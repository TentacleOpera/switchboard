# The standalone server builds a first-boot kanban.db by a path that skips createIfMissing

## Goal

Make the database the standalone server creates on first boot identical to the one `npx switchboard init`
creates. Two different code paths build a fresh DB and they disagree about which indexes and which
repair passes the finished DB gets. The start-path swap (step 1) has shipped; the remaining work is
converging the two creation paths so the divergence cannot reintroduce via `_initialize()`.

### Problem analysis (re-verified against HEAD ead33f59)

> **Superseded:** `startHeadlessSwitchboard` does not use the explicit-creation API. `bootstrap.ts:473-485` writes a zero-byte `kanban.db` then calls `ensureReady()`.
> **Reason:** Step 1 of this plan shipped. The start path now calls `await db.createIfMissing()` at `bootstrap.ts:850`. The zero-byte pre-touch and the `ensureReady()` call are gone.
> **Replaced with:** The start path at `bootstrap.ts:838-850` resolves the DB, mkdir's the parent, and calls `await db.createIfMissing()`. The comment at `:844-849` documents why `createIfMissing` is used instead of `ensureReady` (the latter refuses to auto-create). The primary symptom — a start-born DB missing post-migration indexes — is fixed because `createIfMissing` re-applies `SCHEMA_INDEXES` after migrations (`:2607`).

The **remaining divergence** is between the two creation paths themselves, both of which still exist and are both still called:

**`createIfMissing()` re-applies the schema indexes after migrations; `_initialize()` does not.**

- `createIfMissing()` (`KanbanDatabase.ts:2545-2622`): SCHEMA_TABLES (`:2579`) → `_ensureSchemaColumns` (`:2580`) → `_applySchemaIndexes('SCHEMA_INDEXES (create)')` (`:2581`) → `_runMigrations` (`:2601`) → `_ensureSchemaColumns` (`:2602`) → **`_applySchemaIndexes('SCHEMA_INDEXES (post-migration)')` (`:2607`)** → `_persist` (`:2610`) → `getWorkspaceId` (`:2616`) → `_runConfigMigrations` (`:2620`).
- `_initialize()` (`KanbanDatabase.ts:9231-9290`): SCHEMA_TABLES (`:9281`) → `_ensureSchemaColumns` (`:9282`) → `_applySchemaIndexes('SCHEMA_INDEXES')` (`:9283`) → `_runMigrations` (`:9286`) → `_ensureSchemaColumns` (`:9287`) → `_persist` (`:9290`). **No post-migration re-apply.**

That final line in `createIfMissing` is not decoration, and its own comment says why: migration V20
rebuilds `plans` by creating `plans_v20` and then `ALTER TABLE plans_v20 RENAME TO plans`, which
destroys every index on the table and recreates only its own six. On a fresh database V20 now runs to
completion rather than failing — its INSERT is column-explicit, which was the fix for the
"V20 migration fails on every fresh DB" report — so the index destruction is a live consequence, not a
hypothetical one. `_initialize()` never re-applies, so a database reloaded through `ensureReady()` on
an existing file that went through V20 is missing the SCHEMA_INDEXES entries V20 dropped (the comment
names `idx_plans_project_id` and `idx_plans_workspace_name`).

**The divergence runs the other way too, so the fix is not a one-line swap.** `_initialize()` ends with a
subtask-project invariant reconcile that runs on every startup and is explicitly *not* version-gated
(sited after `_runConfigMigrations` in `_initialize`). `createIfMissing()` runs `_runConfigMigrations`
(`:2620`) but does NOT run the subtask-project invariant reconcile. So `init`-born databases get the
indexes and skip the reconcile; databases reloaded through `_initialize` get the reconcile and miss the
indexes. Whichever way this is unified, the result has to be the union, not one path's behaviour imposed
on the other.

**Blast radius, stated honestly.** Missing indexes are a performance and consistency defect, not
corruption: every query still returns correct rows. The schema version reaches current on both paths, and
a fresh CLI boot has been observed reaching v57 with all tables present. What makes it worth fixing is
that it makes "is this database in the expected shape?" unanswerable — the same class of ambiguity that
cost real debugging time in the V42 incident, where a stamped-but-incomplete schema surfaced as a board
showing zero cards.

**Edge case: interrupted creation.** The start path no longer creates zero-byte files (the pre-touch is
gone), but an interrupted `createIfMissing` — power loss between `openDriver(this._dbPath, { fileMustExist: false })` (`:2573`) and `_persist` (`:2610`) — can leave a partial or empty file. On the next boot,
`createIfMissing` checks `fs.existsSync` (`:2552`) and routes to `ensureReady()` → `_initialize()`, which
opens with `fileMustExist: true` (`:9263`). A zero-length or corrupt file throws there. The repair is
still relevant, just less common than when the pre-touch created zero-byte files on every first boot.

## User Review Required

None.

## Complexity Audit

### Routine

- Adding one `_applySchemaIndexes('SCHEMA_INDEXES (post-migration)')` call after `_runMigrations` in `_initialize()` — the pattern already exists in `createIfMissing()`.
- Adding the subtask-project invariant reconcile to `createIfMissing()` — the code already exists in `_initialize()`.
- Zero-byte file detection: `fs.statSync` → `size === 0` → unlink → retry `createIfMissing`.

### Complex / Risky

- **Determining what the "subtask-project invariant reconcile" actually is and whether it is safe to run during `createIfMissing`.** The plan's original analysis cited `:7035-7040` (now shifted) for this reconcile. It runs after `_runConfigMigrations` in `_initialize` and is explicitly not version-gated. Running it in `createIfMissing` on a fresh DB needs verification that it doesn't depend on state that doesn't exist yet on a brand-new database.
- **The reload-path cost.** Adding post-migration index re-apply to `_initialize` runs on every startup, not just first boot. The plan argues this is an idempotent no-op, but that needs confirmation against the current `_applySchemaIndexes` implementation (`:12512`).

## Edge-Case & Dependency Audit

**Race Conditions:** An interrupted `createIfMissing` leaving a partial file is the primary remaining race. The repair (step 3) addresses it by treating zero-length files as absent.

**Security:** No security surface — this is internal DB initialization.

**Side Effects:** Adding the invariant reconcile to `createIfMissing` changes what `init` does on first run. If the reconcile mutates plan rows (e.g. reassigning subtask-project links), a fresh DB with no plans is a no-op, but an `init` against a pre-existing DB that was previously `createIfMissing`-born (and thus never reconciled) would now get reconciled. That is the intended behaviour, but it is a behaviour change on a shipped path.

**Dependencies & Conflicts:** Collides with `first-run-setup-wizard-for-the-standalone-host.md` — both edit the first-boot block in `bootstrap.ts`. That plan builds its probe in front of the `createIfMissing` call this plan established. Land this plan's convergence first; the wizard builds on top.

## Dependencies

- Collides with `first-run-setup-wizard-for-the-standalone-host.md` — both edit `bootstrap.ts` first-boot logic. This plan's step 1 (shipped) established `createIfMissing` as the creation call; the wizard builds its probe in front of it.

## Adversarial Synthesis

Key risks: (1) The subtask-project invariant reconcile may not be safe to run during `createIfMissing` on a fresh DB if it depends on state that doesn't exist yet — needs verification before lifting. (2) Adding post-migration index re-apply to `_initialize` runs on every reload, not just first boot — the idempotency claim needs confirmation against the current `_applySchemaIndexes` implementation. (3) The zero-byte repair (step 3) is lower priority now that the pre-touch is gone, but an interrupted `createIfMissing` can still leave a partial file. Mitigations: verify the reconcile's preconditions before lifting; confirm `_applySchemaIndexes` idempotency on existing indexes; treat zero-length files as absent and retry creation.

## Proposed changes

1. **SHIPPED — `src/standalone/bootstrap.ts:838-850`** — the zero-byte pre-touch was dropped and
   `await db.createIfMissing()` is now called directly. No further action needed on this step.

2. **Converge the two creation paths** rather than switching callers between them. Lift the post-migration
   `_applySchemaIndexes('SCHEMA_INDEXES (post-migration)')` into `_initialize()` (after `_runMigrations` at
   `:9286`, before `_persist` at `:9290`), so no third caller can reintroduce the gap. Lift the
   subtask-project invariant reconcile from `_initialize()` into `createIfMissing()` (after
   `_runConfigMigrations` at `:2620`), so `init`-born databases get the reconcile too. On the reload path
   the extra re-apply is an idempotent no-op cost, which is the right trade for removing a whole divergence
   class. **Verify the reconcile's preconditions before lifting** — it must not depend on state absent on
   a fresh DB.

3. **Repair a zero-byte or partial `kanban.db`** left by an interrupted `createIfMissing`: in
   `createIfMissing()` before the `fs.existsSync` check at `:2552`, treat a zero-length file as absent
   (unlink, then proceed to create) so the complete path is taken. A corrupt non-zero partial file is
   harder — `openDriver` with `fileMustExist: false` would overwrite it, but that may mask real corruption;
   log a warning and proceed rather than silently overwriting.

## Verification plan

### Automated Tests

1. **Diff the two creations.** Build one DB via `npx switchboard init` and one via a bare start, in
   separate temp dirs, then compare
   `SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name` across both. Expect an
   empty diff after the fix (the start path already uses `createIfMissing`; the convergence ensures
   `_initialize`-born DBs match too).
2. **Schema version parity.** Assert `migration_meta.kanban_db_migration_version` matches on both.
3. **Contract test.** Add one beside `test:contract:db-backup-retention` asserting index/table parity
   between the two creation paths, so a future caller cannot silently reintroduce the divergence.
4. **No second-boot churn.** Boot again against each database and assert no schema-change log lines (no new
   index, no added column) — a fresh DB that still mutates on second boot means the first pass was
   incomplete.
5. **Aborted first boot.** Hand-create a zero-byte `kanban.db`, boot, and assert a full-schema database
   with indexes rather than a load of the empty file.
6. **Failure path.** Point `kanban.dbPath` at an unwritable location and assert the boot fails with a clear
   message instead of serving an empty board.
7. **Invariant reconcile on init-born DB.** After `createIfMissing` on a fresh DB, assert the
   subtask-project invariant reconcile ran (check for its log output or side effect), confirming the
   convergence is complete in both directions.

### Goal Invariants

- `sqlite_master` for a start-born DB and an init-born DB are identical (same set of indexes, same tables, same schema version).
- `_initialize()` calls `_applySchemaIndexes` after `_runMigrations` (post-migration re-apply exists in both paths).
- `createIfMissing()` runs the subtask-project invariant reconcile (previously `_initialize`-only).
- A zero-byte `kanban.db` at boot results in a full-schema database, not an empty-file load.

## Out of scope

- The first-boot V20 log noise (`migration FAILED` plus stack traces on a fresh DB) — separately planned in
  `kanban-db-v20-migration-fresh-db-failure.md`. This plan must not change V20's behaviour; it only stops
  the start path from losing the indexes V20 legitimately drops.
- Workspace scaffolding on the start path — see `standalone-start-never-scaffolds-the-workspace.md`.
- npm packaging — see `b4-npx-distribution-publish.md`.

## Metadata
- **Tags:** database, reliability, bugfix, cli
- **Complexity:** 4
