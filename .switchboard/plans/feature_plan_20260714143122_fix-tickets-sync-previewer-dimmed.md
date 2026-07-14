# Fix: Tickets "Sync changes" Dims Doc Previewer for Full Sync Duration

## Goal

When the user clicks **Sync changes** (`#tickets-sync-all`) in the Planning panel's **Tickets** tab to push local ticket edits back to the source integration (Linear/ClickUp), the entire doc previewer (`#markdown-preview-tickets`) drops to `opacity: 0.4` and all meta-bar buttons become disabled for the whole duration of the sync (~5 seconds). The previewer is visually unclickable and unresponsive even though the sync operation does not alter the currently-displayed ticket content. The goal is to keep the previewer fully interactive during sync, disable only the sync button itself, surface live progress in the status footer, and reduce the total sync wall-time by parallelizing the per-ticket pushes.

### Problem Analysis & Root Cause

- **Symptom**: After clicking "Sync changes", the `tickets-loading-state` spinner appears and `#markdown-preview-tickets` is dimmed to `opacity: 0.4` with all `#tickets-preview-meta-bar` / `#tickets-local-meta-bar` buttons disabled. This state persists until the `syncAllTicketsResult` message returns from the extension — roughly 5 seconds for a handful of tickets.
- **Root cause (webview)**: The click handler at `planning.js` L9150–9158 calls `setTicketsLoadingState(true)`. `setTicketsLoadingState` (L2029–2044) is a **broad** loading gate designed for *loading* ticket content: it sets the preview opacity to `0.4`, shows the full-pane spinner overlay, and disables every button/select in both meta bars. Reusing it for a *background push* operation is wrong — the sync does not change the displayed ticket, so dimming the preview is unnecessary and misleading. The state is only cleared on the `syncAllTicketsResult` message (L5544–5557).
- **Root cause (backend, the ~5s duration)**: `PlanningPanelProvider.ts` `case 'syncAllTickets'` (L6527–6588) iterates over **all** local ticket files and pushes each one **sequentially**:
  ```ts
  for (const ticket of tickets) {
      const result = await vscode.commands.executeCommand(
          'switchboard.pushTicketEdits', { workspaceRoot, provider, id: ticket.id });
      ...
  }
  ```
  Each `pushTicketEdits` (`TaskViewerProvider.ts` L20972) makes a **remote API call** — Linear `updateIssueDescription` (L21039) or ClickUp `updateTask` (L21053) — plus `hostInlineImages` which may upload attachments (L21032–21048). Total wall time = **sum** of all per-ticket API latencies. With N tickets at ~0.5–1s each, the dimmed state lasts N×latency, which matches the reported ~5s.
- **Why the user sees "animation then dimmed"**: The spinner (`tickets-loading-state`, `animation: spin 0.8s linear infinite`) and the `opacity: 0.4` dimming are toggled together by `setTicketsLoadingState`. The spinner is small (32px) and easy to overlook, so the dominant perceived effect is the dimmed, unclickable previewer lasting the full sequential-sync duration.

The fix has two independent parts: (A) stop dimming the previewer during sync (front-end), and (B) parallelize the pushes with bounded concurrency + live progress (back-end) so even the button-disabled window is short.

> **Line-number correction (improve pass):** The original plan cited stale line numbers (click handler L9028–9036, `setTicketsLoadingState` L1922–1937, result handler L5437–5450, `showTicketsStatus` L1333, backend case L6440–6500). All have been corrected above to the actual locations as of the current HEAD. The `TaskViewerProvider.ts` references (L20972, L21032–21048, L21039, L21053, L21064) were already accurate and are unchanged.

## Metadata

- **Tags:** frontend, backend, ui, ux, bugfix, performance
- **Complexity:** 4

- **Files touched:** `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`

## User Review Required

Yes — before implementation, the user should confirm:
1. Whether live progress messages (`syncAllTicketsProgress`) are desired or if a simple "Syncing…" → "Synced N" two-step status is sufficient. The plan recommends making progress **non-optional** (see Adversarial Synthesis).
2. The concurrency cap of 4 is acceptable given the workspace's Linear/ClickUp API tier (see Uncertain Assumptions).

## Complexity Audit

### Routine

- Replacing the `setTicketsLoadingState(true)` call in the `syncAllButton` click handler (`planning.js` L9151) with a sync-specific lightweight state: disable only `#tickets-sync-all` (already done at L9152) and show a "Syncing…" status via the existing `showTicketsStatus` helper (L1440). No new DOM, no new CSS.
- Clearing that lightweight state on `syncAllTicketsResult` (L5544–5557) instead of calling `setTicketsLoadingState(false)` — the sync result handler already re-enables the button and calls `showTicketsStatus`; just drop the `setTicketsLoadingState(false)` call at L5545.
- Adding a bounded-concurrency `Promise.all` chunk loop in the `syncAllTickets` backend case — a small, self-contained refactor of the existing sequential `for` loop (L6551–6567), no new dependencies.

### Complex / Risky

- **Live progress messages**: To show "Syncing 3/10…", the backend must post incremental `syncAllTicketsProgress` messages and the webview must handle a new message type. This is a new (tiny) message contract on both sides. **Recommended non-optional** — see Adversarial Synthesis for why deferring progress breaks the status footer auto-hide.
- **Bounded concurrency vs. API rate limits**: Parallelizing Linear/ClickUp writes risks hitting rate limits if the ticket count is large. **Web research confirmed concurrency 4 is safe** for both platforms (see Rate-Limit Confirmation section). Linear: 5,000 req/hour leaky bucket. ClickUp: 100 RPM on standard plans (concurrency 4 leaves ≥96 requests in the rolling minute). A safe default of 4 keeps a 10-ticket sync under ~1.5s while staying well below rate ceilings.
- **`hostInlineImages` per-ticket file write race**: Each push calls `hostInlineImages` (`ImageHostingHelper.ts` L87–117), which reads `sourceFilePath`, rewrites inline image URLs, and writes the file back (L98–109). If the same ticket id appears in multiple ticket document directories (returned by `_getTicketDocumentDirs`), the collection loop at L6534–6548 would enqueue the same id twice, and both concurrent pushes would read/write the **same file** — a race condition that could corrupt the local ticket file. The coder must either deduplicate by ticket id before pushing, or verify `_getTicketDocumentDirs` never returns overlapping dirs for the same id.
- **`showTicketsStatus` auto-hide**: `showTicketsStatus` (L1440–1450) auto-hides the footer after 4 seconds (L1447–1449 `setTimeout`). If progress messages are deferred and the sync takes >4s, the initial "Syncing changes…" status vanishes prematurely. Progress messages refresh the timer (each call clears + resets the timeout), so making progress non-optional eliminates this gap.

## Edge-Case & Dependency Audit

- **Race Conditions**: The user could click "Sync changes" again while a sync is in flight. The button is disabled at L9152 during sync, so this is already guarded. The new lightweight state must keep the button disabled until `syncAllTicketsResult` arrives (unchanged behavior).
- **Duplicate ticket id across dirs**: If `_getTicketDocumentDirs` returns multiple dirs containing a file for the same ticket id, the collection loop enqueues duplicate entries. In the sequential case this is benign (second push re-reads already-rewritten file). In the parallelized case, concurrent `hostInlineImages` calls on the same file race on read-modify-write. **Mitigation**: deduplicate `tickets` by `id` after collection, keeping the first `filePath` per id.
- **Empty sync**: When there are no local ticket files, the backend sends `syncAllTicketsResult` with `succeeded: 0` and the webview shows "No local ticket files to sync." (L5550). The button must still re-enable. Unchanged.
- **Partial failure**: `syncAllTicketsResult` with `failed > 0` shows "Synced N succeeded, M failed." (L5555). The previewer must remain interactive throughout. With the fix, the previewer is never dimmed, so partial failure no longer traps the UI.
- **Security**: No new credentials, no new network surfaces. The parallelized pushes reuse the existing authenticated `pushTicketEdits` command unchanged.
- **Side Effects**: `pushTicketEdits` calls `cacheService.registerImportedTicket` (L21064) to update sync timestamps. Running these concurrently is safe — each operates on a distinct ticket id/filePath; the cache service writes are independent rows.
- **Dependencies & Conflicts**:
  - `setTicketsLoadingState` is used by many other ticket flows (import, fetch, status load — L1167, L5519, L9003, L9096, etc.). **Do not modify `setTicketsLoadingState` itself.** Only stop calling it from the sync click handler. Other callers legitimately need the full loading gate (they replace preview content).
  - The `syncAllTicketsResult` handler (L5544–5557) currently calls `setTicketsLoadingState(false)` at L5545. After the fix this call becomes a no-op for sync (since sync no longer sets it true), but it is harmless to leave for safety in case another flow set it. Prefer to drop it to avoid masking unrelated loading state.

## Dependencies

None — this plan is self-contained. No prerequisite sessions.

## Rate-Limit Confirmation (Web Research)

Web research confirmed that a concurrency cap of 4 is safe for both platforms:

- **Linear**: 5,000 GraphQL requests/hour per authenticated user, leaky-bucket algorithm (~1.38 req/sec sustained refill). Mutation-specific edge limits exist but concurrency 4 is well within safe bounds. Attachment uploads use a two-step `fileUpload` → GCS presigned PUT flow; the binary upload bypasses Linear's app servers (counts only the `fileUpload` mutation toward the quota).
- **ClickUp**: 100 RPM on Free/Unlimited/Business plans (1,000 RPM Business Plus, 10,000 RPM Enterprise). Concurrency 4 leaves ≥96 requests in the rolling minute — substantial safety margin. **Note**: unlike Linear, ClickUp attachment uploads (`POST /task/{id}/attachment`) are processed on ClickUp's API servers and **count toward** the rolling RPM limit. A sync batch with many inline-image attachments could consume more of the budget than ticket-count alone suggests; the concurrency cap of 4 keeps this bounded.
- **No native idempotency keys** on either platform. The plan does not retry failed pushes (a failed ticket is reported in `results.errors` and surfaced to the user), so duplicate-write risk from blind retries does not apply.
- **Webhook feedback loop**: Pushing ticket updates triggers platform webhooks. If the extension's sync engine listens to those webhooks and re-syncs, a recursive feedback loop could exhaust rate limits. This is an existing-system concern, not introduced by this plan — but the coder should verify the extension's webhook handler filters self-triggered updates (e.g., by client metadata/session id) before relying on parallelized pushes at scale.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) `showTicketsStatus` auto-hides after 4s — if progress is deferred, the "Syncing…" status vanishes mid-sync, breaking the "surface live progress" goal; (2) duplicate ticket ids across dirs cause a concurrent file-write race in `hostInlineImages`. Mitigations: make progress messages non-optional (refreshes the timer), deduplicate tickets by id before pushing. Rate limits at concurrency 4 confirmed safe via web research for both Linear and ClickUp.

## Proposed Changes

> **Line-number note:** All line numbers below are corrected to the actual HEAD locations. The original plan's references were stale by ~100–130 lines.

### 1. `src/webview/planning.js` — stop dimming the previewer during sync

**Click handler (L9150–9158)**: Replace `setTicketsLoadingState(true)` with a sync-scoped status. Keep the button disable. **Important**: after calling `showTicketsStatus`, clear the auto-hide timeout so the "Syncing…" status persists until the result handler resets it.

```js
syncAllButton?.addEventListener('click', () => {
    // Do NOT call setTicketsLoadingState(true) — that dims the whole previewer
    // and disables all meta-bar buttons for the entire sync. The sync is a
    // background push that does not change the displayed ticket, so only the
    // sync button itself needs to be disabled.
    if (syncAllButton) syncAllButton.disabled = true;
    showTicketsStatus('Syncing changes…', false);
    // showTicketsStatus auto-hides after 4s — clear that timeout so the
    // status persists until syncAllTicketsResult or a progress message
    // arrives and resets it.
    if (window._ticketsFooterTimeout) {
        clearTimeout(window._ticketsFooterTimeout);
        window._ticketsFooterTimeout = undefined;
    }
    vscode.postMessage({
        type: 'syncAllTickets',
        provider: lastIntegrationProvider,
        workspaceRoot: ticketsWorkspaceRoot
    });
});
```

**Result handler (L5544–5557)**: Drop the `setTicketsLoadingState(false)` call at L5545 (no longer needed for sync); keep the button re-enable and status display.

```js
case 'syncAllTicketsResult':
    const syncAllBtn = document.getElementById('tickets-sync-all');
    if (syncAllBtn) syncAllBtn.disabled = false;
    if (msg.success) {
        if (msg.succeeded === 0) {
            showTicketsStatus('No local ticket files to sync.', false);
        } else {
            showTicketsStatus(`Synced ${msg.succeeded} tickets successfully.`, false);
        }
    } else {
        showTicketsStatus(`Synced ${msg.succeeded} succeeded, ${msg.failed} failed.`, true);
    }
    break;
```

**Progress handler** (add near the result handler, e.g., after L5557): handle incremental progress so the footer updates live. **Non-optional** — progress messages refresh the `showTicketsStatus` auto-hide timer, keeping the status visible throughout the sync.

```js
case 'syncAllTicketsProgress':
    showTicketsStatus(`Syncing… ${msg.done}/${msg.total}`, false);
    break;
```

### 2. `src/services/PlanningPanelProvider.ts` — parallelize pushes with bounded concurrency + progress + dedup

**`case 'syncAllTickets'` (L6527–6588)**: Replace the sequential `for` loop (L6551–6567) with a bounded-concurrency runner that posts progress messages. Also deduplicate tickets by id to prevent the `hostInlineImages` file-write race.

> **Superseded:** The original plan's proposed backend code did not deduplicate tickets by id before parallelizing, leaving a file-write race if the same id appears in multiple ticket document directories.
> **Reason:** `hostInlineImages` (`ImageHostingHelper.ts` L98–109) reads and writes `sourceFilePath` (read-modify-write). Two concurrent pushes for the same id would race on the same file, potentially corrupting the local ticket document.
> **Replaced with:** Deduplicate the collected `tickets` array by `id` (keeping the first `filePath` per id) before entering the bounded-concurrency loop.

```ts
case 'syncAllTickets': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    const results = { succeeded: 0, failed: 0, errors: [] as string[] };

    if (!workspaceRoot) {
        this.postMessageToWebview({
            type: 'syncAllTicketsResult', success: false, count: 0,
            succeeded: 0, failed: 0, errors: ['No workspace root resolved']
        });
        break;
    }

    const tickets: any[] = [];
    for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
        if (!fs.existsSync(dir)) { continue; }
        let files: string[] = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const fileName of files) {
            const match = fileName.match(/^(linear|clickup)_([^_]+)_(.*)\.md$/);
            if (!match || match[1] !== provider) { continue; }
            const filePath = path.join(dir, fileName);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                tickets.push({ id: match[2], content, filePath });
            } catch { /* ignore read errors */ }
        }
    }

    // Deduplicate by ticket id — if the same id appears in multiple ticket
    // document dirs, keep only the first. This prevents a concurrent
    // hostInlineImages file-write race on the same sourceFilePath.
    const seenIds = new Set<string>();
    const uniqueTickets = tickets.filter(t => {
        if (seenIds.has(t.id)) return false;
        seenIds.add(t.id);
        return true;
    });

    // Bounded concurrency: push up to 4 tickets at a time so total wall time
    // is ~ceil(N/4) × per-ticket latency instead of N × per-ticket latency.
    const CONCURRENCY = 4;
    let done = 0;
    const total = uniqueTickets.length;
    for (let i = 0; i < uniqueTickets.length; i += CONCURRENCY) {
        const batch = uniqueTickets.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (ticket) => {
            try {
                const result: any = await vscode.commands.executeCommand(
                    'switchboard.pushTicketEdits',
                    { workspaceRoot, provider, id: ticket.id }
                );
                return result?.success
                    ? { ok: true }
                    : { ok: false, error: `${ticket.id}: ${result?.error || 'Unknown error'}` };
            } catch (err) {
                return { ok: false, error: `${ticket.id}: ${err instanceof Error ? err.message : String(err)}` };
            }
        }));
        for (const r of batchResults) {
            if (r.ok) { results.succeeded++; }
            else { results.failed++; results.errors.push(r.error); }
        }
        done += batch.length;
        this.postMessageToWebview({
            type: 'syncAllTicketsProgress', done, total
        });
    }

    this.postMessageToWebview({
        type: 'syncAllTicketsResult',
        success: results.failed === 0,
        count: uniqueTickets.length,
        succeeded: results.succeeded,
        failed: results.failed,
        errors: results.errors
    });
    break;
}
```

> **Note**: `CONCURRENCY = 4` is a conservative default. If the workspace hits Linear/ClickUp write rate limits, lower it to 2 or 3. The chunked `Promise.all` approach keeps the cap exact (no runaway queue).

## Verification Plan

> **Per session directives:** No compilation step and no automated tests are run as part of this verification plan. Verification is manual.

### Automated Tests

None — skipped per session directive. All verification is manual.

### Manual Verification

1. **Reproduce the original bug** (before fix): Open the Tickets tab with ≥3 locally-edited tickets, click "Sync changes", confirm the previewer dims to ~0.4 opacity and meta-bar buttons are disabled for the full sync duration.
2. **Apply the fix** and reload the webview.
3. **Previewer stays interactive**: Click "Sync changes" again. Confirm:
   - The previewer remains at full opacity and is clickable throughout the sync.
   - Meta-bar buttons (Edit, Push, status select, comment, etc.) remain enabled.
   - Only the "Sync changes" button is disabled; it re-enables on completion.
   - The status footer shows "Syncing changes…" then "Synced N tickets successfully." and does **not** vanish mid-sync (the auto-hide timeout is cleared in the click handler and refreshed by progress messages).
4. **Sync still works**: After sync, confirm the tickets' sync status badges update to "synced" (the `registerImportedTicket` timestamp refresh still fires). Verify the remote descriptions were updated in Linear/ClickUp.
5. **Parallelization timing**: With 8–10 tickets, confirm the total sync time drops from ~N×latency to ~ceil(N/4)×latency (visibly faster than before).
6. **Partial failure**: Temporarily make one ticket's id invalid (rename its file) and sync. Confirm the previewer stays interactive, the button re-enables, and the footer shows "Synced N succeeded, M failed."
7. **Empty sync**: With no local ticket files, click "Sync changes". Confirm "No local ticket files to sync." appears and the button re-enables immediately.
8. **No regression in other flows**: Trigger a ticket import / refetch (which legitimately uses `setTicketsLoadingState`). Confirm the full loading gate (spinner + dim) still appears for those flows — the change is scoped to sync only.
9. **Duplicate-id dedup**: If the workspace has multiple ticket document dirs, confirm that a ticket appearing in more than one dir is pushed only once (no file corruption from concurrent `hostInlineImages` writes).

---

**Recommendation:** Complexity 4 → **Send to Coder**.

## Completion Summary

Implemented both parts of the fix. **Frontend (`src/webview/planning.js`)**: the `syncAllButton` click handler no longer calls `setTicketsLoadingState(true)` — instead it disables only the sync button, shows a "Syncing changes…" status, and clears the `showTicketsStatus` auto-hide timeout so the status persists; the `syncAllTicketsResult` handler dropped its `setTicketsLoadingState(false)` call, and a new `syncAllTicketsProgress` case updates the footer live (`Syncing… done/total`). **Backend (`src/services/PlanningPanelProvider.ts`)**: the sequential `for` loop in `case 'syncAllTickets'` was replaced with a dedup-by-id step (prevents the `hostInlineImages` concurrent file-write race) plus a bounded-concurrency chunked `Promise.all` runner (cap 4) that posts `syncAllTicketsProgress` after each batch and a final `syncAllTicketsResult` reflecting the deduped count. No issues encountered; the existing `if (workspaceRoot)` guard and empty-sync path were preserved. Per session directives, compilation and automated tests were skipped.
