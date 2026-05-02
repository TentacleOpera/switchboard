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

1. **Load the plan**
   - Read the target plan file and treat it as the single source of truth.
   - Read the actual code for any services, utilities, or modules referenced by the plan.
   - [OPTIONAL] If dependency check is enabled via Prompt Controls checkbox:
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
