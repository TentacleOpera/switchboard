# Storage Topology and the Shared/Runtime Schema Split

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
- [ ] [Split the schema into shared board state and machine-local runtime, so a remote store carries only what is actually shared](../plans/split-shared-board-state-from-machine-local-runtime.md) — **CREATED**
- [ ] [Storage topology: three stores, one operator choice, and the end of ten answers to "where does my data live"](../plans/storage-topology-one-choice-three-stores.md) — **CREATED**
- [ ] [Imported ticket metadata is gitignored files and two bare id strings — make it first-class shared board state](../plans/ticket-metadata-as-first-class-board-state.md) — **CREATED**
- [ ] [The board read endpoints must survive the storage topology, or the SQL-to-endpoints migration lands on endpoints that lie](../plans/board-read-endpoints-must-survive-the-storage-topology.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Topology first, then the tier split, then the read endpoints and ticket metadata in parallel.

**External prerequisite:** both hard prerequisites named by the topology plan — *Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding* and *Scope the ten unscoped tables by workspace_id* — are subtasks of the existing **Storage layer overhaul: real engine, one global store, durable persistence** feature, currently in PLAN REVIEWED. This feature cannot start until those land.

