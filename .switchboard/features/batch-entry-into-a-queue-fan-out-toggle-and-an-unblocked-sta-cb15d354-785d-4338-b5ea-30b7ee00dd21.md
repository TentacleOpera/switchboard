# Batch Entry Into a Queue - Fan-Out Toggle and an Unblocked STAGING Column

**Complexity:** 5

## Goal

Give the operator control over how work enters a queue from the board. A toggle on the Created column decides whether a batch move fans plans out across multiple planners or lands them on one, replacing a rarely-used blank-feature button. And STAGING stops refusing plans dragged back from coded, reviewed, tested or completed columns, in both the drag path and the backend handler that guards it.

## How the Subtasks Achieve This

- **Repurpose Created column's blank-feature button as a planner fan-out toggle for batch move** — replaces a rarely-used button with a toggle controlling whether a batch move fans plans out across multiple planners or lands them on one.
- **Remove STAGING column gate — allow drag-back from any column** — deletes the stageableColumns refusal in both the drag-into-STAGING path and the backend handler, so a plan can be dragged back from coded, reviewed, tested or completed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Repurpose Created Column's Blank-Feature Button as a Planner Fan-Out Toggle for Batch Move](../plans/feature_plan_20260820220404_created-column-batch-move-planner-fanout-toggle.md) — **PLAN REVIEWED**
- [ ] [Remove STAGING column gate — allow drag-back from any column](../plans/remove-staging-column-gate-allow-all-columns.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; the two subtasks touch different entry points and are independent.

**Related plan left standalone.** *Batch moves to a team send the feature implementation prompt* is in CREATED and so is not a subtask here, but it changes the same batch-move entry point that the fan-out toggle modifies. Sequencing the two together avoids a conflict in that code path.

