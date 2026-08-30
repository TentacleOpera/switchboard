# Completion Is Asserted, Never Inferred

**Complexity:** 6

## Goal

Make an explicit completion post the only way the system learns that work finished, and remove every path that infers it from board position or a stale field. Silence gets a defined meaning - it halts rather than advancing. This closes a whole category of false progress: cards that advance because a column looked right, and work reported done because nothing said otherwise.

## How the Subtasks Achieve This

- **Completion is asserted, never inferred, and silence halts** — the anchor: removes every path that infers completion from board position or a stale field, and gives silence a defined meaning.
- **Add a task-complete endpoint the lead posts to** — the explicit signal the anchor makes exclusive; its own Dependencies mark it a precondition rather than a peer.
- **Revise the in-flight plans for asserted completion** — amends three already-written plans whose premise this feature changes; the deliverable is edited plan files, not code.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add a task-complete endpoint the lead posts to](../plans/add-a-task-complete-endpoint-for-the-lead.md) — **CODE REVIEWED** — ID: 4e00f321-0987-43a9-a8b7-38a4e1125b24
- [ ] [Completion is asserted, never inferred — and silence halts](../plans/completion-is-asserted-never-inferred.md) — **CODE REVIEWED** — ID: aa1f49da-ae96-4db1-b0f1-f6829078fd27
- [ ] [Revise the in-flight plans for asserted completion](../plans/revise-the-in-flight-plans-for-asserted-completion.md) — **CODE REVIEWED** — ID: df870968-3e92-4e60-8053-038b0528c562
<!-- END SUBTASKS -->

## Dependencies & sequencing

Hard chain: the endpoint lands first, then the anchor.

**The revision subtask is a gate on work outside this feature.** Its own Ordering section says to amend after the anchor is accepted and before any of the three affected plans are coded. Two of those three are the subtasks of **Two Board-State Inferences of Completion, Removed**; the third is the Mission cards subtask of **Worktrees Consolidate to Two Models, and Streams Become a Stage Map**. Neither of those features should be coded until this revision has landed. The revision also checks board state before editing, so a plan already mid-implementation is recorded as a follow-up rather than rewritten under a coder.

## Team Dispatch Instructions

### Subtask 1: Add a task-complete endpoint the lead posts to
- **Seat:** Coder (Complexity 4)
- **Ship order:** First — adds the `completed_at` column and the endpoint the anchor depends on.
- **Acceptance criteria:**
  - `POST /kanban/task/complete` accepts `{ from, planId, workspaceRoot?, outcome?, note? }` and returns the recorded state.
  - `completed_at` timestamp column added to the plans table (additive, NULL = not completed).
  - In-flight scan at `LocalApiServer.ts:1868-1882` honours `completed_at` (adds `&& !p.completedAt`).
  - Idempotent: repeat call with same `planId` returns existing record, no double-write.
  - No dispatch, no column move.
  - `queue/done` untouched; its existing tests pass.
  - Auth and validation: unauthenticated refused, invalid `workspaceRoot` refused, `planId` with path separators refused.
- **Scope constraints:** Does NOT touch the head order text (the anchor retires the report-file instruction). Does NOT dispatch. Does NOT move cards. The `completed_at` column is the only schema change.

### Subtask 2: Completion is asserted, never inferred — and silence halts
- **Seat:** Coder (Complexity 6)
- **Ship order:** Second — after the endpoint has shipped `completed_at`.
- **Acceptance criteria:**
  - No consumer derives completion from a kanban column or `dispatched_at`.
  - In-flight scan reads `completed_at`; NULL means busy (team stays held).
  - Seat-pacing skip at `LocalApiServer.ts:1700-1705` deleted.
  - `stopReason` field added to `_autobanState` in `TaskViewerProvider.ts`; set on every automation self-stop.
  - Halt surfacing: `_stopAutobanEngine()` + `enabled: false`, relay to Mission Control gated on `_hasMissionControl()`, reason recorded regardless.
  - Stall classification routed through `notifyTurnEnd`'s existing `'stalled'` outcome.
  - Report-file instruction retired in head order (`teamWiring.ts:798, :851`).
  - A halt is visible without reading terminal scrollback.
- **Scope constraints:** Depends on subtask 1's `completed_at` column. Lands with `remove-the-seat-orders-code-reviewed-clause.md` (external plan). Does NOT add a new endpoint (uses subtask 1's). Does NOT build a second stall detector.

### Subtask 3: Revise the in-flight plans for asserted completion
- **Seat:** Intern (Complexity 3)
- **Ship order:** Third — after the anchor is accepted, before any of the three target plans are coded.
- **Acceptance criteria:**
  - `staging-streams-parallel-dispatch-and-worktrees.md` amended: stream columns replaced with dependency edges, `base_branch` argument superseded with note, complexity re-scored, parallel-consumer findings preserved verbatim.
  - `remove-the-seat-orders-code-reviewed-clause.md` amended: framed as first application of the category rule.
  - `the-automation-model-four-things-not-a-mode-axis.md` amended: selector refinement for STAGING queue-order.
  - No amended plan has lost the findings it was written to record.
  - No plan already in implementation is rewritten under its coder (board-state check before editing; append where work has started).
  - Each amendment states why the premise changed, not merely what changed.
- **Scope constraints:** Deliverable is edited plan files, not code. Does NOT amend `add-a-task-complete-endpoint-for-the-lead.md` (precondition relationship already recorded in the anchor's Dependencies). Does NOT perform the streams plan split (records it as a recommendation only).

## Review Findings

Reviewed all three subtasks in place; no CRITICAL findings — the schema is additive, `PLAN_COLUMNS`/`_readRows` are single-sourced, both plan UPSERTs omit `completed_at` from `DO UPDATE SET` (so the plan-file watcher cannot clobber it), and `setCompletedAt` has exactly one caller. Four MAJOR findings were fixed: `PlanIngestionEngine.ts` kept a second, column-scoped copy of the in-flight predicate that read a completed card as in-flight forever and permanently muzzled the queue-watch stall nudge (`src/services/PlanIngestionEngine.ts:1743`, now keyed on `!p.completedAt` with the orphaned `CODING_COLUMNS` const removed); `stopReason` was never cleared, so a recorded halt survived re-arming (`src/services/TaskViewerProvider.ts` `_startAutobanEngine`); the CI-wired gate `test:contract:standing-orders-marker` was RED at HEAD because it still pinned the deleted `/kanban/dispatch` + `CODE REVIEWED` head-order contract (now repointed at `POST /kanban/task/complete`, 64 passed / 0 failed); and the category assertion was scoped to `LocalApiServer.ts` alone, which is why the second consumer shipped green — it now covers every in-flight consumer and was mutation-tested to confirm it fails on the pre-fix source. Verification: `npm run compile-tests` exit 0, and `task-complete`, `completion-asserted-never-inferred`, `queue-pipeline`, `coding-head-prompt`, `standing-orders-marker`, `autoban-state`, `dependency-gate`, `atomic-team-lifecycle` all green; gate-wiring audit confirms all three of this feature's gates are real `run:` steps in `.github/workflows/integration-tests.yml` (:920, :1131, :1137). Remaining risks: five suites are red at HEAD for unrelated reasons, verified pre-existing by running them against HEAD's own source (`stage-marker-commit` and `mission-control-tick` trace to the Aug-23 standing-orders-library commits `73ec9cfb`/`8bdccde3`; `terminal-plan-attribution` pins a `turnEndSilenceMs` literal the source renamed to `nudgeSilenceMs`; plus `feature-file-subtask-link` and `staging-column`), and two deferred NITs — a `plan_events` completion row is lost permanently if `appendPlanEventByPlanId` throws after `completed_at` is written, and `task/complete` bumps `updated_at` so it silently reorders the `updated_at DESC` board with no refresh broadcast.

### Second reviewer pass (independent re-review)

Re-reviewed all three subtasks against HEAD rather than against the prior pass's report, and the asserted-completion half is intact and now stronger than the plan specified: `setCompletedAt` has exactly one production caller, `heldByTeam`/`resolveTeamInFlight` are the single shared predicate, all four `PlanIngestionEngine` queue seams are wired in *both* composition roots, and every `LocalApiServer` option seam this feature added (`onTeamReleased`, `terminalVerb`, `clearTerminalContext`, `onTerminalContextCleared`) is present in the extension root *and* `standalone/bootstrap.ts`. The material finding is that commit `25fdb6d9` (2026-08-29, scheduling consolidation) retired the autoban clock and deleted this feature's Proposed Changes #4 and #5 outright — `stopReason` and the `_stopAutobanEngine` Mission Control relay no longer exist — while also deleting 55 lines of assertions from `completion-asserted-never-inferred.test.js` and leaving that file's docblock still claiming to verify them; the same commit missed `queue-pipeline-contract.test.js:851`, leaving the CI-wired `test:contract:queue-pipeline` gate RED at HEAD on a `_scheduleQueuePop` symbol it had deleted. Three fixes applied, all test-side: the stale `_scheduleQueuePop` assertion was repointed at `runSchedulerJob` (its surviving caller) plus a new pin on the `onTeamReleased → clearAdvanceWhenReadyJobs` re-arm, the misleading docblock now records exactly which invariants died with the autoban engine and which mechanism carries halt visibility instead, and the anchor plan's named-but-never-written "`queue/done` is not completion" test was added as a single-writer pin over `_handleKanbanQueueDone`, `_runQueueDone` and `_handleTeamQueueDone` with every arm required to resolve by name. Verification: `npm run compile-tests` exit 0, and `completion-asserted-never-inferred`, `task-complete`, `queue-pipeline` (now green, was red), `queue-stall-watch`, `standing-orders-marker` (65/0), `team-release-control`, `dependency-gate` and `atomic-team-lifecycle` all pass; every new assertion was mutation-tested to confirm it goes red on the defect it names. Gate-wiring audit: all three gates named in the plans' `### Automated` subsections are real `run:` steps in `.github/workflows/integration-tests.yml` (`task-complete` :1253, `completion-asserted-never-inferred` :1262, `queue-stall-watch` :1277; `queue-pipeline` :1033, `standing-orders-marker` :241) — none is defined-but-uninvoked.

## Deferred Findings

- MAJOR — The anchor plan's halt surfacing is gone from the codebase: `AutobanConfigState` carries no `stopReason` and `_stopAutobanEngine` no longer exists, both deleted by `25fdb6d9` with the autoban engine they hung on. Not restored: re-adding the field would attach new state to a subsystem deliberately retired two days ago, and that is the author's call, not a reviewer's. `src/services/autobanState.ts:59`
- MAJOR — `workspaceRoot` is never validated against a registered-root set on `POST /kanban/task/complete`; `_getKanbanDb` opens or creates a kanban DB at whatever absolute path an authenticated caller supplies. The plan's acceptance criterion "invalid `workspaceRoot` refused" is unmet, but no such registry exists for *any* `/kanban/*` route, so hardening this one alone would be an inconsistent, out-of-scope invention. `src/services/LocalApiServer.ts:2805`
- NIT — Idempotency is read-then-write and is not serialized on any chain: two concurrent identical posts both pass the `existing.completedAt` check, both write, and both append a `completed` row to `plan_events`. `src/services/LocalApiServer.ts:2662`
- NIT — A `clearTerminalContext` failure is unrecoverable: `completed_at` is already written, so a retry returns `idempotent: true` and the accepted coder seat keeps stale context permanently. `src/services/LocalApiServer.ts:2716`
- NIT — `setCompletedAt` writes `updated_at = timestamp`, so a completion silently reorders the `updated_at DESC` board with no refresh broadcast. `src/services/KanbanDatabase.ts:3062`
- NIT — The idempotent early-return omits `dispatchedTerminal` and `acceptedCodingSeat`, so a repeat call's response shape differs from the first call's. `src/services/LocalApiServer.ts:2662`
- NIT — A `plan_events` completion row is lost permanently if `appendPlanEventByPlanId` throws after `completed_at` is written; there is no reconciliation pass. `src/services/LocalApiServer.ts:2707`
- NIT — A live Mission Control prompt still directs question reports to `.switchboard/orchestrator/reports/`, but the writer and reader both use `.switchboard/mission-control/reports/` — a report channel nothing consumes, the same category of defect this feature retired. Outside these three plans' scope. `src/services/KanbanProvider.ts:5769`
