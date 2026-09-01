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
on a 60s interval (`TaskViewerProvider.ts:27622`). The moment a hop most wants to fire is the moment
a seat finishes — and on average that is thirty seconds before the next tick. Across a night of
sequential cards that is a real fraction of the session spent idle, and it is the failure an operator
notices first, because it looks like the automation is not working.

The signal exists and is precise. `notifyTurnEnd` (`TaskViewerProvider.ts:1967`) fires with
`{ seatName, planFile, outcome, workspaceRoot, recipientSeat?, body?, liveDelivery? }` and is *"derived entirely from the pty stream — no
hooks, no tokens, no agent-side obligation."* It is already where the system learns a seat went
quiet. The hook uses only `outcome` and `seatName`; the optional fields are irrelevant to it.

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

**Complexity:** 5
**Tags:** backend, frontend, ui, reliability, ux
**Feature:** edbf45a8-8e3e-46f9-a9ee-7ad13fb9b46d

> **Superseded:** Complexity: 4
> **Reason:** The plan touches 5+ surfaces (`TaskViewerProvider.ts`, `shell.js`, both composition roots, read path, verbs) — not single-file. The debounce/coalescing logic, in-flight claim, and both-roots wiring are moderate, well-scoped risks, which is Mixed (5-6), not Low (4).
> **Replaced with:** Complexity: 5

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
  behind the module-level promise chain (`LocalApiServer.ts:59-69`) — *"the single serialization
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

## Adversarial Synthesis

Key risks: tick and turn-end racing on one free hop produce double-dispatch; `notifyTurnEnd` runs on
the pty stream path and must stay fire-and-forget; `stalled` is not a completion and treating it as
one dispatches onto a wedged fleet. Mitigations: in-flight claim plus existing promise chain
serialize dispatch; hook schedules evaluation, never awaits it; only `outcome === 'completed'`
re-evaluates.

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

## Implementation Summary

Implemented the Fleet tab dock surface, turn-end evaluation scheduler, and session event feed. Integrated `notifyTurnEnd` in `TaskViewerProvider.ts` and `handleTurnEndNotify` in `bootstrap.ts` to trigger a coalesced 2-second debounced hop evaluation pass upon turn completion while ignoring blocked/stalled events. Added an in-memory session feed tracking seat completions and hop dispatches with full state queries and verb toggles (`getHopState`, `setHopCheckbox`, `setHopsStarted`, `setHopState`) across both extension and standalone hosts. Constructed the Fleet tab UI in `shell.html` and `shell.js` displaying the seat table, three hop checkboxes with reason lines, Start/Stop toggle button, and session activity feed without any confirmation modals. Added comprehensive contract tests in `src/test/the-fleet-tab-runs-the-hops-contract.test.js`.


## Review Findings

Files changed in this pass: `src/services/TaskViewerProvider.ts` (`getHopFullState` now returns a
`seatCards` map built by `_buildHopSeatCards` from the same snapshot and the same held-card rule the
readiness predicate uses), `src/webview/shell.js` (the seat table's CURRENT PLAN / TASK cell reads
that map instead of `t.currentPlanTitle || t.planTitle || t.topic` — `ptyListTerminals` rows carry no
plan-shaped field whatsoever, so the column the plan calls the busy/idle discriminator rendered `-`
for every seat forever, contradicting the reason line next to it), `package.json` +
`.github/workflows/integration-tests.yml` (`test:contract:fleet-tab-hops` — the suite existed and was
invoked by nothing), and the suite itself (item 10 asserted an object literal the test had just
written and stayed green with the real field initializer deleted; it now reads the initializer from
source, and new item 11 pins the seatCards path end to end). Validation:
`compile-tests` 0 errors; `test:contract:fleet-tab-hops` **11/11**; `test:contract:dispatch-hops` 15/15;
`browser-panel-verb-routing` 16/16, `standalone-fleet-seam` 13/13, `dispatch-view` pass;
`host-seam-parity:check`, `standalone-parity:check`, `verb-returns:check` pass; eslint 0 errors; no
`confirm(` in either shell file. Remaining risk: every guard here is behavioural and none of the
plan's manual steps (finish a card and watch the feed; kill the pty host mid-session) were run in this
pass, so the end-to-end turn-end→dispatch latency claim is unverified.

## Deferred Findings

- MAJOR `src/webview/shell.js:591` — the Fleet tab renders offline unless BOTH `ptyListTerminals` and `getHopState` return 200. Correct fail-closed behaviour for readiness, but a healthy board with a dead pty host shows nothing at all rather than an empty seat table with three `unknown` hops.
- NIT `src/test/the-fleet-tab-runs-the-hops-contract.test.js:231` — item 9's both-roots check asserts `extSrc.includes('notifyTurnEnd')`, which is true regardless of hop wiring, and joins the two verb assertions with `||`. The load-bearing half (bootstrap.ts wires `scheduleTurnEndHopEvaluation`) is real; the rest is decoration.
- NIT `src/services/TaskViewerProvider.ts:27827` — one debounce timer for all workspaces: a turn-end in workspace B replaces a pending pass for workspace A rather than scheduling its own.
- NIT `src/webview/shell.js:539` — the 60s poll means a reason line can be a minute stale. `evaluatedAt` is served but never rendered, so the panel cannot show that it is stale (the plan's "it carries the evaluation timestamp, so a stale panel is visibly stale").
