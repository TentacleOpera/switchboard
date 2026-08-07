# Project panel goes out of sync with the kanban board after card moves

## Goal

When a card is moved on the kanban board (drag-drop, move-forward, move-backward, autoban, or remote control), the project panel's Kanban Plans tab keeps showing the card in its old column until the user manually switches tabs or the plan file changes on disk. Fix this so the project panel's `_kanbanPlansCache` refreshes whenever the board moves a card — the same way the kanban board and sidebar already do.

### Problem Analysis

The project panel (`project.html` / `project.js`) and the kanban board (`kanban.html` / `KanbanProvider`) both read plan columns from the **same** `kanban.db` `plans.kanban_column` field. They never disagree on the source of truth — they disagree on **when they last read it**.

The project panel refreshes its `_kanbanPlansCache` only in three situations:
1. The user switches to the kanban / projects / features tab (`project.js:52-59` sends `fetchKanbanPlans`).
2. The project panel becomes visible (`PlanningPanelProvider.ts:644-648` sends `refreshKanbanPlans`).
3. A **plan file** changes on disk — the file watcher debounces and sends `fetchKanbanPlans` (`PlanningPanelProvider.ts:1143-1157`).

Card moves on the kanban board only update the DB's `kanban_column` field — the plan file on disk is untouched, so trigger #3 never fires. And the project panel is usually not visible while the user is on the kanban board, so triggers #1 and #2 don't fire either. The cache goes stale silently.

### Root Cause

`TaskViewerProvider.refreshUI()` is the unified post-action refresh path (43 call sites across the codebase). It refreshes the sidebar and the kanban board but **never notifies the project panel**:

```typescript
// TaskViewerProvider.ts:4350-4380
public async refreshUI(workspaceRoot?: string) {
    // ... workspace activation ...
    await Promise.all([
        this._refreshRunSheets(workspaceRoot),
        this._refreshConfigurationState()
    ]);
    // ← no message to the project panel
}
```

Every card-move path funnels through `refreshUI`:
- `handleKanbanForwardMove` / `handleKanbanBackwardMove` → `_applyManualKanbanColumnChange` → `refreshUI` (`TaskViewerProvider.ts:5058, 5284`)
- `handleKanbanCompletePlan` → `refreshUI` (`TaskViewerProvider.ts:5512`)
- `KanbanProvider.moveCardToColumnByPlanFile` → `_refreshBoard` → `refreshUI` (`KanbanProvider.ts:6911`)
- `KanbanProvider.moveCardForward` / `moveCardBackwards` message handlers → `_scheduleBoardRefresh` → `refreshUI`

The project panel's own column-change path (`moveKanbanPlanColumn` → `moveCardToColumnByPlanFile` → `kanbanPlanColumnChanged` → `fetchKanbanPlans`) works because `project.js:702-704` explicitly re-fetches on success. But that path is only used when the move originates from the project panel itself — board-originated moves bypass it entirely.

## Metadata

**Complexity:** 2
**Tags:** bugfix, frontend, backend
**Project:** Browser Switchboard

## The one thing that will go wrong if you rush it

**Don't send `fetchKanbanPlans` directly from `refreshUI`.** The project panel's `refreshKanbanPlans` handler (`project.js:433-438`) already debounces at 200ms and is the correct entry point — it collapses the burst of `refreshUI` calls that fire during a multi-card autoban sweep or a feature cascade move into a single DB read. Posting `fetchKanbanPlans` raw would bypass that debounce and fire one DB query per `refreshUI` call (43 call sites), re-introducing the exact stampede the debounce was built to prevent.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — Notify the project panel on refreshUI

Add a single line at the end of `refreshUI()` (after the `Promise.all` at line 4376-4379) to push `refreshKanbanPlans` to the project panel:

```typescript
// TaskViewerProvider.ts — refreshUI(), after the Promise.all block (line 4379)
public async refreshUI(workspaceRoot?: string) {
    if (workspaceRoot) {
        // ... existing workspace activation (lines 4351-4374) ...
    }
    await Promise.all([
        this._refreshRunSheets(workspaceRoot),
        this._refreshConfigurationState()
    ]);
    // NEW: keep the project panel's Kanban Plans cache in sync with board moves.
    // PlanningPanelProvider.postMessage() forwards to BOTH the planning panel and
    // the project panel webviews. project.js debounces refreshKanbanPlans at 200ms
    // (project.js:433-438), so the 43 refreshUI call sites collapse into one fetch.
    this._planningPanelProvider?.postMessage({ type: 'refreshKanbanPlans' });
}
```

**Why `postMessage` and not `postMessageToProjectWebview`:** `TaskViewerProvider` holds a reference to `PlanningPanelProvider` via `_planningPanelProvider` (typed as `{ postMessage(message: any): void; handleServiceVerb(...) }` at line 685). `PlanningPanelProvider.postMessage()` (line 7200) forwards to both the planning panel and the project panel webviews — which is correct, because the planning panel's Kanban tab (the legacy `implementation.html`) has the same stale-cache bug and benefits from the same refresh.

**Why this is safe:**
- `_planningPanelProvider` is optional (`?.`) — if no planning/project panel is registered (e.g. standalone mode, or the panel hasn't been opened yet), the call is a no-op.
- `PlanningPanelProvider.postMessage()` queues messages if the project panel isn't ready yet (`_pendingProjectMessages`, line 977-978) and flushes them on ready — so a refresh fired before the panel's first paint is not lost.
- `project.js`'s `refreshKanbanPlans` handler is a 200ms debounce that sends a single `fetchKanbanPlans` — it does not re-render synchronously, so there's no perf concern from frequent calls.
- The message type `refreshKanbanPlans` is already handled by `project.js` (line 433) and is the same message `PlanningPanelProvider` sends when the project panel becomes visible (line 647) — no new message type, no new handler.

## Edge-Case & Dependency Audit

- **Race conditions:** `refreshUI` is async and may be called concurrently (e.g. a feature cascade fires `moveCardToColumn` per subtask, each scheduling a board refresh). The 200ms debounce in `project.js:433-438` coalesces these into one `fetchKanbanPlans`. The `fetchKanbanPlans` handler in `PlanningPanelProvider` (line 3460) has a stale-request guard (`_latestRequestIds`) that drops superseded responses. No new race.
- **Standalone mode:** `bootstrap.ts:734` registers its own `switchboard.refreshUI` handler that calls `schedulePushFullState()` — it does not go through `TaskViewerProvider.refreshUI()`. The standalone host has no project panel, so the added line is never reached there. No change needed in `bootstrap.ts`.
- **Browser cockpit (WS mirror):** `PlanningPanelProvider.postMessageToProjectWebview` mirrors to WS clients tagged `'project'` (line 974). A browser cockpit viewing the project panel will also receive `refreshKanbanPlans` and refresh — correct, since it has the same stale-cache problem.
- **Side effects:** One additional `postMessage` call per `refreshUI` invocation. The message is a no-op if no project/planning panel exists. No DB write, no file I/O, no schema change.
- **Dependencies:** No dependency on other plans. The `_planningPanelProvider` field and `setPlanningPanelProvider` wiring (line 3660) already exist.

## Verification Plan

### Automated Tests

No new automated tests required. The change is a single `postMessage` call whose effect (a debounced `fetchKanbanPlans` in the webview) is inherently async and UI-bound — not unit-testable without a full webview harness.

**Manual verification:**

1. **Reproduce the bug first (pre-fix):** Open the kanban board and the project panel side by side (or in separate columns). Note a plan in the CREATED column on both. Drag it forward to PLAN REVIEWED on the kanban board. Observe the kanban board updates immediately; switch to the project panel's Kanban Plans tab and confirm the plan is **still in CREATED** (the bug).
2. **Verify the fix:** Apply the change, reload the extension. Repeat step 1 — drag a plan from CREATED to PLAN REVIEWED on the kanban board. Switch to the project panel's Kanban Plans tab. Confirm the plan now shows **PLAN REVIEWED** within ~200ms (the debounce window).
3. **Move-backward path:** Drag a plan from PLAN REVIEWED back to CREATED on the board. Confirm the project panel reflects CREATED.
4. **Move-forward via prompt copy:** Click "Copy Prompt" on a plan in the kanban board (which auto-advances the column). Confirm the project panel updates.
5. **Complete-plan path:** Complete a plan from the kanban board. Confirm the project panel moves it to COMPLETED (or removes it from the active list, depending on the completed-limit window).
6. **Feature cascade:** Move a feature card on the board (which cascades to all subtasks). Confirm the project panel reflects the new column for the feature AND all subtasks.
7. **Debounce under load:** Trigger an autoban sweep or a multi-card forward move (select 3+ cards, move forward). Confirm the project panel refreshes once (not 3+ times) — watch the network/webview console for a single `fetchKanbanPlans` round-trip.
8. **No panel open:** Close the project panel entirely. Move a card on the kanban board. Confirm no errors in the extension host console (`_planningPanelProvider` is `undefined`, the `?.` no-ops). Reopen the project panel — it should show the correct column (refreshed on open via the existing `onDidChangeViewState` path).
9. **Planning panel Kanban tab:** If the legacy planning panel (`implementation.html`) is open with its Kanban tab visible, move a card on the kanban board. Confirm the planning panel's Kanban tab also updates (it receives the same `refreshKanbanPlans` via `postMessage`).
