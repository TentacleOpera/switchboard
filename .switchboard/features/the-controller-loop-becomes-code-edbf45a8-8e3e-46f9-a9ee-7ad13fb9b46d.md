---
description: 'The controller loop becomes code'
---

# The controller loop becomes code

## Goal

Replace the part of the Mission Control controller that is not judgement with three checkboxes and
a Start button.

The controller's routine loop is three mechanical reads and a comparison: run `switchboard fleet`,
tail a seat log, run `git log -n 1`, then apply rules a human wrote and call a verb. Every step of
that has a correct answer, so what the model contributes to this particular loop is latency, token
cost, and the chance of reading the table wrong.

This is a subtraction. The agent is not replaced — planner-stage questions, escalation, merge
conflicts and advice on what to seat all stay with it. What moves is the state check followed by a
fixed consequence, which makes the dispatch path *less* nondeterministic, not more.

## How the Subtasks Achieve This

- **Three dispatch hops and a Start button**: the backend. Each hop is one column to one team —
  CREATED to planning, PLAN REVIEWED to coding, `*_CODED` to review — and fires only when its
  destination team is free. Readiness is decided in code from `heldByTeam` over card assignment,
  never configured, so there is no checkbox that means "dispatch onto busy seats".
- **The Fleet tab runs the hops**: the surface. Checkboxes, Start, and a feed of what happened,
  beside the seat table they describe. Hops also evaluate on `notifyTurnEnd` rather than only on the
  minute tick, so a finished card produces the next dispatch in seconds instead of up to sixty.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Backend first; the Fleet tab also depends on `the-dock-is-contained-and-becomes-three-tabs`,
which creates the tab it renders into.**

Two things in these plans are load-bearing and easy to get wrong.

Readiness must read card assignment, not seat `status`. A live `switchboard fleet` capture shows
every seat reading `active` — `status` is a liveness signal whose only consumer checks nothing but
`=== 'exited'`. Built on it, a hop fires constantly onto seats that are mid-task, and every test
written against a stub fleet still passes. It is test #1 in both plans for that reason.

Hops 2 and 3 share a readiness set because they share a working tree: a reviewer writes source into
the same checkout a freshly-dispatched coder would start in. That is not a preference —
`agent-commits-sweep-the-whole-shared-tree.md` records two coders concurrent in one tree where a
`git add -A` swept 255 lines of a peer's in-flight work into an unrelated commit.

Nothing here persists. The checkboxes and Start are session state and die with the terminals they
govern; work that must survive a machine sleeping belongs on the remote server.
