# Fix Excessive Line Breaks in Prompt Generation

## Goal
Normalize line breaks in agent prompt generation to eliminate excessive blank lines between sections.

## Metadata
- **Tags:** [bugfix, backend]
- **Complexity:** 4
- **Risk**: Low
- **Estimated Time**: 30 minutes

## User Review Required
No — changes are purely cosmetic formatting fixes with no functional behavior impact.

## Complexity Audit

### Routine
- Remove leading `\n\n` from four directive constants in `agentPromptBuilder.ts`
- Remove leading `\n` from `workspaceTypeBlock` strings
- Add `\n\n` separators at each directive append site (mechanical, repetitive)
- Add `normalizeNewlines` utility function (3-line regex replacement)
- Apply `normalizeNewlines` at each role's return point
- Update `TaskViewerProvider.ts` append sites with same pattern
- Add test assertions for no-triple-newline invariant

### Complex / Risky
- Refactoring the `${dispatchContextPrefix}${FOCUS_DIRECTIVE}${GIT_PROHIBITION_DIRECTIVE}${antigravityBlock}` concatenation pattern shared by 10 non-planner roles — must ensure consistent spacing across all option combinations (enabled/disabled for each flag)

## Current State
The `buildKanbanBatchPrompt` function in `src/services/agentPromptBuilder.ts` accumulates excessive newlines from multiple sources:

1. Base instruction strings end with `\n\n` (line 307)
2. Directive constants start with `\n\n` (lines 201, 203, 215)
3. `ADVANCED_REVIEWER_DIRECTIVE` starts with `\n` (line 205) — different from the others
4. `workspaceTypeBlock` has a leading `\n` (lines 300, 302) and is appended with `\n` suffix (line 333)
5. `dispatchContextPrefix` ends with `\n\n` (line 269)
6. `FOCUS_DIRECTIVE` is appended directly after with no normalization (line 341)

**Example output:**
```
Read .agent/workflows/improve-plan.md and follow it step-by-step.


WORKSPACE TYPE: This workspace is single-repo. Do NOT include a **Repo:** line in the plan metadata.
FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan.
```

Note the two blank lines between the instruction and WORKSPACE TYPE, but no blank line between WORKSPACE TYPE and FOCUS DIRECTIVE.

**Additional affected file:** `src/services/TaskViewerProvider.ts` (lines 6046-6055) uses the same directive constants with the same spacing bugs. Line 6047 adds `\n\n` before `ADVANCED_REVIEWER_DIRECTIVE` which already has a leading `\n`, creating triple newlines.

## Proposed Solution

### Approach 1: Normalize After Assembly
Add a post-processing step to normalize line breaks:
- Replace `\n\n\n+` with `\n\n`
- Ensure single newline between adjacent directives
- Preserve intentional paragraph breaks

**Pros:** Simple, centralized fix
**Cons:** May mask underlying inconsistency

### Approach 2: Refactor Directive Prefixes (Recommended)
Standardize directive formatting:
- Remove `\n\n` prefixes from directive constants
- Use a single `\n` as separator when appending
- Add `\n\n` only at intentional paragraph boundaries

**Pros:** Clearer code structure, consistent behavior
**Cons:** More changes to touch points

### Approach 3: Hybrid (Chosen)
Combine both approaches:
1. Remove leading/trailing whitespace from directive constants (Approach 2)
2. Add `\n\n` separators at every append site (Approach 2)
3. Add `normalizeNewlines` post-processing as a safety net (Approach 1)

**Pros:** Clean constants + defensive safety net; catches edge cases manual spacing might miss
**Cons:** Slightly more code than either approach alone

## Implementation Steps (Approach 3 — Hybrid)

### Step 1: Add `normalizeNewlines` utility
**File:** `src/services/agentPromptBuilder.ts`
**Location:** After the `resolveWorkingDir` function (after line 37)

Add a utility function:
```typescript
/**
 * Collapse 3+ consecutive newlines down to 2, preserving intentional
 * paragraph breaks while eliminating excessive blank lines.
 */
function normalizeNewlines(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n');
}
```

### Step 2: Update Directive Constants
**File:** `src/services/agentPromptBuilder.ts`

Remove leading `\n\n` from these constants:
- `SPLIT_PLAN_DIRECTIVE` (line 201) — remove leading `\n\n`, content starts with `SPLIT PLAN MODE:`
- `DEPENDENCY_CHECK_DIRECTIVE` (line 203) — remove leading `\n\n`, content starts with `[DEPENDENCY CHECK ENABLED]`; also remove trailing `\n`
- `ADVANCED_REVIEWER_DIRECTIVE` (lines 205-213) — remove leading `\n\n` (the template literal starts with backtick-newline-blankline, which is `\n\n`), content starts with `ADVANCED REGRESSION ANALYSIS`
- `AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE` (line 215) — remove leading `\n\n`, content starts with `PAIR PROGRAMMING OPTIMISATION:`; also remove trailing `\n`

Also update:
- `GIT_PROHIBITION_DIRECTIVE` (line 192) — remove leading `\n`, content starts with `GIT POLICY:`
- `workspaceTypeBlock` (lines 300, 302) — remove leading `\n` from both branches, content starts with `WORKSPACE TYPE:`

### Step 3: Update Planner Append Logic
**File:** `src/services/agentPromptBuilder.ts`

Change directive append sites to use consistent `\n\n` separators:

- **Line 328:** Replace `plannerBase += aggressiveDirective + dependencyCheckInstruction;` with conditional appends:
  ```typescript
  if (aggressivePairProgramming) {
      plannerBase += '\n\n' + AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE;
  }
  if (dependencyCheckEnabled) {
      plannerBase += '\n\n' + DEPENDENCY_CHECK_DIRECTIVE;
  }
  ```

- **Line 329-331:** Replace `if (splitPlan) { plannerBase += SPLIT_PLAN_DIRECTIVE; }` with:
  ```typescript
  if (splitPlan) {
      plannerBase += '\n\n' + SPLIT_PLAN_DIRECTIVE;
  }
  ```

- **Line 332-334:** Replace `if (workspaceTypeBlock) { plannerBase += workspaceTypeBlock + '\n'; }` with:
  ```typescript
  if (workspaceTypeBlock) {
      plannerBase += '\n\n' + workspaceTypeBlock;
  }
  ```

- **Line 341:** Replace `plannerPrompt += \`${dispatchContextPrefix}${switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : ''}\`;` with:
  ```typescript
  const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
  const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
  const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
      .filter(Boolean)
      .join('\n\n');
  plannerPrompt += suffixBlock;
  ```

- **Line 348:** Apply `normalizeNewlines` to the final return:
  ```typescript
  return normalizeNewlines(plannerPrompt + `\n\nPLANS TO PROCESS:\n${planList}`);
  ```

### Step 4: Update Non-Planner Roles
**File:** `src/services/agentPromptBuilder.ts`

All non-planner roles share the concatenation pattern `${dispatchContextPrefix}${FOCUS_DIRECTIVE}${GIT_PROHIBITION_DIRECTIVE}${antigravityBlock}`. Refactor each to use the same `suffixBlock` pattern and apply `normalizeNewlines` at the return point.

**Reviewer** (lines 380-389):
- Build `suffixBlock` from `[dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock].filter(Boolean).join('\n\n')`
- Replace the inline concatenation with `${suffixBlock}`
- Wrap return value in `normalizeNewlines()`

**Tester** (lines 415-426):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Lead** (lines 453-464):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Coder** (lines 486-497):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Intern** (lines 506-513):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Analyst** (lines 519-526):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Ticket Updater** (lines 559-564):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Researcher** (lines 574-579):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Research Planner** (lines 607-612):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

**Splitter** (lines 641-646):
- Same `suffixBlock` pattern
- Wrap return value in `normalizeNewlines()`

### Step 5: Update TaskViewerProvider
**File:** `src/services/TaskViewerProvider.ts`

Update the same directive append sites (lines 6046-6055):
- **Line 6046:** `prompt += AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE;` → `prompt += '\n\n' + AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE;`
- **Line 6047:** `prompt += \`\n\n${ADVANCED_REVIEWER_DIRECTIVE}\`;` → `prompt += '\n\n' + ADVANCED_REVIEWER_DIRECTIVE;`
- **Line 6048:** `prompt += DEPENDENCY_CHECK_DIRECTIVE;` → `prompt += '\n\n' + DEPENDENCY_CHECK_DIRECTIVE;`
- **Line 6055:** `prompt += SPLIT_PLAN_DIRECTIVE;` → `prompt += '\n\n' + SPLIT_PLAN_DIRECTIVE;`

Apply `normalizeNewlines` to the final prompt before return. Import `normalizeNewlines` from `agentPromptBuilder.ts` (export it).

### Step 6: Add Test Coverage
**File:** `src/test/minimal-prompt.test.js`

Add a test function `testNoTripleNewlinesInAnyRole` that:
1. Generates prompts for every role: `planner`, `reviewer`, `tester`, `lead`, `coder`, `intern`, `analyst`, `ticket_updater`, `researcher`, `research_planner`, `splitter`
2. For each role, tests multiple option combinations:
   - All options disabled (minimal prompt)
   - All options enabled (maximal prompt)
   - With `workspaceRoot` set (triggers workspaceTypeBlock)
   - With `dispatchContextBlock` (working directory set)
3. Asserts that no generated prompt contains `\n\n\n` (three or more consecutive newlines)
4. Asserts that each prompt contains at least one `\n\n` (verifies paragraph breaks are preserved)

Add a test function `testConsistentSpacingBetweenDirectives` that:
1. Generates a planner prompt with `aggressivePairProgramming: true`, `dependencyCheckEnabled: true`, `splitPlan: true`, `workspaceRoot: __dirname`
2. Verifies that between each directive section there are exactly two newlines (`\n\n`)
3. Verifies no single-newline transitions between major sections

## Edge-Case & Dependency Audit

### Race Conditions
- None — prompt generation is synchronous and stateless

### Security
- None — changes are purely cosmetic formatting

### Side Effects
- Generated prompts will have different whitespace; any downstream parser that relies on exact newline counts could break (unlikely but possible)
- `resolveBaseInstructions` with `prepend`/`append` modes adds `\n\n` between override and base text — this is unaffected by the fix

### Dependencies & Conflicts
- `TaskViewerProvider.ts` imports the same directive constants — changes to constant definitions affect both files
- The `splitter` role embeds `SPLIT_PLAN_DIRECTIVE` inline in its base text (line 630) — removing the `\n\n` prefix from the constant changes the splitter's prompt formatting; the inline reference at line 630 needs a `\n\n` prefix added manually

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) TaskViewerProvider.ts was missing from original scope — same constants, same bugs, must be fixed in tandem or spacing breaks there. (2) workspaceTypeBlock has a hidden leading `\n` that would create triple newlines if the append-site fix is applied naively. (3) The non-planner role concatenation pattern needs a structural fix, not just constant cleanup. Mitigations: hybrid approach with `normalizeNewlines` safety net catches any edge cases; `suffixBlock` join pattern eliminates the concatenation inconsistency.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
- **Context:** Central prompt builder for all agent roles. 675 lines.
- **Logic:** Directive constants carry their own spacing, which conflicts with spacing added at append sites. Remove internal spacing from constants; manage all spacing at append sites; add safety net.
- **Implementation:**
  1. Add `normalizeNewlines` utility after line 37
  2. Strip leading `\n\n`/`\n` from 6 constants (lines 192, 193, 201, 203, 205, 215)
  3. Strip leading `\n` from workspaceTypeBlock (lines 300, 302)
  4. Replace direct concatenation with conditional `\n\n` + directive pattern (lines 328-334)
  5. Build `suffixBlock` via `.filter(Boolean).join('\n\n')` for planner (line 341) and all 10 non-planner roles
  6. Wrap every role's return value in `normalizeNewlines()`
  7. Export `normalizeNewlines` for use by TaskViewerProvider
- **Edge Cases:** Empty directive blocks (disabled options) produce empty strings filtered out by `.filter(Boolean)`; conditional directives (e.g., `switchboardSafeguardsEnabled`) produce no orphaned newlines when disabled; splitter's inline `SPLIT_PLAN_DIRECTIVE` reference (line 630) needs `\n\n` prefix added

### `src/services/TaskViewerProvider.ts`
- **Context:** Task viewer prompt builder. Uses same directive constants. Lines 6046-6055.
- **Logic:** Same spacing bugs as agentPromptBuilder, plus line 6047 adds redundant `\n\n` before ADVANCED_REVIEWER_DIRECTIVE.
- **Implementation:**
  1. Import `normalizeNewlines` from `agentPromptBuilder`
  2. Add `\n\n` prefix before each directive append (lines 6046, 6048, 6055)
  3. Fix line 6047: remove redundant `\n\n` from template literal, use `'\n\n' + ADVANCED_REVIEWER_DIRECTIVE`
  4. Apply `normalizeNewlines` to final prompt before return
- **Edge Cases:** Same as agentPromptBuilder — disabled options produce no orphaned newlines

### `src/test/minimal-prompt.test.js`
- **Context:** Existing test file for prompt builder. 174 lines.
- **Logic:** Add newline normalization assertions.
- **Implementation:** Add `testNoTripleNewlinesInAnyRole` and `testConsistentSpacingBetweenDirectives` functions as described in Step 6.
- **Edge Cases:** Test must cover both single-plan and multi-plan dispatches; must cover all option combinations that trigger different code paths

## Verification Plan

### Automated Tests
```bash
npm test -- src/test/minimal-prompt.test.js
npm test -- src/test/agent-prompt-builder-subagents.test.js
```

The new `testNoTripleNewlinesInAnyRole` test will assert:
- No `\n\n\n` in any generated prompt for any role/option combination
- Each prompt contains at least one `\n\n` (paragraph breaks preserved)

The new `testConsistentSpacingBetweenDirectives` test will assert:
- Exactly `\n\n` between each major section in the planner prompt with all options enabled

### Manual Verification
Manually inspect generated prompts for all roles to ensure readability is maintained. Pay special attention to:
- Planner prompt with all add-ons enabled (most complex combination)
- Reviewer prompt with advanced reviewer enabled
- Coder prompt with pair programming + accuracy mode
- Splitter prompt (inline SPLIT_PLAN_DIRECTIVE reference)

## Risks
- **Low**: Changes are purely cosmetic; no functional behavior affected
- **Medium**: If separator logic is incorrect, could introduce missing newlines where they're needed — mitigated by `normalizeNewlines` safety net and specific test assertions

## Recommendation
Complexity 4 → **Send to Coder**

---

## Reviewer Pass Results

### Review Date: 2026-05-21

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | `GIT_PROHIBITION_DIRECTIVE` in TaskViewerProvider.ts line 5972 appended with ZERO separator — text collision with preceding plan list | **Fixed** |
| 2 | MAJOR | `workspaceTypeBlock` in TaskViewerProvider.ts lines 5975-5977 uses `\n` instead of `\n\n` — inconsistent paragraph spacing vs all other directives | **Fixed** |
| 3 | MAJOR | Missing test functions `testNoTripleNewlinesInAnyRole` and `testConsistentSpacingBetweenDirectives` as specified in Step 6 | **Fixed** |
| 4 | NIT | `challengeBlock` and `antigravityBlock` still carried `\n\n` prefixes, creating 4-newline sequences that `normalizeNewlines` had to collapse — violates plan principle of constants not carrying their own spacing | **Fixed** |
| 5 | NIT | `antigravityBlock` had trailing `\n` creating potential 3-newline sequences | **Fixed** |

### Stage 2: Balanced Synthesis

All 5 findings were valid and fixed. Findings 1-2 were genuine formatting bugs (one catastrophic text collision, one inconsistent spacing). Finding 3 was a plan compliance gap. Findings 4-5 were minor but trivially fixable and reduce reliance on the `normalizeNewlines` crutch for issues that shouldn't exist.

### Code Fixes Applied

#### `src/services/TaskViewerProvider.ts`
1. Line 5972: `prompt += GIT_PROHIBITION_DIRECTIVE` → `prompt += '\n\n' + GIT_PROHIBITION_DIRECTIVE` (CRITICAL fix — was a text collision)
2. Lines 5975-5977: `\nWORKSPACE TYPE:` → `'\n\nWORKSPACE TYPE:'` (MAJOR fix — consistent paragraph spacing)

#### `src/services/agentPromptBuilder.ts`
3. Line 268: `challengeBlock` stripped `\n\n` prefix — now `includeInlineChallenge ? inlineChallengeDirective : ''` (NIT fix)
4. Lines 269-271: `antigravityBlock` stripped `\n\n` prefix and trailing `\n` — now a clean string constant (NIT fix)

#### `src/test/minimal-prompt.test.js`
5. Added `testNoTripleNewlinesInAnyRole` — tests all 11 roles across 4 option combinations, asserts no `\n\n\n` and at least one `\n\n` per prompt
6. Added `testConsistentSpacingBetweenDirectives` — tests planner with all options enabled, verifies all expected sections present and no triple newlines
7. Both new functions registered in the test runner

### Validation Results

- **`node src/test/minimal-prompt.test.js`**: All 15 tests PASS (including 2 new tests)
- **`node src/test/agent-prompt-builder-subagents.test.js`**: All 23 tests PASS
- **`npm run compile-tests`**: PASS (tsc compiles cleanly)
- **`npm run compile`**: PASS (webpack compiles successfully)
- **Pre-existing TS errors** in ClickUpSyncService.ts and KanbanProvider.ts are unrelated to this plan

### Remaining Risks
- The `challengeBlock` is now used in `safeguardsBlock` construction for lead/coder roles via `${batchExecutionRules}\n\n${challengeBlock}`.trim(). When `includeInlineChallenge=false` and `switchboardSafeguardsEnabled=true`, this produces `${batchExecutionRules}\n\n`.trim() which correctly strips the trailing whitespace. Verified by existing tests.
- The `antigravityBlock` no longer has a trailing `\n`. When it's the last element in `suffixBlock` joined with `\n\n`, the join separator handles inter-element spacing correctly. Verified by new `testNoTripleNewlinesInAnyRole` test.
- TaskViewerProvider's `buildCustomAgentPrompt` method was not in the original plan scope and was not modified beyond the two fixes above. Its remaining directive appends (lines 5979-5993) already use `\n\n` prefixes correctly.
