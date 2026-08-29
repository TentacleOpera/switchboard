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
- [ ] [The ready flag gates the Launch button, turning an explicit mission start into a two-click pattern](../plans/ready-filters-bulk-start-it-should-not-gate-an-explicit-launch.md) — **PLAN REVIEWED** — ID: 86af94b7-55e4-4387-a9d7-6c0a56a557a9
- [ ] [Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol](../plans/replace-the-mission-control-persona-with-a-run-sheet.md) — **PLAN REVIEWED** — ID: 254f724e-df9c-45e4-b4fc-e9c400eadc99
- [ ] [A supervised mission has no supervision: `type` is stored, shown and reported, but nothing wakes on a transition](../plans/supervised-missions-wake-the-controller-on-transitions.md) — **PLAN REVIEWED** — ID: 9516c942-a3af-42d3-8607-f904ac4113be
- [ ] [The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture](../plans/the-mission-control-front-door-delivers-twice-and-lies-about-the-posture.md) — **PLAN REVIEWED** — ID: 135f2c7b-a953-4a03-ba70-5e20928b97e3
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

### The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture

- **Seat:** Intern (Complexity 3)
- **Acceptance:**
  - No `/orchestration/` string remains in `.agents/workflows/switchboard.md` or its mirror; every `POST /` path the launcher names is registered in `LocalApiServer.ts`.
  - A `/switchboard` session arms end-to-end (adopt → confirm → `missionControlArmed` true) — must fail on the current tree, pass after the fix.
  - The launcher states the `prompt` field is the persona and gives no instruction to read `switchboard-mission-control/SKILL.md`; the read ban is scoped to inline content.
  - `interview`/`stale-session` prompts carry `ATTENDED=true` (not `UNATTENDED=true`); `resume` carries `UNATTENDED=true` (not `ATTENDED=true`); `no-persona` carries neither.
  - `manage-features/SKILL.md:412` distinguishes the two flags by exact token; grouping asks in an attended interview and skips when unattended.
- **Must not touch:** `launchMission` (already correct); the `no-persona` branch; the `UNATTENDED IMPROVER CONTRACT` at `agentPromptBuilder.ts:1963` (out of scope).

### Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol

- **Seat:** Coder (Complexity 6)
- **Acceptance:**
  - The `interview` prompt contains the menu heading and NOT `## The Tick`, `## Merge-Back`, or `stallCount`.
  - Every protocol path the menu names resolves on disk.
  - The `resume` prompt contains `## The Tick`, `## Signals`, `## Verify via Git`, and the `progress.json` stall-counter contract, and carries no menu.
  - Intentionally-removed sections (Tick, Context Is Cleared, the empty-fleet paragraph) are absent from the interview prompt and present in the resume prompt where they belong.
  - The run sheet is under 80 lines; no `-o /dev/null` appears anywhere; the orientation snippet appears exactly once; launcher and mirror agree modulo frontmatter.
- **Must not touch:** `switchboard-mission-control-http` and `switchboard-contracts` skills (named by branches, not inlined); the standalone `deliveryMode` question (recorded, not fixed here); the `#agent-dock` project-management buttons (a separate controller-UI plan).

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
