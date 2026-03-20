# dynamic routing is not respecting complexity

## Goal
- When i used the copy prompt buttons, it is routing prompts from the planned column to the coder column, even if they are high complexity. please check ALL routing rules to ensure they are going to the corect columns based on complexity. 

## Root Cause Analysis

The bug is in **prompt generation paths** that use `columnToPromptRole()` for PLAN REVIEWED without complexity awareness:

1. **`columnToPromptRole()` in agentPromptBuilder.ts:160** - Hardcodes `'lead'` for PLAN REVIEWED, ignoring complexity
2. **`_generatePromptForColumn()` in KanbanProvider.ts:431-437** - Blindly uses `columnToPromptRole()` for all columns
3. **TaskViewerProvider.ts:5615** - Copy prompt button uses `columnToPromptRole()` directly without complexity check

The `moveSelected` and `moveAll` actions work correctly because they use `_partitionByComplexityRoute()` (KanbanProvider.ts:1144, 1195), but the prompt generation paths do not.

## Proposed Changes

### 1. Fix `_generatePromptForColumn()` in KanbanProvider.ts
**Location:** `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts:431-437`

Add complexity-aware branching for PLAN REVIEWED before calling `columnToPromptRole()`:

```typescript
private _generatePromptForColumn(cards: KanbanCard[], column: string, workspaceRoot: string): string {
    // PLAN REVIEWED requires complexity-based role selection
    if (column === 'PLAN REVIEWED') {
        return this._generateBatchExecutionPrompt(cards, workspaceRoot);
    }
    
    const role = columnToPromptRole(column);
    if (role === 'planner') {
        return this._generateBatchPlannerPrompt(cards, workspaceRoot);
    }
    return this._generateBatchExecutionPrompt(cards, workspaceRoot);
}
```

This ensures `promptSelected` (line 1241) and `promptAll` (line 1259) respect complexity.

### 2. Fix TaskViewerProvider copy prompt path
**Location:** `c:\Users\patvu\Documents\GitHub\switchboard\src\services\TaskViewerProvider.ts:5614-5619`

Add complexity check for PLAN REVIEWED column:

```typescript
const customAgents = await this.getCustomAgents(resolvedWorkspaceRoot);
const effectiveColumn = this._normalizeLegacyKanbanColumn(column || deriveKanbanColumn(Array.isArray(sheet.events) ? sheet.events : [], customAgents));

// For PLAN REVIEWED, use complexity-based role selection
let role: string;
if (effectiveColumn === 'PLAN REVIEWED' && this._kanbanProvider) {
    const complexity = await this._kanbanProvider.getComplexityFromPlan(resolvedWorkspaceRoot, planPathAbsolute);
    role = complexity === 'Low' ? 'coder' : 'lead';
} else {
    role = columnToPromptRole(effectiveColumn) || 'coder';
}

const plan: BatchPromptPlan = { topic, absolutePath: planPathAbsolute };
let textToCopy = buildKanbanBatchPrompt(role, [plan], {
    accurateCodingEnabled: this._isAccurateCodingEnabled()
});
```

### 3. Do NOT modify `columnToPromptRole()` in agentPromptBuilder.ts
**Rationale:** This function is used in other contexts (e.g., autoban, reviewer routing) where the static mapping is correct. The bug is in the callers not checking for PLAN REVIEWED's special complexity routing requirement.

## Implementation Steps

1. **Read current implementations**
   - `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts:431-437` (_generatePromptForColumn)
   - `c:\Users\patvu\Documents\GitHub\switchboard\src\services\TaskViewerProvider.ts:5610-5625` (copyPlanLink handler)

2. **Update KanbanProvider._generatePromptForColumn()**
   - Add PLAN REVIEWED check before calling columnToPromptRole()
   - Route to _generateBatchExecutionPrompt() which already has complexity logic (line 399-408)

3. **Update TaskViewerProvider copyPlanLink handler**
   - Import getComplexityFromPlan from KanbanProvider if needed
   - Add complexity-based role selection for PLAN REVIEWED
   - Keep existing logic for other columns

4. **Verify all affected code paths**
   - `promptSelected` action (KanbanProvider.ts:1231-1247)
   - `promptAll` action (KanbanProvider.ts:1249-1265)
   - `copyPlanLink` in TaskViewerProvider (line 5597-5640)

## Verification Plan

1. **Create test plans with different complexities**
   - One Low complexity plan in PLAN REVIEWED
   - One High complexity plan in PLAN REVIEWED

2. **Test copy prompt button (TaskViewerProvider)**
   - Click copy prompt on Low complexity plan → should generate "coder" prompt
   - Click copy prompt on High complexity plan → should generate "lead" prompt

3. **Test Kanban batch buttons**
   - Select Low complexity plan, click "Copy Prompt" → should route to coder
   - Select High complexity plan, click "Copy Prompt" → should route to lead
   - Select mixed complexity plans → should generate appropriate batch prompt

4. **Verify existing move actions still work**
   - Drag-drop from PLAN REVIEWED should still partition by complexity
   - "Move All" from PLAN REVIEWED should still partition by complexity

## Dependencies

**Conflicts with:**
- `feature_plan_20260318_120428_bug_advance_plan_buttons_do_not_route_dynamically.md` - Related to advance buttons, may overlap with prompt generation
- `feature_plan_20260318_213154_copy_prompt_text_and_advance_text_are_differnet.md` - Directly related to copy prompt behavior

**Requires:**
- No schema changes
- No new dependencies
- Uses existing `getComplexityFromPlan()` method (KanbanProvider.ts:719-803)
- Uses existing `_generateBatchExecutionPrompt()` method (KanbanProvider.ts:399-408)

## Complexity Audit

### Band A (Routine)
- Single-file changes to two existing methods
- Reuses existing complexity detection logic (`getComplexityFromPlan`)
- Reuses existing prompt generation logic (`_generateBatchExecutionPrompt`)
- No new architectural patterns
- No schema changes
- Low risk - adds conditional branching to existing code paths

### Band B (Complex/Risky)
- None

**Classification:** Low complexity (Band A only)

## Agent Recommendation

**Send it to the Coder agent.**

This is a straightforward bug fix that:
- Modifies two existing methods with simple conditional logic
- Reuses all existing infrastructure (complexity detection, prompt generation)
- Requires no architectural changes
- Has clear test cases and verification steps

---

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer (Adversarial)

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | `_generateBatchExecutionPrompt()` checks `hasHighComplexity` across the entire card batch — if ONE card is high-complexity, ALL cards get a `lead` prompt. By design, but batch semantics could surprise users. |
| 2 | NIT | `_handleCopyPlanLink` null-guards `this._kanbanProvider` before complexity check. If null, falls through to `columnToPromptRole('PLAN REVIEWED')` → `'lead'`. Safe but suboptimal for low-complexity plans in an edge case that shouldn't occur in practice. |
| 3 | NIT | `columnToPromptRole()` correctly left unmodified — its static mapping is used by autoban and other contexts. |

**No CRITICAL or MAJOR findings.**

### Stage 2: Balanced Synthesis

- **Keep all changes**: `_generatePromptForColumn` PLAN REVIEWED intercept, `_handleCopyPlanLink` complexity-based role selection, `columnToPromptRole` untouched.
- **No code fixes needed.**
- **Defer**: Mixed-complexity batch behavior is documented in `_generateBatchExecutionPrompt` (by design).

### Files Changed
- `src/services/KanbanProvider.ts` — `_generatePromptForColumn()` (lines 439-454): Added PLAN REVIEWED early return to `_generateBatchExecutionPrompt()`
- `src/services/TaskViewerProvider.ts` — `_handleCopyPlanLink()` (lines 5682-5698): Added complexity-based role selection for PLAN REVIEWED column
- `src/services/agentPromptBuilder.ts` — `columnToPromptRole()`: **Not modified** (intentional)

### Validation Results
- **TypeScript compilation**: ✅ Clean (`npx tsc --noEmit` exit 0)
- **Code review**: ✅ All 3 proposed changes correctly implemented

### Remaining Risks
- None identified. Low-risk conditional branching on existing code paths.
