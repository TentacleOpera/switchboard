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
- [ ] [Split the schema into shared board state and machine-local runtime, so a remote store carries only what is actually shared](../plans/split-shared-board-state-from-machine-local-runtime.md) — **PLAN REVIEWED** — ID: dd72f3a2-1c31-4624-b2f4-9a39de4c99c4
- [ ] [Storage topology: three stores, one operator choice, and the end of ten answers to "where does my data live"](../plans/storage-topology-one-choice-three-stores.md) — **PLAN REVIEWED** — ID: fbdddc53-51bd-4c8d-892f-c31b0eb0827c
- [ ] [Imported ticket metadata is gitignored files and two bare id strings — make it first-class shared board state](../plans/ticket-metadata-as-first-class-board-state.md) — **PLAN REVIEWED** — ID: 7e6272a5-b2cb-4b13-9440-71174038931c
- [ ] [The board read endpoints must survive the storage topology, or the SQL-to-endpoints migration lands on endpoints that lie](../plans/board-read-endpoints-must-survive-the-storage-topology.md) — **PLAN REVIEWED** — ID: c521a681-91b9-4c7e-8fb4-c59c691a329b
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

