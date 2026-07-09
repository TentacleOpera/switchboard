---
name: group-into-features
description: Group loose Switchboard plans into features — scan pre-coding columns, cluster by capability, propose all groupings for one approval, then create features via create-feature.js
allowed-tools: Bash
---

# Skill: Group Into Features

You are grouping loose Switchboard plans into features. Follow this flow exactly — do not create any feature before the user approves.

## When to Use

Triggered when the user asks to "group plans into a feature", "organise loose plans into features", or "suggest feature groupings", OR by clicking the **Suggest Features** board button (which copies this skill's text with the workspace root injected).

If the user already knows which plans to group (no discovery needed), use `create-feature-from-plans` instead — it skips the scan/propose/confirm flow and goes straight to creation.

## Flow

### 1. SCAN

Read the board snapshot:

```
cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md
```

Scope: CREATED and PLAN REVIEWED columns only.
Ignore BACKLOG and all post-coding columns.

Each plan line ends with an HTML comment, e.g.:
```
- [.switchboard/plans/foo.md](...) — Foo <!-- planId:abc-123 -->
- [.switchboard/features/feature-def.md](...) — Bar Feature <!-- planId:def-456 feature -->
- [.switchboard/plans/baz.md](...) — Baz <!-- planId:ghi-789 subtask-of:"Bar Feature" -->
```

Skip lines tagged `feature` (they are features) or `subtask-of:...` (already assigned).
Use the `planId:` value from the comment — NOT the filename — when calling create-feature.js.
(A path under .switchboard/features/ also indicates a feature, but subtask detection
requires the subtask-of tag — do not rely on filenames alone.)

### 1a. PROJECT SCOPE

The active project filter is injected above as `{{ACTIVE_PROJECT_FILTER}}`.

- If a project name is injected: only consider plans tagged `project:"<that name>"`.
- If no project name is injected (empty, `__unassigned__`, or the literal placeholder): ignore all plans that have a `project:"..."` tag — only untagged plans are candidates.

### 2. READ PLAN BODIES

For each candidate plan in scope, read the full plan file.
Extract: goal, problem summary, dependencies, tags.
Use this — not just titles — to determine groupings.
Read plans in parallel where possible. If >25 candidates, first-pass cluster by
title then deep-read within each cluster.

### 3. PROPOSE (single message, all groups at once)

Group by underlying capability theme, not by surface keyword.
Cross-provider plans that address the same capability go into one feature.
Minimum 2 plans per feature. Single-plan "groups" go in the Standalone section.
Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.

**Cross-column warning:** If a proposed feature contains plans from different
kanban columns (e.g. one CREATED + one PLAN REVIEWED), you MUST flag this
prominently in the proposal with a **⚠ CROSS-COLUMN** warning. Explain:
- The CREATED plan(s) have NOT been plan-reviewed yet.
- If the feature is dragged to a coder column, the CREATED subtask(s) will
  skip PLAN REVIEW entirely and go straight to coding without refinement.
- **To fix this after feature creation:** select the feature card on the
  kanban board and press the **Replan** button (the re-plan icon in the
  PLAN REVIEWED column header). This sends the CREATED subtasks to the
  planner agent for `improve-plan` refinement, moving them to PLAN REVIEWED.
- Only once all subtasks are in PLAN REVIEWED should the feature be dragged
  to a coder column.

For each proposed feature, write:
- Feature name
- Goal: 2-4 sentences describing what the feature achieves, what problem it
  solves, and why these plans are grouped together.
- How the Subtasks Achieve This: one bullet per member plan explaining what
  it does and how it contributes to the feature's goal. Format:
    - **Plan Name**: <what it does and how it contributes>
- Dependencies & sequencing: note any ordering constraints between subtasks
  (e.g. "Subtask A must land before Subtask B can be tested") and any
  cross-subtask dependencies. If there are none, state "No hard ordering
  constraints; subtasks can be executed in parallel."
- Member plans with planId, one-line summary, and current kanban column

List genuinely standalone plans separately. Then stop and wait.

### 4. CONFIRM

Wait for user approval or edits. Do not touch the database until confirmed.

### 5. EXECUTE

For each approved group, pass the Goal text as the description argument.
Escape any double quotes in the Goal text (replace " with \") or rephrase to
avoid them, so the bash command does not break. Also avoid $, backticks, and
backslashes in the Goal text — these are shell metacharacters inside double quotes.

```bash
node .agents/skills/kanban_operations/create-feature.js "<feature name>" '["planId1","planId2",...]' "{{WORKSPACE_ROOT}}" "<goal text with escaped quotes>"
```

The description becomes the ## Goal section in the feature file.
After all features are created, write the ## How the Subtasks Achieve This section
and the ## Dependencies & sequencing section into each feature file manually (the
create-feature script only writes the Goal).
Use the text from your step 3 proposal — paste the How the Subtasks Achieve This
section between the Goal and the `<!-- BEGIN SUBTASKS -->` marker, then paste the
Dependencies & sequencing section immediately after the Subtasks block. Both
sections are preserved by _regenerateFeatureFile on subsequent subtask changes, so
they only need to be written once.

**Cross-column note in the feature file:** If the feature has subtasks in
different kanban columns (e.g. some CREATED, some PLAN REVIEWED), add a
**⚠ Cross-Column Review Note** section immediately after the Subtasks block
(before Dependencies & sequencing). Write:

> This feature contains subtasks in different kanban columns. The subtasks
> in CREATED have NOT been plan-reviewed yet. Before dragging this feature
> to a coder column, select the feature on the kanban board and press the
> **Replan** button (re-plan icon in the PLAN REVIEWED column header) to
> send the CREATED subtasks to the planner for `improve-plan` refinement.
> Only review/refine the CREATED subtasks — the PLAN REVIEWED subtasks have
> already been reviewed.

This note is preserved by `_regenerateFeatureFile` along with the other
manual sections.

To add more plans to a feature later, use assign-to-feature.js with the feature planId from the create-feature.js output.

### 6. BACKLOG (optional, after execution)

Ask the user: "Would you like me to analyse the BACKLOG for feature groupings too?"
Do NOT re-read the board or inspect the BACKLOG column yourself.
If the user says yes, repeat steps 1-5 scoped to the BACKLOG column.
If the user says no or does not respond, stop.

## Notes

- Feature creation updates the Switchboard board and writes a `.switchboard/features/` file. It does NOT sync to Linear/ClickUp.
- The `create-feature.js` / `assign-to-feature.js` verb scripts are documented in `.agents/skills/kanban_operations/SKILL.md`.
- The confirm gate is load-bearing **in interactive mode**: never create any feature before the user approves. Unattended mode's authorization comes from the user pressing Start orchestrator.

## Unattended mode (orchestration)

This section applies ONLY when the invoking prompt contains the directive `UNATTENDED=true` (which the Orchestration kickoff prompt injects). It is the explicit, documented exception to the confirm gate above.

- Follow steps 1, 1a, 2, 3 as written, but step 3's proposal is written to the reply for the session log, not for approval; **skip step 4 (CONFIRM) entirely** and proceed to step 5 EXECUTE immediately. Never skip step 4 outside unattended mode.
- After EXECUTE: the **Miscellaneous sweep**. Every in-scope plan that ended up standalone (including the PROPOSE step's "Standalone" section) is assigned to a feature named `Miscellaneous`, so the batch has no ungrouped remainder:
    - Search the in-scope column snapshots for an existing line `— Miscellaneous <!-- planId:<id> feature ... -->` whose project scope matches the active filter. If found, run:
      `node .agents/skills/kanban_operations/assign-to-feature.js "<featurePlanId>" '["id1","id2",...]' "{{WORKSPACE_ROOT}}"`
    - If not found (or assignment fails with the locked-column error), run:
      `node .agents/skills/kanban_operations/create-feature.js "Miscellaneous" '["id1","id2",...]' "{{WORKSPACE_ROOT}}" "Catch-all feature for standalone plans swept during orchestration kickoff."`
    - Zero leftovers → skip the sweep entirely (the `/kanban/feature` route rejects empty `planIds` — do not attempt a blank `Miscellaneous`).
- Repeat the EXECUTE shell-safety rules here: escape `"` in goal text; avoid `$`, backticks, backslashes. No human reviews the generated commands in this mode, so escaping is mandatory, not hygiene.
- Skip step 6 (BACKLOG) in unattended mode — BACKLOG stays human-curated.
