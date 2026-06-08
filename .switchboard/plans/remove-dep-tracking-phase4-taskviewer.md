# Remove Dependency Tracking — Phase 4: TaskViewerProvider

## Goal

Remove all dependency-related code from TaskViewerProvider.ts — the largest cleanup target with 20+ scattered call sites. This includes the dispatch gate, dependency parsing, dependency map rebuild, ClickUp subtask linking, review ticket dependencies, and all `dependencies` field reads/writes in plan records.

## Problem Analysis

TaskViewerProvider is the central orchestrator for plan dispatch, review, and sync. It has the most dependency-related code of any file. With Phases 1-3 removing the UI, prompt injection, and handler infrastructure, this phase removes the remaining call sites and methods that reference dependency data.

## Metadata

- **Complexity:** 7
- **Tags:** refactor, backend

## User Review Required

None — removal only, no new behaviour.

## Complexity Audit

### Routine
- Remove `dependencies` field from plan record creation and parsing
- Remove `dependencies` from mirror sync metadata updates
- Remove `dependencies` from brain plan record updates
- Remove `dependencies` from plan registry sync
- Remove `_isDependencyCheckEnabled()` method

### Complex / Risky
- **`_checkDependenciesBeforeDispatch()`** — a dispatch gate at line 15244 that shows a modal dialog when a plan has unmet dependencies. Must remove the method (lines 15127–15159), its call site (line 15244), and the `depResult` handling block (lines 15244–15254) which includes a branch that re-dispatches as a batch with included dependencies. Removing this means plans dispatch immediately without dependency checks — correct since the data was unreliable.
- **`handleRebuildDependencyMap()`** — method at lines 15471–15494 that generates a rebuild prompt and sends it to the analyst. Must remove entirely.
- **`_parsePlanDependencies()`** — method at line 12759 that parses the `## Dependencies` section from plan text. Used by `getReviewTicketData()`. Must remove the method and its call.
- **`setDependencies` handler** — lines 13184–13192 in the review ticket update handler. Rewrites the `## Dependencies` section in the plan file. Must remove the case block.
- **ClickUp subtask linking** — lines 4440 and 4607 call `updateDependenciesByPlanFile()` to link subtasks to parents. After Phase 5 removes that method, these calls must be gone. The parent-child relationship is already captured in ClickUp's own task hierarchy, so removing the dependency link is acceptable.
- **`getDependenciesFromPlan()` callers** — 3 call sites (lines 2121, 10246, 14244) reference the method removed in Phase 3. Must remove all 3.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — removal only.
- **Security:** None.
- **Side Effects:**
  - Removing `_checkDependenciesBeforeDispatch()` means plans with `## Dependencies` sections in their plan files will no longer be blocked from dispatch. This is correct — the dependency data was unreliable and the feature was unused.
  - Removing ClickUp subtask `updateDependenciesByPlanFile()` calls means subtasks won't have a `dependencies` field in the DB linking them to parents. ClickUp's own task hierarchy already captures this relationship.
  - Removing `setDependencies` handler means the review panel can no longer update the `## Dependencies` section in plan files. This is correct — the section is being deprecated.
- **Dependencies & Conflicts:** Phases 1-3 must be complete. Phase 3 removed `getDependenciesFromPlan()` from KanbanProvider — this phase removes its callers here. Phase 5 will remove `updateDependenciesByPlanFile()` from KanbanDatabase — this phase removes its callers here.

## Dependencies

- Phase 1 (UI layer)
- Phase 2 (Prompt pipeline)
- Phase 3 (Service handlers)

## Adversarial Synthesis

Key risk: The dispatch flow at lines 15244–15254 has a complex branching structure — the `depResult` object controls whether dispatch proceeds, cancels, or re-dispatches as a batch. Removing the entire block must not break the subsequent dispatch logic. Mitigation: the block is self-contained between the dispatch lock acquisition and the actual dispatch call. Removing it simply allows dispatch to proceed unconditionally, which is the desired behaviour.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### Plan record `dependencies` field removal
- Remove `dependencies: ''` from baseRecord (line 2049)
- Remove `dependencies: existing.dependencies || baseRecord.dependencies` (line 2078)
- Remove `let dependencies: string | undefined` variable declaration (line 2500)
- Remove `dependencies = plan.dependencies` read (line 2536)
- Remove `dependencies: dependencies || ''` from dispatch data (line 2553)

#### Mirror sync
- Remove `await db.updateDependenciesByPlanFile(relativeMirror, wsId, meta.dependencies)` (line 9428)
- Remove `await db.updateDependenciesByPlanFile(relativeMirror, wsId, meta.dependencies)` (line 9487)

#### ClickUp subtask linking
- Remove `await db.updateDependenciesByPlanFile(planFileAbsolute, workspaceId, parentPlan.planFile)` and its error handling (lines 4440–4443)
- Remove `await db.updateDependenciesByPlanFile(subtaskPlanFile, workspaceId, rootPlanFileRelative)` (line 4607)

#### Brain plan extraction
- Remove `dependencies: metadata.dependencies || existingPlan.dependencies` from updated record (line 12335)
- Remove the comment about falsy guard for tags/dependencies (lines 12332–12333)

#### Plan registry sync
- Remove `dependencies: ''` from new registry entries (line 10131)
- Remove `dependencies: existing?.dependencies || ''` (line 10179)
- Remove `let insertDependencies` variable and its `getDependenciesFromPlan()` call (lines 10243–10248)
- Remove `dependencies: insertDependencies` from record (line 10266)

#### Review ticket data
- Remove `dependencies: string[]` from `getReviewTicketData` return type (line 12909)
- Remove `const dependencies = this._parsePlanDependencies(planText)` (line 12939)
- Remove `dependencies` from return object (line 12959)

#### Methods to remove entirely
- Remove `_parsePlanDependencies()` method (line 12759+)
- Remove `_isDependencyCheckEnabled()` method (lines 14932–14936)
- Remove `_checkDependenciesBeforeDispatch()` method (lines 15127–15159)
- Remove `handleRebuildDependencyMap()` method (lines 15471–15494)

#### Dispatch flow
- Remove the `_checkDependenciesBeforeDispatch()` call and its result handling (lines 15244–15254). The dispatch should proceed unconditionally after the lock is acquired.

#### Review ticket update handler
- Remove `case 'setDependencies'` block (lines 13184–13192)

#### getDependenciesFromPlan callers (method removed in Phase 3)
- Remove the `getDependenciesFromPlan` call at line 2121 (batch dependency resolution)
- Remove the `getDependenciesFromPlan` call at line 10246 (plan registry sync — already covered above)
- Remove the `getDependenciesFromPlan` call at line 14244 (dependency map rebuild — already covered by removing `handleRebuildDependencyMap`)

## Verification Plan

### Automated Tests
- Skip (per session directive). Tests cleaned in Phase 6.

### Manual Verification
- Dispatch a plan — no dependency check dialog appears, plan dispatches immediately
- Open review panel — no dependencies section visible
- Import a ClickUp subtask — no error, subtask created without dependencies field
- Mirror sync completes without error

**Recommendation: Send to Lead Coder** (Complexity 7 — 20+ scattered sites in a single very large file, dispatch flow modification)
