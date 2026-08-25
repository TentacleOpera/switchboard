# The standalone server builds a first-boot kanban.db by a path that skips createIfMissing

## Goal

Make the database the standalone server creates on first boot identical to the one `npx switchboard init`
creates. Today two different code paths build a fresh DB and they disagree about which indexes and which
repair passes the finished DB gets.

### Problem analysis (verified against HEAD 58c0030)

`startHeadlessSwitchboard` does not use the explicit-creation API. `bootstrap.ts:473-485`:

```ts
const db = KanbanDatabase.forWorkspace(workspaceRoot);

// The database must exist on disk before ensureReady() can initialise it.
const dbPath = db.dbPath;
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) { fs.mkdirSync(dbDir, { recursive: true }); }
if (!fs.existsSync(dbPath)) { fs.writeFileSync(dbPath, Buffer.alloc(0)); }

await db.ensureReady();
```

The zero-byte pre-touch is load-bearing for the comment above it: `_initialize()` deliberately refuses to
create a missing file (`KanbanDatabase.ts:6975-6982` — "not auto-creating", returns `false`). But it also
forces the *existing-file* branch, so a brand-new database is built by `_initialize()` (`:6937`) rather
than by `createIfMissing()` (`:2115`) — and the two are not equivalent in either direction.

**`createIfMissing()` re-applies the schema indexes after migrations; `_initialize()` does not.**

- `createIfMissing()` (`:2145-2172`): SCHEMA_TABLES → `_ensureSchemaColumns` → `_applySchemaIndexes`
  (`:2147`) → `_runMigrations` (`:2166`) → `_ensureSchemaColumns` →
  **`_applySchemaIndexes('SCHEMA_INDEXES (post-migration)')` (`:2172`)**.
- `_initialize()` (`:6990-7000`): SCHEMA_TABLES → `_ensureSchemaColumns` → `_applySchemaIndexes`
  (`:6992`) → `_runMigrations` (`:6995`) → `_ensureSchemaColumns` → `_persist`. **No post-migration
  re-apply.**

That final line in `createIfMissing` is not decoration, and its own comment says why: migration V20
rebuilds `plans` by creating `plans_v20` and then `ALTER TABLE plans_v20 RENAME TO plans` (`:795`), which
destroys every index on the table and recreates only its own six. On a fresh database V20 now runs to
completion rather than failing — its INSERT is column-explicit (`:769-776`), which was the fix for the
"V20 migration fails on every fresh DB" report — so the index destruction is a live consequence, not a
hypothetical one. `_initialize()` never re-applies, so a database created on the server-start path is
missing the SCHEMA_INDEXES entries V20 dropped (the comment names `idx_plans_project_id` and
`idx_plans_workspace_name`) while a database created by `init` has them.

**The divergence runs the other way too, so the fix is not a one-line swap.** `_initialize()` ends with a
subtask-project invariant reconcile that runs on every startup and is explicitly *not* version-gated
(`:7035-7040` onward, sited after `_runConfigMigrations`). `createIfMissing()` does not run it. Both do run
`_runConfigMigrations()` (`:2185` and `:7033`). So `init`-born databases get the indexes and skip the
reconcile; start-born databases get the reconcile and miss the indexes. Whichever way this is unified, the
result has to be the union, not one path's behaviour imposed on the other.

**Blast radius, stated honestly.** Missing indexes are a performance and consistency defect, not
corruption: every query still returns correct rows. The schema version reaches current on both paths, and
a fresh CLI boot has been observed reaching v57 with all tables present. What makes it worth fixing is
that it makes "is this database in the expected shape?" unanswerable — the same class of ambiguity that
cost real debugging time in the V42 incident, where a stamped-but-incomplete schema surfaced as a board
showing zero cards.

**Edge case the pre-touch creates.** A first boot interrupted inside the 300 ms persist debounce leaves a
zero-byte `kanban.db` on disk. The next boot treats it as an existing database (sql.js on an empty buffer
yields an empty database, so the schema is built then) — recoverable, but it also makes `init`'s
"Existing kanban.db kept" report untrue for a file that holds nothing, and it keeps the run on the
index-incomplete path forever.

## Proposed changes

1. **`src/standalone/bootstrap.ts:473-485`** — drop the zero-byte pre-touch and call
   `await db.createIfMissing()`. The `dbDir` mkdir can go with it: `createIfMissing` does its own
   (`KanbanDatabase.ts:2138`). Fail the boot loudly when it returns `false` rather than continuing with a
   null `_db` — today an unwritable path yields a server that answers `/health` and serves an empty board.
2. **Converge the two creation paths** rather than switching callers between them. Lift the post-migration
   `_applySchemaIndexes` into `_initialize()` as well, so no third caller can reintroduce the gap, and
   confirm the invariant reconcile still runs for a `createIfMissing`-born database. On the reload path
   (`:6899-6900`) the extra re-apply is an idempotent no-op cost, which is the right trade for removing a
   whole divergence class.
3. **Repair a zero-byte `kanban.db`** left by an aborted earlier boot: treat a zero-length file as absent
   (unlink, then create) so the complete path is taken and the "kept" report stays truthful.

## Verification plan

1. **Diff the two creations.** Build one DB via `npx switchboard init` and one via a bare start, in
   separate temp dirs, then compare
   `SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name` across both. Expect a
   non-empty diff today (the SCHEMA_INDEXES entries V20 dropped); expect an empty diff after the fix.
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

## Out of scope

- The first-boot V20 log noise (`migration FAILED` plus stack traces on a fresh DB) — separately planned in
  `kanban-db-v20-migration-fresh-db-failure.md`. This plan must not change V20's behaviour; it only stops
  the start path from losing the indexes V20 legitimately drops.
- Workspace scaffolding on the start path — see `standalone-start-never-scaffolds-the-workspace.md`.
- npm packaging — see `b4-npx-distribution-publish.md`.

## Metadata
- **Tags:** database, reliability, bugfix, cli
- **Complexity:** 4
