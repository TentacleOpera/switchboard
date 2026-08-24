# Two Kanban Sort Defects That Move Cards on Their Own

**Complexity:** 3

## Goal

Fix the two reasons a card changes position without anyone moving it. The Created column sorts by last activity rather than creation date, so an agent editing a plan file reshuffles the column; and an optimistic move writes a stale timestamp, landing the card mid-column before it jumps to the top when the prompt is pasted. Both must be settled before manual ordering can be layered over a stable base sort.

## How the Subtasks Achieve This

- **Fix Created column sort — use createdAt, not columnEnteredAt or lastActivity** — stops an agent editing a plan file from reshuffling the column, so the order is stable.
- **Kanban card jumps to middle on copy-prompt advance, then to top on paste** — fixes the stale timestamp in the optimistic move that lands the card mid-column before it jumps on paste.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban card jumps to middle on copy-prompt advance, then to top on paste](../plans/feature_plan_20260819130405_kanban-card-optimistic-move-stale-ts.md) — **PLAN REVIEWED**
- [ ] [Fix Created Column Sort — Use createdAt, Not columnEnteredAt/lastActivity](../plans/fix-created-column-sort-by-creation-date.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

No ordering constraint between the two; both are sort-key corrections and can be done in one pass.

**Sequencing note against a plan outside this feature.** *A priority star and manual ordering in every column* is in CREATED and so is not a subtask here, but manual ordering has to be layered over a stable base sort. Both of these fixes should land before that plan is coded, or it will be implemented against a sort that is about to change.

