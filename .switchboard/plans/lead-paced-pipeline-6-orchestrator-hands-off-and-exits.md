# The Orchestrator Hands Off and Exits — One Team Means No Resident Manager

## Goal

When the orchestrator determines one team is enough, it finishes the job and leaves: scopes the plans, launches the team, stages the queue, dispatches the first card, reports the handoff, and exits. Arming a resident session becomes the exception for genuine multi-team coordination — not the default path every session takes.

### Problem & background

**For a one-at-a-time pipeline, a resident orchestrator is a manager watching a manager.**

Today every session ends the same way regardless of how much coordination it needs. `POST /orchestration/start` seats the orchestrator and delivers a pre-flight; the agent interviews the user, then calls `POST /orchestration/confirm` to arm; arming sets `automationMode: 'agent-managed'` with `enabled: true` (`confirmOrchestrationSession`, `src/services/TaskViewerProvider.ts:10695-10721`) and the orchestrator is woken every N minutes to decide the next action (`orchestrationConfig.intervalMinutes`, default 10 — `src/services/autobanState.ts:102-106`).

For the simple case that is two agents doing one agent's job. The lead already knows when its feature passed review — it was told by its own reviewer. Once it can ask for the next card (subtask 1), a resident orchestrator waking on a timer to observe the same fact adds a hop, a context, a token bill, and an independent failure mode. The pre-flight interview is also the wrong shape for the simple case: it exists so an autonomous all-night session can be authorised, and the simple case has nothing to authorise once handoff is complete.

**There is currently no way to not arm.** `/orchestration/confirm` is the only exit from the pre-flight, and it arms. An orchestrator that has done everything useful has no sanctioned way to say "done, the lead has it" and stop.

### Root cause — arming is the only terminal state the flow has

The session model has exactly two states: interviewing, and armed. Nothing represents *handed off*. So an orchestrator that finishes its advisory work either arms and idles, or is killed by the user — and because arming is the sanctioned path, it arms. The resident manager is a consequence of the state machine, not of anyone deciding a resident manager was wanted.

### What handoff means concretely

The orchestrator's last turn does five things, then ends:

1. **Scope.** Decide which plans are in this session, using the `## What Is Ready To Go` definition from subtask 5.
2. **Launch.** Seat the coding team if one is not already seated. Teams spawn their members automatically when an unparented terminal whose role heads a team is created — the orchestrator does not own them and does not need to.
3. **Stage.** Put the scoped plans into `DISPATCH` in the order they should run (subtask 2).
4. **Dispatch card one.** The same pop the lead makes, so cold start and steady state share one code path.
5. **Report and exit.** Say what was staged, which lead is pacing, and what the first card is. Then exit.

From that moment the pipeline is lead-paced (subtask 1), queue-ordered (subtask 2), and watched (subtask 3). Nothing needs to be awake.

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
* **Exit means the terminal ends.** An idle-but-seated orchestrator is a resident manager with extra steps and a live context bill. Remote Control does not change this: remote intake is a batch that wakes an orchestrator, gets sequenced, and hands off (subtask 7) — it needs no resident session.
* **The orchestrator dispatches card one through the queue pop**, not a bespoke path. One dispatch entry point for the button, the orchestrator and the lead.
* **The handoff report is required output.** An exit the user cannot see reads as a crash.

---

## Complexity Audit

### Routine

- A fourth `/orchestration/*` route beside `start`, `confirm` and `stop` (`LocalApiServer.ts:3933-3938`), following the same body-parse-and-delegate shape.
- Closing the seat — `_closeTerminal(ORCHESTRATOR_TERMINAL_NAME)` already exists (`TaskViewerProvider.ts:20060`, name constant at `:143`) and is what the `closeTerminal` webview action uses.
- Two persona sections and their gate assertions, in a file the gate already reads.

### Complex / Risky

- **Handoff deliberately breaks a stated rule of `/orchestration/stop`.** Stop "does NOT dispose the terminal — a running agent may hold uncommitted context; killing it is the user's call" (`:10723-10735`). Handoff closes it. The distinction is real (the agent has just reported and has nothing in flight) but must be written down, or the next reader unifies the two paths and reintroduces the resident seat.
- **Two paths could both believe they own pacing.** Handoff must leave the automation state exactly as it found it; `/confirm`'s arming block tears the engine down *before* flipping the mode (`:10707-10717`) and handoff must not copy that.
- **The armed state's meaning changes under subtask 4.** Arming today means `automationMode: 'agent-managed'`; subtask 4 deletes that axis. What "armed" resolves to afterwards is reconciled in the Dependencies section below.
- **Refusing an unsafe handoff is the difference between a feature and an outage.** Exiting after handing off to nobody strands the whole night.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Handoff racing the queue watch.** Subtask 3 arms on staging, so the watch exists before handoff dispatches. If handoff's dispatch fails, the watch is already armed and the user is told — the correct order.
- **Terminal close racing the report.** Post the summary to the session log **before** closing the seat; a close that lands first loses the report and the exit reads as a crash.
- **Handoff racing `/confirm`.** Both are terminal moves out of the pre-flight. The second call must be refused rather than applied on top — an armed-then-handed-off session has two owners.

### Security

- Localhost route, same trust boundary as the three existing `/orchestration/*` routes. It closes a terminal, so it must never be reachable from a `GET`.

### Side Effects

- **Closing the orchestrator terminal ends its context.** Anything the agent has not written to `session.md` or the session log is gone. The handoff report is therefore not optional — it is the durable record of what the session did.
- **The automation panel's meaning changes**: after handoff it shows a queue session with a pacing lead, not an armed orchestrator. A user who sees "nothing armed" and nothing else will conclude the night is not running.
- Handoff must not archive `session.md` the way `/orchestration/stop` does — a handed-off session's rules are still the record of what was scoped.

### Dependencies & Conflicts

- **Subtask 1 supplies the pop.** Handoff calls `dispatchNextFromQueue` **in-process**, not `POST /kanban/queue/next` over localhost against its own server.
- **Subtask 2 supplies staging.** Handoff calls the same exported `stageForQueue` the board button uses, so the scoped set gets ordered positions.
- **Subtask 4 and this plan disagree about the armed state — reconciled here.** Subtask 4 says "the orchestrator's `agent-managed` wake interval and `orchestrationConfig.intervalMinutes` go"; this plan keeps `armed` as the multi-team state, defined as "wake interval installed". Both cannot be true. The reconciled end-state: **the exclusive three-mode axis is what dies; the orchestrator wake survives as an independent boolean plus its interval on `orchestrationConfig`.** This plan writes handoff against `orchestrationConfig`, never against `automationMode`, so subtask 4's collapse of the mode axis does not have to rewrite it.
- **Subtask 5 supplies the scoping definition** (`## What Is Ready To Go`) that step 1 of the handoff sequence uses.
- **Persona edits serialise** with subtasks 5, 7 and 4 — one agent stream per file.

---

## Dependencies

- `e060b8c4-27bd-48ac-a5d1-c72f557ea27a` — The Coding Lead Paces Its Own Pipeline *(hard: supplies the pop handoff dispatches through)*
- `7e0983cc-c3a6-44d4-be7f-5b03917153d6` — The Dispatch Column Becomes the Session Queue *(hard: supplies the queue handoff stages into)*
- `3d112587-1374-4d7d-bd48-2601a7de885a` — The Orchestrator Becomes an Advisor *(soft: supplies the scoping definition and lands the persona's first pass)*
- `8919baf1-c7c2-4aa6-a54f-79f11b42187c` — Delete the Mode Axis and the Completion Hybrid *(reverse: subtask 4 sweeps `/confirm`'s `automationMode` write; land this first)*

---

## Adversarial Synthesis

**Risk summary.** The dangerous outcome is an orchestrator that exits having handed off to nobody — a night that ends before it starts, with the one agent that could have noticed already gone. Mitigation is a hard `409` on no live coding head or an empty queue, plus subtask 3's watch being armed at staging (before the dispatch) so a failed handoff still surfaces. The second risk is state ambiguity: handoff must touch no automation flag `/confirm` touches, or two paths end up believing they own pacing — which is exactly the coupling this feature exists to delete.

---

## Proposed Changes

### `src/services/LocalApiServer.ts` — `POST /orchestration/handoff`

**Context.** The three existing orchestration routes are registered at `:3933-3938` and delegate into `TaskViewerProvider`. `/confirm` is the only current exit from the pre-flight and it arms.

**Logic.** A fourth route and a terminal state.

Body: `{ workspaceRoot?, headTerminal, stagedCount, firstCardPlanId, summary }`.

**Implementation.**

1. **Refuse an unsafe handoff first.** No live coding head, or an empty queue → `409` naming exactly what is missing. Exiting after handing off to nobody is worse than not exiting. This check runs before anything is recorded.
2. **Record the handoff** — a session state of `handed off` with the pacing lead's terminal name and the staged count, readable by the automation panel.
3. **Post the summary to the session log** before touching the terminal.
4. **Close the orchestrator seat** via the existing `_closeTerminal(ORCHESTRATOR_TERMINAL_NAME)` path (`TaskViewerProvider.ts:20060`). State inline *why* this differs from `/orchestration/stop`, which deliberately leaves the terminal alive (`:10723-10735`): stop can fire while the agent holds uncommitted context; handoff fires immediately after the agent's own final report, so there is nothing to lose.
5. **Do not arm, and do not disarm.** The arming block (`confirmOrchestrationSession`, `:10695-10721`) is reached only by `/confirm`. Handoff must not call `_stopAutobanEngine()`, must not touch `automationMode`, and must not install or clear any timer — it leaves the automation state exactly as it found it so the two paths cannot both think they own pacing.
6. **Dispatch card one in-process.** The handoff *sequence* dispatches through subtask 1's `dispatchNextFromQueue`; the agent may make that call itself before calling `/handoff`, and `/handoff` verifies the queue is non-empty and a head is live rather than dispatching a second time.
7. **Refuse a second terminal move.** A session already `handed off` or already armed refuses with `409`.

**Edge Cases.** A handoff whose dispatch failed (no live terminal) is refused at step 1, so the orchestrator stays seated and can report the failure. `/orchestration/stop` must still work against a handed-off session (the seat is already gone; disarm is a no-op) and against an armed one.

### `.agents/skills/switchboard-orchestrator/SKILL.md` — the two new sections

**Context.** The persona currently ends its pre-flight at `### On confirmation` (`:99-119`), whose only exit is arming.

**Implementation.**

1. **`## Handoff, or arm?`** — a decision the agent makes explicitly and states. One team and a linear queue → handoff. Multiple teams, worktrees, or separate repos → arm, and say why in one line. Default is handoff; arming needs a stated reason.
2. **Two session states, named.** `handed off` (exited; nothing running but the queue and its watch) and `armed` (multi-team coordination, wake interval installed). Remote intake does not add a third: a batch of remote plans wakes an orchestrator, which sequences the batch and hands off exactly as an interactive session does (subtask 7).
3. **`## The handoff sequence`** — the five steps as an ordered procedure with the exact calls, ending in `POST /orchestration/handoff` and exit. Written so the agent cannot end a session in the seated-but-idle state this plan exists to remove.
4. **Handoff report shape.** Fixed and short: plans staged (count and ordered ids), the pacing lead's terminal name, the first card dispatched, and one sentence stating that the lead paces from here and the queue watch is armed. Bounded, per subtask 5's ceiling discipline.

### `src/services/TaskViewerProvider.ts` + the automation panel — board legibility

The panel shows a **queue session with its pacing lead** — not an armed orchestrator. A user looking at the board after handoff must see what is running and who is driving it; "nothing armed" with no other signal reads as "nothing is happening".

### `GET /catalog` and `.agents/skills/switchboard-orchestration/SKILL.md`

Add `POST /orchestration/handoff` with its body, its `409` conditions, and one line stating it is the default exit from the pre-flight.

---

## Verification Plan

### Automated Tests

- **Unit** — `/orchestration/handoff` with no live coding head → `409`; with an empty queue → `409`; with both → `200`, terminal closed, summary in the session log.
- **Unit** — handoff does not set `automationMode`, does not set the armed flag, does not call `_stopAutobanEngine`, and installs no timer.
- **Unit** — the summary is written to the session log **before** the terminal is closed (assert ordering, not just presence).
- **Unit** — a second terminal move (`/confirm` after `/handoff`, or `/handoff` twice) returns `409`.
- **Unit** — `/confirm` still arms, unchanged, for the multi-team path.
- **Contract test** — the persona contains `## Handoff, or arm?` and `## The handoff sequence`, and the handoff sequence ends in an exit. Both covered by the persona gate.
- **Regression** — `/orchestration/stop` still works against both a handed-off session and an armed one.

### Manual UAT

- **The headline case:** from a cold start with four ready plans and no team, run `/switchboard`. The orchestrator should scope, launch a team, stage four, dispatch one, report, and **exit**. Then all four must complete with no orchestrator running and no timers installed.
- A two-team worktree session still reaches the armed path, with the orchestrator stating why it armed.
- After handoff, the automation panel shows the queue session and the pacing lead, not an armed orchestrator.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

---

## Completion Report

Implemented `POST /orchestration/handoff` in `LocalApiServer.ts` and `TaskViewerProvider.ts`, enforcing pre-flight validation gates that return 409 if no live coding head exists, if the queue is empty, or if a second terminal transition is attempted. Fixed queue-empty verification to always check the board database unconditionally (never bypassing when stagedCount > 0) using candidate filter parity with `dispatchNextFromQueue` (`!dispatchedAt && !featureId`). Summary logging to `.switchboard/orchestrator/session.md` is strictly completed before closing the orchestrator terminal without touching `automationMode` or installing/clearing engine timers. Updated `.agents/skills/switchboard-orchestrator/SKILL.md` with `## Handoff, or arm?` and `## The handoff sequence`, updated `.agents/skills/switchboard-orchestration/SKILL.md`, and extended `src/test/orchestrator-tick-and-reports-contract.test.js` to gate all handoff contracts. No blocking issues encountered.
