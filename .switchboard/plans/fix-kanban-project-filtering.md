# Fix Kanban Dependencies and Test Tabs Project Filtering

## Goal
Add project (and optionally repo-scope) filtering to the Dependencies and Test (UAT) tabs in the Kanban board so they respect the project filter already applied to the main board.

## Metadata
- **Tags:** frontend, backend, bugfix, UI
- **Complexity:** 4

## User Review Required

> [!IMPORTANT]
> The plan proposes filtering only by **project**. The existing `getBoardFilteredByProject` method also filters by `repoScope`. The Dependencies and Test tabs will still show plans from other repos when a repo filter (`_repoScopeFilter`) is active. This is a known gap. If full parity with the main board filter (project + repoScope) is required, both `getPlansWithDependencies` and `getPlansByColumn` must also accept and apply a `repoScope` parameter. This can be done in the same pass or deferred as a follow-up — please confirm scope before implementation.

## Complexity Audit

### Routine
- Adding an optional parameter to two existing database methods (`getPlansWithDependencies`, `getPlansByColumn`) following an already-established codebase pattern (`getBoardFilteredByProject`).
- Passing `this._projectFilter` through four call sites in `KanbanProvider` — purely additive, no branching logic changes.
- All SQL changes are a single `AND project = ?` clause appended to existing queries.

### Complex / Risky
- **Sentinel translation**: The project filter can be `null` (no filter), `''` (unassigned), or the sentinel `KanbanDatabase.UNASSIGNED_PROJECT_FILTER = '__unassigned__'`. Naively passing `projectFilter` to SQL would send the sentinel string directly, returning zero rows instead of unassigned plans. Must adopt the same `effectiveProject` translation used in `getBoardFilteredByProject`.
- **`getDependencyMapData` copyPrompt branch**: The plan's Step 4 originally showed `// ... rest of prompt generation logic` as a stub. The actual handler (lines 4327–4360) has ~25 lines of prompt-assembly logic after the `db.getPlansWithDependencies` call. The coder must preserve that logic exactly — only the DB call arguments change.
- **`_refreshBoardWithData` dead-code note**: `_sendDependencyMapData` is invoked from `_refreshBoardWithData` (line 2000), which the code itself comments as "dead code — zero call sites." The live auto-refresh path (`_refreshBoardImpl`) does not call `_sendDependencyMapData`. This means the Dependencies tab only refreshes on explicit user action via `getDependencyMapData`/`rebuildDependencyMap` handlers. This is a pre-existing issue unrelated to this fix; do not change this behaviour.

## Edge-Case & Dependency Audit

### Race Conditions
- None. All calls are sequential `await` chains. No shared mutable state is modified.

### Security
- None beyond what already exists. SQL uses parameterised queries; the filter value comes from `this._projectFilter` which is set from validated extension state.

### Side Effects
- Changing the signature of `getPlansWithDependencies` and `getPlansByColumn` is backward-compatible — both new parameters are optional (`projectFilter?: string | null`). All existing callers (none of which pass a third argument) continue to work with no filtering applied.

### Dependencies & Conflicts
- `getBoardFilteredByProject` (line 2174) is the authoritative pattern to follow for sentinel handling — reference it during implementation.
- `getCompletedPlansFilteredByProject` (line 2268) is a parallel method for completed plans; it already has project-filter support. `getPlansByColumn` called with `'COMPLETED'` is used separately — the new optional param is additive and does not break it.
- No UI-side changes needed. The webview sends `type: 'getDependencyMapData'` and `type: 'getUATData'` messages unchanged; the filter is sourced entirely from provider state.

## Dependencies
- None (self-contained change within two files).

## Adversarial Synthesis

Key risks: (1) sentinel `__unassigned__` must be translated to `''` before SQL binding, matching the `effectiveProject` pattern in `getBoardFilteredByProject` — failing to do this causes unassigned-project filter to silently return zero rows; (2) the `copyPrompt` branch in `getDependencyMapData` contains ~25 lines of prompt-assembly logic that must be preserved verbatim with only the DB call updated; (3) `repoScope` filtering is not included in this fix, leaving a partial-parity gap acknowledged under User Review Required. Mitigations: follow `getBoardFilteredByProject` exactly for sentinel handling; treat the plan's `// ...` stubs as "update only the DB call, leave surrounding logic unchanged."

## Problem
The Dependencies and Test (UAT) tabs in kanban.html do not respect the project filter. When a project is selected in the workspace/project dropdown, these tabs still show all plans across all projects instead of only plans belonging to the selected project.

## Root Cause
The backend methods that fetch data for these tabs do not accept or apply project filter parameters:
- `KanbanDatabase.getPlansWithDependencies()` — used by Dependencies tab
- `KanbanDatabase.getPlansByColumn()` — used by UAT tab

Both methods query all plans for a workspace without filtering by the `project` column, even though the main board correctly uses `getBoardFilteredByProject()` which respects the project filter.

## Solution
Modify the database methods to accept optional project filter parameters and update the KanbanProvider to pass the current project filter when calling these methods. Follow the established `effectiveProject` sentinel-translation pattern from `getBoardFilteredByProject`.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

#### Context
`getPlansWithDependencies` (line 2220) and `getPlansByColumn` (line 2200) currently accept only `workspaceId` and column arguments. The sibling method `getBoardFilteredByProject` (line 2174) demonstrates the correct pattern for optional project filtering including sentinel handling.

#### Logic — `getPlansWithDependencies`
```typescript
// Clarification: translate UNASSIGNED sentinel before SQL binding
const effectiveProject = projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER
    ? ''
    : projectFilter;
// Only append AND clause when effectiveProject is non-null
if (effectiveProject !== null && effectiveProject !== undefined) {
    sql += ' AND project = ?';
    params.push(effectiveProject);
}
```

#### Implementation — `getPlansWithDependencies`
Replace (line 2220–2234):
```typescript
public async getPlansWithDependencies(
    workspaceId: string,
    columns: string[] = ['CREATED', 'PLAN REVIEWED']
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const placeholders = columns.map(() => '?').join(',');
    const stmt = this._db.prepare(
        `SELECT plan_id, session_id, topic, kanban_column, dependencies 
         FROM plans
         WHERE workspace_id = ? AND status = 'active' AND kanban_column IN (${placeholders})
         ORDER BY kanban_column, updated_at DESC`,
        [workspaceId, ...columns]
    );
    return this._readRows(stmt);
}
```
With:
```typescript
public async getPlansWithDependencies(
    workspaceId: string,
    columns: string[] = ['CREATED', 'PLAN REVIEWED'],
    projectFilter?: string | null
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const placeholders = columns.map(() => '?').join(',');
    const effectiveProject = projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER
        ? ''
        : projectFilter;

    let sql = `SELECT plan_id, session_id, topic, kanban_column, dependencies
               FROM plans
               WHERE workspace_id = ? AND status = 'active' AND kanban_column IN (${placeholders})`;
    const params: unknown[] = [workspaceId, ...columns];

    if (effectiveProject !== null && effectiveProject !== undefined) {
        sql += ' AND project = ?';
        params.push(effectiveProject);
    }

    sql += ' ORDER BY kanban_column, updated_at DESC';
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

#### Implementation — `getPlansByColumn`
Replace (line 2200–2214):
```typescript
public async getPlansByColumn(workspaceId: string, column: string): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const statusFilter = column === 'COMPLETED'
        ? `status = 'completed'`
        : `status = 'active'`;
    const stmt = this._db.prepare(
        `SELECT ${PLAN_COLUMNS} FROM plans
         WHERE workspace_id = ? AND ${statusFilter} AND kanban_column = ?
         ORDER BY updated_at DESC`,
        [workspaceId, column]
    );
    return this._readRows(stmt);
}
```
With:
```typescript
public async getPlansByColumn(
    workspaceId: string,
    column: string,
    projectFilter?: string | null
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const statusFilter = column === 'COMPLETED'
        ? `status = 'completed'`
        : `status = 'active'`;
    const effectiveProject = projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER
        ? ''
        : projectFilter;

    let sql = `SELECT ${PLAN_COLUMNS} FROM plans
               WHERE workspace_id = ? AND ${statusFilter} AND kanban_column = ?`;
    const params: unknown[] = [workspaceId, column];

    if (effectiveProject !== null && effectiveProject !== undefined) {
        sql += ' AND project = ?';
        params.push(effectiveProject);
    }

    sql += ' ORDER BY updated_at DESC';
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

#### Edge Cases
- When `projectFilter` is `null` (no filter active), `effectiveProject` is `null`, condition is false — all plans returned. ✓
- When `projectFilter` is `''` directly (unusual but valid), `effectiveProject` is `''`, condition is true — unassigned plans returned. ✓
- When `projectFilter` is `'__unassigned__'`, sentinel is translated to `''` before SQL. ✓
- When `projectFilter` is a project name string, direct equality filter applies. ✓

---

### `src/services/KanbanProvider.ts`

#### Context
Four call sites need updating. `this._projectFilter` (line 141) is the authoritative provider-level filter state.

#### Implementation — `_sendDependencyMapData` (line 2019)
Change the single DB call at line 2026:
```typescript
// Before:
const plans = await db.getPlansWithDependencies(workspaceId);
// After:
const plans = await db.getPlansWithDependencies(workspaceId, ['CREATED', 'PLAN REVIEWED'], this._projectFilter);
```
No other changes to this method.

#### Implementation — `getDependencyMapData` handler (lines 4327–4360)
Two call sites within the `copyPrompt` branch. The prompt-assembly logic (lines 4336–4351) is unchanged — only the DB fetch calls change:
- Line 4335: `db.getPlansWithDependencies(workspaceId)` → `db.getPlansWithDependencies(workspaceId, ['CREATED', 'PLAN REVIEWED'], this._projectFilter)`

> **Edge Case**: When `copyPrompt === false`, the handler calls `this._sendDependencyMapData(workspaceRoot)` which is already updated above. No additional change needed.

#### Implementation — `rebuildDependencyMap` handler (lines 4362–4373)
- Line 4368: `db.getPlansWithDependencies(workspaceId)` → `db.getPlansWithDependencies(workspaceId, ['CREATED', 'PLAN REVIEWED'], this._projectFilter)`

No other changes to this handler.

#### Implementation — `getUATData` handler (lines 6142–6200+)
- Line 6148: `db.getPlansByColumn(workspaceId, 'CODE REVIEWED')` → `db.getPlansByColumn(workspaceId, 'CODE REVIEWED', this._projectFilter)`
- Line 6149: `db.getPlansByColumn(workspaceId, 'ACCEPTANCE TESTED')` → `db.getPlansByColumn(workspaceId, 'ACCEPTANCE TESTED', this._projectFilter)`

No other changes to this handler.

## Verification Plan

### Automated Tests
- No automated test suite changes required (per session directive). 

### Manual Verification
1. Open the Kanban panel.
2. Select a specific project from the workspace/project dropdown.
3. Navigate to the **Dependencies** tab — verify only plans assigned to the selected project are shown.
4. Navigate to the **Test (UAT)** tab — verify only plans in 'CODE REVIEWED' and 'ACCEPTANCE TESTED' columns assigned to the selected project are shown.
5. Use the "Copy prompt for Dependencies" button (copyPrompt path) — verify the prompt lists only plans from the selected project.
6. Use the "Rebuild dependency map" button — verify rebuild operates only on the selected project's plans.
7. Switch to a different project and verify both tabs update.
8. Select "All Projects" (clears filter) and verify all plans are shown again.
9. Select "Unassigned" project filter and verify only plans with an empty project field are shown (sentinel handling test).

## Files Changed
- `src/services/KanbanDatabase.ts` — Add optional `projectFilter` parameter to `getPlansWithDependencies()` and `getPlansByColumn()` with sentinel translation
- `src/services/KanbanProvider.ts` — Pass `this._projectFilter` at 5 call sites: `_sendDependencyMapData()`, `getDependencyMapData` handler (copyPrompt branch, line ~4335), `rebuildDependencyMap` handler (line ~4368), `getUATData` handler (lines ~6148–6149), and `_generateAntigravityPrompt` (line ~2707)

---

## Review Pass — 2026-06-01

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **MAJOR** | `_generateAntigravityPrompt` call site at line 2707 does not pass `this._projectFilter`. When a project filter is active, the antigravity prompt generator fetches plans from ALL projects, sending an agent to work on the wrong project's plans. Same class of bug the plan was created to fix. | `KanbanProvider.ts:2707` |
| 2 | NIT | New DB methods (`getPlansByColumn`, `getPlansWithDependencies`) lack the early-return optimization that `getBoardFilteredByProject` uses (delegating to the simpler `getBoard()` when no filter is active). Functionally equivalent but a style inconsistency. | `KanbanDatabase.ts:2219-2272` |
| 3 | PASS | Sentinel handling (`__unassigned__` → `''`) is correct in both new DB methods, matching the reference pattern in `getBoardFilteredByProject`. | `KanbanDatabase.ts:2230, 2257` |
| 4 | PASS | All four plan-specified call sites correctly pass `this._projectFilter`. | `KanbanProvider.ts:2133, 4399, 4432, 6155-6156` |
| 5 | PASS | Prompt-assembly logic in `copyPrompt` branch preserved verbatim; only DB call arguments changed. | `KanbanProvider.ts:4400-4414` |
| 6 | PASS | Backward compatibility maintained — optional parameters, existing unfiltered callers still work. | `KanbanDatabase.ts`, `KanbanProvider.ts` |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| 1. `_generateAntigravityPrompt` unfiltered | **Fix now** | Pass `this._projectFilter` at line 2707 — same class of bug, trivial fix, low risk |
| 2. No early-return optimization | Defer | Functionally correct; style-only concern |

### Stage 3: Code Fixes Applied

- **`KanbanProvider.ts` line 2707**: Changed `db.getPlansByColumn(workspaceId, column)` → `db.getPlansByColumn(workspaceId, column, this._projectFilter)`

### Stage 4: Verification Results

- **Typecheck**: `npx tsc --noEmit` — 5 pre-existing errors in unrelated files (`extension.ts`, `ClickUpSyncService.ts`, `KanbanProvider.ts:4726`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`). Zero errors in plan-touched code. All changes compile cleanly.
- **Tests**: Skipped per session directive.

### Remaining Risks

1. **`repoScope` filtering gap** (acknowledged in User Review Required): Dependencies, UAT, and antigravity prompt paths still do not filter by `repoScope`. Only `project` filtering is applied. If a repo filter is active alongside a project filter, plans from other repos within the same project will still appear.
2. **`_generateAntigravityPrompt` now filtered by project but not by `repoScope`**: Same repoScope gap as above, now applies to this call site too.

---

**Status: Review Complete — Implementation verified, one MAJOR finding fixed**
