# The controller's mechanical checks become code — keep a lane fed, per lane

## Goal

Take the part of the Mission Control controller that is not judgement — read the fleet, decide
whether anyone is working, dispatch if not — and make it deterministic code.

The configuration surface is **one switch per lane**: keep the planning lane fed, keep the coding
lane fed, keep the review lane fed. Whether a lane is free is decided in code, not by the user.
Each switch has two positions, propose and act, and starts in propose.

### Problem Analysis

**A language model is currently running string comparisons.**

The controller agent's routine loop is three mechanical reads and a comparison. In its own account
of how it produces a status report: run `switchboard fleet`, tail `.switchboard/logs/<seat>.md`,
run `git log -n 1`. Then it applies rules a human wrote — *if a planner is free, dispatch; if
nobody is coding or reviewing, dispatch the top card* — and calls a verb.

Every step of that is deterministic. `switchboard fleet` already emits an aligned table and a
`--json` projection; the rules are two boolean tests; the action is an existing verb. What the model
adds to this particular loop is latency, token cost, and the chance of reading the table wrong. It
is doing work that has a correct answer.

**This is a subtraction, not an addition.** The agent is not replaced — the ~20% that is actually
judgement stays with it: planner-stage questions, escalation, merge conflicts, advising on what to
seat and what to group. What moves to code is the ~80% that is a state check followed by a fixed
consequence. The result is *less* nondeterminism in the dispatch path, not more.

**And it is not the retired clock returning.** `retire-autoban-and-batch-size.md` deleted the
queue-schedule engine because it was *"still able to dispatch work nobody asked for on a timer"* —
the defect is the word *unconditional*. A rule that fires only when the fleet is provably idle
dispatches precisely when the operator would have. An interval with no state test is the thing being
corrected here, not the thing being rebuilt.

**Switchboard has a scheduler and no rules engine, and the two have been conflated.**

The surviving recurring dispatcher is the survivor jobs timer — named as such in
`bootstrap.ts:3559`: *"the survivor scheduler timer — the one recurring dispatcher, and the engine
behind both sanctioned scheduling surfaces (team automations, Mission Control Schedules)."* It ticks
once a minute (`TaskViewerProvider.ts:27592`) and `_tickSurvivorSchedulerJobs` (`:27624`) fires any
job whose `intervalMinutes` have elapsed since `lastRunAt`.

That is a clock. `ScheduledJob` (`GlobalIntegrationConfigService.ts:45-75`) carries `source`,
`target`, `intervalMinutes`, `teamTarget`, `advanceWhenReady` — and **no condition field of any
kind**. Every job is unconditional in time.

**Conditions exist, but only hard-coded inside individual job branches.** `start-ready-mission`
(`TaskViewerProvider.ts:27706-27716`) does:

```
missions.find(m => m.ready && m.runState !== 'in-flight' && m.runState !== 'completed')
```

That `runState !== 'in-flight'` *is* a "nobody is busy" condition — written in TypeScript, inside
one branch, unreachable and uneditable from outside. Add a second rule and it is a second branch. An
operator cannot express "dispatch when the planner is free" at all, because there is no place to say
it.

**The pattern for evaluating fleet conditions is already proven elsewhere.**
`_runFeatureNudgeSweep` (`PlanIngestionEngine.ts:908`) wakes a head only when four conditions hold —
un-accepted subtask remaining, head live and not `exited`, head silent longer than
`turnEndSilenceMs`, no dispatch outstanding. It composes evidence rather than poking blindly, and
paces itself to one action per window. That is a rules engine hard-coded for exactly one rule.

### Root Cause

Automation grew as *"add a source to the enum and a branch to the switch."* Each new behaviour
brought its own trigger logic inline, because the record had no field to hold one and no evaluator
to run one. Thirteen actions are declared in `mission-control.js:18` (`SCHEDULE_ACTIONS`) and every
one of them is time-triggered, so the shape was never questioned.

### The predicate's input is card assignment, not seat status — this is load-bearing

The obvious implementation of "no one is coding" reads seat `status` from `getFleetLiveness()`
(`TaskViewerProvider.ts:1604`, returning `{ friendlyName, lastDataAt, status, role }`). **That does
not work, and a live `switchboard fleet` capture shows why:**

```
SEAT            ROLE      STATUS  CURRENT PLAN / TASK
Coding          lead      active  -
Coding-coder-1  coder     active  -
reviewer-1      reviewer  active  Fix bare switchboard CLI menu when no server...
planner-1       planner   active  -
```

Every seat reads `active`. `status` is a **liveness** signal, not a busy signal — the only consumer
that reads it, `getAliveCodingTerminalNames` (`:2421`), checks nothing but `status === 'exited'`.
The column that actually distinguishes a working seat from an idle one is `CURRENT PLAN / TASK`.

The correct predicate already exists and is already exported: `heldByTeam`
(`LocalApiServer.ts:76`) — *"true when card is held by a team member with no completion post"* —
and its wrapper `resolveTeamInFlight` (`:89`). Busy means **a card names this seat in
`dispatched_terminal` and its `completed_at` is NULL**. Building the evaluator on `status` would
produce a rule that fires constantly, dispatching onto seats that are mid-task, and every test
written against a stub fleet would pass.

### Non-goals

- **No condition builder, and no way to switch off a safety check.** "Nothing is coding" is not a
  preference, it is the definition of *the coding lane is free* — exposing it as a checkbox would
  let a user configure "dispatch onto busy seats", which is a bug wearing a settings control. The
  readiness predicate lives in `LaneReadiness.ts` and takes no configuration. What the user chooses
  is which lanes to keep fed, and whether each proposes or acts.
- **No expression language, no parser, no `eval`.** Nothing user-authored is executed, because
  nothing about the predicate is user-authored.
- **Not a second dispatcher.** Rules select *when*; the existing action branches keep selecting
  *what* and *where*, and dispatch keeps flowing through `dispatchNextFromQueue` /
  `launchMission`.
- **Not the turn-end trigger.** Tick-only here; `rule-state-surfaces-in-the-dock-and-arms-to-act.md`
  adds the state-change trigger and the arming UI.
- **Not deleting `intervalMinutes`.** A lane switch still respects its job's interval as a floor —
  see the throttle note below.
- **Not retiring the controller agent.** Only its mechanical loop moves. Judgement — planner-stage
  questions, escalation, merge conflicts, what to seat, what to group — stays with the agent, and
  this plan removes none of it. The controller keeps running; it stops re-deriving facts.
- **Not replicating the controller's narrative reports.** Its log-tail and `git log` reads produce
  prose for a human. Rules read board and fleet state and emit a verdict. Anything that needs a
  log tail to decide is, by that fact, in the 20% that stays.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, api, feature, devops

## User Review Required

- **Confirm the role sets.** Proposed: `planning` = `planner`; `coding` and `review` share
  `lead`, `coder`, `intern`, `reviewer`. A fleet using role names outside this set has lanes that
  never read as free.
- **Confirm coding and review share one lock.** They write the same tree, so a busy reviewer holds
  both. This matches the rule as originally stated ("if no one is coding **or reviewing**").
  An earlier revision of this plan split them, which was wrong.
- **Confirm `propose` is the default for a job that gains a lane switch,** including on upgrade.

## Complexity Audit

### Routine

- Adding an optional two-enum field to an interface and threading it through read/write.
- Rendering three switches and a propose/act toggle.

### Complex / Risky

- **`SchedulerConfig` is persisted, shipped state on ~4,000 installs.** `schemaVersion` /
  `SCHEDULER_SCHEMA_VERSION` (`:82-88`) exists as the migration branch point. `keepLaneFed` is optional and
  additive, so no version bump is needed — but the read path must preserve unknown keys rather than
  reserialising a narrowed object, per `CLAUDE.md`'s migration rule.
- **`DROPPED_SOURCES` filters on read** (`:502-508`), with a standing comment: *"Do NOT add
  'team-automation'."* The evaluator must run *after* that filter, or a rule can be attached to a
  job that is about to be dropped and will appear to be armed while never firing.
- **Both composition roots must wire the evaluator.** This is the exact trap `CLAUDE.md` names.
  The tick is reached from `TaskViewerProvider.ts:11590` (extension) and from `bootstrap.ts:3567`
  via `restoreAutobanOnStartup` (standalone). If the evaluator is constructed with a
  fleet/board resolver seam, that seam must be set in **both** roots — a `Promise<void>` seam where
  "never wired" and "working" look identical is precisely the `PlanIngestionEngine` queue-seam
  precedent, where four seams were extension-only for a month and *"no queue watch was ever armed
  in the standalone host."*
- **Fleet unavailability must fail closed.** `getFleetLiveness()` returns `[]` when the pty host is
  down. An empty fleet must resolve `laneIsFree` to **unknown → do not fire**, never to **free →
  fire**. `_runFeatureNudgeSweep` already encodes this lesson (`:924-931`: an empty liveness
  snapshot is *no evidence*, not "every head died"). Getting this backwards means a dead pty host
  dispatches everything at once.
- **Throttle.** A lane that stays free would fire every tick. `lastRunAt`
  plus `intervalMinutes` must remain a floor, so a rule fires at most once per interval even while
  its lane stays free continuously.

## Edge-Case & Dependency Audit

- **Serialization.** Every rule-driven action must reach dispatch through
  `dispatchNextFromQueue` / `launchMission`, both of which sit behind the module-level promise chain
  (`LocalApiServer.ts:59-67`) — *"the single serialization point."* A rule that dispatches by any
  other path reintroduces double-dispatch against a seat's own standing orders.
- **`heldByTeam` needs the board and a team set.** The evaluator therefore needs a DB handle in
  both hosts, not just fleet liveness. `_getKanbanDb(wsRoot)` is the existing path.
- **A job with no `keepLaneFed`** behaves exactly as today. Asserted, not assumed — this is what makes the
  change safe for existing installs.
- **A job in `propose` mode** must never call an action branch. The propose path has
  to be a hard gate before the switch, not a flag checked inside each branch.
- **A lane with no seat of its roles.** A `planning` lane with no planner seated is *unknown*,
  not *idle*. Same fail-closed rule as an empty fleet.
- **Multiple rules matching on one tick.** Evaluate all, act on at most one per tick, in job order,
  so two rules cannot both dispatch into a fleet that had room for one.

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — the field

```ts
// on ScheduledJob:
keepLaneFed?: { lane: 'planning' | 'coding' | 'review'; mode: 'propose' | 'act' };
```

Two enums. That is the entire configuration surface. Optional and additive; the read path preserves
unknown keys and there is no `SCHEDULER_SCHEMA_VERSION` bump.

### 2. New `src/services/LaneReadiness.ts` — the predicate, in code

```ts
laneIsFree(lane, snapshot): { free: boolean; reason: string } | { unknown: string }
```

One function, three lanes, no configuration reaching it. A lane is free when **no seat holding one
of that lane's roles holds an uncompleted card** — `heldByTeam` (`LocalApiServer.ts:76`) over the
board, filtered by role:

| Lane | Free when no seat is busy in | Source column |
| :--- | :--- | :--- |
| `planning` | `planner` | `CREATED` |
| `coding` | `lead`, `coder`, `intern`, **`reviewer`** | the queue |
| `review` | `lead`, `coder`, `intern`, **`reviewer`** | `*_CODED` |

Takes a snapshot (`{ seats, board, teamMembers }`), not services, so it is unit-testable with no
host and both roots hand it the same shape. Missing inputs return `unknown`, and `unknown` is never
treated as free.

**The lock follows the tree, not the role — reviewers write code.** `coding` and `review` share one
readiness set because they share one working tree. A reviewer does not only read: it fixes what it
finds, and those edits land in the same checkout a freshly-dispatched coder would start in.

This is not a precaution, it is a recorded incident. `agent-commits-sweep-the-whole-shared-tree.md`
documents two coders driven concurrently *"in one shared working tree"* on file-disjoint subtasks —
the sanctioned pattern — where one finished, ran `git add -A`, and swept its peer's in-flight
`terminals.html` (57 lines) and `terminals.js` (255 lines) into its own commit. Any seat that writes
source is an occupant of that tree, and a reviewer is such a seat.

`planning` stays separate because a planner writes plan files under `.switchboard/plans/`, not
source, so it cannot collide with either.

**Open — worktree scope.** Where a team runs in its own worktree, the collision domain is that
worktree rather than the repository, and two teams in separate worktrees could both be free at once.
This plan computes readiness over the shared tree, which is correct-and-conservative: it can idle a
lane that a worktree would have freed, and it can never dispatch into an occupied checkout. Making
it worktree-aware is a follow-up, not a prerequisite.

### 3. `src/services/TaskViewerProvider.ts` — tick integration

In `_tickSurvivorSchedulerJobs`, before the interval check:

- Job has no `keepLaneFed` → today's path, untouched.
- Job has one → resolve `laneIsFree(job.keepLaneFed.lane, snapshot)`.
  - Not free, or unknown → record `lastOutcome` as the reason; do not advance `lastRunAt`.
  - Free, `mode: 'propose'` → record `lastOutcome: "would <action>"`; do not act.
  - Free, `mode: 'act'`, interval elapsed → run the existing action branch unchanged.

`lastOutcome` is already a persisted field the UI reads, so the dry-run trail needs no new store.

### 4. Both composition roots

Wire the snapshot resolver (fleet + board) in `TaskViewerProvider` and in `bootstrap.ts`. Diff the
two roots by hand, as `CLAUDE.md` requires — verb reachability will not show this.

## Verification Plan

### Automated Tests

1. **The coding lane is not free while a REVIEWER holds an uncompleted card.** The specific
   regression this plan was corrected for: a lane model that reads only coding roles dispatches a
   coder into a tree a reviewer is editing, and every fleet-shaped test still passes.
2. **A lane is not free when one of its seats holds an uncompleted card**, with every seat's `status`
   set to `'active'`. This is the plan's central defect pinned directly: a status-based
   implementation passes every other test and fails only this one.
3. **Empty fleet → `unknown` → no fire,** for all three lanes. The dead-pty-host
   mass-dispatch guard.
4. **A job with no `keepLaneFed` is byte-for-byte unchanged in behaviour** — same fire times, same
   `lastRunAt` advancement. The ~4,000-install regression gate.
5. **Propose gate:** a free-lane job in `propose` mode records a `would …` outcome and calls **no** action
   branch. Asserted by spying on the branch, not by observing absence of side effects.
6. **Throttle:** a continuously-free lane fires at most once per `intervalMinutes`.
7. **At most one action per tick** when several rules match.
8. **Both roots wire the resolver.** A source-level assertion that the seam is set in
   `TaskViewerProvider.ts` *and* `bootstrap.ts`. This is the only gate that can catch the
   composition-root divergence, and its absence is the documented precedent.
9. **Unknown-key preservation:** round-trip a `SchedulerConfig` carrying a future key and assert it
   survives a write.
10. **Evaluator runs after `DROPPED_SOURCES` filtering.**

### Goal Invariants

- Both rules the controller applies today are expressible with no code change: *"if free planner
  team, dispatch work"* → the `planning` lane switch; *"if no one is coding, dispatch"* → the
  `coding` lane switch. Neither needs a condition to be authored.
- No rule can dispatch except through `dispatchNextFromQueue` / `launchMission`.
- No user-authored string is evaluated as code.
- **Nothing fires on time alone.** A job carrying a lane switch acts only while that lane is free; the
  interval is a floor on frequency, never a trigger. This is the property that distinguishes the
  rule from the clock that was deleted, and it is asserted, not asserted-about.

### Manual — does it reproduce the controller?

The real acceptance test is agreement with the agent it replaces, so run them side by side.

- Leave the controller agent running as it is today, and author both rules unarmed. Over a working
  session, compare each `would …` outcome against what the controller actually did. They should
  agree every time. A disagreement is the interesting artifact: either the rule is wrong, or the
  agent was — and the second case is the argument for the whole plan.
- Note where they cannot agree by construction. The controller reads
  `.switchboard/logs/<seat>.md` and `git log` for its *narrative* reports; the rules read board and
  fleet state only. Anything the controller decides from a log tail is judgement that stays with it,
  and should be visible in this comparison as a decision the rules never claim to make.
- Only arm once the two have agreed across a full session.

### The predicate is not reachable from configuration

One assertion earns its own heading because it is the whole reason the surface is two enums rather
than a checkbox list: **no persisted field can make `laneIsFree` return free for a busy lane.**
Assert it by round-tripping a `ScheduledJob` carrying arbitrary extra keys and confirming
`LaneReadiness` reads none of them — its only inputs are the snapshot and the lane name. A user
cannot configure their way onto a busy seat.
