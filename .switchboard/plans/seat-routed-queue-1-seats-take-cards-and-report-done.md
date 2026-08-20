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
**Feature:** 69d427d8-cf87-4977-825b-d3553b869745

## User Review Required

- **The `pacing` field is read here but written by subtask 3.** This plan ships inert until a team is toggled to seat pacing — the correct intermediate state. No user decision needed to proceed; flagged for awareness.
- **The in-flight scan is skipped for seat pacing, not removed.** Head pacing keeps it byte-for-byte. This is the load-bearing design call; review it before coding.

## Complexity Audit

### Routine
- Adding a `pacing` arg to an existing method signature and resolving it absent → `'head'`.
- Branching on the new field instead of the existing `isExternalHead` boolean — same dispatch opts, different gate.
- Reusing `clearWorkingState` (already shipped) and `phone-a-friend/done`'s 200-no-op contract (already shipped).
- Catalog/verb-allowlist registration — mechanical.

### Complex / Risky
- **Extracting the pop's run body into a private helper** shared by the public method and the `queue/done` handler, both enqueued on `_queueNextChain`. Calling the public method from inside the chain deadlocks it; getting this wrong stalls the entire pipeline.
- **The `/clear` of the finishing seat** when the next card routes to the *same* seat — two clears (done-clear + dispatch-clear) hit one terminal's send lock. Ordering must be done-clear → dispatch-clear → prompt, all inside the chain.
- **`outcome: 'failed'` accepted before subtask 2 lands** — the degraded path must not drop the card silently.

## Edge-Case & Dependency Audit

- **Race Conditions:** The seat-paced path has one trigger (the finishing seat) driving a serial sequence on `_queueNextChain`. No race to arbitrate — this is why the in-flight scan is skipped. Duplicate reports are answered by `clearWorkingState`'s `IS NOT NULL` gate (returns `transitioned: false` → no-op). The mtime watcher clearing first is also a silent 200 (same gate).
- **Security:** `queue/done` accepts `from` (seat name) and `planId`. `planId`, when given, must match the card the seat holds (`dispatchedTerminal === from` + `dispatched_at` set). A seat cannot release another seat's card.
- **Side Effects:** `clearWorkingState` NULLs `dispatched_at`, `last_liveness_at`, `blocked_at` — a clean widened reset. No card move. The watch is armed on release too (step 7), so a failed dispatch that pops nothing still leaves a guarded idle team.
- **Dependencies & Conflicts:** Reads `pacing` from the team definition (subtask 3 writes it). Accepts `outcome: 'failed'` and forwards it — subtask 2 owns the failure branch. The two can land in either order; the degraded behaviour when subtask 2 is absent is specified in step 4 below.

## Dependencies

- `seat-routed-queue-3-choosing-seat-pacing-and-the-idle-watch.md` — writes the `pacing` field this plan reads. Order-independent: absent reads as `'head'`, so this plan is inert until subtask 3 toggles a team.
- `seat-routed-queue-2-seat-orders-and-the-escalation-ladder.md` — owns the `outcome: 'failed'` branch inside the critical section this plan establishes. Can land before or after; degraded behaviour specified.

## Implementation

1. **Add `pacing?: 'head' | 'seat'` to `dispatchNextFromQueue`'s args.** Resolve it as: the explicit argument → the requesting team's stored field (subtask 3 owns writing it; absent reads as `'head'`) → `'head'`.

2. **Branch on pacing, not on requester type.** `pacing === 'seat'` **or** an external head → `{ originTerminal: from, restrictToOriginTeam: true }`. Otherwise the head branch, unchanged. An external head still forces the seat branch regardless of pacing: it has no terminal, so `targetTerminalOverride: from` would name a terminal that does not exist. Keep the roster-is-decisive logic at `:1637-1665` verbatim.

3. **Skip the in-flight scan in seat pacing.** Leave it exactly as it is for head pacing.

4. **`POST /kanban/queue/done`**, body `{ workspaceRoot?, from, outcome?, planId? }`:
   - Find the active card whose `dispatchedTerminal === from` with `dispatched_at` set. None → **200 no-op** with a `reason`. Never 4xx a duplicate; copy `POST /phone-a-friend/done`'s contract (`:2874`), which is this exact shape and already shipped.
   - Clear the latch via the existing `clearWorkingState(planFile, workspaceId)` (`KanbanDatabase.ts:9935`) — the same off-switch the plan-file watcher uses. Do not write `dispatched_at` directly and do not add a second clearing function. It returns true only on a real transition, which is the duplicate answer for free.
   - **Do not move the card.** It is already in its coding column, it got coded, it stays there. `CODE REVIEWED` would assert a review that never ran and `COMPLETED` an acceptance nobody gave — both make the board lie to downstream consumers including the archive's role attribution (`ArchiveManager.ts:135`).
   - Clear the reporting seat's context, then pop the next card.
   - `outcome` is `'finished'` (default) or `'failed'`; accept and forward it. **Degraded behaviour when subtask 2 has not landed:** `outcome: 'failed'` releases the latch and pops the next card — the failed card rests in its coding column (not re-staged, not moved). This is safe (the card stays coded) but the card is not retried until subtask 2's branch exists. When subtask 2 lands, the `failed` branch inside this same critical section re-stages before the pop.
   - `planId`, when given, must match the card the seat holds.
   - **The `reason` field must disambiguate `duplicate` from `queue empty`.** A seat that retries a `queue/done` call (network retry) gets `200` with `reason: "duplicate"` — it must not read this as "the run is over." Only `dispatched: null` with `reason: "queue empty"` means stop.

5. **Clear the finishing seat.** `/clear` is pasted onto the *receiving* terminal at dispatch (`TaskViewerProvider.ts:21197-21223`), and the next card usually routes to a different seat, so the finisher would otherwise keep its context indefinitely. Reuse that clipboard-paste path and its per-terminal send lock (`:21176`) via a host callback — a hand-rolled `sendText('/clear')` gets swallowed by CLI slash-command mode (`:21198`). Respect `terminal.clearBeforePrompt`. A clear failure is logged and does not abort the pop. **Clear ordering when the next card routes to the same seat:** the done-clear runs first (inside the chain, before the pop), then the dispatch-clear runs (inside the pop's dispatch path), then the prompt. Both clears hit the same terminal's send lock serially — done-clear acquires, releases, dispatch-clear acquires, releases, prompt pastes. This is correct by construction because the chain serializes release → clear → pop, but it must be documented so a future editor does not reorder.

6. **Serialize release → clear → pop as one operation** on the existing `_queueNextChain` (`:52`). Extract the pop's run body into a private helper both the public method and this handler enqueue — calling the public method from inside the chain deadlocks it, and there must remain one pop implementation.

7. **Arm the watch on the release too**, not only after a dispatch (`:1695`). A release that pops nothing because the dispatch *failed* leaves a staged queue and an idle team.

8. **Update the pop's doc comment** (`:1500-1527`), which currently asserts that complexity routing picks only the column. Add the route to `protocol-catalog.json` and the verb allowlist — a missing catalog entry turns `catalog:check` red and leaves the control dead in the browser host.

## Adversarial Synthesis

Key risks: (1) the pop-helper extraction can deadlock the chain if the public method is called from inside it — mitigated by extracting a private helper both callers enqueue. (2) `outcome: 'failed'` before subtask 2 lands silently drops the card from the retry path — mitigated by documenting the degraded behaviour (card rests coded, not re-staged) and specifying that subtask 2's branch re-stages before the pop. (3) a `200 no-op` (duplicate) misread as `queue empty` by an autonomous seat — mitigated by disambiguating the `reason` field. (4) clear-ordering when the next card routes to the same finisher — mitigated by chain serialization (done-clear → dispatch-clear → prompt) and documenting the invariant.

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
12. **`reason` disambiguation** — a duplicate `queue/done` returns `200` with `reason: "duplicate"` and `dispatched` reflecting the prior pop (not `null`); an empty-queue pop returns `dispatched: null` with `reason: "queue empty"`. A seat must be able to tell them apart from the body alone.
13. **Degraded `failed` before subtask 2** — report `outcome: 'failed'` with subtask 2 absent; the latch releases, the next card pops, and the failed card rests in its coding column (not re-staged, not moved). No card is dropped from the board.

`npm run compile` clean; `catalog:check` green; the seven PRD gates green, `kanban-dispatch-callers` especially.

---

## Completion Report

Implemented seat-paced queue dispatch and the `queue/done` completion signal in `src/services/LocalApiServer.ts`, `src/services/teamWiring.ts`, and `src/services/TaskViewerProvider.ts`. Extracted the pop's run body into `_runQueuePop` (shared by `dispatchNextFromQueue` and the new `_runQueueDone` handler, both serialized on `_queueNextChain` — no deadlock). Added `pacing?: 'head' | 'seat'` to `dispatchNextFromQueue`, branching on pacing (or external head) to route cards to the complexity-selected seat via `restrictToOriginTeam`, and skipping the in-flight scan for seat pacing (head pacing byte-for-byte unchanged). Added `POST /kanban/queue/done` (`_handleKanbanQueueDone` + `_runQueueDone`): finds the active card held by `from`, clears the latch via `clearWorkingState` (200 no-op on duplicate/watcher-first via `IS NOT NULL` gate), clears the finishing seat via the new `clearTerminalContext` callback (clipboard-paste `/clear`, respects `terminal.clearBeforePrompt`), pops the next card, arms the watch on release-failure, and disambiguates `reason: "duplicate"` (prior `dispatched` non-null) from `reason: "queue empty"` (`dispatched: null`) via a per-seat `_lastSeatPop` cache. `outcome: 'failed'` accepted and forwarded (degraded: releases + pops, card rests coded). Wired `resolveTeamPacing` (via new `resolveTeamPacingForHead` in teamWiring.ts) and `clearTerminalContext` callbacks in TaskViewerProvider's LocalApiServer options. Regenerated `protocol-catalog.json` (apiEndpointCount 80→81) and `src/generated/verbAllowlist.ts`; `catalog:check` green. No issues encountered; compilation and tests skipped per directives.

## Review Findings

Reviewed `src/services/LocalApiServer.ts` and extended `src/test/queue-pipeline-contract.test.js`; duplicate-pop cache entries are now workspace-scoped and escalation overrides survive failed dispatch attempts. `compile-tests`, `compile`, `catalog:check`, `kanban-dispatch-callers:check`, and the wired queue contract passed, including new resting-card and failed-retry regressions. No remaining plan-specific risk was found; unrelated push-routing and Claude-mirror repository gates remain red from concurrent changes outside this plan.
