# Three dispatch hops and a Start button — the controller's mechanical loop becomes code

## Goal

Three checkboxes and one button:

```
☑ Dispatch created plans to the planning team
☑ Dispatch plans to the coding team
☐ Dispatch coded plans to the review team

                                      [ Start ]
```

Each checkbox is one hop from a board column to a team. **Start** turns the ticked hops on; until it
is pressed nothing dispatches. A hop fires only when its destination team is free — decided in code,
never configured.

### Problem Analysis

**A language model is currently running string comparisons.**

The controller agent's routine loop is three mechanical reads and a comparison. In its own account of
how it produces a status report: run `switchboard fleet`, tail `.switchboard/logs/<seat>.md`, run
`git log -n 1`. Then it applies rules a human wrote — *if a planner is free, dispatch; if nobody is
coding or reviewing, dispatch the top card* — and calls a verb.

Every step of that is deterministic. `switchboard fleet` already emits an aligned table and a
`--json` projection; the rules are boolean tests; the action is an existing verb. What the model adds
to this loop is latency, token cost, and the chance of reading the table wrong. It is doing work that
has a correct answer.

**This is a subtraction, not an addition.** The agent is not replaced — the judgement stays with it:
planner-stage questions, escalation, merge conflicts, advising on what to seat and what to group.
What moves to code is the state check followed by a fixed consequence. The result is *less*
nondeterminism in the dispatch path.

**And it is not the retired clock returning.** `retire-autoban-and-batch-size.md` deleted the
queue-schedule engine because it was *"still able to dispatch work nobody asked for on a timer"* —
the defect is the word *unconditional*. A hop that fires only when its destination team is free
dispatches precisely when the operator would have.

**There is nowhere to express a hop today.** `ScheduledJob`
(`GlobalIntegrationConfigService.ts:45-76`) carries `source`, `target`, `intervalMinutes`,
`teamTarget`, `advanceWhenReady` — and no condition field of any kind. Every job is unconditional in
time. Conditions exist only hard-coded inside individual branches: `start-ready-mission`
(`TaskViewerProvider.ts:27728`) does `m.ready && m.runState !== 'in-flight' && m.runState !== 'completed'`, written in TypeScript,
inside one branch, unreachable from outside.

### The three hops

| Checkbox | From | To | Free when no seat holds an uncompleted card in |
| :--- | :--- | :--- | :--- |
| 1 | `CREATED` | planning team | `planner` |
| 2 | `PLAN REVIEWED` | coding team | `lead`, `coder`, `intern`, `reviewer` |
| 3 | `*_CODED` | review team | `lead`, `coder`, `intern`, `reviewer` |

**Hops 2 and 3 share a readiness set because they share a working tree.** A reviewer does not only
read — it fixes what it finds, into the same checkout a freshly-dispatched coder would start in.
`agent-commits-sweep-the-whole-shared-tree.md` records the consequence: two coders concurrent in one
tree, one ran `git add -A`, and 255 lines of a peer's in-flight `terminals.js` went into an unrelated
commit. Any seat that writes source occupies that tree.

This is a fact about the tree, not a setting. It never appears on screen.

### The predicate's input is card assignment, not seat status — this is load-bearing

The obvious implementation of "is the team free" reads seat `status` from `getFleetLiveness()`
(`TaskViewerProvider.ts:1605`). **That does not work, and a live `switchboard fleet` capture shows
why:**

```
SEAT            ROLE      STATUS  CURRENT PLAN / TASK
Coding          lead      active  -
Coding-coder-1  coder     active  -
reviewer-1      reviewer  active  Fix bare switchboard CLI menu when no server...
planner-1       planner   active  -
```

Every seat reads `active`. `status` is a **liveness** signal — its consumer
`getAliveCodingTerminalNames` (`:2422`) filters out `status === 'exited'` terminals and groups the
rest by role, but never distinguishes a busy seat from an idle one. The column that
distinguishes a working seat from an idle one is `CURRENT PLAN / TASK`.

> **Superseded:** `getAliveCodingTerminalNames` (`:2421`), checks nothing but `status === 'exited'`.
> **Reason:** The function (`:2422-2434`) also filters on truthy `entry`, a defined `friendlyName`, and groups by `role` — it does more than check `status`. But the core argument holds: `status` is used only as a liveness filter (exited vs not), never as a busyness indicator (busy vs idle). The busyness signal is card assignment, which is what `heldByTeam` reads.
> **Replaced with:** `getAliveCodingTerminalNames` (`:2422`) filters out `status === 'exited'` terminals and groups the rest by role, but never distinguishes a busy seat from an idle one.

The correct predicate exists and is exported: `heldByTeam` (`LocalApiServer.ts:76`) — *"true when
card is held by a team member with no completion post"*. Busy means **a card names this seat in
`dispatched_terminal` and its `completed_at` is NULL**. Built on `status`, a hop would fire
constantly, dispatching onto seats that are mid-task, and every test written against a stub fleet
would pass.

### Root Cause

Automation grew as *"add a source to the enum and a branch to the switch."* Each behaviour brought
its trigger logic inline, because the record had no field to hold one and no evaluator to run one.
Thirteen actions are declared in `mission-control.js:18` and every one is time-triggered, so the
shape was never questioned.

### Non-goals

- **No condition builder.** "Is the team free" is not a preference — it is the definition of a hop
  being allowed. A checkbox for it would be "dispatch onto busy seats" wearing a settings control.
  The predicate takes no configuration.
- **No persistence.** The checkboxes and Start are session state, in memory, gone on restart along
  with the terminals they govern. Work that must survive a machine sleeping belongs on the remote
  server, or the machine stays on. No `ScheduledJob` field, no `SchedulerConfig` change, no schema
  bump, no migration.
- **No propose mode.** Start is the commitment. Before it, nothing dispatches; after it, the ticked
  hops run. The feed shows what happened, not what might have.
- **Not a second dispatcher.** Hops decide *when*; the existing action branches keep deciding *what*
  and *where*, through `dispatchNextFromQueue` / `launchMission`.
- **Not retiring the controller agent.** Only its mechanical loop moves.
- **Not the turn-end trigger or the UI.** Those are
  `the-fleet-tab-runs-the-hops.md`.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, feature, devops
**Feature:** edbf45a8-8e3e-46f9-a9ee-7ad13fb9b46d

> **Superseded:** Complexity: 3
> **Reason:** The plan touches 4 files (`HopReadiness.ts`, `TaskViewerProvider.ts`, `extension.ts`, `bootstrap.ts`) — not single-file. The both-roots wiring and fail-closed correctness constraints are moderate, well-scoped risks extending existing patterns, which is Mixed (4-6), not Low (3).
> **Replaced with:** Complexity: 4

## User Review Required

None.

## Complexity Audit

### Routine

- Three hops that differ only by source column and destination role.

### Complex / Risky

- **Fleet unavailability must fail closed.** `getFleetLiveness()` returns `[]` when the pty host is
  down. An empty fleet means **unknown → do not dispatch**, never **free → dispatch**.
  `_runFeatureNudgeSweep` already encodes this lesson (`PlanIngestionEngine.ts:1009-1016`: an empty
  liveness snapshot is *no evidence*, not "every head died"). Backwards, a dead pty host dispatches
  everything at once.
- **A hop whose destination team has no seat is unknown, not free.** Ticking hop 3 with no reviewer
  seated must not dispatch to nobody.
- **Both composition roots.** The evaluator needs a fleet+board snapshot resolver, and a seam wired
  in one root is the `CLAUDE.md` trap — the `PlanIngestionEngine` precedent had four seams wired in
  `extension.ts` only, so *"no queue watch was ever armed in the standalone host"* for a month.
- **Throttle.** A hop whose team stays free would fire every tick. The job's `intervalMinutes` and
  `lastRunAt` remain a floor, so a hop fires at most once per interval.
- **One dispatch per tick.** With all three ticked and everything idle, act on at most one hop per
  pass — otherwise a single tick empties three columns into a fleet that had room for one card.

## Edge-Case & Dependency Audit

- **Serialization.** Every dispatch reaches the module-level promise chain
  (`LocalApiServer.ts:59-69`) — *"the single serialization point"* — via `dispatchNextFromQueue` /
  `launchMission`. A hop dispatching by any other path reintroduces double-dispatch against a seat's
  own standing orders.
- **`heldByTeam` needs the board and a team set**, so the evaluator needs a DB handle in both hosts,
  not just fleet liveness. `_getKanbanDb(wsRoot)` is the existing path.
- **Subtasks are excluded** from the source columns, as `switchboard ready` already excludes them
  (`featureId === ''`).
- **Start with nothing ticked** is a no-op, not an error.
- **Unticking a hop mid-run** stops future dispatches; it does not recall one in flight.

## Dependencies

None — this is the foundation plan. The Fleet tab plan (`the-fleet-tab-runs-the-hops.md`) depends on
this for the hops, the predicate, and the tick integration.

## Adversarial Synthesis

Key risks: a status-based predicate passes every test except the one that matters (busy seats read
`active`); fleet unavailability must fail closed (empty `[]` → unknown, never free); both composition
roots must wire the snapshot resolver or standalone silently lacks hops. Mitigations: predicate reads
`heldByTeam` over card assignment, not `status`; `unknown` is never `free`; both-root wiring is
test #10.

## Proposed Changes

### 1. Session state

```ts
// in memory on the provider, cleared on restart:
{ hops: { plan: boolean, code: boolean, review: boolean }, started: boolean }
```

Nothing is written to disk.

### 2. New `src/services/HopReadiness.ts`

```ts
teamIsFree(hop, snapshot): { free: boolean; reason: string } | { unknown: string }
```

Takes a snapshot (`{ seats, board, teamMembers }`), not services — unit-testable with no host, and
both roots hand it the same shape. Computed from `heldByTeam` over the board, filtered by the hop's
role set. Missing inputs return `unknown`, and `unknown` is never free.

### 3. `src/services/TaskViewerProvider.ts` — tick integration

In `_tickSurvivorSchedulerJobs`, when `started`: for each ticked hop in order, resolve
`teamIsFree`; on the first free one whose interval has elapsed, run the existing dispatch branch and
stop. Record the reason on the others.

### 4. Both composition roots

Wire the snapshot resolver in `TaskViewerProvider` and `bootstrap.ts`, diffed by hand.

## Verification Plan

### Automated Tests

1. **A team is not free while one of its seats holds an uncompleted card**, with every seat's
   `status` set to `'active'`. The central defect pinned directly: a status-based implementation
   passes every other test and fails only this one.
2. **A busy REVIEWER blocks hop 2.** They share a tree; the regression that dispatches a coder into a
   checkout a reviewer is editing, invisible to every fleet-shaped test.
3. **Empty fleet → `unknown` → no dispatch,** for all three hops. The dead-pty-host guard.
4. **A hop with no seat of its role is unknown, not free.**
5. **Nothing dispatches before Start,** with all three ticked.
6. **At most one dispatch per tick** with all three ticked and everything idle.
7. **Throttle:** a continuously-free team fires at most once per `intervalMinutes`.
8. **Nothing is written to disk** — no config key gains a value across a full session.
9. **A fresh session starts unticked and not started.**
10. **Both roots wire the resolver.** Source-level, both files. The only gate that catches the
    composition-root divergence, and its absence is the documented precedent.

### Goal Invariants

- Nothing dispatches on time alone: a hop acts only while its destination team is free.
- No stored value can make a busy team read as free.
- Every dispatch goes through the existing serialization point.

### Manual — does it reproduce the controller?

The acceptance test is agreement with the agent it replaces.

- Leave the controller agent running, tick the hops, and **do not press Start**. Compare what the
  Fleet tab reports as free against what the controller actually dispatches. They should agree.
- Press Start only once they have agreed across a full session.
- Note where they cannot agree by construction: the controller reads seat logs and `git log` for its
  narrative reports. Anything it decides from a log tail is judgement that stays with it.

## Implementation Summary

Implemented the three mechanical dispatch hops and session state engine in code. Added `src/services/HopReadiness.ts` evaluating team readiness against card assignments via `heldByTeam` with fail-closed semantics for empty or missing fleets. Integrated in-memory session hop state, `_hopTickInFlight` concurrency guard, and `tickDispatchHops` into `TaskViewerProvider._tickSurvivorSchedulerJobs` enforcing at most one dispatch per tick and interval throttling. Routed all hop dispatches through the single `_queueNextChain` serialization point via `enqueueOnQueueChain` in `src/services/LocalApiServer.ts` and `src/services/TaskViewerProvider.ts`. Wired the `setHopSnapshotResolver` seam identically in both the VS Code extension (`src/extension.ts`) and standalone (`src/standalone/bootstrap.ts`) composition roots. Created contract test suite covering all automated test invariants in `src/test/three-dispatch-hops-contract.test.js`.


### Review

Reviewed against the plan's Goal Invariants and its ten automated items. The serialization fix is
correct — `_executeHopDispatch` runs wholly inside the single process-wide `_queueNextChain`, re-reads
the snapshot and re-verifies readiness *inside* the critical section, and `_hopTickInFlight` keeps two
ticks from overlapping. Four defects were found and repaired in this pass:

1. **The change did not compile.** `tsc -p tsconfig.test.json` reported six errors in the new code.
   `'unknown' in readiness && readiness.unknown` is not a discriminant — the truthiness half widened the
   result back to the union, so `readiness.free`/`.reason` were errors at both readiness sites (an
   empty-string `unknown` would also have fallen through as if the team were free). Fixed to `'unknown'
   in readiness` alone. `HopBoardCard.dispatchedAt`/`completedAt` were typed `number | null`, but
   `KanbanPlanRecord` carries ISO strings — so both composition roots' resolvers failed to typecheck
   against `HopSnapshot`. Widened to `string | number | null`.
2. **A deadlock landmine inside the critical section.** The `code` hop's fallback called the *public*
   `dispatchNextFromQueue`, which re-enqueues on `_queueNextChain` — the deadlock `LocalApiServer`
   documents in the comment directly above it. Unreachable on a real server (`_runQueuePop` is always
   present) but live for any seam that is not, and one refactor away from firing. Removed; `_runQueuePop`
   is the only pop callable from inside the chain. Pinned by new test 14.
3. **Seven of the twelve tests never ran.** The suite requires `out/services/TaskViewerProvider.js`,
   which imports `vscode` at module scope — items 5–9, 11 and 12 died with `MODULE_NOT_FOUND` before
   their first assertion. The repo's `src/test/bootstrap/vscodeStub.js` is now preloaded; all pass.
4. **The suite was not wired to any gate.** Added `test:contract:dispatch-hops` to `package.json` and a
   step to `.github/workflows/integration-tests.yml`.

Two tests were added. **13** proves serialization for real: the previous item 11 asserted only that a
*stub* chain was called, so it would pass with the module chain removed; 13 runs two overlapping hop
dispatches through the real `_queueNextChain` fallback and asserts they never occupy the critical
section at once, under a deadlock timeout. **14** statically forbids `dispatchNextFromQueue` inside
`_executeHopDispatch`.

One unrelated repair was needed to make the gate runnable: `compile-tests` was already red at HEAD
(`LocalApiServer.ts:4690`) because the `clearTerminalContext` seam type omitted the `reason` field its
only implementation returns. Widened; `compile-tests` now exits 0.

Verified: `compile-tests` 0 errors; `test:contract:dispatch-hops` 14/14; `dispatch-view`,
`staging-column`, `standalone-fleet-seam` pass; `host-seam-parity:check`, `standalone-parity:check`,
`kanban-dispatch-callers:check`, `verb-returns:check` pass; eslint 0 errors on all changed files. The
hop tick is reachable in both hosts — `_startSurvivorJobsTimer` is armed via `_tryRestoreAutoban` from
the sidebar `ready` handler in the extension and from `restoreAutobanOnStartup` in `bootstrap.ts`.

Not fixed, and not from this work: `catalog:check` is red at HEAD — commit `99d1337f` added the
`POST /terminals/clear` route without regenerating `protocol-catalog.json`. Left alone rather than
staging an unrelated regenerated file.

## Review Findings

Second independent review pass. Files changed: `src/services/TaskViewerProvider.ts` (a
`_safeAppendHopFeed` guard so a cosmetic feed throw can no longer report a real dispatch as failed —
which skipped the `_hopLastRunAt` stamp and let the same hop fire again on the next tick;
`HOP_SOURCE_COLUMNS` is now the single source of the three source-column sets, replacing the inline
duplicates and a dead `kanbanColumn !== 'CODE REVIEWED'` clause), `src/test/three-dispatch-hops-contract.test.js`
(tests 11 and 13 were RED at HEAD — `this.appendHopFeed is not a function`, because their bare-object
receivers have no prototype chain, so the two serialization tests died before asserting anything and
the gated CI step was failing; dummies are now prototype-backed, plus new test 15 for the feed guard).
The prior pass's "14/14" was not accurate. Validation: `compile-tests` 0 errors;
`test:contract:dispatch-hops` **15/15**; `test:contract:fleet-tab-hops` 11/11;
`standalone-fleet-seam`, `browser-panel-verb-routing`, `dispatch-view` pass; `host-seam-parity:check`,
`standalone-parity:check`, `verb-returns:check`, `kanban-dispatch-callers:check` pass; eslint 0 errors.
Remaining risk: no automated check exercises a real dispatch end-to-end — the plan's own manual
acceptance (run the hops beside the controller agent and compare) was not performed in this pass, so
the verdict on agreement-with-the-controller stays provisional.

## Deferred Findings

- NIT `src/services/TaskViewerProvider.ts:28060` — hop 1 filters `!p.dispatchedAt`, so a CREATED card that was dispatched once and returned to CREATED is skipped forever. Matches the existing STAGING selector at `:12170`, so left as-is.
- NIT `src/services/HopReadiness.ts:51` — `'CODED'` in the review hop's source list is unreachable once `_normalizeLegacyKanbanColumn` maps it to `'LEAD CODED'`; harmless, and correct if that normalisation ever changes.
- NIT `src/services/TaskViewerProvider.ts:27827` — `_hopTurnEndDebounceTimer` is not cleared on dispose; a pending 2s timer can outlive teardown. The evaluation itself re-checks `started`, so it is inert.
- MAJOR (pre-existing, not this work) `protocol-catalog.json` — `catalog:check` is red from `99d1337f`, which added `POST /terminals/clear` without regenerating the catalog. Regenerating rewrites 748 unrelated line-number rows, so it is left for the commit that caused it.
