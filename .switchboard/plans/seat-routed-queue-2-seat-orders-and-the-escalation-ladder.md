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

## Implementation

1. **One order body**, installed at `team` and `team-head` scope by `wireSpawnedTeam` when the team's pacing is `seat` (subtask 3 owns the field):
   - When you finish the card you were dispatched, `POST /kanban/queue/done` with `{ from: "<your seat name>" }`. Do not wait to be asked; there is no head to report to.
   - If you cannot complete it, call the same endpoint with `outcome: "failed"` and a one-line reason. Do not attempt work above your tier and do not report success you cannot evidence.
   - `dispatched: null` with reason `queue empty` means the run is over. Say so and stop.
   - Do not call `POST /kanban/queue/next`, and do not move cards.

2. **Never both instruction sets on one team.** Head-paced teams keep the existing head order untouched and get no seat order. Flipping pacing back to `head` removes the seat orders in the same mutation — a stale order still reaching a live agent is a known failure mode here (`a-stale-standing-order-can-still-reach-a-live-agent.md`).

3. **Mirror the body everywhere the head sentence is mirrored.** The preceding feature's review caught a head-prompt sentence missing from its third mirror. Grep for every copy before calling this done; `teamWiring.ts:408` and `:449` are two.

4. **On `outcome: 'failed'`**, inside the critical section subtask 1 established:
   - `routedTo` is `intern` or `coder` → re-stage the card into `DISPATCH` at the front (`queue_position` below the current minimum, via the staging helper at `KanbanDatabase.ts:9974`, not a hand-rolled UPDATE) with a role override to `getFallbackRole(routedTo)`. Continue the normal release → clear → pop, so it is the next thing dispatched and lands in the stronger seat's coding column on that dispatch.
   - `routedTo` is `lead` → **park**: leave the card where it is, in the coding column of the seat that failed it, latch released. Move nothing, delete nothing. Notify the operator with the card, the seat and the reason, and **pop the next card anyway** — the queue keeps walking.
   - There is no parking column. A parked card is a card resting in a coding column that nobody finished, which is exactly what happened to it.
   - Re-staging moves the card backwards out of its coding column. That is legitimate for the same reason the first dispatch was: the card moves because it is being dispatched again, not because it finished (`switchboard-contracts` #1).

5. **Carry the override on the dispatch, not in config.** Do not rewrite `kanban.routingMapConfig` or the card's stored complexity to steer one card — the routing map is the operator's global setting and complexity is a property of the plan. Mutating either corrupts every future decision.

6. **A stall counts as a failure.** When subtask 3's watch escalates on a seat that never reported, take the same branch, so a dead seat steps up rather than pinning its card.

## Verification Plan

1. **Order delivery.** Wire a seat-paced team; assert intern, coder **and** the head seat all receive the body, and that a `/clear` does not remove it. Assert a head-paced team gets the old head order and no seat order.
2. **Flip pacing to `head`** — seat orders removed in the same mutation, no seat still carrying one.
3. **Mirror completeness** — a static gate asserting the seat-order body appears in every location the head `queue/next` sentence appears. This is the only thing that stops mirror drift.
4. **Step up once.** Complexity-3 card dispatched to the intern (`routedTo: 'intern'`); intern reports `failed`. Assert the card is at the front of `DISPATCH`, the next dispatch sends **that same card** to the **coder**, and `routingMapConfig` and the stored complexity are byte-for-byte unchanged.
5. **Step up twice, then park.** Coder reports `failed` on it (`routedTo: 'coder'`) → goes to the lead. Lead reports `failed` (`routedTo: 'lead'`) → parked: still in `LEAD CODED`, latch released, no `plan_events` move recorded, operator notified with seat and reason, and the **next** queued card dispatched.
6. **A complexity-8 card failed by the lead parks on its first failure** — `getFallbackRole('lead')` is `lead`, and re-dispatching to the same seat is the loop this rule prevents.
7. **A stall escalates** — drive the watch's escalation with no `queue/done` call and assert the card steps up.
8. **No confirmation dialogs** — parking notifies, it never asks.

`npm run compile` clean; `src/test/standing-orders-marker-contract.test.js` green; the seven PRD gates green.
