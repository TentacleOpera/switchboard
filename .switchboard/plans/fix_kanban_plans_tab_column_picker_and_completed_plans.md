# Fix Kanban Plans Tab Column Picker and Completed Plans Issues

## Goal

Fix two bugs in the planning.html kanban plans tab:
1. The column picker does not include a "BACKLOG" option, even though BACKLOG is a valid column in the kanban system
2. When filtering by "COMPLETED" column, no plans show up even though there are 100+ completed plans in the kanban

## Background

The kanban plans tab in planning.html has a column filter dropdown that allows users to filter plans by kanban column. Currently, this filter has two issues:

### Issue 1: Missing BACKLOG Column Option

BACKLOG is implemented as a view toggle on the kanban board, not as a standard column definition. When users toggle "Show Backlog" on the kanban board:
- The CREATED column header changes to "BACKLOG"
- BACKLOG cards are remapped to display in the CREATED column slot
- CREATED cards are hidden
- Dropping to CREATED while in backlog view actually moves cards to BACKLOG

However, the planning sidebar's column picker only shows standard columns from `DEFAULT_KANBAN_COLUMNS` (in `src/services/agentConfig.ts`) plus custom columns from `state.json`. Since BACKLOG is a view state rather than a column definition, it doesn't appear in the picker.

### Issue 2: Completed Plans Not Showing

The planning sidebar fetches plans via `db.getBoard()` in `PlanningPanelProvider._getKanbanPlans()`, which only returns active plans (status = 'active'). The kanban board separately calls `db.getCompletedPlans()` to get completed plans (status = 'completed'). The sidebar never calls this method, so completed plans are never included in the results sent to the webview.

## Root Cause Analysis

### Issue 1 Root Cause
- `PlanningPanelProvider._getKanbanColumnDefinitions()` builds column definitions by calling `buildKanbanColumns(customAgents, customKanbanColumns)`
- `buildKanbanColumns()` in `agentConfig.ts` only includes columns from `DEFAULT_KANBAN_COLUMNS` and custom columns
- BACKLOG is not in `DEFAULT_KANBAN_COLUMNS` because it's implemented as a view state, not a column
- The column picker in planning.js is populated from these column definitions via `updateKanbanColumnFilter()`

### Issue 2 Root Cause
- `PlanningPanelProvider._getKanbanPlans()` calls `db.getBoard(workspaceId)` which only returns active plans
- The kanban board's `_refreshBoardImpl()` calls both `db.getBoard()` and `db.getCompletedPlans()` to get all plans
- The planning sidebar has no equivalent call to `db.getCompletedPlans()`
- Plans with status='completed' are never added to the `allPlans` array sent to the webview

## Metadata

**Tags:** bugfix, ui, backend, database
**Complexity:** 3

## User Review Required

No — the scope is two confirmed bugs with a corrected implementation path and no product scope expansion.

## Complexity Audit

### Routine
- Fetching completed plans via existing `getCompletedPlans()` API (`src/services/KanbanDatabase.ts:2181`)
- Merging two individually-sorted arrays and re-sorting by `updated_at DESC`
- Injecting a single column definition into a sidebar-only context

### Complex / Risky
- **CRITICAL:** The original approach of adding BACKLOG to `DEFAULT_KANBAN_COLUMNS` would leak into the main kanban board and break the `showingBacklog` view toggle by rendering a phantom BACKLOG column. The corrected approach isolates the injection to `PlanningPanelProvider._getKanbanColumnDefinitions()` only.

## Edge-Case & Dependency Audit

### Race Conditions
- None: sidebar data fetch is read-only.

### Security
- None: no new input surfaces or external calls.

### Side Effects
- Fetching up to 100 additional completed plans per workspace increases the JSON payload size to the webview. The default limit of 100 matches the main kanban board's `completedLimit` configuration (`src/services/KanbanProvider.ts:1764`).
- `_getKanbanPlans()` is called once per workspace root; the existing `seenIds` deduplication in the caller (`_handleMessage` at `src/services/PlanningPanelProvider.ts:1634`) prevents cross-root duplicates.

### Dependencies & Conflicts
- None. No new dependencies. No schema changes.

## Dependencies

No external dependencies.

## Adversarial Synthesis

Key risks: (1) Injecting BACKLOG into shared `DEFAULT_KANBAN_COLUMNS` breaks the main kanban board's backlog view toggle by rendering a phantom BACKLOG column; (2) Merging completed plans without resorting breaks the backend's ordering contract. Mitigations: (1) Inject BACKLOG only in `PlanningPanelProvider._getKanbanColumnDefinitions()`; (2) Sort the merged union by `updated_at DESC`; (3) Guard against duplicate BACKLOG definitions with `some()`.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

#### Phase 1: Add BACKLOG to Sidebar Column Definitions (CORRECTED)

**Context:** The original plan proposed adding BACKLOG to `DEFAULT_KANBAN_COLUMNS` in `agentConfig.ts`. This is **rejected** because the main kanban board (`kanban.html`) iterates over `columnDefinitions` to render physical columns. If BACKLOG becomes a real column definition, the board renders an empty BACKLOG column when `showingBacklog=false` and a duplicate when `showingBacklog=true` (since BACKLOG cards are remapped into the CREATED slot). The sidebar must inject BACKLOG independently.

**Logic:** In `_getKanbanColumnDefinitions()` (line ~5144), after calling `buildKanbanColumns()`, append a BACKLOG definition if absent, then re-sort.

**Implementation:**
- Function: `_getKanbanColumnDefinitions()` (line ~5113)
- After line 5144 (`const allColumns = buildKanbanColumns(...)`), add:

```typescript
// Inject BACKLOG as a valid sidebar filter option without affecting the main kanban board
if (!allColumns.some(c => c.id === 'BACKLOG')) {
    allColumns.push({
        id: 'BACKLOG',
        label: 'Backlog',
        order: 5,
        kind: 'created' as const,
        source: 'built-in' as const,
        autobanEnabled: false,
        dragDropMode: 'cli'
    });
    allColumns.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
```

**Edge Cases:**
- If a custom column already has id `'BACKLOG'` (unlikely but possible), `some()` check prevents duplicate.
- The sort preserves the existing order for all other columns.

#### Phase 2: Fetch Completed Plans in Planning Sidebar

**Context:** `_getKanbanPlans()` (line ~5083) currently only calls `db.getBoard()`, which returns `status='active'` plans. The kanban board separately calls `db.getCompletedPlans()` to get completed plans. The sidebar needs the same.

**Logic:** After `db.getBoard()`, call `db.getCompletedPlans(workspaceId, limit)`, merge the arrays, and sort by `updated_at DESC` to maintain the existing ordering contract.

**Implementation:**
- Function: `_getKanbanPlans()` (line ~5083)
- Replace the body after `const records = await db.getBoard(workspaceId);` with:

```typescript
const records = await db.getBoard(workspaceId);
const completedLimit = Math.max(1, Math.min(
    vscode.workspace.getConfiguration('switchboard').get<number>('kanban.completedLimit', 100) ?? 100,
    500
));
const completedRecords = await db.getCompletedPlans(workspaceId, completedLimit);
const allRecords = [...records, ...completedRecords];
allRecords.sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
});

// Resolve to the effective (mapped parent) root so that plan.workspaceRoot
// matches the workspaceItems dropdown values sent to the webview.
const effectiveRoot = this._resolveEffectiveWorkspaceRoot(workspaceRoot);

// Derive the label from _buildKanbanWorkspaceItems() so it uses the
// configured mapping name (not the raw VSCode folder name).
const wsLabel = this._buildKanbanWorkspaceItems().find(
    item => item.workspaceRoot === effectiveRoot
)?.label || path.basename(effectiveRoot);

return allRecords.map((r: any) => ({
    planId: r.planId,
    sessionId: r.sessionId || '',
    topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
    column: r.kanbanColumn,
    workspaceRoot: effectiveRoot,
    workspaceLabel: wsLabel,
    project: r.project || '',
    repoScope: r.repoScope || '',
    mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
    planFile: r.planFile || '',
    complexity: r.complexity || 'Unknown'
}));
```

**Edge Cases:**
- Active (`status='active'`) and completed (`status='completed'`) statuses are mutually exclusive in the DB schema, so no duplicate `planId`s in the union.
- `getCompletedPlans` returns `kanban_column='COMPLETED'` (verified by DB migration V3 at `src/services/KanbanDatabase.ts:3865`), which matches the existing COMPLETED column definition.
- The sort is stable: both `getBoard` and `getCompletedPlans` return individually-sorted results; the merge sort produces a globally-sorted list by `updated_at DESC`.

#### Phase 3: Update Column Filter Logic

**File:** `src/webview/planning.js`

No changes needed. The existing column filter logic in `renderKanbanPlans()` (line ~4004) already filters by `plan.column`, so once BACKLOG and COMPLETED plans are in the data, the filter works correctly.

## Verification Plan

### Automated Tests
- **SKIP COMPILATION** per session directive.
- **SKIP AUTOMATED TESTS** per session directive; user will run test suite separately.

### Manual Verification Steps
1. Open planning sidebar → Kanban Plans tab.
2. Check column picker dropdown includes "Backlog".
3. Select "Backlog" filter → verify BACKLOG plans appear.
4. Select "Completed" filter → verify completed plans appear.
5. Verify other column filters (e.g., "New", "Lead Coder") still work.
6. Open main kanban board → toggle backlog view → verify NO phantom BACKLOG column renders, and the existing CREATED→BACKLOG remapping still works.

## Files Changed

- `src/services/PlanningPanelProvider.ts` — Inject BACKLOG in `_getKanbanColumnDefinitions()` (line ~5144); fetch completed plans in `_getKanbanPlans()` (line ~5083)
- `src/services/agentConfig.ts` — **NO CHANGE** (original plan's edit here is rejected to avoid breaking main kanban board)
- `src/webview/planning.js` — **NO CHANGE**

## Review Findings

**Files changed:** `src/services/PlanningPanelProvider.ts` (committed in `87043caa`).
**Validation:** Implementation matches plan exactly; no type or runtime defects found.
**Remaining risks:** `r: any` in the `.map()` is pre-existing debt; `completedLimit` clamping duplicates KanbanProvider logic but is harmless.
