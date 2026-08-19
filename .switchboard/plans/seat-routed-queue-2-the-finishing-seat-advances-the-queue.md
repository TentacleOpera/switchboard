# The Finishing Seat Advances the Queue — `POST /kanban/queue/done`

## Goal

Give a seat one endpoint to call when it finishes a card. That call retires its card, clears its own context, and dispatches the next queued plan — as a single serialized operation. This is the mechanism that makes the queue self-pacing with no head and no orchestrator.

### Problem analysis — root cause

Today the pipeline's "get the next card" step is driven by an agent that is **not** the one that did the work: the head calls `POST /kanban/queue/next` when its reviewer reports a pass, and the instruction to do so lives in the head prompt (`src/services/teamWiring.ts:408` and `:449`). Remove the head and nothing calls the pop.

The finishing seat cannot simply call `queue/next` itself. Three things block it, and each is load-bearing rather than incidental:

1. **Its own card causes a 409.** The in-flight predicate refuses a team holding any card in a coding column (`src/services/LocalApiServer.ts:1573-1590`). A seat calling at the moment it finishes is, by definition, still holding a card in `INTERN CODED` / `CODER CODED` / `LEAD CODED`. The predicate is correct — the card genuinely has not moved — so the fix is to retire the card first, not to weaken the predicate.
2. **Nothing retires the card.** A failed review does not move a card, and neither does a successful one; the head moves it. `plan_events` records column transitions only, so there is no "this seat says it is done" signal anywhere in the system today.
3. **The finishing seat's context is never cleared.** `/clear` is pasted onto the **receiving** terminal at dispatch time (`src/services/TaskViewerProvider.ts:21197-21223`, gated by `terminal.clearBeforePrompt`). With one card at a time and complexity routing, the next card usually lands on a *different* seat — so the seat that just finished keeps its full context and carries it into whatever it is handed next, possibly hours later.

Retire-then-pop cannot be two client calls. Between them the team is idle with a staged queue, which is exactly the window a schedule tick (`TaskViewerProvider._scheduleQueuePop`, `:12969`) or a second seat's call would use to pop a card the first seat is about to pop. The two steps must sit inside one critical section on the same `_queueNextChain` the pop already serializes on (`LocalApiServer.ts:52`).

### The precedent to copy

`POST /phone-a-friend/done` (`LocalApiServer.ts:2874`) is this exact shape and already shipped: an agent calls it when finished, the host advances a per-target sequential queue, and **duplicate callbacks with nothing in flight are silently ignored** (`:340`). Copy its contract, including the silence on duplicates — an agent that calls twice, or calls after a human already moved its card, must not produce an error the agent then tries to "fix".

### Where the finished card lands — and why not `CODE REVIEWED`

With review deliberately out of the loop, the finished card must not land in `CODE REVIEWED`. That column is `{ role: 'reviewer', kind: 'reviewed', label: 'Reviewed' }` (`src/services/agentConfig.ts:156`) and putting an unreviewed card there makes the board assert a review that never ran — the board would then be lying to every downstream consumer, including the archive's role attribution (`src/services/ArchiveManager.ts:135`).

**Decision: the card moves to `COMPLETED`.** It is the only built-in column that makes no claim about a review (`agentConfig.ts:159`, no `role`, `kind: 'completed'`). The operator's review of a straight-through run is the batch diff in git, which the plan's own Verification Plan already names. A card that needs rework is dragged back by hand.

**Guard:** `COMPLETED` is what auto-archive consumes (`getAutoArchiveConfig`). Verify that a straight-through run with auto-archive enabled does not archive cards out from under an operator who has not looked at them yet, and if it does, exclude seat-retired cards from the sweep for the configured grace window rather than changing the destination column.

## Metadata

**Complexity:** 5
**Tags:** backend, api, reliability, feature

## Implementation

1. **New callback and route.** `POST /kanban/queue/done`, body `{ workspaceRoot?, from, outcome?, planId? }`.
   - `from` — the calling seat's own terminal name. Required.
   - `outcome` — `'finished'` (default) or `'failed'`. `'failed'` is subtask 3's escalation path; this subtask must accept and forward the field without acting on it, so the two can ship in either order.
   - `planId` — optional. When absent the host resolves the card the seat is holding; when present it must match, or the call is refused rather than retiring somebody else's card.

2. **Resolve the seat's card from the board, not from the request.** Find the active card whose `dispatchedTerminal === from` and whose column is in `CODING_COLUMNS` (`LocalApiServer.ts:57`). No such card → **200 no-op** with a `reason`, matching the phone-a-friend duplicate contract. Never 4xx a duplicate.

3. **Run retire → clear → pop as one critical section.** Enqueue the whole sequence onto `_queueNextChain` and call `dispatchNextFromQueue`'s inner run body directly rather than the public method — calling the public method from inside the chain deadlocks it. Extract the existing run body into a private helper that both the public method and this handler enqueue, so there remains exactly one pop implementation and one serialization point.

4. **Retire through the sanctioned move path.** Use the injected `moveCard` callback (`LocalApiServer.ts:77`) — the same path a human's click and `POST /kanban/move` take. **No SQL.** Board integrity aside, a direct write skips the plan-event record and the board refresh. If the move fails, abort before the clear and before the pop, and return the move's failure unchanged: a seat whose card did not move must not have its context wiped.

5. **Clear the finishing seat.** Reuse the existing clipboard-paste `/clear` path with its per-terminal send lock (`TaskViewerProvider.ts:21176-21223`) via a new host callback — do **not** hand-roll a `sendText('/clear')`, which the comment at `:21198` explains gets swallowed by CLI slash-command mode. Respect `terminal.clearBeforePrompt`: when the operator has turned clearing off, honour that here too rather than special-casing this path. A clear failure is logged and does not abort the pop — a stale context is a degraded run, an unpopped queue is a dead night.

6. **Then pop.** With the card in `COMPLETED` the team is genuinely free, so the unchanged team-scoped in-flight predicate passes on its own terms. Return `{ retired: <planId>, cleared: <bool>, dispatched: <payload|null> }`. `dispatched: null` with reason `queue empty` is the normal end of a run, not an error — the seat should read it as "stop, and say so".

7. **Arm the watch on the retire, not only on the dispatch.** `armQueueWatch` currently fires after a successful dispatch (`LocalApiServer.ts:1695`). A retire that pops nothing because the queue is empty is fine; a retire that pops nothing because the *dispatch failed* leaves a staged queue and an idle team, which is precisely the silent night the watch exists to catch. Arm on the retire path too.

8. **Catalog and allowlist.** Add the route to `protocol-catalog.json` and any verb allowlist entry it needs (`src/generated/verbAllowlist.ts`). A missing catalog entry turns CI's `catalog:check` red and leaves the control dead in the browser host — this exact miss was a MAJOR finding in the preceding feature's review.

## Verification Plan

1. **Happy path, end to end.** Seat-paced team, three cards staged (complexity 3, 5, 8). Dispatch card one, then have the holding seat POST `queue/done`. Assert: card one is in `COMPLETED`; a `/clear` was sent to that seat; card two is dispatched to its complexity-routed seat; `queue_position` on the remaining card is intact.
2. **Duplicate call is a silent 200.** Call `queue/done` twice for the same seat. Second call returns 200 with a `reason` and dispatches nothing. Assert the queue did not advance twice — this is the test that catches a double-pop skipping a card.
3. **Race: `queue/done` and a schedule tick concurrently.** Fire both without awaiting the first. Assert exactly one card leaves `DISPATCH`. This is the test the critical-section design exists for; run it in a loop (≥50 iterations) since a chain bug is intermittent by nature.
4. **Move failure aborts cleanly.** Stub `moveCard` to fail. Assert: no `/clear` was sent, no pop happened, the card is still in its coding column, and the error is returned verbatim.
5. **Clear failure does not block the pop.** Stub the clear callback to throw. Assert the next card still dispatches and `cleared: false` is reported honestly.
6. **`clearBeforePrompt` off is respected.** Assert no clear is attempted and `cleared: false`.
7. **`planId` mismatch is refused**, not silently redirected.
8. **Empty queue ends the run.** Last card retired → `dispatched: null`, reason `queue empty`, watch not left armed on a queue with nothing in it.
9. **Auto-archive interaction.** With auto-archive enabled, run a three-card queue and assert the retired cards are still visible to the operator per the guard above.
10. **Head-paced teams are unaffected.** A head-paced team's head calling `queue/next` behaves exactly as it does today.

`npm run compile` clean; `catalog:check` green (step 8 is the reason it would not be); the seven PRD gates green.
