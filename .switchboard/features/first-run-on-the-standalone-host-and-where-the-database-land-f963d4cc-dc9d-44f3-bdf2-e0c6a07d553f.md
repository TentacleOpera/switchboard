# First Run On The Standalone Host, And Where The Database Lands

<!-- board-collapse-07 -->
> **Sequenced within the storage programme (2026-09-04, Board Collapse 07).** The full seven-step order is stated once, in the *Storage layer overhaul* feature file. This feature is step adjacent to it: its database-creation parity and first-boot work is independent of the chain, but its db-path subtask feeds steps 4 and 5, and its wizard shares a surface with the shipped Database panel. Do not dispatch a card from it before its prerequisites.

**Complexity:** 7

## Goal

Make npx switchboard self-sufficient for a user who never opens the VS Code extension and never types init.

First boot creates unconditionally and asks nothing. It writes a zero-byte kanban.db into the repository, then runs the full migration chain against the empty file it just made - the wait the user experiences, spent on an artifact they are about to delete. If they already have a database, from another machine or a global store or a sibling repo, it is ignored: the resolver looks for a configured location and never for an unconfigured existing one. Creation has to move after the answer, not before it.

Beyond one mkdir, the server-start path scaffolds nothing, so a standalone-only install has a board that renders and an orchestration contract that is entirely absent - and the in-browser Setup control that would fix that reports success without scaffolding. The two code paths that build a fresh database also disagree: the server path skips the explicit-creation API, so its result differs from the one init produces in which indexes and which repair passes it gets.

Underneath all of it, a configured database path may not be where the board actually is. Relocation to a target outside the source workspace is refused while the callers repoint anyway, so an unknown number of installs have a configured path aimed at an empty file while the real board sits in the old location. Any migration that assumes the configured path is authoritative will act on the wrong database.

## How the Subtasks Achieve This

- **A First-Run Setup Wizard For The Standalone Host**: splits first run at the natural seam — the database question in the terminal, scaffolding and CLIs and roles and teams in the browser panel — and moves creation **after** the answer, so the migration chain no longer runs on a file the user is about to delete.
- **A Standalone-Only Install Is Never Scaffolded**: gives a workspace the same protocol layout the extension creates on activation, and makes the in-browser Run Setup control actually scaffold instead of reporting success silently.
- **The Standalone Server Builds A First-Boot DB By A Path That Skips createIfMissing**: makes the server-created database identical to the one `init` creates, so the two paths stop disagreeing about which indexes and which repair passes a fresh DB receives.
- **A Configured kanban.dbPath May Not Be Where The Board Is**: establishes source selection before either storage migration runs. Relocation outside the source workspace is refused while callers repoint anyway, so installs carry a configured path aimed at an empty file while the real board sits elsewhere.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The standalone server builds a first-boot kanban.db by a path that skips createIfMissing](../plans/standalone-start-path-db-creation-parity.md) — **PLAN REVIEWED** — ID: 217602b0-6ea9-4558-a284-bfd77650d36e
- [ ] [A standalone-only install is never scaffolded, and the in-browser Setup button that would fix it is a no-op](../plans/standalone-start-never-scaffolds-the-workspace.md) — **PLAN REVIEWED** — ID: eb2456e0-b9a6-498f-95de-493d478941d4
- [ ] [A configured kanban.dbPath may not be where the board actually is, and the migrations assume it is](../plans/a-configured-db-path-may-not-be-where-the-board-is.md) — **PLAN REVIEWED** — ID: 567cb9ce-d9e6-4bcb-8707-287736717c0a
- [ ] [A First-Run Setup Wizard for the Standalone Host](../plans/first-run-setup-wizard-for-the-standalone-host.md) — **PLAN REVIEWED** — ID: a107a9a7-fe7d-4612-aee1-26c17d5c305e
<!-- END SUBTASKS -->

## Dependencies & sequencing

`standalone-start-path-db-creation-parity` lands **first**, and this is a hard constraint the wizard plan states itself: both rewrite the same first-boot block in `bootstrap.ts`. That plan unifies how a fresh database is created; the wizard then decides **whether** to create one and builds its probe in front of that unified path. Reversed, the two rewrites conflict.

`a-configured-db-path-may-not-be-where-the-board-is` is an **input** to the wider storage programme rather than a dependant of it — `retire-cloud-file-sync-db-path-presets.md` and `single-global-database-in-home-store.md` both need its source-selection rule, and the preset plan's adopt-the-synced-database step is unsafe without it. Its steps 1 and 3 ship immediately and independently; step 2 belongs to whichever migration lands first.

`standalone-start-never-scaffolds` is independent of the database ordering and can run in parallel.

Two scope notes added during the consistency audit, recorded on the wizard plan itself. Its `db-pointer` probe tier is scheduled for deletion by `single-global-database-in-home-store.md`, so keep it as one independently removable branch and never let a later tier depend on it having run. And its panel half shares a surface with `database-panel-in-the-shell-rail.md`, which deletes the Setup panel's Database Operations section — so the storage question belongs in the terminal half only, and no storage control should be added to Setup. The wizard's own risk note already sequences the terminal half first and calls it shippable alone; treat that as the shipping order.

Its migration question also has no import target yet (`hand-a-workspace-to-another-machine.md` is unbuilt) — point it at manual copy steps rather than promising an import.

## Team Dispatch Instructions

### The standalone server builds a first-boot kanban.db by a path that skips createIfMissing

- **Seat:** Coder (Complexity 4)
- **Acceptance:**
  - `sqlite_master` for a start-born DB and an init-born DB are identical (same indexes, same tables, same schema version) — diff the two creations and assert empty diff.
  - `_initialize()` calls `_applySchemaIndexes` after `_runMigrations` (post-migration re-apply exists in both paths).
  - `createIfMissing()` runs the subtask-project invariant reconcile (previously `_initialize`-only).
  - A zero-byte `kanban.db` at boot results in a full-schema database, not an empty-file load.
  - No second-boot churn — a fresh DB that still mutates on second boot means the first pass was incomplete.
- **Must not touch:** V20 migration behaviour (`kanban-db-v20-migration-fresh-db-failure.md` owns it); workspace scaffolding on the start path (`standalone-start-never-scaffolds-the-workspace.md` owns it); npm packaging (`b4-npx-distribution-publish.md` owns it).

### A standalone-only install is never scaffolded, and the in-browser Setup button that would fix it is a no-op

- **Seat:** Intern (Complexity 4)
- **Acceptance:**
  - Fresh directory after bare `npx switchboard`: `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/`, `worktrees/`, `.switchboard/.agent_version.json` all exist; DB has a `workspace_id` config row.
  - `switchboard.setup` is registered in the standalone command registry — `runSetup` verb via the browser scaffolds the workspace (assert `.switchboard/plans/` appears), does not fall through to the shim.
  - `--no-scaffold` prevents `.switchboard/plans/` creation; a subsequent bare start scaffolds the rest.
  - Idempotency: a marker line in `AGENTS.md` survives a restart; no duplicate managed block appears.
  - `npx switchboard init` still produces its existing report (regression).
- **Must not touch:** npm publishing and tarball contents (`b4-npx-distribution-publish.md` owns it, but B4 must ship `.agents/` and `AGENTS.md`); the `scaffold`/`control-plane` multi-repo commands (shipped, excluded from cwd `mkdir`); DB creation parity (`standalone-start-path-db-creation-parity.md` owns it).

### A configured kanban.dbPath may not be where the board actually is, and the migrations assume it is

- **Seat:** Intern (Complexity 3)
- **Acceptance:**
  - `handleSetCustomDbPath` does NOT call `config.update` when `migResult.skipped === 'migration_in_progress'` or starts with `error:`.
  - `handleSetLocalDb` does NOT call `config.update` when `migResult.skipped === 'migration_in_progress'` or starts with `error:`.
  - `handleSetCustomDbPath` DOES call `config.update` when `migResult.skipped === 'source_not_found'` (legitimate relocation — nothing to migrate).
  - `handleSetCustomDbPath` DOES call `config.update` when `migResult.migrated === true` (successful migration).
  - `target_has_data` still offers reconciliation (existing branch unchanged).
- **Must not touch:** The location guard or relocation UI (deleted by the consolidation programme — do not repair); the storage engine, topology, or global store; the standalone host's `Configuration.update` no-op (filed separately, moot).

### A First-Run Setup Wizard for the Standalone Host

- **Seat:** Lead Coder (Complexity 7)
- **Acceptance:**
  - `createIfMissing()` is NOT called when a candidate DB is found and adopted; `createIfMissing()` is NOT called when no candidate exists and no TTY/`--db` is provided; `createIfMissing()` IS called after the user answers the database prompt.
  - `--db <path>` suppresses the prompt and produces the same adoption as answering it.
  - `kanban.html` no longer defines `SHIPPED_TEAM_TYPES` inline; `terminals.js` no longer defines `CLI_BRAND_ICON_KEYS` inline — extracted module is the only definition.
  - `backupDir` is derived from `path.dirname(this.dbPath)`, not from `this._workspaceRoot` — backups follow the database.
  - `switchboard setup` is a single subcommand (the existing `cmdSetup` menu, extended — not a duplicate); the wizard uses the existing `openPrompter()`, not `node:readline/promises` as net-new.
- **Must not touch:** The Setup panel's Database Operations section (`database-panel-in-the-shell-rail.md` retires it — storage question belongs in the terminal half only); the `db-pointer` probe tier (scheduled for deletion by `single-global-database-in-home-store.md` — keep as one independently removable branch); the N-to-1 merge (`single-global-database-in-home-store.md` owns it — the wizard adopts, never merges); the migration engine (`hand-a-workspace-to-another-machine.md` owns it — point at manual copy steps, do not promise an import).
