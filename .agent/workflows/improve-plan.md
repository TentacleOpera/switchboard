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
   - Scan related plans or Kanban state for conflicts, ordering dependencies, or overlap.

2. **Improve the plan**
   - Fill in underspecified sections.
   - Break work into clear execution steps.
   - Separate routine work from complex or risky work.
   - Do not add net-new product scope unless it is strictly implied by the existing plan.

3. **Run the internal adversarial review**
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps.
   - Immediately follow with a balanced synthesis that keeps valid concerns, rejects weak ones, and converges on the strongest execution strategy.

4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.

5. **Complete the workflow**
   - Call `complete_workflow_phase` with `workflow: "improve-plan"`, `phase: 1`, and the updated plan as the artifact.
   - End by recommending whether the plan should go to the Coder agent or the Lead Coder.
