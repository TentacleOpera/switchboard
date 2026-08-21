# Enforce Mandatory Split Gate in improve-plan Protocol

## Goal

The improve-plan protocol's scope/split check (Step 2) is currently a soft recommendation that planners can rationalize past. A recent case saw an 8-phase, 42-step, 6+ file mega-plan pass through improve-plan without being split, because the planner (a) conflated sequential dependency with indivisibility, (b) treated the split check as a skippable checkbox on the way to "real" technical work, and (c) scored complexity by the hardest single step rather than aggregate scope. The fix promotes the split check to a mandatory gate that runs before code reading, halts the pass if triggered, and adds anti-rationalization language plus a complexity-scoring correction.

### Root Cause Analysis

The protocol itself enables all three failure modes:

1. **Positioning**: Step 2 runs *after* "Load the plan" (Step 1), which includes reading the actual code. Reading code first primes the planner to see everything as "one coherent change" — by the time the split check runs, the planner has already mentally committed to the plan as a unit.

2. **Soft language**: Step 2 says *"the recommendation is the action, the user decides"* and *"This skill is single-plan and non-destructive, so it cannot retroactively split mid-improve."* The protocol explicitly gives the planner permission to skip the split. In unattended mode it's further downgraded: *"Step 2 still applies as a recommendation, not as a write."*

3. **No anti-rationalization guardrails**: The protocol says "check whether the plan covers 3+ distinct deliverables or 2+ independently-shippable phases" but says nothing about the three specific rationalization patterns that occurred:
   - Interpreting sequential dependency as indivisibility
   - Treating "improve mode" as exempt from the split check
   - Scoring complexity by the hardest step rather than total scope

4. **Scoring guide ambiguity**: The scoring guide says "7-8: High — new patterns, complex state" but never says "score by aggregate scope across all steps and files." A 42-step plan across 6+ files gets scored as a 6 because the hardest individual step is a 5.

## Metadata

**Complexity:** 3
**Tags:** refactor, docs
**Project:** Browser Switchboard

## User Review Required

This plan modifies a workflow protocol file (`.agents/protocols/improve-plan/SKILL.md`) and fixes stale path references in `CLAUDE.md`. Per the consultation mode rules, no implementation will occur until the user has reviewed this plan and explicitly instructed to proceed.

## Complexity Audit

### Routine
- Editing Markdown protocol/documentation files with text changes
- Reordering existing steps (renumber Step 2 to Step 0, shift Steps 3-6 to 2-5)
- Adding new prose sections (anti-rationalization language, scoring clarification)
- Find-replace stale path references in CLAUDE.md (`.switchboard/protocols/` → `.agents/protocols/`)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None — this is a static protocol file, not runtime code.
- **Security**: None.
- **Side Effects**: Changing the protocol affects all future improve-plan runs. Existing plans already in the pipeline are unaffected (they were improved under the old protocol).
- **Dependencies & Conflicts**: The CLAUDE.md file references `.switchboard/protocols/improve-plan/SKILL.md` as the protocol path (6 occurrences), but that directory does not exist — only `.agents/protocols/improve-plan/SKILL.md` exists. AGENTS.md correctly references `.agents/protocols/`. The canonical path is `.agents/protocols/`; CLAUDE.md's references are stale and must be fixed (see Change 6 below). This plan is independent of the routing-behavior plan — the workflow becomes mode-agnostic (check, halt, return) and the routing plan handles what happens to the return.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Making the gate too aggressive could halt the workflow on plans that are large but genuinely single-scope, frustrating users who want a quick improve pass. Mitigation: the gate uses the existing qualitative rules (3+ deliverables, 2+ independently-shippable phases) — no new numeric thresholds — so the trigger criteria are unchanged; only the response changes from soft to hard. (2) The gate is terminal — if it triggers, the plan is not improved at all, which means a plan that needs both splitting AND improvement gets neither in one pass. Mitigation: this is by design — the user splits first, then each split plan gets its own improve pass. (3) Step renumbering creates stale in-text references (line 17 "Step 4", line 104 "Step 5") that must be updated alongside the structural move. Mitigation: Change 1 now explicitly lists both references and their new numbers. (4) CLAUDE.md's stale `.switchboard/protocols/` path references would cause the verification check to fail. Mitigation: Change 6 fixes all 6 occurrences via find-replace.

## Proposed Changes

### `.agents/protocols/improve-plan/SKILL.md`

#### Change 1: Promote split check to Step 0 (before code reading)

**Current structure:**
```
1. Load the plan (includes reading code)
2. Assess scope — flag if split needed
3. Improve the plan
...
```

**New structure:**
```
0. Scope gate — MANDATORY split check (before reading code)
1. Load the plan
2. Improve the plan
...
```

Move the scope assessment to **before** "Load the plan." The planner counts phases, deliverables, and independently-shippable units by scanning the plan's structure (headings, step counts, file references) — not by reading the actual source code. Reading code first primes the planner to see everything as "one coherent change"; the gate must run before that priming occurs.

**Step renumbering:** Moving Step 2 to Step 0 shifts all subsequent steps down by 1:
- Old Step 3 (Improve) → New Step 2
- Old Step 4 (Challenge) → New Step 3
- Old Step 5 (Adversarial) → New Step 4
- Old Step 6 (Update) → New Step 5

Two in-text step references must be updated:
- **Line 17** (Critical Constraints): "the architecture challenge (Step 4)" → "(Step 3)"
- **Line 104** (Challenge step body): "proceed to Step 5" → "proceed to Step 4"

#### Change 2: Make the split check a hard gate

Replace the current Step 2 language ("the recommendation is the action, the user decides", "This skill is single-plan and non-destructive, so it cannot retroactively split mid-improve") with hard-gate language:

**If the split check triggers (3+ distinct deliverables or 2+ independently-shippable phases):**

- **HALT. Do not proceed to improvement.** Do not read source code. Do not run the architecture review or adversarial critique.
- **Propose split boundaries.** Identify the deliverable/phase boundaries and write a brief split proposal: which sections of the current plan become which new plan files, with a one-line rationale per boundary.
- **Return the proposal.** The pass is terminal — the improve-plan workflow does not resume after the split proposal. If the plan is later split into separate files, each new file gets its own improve-plan pass.

**If the split check does NOT trigger:** Proceed to Step 1 (Load the plan) and continue the workflow as before.

The workflow is mode-agnostic. It checks, halts, and returns. What happens to the return (chat, orchestrator inbox, plan marking, etc.) is handled by the runtime/automation system, not by this workflow.

#### Change 3: Add anti-rationalization language

Add a subsection within Step 0 titled **"Anti-rationalization guardrails"** that explicitly calls out the three patterns that caused the original failure:

1. **Dependency ordering ≠ indivisibility.** Sequential phases ("can't do B until A exists") are a dependency *ordering*, not evidence that the work is a single deliverable. If each phase is independently shippable (could be released on its own once its predecessor is done), the split check triggers. "Interdependent" is not "indivisible."

2. **"Improve mode" does not exempt the split check.** Receiving an already-mega-plan is the *reason* to split, not a reason to skip the split check. The fact that the plan was already oversized when you received it means the split check is *more* relevant, not less. Do not focus on technical correctness (verifying code references, finding naming errors) at the expense of the scope check — the scope check runs first precisely so it cannot be crowded out by detail work.

3. **Complexity is scored by aggregate scope, not the hardest single step.** A 42-step plan across 6+ files is a 7-8 by the scoring guide ("multi-file coordination"), regardless of whether any individual step is a 5. Score the forest, not the tree.

#### Change 4: Fix the complexity scoring guide

Add an explicit rule to the **Scoring Guide** section (currently lines 92-97):

> **Aggregate scope rule:** Score by the total scope of the plan — all steps, all files, all phases — not by the difficulty of the hardest individual step. A plan with 40+ steps across 5+ files is at minimum a 7, even if every individual step is routine. The complexity score reflects the coordination burden of the whole plan, not the peak difficulty of any single task.

#### Change 5: Remove split-check language from the Unattended runs section

The current "Unattended runs" section (lines 126-142) says *"Step 2 still applies as a recommendation, not as a write."* Delete that sentence. The split gate is already defined in Step 0 as mode-agnostic — it does not need a second, mode-specific description. The remaining unattended constraints (don't touch sibling files, write the plan file once at the end) stay as-is. What happens to the gate's return in unattended mode is not this workflow's concern.

#### Change 6: Fix stale protocol path references in CLAUDE.md

CLAUDE.md references `.switchboard/protocols/<name>/SKILL.md` in 6 places (lines 54, 93, 114, 116, 127, 130). This directory does not exist — the canonical protocols live at `.agents/protocols/<name>/SKILL.md` (matching AGENTS.md). Replace all 6 occurrences of `.switchboard/protocols/` with `.agents/protocols/` in CLAUDE.md. This is a straightforward find-replace with no semantic change — the paths already point to the same protocol files, just via a stale directory name.

### `CLAUDE.md`

- **Change 6** (described above): find-replace `.switchboard/protocols/` → `.agents/protocols/` across all 6 occurrences.

## Verification Plan

### Automated Tests
None — this plan modifies Markdown protocol/documentation files only. No runtime code is changed, so no automated tests apply.

### Manual Verification
1. Read the modified `.agents/protocols/improve-plan/SKILL.md` and confirm:
   - Step 0 (scope gate) appears before Step 1 (Load the plan)
   - The gate language uses "HALT" / "do not proceed" — no soft "recommend" or "flag" language
   - No mode-adaptive branching in the **split gate itself** (no "if attended" / "if unattended" conditionals within Step 0). The Unattended section may still exist for other constraints — this check applies only to the gate.
   - Anti-rationalization guardrails are present with all three patterns
   - Scoring guide includes the aggregate scope rule
   - Unattended section no longer contains split-check language (remaining constraints untouched)
   - In-text step references updated: line 17 says "(Step 3)" not "(Step 4)", line 104 says "Step 4" not "Step 5"
   - Steps are numbered 0, 1, 2, 3, 4, 5 (no gaps, no duplicates)
2. Confirm no other copy of the protocol exists that needs updating (check `.switchboard/protocols/` — currently does not exist, but verify)
3. Confirm CLAUDE.md references to the protocol path now say `.agents/protocols/` (not `.switchboard/protocols/`). Confirm AGENTS.md references are unchanged (already correct).

### Scenario Test (mental walkthrough)
- **Scenario A:** An 8-phase, 42-step plan enters improve-plan. Step 0 counts 8 phases → gate triggers → planner halts, proposes 3 split boundaries, returns proposal. Plan is NOT improved. Correct.
- **Scenario B:** A 3-step single-file plan enters improve-plan. Step 0 counts 1 deliverable, 1 phase → gate does not trigger → planner proceeds to Step 1. Correct.
- **Scenario C:** A 4-phase plan where phases are sequential dependencies enters improve-plan. Step 0 counts 4 independently-shippable phases → gate triggers (anti-rationalization guardrail #1 prevents "but they're interdependent" excuse). Correct.
