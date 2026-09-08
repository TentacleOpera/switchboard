# Coding Rounds 01 — The Round Record

kanbanColumn: CREATED

## Goal

A coding round is a row in the database, not a fact living only in a lead's context. Registering, dispatching and closing a round all read and write that row.

### Problem analysis

Today a round exists only in the lead's head. Nothing in the system knows a feature was split into three rounds, that round 1 is done, or that round 2 is in flight. So nothing can dispatch the next batch, nothing can tell a dropped delivery from a working seat, and every recovery is the operator reconstructing state by hand from timestamps.

This subtask adds the state. It ships no behaviour on its own and is the dependency for every other subtask in the feature.

> **Note (reconciliation):** A stateless `POST /kanban/round/complete` endpoint already exists (`LocalApiServer.ts:4190`) and already clears coder seats on a round boundary — but it works without any round record, completing whatever outstanding cards a team holds. That endpoint cannot answer "which round," "what ordinal," or "which seat got which subtask," and it cannot dispatch the next registered round. This subtask adds the durable record that makes round state queryable and enables subtasks 02–04 to operate on it.

## Metadata

- **Complexity:** 3
- **Feature:** Coding Rounds
- **Tags:** teams, schema, database

## User Review Required

None.

## Complexity Audit

### Routine
- Adding one `CREATE TABLE` to the migration chain and the schema SQL — the established V2–V72 pattern.
- Column choices (feature_id, team_id, ordinal, state, timestamps) are direct transcriptions of the Goal's requirements.

### Complex / Risky
- Two `dispatched_at` sources after this lands: the round row's per-subtask record and `plans.dispatched_at`. They must not diverge in meaning — see Edge-Case 5.
- Feature-delete orphan prevention has no FK cascade to lean on (SQLite FK enforcement is off in this codebase) — requires an explicit cleanup hook.

## Proposed Changes

### 1. A `coding_rounds` table

One row per round. It must answer, without inference:

- which feature and which team the round belongs to
- the ordinal (round 1, 2, 3…) and the total registered
- the subtask planIds in the round, and the seat each was dispatched to
- the round's state — registered, dispatched, closed
- when it was registered, dispatched and closed

Seat assignment is recorded **per subtask**, because that is what a later clear and a later recovery both need. A round that knows only "three subtasks" cannot tell which seat owes what.

The per-subtask seat map is a JSON column (`subtask_seats`) keyed by planId, holding `{ seat, delivered, delivered_at }` per subtask. This is record-keeping state — the **operational** source of "when was this subtask dispatched" remains `plans.dispatched_at`, which `isStaleCompletedAt` (`LocalApiServer.ts:3925`) reads. The round row's timestamps describe what happened; the plans row drives behaviour. State this separation in the migration comment so a future editor does not try to unify them.

### 2. Append a new migration, do not edit a shipped one

> **Superseded:** The highest existing migration is V69. Add V70.
> **Reason:** The chain has advanced since this plan was written. V70 (`control_plane` backfill), V71 (`override_body` backfill), and V72 (`plan_events.user_id`) all shipped. A plan that says "add V70" collides with an existing V70 and breaks the version gate.
> **Replaced with:** The highest existing migration is V72. Add V73. Never modify the body of a shipped `MIGRATION_Vnn_SQL`, and never stamp a baseline to skip the chain — a fresh database runs every migration in order.

Add the `CREATE TABLE IF NOT EXISTS coding_rounds` to both `SCHEMA_TABLES_SQL` (so fresh DBs get it at creation) and `MIGRATION_V73_SQL` (so existing DBs gain it on upgrade). The column set must be identical between the two.

### 3. This is unreleased state — no back-compat

Coding rounds have never shipped. There is nothing to migrate in and no legacy shape to preserve. Take the clean break.

### 4. Feature-delete must not orphan rounds

SQLite foreign-key enforcement is not enabled in `KanbanDatabase` (`PRAGMA foreign_keys` is not set to ON), so an `ON DELETE CASCADE` would be a no-op. Instead, add an explicit cleanup call in the feature-delete path: when a feature's plan row is deleted, delete its `coding_rounds` rows by `feature_id`. Name the delete site in the implementation (the feature-delete handler in `LocalApiServer` / `KanbanDatabase`).

## Edge-Case & Dependency Audit

1. **Both hosts read it.** The table is created by the shared migration chain, so both composition roots get it. The standalone host's `_initialize` path runs the chain via `_runMigrations()` (`KanbanDatabase.ts:7629`) — confirmed by inspection, not assumption.
2. **A round outlives the process.** That is the point — the lead's context does not survive a clear, and the round record must.
3. **Deleting a feature** must not orphan its rounds — handled by the explicit cleanup hook in change 4, not by a FK cascade.
4. **No round is implied.** A feature dispatched without registered rounds behaves exactly as it does today. Absence of rounds is not an empty round. The existing stateless `round/complete` continues to work for teams with no registered rounds.
5. **Two `dispatched_at` sources.** The round row records per-subtask dispatch timestamps for audit/recovery; `plans.dispatched_at` remains the operational field `isStaleCompletedAt` reads. They are written in the same dispatch operation (subtask 03) so they agree at write time, but they serve different readers. Do not unify them — the plans row is read by completion logic that predates this feature.

## Dependencies

- None as a prerequisite — this is the foundation. Subtasks 02, 03, and 04 all depend on this table existing.

## Adversarial Synthesis

Key risks: (1) dual `dispatched_at` sources diverging in meaning — mitigated by documenting the round row as record-keeping and `plans.dispatched_at` as operational. (2) Orphaned rounds on feature delete with no FK cascade — mitigated by an explicit cleanup hook. (3) Migration number collision with already-shipped V70–V72 — mitigated by using V73.

## Verification Plan

1. A fresh database created from scratch has the table, having run the full chain through V73.
2. An existing database gains it on upgrade without touching any other table.
3. A round row survives an extension restart and reads back identically.
4. Both hosts read the same row for the same round.
5. Deleting a feature deletes its `coding_rounds` rows (orphan prevention).

### Goal Invariants
- `coding_rounds` table exists in `SCHEMA_TABLES_SQL` and `MIGRATION_V73_SQL` with identical column sets.
- `MIGRATION_V73_SQL` is present and no `MIGRATION_V70_SQL` body was modified (V70–V72 untouched).
- A round row with state `registered` is readable after a process restart (round outlives the lead's context).
- No `coding_rounds` row remains for a feature after its plan row is deleted (no orphans).

## Implementation Summary

Added the `coding_rounds` table to `SCHEMA_TABLES_SQL` (fresh DBs) and a new `MIGRATION_V73_SQL` (existing DBs upgrade), with an identical column set: `round_id` PK, `feature_id`, `team_id`, `workspace_id`, `ordinal`, `total_registered`, `state` (default `registered`), `subtask_seats` JSON, and `registered_at`/`dispatched_at`/`closed_at` timestamps, plus a `UNIQUE(feature_id, ordinal)` invariant and feature/workspace indexes. Registered V73 in the `_runMigrations()` chain after the V72 block; V70–V72 bodies were left untouched (diff is additions only). The migration comment records the record-keeping vs operational `dispatched_at` separation (round row audits; `plans.dispatched_at` drives `isStaleCompletedAt`). Added `KanbanDatabase.deleteCodingRoundsByFeature(featureId)` and wired it into `KanbanProvider._deleteFeature` right after the feature row is tombstoned, so both the extension and standalone hosts (which both route through `_deleteFeature`) prevent orphaned rounds without relying on SQLite FK cascades (enforcement is OFF in this codebase). The cleanup is best-effort: a failure warns but does not block the feature delete.


## Review Findings

Reviewed `f63c9681` — no code changes were needed. The `coding_rounds` DDL is byte-identical between `SCHEMA_TABLES_SQL` (`KanbanDatabase.ts:456`) and `MIGRATION_V73_SQL` (`:844`), V70–V72 bodies are untouched (the commit is additions only), and the V73 arm is registered in `_runMigrations()` behind the version gate. `deleteCodingRoundsByFeature` is wired into `KanbanProvider._deleteFeature` (`:15922`), which is the single delete path both hosts reach (`TaskViewerProvider.ts:4696`, `bootstrap.ts:4674`, `PlanningPanelProvider.ts:4416` all delegate to it), so no orphan path was left open. Verification: `tsc -p tsconfig.test.json` clean, `npm run compile` clean, and the db contract suites (`db-export-import-roundtrip`, `db-relocation-split`) pass.

## Deferred Findings

- NIT — `deleteCodingRoundsByFeature` is best-effort (warns, returns 0) so a failed cleanup silently leaves orphan rows; acceptable for a delete path, but nothing reports the orphan. `src/services/KanbanDatabase.ts:6699`
- NIT — `coding_rounds.team_id` is derived from the lead's terminal NAME, so renaming a lead orphans its rounds; nothing rekeys the table the way `rewriteTeamGroupHeadForRename` rekeys the groups store. `src/services/LocalApiServer.ts:4666`
