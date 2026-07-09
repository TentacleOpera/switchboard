# Kanban Database Improvements

**Complexity:** 8

## Goal

Stop `kanban.db` from crashing the extension host and keep the board fast as plan history grows without bound. Today all ~9 workspace DBs share one sql.js WebAssembly heap, and every write serializes the *entire* DB file — so a burst of activity exhausts the shared heap (the `disk I/O error` flood observed 2026-07-08) and per-write cost scales with lifetime plan count. This feature fixes the acute crash first, then removes the structural cause. The two subtasks are grouped because they touch the same surface (`src/services/KanbanDatabase.ts`) in a strict Phase 1 → Phase 2 sequence: bound the heap now, then permanently bound the *hot* working set so the "10k plans" problem never returns.

## How the Subtasks Achieve This

- **Fix kanban.db sql.js WASM Memory Exhaustion**: The Phase 1 hotfix. Four independently-shippable workstreams that bound the shared WASM heap without changing the DB engine — (A) idle-eviction of cached DB instances so ~9 workspaces don't stay permanently resident, (B) coalescing the per-write full-DB `export()` behind a dirty-flag debounce, (C) always-on GC for the two append-only telemetry tables (`plan_events`/`activity_log`, ~54% of the DB) that age out decayed forensics while preserving recent history, and (D) removal of a temporary per-write diagnostic probe. Workstream A alone likely stops the crash; B/C/D harden it. Deliberately leaves completed `plans` rows to grow — that growth is content, not the cause.
- **Split kanban.db into Hot + Cold Stores with a Time-Based Board Window**: The Phase 2 structural fix that *composes with* — does not replace — the hotfix. Introduces a mandatory second sql.js store (`kanban-archive.db`) for dormant plans and replaces the count-based Completed cap with an activity-based hot-window predicate (default 45 days, in-flight/worktree plans pinned hot). This keeps the *hot* DB — the file rewritten on every write — bounded to the working set forever, so per-write serialize cost stops scaling with lifetime plan count. Reuses the eviction/flush machinery Phase 1 builds; keeps DuckDB an optional, never-load-bearing analytics layer.

## Dependencies & sequencing

- **No cross-feature dependencies.** Both subtasks are self-contained within this repo's `KanbanDatabase.ts`/`KanbanProvider.ts`. (The `fix_kanban_db_wasm_memory_exhaustion` hotfix references a separately-tracked *refresh-storm* fix as a mutually-reinforcing trigger reduction, but does not require it to land first.)
- **Strict internal ordering: land the hotfix (Phase 1) fully before starting the split (Phase 2).** Plan B assumes Plan A's idle-eviction and persist-coalescing already exist and reuses them for the cold instance; building B first would duplicate that machinery. Within Phase 1, land the workstreams in order A (eviction) → B (coalescing) → C (retention) → D (probe removal), each behind its own verification.
- **Prerequisite/guard — one reconciled handoff between the two plans:** telemetry GC (Workstream C) must be written so the *selection* of aged `plan_events`/`activity_log` rows is separate from the *sink*. In Phase 1 the sink is deletion from the single DB (optionally forwarding to the DuckDB archive if the CLI is present); in Phase 2 the sink MAY become *relocation to the cold store* instead of deletion. Writing C with a swappable sink means Phase 2 changes where aged rows go, not the age/min-per-plan selection logic — the two plans do not collide on this surface. No other contended symbol: A bounds write *frequency* and resident *count*; B bounds per-write *size*; they layer rather than overlap, and Plan B owns the board-read routing (`getBoardFilteredByProject`/`getCompletedPlans`/`completedLimit`) that Plan A only reads.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix kanban.db sql.js WASM Memory Exhaustion ("disk I/O error" across all DBs)](../plans/fix_kanban_db_wasm_memory_exhaustion.md) — **PLAN REVIEWED**
- [ ] [Split kanban.db into Hot (operational) + Cold (archive) Stores, with a Time-Based Board Window](../plans/split_kanban_hot_cold_dbs.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

