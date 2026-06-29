# Restore Delta Loading for Tickets Tab (Eliminate Full-Reload Churn on Open)

## Goal

### Problem
The Tickets tab in `planning.js` (webview) triggers a full reload of all tickets on every panel open. This is a lot of churn — a full API fetch of every task in the list, a full document import (writing every ticket file to disk), a prune sweep, a re-scan of local files, and a sync-status fetch — every time the planning panel is reopened.

### Background
The Tickets tab was designed with an "Initial-Load-Then-Delta" sync model (commit `9a263f0`, "Tickets Tab: File-Backed Source of Truth + Initial-Load-Then-Delta Sync"). The `refreshTicketsDelta` IPC handler originally read a per-list/per-project cursor from the kanban DB and passed `deltaSince`/`deltaSinceIso` into `switchboard.importAllTasks`, so that only tasks updated since the last pull were fetched and written.

> **Code-review correction:** The webview file is `planning.js` (not `planning.html` as referenced in earlier drafts). The `ticketsLoadedOnce` guard lives at `planning.js` line 152 / 1327.

### Root Cause
Commit `3c48e05` ("Preserve a Non-Epic Plan's Column Across the Delete→Re-Insert Race", 2026-06-29) replaced the delta-pull body of `refreshTicketsDelta` with an **unconditional full import + prune**. The explanatory comment (lines 4881–4885 of `PlanningPanelProvider.ts`) states:

> "The user-facing select/Refresh always does a FULL import + prune: it reconciles the on-disk files to the live list... Delta pulls are reserved for the background auto-sync timer — without a full pass the cleanup prune can't run and stale files would linger."

The delta cursor logic was deleted entirely from the manual refresh path. The message is still named `refreshTicketsDelta` but it no longer does a delta pull — it calls `importAllTasks` **without** `deltaSince`/`deltaSinceIso`, making `isDelta = false` inside `TaskViewerProvider.importAllTasks`. This means:

1. The ClickUp list cache is invalidated (`invalidateTaskCache`) on every refresh.
2. **All** tasks are re-fetched from the API (full pagination through the entire list).
3. **All** ticket documents are re-written to disk.
4. The cleanup prune runs (reads the entire target directory + DB entries).
5. `importAllTicketsComplete` fires → `loadLocalTicketFiles()` re-scans + `localTicketFilesListed` re-renders → `_requestTicketSyncStatuses()` fires another round-trip.

The background auto-sync timer (45s interval, lines 8483–8573) **still** does a proper delta pull — it reads the cursor and passes `deltaSince`/`deltaSinceIso` (lines 8507–8531). So the delta machinery exists and works; it was just removed from the manual path.

### Why "every open"
The webview's `ticketsLoadedOnce` guard (`planning.js` line 152, 1327) prevents re-fetching on subsequent tab switches *within the same webview session*. But VS Code disposes and recreates the planning panel webview when the panel tab is closed and reopened, resetting all JS state. On each fresh open, `ticketsInitialized` and `ticketsLoadedOnce` are both `false`, so the full cascade runs: `loadClickUpSpaces()` → hierarchy restore → `loadClickUpProject()` (fetches ALL tasks) → `clickupProjectLoaded` (`planning.js` line 5121) → `refreshTicketsDelta` (FULL import) → `importAllTicketsComplete` → `loadLocalTicketFiles()` again. That is the "full reload of all tickets on every open."

### Code-Review Finding (Post-Plan-Load Verification)
Reading the actual `TaskViewerProvider.importAllTasks` fast path in full (lines 19250–19543) revealed two facts the original plan missed:

1. **A delta deletion sweep already exists** (lines 19482–19541). When `isDelta` is true, `importAllTasks` fetches the full remote ID set separately (ClickUp: `getListTasks(listId)` full; Linear: `fetchAllIssueIds(projectId)`), gates on `fetchSucceeded` (never deletes on a failed/partial fetch), and removes local files whose `remoteDocId` is absent from the full remote set — scoped to the current list/project directory. **This means stale-file cleanup for remotely-deleted tickets is already handled on every delta pull.** The "prune dilemma" described in the original Edge-Case #2 is already solved by the code.

2. **A delta pull with `includeClosed: true` has a semantic gap.** The delta fetch uses `dateUpdatedGt`/`updatedAfter` to return only tasks updated since the cursor. Tickets closed *before* the cursor was set are not in the delta response, so their files would never be written — a regression from the current full-import behavior (which writes all closed tickets when the status filter switches to a closed status).

These two findings drive the revised proposed changes below.

## Metadata
- **Tags**: `performance`, `bugfix`, `backend`, `reliability`
- **Complexity**: 5 (revised down from 6 — see Complexity Audit; the "prune dilemma" that drove the original 6 is already solved by the existing delta deletion sweep)
- **Affected files**: `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts` (read-only verification, no changes)
- **Regression of**: commit `3c48e05` (overwrote the delta-pull body of `refreshTicketsDelta`)

## User Review Required
**Yes — one design decision needs confirmation before implementation:**

The `includeClosed` force-full behavior (see Revised Proposed Changes below) means that switching the ClickUp status filter to a closed status will always trigger a full import (not a delta pull). This preserves the current behavior exactly but means that specific action cannot benefit from delta optimization. The alternative (accept incomplete closed-ticket files on disk) was rejected as a user-facing regression. **Confirm this trade-off is acceptable.**

No other design decisions require user input — the delta cursor restoration is a direct copy-back of the verified auto-sync timer pattern.

## Complexity Audit

### Routine
- Restoring the delta cursor read + `deltaSince`/`deltaSinceIso` pass-through in `refreshTicketsDelta` — the exact code existed before `3c48e05` and is still present in the auto-sync timer (lines 8507–8531). This is a copy-back, not new logic.
- The `importAllTasks` fast path already supports `deltaSince`/`deltaSinceIso` and gates the prune on `!isDelta` (line 19398). No changes needed there.
- Setting `isDelta: isDeltaRefresh` in the `importAllTicketsComplete` response (line 4931) — a one-line fix, cosmetic (webview handler at `planning.js` line 4367 branches on `autoSync`, not `isDelta`).

### Complex / Risky
- **`includeClosed` semantic gap:** A naive delta pull with `includeClosed: true` misses closed tickets closed before the cursor. Mitigated by forcing a full import when `includeClosed === true` (Revised Proposed Change #1). Well-scoped: this path is triggered only by the explicit status-filter-to-closed action (`planning.js` line 8916), not the every-open path.
- **Cursor correctness across 6 entry points:** `refreshTicketsDelta` is sent from 6 webview locations (`planning.js` lines 4961, 5141, 7650, 7681, 7692, 8916). The cursor is keyed per-list/per-project, so each entry point correctly gets its own cursor. First open (no cursor) → full import; subsequent → delta. The `forceFull` override for `includeClosed` is the only entry-point-specific behavior.
- **No periodic full prune needed (revised):** The original plan's "prune dilemma" — the most complex aspect — is eliminated by the discovery of the existing delta deletion sweep (lines 19482–19541). Stale files for remotely-deleted tickets are cleaned on every delta pull, not every 24h.

## Edge-Case & Dependency Audit

1. **First-ever open (no cursor):** `lastPullIso` is `null` → `deltaSince` is `undefined` → `importAllTasks` runs as a full import (`isDelta = false`) → prune runs → deletion sweep (full version) runs → cursor is set. This is the correct initial-load behavior and must be preserved.

2. **Stale file cleanup without a full pass (RESOLVED by existing code):** The original plan listed three options (A: periodic full prune, B: prune on delta, C: accept stale files). **The code already implements option B.** The delta deletion sweep (lines 19482–19541) fetches the full remote ID set and prunes orphaned files on every delta pull, gated on `fetchSucceeded`. The proposed periodic full prune (option A) is **redundant** and has been removed from the revised proposed changes.
   - **Clarification:** The delta deletion sweep fetches full task *bodies* (not just IDs) for ClickUp (`getListTasks(listId)` at line 19498) — only the `.id` field is used for comparison. This means a delta pull incurs one full-list API fetch (for the sweep) in addition to the delta fetch. The net win is in **document writes** (only changed files written) and **prune skipping**, not in API call count. This is existing behavior of the auto-sync timer (every 45s) and is out of scope to optimize.

3. **`includeClosed` + delta pull (NEW — semantic gap):** When the user switches the ClickUp status filter to a closed status, the webview sends `refreshTicketsDelta` with `includeClosed: true` (`planning.js` line 8916). A delta pull with `includeClosed: true` uses `dateUpdatedGt` to fetch only tasks *updated* since the cursor — closed tickets closed *before* the cursor are not in the response and their files are never written. This is a regression from the current full-import behavior. **Fix: force a full import when `includeClosed === true`** (bypass the cursor). This path is triggered only by the explicit status-filter change, not the every-open path, so it does not reintroduce the target churn.

4. **Locally-modified files:** The delta conflict guard (lines 19364–19380) skips tasks whose local file mtime > `last_synced_at` (with a 1s grace). This is preserved as-is — it only runs when `isDelta` is true, which is exactly the path we're restoring.

5. **`includeClosed` flag preservation:** The manual refresh passes `includeClosed` (backend line 4886, reading `msg.includeClosed`). The delta pull must preserve this so the status-filter behavior is unchanged. The auto-sync timer does not pass `includeClosed` — that's fine for background polling. Of the 6 webview send points, only the status-filter change (line 8916) sends `includeClosed: true`; the other 5 default to `false`.

6. **Cursor staleness after provider/list switch:** `ticketsLoadedOnce` is reset to `false` on provider switch (`planning.js` line 7288) and workspace filter change. The cursor is keyed per-list (`last_delta_pull_clickup_<listId>`) / per-project (`last_delta_pull_linear_<projectId>`), so switching lists correctly starts a fresh cursor. No change needed.

7. **`clickupProjectLoaded` always fires `refreshTicketsDelta`:** `planning.js` lines 5139–5145 fire `refreshTicketsDelta` on every `clickupProjectLoaded`. Once the delta pull is restored, this is correct — the first load (no cursor) does a full import, subsequent loads do deltas. `clickupProjectLoaded` also fires on manual Refresh button clicks and list-select changes, so the delta path must handle all entry points. All 6 send points (`planning.js` lines 4961, 5141, 7650, 7681, 7692, 8916) are covered by the cursor + `forceFull` logic.

8. **`isDelta` flag in `importAllTicketsComplete`:** The backend currently hardcodes `isDelta: false` (line 4931) in the `refreshTicketsDelta` response. The webview `importAllTicketsComplete` handler (`planning.js` line 4367) does not branch on `isDelta` (it branches on `autoSync` at line 4377), so this is cosmetic — but it should be set correctly (`isDelta: isDeltaRefresh`) for consistency and future telemetry.

9. **Concurrency — manual refresh vs auto-sync timer:** Both read the same cursor key and both set it to "now" after a successful pull. If both fire simultaneously, the second pull gets an empty delta (nothing changed since the first pull set the cursor) — wasteful but not harmful. The conflict guard (line 19364) prevents overwriting locally-modified files. This is existing behavior (auto-sync timer already runs concurrently across workspace restarts). Not a new concern.

## Dependencies
- None. This is a self-contained single-file change with no cross-plan dependencies.

## Adversarial Synthesis
**Key risks:** (1) A naive delta pull with `includeClosed: true` silently misses closed tickets closed before the cursor — a user-facing regression; (2) the proposed periodic full prune would reintroduce the exact full-reload churn the plan targets, every 24h. **Mitigations:** Force a full import when `includeClosed === true` (only on the explicit status-filter path, not every-open); remove the periodic prune entirely and rely on the existing delta deletion sweep (lines 19482–19541) which already prunes remotely-deleted tickets on every delta pull. The change collapses to a single-file, ~15-line copy-back of the verified auto-sync timer pattern.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Restore delta pull in `refreshTicketsDelta` (lines 4865–4947)

Replace the unconditional full-import body with the delta-cursor logic (mirroring the auto-sync timer at lines 8507–8531 and the pre-`3c48e05` code).

**Before (lines 4881–4897):**
```typescript
// The user-facing select/Refresh always does a FULL import + prune:
// it reconciles the on-disk files to the live list (top-level + open,
// plus closed when the status filter is on a closed status). Delta
// pulls are reserved for the background auto-sync timer — without
// a full pass the cleanup prune can't run and stale files would linger.
const includeClosed = !!msg.includeClosed;
const result: any = await vscode.commands.executeCommand(
    'switchboard.importAllTasks',
    {
        workspaceRoot,
        provider,
        listId,
        projectId,
        importMode: 'document',
        includeClosed
    }
);
```

**After (ORIGINAL PROPOSAL — includes periodic full prune):**
```typescript
// Delta-aware import: read the per-list/per-project cursor. If the
// cursor is unset (first open for this list/project), fall back to a
// full import + prune (isDelta=false → prune runs, cursor is set).
// If the cursor is set, do a delta pull (only changed tasks written,
// prune skipped). Stale-file cleanup is handled by the periodic full
// prune below — not on every refresh.
const includeClosed = !!msg.includeClosed;
let lastPullIso: string | null = null;
if (kanbanDb) {
    try { lastPullIso = await kanbanDb.getMeta(cursorKey); } catch { /* ignore */ }
}
const deltaSince = lastPullIso ? new Date(lastPullIso).getTime() : undefined;
const deltaSinceIso = lastPullIso || undefined;
const isDeltaRefresh = lastPullIso !== null;

const result: any = await vscode.commands.executeCommand(
    'switchboard.importAllTasks',
    {
        workspaceRoot,
        provider,
        listId,
        projectId,
        importMode: 'document',
        includeClosed,
        ...(deltaSince !== undefined ? { deltaSince } : {}),
        ...(deltaSinceIso ? { deltaSinceIso } : {})
    }
);

// Periodic full prune: if this was a delta pull, check whether a full
// prune is overdue (24h, matching the listLocalTicketFiles heal-scan
// throttle). If so, run a single non-delta import to reconcile stale
// files. This avoids re-writing every document on every refresh while
// still cleaning up remotely-deleted tickets on a sane cadence.
if (isDeltaRefresh && result?.success && kanbanDb) {
    const pruneKey = `last_full_prune_${provider}_${listId || projectId || ''}`;
    let lastPruneIso: string | null = null;
    try { lastPruneIso = await kanbanDb.getMeta(pruneKey); } catch { /* ignore */ }
    const pruneOverdue = !lastPruneIso || (Date.now() - new Date(lastPruneIso).getTime() > 24 * 60 * 60 * 1000);
    if (pruneOverdue) {
        try {
            await vscode.commands.executeCommand(
                'switchboard.importAllTasks',
                { workspaceRoot, provider, listId, projectId, importMode: 'document', includeClosed }
            );
            await kanbanDb.setMeta(pruneKey, new Date().toISOString());
        } catch { /* prune failure is non-fatal — next refresh retries */ }
    }
}
```

> **⚠️ CODE-REVIEW FINDING — PERIODIC FULL PRUNE IS SUPERSEDED.** Reading the full `importAllTasks` fast path (lines 19250–19543) revealed that a **delta deletion sweep already exists** (lines 19482–19541). It fetches the full remote ID set and prunes orphaned files on *every* delta pull, gated on `fetchSucceeded`. The periodic full prune above is **redundant** — it reintroduces the exact full-reload churn (full API fetch + full document re-write + prune) the plan aims to eliminate, just throttled to 24h. **Do NOT implement the periodic full prune block.** Use the Revised Implementation below instead.

**Also update the `isDelta` flag in the response (line 4931):**
```typescript
// Before:
isDelta: false
// After:
isDelta: isDeltaRefresh
```

**Cursor update (lines 4899–4904):** Keep the existing cursor-baseline update — it already sets the cursor after a successful pull. This is correct for both full and delta paths.

---

### 1a. REVISED IMPLEMENTATION (Post-Code-Review) — Use this instead of the original "After" block above

The corrected `refreshTicketsDelta` body (replacing lines 4881–4897). Two changes from the original proposal:
1. **No periodic full prune** — the existing delta deletion sweep (lines 19482–19541) handles stale-file cleanup.
2. **Force full import when `includeClosed === true`** — a delta pull with `includeClosed: true` would miss closed tickets closed before the cursor (semantic gap, see Edge-Case #3).

```typescript
// Delta-aware import: read the per-list/per-project cursor. If the
// cursor is unset (first open for this list/project), fall back to a
// full import + prune (isDelta=false → prune runs, cursor is set).
// If the cursor is set, do a delta pull (only changed tasks written,
// prune skipped). Stale-file cleanup for remotely-deleted tickets is
// handled by the existing delta deletion sweep inside importAllTasks
// (TaskViewerProvider lines 19482–19541) — NOT by a periodic full prune.
//
// Exception: when includeClosed is true (user switched the status
// filter to a closed status — webview planning.js line 8916), force a
// FULL import. A delta pull with includeClosed=true uses dateUpdatedGt
// and would only fetch closed tickets UPDATED since the cursor, missing
// tickets closed before the cursor was set. This path is triggered only
// by the explicit status-filter change, not the every-open path, so it
// does not reintroduce the target churn.
const includeClosed = !!msg.includeClosed;
const forceFull = includeClosed;  // closed-status-filter needs the full set
let lastPullIso: string | null = null;
if (!forceFull && kanbanDb) {
    try { lastPullIso = await kanbanDb.getMeta(cursorKey); } catch { /* ignore */ }
}
const deltaSince = lastPullIso ? new Date(lastPullIso).getTime() : undefined;
const deltaSinceIso = lastPullIso || undefined;
const isDeltaRefresh = lastPullIso !== null;  // false when forceFull or first-open

const result: any = await vscode.commands.executeCommand(
    'switchboard.importAllTasks',
    {
        workspaceRoot,
        provider,
        listId,
        projectId,
        importMode: 'document',
        includeClosed,
        ...(deltaSince !== undefined ? { deltaSince } : {}),
        ...(deltaSinceIso ? { deltaSinceIso } : {})
    }
);

// No periodic full prune — the delta deletion sweep inside importAllTasks
// (lines 19482-19541) already prunes remotely-deleted tickets on every
// delta pull. Adding a periodic full import would reintroduce the exact
// full-reload churn this plan eliminates.
```

**Cursor update (unchanged, lines 4899–4904):** Keep as-is — sets cursor to "now" after successful pull. Correct for both full and delta paths.

**`isDelta` flag in response (line 4931):** Change `isDelta: false` → `isDelta: isDeltaRefresh`.

---

### 2. `src/services/PlanningPanelProvider.ts` — Guard against redundant `loadLocalTicketFiles` double-call

On the tab-open cascade, `loadLocalTicketFiles()` is called at `planning.js` line 1332 (tab open) and again at line 4390 (`importAllTicketsComplete`). With the delta pull, the second call is still needed (to pick up newly imported files), but the first call (before any import) is only useful for rendering the cached sidebar instantly. This is acceptable — no change needed, but worth noting that the delta pull reduces the cost of the *second* call's trigger (fewer files written = fewer FS events = less re-render churn).

### 3. No changes to `src/services/TaskViewerProvider.ts` — REVISED REASONING

The `importAllTasks` fast path (lines 19250–19543) already correctly handles all delta-gated behaviors. The original plan listed four; code review found a **fifth**:

1. **Cache invalidation gate** (line 19265): `if (page === 1 && !append && !isDelta)` — cache invalidated only on full imports.
2. **Delta API params** (lines 19268, 19289): `dateUpdatedGt` (ClickUp) / `updatedAfter` (Linear) passed only when `isDelta`.
3. **Conflict guard** (lines 19364–19380): skips locally-modified files, runs only when `isDelta`.
4. **Prune gate** (line 19398): `if (!isDelta && targetDir && rawItemCount > 0)` — reconcile prune runs only on full imports.
5. **Delta deletion sweep** (lines 19482–19541): **MISSED by the original plan.** When `isDelta`, fetches the full remote ID set (ClickUp: `getListTasks(listId)`; Linear: `fetchAllIssueIds(projectId)`), gates on `fetchSucceeded` (never deletes on failed/partial fetch), and removes local files whose `remoteDocId` is absent from the remote set — scoped to the current list/project directory. **This is the mechanism that makes the periodic full prune unnecessary.**

No modifications needed — the delta machinery is fully intact (including the deletion sweep); it was just not being invoked from the manual refresh path.

## Verification Plan

> **Session directives:** Compilation (`npm run compile` / tsc / webpack) and automated tests (unit, integration, e2e) are SKIPPED per session configuration. The test suite will be run separately by the user. All verification below is manual.

### Automated Tests
- Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification
1. **First open (no cursor):** Close and reopen the planning panel. Confirm via console logging that `refreshTicketsDelta` runs with `lastPullIso = null` → full import → prune runs → deletion sweep runs → cursor set. The sidebar should populate fully (same as current behavior).

2. **Second open (cursor set):** Close and reopen the planning panel again. Confirm that `refreshTicketsDelta` runs with `lastPullIso` set → delta pull → only changed tasks fetched/written → prune skipped. The deletion sweep (delta version) still runs to clean remotely-deleted tickets. The sidebar should populate from local files instantly; only genuinely changed tickets should be re-fetched.

3. **Manual Refresh button:** Click Refresh. Confirm delta pull runs (not full import) when cursor exists. Status toast should show "Imported N tickets" where N is the delta count, not the full list count.

4. **Stale file cleanup (via delta deletion sweep — NOT periodic prune):** Delete a ticket remotely (or mark it archived). Open the tab or click Refresh. Confirm the stale file is removed immediately by the delta deletion sweep (lines 19482–19541) — not after a 24h wait. This validates that the periodic full prune is unnecessary.

5. **List switch:** Switch from List A to List B and back. Confirm each switch uses its own cursor (no cross-list delta confusion). First switch to a never-opened list does a full import; return to a previously-opened list does a delta.

6. **Provider switch:** Switch from ClickUp to Linear and back. Confirm `ticketsLoadedOnce` reset (`planning.js` line 7288) triggers a fresh load, and the cursor is correctly keyed per-provider-per-list.

7. **`includeClosed` force-full (status filter → closed):** With a cursor already set (second+ open), switch the ClickUp status filter to a closed status. Confirm a FULL import runs (not delta) — `isDeltaRefresh` should be `false` because `forceFull = includeClosed = true`. All closed tickets should be written to disk (not just recently-closed ones). This validates the Edge-Case #3 fix.

8. **Locally-modified file:** Edit a ticket file locally (don't push). Open the tab. Confirm the delta pull skips the modified ticket (`skippedModified` increments) and the warning toast appears.

9. **Auto-sync timer unaffected:** With auto-sync ON, confirm the 45s background timer still does delta pulls independently (no double-prune, no cursor collision — it uses the same cursor key, which is correct).

---

## Recommendation

**Complexity: 5 (Mixed) → Send to Coder.**

The change is a single-file (~15-line) copy-back of the verified auto-sync timer delta-cursor pattern into `refreshTicketsDelta`, plus a one-line `forceFull` guard for `includeClosed` and a one-line `isDelta` flag fix. The most complex aspect of the original plan (the prune dilemma) is eliminated by the existing delta deletion sweep. The remaining risks (cursor correctness across 6 entry points, `includeClosed` force-full) are well-scoped and reuse existing patterns. No `TaskViewerProvider` changes required.
