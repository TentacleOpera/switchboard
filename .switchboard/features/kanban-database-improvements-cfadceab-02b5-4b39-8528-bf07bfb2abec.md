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
- [ ] [Fix kanban.db sql.js WASM Memory Exhaustion ("disk I/O error" across all DBs)](../plans/fix_kanban_db_wasm_memory_exhaustion.md) — **CODE REVIEWED**
- [ ] [Split kanban.db into Hot (operational) + Cold (archive) Stores, with a Time-Based Board Window](../plans/split_kanban_hot_cold_dbs.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

---

## Implementation Report

**Status:** Both phases coded. `npx tsc --noEmit` clean for all touched files (`KanbanDatabase.ts`, `KanbanProvider.ts`, `extension.ts`); `npm run compile` (webpack) succeeds with only pre-existing optional-deps warnings. Pre-existing TS2835 errors in unrelated files (`ClickUpSyncService`, `NotionFetchService`, `TaskViewerProvider`) were not introduced by this change.

### Phase 1 — Fix sql.js WASM Memory Exhaustion

**A0 — Mechanism-6 close leak (`_reloadIfStale`):** Every successful stale-reload leaked a full DB image into the shared Emscripten MEMFS registry — `db.close()` unlinks the buffer, but dropping the reference does NOT. Under the refresh storm this was a fast, unbounded native leak toward the ~2 GB WASM ceiling. Fixed by adding `_closeDb()` helper and calling it (a) on the previous image after a proven-good swap, and (b) on the just-built failed image on rollback. `flushPersist()` is now also called before the reload so a pending coalesced write is never lost.

**A — Idle-eviction of cached instances:** Single static sweep timer (60 s cadence) evicts instances idle > 10 min, except the active workspace (`setActiveWorkspaceRoot`, wired in `KanbanProvider` constructor + `setCurrentWorkspaceRoot`). A size-gate (`residentDbBudgetMb`, default 500 MB) triggers early aggressive eviction of idle non-active instances when summed `page_count×page_size` crosses the budget. Race-safe: `_evictKey` records the in-flight eviction so a concurrent `forWorkspace()` awaits it before recreating; removes from caches BEFORE closing so no caller grabs a being-closed `_db`. `evictAll()` drains + flushes + closes all instances on `deactivate()` to release the heap before the host exits.

**B — Coalesce `_persist()` behind a trailing debounce (300 ms):** `_dataVersion` bumped on mutation (not flush) so `KanbanProvider`'s O(1) no-op-refresh short-circuit stays correct. `_dirty` flag + `_persistDebounceTimer` (re)armed per write; the actual `export()`+atomic tmp-write runs once per burst in `_doPersist()`. `flushPersist()` clears the timer and writes synchronously — called from `dispose()`, `_evict()`, `_reloadIfStale()`, and `maybeVacuum()` so a pending write is never lost or clobbered. Board reads from in-memory `_db`, so on-screen state is not delayed.

**C — Always-on telemetry GC with swappable sink:** `purgeOldPlanEvents(olderThanDays=90, minPerPlan=50, sink?)` — SELECTION of aged `event_id`s (ROW_NUMBER window, keeps 50 most-recent per plan) is separated from the SINK (default = batched DELETE from this DB). Phase 2 may pass a relocate-to-cold sink without touching the age/min-per-plan logic. `runTelemetryRetention()` runs both prunes (plan_events 90 d, activity_log 30 d) in one sweep, called on activation. `maybeVacuum()` reclaims pages after a prune, gated on headroom (skips if 2× this instance's size would cross the budget).

**D — Remove `_diagFeatureSnapshot`/`appendFeatureClobberDiag` probe:** Deleted the per-persist/per-reload snapshot method, its two call sites, and the `featureClobberDiag` import. The live `console.error` guard in `updateFeatureStatus` (catches an explicit demotion in the act) is retained as a live signal. `cleanupDiagnosticFiles()` removes stale `feature-clobber-diagnostic.txt` files on activation.

### Phase 2 — Split Hot + Cold Stores

**Cold store instance:** `getArchiveInstance()` returns a `KanbanDatabase` bound to `<ws>/.switchboard/kanban-archive.db` (sibling of the hot DB; respects a db-pointer/custom-path override by deriving the archive path from the hot instance's resolved path). Shares all persistence/eviction/coalescing machinery — same class, different db path. Tracked in separate `_archiveInstances`/`_archiveInstancesByDbPath` maps.

**Move API (write-cold → verify → delete-hot):** `archiveToCold(planId)` and `restoreToHot(planId)` are atomic per-plan with verify-before-delete. A crash mid-move can leave a row in both → `reconcileHotCold()` (hot wins, drops cold duplicate) runs on activation BEFORE the first board read. `runPartitionSweep()` moves all cold-eligible plans in batches of 50 with a flush after each batch — resumable with zero row loss.

**Feature/subtask cohesion:** `selectColdEligiblePlanIds()` builds a HOT set via a 4-arm UNION (recent plans ∪ in-flight plans ∪ subtasks-of-hot-features ∪ features-of-hot-subtasks). A feature unit moves cold only if ALL members are dormant — a feature with any hot subtask keeps the whole unit hot.

**Read routing:** `_readUnion()` helper runs a query against both stores, dedup by key (hot wins). Exhaustive readers (`hasPlanUnion`, `hasPlanByPlanFileUnion`, `getPlanBySessionIdUnion`, `getPlanByPlanIdUnion`, `getPlanFileSetUnion`, `getDistinctProjectsUnion`, `getDistinctWorkspaceNamesUnion`, `projectHasPlansUnion`) all go through it so a future reader can't silently forget the cold store. `cleanupAutoProjects` rewired to consult `getDistinctProjectsUnion` — a project whose plans all went cold is NOT deleted (highest-severity routing case). `_isWorkspaceName` rewired to `getDistinctWorkspaceNamesUnion`. `getCompletedPlansCold()` pages cold-only rows for the "show older →" affordance.

**Time-based board window:** `getCompletedPlansInHotWindow(workspaceId, hotWindowDays=45, minCount=25)` replaces the count-based `completedLimit` cap. `KanbanProvider._refreshBoardImpl` now reads `kanban.hotWindowDays` (default 45) and calls the windowed query; `kanban.completedLimit` is respected as a safety floor (min cards shown on a quiet workspace) so existing user configs degrade gracefully.

**V55 migration (one-time partition):** Creates the cold store, reconciles any double-home, then runs `runPartitionSweep()` to move cold-eligible plans. Idempotent via the version gate; re-running on an already-partitioned DB is a no-op. Does NOT stamp the version on failure — retries on next init.

### Settings added (`package.json`)

- `switchboard.kanban.hotWindowDays` (default 45) — hot/cold split window.
- `switchboard.kanban.residentDbBudgetMb` (default 500) — eviction size-gate.
- `switchboard.kanban.planEventsRetentionDays` (default 90) — plan_events GC.
- `switchboard.kanban.activityLogRetentionDays` (default 30) — activity_log GC.
- `switchboard.kanban.completedLimit` description updated (now a safety floor).

### Files touched

- `src/services/KanbanDatabase.ts` — Phase 1 A0/A/B/C/D + Phase 2 cold store, read routing, move API, V55 migration, retention, vacuum.
- `src/services/KanbanProvider.ts` — `setActiveWorkspaceRoot` wiring (constructor + `setCurrentWorkspaceRoot`), `getCompletedPlansInHotWindow` in `_refreshBoardImpl`, `hotWindowDays` setting read.
- `src/extension.ts` — `startEvictionSweep` + `setResidentDbBudgetMb` on activate; `reconcileHotCold` + `runTelemetryRetention` on activate; `stopEvictionSweep` + `evictAll` on deactivate; `cleanupDiagnosticFiles`.
- `package.json` — four new settings + one description update.

