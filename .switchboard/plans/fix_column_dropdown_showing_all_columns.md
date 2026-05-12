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
