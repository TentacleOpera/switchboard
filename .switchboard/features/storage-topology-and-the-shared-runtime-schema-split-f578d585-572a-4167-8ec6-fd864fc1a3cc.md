# Storage Topology and the Shared/Runtime Schema Split

<!-- board-collapse-07 -->
> **Sequenced within the storage programme (2026-09-04, Board Collapse 07).** The full seven-step order is stated once, in the *Storage layer overhaul* feature file. This feature is step 5 and 6 of that order and cannot start until steps 1 and 2 land. Do not dispatch a card from it before its prerequisites.

**Complexity:** 9

## Goal

Decide the fundamental shape of Switchboard storage - which stores exist, where each lives, and how an operator chooses - and split the schema along the line that choice implies. Today there are roughly ten answers to the question of where board data lives; this replaces them with one operator choice over three stores: Runtime, Board and Archive. Nothing above this layer can be correct until the tier boundary exists, which is why the read endpoints and ticket metadata land with it rather than after it.

## How the Subtasks Achieve This

- **Storage topology: three stores, one operator choice** — the anchor decision; every other subtask here is downstream of it.
- **Split the schema into shared board state and machine-local runtime** — defines what Runtime versus Board actually contains, so a remote store carries only what is genuinely shared.
- **The board read endpoints must survive the storage topology** — makes reads findable across the board window and Archive, and honestly distinguishable between no-such-card and store-unreachable, in every deployment mode.
- **Imported ticket metadata is gitignored files and two bare id strings** — moves ticket association into the board's own store so it survives a fresh clone; its own Dependencies name the tier split as the prerequisite.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Split the schema into shared board state and machine-local runtime, so a remote store carries only what is actually shared](../plans/split-shared-board-state-from-machine-local-runtime.md) — **CODE REVIEWED** — ID: dd72f3a2-1c31-4624-b2f4-9a39de4c99c4
- [ ] [Storage topology: three stores, one operator choice, and the end of ten answers to "where does my data live"](../plans/storage-topology-one-choice-three-stores.md) — **CODE REVIEWED** — ID: fbdddc53-51bd-4c8d-892f-c31b0eb0827c
- [ ] [Imported ticket metadata is gitignored files and two bare id strings — make it first-class shared board state](../plans/ticket-metadata-as-first-class-board-state.md) — **CODE REVIEWED** — ID: 7e6272a5-b2cb-4b13-9440-71174038931c
- [ ] [The board read endpoints must survive the storage topology, or the SQL-to-endpoints migration lands on endpoints that lie](../plans/board-read-endpoints-must-survive-the-storage-topology.md) — **CODE REVIEWED** — ID: c521a681-91b9-4c7e-8fb4-c59c691a329b
<!-- END SUBTASKS -->

## Dependencies & sequencing

> **Corrected (reconciliation):** the first draft said "Topology first, then the tier split." That inverts the topology plan's own hard dependency — it lists the tier split as a prerequisite because its placement table already names what Runtime holds (`dispatched_*`, `last_liveness_at`, `worktrees`), which *is* the tier split's output. The conceptual anchor is the topology *decision*; the implementation order is tier-split → topology → reads + ticket metadata.

1. **Tier split first** — it defines what Runtime versus Board contains (`storageTiers.ts`, local-tier tables, `plans` rebuild, `plan_tickets` registered as shared). Hard external prerequisite: the sidecar/real-binding plan. Pairs with the unscoped-tables plan (one rebuild pass).
2. **Topology** — consumes the tier definition to place three stores, derive Archive, set the window, demote DuckDB. Requires the tier split + sidecar + unscoped-tables.
3. **Read endpoints + ticket metadata in parallel** — read endpoints require topology's window/Archive; ticket metadata requires the tier split's `plan_tickets`-as-shared registration. The two are independent of each other.

**Cross-subtask coordination:**
- The archive sweep (topology) and the orphan sweep (tier split) both act on a card being archived — serialise both behind the sidecar's single ownership.
- `query-kanban` SKILL.md is edited by topology (path consolidation), read endpoints (SQL removal), and the write-guardrail plan — coordinate so none reverts the others.

**External prerequisite:** both hard prerequisites named by the topology plan — *Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding* and *Scope the ten unscoped tables by workspace_id* — are subtasks of the existing **Storage layer overhaul: real engine, one global store, durable persistence** feature, currently in PLAN REVIEWED. This feature cannot start until those land.


## Review Findings

All four subtasks reviewed in one pass against commit `c3561c23`, in dependency order (tier split → topology → reads + ticket metadata). Seven material defects fixed: V74 dropped the four runtime columns even when its copy step threw, so a board missing any one of them lost all dispatch and liveness state silently; the required runtime orphan sweep did not exist; `ArchiveManager` read a `storage.archivePathOverride` key contributed nowhere while dropping the retired `archive.dbPath` read, orphaning every configured DuckDB archive, and fell back to the SQLite cold store's own file so two engines shared one path; retiring five settings from `package.json` broke every `update()` writer for them, because VS Code rejects an unregistered key; the tier column constants had zero consumers and had already drifted (`worktree_id`/`worktree_status` in neither list); two contract suites and one whole test file were never invoked by CI, and the `storage-scripts-parity` gate that exists to catch that was scoped to `test:contract:db-*` so it stayed green; and `query-kanban`'s advertised description still promised an SQL fallback the skill no longer has. Validation: `tsc -p tsconfig.test.json --noEmit` exits 0, `catalog:check` clean, and storage-topology / plan-tickets 37 / board-read-endpoints 37 / board-snapshot-bidirectional / eight `db-*` / storage-scripts-parity (183 wired scripts) all pass; six unrelated suites are red at the committed tree and were verified red there too. The dominant remaining risk is that the Runtime tier is a table inside the Board database rather than the separate Runtime file the tier-split plan's Proposed Change 2 requires, which leaves the downstream libSQL and git-carried store plans blocked.

## Deferred Findings

Per-subtask deferred findings are recorded in each subtask's own plan file. Feature-level:

- MAJOR — The feature's Goal ("Nothing above this layer can be correct until the tier boundary exists") is met at table granularity but not at file granularity: `plan_runtime_state` and `worktrees` are shared-store tables, so no remote Board target can yet be given only the shared tier. `src/services/storageTopology.ts:118`.
- MAJOR — The feature's two hard external prerequisites — the sidecar/real-binding plan and the unscoped-tables plan — are only partly in evidence. `better-sqlite3` is the driver and V70 scoped the ten tables, but the tier split's `plans` rebuild ran as its own V74 pass rather than "in the same pass as the workspace-scoping rebuild", so `plans` was rebuilt twice on the install base instead of once. `src/services/KanbanDatabase.ts:11259`.
- MAJOR — The cross-subtask serialisation the Dependencies section requires ("serialise both behind the sidecar's single ownership" for the archive sweep and the orphan sweep) is not implemented; the new orphan sweep runs once per store open, unserialised against `archiveToCold`. Benign at one process per store, unproven under two. `src/services/KanbanDatabase.ts` (`sweepOrphanedRuntimeState`).
