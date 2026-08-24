# Completion is asserted, never inferred — and silence halts

## Goal

Make a lead's explicit completion post the **only** way the system learns that work finished, remove every path that infers completion from board position or a stale field, and give silence its correct meaning: halt the pipeline and say so.

### Problem Analysis

**Nothing marks work finished, so everything infers it.** Cards move on coding *start* and never on finish, which makes a kanban column a write-once "started" marker. Every consumer that needs to know "is this still running?" therefore reads board position — and board position cannot answer the question.

The fields are no better. The in-flight predicate's own comment records that the fact-based version was tried and abandoned (`LocalApiServer.ts:1724-1727`): keying on `dispatched_at` *"would refuse the head's own legitimate call (the just-reviewed card sits in `CODE REVIEWED` with `dispatched_at` set and `dispatched_terminal` naming the reviewer) and deadlock the pipeline after card one."* It failed for the identical reason — nothing clears it either.

**The workaround is the proof.** Seat pacing skips the in-flight scan entirely, and the stated reason is exactly this defect (`LocalApiServer.ts:1700-1705`): *"cards move on coding start and never on finish, so a coded card stays in its coding column and board position never releases — the scan would pin the team as busy forever and every later pop would 409."* An entire pacing mode carries a special case to route around column-as-state.

**Three inference sites exist today**, each wrong differently:

1. **The seat standing order** (`teamWiring.ts:338-354`) tells any seat to infer completion from "all subtasks are in `LEAD CODED`" and move the feature to `CODE REVIEWED`.
2. **The report file** — the head order (`teamWiring.ts:798`, `:851`) says to *"post a finished report to `.switchboard/mission-control/reports/` naming the feature and its planId, and stop."* Written by `ScheduledJobsService` (`:299`), read only by the Mission Control persona (formerly "orchestrator" — the persona was renamed; the former `switchboard-orchestrator/SKILL.md` no longer exists; behavior contracts now live in `.agents/protocols/switchboard-contracts/SKILL.md`) — so with no Mission Control present, nothing reads it.
3. **`queue/done`** means "dispatch me the next item"; completion is a side effect, and a lead finishing the last item or working outside a queue has no call to make.

**And the inference manufactures a state that should not exist.** There are only three honest answers: the lead posted (done), the lead was nudged and posted (done), or it did not post (something is broken). Inference invents a fourth — *probably* done — out of "we heard nothing", and then advances the pipeline on it. That is the bug. Silence already has a correct meaning, and it is not "continue".

### Root Cause

Completion was never modelled as an event. Because there was no event to wait for, every consumer had to guess from the most recent durable trace it could find — a column, a timestamp, a file — and each guess needed its own special case when the trace turned out not to release.

## Metadata

**Complexity:** 6
**Tags:** reliability, backend, agents, architecture

## Settled Design

- **One signal.** A lead's explicit completion post. `add-a-task-complete-endpoint-for-the-lead.md` supplies it; this plan makes it exclusive.
- **Silence halts.** No fallback, no inference, no "probably". The absence of a signal *is* the signal, and it means stop.
- **The inference paths go as a category**, not site by site. Removing them individually leaves the pattern intact for the next consumer to reach for.
- **A halt announces itself** three ways: automation switches off, a message goes to the controller terminal when one is active, and the reason is recorded on the automation state so the off explains itself.

## Complexity Audit

### Routine

- Turning automation off: `_stopAutobanEngine()` with `enabled: false` is the existing path (`TaskViewerProvider.ts:13880`), already used by other stop routes.
- Posting to the controller: the established machine-origin relay — `ptySendPrompt` with `clearBeforePrompt: false, standingOrders: false` (`LocalApiServer.ts:3313-3328`), which deliberately never resets the recipient's context.
- Controller-present check: `_hasMissionControl()` (`TaskViewerProvider.ts:6522`) — a Mission Control seat held or Mission Control armed. (The method was renamed from `_hasOrchestrator` as part of the orchestrator → Mission Control rename.)

### Complex / Risky

- **There is no stop-reason field anywhere.** No `stopReason`, `lastStopReason` or `disableReason` exists in the codebase. This is the one genuinely new piece of state, and it is one field. It matters because "check the terminals" is not durable, though less catastrophically than a first reading suggests: the standalone gateway keeps a server-side ring buffer and replays it on attach (`MAX_SCROLLBACK_BYTES = 256 * 1024` in `terminalWsGateway.ts`), so a **browser reload loses nothing**. What does lose it: `queue/done` *clears* member terminals by design (`teamWiring.ts:326`), the ring evicts once a terminal has produced more than 256 KB, and a restart of the pty host drops the buffers with it. So a user returning to an off icon may well find the terminal that explains it cleared, evicted, or gone — which is why the reason belongs on the state rather than in scrollback. Do not write the claim as "a session restart loses scrollback": a reviewer will test it with a page refresh, find it false, and reasonably distrust the rest.
- **A halt must be distinguishable from a hang.** Today silence-plus-inference keeps things moving; after this it stops them. That is the intent, but a stopped pipeline that says nothing is indistinguishable from a broken one. The visible off state plus the recorded reason is what makes the difference, so neither is optional.
- **The in-flight predicate should read the completion fact, and "no fact" means busy.** The completion fact is the `completed_at` timestamp column added by `add-a-task-complete-endpoint-for-the-lead.md`. The scan at `LocalApiServer.ts:1868-1882` checks `&& !p.completedAt` instead of `CODING_COLUMNS.has()`. "No fact" (`completed_at` is NULL) means busy — the safe direction: if the lead never posted, the team stays held rather than being freed for more work. It also lets seat pacing stop skipping the scan, removing the special case at `LocalApiServer.ts:1700-1705` rather than preserving it.
- **The stall channel already exists** — `notifyTurnEnd` takes `outcome: 'completed' | 'blocked' | 'stalled'` (`TaskViewerProvider.ts:1739`) — so a turn ending without a completion post is already classifiable. Do not build a second detector beside it.
- **The seat-order clause is one instance, and it has its own plan.** `remove-the-seat-orders-code-reviewed-clause.md` removes exactly this inference at one site. Land them together so the category rule and its first application do not disagree in the interim.
- **The report file path must be retired, not merely bypassed.** It is the head's instructed behaviour when a team has no reviewer seat, so removing the read without changing the instruction leaves agents writing files nothing consumes.

## Edge-Case & Dependency Audit

**Migration.** The inference behaviour shipped. A user whose pipeline advanced on inference will see it stop instead — which is the point, but it must stop *loudly*. No stored state changes shape; the new field is additive and absent means "no recorded reason".

**Security.** Neutral. The controller message is agent-facing text and renders as text. No new endpoint beyond the completion post that `add-a-task-complete-endpoint-for-the-lead.md` already specifies.

**Side effects.** Pipelines that silently limped along on inferred completion will now halt. Expect this to surface pre-existing stalls that were previously invisible — that is a feature, and worth saying in release notes so it does not read as a regression.

**Ordering.** Requires the completion endpoint. Should land with the seat-order clause removal.

## Dependencies

- **Requires** `add-a-task-complete-endpoint-for-the-lead.md` — the signal this plan makes exclusive.
- **Lands with** `remove-the-seat-orders-code-reviewed-clause.md` — one instance of the category.
- **Simplifies** `staging-streams-parallel-dispatch-and-worktrees.md` substantially; see `revise-the-in-flight-plans-for-asserted-completion.md`.
- The stop reason has a natural display home in the schedules **Logs** view specified by `mission-control-panel-ui-specification.md`.
- **Requires** `add-a-task-complete-endpoint-for-the-lead.md` to have shipped the `completed_at` column — the in-flight repointing reads it.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) silence-halts surfaces pre-existing stalls that were previously invisible — mitigated by the stop-reason field and release notes framing it as a feature, not a regression; (2) the in-flight predicate repointing depends on the endpoint plan's `completed_at` column — mitigated by the hard ordering constraint (endpoint first, anchor second); (3) the stop-reason field is new state that must survive persistence and reload — mitigated by housing it on `_autobanState` which is already persisted.

**"Inference is a useful fallback when an agent forgets to post."** It is not a fallback, it is a wrong answer delivered confidently. An agent that forgot to post is an agent whose state is unknown, and advancing on a guess is how a half-finished feature reaches review. Halting costs a nudge; guessing costs the pipeline's trustworthiness.

**"Halting on silence will strand users."** Only if the halt is silent. With the icon off, a controller message, and a recorded reason, a halt is a diagnosable event — which is strictly better than today, where an inferred advance is invisible by construction.

**"Just clear `dispatched_at` on completion instead — smaller change."** That is the same design with a different field, and it inherits the same failure: any consumer still infers "not finished" from the absence of a clear, so a missed clear reads as in-progress forever. The point is an asserted event, not a better trace.

**"Keep the seat-pacing skip; it works."** It works by declining to ask a question it cannot answer. Once the question is answerable the skip is dead weight, and leaving it means two pacing modes with different notions of what "busy" means.

## Proposed Changes

1. **Make the completion post authoritative** — the single fact every consumer reads. The fact is the `completed_at` timestamp on the plans table row, written by `POST /kanban/task/complete` (see `add-a-task-complete-endpoint-for-the-lead.md`).
2. **Remove the three inference paths**: the seat order's board-position clause (`teamWiring.ts:338-354`), the report-file completion channel (head order at `teamWiring.ts:798`, `:851` — retire the instruction, not just the reader), and any treatment of `queue/done` as a completion signal rather than a request for more work.
3. **Repoint the in-flight predicate** at `completed_at` — the scan at `LocalApiServer.ts:1868-1882` checks `&& !p.completedAt` instead of relying on `CODING_COLUMNS.has()` alone. "No fact" (`completed_at` is NULL) means busy. **Delete the seat-pacing skip** at `LocalApiServer.ts:1700-1705` now that board position is no longer the input.
4. **Add a stop reason** to `_autobanState` in `TaskViewerProvider.ts` (e.g. `stopReason: string`), set whenever automation switches itself off. Absent reads as "no recorded reason".
5. **Wire the halt surfacing**: `_stopAutobanEngine()` (`TaskViewerProvider.ts:13880`) + `enabled: false`, a relay message to the Mission Control gated on `_hasMissionControl()` (`TaskViewerProvider.ts:6522`), and the reason recorded on `_autobanState` regardless of whether a Mission Control exists.
6. **Route stall classification through `notifyTurnEnd`'s existing `'stalled'` outcome** rather than a new detector.
7. **Retire the report-file instruction** in the head order, not just its reader.

### Migration

None structural. The stop-reason field is additive; absent reads as "no recorded reason". The behaviour change — silence halts — is deliberate and belongs in release notes.

## Verification Plan

### Goal Invariants

- No consumer derives completion from a kanban column or from `dispatched_at`.
- A missing completion post halts the pipeline rather than advancing it.
- Every automation self-stop carries a reason.
- A halt is visible without reading terminal scrollback.

### Automated Tests

- **Board position cannot complete anything:** park every subtask in a coding column with no completion post; assert nothing advances and the feature is not handed to review. This is the behaviour that ships today, so it is the test that fails first.
- **Silence halts and says so:** withhold the post; assert automation reaches `enabled: false`, a reason is recorded on `_autobanState`, and a Mission Control message is sent when `_hasMissionControl()` is true.
- **The halt is legible with no controller:** same scenario with no Mission Control; assert the reason is still recorded. Testing only the controller path passes while an unattended user gets a bare off switch.
- **In-flight reads the fact, and no fact means busy:** assert a team with an outstanding uncompleted card (`completed_at` is NULL) is refused, and released only by the post (which sets `completed_at`) — not by a column move.
- **The seat-pacing skip is gone:** assert seat pacing runs the same in-flight check as head pacing, and that neither pins a team forever.
- **`queue/done` is not completion:** post it and assert no completion fact is recorded — only the next-item dispatch.
- **No agent is told to write a completion report file:** assert the instruction is absent from the composed head orders.

### Manual Verification

- Run a feature to the point of a deliberately withheld post; confirm the icon goes off, the controller says why, and the reason survives a window reload.

## Outstanding Questions

None.

**Routing: Complexity 6 → Send to Coder.**

## Implementation Summary

### Subtask 1: Add task-complete endpoint (4e00f321)
- Added `completed_at` column to `plans` table with migration in `KanbanDatabase.ts`
- Added `POST /kanban/task/complete` endpoint in `LocalApiServer.ts` — sets `completed_at`, idempotent, validates `from` and `planId`, refuses path separators
- Updated in-flight scan to check `!p.completedAt` — completed cards no longer pin teams
- 11 tests in `src/test/task-complete-endpoint.test.js` — all pass

### Subtask 2: Completion is asserted, never inferred (aa1f49da)
- Removed board-position inference from `TEAM_QUEUE_DONE_ORDER_BODY` (coder no longer checks LEAD CODED or dispatches to CODE REVIEWED)
- Removed report-file completion channel from `NEW_CODING_HEAD_PROMPT` — replaced with `POST /kanban/task/complete` instruction
- Removed `REVIEW_TEAM_QUEUE_DONE_ORDER_BODY` board-position clause — reviewer no longer infers completion
- Deleted seat-pacing skip in `LocalApiServer.ts` — both pacing modes now run identical in-flight check against `completed_at`
- Added `stopReason` field to `AutobanConfigState` in `autobanState.ts` — normalised, persisted
- Wired halt relay in `_stopAutobanEngine(reason?)` — records reason on `_autobanState` regardless of Mission Control, relays to MC gated on `_hasMissionControl()` with `standingOrders: false`
- Routed stall classification through existing `notifyTurnEnd` `'stalled'` outcome — no second detector
- 14 tests in `src/test/completion-asserted-never-inferred.test.js` — all pass
- Updated `queue-pipeline-contract.test.js` seat-pacing test to reflect new `completedAt` check

### Subtask 3: Revise in-flight plans (df870968)
- Amended `staging-streams-parallel-dispatch-and-worktrees.md` — replaced `stream_id`/`stream_seq` with dependency edges evaluated at pop time against `completed_at`, re-scored complexity 6→3, recorded split recommendation
- Amended `remove-the-seat-orders-code-reviewed-clause.md` — framed as first application of the category rule, noted it lands alongside anchor plan
- Amended `the-automation-model-four-things-not-a-mode-axis.md` — refined selector to admit `queue-order` for STAGING column where `queue_position` holds user-set priority

### Files changed
- `src/services/KanbanDatabase.ts` — `completed_at` column + migration
- `src/services/LocalApiServer.ts` — endpoint, in-flight scan, seat-pacing skip removal
- `src/services/teamWiring.ts` — removed inference paths from seat and head orders
- `src/services/autobanState.ts` — `stopReason` field + normalisation
- `src/services/TaskViewerProvider.ts` — `_stopAutobanEngine(reason)` + halt relay
- `src/services/KanbanProvider.ts` — `nudgeCount` fix (pre-existing)
- `src/test/task-complete-endpoint.test.js` — 11 tests
- `src/test/completion-asserted-never-inferred.test.js` — 14 tests
- `src/test/queue-pipeline-contract.test.js` — updated seat-pacing test
- `.switchboard/plans/staging-streams-parallel-dispatch-and-worktrees.md` — amended
- `.switchboard/plans/remove-the-seat-orders-code-reviewed-clause.md` — amended
- `.switchboard/plans/the-automation-model-four-things-not-a-mode-axis.md` — amended
