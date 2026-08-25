# A queued card has no holder; only completed_at releases a team

## Goal

Make the lead's `POST /kanban/task/complete` the single fact that frees a coding team to
take more work. Remove board position from the in-flight predicate, and release
`dispatched_terminal` when a card returns to the queue so the holder fact means what it
says.

### Problem Analysis

**The harm.** `LocalApiServer.ts:1920` counts a card as in flight only while it sits in a
coding column:

```js
CODING_COLUMNS.has(p.kanbanColumn)   // LEAD CODED | CODER CODED | INTERN CODED
  && !p.completedAt
  && p.dispatchedTerminal
  && teamSet.has(p.dispatchedTerminal)
```

A card that leaves a coding column therefore frees the team even though `completed_at` is
still NULL. The lead pulls its next card and starts coding while the previous card is
still live work — a reviewer reading it, a coder applying fixes. Both run in the same
worktree, edit the same files, and land in the same commit.

The defect is not that the column is an imprecise progress signal. It is that **any**
second release signal permits two agents to code concurrently on one tree. The comment at
`:1901` names both releases explicitly: `completed_at` set, **or** the card leaving the
coding column.

**A third signal, latent.** `dispatched_terminal` is never cleared once written —
`clearWorkingState` nulls only `dispatched_at`. The escalation ladder re-stages a failed
card to STAGING (`:2705-2740`) and rewrites queue positions, but leaves the old holder on
the row. Today the column check masks that: STAGING is not a coding column, so the card
stops matching. Drop the column without releasing the holder and the ladder 409s on the
very card it just re-staged.

**Why there is no release valve.** An un-posted card blocking the queue is the intended
behaviour. Any valve is a third signal and restores the concurrency this plan removes the
moment a lead uses it instead of posting. The 409 already names the blocking card's
planId, column and seat, and the completion post is unconditional in the lead's orders and
rendered as an executable call in the `queue/done` relay — the lead has everything it
needs to close the blocker out.

### Release Contract

| Fact | Meaning | Written by | Cleared by |
|---|---|---|---|
| `dispatched_terminal` | this seat holds this card | dispatch / paste attribution | re-stage to the queue; completion |
| `dispatched_at` | a turn is in flight on that seat | dispatch | `clearWorkingState` on report |
| `completed_at` | **the lead asserts this card is done** | `POST /kanban/task/complete` | never |

`kanban_column` appears nowhere. It records where a card is, never whether a team may take
more work.

## Metadata

**Tags:** backend, bugfix, reliability

**Complexity:** 6

## User Review Required

None. The release contract above is fully determined: one holder fact, one completion
fact, no board position, no valve.

## Complexity Audit

### Routine

- Drop one clause from one predicate.
- Rewrite the 409 message.

### Complex / Risky

- Releasing `dispatched_terminal` changes a field three other readers consult:
  `getActiveDispatchedByTerminal`, `getLiveDispatchAttribution`, and the turn-end
  backstop. Each must be checked for a dependence on the holder outliving the dispatch.
- `stillCoding` (`:2680`) reads a column to detect that the watch or an operator already
  re-queued the card. It must be re-expressed against the holder, not deleted — deleting
  it lets the ladder re-stage the same card twice.
- The in-flight scan reads a board snapshot. A completion posted between load and scan
  reads as still-held unless the matched row is re-read.

## Edge-Case & Dependency Audit

### Race Conditions

- Re-stage becomes three writes (release holder, move column, rewrite queue order).
  Release the holder FIRST: the worst interleaving is then a card that reads free slightly
  early, rather than one that blocks its team's queue permanently.
- The in-flight branch must re-read the canonical row before refusing, mirroring the fresh
  read the escalation branch already performs at `:2674`.
- Concurrent `queue/done` calls from two seats on one team already serialise on
  `_teamQueueDoneChains`; the tighter predicate opens no new window.

### Security

- No new caller-supplied field. `from` is still never trusted as a clear target.

### Side Effects

- A team with an un-posted card cannot pull more work. Intended, and the reason the
  completion post is unconditional.
- A card sitting in the queue reports no holder to the board, the dispatch-attribution
  readers, and the turn-end backstop. This is the correct reading — nobody holds it — but
  it is a visible change to those surfaces.

### Dependencies & Conflicts

- Touches `LocalApiServer.ts` and `KanbanDatabase.ts` only — no file overlap with the
  head-prompt subtasks, so it runs concurrently with them on a separate seat.
- Ships with the reviewer-removal subtask: without it the lead still has a card-movement
  path, and this predicate silently makes that path block rather than release.

## Dependencies

None (file-independent of its sibling subtasks).

## Adversarial Synthesis

Key risks: (1) deleting the column from the predicate without releasing the holder on
re-stage — the escalation ladder deadlocks on the card it just re-staged, and the failure
looks like the gate working; (2) a release valve for abandoned cards — that is the second
signal returning under a new name; (3) `releaseDispatchHolder` not cleaning
`last_liveness_at` / `blocked_at`, leaving stale stamps on a re-queued card. Mitigations:
`releaseDispatchHolder` is called before the column write in re-stage and nulls all four
fields mirroring `clearWorkingState`; the three other `dispatched_terminal` readers all
key on `dispatched_at IS NOT NULL` and are confirmed safe (step 5 finding).

## Proposed Changes

### 1. `src/services/LocalApiServer.ts:1920-1937` — one release signal

Replace the predicate with:

```js
!p.completedAt && p.dispatchedTerminal && teamSet.has(p.dispatchedTerminal)
```

Delete `CODING_COLUMNS` from this site. Re-read the canonical row for the matched card
before refusing. Rewrite the 409 to name the one release — post completion for the named
card — and drop "(or hand the feature to review)".

### 2. `src/services/KanbanDatabase.ts` — `releaseDispatchHolder`

Add `releaseDispatchHolder(planFile, workspaceId)`: one UPDATE nulling
`dispatched_terminal`, `dispatched_at`, `last_liveness_at`, and `blocked_at`, then persist.
Nulling all four mirrors `clearWorkingState`'s cleanup so a failed card re-entering the
queue starts from a clean basis (no stale heartbeat or blocked stamp). A new method rather
than widening `updateDispatchInfoByPlanFile`, whose callers all mean "assign", not "release".

### 3. `src/services/LocalApiServer.ts:2705-2740` — re-stage releases the holder

Call `releaseDispatchHolder` before the column write in the escalation re-stage.

### 4. `src/services/LocalApiServer.ts:2680` — re-express `stillCoding`

Replace `CODING_COLUMNS.has(currentColumn)` with a holder check: the card is "still coding"
if its `dispatched_terminal` is non-empty on the fresh read. If the watch already released
the holder (null `dispatched_terminal`), the ladder treats it as already re-staged and
falls through to the pop. This agrees with change 1: the holder, not the column, is the
signal.

### 5. Audit the three other `dispatched_terminal` readers — FINDING: all safe

`getActiveDispatchedByTerminal` (`:10350`), `getLiveDispatchAttribution` (`:10456`), and
the turn-end backstop (`:2444`). All three key on `dispatched_at IS NOT NULL` (or
`dispatchedAt` truthy). After `releaseDispatchHolder` nulls `dispatched_at`, none of them
match the released row. The turn-end backstop is the `queue/done` path, which calls
`clearWorkingState` (not `releaseDispatchHolder`) — it is unaffected by this change. No
reader depends on a queued card retaining its holder. No fix needed; document the finding
in a code comment at each site noting the holder is released on re-stage.

### 6. Tests

- In-flight: a card in ANY column with a team holder and no `completed_at` refuses the
  pop; the same card with `completed_at` set releases it. Pin that the predicate contains
  no column comparison.
- Escalation round trip: fail → re-stage → holder released → the immediately following pop
  dispatches that card rather than 409-ing on it.
- A card re-staged by the watch is not re-staged a second time by the ladder.
- Duplicate completion post does not double-release.

## Verification Plan

### Automated Tests

- New in-flight predicate contract (column-free, both pacing modes).
- New escalation ladder round-trip contract.
- Existing `queue-done-relay`, `task-complete`, `atomic-team-lifecycle`.

### Goal Invariants

- Exactly one fact releases a team: `completed_at`.
- The in-flight predicate contains no `kanbanColumn` comparison.
- A card in the queue has no `dispatched_terminal`.
- Moving a card between columns, by any actor, never changes whether a team may take work.
- There is no release path for an un-posted card other than posting.

### Manual Verification

1. Lead finishes subtask 1, commits, posts. Next card dispatches.
2. Same without posting: `queue/next` refuses and names the card. Posting releases it.
3. Drag the un-posted card to CODE REVIEWED by hand: the team stays held.
4. Subtask reported `failed`: card re-stages, holder released, next pop dispatches it to
   the stronger seat with no 409.
5. Board and Terminals panels show no holder on a queued card.

## Recommendation

Send to Lead Coder. Changes 1 and 3 must land together — change 1 without change 3
deadlocks the escalation ladder.

## Implementation Summary

Replaced the in-flight predicate in `LocalApiServer.ts` with a column-free check keying strictly on `!completedAt` and held terminal in `teamSet`, including canonical row re-reads. Added `releaseDispatchHolder` to `KanbanDatabase.ts` to clear `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, and `blocked_at` upon re-queuing. Updated escalation ladder re-staging in `LocalApiServer.ts` to release holder prior to column move and re-expressed `stillCoding` against the holder fact. Audited other terminal readers and updated contract tests to assert the single release signal invariant.

## Feature Completion Summary

All three subtasks implemented and committed. The coding team head prompt no longer references `targetColumn`, a reviewer roster check, or `/kanban/dispatch`; it states one ending — commit, post `task/complete` with the subtask's planId, then `queue/next`. The in-flight predicate in `LocalApiServer.ts` is column-free, keying on `!completedAt && dispatchedTerminal && teamSet.has()` with canonical row re-reads. `releaseDispatchHolder` clears the holder on re-stage so the escalation ladder does not deadlock. Fifteen frozen prompt snapshots, nine recognisers, `COMMIT_INSTRUCTION_MARKER`, and all fragment-based migration arms were deleted from `teamWiring.ts` and `terminals.js`; structural seed and pair-order migrations retained. New `coding-head-prompt-contract.test.js` pins the cross-file byte-identity and content invariants.


## Review Findings

Two defects fixed. MAJOR: the in-flight scan in `LocalApiServer.ts` found only the first
candidate via `board.find`, re-read it, and if that row came back completed it abandoned the
scan entirely — a team still holding a second un-posted card was released, a fail-open the
pre-change code did not have; it now filters all candidates and re-reads each, refusing on the
first still-held row. CRITICAL: `queue-pipeline-contract` (CI-wired) went green→red because its
column-free assertion sliced the whole `isTeamDispatch` block, catching the `kanbanColumn` the
409 message deliberately reports; the assertion is now scoped to the decision, before
`return fail(409`. Two behavioural regression tests were added (stale-completed first candidate
still refuses on the second held card; a candidate that re-reads as completed does not block),
and the first reproduced the fail-open against the pre-fix build. Verified: `queue-pipeline`,
`queue-done-relay`, `task-complete`, `atomic-team-lifecycle`, `completion-asserted`,
`dependency-gate` all green; compile, compile-tests, lint (0 errors), 9 static gates green.
Remaining risk: `releaseDispatchHolder` correctly nulls all four fields, but the `parked` branch
still leaves a holder on a card resting in a coding column, so the follow-on pop 409s — that is
pre-existing under both the old and new predicates and out of this plan's scope.
