---
name: improve-plan
description: Deep planning, dependency checks, and adversarial review
---

# Improve Plan

Use this workflow to strengthen an existing feature plan in a single fluid pass.

## Critical Constraints
- **NO IMPLEMENTATION**: You are strictly FORBIDDEN from modifying any project source files. Your ONLY permissible write action is updating the existing Feature Plan document.
- **CONTENT PRESERVATION**: You are FORBIDDEN from deleting original implementation details, code blocks, prose, or goal statements. Append and refine; do not truncate. This includes product scope explicitly stated in the plan's Goal or Problem Description — you must not narrow or remove supported scenarios (e.g. multi-root workspaces) even if the current session is single-repo.
- **SESSION vs PRODUCT SCOPE**: Session directives (e.g. "single-repo", "skip compilation", "skip tests") constrain HOW you verify and organize the plan, not WHAT the plan covers. Do not conflate repo structure constraints with product feature requirements. If the plan targets multi-root workspaces, you must preserve and improve that scope regardless of the current session's repo configuration.
- **SINGLE PASS**: Complete enhancement, dependency checks, adversarial critique, balanced synthesis, and plan update in one continuous response.

## Target is an feature? Use improve-feature instead

If the target file is under `.switchboard/features/` or contains an auto-generated `<!-- BEGIN SUBTASKS ... -->` block, this is an **feature**, not a single plan. Stop and use the **`improve-feature`** skill — it improves every subtask and is authorised to restructure the set (merge/delete/rewrite/split). This `improve-plan` workflow is for a single plan and is deliberately non-destructive, which is the wrong contract for an feature.

## Steps

1. **Load the plan**
   - Read the target plan file and treat it as the single source of truth.
   - Read the actual code for any services, utilities, or modules referenced by the plan.

2. **Improve the plan**
   - Fill in underspecified sections and break work into clear execution steps with file paths and line numbers.
   - Ensure the plan has ALL of the following sections (add any that are missing):

   **Required Sections (in order):**
   1. **## Goal** - 1-2 sentences summarizing the objective, followed by any core problem, background, or root-cause analysis (always preserve and do not drop existing analysis)
   2. **## Metadata**
      - **Tags:** [frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library]
      - Do NOT invent tags outside the allowed list. If no tags apply, write **Tags:** none
      - **Complexity:** 1-10
      - **Repo:** Bare sub-repo folder name if applicable
   3. **## User Review Required**
   4. **## Complexity Audit**
      - **### Routine** — bullet points or plain text listing routine aspects
      - **### Complex / Risky** — bullet points or plain text listing complex/risky aspects (or "- None" if empty)
      
      **Recommended format** (parser is flexible):
      ```markdown
      ## Complexity Audit

      ### Routine
      - [routine aspect 1]
      - [routine aspect 2]

      ### Complex / Risky
      - [complex aspect 1]
      - [or "- None" if no complex aspects]
      ```
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
   - You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.

   **Scoring Guide:**
   - 1-2: Very Low — trivial config/copy changes
   - 3-4: Low — routine single-file changes
   - 5-6: Medium — multi-file changes, moderate logic
   - 7-8: High — new patterns, complex state, security-sensitive
   - 9-10: Very High — architectural changes, new framework integrations

3. **Run the internal adversarial review**
    - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps. Adopt a dramatic "Grumpy Architect" voice — incisive, specific, and theatrical. This voice is part of the planner's quality standard and must be preserved regardless of output-compression directives.
   - Immediately follow with a balanced synthesis that keeps valid concerns, rejects weak ones, and converges on the strongest execution strategy.
   - **Output:** Write the full Grumpy and Balanced critiques to the chat response as formatted markdown — do not only write them to the plan file. The user must be able to read the critique directly in chat without opening the plan. In the plan file's `## Adversarial Synthesis` section, include only a 2-3 sentence Risk Summary (e.g., "Key risks: X, Y, Z. Mitigations: A, B."). **Output the adversarial critique exactly once. Do not repeat it.**

4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.
   - End with a recommendation based on complexity:
     - If complexity is 1-3 → "Send to Intern"
     - If complexity is 4-6 → "Send to Coder"
     - If complexity is 7-10 → "Send to Lead Coder"

## Post-Review Board State

1. **Trigger Model**: This `improve-plan` workflow is triggered automatically when a card arrives in the "PLAN REVIEWED" column (which has `autobanEnabled: true` and `role: 'planner'`). The card is already in the "PLAN REVIEWED" column when this workflow runs. Do NOT instruct the user to move it there.
2. **Review Complete**: After completing the adversarial review and plan update, the card stays in the "PLAN REVIEWED" column. The activity light clears on the next plan-file edit. The user advances the card to the next pipeline stage (e.g. dispatches a coder) manually when ready.
3. **Plan Metadata**: Do NOT write a `**Plan ID:**` line — it is never parsed. The importer assigns the ID (a fresh UUID, or a feature's filename UUID) and keys plan identity by the file **path**; a hand-written Plan ID is ignored and drifts from the real DB-assigned one.
4. **Feature Relationships**: Feature relationships are carried by `**Feature:** <feature-plan-id>` and `**Project:** <name>` lines written directly in each plan `.md` — the plan watcher applies these on import with apply-if-empty semantics. If you restructured plans into a feature during review, recommend invoking the `create-feature-from-plans` skill (which runs `create-feature.js` to handle DB update, subtask linking, feature file write, and board refresh atomically) AFTER the review is finished and the user has approved. Do NOT invoke it mid-review.

