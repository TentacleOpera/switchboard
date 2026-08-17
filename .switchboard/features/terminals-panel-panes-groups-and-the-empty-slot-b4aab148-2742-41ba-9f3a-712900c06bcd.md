# Terminals panel: panes, groups and the empty slot

**Complexity:** 6

## Goal

Four defects in the terminals panel's pane-and-group layer: the kanban pane's workspace/project picker is capped too narrow to read, switching groups erases a pane's kanban mode, the empty pane's whole body is an invisible hotspot that fires the agent picker, and adding an agent ignores the slot you aimed at while dropping the group lock or re-laying-out another group.

Three of the four share one root cause worth naming up front: **the rule "a slot with no assignment but a kanban mode is not a free seat" is hand-copied into five places in `src/webview/terminals.js` instead of being defined once** (`:2883`, `:3719`, `:6711`, `:7076`, and as prose at `:4730`). Two seating paths — `seatActiveGroupPage` and `clearGroupLock` — were simply forgotten, which is why a group switch bulldozes a board column. Grouping these subtasks means the predicate gets extracted once and every new seating path in the feature calls it, instead of each subtask adding a sixth and seventh copy and re-arming the bug for whoever writes the eighth.

## How the Subtasks Achieve This

- **Kanban Pane's Workspace › Project Picker Is Too Narrow To Read**: widens the combined `workspace > project` dropdown from a flat 170px ceiling to `min(340px, 55%)` with `min-width: 0` so it shrinks instead of overflowing the 22px pane header, and sets the picker's `title` from the *selected option* in `renderKanbanPane`'s always-runs tail so a capped label stays recoverable on hover. Purely presentational, and the only subtask that touches no seating or lifecycle code — it makes the kanban pane the other three protect actually legible.
- **Switching to a Terminal Group Destroys a Pane's Kanban Mode**: makes kanban mode a property of the composition rather than a global. Teaches `seatActiveGroupPage` and `clearGroupLock` the kanban skip the other four seating paths already apply, adds a `kanbanPanes` snapshot map to the shipped `groupPrefs` keyed by group (with `__all__` for the unlocked composition), captures on switch/toggle/picker-change and restores before seating, and corrects the erasure rule at `:4729` — which had been documenting an invariant that was not yet true. It also **extracts the shared `isSlotFree(i, rendered)` predicate** the feature's other seating work depends on.
- **The Whole Empty Pane Is a Hidden Hotspot That Fires the Agent Picker**: stops `.pane-empty-slot` (a `height: 100%` div) from being the click target for the role picker — `pointer-events: none` on the placeholder, `auto` on a new `.pane-empty-actions` row holding two explicit labelled buttons, `add agent` and `kanban mode`. It also fixes the malformed unlocked picker key (`'group:null'` → the `__all__` sentinel the strip's `+` already uses), which is what lets both buttons be unconditional. This subtask is the **sole owner of the delegated click handler's empty-pane branch** and writes the slot index into the call site on the next subtask's behalf.
- **A New Agent Ignores the Empty Slot You Aimed At and Hijacks Another Group's Grid**: threads the aimed slot index and the picker's group scope from that click through `pickerState` into `createTerminal`, and replaces the bare `assignToFocusedPane(name)` with `seatIntoRequestedSlot` — membership first, then a response-time re-proof via `isSlotFree`, then a `keepLock` seat. Also stops `switchToTeamGroup` from silently re-laying-out and persisting another group's grid, and widens `reportTeamStart`'s fallback message to the single-terminal case. This is what turns the previous subtask's button from "opens a picker" into "fills *this* slot".

## Dependencies & sequencing

**Ship in this order. The last three are not independent.**

1. **Kanban Pane's Workspace › Project Picker Is Too Narrow To Read** — independent; can land at any point. Sequenced first only because it is the cheapest and lands in `terminals.html` CSS plus a three-line tail in `renderKanbanPane`. Its one co-location is that the per-group-state subtask adds `captureKanbanPanesFor` calls to the two picker `change` handlers in the same function — different statements, no conflict.
2. **The Whole Empty Pane Is a Hidden Hotspot That Fires the Agent Picker** — must land before subtask 4. It owns the delegated `.pane-content` handler's empty-pane branch (`terminals.js:4656-4663`) and writes `onNewTerminalClicked(undefined, 'group:' + (activeGroupId || '__all__'), index)`. The third argument is inert until subtask 4 teaches `onNewTerminalClicked` to read it, so this subtask is independently shippable and correct on its own; splitting ownership of that block any other way means one subtask silently overwrites the other's edit.
3. **Switching to a Terminal Group Destroys a Pane's Kanban Mode** — must land before subtask 4, because it defines `isSlotFree`. It edits the `.pane-mode-toggle` branch *below* the block subtask 2 owns, so landing it after subtask 2 keeps those two edits from colliding.
4. **A New Agent Ignores the Empty Slot You Aimed At and Hijacks Another Group's Grid** — last. It consumes subtask 2's call-site argument and subtask 3's `isSlotFree`, and its team path (`switchToTeamGroup` → `switchToGroup`) inherits subtask 3's capture-and-restore, so it can only be verified end-to-end once both are in.

**Reconciled decisions** (recorded so a coder implements to one design, not two):

- **The `add agent` button is unconditional**, present with and without a group lock. Subtask 3 originally gated it on `activeGroupId`; that gate existed only to hide the malformed `'group:null'` key, and once the sentinel is used the unlocked path works. Unconditional also deletes an entire lock-scoped add/remove reconcile branch from the placeholder re-derive path, and it is what makes subtask 4's `__all__` case reachable from a pane.
- **One free-slot predicate, three callers.** `isSlotFree` replaces the byte-identical copy in `handleLockedTerminalClick` and serves subtask 4's new `seatIntoRequestedSlot`. The three remaining variants (`assignToFocusedPane`'s split `isOpen`/`isFree` cascade, `seatTeamWithoutGroup`'s test against a local array, `fillEmptyPanes`' pin-less test) are **not** converted — their expressions genuinely differ and rewriting them is a behaviour change outside this feature. Each gets a pointer comment instead.
- **No snapshot writes from a render path.** `captureKanbanPanesFor` is event-driven only. In particular the erasure rule inside `updatePaneElement` mutates the live array and does **not** capture — it runs on every 5s poll tick and, at load, before any group scope is meaningful.
- **Membership is written even when no free slot exists.** The create succeeded and the picker was group-scoped, so the terminal is a member with nowhere to sit; the group's page affordance is how the operator reaches it. Gating the write on a successful seat would also be contradicted by the next reconcile, since `seatActiveGroupPage` will seat a member into a pinned slot that `isSlotFree` refuses.

**Prerequisites / guards** — none external. No schema change, no host code, no new setting. The single piece of shipped state touched is `terminals.groupPrefs`, and the new `kanbanPanes` sub-key is additive: absent reads as `{}`, the loader whitelist and the module-level default both carry it, and a one-time load-time seed of the active scope keeps an upgrading install's existing kanban pane through its first composition switch.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban Pane's Workspace › Project Picker Is Too Narrow To Read](../plans/feature_plan_20260817141100_kanban-pane-workspace-project-picker-truncates.md) — **PLAN REVIEWED**
- [ ] [Switching to a Terminal Group Destroys a Pane's Kanban Mode](../plans/feature_plan_20260817141400_terminal-groups-destroy-a-panes-kanban-mode.md) — **PLAN REVIEWED**
- [ ] [The Whole Empty Pane Is a Hidden Hotspot That Fires the Agent Picker](../plans/feature_plan_20260817141500_empty-pane-is-one-giant-hidden-hotspot-for-the-agent-picker.md) — **PLAN REVIEWED**
- [ ] [A New Agent Ignores the Empty Slot You Aimed At and Hijacks Another Group's Grid](../plans/feature_plan_20260817141600_new-agent-ignores-the-empty-slot-and-hijacks-another-group.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

