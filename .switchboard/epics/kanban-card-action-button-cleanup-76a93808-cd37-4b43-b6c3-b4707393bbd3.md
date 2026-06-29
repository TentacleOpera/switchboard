---
description: 'Kanban Card Action-Button Cleanup'
---

# Kanban Card Action-Button Cleanup

## Goal

De-clutter and visually unify the action-button row on kanban cards, where epics and high-complexity plans carry the most buttons. This epic removes a redundant per-card dispatch button now that pairing is fully driven by the Pair-mode dropdown, and brings a stylistically inconsistent button back in line with the outline convention used by every other card button.

## How the Subtasks Achieve This

- **Remove the Per-Card Pair Button**: Deletes the redundant per-card Pair button and its dead handler, since pairing is already driven by the Pair-mode dropdown across its nine dispatch sites — de-crowding epic and high-complexity cards.
- **Orchestrate Button: Purple Outline Instead of Solid Fill**: Restyles the Orchestrate button on epic cards from a solid purple fill to the outline style used by Complete, Copy, and Recover, so it no longer reads as a dominant primary call to action.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove the Per-Card "Pair" Button (Rely on the Pair-Mode Dropdown)](../plans/feature_plan_20260629085554_remove-per-card-pair-button.md) — **INTERN CODED**
- [ ] [Orchestrate Button: Purple Outline Instead of Solid Fill](../plans/feature_plan_20260629092225_orchestrate-button-purple-outline.md) — **INTERN CODED**
<!-- END SUBTASKS -->
