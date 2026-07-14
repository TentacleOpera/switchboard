# ClickUp Priority Lost on List Reload in Planning Tickets Tab

## Goal
Fix the bug where ClickUp task priorities set in the planning.html Tickets tab revert to "No priority" after switching lists and coming back, even though the priorities are correctly persisted on ClickUp.

### Problem Analysis
In the Tickets tab of `planning.html`, the user can set a priority on a ClickUp task via the priority-dot popover. The write path works correctly — `selectPriority` optimistically updates the in-memory `clickUpProjectIssues` array and posts `clickupUpdateTaskPriority` to the backend, which calls `clickup.updateTask(taskId, { priority })`. The `clickupPriorityUpdated` confirmation handler also updates the in-memory task. So while the user stays on the current list, the priority dot renders correctly.

However, when the user switches to a different list and returns, all priorities reset to "No priority". The ClickUp side is correct — only the local display is wrong.

### Root Cause
The backend mapper `_mapClickUpTaskToSidebar` in `PlanningPanelProvider.ts` (line 2455) does **not** include the `priority` field in the object it sends to the webview. It maps `id`, `title`, `identifier`, `status`, `statusColor`, `assignees`, `description`, `markdownDescription`, `list`, `url`, `parentId`, and `tags` — but omits `priority`.

The data is present upstream: `ClickUpSyncService._fetchListTasksInternal` normalizes `raw.priority` into `{ id, priority, color, orderindex }` (lines 764–770), and the `ClickUpTask` type declares `priority: { id, priority, color, orderindex } | null` (line 88). So `getListTasks` returns tasks **with** priority.

The loss happens at the mapper boundary. When `clickupLoadProject` fires (on list selection / re-selection), the backend fetches fresh tasks and maps each through `_mapClickUpTaskToSidebar`, stripping `priority`. The webview stores the result into `clickUpProjectIssues` (`planning.js:6118`). The render functions `_clickUpPriorityColor` / `_clickUpPriorityName` (`planning.js:723–748`) and the card builder (`planning.js:9964–9967`) all read `task.priority?.orderindex` / `task.priority?.priority` — which are now `undefined` — so every card falls back to "No priority".

The "Sync changes" button (`tickets-sync-all`) is incidental to this bug; the trigger is purely the list reload that re-fetches via `clickupLoadProject`. The optimistic in-memory update only survives as long as the list is not reloaded.

## Metadata
- **Tags:** bug, clickup, tickets-tab, planning-panel, priority
- **Complexity:** 2

## Complexity Audit

### Routine
- Add the `priority` field to the `_mapClickUpTaskToSidebar` return object — a one-line addition mirroring the existing `status` mapping pattern.
- Verify the webview priority render helpers already handle the normalized shape (they do — they read `task.priority.color`, `task.priority.priority`, `task.priority.orderindex`).

### Complex / Risky
- None. The fix is a pure additive mapping change with no control-flow, state, or schema implications. The `ClickUpTask` type already carries `priority`, and the webview already consumes that exact shape from the optimistic-update path.

## Edge-Case & Dependency Audit

### Correctness
- `priority` can be `null` (ClickUp returns no priority for unset tasks). The mapper must pass `null` through, not coerce to `undefined`, so the webview's `task.priority?.orderindex` optional-chaining still yields `0` → "No priority" correctly.
- The same mapper is used by `clickupTaskDetailsLoaded` (line 5338) for the detail panel and subtask list. Adding `priority` there is harmless (the detail view does not currently render a priority dot, but subtask cards in drill-down reuse `_renderClickUpTicketCard`, which does read `priority`). This is a bonus fix — subtask priority dots will now also render correctly.

### Race Conditions
- None introduced. The mapper is synchronous and stateless.

### Regression Surface
- The only consumer of the mapped object's `priority` is the webview render path, which already expects the normalized `{ id, priority, color, orderindex } | null` shape (proven by the optimistic-update code at `planning.js:900–912` that writes exactly this shape). No other backend consumer reads `priority` off the sidebar-mapped object.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — `_mapClickUpTaskToSidebar` (line 2455)
Add the `priority` field to the returned object, passing the already-normalized value through unchanged.

```ts
private _mapClickUpTaskToSidebar(task: any): any {
    return {
        id: task.id,
        title: task.name,
        identifier: task.id,
        status: task.status?.status || 'Unknown',
        statusColor: task.status?.color || '',
        assignees: task.assignees || [],
        description: task.description?.trim() || 'No description provided.',
        markdownDescription: task.markdownDescription || '',
        list: task.list,
        url: task.url,
        parentId: task.parentId || task.parent || null,
        priority: task.priority || null,   // <-- ADD: preserve priority through list reload
        tags: Array.isArray(task.tags) ? task.tags.map((t: any) => ({
            name: String(t?.name || '').trim(),
            tagFg: String(t?.tag_fg || t?.tagFg || '').trim(),
            tagBg: String(t?.tag_bg || t?.tagBg || '').trim()
        })) : []
    };
}
```

No other files require changes. The webview (`planning.js`) already renders `task.priority` correctly when it is present — the optimistic-update path and the `clickupPriorityUpdated` handler both write the identical normalized shape.

## Verification Plan

1. **Reproduce the original bug first** (confirms the test harness): open the Tickets tab, select a ClickUp list, set a priority on a task, switch to a different list, switch back. Observe all priorities show "No priority" (pre-fix).
2. **Apply the one-line mapper fix.**
3. **Re-test the exact scenario**: set priorities, switch lists, switch back. Confirm the priority dots retain their correct color/name matching what is set on ClickUp.
4. **Cross-check against ClickUp**: open the task in ClickUp (or use the Open button) and confirm the displayed priority matches the dot.
5. **Unset-priority case**: clear a task's priority (set to "No priority" via the popover), switch lists and back. Confirm it still shows "No priority" (the `null` pass-through works).
6. **Subtask drill-down**: open a parent task with subtasks that have priorities set. Confirm subtask priority dots now render (previously also broken via the same mapper).
7. **Refresh / Refetch buttons**: click both `tickets-refresh` and `tickets-refetch` and confirm priorities survive (both trigger `clickupLoadProject` → the fixed mapper).
8. **Run existing ClickUp sync tests**: `src/test/integrations/clickup/clickup-sync-service.test.js` to ensure no service-layer regressions (the change is in the panel provider, not the sync service, but worth confirming the suite is green).
