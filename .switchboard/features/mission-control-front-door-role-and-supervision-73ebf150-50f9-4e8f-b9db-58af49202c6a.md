---
description: 'Mission Control — the front door, the role, and how missions start and are watched'
---

# Mission Control — the front door, the role, and how missions start and are watched

**Complexity:** 6

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
- [ ] [The ready flag gates the Launch button, turning an explicit mission start into a two-click pattern](../plans/ready-filters-bulk-start-it-should-not-gate-an-explicit-launch.md) — **CREATED** — ID: 86af94b7-55e4-4387-a9d7-6c0a56a557a9
- [ ] [Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol](../plans/replace-the-mission-control-persona-with-a-run-sheet.md) — **CREATED** — ID: 254f724e-df9c-45e4-b4fc-e9c400eadc99
- [ ] [A supervised mission has no supervision: `type` is stored, shown and reported, but nothing wakes on a transition](../plans/supervised-missions-wake-the-controller-on-transitions.md) — **CREATED** — ID: 9516c942-a3af-42d3-8607-f904ac4113be
- [ ] [The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture](../plans/the-mission-control-front-door-delivers-twice-and-lies-about-the-posture.md) — **CREATED** — ID: 135f2c7b-a953-4a03-ba70-5e20928b97e3
<!-- END SUBTASKS -->

## Dependencies & sequencing

The front-door subtask ships first and alone: building a run sheet on a step 2 that cannot arm buries
the broken call one level deeper. The run sheet depends on it directly.

The supervision subtask and the run sheet inform each other and are best read together — supervision
being wake-on-transition is what allows the run sheet to delete the interval tick, and the run sheet is
what establishes that the controller is a seated terminal rather than the `/switchboard` conversation.
Either may be implemented first; neither should be implemented without the other having been read.

The ready-gate subtask is a one-line fix with no dependencies and may ship at any point.
