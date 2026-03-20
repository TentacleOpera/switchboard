# No subagents in prompt if only has one plan

## Goal
If only transferring one plan to an agent via the kanban or autoban, do not include an instruction to use a subagent, as that doesn't make sense. So don't use the line 'If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.'

## User Review Required
> [!NOTE]
> None. This is an internal prompt generation tweak.

## Complexity Audit
### Band A — Routine
- Update `src/services/agentPromptBuilder.ts` to conditionally include the parallel sub-agents instruction only when `plans.length > 1`.

### Band B — Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None, purely synchronous string generation.
- **Security:** None.
- **Side Effects:** Prompts for single plans will be slightly shorter and lack the confusing sub-agent directive.
- **Dependencies & Conflicts:** None.

## Adversarial Synthesis
### Grumpy Critique
Ah yes, "just remove the sub-agent instruction when there's one plan." Classic simplistic view. What about edge cases? What if the `plans` array is empty? What about the spacing? If we just conditionally drop the string, we might leave a weird double newline floating around and mess up the markdown structure of the prompt. We're assuming `plans.length` is always well-formed. It probably is, but nobody checks. Just patching the symptoms without thinking about the resulting prompt format.

### Balanced Response
Grumpy makes a fair point about spacing and empty arrays. The plans array shouldn't be empty in normal usage, but checking `plans.length > 1` safely covers both 1 and 0 cases (neither should have parallel instructions). Regarding spacing, we'll ensure the conditional string incorporates the trailing newlines so that when it's omitted, the resulting prompt remains clean and correctly formatted without orphaned blank lines. The change is isolated to `src/services/agentPromptBuilder.ts` and modifies a single string interpolation, making it perfectly safe.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### `src/services/agentPromptBuilder.ts`
#### MODIFY `src/services/agentPromptBuilder.ts`
- **Context:** This file builds the prompts used to instruct the agents. The sub-agent instruction currently hardcoded needs to be conditional based on the number of plans being passed in.
- **Logic:**
  1. Create a `parallelInstruction` variable that checks `plans.length > 1`.
  2. If true, assign the parallel sub-agents instruction string with trailing newlines. If false, assign an empty string.
  3. Prepend this `parallelInstruction` variable to the `CRITICAL INSTRUCTIONS` string to construct the final `batchExecutionRules`.
- **Implementation:**
```typescript
<<<<
    const focusDirective = `FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;
    const batchExecutionRules = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.

CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.`;
    const inlineChallengeDirective = `For each plan, before implementation:
====
    const focusDirective = `FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;
    const parallelInstruction = plans.length > 1 ? \`If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\\n\\n\` : '';
    const batchExecutionRules = \`\${parallelInstruction}CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.\`;
    const inlineChallengeDirective = \`For each plan, before implementation:
>>>>
```
- **Edge Cases Handled:** The use of `\n\n` strictly inside the conditional ensures no rogue line breaks disrupt the prompt when there is only one plan. The check safely ignores `plans.length <= 1`.

## Verification Plan
### Automated Tests
- Run `npx tsc --noEmit` to verify type checks still pass and typescript code remains valid.
- Manually review prompt generation to verify sub-agent language is excluded on single plans and present for multiple plans.

## Reviewer Pass — 2026-03-20

### Validation Results
- **TypeScript typecheck (`tsc --noEmit`)**: PASS
- **`agent-prompt-builder-subagents.test.js`**: PASS (covers all 4 roles × single/multiple plans)

### Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | NIT | Plan uses `<<<<`/`====`/`>>>>` diff format in the code block — confusing and non-standard | Cosmetic — actual implementation is correct |
| 2 | NIT | Empty `plans` array edge case undocumented — `plans.length > 1` safely excludes it but caller contract is implicit | Deferred — caller guards this in practice |
| 3 | NIT | Plan verification section says "manually review" with no specifics; runtime tests now cover this | No action needed — test coverage exists |

### Files Changed
- None (implementation correct as-is)

### Remaining Risks
- None. Runtime test coverage confirms the conditional is working correctly for all roles and plan counts.