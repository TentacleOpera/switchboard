# Fix: Scheduler comms job overwrites other jobs

## Goal

Make the scheduler support N concurrent jobs of any source (board-batch, reconcile, custom, comms) without one source clobbering the others. The root failure is that `comms` still has privileged write paths and UI state that overwrite the shared scheduler job list, while the renderer interaction guard can suppress the full job list before a save. This plan removes the comms special-case writes and fixes the renderer guard.

The scheduler currently has three overlapping failure modes:

1. `GlobalIntegrationConfigService.setMcpMonitorConfig` (lines 527-576) loads the full scheduler job list, **creates a comms job if none exists** (line 573 `jobs.push(job)`), and writes the entire array back. Every comms-related operation — start polling, stop polling, terminal close, source check, sub-form toggle — can therefore clobber other jobs.
2. `kanban.html` `renderAutobanPanel` (line 10304) returns early whenever `isAutobanPanelInteracting` is true. The `updateSchedulerConfig` handler (line 7858) calls `renderAutobanPanel`, so if a config push arrives while any guarded control is active, the DOM never receives the full job list. The SAVE button then calls `setSchedulerConfig` with `collectSchedulerJobs()`, writing only the DOM-visible jobs.
3. `GlobalIntegrationConfigService.setSchedulerConfig` (lines 432-438) performs a full replacement (`nextJobs = config.jobs ?? current.jobs`). If the webview state is stale, the save overwrites disk with an incomplete list.

A secondary goal is to remove the legacy `mcp_monitor` / "Comms Monitor" agent special-casing so a comms job is just another scheduled job: its terminal is named `Scheduler: <label>`, its terminal role is `scheduler`, and it does not appear as a dedicated agent in the agent grid.

A tertiary goal is to let each `local-terminal` job spawn its own terminal and run an optional per-job `startupCommand` before the first scheduler prompt.

> **Superseded:** The plan originally stated `guardInteraction` is applied to the source/target dropdowns inside `createSchedulerJobRow` and recommended removing the guard from those dropdowns.
> **Reason:** `sourceSelect` and `targetSelect` inside `createSchedulerJobRow` (kanban.html:9999-10026) are **not** guarded; no `guardInteraction(sourceSelect)` or `guardInteraction(targetSelect)` exists. The actual failure is that the global `isAutobanPanelInteracting` flag is set by autoban mode/config controls and orchestration controls outside the scheduler section, and `renderAutobanPanel` returns early whenever that flag is true. `updateSchedulerConfig` therefore fails to populate the job list DOM even though the user may not be touching any scheduler control.
> **Replaced with:** Fix the interaction guard so `updateSchedulerConfig` can re-render the scheduler section independently of autoban/orchestration interaction state. Options: (a) add a `force` flag to `renderAutobanPanel` and call it from `updateSchedulerConfig` when `currentAutomationMode === 'scheduler'`; (b) extract a `renderSchedulerSection` function and have `updateSchedulerConfig` target `#scheduler-job-list` and `#scheduler-comms-root` directly. Do not remove non-existent guards from `sourceSelect`/`targetSelect`.

> **Superseded:** The plan originally recommended changing `setSchedulerConfig` to merge incoming jobs with existing jobs as a defensive measure against stale webview state.
> **Reason:** Merge-instead-of-replace violates "what you save is what you get". If a user legitimately deletes jobs, a merge will resurrect them. It also masks the real bug (the renderer guard and `setMcpMonitorConfig` auto-create). A defensive merge is not a substitute for fixing those root causes.
> **Replaced with:** Keep `setSchedulerConfig` as a full replacement of the `jobs` array. Rely on the two root-cause fixes (update-only `setMcpMonitorConfig` and renderer guard fix) to guarantee the DOM holds the full job list before any save. If extra safety is desired, add a mismatch warning/log when the incoming array is dramatically smaller than the persisted one, but do not silently merge.

> **Superseded:** The plan stated "The job's `id` already keys the terminal; the launcher should spawn a new terminal per job without reusing a shared one."
> **Reason:** The terminal name is currently derived from `job.label` (`Scheduler: ${job.label}`), not `job.id`. `_normalizeAgentKey` strips IDE suffixes and lowercases the name, so two jobs with the same normalized label collide on one terminal. `launchMcpMonitorTerminal` also disposes/reuses any live terminal matching that normalized name, so same-label jobs share a terminal.
> **Replaced with:** Make terminal names unique per `job.id` (for example `Scheduler: ${job.label} (${job.id})` or a short id suffix). Index `_schedulerTerminalToJobId` by that exact name. When launching, look up a live terminal by the full `job.id`-derived name; do not reuse a terminal from a different job.

> **Superseded:** The plan stated "The scheduler loop launcher should send `startupCommand` to the terminal before the first prompt if set."
> **Reason:** A startup command runs once per terminal session at creation/reveal, not inside the recurring `_schedulerTick` interval loop. The loop sends the prompt every interval; conflating the two would re-run setup commands repeatedly.
> **Replaced with:** Send the per-job `startupCommand` in `launchMcpMonitorTerminal` (or a generalized scheduler terminal launcher) after shell readiness and before the first prompt. If the terminal already exists for that job, do not re-send the startup command.

## Metadata

**Tags:** bugfix, backend, frontend, ui, ux, refactor, reliability  
**Complexity:** 7

## User Review Required

Before implementation, confirm or decide the following:

1. **Split this plan.** The current file mixes a critical bug fix, a medium refactor (remove `mcp_monitor` agent special-casing), and a feature addition (per-job `startupCommand` and per-job terminals). These are at least two independently shippable phases. Recommend splitting into:
   - Phase 1 (bugfix): `setMcpMonitorConfig` update-only + renderer guard fix.
   - Phase 2 (refactor + feature): remove `mcp_monitor` special-casing, per-job terminals, `startupCommand`.
   If approved, create separate plan files and optionally group them with `create-feature-from-plans`.
2. **Comms job multiplicity.** The existing code assumes a single comms job identified by `COMMS_JOB_ID`. Do you want to keep one comms job maximum, or refactor the comms sub-form so each `source === 'comms'` job carries its own `sourceConfig` and is saved via `setSchedulerConfig`?
3. **Terminal-close behavior.** For non-comms scheduler jobs, closing the terminal currently only stops the loop; the job stays `enabled` and the timer continues firing no-ops. For comms, closing sets `pollingEnabled: false` (disabling the job). Do you want to disable **all** `local-terminal` jobs when their terminal is closed, or keep the current difference?
4. **Comms default startup command.** If the `mcp_monitor` fallback (`claude --model claude-haiku-4-5 --allowedTools "mcp__*"`) is removed, a comms job with no per-job `startupCommand` will fall back to the `coder` role's startup command. Should comms jobs instead have a source-specific default (the same claude MCP command) when `startupCommand` is blank?

## Complexity Audit

### Routine
- Add `startupCommand?: string` to the `ScheduledJob` interface.
- Render a `startupCommand` input in `createSchedulerJobRow` and read it in `collectJobFromRow`.
- Stop `setMcpMonitorConfig` from auto-creating a comms job.
- Remove the `mcp_monitor` role and `MCP_MONITOR_TERMINAL_NAME` constant and rename terminals for comms jobs.
- Remove `setVisibleAgent('mcp_monitor', ...)` calls from comms lifecycle methods.

### Complex / Risky
- The renderer interaction guard fix touches `renderAutobanPanel`, `updateSchedulerConfig`, and the scheduler section DOM lifecycle. A naive "always re-render" change can clobber focus in autoban controls or lose in-progress edits.
- Per-job terminal uniqueness requires changing `_schedulerTerminalName`, `_schedulerTerminalToJobId`, and `launchMcpMonitorTerminal` so two jobs with the same label do not share a terminal. Existing terminal-disposal logic must be updated to match by full job-id-derived name.
- Removing `mcp_monitor` special-casing from `TaskViewerProvider` without breaking the agent grid, `visibleAgents`, `getAgentStartupCommand` fallbacks, and `execute` dispatch guards requires a full audit of all `mcp_monitor` references.
- The comms sub-form currently edits a singleton `mcpMonitorConfig` and posts `setMcpMonitorConfig`. If the goal is truly "comms is one source among equals", that sub-form must write into the selected job's `sourceConfig` and be saved through `setSchedulerConfig`.
- `setMcpMonitorConfig` is called from many paths (`setMcpMonitorConfigFromKanban`, `startMcpMonitorPolling`, `stopMcpMonitorPolling`, `handleTerminalClosed`, `_schedulerTick`). Making it update-only may change behavior for callers that implicitly relied on auto-creation.

## Edge-Case & Dependency Audit

### Race Conditions
- `setMcpMonitorConfig` runs `loadGlobal`, merges, and `saveGlobal`. If two calls interleave (e.g. user toggles a source while a tick updates `sourceLastCheckAt`), the later write can overwrite the earlier. Update-only makes this safer but does not eliminate the read-modify-write race. Consider re-reading inside `setMcpMonitorConfig` just before save, or serializing comms config writes.
- `updateSchedulerConfig` can arrive while `isAutobanPanelInteracting` is true due to an unrelated control. The fix must bypass the guard for scheduler config updates specifically.
- `setSchedulerConfig` is called from `collectSchedulerJobs()` on SAVE and from delete row. A stale DOM will produce a stale save. The renderer guard fix must ensure the DOM is canonical before these calls.

### Security
- `startupCommand` is arbitrary shell text sent to a terminal. It must not be auto-executed without user review. The plan keeps it user-configured and per-job, displayed in the UI, and sent after shell readiness. No new injection vector is introduced beyond the existing `getAgentStartupCommand` mechanism.
- Removing `mcp_monitor` from the monitor-only role list could allow `execute` dispatches to target a comms terminal if not guarded. Verify the dispatch guard at line 18308-18309 is updated to treat scheduler terminals (or the new role) as non-dispatchable.

### Side Effects
- Removing the `mcp_monitor` role may hide existing Comms Monitor terminals from the agent grid if `visibleAgents` still contains `mcp_monitor: true`. Either clean the key during migration or make the grid gracefully ignore stale keys.
- Changing terminal names from "Comms Monitor" to `Scheduler: <label>` will orphan any existing terminal named "Comms Monitor". The closed-terminal handler and `_schedulerTerminalToJobId` map must tolerate that.
- `getAgentStartupCommand('mcp_monitor')` fallback will no longer apply. Existing users with no per-role startup command configured may lose the `claude --model claude-haiku-4-5 --allowedTools "mcp__*"` default unless a comms-specific default or per-job `startupCommand` is provided.

### Dependencies & Conflicts
- `COMMS_JOB_ID` is referenced across `GlobalIntegrationConfigService.ts` and `TaskViewerProvider.ts`. If comms becomes fully per-job, this constant may be removable.
- `renderCommsPanel` / `createCommsPanel` depend on `mcpMonitorConfig` state variables. Removing or generalizing these affects the message handler for `updateMcpMonitorConfig`.
- `KanbanProvider` message handlers (`setMcpMonitorConfig`, `launchMcpMonitorTerminal`, etc.) may need new handlers for generalized scheduler jobs.

## Dependencies

- None — self-contained to the `switchboard` repo.

## Adversarial Synthesis

Key risks: the renderer guard fix can be undermined by a too-broad re-render that clobbers user input; per-job terminal uniqueness is subtle because `_normalizeAgentKey` collapses similar names; and removing `mcp_monitor` agent special-casing has hidden callers (`BUILT_IN_AGENT_LABELS`, `visibleAgents`, dispatch guards, `getAgentStartupCommand` fallbacks) that can break the agent grid or comms defaults. Mitigations: scope the guard bypass to `updateSchedulerConfig` only, derive terminal names from `job.id`, and audit every `mcp_monitor` / `MCP_MONITOR_TERMINAL_NAME` / "Comms Monitor" reference before deleting.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`

#### `ScheduledJob` interface (line 92-101)
- Add `startupCommand?: string` after `promptOverride?: string`.
- Keep `sourceConfig: Record<string, unknown>` as the bag for source-specific data (comms config stays inside `sourceConfig`).

#### `setMcpMonitorConfig` (lines 527-576)
- Load jobs and find the existing comms job by `source === 'comms'` (or by `id === COMMS_JOB_ID` if single-comms semantics are kept).
- **If no comms job exists, return early without writing.** Do not create a new job.
- If a comms job exists, merge the incoming `Partial<McpMonitorConfig>` into its `sourceConfig` and update the job object in the array.
- Persist `globalConfig.scheduler` with the updated jobs array.
- Callers that previously relied on implicit creation (`setMcpMonitorConfigFromKanban`, `startMcpMonitorPolling`, `stopMcpMonitorPolling`, etc.) must be verified; they should only call this when a comms job actually exists.

#### `setSchedulerConfig` (lines 432-438)
- Keep full replacement semantics.
- Optional defensive addition: if `config.jobs` is defined and its length is far smaller than `current.jobs` length, log a warning to aid debugging, but still replace. Do not silently merge missing jobs.

### `src/webview/kanban.html`

#### Interaction guard / `updateSchedulerConfig` re-render (lines 7858-7863, 10300-10307)
- Refactor so `updateSchedulerConfig` can rebuild the scheduler job list independently of `isAutobanPanelInteracting`.
- Recommended approach: extract `createSchedulerSection()` and `renderSchedulerSection()` from `createAutobanPanel`, keep `createSchedulerJobRow` and `collectJobFromRow` accessible to both, and have the `updateSchedulerConfig` handler call `renderSchedulerSection()` when `currentAutomationMode === 'scheduler'`.
- If a full refactor is too invasive, add a `force` parameter to `renderAutobanPanel` and call `renderAutobanPanel(true)` only from `updateSchedulerConfig`, accepting that the whole panel rebuilds.
- In either case, `isAutobanPanelInteracting` must not block the scheduler job list from receiving the canonical config.

#### `createSchedulerJobRow` (lines 9967-10150)
- Add a `startupCommand` input row, visible only when `target === 'local-terminal'`.
- Use `data-field="startupCommand"` or a stable class so `collectJobFromRow` can read it.
- Preserve existing source/target dropdown behavior. Do **not** add `guardInteraction` to them; they are already unguarded.
- When `source === 'comms'`, the existing comms sub-form rendering can remain for now if single-comms semantics are kept. If multiple comms jobs are desired, this sub-form must be bound to the current row's `sourceConfig` rather than the singleton `mcpMonitorConfig`.

#### `collectJobFromRow` (lines 10154-10189)
- Read the `startupCommand` input and include it in the returned job object.

#### Comms sub-form / `mcpMonitorConfig` state (lines 7038-7042, 10315+)
- If single-comms semantics are kept: keep `createCommsPanel` but remove all "Comms Monitor" branding and the `mcpMonitorConfig` global state if possible. Instead, read the comms job's `sourceConfig` from `window.__schedulerConfig` and write back through `setSchedulerConfig`.
- If fully generalizing comms: remove the standalone `mcpMonitorConfig` variables and `renderCommsPanel`; render source-specific controls inline in the job row's `sourceConfig` editor.

### `src/services/TaskViewerProvider.ts`

#### Remove `MCP_MONITOR_TERMINAL_NAME` and `mcp_monitor` role
- Delete the `public static readonly MCP_MONITOR_TERMINAL_NAME` constant (line 22070).
- Remove the comms branch in `_schedulerTerminalName` (lines 22099-22102) so all jobs return `Scheduler: ${job.label}`.
- To avoid terminal collisions, append a deterministic short id suffix to the terminal name (e.g., `Scheduler: ${job.label} (${job.id})` or `Scheduler-${job.id}`). Update `_schedulerTerminalToJobId` to use that exact name.

#### `launchMcpMonitorTerminal` (lines 22548-22637)
- Generalize to launch a terminal for any `local-terminal` job, not just comms.
- Remove `setVisibleAgent('mcp_monitor', ...)` calls. Set `state.terminals[key].role = 'scheduler'` for all scheduler terminals.
- For `startupCommand`: if `job.startupCommand` is set, send it after shell readiness; otherwise use `getAgentStartupCommand('coder')` (or a source-specific default for comms if user review decides option 4).
- Remove `isComms` special cases except where source-specific behavior is genuinely required (prompt builder, GCD interval).

#### `_startSchedulerJobLoop` / `_schedulerTick` (lines 22123-22257)
- Keep the GCD interval logic for `source === 'comms'`; keep `_buildMcpMonitorPrompt` for comms.
- In `_schedulerTick`, use the generalized `_schedulerTerminalName(job)` (already done) and ensure the terminal lookup uses the full `job.id`-derived name.
- When updating `sourceLastCheckAt` for comms, the call to `setMcpMonitorConfig` now safely update-onlys the existing comms job.

#### `handleTerminalClosed` (lines 17822-17842)
- Remove the `isComms` special case. Stop the scheduler loop for `closedJobId` and remove the terminal→jobId index entry.
- Decide with user review whether to also set `enabled = false` for the closed job (consistent behavior across all sources).

#### `setVisibleAgent('mcp_monitor')` calls
- Audit and remove all `setVisibleAgent('mcp_monitor', ...)` calls.
- If `visibleAgents` still contains `mcp_monitor` entries, add migration/cleanup so stale keys do not break the agent grid.

#### `_postMcpMonitorConfig` and message type `updateMcpMonitorConfig`
- If the comms sub-form is kept, rename this path to `updateCommsJobConfig` or similar and ensure it targets the single comms job.
- If comms is fully generalized, remove the dedicated comms config message and rely on `updateSchedulerConfig`.

## Open Code Investigation (before implementation)

The implementer should read and resolve these before changing code:

1. Search the entire `src/` tree for `mcp_monitor`, `MCP_MONITOR_TERMINAL_NAME`, `Comms Monitor`, and `comms-monitor` (case-insensitive). List every match and classify as:
   - Must change (agent role, terminal name, visibility toggle).
   - Can keep (source identifier `source === 'comms'`, `COMMS_JOB_ID`, prompt builder).
   - Needs decision (e.g. `BUILT_IN_AGENT_LABELS`, `visibleAgents` migration, `getAgentStartupCommand` fallbacks, dispatch guards).
2. Determine how `createAgentGrid` and the terminal pool UI use `state.terminals[key].role`. If all scheduler jobs use role `'scheduler'`, does the grid show one aggregate entry per role or one per terminal? Decide whether a distinct `scheduler` monitor-only role is needed and add it to the execute-dispatch guard if so.
3. Verify command registrations in `package.json` or command-map for `switchboard.launchMcpMonitorTerminal`, `switchboard.stopMcpMonitorTerminal`, etc. Decide whether to rename them to `switchboard.launchSchedulerJobTerminal` / `switchboard.stopSchedulerJobTerminal` or keep the old names as shims.
4. Check whether `_buildMcpMonitorPrompt` or `buildMcpMonitorPreview` are referenced from anywhere other than `TaskViewerProvider` and `KanbanProvider`. Rename consistently.
5. Confirm whether the `updateMcpMonitorConfig` message handler in `kanban.html` can be removed entirely or must be kept for backward compatibility.

## Verification Plan

### Automated Tests
- Skipped per directive for this planning pass.

### Manual Verification
1. **Bug fix — persistence:**
   - Configure 3+ scheduler jobs with different sources (board-batch, custom, comms). Save. Restart. Verify all 3 persist.
   - Interact with the mode dropdown or other autoban/orchestration controls, then save a scheduler job. Verify all jobs survive.
   - Stop comms polling. Verify no comms job is auto-created if none existed.
2. **Per-job terminals:**
   - Create two `local-terminal` jobs with the same label. Start both. Verify two distinct terminal tabs are created.
   - Close one terminal. Verify the other terminal keeps running and the closed job stops polling.
3. **Startup command:**
   - Set a custom `startupCommand` on a `local-terminal` job (e.g. `echo "hello"`). Start it. Verify the command runs in the terminal before the first scheduler prompt.
   - Leave `startupCommand` blank. Verify the job uses the existing default startup command (e.g. `coder` role command or comms-specific default).
4. **mcp_monitor removal:**
   - Verify no `mcp_monitor` agent appears in the agent grid.
   - Verify a comms-source job terminal is named `Scheduler: <label>`, not "Comms Monitor".
   - Verify `visibleAgents` no longer contains an `mcp_monitor` key after a comms job is created/updated.
5. **Comms sub-form:**
   - Add a comms job, toggle sources, set intervals, save. Verify the job's `sourceConfig` reflects the changes and `setMcpMonitorConfig` does not create a duplicate job.
   - If multiple comms jobs are implemented: add two comms jobs with different `sourceConfig` and verify they remain independent.

## Recommendation

**Send to Lead Coder.** The plan spans three files, changes scheduler persistence and renderer state, removes legacy agent special-casing, and touches VS Code terminal lifecycle. The risk of regression in the agent grid and terminal handling warrants an experienced owner.

## Completion Report

Implemented update-only logic for `setMcpMonitorConfig` so missing comms jobs are not auto-created. Added `force` parameter to `renderAutobanPanel` allowing `updateSchedulerConfig` to re-render the scheduler job list DOM even when user interaction guards are active. Extended `ScheduledJob` with `startupCommand`, added UI field in job row, and updated terminal launcher to execute custom startup commands per job with unique job-id terminal naming.
Files changed: `src/services/GlobalIntegrationConfigService.ts`, `src/webview/kanban.html`, `src/services/TaskViewerProvider.ts`.
No issues encountered.
