# Two Kanban Sort Defects That Move Cards on Their Own

**Complexity:** 3

## Goal

Fix the two reasons a card changes position without anyone moving it. The Created column sorts by last activity rather than creation date, so an agent editing a plan file reshuffles the column; and an optimistic move writes a stale timestamp, landing the card mid-column before it jumps to the top when the prompt is pasted. Both must be settled before manual ordering can be layered over a stable base sort.

## How the Subtasks Achieve This

- **Fix Created column sort — use createdAt, not columnEnteredAt or lastActivity** — stops an agent editing a plan file from reshuffling the column, so the order is stable.
- **Kanban card jumps to middle on copy-prompt advance, then to top on paste** — fixes the stale timestamp in the optimistic move that lands the card mid-column before it jumps on paste.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban card jumps to middle on copy-prompt advance, then to top on paste](../plans/feature_plan_20260819130405_kanban-card-optimistic-move-stale-ts.md) — **PLAN REVIEWED** — ID: b24cd25c-d885-4d39-a493-28435671d56c
- [ ] [Fix Created Column Sort — Use createdAt, Not columnEnteredAt/lastActivity](../plans/fix-created-column-sort-by-creation-date.md) — **PLAN REVIEWED** — ID: a313de52-6c8d-4dc4-8020-3ac85506fc58
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraint between the two; both are sort-key corrections and can be done in one pass.

**Sequencing (corrected 2026-09-04, Board Collapse 03, decision 16).** The two subtasks are **not** independent: extract one shared column comparator first, in *Kanban card jumps to middle on copy-prompt advance*, then land the Created-column ordering change on top of it. `moveCardElements` currently carries its own insertion rules and would otherwise place a card by a key the column is not sorted on.

The former note here — that both fixes must land before *A priority star and manual ordering in every column* is coded — is **void**: that work shipped in `4df54319` and `c0ea0b26`. The live consequence runs the other way: the comparator must account for the shipped priority order-by mode and the star, and the loose plan *The Priority Star Applies Optimistically* consumes the same extracted comparator instead of adding a third repositioning routine.

