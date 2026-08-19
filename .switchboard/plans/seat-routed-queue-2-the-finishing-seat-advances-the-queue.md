# The Finishing Seat Advances the Queue — `POST /kanban/queue/done`

## Goal

Give a seat one endpoint to call when it finishes a card. That call releases the seat's working-state latch, clears the seat's context, and dispatches the next queued plan — as a single serialized operation. This is the mechanism that makes the queue self-pacing with no head and no orchestrator.

**The card does not move.** It was moved to its coding column when it was dispatched, it got coded, and it stays there.

### Problem analysis — root cause

Today the pipeline's "get the next card" step is driven by an agent that is **not** the one that did the work: the head calls `POST /kanban/queue/next` when its reviewer reports a pass, and the instruction to do so lives in the head prompt (`src/services/teamWiring.ts:408` and its mirror at `:449`). Remove the head and nothing calls the pop.

Two things block the finishing seat from simply calling `queue/next` itself.

**1. The release signal is imprecise.** Subtask 1 makes the seat-paced in-flight predicate read `plans.dispatched_at` — the working-state latch (V51, `src/services/KanbanDatabase.ts:412`) — rather than board position, because a coded card never leaves its coding column and board position therefore never releases. That latch already has off-switches, and neither is good enough to pace a queue on:

- **The plan-file `mtime` advance** (`switchboard-contracts` #2, `src/services/PlanIngestionEngine.ts:1806`) fires on the *first* edit after dispatch. A seat that edits the plan mid-work trips it early, and the queue then dispatches a second card to a team still working the first. This imprecision is why the completion-driven dispatch arm was deleted in the first place; making it load-bearing again re-introduces a defect the project already paid for.
- **`clearStaleWorkingState`** is a timeout. It is a backstop against a dead seat, not a pacing signal — pacing on it means every card costs the full timeout window whether the seat finished in two minutes or twenty.

So the queue needs a signal that means *"I am finished"* and nothing else. The seat is the only party that knows, so the seat has to say it.

**2. The finishing seat's context is never cleared.** `/clear` is pasted onto the **receiving** terminal at dispatch time (`src/services/TaskViewerProvider.ts:21197-21223`, gated by `terminal.clearBeforePrompt`). With one card at a time and complexity routing, the next card usually lands on a *different* seat — so the seat that just finished keeps its full context and carries it into whatever it is handed next, possibly hours later.

Release-then-pop cannot be two client calls. Between them the team reads as idle with a staged queue, which is exactly the window a schedule tick (`TaskViewerProvider._scheduleQueuePop`, `:12969`) or a second seat's call would use to pop the card the first seat is about to pop. Both steps must sit inside one critical section on the same `_queueNextChain` the pop already serializes on (`src/services/LocalApiServer.ts:52`).

### Is trusting the seat's call a contract violation?

No, and it is worth stating so a later coder does not "fix" it back to `mtime`. `switchboard-contracts` #2 says **no agent-authored *text*** is trusted as a control signal — the concern is parsing a coder's prose for "done". An HTTP call to a dedicated endpoint is not text; it is the same class of signal as `POST /kanban/queue/next` and `POST /phone-a-friend/done`, both of which are already trusted agent-initiated control calls that drive real dispatch.

What the seat's call does **not** establish is that the work is *good*. It releases pacing, nothing more. The existing off-switches stay wired as backstops for the seat that never calls.

### The precedent to copy

`POST /phone-a-friend/done` (`LocalApiServer.ts:2874`) is this exact shape and already shipped: an agent calls it when finished, the host advances a per-target sequential queue, and **duplicate callbacks with nothing in flight are silently ignored** (`:340`). Copy its contract, including the silence on duplicates — an agent that calls twice, or calls after the mtime signal already released the latch, must not get an error it then tries to "fix".

## Metadata

**Complexity:** 4
**Tags:** backend, api, reliability, feature

## Implementation

1. **New callback and route.** `POST /kanban/queue/done`, body `{ workspaceRoot?, from, outcome?, planId? }`.
   - `from` — the calling seat's own terminal name. Required.
   - `outcome` — `'finished'` (default) or `'failed'`. `'failed'` is subtask 3's escalation path; this subtask must accept and forward the field without acting on it, so the two can ship in either order.
   - `planId` — optional. When absent the host resolves the card the seat is holding; when present it must match, or the call is refused rather than releasing somebody else's card.

2. **Resolve the seat's card from the board, not from the request.** Find the active card whose `dispatchedTerminal === from`, whose column is in `CODING_COLUMNS` (`LocalApiServer.ts:57`), and whose `dispatched_at` is set. No such card → **200 no-op** with a `reason`, matching the phone-a-friend duplicate contract. Never 4xx a duplicate: the mtime off-switch may legitimately have got there first.

3. **Run release → clear → pop as one critical section.** Enqueue the whole sequence onto `_queueNextChain` and call `dispatchNextFromQueue`'s inner run body directly rather than the public method — calling the public method from inside the chain deadlocks it. Extract the existing run body into a private helper that both the public method and this handler enqueue, so there remains exactly one pop implementation and one serialization point.

4. **Release the latch through the existing off-switch.** Call `clearWorkingState(planFile, workspaceId)` (`KanbanDatabase.ts:9935`) — the same function the mtime path calls. Do not write `dispatched_at` directly and do not add a second clearing function: one off-switch, three callers (mtime, timeout, this endpoint). `clearWorkingState` returns true only on a real transition, which gives the duplicate case its answer for free — a `false` return is a no-op, reported as such.

   **Do not move the card.** Cards move on coding start and never on finish (`switchboard-contracts` #1). There is no destination column for a finished card in this model and inventing one — `CODE REVIEWED` asserts a review that never ran, `COMPLETED` asserts an acceptance nobody gave — makes the board lie to every downstream consumer, including the archive's role attribution (`src/services/ArchiveManager.ts:135`). The coding column *is* the record: this card was coded by this seat.

5. **Clear the finishing seat.** Reuse the existing clipboard-paste `/clear` path with its per-terminal send lock (`TaskViewerProvider.ts:21176-21223`) via a new host callback — do **not** hand-roll a `sendText('/clear')`, which the comment at `:21198` explains gets swallowed by CLI slash-command mode. Respect `terminal.clearBeforePrompt`: when the operator has turned clearing off, honour that here too rather than special-casing this path. A clear failure is logged and does not abort the pop — a stale context is a degraded run, an unpopped queue is a dead night.

6. **Then pop.** With the latch released the team is genuinely free by subtask 1's seat-paced predicate. Return `{ released: <planId>, cleared: <bool>, dispatched: <payload|null> }`. `dispatched: null` with reason `queue empty` is the normal end of a run, not an error — the seat should read it as "stop, and say so".

7. **Arm the watch on the release, not only on the dispatch.** `armQueueWatch` currently fires after a successful dispatch (`LocalApiServer.ts:1695`). A release that pops nothing because the queue is empty is fine; a release that pops nothing because the *dispatch failed* leaves a staged queue and an idle team, which is precisely the silent night the watch exists to catch. Arm on the release path too.

8. **Catalog and allowlist.** Add the route to `protocol-catalog.json` and any verb allowlist entry it needs (`src/generated/verbAllowlist.ts`). A missing catalog entry turns CI's `catalog:check` red and leaves the control dead in the browser host — this exact miss was a MAJOR finding in the preceding feature's review.

## Verification Plan

1. **Happy path, end to end.** Seat-paced team, three cards staged (complexity 3, 5, 8). Dispatch card one, then have the holding seat POST `queue/done`. Assert: card one is **still in its coding column** with `dispatched_at` cleared; a `/clear` was sent to that seat; card two is dispatched to its complexity-routed seat; `queue_position` on the remaining card is intact.
2. **No card is ever moved after coding.** Run the queue to exhaustion and assert the final board is one card per coding column, nothing in `CODE REVIEWED`, nothing in `COMPLETED`, and no `plan_events` row recording a post-coding move. This is the regression gate for the contract-#1 violation this plan previously contained.
3. **Duplicate call is a silent 200.** Call `queue/done` twice for the same seat. Second call returns 200 with a `reason` and dispatches nothing. Assert the queue did not advance twice — this is the test that catches a double-pop skipping a card.
4. **The mtime off-switch getting there first is also a silent 200.** Trip the mtime advance, then call `queue/done`. Assert no error, no second pop, and that the queue advanced exactly once in total.
5. **Race: `queue/done` and a schedule tick concurrently.** Fire both without awaiting the first. Assert exactly one card leaves `DISPATCH`. Run in a loop (≥50 iterations) since a chain bug is intermittent by nature.
6. **Release failure aborts cleanly.** Stub `clearWorkingState` to fail. Assert: no `/clear` was sent, no pop happened, `dispatched_at` still set, and the error is returned verbatim.
7. **Clear failure does not block the pop.** Stub the clear callback to throw. Assert the next card still dispatches and `cleared: false` is reported honestly.
8. **`clearBeforePrompt` off is respected.** No clear attempted, `cleared: false`.
9. **`planId` mismatch is refused**, not silently redirected to whatever the seat is actually holding.
10. **Empty queue ends the run.** Last card released → `dispatched: null`, reason `queue empty`, watch not left armed on a queue with nothing in it.
11. **Head-paced teams are unaffected.** A head-paced team's head calling `queue/next` behaves exactly as it does today, and `queue/done` is not part of its flow.

`npm run compile` clean; `catalog:check` green (step 8 is the reason it would not be); the seven PRD gates green.
