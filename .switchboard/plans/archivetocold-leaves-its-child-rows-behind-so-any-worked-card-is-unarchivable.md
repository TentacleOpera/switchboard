# `archiveToCold` Leaves Its Child Rows Behind, So Any Card That Was Worked On Cannot Be Archived

## Goal

Archiving a plan moves the plan **and everything that references it**, so the delete from the hot
store succeeds. A card that has history archives exactly as easily as one that has none, and a
partial move reports itself instead of settling into a state the code calls "crash-safe".

### The problem, and the root cause

**Measured 2026-09-18 on the Pi, against the live board.** A completed-only archive pass over 2,559
plans, calling the shipped `archiveToCold` primitive once per plan:

```
moved   =   343
failed  = 2,216      SqliteError: FOREIGN KEY constraint failed
                     on DELETE FROM plans WHERE plan_id = ?
```

The split is not random. It is exact:

- **343 succeeded** — plans with no rows in `plan_events`.
- **2,216 failed** — plans with at least one row in `plan_events`.

`archiveToCold` (`KanbanDatabase.ts:6035`) copies the plan row into the cold store and then deletes
it from hot. `plan_events` holds `FOREIGN KEY (plan_id) REFERENCES plans(plan_id)` with **`NO
ACTION`** on delete, and the archive copies **no child rows at all**. So the delete is refused for
every plan that has ever emitted an event — which is every plan anyone actually worked on.

**The cold store proves the child rows are not being carried.** After the pass:

| store | plans | plan_events |
| :--- | ---: | ---: |
| hot (board) | 2,216 completed + 658 active | 14,261 |
| cold (archive) | 2,559 | **0** |

The cold store *has* a `plan_events` table. It has never received a row. 8,506 of the hot events
belong to the plans that were meant to move.

**Failure is silent, because the half-done state has a name.** `runPartitionSweep`'s own docstring
describes a plan present in both stores as "at worst double-homed (reconciled on next activation)"
— a legitimate mid-sweep condition. So 2,216 plans copied-but-not-deleted is indistinguishable from
a sweep that was interrupted, and `_readUnion`'s hot-wins precedence means every read still returns
the right row. Nothing surfaces. The board renders exactly as before, the archive reports 2,559
plans, and the operator's conclusion is that archiving "did nothing".

**Schema drift blocks the obvious fix.** The two `plan_events` tables are not the same shape:

```
hot:   event_id, plan_id, event_type, workflow, action, timestamp,
       device_id, vector_clock, payload, workspace_id, user_id
cold:  event_id, plan_id, event_type, workflow, action, timestamp,
       device_id, user_id, payload, workspace_id
```

Hot carries `vector_clock`; cold has no such column. A `SELECT *` copy fails or misaligns. (On this
board `vector_clock` is empty in all 14,261 rows, so the data loss is nil *here* — but a migration
that silently drops a column because one install happens not to use it is the wrong shape of fix.)

### Root cause

`archiveToCold` implements "move a plan" as "copy one row, delete one row". A plan is not one row.
It is a row plus its referencing children, and the schema enforces exactly that with a foreign key.
The primitive was written against the plan table alone, the FK was added (or predated it) with `NO
ACTION`, and no test covers archiving a plan that has events — so the one case that matters in
production is the one case that has never been exercised.

## Non-goals

- **Wiring the sweep, or fixing the switch that gates it.** `runPartitionSweep` has **zero callers**
  anywhere outside tests — not in `bootstrap.ts`, not in `extension.ts`, not on a timer, not behind
  an endpoint — and `/database/retention/config` reports `{"enabled": false, "source": "default"}`.
  Those are cards `a064cf90` and `ccffc96a`, already on the board; see Dependencies for why they
  must land after this one and not before.
- **Restoring a manual archive path.** `archiveSelected` now answers *"The archive export has been
  removed. Completed cards leave the board via the hot window; their rows stay in the board store."*
  Whether an operator should be able to take a card off the board deliberately is a product
  question, owned by no card today.
- **Changing the hot window.** It is a render filter over `getCompletedPlansInHotWindow`; it hides
  rows and moves nothing. Out of scope here.
- **Reconciling the 2,216 rows already double-homed on this board.** That is an operational
  clean-up, and it is the verification case below, not the deliverable.

## Metadata

**Tags:** bugfix, database, storage, reliability
**Complexity:** 5

## Scope: shared service, both roots

`src/services/KanbanDatabase.ts` — `archiveToCold`, `restoreToHot`, and the cold-store schema
creation. This is a shared service both composition roots already consume, so the fix reaches the
extension host for free and is not throwaway work; no new host-specific wiring is added to
`extension.ts`.

## Proposed changes

### 1. Enumerate the children from the schema, not from a hand-written list

Before deleting, `archiveToCold` must move every row that references the plan. Derive that set from
`PRAGMA foreign_key_list` across the cold/hot schema rather than hardcoding `plan_events` — today
`plan_events` is the only FK onto `plans`, and a hardcoded list is a second source of truth that
goes stale the first time a table is added.

For each referencing table: copy the plan's rows into cold, then delete them from hot, then delete
the plan row. One transaction per plan, so a failure anywhere leaves that plan wholly in hot.

### 2. Make the cold schema match, and refuse rather than narrow

The cold store's `plan_events` is missing `vector_clock`. Bring the cold schema into line with hot
(an additive `ALTER TABLE` on the archive, guarded by a migration-meta bump).

Where a column genuinely cannot be carried, the copy **fails loudly naming the column** — it does
not proceed with a narrowed column list. A migration that drops a column because it is empty on the
machine that ran it is the quiet-wrong-answer shape: it works on the install that wrote it and
loses data on the next one.

### 3. A partial move is an error, not a documented resting state

`archiveToCold` returns `boolean` today, and a `false` is indistinguishable from "already cold".
Return the reason — `{ moved: true }` or `{ moved: false, reason, blockedBy }` — and have
`runPartitionSweep` stop on the first blocked plan rather than logging 2,216 identical warnings and
returning a count that looks like partial success.

"Double-homed" should remain legal only as a *crash* artifact. A move that was refused by a
constraint is a bug, and it must not present as the same state.

### 4. Reconcile double-homed rows on open, since the state is reachable

The docstring already promises reconciliation "on next activation" and nothing implements it. On
cold-store open, a plan present in both stores with identical content should have its hot copy
removed (children first); one whose content differs should be reported, never silently resolved by
precedence. Without this, the 2,216 rows on this board stay forever and every future sweep
re-attempts them.

## Complexity Audit

### Routine

- Deriving the referencing-table set from `foreign_key_list`.
- The additive cold-schema `ALTER TABLE` plus migration-meta bump.
- Widening `archiveToCold`'s return type and its two call sites.

### Complex / Risky

- **Cross-database transactions.** `KanbanDatabase.ts:5646` already records the constraint: *"two
  sql.js files can't share a transaction, so moves use…"*. Whatever ordering that comment protects
  must be preserved — copy-then-delete, never delete-then-copy, so an interruption leaves the row
  double-homed rather than absent. **Note for the implementer:** the driver is better-sqlite3
  (`src/services/sqliteDriver.ts:209`) in WAL mode; that comment's `sql.js` premise is stale and
  should be corrected, but the copy-first ordering it mandates is still right.
- **Deleting child rows is irreversible.** The delete must be gated on a verified count in cold, per
  plan, not a blanket "the insert didn't throw".
- **`restoreToHot` has the mirror bug.** If children now live in cold, a restore must bring them
  back. Fixing only the archive direction makes restore lossy — worse than today, where restore
  moves as little as archive did.

## Edge-Case & Dependency Audit

- **A plan with events but no plan row in cold** (an interrupted earlier attempt) must be handled
  idempotently: re-running the move is the recovery path, so an `INSERT` that collides on
  `event_id` must upsert or be pre-filtered, not abort the transaction.
- **`event_id` is `INTEGER PRIMARY KEY AUTOINCREMENT` in both stores.** Copying with explicit ids
  preserves identity but can collide with cold's own sequence if anything ever writes events
  directly to cold. Assert cold's `plan_events` is archive-only, or key the copy differently.
- **Status values other than `completed`.** This board also holds 65 `deleted` and 1 `missing`. The
  sweep's `selectColdEligiblePlanIds` excludes only `status != 'deleted'`, so `missing` is eligible.
  Decide deliberately which statuses may move.
- **Feature cohesion.** Verified on this board: 0 completed cards are subtasks of an active feature,
  0 completed features have active subtasks, 0 completed cards are in-flight. Those are not
  invariants — the move must still refuse to split a feature unit.
- **Concurrency.** better-sqlite3 in WAL mode permits a second writer, so an archive pass can run
  against a live board. The board rebuilds from the database on each push, so it picks up the
  change; but a long pass holding a write transaction will block the board's writes. Batch and
  release, as `runPartitionSweep` already does.

## Dependencies

**This card is first in a chain of three that already exist on the board.** Nothing blocks it, and
it blocks both of the others.

1. **This card** — `archiveToCold` carries its child rows, so a plan with history can be deleted
   from hot at all.
2. **`a064cf90` — *Auto-Archive Has Never Run: the Advertised Switch Is Not the One Read***
   (PLAN REVIEWED). Two settings look like one switch: `switchboard.archive.autoArchiveCompleted`
   defaults `true` and is never read, while the one the service consults defaults `false` and has
   never been written — confirmed live, `/database/retention/config` answers
   `{"enabled": false, "source": "default"}`.
3. **`ccffc96a` — *Archive on Startup What Has Been in Completed Two Weeks*** (PLAN REVIEWED). The
   startup sweep that stops the hot store refilling.

Both are subtasks of feature **`6b752808` — *Board Rows Outlive Their Plans, and Nothing Archives
Them***.

**The order is load-bearing.** Landing 2 or 3 before this card produces a sweep that runs and
silently fails: it archives the event-less minority, leaves every card with history double-homed,
and that state is documented as legitimate — so the failure reports as success. Measured today,
that ratio is **343 succeeded / 2,216 failed**. A sweep that does not run is better than one that
appears to.

**Two further gaps neither of those cards closes, worth checking during 2:**

- `AutoArchiveService:233` calls `db.archivePlan(planFile, workspaceId, 'archived')` — **not**
  `runPartitionSweep`. So fixing the switch revives `archivePlan`, and the partition sweep stays
  dead code with zero callers in either root.
- `archivePlan` is **not implemented in the standalone host** (`POST /kanban/verb/archivePlan` →
  `502 Verb 'archivePlan' not implemented in standalone mode`). On the host that actually ships,
  fixing the switch wires a service to a verb that answers 502.

**No operator-driven archive path exists either.** `archiveSelected` now answers *"The archive
export has been removed. Completed cards leave the board via the hot window; their rows stay in the
board store."* Whether an operator may take a card off the board deliberately is a product
question, unowned by any of these three cards.

## Verification Plan

### Automated Tests

- **Contract** — archive a plan **with** `plan_events` rows; assert the plan and every event land in
  cold, both are gone from hot, and the call reports success. **This is the test that does not exist
  today, and it is the whole bug.**
- **Contract** — archive a plan with no events; unchanged behaviour (the 343 case).
- **Contract** — a cold schema missing a hot column makes the copy fail naming that column; it does
  not silently narrow.
- **Contract** — `restoreToHot` on an archived plan brings its events back.
- **Contract** — kill the process between the cold insert and the hot delete; assert the plan is
  double-homed, and that reconciliation on next open completes the move.
- **Regression** — `archiveToCold` never reports success while any referencing row remains in hot.

Run `npm run compile-tests` before any `test:contract:*` script.

### Manual Verification

On this board, the 2,216 double-homed plans are the live fixture: after the fix, a second pass
completes them, hot `completed` reaches 0, cold holds 2,559 plans and 8,506 events, and both stores
pass `PRAGMA quick_check`.

### Goal Invariants

1. A plan's archivability does not depend on whether it has history.
2. No delete from hot happens until the corresponding rows are verified present in cold.
3. A refused move reports the constraint that refused it; only a crash leaves a plan double-homed.
4. Archive and restore move the same set of rows.

## Resolved 2026-09-18 — fixed, and the mechanism it described is gone

`archiveToCold` no longer copies across two databases. The archive is now the
`plans_archive` / `plan_events_archive` tables inside the board database, so the move is a
single transaction in one database that deletes children **before** the parent row. That
ordering is the fix this card asked for: the NO ACTION foreign key on `plan_events` was
refusing the parent delete for every plan that had ever emitted an event, which is why 2,216
worked cards were copied-but-not-deleted.

Two consequences for the numbers in this card:

- The cold store's empty `plan_events` is no longer a thing. The 8,506 events this card
  identified as stranded were carried into `plan_events_archive` and are present there.
- The "double-homed, reconciled on next activation" state that made the failure silent
  cannot occur any more. Verified on the live board: 728 board plans, 2,559 archived,
  **0 in both**.

The cold-schema drift item at the end of this card is also moot -- `plans_archive` and
`plan_events_archive` are cloned from the live tables, and the move builds its column list
from PRAGMA at runtime rather than a hardcoded list, so a column present on one side and not
the other is skipped instead of silently dropped.

Ready to move off CREATED.
