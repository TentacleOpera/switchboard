---
description: 'Seat-Routed Plan Queue'
---

# Seat-Routed Plan Queue

## Goal

A queue of standalone plans that a coding team walks by itself: cards dispatch straight to the intern, coder or lead by complexity, and the seat that finishes tells the board, which clears that seat's context and sends the next card. No head delegating, no reviewer hop, no orchestrator, no clock.

Most of this already exists. `DISPATCH` is already an ordered session queue (`queue_position`, `stageForQueue`, `reorderQueue`, `Run queue`) that already excludes feature subtasks, so it is standalone-plans-only by construction. Complexity routing already resolves a score to a seat on a specific team and refuses rather than leaking to another team. What is missing is small: the pop hands every card to the team head instead of the routed seat, and nothing tells the board when a seat is done.

The design constraint that shapes the whole feature is that **cards move on coding start and never on finish**. A dispatched card is already in its coding column; it gets coded and it stays there. Nothing advances it afterwards, so nothing in this feature invents a completion move or a destination column. The only thing that needs to change hands is pacing, and the seat that just finished is the one party that knows.

## How the Subtasks Achieve This

- **Seats take cards by complexity, and say when they are done** — flips the pop's branch from "is the requester a non-terminal agent" to "does this team pace by seat", which reaches a seat-routed dispatch path that already works. Adds `POST /kanban/queue/done`: the seat releases its working-state latch through the existing off-switch, gets its context cleared, and the next card goes out — one serialized operation, no card moved. The seat-paced path does not evaluate the team-busy check at all: that guard exists to arbitrate three racing callers in the head-paced model, and this model has one trigger driving a serial sequence.

- **Every seat is told to report done, and a failed card steps up one seat** — the instruction to advance the queue currently lives only in the team-head prompt, so in a headless queue nobody holds it. Installs one order body at `team` and `team-head` scope so every seat has it and it survives a `/clear`. The escalation ladder needs no new state: the card already records `routedTo`, so a failed card re-stages to `getFallbackRole(routedTo)`, and a card failed at lead parks where it sits.

- **Choosing seat pacing — the team switch and the idle watch** — makes the mode reachable: a per-team `pacing` field, a toggle on the team row, and `Run queue` reporting which mode it ran and where card one landed. Also corrects the idle watch, which asks "is a card held in a coding column" — always true once the first card is coded, so it would see a permanently busy team and never nudge anyone. It asks whether any seat is actually working instead, and escalates to the operator on the first pass when nothing is.

- **The orchestrator presents the seat-routed queue as a third option** — the persona offers exactly two options and asserts in four places that the queue pop hands cards "to the lead". After the other subtasks land those claims are wrong, not merely incomplete. Adds the third option with its trade stated, derives the four claims from pacing, and describes what a finished seat-paced board looks like so an orchestrator does not read resting cards as work in progress and offer to re-dispatch them.

## Dependencies & sequencing

- **Subtask 1 is the only hard prerequisite.** Subtask 2's failure branch runs inside the critical section subtask 1 establishes, and subtask 3's watch and toggle both read the `pacing` field subtask 1 consumes.
- **Subtask 3 writes the field subtask 1 reads.** Subtask 1 must treat an absent field as `head`, so the two are order-independent: subtask 1 alone is inert until a team is switched over, which is the correct intermediate state.
- **Subtask 4 goes last and alone.** It is the only subtask that writes `.agents/skills/switchboard-orchestrator/SKILL.md`. Persona edits serialise — four subtasks of `lead-paced-pipeline` collided in this exact file.
- **Suggested order**: 1, then 2 and 3 (parallel-safe, different layers), then 4.
- **Not in scope**: the board's automation scheduler. A dispatching scheduled job must not fire into an active run, but that is a precondition owned by the scheduler and per-target, not something seat pacing defends against locally. Tracked separately in `scheduler-custom-jobs-and-the-busy-target-rule.md`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->
