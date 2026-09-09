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
`POST /kanban/team/release` (`LocalApiServer.ts:5527`) is documented as *"operator release control for
a team"*, derives the held set server-side, and calls `completeCardInternal` with
`workflow: 'operator-release'`. It appears nowhere in `.agents/skills/*/SKILL.md`. So the concept is
already built and already distinguished in the event log — it is simply not reachable by the caller
who needs it, and it still writes a completion.

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

## Proposed Changes

### 1. Give the queue a release that is not a completion

- **Logic:** An agent that must free its team without claiming the work is done needs a call that says
  exactly that. Extend the existing `/kanban/team/release` concept to the per-card case and document
  it to agents, or add the equivalent — the requirement is a door that releases the lock and records
  that the card was **released, not finished**.
- **Edge cases:** A released card must not read as completed anywhere: not in the board, not in
  rollups, not to the next agent that picks it up. Releasing must be visible enough that a team using
  it as a habit is obvious.

### 2. Completion carries an outcome, and the row keeps it

- **Logic:** Add `outcome` (and the `workflow` that produced it) to the `plans` row, not just to the
  `plan_events` payload. Require a non-empty `outcome` on `POST /kanban/task/complete`; reject the
  post without one rather than defaulting it to `''`.
- **Implementation:** `plan_events` already carries both, so the shape is settled and the migration is
  additive. Backfill from `plan_events` where a completion event exists.
- **Edge cases:** `operator-release` and any new release verb set the outcome themselves — the
  operator is not made to type one.

### 3. The queue's 409 must name the release door

- **Logic:** The `409` from `POST /kanban/queue/next` currently tells the caller to post completion.
  It must name the release call instead, and say plainly that completion is for finished work.
- **Rationale:** The instruction is the mechanism. Fixing the endpoints and leaving the skill text
  pointing at completion changes nothing about what agents actually do.

### 4. Update the agent-facing contract in the same diff

- **Logic:** `.agents/skills/switchboard-orchestration/SKILL.md` and
  `.agents/skills/kanban_operations/SKILL.md` both instruct the completion-to-unblock pattern
  (orchestration at the `queue/next` row, kanban_operations at the double-dispatch note). Both change
  with the code.
- **Implementation:** Edit `.agents/` — the generated `CLAUDE.md` / `.claude/skills` mirrors are not
  the source.

## Verification Plan

### Automated Tests
- `POST /kanban/task/complete` without an `outcome` is refused.
- A release frees the team for `POST /kanban/queue/next` and the card does **not** read as completed.
- A completed card's row carries its outcome, readable without going to `plan_events`.
- The `409` body names the release call, not completion.
- Backfill: an existing completed card gets the outcome recorded in its completion event.

### Goal Invariants
- Releasing a team and finishing work are different writes with different records.
- No completion exists with an empty outcome.
- Nothing infers doneness from a lock release.

### Manual
- Drive a team into the `409`, release, and confirm the card returns to the queue as unfinished.

## Outstanding Questions

- None.
