# A Dispatched Card Stops Being Outstanding Forever

kanbanColumn: CREATED

## Goal

A dispatched card that never reports reaches a bounded, named end state. The board stops claiming
work is in flight when nobody is doing it. **No retry** — that is deliberate and argued below.

### Problem analysis

**There is no timeout anywhere on the dispatch path.** A grep of `KanbanProvider` and
`PlanIngestionEngine` for retry, backoff, attempt or timeout returns feature-link resolution and
queue pacing — nothing that bounds a dispatched card. The only `timeoutMs` values in `src/services`
belong to ClickUp and Notion HTTP calls. A card dispatched to a seat that dies or silently finishes
stays outstanding until a human notices.

The cost is not a stalled agent — it is a **board that lies**. Anything reading "what is in flight"
gets a wrong answer: the operator, the queue, and the nudge sweep that has to filter around it.

### Why this card does not retry, having originally proposed it

The first draft imported "retries with backoff" from a comparable unattended orchestrator. That
premise does not transfer, and the individual cases do not survive being taken apart:

- **A coder reporting failure.** The agent tried and concluded it could not. Re-running an identical
  prompt produces an identical result and spends the quota twice.
- **A seat exiting non-zero.** Occasionally transient, usually not — and there is a human watching
  this board, which is the difference from a tool designed to run with nobody looking.
- **A dispatch that never landed.** Real, transient, and **already solved**: *A Half-Delivered
  Dispatch Has No Safe Recovery* (`ba068390`, CODE REVIEWED) delivers exactly this — see that the
  prompt did not land, and re-deliver it *without clearing the seat*, with a redeliver path at
  `bootstrap.ts:3750`. Adding a second retry mechanism beside it would fight it.

So the one genuinely transient failure has a shipped answer, and the rest are decisions a person
should make. **Do not add retry to this card later without a new argument.**

**And this is not the nudge card.** `A Card Dispatched Long Enough With No Report Nudges the Lead`
(`0417d620`, Planned) tells a human that a card has been quiet — deliberately one predicate and two
fields. Notification is not the same as ending an attempt: the nudge asks someone to look, this
records that nobody did.

## Metadata

- **Complexity:** 3
- **Tags:** dispatch, board-hygiene, reliability, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. A bounded lifetime, ending in a named state

Give a dispatched card a configurable timeout, set well beyond the nudge threshold. On expiry the
attempt ends as **`timed out`**, recorded with the seat and the elapsed time.

`timed out` is not `failed`, not `complete`, and not silence. It means *the attempt was abandoned
because nothing was heard*, and that distinction must survive into everything that reads it. A state
that collapses into "not done" tells the next reader nothing about whether the work happened.

### 2. Never infer completion, in either direction

Nothing here writes `completed_at`. A timed-out card is not done, and it is not proven undone
either — the coder may have finished and failed to report, which is the incident `0417d620` was
written from. Completion remains the explicit POST.

### 3. Release the seat and clear the stamp

A timed-out card releases its seat so the seat returns to the pool, and clears `dispatched_at` so
the card stops reading as in flight.

Check `bf23c37f` (*A column move orphans the dispatch holder*, starred) first — clearing
`dispatched_at` is precisely the operation it is about, and `0417d620`'s audit warns that a nulled
stamp silently drops a card out of the nudge predicate. Ending an attempt must not also end the
board's ability to notice it.

### 4. Say so once

The card shows it timed out, with the seat and elapsed time. One record, no repetition — the nudge
already owns telling people.

## Edge-Case & Dependency Audit

1. **Both composition roots.** The sweep runs in the plan engine, whose queue seams were wired in
   `extension.ts` alone for a month. A timeout enforced on one host and not the other is worse than
   none, because the operator will trust it.
2. **Thresholds far apart.** Nudge in minutes, timeout in hours. A timeout that fires before a human
   has plausibly read the nudge makes the nudge pointless.
3. **A legitimately long task will hit it.** That is what the configurable threshold is for, and why
   the end state is `timed out` rather than `failed`.
4. **Teams.** A timed-out coder inside a running feature affects its lead. Decide whether the lead is
   told; do not act into a team mid-round beyond recording the state.
5. **Do not fold this into `0417d620`.** That card is one predicate by design and its change 6
   forbids acquiring extra gates. This consumes the same fields and is a separate mechanism.
6. **Do not add retry.** See the problem analysis. `ba068390` owns re-delivery.

## Verification Plan

1. A card dispatched past its timeout with no report reaches `timed out`, recorded with seat and
   elapsed time, and is **not** re-dispatched.
2. No path writes `completed_at`; a timed-out card is never treated as done.
3. The seat is released and returns to the pool; `dispatched_at` is cleared without dropping the card
   out of the nudge predicate — assert both.
4. The nudge fires first and the timeout much later, with defaults far enough apart for a human to
   act in between.
5. A card that reports normally before the timeout is unaffected, and no timeout state is recorded.
6. `grep -rn "retry\|backoff" ` over the changed files returns nothing — this card adds neither.
7. The timeout is armed on **both** hosts, verified by reading both composition roots rather than by
   observing one.
