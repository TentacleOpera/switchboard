---
description: 'Seat-Routed Plan Queue'
---

# Seat-Routed Plan Queue

**Complexity:** 4

## Goal

A queue of standalone plans that a coding team walks by itself: cards dispatch straight to the intern, coder or lead by complexity, and the seat that finishes tells the board, which clears that seat's context and sends the next card. No head delegating, no reviewer hop, no orchestrator, no clock.

Most of this already exists. `DISPATCH` is already an ordered session queue (`queue_position`, `stageForQueue`, `reorderQueue`, `Run queue`) that already excludes feature subtasks, so it is standalone-plans-only by construction. Complexity routing already resolves a score to a seat on a specific team and refuses rather than leaking to another team. What is missing is small: the pop hands every card to the team head instead of the routed seat, and nothing tells the board when a seat is done.

The design constraint that shapes the whole feature is that **cards move on coding start and never on finish**. A dispatched card is already in its coding column; it gets coded and it stays there. Nothing advances it afterwards, so nothing in this feature invents a completion move or a destination column. The only thing that needs to change hands is pacing, and the seat that just finished is the one party that knows.

## How the Subtasks Achieve This

- **Seats take cards by complexity, and say when they are done** — flips the pop's branch from "is the requester a non-terminal agent" to "does this team pace by seat", which reaches a seat-routed dispatch path that already works. Adds `POST /kanban/queue/done`: the seat releases its working-state latch through the existing off-switch, gets its context cleared, and the next card goes out — one serialized operation, no card moved. The seat-paced path does not evaluate the team-busy check at all: that guard exists to arbitrate three racing callers in the head-paced model, and this model has one trigger driving a serial sequence.

- **Every seat is told to report done, and a failed card steps up one seat** — the instruction to advance the queue currently lives only in the team-head prompt, so in a headless queue nobody holds it. Installs one order body at `team` and `team-head` scope so every seat has it and it survives a `/clear`. The escalation ladder needs no new state: the card already records `routedTo`, so a failed card re-stages to `getFallbackRole(routedTo)`, and a card failed at lead parks where it sits.

- **Choosing seat pacing — the team switch and the idle watch** — makes the mode reachable: a per-team `pacing` field, a toggle on the team row, and `Run queue` reporting which mode it ran and where card one landed. Also corrects the idle watch, which asks "is a card held in a coding column" — always true once the first card is coded, so it would see a permanently busy team and never nudge anyone. It asks whether any seat is actually working instead, and escalates to the operator on the first pass when nothing is.

- **The orchestrator presents the seat-routed queue as a third option** — the persona offers three session models and asserts in five places that the queue pop hands cards "to the lead". After the other subtasks land those claims are wrong, not merely incomplete. Adds the seat-routed option with its trade stated, derives the five claims from pacing, updates Hard Rule 6 (which an unattended agent obeys over prose) to condition its "never to individual coders" constraint on head pacing, and describes what a finished seat-paced board looks like so an orchestrator does not read resting cards as work in progress and offer to re-dispatch them. Lands inside the shared logic document created by the split plan below.

- **Split the orchestrator skill by runtime entry point** — the orchestrator skill covers two runtimes with opposite wake contracts: PTY-resident (host-woken via `ptySendPrompt`) and external (nobody wakes the agent). One skill with a conditional branch has the same failure mode as `switchboard-cloud`: agents misidentify their runtime and treat the constraint as soft. Splits into two thin runsheets (external: self-wake required; internal: host-woken, skip self-wake) that both reference a shared logic document. The entry point IS the runtime identification — no self-diagnosis. Must land before the orchestrator-presents subtask, which writes its five-site fix inside the shared logic.

## Dependencies & sequencing

- **Subtask 1 is the only hard prerequisite.** Subtask 2's failure branch runs inside the critical section subtask 1 establishes, and subtask 3's watch and toggle both read the `pacing` field subtask 1 consumes.
- **Subtask 3 writes the field subtask 1 reads.** Subtask 1 must treat an absent field as `head`, so the two are order-independent: subtask 1 alone is inert until a team is switched over, which is the correct intermediate state.
- **Subtask 4 goes last and alone.** It is the only subtask that writes the orchestrator shared logic (after the split). Persona edits serialise — four subtasks of `lead-paced-pipeline` collided in this exact file.
- **The split plan goes before subtask 4.** It restructures the orchestrator skill into two runtime-specific runsheets + a shared logic document. Subtask 4's five-site fix lands inside the shared logic the split creates. Both write the same file family — they serialise.
- **Suggested order**: 1, then 2 and 3 (parallel-safe, different layers), then the split plan, then 4.
- **Not in scope**: the board's automation scheduler. A dispatching scheduled job must not fire into an active run, but that is a precondition owned by the scheduler and per-target, not something seat pacing defends against locally. Tracked separately in `scheduler-custom-jobs-and-the-busy-target-rule.md`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Seats Take Cards by Complexity, and Say When They Are Done](../plans/seat-routed-queue-1-seats-take-cards-and-report-done.md) — **CODE REVIEWED**
- [ ] [Every Seat Is Told to Report Done, and a Failed Card Steps Up One Seat](../plans/seat-routed-queue-2-seat-orders-and-the-escalation-ladder.md) — **CODE REVIEWED**
- [ ] [Choosing Seat Pacing — the Team-Level Switch, Run Queue, and the Idle Watch](../plans/seat-routed-queue-3-choosing-seat-pacing-and-the-idle-watch.md) — **CODE REVIEWED**
- [ ] [The Orchestrator Presents the Seat-Routed Queue as a Third Option](../plans/seat-routed-queue-4-orchestrator-presents-the-seat-routed-queue.md) — **CODE REVIEWED**
- [ ] [Split the Orchestrator Skill by Runtime Entry Point](../plans/seat-routed-queue-split-orchestrator-by-runtime.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

Reviewed the feature end-to-end and changed `src/services/LocalApiServer.ts`, `src/services/PlanIngestionEngine.ts`, `src/services/TaskViewerProvider.ts`, `src/services/teamWiring.ts`, `src/extension.ts`, the shared orchestrator skill, and three existing contract tests. Fixed lost escalation overrides after failed dispatch, cross-team idle-watch routing, stale seat pacing after a head-mode respawn, cross-workspace duplicate-cache collisions, missing-runsheet fail-open behavior, and the orchestrator model-count mismatch. Compile, compile-tests, the queue/orchestrator/standing-order/team-routing contracts, catalog, dispatch-caller, parity, standalone-parity/fork, verb-return, lint, and diff checks passed; compile and lint retained pre-existing warnings. Remaining unrelated repository gates are `push-routing:check` (KanbanProvider raw-postMessage baseline drift) and `mirror:check` (three pre-existing Claude mirror drifts).

## Completion Report

All five subtasks implemented across the team seats. Subtask 1 (seats take cards + report done): extracted `_runQueuePop` from `dispatchNextFromQueue`, added `pacing` arg branching to seat-routed dispatch, added `POST /kanban/queue/done` endpoint with `clearWorkingState` latch release, seat context clear, next-card pop, watch-on-release, and `reason` disambiguation (duplicate vs queue empty). Subtask 2 (seat orders + escalation ladder): installed `SEAT_QUEUE_DONE_ORDER_BODY` at `team`/`team-head` scope via `applySeatPacingOrders`, implemented `outcome: 'failed'` branch with `getFallbackRole` step-up, `setQueuePositions` front-re-stage, `_dispatchRoleOverride` per-dispatch override, coding-column double-re-stage guard, and lead-park with operator notification. Subtask 3 (choosing seat pacing + idle watch): added tri-state `pacing` field on team groups, TEAMS tab toggle (no confirm), `Run queue` status text naming mode + seat, `resolveTeamPacing`/`resolveTeamPacingForHead`, pacing propagation to live groups, and seat-paced `_runQueueNudgeSweep` branch (latch-set → nudge seat, latch-clear → first-pass operator escalation). Split plan: restructured orchestrator skill into shared logic + external/internal runsheets, modified `buildOrchestratorKickoffPrompt` with `deliveryMode` param, updated test gate. Subtask 4 (orchestrator presents seat-routed queue): added seat-routed fourth option, fixed five "to the lead" sites to derive from pacing, updated Hard Rule 6, added seat-paced handoff variant, queue-watch difference, and resting-state description. Files changed: `src/services/LocalApiServer.ts`, `src/services/teamWiring.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/PlanIngestionEngine.ts`, `src/services/agentGroupInstantiation.ts`, `src/webview/kanban.html`, `src/webview/terminals.js`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, `.agents/skills/switchboard-orchestrator/SKILL.md`, `.agents/skills/switchboard-orchestrator-external/SKILL.md` (new), `.agents/skills/switchboard-orchestrator-internal/SKILL.md` (new), `src/test/orchestrator-tick-and-reports-contract.test.js`, `AGENTS.md`. No issues encountered beyond coder-2 failing subtask 3 twice (escalated to intern, completed successfully).
