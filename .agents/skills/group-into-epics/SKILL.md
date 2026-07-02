---
description: Group loose Switchboard plans into epics — scan pre-coding columns, cluster by capability, propose all groupings for one approval, then create epics via create-epic.js
---

# Skill: Group Into Epics

You are grouping loose Switchboard plans into epics. Follow this flow exactly — do not create any epic before the user approves.

## When to Use

Triggered when the user asks to "group plans into an epic", "organise loose plans into epics", or "suggest epic groupings", OR by clicking the **Suggest Epics** board button (which copies this skill's text with the workspace root injected).

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
- [.switchboard/epics/epic-def.md](...) — Bar Epic <!-- planId:def-456 epic -->
- [.switchboard/plans/baz.md](...) — Baz <!-- planId:ghi-789 subtask-of:"Bar Epic" -->
```

Skip lines tagged `epic` (they are epics) or `subtask-of:...` (already assigned).
Use the `planId:` value from the comment — NOT the filename — when calling create-epic.js.
(A path under .switchboard/epics/ also indicates an epic, but subtask detection
requires the subtask-of tag — do not rely on filenames alone.)

### 1a. DETERMINE PROJECT SCOPE

The active project filter is injected as `{{ACTIVE_PROJECT_FILTER}}` when
invoked from the **Suggest Epics** board button. This may be:
- A specific project name (e.g. `Remote sync`)
- `__unassigned__` (user is viewing plans with no project)
- Empty / unset / the literal placeholder token (no filter active, OR the
  skill was loaded directly without the button — include ALL plans)

If the filter is a specific project, skip plans whose `project:"..."` tag
does not match. If the filter is `__unassigned__`, skip plans that HAVE a
`project:"..."` tag (only untagged plans are candidates). If the filter is
empty/unset/the literal placeholder, include all plans (current behavior).

Plans with NO `project:` tag are unassigned and match the `__unassigned__`
filter; they are excluded from a specific-project filter.

Example filtering:
- Filter = `Remote sync` → only plans with `project:"Remote sync"` are candidates
- Filter = `__unassigned__` → only plans with NO `project:` tag are candidates
- Filter = empty / `{{ACTIVE_PROJECT_FILTER}}` → all plans are candidates

### 2. READ PLAN BODIES

For each candidate plan in scope, read the full plan file.
Extract: goal, problem summary, dependencies, tags.
Use this — not just titles — to determine groupings.
Read plans in parallel where possible. If >25 candidates, first-pass cluster by
title then deep-read within each cluster.

### 3. PROPOSE (single message, all groups at once)

Group by underlying capability theme, not by surface keyword.
Cross-provider plans that address the same capability go into one epic.
Minimum 2 plans per epic. Single-plan "groups" go in the Standalone section.
Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.
For each proposed epic, write:
- Epic name
- Goal: 2-4 sentences describing what the epic achieves, what problem it
  solves, and why these plans are grouped together.
- How the Subtasks Achieve This: one bullet per member plan explaining what
  it does and how it contributes to the epic's goal. Format:
    - **Plan Name**: <what it does and how it contributes>
- Member plans with planId and one-line summary

List genuinely standalone plans separately. Then stop and wait.

### 4. CONFIRM

Wait for user approval or edits. Do not touch the database until confirmed.

### 5. EXECUTE

For each approved group, pass the Goal text as the description argument.
Escape any double quotes in the Goal text (replace " with \") or rephrase to
avoid them, so the bash command does not break. Also avoid $, backticks, and
backslashes in the Goal text — these are shell metacharacters inside double quotes.

```bash
node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "{{WORKSPACE_ROOT}}" "<goal text with escaped quotes>"
```

The description becomes the ## Goal section in the epic file.
After all epics are created, write the ## How the Subtasks Achieve This section
into each epic file manually (the create-epic script only writes the Goal).
Use the text from your step 3 proposal — paste it between the Goal and the
`<!-- BEGIN SUBTASKS -->` marker. This section is preserved by _regenerateEpicFile
on subsequent subtask changes, so it only needs to be written once.

To add more plans to an epic later, use assign-to-epic.js with the epic planId from the create-epic.js output.

### 6. BACKLOG (optional, after execution)

Ask the user: "Would you like me to analyse the BACKLOG for epic groupings too?"
Do NOT re-read the board or inspect the BACKLOG column yourself.
If the user says yes, repeat steps 1-5 scoped to the BACKLOG column.
If the user says no or does not respond, stop.

## Notes

- Epic creation updates the Switchboard board and writes a `.switchboard/epics/` file. It does NOT sync to Linear/ClickUp.
- The `create-epic.js` / `assign-to-epic.js` verb scripts are documented in `.agents/skills/kanban_operations/SKILL.md`.
- The confirm gate is load-bearing: never create any epic before the user approves.
