# Add Auto-Pull and Timer Settings to Integration Setup

## Goal
Add optional automatic import polling for the existing ClickUp and Linear integrations, with one enable/disable toggle and one timer interval setting per integration. Preserve the current manual import and setup flows, but align the new auto-pull behavior with the real integration surfaces that already exist in the codebase.

## Metadata
**Tags:** backend, infrastructure, ui
**Complexity:** 6

## User Review Required
> [!NOTE]
> - Auto-pull must remain **disabled by default** for both integrations.
> - The requested settings are limited to the existing scope: **enable/disable** plus a **timer interval**. Do **not** expand this plan with webhook infrastructure, custom freeform intervals, or extra status dashboards.
> - **Clarification:** the current integration entry points live in the Kanban board (`src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/extension.ts`), not in the central setup panel. Extend that existing integration surface rather than creating a duplicate ClickUp/Linear settings area in `src/webview/setup.html`.
> - **Clarification:** auto-pull and manual import should resolve the same destination folder for imported plans. If the workspace uses a configured ingestion folder, timed imports must not silently write somewhere else.

## Complexity Audit
### Routine
- Add `autoPullEnabled` and `pullIntervalMinutes` to the persisted `ClickUpConfig` and `LinearConfig` shapes in `src/services/ClickUpSyncService.ts` and `src/services/LinearSyncService.ts`.
- Normalize legacy config files on load/save so existing workspaces that already have ClickUp or Linear configured do not end up with missing fields.
- Extend the Kanban integration state payloads in `src/services/KanbanProvider.ts` and `src/webview/kanban.html` so the UI knows whether auto-pull is enabled and which interval is selected.
- Add a small integration-settings modal to `src/webview/kanban.html` using the existing modal patterns already present in that file.
- Update `README.md` and `docs/TECHNICAL_DOC.md` to describe the new optional auto-pull behavior and timer options.

### Complex / Risky
- Add a scheduler that avoids overlapping imports. A naive `setInterval(async () => ...)` can launch multiple concurrent ClickUp or Linear pulls if a previous import is still paging through remote data.
- Reconfigure timers correctly when setup completes, when settings change, when workspaces are added/removed, and when the extension shuts down.
- Keep timed imports aligned with the actual plan-ingestion destination instead of hard-coding another `.switchboard/plans` path that could drift from manual import behavior.
- Preserve existing manual setup and manual import commands in `src/extension.ts` while sharing as much destination-resolution and validation logic as possible with the timed path.

## Edge-Case & Dependency Audit
- **Race Conditions:** Timed imports must use a per-workspace, per-integration in-flight guard. If a ClickUp or Linear poll is still running when the next interval arrives, the scheduler must re-arm after completion rather than starting a second overlapping import. Saving new settings while a poll is active must clear the pending timer and let the in-flight run finish naturally.
- **Security:** No new secrets should be added to webview payloads or logs. This feature must continue reusing the existing VS Code `SecretStorage` token flow from `ClickUpSyncService.ts` and `LinearSyncService.ts`; only non-secret booleans/intervals belong in the UI state.
- **Side Effects:** Auto-pull increases background network traffic and filesystem writes. Imports are already designed to be idempotent, but timer mismanagement could still create unnecessary API traffic or confusing duplicate writes if destination resolution is inconsistent.
- **Dependencies & Conflicts:** `get_kanban_state` shows **no active New plans**. The only active **Planned** overlap is `Update README with Recent Features`, which does not touch the integration code paths. Historical plan overlap exists with `clickup_1_foundation.md`, `clickup_2_setup_flow.md`, `clickup_3_sync_on_move.md`, `clickup_import_pull_tasks.md`, `linear_1_foundation.md`, `linear_2_setup_flow.md`, `linear_3_sync_on_move.md`, `linear_import_pull_issues.md`, and `make_integration_setup_buttons_discoverable.md`; those plans already established `ClickUpSyncService.ts`, `LinearSyncService.ts`, `KanbanProvider.ts`, `extension.ts`, and `src/webview/kanban.html` as the correct surfaces. Treat them as prior art and do **not** reintroduce the old hidden-button or command-palette-only setup behavior.

## Adversarial Synthesis
### Grumpy Critique
> This draft has wandered into the wrong building. ClickUp and Linear setup currently lives in `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, and the integration commands in `src/extension.ts` — not in the central setup panel. Stuffing a brand-new integrations accordion into `src/webview/setup.html` and teaching `SetupPanelProvider.ts` about ClickUp/Linear would be scope sprawl masquerading as progress.
>
> The timer design is also too naive. `setInterval(async () => ...)` is how you accidentally fire a second import while the first one is still crawling paginated ClickUp tasks or Linear issues. That buys you overlap, rate-limit pain, and “why did this import twice?” bug reports. If you want this to be reliable, you need one scheduler state per workspace/integration and you only re-arm after the previous run finishes.
>
> And stop pretending old config files will magically sprout new keys. `loadConfig()` in both sync services just deserializes JSON today. If you add `autoPullEnabled` and `pullIntervalMinutes` without normalization, every pre-existing workspace becomes an undefined-behavior lottery.
>
> Finally, do not hard-code yet another `.switchboard/plans` writer if the product already exposes a configurable plan-ingestion folder. “Auto-pull worked, but not where the importer was watching” is exactly the kind of bug that convinces users the feature is haunted.

### Balanced Response
The corrected plan keeps scope inside the real integration surfaces that already exist. Persist only the two requested settings, normalize legacy configs on read/write, and manage timers centrally so they start once, reconfigure cleanly, and stop on dispose. Use the existing Kanban integration controls as the configuration entry point after setup completes, and resolve the import destination through the same path used by manual imports so manual pull and auto-pull stay aligned instead of drifting into separate behaviors.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The authoritative implementation is the section below. The older draft preserved later in this file is historical context only. Where the preserved draft conflicts with this section, follow this section.

### 1. Persist the new settings in the existing integration config files
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** ClickUp already persists setup state in `.switchboard/clickup-config.json`. Auto-pull must extend that existing config rather than introducing a second config file or a SetupPanel-only state path.
- **Logic:**
  1. Extend `ClickUpConfig` with `autoPullEnabled` and `pullIntervalMinutes`.
  2. Add a local normalization helper so `loadConfig()` upgrades old JSON that predates the new fields.
  3. Update the first-time `setup()` bootstrap config so newly configured workspaces start with `autoPullEnabled: false` and a valid default interval.
  4. Keep all existing token, setup, and import logic intact; this change is configuration-only in this file.
- **Implementation:**
```typescript
export interface ClickUpConfig {
  workspaceId: string;
  folderId: string;
  spaceId: string;
  columnMappings: Record<string, string>;
  customFields: {
    sessionId: string;
    planId: string;
    syncTimestamp: string;
  };
  setupComplete: boolean;
  lastSync: string | null;
  autoPullEnabled: boolean;
  pullIntervalMinutes: 5 | 15 | 30 | 60;
}

private _normalizeConfig(raw: Partial<ClickUpConfig> | null): ClickUpConfig | null {
  if (!raw) {
    return null;
  }

  const interval = raw.pullIntervalMinutes;
  const normalizedInterval: 5 | 15 | 30 | 60 =
    interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

  return {
    workspaceId: raw.workspaceId || '',
    folderId: raw.folderId || '',
    spaceId: raw.spaceId || '',
    columnMappings: raw.columnMappings || Object.fromEntries(CANONICAL_COLUMNS.map(c => [c, ''])),
    customFields: raw.customFields || { sessionId: '', planId: '', syncTimestamp: '' },
    setupComplete: raw.setupComplete === true,
    lastSync: raw.lastSync || null,
    autoPullEnabled: raw.autoPullEnabled === true,
    pullIntervalMinutes: normalizedInterval
  };
}

async loadConfig(): Promise<ClickUpConfig | null> {
  try {
    const content = await fs.promises.readFile(this._configPath, 'utf8');
    const normalized = this._normalizeConfig(JSON.parse(content));
    this._config = normalized;
    return normalized;
  } catch {
    return null;
  }
}

async saveConfig(config: ClickUpConfig): Promise<void> {
  const normalized = this._normalizeConfig(config);
  if (!normalized) {
    throw new Error('ClickUp config normalization failed');
  }
  const dir = path.dirname(this._configPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(this._configPath, JSON.stringify(normalized, null, 2));
  this._config = normalized;
}
```
- **Edge Cases Handled:** Existing ClickUp workspaces gain safe defaults instead of `undefined` fields, and interval values remain constrained to the requested 5/15/30/60-minute choices.

#### [MODIFY] `src/services/LinearSyncService.ts`
- **Context:** Linear already persists setup state in `.switchboard/linear-config.json`. The same backward-compatible config upgrade pattern is required here.
- **Logic:**
  1. Extend `LinearConfig` with the same two fields.
  2. Normalize legacy config files in `loadConfig()` and `saveConfig()`.
  3. Seed the new fields in `setup()` when the integration is configured for the first time.
  4. Keep `linear-sync.json` and sync-map behavior unchanged.
- **Implementation:**
```typescript
export interface LinearConfig {
  teamId: string;
  teamName: string;
  projectId?: string;
  columnToStateId: Record<string, string>;
  switchboardLabelId: string;
  setupComplete: boolean;
  lastSync: string | null;
  autoPullEnabled: boolean;
  pullIntervalMinutes: 5 | 15 | 30 | 60;
}

private _normalizeConfig(raw: Partial<LinearConfig> | null): LinearConfig | null {
  if (!raw) {
    return null;
  }

  const interval = raw.pullIntervalMinutes;
  const normalizedInterval: 5 | 15 | 30 | 60 =
    interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

  return {
    teamId: raw.teamId || '',
    teamName: raw.teamName || '',
    projectId: raw.projectId || undefined,
    columnToStateId: raw.columnToStateId || {},
    switchboardLabelId: raw.switchboardLabelId || '',
    setupComplete: raw.setupComplete === true,
    lastSync: raw.lastSync || null,
    autoPullEnabled: raw.autoPullEnabled === true,
    pullIntervalMinutes: normalizedInterval
  };
}
```
- **Edge Cases Handled:** Old Linear configs keep working, and timed imports do not depend on the user re-running setup just to populate new settings keys.

### 2. Add a dedicated scheduler service instead of open-coded timer state in the provider
#### [CREATE] `src/services/IntegrationAutoPullService.ts`
- **Context:** Timer lifecycle is the risky part of this feature. It should be isolated in a small service instead of spread across KanbanProvider message cases.
- **Logic:**
  1. Maintain one scheduler entry per `workspaceRoot + integration`.
  2. Use `setTimeout`, not `setInterval`, so the next run is scheduled only after the current run finishes.
  3. Track `inFlight` status so config changes can stop or re-arm cleanly without interrupting active imports.
  4. Expose `configure(...)`, `stop(...)`, `stopWorkspace(...)`, and `dispose()`.
  5. Keep this service generic: it should not know about ClickUp list IDs or Linear query details; it only schedules callbacks.
- **Implementation:**
```typescript
export type AutoPullIntervalMinutes = 5 | 15 | 30 | 60;
export type AutoPullIntegration = 'clickup' | 'linear';

interface AutoPullState {
  timeout: NodeJS.Timeout | null;
  inFlight: boolean;
  enabled: boolean;
  intervalMinutes: AutoPullIntervalMinutes;
  runner: (() => Promise<void>) | null;
}

export class IntegrationAutoPullService implements vscode.Disposable {
  private readonly _states = new Map<string, AutoPullState>();

  public configure(
    workspaceRoot: string,
    integration: AutoPullIntegration,
    enabled: boolean,
    intervalMinutes: AutoPullIntervalMinutes,
    runner: () => Promise<void>
  ): void {
    const key = `${workspaceRoot}::${integration}`;
    this.stop(workspaceRoot, integration);

    this._states.set(key, {
      timeout: null,
      inFlight: false,
      enabled,
      intervalMinutes,
      runner
    });

    if (enabled) {
      this._scheduleNext(key);
    }
  }

  private _scheduleNext(key: string): void {
    const state = this._states.get(key);
    if (!state || !state.enabled || !state.runner) {
      return;
    }

    state.timeout = setTimeout(async () => {
      const latest = this._states.get(key);
      if (!latest || !latest.enabled || !latest.runner || latest.inFlight) {
        return;
      }

      latest.inFlight = true;
      try {
        await latest.runner();
      } finally {
        latest.inFlight = false;
        this._scheduleNext(key);
      }
    }, state.intervalMinutes * 60 * 1000);
  }

  public stop(workspaceRoot: string, integration: AutoPullIntegration): void {
    const key = `${workspaceRoot}::${integration}`;
    const state = this._states.get(key);
    if (!state) {
      return;
    }
    if (state.timeout) {
      clearTimeout(state.timeout);
    }
    this._states.delete(key);
  }

  public stopWorkspace(workspaceRoot: string): void {
    for (const key of this._states.keys()) {
      if (key.startsWith(`${workspaceRoot}::`)) {
        const state = this._states.get(key);
        if (state?.timeout) {
          clearTimeout(state.timeout);
        }
        this._states.delete(key);
      }
    }
  }

  public dispose(): void {
    for (const state of this._states.values()) {
      if (state.timeout) {
        clearTimeout(state.timeout);
      }
    }
    this._states.clear();
  }
}
```
- **Edge Cases Handled:** No overlapping timed imports, predictable stop/reconfigure behavior, and clean disposal when the extension shuts down or workspace folders change.

### 3. Wire auto-pull state, destination resolution, and scheduler startup through the Kanban provider
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** `KanbanProvider` already owns the cached `ClickUpSyncService` and `LinearSyncService` instances, posts integration state to `kanban.html`, and is instantiated at extension activation. It is the correct integration coordinator.
- **Logic:**
  1. Add a private `IntegrationAutoPullService` instance.
  2. Add helpers to build richer `clickupState` and `linearState` payloads that now include `autoPullEnabled` and `pullIntervalMinutes`.
  3. Add a helper to resolve the import destination via `TaskViewerProvider.getPlanIngestionFolder(workspaceRoot)` with `.switchboard/plans` as the fallback.
  4. Add `initializeIntegrationAutoPull()` that walks all open workspace roots, loads config for both integrations, and configures or stops schedulers accordingly.
  5. Add a single save message handler for interval/toggle changes that validates the integration name and interval before persisting.
  6. After a successful first-time `setupClickUp` or `setupLinear`, refresh the posted state and reconfigure timers for that workspace.
  7. Preserve the existing button-state messages; expand them rather than inventing a second UI state channel.
- **Implementation:**
```typescript
private readonly _integrationAutoPull = new IntegrationAutoPullService();
private static readonly _AUTO_PULL_INTERVALS = new Set([5, 15, 30, 60]);

private async _getIntegrationImportDir(workspaceRoot: string): Promise<string> {
  const configured = await this._taskViewerProvider?.getPlanIngestionFolder(workspaceRoot);
  return configured || path.join(workspaceRoot, '.switchboard', 'plans');
}

private _buildClickUpState(config: ClickUpConfig | null, syncError = false) {
  return {
    type: 'clickupState',
    setupComplete: config?.setupComplete ?? false,
    autoPullEnabled: config?.autoPullEnabled ?? false,
    pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
    syncError
  };
}

private _buildLinearState(config: LinearConfig | null, syncError = false) {
  return {
    type: 'linearState',
    setupComplete: config?.setupComplete ?? false,
    autoPullEnabled: config?.autoPullEnabled ?? false,
    pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
    syncError
  };
}

public async initializeIntegrationAutoPull(): Promise<void> {
  const roots = this._getWorkspaceRoots();
  const liveRoots = new Set(roots.map(root => path.resolve(root)));

  for (const root of roots) {
    await this._configureClickUpAutoPull(root);
    await this._configureLinearAutoPull(root);
  }

  // Stop timers for removed workspaces
  for (const knownRoot of Array.from(this._clickUpServices.keys())) {
    if (!liveRoots.has(knownRoot)) {
      this._integrationAutoPull.stopWorkspace(knownRoot);
    }
  }
}
```
- **Edge Cases Handled:** Timer startup happens from the same integration state owner that already knows about workspace roots, cached sync services, and the Kanban webview message channel.

### 4. Keep extension activation and manual import commands aligned with the timed path
#### [MODIFY] `src/extension.ts`
- **Context:** `extension.ts` already instantiates `KanbanProvider` once per activation and owns the manual import commands for ClickUp and Linear. This is the correct place to kick off initial scheduler configuration.
- **Logic:**
  1. After wiring `taskViewerProvider` and `kanbanProvider`, call `void kanbanProvider.initializeIntegrationAutoPull();`.
  2. Add a `vscode.workspace.onDidChangeWorkspaceFolders(...)` listener that re-runs provider initialization so timers follow added/removed folders.
  3. **Clarification:** update the manual `switchboard.importFromClickUp` and `switchboard.importFromLinear` commands to resolve the destination folder via `await taskViewerProvider.getPlanIngestionFolder(workspaceRoot)` instead of hard-coding `.switchboard/plans`. This keeps manual and automatic imports aligned without changing the feature surface.
- **Implementation:**
```typescript
taskViewerProvider.setKanbanProvider(kanbanProvider);
taskViewerProvider.setSetupPanelProvider(setupPanelProvider);
kanbanProvider.setTaskViewerProvider(taskViewerProvider);
setupPanelProvider.setTaskViewerProvider(taskViewerProvider);

void kanbanProvider.initializeIntegrationAutoPull();
context.subscriptions.push(
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void kanbanProvider.initializeIntegrationAutoPull();
  })
);

// Manual import destination alignment
const plansDir = await taskViewerProvider.getPlanIngestionFolder(workspaceRoot);
```
- **Edge Cases Handled:** Auto-pull starts even if the Kanban panel is never opened, and manual import commands do not drift into a different destination than the timed path.

### 5. Add the configuration UI to the real integration surface in the Kanban webview
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The existing user-facing integration controls are the `Setup ClickUp` and `Setup Linear` buttons in the Kanban strip. The plan should extend that surface instead of creating a new integration accordion in `setup.html`.
- **Logic:**
  1. Add a small modal using the existing `.modal-overlay` / `.modal-content` patterns already present in this file.
  2. Cache the latest `clickupState` and `linearState` payloads in the client script.
  3. Change button behavior:
     - If `setupComplete === false`, preserve the current behavior and run setup.
     - If `setupComplete === true`, open the settings modal for that integration instead of re-running setup immediately.
  4. The modal only needs the requested controls: an auto-pull checkbox and a 5/15/30/60-minute interval dropdown.
  5. Save through a single message, for example `saveIntegrationAutoPullSettings`, with `integration`, `autoPullEnabled`, and `pullIntervalMinutes`.
  6. Update tooltips so a configured integration clearly signals that the button now opens settings.
- **Implementation:**
```html
<div id="integration-settings-modal" class="modal-overlay hidden">
  <div class="modal-content">
    <div class="modal-header">
      <h3 class="modal-title" id="integration-settings-title">Integration Settings</h3>
      <button class="modal-close-btn" id="integration-settings-close">&times;</button>
    </div>
    <div class="modal-body">
      <label class="cli-toggle-inline" style="margin: 0 0 12px 0;">
        <label class="toggle-switch">
          <input type="checkbox" id="integration-autopull-toggle">
          <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">Enable Auto-Pull</span>
      </label>
      <label for="integration-interval-select">Pull Interval</label>
      <select id="integration-interval-select" class="kanban-mode-dropdown">
        <option value="5">Every 5 minutes</option>
        <option value="15">Every 15 minutes</option>
        <option value="30">Every 30 minutes</option>
        <option value="60">Every 60 minutes</option>
      </select>
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" id="integration-settings-cancel">Cancel</button>
      <button class="modal-btn modal-btn-primary" id="integration-settings-save">Save</button>
    </div>
  </div>
</div>
```
```javascript
const integrationState = {
  clickup: { setupComplete: false, autoPullEnabled: false, pullIntervalMinutes: 60 },
  linear: { setupComplete: false, autoPullEnabled: false, pullIntervalMinutes: 60 }
};
let activeIntegration = null;

function openIntegrationSettings(kind) {
  activeIntegration = kind;
  const state = integrationState[kind];
  document.getElementById('integration-settings-title').textContent =
    kind === 'clickup' ? 'ClickUp Auto-Pull Settings' : 'Linear Auto-Pull Settings';
  document.getElementById('integration-autopull-toggle').checked = !!state.autoPullEnabled;
  document.getElementById('integration-interval-select').value = String(state.pullIntervalMinutes || 60);
  document.getElementById('integration-settings-modal').classList.remove('hidden');
}
```
- **Edge Cases Handled:** The existing setup flow stays intact for unconfigured integrations, and users get a single, discoverable place to edit the new settings once setup is complete.

### 6. Add regression coverage for wiring and scheduler behavior
#### [CREATE] `src/test/integration-auto-pull-regression.test.js`
- **Context:** The highest regression risk is wiring drift between config fields, provider messages, extension activation, and the Kanban modal.
- **Logic:**
  1. Read `ClickUpSyncService.ts`, `LinearSyncService.ts`, `KanbanProvider.ts`, `extension.ts`, and `src/webview/kanban.html`.
  2. Assert that both config interfaces include the new fields and normalize them on load/save.
  3. Assert that `KanbanProvider.ts` initializes auto-pull on activation, validates settings saves, and enriches `clickupState` / `linearState`.
  4. Assert that `kanban.html` includes the settings modal and save message.
  5. Assert that manual import commands resolve the plan folder through `taskViewerProvider.getPlanIngestionFolder(...)`.
- **Edge Cases Handled:** Prevents a future refactor from partially removing the config fields, modal wiring, or destination alignment while leaving the rest of the feature behind.

#### [CREATE] `src/test/integration-auto-pull-service.test.js`
- **Context:** Timer overlap is the main logic risk; it deserves a direct behavior test instead of source-only assertions.
- **Logic:**
  1. Import the compiled `IntegrationAutoPullService` from `out/services/...`.
  2. Replace `setTimeout` / `clearTimeout` with deterministic fakes inside the test.
  3. Verify that `configure()` schedules exactly one timer, `stop()` clears it, and reconfiguration replaces the old timer.
  4. Verify that a long-running `runner()` does not cause overlapping second executions.
- **Edge Cases Handled:** Protects the scheduler from regressing back to overlapping interval behavior.

### 7. Update docs to reflect the real feature shape
#### [MODIFY] `README.md`
- **Context:** This is user-facing functionality. The README should explain that ClickUp and Linear now support optional timed imports after setup.
- **Logic:** Add a short integration note that manual import remains available and auto-pull is optional, disabled by default, and limited to the supported interval choices.

#### [MODIFY] `docs/TECHNICAL_DOC.md`
- **Context:** The timer lifecycle and import-path alignment are implementation details that future maintainers will otherwise rediscover the hard way.
- **Logic:** Document the persisted config fields, the scheduler ownership (`KanbanProvider` + `IntegrationAutoPullService`), and the requirement that manual and timed imports resolve the same destination folder.

## Verification Plan
### Automated Tests
- Run `npx tsc --noEmit`.
- Run `npm run compile`.
- Run `npx tsc -p tsconfig.test.json`.
- Run `node src/test/integration-auto-pull-regression.test.js`.
- Run `node src/test/integration-auto-pull-service.test.js`.
- Run `node src/test/clickup-setup-token-prompt-regression.test.js`.
- Run `node src/test/plan-ingestion-target-regression.test.js`.

### Manual Verification Steps
1. Open the Kanban board with a workspace that already has ClickUp configured and confirm the existing `ClickUp Synced` button opens the new settings modal instead of re-running setup.
2. Save `Enable Auto-Pull = off` and verify no timer is scheduled.
3. Save `Enable Auto-Pull = on` with a 5-minute interval and verify the provider starts exactly one timed import loop for that workspace/integration.
4. Repeat the same path for Linear.
5. Trigger the existing manual `importFromClickUp` / `importFromLinear` commands and confirm they write to the same destination folder that timed imports use.
6. Reload the window and verify enabled timers resume from persisted config.
7. Disable auto-pull again and verify the next scheduled run is cleared cleanly.

## Agent Recommendation
**Send to Coder** — Complexity 6. The feature is multi-file and lifecycle-sensitive, but it stays within existing integration surfaces and uses straightforward timer/state plumbing once the wrong `setup.html` path is removed from the plan.

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **NIT** Miracles do happen: this feature actually landed in the right building. The implementation stayed in the Kanban integration surface instead of smearing yet another half-related control panel into `setup.html`, and the timer logic uses per-integration `setTimeout` re-arming instead of the usual cursed `setInterval(async () => ...)` overlap machine.
>
> **NIT** The remaining weakness is mostly test shape, not product breakage. A lot of the coverage proves that the right code exists in the right files, which is useful, but still not the same thing as a live integration round-trip. If someone later gets “clever” with the modal wiring or provider coordination, the regexes may applaud while the runtime quietly sulks.

### Stage 2 (Balanced)
Keep the implementation as shipped. No CRITICAL or MAJOR defect was found in this reviewer pass, so no production-code fix was warranted. The plan’s core requirements are satisfied: ClickUp and Linear configs persist normalized auto-pull settings, the scheduler avoids overlapping runs, manual and timed imports share destination resolution, the Kanban strip opens a settings modal after setup instead of re-running setup, and the docs/tests reflect the real feature surface.

### Fixed Items
- No reviewer-applied production code fixes were needed.

### Files Changed
- Observed implementation files:
  - `src/services/ClickUpSyncService.ts`
  - `src/services/LinearSyncService.ts`
  - `src/services/IntegrationAutoPullService.ts`
  - `src/services/KanbanProvider.ts`
  - `src/extension.ts`
  - `src/webview/kanban.html`
  - `src/test/integration-auto-pull-regression.test.js`
  - `src/test/integration-auto-pull-service.test.js`
  - `README.md`
  - `docs/TECHNICAL_DOC.md`
- Reviewer update:
  - `.switchboard/plans/add_auto_pull_and_timer_to_integration_setup.md`

### Validation Results
- `npx tsc -p tsconfig.test.json` → passed
- `node src/test/integration-auto-pull-regression.test.js` → passed
- `node src/test/integration-auto-pull-service.test.js` → passed
- `node src/test/clickup-setup-token-prompt-regression.test.js` → passed
- `node src/test/plan-ingestion-target-regression.test.js` → passed
- `npm run compile` → passed
- `npx tsc --noEmit` → pre-existing TS2835 at `src/services/KanbanProvider.ts:2399` for `await import('./ArchiveManager')`

### Remaining Risks
- Coverage is strongest on wiring and scheduler behavior, but still lighter on true live integration/manual UX verification with real ClickUp/Linear credentials.
- The Kanban integration strip and provider message handlers remain merge hotspots for adjacent integration work.

## Original Draft (Preserved Verbatim)

# Add Auto-Pull and Timer Settings to Integration Setup

## Goal

Add UI controls and background polling logic to enable automatic card import from ClickUp and Linear boards on a configurable timer interval. Currently, card import is manual-only via `importTasksFromClickUp()` and `importIssuesFromLinear()`. This plan adds:
1. Toggle to enable/disable auto-pull for each integration
2. Timer interval setting (e.g., every 5, 15, 30, 60 minutes)
3. Background polling service that calls import methods on the configured interval
4. Config storage for these settings

## Metadata

**Tags:** backend, infrastructure, ui
**Complexity:** 5
**Prerequisites:** `clickup_1_foundation.md`, `clickup_2_setup_flow.md`, `clickup_3_sync_on_move.md`, `linear_1_foundation.md`, `linear_2_setup_flow.md`, `linear_3_sync_on_move.md`

## User Review Required

> [!NOTE]
> - **Background polling**: Uses `setInterval` with configurable intervals. Polling runs continuously when enabled.
> - **Non-blocking**: Import operations are async and fire-and-forget. Polling failures are logged but don't stop subsequent polls.
> - **Deduplication**: Import methods already skip cards that already have plan files or are owned by Switchboard (via tags/labels). Safe to run repeatedly.
> - **Configurable intervals**: Options: 5, 15, 30, 60 minutes, or "disabled". Default: disabled.
> - **Per-integration controls**: ClickUp and Linear have independent enable/disable and interval settings.

## Complexity Audit

### Routine
- **Config storage**: Add `autoPullEnabled` and `pullIntervalMinutes` to existing `ClickUpConfig` and `LinearConfig` interfaces
- **UI controls**: Add checkbox and select dropdown to setup.html following existing pattern (see "PROMPT CONTROLS" section)
- **Message handlers**: Add `getClickUpAutoPullConfig`, `saveClickUpAutoPullConfig`, `getLinearAutoPullConfig`, `saveLinearAutoPullConfig` to SetupPanelProvider

### Complex / Risky
- **Background polling service**: Need to create a new `PollingService` class that manages `setInterval` timers for both integrations. Must handle:
  - Start/stop polling based on config changes
  - Clear intervals when workspace closes
  - Rate limiting between consecutive imports (respect existing `_rateLimitDelay` from sync services)
- **State management**: Polling service needs access to `ClickUpSyncService` and `LinearSyncService` instances, which are cached in `KanbanProvider`. Need to wire this dependency correctly.

## Edge-Case & Dependency Audit

- **Integration not set up**: If `setupComplete: false` in config, polling is skipped entirely regardless of enable flag.
- **API quota exhaustion**: If import fails due to rate limits, log warning and continue polling on next interval. Don't disable auto-pull automatically.
- **Workspace switch**: When switching workspaces, clear polling timers for previous workspace and start for new one.
- **Concurrent imports**: Import methods are already designed to be idempotent (skip existing cards). Safe to call even if previous import hasn't finished.
- **Config race condition**: If user changes interval while polling is active, clear old timer and start new one with new interval.

## Cross-Plan Conflict Analysis

- **`ClickUpConfig` and `LinearConfig` interfaces**: Modified to add new fields. These are defined in `ClickUpSyncService.ts` and `LinearSyncService.ts`. No other plans depend on these interfaces.
- **`setup.html`**: Modified to add new UI section. This is additive only — no existing UI changes.
- **`SetupPanelProvider.ts`**: Modified to add new message handlers. This follows existing pattern (e.g., `getStartupCommands`, `saveStartupCommands`).
- **`KanbanProvider.ts`**: Modified to instantiate and manage `PollingService`. This is a new dependency — need to add `_pollingService` field and lifecycle management.
- **No conflict** with existing sync-on-move plans — polling is independent and doesn't interfere with debounced sync on card moves.

## Adversarial Synthesis

### Grumpy Critique

1. **Polling is the wrong architecture.** You're adding `setInterval` polling when both ClickUp and Linear support webhooks. Why not use webhooks? Because that requires setting up a public endpoint, handling auth, and dealing with webhook delivery reliability. Polling is simpler for a VS Code extension that runs locally. But you should document this trade-off and acknowledge that webhooks would be better for production use.

2. **No way to see last poll time.** Users won't know if auto-pull is actually working. You should add a "Last poll: [timestamp]" indicator in the setup UI, similar to how ClickUp shows "⚠️ Sync Error" after failures.

3. **Interval options are arbitrary.** Why 5, 15, 30, 60? What if I want 2 hours? You should allow custom input or at least add more options (2h, 4h, 8h, 24h).

4. **Polling service lifecycle is unclear.** When does it start? When does it stop? What if the user disables auto-pull while a poll is in-flight? You need clear lifecycle rules: start on extension activation if config enables it, stop on deactivation, clear timer on config disable.

### Balanced Response

1. **Webhook trade-off documented**: Added a note in User Review explaining that polling is used for simplicity (local VS Code extension) and that webhooks would require public endpoint infrastructure. Acknowledged as a known limitation.

2. **Last poll indicator added**: Added `lastPollTimestamp` to config and UI display. Shows "Last poll: [relative time]" in setup panel. Shows "Never polled" if never run.

3. **Interval options expanded**: Added 2h, 4h, 8h, 24h options. Also added "Custom" option with number input for user-defined minutes.

4. **Lifecycle clarified**: 
   - Start: On extension activation, if config has `autoPullEnabled: true` and `setupComplete: true`
   - Stop: On extension deactivation (dispose)
   - Config disable: Clear timer immediately, don't wait for next interval
   - In-flight poll: Let it complete (fire-and-forget), but don't start new one

## Proposed Changes

### Target File 1: Config Interface Updates
#### MODIFY `src/services/ClickUpSyncService.ts`

Add fields to `ClickUpConfig` interface:

```typescript
export interface ClickUpConfig {
  workspaceId: string;
  folderId: string;
  spaceId: string;
  columnMappings: Record<string, string>;
  customFields: {
    sessionId: string;
    planId: string;
    syncTimestamp: string;
  };
  setupComplete: boolean;
  lastSync: string | null;
  // NEW FIELDS
  autoPullEnabled: boolean;
  pullIntervalMinutes: number;
  lastPollTimestamp: string | null;
}
```

Update default config in `setup()` method:

```typescript
config = {
  workspaceId: '',
  folderId: '',
  spaceId: '',
  columnMappings: Object.fromEntries(CANONICAL_COLUMNS.map(c => [c, ''])),
  customFields: { sessionId: '', planId: '', syncTimestamp: '' },
  setupComplete: false,
  lastSync: null,
  autoPullEnabled: false,
  pullIntervalMinutes: 60,
  lastPollTimestamp: null
};
```

#### MODIFY `src/services/LinearSyncService.ts`

Add fields to `LinearConfig` interface:

```typescript
export interface LinearConfig {
  teamId: string;
  teamName: string;
  projectId?: string;
  columnToStateId: Record<string, string>;
  switchboardLabelId: string;
  setupComplete: boolean;
  lastSync: string | null;
  // NEW FIELDS
  autoPullEnabled: boolean;
  pullIntervalMinutes: number;
  lastPollTimestamp: string | null;
}
```

Update default config in `setup()` method:

```typescript
await this.saveConfig({
  teamId: selectedTeam.id,
  teamName: selectedTeam.label,
  projectId: selectedProject.id || undefined,
  columnToStateId,
  switchboardLabelId,
  setupComplete: true,
  lastSync: null,
  autoPullEnabled: false,
  pullIntervalMinutes: 60,
  lastPollTimestamp: null
});
```

### Target File 2: Polling Service
#### CREATE `src/services/PollingService.ts`

```typescript
import * as vscode from 'vscode';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';

export class PollingService implements vscode.Disposable {
  private _clickUpInterval: NodeJS.Timeout | null = null;
  private _linearInterval: NodeJS.Timeout | null = null;
  private _clickUpService: ClickUpSyncService;
  private _linearService: LinearSyncService;
  private _workspaceRoot: string;
  private _plansDir: string;

  constructor(
    workspaceRoot: string,
    plansDir: string,
    clickUpService: ClickUpSyncService,
    linearService: LinearSyncService
  ) {
    this._workspaceRoot = workspaceRoot;
    this._plansDir = plansDir;
    this._clickUpService = clickUpService;
    this._linearService = linearService;
  }

  async startClickUpPolling(intervalMinutes: number): Promise<void> {
    this.stopClickUpPolling();
    const intervalMs = intervalMinutes * 60 * 1000;
    
    // Initial poll
    await this._pollClickUp();
    
    // Start recurring timer
    this._clickUpInterval = setInterval(async () => {
      await this._pollClickUp();
    }, intervalMs);
  }

  stopClickUpPolling(): void {
    if (this._clickUpInterval) {
      clearInterval(this._clickUpInterval);
      this._clickUpInterval = null;
    }
  }

  async startLinearPolling(intervalMinutes: number): Promise<void> {
    this.stopLinearPolling();
    const intervalMs = intervalMinutes * 60 * 1000;
    
    // Initial poll
    await this._pollLinear();
    
    // Start recurring timer
    this._linearInterval = setInterval(async () => {
      await this._pollLinear();
    }, intervalMs);
  }

  stopLinearPolling(): void {
    if (this._linearInterval) {
      clearInterval(this._linearInterval);
      this._linearInterval = null;
    }
  }

  private async _pollClickUp(): Promise<void> {
    try {
      const config = await this._clickUpService.loadConfig();
      if (!config?.setupComplete || !config.autoPullEnabled) {
        return;
      }

      // Poll all lists (each canonical column maps to a list)
      for (const listId of Object.values(config.columnMappings)) {
        if (!listId) continue;
        
        const result = await this._clickUpService.importTasksFromClickUp(listId, this._plansDir);
        if (result.success) {
          console.log(`[PollingService] ClickUp poll: imported ${result.imported}, skipped ${result.skipped}`);
        } else {
          console.warn(`[PollingService] ClickUp poll failed: ${result.error}`);
        }
      }

      // Update last poll timestamp
      config.lastPollTimestamp = new Date().toISOString();
      await this._clickUpService.saveConfig(config);
    } catch (error) {
      console.warn(`[PollingService] ClickUp poll error:`, error);
    }
  }

  private async _pollLinear(): Promise<void> {
    try {
      const config = await this._linearService.loadConfig();
      if (!config?.setupComplete || !config.autoPullEnabled) {
        return;
      }

      const result = await this._linearService.importIssuesFromLinear(this._plansDir);
      if (result.success) {
        console.log(`[PollingService] Linear poll: imported ${result.imported}, skipped ${result.skipped}`);
      } else {
        console.warn(`[PollingService] Linear poll failed: ${result.error}`);
      }

      // Update last poll timestamp
      config.lastPollTimestamp = new Date().toISOString();
      await this._linearService.saveConfig(config);
    } catch (error) {
      console.warn(`[PollingService] Linear poll error:`, error);
    }
  }

  dispose(): void {
    this.stopClickUpPolling();
    this.stopLinearPolling();
  }
}
```

### Target File 3: KanbanProvider Integration
#### MODIFY `src/services/KanbanProvider.ts`

Add private field:

```typescript
private _pollingServices: Map<string, PollingService> = new Map();
```

Add getter method:

```typescript
private _getPollingService(workspaceRoot: string): PollingService {
  let service = this._pollingServices.get(workspaceRoot);
  if (!service) {
    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
    const clickUp = this._getClickUpService(workspaceRoot);
    const linear = this._getLinearService(workspaceRoot);
    service = new PollingService(workspaceRoot, plansDir, clickUp, linear);
    this._pollingServices.set(workspaceRoot, service);
  }
  return service;
}
```

In the constructor or initialization, add startup logic:

```typescript
// Start polling if configured
async function startPollingIfConfigured(workspaceRoot: string) {
  try {
    const clickUp = this._getClickUpService(workspaceRoot);
    const linear = this._getLinearService(workspaceRoot);
    const polling = this._getPollingService(workspaceRoot);

    const clickUpConfig = await clickUp.loadConfig();
    if (clickUpConfig?.autoPullEnabled && clickUpConfig.setupComplete) {
      await polling.startClickUpPolling(clickUpConfig.pullIntervalMinutes);
    }

    const linearConfig = await linear.loadConfig();
    if (linearConfig?.autoPullEnabled && linearConfig.setupComplete) {
      await polling.startLinearPolling(linearConfig.pullIntervalMinutes);
    }
  } catch (error) {
    console.warn('[KanbanProvider] Failed to start polling:', error);
  }
}

// Call this after workspace is initialized
```

In the dispose method, add:

```typescript
this._pollingServices.forEach(service => service.dispose());
this._pollingServices.clear();
```

### Target File 4: Setup Panel UI
#### MODIFY `src/webview/setup.html`

Add new section after "Database Operations" section:

```html
<div class="startup-section">
    <div class="startup-toggle" id="integrations-toggle">
        <div class="section-label">Integrations</div>
        <span class="chevron" id="integrations-chevron">▶</span>
    </div>
    <div class="startup-fields" id="integrations-fields" data-accordion="true">
        <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            CLICKUP
        </div>
        <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
            <input id="clickup-autopull-toggle" type="checkbox" style="width:auto; margin:0;">
            <span>Enable auto-pull from ClickUp</span>
        </label>
        <label class="startup-row" style="display:block; margin-top:6px;">
            <span style="display:block; margin-bottom:4px;">Pull interval</span>
            <select id="clickup-pull-interval" style="width:100%;">
                <option value="5">Every 5 minutes</option>
                <option value="15">Every 15 minutes</option>
                <option value="30">Every 30 minutes</option>
                <option value="60">Every 1 hour</option>
                <option value="120">Every 2 hours</option>
                <option value="240">Every 4 hours</option>
                <option value="480">Every 8 hours</option>
                <option value="1440">Every 24 hours</option>
                <option value="custom">Custom...</option>
            </select>
        </label>
        <div id="clickup-custom-interval-row" class="startup-row hidden" style="display:block; margin-top:6px;">
            <span style="display:block; margin-bottom:4px;">Custom interval (minutes)</span>
            <input id="clickup-custom-interval" type="number" min="1" max="10080" style="width:100%;">
        </div>
        <div id="clickup-last-poll" style="font-size:10px; color:var(--text-secondary); margin-top:4px; font-family:var(--font-mono;">
            Last poll: Never
        </div>

        <div style="font-size: 10px; color: var(--text-secondary); margin: 16px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            LINEAR
        </div>
        <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
            <input id="linear-autopull-toggle" type="checkbox" style="width:auto; margin:0;">
            <span>Enable auto-pull from Linear</span>
        </label>
        <label class="startup-row" style="display:block; margin-top:6px;">
            <span style="display:block; margin-bottom:4px;">Pull interval</span>
            <select id="linear-pull-interval" style="width:100%;">
                <option value="5">Every 5 minutes</option>
                <option value="15">Every 15 minutes</option>
                <option value="30">Every 30 minutes</option>
                <option value="60">Every 1 hour</option>
                <option value="120">Every 2 hours</option>
                <option value="240">Every 4 hours</option>
                <option value="480">Every 8 hours</option>
                <option value="1440">Every 24 hours</option>
                <option value="custom">Custom...</option>
            </select>
        </label>
        <div id="linear-custom-interval-row" class="startup-row hidden" style="display:block; margin-top:6px;">
            <span style="display:block; margin-bottom:4px;">Custom interval (minutes)</span>
            <input id="linear-custom-interval" type="number" min="1" max="10080" style="width:100%;">
        </div>
        <div id="linear-last-poll" style="font-size:10px; color:var(--text-secondary); margin-top:4px; font-family:var(--font-mono;">
            Last poll: Never
        </div>

        <button id="btn-save-integration-config" class="secondary-btn w-full" style="margin-top:12px; color: var(--accent-green); border-color: color-mix(in srgb, var(--accent-green) 250%, transparent);">
            SAVE INTEGRATION CONFIG
        </button>
    </div>
</div>
```

Add JavaScript handlers in setup.html:

```javascript
// Integration config
const integrationsToggle = document.getElementById('integrations-toggle');
const integrationsFields = document.getElementById('integrations-fields');
const integrationsChevron = document.getElementById('integrations-chevron');
const clickupAutopullToggle = document.getElementById('clickup-autopull-toggle');
const clickupPullInterval = document.getElementById('clickup-pull-interval');
const clickupCustomIntervalRow = document.getElementById('clickup-custom-interval-row');
const clickupCustomInterval = document.getElementById('clickup-custom-interval');
const clickupLastPoll = document.getElementById('clickup-last-poll');
const linearAutopullToggle = document.getElementById('linear-autopull-toggle');
const linearPullInterval = document.getElementById('linear-pull-interval');
const linearCustomIntervalRow = document.getElementById('linear-custom-interval-row');
const linearCustomInterval = document.getElementById('linear-custom-interval');
const linearLastPoll = document.getElementById('linear-last-poll');

let lastClickUpConfig = { autoPullEnabled: false, pullIntervalMinutes: 60, lastPollTimestamp: null };
let lastLinearConfig = { autoPullEnabled: false, pullIntervalMinutes: 60, lastPollTimestamp: null };

// Bind accordion for integrations section
bindAccordion('integrations-toggle', 'integrations-fields', 'integrations-chevron', () => {
  vscode.postMessage({ type: 'getClickUpAutoPullConfig' });
  vscode.postMessage({ type: 'getLinearAutoPullConfig' });
});

// Handle interval select change
clickupPullInterval.addEventListener('change', () => {
  if (clickupPullInterval.value === 'custom') {
    clickupCustomIntervalRow.classList.remove('hidden');
  } else {
    clickupCustomIntervalRow.classList.add('hidden');
  }
});

linearPullInterval.addEventListener('change', () => {
  if (linearPullInterval.value === 'custom') {
    linearCustomIntervalRow.classList.remove('hidden');
  } else {
    linearCustomIntervalRow.classList.add('hidden');
  }
});

// Save integration config
document.getElementById('btn-save-integration-config').addEventListener('click', () => {
  const clickupInterval = clickupPullInterval.value === 'custom' 
    ? parseInt(clickupCustomInterval.value, 10) || 60 
    : parseInt(clickupPullInterval.value, 10);
  
  const linearInterval = linearPullInterval.value === 'custom'
    ? parseInt(linearCustomInterval.value, 10) || 60
    : parseInt(linearPullInterval.value, 10);

  vscode.postMessage({
    type: 'saveClickUpAutoPullConfig',
    autoPullEnabled: clickupAutopullToggle.checked,
    pullIntervalMinutes: clickupInterval
  });

  vscode.postMessage({
    type: 'saveLinearAutoPullConfig',
    autoPullEnabled: linearAutopullToggle.checked,
    pullIntervalMinutes: linearInterval
  });
});

// Format relative time for last poll
function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hours ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} days ago`;
}
```

Add message handler in setup.html:

```javascript
window.addEventListener('message', (event) => {
  const message = event.data;
  
  // ... existing handlers ...

  switch (message.type) {
    // ... existing cases ...

    case 'clickUpAutoPullConfig':
      lastClickUpConfig = message;
      clickupAutopullToggle.checked = message.autoPullEnabled;
      clickupPullInterval.value = message.pullIntervalMinutes.toString();
      if (message.pullIntervalMinutes < 5 || message.pullIntervalMinutes > 1440 || ![5,15,30,60,120,240,480,1440].includes(message.pullIntervalMinutes)) {
        clickupPullInterval.value = 'custom';
        clickupCustomInterval.value = message.pullIntervalMinutes.toString();
        clickupCustomIntervalRow.classList.remove('hidden');
      }
      clickupLastPoll.textContent = `Last poll: ${formatRelativeTime(message.lastPollTimestamp)}`;
      break;

    case 'linearAutoPullConfig':
      lastLinearConfig = message;
      linearAutopullToggle.checked = message.autoPullEnabled;
      linearPullInterval.value = message.pullIntervalMinutes.toString();
      if (message.pullIntervalMinutes < 5 || message.pullIntervalMinutes > 1440 || ![5,15,30,60,120,240,480,1440].includes(message.pullIntervalMinutes)) {
        linearPullInterval.value = 'custom';
        linearCustomInterval.value = message.pullIntervalMinutes.toString();
        linearCustomIntervalRow.classList.remove('hidden');
      }
      linearLastPoll.textContent = `Last poll: ${formatRelativeTime(message.lastPollTimestamp)}`;
      break;
  }
});
```

### Target File 5: Setup Panel Provider Message Handlers
#### MODIFY `src/services/SetupPanelProvider.ts`

Add message handlers:

```typescript
case 'getClickUpAutoPullConfig': {
  const clickUpService = new ClickUpSyncService(this._extensionUri.fsPath, this._context.secrets);
  const config = await clickUpService.loadConfig();
  this._panel?.webview.postMessage({
    type: 'clickUpAutoPullConfig',
    autoPullEnabled: config?.autoPullEnabled ?? false,
    pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
    lastPollTimestamp: config?.lastPollTimestamp ?? null
  });
  break;
}

case 'saveClickUpAutoPullConfig': {
  const clickUpService = new ClickUpSyncService(this._extensionUri.fsPath, this._context.secrets);
  const config = await clickUpService.loadConfig();
  if (config) {
    config.autoPullEnabled = message.autoPullEnabled;
    config.pullIntervalMinutes = message.pullIntervalMinutes;
    await clickUpService.saveConfig(config);
    
    // Restart polling with new config
    const workspaceRoot = this._extensionUri.fsPath;
    const taskViewer = this._taskViewerProvider as any;
    const polling = taskViewer?._getPollingService?.(workspaceRoot);
    if (polling) {
      if (message.autoPullEnabled && config.setupComplete) {
        await polling.startClickUpPolling(message.pullIntervalMinutes);
      } else {
        polling.stopClickUpPolling();
      }
    }
  }
  break;
}

case 'getLinearAutoPullConfig': {
  const linearService = new LinearSyncService(this._extensionUri.fsPath, this._context.secrets);
  const config = await linearService.loadConfig();
  this._panel?.webview.postMessage({
    type: 'linearAutoPullConfig',
    autoPullEnabled: config?.autoPullEnabled ?? false,
    pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
    lastPollTimestamp: config?.lastPollTimestamp ?? null
  });
  break;
}

case 'saveLinearAutoPullConfig': {
  const linearService = new LinearSyncService(this._extensionUri.fsPath, this._context.secrets);
  const config = await linearService.loadConfig();
  if (config) {
    config.autoPullEnabled = message.autoPullEnabled;
    config.pullIntervalMinutes = message.pullIntervalMinutes;
    await linearService.saveConfig(config);
    
    // Restart polling with new config
    const workspaceRoot = this._extensionUri.fsPath;
    const taskViewer = this._taskViewerProvider as any;
    const polling = taskViewer?._getPollingService?.(workspaceRoot);
    if (polling) {
      if (message.autoPullEnabled && config.setupComplete) {
        await polling.startLinearPolling(message.pullIntervalMinutes);
      } else {
        polling.stopLinearPolling();
      }
    }
  }
  break;
}
```

## Verification Plan

### Automated Tests
- **PollingService lifecycle**: Mock `ClickUpSyncService` and `LinearSyncService`. Verify `startClickUpPolling` calls import method immediately, then on interval. Verify `stopClickUpPolling` clears timer.
- **Config update restart**: Start polling with 5min interval, update config to 15min, verify timer is restarted with new interval.
- **Import failure handling**: Mock import to throw error. Verify error is logged, polling continues on next interval.

### Manual Verification Steps
1. Open Setup panel → Integrations section
2. Enable ClickUp auto-pull, set interval to 5 minutes
3. Verify "Last poll: Just now" appears after saving
4. Add a new task to ClickUp in a mapped list
5. Wait 5 minutes → verify new plan file appears in `.switchboard/plans/`
6. Change interval to 1 hour → verify timer restarts
7. Disable auto-pull → verify polling stops
8. Repeat steps for Linear integration

## Files to Modify

1. `src/services/ClickUpSyncService.ts` — MODIFY (add `autoPullEnabled`, `pullIntervalMinutes`, `lastPollTimestamp` to config interface)
2. `src/services/LinearSyncService.ts` — MODIFY (add same fields to config interface)
3. `src/services/PollingService.ts` — CREATE (new polling service class)
4. `src/services/KanbanProvider.ts` — MODIFY (add `_pollingServices` map and lifecycle management)
5. `src/webview/setup.html` — MODIFY (add Integrations section with UI controls and JavaScript handlers)
6. `src/services/SetupPanelProvider.ts` — MODIFY (add message handlers for auto-pull config)

## Agent Recommendation

**Send to Coder** — Complexity 5. The polling service is straightforward (timer management with start/stop). The UI changes follow existing patterns. The config updates are straightforward interface additions. The main risk is ensuring polling lifecycle is correctly tied to extension activation/deactivation and config changes.
