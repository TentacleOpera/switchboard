---
description: Add instruction to improve-plan.md to output adversarial critique only once
---

# Plan: Add Adversarial Critique Once Instruction to improve-plan.md

## Goal
Add an explicit instruction to the improve-plan.md workflow file that the adversarial critique must be output ONCE and never repeated under any circumstances.

## Metadata
- **Tags:** workflow, documentation
- **Complexity:** 1
- **Repo:** switchboard

## User Review Required
No

## Complexity Audit

### Routine
- Single-line addition to existing workflow documentation
- No code changes required
- No dependencies or side effects

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None
- **Security:** None
- **Side Effects:** None
- **Dependencies & Conflicts:** None

## Dependencies
None

## Adversarial Synthesis
Key risks: None. This is a trivial documentation change with no technical risk.

## Proposed Changes

### .agent/workflows/improve-plan.md
- **Context:** Step 3 currently instructs to output the adversarial critique but doesn't explicitly forbid repetition
- **Logic:** Add a clear constraint that the critique must be output ONCE and never repeated
- **Implementation:** Add the instruction to the bullet points in step 3, specifically to the "**Output:**" line
- **Edge Cases:** None

**Specific change:**
In step 3, modify the "**Output:**" line to include: "Output the adversarial critique ONCE only. Never repeat it a second time under any circumstances."

## Verification Plan
- Read the modified improve-plan.md file
- Confirm the new instruction is present in step 3
- Confirm the instruction clearly states "ONCE only" and "never repeat"

## Implementation Status
**COMPLETED** - The instruction has been added to improve-plan.md at line 77:
"**Output the adversarial critique ONCE only. Never repeat it a second time under any circumstances.**"
