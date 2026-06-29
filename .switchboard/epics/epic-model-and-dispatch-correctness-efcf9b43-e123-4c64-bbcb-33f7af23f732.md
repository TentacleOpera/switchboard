---
description: 'Epic Model and Dispatch Correctness'
---

# Epic Model and Dispatch Correctness

## Goal

Make the epic data model and its dispatch and routing behavior consistent and correct, independent of how an epic was created. Today an epic complexity is stored as Unknown, which routes it to the wrong lane, its subtasks are silently capped at dispatch time, and the Epics tab merges a vestigial filesystem scan with the database, surfacing dead-ended document cards. This epic makes epics always High complexity, dispatches every subtask with no cap, and makes the Epics tab database-only like every other plan surface.

## How the Subtasks Achieve This

- **Remove Standalone Epics as a Concept**: Deletes the filesystem-scan path so the Epics tab shows only database-backed epics, the same source every other plan surface uses — also eliminating the duplicate and dead-ended document cards as a side effect.
- **Epics Are Always High Complexity**: Stores and clamps an epic's complexity to High (score 8) at creation, migration, and write time, so dragging to AUTOCODE and advancing via the column button route the epic to the same correct lane instead of diverging on an Unknown score.
- **Remove the Epic Subtask Cap (epic_max_subtasks)**: Dispatches every active subtask in the epic prompt with no truncation or warning line, closing the latent bug where capped-but-cascaded subtasks were marked coded without ever reaching an agent.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove the Epic Subtask Cap (`epic_max_subtasks`) Entirely](../plans/feature_plan_20260629081855_remove-epic-max-subtasks-cap.md) — **CREATED**
- [ ] [Remove Standalone Epics as a Concept](../plans/feature_plan_20260629083123_remove-standalone-epics.md) — **CREATED**
- [ ] [Epics Are Always High Complexity (Regardless of Subtasks)](../plans/feature_plan_20260629091401_epics-always-high-complexity.md) — **CREATED**
<!-- END SUBTASKS -->
