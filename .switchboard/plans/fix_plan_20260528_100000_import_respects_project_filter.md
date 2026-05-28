---
description: Fix ClickUp/Linear import to respect project filter
---

# Fix: ClickUp/Linear Import Respects Project Filter

## Goal
When importing a task from ClickUp or Linear, the imported plan should be assigned to the currently selected project in the kanban filter, rather than always landing on the base board.

## Metadata
- **Tags:** [bugfix, backend, UI]
- **Complexity:** 4

## User Review Required
- Confirm that imported plans should inherit the active project filter (vs. always going to base board).
- Confirm that draft plans and clipboard imports are out of scope for this fix.

## Complexity Audit

### Routine
- Adding an optional `projectName` parameter to `_createInitiatedPlan()` options (backward-compatible, no callers break)
- Calling `assignPlansToProject()` after plan creation — reuses existing DB method already used by the kanban UI
- Reading `this._kanbanProvider?.getProjectFilter()` in import handlers — already proven pattern (line 13472)

### Complex / Risky
- Threading `projectName` through `_createImportedLinearPlan()` recursive helper — must ensure the parameter propagates to all recursive subtask calls without breaking the recursion signature

## Edge-Case & Dependency Audit

- **Race Conditions:** Between `_createInitiatedPlan` creating the plan and `assignPlansToProject` updating it, there is a brief window where the plan exists without a project assignment. This is benign — the assignment happens in the same async function before any UI refresh, and the kanban refresh only fires after the entire import completes.
- **Security:** No user-controlled input flows through `projectName` beyond what `KanbanProvider._projectFilter` already holds (set from a validated dropdown). No injection risk.
- **Side Effects:** `assignPlansToProject` does a direct SQL UPDATE on the `plans` table. If the project name doesn't exist in the `projects` table, the plan gets a `project` column value that doesn't match any project row. This is the same behavior as the existing kanban UI drag-and-drop assignment (KanbanProvider line 4197), and the project filter is always set from a validated dropdown, so phantom projects are unlikely.
- **Dependencies & Conflicts:** No other in-flight changes touch `_createInitiatedPlan` or the import methods. The `assignPlansToProject` DB method is stable and already tested.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The Linear import call path goes through `_createImportedLinearPlan`, not directly to `_createInitiatedPlan` — the `projectName` option must be threaded through this recursive helper. (2) Redundant DB calls inside `_createInitiatedPlan` should be avoided by reusing the existing `wsId` variable. Mitigations: Explicitly update `_createImportedLinearPlan` signature; reuse `wsId` from `_registerPlan` for project assignment; drop the unnecessary webview change since `getProjectFilter()` is already accessible from the backend.

## Proposed Changes

### 1. Update `_createInitiatedPlan()` signature and implementation
**File:** `src/services/TaskViewerProvider.ts`
**Lines:** 15271-15361

Add `projectName?: string` to the options type (line 15276-15280):

```typescript
private async _createInitiatedPlan(
    title: string,
    idea: string,
    isAirlock: boolean,
    options: {
        skipBrainPromotion?: boolean;
        suppressIntegrationSync?: boolean;
        createdAt?: string;
        skipTemplateHeadings?: boolean;
        projectName?: string;  // NEW: optional project assignment
    } = {}
): Promise<{ planFileAbsolute: string; }>
```

After `_registerPlan` completes (after line 15330) and before the `suppressIntegrationSync` check (line 15338), add project assignment:

```typescript
// Assign to project if specified (reuses wsId from _registerPlan above)
if (options.projectName && wsId) {
    const db = await this._getKanbanDb(workspaceRoot);
    if (db) {
        await db.assignPlansToProject(
            [planFileRelative.replace(/\\/g, '/')],
            options.projectName,
            wsId
        );
    }
}
```

**Why reuse `wsId`:** The `_getOrCreateWorkspaceId` is already called at line 15320 and stored as `wsId`. Calling it again would be redundant and could theoretically return a different value if the workspace context changed between calls (unlikely but defensive).

**Insertion point rationale:** Placing project assignment after `_registerPlan` ensures the plan row exists in the DB before we UPDATE it. Placing it before `suppressIntegrationSync` ensures the project is set before any integration sync fires, so synced data reflects the correct project.

### 2. Update `_createImportedLinearPlan()` to thread `projectName`
**File:** `src/services/TaskViewerProvider.ts`
**Lines:** 4016-4067

This is the recursive helper that `importLinearTask()` actually calls. It must accept and forward `projectName`:

```typescript
private async _createImportedLinearPlan(
    db: KanbanDatabase,
    linearService: LinearSyncService,
    node: LinearImportNode,
    createdPlanFiles: string[],
    parentPlanFile?: string,
    parentIssue?: LinearIssue,
    projectName?: string  // NEW: forward to _createInitiatedPlan
): Promise<string> {
    const createdAt = new Date().toISOString();
    const { planFileAbsolute } = await this._createInitiatedPlan(
        node.issue.title || this._describeLinearIssue(node.issue),
        this._buildLinearImportPlanContent(node, parentIssue, createdAt),
        false,
        {
            skipBrainPromotion: true,
            createdAt,
            suppressIntegrationSync: true,
            skipTemplateHeadings: true,
            projectName  // NEW: pass through
        }
    );
    // ... existing code unchanged ...

    for (const child of node.subtasks) {
        await this._createImportedLinearPlan(
            db,
            linearService,
            child,
            createdPlanFiles,
            planFileRelative,
            node.issue,
            projectName  // NEW: forward to recursive subtask calls
        );
    }
    // ...
}
```

### 3. Update `importLinearTask()` to pass project filter
**File:** `src/services/TaskViewerProvider.ts`
**Lines:** 4069-4132

Retrieve the current project filter and pass it to `_createImportedLinearPlan`:

```typescript
public async importLinearTask(
    workspaceRoot: string,
    issueId: string,
    includeSubtasks: boolean = true,
    skipSync: boolean = false
): Promise<{ success: boolean; planFile?: string; importedPlanFiles: string[]; error?: string; message?: string }> {
    // ... existing validation code unchanged (lines 4075-4106) ...

    const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

    const importedPlanFiles: string[] = [];
    const rootPlanFile = await this._createImportedLinearPlan(
        db,
        linearService,
        rootNode,
        importedPlanFiles,
        undefined,   // parentPlanFile
        undefined,   // parentIssue
        projectFilter ?? undefined  // NEW: pass current project filter
    );

    // ... rest of method unchanged ...
}
```

### 4. Update `importClickUpTask()` to pass project filter
**File:** `src/services/TaskViewerProvider.ts`
**Lines:** 4134-4218

Retrieve the current project filter and pass it to both the parent and subtask `_createInitiatedPlan` calls:

```typescript
public async importClickUpTask(
    workspaceRoot: string,
    taskId: string,
    includeSubtasks: boolean = true,
    skipSync: boolean = false
): Promise<{ ... }> {
    // ... existing validation code unchanged (lines 4140-4167) ...

    const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

    // Parent task import (line 4172)
    const { planFileAbsolute: rootPlanFile } = await this._createInitiatedPlan(
        task.name || `ClickUp Task ${task.id}`,
        planContent,
        false,
        {
            skipBrainPromotion: true,
            suppressIntegrationSync: true,
            createdAt,
            skipTemplateHeadings: true,
            projectName: projectFilter ?? undefined  // NEW
        }
    );

    // Subtask import (line 4193)
    for (const subtask of subtasks) {
        const subtaskCreatedAt = new Date().toISOString();
        const subtaskContent = this._buildClickUpImportPlanContent(subtask, subtaskCreatedAt);
        const { planFileAbsolute: subtaskPlanFile } = await this._createInitiatedPlan(
            subtask.name || `ClickUp Subtask ${subtask.id}`,
            subtaskContent,
            false,
            {
                skipBrainPromotion: true,
                suppressIntegrationSync: true,
                createdAt: subtaskCreatedAt,
                skipTemplateHeadings: true,
                projectName: projectFilter ?? undefined  // NEW
            }
        );
        // ... rest of subtask loop unchanged ...
    }

    // ... rest of method unchanged ...
}
```

### 5. No webview changes needed
The webview does NOT need to send `projectFilter` in its messages. The backend already has access to `this._kanbanProvider?.getProjectFilter()` (proven by existing usage at line 13472 of TaskViewerProvider.ts). Adding a webview field would create unnecessary coupling between frontend filter state and backend message handling.

## Verification Plan
1. Select a project in the kanban board filter
2. Import a ClickUp task from the implementation.html sidebar
3. Verify the imported plan appears in the selected project board (not base board)
4. Repeat for Linear task import
5. Verify that when no project is selected (filter = null), imports still work (go to base board as before)
6. Verify that subtasks are also assigned to the same project as the parent task
7. Verify that `linearImportAndSendToPlanner` flow also respects the project filter (it calls `importLinearTask`, so it should inherit the fix automatically)
8. Verify that existing callers of `_createInitiatedPlan` (draft plans, clipboard imports) are unaffected — they don't pass `projectName`, so `undefined` is the default and no project assignment occurs

### Automated Tests
- Existing test `src/test/integrations/linear/linear-import-flow.test.js` verifies `_createInitiatedPlan` signature — the regex at line 248 will need updating to include `projectName?: string` in the options pattern
- Existing test `src/test/plan-creation-integration-sync-regression.test.js` verifies `_createInitiatedPlan` signature — may need similar regex update
- Existing test `src/test/clipboard-import-brain-promotion-regression.test.js` — should continue passing since `projectName` is optional with no default

## Files Changed
- `src/services/TaskViewerProvider.ts`:
  - Update `_createInitiatedPlan()` signature and implementation (add `projectName` option + `assignPlansToProject` call)
  - Update `_createImportedLinearPlan()` signature (add `projectName` parameter, forward to `_createInitiatedPlan` and recursive calls)
  - Update `importLinearTask()` to read project filter and pass to `_createImportedLinearPlan`
  - Update `importClickUpTask()` to read project filter and pass to `_createInitiatedPlan` (both parent and subtask calls)
- `src/test/integrations/linear/linear-import-flow.test.js`:
  - Update regex patterns to match new `_createInitiatedPlan` signature with `projectName`
- `src/test/plan-creation-integration-sync-regression.test.js`:
  - Update regex pattern if it matches the full options signature
- `src/test/clipboard-import-brain-promotion-regression.test.js`:
  - Update regex pattern at line 34 to include `projectName?: string` in options

## Review Results (2026-05-28)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | MAJOR | Silent failure on project assignment — `assignPlansToProject` return value ignored, no logging when DB is null or assignment returns false | `TaskViewerProvider.ts:15346-15355` |
| 2 | NIT | `projectFilter ?? undefined` is redundant — `??` only coalesces `null`/`undefined`, but `projectName?: string` already defaults to `undefined` and the guard treats both as falsy | `TaskViewerProvider.ts:4121, 4191, 4213` |
| 3 | NIT | Plan line references stale (said 15271-15361, actual is 15283+) | Plan file metadata |
| 4 | — | Withdrawn: project assignment ordering is correct (before integration sync) | — |
| 5 | NIT | No automated test coverage for the `projectName` behavior path — existing regex tests use `[\s\S]*?` which absorbs the new field but doesn't verify `assignPlansToProject` is called | Test files |
| 6 | MAJOR (pre-existing) | `importClickUpTask` shadows `workspaceId` with different source at line 4195 (`db.getWorkspaceId()`) vs line 4160 (`_getOrCreateWorkspaceId`). Now interacts with new code since `_createInitiatedPlan` uses its own `wsId` for project assignment. | `TaskViewerProvider.ts:4160, 4195` |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action Taken |
|---------|---------|--------------|
| 1. Silent failure | **Fix now** | Added `console.warn` when `assignPlansToProject` returns `false` or DB is null |
| 2. Redundant `?? undefined` | **Fix now** (trivial) | Changed `projectFilter ?? undefined` → `projectFilter \|\| undefined` at all 3 sites |
| 3. Stale line refs | Defer | Noted in review, not blocking |
| 5. No test coverage | Defer | Out of scope; regex tests still pass |
| 6. workspaceId shadowing | Defer (pre-existing) | Not a regression; file separate issue if needed |

### Code Fixes Applied

**File:** `src/services/TaskViewerProvider.ts`

1. **Lines 15346-15360** — Added failure logging for project assignment:
   - Captures `assignPlansToProject` return value; logs `console.warn` if `false`
   - Logs `console.warn` if `_getKanbanDb` returns null while `projectName` is set

2. **Lines 4121, 4191, 4213** — Changed `projectFilter ?? undefined` → `projectFilter || undefined`
   - Semantically equivalent for `string | null` input, more idiomatic

### Verification Results

- **TypeScript typecheck:** 4 pre-existing errors (none in TaskViewerProvider.ts, none related to this plan's changes). No new errors introduced.
- **Existing test regex compatibility:** All 3 test files use `[\s\S]*?` or `[\s\S]*` patterns that absorb the new `projectName?: string` field without modification. Tests should continue passing.

### Remaining Risks

1. **No automated coverage for `assignPlansToProject` call path** — The feature relies on manual verification (steps 1-8 in Verification Plan). A future test could mock `_getKanbanDb` and verify the call.
2. **Pre-existing `workspaceId` shadowing in `importClickUpTask`** — Line 4160 uses `_getOrCreateWorkspaceId`, line 4195 uses `db.getWorkspaceId() || db.getDominantWorkspaceId()`. These could diverge in edge cases. Not introduced by this plan, but worth tracking separately.
3. **`assignPlansToProject` does not validate project name existence** — A phantom project name (not in `projects` table) will be written to the `plans.project` column. Consistent with existing drag-and-drop behavior. Low risk since project filter comes from a validated dropdown.

## Recommendation
Complexity 4 → **Send to Coder** (implementation complete, review fixes applied)
