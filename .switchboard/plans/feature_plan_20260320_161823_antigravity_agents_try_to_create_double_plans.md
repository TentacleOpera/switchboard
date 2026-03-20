# Antigravity agents try to create double plans

## Goal
If I first create the plan here as a md file, and present it to an antigravity agent to implement, it insists on creating ANOTHER plan and seeking approval, which is moronic. The plan is already in place. How can we stop this wasteful behaviour?
We need to inject a strict execution authorization directive into the agent handoff prompts to force them to bypass PLANNING mode and go straight to EXECUTION.

## User Review Required
> [!NOTE]
> None required.

## Complexity Audit
### Band A — Routine
- Update `agentPromptBuilder.ts` to include a strict `AUTHORIZATION TO EXECUTE` directive for `lead` and `coder` roles.
### Band B — Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Prompt text generation is synchronous. 
- **Security:** None. Overriding agent system prompt behavior safely limits their scope to execution. 
- **Side Effects:** Agents might skip verifying edge cases if they strictly skip all planning. However, the `challengeBlock` for `lead` already handles inline review, complementing the execution bypass.
- **Dependencies & Conflicts:** None found in the current plans directory.

## Adversarial Synthesis
### Grumpy Critique
"So we're just going to yell 'AUTHORIZATION TO EXECUTE' at the LLM and hope it listens? LLMs love internal consistency. If its system prompt screams 'ALWAYS WRITE AN IMPLEMENTATION PLAN', slapping a single sentence into the user prompt might get ignored. Plus, what if the plan we feed it is garbage? We're telling it to blindly execute without thinking! It's going to drive straight off a cliff!"

### Balanced Response
"Grumpy makes a fair point about LLM compliance. To maximize compliance, we need to explicitly invoke the terms its system prompt relies on—specifically telling it to enter `EXECUTION` mode and skip `implementation_plan.md`. Regarding blind execution, the `lead` prompt already includes an inline adversarial challenge block that forces it to review the plan for flaws *before* writing code. This gives us the best of both worlds: critical thinking without the bureaucratic overhead of a second plan approval cycle."

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### agentPromptBuilder
#### [MODIFY] `src/services/agentPromptBuilder.ts`
- **Context:** We need to modify the prompt builder to inject a strong execution directive for `lead` and `coder` roles so they bypass their internal planning requirements.
- **Logic:**
  1. Define a constant `executionDirective` containing explicit instructions to enter EXECUTION mode and skip `implementation_plan.md`.
  2. Inject this directive into the `leadPrompt` and `coderPrompt` templates right after the initial intro sentence.
- **Implementation:**
```typescript
    const chatCritiqueDirective =
        \`When you output the adversarial critique (Grumpy and Balanced sections), include them verbatim in your chat response as formatted markdown — do not only write them to the plan file. The user must be able to read the critique directly in chat without opening the plan.\`;

    const executionDirective = \`AUTHORIZATION TO EXECUTE: The plans provided are already authorized. You MUST enter EXECUTION mode immediately. Do NOT enter PLANNING mode or generate an implementation_plan.md. Proceed directly to implementing the changes.\`;

    if (role === 'planner') {
// ... existing code ...
    if (role === 'lead') {
        let leadPrompt = \`Please execute the following \${plans.length} plans.

\${executionDirective}

\${batchExecutionRules}\${challengeBlock}

\${focusDirective}

PLANS TO PROCESS:
\${planList}\`;
        if (pairProgrammingEnabled) {
            leadPrompt += \`\n\nNote: A Coder agent is concurrently handling the Band A (routine) tasks for these plans. You only need to do Band B (complex/risky) work. Once the Coder finishes Band A (they will complete before you), check and integrate their work into your implementation before finalising.\`;
        }
        return leadPrompt;
    }

    if (role === 'coder') {
        const intro = baseInstruction === 'low-complexity'
            ? \`Please execute the following \${plans.length} low-complexity plans from PLAN REVIEWED.\`
            : \`Please execute the following \${plans.length} plans.\`;
        let coderPrompt = withCoderAccuracyInstruction(\`\${intro}

\${executionDirective}

\${batchExecutionRules}\${challengeBlock}

\${focusDirective}

PLANS TO PROCESS:
\${planList}\`, accurateCodingEnabled);
        if (pairProgrammingEnabled) {
            coderPrompt += \`\n\nAdditional Instructions: only do band a.\`;
        }
        return coderPrompt;
    }
```
- **Edge Cases Handled:** Uses exact semantic phrases (`EXECUTION mode`, `implementation_plan.md`) that agent system prompts natively understand, overriding their default behavior safely.

## Verification Plan
### Automated Tests
- Run `npm run compile` to ensure syntax is valid and no typing issues occur in `agentPromptBuilder.ts`.
- Check if any prompt unit tests need adjustment based on compiler output.

## Reviewer Pass — 2026-03-20

### Validation Results
- **TypeScript typecheck (`tsc --noEmit`)**: PASS
- **`agent-prompt-builder-subagents.test.js`**: PASS (`testExecutionDirective` covers lead+coder positive, planner+reviewer negative, single+multiple plans)

### Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | NIT | `executionDirective` constant allocated in shared scope but only used by lead/coder — same pattern as `chatCritiqueDirective` | Acceptable — follows existing code pattern |
| 2 | NIT | Plan verification section only mentions `npm run compile`; runtime test coverage already exists in `agent-prompt-builder-subagents.test.js` but plan doesn't reference it | Informational |
| 3 | NIT | LLM compliance with the directive is probabilistic — no fallback if agent ignores it | Product-level concern, not a code bug |

### Files Changed
- None (implementation correct as-is)

### Remaining Risks
- LLM compliance is inherently probabilistic. The directive uses exact semantic phrases (`EXECUTION mode`, `implementation_plan.md`) that maximize compliance, but cannot guarantee it across all models.
