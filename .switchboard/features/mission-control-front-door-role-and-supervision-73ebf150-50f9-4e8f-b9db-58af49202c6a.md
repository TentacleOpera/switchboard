---
description: 'Mission Control — the front door, the role, and how missions start and are watched'
---

# Mission Control — the front door, the role, and how missions start and are watched

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-04 (Board Collapse audit). This feature has TWO subtasks, not four.**
> 
> *The /switchboard front door arms against an endpoint that does not exist* and *Replace the Mission Control persona with a run sheet* moved to the **/switchboard front door** feature, which owns the eight cards across four features that all rewrote the same workflow file.
> 
> **Everything below that describes four subtasks is void**: the "four subtasks move from the mechanical break outward" framing, two of the four *How the Subtasks Achieve This* bullets, the Dependencies chain that makes the front-door subtask ship "first and alone" with the run sheet depending on it, and — most dangerous — **two of the four seat briefs in Team Dispatch Instructions**. Those two briefs also exist in the front-door feature, so acting on this file would hand the same work to a second seat. They are struck below.
> 
> What remains here: **the ready flag gates the Launch button** and **a supervised mission has no supervision**. They are independent of each other; neither needs the other first.

**Complexity:** 5

## Goal

Repair `/switchboard`, then give Mission Control the shape its own specification describes. The
front door currently arms against an endpoint that does not exist, hands the agent a 619-line persona
twice, and stamps every session unattended including the one a user just typed into. Behind it, the
persona is scoped to the flavour the automation model says needs no persona, while the flavour that
does — a supervised mission — has a type field, a UI picker and a reported `supervised` flag with no
behaviour behind any of it.

The four subtasks move from the mechanical break outward: fix the door, replace the persona with a run
sheet that asks and then loads only what was chosen, give supervision its missing mechanism, and remove
a gate that stops a user launching a mission on purpose.

## How the Subtasks Achieve This

- **The front door delivers twice and lies about the posture**: `POST /orchestration/confirm` does
  not exist — no route containing `orchestration` does — so an agent following the launcher literally
  cannot arm a session. Also stops the launcher asking the agent to read a document already inlined in
  the response, and derives the attended/unattended flag from the session mode instead of hardcoding it.
- **Replace the Mission Control persona with a run sheet**: the launcher asks which job is wanted and
  loads that branch's protocol. The 619 lines are decomposed rather than trimmed, the tick and its
  context-clearing apparatus are deleted because the interval loop they serve no longer runs, and the
  single orientation call reads the body of `GET /health` instead of discarding it.
- **Supervised missions wake the controller on transitions**: `type: 'operation'` is stored, settable
  and reported, and its entire behavioural footprint is a worktree budget. Adds the missing edge
  detector over the per-card turn-end signal that already fires, so a seated controller is woken when a
  mission changes state — and stores a notification watermark, never a status, because run state is
  derived from member cards by design.
- **Ready filters bulk start, it should not gate an explicit launch**: one line disables Launch on a
  mission the user has selected until they first click mark-ready. The service layer has no such check,
  so this is a two-click pattern the backend never asked for.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The ready flag gates the Launch button, turning an explicit mission start into a two-click pattern](../plans/ready-filters-bulk-start-it-should-not-gate-an-explicit-launch.md) — **PLAN REVIEWED** — ID: 86af94b7-55e4-4387-a9d7-6c0a56a557a9
- [ ] [A supervised mission has no supervision: `type` is stored, shown and reported, but nothing wakes on a transition](../plans/supervised-missions-wake-the-controller-on-transitions.md) — **PLAN REVIEWED** — ID: 9516c942-a3af-42d3-8607-f904ac4113be
- [ ] [A Mission Cannot Be Opened, Its Launch Is Not Scoped To It, and Nothing Tests the Mechanism](../plans/memo-missions-cannot-be-opened-scoped-or-tested.md) — **CREATED** — ID: d2953390-1622-4764-8c54-e44c91087082
- [ ] [Mission Control Schedules Persists Four Fields Nothing Reads, Offers Four Actions That Do One Thing, and Loses Its Own Config](../plans/memo-mission-control-schedules-writes-four-fields-nothing-reads.md) — **CREATED** — ID: 3ff3e452-f985-423e-a4c2-1c3aa52a26bb
<!-- END SUBTASKS -->

## Dependencies & sequencing

The front-door subtask ships first and alone: building a run sheet on a step 2 that cannot arm buries
the broken call one level deeper. The run sheet depends on it directly.

The supervision subtask and the run sheet inform each other and are best read together — supervision
being wake-on-transition is what allows the run sheet to delete the interval tick, and the run sheet is
what establishes that the controller is a seated terminal rather than the `/switchboard` conversation.
Either may be implemented first; neither should be implemented without the other having been read.

The ready-gate subtask is a one-line fix with no dependencies and may ship at any point.

## Team Dispatch Instructions

### ~~The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture~~ — MOVED, DO NOT DISPATCH FROM HERE

> **Struck 2026-09-04 (Board Collapse audit).** This plan belongs to the **/switchboard front door** feature, which holds its live seat brief. The brief below was left here when the card moved and would hand the same work to a second seat. It is removed rather than annotated, because a dispatcher reading this section does not necessarily read the top of the file.

### ~~Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol~~ — MOVED, DO NOT DISPATCH FROM HERE

> **Struck 2026-09-04 (Board Collapse audit).** This plan belongs to the **/switchboard front door** feature, which holds its live seat brief. The brief below was left here when the card moved and would hand the same work to a second seat. It is removed rather than annotated, because a dispatcher reading this section does not necessarily read the top of the file.

### A supervised mission has no supervision: `type` is stored, shown and reported, but nothing wakes on a transition

- **Seat:** Coder (Complexity 5)
- **Acceptance:**
  - A supervised (`operation`) mission wakes exactly once per transition, including when multiple members complete concurrently (the watermark compare-and-set is serialized).
  - An unsupervised (`mission`) mission never wakes; a later flip to `operation` produces no backfilled wakes and the next real transition wakes normally.
  - Every read path calls `_deriveMissionRunState`; no reader consults `last_notified_run_state` as truth, and the watermark is absent from state-exposing return paths.
  - The wake payload carries the mission id, both states, and the member card that caused the transition.
  - Both hosts reach the same detector code path beside the existing turn-end notifier.
- **Must not touch:** `runState` persistence (stays derived, never persisted); the `mission` (unsupervised) behaviour; the interval tick (supervision is wake-on-transition, not polling).

### The ready flag gates the Launch button, turning an explicit mission start into a two-click pattern

- **Seat:** Intern (Complexity 2)
- **Acceptance:**
  - An unready mission with at least one member has Launch enabled and launches successfully.
  - `start-ready-mission` still picks up `ready` missions and skips unready ones; the READY badge and `mc-ready-mission` still work.
  - In-flight and completed missions stay disabled; no-members is the only remaining hard block.
  - `ready` is absent from the `mc-launch` predicate at `mission-control.js:205`; both hosts carry the same predicate.
- **Must not touch:** `launchMission` (already correct); `runState` (derived, never persisted); the `ready` flag itself (badge, mark-ready control, and schedule action keep it).
