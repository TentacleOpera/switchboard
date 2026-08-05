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
- **Project:** browser-switchboard

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
- The detection signal is available at creation time — and it is a whole method, not a flag:
  `createIfMissing()` (`:1809-1865`) is the ONLY path that creates a database
  (`new SQL.Database()` at `:1836`). `_initialize` never creates — on a missing file it logs
  `No DB exists at … - not creating` and returns false (`:6339-6347`).
- `migration_meta` already exists as the stamping mechanism (`setMigrationVersion`, `:1880`).

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
data — strictly worse than the problem. The discipline that keeps this safe: stamp only inside
`createIfMissing()` (the sole create path — no flag, no inference from table contents), and prove
stamped-fresh and migrated-fresh databases converge via the schema-equivalence diff in the
Verification Plan. If that discipline cannot be met cheaply, the minimal alternative (User Review 1's
column-explicit INSERT, or simply suppressing V20's stack trace on an empty table) is an acceptable
smaller win.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — stamp the baseline on the create path

- **Context.** `createIfMissing():1809-1865` is the only creation path: `new SQL.Database()`
  at `:1836`, then `SCHEMA_TABLES (create)` + `_ensureSchemaColumns()` + `_applySchemaIndexes()`
  + `_runMigrations()` at `:1838-1842`. `_runMigrations` gates V20 and later on
  `getMigrationVersion()` (e.g. V20 at `:6923-6924`; V40–V57 each stamp at
  `:7516`-`:8028`); V2–V19 run ungated every boot but are idempotent try/catch no-ops.
  `migration_meta` holds `kanban_db_migration_version` (57 on current builds).
- **Logic.** A database created from current `SCHEMA_TABLES` in this call already satisfies
  everything the version-gated historical migrations were written to achieve. Stamp the
  baseline in the create path so the gated chain (V20–V57) is skipped; the ungated V2–V19
  blocks still run and no-op as they do today.
- **Implementation.**
  > **Superseded:** Set an instance-level `_createdFresh = true` on the create path only; in
  > `_runMigrations`, if `_createdFresh` and the stored version is unset, write the baseline
  > version and return before the historical steps.
  > **Reason:** The plan located the create/load distinction in `_initialize`, but
  > `_initialize` never creates — it refuses (`:6339-6347`). The real create path is
  > `createIfMissing()`, which is itself an unambiguous freshness signal, so no instance flag
  > is needed at all. A flag also invites a future caller to set it wrongly.
  > **Replaced with:** In `createIfMissing()`, immediately after `_applySchemaIndexes(
  > 'SCHEMA_INDEXES (create)')` (`:1841`) and before `_runMigrations()` (`:1842`), write the
  > current baseline version via `setMigrationVersion(CURRENT_SCHEMA_VERSION)` (introduce a
  > named constant equal to the highest gated migration, currently 57, next to
  > `MIGRATION_VERSION_KEY`). The version gates then skip V20–V57 naturally; no runner-branch
  > or flag is introduced. The write happens while `this._db` is the freshly created
  > in-memory database, before the first `_persist()` at `:1846`, so creation and stamping
  > land in the same on-disk write.
- **Edge Cases.** Never infer freshness from `SELECT COUNT(*) FROM plans` — an existing
  database with zero plans is not fresh and must still migrate. If some future caller creates
  a DB through a different route, it takes today's behaviour (migrations run) — fail closed.
  Two processes racing `createIfMissing` on the same path: the stamp is part of the creation
  write, so it cannot interleave with another process's migration run any worse than creation
  itself already can.

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

> Per dispatch directive, no automated tests and no compilation steps are part of this
> verification plan — manual verification only.

- **Manual — fresh DB boots clean.** Create a brand-new scratch workspace, boot the
  standalone CLI against it, and read the initialisation log top to bottom: no
  `migration FAILED`, no V20 step output, no `already exists` stack traces. Then query
  `migration_meta` and assert `kanban_db_migration_version = 57`.
- **Manual — schema equivalence (the load-bearing check).** Produce two scratch databases:
  one created with the fix (stamped, migrations skipped) and one created on the build
  *without* the fix (full historical chain, V20 rolled back). Diff the output of
  `SELECT sql FROM sqlite_master ORDER BY name` (plus a `PRAGMA table_info` dump per table)
  between the two. They MUST be identical — this is what proves "stamped fresh" and
  "migrated fresh" converge, and what prevents the fix from becoming a skipped-migration bug.
  Pay specific attention to whatever V55's hot/cold partition init materialises on an empty
  DB.
- **Manual — historical chain still runs where it applies.** Take a real pre-V20 database
  (an old install's `kanban.db`, or one hand-shaped to V19) with rows in `plans`, open it
  with the fixed build, and confirm V20–V57 execute, the data survives, and the version
  ends at 57.
- **Manual — zero-plan existing DB is not treated as fresh.** Open a migrated DB, delete all
  plans, re-open, and confirm no re-stamping and no skipped-migration log lines.
- **Manual — board works on a stamped DB.** Seed a plan into the fresh workspace and confirm
  it appears on the standalone board (`GET /kanban/board`).

## Uncertain Assumptions

- That stamping 57 skips nothing a fresh DB actually needs. Most version-gated migrations
  are schema/data repairs that are no-ops on an empty current-schema DB, but V55's
  "hot/cold partition initialized" may materialise state (config flags, archive structures)
  rather than just tables. This is resolvable locally — the schema-equivalence diff above
  is the arbiter — but if V55 (or any gated migration) proves to do something
  `SCHEMA_TABLES` doesn't, the baseline constant must be lowered to just below that
  migration instead of 57.
- That V20 through V57 are ALL individually version-gated (spot-checked: V20 `:6924`, V40–V57
  each stamp inside a gate). Confirm V21–V39 carry gates before relying on the stamp to skip
  them; any ungated migration in that range still runs and must stay idempotent — same as
  today.

## Out of Scope

- The repeated `kanban-archive.db … not creating` messages during boot (separate noise, different
  cause).
- Any new schema version.

## Completion Report

Added `CURRENT_SCHEMA_VERSION` (57) and stamp it inside `KanbanDatabase.createIfMissing()` before `_runMigrations()`, so fresh databases skip the gated V20-V57 chain. Made the V20 `INSERT` column-explicit to remove the `SELECT *` shape dependency for any DB that still runs it. Downgraded V27 and V29 benign `already exists`/`duplicate column` skips to one-line `console.info` while preserving full `console.error` for genuine failures. No compilation or tests were run per the dispatch directive.
