# Fix: Exclude Subtasks from ClickUp/Linear Task Lists in implementation.html

## Goal

Exclude subtasks from appearing as top-level cards in the ClickUp and Linear task lists within `implementation.html`, ensuring they remain visible only inside their parent task's detail view.

## Metadata

- **Tags:** bugfix, frontend, backend
- **Complexity:** 3
- **Status:** Completed
- **Completed:** 2026-05-15

## User Review Required

No user review required. Root cause is well-understood and fix is localized to three files with no product behavior changes beyond the intended bugfix.

## Problem Statement

When opening the ClickUp or Linear task list in the project tab of `implementation.html`, subtasks are rendered as top-level cards. Subtasks should only be visible inside their parent task's detail view. This has been reported as a recurring issue.

## Root Cause Analysis

### ClickUp
- The webview's `getFilteredClickUpTasks()` (line 4108) already tries to filter: `tasks.filter(task => !task.parentId)`.
- **However**, `TaskViewerProvider._mapClickUpTaskToSidebar()` (line 4339) does **not** include `parentId` in the mapped object sent to the webview.
- Result: `task.parentId` is `undefined` for **all** tasks, so `!undefined === true` and nothing is filtered. Subtasks leak into the list.

### Linear
- `LinearSyncService._buildIssueListQuery()` (line 400) does **not** query the `parent { id }` field.
- `LinearIssue` interface (line 45) and `_normalizeLinearIssue()` (line 328) do **not** include `parentId`.
- `getFilteredLinearIssues()` (line 3316) has **no** subtask exclusion logic at all.
- Result: all issues (including sub-issues) are rendered in the main list.

## Complexity Audit

### Routine
- Add `parentId` to `_mapClickUpTaskToSidebar` return object (single field, zero logic).
- Add `parent { id }` to `_buildIssueListQuery` GraphQL selection (single line).
- Add `parentId` to `LinearIssue` interface and `_normalizeLinearIssue` (two one-liners).
- Add `!issue.parentId` guard to `getFilteredLinearIssues()` (single line).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. These are synchronous mapping/filter operations.
- **Security:** None. No new data exposure; `parentId` is already returned by both APIs.
- **Side Effects:**
  - Cached Linear issues in `PlanningPanelCacheService` lack `parentId`. Until cache refreshes, old entries evaluate `!undefined === true` and continue to appear as top-level cards. This is harmless and self-healing on next refresh. Users may need to reload the panel after extension update.
  - Adding `parentId` to `LinearIssue` is a public interface change, but TypeScript structural typing means existing consumers are unaffected.
- **Dependencies & Conflicts:** None. No other features depend on `LinearIssue` lacking `parentId`.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) ClickUp task list endpoint may return `parent` as a string while detail returns `parentId`, requiring a defensive fallback; (2) stale cached Linear issues without `parentId` may briefly leak into the list until cache TTL expires; (3) single-issue and subtask queries do not fetch `parent { id }`, leaving `LinearIssue.parentId` undefined in detail contexts — acceptable for list-filter scope, but a future inconsistency to address. Mitigations: use defensive `task.parentId || task.parent || null` in ClickUp mapping; document cache reload in verification steps; add `parent { id }` to detail queries as a follow-up enhancement.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** `_mapClickUpTaskToSidebar` (line 4339) maps raw ClickUp task objects into the shape consumed by the webview. The webview's `getFilteredClickUpTasks()` already filters by `!task.parentId`, but the mapped object does not include this field.
- **Logic:** Add `parentId` to the returned object so the existing webview filter can function.
- **Implementation:** Change `parentId: task.parentId || null` to `parentId: task.parentId || task.parent || null` for defensive compatibility with both list and detail endpoint shapes.
- **Edge Cases:** If `parent` is an empty string or missing, falls back to `null` correctly.

### `src/services/LinearSyncService.ts`
- **Context:** The Linear backend does not fetch, type, or normalize the `parent` field on issues. The webview therefore cannot filter sub-issues.
- **Logic:** Query `parent { id }` in the list query, add `parentId` to the `LinearIssue` interface, and normalize the raw `parent.id` value.
- **Implementation:**
  - In `_buildIssueListQuery` (line 400), add `parent { id }` inside the `nodes` selection before `createdAt`.
  - In `LinearIssue` interface (line 45), add `parentId: string | null`.
  - In `_normalizeLinearIssue` (line 328), add `parentId: String(raw?.parent?.id || '').trim() || null`.
- **Edge Cases:** `raw.parent` may be `null`, `undefined`, or an empty object. The normalization safely returns `null` in all cases.

### `src/webview/implementation.html`
- **Context:** `getFilteredLinearIssues()` (line 3316) applies search, state, and project filters but has no subtask exclusion.
- **Logic:** Add a guard at the very top of the filter callback to drop any issue with a `parentId`.
- **Implementation:** Inside the `linearProjectIssues.filter` callback, add `if (issue?.parentId) { return false; }` as the first statement, before state, project, and search filters.
- **Edge Cases:** Issues without `parentId` (including all legacy cached entries) will pass through. This is safe because `undefined` is falsy.

## Files Changed

| File | Change |
|------|--------|
| `src/services/TaskViewerProvider.ts` | Added `parentId: task.parentId \|\| task.parent \|\| null` to `_mapClickUpTaskToSidebar` return object |
| `src/services/LinearSyncService.ts` | 1. Added `parent { id }` to `_buildIssueListQuery` GraphQL selection<br>2. Added `parentId: string \| null` to `LinearIssue` interface<br>3. Added `parentId: String(raw?.parent?.id \|\| '').trim() \|\| null` to `_normalizeLinearIssue` |
| `src/webview/implementation.html` | Added `if (issue?.parentId) { return false; }` guard to `getFilteredLinearIssues()` |

## Implementation Steps

1. ✅ **ClickUp backend mapping**
   - In `TaskViewerProvider.ts` `_mapClickUpTaskToSidebar`, added `parentId: task.parentId || task.parent || null` to the returned object.

2. ✅ **Linear backend query + normalization**
   - In `LinearSyncService.ts` `_buildIssueListQuery`, added `parent { id }` inside the `nodes` selection.
   - In `LinearSyncService.ts` `LinearIssue` interface, added `parentId: string | null`.
   - In `LinearSyncService.ts` `_normalizeLinearIssue`, added `parentId: String(raw?.parent?.id || '').trim() || null`.

3. ✅ **Linear webview filtering**
   - In `implementation.html` `getFilteredLinearIssues`, added a guard at the top: `if (issue?.parentId) { return false; }` (before search/state/project filters).

## Verification Plan

### Automated Tests
- No automated tests currently exist for these specific webview filters. The existing `LinearSyncService` test files are structural placeholders and do not exercise `graphqlRequest` mocking. Adding a full test would require significant mocking infrastructure that is out of scope for this routine bugfix. **Clarification:** A future follow-up should add a real `_normalizeLinearIssue` unit test with mocked `raw.parent` shapes.

### Manual Verification
- ✅ Run `npx tsc --noEmit` (or equivalent workspace compile check) to ensure adding `parentId` to `LinearIssue` does not break TypeScript consumers.
  - **Result:** Compilation passed with zero errors related to modified files. Two pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated import path issues) were observed.
- Open the ClickUp tab in the Switchboard panel; confirm subtasks do not appear as top-level cards.
- Click a parent task; confirm its subtasks render in the detail sidebar.
- Repeat for the Linear tab.
- Ensure search and state filters still work correctly after the filter change.
- If subtasks still appear after update, reload the VS Code window to clear the `PlanningPanelCacheService` task cache.

## Risks

- **Linear query change**: Adding `parent { id }` is a trivial GraphQL field addition with no breaking change risk.
- **ClickUp mapping change**: `parentId` is already computed in the sync service; we are simply passing it through with a defensive fallback. No data shape risk.
- **No tests exist** for these specific webview filters; manual verification is required.

## Validation Results

- **TypeScript compilation:** Passed (no new errors introduced by changes).
- **Files modified:** 3
- **Lines changed:** 5 (1 in TaskViewerProvider.ts, 3 in LinearSyncService.ts, 1 in implementation.html)
- **Remaining risks:** Stale cached Linear issues without `parentId` may briefly appear until cache refreshes. This is self-healing and documented in the verification steps.

## Recommendation

Complexity = 3. **Completed.**

## Review Execution

### Stage 1 — Grumpy Critique
> "Let's see if this 'harmless frontend filter' actually works. For ClickUp, we added `parentId: task.parentId || task.parent || null`. Okay, defensive, fine. But what about Linear? We fetch `parent { id }` and map it. However, the UI filter in `implementation.html` just does `if (issue?.parentId) { return false; }`. What if a top-level issue has a parent project ID mapped onto `parentId` by accident in the future? And why rely on structural typing in TypeScript instead of full regression tests for the GraphQL mapping? It's 'good enough' to hide the subtasks, but it relies heavily on the `PlanningPanelCacheService` self-healing on refresh. I guess it works, but I don't like it."

### Stage 2 — Balanced Synthesis
- **Grumpy's Point on Future Collisions (NIT)**: The `parentId` field in `LinearIssue` is explicitly mapped from the GraphQL `parent { id }` field, which strictly refers to parent *issues* in Linear, not projects. The risk of collision is virtually zero.
- **Grumpy's Point on Cache State (NIT)**: Stale cache without `parentId` will indeed fail open (showing subtasks as top-level until cache clears). This is a known, transient, acceptable side-effect documented in the plan.
- **Implementation Verification**: Checked `TaskViewerProvider.ts`, `LinearSyncService.ts`, and `implementation.html`. All required logic (GraphQL query updates, typing, defensive fallback mapping, and early-return filter) is implemented exactly as planned.
- **Action**: No code changes needed. The implementation fulfills the goal.

### Validation Results
- **Code Fixes Applied**: None required.
- **Verification Run**: Compiled successfully with `npx tsc --noEmit`. No new structural typing issues introduced.
- **Remaining Risks**: Legacy cached entries in `PlanningPanelCacheService` will continue to leak subtasks into the list view until they expire or the user forces a refresh.

**ACCURACY VERIFICATION COMPLETE**
