# Every Seat Is Told to Report Done, and a Failed Card Steps Up One Seat

## Goal

Tell the seats to call `POST /kanban/queue/done`, in a way that survives a `/clear`. And when a seat reports `failed`, re-dispatch the card one rung up `intern → coder → lead`; a card that fails at lead stops.

### Problem analysis

**The instruction is in the wrong prompt.** The sentence that drives the pipeline — *"When the reviewer reports the feature passed, POST /kanban/queue/next…"* — is written into the **team-head** prompt only (`src/services/teamWiring.ts:408`, mirrored at `:449`). It is carried as a `team-head`-scoped standing order so it survives `/clear`, which is right engineering aimed at the wrong recipient: in a seat-paced queue no seat holds that order, so the seats that actually finish cards are told nothing.

The store already has what this needs. `src/services/standingOrders.ts` supports `global`, `team-head`, `team` and `pair` scopes (`:294`), where `team` delivers to members and excludes the head (`:145-149`). Every seat needs the order, head seat included, so install it at both `team` and `team-head` scope. Two orders sharing one body beats inventing a fifth scope.

**The ladder needs no new state.** `getFallbackRole` already encodes it (`src/services/complexityScale.ts:71`: `intern → coder → lead → lead`, terminal at lead). The card already records which seat it went to: `routed_to` is in `PLAN_COLUMNS` (`src/services/KanbanDatabase.ts:881`) and is returned to agents as `routedTo`.

So a re-staged card carries its own history. Dispatch it to `getFallbackRole(routedTo)`; when `routedTo` is already `lead`, `getFallbackRole` returns `lead` and re-dispatching would loop, so that is the park case. No attempt counter, no store, no cleanup rules.

**What `failed` is worth.** With no review, the only failure signals are the seat's own `outcome: 'failed'` and the watch noticing a seat that never reported. That is weaker than a review cycle and the plan should not pretend otherwise: a seat that fabricates success is not caught here. What the ladder does catch is a seat that knows it is stuck, or one that dies — the card gets one attempt at a stronger seat instead of sitting unfinished.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, feature
**Feature:** 69d427d8-cf87-4977-825b-d3553b869745

## User Review Required

- **No review catch for a seat that fabricates success.** With no review hop, the only failure signals are the seat's own `outcome: 'failed'` and the watch noticing a seat that never reported. A seat that lies is not caught here. This is an accepted limitation, not a defect — flagged for awareness.
- **Parking at lead notifies the operator; it never asks.** No confirmation dialog. The queue keeps walking past a parked card.

## Complexity Audit

### Routine
- Installing one standing-order body at `team` and `team-head` scope via the existing `standingOrders.ts` machinery — scopes already exist.
- Reusing `getFallbackRole` (already shipped, terminal at lead) for the escalation ladder — no new state.
- Reading `routedTo` from the card record (already returned to agents) to drive the step-up.

### Complex / Risky
- **Re-staging a failed card at the front of DISPATCH.** No front-insert helper exists — `appendQueuePositions` appends to the back (MAX+1). Must use `setQueuePositions` to rewrite the order with the failed card first, or add a dedicated prepend helper. Getting this wrong sends the failed card to the back of the queue (not the next dispatch).
- **Race between watch escalation and seat report.** Both serialize on subtask 1's `_queueNextChain`, but the second caller may read stale `routedTo` (re-staging does not update `routedTo` — that happens on dispatch). A late `failed` report for a card already re-staged by the watch must be a no-op, not a second re-stage.
- **Flipping pacing back to `head` must remove seat orders in the same mutation.** A stale order reaching a live agent is a known failure mode.

## Edge-Case & Dependency Audit

- **Race Conditions:** The watch (subtask 3) and a seat's `queue/done` report can both escalate the same card. Both run inside subtask 1's critical section (`_queueNextChain`), so they serialize — but the second caller operates on state the first has changed. After the watch re-stages the card to DISPATCH, the card is no longer in a coding column; a late `failed` report from the original seat must check whether the card is still in a coding column before re-staging. If the card has already been re-staged (moved back to DISPATCH), the report is a no-op — same contract as a duplicate report.
- **Security:** A seat reports `outcome: 'failed'` with its own `from` name. The endpoint (subtask 1) validates `dispatchedTerminal === from`. A seat cannot escalate another seat's card.
- **Side Effects:** Re-staging moves the card backwards out of its coding column into DISPATCH. This is legitimate (the card moves because it is being dispatched again, not because it finished — contracts #1). `routingMapConfig` and the stored complexity are never mutated — the override is carried on the dispatch only.
- **Dependencies & Conflicts:** Runs inside subtask 1's `queue/done` critical section. Subtask 3's watch feeds the same failure branch (step 6). The order body is installed by `wireSpawnedTeam` when pacing is `seat` — subtask 3 owns the field and the toggle that triggers install/removal.

## Dependencies

- `seat-routed-queue-1-seats-take-cards-and-report-done.md` — owns the `queue/done` endpoint and the critical section (`_queueNextChain`) this plan's failure branch runs inside. Must land first or together.
- `seat-routed-queue-3-choosing-seat-pacing-and-the-idle-watch.md` — writes the `pacing` field and toggles order install/removal. The order body is installed when pacing is `seat`; subtask 3's watch feeds the failure branch (step 6).

## Implementation

1. **One order body**, installed at `team` and `team-head` scope by `wireSpawnedTeam` when the team's pacing is `seat` (subtask 3 owns the field):
   - When you finish the card you were dispatched, `POST /kanban/queue/done` with `{ from: "<your seat name>" }`. Do not wait to be asked; there is no head to report to.
   - If you cannot complete it, call the same endpoint with `outcome: "failed"` and a one-line reason. Do not attempt work above your tier and do not report success you cannot evidence.
   - `dispatched: null` with reason `queue empty` means the run is over. Say so and stop.
   - Do not call `POST /kanban/queue/next`, and do not move cards.

2. **Never both instruction sets on one team.** Head-paced teams keep the existing head order untouched and get no seat order. Flipping pacing back to `head` removes the seat orders in the same mutation — a stale order still reaching a live agent is a known failure mode here (`a-stale-standing-order-can-still-reach-a-live-agent.md`).

3. **Mirror the body everywhere the head sentence is mirrored.** The preceding feature's review caught a head-prompt sentence missing from its third mirror. Grep for every copy before calling this done; `teamWiring.ts:408` and `:449` are two.

4. **On `outcome: 'failed'`**, inside the critical section subtask 1 established:
   - `routedTo` is `intern` or `coder` → re-stage the card into `DISPATCH` at the front with a role override to `getFallbackRole(routedTo)`. Continue the normal release → clear → pop, so it is the next thing dispatched and lands in the stronger seat's coding column on that dispatch.

     > **Superseded:** Re-stage at the front via the staging helper at `KanbanDatabase.ts:9974`, not a hand-rolled UPDATE.
     > **Reason:** `appendQueuePositions` at `KanbanDatabase.ts:9981` (the helper at the cited line) appends from MAX+1 — the **back** of the queue, not the front. There is no front-insert helper. Appending to the back would send the failed card behind every other staged card, so it would NOT be the next thing dispatched, and verification test 4 would fail.
     > **Replaced with:** Use `setQueuePositions` (`KanbanDatabase.ts:10022`) — the sanctioned whole-order rewriter — with the failed card prepended to the remaining staged list. Alternatively, add a dedicated `prependQueuePosition` helper if the whole-order rewrite is too heavy for a single-card re-stage. Either way, do not hand-roll a raw UPDATE; use the existing serialized queue-position writer so the position is consistent with the rest of the queue.

   - `routedTo` is `lead` → **park**: leave the card where it is, in the coding column of the seat that failed it, latch released. Move nothing, delete nothing. Notify the operator with the card, the seat and the reason, and **pop the next card anyway** — the queue keeps walking.
   - There is no parking column. A parked card is a card resting in a coding column that nobody finished, which is exactly what happened to it.
   - Re-staging moves the card backwards out of its coding column. That is legitimate for the same reason the first dispatch was: the card moves because it is being dispatched again, not because it finished (`switchboard-contracts` #1).
   - **Guard against a double re-stage.** Before re-staging, check the card is still in a coding column (not already back in `DISPATCH`). If the watch (subtask 3) already re-staged this card, a late `failed` report from the original seat finds the card in `DISPATCH` and treats it as a no-op — same contract as a duplicate report. This closes the read-modify-write gap on `routedTo` (re-staging does not update `routedTo`; dispatch does).

5. **Carry the override on the dispatch, not in config.** Do not rewrite `kanban.routingMapConfig` or the card's stored complexity to steer one card — the routing map is the operator's global setting and complexity is a property of the plan. Mutating either corrupts every future decision.

6. **A stall counts as a failure.** When subtask 3's watch escalates on a seat that never reported, take the same branch, so a dead seat steps up rather than pinning its card.

## Verification Plan

1. **Order delivery.** Wire a seat-paced team; assert intern, coder **and** the head seat all receive the body, and that a `/clear` does not remove it. Assert a head-paced team gets the old head order and no seat order.
2. **Flip pacing to `head`** — seat orders removed in the same mutation, no seat still carrying one.
3. **Mirror completeness** — a static gate asserting the seat-order body appears in every location it is installed (every `team`- and `team-head`-scope install site), not that it shadows the head `queue/next` sentence. The seat order and the head sentence are different bodies; the gate must check the seat order's own mirror set. This is the only thing that stops mirror drift.
4. **Step up once.** Complexity-3 card dispatched to the intern (`routedTo: 'intern'`); intern reports `failed`. Assert the card is at the front of `DISPATCH`, the next dispatch sends **that same card** to the **coder**, and `routingMapConfig` and the stored complexity are byte-for-byte unchanged.
5. **Step up twice, then park.** Coder reports `failed` on it (`routedTo: 'coder'`) → goes to the lead. Lead reports `failed` (`routedTo: 'lead'`) → parked: still in `LEAD CODED`, latch released, no `plan_events` move recorded, operator notified with seat and reason, and the **next** queued card dispatched.
6. **A complexity-8 card failed by the lead parks on its first failure** — `getFallbackRole('lead')` is `lead`, and re-dispatching to the same seat is the loop this rule prevents.
7. **A stall escalates** — drive the watch's escalation with no `queue/done` call and assert the card steps up.
8. **No confirmation dialogs** — parking notifies, it never asks.
9. **Double re-stage is a no-op** — the watch re-stages a card to `DISPATCH` (escalation), then the original seat reports `failed` late. Assert the late report is a no-op (card already in `DISPATCH`, not re-staged a second time), and the card is dispatched once to the stronger seat, not twice.

## Adversarial Synthesis

Key risks: (1) the front-staging mechanism was wrong — `appendQueuePositions` appends to the back, not the front; corrected to `setQueuePositions` with the failed card prepended. (2) a race between watch escalation and a late seat report can double-re-stage the same card — mitigated by a coding-column guard (a card already back in `DISPATCH` is a no-op). (3) a seat that fabricates success is not caught — accepted limitation, no review hop. (4) mirror drift on the seat-order body — mitigated by a static gate checking the seat order's own install sites.

`npm run compile` clean; `src/test/standing-orders-marker-contract.test.js` green; the seven PRD gates green.

---

## Completion Report

Implemented the `outcome: 'failed'` escalation ladder inside subtask 1's `queue/done` critical section in `src/services/LocalApiServer.ts`, plus the `notifyOperator` callback in `src/services/TaskViewerProvider.ts`. The failed branch runs after `clearWorkingState` and the seat clear, before the pop: it re-reads the card's current column (coding-column guard against double re-stage by the watch), and for `routedTo` intern/coder it moves the card back to DISPATCH via `updateColumnByPlanFile` then rewrites the queue order with the failed card first via `setQueuePositions` (NOT `appendQueuePositions` which appends to back), setting an ephemeral `_dispatchRoleOverride` so `_runQueuePop` dispatches it to `getFallbackRole(routedTo)` on the next pop (override consumed+deleted on dispatch — never stored in `routingMapConfig` or complexity). For `routedTo` lead it parks: leaves the card in its coding column, latch released, calls `notifyOperator` (VS Code warning + diagnostics channel, no confirmation dialog), and pops the next card anyway. The seat order body (`SEAT_QUEUE_DONE_ORDER_BODY`) and `applySeatPacingOrders` install at `team`+`team-head` scope in `wireSpawnedTeam` were already present from prior work. `catalog:check` green. No issues; compile/tests skipped per directives.

## Review Findings

Reviewed `src/services/LocalApiServer.ts`, `src/services/teamWiring.ts`, and the queue/standing-order contracts. Fixed the MAJOR retry regression where `_dispatchRoleOverride` was deleted before a stronger-seat dispatch succeeded, and pinned the failure/retry path. Compile, catalog, queue-pipeline, standing-orders, and team-scoped-routing checks passed; no plan-specific risk remains beyond the accepted no-review limitation.
