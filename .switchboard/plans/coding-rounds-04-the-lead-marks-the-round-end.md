# Coding Rounds 04 — The Lead Marks the Round End, the System Advances

kanbanColumn: CREATED

## Goal

The lead's only remaining verb is "this round is done". The system closes the round, completes its subtasks, clears the seats and dispatches the next one.

### Problem analysis

Today closing a round is N separate completion posts with N independent outcomes. On 2026-09-04 a lead posted three and one took effect; the other two returned `success: true` having done nothing, and the difference was visible only as absent fields. The lead had no way to know, and the next round had to be dispatched by hand.

With rounds registered, closing one is a single unambiguous act against a record the system already holds.

## Metadata

- **Complexity:** 4
- **Feature:** Coding Rounds
- **Tags:** teams, completion, dispatch, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. `POST /kanban/rounds/complete`

`{ "from": "<lead terminal>" }` closes the team's in-flight round. The system marks its subtasks complete, clears their seats, closes the round row, and dispatches the next registered round.

**The lead's post is the authority.** It decided the round is over. Do not re-derive whether the work is really finished, do not sample activity, do not consult timestamps to second-guess it. The head's standing order already states the contract — *"Your POST is the only fact the system acts on."*

### 2. One response, naming what happened

What was completed, which seats were cleared, and which round was dispatched next — or that this was the last one. A response that says `success: true` and nothing else is how the current failure hid for an entire feature run.

### 3. Closing the last round ends the feature

The final round's close is the feature's end: every roster seat is cleared, the lead included, and the team is released. A lead's context is spent when its feature is; carrying it into the next feature is the stale-orchestration problem from the other direction.

### 4. Completion must not be blocked by a stale timestamp

`completed_at` is currently write-once and never reset, so a re-dispatched subtask reads as permanently complete and its completion is discarded. That defect is `711fa15e` and it is a **prerequisite** — without it this endpoint inherits the same silent skip.

## Edge-Case & Dependency Audit

1. **Depends on 01, 02, 03, and on `711fa15e` change 1.**
2. **Closing with no round in flight** is a no-op that says so.
3. **Closing round 2 while round 1 is open** should not be possible; there is one in-flight round per team.
4. **No next round registered** closes cleanly and reports that the queue is empty — not an error.
5. **Both hosts.**

## Verification Plan

1. A lead posts round-complete once and three seats are cleared, three subtasks completed.
2. The next registered round is dispatched automatically, with no further lead action.
3. Closing the last round clears every seat including the lead and releases the team.
4. A close with nothing in flight reports a no-op.
5. A round containing a re-dispatched subtask completes it, once `711fa15e` change 1 has landed.
6. The response names what was completed, cleared and dispatched.
