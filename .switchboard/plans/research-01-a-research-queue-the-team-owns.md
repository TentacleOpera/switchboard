# Research 01 — A Research Queue the Team Owns

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A per-team queue of research requests, durable across a restart, carrying the
identity of the seat that asked.

This subtask owns exactly one thing: the `research_requests` table and its
KanbanDatabase accessors. The verbs, dispatcher, and notification paths are
sibling subtasks that read and write this store.

## Why the requester's identity is the point

On 2026-09-19 `Planning-planner-1` flagged an open question, the researcher
answered it in 24KB, and **the planner was never told**. The researcher's own
prompt names the right reader — `bootstrap.ts:5320` says *"so the plan author can
review them later"* — and nothing in the system resolves "the plan author" to a
seat. A request that does not record who asked cannot be answered.

## Metadata

- **Tags:** backend, database, feature
- **Complexity:** 4
- **Project:** Orchestration

## User Review Required

- None — the store design follows the `coding_rounds` precedent the feature
  file already names.

## Complexity Audit

### Routine
- One new table in `SCHEMA_TABLES_SQL` plus one additive V-numbered migration —
  the exact pattern V80 (`linear_managed_artifacts`), V82 (`plan_write_sets`)
  and V83 (`remote_project_bindings`) follow at `KanbanDatabase.ts:11618-11665`.
- A small set of synchronous prepared-statement accessors, same shape as the
  `coding_rounds` accessors at `KanbanDatabase.ts:8442+`.

### Complex / Risky
- The state machine must admit `assigned → queued` (requeue on dead researcher,
  Research-06) in addition to the forward path — a monotonic-state assumption
  here breaks the sibling subtask.
- No FK enforcement exists in this codebase (`KanbanProvider.ts:17508` comment),
  so requester/assignee integrity is by convention, not constraint.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two planners can file simultaneously — inserts are
  independent rows, no shared key. Claim/transition races are the siblings'
  problem, but the accessor for assignment must be a conditional UPDATE
  (`WHERE state='queued'`) so Research-03 can claim atomically.
- **Security:** `question` is free text written by a seat and later rendered
  into prompts and the plan file — store verbatim, escape only at render time.
- **Side Effects:** None beyond the table; no file writes, no prompts.
- **Dependencies & Conflicts:** Next free migration version is V84 (V83 is
  `remote_project_bindings`). Seat identity is a name string, matching how
  `owner_seat` works on `plans` — no join to a terminal registry.

## Dependencies

- None upstream. Siblings Research-02/03/04/05/06 all consume this store;
  Research-07 consumes `countOutstandingResearchForSeat`.

## Adversarial Synthesis

Key risks: a state enum that forgets the requeue edge, and an accessor set that
forces siblings to hand-write SQL and drift. Mitigations: the conditional-UPDATE
claim accessor lives here, and the state list below is the contract every
sibling codes against.

## Proposed Changes

### src/services/KanbanDatabase.ts

- **Context:** `SCHEMA_TABLES_SQL` ends near line 745 (`remote_project_bindings`);
  the migration ladder's last rung is V83 at `KanbanDatabase.ts:11655-11665`;
  `coding_rounds` (line 695) is the shape precedent the feature names.
- **Logic:** Add `research_requests` — one row per request:
  ```sql
  CREATE TABLE IF NOT EXISTS research_requests (
      request_id    TEXT PRIMARY KEY,
      team_id       TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      plan_id       TEXT NOT NULL,
      requested_by  TEXT NOT NULL,
      question      TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'queued',
      assigned_to   TEXT NOT NULL DEFAULT '',
      doc_path      TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      assigned_at   TEXT DEFAULT NULL,
      answered_at   TEXT DEFAULT NULL
  );
  ```
  `state` ∈ `queued | assigned | answered | abandoned`. `assigned → queued` is
  legal (requeue). Indexes: `(team_id, state)` and `(requested_by, state)`.
- **Implementation:**
  1. Append the CREATE TABLE plus both indexes to `SCHEMA_TABLES_SQL`.
  2. Add `MIGRATION_V84_SQL` (same statements) and a `v84 < 84` block after the
     V83 block, `try { exec } catch {}` per statement, `setMigrationVersion(84)`,
     matching the V82/V83 additive pattern exactly.
  3. Accessors, all following the existing prepared-statement style:
     - `insertResearchRequest(row)` — full column list.
     - `getResearchRequest(requestId)`.
     - `listResearchRequests(teamId, state?)` — ordered `created_at ASC` (the
       dispatcher's oldest-first read).
     - `claimOldestQueuedResearchRequest(teamId, seatName)` — one conditional
       `UPDATE ... SET state='assigned', assigned_to=?, assigned_at=? WHERE
       request_id = (SELECT request_id ... state='queued' ORDER BY created_at
       ASC LIMIT 1) AND state='queued'`; returns the claimed row or null. This
       is the anti-double-assign seam Research-03/06 depend on.
     - `completeResearchRequest(requestId, docPath)` — sets `answered`,
       `doc_path`, `answered_at`.
     - `requeueResearchForSeat(seatName)` — `assigned → queued`, clears
       `assigned_to`/`assigned_at`; returns affected `team_id`s so the caller
       can re-pump.
     - `countOutstandingResearchForSeat(seatName)` — `state IN
       ('queued','assigned')` keyed on `requested_by`; Research-07's waiting
       predicate.
     - `abandonResearchRequest(requestId)` — terminal state for a request that
       can never be served (no researcher on the team, surfaced by Research-03).
- **Edge Cases:** A request whose `plan_id` or seat later disappears is NOT
  cascade-deleted — the orphan sweep (`sweepOrphanedRuntimeState`,
  `KanbanDatabase.ts:5739`, invoked by the migration runner near 11671)
  must not touch this table; an answer for a deleted plan is still an answer.

## Verification Plan

### Automated Tests
- Contract test (pattern: `src/test/queue-pipeline-contract.test.js`):
  open a fresh DB, assert `research_requests` exists with the columns above;
  run the V84 block against a V83-stamped DB and assert the table appears.
- Insert two rows, restart (close + reopen the DB), assert `requested_by`,
  `state`, `assigned_to` round-trip intact.
- `claimOldestQueuedResearchRequest` called twice concurrently returns two
  different rows (or one row + null) — never the same row twice.
- A row written under `teamA` is invisible to `listResearchRequests('teamB')`.

### Goal Invariants
- Assert table `research_requests` exists in `SCHEMA_TABLES_SQL` and in a
  migrated DB.
- Assert a persisted row's `requested_by` is non-empty and survives reopen.
- Assert `requeueResearchForSeat` moves `assigned → queued` (the negative
  invariant: no accessor performs a monotonic-only transition).

## Constraints

**Every seat-facing call is a CLI verb, never raw HTTP.** A documented raw POST
403s — `_isAllowedCrossSiteRequest` refuses a request with no
`X-Switchboard-Client` marker, and `cli.ts` is what sets it. The 2026-09-10
correction at `LocalApiServer.ts:1161` forbids raw-HTTP forms "in the team
prompts".

**Do not name `write_to_file`.** It does not exist in a Claude Code seat. Name
the deliverable and its path; let the seat choose its tool.

**No sessionId.** Identifiers are `planId`, `requestId` or a seat name.

**Tag every resolved value.** "No researcher is free" and "this team has no
researcher" are different answers and must not render the same.

**Complexity:** 4
**Routing:** Send to Coder
