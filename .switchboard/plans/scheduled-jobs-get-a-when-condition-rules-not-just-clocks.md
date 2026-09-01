# The controller's mechanical checks become code — one switch, session-scoped

## Goal

Take the part of the Mission Control controller that is not judgement — read the fleet, decide
whether anyone is working, dispatch if not — and make it deterministic code.

The configuration surface is **one switch and one scope**:

```
Automation   off | propose | act        (starts off)
Scope        planning + coding | coding only
```

Whether the run is idle is decided in code, not by the user. **The switch is session state** — it
lives in memory, is set by a verb, and is gone on restart along with the terminals. Persistence is
not this feature's job: a user who wants work to survive their machine sleeping uses the remote
server or leaves the machine on.

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
  preference, it is the definition of *the run is idle* — exposing it as a checkbox would let a user
  configure "dispatch onto busy seats", which is a bug wearing a settings control. The readiness
  predicate lives in `RunReadiness.ts` and takes no configuration. What the user chooses is the
  scope and whether the automation is off, proposing, or acting.
- **No expression language, no parser, no `eval`.** Nothing user-authored is executed, because
  nothing about the predicate is user-authored.
- **Not a second dispatcher.** Rules select *when*; the existing action branches keep selecting
  *what* and *where*, and dispatch keeps flowing through `dispatchNextFromQueue` /
  `launchMission`.
- **Not the turn-end trigger.** Tick-only here; `rule-state-surfaces-in-the-dock-and-arms-to-act.md`
  adds the state-change trigger and the switch itself.
- **Not persistence.** The switch dies with the session, as the terminals do. Surviving a restart is
  the remote server's job, or the user leaves the machine on.
- **Not deleting `intervalMinutes`.** The automation still respects the job's interval as a floor —
  see the throttle note below.
- **Not retiring the controller agent.** Only its mechanical loop moves. Judgement — planner-stage
  questions, escalation, merge conflicts, what to seat, what to group — stays with the agent, and
  this plan removes none of it. The controller keeps running; it stops re-deriving facts.
- **Not replicating the controller's narrative reports.** Its log-tail and `git log` reads produce
  prose for a human. Rules read board and fleet state and emit a verdict. Anything that needs a
  log tail to decide is, by that fact, in the 20% that stays.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, api, feature, devops

## User Review Required

None — all settled.

**Settled — the role sets are exhaustive.** `planning + coding` = `planner`, `lead`, `coder`,
`intern`, `reviewer`; `coding only` drops `planner`. These are Switchboard's own role names and the
feature supports no others, so there is no "unknown role" case to design for. A seat whose role is
outside the scope does not hold the run.
**Settled — one run, one lock.** Planning and coding are steps of a single pipeline, not separate
lanes; reviewers write source, so they hold the run too. Earlier revisions of this plan split them
into independent lanes, which invented a distinction the system does not have.
**Settled — the lock is global and `feature_worktree_mode` is not read.** Parallel checkouts come
from a mission with dependency edges, never from a scheduler reading a setting.
**Settled — the automation starts `off`.** Nothing is inherited, because nothing persists.

## Complexity Audit

### Routine

- Adding an optional two-enum field to an interface and threading it through read/write.
- Rendering three switches and a propose/act toggle.

### Complex / Risky

- **`SchedulerConfig` is persisted, shipped state on ~4,000 installs.** `schemaVersion` /
  `SCHEDULER_SCHEMA_VERSION` (`:82-88`) exists as the migration branch point. the automation switch is optional and
  additive, so no version bump is needed — but the read path must preserve unknown keys rather than
  reserialising a narrowed object, per `CLAUDE.md`'s migration rule.
- **`DROPPED_SOURCES` filters on read** (`:502-508`), with a standing comment: *"Do NOT add
  'team-automation'."* The evaluator must run *after* that filter, or a rule can be attached to a
  job that is about to be dropped and will appear to be acting while never firing.
- **Both composition roots must wire the evaluator.** This is the exact trap `CLAUDE.md` names.
  The tick is reached from `TaskViewerProvider.ts:11590` (extension) and from `bootstrap.ts:3567`
  via `restoreAutobanOnStartup` (standalone). If the evaluator is constructed with a
  fleet/board resolver seam, that seam must be set in **both** roots — a `Promise<void>` seam where
  "never wired" and "working" look identical is precisely the `PlanIngestionEngine` queue-seam
  precedent, where four seams were extension-only for a month and *"no queue watch was ever armed
  in the standalone host."*
- **Fleet unavailability must fail closed.** `getFleetLiveness()` returns `[]` when the pty host is
  down. An empty fleet must resolve `runIsIdle` to **unknown → do not fire**, never to **free →
  fire**. `_runFeatureNudgeSweep` already encodes this lesson (`:924-931`: an empty liveness
  snapshot is *no evidence*, not "every head died"). Getting this backwards means a dead pty host
  dispatches everything at once.
- **Throttle.** A run that stays idle would fire every tick. `lastRunAt`
  plus `intervalMinutes` must remain a floor, so a rule fires at most once per interval even while
  the run stays idle continuously.

## Edge-Case & Dependency Audit

- **Serialization.** Every rule-driven action must reach dispatch through
  `dispatchNextFromQueue` / `launchMission`, both of which sit behind the module-level promise chain
  (`LocalApiServer.ts:59-67`) — *"the single serialization point."* A rule that dispatches by any
  other path reintroduces double-dispatch against a seat's own standing orders.
- **`heldByTeam` needs the board and a team set.** The evaluator therefore needs a DB handle in
  both hosts, not just fleet liveness. `_getKanbanDb(wsRoot)` is the existing path.
- **A job with no the automation switch** behaves exactly as today. Asserted, not assumed — this is what makes the
  change safe for existing installs.
- **A job in `propose` mode** must never call an action branch. The propose path has
  to be a hard gate before the switch, not a flag checked inside each branch.
- **A scope with no seat of its roles.** `planning + coding` with no planner seated is *unknown*,
  not *idle*. Same fail-closed rule as an empty fleet.
- **Multiple rules matching on one tick.** Evaluate all, act on at most one per tick, in job order,
  so two rules cannot both dispatch into a fleet that had room for one.

## Proposed Changes

### 1. Session state, not persisted config

```ts
// in-memory on the provider, cleared on restart:
{ scope: 'plan+code' | 'code', mode: 'off' | 'propose' | 'act' }   // default: mode 'off'
```

Two enums, and **nothing is written to disk**. No `ScheduledJob` field, no `SchedulerConfig` change,
no `SCHEDULER_SCHEMA_VERSION` bump, no unknown-key preservation, no migration for ~4,000 installs —
the entire class of concern disappears because the setting does not outlive the session that set it.
That matches the terminals it governs, which do not survive a restart either.

### 2. New `src/services/RunReadiness.ts` — the predicate, in code

```ts
runIsIdle(scope, snapshot): { idle: boolean; reason: string } | { unknown: string }
```

One function, no configuration reaching it. The run is idle when **no seat holding one of the
scope's roles holds an uncompleted card** — `heldByTeam` (`LocalApiServer.ts:76`) over the board,
filtered by role:

| Scope | Roles that hold the run |
| :--- | :--- |
| `planning + coding` | `planner`, `lead`, `coder`, `intern`, `reviewer` |
| `coding only` | `lead`, `coder`, `intern`, `reviewer` |

**Planning and coding are one run, not two lanes.** A card goes CREATED → planner → PLAN REVIEWED →
coder → coded → reviewer, and the two rules the controller applies today are two steps of that one
pipeline. Modelling them as independent switches invented a distinction the system does not have.

**Reviewers hold the run**, because they write source into the same tree a coder would start in —
see `agent-commits-sweep-the-whole-shared-tree.md`, where one seat's `git add -A` swept 255 lines of
a peer's in-flight work into an unrelated commit.

Takes a snapshot (`{ seats, board, teamMembers }`), not services, so it is unit-testable with no
host and both roots hand it the same shape. Missing inputs return `unknown`, and `unknown` is never
treated as idle.

**The lock is global.** Worktrees are opt-in, bounded and mission-owned — `stageForQueue`
(`KanbanProvider.ts:8667`) provisions none, and *"opt-in provisioning belongs on the mission
(`maxExtraWorktrees`, 0 by default)."* Parallel checkouts come from a curated mission with
dependency edges, never from a setting a scheduler reads, so `runIsIdle` computes over the whole
fleet and reads no worktree mode.

### 3. `src/services/TaskViewerProvider.ts` — tick integration

In `_tickSurvivorSchedulerJobs`, before the interval check:

- Job has no the automation switch → today's path, untouched.
- Automation on → resolve `runIsIdle(scope, snapshot)`.
  - Not free, or unknown → record `lastOutcome` as the reason; do not advance `lastRunAt`.
  - Free, `mode: 'propose'` → record `lastOutcome: "would <action>"`; do not act.
  - Free, `mode: 'act'`, interval elapsed → run the existing action branch unchanged.

`lastOutcome` is already a persisted field the UI reads, so the dry-run trail needs no new store.

### 4. Both composition roots

Wire the snapshot resolver (fleet + board) in `TaskViewerProvider` and in `bootstrap.ts`. Diff the
two roots by hand, as `CLAUDE.md` requires — verb reachability will not show this.

## Verification Plan

### Automated Tests

1. **The run is not idle while a REVIEWER holds an uncompleted card.** The specific regression this
   plan was corrected for: a model that reads only coding roles dispatches a coder into a tree a
   reviewer is editing, and every fleet-shaped test still passes.
2. **The run is not idle when one of its seats holds an uncompleted card**, with every seat's `status`
   set to `'active'`. This is the plan's central defect pinned directly: a status-based
   implementation passes every other test and fails only this one.
3. **`RunReadiness` never reads `feature_worktree_mode`.** Source-level. A legacy `'per-feature'`
   value left on an old install must not mark the run idle while its tree is occupied — and since no UI can
   set that value any more, such installs are the only ones that carry it.
4. **A busy seat on team A holds the run for team B.** One tree, one lock. The assertion that
   stops a per-team implementation from looking correct on a single-team fixture.
5. **Empty fleet → `unknown` → no fire,** for both scopes. The dead-pty-host
   mass-dispatch guard.
6. **A job with no the automation switch is byte-for-byte unchanged in behaviour** — same fire times, same
   `lastRunAt` advancement. The ~4,000-install regression gate.
7. **Propose gate:** an idle run in `propose` mode records a `would …` outcome and calls **no** action
   branch. Asserted by spying on the branch, not by observing absence of side effects.
8. **Throttle:** a continuously-idle run fires at most once per `intervalMinutes`.
9. **At most one action per tick** when several rules match.
10. **Both roots wire the resolver.** A source-level assertion that the seam is set in
   `TaskViewerProvider.ts` *and* `bootstrap.ts`. This is the only gate that can catch the
   composition-root divergence, and its absence is the documented precedent.
11. **Unknown-key preservation:** round-trip a `SchedulerConfig` carrying a future key and assert it
   survives a write.
12. **Evaluator runs after `DROPPED_SOURCES` filtering.**

### Goal Invariants

- Both rules the controller applies today are expressible with no code change: *"if free planner
  team, dispatch work"* and *"if no one is coding, dispatch"* are two steps of one pipeline, both
  covered by `planning + coding`. Neither needs a condition to be authored.
- No rule can dispatch except through `dispatchNextFromQueue` / `launchMission`.
- No user-authored string is evaluated as code.
- **Nothing fires on time alone.** The automation acts only while the run is idle; the
  interval is a floor on frequency, never a trigger. This is the property that distinguishes the
  rule from the clock that was deleted, and it is asserted, not asserted-about.

### Manual — does it reproduce the controller?

The real acceptance test is agreement with the agent it replaces, so run them side by side.

- Leave the controller agent running as it is today, with the automation on *propose*. Over a working
  session, compare each `would …` outcome against what the controller actually did. They should
  agree every time. A disagreement is the interesting artifact: either the rule is wrong, or the
  agent was — and the second case is the argument for the whole plan.
- Note where they cannot agree by construction. The controller reads
  `.switchboard/logs/<seat>.md` and `git log` for its *narrative* reports; the rules read board and
  fleet state only. Anything the controller decides from a log tail is judgement that stays with it,
  and should be visible in this comparison as a decision the rules never claim to make.
- Only switch to *act* once the two have agreed across a full session.

### The predicate is not reachable from configuration

One assertion earns its own heading because it is the whole reason the surface is two enums rather
than a settings panel: **no stored value can make `runIsIdle` return idle for a busy run.** Assert it
by handing `RunReadiness` a session state carrying arbitrary extra keys and confirming it reads none
of them — its only inputs are the snapshot and the scope. A user cannot configure their way onto a
busy seat.
