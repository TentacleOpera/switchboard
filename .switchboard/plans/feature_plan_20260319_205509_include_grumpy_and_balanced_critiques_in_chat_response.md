# Include Grumpy and Balanced Critiques in Chat Response

## Goal
Update the `planner` and `reviewer` prompt templates in `agentPromptBuilder.ts` so that when those agents update an implementation plan, they are explicitly instructed to present their Grumpy and Balanced adversarial critique sections in the same chat response — not only written into the plan file.

## User Review Required
> [!NOTE]
> This is a **prompt-only change** in `agentPromptBuilder.ts`. No UI, no backend state, no new settings. The runtime behaviour will change immediately on next plan dispatch after deploy.

## Complexity Audit

### Band A — Routine
- Modify the `planner` prompt string (lines 79–97 of `agentPromptBuilder.ts`) to include an explicit instruction to echo Grumpy + Balanced critique in the chat alongside updating the plan file.
- Modify the `reviewer` prompt string (lines 104–123 of `agentPromptBuilder.ts`) to include the same instruction, scoped to the reviewer workflow (Grumpy findings → Balanced synthesis → code fixes).
- Update regression snapshot test if one exists for these prompt strings.

### Band B — Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None — pure static string change, no async paths affected.
- **Security:** None — prompt content only.
- **Side Effects:** Agents will now produce longer chat responses because they must echo the critique in addition to their existing work. This is the intended behaviour; no silent regression risk.
- **Dependencies & Conflicts:** No currently open Kanban plans touch `agentPromptBuilder.ts`. Check `kanban-batch-prompt-regression.test.js` — it may assert exact prompt substrings and will need updating.

## Adversarial Synthesis

### Grumpy Critique
> "Oh fantastic, another 'just add a line to the prompt' plan. Let me count the ways this goes sideways. First, where exactly does the instruction live? You say 'in the planner prompt' but the planner prompt is a 20-line template string. If you staple 'also show it in chat' to the *end* of that blob, half the models will bury it after the plan list and ignore it. You need to insert the instruction **before** the plan list so it registers as an execution gate, not an afterthought.
>
> Second, you haven't specified the *format* of the in-chat critique. 'Present the Grumpy and Balanced critiques in the chat' — does that mean copy-paste the plan's `## Adversarial Synthesis` section verbatim? Paraphrase it? The agent will hallucinate whatever feels right. You need an explicit structural directive: render it as a named section in the chat *before* confirming plan updates are done.
>
> Third, you've totally ignored the reviewer prompt. The reviewer already has a Grumpy Stage and Balanced Stage (Steps 2–3 in the reviewer block), but the prompt says 'apply code fixes… and update the original plan file' — there's zero instruction to surface these stages back to the user in the chat response. Same problem, same fix needed.
>
> Finally, no regression test update plan? The `kanban-batch-prompt-regression.test.js` snapshot will fail the moment you change the substring."

### Balanced Response
The Grumpy critique is correct on all four points:
1. **Instruction placement** — the new directive must be inserted *above* the `PLANS TO PROCESS:` line but *after* the existing behavioural rules, so it reads as a required pre-completion step rather than an appended note.
2. **Format specificity** — the instruction explicitly names the section (`### Grumpy Critique` and `### Balanced Response` from the plan's `## Adversarial Synthesis`) and states that they must appear in the chat as a formatted markdown block before the agent confirms completion.
3. **Reviewer coverage** — the reviewer prompt already has discrete Stage 1/Stage 2 steps; the addition clarifies that these stages must be **visible in the chat reply**, not only written into the file.
4. **Regression test** — the implementation steps below include updating the snapshot/assertion in `kanban-batch-prompt-regression.test.js`.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks.

### Prompt Generation — agentPromptBuilder

#### [MODIFY] `src/services/agentPromptBuilder.ts`

- **Context:** The `buildKanbanBatchPrompt` function contains two prompt templates that are affected: the `'planner'` branch (lines 77–98) and the `'reviewer'` branch (lines 100–124). Both need an explicit instruction to surface the adversarial critique in the chat response.
- **Logic:**
  1. Define a shared constant `chatCritiqueDirective` above the `if (role === 'planner')` block.
  2. In the **planner** branch: insert `chatCritiqueDirective` between the `For each plan:` numbered list and the `PLANS TO PROCESS:` block. Specifically, insert it as a new numbered item 4 (after the current item 3 about adversarial review) and renumber: *"4. Present the Grumpy and Balanced critique sections in your chat response as formatted markdown (copy the `### Grumpy Critique` and `### Balanced Response` blocks verbatim from your draft plan) before confirming the plan update is written."*
  3. In the **reviewer** branch: insert a parallel instruction after the existing `CRITICAL: Do not stop after Stage 1…` line, making explicit that Stage 1 (Grumpy) and Stage 2 (Balanced) must be rendered in the chat reply — not only written into the plan file.
- **Implementation:**

```typescript
// ── NEW: shared directive inserted in both planner and reviewer prompts
const chatCritiqueDirective =
    `When you output the adversarial critique (Grumpy and Balanced sections), include them verbatim in your chat response as formatted markdown — do not only write them to the plan file. The user must be able to read the critique directly in chat without opening the plan.`;

// ── PLANNER branch — updated numbered steps (formerly 4 steps, now 5)
if (role === 'planner') {
    const plannerVerb = baseInstruction === 'enhance' ? 'enhance' : 'improve';
    return `Please ${plannerVerb} the following ${plans.length} plans. Break each down into distinct steps grouped by high complexity and low complexity. Add extra detail.
MANDATORY: You MUST read and strictly adhere to \`.agent/rules/how_to_plan.md\` to format your output and ensure sufficient technical detail. Do not make assumptions about which files need to be changed; provide exact file paths and explicit implementation steps as required by the guide.
Do not add net-new product requirements or scope.
You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.

${batchExecutionRules}

For each plan:
1. Read the plan file before editing.
2. Fill out 'TODO' sections or underspecified parts. Scan the Kanban board/plans folder for potential cross-plan conflicts and document them.
3. Ensure the plan has a "## Complexity Audit" section with "### Band A — Routine" and "### Band B — Complex / Risky" subsections. If missing, create it. If present, update it. If Band B is empty, write "- None" explicitly.
4. Perform adversarial review: post a Grumpy critique (dramatic "Grumpy Principal Engineer" voice: incisive, specific, theatrical) then a Balanced synthesis.
5. ${chatCritiqueDirective}
6. Update the original plan with the enhancement findings. Do NOT truncate, summarize, or delete existing implementation steps, code blocks, or goal statements.
7. Recommend agent: if the plan is simple (routine changes, only Band A), say "Send to Coder". If complex (Band B tasks, new frameworks), say "Send to Lead Coder".

${focusDirective}

PLANS TO PROCESS:
${planList}`;
}

// ── REVIEWER branch — inject directive after existing CRITICAL line
if (role === 'reviewer') {
    const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
    const reviewerExecutionIntro = buildReviewerExecutionIntro(plans.length);
    const reviewerExecutionMode = buildReviewerExecutionModeLine(`For ${planTarget}, assess the actual code changes against the plan requirements, fix valid material issues in code when needed, then verify.`);
    return `${reviewerExecutionIntro}

${batchExecutionRules}

${reviewerExecutionMode}

For each plan:
1. Use the plan file as the source of truth for the review criteria.
2. Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.
4. Apply code fixes for valid CRITICAL/MAJOR findings.
5. Run verification checks (typecheck/tests as applicable) and include results.
6. Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps.

CRITICAL: Do not stop after Stage 1. Complete the Grumpy review, the Balanced synthesis, the code fixes, and the plan update all in one continuous response.

${chatCritiqueDirective}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
}
```

- **Edge Cases Handled:** Placement before `PLANS TO PROCESS:` ensures the instruction is parsed before the plan list, so models that process instructions sequentially will treat it as a completion gate. The word "verbatim" removes ambiguity about whether the agent should paraphrase.

---

### Regression Tests

#### [MODIFY] `src/test/kanban-batch-prompt-regression.test.js`

- **Context:** This file contains snapshot assertions against `buildKanbanBatchPrompt` output. Any assertion checking the exact substring count of numbered steps, or asserting the exact `For each plan:` block for `planner` or the exact `CRITICAL:` line for `reviewer`, will now fail because both templates have been extended.
- **Logic:**
  1. Locate the test that calls `buildKanbanBatchPrompt` with `role: 'planner'` and update the assertion to include `chatCritiqueDirective` text (or check for the keyword "verbatim in your chat response").
  2. Locate the test that calls `buildKanbanBatchPrompt` with `role: 'reviewer'` and update similarly.
  3. If tests use `toMatchSnapshot()`, delete the stale snapshots and re-run to regenerate.
- **Implementation:** Search for the string `"present"` or `"critique"` in the test file after the change to confirm the new text is captured. If the test uses `includes`:

```javascript
// planner regression – new assertion
assert.ok(
    plannerPrompt.includes('verbatim in your chat response'),
    'Planner prompt must instruct agent to surface critique in chat'
);

// reviewer regression – new assertion
assert.ok(
    reviewerPrompt.includes('verbatim in your chat response'),
    'Reviewer prompt must instruct agent to surface critique in chat'
);
```

- **Edge Cases Handled:** If a snapshot runner is used, the stale snapshot will cause a clear diff failure, not a silent pass — this is fine; the developer should delete stale snapshots and re-run.

## Verification Plan

### Automated Tests
1. Run the existing regression suite:
   ```
   npm test
   ```
   Expected: `kanban-batch-prompt-regression.test.js` passes with updated assertions.

2. Spot-check the generated strings programmatically:
   ```javascript
   const { buildKanbanBatchPrompt } = require('./out/services/agentPromptBuilder');
   const planner = buildKanbanBatchPrompt('planner', [{ topic: 'test', absolutePath: '/tmp/test.md' }]);
   console.assert(planner.includes('verbatim in your chat response'), 'Planner missing directive');
   const reviewer = buildKanbanBatchPrompt('reviewer', [{ topic: 'test', absolutePath: '/tmp/test.md' }]);
   console.assert(reviewer.includes('verbatim in your chat response'), 'Reviewer missing directive');
   ```

### Manual Verification
- Open kanban, place a plan in CREATED, press the "Prompt Selected" (copy prompt) button → paste result into a text editor and confirm the `chatCritiqueDirective` text appears.
- Advance a plan through PLAN REVIEWED → confirm the reviewer prompt surface contains the new `chatCritiqueDirective` line.

---

## Agent Recommendation
**Send to Coder** — Band A only. Pure string constant addition + one test update. No logic, state, or architecture changes.

## Reviewer Pass — 2026-03-20

### Validation Results
- **TypeScript typecheck (`tsc --noEmit`)**: PASS
- **`agent-prompt-builder-subagents.test.js`**: PASS (including new `testChatCritiqueDirective`)
- **`autoban-reviewer-prompt-regression.test.js`**: PASS
- **`kanban-batch-prompt-regression.test.js`**: PASS

### Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | MAJOR | Plan specified updating `kanban-batch-prompt-regression.test.js` but that file tests `KanbanProvider.ts`, not `agentPromptBuilder.ts`. No runtime test existed for `chatCritiqueDirective` in planner/reviewer prompts. | **FIXED**: Added `testChatCritiqueDirective()` to `agent-prompt-builder-subagents.test.js` — asserts directive present in planner+reviewer, absent from lead+coder. |
| 2 | NIT | Plan step numbering ("insert as item 4") doesn't match implementation (it's step 5) | Cosmetic — plan text is stale relative to code |
| 3 | NIT | `autoban-reviewer-prompt-regression.test.js` already had a source-level check (line 32-35) for the reviewer, but no runtime coverage | Covered by the new runtime test above |

### Files Changed
- `src/test/agent-prompt-builder-subagents.test.js` — added `chatCritiqueText` constant and `testChatCritiqueDirective()` function

### Remaining Risks
- None. All prompt builder roles now have runtime test coverage for the chatCritiqueDirective.
