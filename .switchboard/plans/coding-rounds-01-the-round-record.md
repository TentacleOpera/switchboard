# Coding Rounds 01 — The Round Record

kanbanColumn: CREATED

## Goal

A coding round is a row in the database, not a fact living only in a lead's context. Registering, dispatching and closing a round all read and write that row.

### Problem analysis

Today a round exists only in the lead's head. Nothing in the system knows a feature was split into three rounds, that round 1 is done, or that round 2 is in flight. So nothing can dispatch the next batch, nothing can tell a dropped delivery from a working seat, and every recovery is the operator reconstructing state by hand from timestamps.

This subtask adds the state. It ships no behaviour on its own and is the dependency for every other subtask in the feature.

## Metadata

- **Complexity:** 3
- **Feature:** Coding Rounds
- **Tags:** teams, schema, database

## User Review Required

None.

## Proposed Changes

### 1. A `coding_rounds` table

One row per round. It must answer, without inference:

- which feature and which team the round belongs to
- the ordinal (round 1, 2, 3…) and the total registered
- the subtask planIds in the round, and the seat each was dispatched to
- the round's state — registered, dispatched, closed
- when it was registered, dispatched and closed

Seat assignment is recorded **per subtask**, because that is what a later clear and a later recovery both need. A round that knows only "three subtasks" cannot tell which seat owes what.

### 2. Append a new migration, do not edit a shipped one

The highest existing migration is V69. Add V70; never modify the body of a shipped `MIGRATION_Vnn_SQL`, and never stamp a baseline to skip the chain — a fresh database runs every migration in order.

### 3. This is unreleased state — no back-compat

Coding rounds have never shipped. There is nothing to migrate in and no legacy shape to preserve. Take the clean break.

## Edge-Case & Dependency Audit

1. **Both hosts read it.** The table is created by the shared migration chain, so both composition roots get it, but confirm the standalone host's `_initialize` path runs the chain rather than assuming a pre-created file has it.
2. **A round outlives the process.** That is the point — the lead's context does not survive a clear, and the round record must.
3. **Deleting a feature** must not orphan its rounds.
4. **No round is implied.** A feature dispatched without registered rounds behaves exactly as it does today. Absence of rounds is not an empty round.

## Verification Plan

1. A fresh database created from scratch has the table, having run the full chain.
2. An existing database gains it on upgrade without touching any other table.
3. A round row survives an extension restart and reads back identically.
4. Both hosts read the same row for the same round.
