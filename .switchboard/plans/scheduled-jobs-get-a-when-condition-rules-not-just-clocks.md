# The controller's mechanical checks become code — a `when` condition on scheduled jobs

## Goal

Take the part of the Mission Control controller that is not judgement — read the fleet, decide
whether anyone is working, dispatch if not — and make it deterministic code. The mechanism is a
declared `when` condition on `ScheduledJob`, evaluated against live fleet and board state. Ship it
dry-run first: a job with a `when` evaluates on every tick and records what it *would* have done,
and does not act until it is armed.

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

- **No expression language, no parser, no `eval`.** Conditions are a fixed, closed set of named
  checks combined with AND. Nothing user-authored is executed.
- **Not a second dispatcher.** Rules select *when*; the existing action branches keep selecting
  *what* and *where*, and dispatch keeps flowing through `dispatchNextFromQueue` /
  `launchMission`.
- **Not the turn-end trigger.** Tick-only here; `rule-state-surfaces-in-the-dock-and-arms-to-act.md`
  adds the state-change trigger and the arming UI.
- **Not deleting `intervalMinutes`.** A rule with a `when` still respects its interval as a floor —
  see the throttle note below.
- **Not retiring the controller agent.** Only its mechanical loop moves. Judgement — planner-stage
  questions, escalation, merge conflicts, what to seat, what to group — stays with the agent, and
  this plan removes none of it. The controller keeps running; it stops re-deriving facts.
- **Not replicating the controller's narrative reports.** Its log-tail and `git log` reads produce
  prose for a human. Rules read board and fleet state and emit a verdict. Anything that needs a
  log tail to decide is, by that fact, in the 20% that stays.

## Metadata

**Complexity:** 6
**Tags:** backend, reliability, api, feature, devops

## User Review Required

- **Confirm the initial condition set.** Proposed: `noSeatCoding`, `noSeatReviewing`,
  `roleIdle: <role>`, `columnNonEmpty: <COLUMN>`, `columnEmpty: <COLUMN>`. The first two plus
  `roleIdle: planner` cover both rules as originally stated.
- **Confirm AND-only.** Every ticked condition must hold. No OR, no negation beyond the paired
  empty/non-empty checks. This keeps the dock's rendering a plain English list.
- **Confirm dry-run is the default for a job that gains a `when`,** including on upgrade.

## Complexity Audit

### Routine

- Adding an optional field to an interface and threading it through read/write.
- Rendering condition names as English in a UI list.

### Complex / Risky

- **`SchedulerConfig` is persisted, shipped state on ~4,000 installs.** `schemaVersion` /
  `SCHEDULER_SCHEMA_VERSION` (`:82-88`) exists as the migration branch point. `when` is optional and
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
  down. An empty fleet must evaluate `noSeatCoding` as **unknown → do not fire**, never as **true →
  fire**. `_runFeatureNudgeSweep` already encodes this lesson (`:924-931`: an empty liveness
  snapshot is *no evidence*, not "every head died"). Getting this backwards means a dead pty host
  dispatches everything at once.
- **Throttle.** A `when`-driven job whose condition stays true would fire every tick. `lastRunAt`
  plus `intervalMinutes` must remain a floor, so a rule fires at most once per interval even while
  its condition holds continuously.

## Edge-Case & Dependency Audit

- **Serialization.** Every rule-driven action must reach dispatch through
  `dispatchNextFromQueue` / `launchMission`, both of which sit behind the module-level promise chain
  (`LocalApiServer.ts:59-67`) — *"the single serialization point."* A rule that dispatches by any
  other path reintroduces double-dispatch against a seat's own standing orders.
- **`heldByTeam` needs the board and a team set.** The evaluator therefore needs a DB handle in
  both hosts, not just fleet liveness. `_getKanbanDb(wsRoot)` is the existing path.
- **A job with no `when`** behaves exactly as today. Asserted, not assumed — this is what makes the
  change safe for existing installs.
- **A job with a `when` and no armed flag** must never call an action branch. The dry-run path has
  to be a hard gate before the switch, not a flag checked inside each branch.
- **Condition naming a role no seat has.** `roleIdle: planner` with no planner seated is *unknown*,
  not *idle*. Same fail-closed rule as an empty fleet.
- **Multiple rules matching on one tick.** Evaluate all, act on at most one per tick, in job order,
  so two rules cannot both dispatch into a fleet that had room for one.

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — the field

```ts
export type RuleCondition =
    | { kind: 'noSeatCoding' }
    | { kind: 'noSeatReviewing' }
    | { kind: 'roleIdle'; role: string }
    | { kind: 'columnNonEmpty'; column: string }
    | { kind: 'columnEmpty'; column: string };

// on ScheduledJob:
when?: { all: RuleCondition[]; armed: boolean };
```

Optional and additive. Read path preserves unknown keys; no `SCHEDULER_SCHEMA_VERSION` bump.

### 2. New `src/services/RuleEvaluator.ts` — pure and host-agnostic

`evaluate(conditions, snapshot): { matched: boolean; reasons: string[]; unknown: string[] }`

Takes a **snapshot** (`{ seats, board, teamMembers }`), not services — so it is unit-testable with
no host, and both roots hand it the same shape. `noSeatCoding` / `noSeatReviewing` are computed
from `heldByTeam` over the board, filtered by role. Any condition whose inputs are missing lands in
`unknown`, and a non-empty `unknown` means `matched: false`.

### 3. `src/services/TaskViewerProvider.ts` — tick integration

In `_tickSurvivorSchedulerJobs`, before the interval check:

- Job has no `when` → today's path, untouched.
- Job has a `when` → build the snapshot, evaluate.
  - Not matched → record `lastOutcome` as the failing reason; do not advance `lastRunAt`.
  - Matched but `armed: false` → record `lastOutcome: "would <action>: <reasons>"`; do not act.
  - Matched and armed and interval elapsed → run the existing action branch unchanged.

`lastOutcome` is already a persisted field the UI reads, so the dry-run trail needs no new store.

### 4. Both composition roots

Wire the snapshot resolver (fleet + board) in `TaskViewerProvider` and in `bootstrap.ts`. Diff the
two roots by hand, as `CLAUDE.md` requires — verb reachability will not show this.

## Verification Plan

### Automated Tests

1. **`noSeatCoding` is false when a seat holds an uncompleted card**, with every seat's `status`
   set to `'active'`. This is the plan's central defect pinned directly: a status-based
   implementation passes every other test and fails only this one.
2. **Empty fleet → `unknown` → no fire.** Both for `noSeatCoding` and `roleIdle`. The dead-pty-host
   mass-dispatch guard.
3. **A job with no `when` is byte-for-byte unchanged in behaviour** — same fire times, same
   `lastRunAt` advancement. The ~4,000-install regression gate.
4. **Dry-run gate:** a matched, unarmed job records a `would …` outcome and calls **no** action
   branch. Asserted by spying on the branch, not by observing absence of side effects.
5. **Throttle:** a continuously-true condition fires at most once per `intervalMinutes`.
6. **At most one action per tick** when several rules match.
7. **Both roots wire the resolver.** A source-level assertion that the seam is set in
   `TaskViewerProvider.ts` *and* `bootstrap.ts`. This is the only gate that can catch the
   composition-root divergence, and its absence is the documented precedent.
8. **Unknown-key preservation:** round-trip a `SchedulerConfig` carrying a future key and assert it
   survives a write.
9. **Evaluator runs after `DROPPED_SOURCES` filtering.**

### Goal Invariants

- Both rules the controller applies today are expressible with no code change: *"if free planner
  team, dispatch work"* → `roleIdle: planner` + `columnNonEmpty: CREATED`; *"if no one is coding or
  reviewing, dispatch"* → `noSeatCoding` + `noSeatReviewing`.
- No rule can dispatch except through `dispatchNextFromQueue` / `launchMission`.
- No user-authored string is evaluated as code.
- **Nothing fires on time alone.** A job carrying a `when` acts only when its conditions hold; the
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
