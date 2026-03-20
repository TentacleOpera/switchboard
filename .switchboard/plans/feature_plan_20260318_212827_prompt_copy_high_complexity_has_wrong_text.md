# Prompt copy high complexity has wrong text

## Goal
When you select high complexity plans in kanban, and press the copy prompt button for them, the prompt calls them 'low complexity plans' and claims they are limited scope. This is incorrect. The copied prompt should instead be dynamic to the plan complexity. If high complexity plans are included, it should not use low complexity language.

## Proposed Changes
1. **Refactor Prompt Method Name**: Rename `_generateBatchLowComplexityPrompt` in `src/services/KanbanProvider.ts` to `_generateBatchExecutionPrompt` to reflect that it handles plans of varying complexity.
2. **Dynamic Complexity Text**: Inside `_generateBatchExecutionPrompt`, inspect the passed `cards`. Determine if any card has high complexity (e.g. `!this._isLowComplexity(card)`).
3. **Adjust Intro Instruction**:
   - If ALL cards are low complexity: "Please execute the following X low-complexity plans from PLAN REVIEWED."
   - If ANY card is high complexity: "Please execute the following X plans." (Remove "low-complexity" and any language about limited scope).
4. **Integration with Plan 2**: This refactoring should align with unifying the prompt generation between KanbanProvider and TaskViewerProvider (as detailed in the related plan `copy_prompt_text_and_advance_text_are_differnet.md`).

## Implementation Steps

### Step 1: Rename method and update all call sites
**File**: `src/services/KanbanProvider.ts`

1. **Line 411**: Rename `_generateBatchLowComplexityPrompt` to `_generateBatchExecutionPrompt`
2. **Line 454**: Update call site in `_generatePromptForColumn` from `this._generateBatchLowComplexityPrompt(cards, workspaceRoot)` to `this._generateBatchExecutionPrompt(cards, workspaceRoot)`
3. **Line 1120**: Update call site in `batchLowComplexity` handler from `this._generateBatchLowComplexityPrompt(sourceCards, workspaceRoot)` to `this._generateBatchExecutionPrompt(sourceCards, workspaceRoot)`

### Step 2: Add complexity detection logic
**File**: `src/services/KanbanProvider.ts`, **Line 411-427**

Inside the renamed `_generateBatchExecutionPrompt` method:
1. Before building the prompt string, check if any card has non-low complexity:
   ```typescript
   const hasHighComplexity = cards.some(card => !this._isLowComplexity(card));
   ```
2. Build the intro line dynamically:
   ```typescript
   const complexityLabel = hasHighComplexity ? '' : 'LOW-complexity ';
   const intro = `Implement all ${cards.length} ${complexityLabel}plans from the PLAN REVIEWED column.`;
   ```
3. Adjust the instruction text on line 421 to remove "Each plan is small scope" language when high complexity plans are present:
   ```typescript
   const scopeGuidance = hasHighComplexity 
       ? 'Work serially through all plans. Do not stop between plans.'
       : 'Work serially through all plans. Each plan is small scope (routine changes, single-file edits, or simple UI additions). Do not stop between plans.';
   ```

### Step 3: Verify no other references
Search for any other references to the old method name and update them.

## Dependencies
- `src/services/KanbanProvider.ts` (Lines 411-427, 454, 1120)
- **Blocks**: None (can be implemented independently)
- **Blocked by**: None
- **Related Plan**: `feature_plan_20260318_213154_copy_prompt_text_and_advance_text_are_differnet.md` (Plan 2 will later centralize this logic)

## Verification Plan
1. Select multiple low-complexity plans in PLAN REVIEWED column → Copy prompt → Verify intro says "LOW-complexity"
2. Select at least one high-complexity plan in PLAN REVIEWED column → Copy prompt → Verify intro does NOT say "LOW-complexity" and does NOT include "small scope" language
3. Run `npm run compile` to ensure no TypeScript errors

## Complexity Audit

### Band A (Routine)
- ✅ Single-file change (only `KanbanProvider.ts`)
- ✅ Reuses existing pattern (`_isLowComplexity` already exists at line 368)
- ✅ Low risk (string manipulation with conditional logic)
- ✅ Small scope (~15 lines of code changes)

**Complexity**: **Band A (Routine)**
**Recommended Agent**: **Coder**

## Adversarial Review

**Grumpy Critique**: 
"This plan claims it's 'low complexity' but it's actually tightly coupled to Plan 2. You can't just rename the method and add a conditional—the real problem is that `KanbanProvider` and `TaskViewerProvider` generate completely different prompts for the same action. Fixing this in isolation will create technical debt. Also, the plan doesn't specify WHERE the complexity check should happen—before or after the card list is formatted? And what about the `_generateBatchPlannerPrompt` method at line 452? Does that need the same treatment? The plan is silent on this."

**Balanced Synthesis**: 
Valid concern about coupling with Plan 2. However, Plan 1 can be executed as a tactical fix that Plan 2 will later absorb into the unified prompt builder. The complexity check should happen at the intro text generation level (before building the full prompt string), inspecting all cards via `cards.some(card => !this._isLowComplexity(card))`. The `_generateBatchPlannerPrompt` method is for the CREATED column (planning phase), not execution, so it doesn't need this fix—it's a different workflow entirely. The plan is sound as a short-term fix with the understanding that Plan 2 will centralize this logic into a shared utility. Implementation steps now clarify the exact insertion points and logic flow.

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer

**[NIT]** *The plan said one thing, the implementation did something better — and didn't update the plan.* The plan specified inline `complexityLabel` and `scopeGuidance` variables within `_generateBatchExecutionPrompt`. The actual implementation is *cleaner*: it selects `role = 'lead'` vs `role = 'coder'` and delegates to `buildKanbanBatchPrompt()` in `agentPromptBuilder.ts`, which already has role-appropriate prompt templates. This is objectively superior — it uses the shared canonical prompt builder instead of duplicating string logic. But the plan's Implementation Steps are now stale documentation. Someone reading Step 2 would expect inline string manipulation and find delegation to a shared module instead. *The horror of documentation that lies to you.*

**[NIT]** *Step 1 line numbers are stale.* Plan says "Line 411: Rename", "Line 454: Update call site", "Line 1120: Update call site." Actual locations: method at line 399, call sites at lines 442, 453, and 1119. Line numbers drifted during implementation. This is expected for any plan that references line numbers, but it's worth noting for traceability.

**[NIT]** *The `batchLowComplexity` handler name is now slightly misleading.* The handler at line 1108 still says `case 'batchLowComplexity'` and filters for only low-complexity cards, then calls `_generateBatchExecutionPrompt(sourceCards)`. Since all sourceCards are guaranteed low-complexity (filtered at line 1114), the method will always select `role = 'coder'` with `instruction = 'low-complexity'`. This is correct, but the handler name suggests it *only* handles low complexity, while the method it calls is now generic. A future developer might incorrectly assume the method only handles low-complexity plans because of where they first encounter it. Harmless, but a code smell.

**Verdict**: Three NITs. Zero functional issues. The implementation is actually *better* than the plan specified — it routes through the canonical `buildKanbanBatchPrompt` rather than hand-rolling prompt strings.

### Stage 2: Balanced Synthesis

- **Keep**: The implementation approach (role-based delegation to `agentPromptBuilder.ts`) is superior to the plan's inline approach. All three call sites are correctly updated. The `hasHighComplexity` check at line 400 correctly flips between lead/coder roles.
- **Fix now**: Nothing. All NITs are documentation/naming concerns with zero functional impact.
- **Defer**: Update plan line numbers and implementation steps to reflect actual code if this plan is referenced again. The `batchLowComplexity` message type name could be renamed in a future cleanup.

### Code Fixes Applied
None required — no CRITICAL or MAJOR findings. Implementation exceeds plan quality.

### Verification Results
- **TypeScript compile**: `npx tsc --noEmit` → **PASS** (exit code 0, zero errors)
- **Functional trace**: High-complexity cards → `hasHighComplexity=true` → `role='lead'` → `buildKanbanBatchPrompt('lead', ...)` → prompt says "Please execute the following N plans." (no "low-complexity" language) ✓
- **Functional trace**: All low-complexity cards → `hasHighComplexity=false` → `role='coder'`, `instruction='low-complexity'` → `buildKanbanBatchPrompt('coder', ...)` → prompt says "Please execute the following N low-complexity plans from PLAN REVIEWED." ✓

### Files Changed
- `src/services/KanbanProvider.ts` (method rename at line 399, complexity detection at lines 400-407, call sites at lines 442, 453, 1119)
- `src/services/agentPromptBuilder.ts` (shared prompt builder — unchanged by this plan, but is the canonical path used)

### Remaining Risks
- None. The shared prompt builder ensures prompt consistency across all UI surfaces.

### Status: ✅ APPROVED
