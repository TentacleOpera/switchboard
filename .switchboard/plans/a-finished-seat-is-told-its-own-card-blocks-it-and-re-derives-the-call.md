# A Finished Seat Is Told Its Own Card Blocks It, Then Re-Derives the Call It Was Given

## Goal

A seat that has finished its subtask reports once, closes out once, and stops. It is never sent
back to read the source to work out which call to make, and it is never told its own card is what
blocks it.

### What happened (Coding-intern, 2026-09-13, from its session log)

The seat got it right, then could not get confirmation that it had:

1. **Finished the subtask correctly.** Code changes in the working tree, summary appended to the
   plan file, report delivered to the head via `ptySendPrompt`. Nothing wrong to this point.
2. **Ran `done --from Coding-intern`.** The response was **409**, carrying
   `"released": "9fe3046b-…"` — the seat's own card. So the call *did* something (the card was
   released, the team freed) and reported a conflict at the same time. The agent could not tell
   whether it had succeeded.
3. **Followed the 409's own remedy.** The body reads *"Completion is for FINISHED work — POST
   /kanban/task/complete with a non-empty outcome when the work is done"*, so it prepared exactly
   that: `/tmp/devin-so-complete.json`, 3389 bytes, `outcome: "finished"`.
4. **Then went reading the source instead of sending it** — `LocalApiServer.ts:4568-4657`,
   `:3690-3759`, and a grep of `./src/standalone` for `done|--from|task/complete|queue/done`. It
   was working out the correct call signature from the implementation, because the instructions
   it held had already been contradicted once.
5. **Repeated that.** Its own account: *"I should have stopped and asked rather than barrel into a
   third call… the right move was to surface that to you instead of improvising a
   /kanban/task/complete POST you did not explicitly authorize."*

It ended halted with the card **released but not completed**, waiting for a human.

### The three defects

**1. `done` returns 409 while also releasing the card.** The response carried `released: <planId>`
and a conflict status together. A caller cannot act on that: it has neither a success it can
record nor a clean failure it can retry. The agent's next three actions all follow from not
knowing which happened.

**2. The 409 body is a SIXTH place that instructs agents to supply an `outcome`.**
`LocalApiServer.ts:3740`:

> *"Team already in flight: card '<id>' is in '<column>' held by '<terminal>' with no completion
> post. Completion is for FINISHED work — POST /kanban/task/complete with a non-empty outcome when
> the work is done."*

Five instruction sites were corrected when the `outcome` gate was removed. This one was missed
because it is **prose in an error body**, not a payload template — and the contract test written
at the time matches on the literal `task/complete with {"from"` shape, so it cannot see it. The
error text is now actively teaching agents a payload the endpoint no longer wants.

**3. An agent reading the source to discover a call signature is an unhandled failure.** Step 4 is
the tell. The seat had an instruction, was refused, was handed a different instruction by the
error, and resolved the disagreement by reading `LocalApiServer.ts`. That is expensive, it burns
the context the seat needs for its actual work (this one ended at 139k/200k), and it only happens
when the contract an agent was given is not trustworthy.

### Non-goals

- **Making the agent retry harder.** It stopped and asked, which was right. The fix is to make the
  first call answerable, not to add retries.
- **Reinstating an `outcome` requirement.** No agent writes a summary to close work out. This plan
  removes the last place that asks for one.
- **A new completion endpoint.** `done`, `task/complete` and `card/release` are the right three
  doors; the problem is what they say when refusing.

## Metadata

- **Complexity:** 3
- **Tags:** teams, completion, api, bugfix

## User Review Required

None.

## Proposed Changes

### 1. `done` never returns a conflict for a card it just released

If the call released the seat's card, that is a success and returns `200` naming what was
released. A 409 is reserved for the case where nothing was done. The two must never arrive
together — a response that both acts and refuses is unanswerable by a caller with no human
attached.

### 2. Strip the outcome instruction from the 409 body

`LocalApiServer.ts:3740` stops naming a non-empty outcome. It names the two doors and what each
one means: `task/complete` for finished work, `card/release` to free the team without claiming
the work is done. Nothing about writing a summary.

### 3. The contract test reads error bodies, not just payload templates

The existing `test:contract:task-complete-instruction` scans for the literal payload shape and
therefore missed a prose instruction in an error string. Extend it to fail on **any** source text
that tells an agent to supply an outcome — payload template, error body, comment or skill file.
That is the assertion that would have caught this one.

### 4. An error that refuses an agent names one next action

Every refusal an agent can receive on the completion path states exactly one thing to do next. The
409 today names two doors and a field requirement, which is what let a seat pick the wrong one and
then go reading source to break the tie. Where a genuine choice exists, the error says to report
it to the head rather than choose.

## Verification Plan

### Automated Tests

1. Extend `src/test/task-complete-instruction-contract.test.js` (already wired as
   `test:contract:task-complete-instruction` in CI) with an assertion that no source string —
   including error bodies — instructs an agent to supply an outcome. Verified load-bearing by
   restoring the 409's current wording and watching it fail.
2. **New** case in the same suite: `done` against a card it can release returns `200` with the
   released id, never `409` alongside `released`.
3. Assert every refusal on the completion path names exactly one next action.

### Goal Invariants

- A seat that finishes a subtask completes its close-out with one call and one answer.
- No agent reads `LocalApiServer.ts` to work out how to report completion.
- A response never both releases a card and refuses the request.
- No error body asks an agent to write a summary.
