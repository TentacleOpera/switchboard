---
description: 'Milestones — Long-Term Goals On The Board'
---

# Milestones — Long-Term Goals On The Board

**Complexity:** 5

## Goal

Give the board a concept it has never had: a long-term goal that cards belong to. The board has four groupings — projects filter, features decompose one deliverable, missions execute, worktrees isolate — and every one of them answers "what do I work on next". Nothing answers "what does this add up to", so long-term intent lives in the user's head and in plan prose where neither the board nor the controller agent can read it.

A milestone is defined by a user or an agent, holds cards added by hand or over HTTP, reports where those cards currently sit on the board, and is marked complete by a person or an agent rather than by a calculation. The controller agent reads milestones to decide which missions to build next.

Milestones are deliberately inert. Adding a card to one runs nothing, and nothing about missions changes: a mission remains a card that triggers a launch when moved. The two are kept apart on purpose — `missions.type` is free text defaulting to `'mission'`, so `type = 'milestone'` would work today with no migration, and taking that shortcut would put a goal in Mission Control's launch list as something dispatchable by accident.

## How the Subtasks Achieve This

- **Milestones — long-term goals that cards belong to, and that a controller agent can read**: the state, the API, and agent access. Adds `milestones` + `milestone_members` (V66), mirroring the proven `missions` / `mission_members` membership shape including a `member_kind` for plans versus features. Column status is derived at read time and keyed to whatever columns the board currently has, so a renamed column neither breaks nor silently drops cards; a feature counts once through the feature so co-membership cannot inflate the numbers the controller agent reads. Nine routes mirroring `/kanban/mission/*`, completion as an explicit declaration that never touches a card, and the orchestration skill step that has the controller agent read goals before choosing what to group and dispatch.

- **A Milestones tab on the board — goals, their cards, and where those cards are**: the surface. Adds the MILESTONES tab to `kanban.html` using the existing tab seams, showing each goal with the per-column breakdown of its cards rather than a single percentage, plus create, complete/reopen, delete, drag-to-reorder, and an ADD TO MILESTONE action driven from the board's existing card selection that prefers a parent feature over its subtasks. Renders the backend's counts rather than recomputing them, so the tab and the API cannot disagree about how much work a goal contains.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

Strictly ordered. The state plan must land first: it owns the tables, the derived column status, and every route the tab calls, and the tab plan adds no state of its own. The state plan is independently shippable and useful on its own — agents can create goals, add cards, read status, and mark completion over HTTP with no UI at all. The tab is the human surface on top of it and is not shippable before it.

Both are independent of the other plans on this branch (`agents-set-a-columns-card-order`, `agents-set-a-cards-priority-level`, `priority-as-a-native-field-and-a-board-wide-order-by`) — different state, different consumers, any order.
