# Fix: Prompt Generation Uses Source Column Role Instead of Destination Column

## Goal
Fix the `_generatePromptForColumn()` method in `KanbanProvider.ts` so that "Copy prompt and advance" on built-in columns generates prompts for the destination column's agent role instead of the source column's role.

## Metadata
- **Tags:** bugfix, backend, workflow
- **Complexity:** 4

## User Review Required
Optional — manual verification of generated prompt content is recommended after deployment.

## Complexity Audit

### Routine
- Single-file change (`src/services/KanbanProvider.ts`, lines 2339–2384)
- No new dependencies or architectural patterns
- Reuses existing `_generatePromptForDestinationRole()` helper

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None — prompt generation is synchronous and stateless.
- **Security:** None — no new attack surface or permission changes.
- **Side Effects:** Changes prompt text for built-in column advancement paths (`LEAD CODED` → `CODE REVIEWED`, `CODE REVIEWED` → `ACCEPTANCE TESTED`, etc.). This is the intended bug fix. Drag-drop paths are unaffected because `promptOnDrop` does not pass `destinationColumn`.
- **Dependencies & Conflicts:** None — self-contained change with no external dependencies.

## Dependencies
- None — this fix is self-contained.

## Adversarial Synthesis
Key risks: custom-user columns without an explicit role may receive generic execution prompts instead of source-column prompts when advanced via `promptSelected`/`promptAll` (minor edge case; custom columns typically have roles). The `kind` switch fallback assumes column-kind-to-role mapping that could drift if built-in columns change. Mitigations: add unit test coverage for role resolution and verify the existing `PLAN REVIEWED` null-role special case remains intact.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** `_generatePromptForColumn()` receives a `destinationColumn` parameter for "prompt and advance" operations, but only uses it for custom columns (lines 2342–2348). For built-in columns, it falls through to source-column role resolution (lines 2350–2384), causing incorrect prompt generation when advancing from `LEAD CODED` to `CODE REVIEWED` (generates a lead execution prompt instead of a reviewer review prompt).
- **Logic:** Use `destinationColumn || column` for role resolution. Derive `sourceColumnLabel` from the original source `column` for display context in execution prompts. Remove the redundant custom-column early-return since the unified logic handles all columns correctly.
- **Implementation:** Modify lines 2339–2384 in `_generatePromptForColumn()`. See the existing "## Fix" section below for the complete code diff.
- **Edge Cases:**
  - No `destinationColumn` provided: falls back to source column behavior (preserves drag-drop `promptOnDrop` and copy-only paths).
  - `PLAN REVIEWED`: special-cased with `role = null` for complexity routing; preserved in the fix.
  - Custom columns: handled correctly by the unified role resolution.
  - `COMPLETED` destination: `columnToPromptRole('COMPLETED')` returns `null` → generic execution prompt. Acceptable since COMPLETED has no active agent.

## Verification Plan

### Automated Tests
- Add unit tests for `_generatePromptForColumn()` covering:
  - Destination column role resolution for built-in columns (`LEAD CODED` → `CODE REVIEWED` → reviewer prompt)
  - Source column fallback when `destinationColumn` is undefined
  - `PLAN REVIEWED` complexity routing (role = null)
  - Custom column with explicit role

### Manual Verification
(See the existing "## Testing" section below for detailed manual verification steps.)

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

## Recommendation
Send to Coder.
