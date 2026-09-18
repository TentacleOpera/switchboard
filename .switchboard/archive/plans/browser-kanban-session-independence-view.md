# Board Kanban: Client-Side Project Filter (Skip Refresh on Dropdown Change)

## Metadata

- **Complexity:** 4
- **Tags:** frontend, backend, performance, ui, ux, bugfix, refactor
- **Project:** switchboard

## Goal

Make the board kanban view (`kanban.html`) snappy and independent on both browser and extension by adopting the project panel's proven client-side filter pattern. Changing the project filter dropdown must be instant — no 5-second backend round-trip, no cross-UI lock. Preserve auto-stamping and dispatch scoping by keeping the cheap backend state write, just skipping the expensive refresh.

### Problem

The board kanban view treats the project filter as backend state that requires a full refresh on every change. The flow is:

1. User changes dropdown → board posts `setProjectFilter` (kanban.html:8197)
2. Backend handler: `setProjectFilter()` writes `_projectFilter` in-memory + `db.setConfig('kanban.activeProjectFilter', ...)` (KanbanProvider.ts:6454-6467) — **fast**
3. Backend handler: `await this._refreshBoard(workspaceRoot)` (KanbanProvider.ts:7482) — **~5 seconds** (full DB read + card recomputation + broadcast)
4. Only after step 3 does the board receive `updateBoard` + `updateWorkspaceSelection` via WS and re-render

This causes two symptoms:

- **5-second freeze:** The dropdown change blocks on a full backend refresh that the user didn't need — they just wanted to see different cards.
- **Cross-UI lock:** `updateWorkspaceSelection` (broadcast on every refresh) overwrites `activeProjectFilter` and rebuilds the dropdown (kanban.html:7110-7128). The browser receives this via WS and its dropdown snaps back to the webview's project. Both UIs are coupled to the singleton `_projectFilter` (KanbanProvider.ts:218) and reset each other on every refresh.

Additionally, `refreshWithData` early-returns if `!this._panel` (KanbanProvider.ts:1737) — so if the VS Code panel is closed, the browser's filter change writes the DB but gets no `updateBoard` broadcast at all. (The plan watcher / `switchboard.refreshUI` path still runs without a panel, but the final card broadcast is gated downstream in `refreshWithData`.)

### Root Cause

The board view reinvented a heavier pattern than necessary. The project panel's kanban tab (`project.js`) already solved this correctly:

- **Fetch all plans** → cache in `_kanbanPlansCache` (all projects, all columns)
- **Filter entirely client-side** — `getFilteredKanbanPlans()` filters the cache by `kanbanFilters.project`, `.column`, `.workspaceRoot`, `.search` (project.js:1602-1617)
- **Dropdown change is instant** — `kanbanProjectFilter.addEventListener('change', ...)` sets `kanbanFilters.project` and calls `renderKanbanPlans()` (project.js:2250-2253). No backend call, no broadcast, no coupling.
- **Live updates** — backend pushes `refreshKanbanPlans` → panel re-fetches → cache updates → re-renders with local filter preserved.

The board view instead round-trips to the backend on every filter change, and the backend pre-filters cards by `_projectFilter` before broadcasting (TaskViewerProvider.ts:17425-17427, via `KanbanProvider.refreshWithData`), so the board never has all cards locally and can't filter client-side.

### Key Insight: What `setProjectFilter` Actually Does

`setProjectFilter` (KanbanProvider.ts:6454) does three things:
1. `this._projectFilter = filter` — in-memory singleton update, **instant**
2. `db.setConfig('kanban.activeProjectFilter', ...)` — DB config write, **fast** (this is what the plan watcher reads to auto-stamp new plans)
3. `await this._refreshBoard(workspaceRoot)` — full DB read + card recomputation + broadcast, **~5 seconds**

Steps 1-2 are cheap and are what keep auto-stamping and dispatch scoping working. Step 3 is the freeze. The fix: keep 1-2, skip 3, filter client-side.

### Desired Behavior

- Changing the project filter dropdown is instant: update a local filter variable, re-render from cached cards. No 5-second wait.
- The board view caches ALL cards (all projects) locally and filters client-side, exactly like the project panel.
- Auto-stamping keeps working: the board still writes `kanban.activeProjectFilter` to the DB config on filter change (cheap, no refresh). The plan watcher reads this key to stamp new plans.
- Dispatch scoping keeps working: the board still updates the singleton `_projectFilter` in-memory on filter change (cheap, no refresh). Dispatch/prompt generation reads this singleton.
- The browser and webview never reset each other's dropdown — each owns its local view filter; the shared backend state (singleton + DB config) is for stamping/dispatch, not for view rendering.
- Live updates still work: when plans change, the backend pushes `updateBoard` with all cards; the board re-renders with the local filter still applied.
- No separate dispatch-scoping plan needed — the singleton is still updated.

## User Review Required

This plan corrects two backend targeting errors found during the improve pass (Steps 1 and 5 originally pointed at dead/wrong functions). Reviewer should confirm the corrected live-path targets (`TaskViewerProvider._refreshRunSheetsImpl` and `KanbanProvider.refreshWithData`) match current architecture before dispatch.

## Complexity Audit

### Routine
- Frontend `updateBoard` handler change: cache `allCards`, filter client-side (kanban.html:7194) — mirrors the proven `project.js` pattern.
- Frontend `updateWorkspaceSelection` handler change: stop overwriting the local filter, preserve selection (kanban.html:7110).
- Frontend dropdown change handler: local filter + lightweight `setProjectFilter` post with `noRefresh: true` (kanban.html:8171).
- Backend `case 'setProjectFilter'`: add `noRefresh` flag guard (KanbanProvider.ts:7478) — additive, backward compatible.

### Complex / Risky
- Backend filter-point relocation: change `TaskViewerProvider._refreshRunSheetsImpl` (line 17425-17427) to send unfiltered cards. Touches the single shared refresh path that feeds BOTH sidebar and kanban — must not regress the sidebar.
- Browser-only gate relaxation in `refreshWithData` (KanbanProvider.ts:1737): removing/loosening the `!this._panel` early-return changes broadcast behavior when the panel is closed. Must ensure no-op early-out and workspace-root guard still hold, and that auxiliary messages don't misfire without a panel.
- Column-occupancy correctness: once unfiltered cards flow client-side, the board must compute occupancy from `allCards` (not filtered `currentCards`) or hidden columns lose their counts.

## Edge-Case & Dependency Audit

- **Race Conditions:** A `setProjectFilter` post with `noRefresh: true` writes the singleton + DB config without a refresh. If a file-watcher-triggered `refreshUI` fires concurrently, `_refreshRunSheetsImpl` reads the just-updated `_projectFilter` — but since the broadcast is now unfiltered, the stale singleton read no longer corrupts the card set. The local `boardProjectFilter` is owned client-side and is never raced by the broadcast. Safe.
- **Security:** No new surface. The `noRefresh` flag is a boolean hint; `setProjectFilter` still validates `msg.project` is `null | string` before writing.
- **Side Effects:** Sending unfiltered cards increases the `updateBoard` WS payload size. The DB read cost is unchanged (TaskViewerProvider already reads once). For very large workspaces, consider a lightweight card projection (omit full plan text) — noted as a future optimization, not a blocker.
- **Dependencies & Conflicts:** The `repoScope` filter (`_repoScopeFilter`) is a separate backend scoping concern and MUST stay server-side. Only the project filter moves client-side. The sidebar (`TaskViewerProvider._view`) consumes the same `activeRows` snapshot — changing the filter branch affects what the sidebar receives too; verify the sidebar still filters/renders correctly (it applies its own column/ghost filtering downstream at line 17446+).

## Dependencies

- None — single-plan, self-contained. No prerequisite sessions.

## Adversarial Synthesis

Key risks: (1) the corrected backend targets touch the one shared refresh path feeding both sidebar and kanban — a regression there breaks two surfaces; (2) loosening the `refreshWithData` panel gate changes broadcast behavior when the panel is closed and must preserve the no-op early-out and workspace-root guard; (3) column occupancy must be recomputed from unfiltered `allCards` client-side or hidden columns lose counts. Mitigations: keep `repoScope` server-side, preserve the sidebar's downstream filtering, and gate the panel-closed broadcast on `_broadcaster` existence (already how `postMessage` routes to WS).

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_refreshRunSheetsImpl` (~line 17425)

**Context:** This is the LIVE broadcast path. `switchboard.refreshUI` → `_refreshRunSheets` → `_refreshRunSheetsImpl` reads the DB once, pre-filters cards by `_projectFilter`, then hands the filtered set to `KanbanProvider.refreshWithData`, which builds cards and posts `updateBoard`.

> **Superseded:** The original plan targeted `KanbanProvider._refreshBoardImpl` (~line 3298) to "send unfiltered cards in `updateBoard`" and claimed it could reuse `allActiveRows` (line 1808-1812).
> **Reason:** `_refreshBoardImpl` has zero call sites — it is dead code (the file documents its neighbor `_refreshBoardWithData` as "zero call sites" at line 3478; only comments reference `_refreshBoardImpl`). Editing it would change nothing. The `allActiveRows` computation at 1808-1812 lives inside that dead function and is not reusable from the live path.
> **Replaced with:** Change the filter branch in `TaskViewerProvider._refreshRunSheetsImpl` (line 17425-17427). This function already performs the single DB read; just drop the project-filter branch and always read unfiltered, keeping the `repoScope` branch.

**Logic:**
```ts
// Current (line 17422-17430):
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;
const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = (projectFilter !== null || repoScope)
    ? await db.getCompletedPlansFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getCompletedPlans(workspaceId);

// Change: keep repoScope server-side, drop projectFilter from the DB query.
// The board view filters by project client-side; repoScope is a backend scoping concern.
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const activeRows = repoScope
    ? await db.getBoardFilteredByProject(workspaceId, null, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = repoScope
    ? await db.getCompletedPlansFilteredByProject(workspaceId, null, repoScope)
    : await db.getCompletedPlans(workspaceId);
```

**Implementation:**
- Remove `projectFilter` from the branch condition at line 17425 and 17428; keep `repoScope`.
- Pass `null` for the project argument to `getBoardFilteredByProject` when `repoScope` is active (so repo scoping still applies, project scoping does not).
- `refreshWithData` (line 17442) receives the unfiltered set and broadcasts it; the board filters client-side.

**Edge Cases:**
- The sidebar (`_view`) also consumes `activeRows` (line 17446+). It applies its own ghost-plan + column + exclude-reviewed-backlog filtering downstream, but it may rely on the project pre-filter for correctness. **Verify** the sidebar still renders the right plans — if it depended on server-side project filtering, it will now show all projects and need its own client-side project filter too. Flag for reviewer: confirm whether the sidebar has a project filter UI or relies on the pre-filter.
- `refreshWouldBeNoOp` (line 17402) keys on `(workspaceId|projectFilter|repoScope|dataVersion|configEpoch)`. With projectFilter no longer affecting the broadcast payload, the no-op key must still change when the project filter changes (so a filter switch isn't wrongly skipped as a no-op). Since the board now filters client-side and `noRefresh` skips the refresh entirely on dropdown change, the no-op key is only relevant for file-watcher-triggered refreshes — which legitimately should still push. Confirm the key still includes `projectFilter` so config-epoch changes (project override toggle) force a push.

### `src/services/KanbanProvider.ts` — `case 'setProjectFilter'` (~line 7478)

**Context:** The webview message handler for project-filter changes. Currently always calls `_refreshBoard` after `setProjectFilter`.

**Logic:** Add a `noRefresh` opt-out:
```ts
case 'setProjectFilter': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
        await this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        if (!msg.noRefresh) {
            await this._refreshBoard(workspaceRoot);  // legacy/full refresh path
        }
        return { success: true };
    }
    return { success: false, error: 'No workspace root or invalid project' };
}
```

**Implementation:** Single-line guard around the existing `_refreshBoard` call. `setProjectFilter` (line 6454) still runs unconditionally — so the singleton update + DB config write (steps 1-2) and the project-override reload (line 6475) still fire. Only the expensive refresh (step 3) is skipped.

**Edge Cases:**
- `noRefresh` is additive: existing callers without the flag still get the full refresh (backward compatible).
- The project-override path (line 6475, `_projectOverrideEnabled`) reloads scoped settings and bumps config epoch on every `setProjectFilter`. With `noRefresh`, the epoch bump happens but no board refresh follows — the board will pick up the new override values on the NEXT file-watcher-triggered `updateBoard`. Acceptable for a filter-only change; if instant override reflection is required, the board can re-render from cached cards using the pushed `updateOverrideState` message. Flag for reviewer.

### `src/services/KanbanProvider.ts` — `refreshWithData` (~line 1737)

**Context:** The public method that builds cards and broadcasts `updateBoard`. It early-returns when `!this._panel`, which blocks the browser from receiving live updates when the VS Code panel is closed.

> **Superseded:** The original plan targeted `_refreshBoard` (~line 3194) to fix the browser-only early-return, proposing "if `!this._panel` but a wsHub is connected, still run the refresh and broadcast via `mirrorToWs`."
> **Reason:** `_refreshBoard` (line 3194) no longer contains the broadcast logic — it delegates to `vscode.commands.executeCommand('switchboard.refreshUI')` (line 3205), which runs `_refreshRunSheetsImpl` WITHOUT a panel gate. The actual block is downstream in `refreshWithData` (line 1737: `if (!this._panel) return`), which is the method `_refreshRunSheetsImpl` calls at line 17442. Patching `_refreshBoard`'s gate changes nothing.
> **Replaced with:** Relax the gate in `refreshWithData` (line 1737) to allow broadcasting when there is no panel but a `_broadcaster` (WS/API mirror) exists.

**Logic:**
```ts
// Current (line 1737-1740):
if (!this._panel) {
    console.warn('[KanbanProvider] refreshWithData: no panel — skipping');
    return;
}

// Change: allow the broadcast when a broadcaster (WS/API mirror) is attached,
// even if the VS Code webview panel is closed. The postMessage() helper already
// routes to _broadcaster.push() when _broadcaster is set (line 2009-2010),
// so auxiliary + updateBoard messages will reach the browser.
if (!this._panel && !this._broadcaster) {
    console.warn('[KanbanProvider] refreshWithData: no panel and no broadcaster — skipping');
    return;
}
```

**Implementation:**
- Replace the `!this._panel` guard with `!this._panel && !this._broadcaster`.
- `postMessage` (line 2008-2017) already prefers `_broadcaster.push` when present and falls back to `_panel.webview.postMessage` — so no change needed there; messages route to WS when only the broadcaster is attached.
- The workspace-root guard (line 1747-1753) and the no-op early-out (line 1771) still run and keep the broadcast correct.

**Edge Cases:**
- Auxiliary messages (`updateColumns`, `updateWorkspaceSelection`, `updateAgentNames`, override state, etc.) will now also broadcast to the browser when the panel is closed. These are harmless for the browser (it already handles them), but confirm none assume a webview exists.
- The `_pendingWebviewMessages` queue (line 2015) is only used when there's a panel but it's not ready — unaffected by this change (the broadcaster path is taken first when `_broadcaster` is set).

### `src/webview/kanban.html` — `updateBoard` handler (~line 7194)

**Context:** The board receives cards and renders them. Currently renders the pre-filtered set directly.

**Logic:** Cache the full set; filter client-side:
```js
// On receiving updateBoard (msg.cards is now the unfiltered set per the TaskViewerProvider change):
allCards = msg.cards;
currentCards = boardProjectFilter
    ? allCards.filter(c => c.project === boardProjectFilter)
    : allCards;
renderBoard(currentCards);
```

**Implementation:**
- Introduce module-level `let allCards = [];` and `let boardProjectFilter = null;` (initialize `boardProjectFilter` from `activeProjectFilter` on first load so it starts in sync with the backend, then own it locally).
- In the `updateBoard` case, store `allCards = msg.cards` before rendering, then apply the local filter.
- Compute column occupancy from `allCards` (not `currentCards`) so hidden columns with cards in other projects still show occupancy.

**Edge Cases:**
- `boardProjectFilter` must distinguish "no filter" (`null`) from "unassigned" (`__unassigned__`). Match the existing `activeProjectFilter` semantics.
- If `msg.cards` is empty (no plans), still render empty columns from `allCards` occupancy (zero) — no special case needed.

### `src/webview/kanban.html` — `updateWorkspaceSelection` handler (~line 7110)

**Context:** Broadcast on every refresh; currently overwrites `activeProjectFilter` and rebuilds the dropdown, snapping the browser's selection back to the webview's project.

**Logic:**
- Keep the workspace-level sync (workspace root, workspace items, `allWorkspaceProjects`) — both UIs should agree on the active workspace.
- Do NOT overwrite `boardProjectFilter` from `msg.projectFilter`. The board owns its filter locally.
- Rebuild the dropdown options from `allWorkspaceProjects` (so new projects appear), but preserve the current `boardProjectFilter` selection.

**Edge Cases:**
- If the workspace itself changes (different root), reset `boardProjectFilter` to the new workspace's backend-reported filter (the user switched workspaces, not projects). Detect by comparing `msg.workspaceRoot` to the previously stored root.

### `src/webview/kanban.html` — `workspace-project-select` change handler (~line 8171)

**Context:** The dropdown change handler. Currently posts `setProjectFilter` and waits for the full refresh.

**Logic:** Local filter + lightweight backend write:
```js
// Same-workspace project filter change:
boardProjectFilter = selectedProject;
// Re-render instantly from cache (like project.js:2250-2253):
currentCards = boardProjectFilter ? allCards.filter(c => c.project === boardProjectFilter) : allCards;
renderBoard(currentCards);
// Lightweight backend write for stamping/dispatch (no refresh):
postKanbanMessage({ type: 'setProjectFilter', project: selectedProject, noRefresh: true });
```

**Edge Cases:**
- If the user switches workspace via the same dropdown, do NOT send `noRefresh` — a workspace switch legitimately needs a full refresh (different DB, different projects). Detect workspace-vs-project change in the handler.

## Verification Plan

### Automated Tests
- **SKIP:** Per session directive, no automated tests are run as part of this plan's verification. Existing kanban regression tests should be run by the coder post-implementation, but the plan itself does not gate on them.

### Manual Verification
1. **Snappy dropdown (browser):** Open the browser kanban. Change the project filter dropdown. Confirm the board re-renders in <100ms. DevTools Network tab shows the `setProjectFilter` POST with `noRefresh: true` — response is immediate.
2. **Snappy dropdown (webview):** Open the VS Code webview board. Change the project filter dropdown. Confirm instant re-render, no 5-second wait.
3. **Independence:** Open BOTH browser and webview. Set browser to "Project X", webview to "Project Y". Confirm neither resets the other's dropdown. Change plans in one — the other's filter stays.
4. **Auto-stamping preserved:** Set the board to "Project X". Create a new plan file in the watched workspace. Confirm the plan is auto-stamped with "Project X" (verify in the DB or the plan's metadata). This confirms the DB config write still happens.
5. **Dispatch scoping preserved:** Set the board to "Project X" (which has project-tier role config overrides). Dispatch a prompt. Confirm the prompt uses Project X's role config and PRD. This confirms the singleton update still happens.
6. **Live updates preserved:** With the board open, create a new plan file. Confirm the new card appears (filtered by the local project filter if it matches, hidden if not). The local filter is preserved across the live update.
7. **Browser-only scenario:** Close the VS Code panel. Open only the browser. Change the project filter. Confirm the board updates. Create a new plan. Confirm it appears live and is auto-stamped. (This validates the `refreshWithData` gate relaxation.)
8. **Sidebar regression check:** Open the sidebar. Confirm it still renders the correct plans after the `TaskViewerProvider` filter-branch change. If the sidebar relied on server-side project filtering, file a follow-up — do NOT silently break it.
9. **Project panel unchanged:** Open the project panel's kanban tab. Confirm it still works exactly as before (not touched by this plan).
10. **Column occupancy:** With a project filter active, confirm columns that hold cards ONLY in other (hidden) projects still show their occupancy counts correctly (computed from `allCards`, not `currentCards`).

## Risks & Edge Cases

- **Unfiltered card volume:** Sending all cards increases the `updateBoard` payload. The DB read cost is unchanged (TaskViewerProvider already reads once). The WS payload is larger but contains the same card set the DB already computes. If this is a concern for very large workspaces, add a lightweight board-card projection (omit full plan text, send only card metadata) — future optimization, not a blocker.
- **Column occupancy:** The board view must compute column occupancy from the unfiltered `allCards` (so hidden columns with cards in other projects still show occupancy), not from the filtered `currentCards`. Ensure the board's occupancy computation uses `allCards`.
- **`repoScope` filter:** Backend scoping concern (repo-level), not a view toggle. Keep filtering by `repoScope` server-side. Only the project filter moves client-side.
- **Sidebar dependency:** `TaskViewerProvider._refreshRunSheetsImpl` feeds both sidebar and kanban from one snapshot. Changing the filter branch affects both. The sidebar applies downstream filtering (ghost plans, column, exclude-reviewed-backlog) but may have relied on the project pre-filter. Reviewer must confirm the sidebar still shows the right plans; if not, the sidebar needs its own client-side project filter (follow-up plan).
- **`updateWorkspaceSelection` still broadcasts:** The board view now ignores the `projectFilter` field in this message (it owns its local filter). The workspace-level fields (root, items, projects list) are still synced. Dropdown options rebuild from `allWorkspaceProjects`; selection is preserved.
- **Webview also gets unfiltered cards:** The VS Code webview board also receives unfiltered cards and filters client-side — desired unification. Its local `boardProjectFilter` initializes from `activeProjectFilter` on first load, then is owned locally.
- **`noRefresh` flag is additive:** Existing callers of `setProjectFilter` without `noRefresh` still get the full refresh (backward compatible). Only the board view's dropdown handler sends `noRefresh: true`.
- **Project-override on filter switch:** `setProjectFilter` reloads scoped settings + bumps config epoch (line 6475) even with `noRefresh`. The board picks up new override values on the next file-watcher-triggered `updateBoard`. Acceptable for filter-only changes; flag if instant override reflection is required.

## Uncertain Assumptions

The following were flagged during planning and verified directly against current source (no web research needed — all confirmed by reading the code):
- **CONFIRMED:** `_refreshBoardImpl` (KanbanProvider:3298) is dead code (zero call sites). The live path is `TaskViewerProvider._refreshRunSheetsImpl` → `KanbanProvider.refreshWithData`.
- **CONFIRMED:** The browser-only early-return block is in `refreshWithData` (KanbanProvider:1737), not `_refreshBoard` (3194, which now delegates to `switchboard.refreshUI`).
- **UNVERIFIED — reviewer must confirm:** Whether the sidebar (`TaskViewerProvider._view`) relies on the server-side project pre-filter for correctness. If it does, the filter-branch change in `_refreshRunSheetsImpl` will make the sidebar show all projects' plans, requiring a sidebar-side client-side project filter (follow-up plan). This is the one assumption that could not be confirmed from the read path alone and should be checked at implementation time.

No web research is needed for this plan — all code-level uncertainties were resolved by direct source inspection. The single remaining uncertainty (sidebar project-filter dependency) is an implementation-time verification, not a research question.

## Completion Summary

Implemented the client-side project filter for the board kanban view so dropdown changes are instant and browser/webview are independent. The backend (`TaskViewerProvider._refreshRunSheetsImpl`) now sends unfiltered cards (repoScope still applied server-side); the sidebar's `filterByProjectScope` was extended to filter by project name client-side so the sidebar does not regress (resolving the plan's UNVERIFIED sidebar assumption). `KanbanProvider` gained a `noRefresh` opt-out on `case 'setProjectFilter'` (cheap singleton + DB config write still fires for auto-stamping/dispatch) and the `refreshWithData` panel gate was relaxed to `!this._panel && !this._broadcaster` so the browser gets live updates when the VS Code panel is closed. `kanban.html` now caches `allCards` (unfiltered) and filters client-side via a board-owned `boardProjectFilter` (seeded from the backend on first load / workspace switch, then owned locally); column occupancy is computed from `allCards`, `updateWorkspaceSelection` no longer overwrites the local filter on same-workspace refreshes, the dropdown change handler re-renders instantly and posts `setProjectFilter` with `noRefresh: true`, and moveCards/moveCardsFailed keep `allCards` in sync.

Files changed: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`. No issues encountered; per session directives, compilation and automated tests were skipped.

## Review Findings

Independent reviewer pass (in-place). Verified the implementation against the plan's four change sites plus the adversarial regression axes (caller/consumer trace, double-trigger, race, orphaned refs, full UI→state path). Files changed: `src/services/TaskViewerProvider.ts` (filter-branch relocation + sidebar `filterByProjectScope` client-side extension), `src/services/KanbanProvider.ts` (`noRefresh` guard on `case 'setProjectFilter'` + `refreshWithData` gate relaxed to `!this._panel && !this._broadcaster`), `src/webview/kanban.html` (`allCards` cache, `boardProjectFilter`, `applyBoardProjectFilter`, `computeColumnOccupancy`/`refreshColumnCounts`, `updateWorkspaceSelection` re-seed-on-workspace-change, dropdown `noRefresh: true` post, moveCards/moveCardsFailed cache sync). No CRITICAL or MAJOR findings — no code fixes applied. The investigated `projectFilter === ''` sidebar edge is unreachable (dropdown only emits `__unassigned__`/names; DB restore never sets `_projectFilter = ''`). Residual risks (all pre-documented and accepted by the plan): (1) sidebar now filters by denormalized `row.project` name instead of the old `project_id` JOIN — plans with stale name-but-correct-id hide, matching the board's own client-side filter for consistency; (2) `buildBoardSignature(allCards)` runs on the larger unfiltered set each `updateBoard` (accepted payload/perf tradeoff); (3) `_postOverrideState` skips on `!this._panel` so browser-only override state lags to the next watcher refresh (accepted). Verification: `npm run compile` ✅, `npm run compile-tests` (tsc) ✅, `parity:check` ✅, `push-routing:check` ✅, `verb-returns:check` ✅, `mirror:check` ✅, `test:regression:plan-sync` ✅, `test:regression:native-project-api` ✅. The standalone `control-plane-repo-scope.test.js` fails with a pre-existing DB-init ENOENT flake identically on pre-change commit `e2220b1` (not CI-invoked, not a regression). Gate-wiring audit: every automated check the plan's verification names is defined in `package.json` and invoked by `.github/workflows/integration-tests.yml` (compile-tests, compile, parity:check, push-routing:check, verb-returns:check, mirror:check, test:integration:all) — no "defined but not invoked" gap. The plan-file "SKIP per session directive" note was treated as a record, not a directive (per anti-leakage rule); tests were run independently and passed.
