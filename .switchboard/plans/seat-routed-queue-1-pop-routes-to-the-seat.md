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

### What this plan does NOT change

- **The in-flight refusal stays team-scoped and unchanged.** One card at a time for the whole team is the chosen pacing, and `CODING_COLUMNS`-based team-wide refusal (`LocalApiServer.ts:1573-1590`) already implements exactly that. No seat-scoped predicate, no concurrency rework.
- **The queue source stays `DISPATCH` only.** No `PLAN REVIEWED` fallback — that was deliberately removed and re-adding it drains the whole lane unattended (`LocalApiServer.ts:1596-1607`).
- **The serialization chain stays the single critical section** (`_queueNextChain`, `LocalApiServer.ts:52`).
- **`resolveRoutedRole` is not touched.** `KanbanProvider.resolveRoutedRole` (`src/services/KanbanProvider.ts:1508`) remains the single source of truth for score → role, including the custom routing map and the pair-programming bypass.

## Metadata

**Complexity:** 3
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

3. **Report the routing back.** In seat mode the response already carries `teamRouting` (`:1478`), because `teamOverride` was resolved rather than overridden. Surface it in the `queue/next` payload alongside `dispatched`, and add `pacing` to the response so a caller can see which branch ran. The head branch continues to carry no `teamRouting` — that asymmetry is documented behaviour, not a bug to normalise.

4. **Make the no-seat refusal legible.** The existing 409 text at `:1441` ("Add a `<role>` seat to the team") was written for an external head. In seat pacing the likelier cause is that the routed seat is not live. Extend the message to name the card's complexity and the role it routed to, so the operator can see *why* that seat was chosen. Do not add a fallback to another seat here — role degradation is `_validateOrDegradeCodingColumn`'s job (`KanbanProvider.ts:8184`) and re-implementing it in the pop would give two answers to one question.

5. **Update the method's doc comment.** The block at `LocalApiServer.ts:1500-1527` currently asserts that complexity routing chooses only the column and that the response carries no `teamRouting`. Both become conditional on pacing. That comment is the contract three sibling callers read; leaving it stale is the most likely way this change gets reverted by a later coder.

## Verification Plan

Extend `src/test/queue-pipeline-contract.test.js` (the existing behavioural suite over the real compiled services) rather than adding a parallel harness.

1. **Seat routing by complexity.** Team seated lead/coder/intern, pacing `seat`. Stage three cards with complexity 3, 5 and 8. Pop three times (retiring the card between pops so the 409 releases). Assert each card's `dispatched.targetTerminal` is the intern, coder and lead seat respectively, and that `teamRouting` reads `team-scoped: <from> → <seat>`.
2. **Head pacing is byte-for-byte unchanged.** Same fixture with pacing absent: assert every card dispatches to `from`, and that no `teamRouting` field is present. This is the regression gate for ~4,000 installs.
3. **Absent pacing field on a stored team resolves to `head`.** Construct a `terminals.groups` entry with no pacing key — the shipped shape — and assert head behaviour.
4. **External head still forced to seat routing.** A `from` that the roster does not contain gets `restrictToOriginTeam` even with pacing `head`.
5. **In-flight refusal unchanged in seat mode.** With a card held by the *intern* in `INTERN CODED`, a pop requested by the *coder* on the same team returns 409 naming the intern's card. One card at a time is team-wide, not per-seat.
6. **No seat for the routed role → 409, card stays staged.** Assert the card's `queue_position` and `DISPATCH` column are intact after the refusal, and that the message names both the complexity and the routed role.
7. **Queue empty → `dispatched: null`, reason `queue empty`**, in seat mode as in head mode.

Run `npm run compile` and the seven PRD gates (`catalog`, `parity`, `push-routing`, `standalone-parity`, `kanban-dispatch-callers`, `verb-returns`, `mirror`). `kanban-dispatch-callers` is the one most likely to trip, since it audits every caller of the dispatch path.
