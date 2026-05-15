# Fix: ClickUp Single Task Subtasks Parameter

## Problem
`ClickUpSyncService.getTaskDetails()` calls the single-task endpoint `/task/{id}` with `subtasks=true`, but ClickUp's single-task endpoint expects `include_subtasks=true`. The incorrect parameter is silently ignored, so subtasks are never returned.

- List/Team bulk endpoints correctly use `subtasks=true`.
- Single-task endpoint requires `include_subtasks=true`.

## Affected File
- `src/services/ClickUpSyncService.ts`

## Changes Required
1. **Line 1207** (`src/services/ClickUpSyncService.ts`): Change query parameter from `subtasks=true` to `include_subtasks=true` in the `GET /task/${normalizedTaskId}` call inside `getTaskDetails`.
   ```typescript
   // BEFORE:
   `/task/${normalizedTaskId}?subtasks=true&include_markdown_description=true`
   // AFTER:
   `/task/${normalizedTaskId}?include_subtasks=true&include_markdown_description=true`
   ```
2. **Line 1215** (`src/services/ClickUpSyncService.ts`): Update stale comment that references `subtasks=true` to say `include_subtasks=true`.
   ```typescript
   // BEFORE:
   // Extract subtasks from the task response (returned when subtasks=true param is used)
   // AFTER:
   // Extract subtasks from the task response (returned when include_subtasks=true param is used)
   ```

## Verification
- [ ] Ensure no other single-task endpoint calls use the wrong parameter.
- [ ] Confirm list/team endpoints remain unchanged (they correctly use `subtasks=true`).
- [ ] Run `clickup-sync-service.test.js` to verify no regressions.

## Complexity Audit

**Manual Complexity Override:** 3

**Routine**: Single-file, localized change (one query parameter swap + one comment update). Reuses existing patterns. No architectural changes. No multi-system coordination. Total scope: ~2 lines of code.
### Complex / Risky
- None.


## Edge-Case & Dependency Audit
- **Dependencies & Conflicts**: No active Kanban plans in New/Planned columns conflict with this change (dependency query unavailable, but the change surface is extremely narrow — one method, two lines). No cross-plan conflicts identified.
- **Correct endpoint usages preserved**: The following endpoints correctly use `subtasks=true` and must NOT be changed:
  - `getListTasks()` line 1150: `/list/{listId}/task?subtasks=true...` (list endpoint)
  - `listTasksFromClickUp()` line 1445: `/list/{listId}/task?subtasks=true...` (list endpoint)
  - `searchTasks()` line 946: `/team/{workspaceId}/task?subtasks=true...` (team endpoint)
  - `getSubtasks()` line 987: `/team/{workspaceId}/task?parent=...&subtasks=true...` (team endpoint)
- **MCP tool docs**: `register-tools.js` line 2655 doc string for `call_clickup_api` mentions `subtasks: true` for single task GET — this is documentation for the composite-query wrapper in the MCP tool, not a ClickUp API call, so it is out of scope for this fix. The `clickup_fetch` tool already uses `include_subtasks` correctly.
- **Test coverage gap**: `clickup-sync-service.test.js` does not currently test `getTaskDetails()` directly. The fix is trivial enough that existing test patterns for other methods provide sufficient confidence, but consider adding a test for `getTaskDetails` subtask parameter if test coverage is a priority.

## Adversarial Review

### Stage 1 — Grumpy Critique
> "This is a 'single-line fix' plan that's been sitting around. How do we know this parameter name is actually correct? ClickUp's docs are notorious for inconsistency. What if `include_subtasks=true` is also wrong, or only works on v3? What if the subtasks array key in the response changes too? And why is there no test for `getTaskDetails` at all? The silent failure mode means this bug could have been losing subtask data for weeks. Also, did anyone check if the MCP server's `call_clickup_api` tool docs are misleading users into using the wrong parameter?"

### Stage 2 — Balanced Synthesis
- **Valid concern**: ClickUp API parameter naming should be verified against the official docs. The distinction between `subtasks=true` (list/team bulk endpoints) and `include_subtasks=true` (single-task endpoint) is well-documented in ClickUp's REST API reference.
- **Valid concern**: No direct test for `getTaskDetails` in the test suite. This is a coverage gap but not a blocker for this specific fix.
- **Weak concern**: The MCP tool doc string in `register-tools.js` is about its internal composite-query wrapper, not raw ClickUp API parameters. It is intentionally out of scope.
- **Valid concern**: After the fix, the code should still correctly parse `taskResult.data?.subtasks` array. No response structure change is expected — ClickUp returns the same `subtasks` array regardless of which parameter name triggers it.
- **Conclusion**: Proceed with the two-line change. The risk is minimal and the fix is well-scoped. No architectural changes needed.

## Estimated Complexity
Routine — single-file, two-line fix (one code, one comment).
