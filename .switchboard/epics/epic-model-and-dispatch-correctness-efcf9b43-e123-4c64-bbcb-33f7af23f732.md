---
description: 'Epic Model and Dispatch Correctness'
---

# Epic Model and Dispatch Correctness

**Complexity:** 4

## Goal

Make the epic data model and its dispatch and routing behavior consistent and correct, independent of how an epic was created. Today an epic complexity is stored as Unknown, which routes it to the wrong lane, its subtasks are silently capped at dispatch time, and the Epics tab merges a vestigial filesystem scan with the database, surfacing dead-ended document cards. This epic makes an epic's complexity the maximum of its subtasks' scores (stored, recomputed, never Unknown), dispatches every subtask with no cap, and makes the Epics tab database-only like every other plan surface.

## How the Subtasks Achieve This

- **Remove Standalone Epics as a Concept**: Deletes the filesystem-scan path so the Epics tab shows only database-backed epics, the same source every other plan surface uses — also eliminating the duplicate and dead-ended document cards as a side effect.
- **Epic Complexity Is Derived from Subtasks (Max)**: Stores an epic's complexity as the maximum score among its active subtasks — recomputed at creation, on membership change, and whenever a subtask is rescored (including the planner-agent file-watch reparse) — so a cleanup epic of low-complexity subtasks routes to the cheap lane while an epic containing a hard subtask routes to the lead, and the old Unknown-driven frontend/backend routing divergence is gone.
- **Remove the Epic Subtask Cap (epic_max_subtasks)**: Dispatches every active subtask in the epic prompt with no truncation or warning line, closing the latent bug where capped-but-cascaded subtasks were marked coded without ever reaching an agent.
- **Remove the Worktree Chip from Epic Cards (Visual Noise)**: Deletes the non-interactive monospace worktree branch badge from the epic card topic line — pure visual noise that duplicates the Worktrees tab. The underlying `currentEpicWorktrees` state and the Worktrees-tab dropdown guard are preserved; only the redundant on-card chip is removed.
- **Show Epic Complexity on the Epic Card (Replace the Timestamp)**: Replaces the relative timestamp in the epic card meta line with the epic's derived complexity chip (reusing the same colored chip and already-computed variables as normal plan cards), surfacing the routing-relevant complexity fact that was invisible on epic cards. Hard dependency on the Epic Complexity Is Derived from Subtasks plan — must ship in the same or later VSIX.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove the Epic Subtask Cap (`epic_max_subtasks`) Entirely](../plans/feature_plan_20260629081855_remove-epic-max-subtasks-cap.md) — **CODE REVIEWED**
- [ ] [Remove Standalone Epics as a Concept](../plans/feature_plan_20260629083123_remove-standalone-epics.md) — **CODE REVIEWED**
- [ ] [Epic Complexity Is the Max of Its Subtasks (Derived, Never Unknown)](../plans/feature_plan_20260629091401_epics-always-high-complexity.md) — **CODE REVIEWED**
- [ ] [Show Epic Complexity on the Epic Card (Replace the Timestamp)](../plans/feature_plan_20260629124815_epic-card-complexity-display.md) — **CODE REVIEWED**
- [ ] [Remove the Worktree Chip from Epic Cards (Visual Noise)](../plans/feature_plan_20260629130000_remove-epic-worktree-chip.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
