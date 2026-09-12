# Completion Is the Only Way to Release a Team, So It Gets Posted Before the Work Is Done

## Goal

Separate "this team no longer holds the card" from "this work is finished". They are one write today —
`completed_at` — so an agent that needs the first has no way to get it without asserting the second.
Completion must also carry what happened, instead of being an empty timestamp that 96% of posts leave
unexplained.

### Problem analysis

**One write, two meanings.** `completeCardInternal` (`LocalApiServer.ts:3969`) sets `completed_at`,
and that single field answers both questions the board asks: is the work done, and is the team free.
Nothing else releases a team — the orchestration skill states it outright:

> a seat on your team still HOLDS a card with no completion post — `completed_at` is the only fact
> that releases a team, in any column; POST `/kanban/task/complete` for the planId named in
> `inFlight` before asking again. **Moving the card releases nothing.**

So an agent blocked by a `409` from `POST /kanban/queue/next` is *instructed* to post completion to
get unblocked. It is the documented remedy. Premature completion is therefore not agents behaving
badly — it is the only door in the wall, and the door is labelled "done".

**The endpoint asserts nothing.** `_handleKanbanTaskComplete` (`LocalApiServer.ts:4147`) validates
shape and nothing else: `workspaceRoot` present, `from` present, `planId` present, no path separators
in `planId`. There is no check that the card was dispatched to this team, that a diff exists, that a
review passed, or that the caller is the seat that holds it. It writes the timestamp.

**Measured on this board, 2026-09-09.** `plan_events` records every post:

| | |
| :--- | ---: |
| `task-complete` events | **201** |
| …carrying a non-empty `outcome` | **8** |
| …carrying a non-empty `note` | **3** |
| `operator-release` events | 3 |

**193 of 201 completions (96%) say only "done", with no statement of what was done.** A typical
payload is `{"from":"Coding","outcome":"","note":"","acceptedCodingSeat":"Coding-intern"}`.

**And the row cannot hold the answer even when it is given.** `PRAGMA table_info(plans)` has
`dispatched_at`, `dispatched_terminal`, `dispatched_agent`, `dispatched_ide` and `completed_at` — and
**no `outcome` and no `workflow` column**. `outcome` and `note` survive only in the `plan_events`
payload. Every consumer that reads a plan row sees an identical completion whether it came from
finished work, from a lead clearing a 409, or from the operator's release.

This is the project's standing rule at the level of the completion record: *a fallback must never be
indistinguishable from a real value.* An unlocking post and a finishing post are the same bytes.

**A release door already exists, and agents are not told about it.**
`POST /kanban/team/release` (`LocalApiServer.ts:5561`) is documented as *"operator release control for
a team"*, derives the held set server-side, and calls `completeCardInternal` with
`workflow: 'operator-release'`. It appears nowhere in `.agents/skills/*/SKILL.md`. So the concept is
already built and already distinguished in the event log — it is simply not reachable by the caller
who needs it, and it still writes a completion.

> **Verified this session (line drift):** `completeCardInternal` is at `LocalApiServer.ts:4018`
> (plan cited `:3969`); `_handleKanbanTaskComplete` at `:4196` (cited `:4147`);
> `/kanban/team/release` at `:5561` (cited `:5527`); the queue/next 409 at `:3590` (cited by topic).
> The `plans` table (`KanbanDatabase.ts:344-382`) has **no** `outcome` and **no** `workflow` column —
> confirmed; both survive only in `plan_events` (`:571`, `:696`). `completeCardInternal` clears the
> coding seat via `clearTerminalContext` (step 5, `:4016`), so the release path clears the seat too.
> The 409 body at `:3590` literally reads `Post /kanban/task/complete before asking for the next card`
> — confirming the plan's claim that the 409 names completion, not release.

> **The design this plan inverts is deliberate and documented.** The queue/next code at
> `LocalApiServer.ts:3428-3432` states: *"There is deliberately NO release valve for an un-posted card.
> Any valve is a second signal under a new name, and restores that concurrency the moment a lead
> reaches for it instead of posting."* This plan proposes exactly that valve. The inversion is
> defensible **only** because change 2 (forced `outcome`) makes completion mean "finished, with a
> statement," leaving release as the genuine "free without claiming done" path — so the valve no
> longer restores the concurrency the comment feared. Change 1 (valve) and change 2 (forced outcome)
> are **one coupled decision**: neither ships alone. Change 4 (409 body + skill text name the release
> door) is the adoption mechanism — without it the 409 still says "post /kanban/task/complete" and
> agents keep completing to unlock, passing the plan's invariants green on a dead verb.
>
> **Approved (user, this session):** the release valve is go. The inversion of the `:3428-3432`
> design comment is authorised. Ship changes 1, 2, and 4 together.

#### This is not already on the board

Searched by topic and by full text across `.switchboard/plans/`. The nearest cards are different
problems: *Investigate Completion and Archival Workflows* (`0b481492`, BACKLOG) is a documentation
exercise; *The Review Team Has No Coder Seats, So a Reviewer Can Only Rubber-Stamp an Unimplemented
Subtask* (`9f7169b1`, PLAN REVIEWED) is about a reviewer lacking the means to fix what it finds;
*Remove mtime-based completion detection* is COMPLETED and established the explicit post that this
card is about. None of them covers the release/assert conflation.

## Metadata

**Complexity:** 5
**Tags:** kanban, api, orchestration, contracts

## User Review Required

None.

## Complexity Audit

### Routine
- `completeCardInternal` (`LocalApiServer.ts:4018`) already accepts `outcome`/`note`/`workflow` opts and already writes them to `plan_events` (`:4094`). Adding `outcome`/`workflow` columns to the `plans` row is an additive migration backfilled from `plan_events` — the shape is settled.
- `/kanban/team/release` (`:5561`) already calls `completeCardInternal` with `workflow: 'operator-release'`; extending it (or adding a per-card release verb) reuses the existing helper.
- The 409 body (`:3590`) and the two skill files are text edits.

### Complex / Risky
- **The release valve inverts a deliberate design** (`LocalApiServer.ts:3428-3432`). The inversion is only safe because change 2 makes completion meaningful — see the design note above. Change 1 and change 2 are coupled and must land together.
- **Forced `outcome` is a breaking change to the completion contract.** Every existing caller (agents, the round-complete/feature-complete paths at `:4434`, `:4555`, `:5498`) must supply a non-empty outcome or be rejected. The internal `round-complete`/`feature-complete` callers set `workflow` but may not set `outcome` — they must be updated in the same diff or they start failing. `operator-release` and any new release verb set their own outcome (the operator is not made to type one).
- **Backfill from `plan_events`.** 193 of 201 historical completions have empty `outcome`. Backfilling the column from `plan_events` leaves most rows with empty `outcome` anyway — the column is for going-forward enforcement, and the backfill is best-effort (populate where an event carried one). The "no completion exists with an empty outcome" invariant must be scoped to **new** completions, not retroactive — or the backfill must synthesise an outcome, which is a lie. Scope the invariant to posts after the migration.
- **Schema coordination with the completion-membership plan (subtask 2).** That plan extends the dispatch record with a team-group id; this plan adds `outcome`/`workflow` to the `plans` row. Both are plans-adjacent schema migrations landing in the same feature delivery — coordinate so they are one migration version (or adjacent versions), not two competing `ALTER TABLE` passes.

## Edge-Case & Dependency Audit

- **Race Conditions:** a release and a completion for the same card racing is the existing `completeCardInternal` idempotency domain (`:4054-4056`, `isIdempotent` on `completed_at`). A release must not write `completed_at` (it is not a completion) — so the idempotency check that keys on `completed_at` does not gate a release. The release needs its own "already released" guard (e.g. a `released_at` or a `workflow='operator-release'` event check) or a release-then-complete sequence leaves a card both released and completable.
- **Security:** `_handleKanbanTaskComplete` (`:4196`) validates shape only — no check the caller holds the card. The plan does not add auth; the release verb inherits the same shape-only validation. Acceptable per the plan's scope, but the release verb should at minimum derive the held set server-side (as `/kanban/team/release` already does at `:5561`), not trust a client-supplied `planId`.
- **Side Effects:** `completeCardInternal` clears the coding seat (`:4016`). A release that calls `completeCardInternal` clears the seat too — which is intended for a release (free the team). This is the same clear path the completion-membership plan (subtask 2) hardens for team members on uncertainty; subtask 2's "preserve on uncertainty" is scoped to `queue/done`, NOT `completeCardInternal`. A released team member is therefore cleared unconditionally — acceptable, since release is a deliberate act, but note the asymmetry.
- **Dependencies & Conflicts:** couples to subtask 2's schema migration (coordinate). The `round-complete`/`feature-complete` internal callers (`:4434`, `:4555`, `:5498`) must be updated for forced `outcome`. No conflict with subtasks 1, 3, 4.

## Dependencies

- `sess_three_clear_path_defects` — parent of the completion-membership plan (subtask 2); this plan's release path shares `completeCardInternal`'s clear, which that family hardened.
- Subtask 2 (completion-membership) — shared plans-adjacent schema migration; coordinate the `ALTER TABLE` versions.

## Adversarial Synthesis

Key risks: (1) the release valve inverts a deliberate, commented design decision and is only safe because forced `outcome` makes completion meaningful — change 1 and change 2 are one coupled decision, not four independent changes; (2) the "no completion with empty outcome" invariant, if applied retroactively, either fails on 193 historical rows or forces a synthesised (false) outcome — scope it to new posts; (3) change 4 (skill text + 409 body) is the adoption mechanism, not documentation — without it the invariants pass green on a dead verb. Mitigations: land changes 1+2+4 together; scope the outcome invariant to posts after migration; treat the 409 body and skill text as load-bearing.

## Proposed Changes

### 1. Give the queue a release that is not a completion

- **Logic:** An agent that must free its team without claiming the work is done needs a call that says
  exactly that. Extend the existing `/kanban/team/release` (`LocalApiServer.ts:5561`) concept to the
  per-card case and document it to agents, or add the equivalent — the requirement is a door that
  releases the lock and records that the card was **released, not finished**.
- **Coupling (load-bearing):** this change is only safe alongside change 2 (forced `outcome`). Without
  it, the valve is the "second signal under a new name" the design comment at `:3428-3432` rejects.
  Ship changes 1, 2, and 4 together.
- **Edge cases:** A released card must not read as completed anywhere: not in the board, not in
  rollups, not to the next agent that picks it up. A release must NOT write `completed_at` (it is not
  a completion), so it falls outside `completeCardInternal`'s `completed_at`-keyed idempotency
  (`:4054-4056`); add a release-specific "already released" guard (a `released_at` column or a
  `workflow='operator-release'` event check) so a release-then-complete sequence cannot leave a card
  both released and completable. Derive the held set server-side (as `/kanban/team/release` already
  does), not from a client-supplied `planId`. Releasing must be visible enough that a team using it as
  a habit is obvious.

### 2. Completion carries an outcome, and the row keeps it

- **Logic:** Add `outcome` (and the `workflow` that produced it) to the `plans` row, not just to the
  `plan_events` payload. Require a non-empty `outcome` on `POST /kanban/task/complete`; reject the
  post without one rather than defaulting it to `''`.
- **Implementation:** `plan_events` already carries both, so the shape is settled and the migration is
  additive. Backfill from `plan_events` where a completion event carried one (best-effort — 193 of 201
  historical events have empty outcome, so most rows stay empty; the column is for going-forward
  enforcement). Coordinate the `ALTER TABLE` version with the completion-membership plan (subtask 2),
  which extends the dispatch record in the same delivery.
- **Edge cases:** `operator-release` and any new release verb set the outcome themselves — the
  operator is not made to type one. The internal `round-complete`/`feature-complete` callers
  (`:4434`, `:4555`, `:5498`) must be updated to supply an outcome in the same diff or they start
  being rejected. The "no completion with empty outcome" invariant is scoped to **new** posts after
  the migration, not retroactive rows.

### 3. The queue's 409 must name the release door

- **Logic:** The `409` from `POST /kanban/queue/next` (`LocalApiServer.ts:3590`) currently tells the
  caller to `Post /kanban/task/complete before asking for the next card`. It must name the release
  call instead, and say plainly that completion is for finished work.
- **Rationale:** The instruction is the mechanism. Fixing the endpoints and leaving the skill text
  pointing at completion changes nothing about what agents actually do.

### 4. Update the agent-facing contract in the same diff (adoption mechanism — load-bearing)

- **Logic:** `.agents/skills/switchboard-orchestration/SKILL.md` and
  `.agents/skills/kanban_operations/SKILL.md` both instruct the completion-to-unblock pattern
  (orchestration at the `queue/next` row, kanban_operations at the double-dispatch note). Both change
  with the code.
- **Implementation:** Edit `.agents/` — the generated `CLAUDE.md` / `.claude/skills` mirrors are not
  the source.
- **Why load-bearing:** without this, the 409 and skill text still name completion, agents keep
  completing to unlock, and the plan's invariants pass green on a dead release verb. This change is
  the difference between the feature being used and the feature being a green test.

## Verification Plan

### Automated Tests
- `POST /kanban/task/complete` without an `outcome` is refused.
- A release frees the team for `POST /kanban/queue/next` and the card does **not** read as completed.
- A completed card's row carries its outcome, readable without going to `plan_events`.
- The `409` body names the release call, not completion.
- Backfill: an existing completed card gets the outcome recorded in its completion event.

### Goal Invariants
- Releasing a team and finishing work are different writes with different records.
- No completion **posted after the migration** exists with an empty outcome (scoped to new posts —
  193 of 201 historical rows have empty outcome; a retroactive invariant would fail or force a lie).
- Nothing infers doneness from a lock release.
- **Negative:** a release does NOT write `completed_at` and a released card does NOT read as
  completed in the board, rollups, or the next agent's pickup.
- **Paired positive:** a release DOES free the team for `POST /kanban/queue/next` and records a
  `workflow='operator-release'` (or equivalent) event.
- **Adoption:** the `409` body and both skill files name the release door, not completion.

### Manual
- Drive a team into the `409`, release, and confirm the card returns to the queue as unfinished.

## Outstanding Questions

- None.

## Implementation Summary

Implemented V77: `plans.outcome` + `plans.workflow` + `plans.released_at` (additive ALTER + fresh-schema; backfilled `outcome`/`workflow` best-effort from `plan_events` for rows already carrying `completed_at`). Split the verbs: `releaseCardInternal` writes `released_at` (NOT `completed_at`), clears the dispatch holder so `heldByTeam` returns false, records a `workflow='operator-release'` event, and frees the team — exposed as `POST /kanban/card/release` (per-card) and re-pointed `POST /kanban/team/release` (bulk) off `completeCardInternal`. `completeCardInternal` now requires a non-empty `outcome` on new posts (idempotent repeats of pre-V77 rows pass through) and stamps `outcome`/`workflow` on the row; `round-complete`/`feature-complete` supply their own outcomes. The `queue/next` 409 names both `task/complete` (when done) and `card/release` (to free without finishing), and both `.agents` skill files were updated to the release/finish split. `npx tsc --noEmit` is clean for the touched files (only pre-existing `TS2835` import-style errors in untouched files remain); automated tests were not run this session.

## Review Findings

Changes 1-4 all landed and the V77 schema is correct (`outcome`/`workflow`/`released_at` on `plans`, `PLAN_COLUMNS` + `_readRows` serve them, so `GET /kanban/plan` really returns `releasedAt` as the skill text now claims). Two defects fixed in `src/services/LocalApiServer.ts`: `releaseCardInternal` frees the team ONLY through `releaseDispatchHolder`, gated on `existing.planFile && existing.workspaceId` inside a swallowing try, so a skipped or failed clear returned `success: true` having freed nothing — it now reports `freed`/`freeError`, and the bulk `team/release` counts an unfreed card as failed rather than released; and the docblock's claim that release-then-complete "cannot leave a card both released and completable" was false, so it now states the guard's real one-directional shape. The load-bearing change 4 was written but never committed — both `.agents` skill files sat modified in the working tree while the code shipped, which is precisely the "green test on a dead verb" the plan warned about; they are included in this commit. Three named checks had no test at all, so `src/test/atomic-team-feature-run-context-lifecycle.test.js` (CI-wired) now proves a no-outcome completion is refused with 400 and points at the release door, that `card/release` writes `released_at` and never `completed_at` while clearing the holder and emitting a `released` event, and that the 409 body names both doors; its fake response also lacked `getHeaders`/`getHeader`, which made every routed handler answer 500 — that suite now runs 10/10 green, up from 2 pre-existing failures.

## Deferred Findings

- NIT `src/services/LocalApiServer.ts:4336` — a release writes `outcome: 'Released by <from>'` onto the row. Nothing infers completion from a non-empty `outcome` today, but `workflow` is the field that actually distinguishes the two writes, so a future consumer must read `workflow`/`released_at`, never `outcome`'s presence.
- NIT `src/services/LocalApiServer.ts:4249` — `clearReleasedAt` was added to `KanbanDatabase` but no caller resets `released_at` on re-dispatch, so a released card that is later re-dispatched keeps a stale `released_at` alongside a fresh `dispatched_at`.
- NIT — the V77 backfill's `MAX(timestamp) AS ts` subquery is not correlated to the selected `workflow`/`payload` columns; on SQLite this happens to return the row of the max, but it is a bare-column aggregate and would be wrong under a stricter engine. Best-effort by design and harmless here.
- NIT `src/services/LocalApiServer.ts:4562` — `onTeamReleased` is wired by neither composition root, so the advance-when-ready hook the new handler fires is inert on both hosts (pre-existing).
