---
description: Deep planning, dependency checks, and adversarial review
---

# Improve Plan

Use this workflow to strengthen an existing feature plan in a single fluid pass.

## Critical Constraints
- **NO IMPLEMENTATION**: You are strictly FORBIDDEN from modifying any project source files. Your ONLY permissible write action is updating the existing Feature Plan document.
- **CONTENT PRESERVATION**: You are FORBIDDEN from deleting original implementation details, code blocks, prose, or goal statements. Append and refine; do not truncate. This includes product scope explicitly stated in the plan's Goal or Problem Description — you must not narrow or remove supported scenarios (e.g. multi-root workspaces) even if the current session is single-repo.
- **SESSION vs PRODUCT SCOPE**: Session directives (e.g. "single-repo", "skip compilation", "skip tests") constrain HOW you verify and organize the plan, not WHAT the plan covers. Do not conflate repo structure constraints with product feature requirements. If the plan targets multi-root workspaces, you must preserve and improve that scope regardless of the current session's repo configuration.
- **SINGLE PASS**: Complete enhancement, dependency checks, adversarial critique, balanced synthesis, and plan update in one continuous response.

## Target is a feature? Use improve-feature instead

If the target file is under `.switchboard/features/` or contains an auto-generated `<!-- BEGIN SUBTASKS ... -->` block, this is a **feature**, not a single plan. Stop and use the **`improve-feature`** workflow — it improves every subtask and is authorised to restructure the set (merge/delete/rewrite/split). This `improve-plan` workflow is for a single plan and is deliberately non-destructive, which is the wrong contract for a feature.

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

## Plan-Import Manifest (Trigger A — column transition)

After updating the plan `.md` file(s), the reviewed plan should land in the "PLAN REVIEWED" kanban column.

**Local agents (Switchboard extension running):** Do NOT write a manifest for the column transition. Simply update the plan file and inform the user that the review is complete. The user will move the card to "PLAN REVIEWED" in the extension UI when ready — that card move is what triggers the next pipeline stage.

**Remote agents (no Switchboard extension access):** Emit a **plan-import manifest** so the extension ingests the column transition on its next scan. To determine if you are remote: check whether `.switchboard/api-server-port.txt` exists in the workspace root (walk up from your current directory). If it does not exist, you are remote.

**When to emit:**
- **Trigger A (remote only):** you have adversarially reviewed a plan → set `kanbanColumn: "PLAN REVIEWED"`.
- **Trigger B (all agents):** if you restructured plans into an feature during review → include `isFeature`/`featureId` links for the feature + subtask set. Trigger B applies regardless of local/remote — feature relationships span multiple files and cannot be expressed via a single card move. **Local agents writing a Trigger B-only manifest:** set `kanbanColumn: "CREATED"` (or omit the field) so the ingestor does not auto-move the card — the user moves it manually.
- Pure plan creation with no review and no grouping → no manifest.

**Location:** `.switchboard/plans/manifest.json` (one batch file per workspace, covering all plans this run produced/reviewed). Write it **last**, after all `.md` files.

**v1 schema:**
```json
{
  "version": 1,
  "plans": [
    {
      "planFile": ".switchboard/plans/feature_plan_20260630_foo.md",
      "planId": "550e8400-e29b-41d4-a716-446655440000",
      "kanbanColumn": "PLAN REVIEWED",
      "status": "active",
      "isFeature": false,
      "featureId": "",
      "project": "Switchboard"
    }
  ]
}
```

**Field rules:**
- `planFile` (**required**): path relative to workspace root, as stored in the DB.
  Must be `.switchboard/plans/<name>.md` for plans or `.switchboard/features/<name>.md` for features.
  Bare filenames (e.g. `foo.md`) are auto-resolved to `.switchboard/plans/foo.md` but the
  full path is preferred. No `..` or absolute paths.
- `planId` (recommended): must match the `**Plan ID:** <uuid>` embedded in the `.md` so identity is stable and `featureId` references resolve.
- `kanbanColumn`: validated against the board's column set. Invalid → skipped (plan stays `CREATED`).
- `fromColumn` (optional): the column the plan must currently be in for the `kanbanColumn` move to apply. Defaults to `CREATED` (the import-upgrade case). Set it to make a **forward transition from a later stage** — e.g. a remote coding agent advancing a plan `"fromColumn": "PLAN REVIEWED", "kanbanColumn": "CODED"`. If the plan is no longer in `fromColumn` (a human/host already moved it), the move is skipped by the stale-manifest guard.
- `status`: `active` | `archived` | `completed` | `deleted`.
- `isFeature` / `featureId`: `featureId` references another entry's `planId` (in-batch) or an existing DB feature. Process features before subtasks (the ingestor sorts automatically).
- `project`: project name; resolved to `project_id` at ingest (unknown project → kept as denormalized string).

**Stale-manifest guard:** the ingestor overrides the column only when the row is currently in the entry's `fromColumn` (default `CREATED`); if the card is anywhere else — because a human/host already moved it — the column override is skipped (feature/project still applied). This lets a fresh manifest make a legitimate forward transition (e.g. `PLAN REVIEWED` → `CODED`) while a stale one is ignored. The manifest is deleted after all entries apply; idempotent if a delete is missed.

**`**Plan ID:**` embedding:** each plan `.md` must embed `**Plan ID:** <uuid>` (and features use the `feature-<uuid>.md` filename) so `featureId` links resolve and identity is stable across re-imports. Required for Trigger B, recommended for Trigger A.
