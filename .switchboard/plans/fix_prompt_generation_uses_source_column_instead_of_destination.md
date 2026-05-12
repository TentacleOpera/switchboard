# Fix: Prompt Generation Uses Source Column Role Instead of Destination Column

## Bug Description
When using the **"Copy prompt and advance"** button (`promptSelected` / `promptAll`) on plans in a coded column (e.g., `LEAD CODED`), the generated prompt is an **execution prompt** (e.g., lead coder) instead of a **reviewer prompt**, even though the plan advances to `CODE REVIEWED`.

The prompt text incorrectly says:
- *"Please execute the following N plans from the Lead Coder column"*
- *"AUTHORIZATION TO EXECUTE: ..."*

It should say:
- *"Please review the following N plans"*
- Stage 1 (Grumpy) / Stage 2 (Balanced) review directives

## Root Cause
In `KanbanProvider.ts`, `_generatePromptForColumn()` receives a `destinationColumn` parameter for "prompt and advance" operations, but **only uses it for custom columns** (lines 2294-2300). For built-in columns, it falls through to lines 2302-2337 which determine the prompt role from the **source column's `role` field** (line 2309).

When advancing from `LEAD CODED` (role: `lead`) to `CODE REVIEWED` (role: `reviewer`):
1. `nextCol = "CODE REVIEWED"`
2. `_generatePromptForColumn(cards, "LEAD CODED", workspaceRoot, "CODE REVIEWED")`
3. Built-in destination check is skipped (not a custom column)
4. `columnDef` is looked up for `"LEAD CODED"` → `role = "lead"`
5. Prompt is generated as a **lead execution prompt** instead of a **reviewer review prompt**

## Affected Code

### `src/services/KanbanProvider.ts`
**Lines 2281-2337** — `_generatePromptForColumn()` method:

```typescript
private async _generatePromptForColumn(
    cards: KanbanCard[],
    column: string,
    workspaceRoot: string,
    destinationColumn?: string
): Promise<string> {
    ...
    // BUG: Only custom columns use destinationColumn for role resolution
    if (destinationColumn) {
        const destCol = allColumns.find(c => c.id === destinationColumn);
        if (destCol && (destCol.source === 'custom-user' || destCol.source === 'custom-agent') && destCol.role) {
            return this._generatePromptForDestinationRole(cards, destCol.role, workspaceRoot);
        }
    }

    const columnDef = allColumns.find(c => c.id === column);
    ...
    // BUG: Uses source column's role, ignoring destinationColumn for built-in columns
    if (columnDef?.role && column !== 'PLAN REVIEWED') {
        role = columnDef.role;
    }
    ...
}
```

**Lines 4385-4402** — `promptSelected` handler (calls `_generatePromptForColumn` correctly with `nextCol`):

```typescript
case 'promptSelected': {
    ...
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    // Passes destinationColumn correctly, but _generatePromptForColumn ignores it for built-ins
    const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
    ...
}
```

**Lines 4480-4494** — `promptAll` handler (same issue):

```typescript
case 'promptAll': {
    ...
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
    ...
}
```

## Fix

Modify `_generatePromptForColumn()` to use the **destination column** for role resolution when `destinationColumn` is provided, regardless of whether it's a custom or built-in column. Keep `sourceColumnLabel` from the source column for display context.

### Changed Logic

```typescript
private async _generatePromptForColumn(
    cards: KanbanCard[],
    column: string,
    workspaceRoot: string,
    destinationColumn?: string
): Promise<string> {
    const [customAgents, customKanbanColumns] = await Promise.all([
        this._getCustomAgents(workspaceRoot),
        this._getCustomKanbanColumns(workspaceRoot)
    ]);
    const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);

    // When advancing to a destination column, the prompt should be for the
    // DESTINATION agent who receives the plans, not the source column agent.
    const roleSourceColumn = destinationColumn || column;
    const roleSourceDef = allColumns.find(c => c.id === roleSourceColumn);

    // sourceColumnLabel is kept from the ORIGINAL source column for context
    const sourceColumnDef = allColumns.find(c => c.id === column);
    const sourceColumnLabel = sourceColumnDef?.label || column;

    let role: string | null = null;
    if (roleSourceDef?.role && roleSourceColumn !== 'PLAN REVIEWED') {
        role = roleSourceDef.role;
    }

    if (!role && roleSourceDef) {
        switch (roleSourceDef.kind) {
            case 'created': role = 'planner'; break;
            case 'coded': role = 'reviewer'; break;
            case 'reviewed': role = 'tester'; break;
            case 'review': role = null; break;
            case 'custom-user': role = null; break;
            case 'custom-agent': role = null; break;
            case 'gather': role = null; break;
            case 'completed': role = null; break;
        }
    }

    if (!role) {
        role = columnToPromptRole(roleSourceColumn);
    }

    if (roleSourceColumn === 'PLAN REVIEWED') {
        role = null;
    }

    return this._generatePromptForDestinationRole(cards, role, workspaceRoot, sourceColumnLabel);
}
```

### Key Changes
1. **Role resolution column**: Use `destinationColumn || column` instead of always using `column`
2. **Keep sourceColumnLabel**: Still derived from the original `column` for display context in execution prompts
3. **Remove redundant custom column early-return**: The unified logic now handles custom columns correctly (while preserving backward compatibility if kept)

## Verification Matrix

| Source Column | Destination Column | Current Prompt (Bug) | Expected Prompt (Fix) |
|---------------|-------------------|----------------------|----------------------|
| `LEAD CODED` | `CODE REVIEWED` | Lead execution | Reviewer review |
| `CODER CODED` | `CODE REVIEWED` | Coder execution | Reviewer review |
| `INTERN CODED` | `CODE REVIEWED` | Intern execution | Reviewer review |
| `CODE REVIEWED` | `ACCEPTANCE TESTED` | Reviewer review | Tester acceptance test |
| `PLAN REVIEWED` | `LEAD CODED` | Complexity-routed execution | Complexity-routed execution (unchanged) |
| `CREATED` | `PLAN REVIEWED` | Planner prompt | Planner prompt (unchanged) |

## Edge Cases

1. **No destinationColumn provided**: Falls back to source column behavior (preserves drag-drop and copy-only prompt paths)
2. **Destination is COMPLETED**: `columnToPromptRole('COMPLETED')` returns `null` → falls through to `_generateBatchExecutionPrompt` with `overrideRole = undefined` → generates generic execution prompt. This is acceptable since COMPLETED has no active agent.
3. **Custom columns**: Already handled correctly; the fix extends the same logic to built-in columns.
4. **PLAN REVIEWED**: Special-cased with `role = null` for complexity routing; the fix preserves this.

## Files to Change

- `src/services/KanbanProvider.ts` — lines 2281-2337

## Testing

### Manual Verification
1. Create a plan and move it to `LEAD CODED`
2. Click **"Copy prompt and advance"** (promptSelected button)
3. Verify the copied prompt contains reviewer directives (Stage 1 Grumpy, Stage 2 Balanced)
4. Verify the plan advanced to `CODE REVIEWED`
5. Repeat from `CODE REVIEWED` → verify tester prompt is generated

### Regression Checks
- `CREATED` → `PLAN REVIEWED`: Should still generate planner prompt
- `PLAN REVIEWED` → `LEAD CODED`/`CODER CODED`: Should still use complexity routing
- Custom column advancement: Should still use custom column's configured role
