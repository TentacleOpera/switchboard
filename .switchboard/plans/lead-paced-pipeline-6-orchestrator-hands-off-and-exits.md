# The Orchestrator Hands Off and Exits — One Team Means No Resident Manager

## Goal

When the orchestrator determines one team is enough, it finishes the job and leaves: scopes the plans, launches the team, stages the queue, dispatches the first card, reports the handoff, and exits. Arming a resident session becomes the exception for genuine multi-team coordination — not the default path every session takes.

### Problem & background

**For a one-at-a-time pipeline, a resident orchestrator is a manager watching a manager.**

Today every session ends the same way regardless of how much coordination it needs. `POST /orchestration/start` seats the orchestrator and delivers a pre-flight; the agent interviews the user, then calls `POST /orchestration/confirm` to arm; arming sets `automationMode: 'agent-managed'` with `enabled: true` (`src/services/TaskViewerProvider.ts:10633-10642`) and the orchestrator is woken every N minutes to decide the next action (`orchestrationConfig.intervalMinutes`, default 10 — `src/services/autobanState.ts:105`).

For the simple case that is two agents doing one agent's job. The lead already knows when its feature passed review — it was told by its own reviewer. Once it can ask for the next card (plan 1), a resident orchestrator waking on a timer to observe the same fact adds a hop, a context, a token bill, and an independent failure mode. The pre-flight interview is also the wrong shape for the simple case: it exists so an autonomous all-night session can be authorised, and the simple case has nothing to authorise once handoff is complete.

**There is currently no way to not arm.** `/orchestration/confirm` is the only exit from the pre-flight, and it arms. An orchestrator that has done everything useful has no sanctioned way to say "done, the lead has it" and stop.

### Root cause — arming is the only terminal state the flow has

The session model has exactly two states: interviewing, and armed. Nothing represents *handed off*. So an orchestrator that finishes its advisory work either arms and idles, or is killed by the user — and because arming is the sanctioned path, it arms. The resident manager is a consequence of the state machine, not of anyone deciding a resident manager was wanted.

### What handoff means concretely

The orchestrator's last turn does five things, then ends:

1. **Scope.** Decide which plans are in this session, using the `## The ready set` definition from plan 5.
2. **Launch.** Seat the coding team if one is not already seated. Teams spawn their members automatically when an unparented terminal whose role heads a team is created — the orchestrator does not own them and does not need to.
3. **Stage.** Put the scoped plans into `DISPATCH` in the order they should run (plan 2).
4. **Dispatch card one.** `POST /kanban/queue/next` — the same call the lead makes, so cold start and steady state share one code path.
5. **Report and exit.** Say what was staged, which lead is pacing, and what the first card is. Then exit.

From that moment the pipeline is lead-paced (plan 1), queue-ordered (plan 2), and watched (plan 3). Nothing needs to be awake.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, api, refactor, reliability
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Five decisions made here:

* **Handoff is a real terminal state**, not "arm and hope the agent stays quiet."
* **Handoff is the default for one team.** Arming requires a reason the orchestrator must state — multiple teams, worktrees, or cross-repo coordination.
* **Exit means the terminal ends.** An idle-but-seated orchestrator is a resident manager with extra steps and a live context bill — *except* under Remote Control, which is a third state rather than an exception to the rule (see below).
* **The orchestrator dispatches card one through `queue/next`**, not a bespoke path. One dispatch entry point for the button, the orchestrator and the lead.
* **The handoff report is required output.** An exit the user cannot see reads as a crash.

---

## Implementation

**Blocked on plans 1 and 2** — handoff dispatches through `queue/next` into a staged queue.

1. **`POST /orchestration/handoff`** beside `/orchestration/start`, `/confirm` and `/stop` (`src/services/LocalApiServer.ts:3933-3938`). Body: `{ workspaceRoot?, headTerminal, stagedCount, firstCardPlanId, summary }`. It records the handoff, leaves `enabled` reflecting a running queue session rather than an armed orchestrator, posts the summary to the session log, and closes the orchestrator terminal.

2. **Do not arm on handoff.** The arming block (`TaskViewerProvider.ts:10633-10642`) is reached only by `/confirm`. Handoff must not touch `automationMode` — under plan 4 that axis is gone, and until then handoff must leave it exactly as it found it so the two paths cannot both think they own pacing.

3. **Persona: `## Handoff, or arm?`** — a decision the agent makes explicitly and states. One team and a linear queue → handoff. Multiple teams, worktrees, or separate repos → arm, and say why in one line. Remote Control active → stay seated (subtask 7). Default is handoff; anything else needs a stated reason.

3b. **Three session states, named.** `handed off` (exited, nothing running but the queue), `armed` (multi-team coordination, wake interval installed), and `seated` (Remote Control — idle, **no timer**, woken only by inbound instructions per `switchboard-contracts` #9). The seated state is what keeps subtask 7 from contradicting this plan's exit rule: a terminal woken by push costs nothing between messages, which is not true of an armed one. Handoff must refuse to exit while Remote Control is active.

4. **Persona: `## The handoff sequence`** — the five steps above as an ordered procedure with the exact calls, ending in `POST /orchestration/handoff` and exit. Written so the agent cannot end a session in the seated-but-idle state that this plan exists to remove.

5. **Handoff report shape.** Fixed and short: plans staged (count and ordered ids), the pacing lead's terminal name, the first card dispatched, and the sentence that the lead paces from here and the queue watch is armed. Bounded, per plan 5's ceiling discipline.

6. **Refuse an unsafe handoff.** No live coding head, or an empty queue, returns `409` naming what is missing. Exiting after handing off to nobody is worse than not exiting.

7. **Board legibility.** The automation panel shows a queue session with its pacing lead — not an armed orchestrator. A user looking at the board after handoff must see what is running and who is driving it.

---

## Verification Plan

- **Unit:** `/orchestration/handoff` with no live coding head → `409`; with an empty queue → `409`; with both → `200`, terminal closed, summary in the session log.
- **Unit:** handoff does not set `automationMode` or the armed flag, and does not install any timer.
- **Unit:** `/confirm` still arms, unchanged, for the multi-team path.
- **Contract test:** the persona contains `## Handoff, or arm?` and `## The handoff sequence`, and the handoff sequence ends in an exit. Both are covered by the persona gate.
- **Unit:** the `seated` state installs no timer — the distinction from `armed` is the whole justification for allowing a non-exiting orchestrator, so a wake interval leaking into it is a real defect.
- **Manual UAT — the headline case:** from a cold start with four ready plans and no team, run `/switchboard`. The orchestrator should scope, launch a team, stage four, dispatch one, report, and **exit**. Then all four must complete with no orchestrator running and no timers installed.
- **Manual UAT:** a two-team worktree session still reaches the armed path, with the orchestrator stating why it armed.
- **Manual UAT:** after handoff, the automation panel shows the queue session and the pacing lead, not an armed orchestrator.
- **Regression:** `/orchestration/stop` still works against both a handed-off session and an armed one.
