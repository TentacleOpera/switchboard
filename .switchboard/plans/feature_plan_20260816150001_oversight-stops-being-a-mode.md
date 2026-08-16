# Orchestration Stops Being a Mode — Oversight Becomes a Flag

## Goal

Make the orchestrator an **optional oversight agent that runs alongside** board automation, armed by `orchestrationConfig.enabled`, instead of a peer value of `automationMode`. After this plan the OVERSIGHT AGENT toggle that already renders actually reaches the engine.

### Problem & background

**`automationMode` is a single-valued enum, so `orchestration` as a peer mode *deselects* board progression.** That forces a false choice: oversight OR automation, never both. The two are complementary by design — the run sheet owns the mechanical transition (a reviewed plan goes to a coder); the orchestrator owns the judgement transitions the run sheet deliberately does not automate (into PLAN REVIEWED and into CODE REVIEWED), plus grouping plans into features and worktree merge-back. Modelling a supervisor as a sibling of the thing it supervises is what produced an Orchestration mode whose panel had nothing on it: there was nothing to configure because the mode was never the right container.

**The tree is HALF-MIGRATED and this plan closes it.** An earlier pass landed the UI half and part of the webview logic:

* `kanban.html:11073–11116` renders an OVERSIGHT AGENT subsection whose checkbox posts the shipped `startOrchestrator` / `stopOrchestrator` messages, and already reads its *checked* state from `state.orchestrationConfig.enabled` (`:11100`).
* The toolbar click handler (`kanban.html:9788`) already carries the comment *"Orchestration is no longer a mode, so the toolbar button always drives the run sheet"* and unconditionally posts `toggleAutoban`.
* `autobanState.ts` already maps the persisted `orchestration` mode value to the surviving board-progression mode (`:251–256`) and carries the intent across into `orchestrationConfig.enabled` (`:314–322`).

But seven sites still branch on the mode, so **the toggle renders, checks, and the engine never hears about it** — a live instance of the project PRD's "no dead buttons" violation (contract #6).

The seven, verified in the working tree on 2026-08-16 (**line numbers drift — anchor on the symbol names, not the digits**):

| Site | Symbol | What it does today |
| :--- | :--- | :--- |
| `kanban.html:6923` | `updateAutobanButtonState` | toolbar active-state + tooltip keyed on the mode |
| `TaskViewerProvider.ts:9826` | `_stopAutobanIfNoValidTicketsRemain` | auto-stop-on-empty returns `false` in orchestration mode |
| `TaskViewerProvider.ts:10264` | `startOrchestratorFromKanban` | **writes** `automationMode: 'orchestration'` |
| `TaskViewerProvider.ts:10289` | `setAutomationModeFromKanban` | accepted-modes array includes `'orchestration'` |
| `TaskViewerProvider.ts:10340` | `setAutomationModeFromKanban` | ternary disarms `orchestrationConfig` on any other mode |
| `KanbanProvider.ts:2253` | worktree-mode reset guard | `getAutomationMode() === 'orchestration'` |
| `KanbanProvider.ts:8453` | `setAutomationMode` verb arm | `msg.mode === 'orchestration'` drives worktree topology |

The two remaining `'orchestration'` literals — `autobanState.ts:253` (comment) and `:319` (migration) — are the intentional state migration and **must stay**.

**Correction to the earlier draft of this plan: `isAutomationArmed` is NOT one of those sites.** It is a dependency closure passed into `OversightPassService` (`TaskViewerProvider.ts:1058`) and it reads **only** `this._autobanState.enabled === true`. It never mentions the mode. It still has to change, and it is still the highest-consequence change here, but for a different reason — see the Complex/Risky section. Reading it as a mode branch will send an implementer looking for a comparison that does not exist.

---

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, ui, reliability

---

## User Review Required

**None.** Four decisions made here:

* **Oversight is a flag, not a mode.** `orchestrationConfig.enabled` is the single source of truth for "is an orchestrator supervising".
* **Arming oversight does not start automation, and disarming does not stop it.** They are independent.
* **The mode names are NOT changed here.** The tree currently reads `'run-sheet' | 'scheduler'`; renaming to `internal` / `external` is the sibling plan's job. This plan touches only the orchestration-as-a-mode axis, so the two do not collide on the same identifiers.
* **The state migration already landed and is not re-done.** `autobanState.ts:314–322` sets `orchestrationConfig.enabled = true` when the persisted mode was `orchestration`. Keep it exactly as is.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Repointing five boolean checks from a mode comparison to a config flag.
* Removing one value from an accepted-modes array.

### Complex / Risky

* **`isAutomationArmed` (`TaskViewerProvider.ts:1058`) is the quiet one — and it is not a mode branch.** It is `() => this._autobanState.enabled === true`, consumed by `OversightPassService.start()` (`OversightPassService.ts:189–197`) to return a **409** when a pass would double-dispatch against a live engine. Today `startOrchestratorFromKanban` sets `enabled: true` (`:10261–10266`), so an armed orchestrator *incidentally* trips that guard. The moment arming oversight stops setting `autobanState.enabled`, the incidental coverage disappears: an oversight pass can start while an orchestrator is working the same board. No type error, no UI symptom; the failure is two engines dispatching the same cards.
* **`startOrchestratorFromKanban` sets `enabled: true` and the mode in one write** (`:10261–10266`). Splitting those is the whole point — otherwise arming oversight hijacks automation. Note the mirror image already over-reaches: `stopOrchestratorFromKanban` (`:10276–10285`) sets `enabled: false` **and** calls `_stopAutobanEngine()`, so today untick-oversight kills board progression.
* **Worktree topology is keyed on the mode transition, and BOTH halves are on it.** `KanbanProvider.ts:8452–8477`: the `if (msg.mode === 'orchestration')` arm stashes the prior under `orchestration_prior_feature_worktree_mode` and switches to `per-feature`; the **`else` arm restores and consumes the prior on every other mode value**. With orchestration no longer a mode, the `if` arm is unreachable *and* the `else` arm fires on every ordinary mode switch — so arming oversight silently stops switching topology, and any later mode switch eats a prior that oversight stashed. Neither is a type error.
* **The auto-stop-on-empty guard changes meaning.** `TaskViewerProvider.ts:9820–9828` returns `false` while in orchestration mode. Keyed on oversight it becomes "do not auto-stop while an oversight agent is running" — correct intent, real behaviour change.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **Toggle-then-render.** The oversight checkbox already derives `checked` from the broadcast (`kanban.html:11100`), but its `change` handler optimistically rewrites the *label* (`:11112`) before the provider confirms. If `startOrchestrator` fails, the box reads "Running" while nothing is armed. Drive the label from the broadcast too, and let the re-render correct a failed arm.
* **Double-enter on worktree topology.** `orchestration_prior_feature_worktree_mode` has an `if (!savedPrior)` guard (`KanbanProvider.ts:8457`). Any new arming path must reuse it or a fast off/on cycle overwrites the true prior with `per-feature` and the user never gets their topology back. The consume-on-restore (`db.setConfig(PRIOR_KEY, '')`, `:8474`) must move with it.
* **Double-dispatch.** See `isAutomationArmed` above — fix it in the same commit as the arming split, not after.

### Security

* Not a privilege change. No new routes; `startOrchestrator` / `stopOrchestrator` are reused unchanged.

### Side Effects

* Installs persisted in `orchestration` mode already normalise onto the surviving board-progression mode with `enabled: true` carried over, so on the next reload `_tryRestoreAutoban` (`TaskViewerProvider.ts:10051–10060`) starts the run-sheet engine for them. After this plan they get board progression **and** an armed oversight agent — strictly more than they had, and the intended outcome.
* A user who previously stopped the orchestrator by switching mode now uses the toggle. The old gesture no longer exists.

### Dependencies & Conflicts

* **`src/services/TaskViewerProvider.ts`** — `isAutomationArmed` dep closure (`:1058`), `getAutomationMode()` (`:1113`), `_stopAutobanIfNoValidTicketsRemain` (`:9820`), `startOrchestratorFromKanban` (`:10088`, arming write at `:10261`), `stopOrchestratorFromKanban` (`:10276`), `setAutomationModeFromKanban` (`:10287`, accepted-modes `:10289`, ternary `:10340`).
* **`src/services/KanbanProvider.ts`** — `:2248–2258` (active-session guard on worktree reset), `:8448–8483` (`setAutomationMode` verb arm: topology stash *and* restore).
* **`src/webview/kanban.html`** — `updateAutobanButtonState` (`:6904`, orchestration branch `:6923`) and the stale comment block at `:6917–6920`, which still documents `single-column` / `orchestration`; the OVERSIGHT AGENT subsection (`:11073–11116`).
* **Sibling plan — internal/external rename.** Lands **after** this one. Both edit `TaskViewerProvider.ts` and `kanban.html`, so per the PRD's one-stream-per-file rule they serialise.
* **Shared symbol with both siblings:** the accepted-modes array at `TaskViewerProvider.ts:10289`. This plan removes `'orchestration'`, leaving `['run-sheet', 'scheduler']`. Do not pre-empt the rename or the `scheduler` removal here.

---

## Dependencies

* None. Everything needed is in the tree.
* **Blocks** the internal/external rename and everything downstream of it — the rename should not run against a tree where the mode axis still carries orchestration.

---

## Adversarial Synthesis

Key risks: (1) **`isAutomationArmed` silently stops guarding** — and an implementer who trusts the old "eight sites branching on the mode" framing will grep for a comparison that was never there, find nothing, and skip it; the result is an oversight pass and an orchestrator dispatching the same cards, with no error anywhere. (2) **The worktree-topology `else` arm is left behind**, so the stash side moves onto oversight while the restore side stays on the mode path and gets consumed by the next unrelated mode switch. (3) **Entangled arming** — a careless split either starts automation whenever oversight is armed, or leaves `stopOrchestratorFromKanban`'s `_stopAutobanEngine()` call in place so unticking oversight still kills board progression. (4) **The optimistic toggle label** reporting "Running" for an orchestrator that never started — the hollow-success pattern this codebase keeps reproducing. Mitigations: widen `isAutomationArmed` in the same commit as the arming split; move **both** halves of the topology switch; write arming and enabling as two independent state writes and delete the `_stopAutobanEngine()` call from the stop path; drive the toggle's label from the broadcast config.

---

## Proposed Changes

**Build order:** (1) provider state and arming → (2) worktree topology → (3) UI leftovers. State first, so the toggle is never live against an engine that cannot hear it.

### 1. Stop treating orchestration as a mode in the provider

* `setAutomationModeFromKanban` (`:10289`) — accepted-modes array drops `'orchestration'`, leaving `['run-sheet', 'scheduler']`.
* `startOrchestratorFromKanban` (`:10261–10266`) — stops writing `automationMode`. It writes **only** `orchestrationConfig: { ...DEFAULT_ORCHESTRATION_CONFIG, ...existing, enabled: true }`, and must **not** set `autobanState.enabled`.
* `stopOrchestratorFromKanban` (`:10276–10285`) — mirror image: sets `orchestrationConfig.enabled = false`, must **not** set `autobanState.enabled = false`, and must **not** call `_stopAutobanEngine()`.
* `setAutomationModeFromKanban` (`:10340`) — the ternary keyed on `newMode !== 'orchestration'` goes; the `orchestrationConfig` spread carries through unchanged. Switching automation modes must not disarm oversight; only the toggle does.
* `_stopAutobanIfNoValidTicketsRemain` (`:9826`) — the guard reads `this._autobanState.orchestrationConfig?.enabled === true`. Update the comment to say why: an oversight agent is still working the board, so an empty column is not a stop condition.
* `isAutomationArmed` (`:1058`) — becomes `() => this._autobanState.enabled === true || this._autobanState.orchestrationConfig?.enabled === true`. This is the `OversightPassService` 409 guard; it must not narrow. Keep the 409 message accurate to both arms.
* `getAutomationMode()` (`:1113`) — audit callers. Any caller meaning "is the orchestrator running" gets an explicit `isOversightAgentRunning()` accessor instead of overloading the mode. `KanbanProvider.ts:2253` is one such caller (see §2).

**Edge cases:** arming oversight mid-tick must not restart or stop the engine. Do not add a second state migration beside the one at `autobanState.ts:314–322`.

### 2. Move worktree topology onto the oversight-arming path

* Move **both** halves out of the `setAutomationMode` verb arm (`KanbanProvider.ts:8448–8483`):
  * the `if (msg.mode === 'orchestration')` arm (stash prior + switch to `per-feature` + `_sendWorktreeConfig`) → onto the `orchestrationConfig.enabled` false → true transition;
  * the `else` arm (restore prior + clear `PRIOR_KEY` + `_sendWorktreeConfig`) → onto the true → false transition.
  After the move, the `setAutomationMode` arm touches worktree topology **not at all**. Leaving the `else` behind is the failure mode: it would fire on every ordinary mode switch and consume a prior that oversight stashed.
* Keep the existing `if (!savedPrior)` double-enter guard (`:8457`) and the `validModes` clamp (`:8472`) verbatim.
* `KanbanProvider.ts:2253` — the guard that skips resetting worktree mode during an active orchestrator session reads oversight state (via the new `isOversightAgentRunning()` accessor) instead of the mode.

**Edge cases:** the restore only applies when a stashed prior exists, so a user's manual topology change is not clobbered. `setFeatureWorktreeMode` already clears `PRIOR_KEY` (`KanbanProvider.ts:11959–11963`) — leave that as is. Do not delete worktrees as part of any topology change.

### 3. Finish the UI

* `kanban.html:6923` — the `updateAutobanButtonState` branch keyed on orchestration mode goes; `isActive` is the automation-enabled state and the tooltip is the automation tooltip. Rewrite the stale comment block at `:6917–6920`, which still names `single-column` and `orchestration`. (The click handler at `:9788` already landed — do not re-edit it.)
* The OVERSIGHT AGENT toggle renders its checked state **and its label** from the broadcast `orchestrationConfig.enabled`; delete the optimistic label write at `:11112` so a failed arm settles to "Off".
* Add an oversight status line so the section says something when idle. Replacing an empty mode with an empty subsection repeats the defect this plan exists to fix.

**Edge cases:** no confirmation dialog on the toggle (project rule). No tombstone comments explaining that orchestration used to be a mode.

---

## Verification Plan

### Automated Tests

* A persisted `automationMode: 'orchestration'` normalises with `orchestrationConfig.enabled === true` (guards the already-landed migration against regression).
* Arming oversight does **not** set `autobanState.enabled` and does not stop or restart the engine; disarming does not stop it and does not call `_stopAutobanEngine()`.
* `isAutomationArmed` returns true when oversight is armed and automation is off — assert through `OversightPassService.start()` returning **409**, not by reading the closure.
* Switching automation modes leaves `orchestrationConfig.enabled` untouched.
* Arming oversight switches `feature_worktree_mode` to `per-feature` and stashes the prior exactly once across a rapid off/on/off/on cycle; disarming restores it and clears the key.
* A `setAutomationMode` call does **not** read, write, or clear `orchestration_prior_feature_worktree_mode` — this is the assertion that catches the `else` arm being left behind.
* The auto-stop-on-empty guard returns `false` while oversight is armed and `true` when it is not.
* Grepping `src/` for `automationMode === 'orchestration'` / `mode === 'orchestration'` returns nothing outside `autobanState.ts:253` and `:319`.

### Manual Verification

1. **Oversight is additive:** tick OVERSIGHT AGENT. Automation keeps running and the orchestrator starts. Untick — the orchestrator stops, automation keeps running.
2. **Not a dead control:** confirm the toggle reaches the engine — the orchestrator terminal appears and the status line reflects it.
3. **Failed arm reads honestly:** with no orchestrator available, tick it and confirm it settles to "Off", not "Running".
4. **Existing orchestration user:** set `automationMode: 'orchestration'` in persisted state, reload, confirm oversight is already ticked.
5. **Worktree topology:** arm oversight, confirm per-feature worktrees; disarm, confirm the prior topology returns. Then arm oversight, switch automation mode (without touching the toggle), and confirm the topology is still `per-feature` — the `else`-arm regression.

---

## Recommendation

Complexity 5 → **Send to Coder.**

**The tree is half-migrated — read the Problem section before editing.** The toggle, the toolbar click handler and the state migration are already in. Re-doing them will conflict. The job is the seven mode sites plus `isAutomationArmed`.

**The thing to get right:** `isAutomationArmed` (`:1058`). It is **not** a mode branch — it reads `autobanState.enabled`, and arming the orchestrator trips it only incidentally today. The moment arming stops setting `enabled`, the 409 that stops a double-dispatch stops firing: no type error, no UI symptom, two engines dispatching the same cards. Widen it in the same commit as the arming split.

**Second:** move **both** halves of the worktree-topology switch at `KanbanProvider.ts:8448–8483`. The `if` arm becomes unreachable; the `else` arm becomes actively wrong. Verify by arming the toggle and inspecting `feature_worktree_mode`, then by switching automation mode and confirming the topology holds.

**Migration:** already landed at `autobanState.ts:314–322`. Do not add another. Do **not** rename `singleColumnConfig` or the `'singleColumn.autoban.state'` key.

---

## Completion Report

Implemented the full oversight-as-a-flag migration across all seven mode sites plus `isAutomationArmed`. In `TaskViewerProvider.ts`: widened `isAutomationArmed` to OR on `orchestrationConfig.enabled` (prevents the silent double-dispatch regression), split `startOrchestratorFromKanban`/`stopOrchestratorFromKanban` to write only `orchestrationConfig` (no `enabled`, no `automationMode`, no `_stopAutobanEngine()`), dropped `'orchestration'` from the accepted-modes array and the disarming ternary in `setAutomationModeFromKanban`, repointed `_stopAutobanIfNoValidTicketsRemain` to the oversight flag, and added `isOversightAgentRunning()`. In `KanbanProvider.ts`: moved both halves of the worktree-topology stash/restore out of the `setAutomationMode` arm into the `startOrchestrator`/`stopOrchestrator` arms (preserving the double-enter guard and validModes clamp), and repointed the `_reconcileStaleWorktreeMode` guard to `isOversightAgentRunning()`. In `kanban.html`: removed the orchestration branch from `updateAutobanButtonState`, rewrote the stale comment, deleted the optimistic toggle label write, added a status line, and added `workspaceRoot` to the `stopOrchestrator` message. Also updated stale docstrings in `OversightPassService.ts` and `LocalApiServer.ts`. No issues hit; the intentional `autobanState.ts:253`/`:319` migration references were left untouched, and grep confirms no `'orchestration'` mode comparisons remain outside them.

### Revision — worktree topology moved to the arming transition

Review caught two defects in the initial topology move: (1) the topology lived on the KanbanProvider verb arms, which `POST /orchestration/start|stop` bypass entirely (they wire straight to the provider methods), so an HTTP arm switched no topology; (2) the verb arm applied topology BEFORE `startOrchestratorFromKanban`, so a failed kickoff left `per-feature` switched on with a stashed prior and no restore path. Fixed by extracting a public `applyOversightWorktreeTopology(workspaceRoot, armed)` on KanbanProvider holding both halves verbatim (double-enter guard, per-feature switch, validModes clamp, PRIOR_KEY consume), deleting the inline blocks from both verb arms, and calling it from inside the provider methods: `startOrchestratorFromKanban` calls it with `armed=true` at the END (after every early return, adjacent to the orchestrationConfig write), and `stopOrchestratorFromKanban` now takes an optional `workspaceRoot`, resolves it via `_resolveWorkspaceRoot`, and calls it with `armed=false`. The verb arm passes `msg.workspaceRoot` through. Both HTTP and webview paths now reach the topology switch, and a failed arm never moves it.

## Review Findings

Reviewed 2026-08-16. All seven mode sites plus `isAutomationArmed` landed correctly: the 409 guard ORs on `orchestrationConfig.enabled` (`TaskViewerProvider.ts:1078`), arming/disarming write only `orchestrationConfig` with no `_stopAutobanEngine()` on the stop path, the disarming ternary is gone, and `applyOversightWorktreeTopology` (`KanbanProvider.ts:2258`) holds both halves on the arming transition with the `setAutomationMode` verb arm no longer touching `feature_worktree_mode` at all — verified by grep and by an added regression assertion. One MAJOR fixed: the OVERSIGHT AGENT subsection was rendered only under `currentAutomationMode === 'internal'` (`kanban.html:11086`), so an orchestrator armed in Internal and then switched to External stayed armed — blocking oversight passes via `isAutomationArmed` and suppressing auto-stop-on-empty — with no toggle to clear it; it now renders in both modes, since `orchestrationConfig` survives a mode switch by design. Files changed by this pass: `src/webview/kanban.html`, `src/test/autoban-state-regression.test.js`. Validation: `compile-tests` and `compile` clean, `catalog:check`/`parity:check`/`mirror:check`/`verb-returns:check`/`push-routing:check` green, `test:contract:autoban-state` green with new assertions covering the arming split, the 409 OR, the topology move, and the absence of `'orchestration'` mode comparisons. Remaining risk: manual verification items 1–5 (real orchestrator launch, failed-arm label settling, live worktree topology round-trip) are still unexercised by any automated check.
