# Fix: Plan Creation Not Inheriting Active Kanban Project

## Goal

When a user creates a plan from the kanban board while a project filter is active, the newly created plan must be automatically assigned to that project.

### Root Cause

Two independent assignment paths both fail:

1. **Direct assignment path is skipped.** `TaskViewerProvider.createDraftPlanTicket()` calls `_createInitiatedPlan(title, idea, false, { createdAt })` **without passing `projectName`**. `_createInitiatedPlan` has logic to call `db.assignPlansToProject()` when `options.projectName` is provided (`TaskViewerProvider.ts:15618-15632`), but since the option is absent, this block is skipped entirely.

2. **Watcher fallback path is bypassed.** `GlobalPlanWatcherService._handlePlanFile()` uses `this._currentProjects.get(workspaceRoot)` to assign discovered plans to the active project (`GlobalPlanWatcherService.ts:448`). However, `_createInitiatedPlan` calls `GlobalPlanWatcherService.registerPendingCreation(planFileAbsolute)` (`TaskViewerProvider.ts:15586`) to prevent duplicate DB inserts. This causes `_handlePlanFile` to skip the file entirely (`GlobalPlanWatcherService.ts:397-400`), so the watcher fallback never executes.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend

## User Review Required

No — straightforward bugfix with well-defined scope and no product ambiguity.

## Complexity Audit

### Routine
- Single-file change in `createDraftPlanTicket()` to read kanban project filter and pass it through the existing `options` contract.
- Update one regression test regex to match the new call signature.
- Reuses existing `_createInitiatedPlan` option contract and `assignPlansToProject` call path; no new patterns introduced.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. Plan creation, file write, DB registration, and project assignment are sequential within the same async function. The file-system watcher is blocked by `registerPendingCreation` until the explicit DB insert completes.

### Security
- `projectName` originates from `KanbanProvider`'s in-memory `_projectFilter`, which is set via validated UI dropdown values. The value is passed to `assignPlansToProject`, which uses SQLite parameterized queries. No injection risk. Assignment is scoped to the resolved workspace ID, so no cross-workspace privilege escalation.

### Side Effects
- Plan file write, DB registration, project assignment, integration sync queue, and UI refresh — all existing side effects unchanged. The only delta is an additional conditional `assignPlansToProject` call when `projectName` is present.

### Dependencies & Conflicts
- The regression test regex must be updated in the same PR; otherwise CI fails.
- No cross-session dependencies.
- All other callers of `_createInitiatedPlan` (clipboard import, NotebookLM import, Linear/ClickUp imports) are unaffected because they continue to omit `projectName`.

## Dependencies

None.

## Adversarial Synthesis

Key risks: workspace root mismatch between `_resolveWorkspaceRoot()` and `_kanbanProvider.getCurrentWorkspaceRoot()` (mitigated by shared root resolution logic, worst case is no-op); test regex stale after signature change (mitigated by updating regression test in Step 2). The fix is safe, localized, and additive.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

**Context:** `createDraftPlanTicket()` is the entry point for the kanban board's "Create Plan" button. It currently creates an untitled plan but never forwards the active kanban project filter.

**Logic:** Before calling `_createInitiatedPlan`, read the active project filter from `_kanbanProvider`. Skip the sentinel value `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` and any falsy value. Pass the resulting `projectName` through the existing `options` object.

**Implementation:**

```typescript
public async createDraftPlanTicket(): Promise<void> {
    const title = 'Untitled Plan';
    const createdAt = new Date().toISOString();
    const idea = this._buildDraftPlanContent(title);

    // Inherit the active kanban project filter, if any
    let projectName: string | undefined;
    const activeProject = this._kanbanProvider?.getProjectFilter();
    if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        projectName = activeProject;
    }

    try {
        const { planFileAbsolute } = await this._createInitiatedPlan(title, idea, false, { createdAt, projectName });
        await this._openPlanInReviewPanel(planFileAbsolute, title);
    } catch (err: any) {
        const msg = err?.message || String(err);
        vscode.window.showErrorMessage(`Plan creation failed: ${msg}`);
    }
}
```

**Edge Cases:**
- `_kanbanProvider` is undefined → `activeProject` is `undefined`, `projectName` omitted, behavior identical to today.
- `UNASSIGNED_PROJECT_FILTER` is selected → `projectName` omitted, no assignment performed.
- Multi-root workspace → `_resolveWorkspaceRoot()` delegates to `_kanbanProvider.getCurrentWorkspaceRoot()` as its first priority, so the project filter and plan creation target the same workspace.

### `src/test/clipboard-import-brain-promotion-regression.test.js`

**Context:** The regression test asserts the exact `_createInitiatedPlan` call signature inside `createDraftPlanTicket` to ensure clipboard imports do not accidentally alter brain-promotion behavior.

**Logic:** Update the regex to expect the new options object that includes `projectName`.

**Implementation:**

```javascript
assert.match(
    source,
    /public async createDraftPlanTicket\(\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(title, idea, false, \{ createdAt, projectName \}\);/,
    'Expected normal draft plan creation to keep the default brain-promotion behavior while inheriting the active project filter.'
);
```

**Edge Cases:** None — this is a literal signature match.

## Verification Plan

### Automated Tests
- Update `src/test/clipboard-import-brain-promotion-regression.test.js` regex as described in Step 2.
- **Follow-up (post-merge):** Add a semantic unit test that mocks `KanbanProvider.getProjectFilter()` returning a real project name, calls `createDraftPlanTicket()`, and asserts that `KanbanDatabase.assignPlansToProject` is invoked with that name. The current regex-only test validates syntax, not behavior.

### Manual Verification
1. Open the kanban board and select a workspace with at least one project.
2. Select a project from the project filter dropdown.
3. Click "Create Plan" in the kanban board.
4. Verify the new plan appears in the kanban board under the selected project (not in "All Projects" or "Unassigned").
5. Repeat with "Unassigned" selected — the plan should have no project assignment.
6. Repeat with no project filter selected — the plan should have no project assignment.

**Send to Intern**
