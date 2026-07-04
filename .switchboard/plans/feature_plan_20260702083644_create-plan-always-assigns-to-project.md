# Create plan always assigns to a project even with base workspace board selected

**Plan ID:** f1cbf627-0a7c-417f-88c9-f1cbf627229a

## Goal

### Problem
When the user clicks any "Create Plan" button while the base workspace board (no project / `__unassigned__`) is selected on the kanban board, the newly created plan is always assigned to a project instead of being left unassigned. The user expects: if the base workspace board is selected, the new plan should have NO project.

### Background
All create-plan paths converge on `TaskViewerProvider.createDraftPlanTicket()` (TaskViewerProvider.ts:16766-16808). This method:
1. Gets the active project filter: `const activeProject = this._kanbanProvider?.getProjectFilter()` (line 16782)
2. Checks if it's a real project: `if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)` (line 16783)
3. If so, passes `projectName` to `_createInitiatedPlan` (line 16788)
4. `_createInitiatedPlan` (TaskViewerProvider.ts:17319) calls `db.assignPlansToProject(...)` if `options.projectName` is set (TaskViewerProvider.ts:17380-17393)
5. **Critically**, `_createInitiatedPlan` also calls `_registerPlan` (line 17369) which calls `db.insertFileDerivedPlan` (line 11686) with `project: ''` for the base-workspace case. This inserts the plan into the kanban `plans` table immediately — so the plan IS in the DB before the watcher fires.

### Root Cause
The logic at lines 16782-16785 appears correct — it only assigns a project when the filter is NOT `UNASSIGNED_PROJECT_FILTER`. So when the base workspace board is selected, `activeProject` should be `'__unassigned__'`, the condition should be false, and `projectName` should be `undefined`.

**Correct so far.** `_registerPlan` inserts the plan via `insertFileDerivedPlan` (line 11686) with `project: ''` — correct. `assignPlansToProject` is skipped because `projectName` is `undefined`. So the plan is in the DB with `project = ''`.

The bug surfaces via the **GlobalPlanWatcherService**. When `_createInitiatedPlan` writes the plan file (TaskViewerProvider.ts:17351), the file watcher detects the new file. The watcher's `_handlePlanFile` method (GlobalPlanWatcherService.ts:444) checks `GlobalPlanWatcherService._pendingCreations` — if the file is in the pending set, it skips the import (line 446-448). The pending entry is set by `GlobalPlanWatcherService.registerPendingCreation(planFileAbsolute)` at TaskViewerProvider.ts:17348.

The pending creation window is **10000ms** (GlobalPlanWatcherService.ts:46-48). After 10000ms, the pending entry is deleted and the watcher will process the file. Since `_registerPlan` already inserted the plan into the DB, the watcher's `getPlanByPlanFile` lookup (line 466) finds the existing row → the watcher takes the **`else` (existing plan) branch** (line 617), NOT the `!plan` (new plan) branch.

In the `else` branch (lines 617-640), the watcher re-resolves the project:
```ts
let resolvedProject = plan.project;           // '' (correct)
if (metadata.project) {
    resolvedProject = metadata.project;       // (A) frontmatter override
} else if (!resolvedProject) {
    resolvedProject = (await db.getConfig('kanban.activeProjectFilter')) || '';  // (B) BUG
}
```

Since `plan.project` is `''` (falsy), branch (B) fires and reads `kanban.activeProjectFilter` from the DB config. The `kanban.activeProjectFilter` config key is written by `setProjectFilter` (KanbanProvider.ts:4937-4961):
```ts
const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
void this._getKanbanDb(this._currentWorkspaceRoot)
    .setConfig('kanban.activeProjectFilter', activeProjectName)
    .catch(e => console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e));
```

**The actual root cause**: The `kanban.activeProjectFilter` config key is **stale**. It's written asynchronously by `setProjectFilter` via `void this._getKanbanDb(...).setConfig(...)` (KanbanProvider.ts:4950). The `void` means the write is fire-and-forget. If the user switches from a project (e.g., "Foo") to the base workspace (`__unassigned__`), `setProjectFilter` fires the config write to set it to `''`, but the write may not complete before the watcher reads it. The watcher then reads the OLD value (`"Foo"`) and branch (B) stamps the plan with "Foo".

> **Correction to original analysis**: The original root-cause section claimed the watcher does a "second insert" via the `!plan` (new plan) branch. This is **incorrect** for the normal create-plan flow. `_registerPlan` (called inside `_createInitiatedPlan` at line 17369) inserts the plan into the kanban DB immediately via `insertFileDerivedPlan` (line 11686). After the 10000ms pending window, the watcher finds the existing row and takes the `else` branch — not `!plan`. The reassignment happens via branch (B) in the `else` path, which is the same bug fixed by the companion subtask "Auto-Assign to Current Project Must Only Fire on First Import." The stale-config root cause (fire-and-forget `setProjectFilter`) is what THIS subtask fixes.

> **Note on the atomic-write DELETE→re-INSERT race**: If an editor saves via temp-file+rename, the watcher fires DELETE (removes the row) then CREATE. After DELETE, `getPlanByPlanFile` returns null → the `!plan` branch fires → stamps `metadata.project || activeProject`. If `activeProject` is stale, the plan gets the wrong project. The tombstone logic (lines 587-606) restores the column but NOT the project. Awaiting `setProjectFilter` (this subtask's fix) prevents the stale read in this path too.

## Metadata
- **Tags:** bugfix, reliability
- **Complexity:** 6/10

## User Review Required
Yes — the fix changes `setProjectFilter` from synchronous (`void`) to `async`/`awaited`. This is a signature change that ripples to all 5 call sites and 2 test files. Reviewer must confirm no caller relies on the synchronous completion of the DB write (the in-memory `_projectFilter` is still set synchronously, so `getProjectFilter()` is unaffected).

## Complexity Audit

### Routine
- Changing `void` to `await` in a single method body (`setProjectFilter`).
- Adding `await` to 5 existing call sites (all already inside async message-handler contexts).
- In-memory `_projectFilter` assignment remains synchronous — no behavioral change to `getProjectFilter()`.

### Complex / Risky
- **Signature change**: `setProjectFilter` goes from `void` to `Promise<void>`. Any caller that doesn't await gets a floating promise. Must audit ALL callers (5 in KanbanProvider.ts, 2 in test files).
- **Test impact**: `KanbanProvider.test.ts` calls `provider.setProjectFilter('...')` without await (lines 500, 536). These need `await` to avoid floating-promise warnings, though they'll still pass because `getProjectFilter()` reads the in-memory value set synchronously.
- **Stale-config window elimination**: The fix narrows the race window from "unbounded" (fire-and-forget) to "zero" (awaited). But if `_refreshBoardImpl` also writes `kanban.activeProjectFilter` (per code comments at line 4946), there's a second write path. That path writes the same value (current filter), so it's not a correctness issue — just a potential double-write.

## Edge-Case & Dependency Audit
- **Fire-and-forget config write**: `setProjectFilter` (KanbanProvider.ts:4950) uses `void` to fire-and-forget the DB config write. This is the root cause. The write must be awaited before any plan creation reads it.
- **Pending creation window (10000ms)**: `registerPendingCreation` sets a 10000ms timeout (GlobalPlanWatcherService.ts:46-48) after which the watcher will process the file. Since `_registerPlan` inserts the plan into the DB synchronously during `_createInitiatedPlan`, the watcher finds the existing row after the window expires and takes the `else` branch — re-stamping the project via branch (B).
- **`insertFileDerivedPlan` project field**: `_registerPlan` calls `insertFileDerivedPlan` (line 11686) with `project: ''` for the base-workspace case. The ON CONFLICT clause (`project = COALESCE(NULLIF(excluded.project, ''), plans.project)`, KanbanDatabase.ts:1453) preserves the existing DB value when the incoming project is empty. But branch (B) in the watcher's `else` path ensures the incoming value is NON-empty (stale "Foo"), so COALESCE never protects.
- **`metadata.project`**: The watcher checks `metadata.project || activeProject` (new-plan branch, line 526) or `metadata.project` then `activeProject` (else branch, lines 623-631). For newly created plans, the plan content template (`_buildDraftPlanContent`, line 16749) does not include project metadata, so `metadata.project` is empty, and the fallback to `activeProject` is used.
- **Multiple rapid project switches**: If the user rapidly switches between projects and the base workspace, multiple fire-and-forget config writes may race. The last write should win, but without awaiting, the order is not guaranteed. Awaiting eliminates this.
- **`assignPlansToProject` in `_createInitiatedPlan`**: When `projectName` IS set (a real project is selected), this path correctly assigns the plan (lines 17380-17393). The bug is only about the base-workspace case where `projectName` is NOT set but the watcher overrides it.
- **Atomic-write DELETE→re-INSERT race**: When an editor saves via temp+rename, the watcher fires DELETE then CREATE. The `!plan` branch stamps `metadata.project || activeProject`. If `activeProject` is stale, the plan gets the wrong project. The tombstone restores the column (lines 587-606) but not the project. Awaiting `setProjectFilter` prevents the stale read here too.
- **Companion subtask dependency**: The `else`-branch re-stamp (branch B) is independently fixed by the companion subtask "Auto-Assign to Current Project Must Only Fire on First Import." That subtask removes branch (B) entirely, so even if the config is stale, existing plans aren't re-stamped. This subtask's fix (await `setProjectFilter`) addresses the root cause (stale config) for BOTH the `else` branch and the `!plan` branch (atomic-write race).

## Dependencies
- `feature_plan_20260702114923_auto-assign-project-only-on-first-import.md` — Companion subtask that removes the `else`-branch re-stamp. Together they close both the stale-config race (this plan) and the re-stamp-on-every-save behavior (companion). Either fix independently resolves the create-plan-always-assigns bug for the normal flow; both are needed for the atomic-write race and the "plans jump on save" scenario.

## Adversarial Synthesis
Key risks: (1) `setProjectFilter` signature change from `void` to `Promise<void>` ripples to 5 call sites + 2 test files — any un-awaited caller leaves a floating promise. (2) The original plan's "defense-in-depth" change #2 (re-query `getPlanByPlanFile` in the `!plan` branch) is a no-op because `plan` was already fetched as null at line 466 — re-querying returns the same null. (3) The original plan's change #3 is a pure no-op (the code already produces `undefined` for the base-workspace case). Mitigations: await all callers (all are in async contexts); remove change #2 (broken); keep change #3 only as a documentation comment. The root-cause fix (change #1) is sufficient and correct.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — await the config write in `setProjectFilter`

Change the fire-and-forget `void` to an awaited write. Since `setProjectFilter` is currently synchronous (`public setProjectFilter(filter: string | null): void`), it needs to become async.

**Option A (preferred): Make `setProjectFilter` async and await the config write.**

```ts
// BEFORE (KanbanProvider.ts:4937-4961)
public setProjectFilter(filter: string | null): void {
    this._projectFilter = filter;
    if (this._currentWorkspaceRoot) {
        const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
        const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
        void this._getKanbanDb(this._currentWorkspaceRoot)
            .setConfig('kanban.activeProjectFilter', activeProjectName)
            .catch(e => console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e));

        if (this._projectFilterSaveTimeout) {
            clearTimeout(this._projectFilterSaveTimeout);
        }
        this._projectFilterSaveTimeout = setTimeout(async () => {
            await this._context.workspaceState.update(`kanban.projectFilter.${resolvedRoot}`, filter);
        }, 100);
    }
}

// AFTER
public async setProjectFilter(filter: string | null): Promise<void> {
    this._projectFilter = filter;
    if (this._currentWorkspaceRoot) {
        const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
        const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
        try {
            await this._getKanbanDb(this._currentWorkspaceRoot)
                .setConfig('kanban.activeProjectFilter', activeProjectName);
        } catch (e) {
            console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e);
        }

        if (this._projectFilterSaveTimeout) {
            clearTimeout(this._projectFilterSaveTimeout);
        }
        this._projectFilterSaveTimeout = setTimeout(async () => {
            await this._context.workspaceState.update(`kanban.projectFilter.${resolvedRoot}`, filter);
        }, 100);
    }
}
```

**Update all callers** to await the now-async `setProjectFilter`:
- KanbanProvider.ts:5499 — `await this.setProjectFilter(KanbanDatabase.UNASSIGNED_PROJECT_FILTER)` (inside `selectWorkspace` case, async context)
- KanbanProvider.ts:5501 — `await this.setProjectFilter(msg.project)` (inside `selectWorkspace` case, async context)
- KanbanProvider.ts:5553 — `await this.setProjectFilter(projectName)` (inside `createProject` case, async context)
- KanbanProvider.ts:5619 — `await this.setProjectFilter(KanbanDatabase.UNASSIGNED_PROJECT_FILTER)` (inside `deleteProject` case, async context)
- KanbanProvider.ts:5640 — `await this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER)` (inside `setProjectFilter` case, async context)

All 5 call sites are inside `async` message-handler case blocks, so `await` is valid.

### 2. ~~`src/services/GlobalPlanWatcherService.ts` — don't override project for recently created plans~~

> **REMOVED (broken):** The original plan proposed re-querying `db.getPlanByPlanFile(relativePath, workspaceId)` inside the `!plan` branch to check if the plan already exists with a project. This is a **no-op**: `plan` is fetched at line 466 via the same `getPlanByPlanFile` call. If it returned null there, it returns null again here. The defense-in-depth does not work as written.
>
> The atomic-write DELETE→re-INSERT race (where `!plan` fires after a DELETE) is covered by change #1 (awaiting `setProjectFilter` ensures `activeProject` is never stale). The companion subtask removes the `else`-branch re-stamp. No watcher change is needed in this subtask.

### 3. `src/services/TaskViewerProvider.ts` — document the base-workspace intent (clarification, no behavioral change)

In `createDraftPlanTicket`, the current code already produces `projectName = undefined` for the base-workspace case. This is correct — `_createInitiatedPlan` skips `assignPlansToProject` and `_registerPlan` inserts with `project: ''`. No code change is needed. The original plan's proposed `else if` branch is a no-op.

**Optional documentation comment** (no behavioral change):
```ts
// TaskViewerProvider.ts:16781-16785 — existing code, no change needed
let projectName: string | undefined;
const activeProject = this._kanbanProvider?.getProjectFilter();
if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
    projectName = activeProject;
}
// When activeProject is UNASSIGNED_PROJECT_FILTER or null, projectName stays undefined.
// _createInitiatedPlan skips assignPlansToProject and _registerPlan inserts with project: ''.
// The watcher's else-branch re-stamp (branch B) is the bug — fixed by the companion subtask
// and by awaiting setProjectFilter (change #1) so the config is never stale.
```

### 4. `src/services/__tests__/KanbanProvider.test.ts` — await setProjectFilter calls

Update the two synchronous calls to await:
- Line 500: `await provider.setProjectFilter('Project A');`
- Line 536: `await provider.setProjectFilter('DeletedProject');`

Both tests assert `getProjectFilter()` which reads the in-memory value (set synchronously), so they pass regardless. The `await` prevents floating-promise warnings.

## Verification Plan

> **Note:** Per session directives, compilation and automated tests are skipped in this verification plan. The test suite will be run separately by the user.

### Manual Verification
1. **Base workspace selected, create plan**: Select the base workspace (no project) on the kanban board. Click "Create Plan". Verify the new plan has NO project assigned (check the kanban card — no project label, and query the DB: `SELECT project FROM plans WHERE plan_file = '...'`).
2. **Project selected, create plan**: Select project "Foo" on the kanban board. Create a plan. Verify the plan is assigned to "Foo".
3. **Rapid switch from project to base, then create**: Select "Foo", then immediately switch to base workspace, then quickly create a plan. Verify the plan has NO project (the config write should be awaited and complete before creation).
4. **Watcher delay scenario**: Create a plan, then wait >10 seconds. Verify the watcher does not re-import the plan with a stale project (check DB — project should remain empty).
5. **External plan creation (drag file into plans folder)**: While base workspace is selected, manually create a `.md` file in `.switchboard/plans/`. Verify the watcher imports it with no project (not the stale filter).
6. **External plan creation while project selected**: While "Foo" is selected, manually create a `.md` file. Verify the watcher imports it with project "Foo".
7. **Existing tests (run separately)**: Run `npm test` and verify no regressions in `KanbanProvider.test.ts` (which tests `setProjectFilter`). The two `setProjectFilter` calls in the test file should be updated to `await`.

## Uncertain Assumptions

None — all code paths, line numbers, and SQL clauses were verified by reading the source files directly. No web research is needed.

## Review Findings

Reviewed commit `7b6e790` (implementation) against plan requirements. The core fix — `setProjectFilter` async conversion with awaited config write — is correct: all 5 production callers and 2 test callers are properly awaited, in-memory `_projectFilter` remains synchronous, and try/catch prevents unhandled rejections. **MAJOR fix applied**: removed an unplanned double-trigger `this._taskViewerProvider?.refreshUI(workspaceRoot)` at `KanbanProvider.ts:6248` — `_refreshBoard` at line 6247 already calls `refreshUI` via the `switchboard.refreshUI` command, so the direct call was redundant, fire-and-forget, and introduced an unhandled-rejection vector. **NIT (deferred)**: the commit bundled an unrelated `activatePlanInProjectPanel` signature change (added optional `sessionId` param) — safe but outside plan scope. File changed: `src/services/KanbanProvider.ts` (line 6248 removed). Verification: grep confirmed no orphaned references to the removed call; compilation and tests skipped per session directives. Remaining risk: the `activatePlanInProjectPanel` scope creep is harmless but should be noted for commit hygiene.
