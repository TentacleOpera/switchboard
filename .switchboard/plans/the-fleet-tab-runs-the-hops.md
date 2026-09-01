# The Fleet tab runs the hops — three checkboxes, a Start button, and a feed

## Goal

Put the dispatch hops on screen in the dock's Fleet tab, and make them fire the moment a seat
finishes rather than waiting for the next minute tick.

```
SEAT            ROLE      STATUS  CURRENT PLAN / TASK
Coding          lead      active  -
Coding-coder-1  coder     active  -
reviewer-1      reviewer  active  Fix bare switchboard CLI menu…
planner-1       planner   active  -

☑ Dispatch created plans to the planning team      planner-1 free
☑ Dispatch plans to the coding team                reviewer-1 is working
☐ Dispatch coded plans to the review team

                                                        [ Start ]

14:32  ✓ "Wire the sixteen unwired seams" → Coding-coder-2
14:31  ·  reviewer-1 finished "Fix bare switchboard CLI menu"
14:28  ✓ "Add an Orders tab" → planner-1
```

### Problem Analysis

Its sibling plan gives the hops their readiness predicate and tick integration. Two things are
missing before that is usable.

**1. Up to sixty seconds of dead air, exactly when the fleet is emptiest.** The survivor timer runs
on a 60s interval (`TaskViewerProvider.ts:27592`). The moment a hop most wants to fire is the moment
a seat finishes — and on average that is thirty seconds before the next tick. Across a night of
sequential cards that is a real fraction of the session spent idle, and it is the failure an operator
notices first, because it looks like the automation is not working.

The signal exists and is precise. `notifyTurnEnd` (`TaskViewerProvider.ts:1966`) fires with
`{ seatName, planFile, outcome, workspaceRoot }` and is *"derived entirely from the pty stream — no
hooks, no tokens, no agent-side obligation."* It is already where the system learns a seat went
quiet.

**2. The hops have no surface.** Their state lives in memory with no reader — an operator cannot tick
one, cannot press Start, and cannot see why a hop is not firing. The Fleet tab already polls seat
state; the hops belong beside it, because "is the team free" is a statement about that fleet.

### Root Cause

Turn-end and scheduling were built for different consumers and never introduced. `notifyTurnEnd`
exists to notify an *agent* — it resolves a recipient through `parentInstanceId` and delivers a
prompt. The scheduler fires *host* actions on a clock. Nothing needed a host action triggered by a
turn ending, so the two never met.

### Non-goals

- **No propose mode.** Start is the commitment. Before it nothing dispatches; after it the ticked
  hops run. The feed reports what happened, not what might have.
- **No control over readiness.** The line beside each checkbox explains why a hop is held; it offers
  no way to overrule it. That is a `HopReadiness` decision and is not reachable from the UI.
- **No persistence.** Checkboxes and Start die with the session, like the terminals.
- **No second dispatcher.** The turn-end path calls the same evaluator and the same branches.

## Metadata

**Complexity:** 4
**Tags:** backend, frontend, ui, reliability, ux

## Dependencies

- **Hard prerequisite:** `three-dispatch-hops-and-a-start-button.md` — the hops, the predicate, the
  tick integration.
- **Hard prerequisite:** `agent-dock-three-tabs-agent-cli-fleet.md` — the Fleet tab this renders into.

## User Review Required

None.

## Complexity Audit

### Routine

- Three checkboxes, a button, a reason line and a feed.

### Complex / Risky

- **Two triggers, one serialization point.** The tick and the turn-end pass can evaluate within
  milliseconds of each other. Both reach dispatch through `dispatchNextFromQueue` / `launchMission`,
  behind the module-level promise chain (`LocalApiServer.ts:59-67`) — *"the single serialization
  point."* On top of that the evaluator takes an in-flight claim before acting, released after, so
  two triggers cannot both pass the interval floor in one window. Without it this plan reintroduces
  the double-dispatch the queue's design exists to prevent.
- **`notifyTurnEnd` is fire-and-forget and must stay that way.** Its body is a
  `void (async () => …)()` with every failure caught, because it runs on the pty stream's path. An
  evaluation hung on a DB read must not stall or throw into it. The hook *schedules* evaluation; it
  does not await it.
- **Turn-end fires per seat; the hops are fleet-wide.** Five seats finishing together produce five
  events. Evaluation coalesces to one pass per short window, or one wave of completions starts five
  passes racing each other.
- **`outcome: 'stalled'` is not a completion.** `notifyTurnEnd` carries
  `'completed' | 'blocked' | 'stalled'`, and `stalled` comes from the feature nudge sweep. Treating a
  stall as "a seat freed up" dispatches onto a fleet that is wedged. Only `completed` re-evaluates.
- **Both composition roots.** The hook from `notifyTurnEnd` into the evaluator is a new seam, and a
  seam wired in one root is the documented failure mode.
- **Start is a state change with consequences.** Pressing it from a browser tab, over a tailnet,
  starts real work. It routes through the same authenticated verb path as every other board
  mutation.

## Edge-Case & Dependency Audit

- **No `confirm()` on Start.** `CLAUDE.md` is unambiguous, and `window.confirm` is a silent no-op in
  a VS Code webview — a gate there would make the button do nothing at all.
- **Start while a team is already free** fires on the next trigger, not on the click. Start is not
  itself a trigger, or it is a dispatch button wearing a different label.
- **Fleet tab offline** renders every hop as *unknown*, never as free. Same fail-closed rule as the
  evaluator: an unreachable board is not evidence of an idle fleet.
- **Reason staleness.** The tab polls at 60s, so a reason shown is as old as its poll. It carries the
  evaluation timestamp, so a stale panel is visibly stale.
- **The feed is session-scoped and in memory.** It is a window you watch, not an audit log — no new
  store, nothing persisted.
- **Stop.** Once started, the button becomes Stop; pressing it halts future dispatches and does not
  recall one in flight.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — turn-end trigger

In `notifyTurnEnd`, on `outcome === 'completed'` only, schedule a coalesced evaluation pass (trailing
debounce, ~2s). Fire-and-forget, caught, logged — never awaited on the notify path.

### 2. The evaluator — an in-flight claim

Wrap evaluation-plus-dispatch in a claim so the tick and the turn-end pass cannot both act in one
window. The interval floor stays as the outer throttle.

### 3. Read surface

Expose hop state — ticked, started, free/held, reason, evaluated-at — plus the session feed, through
the authenticated read path the Fleet tab already uses. No new transport.

### 4. `src/webview/shell.js` — the Fleet tab

Seat table (from the sibling dock plan), then three checkboxes each with its reason line, then
Start/Stop, then the feed. Two kinds of feed line: what a hop dispatched, and what a seat finished.

### 5. Verbs

Setting a checkbox and pressing Start are small authenticated verbs, wired in **both** composition
roots. In-memory — they write nothing to disk.

## Verification Plan

### Automated Tests

1. **`stalled` and `blocked` do not trigger evaluation; `completed` does.** The wedged-fleet guard.
2. **Coalescing:** five turn-end events inside the debounce window produce exactly one pass.
3. **Double-trigger safety:** a tick and a turn-end pass racing on one free hop produce exactly
   **one** dispatch. Asserted by counting branch invocations, not final board state — the state can
   look right while two dispatches occurred.
4. **`notifyTurnEnd` stays non-blocking:** an evaluator that throws, and one that never resolves,
   both leave its delivery path unaffected.
5. **Start does not itself dispatch.** Press it while a team is already free; assert no action until
   the next trigger.
6. **Nothing dispatches before Start,** with all three ticked.
7. **Offline renders `unknown`,** never free.
8. **No `confirm(`** anywhere in the changed webview files.
9. **Both roots wire the turn-end hook and the verbs.** Source-level, both files.
10. **A fresh session starts unticked and stopped.**

### Goal Invariants

- A completed turn causes re-evaluation within seconds, not on the next minute boundary.
- Every hop's state and reason is readable without asking an agent.
- Nothing dispatches until Start.

### Manual

- Tick all three, press Start, finish a card: the next dispatch follows within seconds, and the feed
  names the hop that caused it.
- Kill the pty host mid-session: every hop shows *unknown* and nothing dispatches.
- Press Start while a team is already free: nothing happens until the next completion.
- Press Stop mid-run: the in-flight card continues, nothing new goes out.
