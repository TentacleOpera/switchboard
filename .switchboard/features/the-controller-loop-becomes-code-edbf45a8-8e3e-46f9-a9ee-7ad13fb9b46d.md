---
description: 'The controller loop becomes code'
---

# The controller loop becomes code

**Complexity:** 5

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
- [ ] [The Fleet tab runs the hops — three checkboxes, a Start button, and a feed](../plans/the-fleet-tab-runs-the-hops.md) — **CODER CODED** — ID: 715f1f3b-a022-4a5b-95e5-45c3b358e601
- [ ] [Three dispatch hops and a Start button — the controller's mechanical loop becomes code](../plans/three-dispatch-hops-and-a-start-button.md) — **CODER CODED** — ID: 862344fe-6999-4aff-b8cc-19a5f42ca73d
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Backend first; the Fleet tab also depends on `the-dock-is-contained-and-becomes-three-tabs`,
which creates the tab it renders into.**

Two things in these plans are load-bearing and easy to get wrong.

Readiness must read card assignment, not seat `status`. A live `switchboard fleet` capture shows
every seat reading `active` — `status` is a liveness signal (exited vs not), not a busyness signal
(busy vs idle). Built on it, a hop fires constantly onto seats that are mid-task, and every test
written against a stub fleet still passes. It is test #1 in both plans for that reason.

Hops 2 and 3 share a readiness set because they share a working tree: a reviewer writes source into
the same checkout a freshly-dispatched coder would start in. That is not a preference —
`agent-commits-sweep-the-whole-shared-tree.md` records two coders concurrent in one tree where a
`git add -A` swept 255 lines of a peer's in-flight work into an unrelated commit.

Nothing here persists. The checkboxes and Start are session state and die with the terminals they
govern; work that must survive a machine sleeping belongs on the remote server.

## Team Dispatch Instructions

### Three dispatch hops and a Start button — the controller's mechanical loop becomes code
- **Seat:** Coder
- **Acceptance:**
  - A team is not free while one of its seats holds an uncompleted card, with every seat's `status` set to `'active'`
  - Empty fleet → `unknown` → no dispatch, for all three hops
  - Nothing dispatches before Start, with all three ticked
  - At most one dispatch per tick with all three ticked and everything idle
  - Both roots wire the resolver (source-level, both `extension.ts` and `bootstrap.ts`)
- **Must not touch:** None specified.

### The Fleet tab runs the hops — three checkboxes, a Start button, and a feed
- **Seat:** Coder
- **Acceptance:**
  - `stalled` and `blocked` do not trigger evaluation; `completed` does
  - Coalescing: five turn-end events inside the debounce window produce exactly one pass
  - Double-trigger safety: a tick and a turn-end pass racing on one free hop produce exactly one dispatch
  - `notifyTurnEnd` stays non-blocking: an evaluator that throws or never resolves leaves its delivery path unaffected
  - No `confirm(` anywhere in the changed webview files
- **Must not touch:** None specified.

## Completion Summary

Both subtasks implemented and reviewed. Backend (three-dispatch-hops): `HopReadiness.ts` evaluates team readiness via `heldByTeam` over card assignment with fail-closed semantics; `tickDispatchHops` integrates into `_tickSurvivorSchedulerJobs` with one-dispatch-per-tick and interval throttling; serialization enforced through `_queueNextChain` via `enqueueOnQueueChain`; both roots wire `setHopSnapshotResolver`. Fleet tab (the-fleet-tab-runs-the-hops): `notifyTurnEnd` schedules coalesced 2s debounce evaluation on `completed` only; hop verbs (`getHopState`, `setHopCheckbox`, `setHopsStarted`) wired in both roots; shell.html/shell.js render seat table, checkboxes with reasons, Start/Stop, and session feed with 60s visibility-gated polling. No `confirm()` anywhere. Contract tests cover all 10 verification items per plan.
