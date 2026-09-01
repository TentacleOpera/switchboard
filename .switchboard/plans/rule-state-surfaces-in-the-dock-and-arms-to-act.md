# A switch per lane, a feed to watch them — the dock Fleet tab

## Goal

One tab does the whole job: a switch per lane, and a feed showing what the lanes and the fleet
actually did. Rules also evaluate the moment a seat finishes a turn (not only on the
minute tick), surface every rule's live verdict in the dock's Fleet tab, and give each rule an
explicit per-lane switch that moves it from proposing to acting by a deliberate click.

### Problem Analysis

Its sibling plan gives jobs a `when` condition, evaluated on the survivor tick and recorded in
`lastOutcome`. Two things are missing before that is usable.

**1. Up to sixty seconds of dead air, exactly when the fleet is emptiest.** The survivor timer runs
on a 60s interval (`TaskViewerProvider.ts:27592`). The moment a rule most wants to fire is the
moment a seat finishes — and that is the moment the tick has, on average, thirty seconds left to
run. Across a night of sequential cards that is a meaningful fraction of the session spent idle,
and it is the failure the operator notices first because it looks like the automation is not
working.

The signal already exists and is already precise. `notifyTurnEnd`
(`TaskViewerProvider.ts:1966`) fires with `{ seatName, planFile, outcome, workspaceRoot }` and is
*"derived entirely from the pty stream — no hooks, no tokens, no agent-side obligation."* It is
already the place the system learns a seat went quiet.

**2. `lastOutcome` is a string in a config blob.** The dry-run trail the sibling plan writes has no
reader. An operator cannot see which rules matched, which conditions failed, or what would happen
next — so there is no way to build confidence before switching a lane to *act*, which is the entire
point of shipping propose-first. The dock's new Fleet tab is already rendering seat state on a poll; rule verdicts
belong beside them, because a rule's verdict is a statement *about* that fleet.

### Root Cause

Turn-end and scheduling were built for different consumers and never introduced. `notifyTurnEnd`
exists to notify an *agent* — it resolves a recipient through `parentInstanceId`, falls back to a
Mission Control terminal, and delivers a prompt. The scheduler exists to fire *host* actions on a
clock. Nothing needed a host action triggered by a turn ending, so the two never met.

### Non-goals

- **No new condition kinds.** The sibling plan's closed set is the whole vocabulary.
- **No second dispatcher.** The turn-end path calls the same evaluator and the same action branches.
- **Not a rules editor — there is nothing to author.** The lane switches live in the Fleet tab
  because that is where you watch the lanes they govern. What stays in the Mission Control
  Schedules surface is creating and deleting jobs, choosing an action, and setting an interval.
- **No control over readiness.** The panel explains why a lane is busy; it offers no way to
  overrule it. That is a `LaneReadiness` decision and it is not reachable from the UI.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, ui, reliability, ux

## Dependencies

- **Hard prerequisite:** `scheduled-jobs-get-a-when-condition-rules-not-just-clocks.md` — the `when`
  field, the evaluator, and the dry-run gate.
- **Hard prerequisite:** `agent-dock-three-tabs-agent-cli-fleet.md` — the Fleet tab this renders into.

## User Review Required

None — both settled.

**The propose/act switch is per lane.** Planning can be acting while Coding is still only proposing,
so trust is built one lane at a time. A single master switch would force all-or-nothing.

**It persists across restarts, and the restart case is already safe by a different mechanism.**
`mode` is a field on the job, so a lane left on *act* is still acting after a reload — but a restart
loses the terminals, and an empty fleet resolves `laneIsFree` to **unknown**, which never fires. So
a persisted *act* lane does nothing on a fresh launch: not because it forgot, but because there is
nothing to dispatch to. The fail-closed rule the evaluator already needs for a dead pty host covers
this for free.

**The one case where persistence has teeth is `startOnLoad`.** It is a per-team checkbox
(`kanban.html:5189`, `group.startOnLoad`) and `startTeamsOnLoad`
(`TaskViewerProvider.ts:13048`) runs it at boot in both hosts. Such a team re-seats automatically,
so the fleet is populated again and a persisted *act* lane resumes dispatching unattended.

That is acceptable, and it is the reason to persist rather than reset. Reaching it requires **two
deliberate switches**: `startOnLoad` ticked on the team, and the lane set to *act*. Together those
are a description of unattended overnight operation, which is the feature. Resetting every lane to
*propose* on each launch would break exactly that configuration — the automation would stop
overnight, which is when it is wanted — and the friction would be routed around within a week.

**Verification owes this case a test** (see below): a `startOnLoad` team plus a persisted *act* lane
must resume; a restart with no autostart team must not.

## Complexity Audit

### Routine

- Rendering a rule list with a verdict line and a toggle.
- Adding an evaluation call at a second trigger point.

### Complex / Risky

- **Two triggers, one serialization point.** The tick and the turn-end path can both evaluate the
  same rule within milliseconds. Both must reach action through `dispatchNextFromQueue` /
  `launchMission`, which sit behind the module-level promise chain (`LocalApiServer.ts:59-67`) —
  *"the single serialization point."* In addition, the rule engine needs its own guard: a matched
  rule takes a per-job in-flight claim before evaluating its action, released after, so two triggers
  cannot both pass the interval floor in the same window. Without it this plan reintroduces exactly
  the double-dispatch the queue's design exists to prevent.
- **`notifyTurnEnd` is fire-and-forget and must stay that way.** Its body is a
  `void (async () => …)()` with every failure caught and logged, because it runs on the pty stream's
  path. A rule evaluation hung on a DB read must not be able to stall or throw into it. The hook
  schedules evaluation, it does not await it.
- **Turn-end fires per seat, and rules are fleet-wide.** Five seats finishing together produce five
  turn-end events. Evaluation must coalesce — one evaluation pass per short window, not one per
  event — or a single wave of completions triggers five passes racing each other.
- **`outcome: 'stalled'` is not a completion.** `notifyTurnEnd` carries
  `'completed' | 'blocked' | 'stalled'`, and `stalled` originates from the feature nudge sweep. A
  rule that treats a stall as "a seat freed up" dispatches new work onto a fleet that is wedged.
  Only `completed` triggers re-evaluation.
- **Both composition roots.** `notifyTurnEnd` lives on `TaskViewerProvider`, which both hosts
  construct — but the hook from it into the evaluator is a new seam, and a seam wired in one root is
  the documented failure mode.
- **Switching a lane to *act* is a state change with consequences.** Doing it from a browser tab,
  over a tailnet, starts real work. It routes through the same authenticated verb path as every other board
  mutation; it does not get a shortcut because it is a checkbox.

## Edge-Case & Dependency Audit

- **No `confirm()` on the propose/act switch.** `CLAUDE.md` is unambiguous, and `window.confirm` is
  a silent no-op in a VS Code webview. It toggles immediately; the propose trail is the safety, not a
  dialog.
- **A lane switched to *act* while it is already free** fires on the next trigger, not instantly on
  the click. The switch is not itself a trigger — otherwise it is a dispatch button wearing a
  different label.
- **Fleet tab offline.** Rule verdicts must render as *unknown*, never as *not matched*. The same
  fail-closed rule as the evaluator: an unreachable board is not evidence of an idle fleet.
- **Verdict staleness.** The Fleet tab polls; a verdict shown is as old as its poll. It carries the
  evaluation timestamp so a stale panel is visibly stale.
- **A rule whose job was dropped on read** (`DROPPED_SOURCES`) must not appear as acting in the dock.
  Render from the same filtered list the tick evaluates.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — turn-end trigger

In `notifyTurnEnd`, on `outcome === 'completed'` only, schedule a coalesced rule-evaluation pass
(trailing debounce, ~2s). Fire-and-forget, caught, logged — never awaited on the notify path.

### 2. Rule engine — a per-job claim

Wrap evaluation-plus-action in a per-job claim so the tick and the turn-end pass cannot both act for
one rule in the same window. The interval floor stays as the outer throttle.

### 3. Read surface

Expose the evaluated rule set — id, label, conditions in English, verdict, failing reasons,
`mode`, `lastOutcome`, evaluated-at — through the existing authenticated read path the Fleet tab
already uses, so the dock gains no new transport.

### 4. `src/webview/shell.js` — the Fleet tab, top to bottom

The whole feature is one tab, read top to bottom:

**1. Seats** — the `SEAT / ROLE / STATUS / CURRENT PLAN` table, polled (from the sibling dock plan).

**2. Lanes — the switches.** One row per lane. Each is on or off, and propose or act:

```
☑ Planning   free            → would dispatch "Add an Orders tab"      [ propose ▸ act ]
☑ Coding     busy: reviewer-1 holds "Fix bare switchboard CLI menu"    [ propose ▸ ACT ]
☐ Review     busy: reviewer-1 holds "Fix bare switchboard CLI menu"    [ propose ▸ act ]
```

Coding and review show the same reason because they share one working tree — a reviewer writes
source, so it holds both. Planning is independent: a planner writes plan files, not code.

The busy reason names the seat and its card, with no team qualifier: the fleet shares one tree, so a
busy seat holds the lane for everyone. Parallel checkouts come from a mission with dependency edges
and a bounded `maxExtraWorktrees`, never from a scheduler inferring isolation — see
`retire-the-dead-feature-worktree-mode-config.md`.

Three switches, one mode each. The user never sees or sets the readiness test — "busy: reviewer-1
holds …" is the panel *explaining* `laneIsFree`, not a control. There is deliberately no way to
make a lane dispatch while it is busy. No confirm gate on the mode toggle — `CLAUDE.md`, and
`window.confirm` is a silent no-op in a VS Code webview anyway.

**3. Feed — the messages.** A reverse-chronological list under the rules, one line per entry:

```
14:32  ✓ dispatched "Wire the sixteen unwired seams" → Coding-coder-2   (rule: coding lane idle)
14:31  · reviewer-1 finished "Fix bare switchboard CLI menu"
14:18  ~ would dispatch "Add an Orders tab" → planner-1   (lane on propose)
```

Three kinds of line, one feed: what a rule did, what the fleet did, and what a rule would have done
if the lane were on *act*. Session-scoped and in memory — this is a window you watch, not an audit log, so nothing
new is persisted and no store is added. `lastOutcome` on the job remains what survives a restart.

### 5. Mode verb

A small authenticated verb setting `keepLaneFed.mode` on one job, wired in **both** composition
roots.

## Verification Plan

### Automated Tests

1. **`stalled` and `blocked` do not trigger evaluation; `completed` does.** The wedged-fleet guard.
2. **Coalescing:** five turn-end events inside the debounce window produce exactly one evaluation
   pass.
3. **Double-trigger safety:** a tick and a turn-end pass racing on one free lane set to *act* produce
   exactly **one** action. Asserted by counting action-branch invocations, not by observing final
   board state — the state can look correct while two dispatches occurred.
4. **`notifyTurnEnd` stays non-blocking:** an evaluator that throws, and one that never resolves,
   both leave `notifyTurnEnd`'s own delivery path unaffected.
5. **Switching to *act* does not itself dispatch.** Flip a lane that is already free; assert no
   action until the next trigger.
6. **Restart with no autostart team dispatches nothing,** even with a lane persisted on *act*: the
   empty fleet resolves to `unknown` and `unknown` never fires. The case the operator expects to be
   safe, pinned so a later change to the empty-fleet rule cannot quietly make a persisted lane fire
   into a fleet that has not booted.
7. **Restart with a `startOnLoad` team and a persisted *act* lane does resume.** The deliberate
   configuration, asserted as working rather than left to chance — this is the pair of switches that
   makes unattended overnight operation the feature rather than an accident.
8. **Offline renders `unknown`,** never `not matched`.
9. **No confirm gate** in the dock diff — grep for `confirm(` across the changed webview files, per
   the standing repo rule.
10. **Both roots wire the turn-end hook and the mode verb.** Source-level, both files.
11. **Dropped-source jobs never render as acting.**

### Goal Invariants

- A completed turn causes re-evaluation within seconds, not on the next minute boundary.
- Every rule's verdict and reasoning is readable without asking an agent.
- No lane acts until it has been switched to *act* by a click, and the switch is per lane.
- Exactly one action per matched rule per interval, across both triggers.

### Manual

- Run a session with both lanes on *act*. Finish a card; the next dispatch should follow within a few
  seconds, and the Fleet tab should show the verdict that caused it.
- Kill the pty host mid-session; every verdict flips to `unknown` and nothing dispatches.
- Switch a lane that is already free to *act*; confirm nothing happens until the next completion.
