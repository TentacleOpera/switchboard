# Completion is asserted, never inferred — and silence halts

## Goal

Make a lead's explicit completion post the **only** way the system learns that work finished, remove every path that infers completion from board position or a stale field, and give silence its correct meaning: halt the pipeline and say so.

### Problem Analysis

**Nothing marks work finished, so everything infers it.** Cards move on coding *start* and never on finish, which makes a kanban column a write-once "started" marker. Every consumer that needs to know "is this still running?" therefore reads board position — and board position cannot answer the question.

The fields are no better. The in-flight predicate's own comment records that the fact-based version was tried and abandoned (`LocalApiServer.ts:1685-1688`): keying on `dispatched_at` *"would refuse the head's own legitimate call (the just-reviewed card sits in `CODE REVIEWED` with `dispatched_at` set and `dispatched_terminal` naming the reviewer) and deadlock the pipeline after card one."* It failed for the identical reason — nothing clears it either.

**The workaround is the proof.** Seat pacing skips the in-flight scan entirely, and the stated reason is exactly this defect (`:1680-1684`): *"cards move on coding start and never on finish, so a coded card stays in its coding column and board position never releases — the scan would pin the team as busy forever and every later pop would 409."* An entire pacing mode carries a special case to route around column-as-state.

**Three inference sites exist today**, each wrong differently:

1. **The seat standing order** (`teamWiring.ts:322-325`) tells any seat to infer completion from "all subtasks are in `LEAD CODED`" and move the feature to `CODE REVIEWED`.
2. **The report file** — the head order (`teamWiring.ts:769`, `:819`) says to *"post a finished report to `.switchboard/orchestrator/reports/` naming the feature and its planId, and stop."* Written by `ScheduledJobsService` (`:227`), read only by the orchestrator persona (`switchboard-orchestrator/SKILL.md:368`) — so with no orchestrator present, nothing reads it.
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

- Turning automation off: `_stopAutobanEngine()` with `enabled: false` is the existing path (`TaskViewerProvider.ts:10818-10820`), already used by other stop routes.
- Posting to the controller: the established machine-origin relay — `ptySendPrompt` with `clearBeforePrompt: false, standingOrders: false` (`LocalApiServer.ts:4118-4128`), which deliberately never resets the recipient's context.
- Controller-present check: `_hasOrchestrator()` (`:6361`) — a seat held or orchestration armed.

### Complex / Risky

- **There is no stop-reason field anywhere.** No `stopReason`, `lastStopReason` or `disableReason` exists in the codebase. This is the one genuinely new piece of state, and it is one field. It matters because "check the terminals" is not durable: `queue/done` *clears* member terminals by design (`teamWiring.ts:318`), and a session restart loses scrollback entirely — so without a recorded reason a user returns to an off icon with no route back to why.
- **A halt must be distinguishable from a hang.** Today silence-plus-inference keeps things moving; after this it stops them. That is the intent, but a stopped pipeline that says nothing is indistinguishable from a broken one. The visible off state plus the recorded reason is what makes the difference, so neither is optional.
- **The in-flight predicate should read the completion fact, and "no fact" means busy.** That is the safe direction: if the lead never posted, the team stays held rather than being freed for more work. It also lets seat pacing stop skipping the scan, removing the special case at `:1680-1684` rather than preserving it.
- **The stall channel already exists** — `notifyTurnEnd` takes `outcome: 'completed' | 'blocked' | 'stalled'` (`TaskViewerProvider.ts:1644`) — so a turn ending without a completion post is already classifiable. Do not build a second detector beside it.
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

## Adversarial Synthesis

**"Inference is a useful fallback when an agent forgets to post."** It is not a fallback, it is a wrong answer delivered confidently. An agent that forgot to post is an agent whose state is unknown, and advancing on a guess is how a half-finished feature reaches review. Halting costs a nudge; guessing costs the pipeline's trustworthiness.

**"Halting on silence will strand users."** Only if the halt is silent. With the icon off, a controller message, and a recorded reason, a halt is a diagnosable event — which is strictly better than today, where an inferred advance is invisible by construction.

**"Just clear `dispatched_at` on completion instead — smaller change."** That is the same design with a different field, and it inherits the same failure: any consumer still infers "not finished" from the absence of a clear, so a missed clear reads as in-progress forever. The point is an asserted event, not a better trace.

**"Keep the seat-pacing skip; it works."** It works by declining to ask a question it cannot answer. Once the question is answerable the skip is dead weight, and leaving it means two pacing modes with different notions of what "busy" means.

## Proposed Changes

1. **Make the completion post authoritative** — the single fact every consumer reads.
2. **Remove the three inference paths**: the seat order's board-position clause, the report-file completion channel, and any treatment of `queue/done` as a completion signal rather than a request for more work.
3. **Repoint the in-flight predicate** at the completion fact, with "no fact" meaning busy, and **delete the seat-pacing skip** now that board position is no longer the input.
4. **Add a stop reason** to the automation state, set whenever automation switches itself off.
5. **Wire the halt surfacing**: `_stopAutobanEngine()` + `enabled: false`, a relay message to the controller gated on `_hasOrchestrator()`, and the reason recorded regardless of whether a controller exists.
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
- **Silence halts and says so:** withhold the post; assert automation reaches `enabled: false`, a reason is recorded, and a controller message is sent when `_hasOrchestrator()` is true.
- **The halt is legible with no controller:** same scenario with no orchestrator; assert the reason is still recorded. Testing only the controller path passes while an unattended user gets a bare off switch.
- **In-flight reads the fact, and no fact means busy:** assert a team with an outstanding uncompleted card is refused, and released only by the post — not by a column move.
- **The seat-pacing skip is gone:** assert seat pacing runs the same in-flight check as head pacing, and that neither pins a team forever.
- **`queue/done` is not completion:** post it and assert no completion fact is recorded — only the next-item dispatch.
- **No agent is told to write a completion report file:** assert the instruction is absent from the composed head orders.

### Manual Verification

- Run a feature to the point of a deliberately withheld post; confirm the icon goes off, the controller says why, and the reason survives a window reload.

## Outstanding Questions

None.
