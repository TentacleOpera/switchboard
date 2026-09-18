# Orchestration Starts as a Conversation, Not a Button Press

## Goal

Pressing Start does not start orchestration. It brings up the orchestrator in a terminal, where the agent runs a pre-flight check, tells you what is missing, proposes a goal for the session, and waits. Orchestration begins only when you answer it.

### Why

**An unattended run that begins on a click begins against a board that may not be ready.** No coding agents seated, a research prompt active with no researcher to serve it, plans sitting loose that you meant to group first, a worktree strategy that does not match what you are about to do. Today the kickoff simply proceeds and writes escalations into a log you read in the morning — the failures are discovered after the night is spent.

**The one moment a human is guaranteed present is the moment they press the button.** That is the moment to ask. Everything after it is unattended by design.

**The orchestrator is an ordinary agent.** It is not special machinery — it is a terminal running a CLI with a skill, exactly like a lead or a planner. So the way to talk to it before it starts is the way you talk to any agent: in its terminal.

### What the code does today (root cause, verified)

`startOrchestratorFromKanban` (`src/services/TaskViewerProvider.ts:10227-10413`) does five things in one uninterruptible sequence:

1. Finds or creates the `Orchestrator` terminal and boots the lead CLI (`:10241-10354`).
2. Builds a kickoff prompt inline (`:10366-10380`) that points at `.agents/skills/switchboard-orchestrator/SKILL.md` and injects `UNATTENDED=true`, `WORKSPACE_ROOT`, `ACTIVE_PROJECT_FILTER` — plus an imperative tail: *"Read the board, group plans into features, message the team leads … and ask them to report back when done."*
3. Delivers it via `_dispatchExecuteMessage`, surfacing a real error if delivery fails (`:10383-10395`).
4. **Arms the session** — `orchestrationConfig.enabled = true`, persisted and broadcast (`:10402-10407`).
5. **Switches the worktree topology** — `applyOversightWorktreeTopology(root, true)` (`:10412`).

Steps 1-3 are exactly what this plan wants Start to keep. Steps 4-5 are exactly what it must stop doing on Start. `POST /orchestration/start` (`LocalApiServer.ts:2543-2567`) calls the same method, so it inherits the same arming — which is why redirecting one door and not the other is not an option.

## The sequence

**1. Start brings up the orchestrator and stops.** It seats the terminal, launches the CLI, and hands the agent the pre-flight instruction. It arms nothing and installs no timer.

**2. The agent runs a pre-flight and reports.** It checks what this session will actually need and names anything missing, in plain terms:

- **Is there a coding *team* for the features in scope** — not merely a coding agent? See below; this is the check that most often decides whether a night is productive.
- Is there a planner or planning team?
- If the research prompt is active, is there a researcher to serve it?
- What is the worktree strategy, and does the board match it?
- Is there anything to do at all — plans in CREATED, features in PLAN REVIEWED?
- Are there loose plans that were probably meant to be grouped?

Missing things are reported, not fixed. The agent does not create teams, group plans, or change settings to make itself runnable — it says what it found and lets you decide.

**3. The agent proposes a goal for the session.** One short statement of what it intends to accomplish overnight, and the scope it will work within. You can alter it — narrow it to a subset of plans, exclude a feature, cap it at one lane.

**4. You confirm in the terminal, and only then does it begin.** The agent writes the agreed goal and scope to the session file and starts ticking.

**Start is user input, always.** No cron, no scheduled fire, no browser-load autostart may skip steps 2 and 3. A startup team (see `teams-start-themselves-on-load.md`) may seat the orchestrator's terminal on load — that seats an agent, it does not start orchestration.

### A feature needs a team, not an agent

A lone coder terminal is enough for a standalone plan. It is usually **not** enough for a feature: a feature is a set of subtasks, and one agent works them serially with no lead to hand off to and no reviewer to catch what it missed. The `Coding` team type exists precisely for this shape — a lead, coders, and a shared reviewer — and the review handoff described in `coding-team-sends-the-feature-to-review-not-each-subtask.md` has no head to perform it if there is no team.

So when features are in scope and only a single coding agent is seated, the pre-flight must say so plainly and **strongly recommend starting a coding team** before the session begins. Name the features it is worried about, so the recommendation is concrete rather than generic advice.

It remains a recommendation, not a gate. You may proceed with a lone agent — but you will have been told, before the night is spent, rather than after.

The same sequence runs when you simply ask the orchestrator about orchestration in its terminal. There is one entry path, and the button is a shortcut to it rather than a second mechanism.

## Where the entry point lives

**The AUTOMATION tab holds configuration; the terminal holds the conversation.** The tab owns which CLI command starts the orchestrator, how often it wakes, and which mode is active. It does not own starting, because starting is a dialogue and a settings panel is a poor place to have one. Its button *opens the orchestrator* — it does not start orchestration.

**Not the TEAMS tab.** A team is a head with members working subtasks. The orchestrator is a singleton with no members; giving it a team card recreates the "Solo coder" entry that `teams-tab-three-presets-and-phone-a-friend.md` removes for exactly this reason — a team-type card for something that is not a team.

**Not a new panel.** One agent does not need a third surface.

### Two doors, one sequence

The other door already exists and shipped: the `/switchboard` management console, whose Automation menu offers **"Arm / disarm the unattended engine — `POST /orchestration/start`."** The authored source is `.agents/workflows/switchboard.md:326`; `.claude/skills/switchboard/SKILL.md:328` is its generated mirror (`ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST`, `source: 'workflows/switchboard.md'`).

Today that arms the engine directly. After this plan it must not: **`POST /orchestration/start` seats the orchestrator and delivers the pre-flight — it never begins ticking.** Any caller reaching it, from the tab, the console, or a script, lands in the same conversation.

Leaving one door with a pre-flight and one without is the two-mechanism pattern that produced the original footgun the console skill was written to close — a human opening a management view and silently triggering unattended automation. Do not reintroduce it on the API side.

Reserve a separate resume path for a session already confirmed (see verification 8), so restarting a dead terminal does not re-run the interview.

## Confirmation needs a mechanism, not just a file

The original sequence says the agent "writes the agreed goal and scope to the session file and starts ticking". Writing a file does not install a timer. The interval lives in the extension host (agent-managed mode, `automation-tab-three-exclusive-modes.md`), so something must carry "the user said yes" from the terminal back to the host.

> **Superseded:** confirmation is complete when the agent writes `.switchboard/orchestrator/session.md`; ticking follows.
> **Reason:** arming is an extension-host action — it flips `orchestrationConfig.enabled` and starts the wake clock. A markdown file written by an agent cannot do either. Leaving the mechanism unstated is how this plan ships a pre-flight that never arms anything, with every verification except #6 and #7 quietly unmet.
> **Replaced with:** the agent writes `session.md` and then calls **`POST /orchestration/confirm`**, which performs exactly the arming half that Start no longer does. The write comes first so a confirm that races a host restart still finds its session on disk.

**One mechanism, not two.** No file-watcher backstop that arms on `session.md` appearing. An agent that cannot reach the local API cannot cause a timer to be installed in a host it cannot reach either, so a second path buys nothing real and reintroduces the two-door problem this plan exists to close.

`POST /orchestration/confirm` is the arming half moved verbatim out of `startOrchestratorFromKanban`:

- Set `orchestrationConfig.enabled = true`, persist, broadcast (`TaskViewerProvider.ts:10402-10407`).
- `applyOversightWorktreeTopology(root, true)` (`:10412`).
- Return `{ success: true, sessionFile }` — or `{ success: false, error }` when `session.md` is absent, so an agent that forgot to write it learns immediately instead of arming a session with no rules.

### Resume, and what Stop must clear

**Resume is a branch in the seat prompt, keyed on ground truth.** When the orchestrator is seated, the host checks two facts: does `.switchboard/orchestrator/session.md` exist, and is `orchestrationConfig.enabled` true?

| `session.md` | armed | prompt delivered |
| :--- | :--- | :--- |
| absent | either | **pre-flight** — the full interview |
| present | true | **resume** — read `session.md`, continue under the existing rules, do not re-interview |
| present | false | **pre-flight**, told a stale session file exists and offering to reuse its goal |

**Stop must clear the session, or Start stops interviewing forever.** `stopOrchestratorFromKanban` (`TaskViewerProvider.ts:10423`) currently only disarms. If it leaves `session.md` in place, the next Start reads row three of that table on a session the user already ended. Stop renames it to `.switchboard/orchestrator/sessions/session-<ISO>.md` — the overnight record survives for reading, and the next Start starts clean.

## The session file

Confirmation produces `.switchboard/orchestrator/session.md`, in two parts:

- **Rules** — the agreed goal, the scope, the worktree strategy, which lanes are active. Written once at confirmation, then read-only for the session.
- **Log** — append-only, what actually happened. Only real actions; idle ticks write nothing.

This file is the session's memory (see `orchestrator-persona-becomes-a-tick.md`), which is why it is written before the first tick rather than discovered along the way.

### It supersedes `session-log.md`, which is a shipped read surface

`.switchboard/orchestrator/session-log.md` is what the current persona writes (`.agents/skills/switchboard-orchestrator/SKILL.md:147`) and what `GET /orchestrator/session-log` reads — the path is hardcoded at `LocalApiServer.ts:2789`, the route registered at `:3950`, documented to agents at `.agents/skills/switchboard-orchestration/SKILL.md:62` and `:336`, and present in `protocol-catalog.json`. Moving the log into `session.md` without touching it leaves a shipped endpoint that returns `''` forever on installs that have not migrated.

**Change `_handleGetOrchestratorSessionLog` to read `session.md` when it exists and fall back to `session-log.md` otherwise.** The endpoint name, route and response shape are unchanged; the fallback is the migration, and it costs one branch. Update the two `switchboard-orchestration` lines to name `session.md` as the current file and `session-log.md` as the legacy fallback.

### Where the pre-flight text lives — and the file this plan does *not* own

The pre-flight is agent behaviour, so it belongs in the persona skill, not in a string literal. This plan writes a **`## Pre-flight`** section and a **`## Session File`** section into `.agents/skills/switchboard-orchestrator/SKILL.md`; the injected prompt points at the skill and supplies runtime context, exactly as `:10369-10377` does today.

`orchestrator-persona-becomes-a-tick.md` rewrites **the rest of that same file**. The ownership split is: this plan owns `## Pre-flight` and `## Session File`; the persona plan owns everything else and must not rewrite those two sections. This plan lands first, so the persona rewrite is authored with them already present.

## Order — third of four

Requires `automation-tab-three-exclusive-modes.md` (2 of 4), which creates agent-managed mode and the Start this plan redefines — there is no button to change until it exists. That in turn requires `worktree-strategy-is-the-users-choice.md` (1 of 4), whose setting the pre-flight reports on.

`orchestrator-persona-becomes-a-tick.md` (4 of 4) lands after this one: it reads the session file that confirmation produces here.

## Metadata

**Complexity:** 6
**Tags:** ux, backend, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a route arm and handler for `POST /orchestration/confirm`, mirroring `_handleOrchestrationStart` (`LocalApiServer.ts:2543`) line for line.
- One branch in `_handleGetOrchestratorSessionLog` (`:2786-2797`).
- Writing two sections into the persona skill.
- Renaming `session.md` on stop.

### Complex / Risky

- **Splitting a shipped method that four callers depend on.** `startOrchestratorFromKanban` is reached from the AUTOMATION tab verb (`KanbanProvider.ts:8519`), a command (`TaskViewerProvider.ts:3342`), and `POST /orchestration/start` (`LocalApiServer.ts:2559`). Every one of them must land on seat-and-interview, and none may keep the old arming behaviour.
- **The arming state machine gains a third state.** Today: not armed / armed. After: seated-not-armed / seated-and-armed / not-seated. `isAutomationArmed` (`TaskViewerProvider.ts:1078`) ORs `orchestrationConfig.enabled` into the double-dispatch guard, so a seated-but-unarmed orchestrator must read as *not armed* — otherwise merely opening the orchestrator blocks the run sheet.
- **Ordering of the arm.** The topology switch deliberately rides the arming transition *after every early return* (`:10408-10412`) so a failed kickoff never leaves `per-feature` switched on with a stashed prior and no restore path. Moving arming to a separate endpoint must preserve that property, not re-open the bug `feature_plan_20260816150001_oversight-stops-being-a-mode.md` closed.
- **A conversation is not a state machine the host can see.** The host knows the agent was seated; it cannot know whether the user answered. The only evidence is the confirm call. A user who closes the terminal mid-interview leaves a seated, unarmed orchestrator and no session file — which must be a clean no-op, not a half-state.

## Edge-Case & Dependency Audit

### Race Conditions

- **Start pressed twice.** Today the second press reuses the live terminal and re-injects the kickoff (`:10243-10257`). After this change the second press must re-deliver the *pre-flight*, which is idempotent — it reports and waits. Harmless, but the second delivery arrives mid-conversation; deliver with `clearBeforePrompt: false` so the first interview's context is not wiped.
- **Confirm while already armed.** Two confirms (agent retry, user double-answer) must be idempotent: setting `enabled = true` twice is a no-op, and `applyOversightWorktreeTopology` already carries a double-enter guard (`KanbanProvider.ts:2248-2251`). Do not add a new guard; rely on the existing one.
- **Confirm racing a host restart.** The agent writes `session.md` before calling confirm, so a confirm lost to a restart leaves the rules on disk and the session unarmed — the next Start lands on table row three and offers to reuse the goal. This is the intended failure mode.
- **Stop during an interview.** No session file exists, so the rename is a no-op. Disarm proceeds normally.

### Security

- `POST /orchestration/confirm` inherits `_checkAuth(req, true)` and the localhost gate from the endpoint it mirrors. It is strictly *less* dangerous than `/orchestration/start` is today, because it cannot seat a terminal or spawn a CLI — it only flips a flag on a session the user already interviewed.
- The session file is agent-authored and gitignored (`.gitignore:52`, `.switchboard/*`). It must never be parsed into anything executable; it is prose the agent re-reads.

### Side Effects

- Start becomes non-arming. Any external script that relied on `POST /orchestration/start` to arm automation stops arming — that is the intended behaviour change and the reason both doors must change together. Say so in the endpoint's response message rather than returning a bare success.
- `stopOrchestratorFromKanban` gains a filesystem rename. It must stay best-effort: a rename failure logs and disarm still completes.
- The `GET /orchestrator/session-log` response body changes shape in practice (two-part document rather than a bare log) for callers on new sessions. The route contract — markdown string, `''` when absent — is unchanged.

### Dependencies & Conflicts

- **`src/services/TaskViewerProvider.ts`** — `startOrchestratorFromKanban` (`:10227`) and `stopOrchestratorFromKanban` (`:10423`). `agent-reports-go-to-a-file-inbox.md` edits the turn-end notifier in the same file at `:1243`. Non-overlapping regions, same file: serialise (PRD *Orchestration discipline*, one stream per file).
- **`.agents/skills/switchboard-orchestrator/SKILL.md`** — shared with `orchestrator-persona-becomes-a-tick.md`. Ownership split stated above; this plan lands first.
- **`.agents/skills/switchboard-orchestration/SKILL.md`** — this plan edits the two session-log lines (`:62`, `:336`); the inbox plan appends a reports section; the launcher plan appends the verb-rail traps. Three appenders, distinct regions, serialise.
- **`.agents/workflows/switchboard.md:326`** — the console's Automation menu line describing Start as "arm the unattended engine". It becomes false with this change. `switchboard-skill-becomes-a-launcher.md` deletes the whole file's console content, so if the launcher lands first this edit disappears with it; if this plan lands first, fix the line here. Either order is safe — do not both edit it.
- **`automation-tab-three-exclusive-modes.md`** supplies agent-managed mode and the wake interval; **`worktree-strategy-is-the-users-choice.md`** supplies the setting the pre-flight reports.

## Dependencies

- `sess_automation_modes — automation-tab-three-exclusive-modes.md` (2 of 4): agent-managed mode, the interval, and the Start button this plan redefines.
- `sess_worktree_strategy — worktree-strategy-is-the-users-choice.md` (1 of 4): the worktree strategy setting the pre-flight reads and reports.
- `sess_orchestrator_tick — orchestrator-persona-becomes-a-tick.md` (4 of 4): consumer of `session.md`; lands after this plan.
- `sess_oversight_topology — feature_plan_20260816150001_oversight-stops-being-a-mode.md`: the shipped `applyOversightWorktreeTopology` ordering guarantee that must survive the split.

## Adversarial Synthesis

**Risk summary.** The load-bearing risk is a pre-flight that talks and never arms: Start correctly stops arming, and nothing ever turns the timer on, so the feature ships as a polite agent that does nothing overnight — and every verification except "it waits" passes. `POST /orchestration/confirm`, carrying the arming block moved verbatim (including the after-every-early-return topology ordering), is the mitigation, with the missing-`session.md` failure returned honestly rather than as a silent success. The second risk is the new seated-but-unarmed state leaking into `isAutomationArmed` and blocking the run sheet; it is closed by keying that guard on `orchestrationConfig.enabled` only, which seating no longer sets.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `startOrchestratorFromKanban` (`:10227-10413`)

- **Context.** Seats the terminal, boots the CLI, injects a kickoff prompt, arms the session, switches topology.
- **Logic.** Keep steps 1-3. Move steps 4-5 into a new public `confirmOrchestrationSession(workspaceRoot)`. Replace the imperative kickoff tail with a pre-flight or resume instruction chosen by the two-fact branch.
- **Implementation.**
  - Delete lines `:10402-10412` from this method; move them verbatim into `confirmOrchestrationSession`, preserving the "after every early return" ordering and the `applyOversightWorktreeTopology(root, true)` call.
  - Before building the prompt, resolve `sessionExists = fs.existsSync(<root>/.switchboard/orchestrator/session.md)` and `armed = this._autobanState.orchestrationConfig?.enabled === true`.
  - Prompt tail becomes one of: pre-flight (`!sessionExists`), resume (`sessionExists && armed`), or pre-flight-with-stale-session (`sessionExists && !armed`). Keep `UNATTENDED=true`, `WORKSPACE_ROOT`, `ACTIVE_PROJECT_FILTER` and the pointer at `.agents/skills/switchboard-orchestrator/SKILL.md` unchanged — the pre-flight protocol lives in that skill's `## Pre-flight` section.
  - The kickoff-delivery failure path (`:10387-10395`) is unchanged and still surfaces an error.
- **Edge cases.** A missing persona file still falls back to the stand-by prompt (`:10379`). Re-pressing Start on a live terminal re-delivers with `clearBeforePrompt: false`.

### `src/services/TaskViewerProvider.ts` — `confirmOrchestrationSession` (new, public)

- **Context.** The arming half, callable over HTTP.
- **Logic.** Verify the session file, then arm.
- **Implementation.** Resolve the root via `_resolveWorkspaceRoot`; if `session.md` is absent return `{ success:false, error:'no session file — write .switchboard/orchestrator/session.md before confirming' }`. Otherwise run the moved arming block and return `{ success:true, sessionFile }`.
- **Edge cases.** Idempotent on a second call. Relies on `applyOversightWorktreeTopology`'s existing double-enter guard rather than adding one.

### `src/services/TaskViewerProvider.ts` — `stopOrchestratorFromKanban` (`:10423`)

- **Context.** Disarms only; does not dispose the terminal.
- **Logic / Implementation.** After the existing disarm, best-effort rename `.switchboard/orchestrator/session.md` → `.switchboard/orchestrator/sessions/session-<ISO>.md` (mkdir -p first). Log and continue on failure.
- **Edge cases.** No session file → no-op. A name collision on the ISO second → append a counter suffix rather than overwriting an archived session.

### `src/services/LocalApiServer.ts`

- **Context.** `_handleOrchestrationStart` (`:2543`), `_handleOrchestrationStop` (`:2575`), `_handleGetOrchestratorSessionLog` (`:2786`), route table (`:3894-3896`, `:3950`).
- **Logic.** Add the confirm door; correct the start door's message; make the log read prefer `session.md`.
- **Implementation.**
  - `_handleOrchestrationConfirm` mirroring `_handleOrchestrationStart` exactly: `_checkAuth(req, true)`, 503 when the callback is absent, parse `{ workspaceRoot? }`, call it, respond. New `orchestrationConfirm` entry in `LocalApiServerOptions`, wired in `TaskViewerProvider` as `(root) => this.confirmOrchestrationSession(root)`, and in the standalone bootstrap's router alongside its siblings.
  - Route arm: `else if (pathname === '/orchestration/confirm' && req.method === 'POST')`.
  - `_handleOrchestrationStart`'s success message changes from `'Orchestration engine armed'` to something true — the orchestrator is seated and awaiting confirmation. A caller reading the message is the only signal a script has that the semantics changed.
  - `_handleGetOrchestratorSessionLog` (`:2789`): try `session.md`, fall back to `session-log.md`, `''` if neither.
  - Regenerate `protocol-catalog.json` so the new endpoint is discoverable — the catalog has gone stale on exactly this kind of addition before.
- **Edge cases.** The standalone host must construct the confirm callback or honestly report the verb absent (PRD contract #6) — never a route that answers success with nothing wired behind it.

### `.agents/skills/switchboard-orchestrator/SKILL.md` — new `## Pre-flight` and `## Session File` sections

- **Context.** The persona the injected prompt points at. This plan adds two sections; `orchestrator-persona-becomes-a-tick.md` rewrites the rest.
- **Logic.** The pre-flight protocol as agent-readable steps.
- **Implementation.** `## Pre-flight`: the six checks, the report-don't-fix rule, the team-not-agent recommendation with features named, the goal proposal, and the stop-and-wait. On confirmation: write `session.md` (Rules then Log), then `POST /orchestration/confirm`, and only then begin. `## Session File`: the two-part structure, that Rules are written once and read-only thereafter, that the Log is append-only and idle ticks write nothing, and that this file supersedes `session-log.md`.
- **Edge cases.** The resume branch must be described here too, or a restarted terminal re-interviews despite the host sending the resume prompt.

### `.agents/skills/switchboard-orchestration/SKILL.md` (`:62`, `:336`)

- **Implementation.** Name `.switchboard/orchestrator/session.md` as the current session file and `session-log.md` as the legacy fallback the endpoint still honours. Add `POST /orchestration/confirm` to the endpoint table. Regenerate the `.claude/` mirror rather than hand-editing it.

### `.agents/workflows/switchboard.md:326`

- **Implementation.** Only if this plan lands before `switchboard-skill-becomes-a-launcher.md`: correct "Arm / disarm the unattended engine" to describe seating the orchestrator into a pre-flight. If the launcher lands first the line is already gone — do not edit it twice.

## Verification Plan

1. Press Start with no coding team seated: the agent says so and waits. No card moves, no timer is installed.
2. Press Start with features in scope and only a **single coding agent** seated: the pre-flight strongly recommends a coding team and names the features at risk. Confirming anyway proceeds — it is advice, not a gate.
3. Press Start with features in scope and a coding team seated: no such recommendation appears.
4. Press Start with a research prompt active and no researcher: it is named in the pre-flight.
5. Press Start on an empty board: the agent says there is nothing to do rather than starting a session that will idle all night.
6. The agent proposes a goal and stops. Nothing runs until a reply is typed.
7. Reply narrowing scope to two plans: the session file records that scope, and the ticks stay inside it.
8. Kill and restart the terminal mid-session: the agent picks up the existing session file rather than re-running pre-flight from scratch.
9. A cron fire or a browser-load startup team seats the orchestrator's terminal but does not begin orchestration.
10. `POST /orchestration/start` — called from the `/switchboard` console or by hand — lands in the same pre-flight and does not begin ticking. Both doors behave identically.
11. **After Start and before any answer**, `orchestrationConfig.enabled` is still false and the worktree topology is unchanged. Confirm, and both flip in the same step.
12. `POST /orchestration/confirm` with no `session.md` on disk returns `{success:false}` and arms nothing.
13. A seated-but-unconfirmed orchestrator does not trip the double-dispatch guard: the run sheet can still be armed from the AUTOMATION tab while the interview is open.
14. Stop, then Start again: the interview runs from scratch, and the previous session survives under `.switchboard/orchestrator/sessions/`.
15. `GET /orchestrator/session-log` returns `session.md` when it exists, and the legacy `session-log.md` on an install that still has one.

### Automated Tests

Not run this session (SKIP TESTS directive). Coverage a later run should add: `startOrchestratorFromKanban` leaves `orchestrationConfig.enabled` false (the inverse of what `src/test/autoban-state-regression.test.js` asserts today for the armed path); the three-way prompt branch; and `confirmOrchestrationSession` rejecting a missing session file. `src/test/autoban-state-regression.test.js:448` pins the exact `isAutomationArmed` source shape — check whether that assertion still holds before editing anything near it.

---

**Recommendation:** Complexity 6 → **Send to Coder.**

## Completion report (2026-08-17, appended by lead-1)

Implemented in `50255c66` (persona `## Pre-flight` + `## Session File`) and `f741a304` (code and docs). Start now seats the orchestrator and delivers a three-way prompt branch (pre-flight / resume / stale-session) instead of arming; the arming block moved verbatim into a new public `confirmOrchestrationSession`, reached by `POST /orchestration/confirm`. `stopOrchestratorFromKanban` archives `session.md` to `sessions/session-<ISO>.md` with a counter suffix on collision, `_handleGetOrchestratorSessionLog` prefers `session.md` and falls back to the legacy file, `protocol-catalog.json` was regenerated, and the start endpoint's success message no longer claims the engine is armed. Two instructions in this plan were stale and were deliberately not followed: `applyOversightWorktreeTopology` is deleted and two tests assert it stays deleted, and `isAutomationArmed` is likewise asserted dead, so no replacement guard was added.

Verified by lead-1 against the diff rather than the coder's account. Compilation and tests not run — SKIP COMPILATION / SKIP TESTS were in force for this run, so this plan's written Verification Plan remains unexecuted. Note: the coder reported completion to the lead over `ptySendPrompt` and was never instructed to append this report itself, so the board saw no completion signal for this card until now.

## Review Findings

Reviewed 2026-08-17 with tests run — the prior "SKIP TESTS in force" note is a record of the coder's run, not a directive to the reviewer. **CRITICAL:** `test:contract:autoban-state` (CI-wired) was RED — its `startOrchestratorFromKanban must set enabled: true` assertion still encoded the arming this subtask deleted, and the stale `orchestrationConfig.enabled` name in the resume prompt tripped the field-deletion grep. Fixed: the assertion is inverted (Start must NOT arm) and retargeted at `confirmOrchestrationSession`, which is now pinned for the engine-down-before-mode-flip ordering and the missing-`session.md` refusal; the stale field name was scrubbed from `TaskViewerProvider.ts`, `LocalApiServer.ts` and `switchboard-orchestration/SKILL.md`. Also fixed: pressing Start left the AUTOMATION toggle snapping back to OFF with no explanation (correct state, reads as a dead button) — the existing `automation-status-line` now says the orchestrator is seated and awaiting confirmation. Files changed: `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/webview/kanban.html`, `src/test/autoban-state-regression.test.js`, `.agents/skills/switchboard-orchestration/SKILL.md` (+ mirror). Validation: typecheck 0 errors, lint 0 errors, 99/106 CI gates green; the 7 failures are pre-existing in memo/terminal/tickets/ws-surface and untouched by this feature. Remaining risk: the standalone host still returns 503 for `/orchestration/confirm` — honest per PRD contract #6, but a standalone-hosted orchestrator cannot arm itself.
