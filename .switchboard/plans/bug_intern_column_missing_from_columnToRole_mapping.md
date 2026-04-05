# Bug: Intern Column Missing from _columnToRole Mapping

## Goal
Fix the missing 'INTERN CODED' case in the `_columnToRole` function in `KanbanProvider.ts`, which prevents intern-routed plans from being properly dispatched via CLI triggers, MCP move commands, and drag-drop operations.

## Metadata
**Tags:** bugfix, routing
**Complexity:** 2

## Problem

When pressing 'advance all' in the PLAN REVIEWED column (or using other dispatch mechanisms), plans that should route to the intern terminal (complexity 1-4) fail to dispatch correctly. The root cause is that the `_columnToRole` function in `KanbanProvider.ts` is missing a case for 'INTERN CODED', causing it to return `null` when attempting to map the column to a role.

### Affected Scenarios

1. **MCP Move Commands**: The `_buildMcpTargetAliases` function uses `_columnToRole` to register column targets. Since 'INTERN CODED' returns `null`, MCP commands like `mcpMoveKanbanCard` targeting the intern column fail.

2. **Drag-Drop Dispatch**: When users drag-drop a card to the INTERN CODED column, the `triggerAction` message handler calls `_columnToRole` to determine the dispatch role. A `null` return causes the dispatch to be skipped.

3. **Batch Action Triggers**: The `triggerBatchAction` handler uses `_columnToRole` to map the target column to a role for batch dispatch. Missing 'INTERN CODED' prevents batch operations to the intern column.

4. **Move Operations**: The `moveSelected` handler (for non-PLAN REVIEWED columns) uses `_columnToRole` to trigger CLI dispatch when moving cards. If the target is INTERN CODED, dispatch fails.

## Root Cause

In `src/services/KanbanProvider.ts`, the `_columnToRole` function (lines 2339-2349) is missing a case for 'INTERN CODED':

```typescript
private _columnToRole(column: string): string | null {
    switch (column) {
        case 'PLAN REVIEWED': return 'planner';
        case 'LEAD CODED': return 'lead';
        case 'CODER CODED': return 'coder';
        case 'CODED': return 'lead';
        case 'CODE REVIEWED': return 'reviewer';
        case 'COMPLETED': return null;
        default: return column.startsWith('custom_agent_') ? column : null;
    }
}
```

This function is used in multiple critical paths:
- Line 1227: Building MCP target aliases
- Line 1433: Drag-drop dispatch
- Line 1468: Batch action triggers  
- Line 1794, 1860: Move selected operations

### Contrast with Other Functions

Other similar functions in the codebase DO include 'INTERN CODED':
- `_recordDispatchIdentity` (line 415): Has 'INTERN CODED': 'intern' mapping
- `_targetColumnForDispatchRole` (line 1524): Returns 'INTERN CODED' for intern role
- `_roleForKanbanColumn` in TaskViewerProvider.ts (line 774): Has case for 'INTERN CODED'
- `_codedColumnForDispatchRoles` in TaskViewerProvider.ts (line 740): Returns 'INTERN CODED' for intern role

This inconsistency suggests `_columnToRole` was overlooked when the intern column was added.

## Solution

Add the missing 'INTERN CODED' case to the `_columnToRole` function in `src/services/KanbanProvider.ts`.

### Proposed Changes

#### [MODIFY] `src/services/KanbanProvider.ts`

**Context**: The `_columnToRole` function is missing a case for 'INTERN CODED', causing it to return `null` when mapping the intern column to a role. This breaks dispatch mechanisms that rely on this mapping.

**Logic**: Add a case for 'INTERN CODED' that returns 'intern', consistent with other column-to-role mappings in the codebase.

**Implementation**:

Search (lines 2339-2349 of `src/services/KanbanProvider.ts`):
```typescript
private _columnToRole(column: string): string | null {
    switch (column) {
        case 'PLAN REVIEWED': return 'planner';
        case 'LEAD CODED': return 'lead';
        case 'CODER CODED': return 'coder';
        case 'CODED': return 'lead';
        case 'CODE REVIEWED': return 'reviewer';
        case 'COMPLETED': return null;
        default: return column.startsWith('custom_agent_') ? column : null;
    }
}
```

Replace:
```typescript
private _columnToRole(column: string): string | null {
    switch (column) {
        case 'PLAN REVIEWED': return 'planner';
        case 'LEAD CODED': return 'lead';
        case 'CODER CODED': return 'coder';
        case 'INTERN CODED': return 'intern';
        case 'CODED': return 'lead';
        case 'CODE REVIEWED': return 'reviewer';
        case 'COMPLETED': return null;
        default: return column.startsWith('custom_agent_') ? column : null;
    }
}
```

## Files to Modify

- `src/services/KanbanProvider.ts` — Add 'INTERN CODED' case to `_columnToRole` function (lines 2339-2349)

## Verification Plan

### Automated Tests

Add a test case to `src/test/kanban-complexity.test.ts` to verify that `_columnToRole` correctly maps 'INTERN CODED' to 'intern':

```typescript
test('_columnToRole maps INTERN CODED to intern', () => {
    const kanbanProvider = // ... create instance ...
    assert.strictEqual(kanbanProvider['_columnToRole']('INTERN CODED'), 'intern');
});
```

### Manual Verification

1. **MCP Move Test**: Use MCP to move a plan to the intern column:
   - Create a test plan with complexity 3 (should route to intern)
   - Use MCP command to move the plan to INTERN CODED
   - Verify the plan moves successfully and dispatches to intern terminal

2. **Drag-Drop Test**: Drag a low-complexity plan to the INTERN CODED column:
   - Verify the card moves to INTERN CODED
   - Verify CLI dispatch triggers to the intern terminal

3. **Advance All Test**: Press 'advance all' in PLAN REVIEWED column with a low-complexity plan:
   - Verify the plan routes to INTERN CODED
   - Verify the intern terminal receives the dispatch

4. **Batch Action Test**: Select multiple cards and batch move to INTERN CODED:
   - Verify all cards move to INTERN CODED
   - Verify batch dispatch triggers to intern terminal

## Impact

- Fixes intern column routing for all dispatch mechanisms (MCP, drag-drop, batch, move operations)
- No breaking changes to existing functionality
- Minimal change: single line added to switch statement
- Aligns `_columnToRole` with other similar mapping functions in the codebase

## Additional Notes

### User's Original Report Context

The user reported that pressing 'advance all' in the PLANNED column with coder columns collapsed did not route a low-priority plan (complexity 3) to the intern terminal. 

However, the current implementation does not apply complexity routing when moving FROM PLANNED — complexity routing only applies when moving FROM PLAN REVIEWED. The 'advance all' in PLANNED moves all cards to PLAN REVIEWED and dispatches to the planner role, which is the expected behavior for that column.

The missing 'INTERN CODED' case would affect the subsequent step when the user presses 'advance all' in PLAN REVIEWED, or when using other dispatch mechanisms targeting the intern column.
