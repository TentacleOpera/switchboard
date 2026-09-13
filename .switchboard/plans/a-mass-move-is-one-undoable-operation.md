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

**Where it lives.** The surface already exists: `#status-message` in the kanban sub-bar
(`kanban.html:3049`, `role="status"`, `aria-live="polite"`), driven by `showStatusBarMessage()`
(`kanban.html:8264`). A bulk move already has a place to announce itself, and the undo rides the
same announcement rather than introducing a surface of its own:

```
Moved 172 cards to LEAD CODED · UNDO
```

This is not a dialog. It appears **after** the move, interrupts nothing, and is ignorable.

One change to that helper is required. `showStatusBarMessage` clears itself after **5000 ms** —
correct for a status flash, wrong for a recovery affordance: an operator who looks away loses the
only cheap way back. An undo offer persists until it is superseded by the next bulk move or
dismissed. The timeout stays the default for every other caller; this is an opt-out, not a change
to the shared behaviour.

### 5. The button says what it is about to move — by dropping a gate, not adding a feature

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

### 6. Both composition roots

The move path is shared; the surface that offers the undo is not. `extension.ts` and
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
5. Assert the undo offer survives the 5000 ms `showStatusBarMessage` timeout, and that an ordinary
   status message still clears at 5000 ms.
6. Assert no `confirm()`, `window.confirm()` or modal gate exists on the move path, on either host.

### Goal Invariants

- Any bulk move can be reversed by one action, with no database restore.
- Every card returns to the column it was in, not to a column inferred for it.
- The event log distinguishes a card the operator moved from a card its feature moved.
- Pressing "advance all" by accident costs the operator one action, not a rollback of the board.
- No confirmation dialog exists anywhere on this path.
- The undo offer is still on screen a minute after the move that created it.
