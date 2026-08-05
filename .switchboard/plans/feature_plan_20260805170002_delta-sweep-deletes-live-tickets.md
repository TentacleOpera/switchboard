# Delta deletion sweep destroys live ticket files on a short fetch

## Goal

Stop the delta-refresh deletion sweep from unlinking local ticket files (and their `imported_docs` rows) when the remote ID fetch that authorises the deletion is incomplete. Also stop `refreshTicketsDelta` from firing unconditionally on every list load, so a read action can never trigger a destructive write.

A partial safety fix — the ClickUp/Linear gate in `TaskViewerProvider.importAllTasks` — was applied on 2026-08-05 while diagnosing live data loss. This plan covers verifying that fix, extending it where it is still weak, and removing the trigger that made it fire so often.

### Problem analysis & root cause

**Reported symptom.** "It's not even finding tickets anymore, and refetch does nothing." "I am just trying to work and the system keeps deleting the files I am working with."

**Confirmed data loss.** All five Sprint 4 ticket files (`.switchboard/tickets/clickup/tech-team/q3-2026/sprint-4-108-238/`) and their five `imported_docs` rows were deleted while the user was working. ClickUp still held all five tasks — the remote was never the problem. Files were restored from a diagnostic backup.

**Root cause 1 — the sweep's authorisation check only means "did not throw".**

```ts
// src/services/TaskViewerProvider.ts, delta sweep (~22511), as it stood
const allTasks = await clickup.getListTasks(listId, { forceRefresh: true });
fullRemoteIds = new Set(allTasks.map(t => String(t.id)));
fetchSucceeded = true;                     // ← unconditional
...
if (fetchSucceeded) {
    // unlink every local file whose remote id is not in fullRemoteIds
    // and delete its imported_docs row
}
```

`_fetchListTasksInternal` returns short results **without throwing**:

```js
const isLastPage = result.data?.last_page === true;
if (isLastPage) { complete = true; break; }
if (pageTasks.length === 0) { break; }     // exits with complete = false
```

It computes a `complete` flag precisely for this, and even carries a comment claiming an incomplete fetch "will (correctly) suppress the destructive prune/sweep downstream" — but scopes that claim to non-delta fetches, and `getListTasks` discards `complete` entirely. So any 200 response with a short or empty page yields a `fullRemoteIds` set missing real tickets, `fetchSucceeded = true`, and deletion.

The non-delta sweep 50 lines above is correctly gated:

```ts
const fetchIsAuthoritative = fetchComplete && !resolutionFailed && rawItemCount > 0;  // :22320
if (!isDelta && fetchIsAuthoritative) { ... }                                          // :22472
```

That guard was added when this same class of bug was fixed on the full-import path (commit `28e465be`, 2026-07-08). The delta path was written alongside it with only the didn't-throw check and never received the equivalent treatment.

**Root cause 2 — a read fires the destructive write, on every list load.**

```js
// src/webview/tickets.js:6639 — inside case 'clickupProjectLoaded'
if (clickUpSelectedListId) {
    vscode.postMessage({ type: 'refreshTicketsDelta', workspaceRoot: ticketsWorkspaceRoot,
                         provider: 'clickup', listId: clickUpSelectedListId });
}
```

Unconditional. `loadClickUpProject` runs on panel open, list selection, provider switch, the Refresh button, and after every ticket create — so every one of those runs a sweep.

**This is not auto-sync.** `ticketsAutoSync` was `false` throughout, and `_updateTicketsAutoSyncWatcher` (`TicketsPanelProvider.ts:569`) is a **no-op stub** — "no-op in 2b" — because the timer system was never carried across in the panel split. There is no 45-second tick; the `45s` mentions in comments are leftovers from when tickets lived in `planning.js`. Anyone diagnosing this by looking for a timer will find nothing and conclude the sweep cannot be running. It runs from the list-load path.

**Root cause 3 — the reply-broadcast bug multiplies both.** `clickupProjectLoaded` is broadcast to every Tickets surface (see `feature_plan_20260805170000_tickets-cross-panel-reply-contamination`), so *every* open panel fires its own delta sweep off *any* panel's list load. Measured: one `clickupLoadProject` call produced 3 `importAllTicketsComplete`. Those concurrent sweeps each issue a full paginated ClickUp fetch, which raises the chance of the short response that triggers deletion — a feedback loop where load causes the condition that causes deletion.

**This explains "refetch does nothing".** A `forceFull` refetch was observed returning `successCount: 3` with the target directory still empty afterwards. The refetch worked; a concurrent panel-triggered delta sweep deleted its output moments later. The user sees a no-op.

### Fix already applied (2026-08-05, needs verification and a build)

`src/services/TaskViewerProvider.ts` delta sweep now reads completeness:

- ClickUp: `getListTasks(listId, {forceRefresh:true})` → `getListTasksLive(listId)` (the identical `_fetchListTasksInternal` call, but it returns `{tasks, complete}` instead of discarding the flag), then `fetchSucceeded = complete && fullRemoteIds.size > 0`.
- Linear: `fetchSucceeded = fullRemoteIds.size > 0`.
- Both non-authoritative paths log a warning naming the list/project and the reason.

**This is not live.** It is in `src/`; the running extension serves the installed VSIX's `dist/extension.js`. Deletions continue until a rebuild and reinstall.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, backend, frontend, tickets, data-loss

## Complexity Audit

**Moderate, and the risk is behavioural rather than structural.** The sweep gate is a few lines. The judgement calls are (a) what counts as authoritative for Linear, whose ID fetch reports no completeness at all, and (b) whether an intentionally-emptied remote list should still be swept. Both are decided below rather than left open.

Deletion is irreversible for anything not in git — `.switchboard/tickets/` is a working directory, and the sweep drops the DB row too, so there is no record that a file ever existed. Every ambiguous case must therefore resolve to "do not delete".

## Edge-Case & Dependency Audit

- **Genuinely-emptied remote list no longer sweeps.** `complete && size > 0` means deleting every task in ClickUp leaves the local files behind. This is deliberate and consistent: the non-delta path's `rawItemCount > 0` term already declines to sweep that case. Reconciling a deliberately-emptied list belongs to an explicit user action, not to a background refresh. Do not "fix" this by relaxing the gate.
- **Linear is still only half-gated.** `fetchAllIssueIds` (`LinearSyncService.ts:901`) returns a bare `Set<string>`; it breaks out of pagination on `!hasNextPage` (complete), on a missing cursor (ambiguous), and on `pageCount >= maxPages` (50 pages / 2500 issues — truncated). The applied fix blocks the catastrophic empty-set case but a truncated run still sweeps. Closing this properly means having `fetchAllIssueIds` return completeness alongside the set; check its other callers before changing the signature.
- **`getListTasksLive` ignores `includeClosed`.** It calls `_fetchListTasksInternal(listId, { forceRefresh: true })`, and with `includeClosed` undefined that resolves to `includeClosed = true` — the same superset the previous `getListTasks({forceRefresh:true})` call fetched. Behaviour is unchanged, and a superset is the safe direction for a deletion authority: closed tickets stay in `fullRemoteIds`, so their local files are not swept. Do not narrow this to open-only.
- **`targetDir` scoping is derived from the wrong source.** The sweep filters candidates with `path.dirname(t.filePath) === targetDir`, where `targetDir` comes from `clickup.getSelectedHierarchy()` — the *currently selected* space/folder/list names — not from the `listId` being refreshed. If the selection has moved on since the refresh was queued, the sweep compares one list's files against another list's remote IDs. A `_unknown/_unknown` directory already exists under the tickets root, which is what an unresolved hierarchy produces. Verify this before touching the sweep further; a plain path comparison is not a safe scope key.
- **Removing the auto-trigger must not break deletion detection.** `clickupProjectLoaded` firing `refreshTicketsDelta` is also how remotely-deleted tickets currently disappear locally. Moving reconciliation to the explicit Refresh / Refetch buttons is the intended trade: a read action stops performing destructive writes. State this in the UI copy if the buttons' meaning changes.
- **Sequence with the broadcast fix.** Plan `…170000` (scope-stamp and filter) removes the multiplier by stopping panels reacting to each other's `clickupProjectLoaded`. It is a real mitigation but not a substitute — a single panel can still hit a short fetch. Land the sweep gate first; it is the one that prevents data loss on its own.
- **No migration.** No stored state changes. The deleted rows are simply gone; recovery is re-import from the provider (or a backup), not a migration.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — verify the applied gate

Confirm the delta sweep reads `complete` for ClickUp and non-emptiness for Linear, and that both non-authoritative branches warn with the list/project id and the reason.

### 2. `src/services/LinearSyncService.ts` — report completeness

Change `fetchAllIssueIds` to return `{ ids: Set<string>; complete: boolean }`, with `complete = false` when the loop exits via the `maxPages` cap or a missing cursor. Update callers, and tighten the delta gate to `complete && ids.size > 0` to match ClickUp.

### 3. `src/webview/tickets.js:6639` — stop the read from triggering the write

Remove the unconditional `refreshTicketsDelta` post from the `clickupProjectLoaded` arm (and audit the Linear equivalent). Reconciliation stays on the explicit Refresh and Refetch buttons, which already post it. Keep the `loadLocalTicketFiles()` call — that is a read and is what repaints the sidebar.

### 4. `src/services/TicketsPanelProvider.ts:569` — resolve the stub

`_updateTicketsAutoSyncWatcher` is a no-op that the panel calls in two places as if it worked, and the setting is surfaced in the UI as if it did something. Either carry the timer system across from `planning.js` or remove the setting from the UI. Shipping a toggle that controls nothing is what made "I have auto sync turned off" a reasonable objection to a wrong diagnosis. Removing the toggle is the smaller change and is preferred unless background sync is actually wanted.

### 5. Guard the invariant with a test

Add a test that stubs a ClickUp fetch returning `complete: false` with a short task list and asserts `deletedCount === 0` and that no `unlink` occurred. This is the regression that must never return.

## Verification Plan

1. `npm run compile` and install the resulting VSIX — **the fix does not take effect until this happens**; the running extension serves `dist/extension.js` from the installed VSIX, not `src/`.
2. Unit test: short + incomplete ClickUp fetch → `deletedCount === 0`, no files unlinked.
3. Unit test: complete, non-empty fetch missing one previously-imported id → that one file is unlinked and its row removed (the sweep still works when authorised).
4. Unit test: empty-but-complete fetch → no deletion (the deliberate trade above).
5. Live: with the Tickets panel open on a list with files, force a short fetch (throttle or stub the ClickUp response) and confirm files survive and the warning names the list.
6. Live: open two Tickets panels on the same list, create a ticket, and confirm the file count never drops and no `imported_docs` rows disappear. Watch the Sprint 4 directory specifically — that is where the loss occurred.
7. Live: confirm `forceFull` Refetch's output survives — `successCount` files still present 30 s later.
8. `npm test` — no new failures. Five regression tests are already red at HEAD; stash-verify before attributing a failure to this change.

**User Review Required:** None.
