# Every Seat Is Told to Advance the Queue, and a Twice-Failed Card Is Parked

## Goal

Two halves of one problem: the seats in a headless queue must be *told* to call `POST /kanban/queue/done`, in a way that survives a `/clear`; and a card that fails must escalate one rung up the `intern → coder → lead` ladder, then park and notify — without a lead session to remember the attempt count.

### Problem analysis — root cause

**Half one: the instruction is in the wrong prompt.** The sentence that drives the whole pipeline — *"When the reviewer reports the feature passed, POST /kanban/queue/next…"* — is written into the **team-head** prompt only (`src/services/teamWiring.ts:408` and its mirror at `:449`). It is carried as a `team-head`-scoped standing order specifically so it survives `/clear`, which is correct engineering aimed at the wrong recipient: in a seat-paced queue no seat holds the `team-head` scope's instruction, and the seats that actually finish cards are told nothing about advancing the queue.

The standing-orders store already has the scope this needs. `src/services/standingOrders.ts` supports `global`, `team-head`, `team` and `pair` (`:294`), where `team` delivers to team members and deliberately **excludes the head** (`:145-149`). A seat-paced queue needs *every* seat instructed, head seat included — so the order must be installed at both `team` and `team-head` scope rather than inventing a fifth scope. Two orders with one body is a smaller change than a new scope with new delivery rules, and the scope-rank ordering at `:294` already renders both before `pair`.

**Half two: the escalation ladder has nowhere to count.** `getFallbackRole` already encodes the ladder (`src/services/complexityScale.ts:71`: `intern → coder → lead → lead`, terminal at lead). What is missing is the counter. The existing plan `a-failed-subtask-escalates-to-a-stronger-seat.md` makes an explicit architecture decision to keep the failure count **in the lead's own session**, as prompt text — a sound choice when a lead is driving, and unavailable here by construction. A seat-paced queue has no lead session and no continuous context anywhere: the whole point is that every seat is cleared between cards.

So the count must live host-side. It also must not need a `plans` table migration: the `plans` table shipped, `queue_position` was just added as V60 (`src/services/KanbanDatabase.ts:496-509`), and a V61 column for a counter that is only meaningful during a single queue run is a permanent schema cost for transient state.

**Decision: the attempt record is a config JSON map, not a table column.** Store `queue.attempts` as `{ [planId]: { attempts, lastRole, lastSeat, lastFailedAt } }` via `getConfigJson`/`setConfigJson`, serialized through a module-level write chain in the style of `mutateStandingOrders` and `mutateTerminalGroups` (`teamWiring.ts:162`). It persists across host restarts, needs no migration, and an entry is deleted when its card leaves the queue. Unknown keys in the blob are preserved on write, per the project's migration rule.

### What "failed" means here, given there is no review

Review is deliberately out of this pipeline, so the only failure signal is the seat's own `outcome: 'failed'` on `queue/done` — plus the queue watch's stall detection for a seat that never reports at all. That is a weaker signal than a review cycle, and the plan must not pretend otherwise: a seat that fabricates success is not caught by this mechanism. The ladder's value here is narrower and still real — a seat that *knows* it is stuck, or that dies mid-card, gets the work re-attempted one tier up instead of the card silently sitting in a coding column forever.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, feature, docs

## Implementation

### The seat order

1. **Author one order body**, installed at both `team` and `team-head` scope by `wireSpawnedTeam` when the team's pacing is `seat` (subtask 4 owns the pacing field). Content, in the imperative register the existing orders use:
   - When you finish the card you were dispatched, `POST /kanban/queue/done` with `{ from: "<your seat name>" }`. Do not wait to be asked, and do not report to a head — in this team there is none.
   - If you cannot complete it, call the same endpoint with `outcome: "failed"` and a one-line reason. Do not attempt work above your tier and do not report success you cannot evidence.
   - A response of `dispatched: null` with reason `queue empty` means the run is over. Say so and stop.
   - Do not call `POST /kanban/queue/next` yourself, and do not move cards.
2. **Do not write the order for head-paced teams.** A head-paced team keeps the existing head order untouched; the two instruction sets must never both be live on one team, or the head and its seats will both pop.
3. **Remove the order when pacing flips back to `head`**, in the same mutation that writes the field. A stale order that still reaches a live agent is a known failure mode in this codebase (`a-stale-standing-order-can-still-reach-a-live-agent.md`) and this is a new way to create one.
4. **Mirror the body wherever the head prompt is mirrored.** The preceding feature's review found a head-prompt sentence missing from its third mirror. Grep for every copy of the `queue/next` sentence before declaring this done — `teamWiring.ts:408` and `:449` are two of them, and the skill surfaces under `.agents/skills/` and `.claude/skills/` may carry more.

### The ladder

5. **On `outcome: 'failed'`** (inside the same critical section subtask 2 established, so the count and the requeue cannot interleave):
   - Read the card's attempt entry. Increment `attempts`; record the seat and the role that just failed.
   - `attempts === 1` → re-stage the card at the **front** of the queue (`queue_position` below the current minimum, via the existing staging helper at `KanbanDatabase.ts:9974` rather than a hand-rolled UPDATE) with a routing override to `getFallbackRole(lastRole)`. Then continue the normal retire→clear→pop sequence, so the requeued card is the very next thing dispatched.
   - `attempts >= 2`, **or** `lastRole === 'lead'` (the ladder's terminal rung) → **park**: leave the card out of `DISPATCH`, delete nothing, notify the operator with the card, both failing seats and both reasons, and **pop the next card anyway**. The queue keeps walking; that is the chosen failure policy.
6. **Carry the override to the dispatch, not to the routing map.** The requeued card's role override belongs in the attempt entry and is read by the pop when it dispatches that card. Do **not** rewrite `kanban.routingMapConfig` or the card's stored complexity — the routing map is the operator's global setting and the complexity is a property of the plan. Mutating either to steer one card corrupts every future decision.
7. **A stall counts as a failure.** When subtask 4's queue watch escalates on a seat that never reported, record it as an attempt for that card and take the same branch, so a dead seat escalates rather than pinning the queue.
8. **Clean up.** Delete a card's attempt entry when it retires to `COMPLETED`, when it is parked, or when it leaves `DISPATCH` by any other route. Sweep entries for plan IDs that no longer exist on host start, so the blob cannot grow without bound.

## Verification Plan

1. **Order delivery.** Wire a seat-paced team; assert every seat — intern, coder **and** the head seat — receives the order body, and that a `/clear` does not remove it. Assert a head-paced team receives the old head order and *not* the seat order.
2. **Flip pacing to `head`.** Assert the seat orders are removed in the same mutation and no seat still carries one.
3. **Mirror completeness.** A gate assertion that the seat-order body appears in every location the head `queue/next` sentence appears in. This is a static check and it is the only thing that stops mirror drift.
4. **Escalate once.** Complexity-3 card dispatched to the intern; intern reports `failed`. Assert: attempts is 1, the card is at the front of `DISPATCH`, the next dispatch sends **that same card** to the **coder**, and the routing map and stored complexity are byte-for-byte unchanged.
5. **Park on second failure.** Coder reports `failed` on the same card. Assert: the card is parked (not in `DISPATCH`, not deleted), the operator notification names both seats and both reasons, and the **next** card in the queue is dispatched.
6. **Terminal rung.** A complexity-8 card failed by the lead parks on the *first* failure — `getFallbackRole('lead')` returns `lead`, and re-dispatching to the same seat is the loop this rule exists to prevent.
7. **Stall counts as a failure.** Drive the watch's escalation with no `queue/done` call; assert an attempt is recorded and the card escalates.
8. **Concurrency.** Fire `failed` and a schedule tick together, ≥50 iterations; assert `attempts` never double-increments and the card is never staged twice.
9. **Blob hygiene.** Unknown keys in `queue.attempts` survive a write; entries are removed on retire, park and manual drag-out; orphans are swept on start.
10. **No confirmation dialogs anywhere in this work** — parking notifies, it does not ask.

`npm run compile` clean; the standing-orders contract gate (`src/test/standing-orders-marker-contract.test.js`) green; the seven PRD gates green.
