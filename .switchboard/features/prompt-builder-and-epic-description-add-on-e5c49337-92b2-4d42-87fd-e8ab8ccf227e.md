# Prompt Builder and Epic Description Add-on

**Complexity:** 7

## Goal

Strip redundant boilerplate from generated prompts and add a new planner add-on for epic description backfill. Both plans heavily modify agentPromptBuilder.ts and KanbanProvider.ts and must be coordinated to avoid merge conflicts.

## How the Subtasks Achieve This

- **Prompt Builder Redundancy Cleanup — Lean Dispatch Prompts**: Strips duplicated role descriptions, constitution text, and boilerplate from generated prompts, reducing token waste and improving prompt clarity.
- **Write Epic Description If Empty Planner Add-on**: Adds a new planner add-on (ON by default) that instructs the planner to backfill missing Goal, How the Subtasks Achieve This, and Dependencies and sequencing sections in epic files, plus updates the Suggest Epics skill.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add "Write Epic Description If Empty" Planner Add-on + Dependencies Section to Suggest Epics Skill](../plans/feature_plan_20260702063927_write-epic-description-if-empty-addon.md) — **CODE REVIEWED**
- [ ] [Prompt Builder Redundancy Cleanup — Lean Dispatch Prompts](../plans/feature_plan_20260702123609_prompt-builder-redundancy-cleanup.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

