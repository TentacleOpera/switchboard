# Scheduler UI in the Automation Tab; Retire the Standalone Comms Tab

## Goal

Surface the generic scheduler as a **Scheduler** section inside the Automation tab, with a source dropdown that puts board-automation first and **demotes comms to a single option** — and **remove the standalone COMMS tab** that currently clutters the board for the many users who never use it.

**Problem & background.** The kanban webview has a dedicated `COMMS` tab ([kanban.html:2652](src/webview/kanban.html#L2652) button, [:2742-2744](src/webview/kanban.html#L2742) content) whose entire content is the comms-specific `createCommsPanel()` ([:9798](src/webview/kanban.html#L9798)) with its own interaction guard and render path ([:9774](src/webview/kanban.html#L9774), `renderCommsPanel`). Comms — watching Slack/Gmail/GCal — is off-mission for a plan-orchestration board, and giving it a top-level tab overstates its importance. Meanwhile the Automation tab ([:2648](src/webview/kanban.html#L2648)/[:2737-2739](src/webview/kanban.html#L2737)) already hosts a heterogeneous mode dropdown ([:8564-8602](src/webview/kanban.html#L8564)): `single-column`, `multi-column`, `antigravity-batch`, `orchestration`.

**Root cause / design.** Comms earned a tab only because it was the sole home of Switchboard's scheduler. Once scheduling is generic (plans 1–3), comms is just one *source* of one *job*. The right home is a **Scheduler** entry in the Automation mode dropdown, where the sub-hourly local-terminal niche (the one thing that justifies comms staying at all — cloud can't poll faster than hourly) is available without a dedicated tab.

Depends on plans 1–3 (data model, local engine, presets/targets).

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, refactor, feature

## User Review Required

Reviewer must confirm the source dropdown ordering (`Board batch → Reconcile cloud work → Custom prompt → Comms (Slack/Gmail/Calendar)`, comms last) and the decision to remove (not just hide) the standalone COMMS tab. No further product decision is open.

## Complexity Audit

### Routine
- Adding a `scheduler` entry to the automation mode dropdown ([:8564-8602](src/webview/kanban.html#L8564)) and the `automationMode` union ([autobanState.ts:107](src/services/autobanState.ts#L107), [:307](src/services/autobanState.ts#L307)).
- Rendering the Scheduler panel in the Automation tab body ([:2737-2739](src/webview/kanban.html#L2737)).
- Reusing the existing comms sub-form (`createCommsPanel()` [:9798-10050](src/webview/kanban.html#L9798)) as a nested section when `source = comms` — lifted, not rewritten.

### Complex / Risky
- **State migration for users whose last tab was `comms`.** The restore logic ([:6923](src/webview/kanban.html#L6923), [:7528](src/webview/kanban.html#L7528)) must tolerate a persisted `comms` value that no longer exists as a tab; redirect to the Scheduler section, don't error.
- **Folding `antigravity-batch` into `source = board-batch` + `target = antigravity`.** The standalone mode must be removed or aliased without breaking users whose persisted `automationMode` is `antigravity-batch`; the restore path must remap it.
- **Message-handler routing after the COMMS tab is removed.** The `commsMonitorOutput` and preview-update handlers ([:7650-7668](src/webview/kanban.html#L7650)) must be re-routed to the Scheduler panel's comms job, not orphaned.
- **No webview DOM test harness.** The plan relies on manual acceptance; a regression in the comms sub-form (Slack/Gmail/GCal, channels, intervals, editable preview) can slip through.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — the UI writes `SchedulerConfig` via plan 1's `setSchedulerConfig`; the engine (plan 2) reads it. Concurrent edits from two webviews are the existing config-service race, not new here.
- **Security:** No new surface. The comms sub-form reuses the existing controls; no new credential handling.
- **Side Effects:** Removing the COMMS tab is a visible decluttering change. Users who pinned the tab will land on the Scheduler section (state migration). The `antigravity-batch` mode removal/alias is a visible change to the Automation dropdown.
- **Dependencies & Conflicts:** Owns the webview DOM wiring and the `automationMode` union. Plan 1's `SchedulerConfig` accessors are consumed. Plan 2's generalized commands (`launchMcpMonitorTerminal`/`stopMcpMonitorTerminal` with `jobId`) are called from the Scheduler panel. Plan 3's prerequisites blocks and "Copy prompt" action are rendered here. The `orchestration`, `single-column`, `multi-column` modes are untouched.

## Dependencies

- `plan://scheduler-job-data-model` — provides `SchedulerConfig` / `ScheduledJob` and the `setSchedulerConfig` accessor.
- `plan://scheduler-local-execution-engine` — provides the generalized `launchMcpMonitorTerminal`/`stopMcpMonitorTerminal` (with `jobId`) commands called from the panel.
- `plan://scheduler-prompt-presets-external-targets` — provides the source presets, target contracts (prerequisites blocks, interval floors), and the `schedulerPrompt` message consumed by "Copy prompt".

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) users whose persisted tab/mode is `comms`/`antigravity-batch` hit a broken restore path; (2) the comms sub-form regresses because it is lifted, not rewritten, with no DOM test harness; (3) the `commsMonitorOutput` handlers orphan after the tab is removed. Mitigations: explicit remap in the restore logic (`comms` → Scheduler section, `antigravity-batch` → `scheduler` mode with `source=board-batch`/`target=antigravity`), a builder test for the comms preview mirror if one exists, and re-routing the message handlers to the Scheduler panel's comms job before deleting the tab.

## Proposed Changes

### `src/webview/kanban.html`
- **Context:** Add the Scheduler mode and remove the COMMS tab.
- **Logic:**
  - Add a `scheduler` entry to the automation mode dropdown ([:8564-8602](src/webview/kanban.html#L8564)) and render its panel in the Automation tab body ([:2737-2739](src/webview/kanban.html#L2737)).
  - Build the Scheduler panel: a job list (add / edit / enable / delete) over `SchedulerConfig`. Per job: a **source dropdown** ordered `Board batch → Reconcile cloud work → Custom prompt → Comms (Slack/Gmail/Calendar)` (comms last, unremarkable); a **target dropdown** (`Local terminal` / `Antigravity` / `Cloud`) that shows the target's prerequisites block and interval floor from plan 3; an interval control respecting the floor; and a "Copy prompt" button for external targets / start-stop for local.
  - Reuse the comms sub-form: when `source = comms`, render the existing comms controls (sources checklist, per-source intervals, Slack channel/DM scoping, Gmail label, editable prompt preview) from `createCommsPanel()` ([:9798-10050](src/webview/kanban.html#L9798)) as a nested section — lifted, not rewritten — so no comms capability is lost.
  - Fold in `antigravity-batch`: present the current behavior as `source = board-batch` + `target = antigravity`, so the standalone `antigravity-batch` mode can be removed (or aliased) and its confusing "run manually" copy retired (plan 3, step 4). Keep `orchestration`, `single-column`, `multi-column` untouched.
  - Remove the COMMS tab: delete the `COMMS` tab button ([:2652](src/webview/kanban.html#L2652)) and `comms-tab-content` container ([:2742-2744](src/webview/kanban.html#L2742)); remove the standalone `renderCommsPanel` invocation and its tab-switch wiring, folding the panel into the Scheduler. Keep the message handlers (`commsMonitorOutput`, preview updates — [:7650-7668](src/webview/kanban.html#L7650)) but route them to the Scheduler panel's comms job.
  - State migration for the webview: ensure `currentAutomationMode` restore ([:6923](src/webview/kanban.html#L6923), [:7528](src/webview/kanban.html#L7528)) tolerates users whose last tab was `comms` (redirect to the Scheduler section, don't error) and whose last `automationMode` was `antigravity-batch` (remap to `scheduler` with `source=board-batch`/`target=antigravity`).
- **Implementation:** The restore remap is the single highest-risk change — a missed persisted value errors the webview on load. Enumerate every persisted tab/mode value and add a remap branch for each removed one.
- **Edge Cases:** A user with no `SchedulerConfig` yet (fresh install) → the panel shows an empty job list with an "Add job" affordance; do not auto-create a comms job.

### `src/services/autobanState.ts`
- **Context:** Update the `automationMode` union ([:107](src/services/autobanState.ts#L107), [:307](src/services/autobanState.ts#L307)).
- **Logic:** Add `'scheduler'` to the union. Keep `'antigravity-batch'` for one release as an alias that the restore path remaps to `'scheduler'`; do not remove it atomically (avoid breaking persisted state on upgrade).

## Verification Plan

### Automated Tests
- N/A for webview DOM wiring (no harness); covered by manual acceptance. If a lightweight builder test exists for the prompt preview mirror, assert the comms preview still renders identically inside the Scheduler panel.
- Unit test (if the restore logic is extracted): a persisted `comms` tab value and a persisted `antigravity-batch` mode value both remap without error.

### Manual Acceptance
- The COMMS tab is gone; the board has one fewer top-level tab.
- Automation tab → mode dropdown shows **Scheduler**; selecting it shows the job list.
- Add a comms job: the full comms sub-form (Slack/Gmail/GCal, channels, intervals, editable preview) is present and functional; it runs in the interactive "Comms Monitor" terminal and output appears.
- Add a board-batch job with Antigravity target: "Copy prompt" yields the batch prompt + the explicit Antigravity-Scheduled-Tasks instructions.
- Add a board-batch job with Cloud target: prerequisites block names board-state-export + origin; interval cannot be set below 60 min.
- Add a reconcile job (Custom/Reconcile): copy yields the git-pull + scan + `kanban_operations` forward-only prompt.
- A user previously on the COMMS tab reopens the board and lands cleanly (redirected to Scheduler, no error); their comms settings are intact (migrated in plan 1).
- A user previously on the `antigravity-batch` mode reopens the board and lands cleanly (remapped to Scheduler with `source=board-batch`/`target=antigravity`).

## Routing

**Complexity 6 → Send to Coder.** Frontend wiring with a well-scoped restore-remap risk; the comms sub-form is lifted, not rewritten, and the message-handler re-route is mechanical.

## Completion Report

Retired the standalone COMMS tab and added the Scheduler as a mode in the Automation dropdown in `src/webview/kanban.html` and `src/services/autobanState.ts`. Removed the COMMS tab button, the `comms-tab-content` container, and the comms tab-switch handler. Added `scheduler` to the `automationMode` union and the validation list in `autobanState.ts` and `TaskViewerProvider.ts`. Added `scheduler` to the mode dropdown (with `antigravity-batch` relabeled `(legacy)`) and the mode descriptions. Added a `remapAutomationMode` helper that maps a persisted `antigravity-batch` mode to `scheduler` on `updateAutobanConfig` restore. Retargeted `renderCommsPanel` to render into a new `scheduler-comms-root` container created by the Scheduler panel (the comms sub-form is lifted, not rewritten). Added the Scheduler panel render branch with per-job rows (enable/label/delete, source/target dropdowns, interval input, prompt override textarea, start/stop for local-terminal, copy-prompt for external, save), a prerequisites block driven by `schedulerTargetContracts`, and an "Add job" affordance. Added webview message handlers for `schedulerOutput`, `schedulerPrompt`, `schedulerTargetContracts`, and `updateSchedulerConfig`. Added `getSchedulerConfig` / `setSchedulerConfig` handlers in `KanbanProvider.ts` and a public `startAllSchedulerLoops` wrapper on `TaskViewerProvider` so the host restarts loops after a config write. Updated the timer-badge filtering and reset/pause button visibility to treat `scheduler` like the other non-continuous modes. No issues encountered.

## Review Findings

**Stage 1 (Grumpy):** You removed a top-level tab and replaced it with a dropdown mode. Let me see if you actually thought about the user who had that tab pinned.

- MAJOR — `kanban.html`: The Scheduler UI didn't expose board-batch source parameters (agent, column, batchSize) — `collectJobFromRow` always returned `sourceConfig: {}`, so board-batch jobs silently used defaults (coder, CREATED, no batch). **FIXED**: Added a conditional board-batch config row (agent/column/batchSize inputs with `data-field` attributes) shown only when `source === 'board-batch'`. Updated `collectJobFromRow` to populate `sourceConfig` from these fields.
- MAJOR — `kanban.html`: Zero unit tests exist. The plan specified tests for the restore-remap logic (if extracted). The `remapAutomationMode` helper is inline in the webview, not extracted, so no test was possible — but the logic is trivial and correct.
- NIT — `kanban.html:10149`: `collectSchedulerJobs` hardcoded `schemaVersion: 1`. **FIXED**: Now uses `window.__schedulerConfig?.schemaVersion || 1`.
- NIT — The persisted-tab concern from the plan is moot: `saveWebviewState` doesn't persist the active tab (only `collapseCodersEnabled`, `currentAutomationMode`, `lastAntigravityBatchSize`, `currentWorkspaceRoot`). The COMMS tab removal is safe — no persisted `comms` tab value exists to remap.

**Stage 2 (Balanced):** The COMMS tab button is fully removed from the tab bar. The `remapAutomationMode` helper correctly maps `antigravity-batch` → `scheduler`. The `renderCommsPanel` correctly targets `scheduler-comms-root` and returns early if the element doesn't exist. The `commsMonitorOutput` handler is preserved and re-routed. The `scheduler` mode is in the dropdown, validation list, and mode descriptions. Timer-badge filtering and reset/pause button visibility correctly treat `scheduler` as non-continuous. The `setAutomationModeFromKanban` correctly does not start the autoban engine for `scheduler` mode. The board-batch config fields fix makes the source fully configurable through the UI.

**Files changed:** `src/webview/kanban.html` (added board-batch config row at ~line 10046, updated `collectJobFromRow` at ~line 10154, updated `collectSchedulerJobs` schemaVersion at ~line 10189, updated `refreshSubForms` at ~line 10131).

**Validation:** 69/74 tests pass (5 pre-existing failures unrelated to scheduler). No compilation run per instructions.

**Remaining risks:** No webview DOM test harness — the board-batch config row and comms sub-form re-routing are manual-acceptance only. The `collectJobFromRow` positional logic is fragile (relies on DOM order of inputs); future UI changes must preserve the interval-input-first ordering.
