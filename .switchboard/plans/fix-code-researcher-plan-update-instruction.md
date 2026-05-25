# Fix Code Researcher Plan Update Instruction

## Goal
Add an explicit instruction to the `code_researcher` agent prompt requiring it to update the plan file with research findings, closing the gap between the agent's stated purpose ("improve coding plans") and its actual directive (which only says "produce output").

## Metadata
- **Tags:** [bugfix, backend, workflow]
- **Complexity:** 3

## User Review Required
No — this is a targeted prompt-text fix with no architectural impact. The change adds instruction text to an existing string variable; no new logic, state, or dependencies are introduced.

## Problem
In `kanban.html` prompts tab, the code researcher agent's prompt does not instruct the agent to actually update the plan file with research results. The current `DEEP_RESEARCH_DIRECTIVE` only tells the agent to "produce output" with research findings (Executive Summary, Current State Analysis, External Research Findings, Proposed Implementation Plan, Impact Analysis, Source Credibility Assessment, Knowledge Gaps, Recommended Next Steps), but does not explicitly instruct the agent to update the plan file itself.

The agent description says "Uses research to scope and improve coding plans with codebase exploration and external research" — the key word being "improve" — but the prompt lacks the instruction to actually apply those improvements to the plan file.

## Root Cause
In `src/services/agentPromptBuilder.ts`, the `code_researcher` role handler (lines 837-870) uses `DEEP_RESEARCH_DIRECTIVE` which ends with:
```
PHASE 4: Synthesis — produce output with: Executive Summary, Current State Analysis, External Research Findings, Proposed Implementation Plan, Impact Analysis, Source Credibility Assessment, Knowledge Gaps, Recommended Next Steps.
TARGET SOURCE COUNT: 50-100 sources (soft target — prioritize quality over quantity).
```

This directive instructs the agent to produce research output but does not include an explicit instruction to update the plan file with those findings.

Compare to the `reviewer` role (line 432) which explicitly states:
```
6. Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps.
```

## Complexity Audit

### Routine
- Appending a string literal to an existing variable (`crBase`) in a single file
- Following the established pattern set by the `reviewer` role's plan-update instruction
- No new logic branches, state, or dependencies

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** N/A — this is a static string addition, no runtime state changes.
- **Security:** No security implications. The instruction text is non-privileged prompt content.
- **Side Effects:** The `resolveBaseInstructions` override system (line 135-150) could theoretically replace the entire base in `replace` mode, which would discard the new instruction. This is a pre-existing design constraint affecting all roles equally — not a regression introduced by this change.
- **Dependencies & Conflicts:** The `code_researcher` handler processes plans listed in `PLANS TO PROCESS` (line 871), which may contain multiple plans. The instruction text must reference plan files generically (not assume a single plan) to be consistent with batch mode.

## Dependencies
None.

## Adversarial Synthesis
Key risks: (1) Section naming collision — if the instruction tells the agent to add new top-level sections like "Research Findings", they may conflict with the plan's canonical structure (Goal, Metadata, Complexity Audit, etc.). Mitigation: instruct the agent to integrate findings into existing sections rather than inventing new ones. (2) Batch-mode ambiguity — the instruction must work when multiple plans are listed in `PLANS TO PROCESS`. Mitigation: reference "each plan file" rather than "the plan file". Overall risk is low; this is a single-string addition with no logic changes.

## Solution
Add an explicit instruction to the `code_researcher` prompt to update the plan file with research findings. This should be appended to `crBase` after the `DEEP_RESEARCH_DIRECTIVE` and before `resolveBaseInstructions` is called.

The instruction should:
1. Tell the agent to update each plan file with research findings
2. Integrate findings into existing plan sections (not invent new top-level sections that collide with the canonical plan structure)
3. Instruct not to truncate or delete existing plan content
4. Make it clear this is a required step, not optional

## Proposed Changes

### `src/services/agentPromptBuilder.ts` (line 853)

**Context:** The `code_researcher` handler builds `crBase` at line 853 as:
```typescript
let crBase = `You are a Code Researcher Agent.\n\n${customDeepDirective}`;
```
This is then passed to `resolveBaseInstructions` at line 855. The plan-update instruction must be appended to `crBase` before that call.

**Logic:** Append a `PHASE 5` directive to `crBase` that mirrors the `reviewer` role's plan-update instruction (line 432) but is tailored for research output. The key difference from the original plan's "suggested instruction text" is that this version integrates into existing plan sections rather than creating new top-level sections that would collide with the canonical plan structure.

**Implementation:**
Change line 853 from:
```typescript
let crBase = `You are a Code Researcher Agent.\n\n${customDeepDirective}`;
```
to:
```typescript
let crBase = `You are a Code Researcher Agent.\n\n${customDeepDirective}` +
    `\n\nPHASE 5: Plan Update — After completing the research synthesis, you MUST update each plan file listed in PLANS TO PROCESS with your findings. ` +
    `Integrate your research into the plan's existing sections: ` +
    `add findings and analysis to relevant Proposed Changes subsections, ` +
    `update the Edge-Case & Dependency Audit with newly discovered risks, ` +
    `and append a "Knowledge Gaps" subsection under the Complexity Audit if gaps were identified. ` +
    `Do NOT truncate, summarize, or delete existing plan content. ` +
    `Do NOT add new top-level sections that duplicate or conflict with the plan's canonical structure.`;
```

**Edge Cases:**
- If `resolveBaseInstructions` receives a `replace` mode override for `code_researcher`, the new instruction will be discarded. This is the same behavior as every other role's base instructions and is not a regression.
- If multiple plans are listed in `PLANS TO PROCESS`, the instruction correctly says "each plan file" to match batch semantics.

## Verification Plan

### Automated Tests
- N/A — this is a prompt text change with no testable logic. The existing test suite for `buildKanbanBatchPrompt` may need snapshot updates if it captures `code_researcher` output.

### Manual Verification
1. Open `kanban.html` and navigate to the prompts tab
2. Select the `code_researcher` role with a plan in the kanban
3. Generate the prompt and verify it includes "PHASE 5: Plan Update" text
4. Confirm the instruction references "each plan file" (not "the plan file")
5. Confirm the instruction says "Integrate your research into the plan's existing sections" (not "Add a Research Findings section")

### Recommendation
Complexity 3 → **Send to Intern**
