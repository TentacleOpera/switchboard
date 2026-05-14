# Fix: Column dropdown in plan ticket view shows all columns including unused ones

## Goal
Filter the Column dropdown in the plan ticket review panel and its `setColumn` validation to only show columns whose associated built-in agents are currently visible in the workspace.

## Metadata
- **Tags:** UI, bugfix
- **Complexity:** 3

## User Review Required
No. This is a pure bugfix with no product behavior change beyond hiding incorrectly shown columns.

## Complexity Audit
### Routine
- Single-file change in `TaskViewerProvider.ts`.
- Reuses existing `getVisibleAgents()` and `_buildSetupKanbanStructure` filtering pattern.
- No new dependencies or API changes.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** `getVisibleAgents` reads from the workspace state file on disk. If the file changes between fetching the dropdown list and validating the `setColumn` request, the validation could reject a column that was just visible. Probability is low; mitigation is to re-open the ticket.
- **Security:** No security impact. The validation in `updateReviewTicket` is a consistency guard, not an authorization boundary.
- **Side Effects:** If a plan is already in a hidden column, the review panel already handles this by appending the current value as an extra option (see `review.html:779-785`). The plan remains viewable and movable to a visible column.
- **Dependencies & Conflicts:** None. Does not touch KanbanProvider or the board view.

## Dependencies
None.

## Adversarial Synthesis
Key risks: the `setColumn` branch string-matching regression test will break when the code shape changes, and the duplicated filter logic could diverge from `_buildSetupKanbanStructure` in the future. Mitigations: update `src/test/review-ticket-column-persistence-regression.test.js` to match the new filtered code, and extract a shared `_filterVisibleColumns` helper to eliminate the sync tax.

## Proposed Changes
### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

#### Step 1: Extract a shared private helper `_filterVisibleColumns`

Add a new private method (e.g., near `_buildSetupKanbanStructure` at line 1361):

```typescript
private _filterVisibleColumns(
    columns: KanbanColumnDefinition[],
    visibleAgents: Record<string, boolean>
): KanbanColumnDefinition[] {
    return columns.filter(column => {
        const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
        if (fixed) return true;
        if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
            return false;
        }
        return true;
    });
}
```

Then refactor `_buildSetupKanbanStructure` to use it:

```typescript
private _buildSetupKanbanStructure(
    customAgents: CustomAgentConfig[],
    customKanbanColumns: CustomKanbanColumnConfig[],
    visibleAgents: Record<string, boolean>
): SetupKanbanStructureItem[] {
    const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
    const visibleColumns = this._filterVisibleColumns(allColumns, visibleAgents);
    return visibleColumns.map((column) => {
        const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
        const visible = fixed
            ? true
            : column.source === 'built-in'
                ? (!column.role || visibleAgents[column.role] !== false)
                : true;
        return {
            id: column.id,
            label: column.label,
            role: column.role,
            kind: column.kind,
            source: column.source,
            fixed,
            reorderable: !fixed,
            visible,
            order: column.order,
            assignedAgent: column.role,
            triggerPrompt: column.triggerPrompt,
            dragDropMode: column.dragDropMode,
            editable: column.source === 'custom-user',
            deletable: !fixed
        };
    });
}
```

#### Step 2: Filter columns by agent visibility in `getReviewTicketData`

In `getReviewTicketData()` (~line 11633), change:

```typescript
const customAgents = await this.getCustomAgents(workspaceRoot);
const customKanbanColumns = await this._getCustomKanbanColumns(workspaceRoot);
const columns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns).map(column => ({ id: column.id, label: column.label }));
```

To:

```typescript
const [customAgents, customKanbanColumns, visibleAgents] = await Promise.all([
    this.getCustomAgents(workspaceRoot),
    this._getCustomKanbanColumns(workspaceRoot),
    this.getVisibleAgents(workspaceRoot)
]);
const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
const columns = this._filterVisibleColumns(allColumns, visibleAgents)
    .map(column => ({ id: column.id, label: column.label }));
```

#### Step 3: Filter column validation in `updateReviewTicket` (`setColumn`)

In `updateReviewTicket()` `setColumn` case (~line 11829), change:

```typescript
const [customAgents, customKanbanColumns] = await Promise.all([
    this.getCustomAgents(workspaceRoot),
    this._getCustomKanbanColumns(workspaceRoot)
]);
const columns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns).map(entry => entry.id);
```

To:

```typescript
const [customAgents, customKanbanColumns, visibleAgents] = await Promise.all([
    this.getCustomAgents(workspaceRoot),
    this._getCustomKanbanColumns(workspaceRoot),
    this.getVisibleAgents(workspaceRoot)
]);
const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
const columns = this._filterVisibleColumns(allColumns, visibleAgents)
    .map(entry => entry.id);
```

### Step 4: Update the regression test

#### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/test/review-ticket-column-persistence-regression.test.js`

The existing test does string-level assertions on the `setColumn` branch. Update it to match the new code shape (e.g., assert that `visibleAgents` is fetched and `_filterVisibleColumns` is called).

## Verification Plan
### Automated Tests
- [ ] Update `src/test/review-ticket-column-persistence-regression.test.js` because its string assertions match the current unfiltered code exactly.
- [ ] Add a test asserting that `_filterVisibleColumns` excludes built-in columns whose `role` is disabled in `visibleAgents` while keeping fixed columns (`CREATED`, `COMPLETED`) and custom columns.

### Manual Verification
1. Open the Switchboard extension in a workspace where the Acceptance Tester (or any other `hideWhenNoAgent` agent) is **disabled**.
2. Open a plan ticket in the review panel.
3. Click the **Column** dropdown.
4. **Expected:** "Acceptance Tested" (or the disabled agent's column) is **not present**.
5. Enable the agent in Switchboard Setup.
6. Re-open the dropdown.
7. **Expected:** The column **now appears**.

## Risks & Edge Cases
- **Plans currently in a hidden column:** If a plan is already in a column that becomes hidden, the review panel's `renderColumns()` already handles this by appending the current value as an extra option (see `review.html:779-785`). The plan remains viewable and movable to a visible column.
- **Custom user columns:** These are always shown (they are not built-in and have no role-based gating), which is correct.
- **Custom agent columns:** These are already filtered by `includeInKanban` during `_buildKanbanColumnsForWorkspace`; no extra visibility logic needed.
- **Regression test fragility:** `src/test/review-ticket-column-persistence-regression.test.js` relies on string matching of the `setColumn` branch. It will fail after this change and must be updated before merge.

**Recommendation:** Send to Coder.

## Reviewer Pass

**Date reviewed:** 2026-05-14

### Stage 1 — Grumpy Adversarial Findings

*[Clears throat, adjusts glasses, leans into microphone]*

**CRITICAL:** None. The implementation is functionally correct. I'm as surprised as you are.

**MAJOR:** None. The core filtering logic is sound, the integration points are correct, and the edge cases are handled.

**NITs:**
- **Missing `_filterVisibleColumns` unit test (NIT):** The Verification Plan explicitly called for "Add a test asserting that `_filterVisibleColumns` excludes built-in columns whose `role` is disabled in `visibleAgents` while keeping fixed columns (`CREATED`, `COMPLETED`) and custom columns." This was not delivered. The regression test was updated, but no dedicated test for the new helper existed. When you add a helper, you test the helper. This is not optional — it's hygiene.
- **Redundant `visible` computation in `_buildSetupKanbanStructure` (NIT):** After `_filterVisibleColumns` has already evicted hidden built-in columns, the `visible` property computed at lines 1348-1352 is dead logic — it will always be `true` for every remaining item. Callers filtering by `item.visible !== false` still work, but the semantic intent is now misleading. Either the filtering belongs elsewhere, or the `visible` computation should be removed. Not a bug, but a wart.

### Stage 2 — Balanced Synthesis

**What to keep:**
- The `_filterVisibleColumns` helper design is clean, focused, and reusable.
- Integration in `getReviewTicketData` and `updateReviewTicket` is correct and consistent.
- The regression test update accurately reflects the new code shape.
- The `renderColumns` edge-case fallback (lines 779-785 in `review.html`) correctly preserves plans already in hidden columns.
- TypeScript compilation is clean for modified files.

**What to fix now:**
- Add the missing `_filterVisibleColumns` unit test. This is small, high-value, and closes the verification gap.

**What can defer:**
- Removing the redundant `visible` computation in `_buildSetupKanbanStructure`. It is harmless dead code with no functional impact.

### Fixes Applied

| # | File | Change |
|---|------|--------|
| 1 | `src/test/column-dropdown-filter-visible-columns.test.js:1-127` | Added dedicated unit/regression test for `_filterVisibleColumns`. Tests source-code structure (signature, fixed-column handling, built-in filtering, custom-column preservation) and behavioral outcomes across three visibility scenarios (all visible, one hidden, all built-in hidden). |

### Validation

- **Regression test (`node src/test/review-ticket-column-persistence-regression.test.js`):** Passed.
- **New unit test (`node src/test/column-dropdown-filter-visible-columns.test.js`):** Passed.
- **TypeScript compilation (`npx tsc --noEmit`):** No new errors in modified files.

### Remaining Risks

- None beyond those already documented in the plan (e.g., race condition between fetching dropdown list and validating `setColumn`).
- The redundant `visible` computation in `_buildSetupKanbanStructure` may confuse future maintainers but has no runtime effect.

---

## Execution Results

**Date executed:** 2026-05-14

### Changes Applied

| # | File | Change |
|---|------|--------|
| 1 | `src/services/TaskViewerProvider.ts:1322-1334` | Added `_filterVisibleColumns` private helper that filters out built-in columns whose associated agent role is disabled in `visibleAgents`, while always keeping fixed columns (`CREATED`, `COMPLETED`) and custom columns. |
| 2 | `src/services/TaskViewerProvider.ts:1336-` | Refactored `_buildSetupKanbanStructure` to use `_filterVisibleColumns`, eliminating the duplicated inline filter logic. |
| 3 | `src/services/TaskViewerProvider.ts:11670-11677` | `getReviewTicketData` now fetches `visibleAgents` alongside `customAgents` and `customKanbanColumns`, and uses `_filterVisibleColumns` before mapping to the dropdown `{id, label}` objects. |
| 4 | `src/services/TaskViewerProvider.ts:11871-11878` | `updateReviewTicket` `setColumn` validation now fetches `visibleAgents` and uses `_filterVisibleColumns` before checking if the requested column is valid. |
| 5 | `src/test/review-ticket-column-persistence-regression.test.js:19-25` | Updated string assertions to match the new filtered code shape (`visibleAgents` fetched, `_filterVisibleColumns` called). |
| 6 | `src/services/TaskViewerProvider.ts:15-27` | Added `KanbanColumnDefinition` import from `./agentConfig`. |

### Validation

- **TypeScript compilation (`npx tsc --noEmit`):** No new errors in modified files. Pre-existing module-resolution warnings in `ClickUpSyncService.ts:2309` and `KanbanProvider.ts:3991` are unrelated.
- **Regression test (`node src/test/review-ticket-column-persistence-regression.test.js`):** Passed.

### Remaining Risks

- None beyond those already documented in the plan (e.g., race condition between fetching dropdown list and validating `setColumn`).
