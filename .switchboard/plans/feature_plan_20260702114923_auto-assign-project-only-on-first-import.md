# Auto-Assign to Current Project Must Only Fire on First Import, Not on Save/Update

## Goal

### Problem

When an agent writes to an existing plan file (save, update, or edit), the `GlobalPlanWatcherService` file watcher fires and re-resolves the plan's project assignment. If the plan currently has no project (`project = ''`), the watcher stamps it with whatever project the user currently has selected in the kanban board dropdown (`kanban.activeProjectFilter` DB config key). Since the user clicks through different projects while agents are concurrently writing to plan files, plans jump randomly between projects — appearing to "move all over the place."

### Root Cause

In `src/services/GlobalPlanWatcherService.ts`, the `_handlePlanFile` method has two branches:

1. **New plan (`!plan`)** — lines 517–615: Correctly stamps the plan with `metadata.project || activeProject` (the board's current project filter). This is the intended "first import" behavior.

2. **Existing plan (`else`)** — lines 616–698: Re-resolves the project on **every** file modification:
   ```typescript
   let resolvedProject = plan.project;
   if (metadata.project) {
       resolvedProject = metadata.project;          // (A) frontmatter override — correct
   } else if (!resolvedProject) {
       resolvedProject = (await db.getConfig('kanban.activeProjectFilter')) || '';  // (B) BUG
   }
   ```
   - Branch (A) is correct: if the plan file's frontmatter explicitly sets a project, honor it.
   - **Branch (B) is the bug**: when the plan has no project (`''` is falsy), it re-reads the board's *live* active project filter and stamps the plan with it. This runs on every save, so the plan's project tracks whatever the user happens to be viewing at the moment an agent writes the file.

The `insertFileDerivedPlan` ON CONFLICT clause (`project = COALESCE(NULLIF(excluded.project, ''), plans.project)`) would normally preserve the existing DB value when the incoming project is empty — but branch (B) ensures the incoming value is *never* empty for unassigned plans, so the COALESCE never gets a chance to protect them.

### Background Context

The `kanban.activeProjectFilter` DB config key is written by `KanbanProvider.setProjectFilter()` every time the user switches the project dropdown (line 4924). It reflects the user's *current viewing context*, not a stable assignment intent. Using it to assign projects to existing plans on every file save conflates "what am I looking at" with "what should this plan belong to."

## Metadata

- **Tags:** bug, kanban, project-assignment, file-watcher, data-integrity
- **Complexity:** 3

## Complexity Audit

**Routine.** The fix is a single conditional removal in one file (`GlobalPlanWatcherService.ts`). The new-plan import path (branch 1) already handles first-import assignment correctly. No schema changes, no new APIs, no migration needed. The only risk is a plan that was imported with `project = ''` before the board first refreshed — but such plans can be manually assigned via the "Assign to project" button, and the first-import path already covers the common case.

## Edge-Case & Dependency Audit

1. **Plans imported with `project = ''` before board refresh**: The first-import path (branch 1) uses `metadata.project || activeProject`. If `activeProject` is also empty at import time (board hasn't refreshed yet), the plan gets `project = ''`. After this fix, it will stay `''` until manually assigned — which is correct behavior (no silent reassignment). The user can assign it via the board UI.

2. **Frontmatter `metadata.project` override**: Branch (A) is preserved. If a plan file's frontmatter explicitly declares a project, it will still be honored on every save. This is correct — the file is the authority for its own project when it says so explicitly.

3. **Atomic-write DELETE→re-INSERT race**: When an editor saves via temp-file+rename, the watcher fires a DELETE then a CREATE. The DELETE handler captures a tombstone; the CREATE handler may take the `!plan` (new plan) branch if the row was deleted. In that case, the first-import path runs and stamps the active project — which is correct (it's genuinely a re-import). The tombstone restoration logic (lines 586–606) preserves the kanban column. Project is not tombstoned, so a re-imported plan gets the current active project. This is acceptable: the atomic-write race is a re-import, not an update.

4. **`insertFileDerivedPlan` COALESCE behavior**: After removing branch (B), `resolvedProject` will be `plan.project` (possibly `''`) when no frontmatter project is set. The ON CONFLICT clause `project = COALESCE(NULLIF(excluded.project, ''), plans.project)` will preserve the existing DB value — exactly the desired behavior.

5. **Epic project derivation** (`KanbanProvider.ts:9232–9237`): Epics derive their project from subtasks or the active filter. This is a separate code path (`recomputeEpicColumnFromSubtasks` / epic creation) and is not affected by this change.

6. **Existing tests**: `GlobalPlanWatcherService.test.ts` tests the new-plan import path (lines 475–511) and `setCurrentProject` (which no longer exists in the source — stale tests). The existing-plan update path has no test coverage for project re-resolution. A new test should be added to verify the fix.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — Remove active-project re-stamp on existing-plan updates

**Lines 616–643** (the `else` / existing-plan branch):

**Before:**
```typescript
} else {
    // Existing plan - update metadata.
    // Re-resolve the active project if the plan currently has none.
    // Priority: explicit frontmatter project > board's active project (DB config)
    // > existing DB project (preserved by COALESCE).
    let resolvedProject = plan.project;
    if (metadata.project) {
        // Frontmatter explicitly sets a project — honor it (overrides everything)
        resolvedProject = metadata.project;
    } else if (!resolvedProject) {
        // Plan has no project yet — stamp it with the board's active project,
        // read from the same DB the board persists it to. Without this, a plan
        // initially imported with project='' (e.g. before the board first
        // refreshed) would stay empty forever.
        resolvedProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
    }
    const updatedRecord: KanbanPlanRecord = {
        ...plan,
        topic: metadata.topic,
        complexity: metadata.complexity,
        tags: metadata.tags,
        project: resolvedProject,
        updatedAt: fileMtime
    };
```

**After:**
```typescript
} else {
    // Existing plan - update metadata.
    // Project assignment: only honor an explicit frontmatter project override.
    // The auto-assign-to-active-project behavior is intentionally FIRST-IMPORT ONLY
    // (the !plan branch above). Re-stamping on every save causes plans to jump
    // between projects when the user clicks through the board dropdown while
    // agents are writing to plan files. If the plan has no project and no
    // frontmatter override, leave it empty — insertFileDerivedPlan's COALESCE
    // preserves the existing DB value, and the user can assign manually.
    let resolvedProject = plan.project;
    if (metadata.project) {
        resolvedProject = metadata.project;
    }
    const updatedRecord: KanbanPlanRecord = {
        ...plan,
        topic: metadata.topic,
        complexity: metadata.complexity,
        tags: metadata.tags,
        project: resolvedProject,
        updatedAt: fileMtime
    };
```

### `src/services/__tests__/GlobalPlanWatcherService.test.ts` — Add regression test

Add a test that verifies an existing plan with `project = ''` is NOT reassigned to the active project filter on file update:

```typescript
test('existing plan with empty project is NOT reassigned to active project on update', async () => {
    resolveStub.withArgs('/parent/root').returns('/parent/root');
    service.setCurrentProject('/parent/root', 'Project A');

    // Plan already exists in DB with no project
    dbStub.getPlanByPlanFile = sandbox.stub().resolves({
        planId: 'plan-1',
        sessionId: '',
        topic: 'Existing plan',
        planFile: '.switchboard/plans/test.md',
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: '3',
        tags: '',
        project: '',           // ← no project assigned
        workspaceId: 'ws-123',
        projectId: null,
    } as any);

    dbStub.getConfig = sandbox.stub().withArgs('kanban.activeProjectFilter').resolves('Project A');
    dbStub.insertFileDerivedPlan = sandbox.stub().resolves(true);

    sandbox.stub(fs.promises, 'stat').resolves({
        mtime: new Date('2026-07-02T12:00:00Z'),
        birthtime: new Date('2026-07-02T10:00:00Z'),
    } as any);
    sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nExisting plan');
    const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
    parseStub.resolves({ sessionId: '', topic: 'Existing plan', complexity: '3', tags: '', dependencies: '', kanbanColumn: 'CREATED' });

    await (service as any)._handlePlanFile(parentMockUri, workspaceRoot);

    const upserted = dbStub.insertFileDerivedPlan.getCall(0).args[0];
    assert.strictEqual(upserted.project, '', 'Existing plan must not be reassigned to active project on update');
});
```

## Verification Plan

1. **Unit test**: Run `npm test` — the new regression test should pass, confirming existing plans with empty projects are not reassigned on update.

2. **Manual repro** (the exact scenario from the bug report):
   - Create a plan with no project assigned (import a plan file while no project filter is active).
   - Select "Project A" in the board dropdown.
   - Have an agent (or manually) edit and save the plan file.
   - Verify the plan's project stays empty (or whatever it was before), NOT "Project A".
   - Switch to "Project B" in the dropdown.
   - Save the plan file again.
   - Verify the plan's project is still unchanged.

3. **First-import still works**: Create a brand-new plan file while "Project A" is selected in the dropdown. Verify the plan is assigned to "Project A" on first import.

4. **Frontmatter override still works**: Add `**Project:** Project X` to a plan's metadata section. Save the file. Verify the plan's project updates to "Project X" regardless of the board dropdown selection.
