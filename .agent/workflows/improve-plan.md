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
   - **Query active Kanban plans for dependencies (DO NOT scan the plans folder directly):**
     - Run `node .agent/skills/kanban_operations/get-state.js <workspace_id>` to retrieve all active plans grouped by Kanban column.
     - Inspect plans in **New** and **Planned** columns for potential dependencies and conflicts.
     - **Exclude plans in Completed, Intern, Lead Coder, Coder, and Reviewed columns** — these are already implemented (or in final review) and irrelevant for dependency/conflict analysis.
     - Document any cross-plan conflicts with the active plan set only.
     - **If the database query fails:** Do not fall back to unfiltered file scanning. Instead, note the uncertainty in the `## Edge-Case & Dependency Audit` section under `Dependencies & Conflicts`.
   - **After identifying dependencies**, emit them in the plan's `## Dependencies` section as one `sess_XXXXXXXXXXXXX — <topic>` line per dependency. If none, write `None`. This section is parsed by the Kanban database; the bullet inside `## Edge-Case & Dependency Audit` remains for human rationale only.

2. **Improve the plan**
   - Fill in underspecified sections.
   - Break work into clear execution steps with file paths and line numbers.
   - Ensure the plan has ALL of the following sections (add any that are missing):

   **Required Sections (in order):**

   1. **## Goal** - 1-2 sentences summarizing the objective

   2. **## Metadata** (immediately after Goal) - Must include:
      - **Tags:** Comma-separated list chosen ONLY from: frontend, backend, authentication, database, UI, UX, devops, infrastructure, bugfix, documentation, reliability, workflow, testing, security, performance, analytics
      - **Complexity:** Integer 1-10 (scoring: 1-2 Very Low, 3-4 Low, 5-6 Medium, 7-8 High, 9-10 Very High)
      - **Repo:** Bare sub-repo folder name (e.g. 'be'), omit if not applicable

   3. **## User Review Required** - Any user-facing warnings, breaking changes, or manual steps required

   4. **## Complexity Audit** - Must have subsections:
      - ### Routine - List routine, safe changes
      - ### Complex / Risky - List complex logic, state mutations, or risky changes

   5. **## Edge-Case & Dependency Audit** - Must include:
      - **Race Conditions:** Analysis
      - **Security:** Analysis
      - **Side Effects:** Analysis
      - **Dependencies & Conflicts:** Human-readable prose explaining WHY each dependency/conflict matters. Reference plans by session IDs (sess_XXXXXXXXXXXXX). Use the `kanban_operations` skill (run `node .agent/skills/kanban_operations/get-state.js <workspace_id>`) to retrieve active session IDs; if the query fails, document the uncertainty.

   6. **## Dependencies** - Machine-readable format (one per line): `sess_XXXXXXXXXXXXX — <topic>`. If no dependencies, write `None`.

   7. **## Adversarial Synthesis** - 2-3 sentence Risk Summary (e.g., "Key risks: X, Y, Z. Mitigations: A, B.").
      - **Note:** Full Grumpy and Balanced critiques are produced during planning and shown in chat for user review; only the Risk Summary is persisted to the plan file to optimize tokens. The process rigor is preserved—only the storage location changes.

   8. **## Proposed Changes** - For each target file/component:
      - ### [Target File or Component]
        - #### [MODIFY / CREATE / DELETE] `path/to/file.ext`
        - **Context:** Why this file needs changing
        - **Logic:** Step-by-step breakdown of changes
        - **Implementation:** Complete code block, unified diff, or full function rewrite without truncation
        - **Edge Cases Handled:** How the code mitigates risks

   9. **## Verification Plan** - Must include:
      - ### Automated Tests - What existing or new tests need to be run/written

   - Do not add net-new product scope unless strictly implied by the existing plan.

   **Complexity Criteria:**

   **Routine:**
   - Single-file, localized changes (text updates, button renames, CSS tweaks)
   - Reuses existing patterns (calling an already-implemented handler, adding a field to an existing struct)
   - Low risk (no architectural changes, no multi-system coordination)
   - Small scope (typically <20 lines of code per change)

   **Complex / Risky:**
   - Multi-file coordination (changes span 3+ files with tight coupling)
   - New architectural patterns (introducing new state management, new message types, new DB schema)
   - Data consistency risks (race conditions, state synchronization across systems)
   - Breaking changes (modifying core data structures, changing column definitions)

   **"Routine + Moderate" (Mixed Complexity):**
   - Use when a plan has BOTH routine and moderate components
   - Majority is routine (70%+ of changes are straightforward)
   - One or two moderate pieces that add risk but are well-scoped
   - No architectural rewrites — the moderate parts extend existing patterns

3. **Run the internal adversarial review**
   - First, produce a sharp Grumpy-style critique focused on assumptions, risks, race conditions, missing error handling, and validation gaps.
   - Immediately follow with a balanced synthesis that keeps valid concerns, rejects weak ones, and converges on the strongest execution strategy.
   - **Output:** Write the full Grumpy and Balanced critiques to the chat response for user review. In the plan file's `## Adversarial Synthesis` section, include only a 2-3 sentence Risk Summary (e.g., "Key risks: X, Y, Z. Mitigations: A, B.").

4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.
   - End with a recommendation: if complexity ≤ 6, say "Send to Coder". If complexity ≥ 7, say "Send to Lead Coder".

5. **[Optional] Generate Architectural Diagram**
   - If the plan involves service boundary changes or new services:
     - Invoke `skill: "architectural_diagrams"`
     - Generate flowchart diagram for affected services
     - Render to image and upload to associated ClickUp/Linear ticket
     - Include attachment URL in plan metadata for reference
   - Skip this step if the plan does not involve architectural changes.
