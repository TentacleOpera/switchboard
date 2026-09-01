# One automation switch, a feed to watch it — the dock Fleet tab

## Goal

One tab does the whole job: the automation switch, and a feed showing what it and the fleet
actually did. It also evaluates the moment a seat finishes a turn, not only on the minute tick.

### Problem Analysis

Its sibling plan gives the automation its switch and its readiness predicate, evaluated on the
survivor tick and recorded in `lastOutcome`. Two things are missing before that is usable.

**1. Up to sixty seconds of dead air, exactly when the fleet is emptiest.** The survivor timer runs
on a 60s interval (`TaskViewerProvider.ts:27592`). The moment the automation most wants to fire is
the moment a seat finishes — and that is the moment the tick has, on average, thirty seconds left to
run. Across a night of sequential cards that is a meaningful fraction of the session spent idle,
and it is the failure the operator notices first because it looks like the automation is not
working.

The signal already exists and is already precise. `notifyTurnEnd`
(`TaskViewerProvider.ts:1966`) fires with `{ seatName, planFile, outcome, workspaceRoot }` and is
*"derived entirely from the pty stream — no hooks, no tokens, no agent-side obligation."* It is
already the place the system learns a seat went quiet.

**2. `lastOutcome` is a string in a config blob.** The dry-run trail the sibling plan writes has no
reader. An operator cannot see which rules matched, which conditions failed, or what would happen
next — so there is no way to build confidence before switching to *act*, which is the entire point
of shipping propose-first. The dock's new Fleet tab already renders seat state on a poll; the
verdict belongs beside it, because it is a statement *about* that fleet.

### Root Cause

Turn-end and scheduling were built for different consumers and never introduced. `notifyTurnEnd`
exists to notify an *agent* — it resolves a recipient through `parentInstanceId`, falls back to a
Mission Control terminal, and delivers a prompt. The scheduler exists to fire *host* actions on a
clock. Nothing needed a host action triggered by a turn ending, so the two never met.

### Non-goals

- **No new condition kinds.** The sibling plan's closed set is the whole vocabulary.
- **No second dispatcher.** The turn-end path calls the same evaluator and the same action branches.
- **Not a rules editor — there is nothing to author.** The switch lives in the Fleet tab because
  that is where you watch the run it governs. What stays in the Mission Control Schedules surface is
  creating and deleting jobs, choosing an action, and setting an interval.
- **Not persistence.** The switch dies with the session. Surviving a restart is the remote server's
  job.
- **No control over readiness.** The panel explains why the run is busy; it offers no way to
  overrule it. That is a `RunReadiness` decision and it is not reachable from the UI.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, ui, reliability, ux

## Dependencies

- **Hard prerequisite:** `scheduled-jobs-get-a-when-condition-rules-not-just-clocks.md` — the `when`
  field, the evaluator, and the dry-run gate.
- **Hard prerequisite:** `agent-dock-three-tabs-agent-cli-fleet.md` — the Fleet tab this renders into.

## User Review Required

None.

**One switch, one scope, session-scoped.** Planning and coding are steps of a single run, so the
earlier per-lane model invented a distinction the system does not have. Nothing persists: the switch
starts `off` on every launch and dies with the session, exactly as the terminals do. Persistence is
the remote server's job.

## Complexity Audit

### Routine

- Rendering a switch, a verdict line and a feed.
- Adding an evaluation call at a second trigger point.

### Complex / Risky

- **Two triggers, one serialization point.** The tick and the turn-end path can both evaluate the
  run within milliseconds. Both must reach action through `dispatchNextFromQueue` /
  `launchMission`, which sit behind the module-level promise chain (`LocalApiServer.ts:59-67`) —
  *"the single serialization point."* In addition, the automation needs its own guard: it takes an
  in-flight claim before evaluating its action, released after, so two triggers
  cannot both pass the interval floor in the same window. Without it this plan reintroduces exactly
  the double-dispatch the queue's design exists to prevent.
- **`notifyTurnEnd` is fire-and-forget and must stay that way.** Its body is a
  `void (async () => …)()` with every failure caught and logged, because it runs on the pty stream's
  path. A rule evaluation hung on a DB read must not be able to stall or throw into it. The hook
  schedules evaluation, it does not await it.
- **Turn-end fires per seat, and the run is fleet-wide.** Five seats finishing together produce five
  turn-end events. Evaluation must coalesce — one evaluation pass per short window, not one per
  event — or a single wave of completions triggers five passes racing each other.
- **`outcome: 'stalled'` is not a completion.** `notifyTurnEnd` carries
  `'completed' | 'blocked' | 'stalled'`, and `stalled` originates from the feature nudge sweep. A
  automation that treats a stall as "a seat freed up" dispatches new work onto a fleet that is wedged.
  Only `completed` triggers re-evaluation.
- **Both composition roots.** `notifyTurnEnd` lives on `TaskViewerProvider`, which both hosts
  construct — but the hook from it into the evaluator is a new seam, and a seam wired in one root is
  the documented failure mode.
- **Switching to *act* is a state change with consequences.** Doing it from a browser tab,
  over a tailnet, starts real work. It routes through the same authenticated verb path as every other board
  mutation; it does not get a shortcut because it is a checkbox.

## Edge-Case & Dependency Audit

- **No `confirm()` on the propose/act switch.** `CLAUDE.md` is unambiguous, and `window.confirm` is
  a silent no-op in a VS Code webview. It toggles immediately; the propose trail is the safety, not a
  dialog.
- **Switching to *act* while the run is already idle** fires on the next trigger, not instantly on
  the click. The switch is not itself a trigger — otherwise it is a dispatch button wearing a
  different label.
- **Fleet tab offline.** The verdict must render as *unknown*, never as *idle*. The same
  fail-closed rule as the evaluator: an unreachable board is not evidence of an idle fleet.
- **Verdict staleness.** The Fleet tab polls; a verdict shown is as old as its poll. It carries the
  evaluation timestamp so a stale panel is visibly stale.
- **A job dropped on read** (`DROPPED_SOURCES`) must not appear as acting in the dock. Render from
  the same filtered list the tick evaluates.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — turn-end trigger

In `notifyTurnEnd`, on `outcome === 'completed'` only, schedule a coalesced rule-evaluation pass
(trailing debounce, ~2s). Fire-and-forget, caught, logged — never awaited on the notify path.

### 2. The evaluator — an in-flight claim

Wrap evaluation-plus-action in a claim so the tick and the turn-end pass cannot both act in the same
window. The interval floor stays as the outer throttle.

### 3. Read surface

Expose the automation's state — scope, mode, verdict, busy reason, last outcome, evaluated-at —
through the existing authenticated read path the Fleet tab already uses, so the dock gains no new
transport.

### 4. `src/webview/shell.js` — the Fleet tab, top to bottom

The whole feature is one tab, read top to bottom:

**1. Seats** — the `SEAT / ROLE / STATUS / CURRENT PLAN` table, polled (from the sibling dock plan).

**2. The automation — one switch and one scope.**

```
Automation   ( ) off   (•) propose   ( ) act
Scope        (•) planning + coding   ( ) coding only

Run is busy: reviewer-1 holds "Fix bare switchboard CLI menu"
→ would dispatch "Add an Orders tab" when it frees
```

The busy line explains `runIsIdle`; it is not a control. There is deliberately no way to dispatch
into a busy run. No confirm gate on the switch — `CLAUDE.md`, and `window.confirm` is a silent no-op
in a VS Code webview anyway.

**The switch is session state.** It starts `off` on every launch and is gone when the board closes,
like the terminals it governs. Nothing is persisted, so there is no schema change and no migration.
Work that must survive a machine sleeping belongs on the remote server.

**3. Feed — the messages.** A reverse-chronological list under the rules, one line per entry:

```
14:32  ✓ dispatched "Wire the sixteen unwired seams" → Coding-coder-2   (run idle)
14:31  · reviewer-1 finished "Fix bare switchboard CLI menu"
14:18  ~ would dispatch "Add an Orders tab" → planner-1   (propose)
```

Three kinds of line, one feed: what the automation did, what the fleet did, and what it would have
done on *act*. Session-scoped and in memory — this is a window you watch, not an audit log, so nothing
new is persisted and no store is added. `lastOutcome` on the job remains what survives a restart.

### 5. Mode verb

A small authenticated verb setting the session's `{ scope, mode }`, wired in **both** composition
roots. In-memory — it writes nothing to disk.

## Verification Plan

### Automated Tests

1. **`stalled` and `blocked` do not trigger evaluation; `completed` does.** The wedged-fleet guard.
2. **Coalescing:** five turn-end events inside the debounce window produce exactly one evaluation
   pass.
3. **Double-trigger safety:** a tick and a turn-end pass racing on an idle run set to *act* produce
   exactly **one** action. Asserted by counting action-branch invocations, not by observing final
   board state — the state can look correct while two dispatches occurred.
4. **`notifyTurnEnd` stays non-blocking:** an evaluator that throws, and one that never resolves,
   both leave `notifyTurnEnd`'s own delivery path unaffected.
5. **Switching to *act* does not itself dispatch.** Flip it while the run is already idle; assert no
   action until the next trigger.
6. **A fresh session starts `off`.** Nothing is read from disk; no prior session's mode is inherited.
7. **Offline renders `unknown`,** never `not matched`.
8. **No confirm gate** in the dock diff — grep for `confirm(` across the changed webview files, per
   the standing repo rule.
9. **Both roots wire the turn-end hook and the mode verb.** Source-level, both files.
10. **Dropped-source jobs never render as acting.**

### Goal Invariants

- A completed turn causes re-evaluation within seconds, not on the next minute boundary.
- Every rule's verdict and reasoning is readable without asking an agent.
- The automation acts only after a deliberate click, and starts `off` on every launch.
- Exactly one action per matched rule per interval, across both triggers.

### Manual

- Run a session with the automation on *act*. Finish a card; the next dispatch should follow within a few
  seconds, and the Fleet tab should show the verdict that caused it.
- Kill the pty host mid-session; every verdict flips to `unknown` and nothing dispatches.
- Switch to *act* while the run is already idle; confirm nothing happens until the next completion.
