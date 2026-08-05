# External Orchestration — Governance, Brakes and Controls in Connections

## Goal

Gate and govern the declared-move channel so an external surface (Gemini Spark, Claude Cowork, or anything else that can write into the workspace) can act as an orchestrator over the local fleet **only when explicitly permitted, within a declared scope, and subject to the same stop controls as local automation** — with the controls living in Connections, not the Automation tab.

### Problem & background

**The mechanism is already live in `src/`; nothing governs it.** The declared-intent path is implemented and ungated today: an external agent writes a moves file to `.switchboard/instructions/moves/`, Switchboard watches the directory (`KanbanProvider.ts:819-828`, `fs.watch` with a 150ms settle), validates each line, and applies legal moves **through the same `moveCardToColumn` path a human click uses** — the apply function is `processDeclaredMoves` (`ScheduledJobsService.ts:144`), called on every workspace scan (`KanbanProvider.ts:815`) and on every moves-file write (`:824`). Outcomes are filed in the `board_move_requests` table (`KanbanDatabase.ts:222`). A `pipeline-manager` standing job (`ScheduledJobsService.ts:408`) is seeded whose entire work product is column transitions. This was committed 2026-08-05 (commits `4505876a`, `1c7de0f6`).

> **Superseded:** "The mechanism is being built; nothing governs it… the sibling plan now owns the full declared-intent path… the gate must land with it or before it."
> **Reason:** Stale briefing. The apply watcher and `processDeclaredMoves` are already committed in `src/` and run on every workspace with a moves directory. The gate is therefore a **remediation of live, ungated code**, not a concurrent landing with a mechanism still on paper. Treating it as future-tense misleads the coder into thinking there is sequencing slack there is not.
> **Replaced with:** The channel is live and ungated **now**. This plan remediates it: the gate, scope, caps, and brake must land against the existing `processDeclaredMoves` apply path, and until they do, any process that can write a file into `.switchboard/instructions/moves/` dispatches coding agents with no toggle, no scope limit, and no brake coverage.

That is the right mechanism and this plan does not relitigate it. But in Switchboard **a column move is a dispatch** — `moveCardToColumn` auto-dispatches the destination column's agent (`KanbanProvider.ts:8024+`, the same path `RemoteControlService._applyStateMirror` → `onColumnMove` → `{dispatched}` uses for Notion at `RemoteControlService.ts:623-663`). So the declared-move channel is, by construction, a remote agent-dispatch channel. Four things follow that the mechanism does not cover:

**Root cause 1 — the capability is default-ON by existence.** Once the apply watcher runs, *any* process that can write a file into `.switchboard/instructions/moves/` can dispatch coding agents. There is no toggle. That contradicts PRD contract #2 ("new capabilities ship default-OFF") for the highest-privilege capability in the feature, and it means the gate is "did the user happen to install a version with the watcher", not a decision anyone made.

**Root cause 2 — the brakes do not reach it.** `PipelineOrchestrator` holds `_running` and `_paused` (`:52`, persisted as `pipeline.paused` at `:279`), its tick bails on either (`:243`), and the user reaches them through `pipelineStart` / `pipelineStop` / `pipelinePause` / `pipelineUnpause` (`TaskViewerProvider.ts:12714-12729`). The declared-move apply path is orthogonal to all of it. So a user who hits **Stop** because agents are misbehaving stops local advancement while an external orchestrator keeps declaring moves that keep dispatching. The one control they will reach for does not cover the new path, and it will look like Stop is broken.

> **Note — pipeline verbs exist only in the extension host.** `PipelineOrchestrator` is constructed in exactly one place: `TaskViewerProvider.ts:760`. The standalone host (`src/standalone/`) does **not** construct one and exposes no pipeline verbs. This is load-bearing for the brake design in change 3: a brake that reads pipeline state must not assume a pipeline exists, or it silently bricks declared moves in `npx switchboard` (the host this project exists to build — PRD "two hosts, one engine").

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

* **Default OFF.** External orchestration is disabled until the user turns it on. A fresh install with the watcher compiled in grants nothing. The gate is **channel-level (per workspace)**, not per-connection: there is no authorship verification for moves files (anything that can write into the workspace can write one — see Security), so the toggle authorises *the channel*, and the panel copy must say so rather than implying per-surface control.
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
* **Brake integration crosses two subsystems** that currently know nothing about each other — `PipelineOrchestrator`'s in-memory `_running`/`_paused` and the file-driven apply watcher. Reading pipeline state from the apply path introduces a coupling that must not become a circular dependency or a startup-order hazard — and must be **host-aware**, because the standalone host has no pipeline at all (see change 3).
* **Held-versus-dropped is a data-loss decision.** A move arriving while the pipeline is stopped must not vanish, and must not silently flood in on unpause. Both failure directions are bad and the middle needs designing.
* **Remediation, not greenfield.** The apply path is already live in `src/` and ungated. The gate lands against running code, so there is a current (not future) window in which the capability is ungated; the brake rule must also avoid regressing the standalone host while fixing the extension host.

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
* **Sibling plan — Scheduled External-Agent Jobs.** Owns the moves file format, the apply watcher, `moves/applied/`, and the `board_move_requests` table (now implemented in `src/`). This plan owns the gate, the scope config, the brake integration, and the controls UI. **This plan adds a `held` status value to that table; it does not redefine it** (the schema is `status TEXT NOT NULL DEFAULT 'applied'` — free-text, so `held` is a new value, no migration). The watcher is already in `src/`, so the gate is a remediation landing against live code, not a concurrent ship.
* **`PipelineOrchestrator`** — `src/services/PipelineOrchestrator.ts:52` (`_paused`), `:98-119` (`stop`/`pause`/`unpause`), `:132-141` (`getState`), `:243` (tick guard), `:279` (persistence). Read state via `getState()` (or a host-aware accessor wrapping it); do not fork a second notion of running. **Constructed only at `TaskViewerProvider.ts:760` — absent in the standalone host.**
* **Pipeline verbs** — `TaskViewerProvider.ts:12714-12729` (`pipelineStart`/`pipelineStop`/`pipelinePause`/`pipelineUnpause`). Extension-host only.
* **Connections panel** — the controls land in its Jobs sub-tab (or an Orchestration section within it). Buildable headless-first; the gate must work with no UI at all.
* Config storage — the Kanban DB `config` table (`KanbanDatabase.ts:167`), which is the blessed home for multi-process state.

---

## Dependencies
* The apply watcher is **already in `src/`** (`processDeclaredMoves`, `KanbanProvider.ts:815/824`; `ScheduledJobsService.ts:144`), so this plan is a remediation on live code, not a prerequisite gate. The gate/scope/brake must land against that existing path; there is no "ship after the watcher" option — the watcher is already shipping from `src/`.
* **Standalone host** (`src/standalone/bootstrap.ts`) — the brake integration must tolerate the absence of `PipelineOrchestrator` here (see change 3). If the standalone host later gains a pipeline, the `noPipelineInHost` branch naturally retires.

---

## Adversarial Synthesis

Key risks: (1) **the channel is live and ungated now** — `processDeclaredMoves` runs on scan and on `fs.watch` with no gate, so until this plan lands any process that can write a file into `instructions/moves/` dispatches coding agents (present-tense remediation, not a future release window); (2) **Stop that does not stop** — the pipeline brakes are orthogonal to the file-driven apply path, so a user halting misbehaving agents watches an external orchestrator keep dispatching, and concludes the stop button is broken; (3) **the brake bricks the standalone host** — `PipelineOrchestrator` is built only in the extension host, so an unconditional "absent → held" rule permanently holds every dispatching move in `npx switchboard` while the toggle reads "on" (PRD contract #6 dead-button failure); (4) **held-move mishandling** — dropping queued moves loses work, releasing them all at once on unpause reproduces the runaway the pause existed to prevent; (5) **unverifiable authorship** — nothing can confirm which surface wrote a moves file, so per-surface/per-connection trust is an illusion and column-scope limits are the only real blast-radius control. Mitigations: land the gate/scope/brake against the existing apply path and default closed, resolving every ambiguous case to closed; read `_running`/`_paused` via a host-aware accessor that returns `noPipelineInHost` for the standalone host (gate + caps govern, do not hold) and `absentTransient` only for extension-host early startup; bound the hold queue, surface its depth, and drain it through the same per-cycle cap as fresh moves; state plainly in the panel that the gate authorises *the channel* (per workspace), not a particular vendor or connection.

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

**Edge cases:** read pipeline state through an accessor rather than reaching into private fields. The orchestrator may not be constructed yet during extension-host startup, and **in the standalone host (`npx switchboard`) no `PipelineOrchestrator` is ever constructed** (`src/standalone/` has none; it is built only at `TaskViewerProvider.ts:760`). The brake must distinguish these two cases:

> **Superseded:** "absent state resolves to held, not applied."
> **Reason:** That rule is correct for the extension-host startup-order hazard (pipeline not yet built → transient → hold). Applied unconditionally it is a **permanent hold in the standalone host**, where no pipeline ever exists — every dispatching move would be held forever while the toggle reads "enabled," bricking the declared-move channel in the one host this project exists to build (PRD "two hosts, one engine"; contract #6 — no dead buttons). A green "held" count is not a substitute for the channel actually working.
> **Replaced with:** a **host-aware brake rule**:
> - **Pipeline exists and is constructed** → read `_running`/`_paused`; dispatching moves are held when stopped/paused, non-dispatching moves apply. (Extension host, steady state.)
> - **Pipeline accessor exists but reports not-yet-constructed** (extension host, early startup) → hold dispatching moves (transient; drained once the pipeline is up). This preserves the original fail-safe intent.
> - **No pipeline in this host** (standalone / `npx switchboard`) → the brake is **not applicable**: there is no local fleet pipeline to stop, so the dispatch decision falls back to the gate's enable flag and the caps alone. Do not hold.
>
> Concretely: resolve the brake through a single accessor (e.g. `getPipelineDispatchState()` on the host/provider) that returns one of `{ running, paused, absentTransient, noPipelineInHost }`. Only `paused`, `!running`, and `absentTransient` hold dispatching moves; `noPipelineInHost` does not. This keeps the extension-host safety story intact and makes the standalone host's declared-move channel actually function — satisfying PRD contracts #6 (no dead buttons) and #7 (two-layer completion: the gate must work headless with no pipeline present).

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
* Brake tests: pipeline stopped ⇒ dispatching moves held, non-dispatching moves applied; unpause drains without exceeding the cap; **extension-host early startup (accessor reports `absentTransient`) ⇒ dispatching moves held**; **standalone host (accessor reports `noPipelineInHost`) ⇒ dispatching moves apply under the gate + caps, NOT held** — this is the regression test for the standalone dead-button failure.
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
11. **Standalone host parity (the PRD check):** under `npx switchboard` (no `PipelineOrchestrator`), enable the gate, drop a valid dispatching moves file. Confirm the move applies (not held) — the `noPipelineInHost` branch governs and the channel is usable in the standalone host, not bricked.

---

## Recommendation

Complexity 6 → **Send to Coder.** The apply watcher is already live and ungated in `src/` (`processDeclaredMoves`, `KanbanProvider.ts:815/824`), so this is a remediation of unreleased dev work, not a concurrent landing — land steps 1-3 (gate → scope + caps → host-aware brake) against the existing apply path before the next VSIX cut; until they land, the declared-move channel dispatches coding agents with no toggle, no scope, and no brake. The brake integration must be host-aware (the `noPipelineInHost` branch) or it bricks `npx switchboard` — the host this project exists to build.

**Migration:** none. The marketplace VSIX is 1.5.9 (shipped March 2026); the moves watcher first committed 2026-08-05 in unreleased dev work (`package.json` 1.7.13). No released version contains the ungated channel, so default-OFF gating is a **clean break** — no compat shim, no upgrade notice, no migration of prior `pipeline-manager` usage (there is none in the field).
