# Seats Take Cards by Complexity, and Say When They Are Done

## Goal

A queue of standalone plans dispatches straight to the intern, coder or lead by complexity, and the seat that finishes tells the board — which clears that seat's context and sends the next card. No head, no clock, no review hop, no orchestrator.

### Problem analysis

Two small changes in `src/services/LocalApiServer.ts`. Nearly everything this needs is already built.

**1. The pop hands every card to the head.** `dispatchNextFromQueue` (`:1528`) ends in a branch on one boolean:

```ts
const dispatchOpts = isExternalHead
    ? { originTerminal: from, restrictToOriginTeam: true }
    : { originTerminal: from, targetTerminalOverride: from };
```

The first branch is exactly the wanted behaviour and already works: complexity picks the column (`resolveAutoDispatchColumn`, `:1387`), the column yields a role (`gate.role`, `:1403`), and `resolveTeamRoleTerminal` finds that role's seat **on this team** (`:1434`), refusing rather than leaking to another team. The second branch short-circuits all of that and gives the head every card to delegate by hand.

So seat routing is built. It is reachable only when the requester is a non-terminal agent, because "the requester isn't a terminal" was used as a proxy for "route to the seat" back when those were the same case. They are not the same thing, and that proxy is the whole blocker.

**2. Nothing tells the board a seat is done.** The instruction to call the pop lives in the **head** prompt (`src/services/teamWiring.ts:408`, mirrored at `:449`): the head calls it when its reviewer reports a pass. Remove the head and nothing ever calls it.

### The in-flight check does not apply here, and must be skipped

The pop refuses a team that is already busy, deciding busy from board position — any active card of this team in a coding column (`:1573-1590`). That guard exists because the head-paced pop has **three** callers that can race: the lead, the `Run queue` button, and the schedule timer (`TaskViewerProvider._scheduleQueuePop`, `:12969`).

This model has one trigger — the seat that just finished — driving a strictly serial sequence. There is nothing to arbitrate, so **the seat-paced path does not evaluate the check at all.** Not a second predicate, not a composite condition: a guard that has no race to guard.

It also cannot be reused as-is, which is why leaving it in place is not the safe option. Cards move on coding *start* and never on finish (`switchboard-contracts` #1) — `performKanbanDispatch` persists the move before dispatching (`:1450-1453`), so the card is in its coding column from the moment the seat gets it, and with no review hop it stays there. Coded is where a coded card belongs. Board position therefore never releases: card one would pin the team as busy forever and every later pop would 409.

**Assumption, not this plan's work: the scheduler does not fire into an active run.** The scheduler is a general task runner — its jobs are independent tasks ("advance one card", "do some research", "start orchestrating"), and "advance a card every 30 minutes" is a legitimate one. It has no overlap with a paced run beyond optionally kicking one off, because a job that dispatches must not fire while a run is live. That is a precondition on the job, owned by the scheduler.

Where that precondition is missing, it is a defect in the scheduler and must be fixed there, not defended against here. Do **not** add a seat-pacing special case to `_scheduleQueuePop` — a local guard would encode the arbitration framing this plan is removing, and would still leave every other dispatching job able to fire into a live run.

Duplicate reports are the only other way to double-dispatch, and `dispatched_at` (V51, `KanbanDatabase.ts:412`) already answers it: set at dispatch, cleared on completion. A report from a seat holding no card is a no-op.

## Metadata

**Complexity:** 4
**Tags:** backend, api, feature

## Implementation

1. **Add `pacing?: 'head' | 'seat'` to `dispatchNextFromQueue`'s args.** Resolve it as: the explicit argument → the requesting team's stored field (subtask 3 owns writing it; absent reads as `'head'`) → `'head'`.

2. **Branch on pacing, not on requester type.** `pacing === 'seat'` **or** an external head → `{ originTerminal: from, restrictToOriginTeam: true }`. Otherwise the head branch, unchanged. An external head still forces the seat branch regardless of pacing: it has no terminal, so `targetTerminalOverride: from` would name a terminal that does not exist. Keep the roster-is-decisive logic at `:1637-1665` verbatim.

3. **Skip the in-flight scan in seat pacing.** Leave it exactly as it is for head pacing.

4. **`POST /kanban/queue/done`**, body `{ workspaceRoot?, from, outcome?, planId? }`:
   - Find the active card whose `dispatchedTerminal === from` with `dispatched_at` set. None → **200 no-op** with a `reason`. Never 4xx a duplicate; copy `POST /phone-a-friend/done`'s contract (`:2874`), which is this exact shape and already shipped.
   - Clear the latch via the existing `clearWorkingState(planFile, workspaceId)` (`KanbanDatabase.ts:9935`) — the same off-switch the plan-file watcher uses. Do not write `dispatched_at` directly and do not add a second clearing function. It returns true only on a real transition, which is the duplicate answer for free.
   - **Do not move the card.** It is already in its coding column, it got coded, it stays there. `CODE REVIEWED` would assert a review that never ran and `COMPLETED` an acceptance nobody gave — both make the board lie to downstream consumers including the archive's role attribution (`ArchiveManager.ts:135`).
   - Clear the reporting seat's context, then pop the next card.
   - `outcome` is `'finished'` (default) or `'failed'`; accept and forward it without acting on it — subtask 2 owns the failure path, so the two can land in either order.
   - `planId`, when given, must match the card the seat holds.

5. **Clear the finishing seat.** `/clear` is pasted onto the *receiving* terminal at dispatch (`TaskViewerProvider.ts:21197-21223`), and the next card usually routes to a different seat, so the finisher would otherwise keep its context indefinitely. Reuse that clipboard-paste path and its per-terminal send lock (`:21176`) via a host callback — a hand-rolled `sendText('/clear')` gets swallowed by CLI slash-command mode (`:21198`). Respect `terminal.clearBeforePrompt`. A clear failure is logged and does not abort the pop.

6. **Serialize release → clear → pop as one operation** on the existing `_queueNextChain` (`:52`). Extract the pop's run body into a private helper both the public method and this handler enqueue — calling the public method from inside the chain deadlocks it, and there must remain one pop implementation.

7. **Arm the watch on the release too**, not only after a dispatch (`:1695`). A release that pops nothing because the dispatch *failed* leaves a staged queue and an idle team.

8. **Update the pop's doc comment** (`:1500-1527`), which currently asserts that complexity routing picks only the column. Add the route to `protocol-catalog.json` and the verb allowlist — a missing catalog entry turns `catalog:check` red and leaves the control dead in the browser host.

## Verification Plan

Extend `src/test/queue-pipeline-contract.test.js` rather than adding a parallel harness.

1. **Three cards, three seats.** Seat-paced team, cards of complexity 3, 5 and 8 staged. Card one dispatches to the intern; the intern POSTs `queue/done`; card two goes to the coder; and so on. Assert each landed on the right seat and each `teamRouting` reads `team-scoped: <from> → <seat>`.
2. **Nothing moves after coding.** At exhaustion the board is one card in each of `INTERN CODED`, `CODER CODED`, `LEAD CODED`, all with `dispatched_at` cleared, nothing in `CODE REVIEWED` or `COMPLETED`, and no `plan_events` row recording a post-coding move.
3. **A resting card does not block the queue.** With one card already coded and resting in `INTERN CODED`, assert the next pop succeeds. This is the single most important test here — it is what the deleted in-flight scan would have broken.
4. **Duplicate report is a silent 200.** Call `queue/done` twice; the second dispatches nothing and the queue advanced exactly once.
5. **The mtime off-switch getting there first is also a silent 200** — trip the watcher's clear, then report; no error, no second pop.
6. **A report from a seat holding no card is a no-op.**
7. **Clear failure does not block the pop** — `cleared: false` reported honestly, next card still dispatched. And `clearBeforePrompt` off is respected.
8. **Release failure aborts cleanly** — no clear sent, no pop, `dispatched_at` still set, error returned verbatim.
9. **Head pacing is byte-for-byte unchanged** — every card to `from`, no `teamRouting`, the in-flight scan still refusing on board position (including for a card whose `dispatched_at` is cleared, where a cleared latch does **not** mean the team is free). This is the regression gate for ~4,000 installs, and an absent `pacing` field must behave identically to `'head'`.
10. **Empty queue ends the run** — `dispatched: null`, reason `queue empty`, watch not left armed.
11. **No seat for the routed role → 409, card stays staged** with its `queue_position` intact.

`npm run compile` clean; `catalog:check` green; the seven PRD gates green, `kanban-dispatch-callers` especially.
