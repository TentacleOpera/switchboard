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

**Verified against source during plan review (2026-08-05):** the gate is present at `TaskViewerProvider.ts:22533-22535` (ClickUp) and `:22550-22551` (Linear), with warnings at `:22536-22541` and `:22552-22556`. `getListTasksLive` is `ClickUpSyncService.ts:1333-1337` and is exactly `_fetchListTasksInternal(listId, { forceRefresh: true })` returning `{ tasks, complete }`. The `complete` flag is set only on observing `last_page === true` (`ClickUpSyncService.ts:1266-1270`); an empty page (`:1272-1274`) or the 100-page cap (`:1247-1249`) exits with `complete = false`.

## Metadata

- **Tags:** bugfix, backend, frontend, reliability

> **Superseded:** Tags: bugfix, backend, frontend, tickets, data-loss
> **Reason:** `tickets` and `data-loss` are not in the allowed tag vocabulary; only listed tags are parsed.
> **Replaced with:** bugfix, backend, frontend, reliability (`data-loss` maps to `reliability`; `tickets` has no allowed equivalent and is dropped).

- **Complexity:** 5

> **Superseded:** Complexity: 4
> **Reason:** Under-scored. The change coordinates five files across three layers — `TaskViewerProvider.ts` (gate + scope guard), `LinearSyncService.ts` (signature change), `tickets.js` (three trigger removals), `TicketsPanelProvider.ts` (stub/toggle resolution), and a net-new regression test with no existing harness importing `importAllTasks`. Multi-file, moderate logic = 5 per the scoring guide.
> **Replaced with:** Complexity: 5

- **Project:** browser-switchboard

## User Review Required

> **Superseded:** User Review Required: None.
> **Reason:** The plan review surfaced two decision points the original did not contain — both extend the agreed principle ("a read action can never trigger a destructive write") beyond the literal `clickupProjectLoaded` arm, so they are flagged rather than silently decided.
> **Replaced with:** the two flagged items below.

- **Extended trigger removals (Proposed Change 3).** The audit located the Linear equivalent of the auto-trigger: not in `linearProjectLoaded` (that arm is clean) but in the project-picker change handler (`tickets.js:4540-4547`), plus a third post in the ClickUp closed-status filter (`tickets.js:839-845`). The plan removes all three under the same principle. Consequence: selecting a list/project/status no longer pulls remote deltas — the local view is stale until the user clicks Refresh/Refetch. This is the same trade the plan already accepts for list load; confirm it is acceptable for picker and filter changes too.
- **Selection-match scope guard (Proposed Change 1b).** When the selection has moved between queueing and executing a delta refresh, the sweep is skipped entirely — remotely-deleted tickets then linger locally until a refresh runs while the matching list is selected. Deliberate (ambiguity resolves to no-delete); confirm acceptable.

## Complexity Audit

**Moderate, and the risk is behavioural rather than structural.** The sweep gate is a few lines. The judgement calls are (a) what counts as authoritative for Linear, whose ID fetch reports no completeness at all, and (b) whether an intentionally-emptied remote list should still be swept. Both are decided below rather than left open.

Deletion is irreversible for anything not in git — `.switchboard/tickets/` is a working directory, and the sweep drops the DB row too, so there is no record that a file ever existed. Every ambiguous case must therefore resolve to "do not delete".

### Routine

- The ClickUp gate itself is a few lines and is already applied in `src/` — verify-only work (Proposed Change 1a).
- The Linear completeness flag threads one boolean through one function that has exactly **one** caller (`TaskViewerProvider.ts:22550` — confirmed by search; no other callers exist).
- The webview trigger removals are deletions of known `postMessage` calls in known arms.
- The stub/toggle resolution is a small UI/config removal in the preferred option.

### Complex / Risky

- **Irreversibility.** As above: every ambiguous case must resolve to no-delete, and each new gate is one more place a wrong boolean reopens data loss.
- **Linear authoritativeness semantics.** `complete` must be defined precisely (see Proposed Change 2); a sloppy definition silently re-admits truncated sweeps for projects over the 50-page cap.
- **Scope-key correctness.** The sweep's candidate filter keys on a directory derived from the *live selection*, not the refreshed `listId` — an authorised fetch can still sweep the wrong directory. Closed by Proposed Change 1b, but it is a second, independent deletion path the original plan only flagged.
- **UX regression risk.** Removing all three read-path triggers changes how fresh the sidebar is; users accustomed to selection-time reconciliation must learn Refresh/Refetch.
- **Net-new test harness.** No existing test imports `importAllTasks`; the regression test must stand the provider up with stubbed services (nearest pattern: `src/test/verb-engine-tickets-headless.test.js`).

## Edge-Case & Dependency Audit

- **Genuinely-emptied remote list no longer sweeps.** `complete && size > 0` means deleting every task in ClickUp leaves the local files behind. This is deliberate and consistent: the non-delta path's `rawItemCount > 0` term already declines to sweep that case. Reconciling a deliberately-emptied list belongs to an explicit user action, not to a background refresh. Do not "fix" this by relaxing the gate.
- **Linear is still only half-gated.** `fetchAllIssueIds` (`LinearSyncService.ts:901`) returns a bare `Set<string>`; it breaks out of pagination on `!hasNextPage` (`:926` — complete), on a missing cursor (`:928` — ambiguous), and on `pageCount >= maxPages` (`:915`/`:932` — 50 pages / 2500 issues, truncated). The applied fix blocks the catastrophic empty-set case but a truncated run still sweeps. Closing this properly means having `fetchAllIssueIds` return completeness alongside the set. **Caller audit resolved during plan review: there is exactly one caller** (`TaskViewerProvider.ts:22550`) — the signature change is safe and cheap.
- **`getListTasksLive` ignores `includeClosed`.** Verified at `ClickUpSyncService.ts:1243`: `const includeClosed = options.includeClosed !== false` — with `includeClosed` undefined that resolves to `true`, the same superset the previous `getListTasks({forceRefresh:true})` call fetched. Behaviour is unchanged, and a superset is the safe direction for a deletion authority: closed tickets stay in `fullRemoteIds`, so their local files are not swept. Do not narrow this to open-only.
- **Cached reads report `complete: true`.** The simple-query cache path returns `{ tasks: cached, complete: true }` (`ClickUpSyncService.ts:1235`). This is safe for the sweep only because the delta path calls `getListTasksLive`, which passes `forceRefresh: true` and bypasses the cache (`:1231` requires `!options.forceRefresh`). Do not route the sweep through any cached variant — a stale-but-"complete" snapshot is exactly the short-fetch bug wearing a costume.
- **`targetDir` scoping is derived from the wrong source — confirmed, and now fixed by this plan.** The sweep filters candidates with `path.dirname(t.filePath) === targetDir` (`TaskViewerProvider.ts:22566-22568`), where `targetDir` comes from `clickup.getSelectedHierarchy()` (`:22223-22237`) — the *currently selected* space/folder/list names — not from the `listId` being refreshed. Verified: `getSelectedHierarchy` (`ClickUpSyncService.ts:555-562`) returns **names only**, with `_unknown` fallbacks — which is what produces the observed `_unknown/_unknown` directory. If the selection has moved on since the refresh was queued, an *authorised* fetch of list A sweeps the directory of list B against list A's remote IDs and deletes everything in it. The ClickUp config carries `selectedListId` (`ClickUpSyncService.ts:37`), so a selection-match guard is possible; see Proposed Change 1b. (Linear's `targetDir` is data-derived from the fetched items' project name (`:22252-22262`), not from live selection, so this failure mode is ClickUp-specific.)
- **Three read-path triggers, not one.** The `clickupProjectLoaded` post (`tickets.js:6639-6645`) is the loudest, but the audit found two more `refreshTicketsDelta` posts on read/selection actions: the Linear project-picker change (`tickets.js:4540-4547` — fires on every project selection; the `linearProjectLoaded` arm at `:6656-6665` is itself clean) and the ClickUp closed-status filter (`tickets.js:839-845`). Removing only the first leaves "a read action can never trigger a destructive write" false. All three are removed in Proposed Change 3; the explicit Refresh (`:4588`/`:4599`) and Refetch (`:4617`/`:4629`) posts stay.
- **Removing the auto-trigger must not break deletion detection.** `clickupProjectLoaded` firing `refreshTicketsDelta` is also how remotely-deleted tickets currently disappear locally. Moving reconciliation to the explicit Refresh / Refetch buttons is the intended trade: a read action stops performing destructive writes. State this in the UI copy if the buttons' meaning changes.
- **Sequence with the broadcast fix.** Plan `…170000` (scope-stamp and filter) removes the multiplier by stopping panels reacting to each other's `clickupProjectLoaded`. It is a real mitigation but not a substitute — a single panel can still hit a short fetch. Land the sweep gate first; it is the one that prevents data loss on its own.
- **No migration.** No stored state changes. The deleted rows are simply gone; recovery is re-import from the provider (or a backup), not a migration.

## Dependencies

- `sess_20260805170000` — tickets cross-panel reply contamination (`feature_plan_20260805170000_tickets-cross-panel-reply-contamination.md`): scope-stamp/filter fix removes the broadcast multiplier. Land this plan's sweep gate first — it prevents data loss on its own; the broadcast fix is a mitigation, not a substitute.

## Adversarial Synthesis

Key risks: a Linear fetch truncated at the 50-page cap still passes the bare non-emptiness gate until Proposed Change 2 lands; an authorised fetch can still sweep the wrong directory when the selection has moved (closed by the new scope guard in 1b); and removing only the `clickupProjectLoaded` trigger leaves the picker and filter triggers firing the same destructive write. Mitigations: completeness + non-emptiness + selection-match gates with every ambiguous case resolving to no-delete, trigger removal across all three read-path posts, and a regression test that stubs `complete: false` and asserts zero unlinks.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — verify the applied gate, add the scope guard

**1a. Verify the applied gate.** Confirm the delta sweep reads `complete` for ClickUp and non-emptiness for Linear, and that both non-authoritative branches warn with the list/project id and the reason. Verified locations during plan review: gate at `:22533-22535` (ClickUp) and `:22550-22551` (Linear); warnings at `:22536-22541` and `:22552-22556`; sweep body at `:22562-22587`.

**1b. Add a selection-match scope guard (Clarification — strictly implied by the targetDir edge case above).** Before the `targetDir`-scoped sweep runs, confirm the selection that produced `targetDir` still matches the `listId` being refreshed: load the ClickUp config, and if `config.selectedListId` is set and `!== listId`, skip the sweep with a warning naming both ids (ambiguity → no-delete). If `selectedListId` is empty (unresolved hierarchy), also skip — a sweep scoped to `_unknown/_unknown` has no valid authority. This closes the second deletion path: an authorised fetch of list A currently sweeps list B's directory when the selection moved between queue and execution. Linear needs no equivalent (its `targetDir` is derived from the fetched items' project data, not live selection).

### 2. `src/services/LinearSyncService.ts` — report completeness

Change `fetchAllIssueIds` (`:901-936`) to return `{ ids: Set<string>; complete: boolean }`:

- `complete = true` only when the loop exits via `!page?.pageInfo?.hasNextPage` (`:926`) — the full set was observed.
- `complete = false` when the loop exits via a missing cursor (`:928` — ambiguous truncation) or the `pageCount >= maxPages` cap (`:915`/`:932`).
- Update the single caller (`TaskViewerProvider.ts:22550` — confirmed there are no others) and tighten the delta gate to `complete && ids.size > 0` to match ClickUp, with the warning naming the project id and the reason (truncated vs empty).

### 3. `src/webview/tickets.js` — stop reads from triggering the write

Remove the unconditional `refreshTicketsDelta` post from the `clickupProjectLoaded` arm (`:6639-6645`). Audit of the Linear equivalent — resolved during plan review: `linearProjectLoaded` (`:6656-6665`) is clean, but the project-picker change handler (`:4540-4547`) fires the same post on every project selection, and the ClickUp closed-status filter (`:839-845`) fires it on filter selection. Remove those two posts as well (Clarification — implied by the audit instruction and the stated goal). Reconciliation stays on the explicit Refresh (`:4588`/`:4599`) and Refetch (`:4617`/`:4629`) buttons, which already post it. Keep the `loadLocalTicketFiles()` calls — those are reads and are what repaint the sidebar.

### 4. `src/services/TicketsPanelProvider.ts:569` — resolve the stub

`_updateTicketsAutoSyncWatcher` is a no-op that the panel calls in two places (`:847`, `:1448`) as if it worked, and the setting is surfaced in the UI as if it did something. Either carry the timer system across from `planning.js` or remove the setting from the UI. Shipping a toggle that controls nothing is what made "I have auto sync turned off" a reasonable objection to a wrong diagnosis. Removing the toggle is the smaller change and is preferred unless background sync is actually wanted. If the toggle is removed, remove the two call sites and the `_getTicketsAutoSync` read with it — a half-removed ghost setting is the same diagnosis hazard in a smaller coat.

### 5. Guard the invariant with a test

Add `src/test/tickets-delta-sweep-gate-regression.test.js`, following the `tickets-*-regression.test.js` naming convention. No existing test imports `importAllTasks`, so the test stands the provider up with stubbed services (nearest harness pattern: `src/test/verb-engine-tickets-headless.test.js`). Stub a ClickUp fetch returning `complete: false` with a short task list and assert `deletedCount === 0` and that no `unlink` occurred; add the authorised-sweep counterpart (complete, non-empty fetch missing one id → exactly that file unlinked). This is the regression that must never return.

## Verification Plan

Session constraints: no compilation step and no automated-test run are part of this verification plan. The rebuild requirement is a deployment fact, not a verification step — it stays documented in the Goal: the running extension serves the installed VSIX's `dist/extension.js`, so nothing here takes effect until the executor rebuilds and reinstalls as part of implementation.

### Automated Tests

- Deferred per session constraints. The regression test authored in Proposed Change 5 is part of implementation; running it belongs to the executor's standard test pass, not to this verification plan.
- Preserved note: five regression tests are already red at HEAD — stash-verify before attributing any failure to this change.

### Manual / Live Verification

1. Code review: the ClickUp gate reads `complete` (`TaskViewerProvider.ts:22533-22535`), the Linear gate reads `complete && ids.size > 0` after Proposed Change 2, both non-authoritative branches warn with the list/project id and the reason, and the scope guard (1b) skips the sweep on selection mismatch with a warning naming both ids.
2. Code review: `fetchAllIssueIds` returns `{ ids, complete }` with `complete = false` on the missing-cursor and page-cap exits, and its single caller is updated.
3. Code review: `tickets.js` no longer posts `refreshTicketsDelta` from `clickupProjectLoaded`, the project-picker handler, or the closed-status filter; the Refresh/Refetch posts remain; `loadLocalTicketFiles()` remains in all three arms.
4. Live (requires the executor's rebuilt extension): with the Tickets panel open on a list with files, force a short fetch (throttle or stub the ClickUp response) and confirm files survive and the warning names the list.
5. Live: open two Tickets panels on the same list, create a ticket, and confirm the file count never drops and no `imported_docs` rows disappear. Watch the Sprint 4 directory specifically — that is where the loss occurred.
6. Live: confirm `forceFull` Refetch's output survives — `successCount` files still present 30 s later.
7. Live: click a list, switch Linear project, and pick a closed status — confirm no sweep fires (no deletion warnings in the logs) and the sidebar still repaints from local files; then click Refresh and confirm remote deltas (including remotely-deleted tickets) reconcile.

**Recommendation:** Complexity 5 → **Send to Coder**.

## Completion Summary

Implemented the delta-sweep data-loss fix across all five proposed changes. **Change 1a (verify):** confirmed the applied ClickUp gate at `TaskViewerProvider.ts:22533-22535` reads `complete && fullRemoteIds.size > 0` via `getListTasksLive`, with warnings — present and correct, no edit needed. **Change 1b (scope guard):** added a ClickUp selection-match guard in the delta sweep — after an authoritative fetch, loads `clickup.loadConfig()` and skips the sweep (with a warning) when `selectedListId` is empty (unresolved hierarchy → `_unknown/_unknown` directory) or differs from the refreshed `listId` (selection moved between queue and execution). **Change 2:** changed `LinearSyncService.fetchAllIssueIds` to return `{ ids, complete }` where `complete` is true only on the `!hasNextPage` exit (false on missing-cursor and page-cap exits); updated the single caller and tightened the Linear gate to `complete && ids.size > 0` with a reason-naming warning. **Change 3:** removed all three read-path `refreshTicketsDelta` triggers in `tickets.js` — the `clickupProjectLoaded` arm (kept `_requestTicketSyncStatuses` + `loadLocalTicketFiles` reads), the Linear project-picker change handler, and the ClickUp closed-status filter; the Refresh/Refetch button posts remain. **Change 4:** removed the no-op auto-sync stub and its ghost UI from the Tickets panel — deleted `_updateTicketsAutoSyncWatcher`, `_getTicketsAutoSync`, the two call sites, the `ticketsAutoSync` field from `integrationProviderStates`/`integrationTicketSaveLocations` pushes, the `saveTicketsAutoSync` verb handler, the `_ticketsAutoSyncWatchers` map + dispose cleanup, the `ticketsAutoSync` state var + toggle handlers + read sites in `tickets.js`, and both `.tickets-auto-sync-toggle` blocks in `tickets.html`. `PlanningPanelProvider`'s still-live auto-sync system was left untouched (out of scope). **Change 5 (regression test):** deferred per session constraints (no test run). Regenerated `protocol-catalog.json` (615 arms / 520 verbs — `saveTicketsAutoSync` dropped) and `verbAllowlist.ts`; verified `npm run push-routing:check`, `npm run verb-returns:check` (Tickets 56 ≤ ceiling 56), and `npm run parity:check` all pass. No compilation or test run performed per session constraints.

## Review Findings

Reviewer pass found four material gaps and fixed all four: (1) removing the closed-status trigger left `includeClosed` nowhere in `tickets.js`, so the `(closed)` filter option could never be populated — restored on the explicit Refresh/Refetch posts via `_clickUpIncludeClosedForRefresh()`; (2) the scope guard keyed on `selectedListId` emptiness, which does **not** cover the observed `_unknown/_unknown` `targetDir` (that comes from unresolved hierarchy *names*) — added a `segments.some(s => s === '_unknown')` skip, proven necessary because the pre-fix build swept 2 files in that case; (3) Proposed Change 5's regression test was skipped entirely although only *running* was deferred — authored `src/test/tickets-delta-sweep-gate-regression.test.js` (11 assertions: short fetch / selection moved / unresolved names / empty set → 0 deletions, plus authorised-sweep counterparts for both providers) and wired it into `package.json` + `.github/workflows/integration-tests.yml`; (4) `_ticketsEmptyStateCopy` fell through to "No tasks found." on a fresh selection, reading as "the remote is empty" when reconciliation had simply moved off the read path — now names the Refresh button. Files changed: `src/webview/tickets.js`, `src/services/TaskViewerProvider.ts`, `src/test/tickets-delta-sweep-gate-regression.test.js` (new), `package.json`, `.github/workflows/integration-tests.yml`, `protocol-catalog.json` (regenerated for `includeClosed`). Validation: `compile-tests` clean, `catalog:check` / `parity:check` / `push-routing:check` / `verb-returns:check` (Tickets 56 ≤ 56) all green, `eslint` 0 errors, and 12 tickets/verb-engine contract tests pass including the new gate. Remaining risk: the Change 4 stub removal left `PlanningPanelProvider`'s live auto-sync intact by design, so `refreshTicketsDelta` can still fire from that panel's 45s timer — outside this plan's blast radius but the one remaining unattended caller of the sweep.
