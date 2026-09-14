# The Runtime Overlay Passes One Bound Parameter Per Row, and Falls Off a Cliff at 32,766

## Goal

The machine-local runtime overlay stops scaling its bound-parameter count with the size of the read.
A board read of any size succeeds, the SQLite variable ceiling stops being reachable, and the
overlay's merge semantics are written down instead of emergent.

### Problem analysis

**Measured on this board, 2026-09-14.**

`_readRows` (`KanbanDatabase.ts:15011`) is the single row-reader every plan read funnels through.
After reading the shared `plans` rows it runs a second query to merge machine-local runtime state:

```sql
SELECT plan_id, dispatched_agent, dispatched_ide, dispatched_terminal,
       dispatched_team_group, dispatched_at, last_liveness_at, blocked_at
FROM plan_runtime_state
WHERE device_id = ? AND plan_id IN (?, ?, ?, …)   -- one parameter PER ROW
```

then builds a `Map<plan_id, row>` and copies seven fields across with seven hand-written `if`s.

**The parameter list is the defect.** It grows one-for-one with the rows being read. The ceiling is
**32,766 bound parameters** — probed directly against this build's SQLite, not quoted from docs:

```
max bound parameters = 32766
```

Past it SQLite raises *"too many SQL variables"*. There is **no proactive guard** — no limit check, no
chunking; a grep of `KanbanDatabase.ts` for `32766`/`SQLITE_MAX_VARIABLE`/chunking returns nothing.
What happens instead is generic: the overlay's `catch` sees that `plan_runtime_state` exists, logs,
and re-throws, so the whole board read fails. Loud rather than silent, which is right, but it is a
cliff — fine at 32,766 rows, broken at 32,767.

> **Correction to the source finding.** The deferred finding in
> *split-shared-board-state-from-machine-local-runtime* cites `KanbanDatabase.ts:14401` as where this
> "now re-throws". That line is `setPriorityStarred`; the reference has drifted. The re-throw is the
> generic `catch` at the end of the overlay in `_readRows`, and there is no dedicated guard anywhere.

**Distance from the cliff today:** 3,207 plans, 586 active, 1,416 rows in `plan_runtime_state`. The
working-set windowing from *The Board Must Fit a 1 GB Pi* filters dormant PLAN REVIEWED / CODE
REVIEWED cards out of board reads before they reach the overlay. So roughly 50x the current active
count in one workspace is required. Not imminent; also not impossible on a long-lived multi-repo
install with auto-import, and nothing warns as it is approached.

**A SQL join is available but is not a small change.** Both tiers are tables in one better-sqlite3
file, and the PK autoindex (`plan_id` + `device_id`) is already the join key. The file even joins
them in SQL in two other places already — `KanbanDatabase.ts:4688` (a correlated `EXISTS`) and
`:14834` (`JOIN plan_runtime_state r ON p.plan_id = r.plan_id`) — so the pattern is proven here.
But `_readRows(stmt)` takes an **already-prepared statement** and has **~42 call sites**. Converting
to a join means adding a join clause and a `device_id` parameter to 42 queries. That is what Change 4
of the parent plan meant by *"rewriting a working read path to save one join buys nothing."*

**The parameter list does not need the join to disappear.** The `IN (…)` clause exists only to narrow
runtime rows to the ones just read. It does not have to: `plan_runtime_state` is already scoped by
`device_id`, and the orphan sweep (`sweepOrphanedRuntimeState`) keeps it from accumulating rows whose
plan is gone. Selecting every runtime row for **this device** is one parameter, bounded by the
device's own row count (1,416 here), not by the read.

> **Architecture review note (2026-09-14).** The device-scoped query changes the access pattern: the
> current `WHERE device_id = ? AND plan_id IN (…)` uses the PK autoindex on `(plan_id, device_id)`
> — `plan_id` is the leading column, so SQLite seeked each plan_id. The proposed `WHERE device_id = ?`
> cannot use that autoindex (`device_id` is the second column; SQLite composite indexes require the
> leading column constrained) and no standalone `device_id` index exists. Without one, the query
> degrades to a full table scan on every board read. The orphan sweep only removes rows whose
> `plan_id` is absent from `plans` — dormant plans retain their runtime rows — so the device row
> count grows with the total plan count, not the active count. Change 5 adds `idx_plan_runtime_state_device`
> to keep the device-scoped query an index seek instead of a full scan.

### Root cause

The merge was written in TypeScript when the two tiers were expected to live in separate database
files — libSQL embedded replicas sync whole databases, so machine-local state had to be a separate
file and could not be joined. That premise was **withdrawn 2026-09-11** when libSQL was rejected. The
tiers became tables in one file; the read path kept the shape the dead premise required, including
the row-scoped `IN` list that a cross-file merge needed and a same-file merge does not.

### Non-goals

- **Splitting the tiers into two database files.** Explicitly withdrawn in the parent plan; the
  `device_id` keying is what does the work, not the file boundary.
- **Changing which columns are machine-local.** The tier boundary in `storageTiers.ts` is unchanged.
- **The N+1 batching audit.** Deliberately not a prerequisite for this change.
- **Converting all ~42 `_readRows` callers to joins.** Possible later; out of scope here.

## Metadata

**Tags:** database, performance, reliability, backend
**Complexity:** 4

## User Review Required

**The empty-string asymmetry is a behaviour decision, and must be made explicitly.** Today:

```js
if (rt.dispatched_terminal !== undefined && !== null && !== '')  // string: '' IGNORED
if (rt.dispatched_at !== undefined)                              // timestamp: null HONOURED
```

So the runtime tier can clear a timestamp but cannot clear a string: a released seat writing
`dispatched_terminal = ''` leaves the stale value in `plans` standing. Asserted default: **preserve
current behaviour exactly** in this change, and record the asymmetry as a known question, so a
parameter-count fix cannot silently become a semantics change. Whether `''` should clear is worth
settling — stale dispatch holders were observed on this board on 2026-09-14 (cards `072a002b` and
`40fb3702` reported held by `planner-1` long after dispatch moved) and this is one candidate
mechanism, unproven.

## Complexity Audit

### Routine
- Replacing the `IN (…)` clause with `WHERE device_id = ?` — a one-line SQL change in `_readRows` (`KanbanDatabase.ts:15104`).
- The seven field-copy `if`s are unchanged — no logic modification.
- The missing-table `catch` arm (`:15143-15151`) is unchanged.
- The fix is in shared code (`KanbanDatabase.ts`), so it lands once for both composition roots — no parity divergence risk on the change itself.

### Complex / Risky
- Adding a `device_id` index requires a new migration (V78) and a matching addition to `SCHEMA_TABLES_SQL` — two schema definitions must stay in sync (the fresh-DB path at `:728` and the upgrade-DB path via `MIGRATION_V78_SQL`).
- The device-scoped query changes the access pattern from PK-autoindex seek (leading column `plan_id`) to a full table scan without a `device_id` index — a performance regression that the index addition (Change 5) must accompany, or the fix trades a hard cliff for a slow degrade.

## Edge-Case & Dependency Audit

**Race Conditions:** None. `_readRows` is a synchronous read within a single `KanbanDatabase` instance. The overlay query runs after the main rows are fetched and before the result is returned. No concurrent writer can interleave between the two queries in a way that differs from the current code — better-sqlite3 is synchronous.

**Security:** No new surface. The `device_id` is obtained from `getMachineId()` (same as today). No user-controlled input enters the query.

**Side Effects:** The device-scoped query reads ALL runtime rows for the device instead of only the read's rows. The map lookup (`runtimeMap.get(row.planId)`) already discards non-matching rows, so the merged output is identical. The only side effect is increased I/O on boards where the device's runtime row count exceeds the read size — mitigated by the `device_id` index (Change 5).

**Dependencies & Conflicts:**
- The orphan sweep (`sweepOrphanedRuntimeState`, `KanbanDatabase.ts:5647`) runs once per open (`:11238`) and removes only rows whose `plan_id` is absent from `plans`. Dormant plans (in `plans` but windowed out of reads) retain their runtime rows, so the device row count grows with total plan count, not active count. The device-scoped query reads all of them — the `device_id` index keeps this efficient.
- The V78 migration must run after V77 (the current head, `:11230`). The migration runner processes versions in order, so this is automatic.
- `storageTiers.ts` lists `plan_runtime_state` as a machine-local table — unchanged by this plan.

## Dependencies

- `sess_runtime_overlay_cliff` — the 32,766 bound-parameter ceiling probed directly against this build's SQLite on 2026-09-14.
- `sess_orphan_sweep` — `sweepOrphanedRuntimeState` semantics: removes only rows with no matching `plan_id` in `plans`, not dormant rows.

## Adversarial Synthesis

Key risks: (1) the proposed `WHERE device_id = ?` query does a full table scan because `device_id` is the second column of the PK `(plan_id, device_id)` and no standalone index exists — a performance regression that grows with the device's total runtime row count; (2) the plan's claim that the row count is "bounded by the device's own row count (1,416)" understates growth, since the orphan sweep only removes rows whose plan is gone, not dormant plans. Mitigations: add `idx_plan_runtime_state_device` as part of this change (V78 migration + `SCHEMA_TABLES_SQL`); the index makes the device-scoped query an index seek instead of a full scan.

## Proposed Changes

### 1. Drop the per-row `IN (…)` list

In `_readRows`, replace the row-scoped query with a device-scoped one:

```sql
SELECT plan_id, dispatched_agent, dispatched_ide, dispatched_terminal,
       dispatched_team_group, dispatched_at, last_liveness_at, blocked_at
FROM plan_runtime_state
WHERE device_id = ?
```

One bound parameter, always. Build the same `Map<plan_id, row>` and apply the same seven field
copies, unchanged. The overlay keeps its shape; only its selectivity moves from the parameter list to
the map lookup, which already discards non-matching rows.

### 2. Keep the merge semantics byte-identical

The seven `if`s are copied across verbatim, including the empty-string guards. This change is about
parameter count, not behaviour. Any semantic change is a separate card against the question above.

### 3. Keep the missing-table tolerance

The existing `catch` distinguishes "table absent (pre-V74)" from a real failure via
`_getExistingTableNames()`. That stays exactly as-is — it is the only thing letting a pre-migration
database read at all.

### 4. Host scope

`KanbanDatabase` is shared by both composition roots, so the fix lands once. Verification still runs
under both, since the extension and standalone reach `_readRows` through different callers.

### 5. Add a `device_id` index (V78 migration)

The device-scoped query from Change 1 cannot use the PK autoindex on `(plan_id, device_id)` —
`device_id` is the second column, and SQLite composite indexes require the leading column to be
constrained. Without a standalone `device_id` index, the query degrades to a full table scan on
every board read. Today that scan is 1,416 rows (trivial), but the orphan sweep only removes rows
whose plan is gone from `plans`, not dormant plans, so the device row count grows with the total
plan count. At scale (30,000+ plans) a full scan per board read on a Pi is avoidable overhead.

Add the index in two places to keep the fresh-DB and upgrade-DB schemas in sync:

1. **`SCHEMA_TABLES_SQL`** (`KanbanDatabase.ts:728`, after the existing
   `idx_plan_runtime_state_workspace` line):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_plan_runtime_state_device ON plan_runtime_state(device_id)
   ```

2. **New `MIGRATION_V78_SQL`** (after `MIGRATION_V77_SQL`, `KanbanDatabase.ts:1196`):
   ```typescript
   const MIGRATION_V78_SQL = [
       `CREATE INDEX IF NOT EXISTS idx_plan_runtime_state_device ON plan_runtime_state(device_id)`,
   ];
   ```
   And the migration runner block (after the V77 block, `KanbanDatabase.ts:11225-11232`):
   ```typescript
   if (v77 < 78) {
       for (const sql of MIGRATION_V78_SQL) {
           try { this._db.exec(sql); } catch { /* index already exists */ }
       }
       await this.setMigrationVersion(78);
       console.log('[KanbanDatabase] V78 migration completed: device_id index added to plan_runtime_state');
   }
   ```

**Edge cases:** `CREATE INDEX IF NOT EXISTS` is idempotent — safe on a DB that already has the index
(e.g., a fresh DB created post-V78 that already ran the `SCHEMA_TABLES_SQL` copy). The `try/catch`
mirrors the V77 pattern for already-exists tolerance.

## Verification Plan

### Automated Tests

- **Contract (the headline)** — seed a workspace with **40,000 active plans** and read the board.
  Fails today with *"too many SQL variables"*; must pass after. This is the test that proves the
  cliff is gone rather than moved.
- **Contract (no behaviour change)** — for a board with runtime rows present, assert the merged
  output is field-for-field identical before and after, including a row where
  `dispatched_terminal = ''` (the stale value must still stand) and one where `dispatched_at IS NULL`
  (the null must still overlay).
- **Contract** — a database with no `plan_runtime_state` table still reads, exercising the pre-V74 arm.
- **Contract** — runtime rows belonging to a different `device_id` never appear in the merge.
- **Contract** — the V78 migration creates `idx_plan_runtime_state_device`; a fresh DB (post-V78
  `SCHEMA_TABLES_SQL`) has the same index.
- **Parity** — both composition roots produce the same merged rows for the same store.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. The overlay binds exactly one parameter regardless of read size.
2. A board read of 40,000 active plans succeeds.
3. The merged output is unchanged for every case the current overlay handles.
4. A missing `plan_runtime_state` is still tolerated; a present-but-failing one still throws.
5. `idx_plan_runtime_state_device` exists on both fresh and migrated databases.

## Outstanding Questions

- **[user]** Whether `''` should clear a string field (e.g. `dispatched_terminal = ''` releasing a stale seat) — proceeding on the assumption that current behaviour is preserved exactly in this change (see User Review Required). The asymmetry is recorded, not resolved.
- **[user]** Whether the `device_id` index addition (Change 5) should be a separate plan or part of this one — proceeding on the assumption that it is part of this change, since the device-scoped query is the change that makes the index necessary.

## Completion Report

Implemented all five changes in `src/services/KanbanDatabase.ts`: the runtime overlay in `_readRows` now selects `WHERE device_id = ?` (one bound parameter, regardless of read size) instead of `WHERE device_id = ? AND plan_id IN (…)`, removing the 32,766 bound-parameter cliff; the seven field-copy `if`s and the missing-table `catch` arm are byte-identical, so merge semantics and pre-V74 tolerance are preserved. Added `idx_plan_runtime_state_device` to both `SCHEMA_TABLES_SQL` (fresh-DB path) and a new `MIGRATION_V78_SQL` with a matching runner block (upgrade-DB path), keeping the device-scoped query an index seek rather than a full scan. The change lands in shared code, so both composition roots get it once. Compilation and automated tests were skipped per the run directives; the verification steps remain written down in the plan above.

## Review Findings

Reviewed `src/services/KanbanDatabase.ts` (commit `835f198c`); the coder ran no compilation or tests, so this pass ran them. The device-scoped overlay was reverted to a **chunked** row-scoped overlay (`RUNTIME_OVERLAY_CHUNK = 500`) because it was measured to be a 222x regression on the reference board: a single-plan lookup went from 23 µs to 5,111 µs, since every `_readRows` call — including `getPlanByPlanId` and the ~61 loop-adjacent single-plan read sites — materialised all 1,402 runtime rows this device owns, and `idx_plan_runtime_state_device` did **not** mitigate it (5,268 µs *with* the index; the cost is row materialisation, not the scan). Chunking caps the bound-parameter count at 501 per query so SQLite's 32,766 ceiling stays unreachable at any read size, while keeping the PK-autoindex seek and cost proportional to the read. Added `src/test/runtime-overlay-parameter-ceiling.test.js` (six invariants incl. a 40,000-plan read, the empty-string asymmetry, device isolation, the pre-V74 arm and the V78 index) and wired it into CI at `.github/workflows/integration-tests.yml:1022`. Verification: `npm run compile-tests` clean, new suite 6/6 pass, bound-parameter ceiling independently probed (32,766 OK / 32,767 throws "too many SQL variables"); the V78 index and migration are kept as-is.

## Deferred Findings

- MAJOR — `.github/workflows/integration-tests.yml` — `npm run test:contract:storage-scripts-parity` is currently RED for reasons unrelated to this plan: `test:contract:tmux-seat-reuse`, `test:contract:tmux-team-start-idempotent` and `test:contract:tmux-solo-seat-single-session` are defined in `package.json` but invoked by no workflow step. Pre-existing; not fixed here because they belong to the tmux seat work.
- MAJOR — `src/services/KanbanDatabase.ts:731` — `idx_plan_runtime_state_device` (V78) is now used by no query in the tree: the overlay is row-scoped again and `sweepOrphanedRuntimeState` is not device-scoped. It is retained because Goal Invariant 5 names it and the write cost on a ~1,400-row table is negligible, but it is dead weight until a device-scoped query exists.
- MAJOR — `src/services/KanbanDatabase.ts:15161` — the plan's "Parity — both composition roots produce the same merged rows for the same store" test was not written. The change is in shared `KanbanDatabase`, so divergence is structurally impossible here, but the named check does not exist.
- NIT — `src/services/KanbanDatabase.ts:1218` — the V78 runner block calls `this.getMigrationVersion()` a second time into a local named `v78` after the V77 block already read it; harmless, matches the surrounding pattern.
- NIT — `src/services/KanbanDatabase.ts:15163` — the overlay now de-duplicates plan ids with a `Set` before chunking (the previous code did not). Output is identical; it only avoids re-binding a duplicate id.
- NIT — plan text cites `SCHEMA_TABLES_SQL:728` as the home for the new index; indexes actually live in `SCHEMA_INDEX_STATEMENTS` (`:702`, per the comment at `:389`). The implementation used the correct list — the plan's citation was wrong, not the code.
- NIT — the empty-string asymmetry (`dispatched_terminal = ''` cannot clear a stale value) is preserved exactly, as the plan required, and is now pinned by a test. It remains an open question, not a defect of this change.

### Review Deviations

**What changed.** Goal Invariant 1 says the overlay "binds exactly one parameter regardless of read size", and Change 1 specifies `WHERE device_id = ?` with no plan-id list. This review replaced that with a row-scoped `plan_id IN (…)` list **chunked at 500**, so the parameter count per query is capped at 501 and still never grows with the read.

**Why the original destination was a blocker.** Measured on this board on 2026-09-14, with the device owning 1,402 runtime rows: the device-scoped form costs 5,111 µs per `_readRows` call versus 23 µs for the row-scoped form — 222x, paid on *every* call, including every single-plan lookup. `idx_plan_runtime_state_device`, which Change 5 adds specifically to mitigate this, was measured to make no difference (5,268 µs with the index, 5,111 µs without) because the cost is materialising 1,402 rows and building a Map, not the table scan. There are ~61 loop-adjacent single-plan read sites (`KanbanProvider.ts:3378`, `LocalApiServer.ts:3075`, `TransferBundleService.ts:609` and others), so a board-wide sweep pays this thousands of times. The plan's own analysis notes the device's runtime row count grows with *total* plans rather than active ones, so this cost grows while the cliff it avoids requires 32,767 rows in a single read — roughly 50x the current post-windowing board read of 586.

**What the author needs to decide.** Whether "exactly one bound parameter" was the goal, or whether "the parameter count never scales with the read, and the ceiling is unreachable" was — chunking satisfies the second and the Goal prose, but not the first as literally written. If exactly-one is required, the device-scoped query needs a different mitigation than an index (a cached-and-invalidated device map, or the SQL join the plan lists as a non-goal). Goal Invariant 5 (the V78 index) is left in place either way.
