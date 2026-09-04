# Coding Rounds 03 — The System Dispatches the Round

kanbanColumn: CREATED

## Goal

Dispatching a round — clearing the seats, delivering the prompts, recording who got what — is the system's job. The lead stops issuing dispatches.

### Problem analysis

Every defect reported on 2026-09-04 was in mechanics the lead was performing by hand: clearing seats, sequencing deliveries, re-dispatching when one dropped. The lead is not bad at this; it should not be doing it. A prompt that fails to land is invisible to an agent driving curl, and a redispatch is destructive precisely because nothing above it is tracking what was already sent.

Moving the mechanics into the system makes the sequence one code path, testable, and recoverable.

## Metadata

- **Complexity:** 5
- **Feature:** Coding Rounds
- **Tags:** teams, dispatch, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Dispatching a round is one operation

Given a registered round: assign its subtasks to seats, clear those seats, deliver each prompt, and record the seat against each subtask on the round row. One operation, one outcome, one record of what actually happened.

The clear here is unconditional across the round's seats. A round boundary is a barrier — there is nothing to protect and no busy check to add.

### 2. Record delivery per subtask, not per round

A round where two of three prompts landed is not a round that was dispatched. Record each subtask's delivery outcome so the round's state is honest and the missing one can be re-sent without touching the other two.

This is what makes recovery possible at all, and it is the half that does not exist today.

### 3. Re-delivery is safe and does not clear

Re-sending a subtask's prompt to its recorded seat must not clear that seat — the seat is being repaired, not handed new work. Repeating it must not compound.

### 4. The lead is not a dispatcher any more

Once this lands, the head's standing orders must stop instructing the lead to dispatch subtasks to seats. Leaving both paths live means two things racing to seat the same subtask. Subtask 05 owns the prompt change; this subtask owns making the system path exist and be the one that runs.

## Edge-Case & Dependency Audit

1. **Depends on 01 and 02.**
2. **Fewer seats than subtasks** is the lead's plan to make, not the system's to correct. Dispatch what the round names, and report if a subtask has no seat rather than silently holding it.
3. **A seat that dies mid-round** leaves its subtask recorded as undelivered. That is the correct record and the input to recovery.
4. **The lead is never one of the cleared seats.**
5. **Both hosts.** This is composition-root wiring, which is where the two roots historically diverge — diff them by hand.

## Verification Plan

1. Dispatching a three-subtask round clears three seats and delivers three prompts, recorded per subtask.
2. A round where one delivery drops records two delivered and one not, and the round is not marked dispatched.
3. Re-sending the missing one delivers it without clearing its seat or touching the others.
4. Re-sending twice does not compound.
5. A subtask with no available seat is reported, not silently skipped.
6. Both hosts produce the same records for the same round.
