# Make prompts standard across all sources

## Goal
THe planing prompt is still not standard across all sources. For example, if I press 'copy prompt' on the card itself in the kanbanwhile the card is in the New column, it gives me an extremely short 'please review this plan' prompt that does not match the quality of the other prompts. 

To make this very clear: ALL PROMPTS OF THE SAME TYPE MUST BE THE SAME. That means:

* move all
* move selected
* prompt move all
* prompt move selected
* send to jules
* copy prompt on card
* Send to agent in ticket view
* autoban prompt

These ALL must be the same. So if ANY ONE is triggered for a planner, it must be the same regardless of which one. If ANY is triggered for a coder ,it must be the same regardles sfo which one. This is not a hard concept, yet you consistently fial to grasp it. 

## Root Cause Analysis

**8 Distinct Prompt Generation Paths Identified:**
1. Kanban card "Copy Prompt" → `TaskViewerProvider._handleCopyPlanLink()` (line 5667)
2. Kanban "Prompt Selected" → `KanbanProvider._generatePromptForColumn()` (line 450)
3. Kanban "Prompt All" → `KanbanProvider._generatePromptForColumn()` (line 450)
4. Ticket View "Send to Agent" → `TaskViewerProvider.handleKanbanTrigger()` (line 7300+)
5. Autoban routing → Uses `handleKanbanTrigger()` path
6. Batch planner → `KanbanProvider._generateBatchPlannerPrompt()` (line 386)
7. Batch low complexity → `KanbanProvider._generateBatchLowComplexityPrompt()` (line 411)
8. Move operations (when CLI enabled) → Triggers via `handleKanbanTrigger()`

**Current Inconsistencies:**
- CREATED column card copy: `"Please improve the following plan. Execute the .agent/workflows/improve-plan.md workflow..."`
- CREATED batch planner: `"Run the /improve-plan workflow on all X plans..."`
- CREATED via "Send to Agent": Full structured prompt with Stage 1/2/3 instructions
- These are **three different prompts** for the same role/column combination

## Proposed Changes

### Step 1: Create Centralized Prompt Factory
**File:** `src/services/TaskViewerProvider.ts`
**Location:** Add new private method around line 5660 (before `_handleCopyPlanLink`)

```typescript
private _buildCanonicalPrompt(
    role: string,
    cards: Array<{sessionId: string, topic: string, planFile?: string, complexity?: string}>,
    workspaceRoot: string,
    options: {
        isBatch: boolean,
        instruction?: string,
        includeWorkflowContext?: boolean
    }
): string
```

**Implementation:**
- Consolidate role-specific logic from `handleKanbanTrigger()` (lines 7300-7414)
- Support both single-card and batch modes
- Include file location context for batch operations
- Return identical prompts regardless of UI entry point

### Step 2: Refactor Card Copy Prompt
**File:** `src/services/TaskViewerProvider.ts`
**Lines:** 5667-5737 (`_handleCopyPlanLink`)

**Changes:**
- Replace inline prompt construction (lines 5701-5712) with call to `_buildCanonicalPrompt()`
- Derive role from `effectiveColumn` using existing `_roleForKanbanColumn()` helper
- Pass single card as array to unified function

### Step 3: Refactor Batch Prompts in KanbanProvider
**File:** `src/services/KanbanProvider.ts`
**Lines:** 386-408 (`_generateBatchPlannerPrompt`), 411-426 (`_generateBatchLowComplexityPrompt`)

**Changes:**
- Call `TaskViewerProvider._buildCanonicalPrompt()` instead of inline construction
- Requires exposing the new method or moving it to a shared utility
- Preserve batch-specific formatting (numbered lists, file paths)

### Step 4: Unify "Prompt Selected/All" Paths
**File:** `src/services/KanbanProvider.ts`
**Lines:** 450-455 (`_generatePromptForColumn`), 1259-1282 (message handlers)

**Changes:**
- Replace `_generatePromptForColumn()` with call to centralized factory
- Ensure column-to-role mapping is consistent with other paths

### Step 5: Verify Ticket View "Send to Agent"
**File:** `src/services/TaskViewerProvider.ts`
**Lines:** 7300-7414 (planner prompt construction in `handleKanbanTrigger`)

**Changes:**
- Extract existing prompt logic into `_buildCanonicalPrompt()`
- Ensure this becomes the canonical implementation
- Preserve strict/light mode variants and phase gate metadata

### Step 6: Add Shared Prompt Utilities
**File:** `src/services/TaskViewerProvider.ts`
**New helper methods:**
- `_formatCardListForPrompt(cards[], includeComplexity)` - Standardize card formatting
- `_getSourceContextHints(workspaceRoot)` - File location hints for batch operations
- `_roleForKanbanColumn(column)` - Centralize column-to-role mapping (may already exist)

## Implementation Steps

1. **Create `_buildCanonicalPrompt()` method** in TaskViewerProvider.ts
   - Extract planner prompt logic from `handleKanbanTrigger()` (lines 7300-7363)
   - Extract coder prompt logic from `handleKanbanTrigger()` (lines 7416+)
   - Extract reviewer prompt logic from `handleKanbanTrigger()` (lines 7416-7449)
   - Add batch mode support with file context hints
   - Add single-card mode support with markdown link formatting

2. **Refactor `_handleCopyPlanLink()`** (lines 5667-5737)
   - Replace lines 5701-5712 with call to `_buildCanonicalPrompt()`
   - Map `effectiveColumn` to role
   - Pass card data as single-element array

3. **Refactor KanbanProvider batch prompts**
   - Update `_generateBatchPlannerPrompt()` to call TaskViewerProvider method
   - Update `_generateBatchLowComplexityPrompt()` to call TaskViewerProvider method
   - May require making `_buildCanonicalPrompt()` public or creating shared utility

4. **Update `_generatePromptForColumn()`** in KanbanProvider
   - Replace conditional logic with call to centralized factory
   - Remove `_generateBatchPlannerPrompt()` and `_generateBatchLowComplexityPrompt()` if fully replaced

5. **Verify all 8 paths produce identical output**
   - Test CREATED column: card copy, prompt selected, prompt all, send to agent
   - Test PLAN REVIEWED column: all paths for coder role
   - Test completed columns: all paths for reviewer role
   - Test custom agent columns if applicable

## Complexity Audit

### Band A (Routine)
- Extract existing prompt strings into centralized function (code movement, no logic changes)
- Update call sites to use new function (straightforward refactoring)
- Add helper methods for card formatting (simple utility functions)

### Band B (Complex/Risky)
- Integrating with `handleKanbanTrigger()` dispatch logic (touches critical agent routing)
- Cross-file coordination between KanbanProvider and TaskViewerProvider (architectural coupling)
- Preserving phase gate metadata and strict/light mode variants (multiple code paths to verify)
- Risk of breaking autoban, CLI triggers, or custom agent dispatch (high test surface area)
- Column-to-role mapping must stay consistent across all paths (single point of failure if wrong)

## Dependencies

**Potential Conflicts:**
- Search found 43 plans mentioning "prompt" - many are completed/archived
- Active plans that may overlap:
  - `feature_plan_20260317_160207_autoban_prompts_are_terrible.md` - May address autoban-specific prompt issues
  - `feature_plan_20260318_213154_copy_prompt_text_and_advance_text_are_differnet.md` - Directly related to prompt inconsistency
  - `feature_plan_20260318_212827_prompt_copy_high_complexity_has_wrong_text.md` - Specific prompt text issue

**Recommendation:** Review these 3 plans to avoid duplicate work or conflicting changes.

## Verification Plan

1. **Unit test prompt generation:**
   - Call `_buildCanonicalPrompt()` with each role (planner, coder, reviewer, custom)
   - Verify batch vs single-card modes produce correct format
   - Verify strict vs light mode variants (if applicable)

2. **Integration test all UI paths:**
   - Kanban card "Copy Prompt" → verify clipboard content
   - Kanban "Prompt Selected" → verify clipboard content
   - Kanban "Prompt All" → verify clipboard content
   - Ticket View "Send to Agent" → verify message payload
   - Trigger autoban → verify CLI command payload
   - Batch planner button → verify clipboard content

3. **Regression test agent dispatch:**
   - Verify planner agents receive correct prompt format
   - Verify coder agents receive correct prompt format
   - Verify reviewer agents receive correct prompt format
   - Verify custom agents receive correct prompt format

4. **Manual verification:**
   - Compare prompts from all 8 paths side-by-side
   - Confirm identical text for same role/column combination
   - Confirm batch prompts include file context hints
   - Confirm single-card prompts include markdown links

## Open Questions

1. Should `_buildCanonicalPrompt()` be public or remain private with KanbanProvider calling TaskViewerProvider methods?
2. Should we create a shared `PromptBuilder` utility class instead of adding to TaskViewerProvider?
3. Do custom agents need special prompt handling or can they use the standard coder/planner templates?
4. Should batch prompts always include file location hints, or only for certain roles?

## Agent Recommendation

**This plan requires advanced reasoning. Send it to the Lead Coder.**

**Rationale:**
- Multi-file coordination between KanbanProvider and TaskViewerProvider
- Touches critical agent dispatch and routing logic
- High risk of breaking autoban, CLI triggers, or custom agent workflows
- Requires careful preservation of phase gate metadata and mode variants
- Architectural refactoring with significant test surface area
