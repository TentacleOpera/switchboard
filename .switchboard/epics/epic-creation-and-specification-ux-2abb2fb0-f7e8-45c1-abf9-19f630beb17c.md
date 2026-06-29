---
description: 'Epic Creation and Specification UX'
---

# Epic Creation and Specification UX

## Goal

Make the journey of creating and fleshing out an epic coherent and correct, from the button that starts it to the file it produces. Today the create entry points are mislabeled, cannot make a blank epic, produce epic files missing their subtask list, and offer no way to improve a thin epic description. This epic fixes the create-button label and behavior, repairs the generated epic file so it always lists its subtasks, and adds a Refine path so a sparse epic can be turned into a complete, decomposable specification.

## How the Subtasks Achieve This

- **Dynamic Promote-to-Epic Button Label**: Relabels the strip button to GROUP INTO EPIC when two or more cards are selected, so the label matches the action it performs rather than implying in-place promotion.
- **Replace Group All Plans Into Epic with Add Epic**: Repurposes the CREATED-column button to create a blank epic and relaxes the backend create method to accept zero subtasks, giving a clean way to start an empty epic and attach subtasks later.
- **Promote-to-Epic Creates Epic File Without Subtask List**: Fixes the bug where multi-plan promotion writes an epic file with no Subtasks section, hardening the create and regenerate path so the generated file always lists its subtasks.
- **Refine Epic Skill and Epics-Tab Button**: Adds a refine_epic skill and a Refine button that copies a prompt to turn a thin or empty epic into a complete specification with a proposed subtask breakdown — the specification step the create flow never had.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Promote-to-Epic Creates Epic File Without Subtask List in Description](../plans/feature_plan_20260628220159_promote-to-epic-missing-subtasks.md) — **CODE REVIEWED**
- [ ] [Dynamic "Promote to Epic" Button Label Based on Selection Count](../plans/feature_plan_20260628221751_promote-to-epic-button-label-dynamic.md) — **CODE REVIEWED**
- [ ] [Replace "Group All Plans Into Epic" Button with "Add Epic" (Blank Epic Creation)](../plans/feature_plan_20260628221752_add-epic-button-replaces-group-all.md) — **CODE REVIEWED**
- [ ] [Refine Epic Skill & Epics-Tab Button](../plans/feature_plan_20260628222343_refine-epic-skill-and-card-button.md) — **CODE REVIEWED**
- [ ] [Extract the Suggest-Epics Orchestration Flow into a Model-Invocable Skill](../plans/feature_plan_20260629114530_extract-suggest-epics-flow-into-skill.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
