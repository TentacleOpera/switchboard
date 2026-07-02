# Auto-Assign to Current Project Must Only Fire on First Import, Not on Save/Update

**Plan ID:** f1cbf627-0a7c-417f-88c9-f1cbf627229b

## Goal

### Problem

When an agent writes to an existing plan file (save, update, or edit), the `GlobalPlanWatcherService` file watcher fires and re-resolves the plan's project assignment. If the plan currently has no project (`project = ''`), the watcher stamps it with whatever project the user currently has selected in the kanban board dropdown (`kanban.activeProjectFilter` DB config key). Since the user clicks through different projects while agents are concurrently writing to plan files, plans jump randomly between projects — appearing to "move all over the place."

### Root Cause

In `src/services/GlobalPlanWatcherService.ts`, the `_handlePlanFile` method has two branches:

1. **New plan (`!plan`)** — lines 517–615: Correctly stamps the plan with `metadata.project || activeProject` (the board's current project filter). This is the intended "first import" behavior.

2. **Existing plan (`else`)** — lines 617–698: Re-resolves the project on **every** file modification:
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

The `insertFileDerivedPlan` ON CONFLICT clause (`project = COALESCE(NULLIF(excluded.project, ''), plans.project)`, KanbanDatabase.ts:1453) would normally preserve the existing DB value when the incoming project is empty — but branch (B) ensures the incoming value is *never* empty for unassigned plans, so the COALESCE never gets a chance to protect them.

### Background Context

The `kanban.activeProjectFilter` DB config key is written by `KanbanProvider.setProjectFilter()` every time the user switches the project dropdown (line 4937). It reflects the user's *current viewing context*, not a stable assignment intent. Using it to assign projects to existing plans on every file save conflates "what am I looking at" with "what should this plan belong to."

> **Relationship to companion subtask**: The companion subtask "Create plan always assigns to a project even with base workspace board selected" fixes the *stale-config* root cause by awaiting `setProjectFilter`'s DB write. That fix ensures `kanban.activeProjectFilter` is never stale. However, even with a non-stale config, branch (B) still re-stamps existing plans on every save — if the user is viewing "Foo" and an agent saves a plan with no project, the plan jumps to "Foo" (correct config, wrong behavior). THIS subtask removes branch (B) entirely, making auto-assignment first-import-only. Both fixes are needed: the companion prevents stale reads, this one prevents the re-stamp-on-save behavior.

## Metadata

- **Tags:** bugfix, reliability
- **Complexity:** 3/10

## User Review Required
Yes — the fix removes the "auto-assign to active project on save" behavior for existing plans with no project. Reviewer must confirm this is acceptable: plans imported with `project = ''` before the board first refreshed will stay `''` until manually assigned via the board UI. The first-import path (branch 1) still handles the common case. If the reviewer wants a "catch-up" mechanism for plans that were imported before the board set a project, that would be a separate feature — not this bugfix.

## Complexity Audit

### Routine
- Single conditional removal in one file (`GlobalPlanWatcherService.ts`, lines 626-631).
- The new-plan import path (branch 1) already handles first-import assignment correctly — no change needed there.
- No schema changes, no new APIs, no migration needed.
- The `insertFileDerivedPlan` COALESCE clause already preserves existing DB values when the incoming project is empty — removing branch (B) lets it do its job.

### Complex / Risky
- None. The change is a pure deletion of a buggy code path. The only behavioral change is that existing plans with `project = ''` no longer get silently re-assigned on save.

## Edge-Case & Dependency Audit

1. **Plans imported with `project = ''` before board refresh**: The first-import path (branch 1) uses `metadata.project || activeProject`. If `activeProject` is also empty at import time (board hasn't refreshed yet), the plan gets `project = ''`. After this fix, it will stay `''` until manually assigned — which is correct behavior (no silent reassignment). The user can assign it via the board UI's "Assign to project" button.

2. **Frontmatter `metadata.project` override**: Branch (A) is preserved. If a plan file's frontmatter explicitly declares a project, it will still be honored on every save. This is correct — the file is the authority for its own project when it says so explicitly.

3. **Atomic-write DELETE→re-INSERT race**: When an editor saves via temp-file+rename, the watcher fires a DELETE then a CREATE. The DELETE handler captures a tombstone; the CREATE handler may take the `!plan` (new plan) branch if the row was deleted. In that case, the first-import path runs and stamps the active project — which is correct (it's genuinely a re-import). The tombstone restoration logic (lines 587–606) preserves the kanban column. Project is not tombstoned, so a re-imported plan gets the current active project. This is acceptable: the atomic-write race is a re-import, not an update. The companion subtask's fix (await `setProjectFilter`) ensures the active project is not stale in this path.

4. **`insertFileDerivedPlan` COALESCE behavior**: After removing branch (B), `resolvedProject` will be `plan.project` (possibly `''`) when no frontmatter project is set. The ON CONFLICT clause `project = COALESCE(NULLIF(excluded.project, ''), plans.project)` (KanbanDatabase.ts:1453) will preserve the existing DB value — exactly the desired behavior.

5. **Epic project derivation** (`KanbanProvider.ts:9290`): Epics derive their project from subtasks or the active filter. This is a separate code path (`recomputeEpicColumnFromSubtasks` / epic creation) and is not affected by this change.

6. **Existing tests — STALE INFRASTRUCTURE**: `GlobalPlanWatcherService.test.ts` has two problems:
   - The `_handlePlanFile` tests (lines 288-420) stub `dbStub.upsertPlans` but the source calls `db.insertFileDerivedPlan` (not `upsertPlans`). These tests will fail because `insertFileDerivedPlan` is not stubbed on `dbStub` — calling it throws `TypeError`, which is caught by `_handlePlanFile`'s try/catch, so `upsertSpy.getCall(0)` returns undefined and the assertion throws.
   - The `setCurrentProject` tests (lines 426-511) call `service.setCurrentProject(...)` but `setCurrentProject` does NOT exist in the source `GlobalPlanWatcherService.ts` (verified — zero matches). These tests will throw `TypeError: service.setCurrentProject is not a function`.
   - **The proposed regression test in the original plan also used `service.setCurrentProject` — this is broken.** The corrected test (below) stubs `dbStub.getConfig` directly instead.

## Dependencies
- `feature_plan_20260702083644_create-plan-always-assigns-to-project.md` — Companion subtask that fixes the stale-config root cause by awaiting `setProjectFilter`. Together they close both the stale-config race (companion) and the re-stamp-on-every-save behavior (this plan). Either fix independently resolves the create-plan-always-assigns bug for the normal flow; both are needed for the atomic-write race and the "plans jump on save" scenario.

## Adversarial Synthesis
Key risks: (1) Plans imported with `project = ''` before the board sets a project will stay unassigned until manually fixed — but this is correct behavior (no silent reassignment is better than random reassignment). (2) The test file is stale — existing `_handlePlanFile` tests stub `upsertPlans` (source calls `insertFileDerivedPlan`) and `setCurrentProject` tests reference a non-existent method. The new regression test must stub `insertFileDerivedPlan` and `getConfig` directly, not rely on `setCurrentProject`. (3) The atomic-write DELETE→re-INSERT race still stamps the active project in the `!plan` branch — but this is correct (it's a re-import, not an update) and the companion subtask ensures the config isn't stale. Mitigations: remove branch (B) only; preserve branch (A); write the regression test with correct stubs.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — Remove active-project re-stamp on existing-plan updates

**Lines 617–643** (the `else` / existing-plan branch):

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

### `src/services/__tests__/GlobalPlanWatcherService.test.ts` — Add regression test (corrected)

> **Correction to original test**: The original proposed test called `service.setCurrentProject('/parent/root', 'Project A')` — but `setCurrentProject` does NOT exist in the source. The corrected test stubs `dbStub.getConfig` directly to simulate the active project filter. It also stubs `dbStub.insertFileDerivedPlan` (the actual method the source calls, not the stale `upsertPlans`).

```typescript
test('existing plan with empty project is NOT reassigned to active project on update', async () => {
    const workspaceRoot = '/mock/root';
    const planPath = '/mock/root/.switchboard/plans/existing.md';
    const relativePath = '.switchboard/plans/existing.md';
    const mockUri = { fsPath: planPath } as vscode.Uri;
    const fixedMtime = new Date('2026-07-02T12:00:00.000Z');
    const fixedBirthtime = new Date('2026-07-02T10:00:00.000Z');

    // Plan already exists in DB with no project
    dbStub.getPlanByPlanFile = sandbox.stub().resolves({
        planId: 'plan-1',
        sessionId: '',
        topic: 'Existing plan',
        planFile: relativePath,
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: '3',
        tags: '',
        project: '',           // ← no project assigned
        workspaceId: 'ws-123',
        projectId: null,
    } as any);

    // Simulate the board having "Project A" as the active filter
    dbStub.getConfig = sandbox.stub().withArgs('kanban.activeProjectFilter').resolves('Project A');
    dbStub.insertFileDerivedPlan = sandbox.stub().resolves(true);

    sandbox.stub(fs.promises, 'stat').resolves({
        mtime: fixedMtime,
        birthtime: fixedBirthtime,
    } as any);
    sandbox.stub(fs.promises, 'readFile').resolves('# Plan\n\n## Topic\nExisting plan');
    const parseStub = sandbox.stub(await import('../planMetadataUtils'), 'parsePlanMetadata');
    parseStub.resolves({ sessionId: '', topic: 'Existing plan', complexity: '3', tags: '', dependencies: '', kanbanColumn: 'CREATED' });

    await (service as any)._handlePlanFile(mockUri, workspaceRoot);

    const upserted = dbStub.insertFileDerivedPlan.getCall(0).args[0];
    assert.strictEqual(upserted.project, '', 'Existing plan must not be reassigned to active project on update');
});
```

> **Note on stale test infrastructure**: The existing `_handlePlanFile` tests (lines 288-420) stub `upsertPlans` but the source calls `insertFileDerivedPlan`. These tests are likely already failing. Fixing them is out of scope for this subtask but should be tracked as a separate cleanup task. The new regression test above correctly stubs `insertFileDerivedPlan`.

## Verification Plan

> **Note:** Per session directives, compilation and automated tests are skipped in this verification plan. The test suite will be run separately by the user.

### Manual Verification
1. **Manual repro** (the exact scenario from the bug report):
   - Create a plan with no project assigned (import a plan file while no project filter is active).
   - Select "Project A" in the board dropdown.
   - Have an agent (or manually) edit and save the plan file.
   - Verify the plan's project stays empty (or whatever it was before), NOT "Project A".
   - Switch to "Project B" in the dropdown.
   - Save the plan file again.
   - Verify the plan's project is still unchanged.

2. **First-import still works**: Create a brand-new plan file while "Project A" is selected in the dropdown. Verify the plan is assigned to "Project A" on first import (the `!plan` branch is unchanged).

3. **Frontmatter override still works**: Add `**Project:** Project X` to a plan's metadata section. Save the file. Verify the plan's project updates to "Project X" regardless of the board dropdown selection (branch A is preserved).

4. **Existing tests (run separately)**: Run `npm test` — the new regression test should pass. Note: existing `_handlePlanFile` tests may fail due to stale `upsertPlans` stubs (pre-existing issue, not caused by this change).

## Uncertain Assumptions

None — all code paths, line numbers, SQL clauses, and method existence were verified by reading the source files directly. No web research is needed.
