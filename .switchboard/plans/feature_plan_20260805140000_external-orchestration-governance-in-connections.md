# External Orchestration — Governance, Brakes and Controls in Connections

## Goal

Gate and govern the declared-move channel so an external surface (Gemini Spark, Claude Cowork, or anything else that can write into the workspace) can act as an orchestrator over the local fleet **only when explicitly permitted, within a declared scope, and subject to the same stop controls as local automation** — with the controls living in Connections, not the Automation tab.

### Problem & background

**The mechanism is being built; nothing governs it.** The sibling plan *Scheduled External-Agent Jobs* now owns the full declared-intent path: an external agent writes a moves file to `.switchboard/instructions/moves/`, Switchboard watches the directory, validates each line (planId exists, column exists, transition legal), applies legal moves **through the same move-card path a human click uses**, files the result in `board_move_requests`, and ships a `pipeline-manager` standing job whose entire work product is column transitions.

That is the right mechanism and this plan does not relitigate it. But in Switchboard **a column move is a dispatch** — moving a card into a coding column starts an agent, which is what `RemoteControlService._applyStateMirror` → `onColumnMove` → `{dispatched}` already does for Notion. So the declared-move channel is, by construction, a remote agent-dispatch channel. Four things follow that the mechanism plan does not cover:

**Root cause 1 — the capability is default-ON by existence.** Once the apply watcher runs, *any* process that can write a file into `.switchboard/instructions/moves/` can dispatch coding agents. There is no toggle. That contradicts PRD contract #2 ("new capabilities ship default-OFF") for the highest-privilege capability in the feature, and it means the gate is "did the user happen to install a version with the watcher", not a decision anyone made.

**Root cause 2 — the brakes do not reach it.** `PipelineOrchestrator` holds `_running` and `_paused` (`:52`, persisted as `pipeline.paused` at `:279`), its tick bails on either (`:243`), and the user reaches them through `pipelineStart` / `pipelineStop` / `pipelinePause` / `pipelineUnpause` (`TaskViewerProvider.ts:12677-12696`). The declared-move apply path is orthogonal to all of it. So a user who hits **Stop** because agents are misbehaving stops local advancement while an external orchestrator keeps declaring moves that keep dispatching. The one control they will reach for does not cover the new path, and it will look like Stop is broken.

**Root cause 3 — no scope or rate limit.** A moves file with two hundred valid lines dispatches two hundred agents. Every line is individually legal; the aggregate is not something anyone intended. There is also no restriction on *which* columns an external party may move into — the channel that advances a plan to a review column can equally advance it to a coding column, or to COMPLETED.

**Not a root cause: coexistence with the local orchestrator persona.** `switchboard-orchestrator` also moves cards, but it is a different class of thing — a heavyweight unattended batch manager doing grouping, worktree dispatch and merge-back — and a user runs one or the other, not both. No arbitration mechanism is specified here. If the two ever do overlap, Switchboard remains the only executor of declared moves, so the DB stays consistent; the failure mode would be duplicate dispatch, which the caps in change 2 already bound.

**Why Connections and not the Automation tab.** These are two different questions that look similar. The Automation tab governs **how the local engine runs** — tick interval, drain versus watch, starting and stopping our own fleet. This plan governs **what an outside party is permitted to do to that engine**: whether it may act at all, which columns it may reach, how much it may do per cycle. That is a privilege attached to a *connection* — closer to an OAuth scope than to an engine setting. Filing "who may drive this machine" under "how fast the machine runs" puts the trust decision in the operations panel and hides it from the panel that exists to describe external surfaces.

The practical test: a user auditing what Spark is allowed to do should find the answer next to where they connected Spark. Under Automation they would have to already know the capability exists to go looking for it — which is the exact discoverability failure the Connections panel was created to fix.

**Scope boundary.** This plan adds no new command types. It does **not** introduce direct terminal prompts from an external orchestrator: a declared move is checkable (planId exists, column exists, transition legal), whereas a free-text prompt into `ptySendPrompt` has no schema against which "is this legal" can be answered. Moves already give an external orchestrator real dispatch power inside a validated envelope; raw prompt injection from an unattended process gives that property up for a capability moves largely cover. If it is ever wanted it is a separate plan with its own safety case.

---

## Metadata
**Complexity:** 6
**Tags:** security, backend, ui, reliability, infrastructure
**Project:** browser-switchboard

---

## User Review Required

**None.** Three decisions made here:

* **Default OFF.** External orchestration is disabled until the user turns it on, per connection. A fresh install with the watcher compiled in grants nothing.
* **Stop means stop, globally.** The existing pipeline stop/pause controls hold declared moves that would dispatch. One brake, both paths — not a second stop button the user has to learn about.
* **No new command vocabulary.** Column moves only. See the scope boundary above.

---

## Complexity Audit
* **Score:** 6 / 10

### Routine
* A persisted boolean and a small scope config in the Kanban DB config table.
* A gate check at the top of the apply path.
* A controls section in an existing panel.

### Complex / Risky
* **This is a privilege boundary, so failure modes are asymmetric.** A gate that fails open silently grants remote dispatch; a gate that fails closed merely stops work. Every ambiguous case must resolve to closed.
* **Brake integration crosses two subsystems** that currently know nothing about each other — `PipelineOrchestrator`'s in-memory `_running`/`_paused` and the file-driven apply watcher. Reading pipeline state from the apply path introduces a coupling that must not become a circular dependency or a startup-order hazard.
* **Held-versus-dropped is a data-loss decision.** A move arriving while the pipeline is stopped must not vanish, and must not silently flood in on unpause. Both failure directions are bad and the middle needs designing.
* **Ordering with the sibling plan.** The apply path is being built now. The gate must land with it or before it, or there is a released window in which the capability is ungated.

---

## Edge-Case & Dependency Audit

### Race Conditions
* **Enable flipped off mid-apply.** A moves file part-applied when the user disables must stop cleanly at a line boundary, record which lines applied and which were abandoned, and not re-apply the applied ones on re-enable.
* **Stop pressed during an apply cycle.** Same requirement: finish or abandon at a line boundary, never mid-move.
* **Unpause thundering herd.** Moves accumulated while paused must not all apply at once on unpause — that is precisely the runaway the user pressed pause to avoid. Drain them through the same per-cycle cap as fresh moves.

### Security
* **This is the security surface of the whole feature.** Everything else in Connections is prompts and files; this one starts agents that execute code and modify the repo. Treat the gate as a privilege boundary: default closed, explicit to open, visible while open, and instantly revocable.
* **Writer authentication is not available and must not be pretended.** Anything that can write into the workspace can write a moves file — a stray script, another agent, a synced folder. The gate is the only meaningful control; there is no way to verify *which* external surface authored a file. State this honestly in the panel copy rather than implying per-surface authorisation. Column-scope limits exist precisely because authorship cannot be verified.
* **Scope limits are the blast-radius control.** Allow-listing target columns means a compromised or confused writer can advance work through review stages but cannot, say, mark everything COMPLETED or dispatch the entire backlog.

### Side Effects
* An enabled external orchestrator causes agent runs that spend real quota and change the repo, with nobody watching. The panel must show this is on, not bury it in a settings list.
* Held moves accumulate while stopped. Bound the queue and surface the depth; an unbounded hold is a delayed flood.

### Dependencies & Conflicts
* **Sibling plan — Scheduled External-Agent Jobs.** Owns the moves file format, the apply watcher, `moves/applied/`, and the `board_move_requests` table. This plan owns the gate, the scope config, the brake integration, and the controls UI. **This plan adds a `held` status to that table; it does not redefine it.** Land together or gate-first.
* **`PipelineOrchestrator`** — `src/services/PipelineOrchestrator.ts:52` (`_paused`), `:98-119` (`stop`/`pause`/`unpause`), `:135` (state), `:243` (tick guard), `:279` (persistence). Read state from here; do not fork a second notion of running.
* **Pipeline verbs** — `TaskViewerProvider.ts:12677-12696`.
* **Connections panel** — the controls land in its Jobs sub-tab (or an Orchestration section within it). Buildable headless-first; the gate must work with no UI at all.
* Config storage — the Kanban DB `config` table, which is the blessed home for multi-process state.

---

## Dependencies
* None blocking, but sequencing matters: the gate must not ship *after* the apply watcher.

---

## Adversarial Synthesis

Key risks: (1) **an ungated release window** — the apply watcher is being built now, and if the gate lands after it there is a shipped version in which any process that can write a file dispatches coding agents; (2) **Stop that does not stop** — the pipeline brakes are orthogonal to the file-driven apply path, so a user halting misbehaving agents watches an external orchestrator keep dispatching, and concludes the stop button is broken; (3) **held-move mishandling** — dropping queued moves loses work, releasing them all at once on unpause reproduces the runaway the pause existed to prevent; (4) **unverifiable authorship** — nothing can confirm which surface wrote a moves file, so per-surface trust is an illusion and column-scope limits are the only real blast-radius control. Mitigations: ship the gate with or before the watcher and default it closed, resolving every ambiguous case to closed; read `_running`/`_paused` from `PipelineOrchestrator` rather than forking a second notion of running, and treat a dispatching move under stop as held; bound the hold queue, surface its depth, and drain it through the same per-cycle cap as fresh moves; state plainly in the panel that the gate authorises *the channel*, not a particular vendor.

---

## Proposed Changes

**Build order:** (1) gate → (2) scope + caps → (3) brake integration → (4) controls UI. Steps 1-3 are the safety story and are worth landing before the UI.

### 1. The gate — default closed

**Implementation:** a persisted flag in the Kanban DB config table (`connections.externalOrchestration.enabled`, default `false`). The apply path checks it **first**, before parsing a moves file. Disabled means files are left in place untouched, not deleted and not marked — re-enabling processes what accumulated, subject to the caps below.

**Logic:** leaving files in place makes disabled a true pause rather than a silent bin, and means a user who enables the feature after an agent has been writing for a week does not discover their instructions were discarded.

**Edge cases:** a missing or unreadable config value resolves to **disabled**. Every ambiguous read fails closed — this is the asymmetric-failure rule and it applies to the config read as much as to the validation.

### 2. Scope and caps

**Implementation:** stored alongside the flag:
* `allowedTargetColumns: string[]` — target columns an external orchestrator may move *into*. Default to review/inspection columns, **not** coding columns; the user opts into dispatch-triggering targets deliberately.
* `maxMovesPerFile: number` — a file exceeding it is rejected whole, logged, and left for the user, rather than half-applied.
* `maxDispatchesPerHour: number` — a rolling cap across all applied moves that trigger a dispatch. On breach, subsequent dispatching moves are **held**, not dropped.

**Logic:** the per-file cap catches a runaway generator; the hourly cap catches a slow leak that no single file reveals. They fail differently and both are needed.

**Edge cases:** a move whose target is outside `allowedTargetColumns` is **skipped with a reason**, exactly like an invalid planId — a legal move the user has not authorised, not an error. Record it so the user can see what the orchestrator wanted and widen scope deliberately.

### 3. Brake integration — one stop, both paths

**Implementation:** the apply path reads `PipelineOrchestrator` state (`:135`) before applying. When `_running` is false or `_paused` is true:
* moves whose target column **would trigger a dispatch** are **held** — recorded in `board_move_requests` with a new `held` status and left un-applied;
* moves whose target column does **not** dispatch may still apply. Decide this per-column from the same routing config the board uses; do not hard-code a list.

On unpause or start, drain held moves oldest-first through the normal caps.

**Logic:** the user's mental model is "Stop means no new agents start." Honouring that for the external path costs one state read and removes an entire class of "the stop button is broken" confusion. Letting non-dispatching moves through preserves bookkeeping progress while the fleet is halted, which is the actual intent of pausing.

**Edge cases:** read pipeline state through an accessor rather than reaching into private fields, and tolerate the orchestrator not being constructed yet during startup — **absent state resolves to held**, not applied.

### 4. Controls in Connections

**Implementation:** in the Jobs sub-tab, an Orchestration section carrying:
* the enable toggle, with the current state legible at a glance — this is a privilege that starts agents, so it should not look like a preference;
* the scope config (allowed columns, caps);
* a live list from `board_move_requests`: applied, skipped-with-reason, held-with-reason, and the hold-queue depth;
* a kill switch that disables the gate and clears held moves in one action.

**Logic:** the audit list is what makes the gate trustworthy. A toggle with no visibility into what the channel has been doing is a checkbox the user cannot reason about.

**Edge cases:** when external orchestration is enabled, surface it outside this panel too — a status indicator wherever the automation state is already shown. A privilege that only announces itself on the page where it was granted is one the user forgets is on. No confirm dialog on the toggle or the kill switch; both act immediately.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* Gate tests: disabled ⇒ no moves applied and files untouched; missing config ⇒ treated as disabled; unreadable config ⇒ treated as disabled.
* Cap tests: a file over `maxMovesPerFile` applies **nothing**; the hourly cap holds rather than drops; held moves drain oldest-first under the cap.
* Brake tests: pipeline stopped ⇒ dispatching moves held, non-dispatching moves applied; unpause drains without exceeding the cap; **absent pipeline state ⇒ held**.
* Scope test: a target outside `allowedTargetColumns` is skipped with a reason, not applied and not errored.

### Manual Verification
1. **Fresh install grants nothing:** with the watcher present and the gate never touched, drop a valid moves file. Nothing applies; the file is still there.
2. **Enable, then apply:** turn it on, drop the same file, confirm the move applies through the human-click path — mirror re-exports, board updates, feature recomputation fires.
3. **Stop means stop (the headline check):** with external orchestration enabled and a `pipeline-manager` job running, press **Stop**. Confirm no new agents start, that dispatching moves show as *held* with the reason, and that the hold depth is visible.
4. **Unpause is not a flood:** accumulate held moves, then unpause. They drain oldest-first under the cap, not all at once.
5. **Scope refusal:** configure allowed columns to review-only, then declare a move into a coding column. Skipped with a reason, visible in the panel, no dispatch.
6. **Per-file cap:** a file over the limit applies **zero** lines — not a partial prefix.
7. **Kill switch:** with moves in flight and held, hit it. Applying stops at a line boundary, held moves clear, nothing is half-applied.
8. **Visible while on:** with the gate enabled, confirm it is legible outside Connections wherever automation state is shown.
9. **Honest copy:** the panel does not claim to authorise a specific vendor. It authorises the channel — anything that can write to the workspace can write a moves file, and the copy says so.
10. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 6 → **Send to Coder.** Land steps 1-3 before or with the sibling plan's apply watcher; there must be no released version in which the declared-move channel is ungated.
