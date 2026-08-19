# The Queue Pop Routes to the Seat, Not to the Head

## Goal

Make `dispatchNextFromQueue` able to hand a popped card **directly to the complexity-routed seat** on a terminal-seated team, with no head agent in the middle. Today that behaviour exists but is reachable only by an external (non-terminal) head; a normal lead/coder/intern team always routes every card to the head.

### Problem analysis — root cause

`LocalApiServer.dispatchNextFromQueue` (`src/services/LocalApiServer.ts:1528`) ends in a two-way branch on one boolean, `isExternalHead`:

```ts
const dispatchOpts = isExternalHead
    ? { originTerminal: from, restrictToOriginTeam: true }
    : { originTerminal: from, targetTerminalOverride: from };
```

Both halves already work, and they mean opposite things:

- **`targetTerminalOverride: from`** short-circuits the team-scoped resolver at `LocalApiServer.ts:1427`. Complexity routing still picks the *column* — so the card can read `INTERN CODED` — but the **head receives every card** and is expected to delegate by hand. The method's own doc comment states this outright (`LocalApiServer.ts:1521-1526`).
- **`restrictToOriginTeam: true`** leaves `teamOverride` unset, so the dispatch runs the full routing chain: `resolveAutoDispatchColumn(workspaceRoot, record.complexity)` picks the column from the card's complexity (`LocalApiServer.ts:1387`), `resolveKanbanDispatch(column)` yields `gate.role` (`:1403`), and `resolveTeamRoleTerminal(origin, gate.role)` resolves **that role's seat on the origin's own team** (`:1434`). A miss is a 409 refusal rather than a fall-through to workspace-wide routing (`:1441`).

So "assign the plan to the correct agent by complexity" is **already implemented end to end**. The only thing standing between it and a terminal-seated lead/coder/intern team is that `isExternalHead` is computed from *what kind of agent asked* rather than *how this team is configured to pace itself*.

The root cause is that the two ideas were conflated when the external-headed team mode landed: "the requester is not a terminal" was used as a proxy for "route to the seat", because at the time those were the same case. They are not the same thing, and the proxy is what blocks the simpler automation.

### The second root cause — the in-flight predicate cannot release

Routing the card is only half of it. The pop refuses a team that is already busy, and it decides busy from **board position**: any active card of this team sitting in a `CODING_COLUMNS` column (`LocalApiServer.ts:1573-1590`).

That works in the head-paced model because a card *leaves* the coding column when the head hands the feature to review. The move out is the release event. **In this model there is no move out.** Cards move on coding *start* and never on finish (`switchboard-contracts` #1) — `performKanbanDispatch` persists the move before it dispatches (`LocalApiServer.ts:1450-1453`), so the card is already in `INTERN CODED`/`CODER CODED`/`LEAD CODED` from the moment it is sent, and with no review hop it stays there. Coded is where a coded card belongs.

So under board position, the first card pins the team as in-flight permanently and every subsequent pop returns 409 forever. The card position is right; the predicate is wrong.

**The predicate this model needs already exists and needs no new state.** `plans.dispatched_at` (V51, shipped — `KanbanDatabase.ts:412`) is the working-state latch: set at dispatch, cleared by `clearWorkingState` (`KanbanDatabase.ts:9935`) and by `clearStaleWorkingState` on timeout, and read by `isWorkingState()` as PRD contract #3. Set means this seat is working; cleared means it is not.

The pop's doc comment explicitly rejected this predicate, and its reason is worth quoting because a later coder will read it and try to revert:

> Keying the predicate on `dispatched_at` instead would refuse the head's own legitimate call (the just-reviewed card sits in `CODE REVIEWED` with `dispatched_at` set and `dispatched_terminal` naming the reviewer) and deadlock the pipeline after card one.

That objection is **entirely about the review hop**: the review dispatch re-set `dispatched_at` on a card that now named the reviewer. A seat-paced queue has no review dispatch, so `dispatched_at` on a card in a coding column names the coder and nothing else. The objection does not apply here, and the two predicates trade places: board position is correct for head pacing and never releases here; `dispatched_at` is correct here and mis-refuses there.

**Decision: the predicate is chosen by pacing.** Head pacing keeps board position, byte for byte. Seat pacing reads `dispatched_at`. Neither is a fallback for the other and neither is "the fixed one" — they are two models with two different release events.

### What this plan does NOT change

- **The queue source stays `DISPATCH` only.** No `PLAN REVIEWED` fallback — that was deliberately removed and re-adding it drains the whole lane unattended (`LocalApiServer.ts:1596-1607`).
- **The serialization chain stays the single critical section** (`_queueNextChain`, `LocalApiServer.ts:52`).
- **`resolveRoutedRole` is not touched.** `KanbanProvider.resolveRoutedRole` (`src/services/KanbanProvider.ts:1508`) remains the single source of truth for score → role, including the custom routing map and the pair-programming bypass.
- **Cards are not moved after coding.** No retire step, no new column, no completion move. A coded card rests in its coding column; that is the model, not an omission.
- **One card at a time stays team-wide.** No seat-scoped concurrency.

### What paces the queue until subtask 2 lands

With `dispatched_at` as the predicate, this subtask is independently useful on its own: the latch already has an off-switch — the plan-file mtime advance clears working state via the watcher (`PlanIngestionEngine.ts:1806`, `switchboard-contracts` #2). So a seat that finishes and writes its completion summary releases the latch, and the next pop succeeds.

That signal is imprecise — a mid-work plan edit trips it early, which is exactly why the completion-driven dispatch arm was deleted — so it is **not** the intended pacing mechanism. Subtask 2 replaces it with the seat's explicit report and adds the context clear. Stating it here matters for sequencing: this subtask does not deadlock while waiting for subtask 2, and the staleness timeout (`clearStaleWorkingState`) is a second existing backstop.

## Metadata

**Complexity:** 4
**Tags:** backend, api, feature

## Implementation

1. **Add a pacing input to the pop.** Extend `dispatchNextFromQueue`'s args with `pacing?: 'head' | 'seat'`. Resolve it in this precedence order:
   1. the explicit argument, when the caller passed one;
   2. the requesting team's stored pacing (subtask 4 owns writing it — read it through the same `terminals.groups` accessor the roster resolver uses, and treat an absent field as `'head'`);
   3. `'head'` — the shipped behaviour.

2. **Replace the branch condition, keep both branches.** The dispatch options become:
   - `pacing === 'seat'`, **or** the requester is an external head → `{ originTerminal: from, restrictToOriginTeam: true }`
   - otherwise → `{ originTerminal: from, targetTerminalOverride: from }`

   An external head is still forced onto the seat-routed branch regardless of pacing: it has no terminal, so `targetTerminalOverride: from` would dispatch to a name that does not exist. Preserve the existing roster-is-decisive logic verbatim (`LocalApiServer.ts:1637-1665`) — do not "simplify" the live-terminal fallback, which exists only for hosts with no roster resolver.

3. **Choose the in-flight predicate by pacing.** In head pacing, leave the `CODING_COLUMNS` scan exactly as it is. In seat pacing, refuse when any active card of this team has `dispatched_at` set — i.e. a seat is still working — and pass through the same 409 shape, naming the card, the holding seat and the fact that the seat has not reported. Resolve team membership from `dispatchedTerminal` through `resolveTeamMembers`, unchanged in both branches: only the *busy test* differs, not who counts as the team. Do not fold the two predicates into one composite condition — a card in a coding column with `dispatched_at` cleared is idle in seat pacing and busy in head pacing, so an `&&` or `||` of the two is wrong in one direction whichever way it is written.

4. **Report the routing back.** In seat mode the response already carries `teamRouting` (`:1478`), because `teamOverride` was resolved rather than overridden. Surface it in the `queue/next` payload alongside `dispatched`, and add `pacing` to the response so a caller can see which branch ran. The head branch continues to carry no `teamRouting` — that asymmetry is documented behaviour, not a bug to normalise.

5. **Make the no-seat refusal legible.** The existing 409 text at `:1441` ("Add a `<role>` seat to the team") was written for an external head. In seat pacing the likelier cause is that the routed seat is not live. Extend the message to name the card's complexity and the role it routed to, so the operator can see *why* that seat was chosen. Do not add a fallback to another seat here — role degradation is `_validateOrDegradeCodingColumn`'s job (`KanbanProvider.ts:8184`) and re-implementing it in the pop would give two answers to one question.

6. **Update the method's doc comment.** The block at `LocalApiServer.ts:1500-1527` currently asserts that complexity routing chooses only the column and that the response carries no `teamRouting`. Both become conditional on pacing. That comment is the contract three sibling callers read; leaving it stale is the most likely way this change gets reverted by a later coder.

## Verification Plan

Extend `src/test/queue-pipeline-contract.test.js` (the existing behavioural suite over the real compiled services) rather than adding a parallel harness.

1. **Seat routing by complexity.** Team seated lead/coder/intern, pacing `seat`. Stage three cards with complexity 3, 5 and 8. Pop three times, clearing working state between pops so the latch releases. Assert each card's `dispatched.targetTerminal` is the intern, coder and lead seat respectively, that each card is left sitting in its own coding column, and that `teamRouting` reads `team-scoped: <from> → <seat>`.
2. **Head pacing is byte-for-byte unchanged.** Same fixture with pacing absent: assert every card dispatches to `from`, and that no `teamRouting` field is present. This is the regression gate for ~4,000 installs.
3. **Absent pacing field on a stored team resolves to `head`.** Construct a `terminals.groups` entry with no pacing key — the shipped shape — and assert head behaviour.
4. **External head still forced to seat routing.** A `from` that the roster does not contain gets `restrictToOriginTeam` even with pacing `head`.
5. **Seat pacing: the latch is the refusal, and it releases.** With a card in `INTERN CODED` and `dispatched_at` **set**, a pop requested by the coder on the same team returns 409 naming the intern's card — one card at a time is team-wide, not per-seat. Then clear working state on that card, leaving it exactly where it is in `INTERN CODED`, and assert the next pop **succeeds**. This is the test the whole subtask turns on: a coded card resting in a coding column must not block the queue.
6. **Head pacing: board position is still the refusal.** With a card in `CODER CODED` and `dispatched_at` **cleared**, a head-paced pop still returns 409. Asserting this explicitly is what stops a later coder from "unifying" the two predicates and silently breaking head pacing, where a cleared latch does not mean the team is free.
7. **Three cards end in three coding columns.** Run a full three-card queue to exhaustion and assert the final board state is one card in each of `INTERN CODED`, `CODER CODED` and `LEAD CODED`, all with `dispatched_at` cleared, and nothing in `CODE REVIEWED` or `COMPLETED`. No card was moved after coding.
8. **No seat for the routed role → 409, card stays staged.** Assert the card's `queue_position` and `DISPATCH` column are intact after the refusal, and that the message names both the complexity and the routed role.
9. **Queue empty → `dispatched: null`, reason `queue empty`**, in seat mode as in head mode.

Run `npm run compile` and the seven PRD gates (`catalog`, `parity`, `push-routing`, `standalone-parity`, `kanban-dispatch-callers`, `verb-returns`, `mirror`). `kanban-dispatch-callers` is the one most likely to trip, since it audits every caller of the dispatch path.
