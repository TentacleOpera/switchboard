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

- **Complexity:** 6
- **Tags:** bugfix, database, ui, reliability

> **Superseded:** Complexity 3.
> **Reason:** The original score counted only the surface (one button, one label gate). The actual
> change touches a shipped schema (`plan_events`, MIGRATION_V5 — migration required), ~25 call
> sites of `recordRunSheetForColumnMove` (`KanbanProvider.ts` + `TaskViewerProvider.ts`), a new
> undo verb and board-wide button, an atomic all-or-nothing reversal, ESC delivery to dispatched
> seats through the `ptyWrite` seam, and wiring in both composition roots. That is multi-file
> coordination with a data-consistency risk (partial undo) and a schema migration — a Mixed (5-6)
> profile at minimum, scored 6 for the atomicity + migration risk.
> **Replaced with:** Complexity 6.

## User Review Required

None.

## Complexity Audit

### Routine
- Dropping the `isTeamHeadCol && colCount > cap` gate in `updateCapLabels()` (`kanban.html:9584`)
  so the Move All button states its count wherever a count exists — a one-line condition removal.
- Adding the undo button to `#kanban-sub-bar` (`kanban.html:3044`) as one more `strip-btn`, hidden
  when there is nothing to undo — markup + a visibility toggle, mirroring the existing
  `btn-feature-action` pattern.
- The cap-label count including cascaded subtasks — extending `leadBoundCount` (`kanban.html:9560`)
  or the label writer to add the cascade count from `_collectAllMovedSessionIds`
  (`KanbanProvider.ts:9002`).

### Complex / Risky
- **Schema migration.** `plan_events` shipped in MIGRATION_V5 (`KanbanDatabase.ts:747`) and was
  rebuilt in MIGRATION_V20 (`:1364`). Adding an `operation_id` column (or a prior-column field)
  requires a new migration step that ALTERs the live table for the install base — per CLAUDE.md,
  shipped state MUST be migrated, never assumed "already ran."
- **Operation identity threading.** ~25 call sites of `recordRunSheetForColumnMove` across
  `KanbanProvider.ts` (bulk move, move all, move selected, drag, advance, queue pop) and the
  cascade fan-out inside `moveCardToColumnWithReason` (`:8933-8941`) all need the same operation
  id. A missed call site is a silent divergence — the undo names a set that excludes cards the
  move touched.
- **All-or-nothing undo.** A partial undo leaves the operator unable to see which half came back.
  The reversal must be transactional (SQLite `BEGIN`/`COMMIT`/`ROLLBACK`) or pre-validated before
  any write. A card that fails to restore mid-set must roll the whole set back.
- **ESC delivery to the right seats.** The operation must record which terminals it delivered to
  at delivery time (not inferred from liveness afterwards), and undo must send ESC (`'\x1b'`)
  through `ptyWrite` to exactly those seats. Sending to the wrong seats interrupts unrelated work.
- **Both composition roots.** The `ptyWrite` seam is wired in `bootstrap.ts:2680` and
  `TaskViewerProvider.ts:16621`; the undo verb and its ESC delivery must be wired in both, and
  verified in both — an undo present on one host and absent on the other is the divergence
  CLAUDE.md names.

## Edge-Case & Dependency Audit

### Race Conditions
- **Undo during a live cascade.** A bulk move is not instantaneous — the cascade fan-out is chunked
  (`FANOUT_CHUNK_SIZE = 20`, `KanbanProvider.ts:8917`). An undo pressed mid-cascade would name a
  partial set. The operation id must be assigned before the first card moves and the undo must
  refuse (or wait) until the operation's move phase is complete. The sibling plan
  *A Bulk Move Cannot Outgrow the Board* adds a `_bulkMoveActive` scope guard; the undo should
  gate on the same guard or record a "complete" marker the undo checks.
- **Concurrent bulk moves.** Two bulk moves in flight at once produce two operation ids. The undo
  button offers the most recent; the older operation's cards are still restorable from the log but
  the button does not surface them. Acceptable — the button is for the accidental press, not a
  general history browser.
- **Optimistic moves vs. persisted undo.** The webview applies optimistic column moves
  (`kanban.html` optimistic-move path). The undo reads from the persisted log, not the optimistic
  overlay, so a card still showing its optimistic column is restored to its real prior column. The
  board refresh after undo must clear the optimistic overlay for the affected cards.

### Security
- **ESC is one byte to a terminal.** Sending `'\x1b'` to a terminal running an agent is an
  interrupt, not a command — it cannot inject a prompt or execute code. The risk is interrupting
  work the operator wanted; the mitigation is recording the exact seats the operation delivered to,
  never every live terminal.

### Side Effects
- **Undo restores columns but does not un-dispatch.** A forward move may have triggered
  integration sync (Linear/ClickUp) and feature-file regeneration (`_regenerateFeatureFile`,
  `KanbanProvider.ts:8981`). Undoing the column change does not reverse the sync or rewrite the
  feature file back. This is acceptable: the column is the board's truth, and the integration sync
  is idempotent on the next forward move. Documented here so it is not rediscovered as a bug.
- **Undo sends ESC to seats that may have already finished.** An ESC that does nothing costs
  nothing. A seat mid-turn gets interrupted — which is the intent.

### Dependencies & Conflicts
- **Sibling plan: *A Bulk Move Cannot Outgrow the Board* (`d7cb5ea9`).** That plan adds
  `_bulkMoveActive` and the `BULK_MOVE_MAX_CARDS` ceiling. This plan's undo should compose with
  the scope guard (gate on it, or share the operation id). The two plans must not be implemented
  in conflict — the scope guard suppresses intermediate refreshes, and the undo's board refresh
  must not be suppressed by it.
- **Existing `operationId` namespace.** `terminals.js:303` and `TaskViewerProvider.ts:1037` already
  use `operationId` for the dispatch curtain (a transient UI correlation id, never persisted). The
  bulk-move operation id in this plan is a different, persisted thing. The coder must not reuse
  the curtain's `operationId` field or conflate the two — name the persisted id distinctly (e.g.
  `bulkMoveOperationId`) in `plan_events`.

## Dependencies

- `d7cb5ea9` — *A Bulk Move Cannot Outgrow the Board* (composes; the scope guard and ceiling land
  first or concurrently).

## Adversarial Synthesis

Key risks: (1) a schema migration is required and the plan never mentioned it — a coder who
adds the column without a migration step corrupts the install base; (2) ~25 `recordRunSheetForColumnMove`
call sites must all carry the operation id, and a missed site is a silent partial undo; (3) the
all-or-nothing guarantee needs a transaction or pre-validation, not a loop of independent writes;
(4) ESC delivery must record the exact seats at delivery time, never infer them afterwards.
Mitigations: name the migration step explicitly, enumerate the call-site classes, wrap the
reversal in a SQLite transaction, and record delivered seats in the operation record at dispatch.

## Proposed Changes

### 1. A bulk move carries one identity

Every card touched by a single move operation — the multi-select, the "advance all", the feature
cascade and its subtasks — records the same operation id. Without it there is no set to name, and
an undo has nothing to address.

**Clarification (storage mechanism):** The operation id lands in `plan_events`. The current
schema (`KanbanDatabase.ts:622`) has no `operation_id` column — it must be added via a new
migration step (`ALTER TABLE plan_events ADD COLUMN operation_id TEXT DEFAULT ''`), following the
existing migration pattern (`MIGRATION_V5_SQL`, `MIGRATION_V20_SQL`). The id is also written into
the event `payload` JSON for redundancy. The persisted id must be named distinctly from the
transient dispatch-curtain `operationId` (`terminals.js:303`) — e.g. `bulkMoveOperationId`.

**Clarification (call-site scope):** The operation id is threaded through
`recordRunSheetForColumnMove` (`TaskViewerProvider.ts:8434`), which today takes
`(sessionId, targetColumn, direction, workspaceRoot)` and writes one `workflow_event` row per
card via `_updateSessionRunSheet` → `SessionActionLog.updateRunSheet` →
`db.appendPlanEventByPlanId` (`SessionActionLog.ts:571`). The function gains an optional
`operationId` parameter. Every call site — bulk move (`KanbanProvider.ts:7624, 7686`), move all
(`:9605, 9661, 11366, 11429, 11865, 11957`), move selected (`:12111, 12183, 12270, 12344`),
drag, advance, and the cascade fan-out inside `moveCardToColumnWithReason` (`:8933-8941`) —
passes the same id for one press. The id is generated once at the entry point of each bulk
operation and threaded down.

### 2. Each moved card records the column it came from

Restoration is per card, not per column: the 139 subtasks did not all start in the same place.
The prior column goes in the event, so an undo is a replay of recorded fact rather than a guess
about where a card "probably" belonged.

**Clarification:** The prior column is read from `plan.kanbanColumn` before the move in
`moveCardToColumnWithReason` (`KanbanProvider.ts:8891`) and written into the event `payload` JSON
as `priorColumn`. The undo reads it back from the persisted event. No new column is strictly
required for the prior column (the payload carries it), but the `operation_id` column is
required to name the set.

### 3. A cascaded move says it was cascaded

A subtask pulled in by its feature must not be recorded as `"User manually moved plan forwards"`.
It records that it moved because its feature moved, and which feature. This is what lets an undo
reverse the cascade without reversing a deliberate move that happened to land in the same column —
and it is the difference between an audit log and a log that agrees with itself.

**Clarification:** `recordRunSheetForColumnMove` (`TaskViewerProvider.ts:8434`) currently hardcodes
the outcome string. It gains a `cascade?: { featurePlanId: string }` parameter. When set, the
outcome is `"Moved by feature cascade (feature: <planId>)"` instead of `"User manually moved plan
forwards"`. The cascade fan-out in `moveCardToColumnWithReason` (`KanbanProvider.ts:8933-8941`)
passes the parent feature's plan id; the direct (operator-touched) card passes no cascade
parameter and keeps the manual outcome.

### 4. Undo reverses the operation, whole

One action restores every card in the operation to its recorded prior column, in full or not at
all. A partial undo is worse than none: the operator cannot see which half came back.

**Clarification (atomicity):** The reversal runs inside a SQLite transaction
(`db.transaction(...)` or explicit `BEGIN`/`COMMIT`/`ROLLBACK`). It reads every `plan_events` row
for the operation id, collects the `(planId, priorColumn)` pairs, and issues the column restores
as one batch. If any restore fails, the transaction rolls back and no card moves — the button
stays armed for a retry.

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

**Clarification (verb):** The button posts a new verb (e.g. `undoBulkMove`) carrying the operation
id of the most recent bulk move. The provider resolves the set from `plan_events`, runs the
transactional reversal, posts a board refresh, and clears the button.

### 5. The Move All button says what it is about to move — by dropping a gate, not adding a feature

This is already built. `updateCapLabels()` (`kanban.html:9573`) renders a `.cap-label` onto the
Move All button reading `SEND 5 OF 172`, with the styling (`column-icon-btn-labeled`) and the
count (`leadBoundCount`) already in place. It is gated behind `isTeamHeadCol && colCount > cap`, so
every other column shows a bare icon and the operator has no idea whether the press moves three
cards or three hundred.

Drop the gate: the button states its count wherever a count exists. Do not build a second labelling
mechanism beside this one.

The count must include **cascaded subtasks**, which is the number the current label would miss —
`leadBoundCount` counts cards in the column, and the 139 subtasks that moved on 2026-09-14 were not
in it. A button reading `MOVE 33` for an operation that moves 172 is worse than an unlabelled one.

**Clarification:** The label writer in `updateCapLabels()` (`kanban.html:9583`) calls
`leadBoundCount(colId, getAllInColumn(colId))` for the column total. To include cascaded subtasks,
the count must add the subtask fan-out that `_collectAllMovedSessionIds` (`KanbanProvider.ts:9002`)
would produce for each feature in the column. The cleanest path is to compute the cascade-inclusive
total server-side (where `_collectAllMovedSessionIds` already lives) and deliver it on the card
payload, rather than re-deriving the cascade client-side a third time (the archived review at
`memo-archive-2026-09-04.md:224` already flags `leadBoundCount` as a second client-side copy of the
complexity route that cannot see live-pool degradation). Label it as a Clarification, not a new
requirement: the plan already says "the count must include cascaded subtasks."

This is a label, not a gate: it does not interrupt, does not ask, and does not require a second
click.

### 6. Undo interrupts the seats the move dispatched to

A forward move is not only a column change. `Move Selected` is tooltipped *"Move selected plans to
next stage (triggers CLI if enabled)"* — an accidental press fires prompts at live agents, and
restoring the columns while twenty seats keep working on prompts nobody meant to send is not a
recovery. Undo must reach the terminals.

So the operation records **which seats it delivered to**, and undo sends **ESC to every one of
them**. One key, every family, no table and no per-CLI branch.

**Clarification (delivery seam):** ESC is sent through the existing `ptyWrite` seam
(`bootstrap.ts:2680`, `TaskViewerProvider.ts:16621`) with `data: '\x1b'`. This seam is already
wired in both composition roots and accepts raw bytes. No new seam is needed.

**Clarification (seat recording):** The operation records the terminal names it delivered to at
delivery time. The dispatch path already records `dispatchedTerminal` via
`_recordDispatchIdentity` (`KanbanProvider.ts:3872`) → `db.updateDispatchInfo`. The bulk-move
operation collects the terminal names that received a prompt during the move (the seats the
dispatch actually reached) and stores them in the operation record — not inferred from liveness
afterwards. The undo reads this list and sends `ptyWrite({ name, data: '\x1b' })` to each.

The one constraint: **only the seats this operation delivered to**, recorded at delivery — never
every terminal, and never inferred afterwards from liveness. A seat busy on unrelated work is not
part of this undo.

Nothing else is checked. Not whether the seat has finished its turn, not which CLI it is running.
ESC interrupts Claude (demonstrated 2026-09-14), which is the case that matters, and an ESC that
does nothing costs nothing.

**Recorded, so it is not rediscovered as a bug:** copilot echoes ESC as a literal `^[` into its
input box rather than acting on it (measured 2026-08-23). That is a known and accepted limit of
sending one key everywhere, and if copilot needs a different key later it goes in then. A coder
must **not** pre-empt that by building a family→key table — a static list pretending to be a runtime
probe is the mistake `CLI_AGENT_REGEX` was deleted for, and this plan deliberately ships without
one.

### 7. Both composition roots

The move path is shared; the surface that offers the undo, and the pty seam the interrupt
rides, are not. `extension.ts` and
`src/standalone/bootstrap.ts` must both wire it, and both be verified — an undo affordance present
on one host and absent on the other is the divergence `CLAUDE.md` names, and it fails silently.

**Clarification (wiring):** The `ptyWrite` seam is already wired in both roots (cited above). The
new `undoBulkMove` verb must be handled in both `bootstrap.ts`'s verb switch and the extension
host's verb dispatcher. The undo button in `kanban.html` is shared webview markup, so it renders
in both — but the verb it posts must be answered by both hosts. The verification plan's test 9
(checking no confirm gate on either host) and the contract suite must run against both roots.

### 8. Schema migration for `plan_events`

`plan_events` shipped in MIGRATION_V5 (`KanbanDatabase.ts:747`) and was rebuilt in MIGRATION_V20
(`:1364`). Adding `operation_id` requires a new migration step that ALTERs the current table for
the install base. Per CLAUDE.md: shipped state MUST be migrated, never assumed "already ran." The
migration adds `operation_id TEXT DEFAULT ''` to `plan_events` and is idempotent
(`ALTER TABLE ... ADD COLUMN` guarded by a column-existence check, matching the existing migration
pattern). Existing rows get the default empty string — they are not part of any bulk-move
operation and the undo ignores them.

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
8. Assert every delivered seat gets ESC regardless of CLI family, and that no family→key table
   exists on this path.
9. Assert no `confirm()`, `window.confirm()` or modal gate exists on the move path, on either host.
10. Assert the `plan_events` migration adds `operation_id` idempotently and existing rows carry the
    default empty string.
11. Assert the persisted operation id is distinct from the transient dispatch-curtain `operationId`
    (`terminals.js:303`) — the undo reads the persisted id, not the curtain id.

### Goal Invariants

- Any bulk move can be reversed by one action, with no database restore.
- Every card returns to the column it was in, not to a column inferred for it.
- The event log distinguishes a card the operator moved from a card its feature moved.
- Pressing "advance all" by accident costs the operator one action, not a rollback of the board.
- No confirmation dialog exists anywhere on this path.
- The undo button is still on screen a minute after the move that created it, in the same place
  every time.
- Undoing a move sends ESC to every seat that move dispatched to, and to no other seat.
- No seat outside the undone operation is touched.
- The `plan_events` table carries an `operation_id` column on every install, including those
  upgraded from a release that lacked it.

## Outstanding Questions

- **[user]** Should the undo button offer only the most recent bulk move, or a short history (e.g.
  last 3)? Proceeding on the assumption that it offers only the most recent — the button is for the
  accidental press, not a general history browser, and older operations remain restorable from the
  log by a future affordance.
