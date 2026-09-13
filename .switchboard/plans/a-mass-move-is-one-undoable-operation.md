# A Mass Move Is One Undoable Operation

## Goal

"Advance all" can be pressed by accident. When it is, one action puts it back — exactly, to the
columns each card came from — without restoring a database.

### What recovery costs today

On 2026-09-14 a burst moved **172 cards to LEAD CODED**: 33 features and 139 subtasks the operator
never touched, dragged in by the feature cascade. The only recovery available was restoring a
whole-database backup taken 19 minutes earlier, which discards every other thing the board recorded
in that window — the coding team's real work included.

That is the measure of "no easy undo": the smallest unit of reversal the board offers is the entire
board, rewound in time.

### Why the audit log could not be used

The board *does* record every move in `plan_events`. Two properties make that record useless for
reversing one:

1. **A bulk move is not recorded as a bulk move.** The 172 cards produced 172 independent events
   with no shared identity. Nothing in the log says these were one press of one button, so nothing
   can name the set to undo.
2. **Every cascaded card claims the operator moved it.** `recordRunSheetForColumnMove(key, target,
   'forward', …)` stamps each subtask with `"User manually moved plan forwards"`. All 139 subtasks
   the operator never touched carry that sentence. The log therefore cannot distinguish a card the
   user moved from a card that moved *because its feature moved*, and an undo built on it would
   reverse deliberate moves alongside accidental ones.

The cards also did not come from one column, so "move everything back one column" is not a
restoration. The prior column has to be recorded per card.

### Not a confirmation dialog

`CLAUDE.md` forbids confirm gates in this codebase with no exceptions, and `window.confirm()` is a
silent no-op in a webview sandbox without `allow-modals` — a gate added here would make the button
do literally nothing. This plan adds none, and a coder must not introduce one. The protection is
that the action is **reversible**, not that it is **hard to take**.

### Non-goals

- **A confirm step, a two-click pattern, or an "Are you sure?" of any shape.** See above.
- **A general undo stack for every board action.** This is bulk moves — the operations that touch
  many cards from one press. One-card moves are already cheap to reverse by hand.
- **The memory cost of a bulk move.** Covered by *A Bulk Move Cannot Outgrow the Board*
  (`d7cb5ea9`); the two compose and neither substitutes for the other.

## Metadata

- **Complexity:** 3
- **Tags:** kanban, undo, data-integrity, bugfix

## User Review Required

None.

## Proposed Changes

### 1. A bulk move carries one identity

Every card touched by a single move operation — the multi-select, the "advance all", the feature
cascade and its subtasks — records the same operation id. Without it there is no set to name, and
an undo has nothing to address.

### 2. Each moved card records the column it came from

Restoration is per card, not per column: the 139 subtasks did not all start in the same place.
The prior column goes in the event, so an undo is a replay of recorded fact rather than a guess
about where a card "probably" belonged.

### 3. A cascaded move says it was cascaded

A subtask pulled in by its feature must not be recorded as `"User manually moved plan forwards"`.
It records that it moved because its feature moved, and which feature. This is what lets an undo
reverse the cascade without reversing a deliberate move that happened to land in the same column —
and it is the difference between an audit log and a log that agrees with itself.

### 4. Undo reverses the operation, whole

One action restores every card in the operation to its recorded prior column, in full or not at
all. A partial undo is worse than none: the operator cannot see which half came back.

**Where it lives.** A global button in `#kanban-sub-bar` (`kanban.html:3044`) — the top strip that
already carries `strip-btn` controls (`btn-chat-copy-prompt`, `btn-suggest-features`,
`btn-project-manager`, `btn-feature-action`). It sits there as one more `strip-btn`, hidden when
there is nothing to undo and shown when there is:

```
UNDO LAST MOVE (172)
```

One button, board-wide, in the same place every time. It is not per-column and not attached to the
move that created it: an operator recovering from a press they did not mean to make should not have
to remember which column it came from.

It is **not** a dialog and not `#status-message`. The status bar self-clears after 5000 ms, which
is right for a flash and wrong for a recovery affordance — look away and the only cheap way back is
gone. The button persists until it is used, or until the next bulk move replaces what it offers.

### 5. The Move All button says what it is about to move — by dropping a gate, not adding a feature

This is already built. `updateCapLabels()` (`kanban.html:9572`) renders a `.cap-label` onto the
Move All button reading `SEND 5 OF 172`, with the styling (`column-icon-btn-labeled`) and the
count (`leadBoundCount`) already in place. It is gated behind `isTeamHeadCol && colCount > cap`, so
every other column shows a bare icon and the operator has no idea whether the press moves three
cards or three hundred.

Drop the gate: the button states its count wherever a count exists. Do not build a second labelling
mechanism beside this one.

The count must include **cascaded subtasks**, which is the number the current label would miss —
`leadBoundCount` counts cards in the column, and the 139 subtasks that moved on 2026-09-14 were not
in it. A button reading `MOVE 33` for an operation that moves 172 is worse than an unlabelled one.

This is a label, not a gate: it does not interrupt, does not ask, and does not require a second
click.

### 6. Undo interrupts the seats the move dispatched to

A forward move is not only a column change. `Move Selected` is tooltipped *"Move selected plans to
next stage (triggers CLI if enabled)"* — an accidental press fires prompts at live agents, and
restoring the columns while twenty seats keep working on prompts nobody meant to send is not a
recovery. Undo must reach the terminals.

So the operation records **which seats it delivered to**, and undo sends each of them ESC.

Two constraints, and nothing beyond them:

- **Only the seats this operation delivered to**, recorded at delivery — never every terminal, and
  never inferred afterwards from liveness. A seat busy on unrelated work is not part of this undo.
- **The interrupt key must not default.** ESC interrupts Claude (demonstrated 2026-09-14). What
  interrupts the other families is not established, and one measurement that does exist cuts the
  other way: copilot echoes ESC as a literal `^[` rather than acting on it. So a seat whose family
  is not known to take ESC is reported by name and left alone. A family→key table pretending to be
  a runtime probe is the mistake `CLI_AGENT_REGEX` was deleted for.

Whether the seat has already finished its turn is **not** checked. An ESC into a settled Claude seat
costs nothing, and a liveness probe on the delivery path is a subsystem this does not need.

### 7. Both composition roots

The move path is shared; the surface that offers the undo, and the pty seam the interrupt
rides, are not. `extension.ts` and
`src/standalone/bootstrap.ts` must both wire it, and both be verified — an undo affordance present
on one host and absent on the other is the divergence `CLAUDE.md` names, and it fails silently.

## Verification Plan

### Automated Tests

1. **New** `src/test/bulk-move-undo-contract.test.js`, wired as `test:contract:bulk-move-undo`
   **and invoked from `.github/workflows/integration-tests.yml`** — a suite defined but not invoked
   is not a gate. Moves a feature whose subtasks start in **three different columns**, undoes, and
   asserts every card is back in its own original column. A test whose cards all start in one
   column would pass against a naive "move everything back" implementation and prove nothing.
2. Assert a cascaded subtask's event does not claim the user moved it, and names the feature that
   did.
3. Assert undo is all-or-nothing: injected failure part-way leaves every card at its pre-undo
   column.
4. Assert the advertised count equals the number of cards the operation actually moves, cascaded
   subtasks included — a feature with subtasks must not advertise only the feature.
5. Assert the advertised undo count matches the number of cards the undo restores.
6. Assert the undo button lives in `#kanban-sub-bar` and survives longer than the 5000 ms
   `showStatusBarMessage` timeout, while an ordinary status message still clears at 5000 ms.
7. Assert undo sends ESC only to seats this operation delivered to — a seat busy on unrelated work
   receives nothing.
8. Assert a family not known to take ESC is reported and sent nothing, and that no family→key
   default exists.
9. Assert no `confirm()`, `window.confirm()` or modal gate exists on the move path, on either host.

### Goal Invariants

- Any bulk move can be reversed by one action, with no database restore.
- Every card returns to the column it was in, not to a column inferred for it.
- The event log distinguishes a card the operator moved from a card its feature moved.
- Pressing "advance all" by accident costs the operator one action, not a rollback of the board.
- No confirmation dialog exists anywhere on this path.
- The undo button is still on screen a minute after the move that created it, in the same place
  every time.
- Undoing a move stops the agents that move set working, and says which ones it could not stop.
- No seat is ever sent an interrupt key chosen by a default.
- No seat outside the undone operation is touched.
