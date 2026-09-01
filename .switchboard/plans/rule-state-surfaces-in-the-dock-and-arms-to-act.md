# Checkboxes to set the rules, a feed to watch them — the dock Fleet tab

## Goal

One tab does the whole job: checkboxes to configure each rule, and a feed showing what the rules and
the fleet actually did. Rules also evaluate the moment a seat finishes a turn (not only on the
minute tick), surface every rule's live verdict in the dock's Fleet tab, and give each rule an
explicit Arm control so it moves from proposing to acting by a deliberate click.

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
next — so there is no way to build confidence before arming, which is the entire point of shipping
dry-run first. The dock's new Fleet tab is already rendering seat state on a poll; rule verdicts
belong beside them, because a rule's verdict is a statement *about* that fleet.

### Root Cause

Turn-end and scheduling were built for different consumers and never introduced. `notifyTurnEnd`
exists to notify an *agent* — it resolves a recipient through `parentInstanceId`, falls back to a
Mission Control terminal, and delivers a prompt. The scheduler exists to fire *host* actions on a
clock. Nothing needed a host action triggered by a turn ending, so the two never met.

### Non-goals

- **No new condition kinds.** The sibling plan's closed set is the whole vocabulary.
- **No second dispatcher.** The turn-end path calls the same evaluator and the same action branches.
- **Not a rules *editor* in the dock — but the checkboxes are here.** Ticking conditions on and off
  and arming a rule happen in the Fleet tab, because that is where you are watching the fleet those
  conditions describe. What stays in the Mission Control Schedules surface is creating and deleting
  jobs, choosing an action, and setting an interval. Splitting the checkboxes away from the fleet
  they read would mean configuring a rule in one panel and watching it in another.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, ui, reliability, ux

## Dependencies

- **Hard prerequisite:** `scheduled-jobs-get-a-when-condition-rules-not-just-clocks.md` — the `when`
  field, the evaluator, and the dry-run gate.
- **Hard prerequisite:** `agent-dock-three-tabs-agent-cli-fleet.md` — the Fleet tab this renders into.

## User Review Required

- **Confirm Arm is per-rule, not global.** Proposed: each rule arms independently, so the planner
  rule can act while the coding rule is still being watched. A single global switch is simpler but
  forces all-or-nothing trust.
- **Confirm arming persists across restarts.** Proposed: yes — `armed` is a field on the job, so it
  survives. The alternative (re-arm every session) is safer but becomes friction the operator
  routes around.

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
- **Arming is a state change with consequences.** Toggling Arm from a browser tab, over a tailnet,
  starts real work. It routes through the same authenticated verb path as every other board
  mutation; it does not get a shortcut because it is a checkbox.

## Edge-Case & Dependency Audit

- **No `confirm()` on Arm.** `CLAUDE.md` is unambiguous, and `window.confirm` is a silent no-op in a
  VS Code webview. Arm toggles immediately; the dry-run trail is the safety, not a dialog.
- **A rule armed while its condition already holds** fires on the next trigger, not instantly on the
  click. Arming is not itself a trigger — otherwise the click is a dispatch button wearing a
  different label.
- **Fleet tab offline.** Rule verdicts must render as *unknown*, never as *not matched*. The same
  fail-closed rule as the evaluator: an unreachable board is not evidence of an idle fleet.
- **Verdict staleness.** The Fleet tab polls; a verdict shown is as old as its poll. It carries the
  evaluation timestamp so a stale panel is visibly stale.
- **A rule whose job was dropped on read** (`DROPPED_SOURCES`) must not appear armed in the dock.
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
`armed`, `lastOutcome`, evaluated-at — through the existing authenticated read path the Fleet tab
already uses, so the dock gains no new transport.

### 4. `src/webview/shell.js` — the Fleet tab, top to bottom

The whole feature is one tab, read top to bottom:

**1. Seats** — the `SEAT / ROLE / STATUS / CURRENT PLAN` table, polled (from the sibling dock plan).

**2. Rules — the checkboxes.** One block per rule. Its conditions are checkboxes, ticked or not:

```
☑ Nothing is coding      ☑ Nothing is reviewing     ☐ Planner idle
☐ CREATED has cards      ☐ STAGING has cards
→ waiting: reviewer-1 holds "Fix bare switchboard CLI menu"          [ Arm ]
```

Ticking a box writes the condition and the panel re-evaluates on the next poll, so you see
immediately whether the rule you just described is currently true. Arm is a toggle on the same row.
No confirm gate — `CLAUDE.md`, and `window.confirm` is a silent no-op in a VS Code webview anyway.

**3. Feed — the messages.** A reverse-chronological list under the rules, one line per entry:

```
14:32  ✓ dispatched "Wire the sixteen unwired seams" → Coding-coder-2   (rule: coding lane idle)
14:31  · reviewer-1 finished "Fix bare switchboard CLI menu"
14:18  ~ would dispatch "Add an Orders tab" → planner-1   (rule not armed)
```

Three kinds of line, one feed: what a rule did, what the fleet did, and what a rule would have done
if armed. Session-scoped and in memory — this is a window you watch, not an audit log, so nothing
new is persisted and no store is added. `lastOutcome` on the job remains what survives a restart.

### 5. Arm verb

A small authenticated verb setting `when.armed` on one job, wired in **both** composition roots.

## Verification Plan

### Automated Tests

1. **`stalled` and `blocked` do not trigger evaluation; `completed` does.** The wedged-fleet guard.
2. **Coalescing:** five turn-end events inside the debounce window produce exactly one evaluation
   pass.
3. **Double-trigger safety:** a tick and a turn-end pass racing on one matched, armed rule produce
   exactly **one** action. Asserted by counting action-branch invocations, not by observing final
   board state — the state can look correct while two dispatches occurred.
4. **`notifyTurnEnd` stays non-blocking:** an evaluator that throws, and one that never resolves,
   both leave `notifyTurnEnd`'s own delivery path unaffected.
5. **Arming does not itself dispatch.** Arm a rule whose condition already holds; assert no action
   until the next trigger.
6. **Offline renders `unknown`,** never `not matched`.
7. **No confirm gate** in the dock diff — grep for `confirm(` across the changed webview files, per
   the standing repo rule.
8. **Both roots wire the turn-end hook and the arm verb.** Source-level, both files.
9. **Dropped-source jobs never render as armed.**

### Goal Invariants

- A completed turn causes re-evaluation within seconds, not on the next minute boundary.
- Every rule's verdict and reasoning is readable without asking an agent.
- No rule acts until it has been armed by a click, and arming is per-rule.
- Exactly one action per matched rule per interval, across both triggers.

### Manual

- Run a session with both rules armed. Finish a card; the next dispatch should follow within a few
  seconds, and the Fleet tab should show the verdict that caused it.
- Kill the pty host mid-session; every verdict flips to `unknown` and nothing dispatches.
- Arm a rule whose conditions already hold; confirm nothing happens until the next completion.
