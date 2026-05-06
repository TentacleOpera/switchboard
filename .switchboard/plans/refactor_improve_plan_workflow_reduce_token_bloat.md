# Refactor improve-plan.md Workflow to Reduce Token Bloat

## Goal
Remove token bloat from the improve-plan.md workflow file by condensing verbose educational instructions while preserving the strict Markdown formatting templates and criteria inline, reducing the file from ~100 lines to ~65 lines.

## Metadata
**Tags:** workflow, documentation, reliability
**Complexity:** 3

## User Review Required
None - this is a documentation-only change with no code execution impact

## Complexity Audit
### Routine
- Condensing educational content from workflow file into dense matrices
- Preserving strict Markdown templates for required sections

### Complex / Risky
- None - this is a pure documentation refactoring with no code changes

## Edge-Case & Dependency Audit
- **Race Conditions:** None - documentation changes are not concurrent
- **Security:** None - no code execution or security-sensitive changes
- **Side Effects:** None - workflow behavior remains identical, only token efficiency improves
- **Dependencies & Conflicts:** Kanban query returned 0 active plans in New/Planned columns. No conflicts with this documentation-only change.

## Dependencies
None

## Adversarial Synthesis
Key risks: Over-condensation removes structural Markdown templates causing agent formatting drift; removing the allowed tags list causes tag hallucination; pointing to an external complexity skill file creates an expensive tool-call roundtrip on every execution. Mitigations: Keep the strict Markdown hierarchy (`##`, `###`) explicitly in the prompt; keep the `Tags` allowed list inline; condense the 19-line complexity lecture into a dense 4-line matrix inline to avoid the need for an external file fetch.

## Proposed Changes

### [Target File] `.agent/workflows/improve-plan.md`
- **Context:** Current workflow file contains ~100 lines with significant educational bloat that agents read on every execution
- **Logic:**
  1. Remove verbose "Complexity Criteria" lecture (lines 71-89)
  2. Replace with a dense, 4-line inline complexity matrix (Routine, Complex, Mixed)
  3. Condense "Required Sections" by removing verbose prose while explicitly preserving the Markdown hierarchy (`## Goal`, `### Routine`, etc.)
  4. Ensure the `Tags` allowed list is explicitly stated inline
  5. Preserve all Critical Constraints and execution steps unchanged
- **Implementation:**

```markdown
---
description: Deep planning, dependency checks, and adversarial review
---

# Improve Plan

Use this workflow to strengthen an existing feature plan in a single fluid pass.

## Critical Constraints
- **NO IMPLEMENTATION**: You are strictly FORBIDDEN from modifying any project source files. Your ONLY permissible write action is updating the existing Feature Plan document.
- **CONTENT PRESERVATION**: You are FORBIDDEN from deleting original implementation details, code blocks, prose, or goal statements. Append and refine; do not truncate.
- **SINGLE PASS**: Complete enhancement, dependency checks, adversarial critique, balanced synthesis, and plan update in one continuous response.

## Steps

1. **Load the plan and verify dependencies**
   - Read the target plan file and treat it as the single source of truth.
   - Read the actual code for any services, utilities, or modules referenced by the plan.
   - Query active Kanban plans for dependencies using `kanban_operations` skill: run `node .agent/skills/kanban_operations/get-state.js <workspace_id>`. Inspect New and Planned columns for conflicts; exclude Completed, Intern, Lead Coder, Coder, and Reviewed columns. If query fails, note uncertainty in Edge-Case & Dependency Audit.
   - Emit dependencies in plan's `## Dependencies` section as `sess_XXXXXXXXXXXXX — <topic>` lines, or `None` if none.

2. **Improve the plan**
   - Fill in underspecified sections and break work into clear execution steps with file paths and line numbers.
   - Ensure the plan has ALL of the following sections (add any that are missing):

   **Required Sections (in order):**
   1. **## Goal** - 1-2 sentences summarizing the objective
   2. **## Metadata**
      - **Tags:** [frontend, backend, authentication, database, UI, UX, devops, infrastructure, bugfix, documentation, reliability, workflow, testing, security, performance, analytics]
      - **Complexity:** 1-10
      - **Repo:** Bare sub-repo folder name if applicable
   3. **## User Review Required**
   4. **## Complexity Audit**
      - ### Routine
      - ### Complex / Risky
   5. **## Edge-Case & Dependency Audit**
      - **Race Conditions**, **Security**, **Side Effects**, **Dependencies & Conflicts**
   6. **## Dependencies**
      - `sess_XXXXXXXXXXXXX — <topic>` format
   7. **## Adversarial Synthesis**
      - 2-3 sentence Risk Summary
   8. **## Proposed Changes**
      - ### [Target File]
        - Context, Logic, Implementation, Edge Cases
   9. **## Verification Plan**
      - ### Automated Tests

   **Complexity Criteria:**
   - **Routine (1-4):** Single-file, localized changes. Reuses existing patterns. Low risk. Small scope.
   - **Complex/Risky (7-10):** Multi-file coordination. New architectural patterns. Data consistency risks. Breaking changes.
   - **Mixed (5-6):** Majority routine but with one or two moderate, well-scoped risks extending existing patterns.
   - Do not add net-new product scope unless strictly implied by the existing plan.

3. **Run the internal adversarial review**
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps.
   - Immediately follow with a balanced synthesis that keeps valid concerns, rejects weak ones, and converges on the strongest execution strategy.
   - **Output:** Write the full Grumpy and Balanced critiques to the chat response for user review. In the plan file's `## Adversarial Synthesis` section, include only a 2-3 sentence Risk Summary (e.g., "Key risks: X, Y, Z. Mitigations: A, B.").

4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.
   - End with a recommendation: if complexity ≤ 6, say "Send to Coder". If complexity ≥ 7, say "Send to Lead Coder".
```

- **Edge Cases Handled:** All critical execution instructions preserved including field specifications and column exclusion rules. Strict Markdown formatting templates restored to prevent agent drift.

## Verification Plan
- ### Automated Tests
  - [x] Run the refactored workflow against a test plan to ensure it executes correctly
  - [x] Verify that the refactored workflow file contains all Critical Constraints
  - [x] Verify that all 4 execution steps are present and complete
  - [x] Verify that field specifications and structural markdown are preserved inline
  - [x] Compare line count reduction (target: ~65 lines, down from ~100. Actual: 67 lines)

## Review Notes
**Review Status:** Code Reviewed and Verified
**Review Findings:**
- The initial review highlighted that condensing required sections into a comma-separated paragraph removed the structural Markdown template, risking formatting drift across agents.
- The plan to reference an external `complexity_scoring.md` file was abandoned because triggering a file search tool call would cost significantly more tokens and latency than simply preserving a 4-line matrix inline.
- `improve-plan.md` has been successfully updated to balance explicit template structure with prose condensation. Line count sits at 67.
- The plan is ready for final delivery.
