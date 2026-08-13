# Clicking an attachment tag on a ticket must open the attachment viewer, not silently re-download the file

## Goal

Make a click on an attachment chip in the ticket detail pane open the **attachments viewer** — the existing attachments modal, scrolled to and highlighting the clicked attachment, with its inline image preview visible — instead of firing a background download whose only feedback is a `Attachment downloaded ✓` toast and a file path in the footer.

### Problem

Every ticket detail render emits its attachments as `.tickets-attachment-item` buttons — three separate render paths do it:

- `src/webview/tickets.js:3046` (ClickUp, cached-detail path)
- `src/webview/tickets.js:3364` (Linear)
- `src/webview/tickets.js:3474` (ClickUp)

A single delegated handler on `#preview-pane-tickets` catches the click (`src/webview/tickets.js:5315-5340`) and does exactly one thing:

```js
vscode.postMessage({ type: 'downloadAttachment', workspaceRoot: ticketsWorkspaceRoot, provider, url, filename, attachmentId, ticketId, ticketTitle });
```

The user clicks something that looks like a link to an attachment and gets: a toast, a file path in a footer that auto-hides after 5 seconds (`src/webview/tickets.js:7948-7959`), and no view of the attachment. The affordance reads as "open this"; the behaviour is "download this, again".

### Root cause

The chip click was wired to the *acquisition* verb rather than the *presentation* surface. The viewer already exists and is fully built: `renderAttachmentsList` (`src/webview/tickets.js:2808-2929`) renders each attachment with its action buttons and, for image extensions, an **inline preview** driven by `att.webviewUri` (`src/webview/tickets.js:2850-2864`).

That URI is *not* produced by `getAttachmentList` — that method returns only `{ id, filename, url, localPath, isDownloaded }` (`src/services/TaskViewerProvider.ts:25001-25055`, signature at 25008, return shape at 25044-25050). It is stamped afterwards, host-agnostically, by the **`viewAttachments` arm** (`src/services/TicketsPanelProvider.ts:3456-3468`): for downloaded image files it calls `_buildLocalAssetUrl` (`src/services/TicketsPanelProvider.ts:529`), which emits an allow-listed `http://127.0.0.1:<port>/design/asset?...` URL that satisfies both the editor webview CSP and the browser cockpit, with `asWebviewUri` as the editor-only fallback. This distinction matters for the coder: the preview only ever appears for attachments the **`viewAttachments` verb** returned — a raw `getAttachmentList` result has no `webviewUri` at all.

The modal is opened today only by the `View Attachments` action-bar button (`src/webview/tickets.js:5234-5259`), which posts `viewAttachments` and renders the result. The chip was simply never connected to it.

A second defect compounds this. `downloadAttachment` never reuses an existing file:

```ts
// src/services/TaskViewerProvider.ts:24969-24973
let targetFilePath = path.join(resolvedTargetDir, finalFilename);
if (fs.existsSync(targetFilePath)) {
    const parsed = path.parse(finalFilename);
    finalFilename = `${parsed.name}-${Date.now()}${parsed.ext}`;   // ← duplicate on every click
    targetFilePath = path.join(resolvedTargetDir, finalFilename);
}
```

So the current chip behaviour writes a **new timestamped copy of the same attachment on every single click**. Ten clicks on one chip leave ten files on disk. Routing the chip through the viewer — which knows `isDownloaded` from `getAttachmentList` — removes the repeat-download path entirely.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, ui, ux
- **Project:** Browser Switchboard

## User Review Required

None. The chip becomes a "show me this" affordance; every other attachment control keeps its current behaviour.

## Complexity Audit

### Routine

- Opening the modal and posting `viewAttachments` is a copy of the `btn-view-attachments` handler that already exists 80 lines away (`src/webview/tickets.js:5234-5259`).
- Highlight/scroll on a rendered row is standard DOM work.
- No backend change, no new verb, no allow-list or catalog regeneration — `viewAttachments`, `downloadAttachment` and `openAttachment` are all already in `TICKETS_VERBS` (`src/generated/verbAllowlist.ts:11`), and none of the three has a payload schema in `src/services/verbSchemas.ts`, so nothing to widen there either.

### Complex / Risky

1. **Asynchronous focus across a re-render.** The chip's attachment may not be downloaded yet. The flow is then: post `downloadAttachment` → `attachmentDownloaded` arrives → the existing arm re-posts `viewAttachments` (`src/webview/tickets.js:7961-7972`) → `attachmentsListResult` arrives → `renderAttachmentsList` replaces the modal's innerHTML. The "focus this attachment" intent must survive two round-trips and one full re-render. Solved with a module-scoped pending-focus token consumed by `renderAttachmentsList`, not by holding a DOM reference across the re-render.

2. **Download-retry loop — the sharpest risk in this plan.** The token-carrying flow above is a cycle: *render sees not-downloaded → post download → download completes → re-post viewAttachments → render*. If the second render **still** reports `isDownloaded: false` (download failed silently, or the provenance record in `_recordAttachment` did not land under the key `getAttachmentList` reads), the cycle repeats forever — and because of the `-${Date.now()}` duplicate path above, **every lap writes another copy of the file to disk**. This is the same defect the plan is fixing, escalated into a runaway. The token must therefore carry a one-shot `downloadRequested` flag and give up with a red status on the second miss.

3. **Matching the clicked chip to a row in the list.** The chip carries `data-attachment-id` and the provider URL; `getAttachmentList` echoes back `id` and `url` (`src/services/TaskViewerProvider.ts:25044-25050`). `id` may be empty for legacy/inline attachments, so the match must fall back to `url` and finally to `filename`. Getting this wrong means the modal opens but focuses the wrong row — visible, not destructive.

No migration concerns: webview interaction only. No persisted state, no settings, no schema, no file format changes.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Required behaviour |
| --- | --- |
| Download completes but the row still reads `isDownloaded: false` | **Give up after one attempt.** The focus token carries `downloadRequested`; on the second miss, clear the token and show a red status. Never re-post `downloadAttachment` for the same token — see Complexity Audit #2. |
| Download **fails** (401 / expired signed URL) | The `attachmentDownloaded` failure branch (`src/webview/tickets.js:7973-7975`) shows the error and does **not** re-post `viewAttachments`, so nothing will ever consume the token. **Clear the token in that branch** or it leaks and fires against an unrelated later render. |
| `viewAttachments` returns `[]` | `renderAttachmentsList` early-returns at `src/webview/tickets.js:2812-2815` before any of the focus code. **Clear the token in that early-return branch too.** |
| `viewAttachments` errors | The `attachmentsListResult` failure branch (`src/webview/tickets.js:7981-7983`) never calls `renderAttachmentsList`. **Clear the token there as well.** |
| Two chips clicked in rapid succession | Last-write-wins on the pending-focus token. No queue. |
| User navigates to a subtask while a download is pending | The subtask-nav handler (`src/webview/tickets.js:5342-5384`) swaps `selectedLinearIssue` / `selectedClickUpIssue`. The `attachmentDownloaded` arm re-posts `viewAttachments` for the *new* selection, whose list will not contain the pending attachment → the no-match branch clears the token. Self-correcting; no extra guard needed. |

### Security

| Case | Required behaviour |
| --- | --- |
| Row lookup by attachment path | Do **not** build a CSS attribute selector out of a filesystem path — a path containing a quote breaks the selector, and `escapeAttr` is HTML-attribute escaping, not CSS-selector escaping. Match by array index instead (see Proposed Changes #3). |
| Expired provider URLs | Linear/ClickUp attachment URLs are signed and expire; they are never hotlinkable. The `Open remote` link is the escape hatch, not a preview source. Do not widen `img-src` to reach them. |

### Side Effects

| Case | Required behaviour |
| --- | --- |
| Attachment already downloaded | Open modal, `viewAttachments`, focus the row. **No download.** This is the fix for the duplicate-file defect. |
| Attachment not yet downloaded | Post `downloadAttachment` once, show `Fetching attachment…`, open the modal immediately in a loading state, then focus the row when `attachmentsListResult` lands. |
| Non-image attachment (pdf, zip, docx) | The modal row renders with `Open` / `Copy path`; no inline preview. That is correct — the viewer shows what it can and offers the OS open. Do **not** attempt to inline-render unknown types. |
| Image attachment | Inline `<img>` preview via `att.webviewUri`, already implemented, works on both hosts via the `/design/asset` loopback route. |
| Modal already open when a chip is clicked | Do not toggle it shut. Re-issue `viewAttachments` and re-focus on the newly clicked attachment. The current `btn-view-attachments` handler toggles; the chip handler must **not** reuse that toggle. |
| `ticketTitle` field on the download payload | Destructured at `src/services/TaskViewerProvider.ts:24945` and then **never used** in the download body. The existing `name`-vs-`title` inconsistency in this file (`tickets.js:2904` uses `.task.title`, `tickets.js:5328` uses `.task.name`) is therefore inert — it does not affect the target directory, which is derived from `_ticketAttachmentsDir(root, provider, ticketId)`. Match the existing chip handler and use `.task.name`; do not spend time reconciling the two. |
| Nested `<img>`/text inside the chip | The handler uses `e.target.closest('.tickets-attachment-item')` already — unchanged. |
| Browser cockpit | Every verb here is already broadcast-routed (`BroadcastHub`), and `webviewUri` prefers the loopback URL precisely so the browser can preview. No host-specific branch needed. |

### Dependencies & Conflicts

| Case | Required behaviour |
| --- | --- |
| **Feature sibling: the Reveal→Copy-path subtask** | **Hard ordering dependency — that plan lands first.** It rewrites the same `isDownloaded` button branch (`src/webview/tickets.js:2827-2831`) and the same listener region (2886-2895) that this plan appends to. Every reference below to the row's buttons assumes the post-deletion state (`Open` / `Copy path`). |

> **Superseded:** "Non-image attachment (pdf, zip, docx) — the modal row renders with `Open` / `Reveal`"; and manual step "Click a chip for a non-image attachment (pdf/zip): row is focused, `Open` / `Reveal` present".
> **Reason:** The sibling subtask in this feature deletes the `Reveal` button outright (it is a silent no-op on every host) and replaces it with `Copy path`. Verifying against `Reveal` would fail on a correctly-implemented board.
> **Replaced with:** `Open` / `Copy path`, throughout this plan.

| Case | Required behaviour |
| --- | --- |
| Chip clicked on a subtask ticket, or `selectedLinearIssue` / `selectedClickUpIssue` momentarily null | Guard: if no `ticketId` or no `attachments` array, fall through to no-op rather than posting a malformed verb. |
| Host wiring | Relies on `viewAttachments` → `switchboard.getAttachmentList` and `downloadAttachment` → `switchboard.downloadAttachment`, all registered on **both** hosts (`src/extension.ts:2109`, `2114`; `src/standalone/bootstrap.ts:838`, `842`). No Layer-2 gap. |
| No new dependencies | `showTicketsStatus` (`src/webview/tickets.js:333`), `getTicketsTabElements`, `lastIntegrationProvider` and `ticketsWorkspaceRoot` are all already in scope in this file. |

## Dependencies

- None. No prior session artifacts are required.

## Adversarial Synthesis

**Risk Summary.** The headline risk is the download-retry cycle: render→download→re-render is a loop, and because `downloadAttachment` appends `-${Date.now()}` to any colliding filename, an un-terminated loop writes an unbounded stream of duplicate files — a worse version of the bug being fixed. Mitigation is a one-shot `downloadRequested` flag on the focus token plus a red-status give-up, and token clearing in all four paths that can end a cycle without a successful render (empty list, list error, download failure, no match). The secondary risk is a leaked token firing a highlight against an unrelated later render; the same clearing discipline covers it. Row matching is done by array index rather than a path-derived CSS selector, which removes an escaping hazard class entirely.

## Proposed Changes

### 1. `src/webview/tickets.js` — replace the chip handler (currently lines 5315-5340)

**Context.** The delegated handler on `#preview-pane-tickets` has exactly one branch today.

```js
document.getElementById('preview-pane-tickets')?.addEventListener('click', (e) => {
    const attachmentBtn = e.target.closest('.tickets-attachment-item');
    if (attachmentBtn) {
        const provider = lastIntegrationProvider;
        const url = attachmentBtn.dataset.linearAttachmentUrl || attachmentBtn.dataset.clickupAttachmentUrl;
        const filename = attachmentBtn.textContent.trim();
        const attachmentId = attachmentBtn.dataset.attachmentId;
        // A chip is a "show me this" affordance, not "download this". Open the
        // viewer and let the download happen only if the file isn't there yet.
        openAttachmentViewerFor({ provider, url, filename, attachmentId });
    }
});
```

### 2. `src/webview/tickets.js` — new viewer-focus helper, placed next to `renderAttachmentsList`

```js
// Focus intent for the attachments modal. Survives the download → viewAttachments
// → renderAttachmentsList round-trip, which replaces the modal's innerHTML, so a
// DOM reference cannot be held across it. `downloadRequested` makes the download
// leg ONE-SHOT: render → download → re-render is a cycle, and downloadAttachment
// appends `-${Date.now()}` on filename collision, so an unterminated cycle would
// write a new copy of the file on every lap.
let _pendingAttachmentFocus = null;

function _attachmentMatchesFocus(att, focus) {
    if (!focus) return false;
    if (focus.attachmentId && att.id && String(att.id) === String(focus.attachmentId)) return true;
    if (focus.url && att.url && att.url === focus.url) return true;
    return !!(focus.filename && att.filename && att.filename === focus.filename);
}

function openAttachmentViewerFor(focus) {
    const provider = focus.provider || lastIntegrationProvider;
    const ticketId = provider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id;
    const attachments = provider === 'linear' ? selectedLinearIssue?.attachments : selectedClickUpIssue?.attachments;
    if (!ticketId || !attachments) return;

    _pendingAttachmentFocus = { ...focus, downloadRequested: false };

    const modal = document.getElementById('attachments-modal');
    if (modal) modal.style.display = 'flex';   // never toggles closed — see edge-case table
    const { attachmentsList } = getTicketsTabElements();
    if (attachmentsList) {
        attachmentsList.innerHTML = '<div style="font-size: 11px; color: var(--text-secondary);">Loading attachment…</div>';
    }

    vscode.postMessage({ type: 'viewAttachments', workspaceRoot: ticketsWorkspaceRoot, provider, ticketId, attachments });
}
```

### 3. `src/webview/tickets.js` — consume the token in `renderAttachmentsList`

**Context.** `renderAttachmentsList` emits one `.attachment-row` per entry of `attachments`, in order (`src/webview/tickets.js:2818-2870`), then sets `attachmentsList.innerHTML = html` (2872) and binds row listeners (2875-2928).

**Implementation — two edits.**

**(a)** In the empty early-return branch (lines 2812-2815), clear the token before returning:

```js
if (!attachments || attachments.length === 0) {
    _pendingAttachmentFocus = null;   // nothing will ever consume it
    attachmentsList.innerHTML = '<div class="empty-state">No attachments found.</div>';
    return;
}
```

**(b)** After the existing listener bindings (after line 2928, before the closing brace of the function):

```js
// Consume the pending focus exactly once. If the target attachment is not yet
// downloaded, kick the download ONCE and keep the token — the attachmentDownloaded
// arm re-issues viewAttachments, and the next render focuses it for real. If the
// second pass still reports it undownloaded, stop: another download would loop and
// write a fresh timestamped duplicate on every lap.
if (_pendingAttachmentFocus) {
    const focus = _pendingAttachmentFocus;
    const idx = attachments.findIndex(a => _attachmentMatchesFocus(a, focus));
    if (idx === -1) {
        _pendingAttachmentFocus = null;                       // nothing to focus — never leave a stale token
    } else if (!attachments[idx].isDownloaded) {
        if (focus.downloadRequested) {
            _pendingAttachmentFocus = null;
            showTicketsStatus('Attachment could not be prepared for preview.', true);
        } else {
            focus.downloadRequested = true;
            showTicketsStatus('Fetching attachment…', false);
            const match = attachments[idx];
            const ticketId = lastIntegrationProvider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id;
            const ticketTitle = lastIntegrationProvider === 'linear' ? selectedLinearIssue?.issue?.title : selectedClickUpIssue?.task?.name;
            vscode.postMessage({
                type: 'downloadAttachment', workspaceRoot: ticketsWorkspaceRoot,
                provider: lastIntegrationProvider, url: match.url, filename: match.filename,
                attachmentId: match.id || '', ticketId, ticketTitle
            });
        }
    } else {
        _pendingAttachmentFocus = null;
        // Row order is 1:1 with `attachments` (the forEach above), so index the
        // rendered rows directly rather than building a selector out of a path.
        const row = attachmentsList.querySelectorAll('.attachment-row')[idx];
        if (row) {
            row.scrollIntoView({ block: 'nearest' });
            row.classList.add('attachment-row-focused');
            setTimeout(() => row.classList.remove('attachment-row-focused'), 2000);
        }
    }
}
```

> **Superseded:** Tag each row with `data-att-key` on the `.attachment-row` wrapper and find it with `attachmentsList.querySelector('.attachment-row[data-att-key="' + escapeAttr(match.localPath || match.url) + '"]')`.
> **Reason:** Three problems. (1) `escapeAttr` is HTML-attribute escaping, not CSS-selector escaping — a `localPath` containing a quote produces a malformed selector and a silent miss. (2) `localPath` is `''` for anything not downloaded (`src/services/TaskViewerProvider.ts:25048`), so the key is unstable across the two renders of the download flow. (3) It requires editing the row markup at line 2821, which is the same block the sibling Reveal→Copy-path subtask rewrites — an avoidable merge collision.
> **Replaced with:** Index-based lookup. `renderAttachmentsList` emits rows 1:1 with `attachments` in order, so `attachmentsList.querySelectorAll('.attachment-row')[idx]` is exact, needs no escaping, and requires **no markup change at all**.

### 4. `src/webview/tickets.js` — clear the token on the three non-render exits

- `attachmentDownloaded` failure branch (line 7973-7975): add `_pendingAttachmentFocus = null;` — this branch does not re-post `viewAttachments`, so nothing downstream will consume the token.
- `attachmentsListResult` failure branch (line 7981-7983): add `_pendingAttachmentFocus = null;` — `renderAttachmentsList` is never called on this path.
- The empty-list early return, covered by change 3(a).

The `attachmentDownloaded` **success** arm (`src/webview/tickets.js:7945-7972`) already re-posts `viewAttachments`, so no change is needed there — the second render finds `isDownloaded: true` and takes the focus branch.

### 5. `src/webview/tickets.html` — focus highlight style

Add next to the other attachment rules. `.attachment-row` carries only inline styles today and no `outline`, so a class rule is not overridden:

```css
.attachment-row-focused {
    outline: 1px solid var(--accent-teal, #00ffcc);
    outline-offset: 2px;
}
```

### 6. `src/webview/tickets.js` — leave `btn-view-attachments` alone

The action-bar button (lines 5234-5259) keeps its open/close toggle. Only the chip path uses `openAttachmentViewerFor`, which always opens.

## Verification Plan

> Session directive: this pass does **not** run compilation or automated tests. The gate commands below are listed for CI / the implementing session, not executed here.

### Automated Tests

1. New test `src/test/tickets-attachment-chip-opens-viewer.test.js`, against the tickets webview harness used by the existing browser panel tests:
   - dispatch a click on a `.tickets-attachment-item` chip; assert the posted message is `viewAttachments` and that **no** `downloadAttachment` is posted in the same tick;
   - feed an `attachmentsListResult` where the matching attachment has `isDownloaded: true`; assert the matching `.attachment-row` receives `attachment-row-focused` and no `downloadAttachment` is posted;
   - feed a result where the match has `isDownloaded: false`; assert exactly one `downloadAttachment` is posted and the focus token is retained;
   - **loop guard:** feed a *second* result where the same match is still `isDownloaded: false`; assert **no** further `downloadAttachment` is posted and an error status is shown;
   - feed a result with no matching attachment; assert the token is cleared and nothing is posted;
   - feed a failing `attachmentDownloaded` and then an unrelated `attachmentsListResult`; assert no row is highlighted (token was cleared).
2. CI gates (run on merge, not in this session): `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`. None should move — this change is webview-only.

### Static guards

- `grep -n "downloadAttachment" src/webview/tickets.js` → the only senders are the modal's `Download` button (`~2905`) and the one-shot leg inside `renderAttachmentsList`. The delegated `#preview-pane-tickets` handler must **not** appear.
- `grep -n "_pendingAttachmentFocus = null" src/webview/tickets.js` → at least **five** sites (empty list, no match, give-up, success focus, download failure, list error).

### Manual — VS Code editor panel

3. Select a ticket with an already-downloaded image attachment. Click its chip. The attachments modal must open with that row visible, outlined, and its inline image preview rendered. `ls` the attachments dir before and after: **file count must not change**.
4. Select a ticket whose attachment has never been downloaded. Click the chip: modal opens in a loading state, status reads `Fetching attachment…`, then the row appears downloaded with a preview and the outline. `ls` shows exactly one new file.
5. Click the same chip five more times. `ls` shows **no** additional files — this is the direct regression check for the `-${Date.now()}` duplicate-copy path.
6. Click a chip for a non-image attachment (pdf/zip): row is focused, `Open` / `Copy path` present, no broken `<img>`.
7. With the modal already open on ticket A's attachment, click a different chip: the modal stays open and re-focuses the new row.

### Manual — browser cockpit (the pinned surface)

8. Repeat steps 3 and 4 in the browser cockpit against the running standalone host. The inline preview must render via the `http://127.0.0.1:<port>/design/asset` URL — confirm in devtools Network that the image request is 200 and no CSP violation is logged.
9. Confirm the `attachmentDownloaded` and `attachmentsListResult` pushes arrive over WS (devtools → WS frames) and that the focus lands after the second render.

### Failure path

10. Point a ticket at an expired attachment URL; click the chip. A red status shows the download error, the modal stays open, and the row still offers `Open remote`. No ✓, no silent stall, and — checked in devtools Network — **no** second `downloadAttachment`.

---

**Recommendation: Send to Coder** (complexity 5). Land the Reveal→Copy-path subtask before starting this one.
