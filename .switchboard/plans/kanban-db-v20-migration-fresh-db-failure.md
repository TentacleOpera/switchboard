# KanbanDatabase: V20 migration fails on every fresh DB and dumps two stack traces

## Goal

Stop the V20 migration from attempting — and failing — on newly created databases, so a first boot in a
new workspace produces a clean log instead of two stack traces for a migration that cannot succeed and
does not need to run.

### Root problem / background (reproduced 2026-08-04 on a brand-new scratch workspace)

Creating a workspace and booting the standalone CLI against it produces, during initialisation:

```
[KanbanDatabase] V20 step 2: INSERT INTO plans_v20 SELECT * FROM plans WHERE rowid IN (...)
[KanbanDatabase] V20 step 2 FAILED: ... Error: table plans_v20 has 24 columns but 34 values were supplied
[KanbanDatabase] V20 migration FAILED — rolled back. DB unchanged. Error: ... (full stack)
```

Mechanism. On a fresh database the `plans` table is created from the current `SCHEMA_TABLES` definition,
which has **34** columns — every column added between V20 and V57. The V20 migration then creates
`plans_v20` from its *historical* 24-column shape (`src/services/KanbanDatabase.ts:487`) and runs
`INSERT INTO plans_v20 SELECT * FROM plans` (`:517`). `sql.js` validates the column count at exec time
regardless of row count, so the statement fails even though the table is empty. The migration rolls
back (`:6943`) and the schema is left alone.

Blast radius, measured rather than assumed:

- **It is not a functional break.** After the failure the DB still reaches the current schema: the
  migration runner continues, `_ensureSchemaColumns` reconciliation adds what is missing (the log shows
  it adding `subtask_plan_id`, `base_branch` and `tier` to `worktrees`), and `migration_meta` ends at
  `kanban_db_migration_version = 57`. Confirmed by query on the scratch DB. The board then works — a
  seeded plan imported and appeared in `GET /kanban/board`, and `createPlan` succeeded.
- **It does not retry.** Because the version is stamped to 57, the second boot is clean. Verified: the
  rebuilt CLI booting against the same (now-migrated) DB logged no V20 failure.
- **It is a one-shot, first-boot-only event** — which is exactly when a new user is most likely to be
  reading the log.

Why fix it anyway: this codebase has already lost real debugging time to migration noise. The
board-showing-zero-cards incident was ultimately `getWorktrees()` throwing `no such column:
subtask_plan_id` because V42's columns were missing while the migration version was stamped past 42 —
a genuine failure that had to be dug out of the logs. A migration that *always* prints
`migration FAILED` plus a stack trace on first boot trains the reader to skip exactly the lines that
matter, and it makes "did the schema apply?" unanswerable at a glance. The same log also shows several
benign `migration step skipped (already exists): duplicate column name: ...` entries printed with full
stack traces (`:6940`-area handling for V23, V27, V29) — same category of avoidable noise.

## Metadata
- **Tags:** database, bugfix, reliability, devops
- **Complexity:** 4
- **Repo:** `switchboard`

## User Review Required (decisions, with defaults)

1. **Skip V20 on fresh DBs, or make its INSERT column-explicit?**
   **Default (recommended): skip.** A database created from the current `SCHEMA_TABLES` already
   satisfies everything V20 was written to achieve (session_id not unique, `plan_file`+`workspace_id`
   unique). Detect "freshly created at current schema" and stamp historical migrations as satisfied
   without executing them. Naming the 24 columns explicitly in the INSERT would also stop the error, but
   it makes a historical migration keep re-deriving a shape that no live database has — more code,
   same outcome.

2. **Should this apply to all historical migrations or only V20?**
   **Default: all pre-baseline migrations, via one "created fresh" flag.** V20 is the one that errors
   loudly, but V23/V27/V29 already emit `already exists` stack traces on the same fresh boot. One flag
   set at creation time, consumed by the runner, fixes the category rather than the instance.

3. **Downgrade the benign `already exists` logs?**
   **Default: yes, and drop their stack traces.** A skipped step is expected control flow, not an
   error; log it at debug/info with the reason and no stack. Keep full stacks for genuine failures so
   they stand out.

## Complexity Audit

### Routine
- The detection signal is available at creation time: `_initialize` already distinguishes "No DB exists
  … not creating" from "Loaded existing DB", and it logs which path it took.
- `migration_meta` already exists as the stamping mechanism.

### Complex / Risky
- **Migration-runner changes are high-consequence.** A mistake that stamps migrations as applied on a
  database that is *not* fresh would skip real work and produce precisely the V42-style
  "stamped-but-missing-columns" corruption this codebase has already suffered. The freshness signal must
  be unambiguous — derived from the create path, never inferred from an empty `plans` table (a real
  database can legitimately have zero plans).
- **Two hosts, one DB.** The same `KanbanDatabase` runs under the extension and the standalone CLI; a
  behaviour change here affects both, including workspaces that are opened by both.

## Edge-Case & Dependency Audit

- **Race Conditions.** Two processes (editor and CLI) initialising the same new `kanban.db`
  simultaneously could both take the create path. The stamping must be inside the same transaction as
  creation, or one process can stamp while the other is still creating. Existing behaviour already has
  this exposure; do not widen it.
- **Security.** None; local schema management only.
- **Side Effects.** Fewer migrations executed on fresh DBs means less exercise of the migration code in
  everyday use, so a genuine defect in a historical migration would be caught later. Mitigate by keeping
  a test that runs the full historical chain against a **V19-shaped** fixture, so the migrations remain
  covered where they actually apply.
- **Dependencies & Conflicts.** Independent of the standalone plans. Touches
  `KanbanDatabase.ts`, which is also on the path of any in-flight schema work — coordinate if a V58 is
  in progress.

## Dependencies

- None. (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** The bug being fixed is cosmetic; the fix touches the most dangerous file in the
project. Getting the freshness signal wrong converts harmless log noise into skipped migrations on real
data — strictly worse than the problem. The discipline that keeps this safe: derive freshness only from
the code path that created the file, add the stamping inside the creation transaction, and keep a
V19-fixture test so the historical chain stays covered. If that discipline cannot be met cheaply, the
minimal alternative (User Review 1's column-explicit INSERT, or simply suppressing V20's stack trace on
an empty table) is an acceptable smaller win.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — freshness flag

- **Context.** `_initialize` distinguishes create from load (its logs read `No DB exists at … - not
  creating` versus `Loaded existing DB from …`); `SCHEMA_TABLES` defines the current 34-column `plans`;
  `_runMigrations` executes the chain; `migration_meta` holds
  `kanban_db_migration_version` (57 on current builds).
- **Logic.** When the database is created from `SCHEMA_TABLES` in this call, mark it as born at the
  current baseline and have `_runMigrations` stamp the version to the baseline without executing the
  historical steps.
- **Implementation.** Set an instance-level `_createdFresh = true` on the create path only; in
  `_runMigrations`, if `_createdFresh` and the stored version is unset, write the baseline version and
  return before the historical steps. Do the write in the same transaction that created the tables.
- **Edge Cases.** Never infer freshness from `SELECT COUNT(*) FROM plans` — an existing database with
  zero plans is not fresh and must still migrate. If the create path is ambiguous in some caller, fail
  closed by running the migrations (today's behaviour).

### `src/services/KanbanDatabase.ts` — V20 hardening

- **Context.** `plans_v20` DDL at `:487`; the failing `INSERT ... SELECT *` at `:517`; `UPDATE` at
  `:525`; `RENAME` at `:531`; failure logging at `:6940-6943`.
- **Logic.** Belt and braces for any database that reaches V20 with a wider `plans` table than V20
  expects: make the INSERT column-explicit, or skip with a clear reason when the source table's column
  set is not the V20 shape.
- **Implementation.** Prefer an explicit column list matching `plans_v20`'s 24 columns so the statement
  is shape-independent. If the two shapes are incompatible in a way that cannot be mapped, log a single
  explanatory line and skip — not a stack trace.
- **Edge Cases.** Preserve the existing rollback semantics; the current failure at least leaves the DB
  unchanged, and that property must survive.

### `src/services/KanbanDatabase.ts` — log hygiene

- **Context.** The `migration step skipped (already exists): duplicate column name: ...` entries for
  V23/V27/V29, each printed with a full stack.
- **Logic.** Expected-skip conditions log one line without a stack; genuine failures keep full detail.
- **Implementation.** Detect the `duplicate column name` / `already exists` error shapes and log at
  info with the column name and the reason.
- **Edge Cases.** Do not blanket-swallow — an unrecognised error must still print in full, since that is
  how the V42 incident was eventually diagnosed.

## Verification Plan

### Automated Tests

- **Contract — fresh DB boots clean.** Create a new workspace, initialise `KanbanDatabase`, and assert
  the captured log contains no `migration FAILED`, no `ERR`/stack traces, and no `already exists`
  stack traces. Assert `kanban_db_migration_version` equals the current baseline (57) and that the
  `plans` table has the full current column set.
- **Contract — historical chain still runs where it applies.** Build a V19-shaped fixture DB with rows,
  run initialisation, and assert V20 through V57 actually execute and the data survives (including the
  `plan_file`+`workspace_id` uniqueness V20 exists to establish). This is the test that prevents the
  fix from becoming a skipped-migration bug.
- **Regression — a zero-plan existing DB is not treated as fresh.** Take a migrated DB, delete all
  plans, re-initialise, and assert migrations are not re-stamped or skipped incorrectly.
- **Regression — rollback preserved.** Force a V20 failure against an incompatible fixture and assert
  the DB is unchanged, matching today's `rolled back. DB unchanged` guarantee.
- **Manual smoke.** `node dist/standalone/cli.js --workspace <brand-new-dir> --no-open` and read the
  boot log top to bottom: it should contain no failures.

## Uncertain Assumptions

- That every caller of `KanbanDatabase` creates via the same path, so one freshness flag is sufficient.
  The archive DB takes a different route (it logs `No DB exists … - not creating` repeatedly during
  boot), which suggests more than one initialisation entry point — enumerate them before relying on a
  single flag.
- That the baseline to stamp is the current maximum (57) rather than a deliberate lower baseline. If the
  team wants some post-V20 migrations to still run on fresh DBs (e.g. data repairs that also seed
  defaults), the baseline is a judgement call, not a constant.

## Out of Scope

- The repeated `kanban-archive.db … not creating` messages during boot (separate noise, different
  cause).
- Any new schema version.
