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

Additionally, `_refreshBoard` early-returns if `!this._panel` (KanbanProvider.ts:3195) — so if the VS Code panel is closed, the browser's filter change writes the DB but gets no update at all.

### Root Cause

The board view reinvented a heavier pattern than necessary. The project panel's kanban tab (`project.js`) already solved this correctly:

- **Fetch all plans** → cache in `_kanbanPlansCache` (all projects, all columns)
- **Filter entirely client-side** — `getFilteredKanbanPlans()` filters the cache by `kanbanFilters.project`, `.column`, `.workspaceRoot`, `.search` (project.js:1602-1617)
- **Dropdown change is instant** — `kanbanProjectFilter.addEventListener('change', ...)` sets `kanbanFilters.project` and calls `renderKanbanPlans()` (project.js:2250-2253). No backend call, no broadcast, no coupling.
- **Live updates** — backend pushes `refreshKanbanPlans` → panel re-fetches → cache updates → re-renders with local filter preserved.

The board view instead round-trips to the backend on every filter change, and the backend pre-filters cards by `_projectFilter` before broadcasting (KanbanProvider.ts:3298-3300), so the board never has all cards locally and can't filter client-side.

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

## Implementation Plan

### 1. Backend: send unfiltered cards in `updateBoard`

**File:** `src/services/KanbanProvider.ts` — `_refreshBoardImpl` (~line 3298)

Currently the backend pre-filters cards by `_projectFilter` before broadcasting:
```ts
const dbRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

Change: always send unfiltered cards (`db.getBoard(workspaceId)`) in the `updateBoard` broadcast. The board view filters client-side. The `_projectFilter` singleton is still read at the top of `_refreshBoardImpl` (line 3248) for dispatch/prompt scoping, but it no longer filters the broadcast.

The `_refreshBoardImpl` already computes `allActiveRows` (unfiltered) for column occupancy (line 1808-1812) — reuse this for the broadcast cards. No extra DB query.

**Note:** The `repoScope` filter (`_repoScopeFilter`) is a separate concern — it's a repo-level scope, not a project view filter. If `repoScope` is active, keep filtering by it server-side (it's a backend scoping concern, not a view toggle). Only the project filter moves client-side.

### 2. Backend: add a lightweight `setProjectFilter` path that skips refresh

**File:** `src/services/KanbanProvider.ts` — `case 'setProjectFilter'` (~line 7478)

Currently:
```ts
case 'setProjectFilter': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
        await this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        await this._refreshBoard(workspaceRoot);  // ← the 5-second part
        return { success: true };
    }
    return { success: false, error: 'No workspace root or invalid project' };
}
```

Change: skip `_refreshBoard` when `msg.noRefresh === true`:
```ts
case 'setProjectFilter': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
        await this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        if (!msg.noRefresh) {
            await this._refreshBoard(workspaceRoot);
        }
        return { success: true };
    }
    return { success: false, error: 'No workspace root or invalid project' };
}
```

This preserves the singleton update + DB config write (steps 1-2) for stamping and dispatch scoping, but skips the expensive refresh (step 3). The board view filters client-side instead.

### 3. Board view: cache all cards, filter client-side

**File:** `src/webview/kanban.html` — `updateBoard` handler (~line 7194)

Currently the board receives pre-filtered cards and renders them directly. Change to the project panel pattern:
- Store incoming `cards` as `allCards` (the full unfiltered set, now sent by the backend per step 1).
- Apply the local `boardProjectFilter` to produce the rendered set:
  ```js
  currentCards = boardProjectFilter
      ? allCards.filter(c => c.project === boardProjectFilter)
      : allCards;
  ```
- Call `renderBoard(currentCards)`.
- Maintain `boardProjectFilter` as a local variable, initialized from `activeProjectFilter` on first load (so it starts in sync with the backend), then owned locally thereafter.

**File:** `src/webview/kanban.html` — `updateWorkspaceSelection` handler (~line 7110)

Currently this handler overwrites `activeProjectFilter` and rebuilds the dropdown on every broadcast. Change:
- Keep the workspace selection sync (workspace root, workspace items, `allWorkspaceProjects`) — these are workspace-level and both UIs should agree.
- Do NOT overwrite `boardProjectFilter` from `msg.projectFilter`. The board owns its filter locally.
- Rebuild the dropdown options from `allWorkspaceProjects` (so new projects appear), but preserve the current `boardProjectFilter` selection.

### 4. Board view: dropdown change = local filter + lightweight backend write

**File:** `src/webview/kanban.html` — `workspace-project-select` change handler (~line 8171)

Replace the current `setProjectFilter` post with the project panel pattern + lightweight backend write:
```js
// Same-workspace project filter change:
boardProjectFilter = selectedProject;
// Re-render instantly from cache (like project.js:2250-2253):
currentCards = boardProjectFilter ? allCards.filter(c => c.project === boardProjectFilter) : allCards;
renderBoard(currentCards);
// Lightweight backend write for stamping/dispatch (no refresh):
postKanbanMessage({ type: 'setProjectFilter', project: selectedProject, noRefresh: true });
```

This is instant (client-side render) + keeps backend state correct (singleton + DB config updated for stamping/dispatch) + no 5-second refresh.

### 5. Fix `_refreshBoard` early-return for browser-only scenarios

**File:** `src/services/KanbanProvider.ts` — `_refreshBoard` (~line 3194)

Currently `_refreshBoard` returns early if `!this._panel`. When only the browser is open, file-watcher-triggered refreshes never broadcast. Fix: if `!this._panel` but a LocalApiServer/wsHub is connected, still run the refresh and broadcast via `mirrorToWs` (no webview target). This ensures the browser gets live updates even when the VS Code panel is closed.

## Verification Plan

1. **Snappy dropdown (browser):** Open the browser kanban. Change the project filter dropdown. Confirm the board re-renders in <100ms. DevTools Network tab shows the `setProjectFilter` POST with `noRefresh: true` — response is immediate.
2. **Snappy dropdown (webview):** Open the VS Code webview board. Change the project filter dropdown. Confirm instant re-render, no 5-second wait.
3. **Independence:** Open BOTH browser and webview. Set browser to "Project X", webview to "Project Y". Confirm neither resets the other's dropdown. Change plans in one — the other's filter stays.
4. **Auto-stamping preserved:** Set the board to "Project X". Create a new plan file in the watched workspace. Confirm the plan is auto-stamped with "Project X" (verify in the DB or the plan's metadata). This confirms the DB config write still happens.
5. **Dispatch scoping preserved:** Set the board to "Project X" (which has project-tier role config overrides). Dispatch a prompt. Confirm the prompt uses Project X's role config and PRD. This confirms the singleton update still happens.
6. **Live updates preserved:** With the board open, create a new plan file. Confirm the new card appears (filtered by the local project filter if it matches, hidden if not). The local filter is preserved across the live update.
7. **Browser-only scenario:** Close the VS Code panel. Open only the browser. Change the project filter. Confirm the board updates. Create a new plan. Confirm it appears live and is auto-stamped.
8. **Project panel unchanged:** Open the project panel's kanban tab. Confirm it still works exactly as before (not touched by this plan).
9. **Existing tests:** Run kanban regression tests. The card data shape is unchanged; only the filtering location moved client-side and the refresh is skipped for filter-only changes.

## Risks & Edge Cases

- **Unfiltered card volume:** Sending all cards increases the `updateBoard` payload. However, `_refreshBoardImpl` already reads the full unfiltered set for column occupancy (line 1808-1812), so there's no new DB cost. The WS payload is larger but contains the same card set the DB already computes. If this is a concern for very large workspaces, add a lightweight board-card projection (omit full plan text, send only card metadata).
- **Column occupancy:** The board view must compute column occupancy from the unfiltered `allCards` (so hidden columns with cards in other projects still show occupancy), not from the filtered `currentCards`. Ensure the board's occupancy computation uses `allCards`.
- **`repoScope` filter:** This is a backend scoping concern (repo-level), not a view toggle. Keep filtering by `repoScope` server-side. Only the project filter moves client-side.
- **`updateWorkspaceSelection` still broadcasts:** The board view now ignores the `projectFilter` field in this message (it owns its local filter). But the workspace-level fields (root, items, projects list) are still synced — both UIs should agree on which workspace is active. The dropdown options are rebuilt from `allWorkspaceProjects` so new projects appear, but the selection is preserved.
- **Webview also gets unfiltered cards:** The VS Code webview board will also receive unfiltered cards and filter client-side. This is the desired unification — both UIs use the same pattern. The webview's local `boardProjectFilter` is initialized from `activeProjectFilter` on first load, then owned locally.
- **`noRefresh` flag is additive:** Existing callers of `setProjectFilter` without `noRefresh` still get the full refresh (backward compatible). Only the board view's dropdown handler sends `noRefresh: true`.
