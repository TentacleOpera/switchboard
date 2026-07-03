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

## Epic Mode (when the target is an epic)

**Detect epic mode** when the target file is under `.switchboard/epics/`, or its contents include an auto-generated `<!-- BEGIN SUBTASKS ... -->` / `<!-- END SUBTASKS -->` block. When detected, the work below is REQUIRED and takes priority over the single-plan schema — an epic is not just a bigger plan, and reviewing it in isolation from its subtasks is a protocol violation.

### 1. Read every subtask, not just the epic
Read each subtask plan linked in the subtasks block **in full** (and the actual code they touch). You cannot reconcile subtasks you have not read. If a subtask link is broken or the file is missing, say so explicitly rather than guessing.

### 2. Cross-subtask reconciliation audit (the core of epic review)
Subtasks authored separately are frequently **contradictory, overlapping, or superseded**. For every file/symbol touched by more than one subtask, classify each finding:
- **Overlap** — two+ subtasks doing the same or duplicate work.
- **Contradiction** — incompatible designs on the same surface (e.g. two subtasks rewriting one function with different signatures; two subtasks defining the same field differently).
- **Supersession** — one subtask's approach/fields obsoleted by another (e.g. a global field replaced by a per-item variant later in the set).
- **Ordering** — subtask A must land before B (shared-file merge order, a rename/extraction others depend on, a structural move others target).
Produce a **shared-surface map** (which subtasks touch which file/symbol) and, for each contended symbol, a **merge map** describing the single reconciled end-state and which subtask contributes what. Add an **execution order** (waves) that resolves the ordering constraints.

### 3. Decide per finding: consolidate / rewrite / reorder / leave
For each overlap/contradiction/supersession, state the recommended resolution and rationale: **consolidate** overlapping subtasks into one, **rewrite** a subtask to remove a contradiction, **reorder** to satisfy a dependency, or **leave** as-is. Note the complexity of the reconciled program (which may differ from any single subtask's complexity).

### 4. Two-phase gate — RECOMMEND, then act only on approval
This is an analyze-then-act workflow, NOT a single destructive pass:
- **Phase 1 (this pass):** Write the reconciliation audit, shared-surface map, merge map, and execution order into the **epic file** (append below the subtasks block — never edit inside the auto-generated `<!-- BEGIN/END SUBTASKS -->` block). Do **NOT** edit, merge, or rewrite any subtask `.md` file yet. End by presenting the specific consolidation/rewrite proposal to the user and asking for approval.
- **Phase 2 (only after the user approves the specific plan):** Apply the approved edits. Rewriting a subtask's *body* edits that subtask file (preserving original content per CONTENT PRESERVATION). Changing the subtask *set* (merging two subtasks into one, adding a consolidated plan) must route through `assign-to-epic.js` / the epic's create path — never by hand-editing the auto-generated subtasks block, which Switchboard regenerates.

Everything in Steps below still applies to the epic file itself (Goal, Metadata, adversarial critique, recommendation). The reconciliation audit is additive to — not a replacement for — those sections.

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
- **Trigger B (all agents):** if you restructured plans into an epic during review → include `isEpic`/`epicId` links for the epic + subtask set. Trigger B applies regardless of local/remote — epic relationships span multiple files and cannot be expressed via a single card move. **Local agents writing a Trigger B-only manifest:** set `kanbanColumn: "CREATED"` (or omit the field) so the ingestor does not auto-move the card — the user moves it manually.
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
      "isEpic": false,
      "epicId": "",
      "project": "Switchboard"
    }
  ]
}
```

**Field rules:**
- `planFile` (**required**): path relative to workspace root, as stored in the DB.
  Must be `.switchboard/plans/<name>.md` for plans or `.switchboard/epics/<name>.md` for epics.
  Bare filenames (e.g. `foo.md`) are auto-resolved to `.switchboard/plans/foo.md` but the
  full path is preferred. No `..` or absolute paths.
- `planId` (recommended): must match the `**Plan ID:** <uuid>` embedded in the `.md` so identity is stable and `epicId` references resolve.
- `kanbanColumn`: validated against the board's column set. Invalid → skipped (plan stays `CREATED`).
- `fromColumn` (optional): the column the plan must currently be in for the `kanbanColumn` move to apply. Defaults to `CREATED` (the import-upgrade case). Set it to make a **forward transition from a later stage** — e.g. a remote coding agent advancing a plan `"fromColumn": "PLAN REVIEWED", "kanbanColumn": "CODED"`. If the plan is no longer in `fromColumn` (a human/host already moved it), the move is skipped by the stale-manifest guard.
- `status`: `active` | `archived` | `completed` | `deleted`.
- `isEpic` / `epicId`: `epicId` references another entry's `planId` (in-batch) or an existing DB epic. Process epics before subtasks (the ingestor sorts automatically).
- `project`: project name; resolved to `project_id` at ingest (unknown project → kept as denormalized string).

**Stale-manifest guard:** the ingestor overrides the column only when the row is currently in the entry's `fromColumn` (default `CREATED`); if the card is anywhere else — because a human/host already moved it — the column override is skipped (epic/project still applied). This lets a fresh manifest make a legitimate forward transition (e.g. `PLAN REVIEWED` → `CODED`) while a stale one is ignored. The manifest is deleted after all entries apply; idempotent if a delete is missed.

**`**Plan ID:**` embedding:** each plan `.md` must embed `**Plan ID:** <uuid>` (and epics use the `epic-<uuid>.md` filename) so `epicId` links resolve and identity is stable across re-imports. Required for Trigger B, recommended for Trigger A.
