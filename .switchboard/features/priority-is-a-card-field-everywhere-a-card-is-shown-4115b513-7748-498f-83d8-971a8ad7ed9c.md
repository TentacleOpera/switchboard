# Priority Is A Card Field Everywhere A Card Is Shown

**Complexity:** 6

## Goal

Give every card a priority - not only cards imported from a tracker - with one board-wide order-by control that determines execution order rather than just the view, and make the star that already exists on the board visible and clickable in the sidebar too.

The plans table has no priority column. TeamQueueService sorts a priority read from queue-item frontmatter, but that orders queue items, not cards. Both trackers offer the same shape - four levels plus an unset state, 1 being most urgent in each - so a single field maps to both with no scale conversion and no inversion to get wrong. An import-only field would be worse than none: most of the board would show nothing, the badge would appear for reasons the board does not explain, and a locally authored plan could not be marked urgent at all.

The star has the same shape of gap. It ships on the board webview, where clicking it toggles priorityStarred and starred cards sort first, but the sidebar project panel renders plan and feature cards with no star UI at all - separate rendering functions in a separate webview context. So plans managed from the sidebar cannot be starred, and starred plans show no indication there.

## How the Subtasks Achieve This

- **Priority Is A Native Card Field And A Board-Wide Order By**: adds a native 1-4 priority with null for unset on every card, and one order-by control (manual, priority, date, complexity, star always first) that decides execution order rather than only the view. Both trackers use four levels plus unset with 1 most urgent, so the field maps to each with no scale conversion and no inversion to get wrong.
- **Add Priority Star To Sidebar Project Panel Plan And Feature Cards**: extends the star that already ships on the board — where clicking it toggles `priorityStarred` and starred cards sort first — into the sidebar's separate rendering functions, closing the gap where plans managed from the sidebar cannot be starred and starred plans show no indication.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Priority is a native card field, and the board gets one "order by" control that decides what actually runs](../plans/priority-as-a-native-field-and-a-board-wide-order-by.md) — **CODER CODED** — ID: 602832e6-3b60-4701-aac5-8841969a1569
- [ ] [Add priority star to sidebar project panel plan and feature cards](../plans/feature_plan_20260827144005_priority-star-on-sidebar-plan-and-feature-cards.md) — **CODER CODED** — ID: b677a96e-5e1c-4d16-be1b-d39372607ad0
<!-- END SUBTASKS -->

## Dependencies & sequencing

The sidebar star can land first: it is pure UI over already-shipped state (V63 delivered `priority_starred` and `column_order`), needs no migration, and is independently useful.

`priority-as-a-native-field` extends the same ordering resolver (`kanbanOrdering.ts`) with one more mode parameter and must land **with or after** the shipped star work, never before it.

Two implementation facts recorded in the plans. ClickUp returns priority as an object rather than a bare integer, so the read path must extract the level from `orderindex` or map the label string to 1-4 — the scale matches, the wire format does not. The write path accepts a bare integer, so write-back is direct.

One gap worth knowing before coding: there is no dedicated REST endpoint for the star. It is reachable only as a verb (`POST /kanban/verb/setPriorityStarred`, payload `planId` / `starred` / `workspaceRoot`), that verb has no entry in `verbSchemas.ts` so its payload is unvalidated, and it is documented in no agent-facing file. If priority is meant to be settable by an agent or from a phone, that endpoint gap belongs in this feature's scope — decide it deliberately rather than inheriting the verb rail by default.
