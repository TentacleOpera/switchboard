# Persist and Restore Kanban Project Filter Across IDE Sessions

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, frontend, vscode-extension, state-management

## Goal

Fix a UX friction where the Kanban board always reopens to the workspace-level "Unassigned" project filter, even if the user had previously filtered to a specific project. The workspace root is already persisted and restored; this plan adds the same behavior for the active project filter.

## Background / Problem Analysis

- `KanbanProvider` persists the last selected workspace via `workspaceState.get('kanban.lastSelectedWorkspace')` and restores it in the constructor.
- `_projectFilter` is initialized to `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` and is **never persisted**.
- On reopening the Kanban panel, the workspace is restored but the project filter resets to `"__unassigned__"`, so the board shows all unassigned plans instead of the previously filtered project.
- `setProjectFilter()` already updates `GlobalPlanWatcherService` when the workspace root is set, making it the natural hook to also persist the filter.
- The webview already receives `projectFilter` in `initData` messages and stores it in `activeProjectFilter`. The frontend side does not need structural changes — only the backend must restore and send the correct value.

## Implementation Plan

### Step 1 — Persist project filter on change

In `KanbanProvider.setProjectFilter()`, after updating `this._projectFilter`, persist the new value to `workspaceState` using a scoped key that includes the workspace root (to avoid collisions across multi-root workspaces):

```
workspaceState.update(`kanban.projectFilter.${workspaceRoot}`, filter)
```

Use the same 100ms debounce pattern already used in `setCurrentWorkspaceRoot()` to avoid excessive writes.

### Step 2 — Restore project filter in constructor

In the `KanbanProvider` constructor, after resolving `_currentWorkspaceRoot` from the persisted workspace, attempt to restore the project filter:

1. Read `workspaceState.get<string | null>(\`kanban.projectFilter.${resolvedRoot}\`, null)`.
2. If the value exists, validate it against the workspace's actual project list (async check deferred until DB is ready, or use a synchronous validation if the list is already cached).
3. If valid, set `_projectFilter = persistedValue`. If invalid or missing, keep the default `UNASSIGNED_PROJECT_FILTER`.

Because DB may not be ready in the constructor, consider a lazy restore: store the raw persisted value in a temporary field and validate it on the first `_refreshBoardImpl()` call where DB access is guaranteed.

### Step 3 — Scope the persisted key correctly

The workspace root used in the state key must be the resolved absolute path (same as `setCurrentWorkspaceRoot`). Ensure path normalization (via `path.resolve`) before reading/writing the key, so multi-root workspaces with overlapping names don't collide.

### Step 4 — Update existing behavior on workspace switch

When the user switches workspaces via `selectWorkspace`, the current code resets the project filter to `UNASSIGNED_PROJECT_FILTER` (see `_handleMessage` `case 'selectWorkspace'`). This behavior should remain — workspace switches intentionally clear the project filter. The fix only affects **IDE restart / panel reopen**, not mid-session workspace switches.

### Step 5 — Regression test

Add a test in `KanbanProvider.test.ts`:

- Instantiate `KanbanProvider` with a mock context that has `kanban.lastSelectedWorkspace` and `kanban.projectFilter.{root}` pre-seeded.
- Assert that `_projectFilter` is restored to the persisted value.
- Add a second test: seed a project filter that no longer exists in the workspace's project list. Assert it falls back to `UNASSIGNED_PROJECT_FILTER`.

Update existing tests if the constructor now triggers an additional state read/write.

## Files to Modify

- `src/services/KanbanProvider.ts` — persist in `setProjectFilter()`, restore in constructor, validate on first refresh.
- `src/services/__tests__/KanbanProvider.test.ts` — add regression tests for restore + invalid-project fallback.

## Edge Cases & Risks

| Risk | Mitigation |
|------|------------|
| Persisted project name no longer exists (deleted or renamed) | Validate against DB project list on first refresh; fallback to `UNASSIGNED_PROJECT_FILTER`. |
| Multi-root workspace path collisions in state keys | Use resolved absolute path in the key. |
| Race between constructor and DB readiness | Defer validation to `_refreshBoardImpl` where DB is guaranteed ready. |
| Existing tests assume `_projectFilter` starts as `UNASSIGNED` | Update mock context in tests to not seed the new key, or explicitly assert the default when no key exists. |
| `deleteProject` handler resets filter but may not clear persisted state | Ensure `deleteProject` also clears `workspaceState` for the deleted project key to avoid stale restore on next open. |

## Validation

1. Manual test:
   - Open Kanban in workspace A, filter to project "P1".
   - Close the Kanban panel (or reload window).
   - Reopen Kanban. Verify it shows workspace A with project "P1" pre-selected.
2. Regression test:
   - Switch to workspace B. Verify project filter resets to Unassigned (existing behavior preserved).
3. Edge case:
   - Delete project "P1". Close and reopen Kanban. Verify filter falls back to Unassigned.

## Acceptance Criteria

- [ ] Reopening the Kanban panel restores the last-used project filter for the persisted workspace.
- [ ] If the last-used project no longer exists, the filter falls back to `UNASSIGNED_PROJECT_FILTER`.
- [ ] Switching workspaces mid-session still resets the project filter to `UNASSIGNED_PROJECT_FILTER`.
- [ ] All existing `KanbanProvider` tests pass; new regression tests added and passing.
