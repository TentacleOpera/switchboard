# Redesign Integration Setup as Checkbox Options

## Goal
Replace the current all-or-nothing setup buttons in the central integration setup panel with explicit per-integration checkbox options while preserving the existing ClickUp, Linear, and Notion capabilities that already exist in the codebase. The implementation must move capability selection out of the standalone global operation-mode UI and into the integration sections themselves without adding new product scope.

## Metadata
**Tags:** frontend, backend, UI
**Complexity:** 8

## User Review Required
> [!NOTE]
> - This plan changes setup UX and persisted integration behavior. Existing `.switchboard/clickup-config.json`, `.switchboard/linear-config.json`, and `.switchboard/notion-config.json` state must be migrated or normalized rather than discarded.
> - **Clarification:** keep the existing post-setup editors in `src/webview/setup.html` (`#clickup-mappings-section`, `#clickup-automation-section`, `#linear-automation-section`). The checkbox redesign replaces the initial setup controls; it does not remove the downstream mapping or automation editors.
> - **Clarification:** the existing planner design-doc toggle in `src/webview/setup.html` (`#design-doc-toggle`) and the persisted `planner.designDocEnabled` / `planner.designDocLink` settings in `src/services/TaskViewerProvider.ts` remain the single source of truth for whether planner prompts append a design document. The Notion checkbox in this plan must reuse that path instead of inventing a second persisted Notion-only enable flag.
> - **Clarification:** existing command entry points in `src/extension.ts` (`switchboard.setupClickUp`, `switchboard.setupLinear`, `switchboard.setNotionToken`) stay valid. If setup-panel webview message names change, migrate the setup panel, provider handlers, and regression tests together without breaking command-palette entry points mid-refactor.
> - **Clarification:** because the current Kanban header toggle only exists to flip the soon-to-be-removed global mode, `src/webview/kanban.html` should repurpose that control into an integration-setup shortcut instead of leaving a misleading runtime toggle behind.
> - Recommended agent: Send to Lead Coder

## Complexity Audit
### Routine
- Replace the button-only controls in `src/webview/setup.html` with explicit checkbox groups, apply buttons, and richer status text for ClickUp, Linear, and Notion.
- Expand setup-panel message routing in `src/services/SetupPanelProvider.ts` and setup-state hydration in `src/services/TaskViewerProvider.ts` so the webview can send structured option payloads and receive option-state summaries.
- Add or update regression assertions in `src/test/setup-panel-migration.test.js` so the setup panel owns the new checkbox UI and no longer depends on the old operation-mode subsection.
- Extend existing service-level tests in `src/test/integrations/clickup/clickup-sync-service.test.js` and `src/test/integrations/linear/linear-sync-service.test.js` to cover the new config fields and option-aware apply flows instead of inventing duplicate test suites.

### Complex / Risky
- Remove the global `_operationMode` dependency from `src/services/KanbanProvider.ts`, `src/webview/setup.html`, `src/webview/kanban.html`, and `src/test/operation-mode-toggle-regression.test.js` without breaking auto-pull timers, automation polling, card-move sync, or live content sync.
- Refactor `ClickUpSyncService.setup()` and `LinearSyncService.setup()` into idempotent, option-aware flows that can safely reapply against already configured workspaces without duplicating folders, lists, mappings, or labels.
- Preserve backward compatibility for already configured integrations by deriving truthful checkbox hydration from existing config files and by defaulting legacy workspaces to their current behavior where the new flags are absent.
- Keep the Notion path transparent without creating a second source of truth for design-doc enablement or a token-saving flow that lies about planner behavior.

## Edge-Case & Dependency Audit
- **Race Conditions:** applying checkbox selections must disable the per-integration apply button until the provider returns, otherwise repeated clicks can trigger duplicate ClickUp folder/list creation or repeated Linear QuickPick prompts. Timer reconfiguration in `src/services/KanbanProvider.ts` must continue to reuse the existing `IntegrationAutoPullService` in-flight protections when `autoPullEnabled` changes, and `ContinuousSyncService` must stop cleanly when both integrations have real-time sync disabled so it does not keep processing stale queued file events.
- **Security:** tokens must remain in VS Code `SecretStorage` only. The setup-panel webview may send tokens to the extension host on apply, but the host must not echo tokens back in result payloads or persist them into `.switchboard/*.json`. New payloads should carry only non-secret booleans, ids, counts, and error strings after apply completes.
- **Side Effects:** removing the global operation-mode toggle affects more than the setup panel. `src/webview/kanban.html` currently renders a mode button, `src/services/KanbanProvider.ts` currently gates automation and live sync by mode, and `src/services/ContinuousSyncService.ts` still claims it starts and stops based on Board Management Mode. If those surfaces are not updated together, the UI will advertise a mode that no longer exists while background sync still follows the old rules. Real-time sync opt-out must also short-circuit all existing write paths: `KanbanProvider._queueClickUpSync()`, `KanbanProvider._queueLinearSync()`, the ClickUp plan-content watcher hook in `_setupPlanContentWatcher()`, and `ContinuousSyncService._syncToClickUp()` / `_syncToLinear()`.
- **Dependencies & Conflicts:** `get_kanban_state` currently shows no active New plans and only this plan in Planned, so there is no active Kanban dependency. Historical overlap still exists in `.switchboard/plans/add_operation_mode_toggle_for_event_driven_integrations.md`, `.switchboard/plans/add_auto_pull_and_timer_to_integration_setup.md`, `.switchboard/plans/fix_board_management_button_and_integration_panel_ux.md`, `.switchboard/plans/setup_view_improvements.md`, and `.switchboard/plans/add_project_management_accordion_to_central_setup.md`. Those plans are not active blockers under the planning rules, but they touched the same code paths (`src/webview/setup.html`, `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, and the regex-based test files), so this work must avoid reintroducing obsolete mode-toggle markup, stale setup copy, or the older setup-panel structure.

## Adversarial Synthesis
### Grumpy Critique
This draft is trying to replace one obvious button with a whole distributed state machine and pretending the blast radius stops at `src/webview/setup.html`. It does not. The moment you remove the standalone operation-mode UI without unwinding `_operationMode` in `src/services/KanbanProvider.ts`, `updateOperationModeUi()` in `src/webview/setup.html`, the header toggle in `src/webview/kanban.html`, and the regex tests that police those paths, you will ship a haunted interface where automation disappears, sync still runs, and nobody can explain which checkbox actually won.

ClickUp is the nastiest trap. `ClickUpSyncService.setup()` is not an "apply options" helper today; it is a transactional wizard that fetches a workspace, prompts for a space, creates or reuses the "AI Agents" folder, creates lists, and opportunistically creates custom fields. If you just cram checkbox booleans into that method, every re-apply becomes roulette: duplicate resources, half-written config, cleanup logic that only understands the legacy all-or-nothing path, and a UI that claims a resource is "optional" while the backend still secretly depends on it.

Linear is not safer just because it is cleaner. The current flow prompts for team selection, optional project scope, full column mapping, and label creation in a fixed sequence. Turning that into checkbox-driven setup means you must spell out which prompts still appear, which persisted values are reused, and what "unchecked" means for previously saved state. If you do not define that now, the implementer will either silently keep stale project scope forever or wipe mappings the user never asked to touch.

And Notion is a classic foot-gun. There is already a global design-doc toggle in `src/webview/setup.html` backed by `planner.designDocEnabled` and `planner.designDocLink` in `src/services/TaskViewerProvider.ts`. If this plan adds a shiny new "Enable design document fetching" checkbox and persists it somewhere else, congratulations: you now have two sources of truth for one behavior and a guaranteed bug report that says "Notion says enabled but planner prompts still ignore it."

### Balanced Response
The corrected plan narrows the change to concrete, already-existing surfaces and separates one-time provisioning from ongoing behavior flags. The setup panel should own the new checkbox UX, but the backend must derive resource state from existing config (`folderId`, `columnMappings`, `customFields`, `projectId`, `switchboardLabelId`) and add only the missing behavior flags needed for ongoing enablement, especially per-integration real-time sync.

For ClickUp and Linear, the safest path is to keep legacy `setup()` entry points as compatibility wrappers while introducing option-aware apply methods that reuse extracted idempotent helpers. That preserves command-palette compatibility, allows the setup panel to express explicit choices, and makes re-apply flows predictable instead of rerunning the full wizard every time.

For the former mode logic, the plan should delete the global toggle and move every sync decision to the integration config that actually owns it: card-move sync, content sync, auto-pull, automation polling, and setup-panel visibility. Notion should stay aligned with the already-existing planner design-doc setting, so the new checkbox is a transparent setup affordance rather than a second persisted feature flag. Those adjustments keep the redesign in scope while preventing the state drift and duplicate-truth bugs Grumpy is warning about.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The sections below are the authoritative implementation spec. The preserved draft later in this file is historical context only. Where the preserved draft conflicts with the sections below, follow the sections below.

### Low Complexity / UI Wiring
#### [MODIFY] `src/webview/setup.html`
- **Context:** the current project-management accordion still has a standalone `OPERATION MODE` subsection, button-only setup controls (`#btn-setup-clickup`, `#btn-setup-linear`, `#btn-setup-notion`), and automation-section visibility that depends on `currentOperationMode` / `currentOperationNeedsSetup` rather than on per-integration config. This file is the primary UX surface for the requested redesign.
- **Logic:**
  1. Remove the entire standalone operation-mode subsection and its badge copy from the project-management accordion.
  2. Leave the token inputs in place for all three integrations.
  3. Replace each setup button with explicit checkbox rows plus one apply button per integration.
  4. Preserve the existing ClickUp mapping editor and ClickUp/Linear automation editors below the new checkbox controls so reconfiguration still happens in the same panel.
  5. Stop using `currentOperationMode` and `currentOperationNeedsSetup` to decide whether automation editors render; instead render them from the integration's own state so the panel no longer requires a global mode to be visible.
  6. Keep the separate Live Sync Configuration block, but update its helper text so it is clearly a secondary global service that only applies to integrations whose per-integration real-time sync flag is enabled.
- **Implementation:**
  1. Replace the old `OPERATION MODE` block with per-integration checkbox groups using explicit ids:
     - ClickUp:
       - `#clickup-option-create-folder`
       - `#clickup-option-create-lists`
       - `#clickup-option-create-custom-fields`
       - `#clickup-option-enable-realtime-sync`
       - `#clickup-option-enable-auto-pull`
       - `#btn-apply-clickup-config`
       - `#clickup-option-summary`
     - Linear:
       - `#linear-option-map-columns`
       - `#linear-option-create-label`
       - `#linear-option-scope-project`
       - `#linear-option-enable-realtime-sync`
       - `#linear-option-enable-auto-pull`
       - `#btn-apply-linear-config`
       - `#linear-option-summary`
     - Notion:
       - `#notion-option-enable-design-doc`
       - `#btn-apply-notion-config`
       - `#notion-option-summary`
  2. Replace the old webview messages with explicit apply payloads:
     ```js
     { type: 'applyClickUpConfig', token, options: {
         createFolder: boolean,
         createLists: boolean,
         createCustomFields: boolean,
         enableRealtimeSync: boolean,
         enableAutoPull: boolean
     } }
     ```
     ```js
     { type: 'applyLinearConfig', token, options: {
         mapColumns: boolean,
         createLabel: boolean,
         scopeProject: boolean,
         enableRealtimeSync: boolean,
         enableAutoPull: boolean
     } }
     ```
     ```js
     { type: 'applyNotionConfig', token, options: {
         enableDesignDocFetching: boolean
     } }
     ```
  3. Remove these setup-panel-only functions and listeners because they no longer match the requested UX:
     - `updateOperationModeUi(...)`
     - `btn-setup-coding-mode` / `btn-setup-board-mgmt-mode` listeners
     - `case 'operationModeChanged'` in the setup-panel message handler
  4. Add helpers that explicitly collect and hydrate checkbox state:
     - `collectClickupApplyOptions()`
     - `collectLinearApplyOptions()`
     - `collectNotionApplyOptions()`
     - `renderClickupOptionSummary(state)`
     - `renderLinearOptionSummary(state)`
     - `renderNotionOptionSummary(state)`
  5. Change setup-result message handling so the webview listens for `clickupApplyResult`, `linearApplyResult`, and `notionApplyResult`, then reuses the existing `setIntegrationStatus(...)`, `setClickupSetupMessage(...)`, and `setLinearSetupMessage(...)` flows.
  6. Keep `#clickup-mappings-section`, `#clickup-automation-section`, and `#linear-automation-section`, but drive their visibility from the new integration state fields rather than `currentOperationMode === 'board-management'`.
- **Edge Cases Handled:** the apply buttons can be disabled when no checkbox is selected, token validation can continue using the existing error containers, and previously configured mappings/automation remain reachable because the redesign changes only the initial control block rather than hiding or deleting the existing post-setup editors.

#### [MODIFY] `src/services/SetupPanelProvider.ts`
- **Context:** this provider currently routes `setupClickUp`, `setupLinear`, `setupNotion`, and `switchOperationMode` messages from `setup.html` into `TaskViewerProvider`. The redesign needs structured option payloads instead of one-token setup calls.
- **Logic:**
  1. Replace the three integration setup message cases with `applyClickUpConfig`, `applyLinearConfig`, and `applyNotionConfig`.
  2. Remove the setup-panel `switchOperationMode` case once `setup.html` stops sending it.
  3. Keep the existing `getIntegrationSetupStates` and `postSetupPanelState()` refresh path so the panel rehydrates after every apply.
- **Implementation:**
  1. Replace:
     - `case 'setupClickUp'`
     - `case 'setupLinear'`
     - `case 'setupNotion'`
     - `case 'switchOperationMode'`
  2. Add:
     - `case 'applyClickUpConfig'`
     - `case 'applyLinearConfig'`
     - `case 'applyNotionConfig'`
  3. Each new case should pass both `message.token` and `message.options` to the matching `TaskViewerProvider` handler, then emit:
     - `clickupApplyResult`
     - `linearApplyResult`
     - `notionApplyResult`
  4. Preserve the existing refresh sequence after successful or failed apply:
     - `await this._taskViewerProvider.postSetupPanelState();`
     - `await vscode.commands.executeCommand('switchboard.refreshUI');`
- **Edge Cases Handled:** all setup-panel state rebroadcast still goes through the existing provider refresh path, so the redesigned controls do not need a second hydration channel and failure states continue to flow through the same panel-level error handling.

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** this file owns the setup-panel state types, setup-panel hydration, and the current `handleSetupClickUp`, `handleSetupLinear`, `handleSetupNotion`, and `handleSwitchOperationMode` entry points. It is the central place where the UI's checkbox semantics must be translated into service calls and truthful hydration state.
- **Logic:**
  1. Extend the current setup-state types so the webview can distinguish "resource already provisioned" from "behavior currently enabled."
  2. Replace `handleSetupClickUp`, `handleSetupLinear`, and `handleSetupNotion` with option-aware apply handlers.
  3. Remove `handleSwitchOperationMode` and stop sending `operationModeChanged` from `postSetupPanelState()`.
  4. Preserve the existing separate `designDocSetting` payload and reuse it when hydrating the Notion checkbox summary.
- **Implementation:**
  1. Expand the local setup-state types near the top of the file. The panel needs explicit hydration fields instead of guessing from one boolean:
     ```ts
     type ClickUpSetupState = {
       setupComplete: boolean;
       folderReady: boolean;
       listsReady: boolean;
       customFieldsReady: boolean;
       realTimeSyncEnabled: boolean;
       autoPullEnabled: boolean;
       columns: ClickUpSetupColumnState[];
       availableLists: Array<{ id: string; name: string }>;
       mappedCount: number;
       excludedCount: number;
       unmappedCount: number;
       automationRules: ClickUpAutomationRule[];
       error?: string;
     };
     ```
     ```ts
     type LinearSetupState = {
       setupComplete: boolean;
       mappingsReady: boolean;
       labelReady: boolean;
       projectScoped: boolean;
       realTimeSyncEnabled: boolean;
       autoPullEnabled: boolean;
       columns: LinearSetupColumnState[];
       availableLabels: Array<{ id: string; name: string }>;
       availableStates: Array<{ id: string; name: string; type: string }>;
       automationRules: LinearAutomationRule[];
       error?: string;
     };
     ```
  2. Add `NotionSetupState` so the setup panel does not have to infer Notion status from unrelated payloads:
     ```ts
     type NotionSetupState = {
       setupComplete: boolean;
       designDocEnabled: boolean;
       designDocLink: string;
     };
     ```
  3. Replace the old handlers with:
     - `handleApplyClickUpConfig(token: string, options: ClickUpApplyOptions)`
     - `handleApplyLinearConfig(token: string, options: LinearApplyOptions)`
     - `handleApplyNotionConfig(token: string, options: { enableDesignDocFetching: boolean })`
  4. `getIntegrationSetupStates()` must derive checkbox hydration from existing persisted state instead of hard-coded defaults:
     - ClickUp:
       - `folderReady` from `folderId`
       - `listsReady` from non-empty `columnMappings`
       - `customFieldsReady` from `customFields.sessionId`, `planId`, and `syncTimestamp`
       - `realTimeSyncEnabled` from the new config flag
       - `autoPullEnabled` from the existing config flag
     - Linear:
       - `mappingsReady` from non-empty `columnToStateId`
       - `labelReady` from `switchboardLabelId`
       - `projectScoped` from `projectId`
       - `realTimeSyncEnabled` from the new config flag
       - `autoPullEnabled` from the existing config flag
     - Notion:
       - `setupComplete` from `notionConfig?.setupComplete`
       - `designDocEnabled` and `designDocLink` from `handleGetDesignDocSetting()`
  5. `postSetupPanelState()` should keep sending `integrationSetupStates` and `designDocSetting`, but it must stop emitting the legacy `operationModeChanged` payload after integration state loads.
  6. Keep the existing command-friendly setup helpers as thin compatibility wrappers if needed, but route the setup-panel flow through the new apply handlers so the checkbox semantics are centralized in one place.
- **Edge Cases Handled:** the Notion token rollback behavior remains intact on validation failure, the setup panel can rehydrate legacy workspaces truthfully even before migration writes back the new flags, and stale operation-mode UI cannot drift because the setup-panel broadcaster stops sending a mode payload entirely.

#### [MODIFY] `src/test/setup-panel-migration.test.js`
- **Context:** this regression file currently enforces the old setup-panel message names and still expects button-driven setup actions.
- **Logic:**
  1. Keep the test focused on setup-panel ownership of the integration UI.
  2. Update its assertions so it expects checkbox ids and apply messages instead of legacy setup-button messages.
  3. Explicitly assert that the standalone operation-mode subsection is gone.
- **Implementation:**
  1. Replace string assertions for:
     - `"type: 'setupClickUp'"`
     - `"type: 'setupLinear'"`
     - `"type: 'setupNotion'"`
  2. With assertions for:
     - `"type: 'applyClickUpConfig'"`
     - `"type: 'applyLinearConfig'"`
     - `"type: 'applyNotionConfig'"`
  3. Add HTML assertions for the new checkbox ids and apply buttons.
  4. Add a negative assertion that `setup.html` no longer contains the old `OPERATION MODE` setup subsection or `btn-setup-coding-mode` / `btn-setup-board-mgmt-mode`.
- **Edge Cases Handled:** keeping this regex test aligned with the new message names prevents the setup panel from accidentally regressing back to token-only setup calls after the refactor.

### High Complexity / State, Config, and Scheduler Refactor
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** the current ClickUp service persists folder, list, custom-field, auto-pull, and automation state, but it has no explicit per-integration real-time sync flag and its `setup()` method always executes the legacy all-in-one provisioning flow.
- **Logic:**
  1. Add a persisted `realTimeSyncEnabled` flag so ongoing ClickUp push behavior can be enabled or disabled independently of auto-pull.
  2. Split one-time provisioning actions (folder, lists, custom fields) from ongoing behavior flags (real-time sync, auto-pull).
  3. Keep the legacy `setup()` entry point as a compatibility wrapper, but move the real work into an option-aware apply method that can safely re-run.
  4. Preserve cleanup guarantees for newly created resources if a later provisioning step fails.
- **Implementation:**
  1. Extend `ClickUpConfig` with:
     ```ts
     realTimeSyncEnabled: boolean;
     ```
  2. Update `_normalizeConfig(...)` so legacy workspaces default to their current behavior:
     - `realTimeSyncEnabled: raw.realTimeSyncEnabled ?? (raw.setupComplete === true)`
     - keep existing normalization for `autoPullEnabled`, `pullIntervalMinutes`, and `automationRules`
  3. Add an option payload type:
     ```ts
     export interface ClickUpApplyOptions {
       createFolder: boolean;
       createLists: boolean;
       createCustomFields: boolean;
       enableRealtimeSync: boolean;
       enableAutoPull: boolean;
       columns?: string[];
     }
     ```
  4. Extract the current `setup()` internals into idempotent helpers such as:
     - `ensureWorkspaceAndSpace(...)`
     - `ensureFolder(...)`
     - `ensureColumnMappings(...)`
     - `ensureCustomFields(...)`
  5. Add `applyConfig(options: ClickUpApplyOptions)` that:
     - stores or validates the token exactly as today
     - loads existing config first
     - runs only the provisioning helpers selected by the checkbox payload
     - validates dependency rules before writing behavior flags:
       - `createCustomFields` requires at least one mapped list, either existing or created in this apply
       - `enableRealtimeSync` requires an existing folder plus at least one mapped list
       - `enableAutoPull` requires at least one mapped list
       - if `createFolder` is false and there is no saved `folderId` and no reusable existing "AI Agents" folder, return an explicit error instead of silently creating one
     - persists `realTimeSyncEnabled` and `autoPullEnabled`
  6. Keep `setup(options?: ClickUpSetupOptions)` as the legacy wrapper used by old command paths, internally translating to the new apply method with a legacy preset instead of duplicating the whole provisioning flow.
- **Edge Cases Handled:** legacy workspaces keep current push behavior after migration, partial reprovisioning can reuse existing folder/list state instead of duplicating resources, and failed custom-field creation stays non-fatal exactly as it is today while still allowing the apply flow to persist the selected behavior flags safely.

#### [MODIFY] `src/services/LinearSyncService.ts`
- **Context:** the Linear service already persists team, project scope, mappings, label id, auto-pull, and automation rules, but it also lacks a per-integration real-time sync flag and still exposes a fixed-order `setup()` wizard.
- **Logic:**
  1. Add a persisted `realTimeSyncEnabled` flag so Linear push behavior is not inferred indirectly from global mode.
  2. Convert the fixed-order wizard into an option-aware apply flow that prompts only for the selections the user actually chose.
  3. Preserve `setup()` as a compatibility wrapper for existing command entry points.
  4. Make the "scope to project" checkbox authoritative for whether `projectId` remains populated.
- **Implementation:**
  1. Extend `LinearConfig` with:
     ```ts
     realTimeSyncEnabled: boolean;
     ```
  2. Update `_normalizeConfig(...)` so legacy configured workspaces default to `realTimeSyncEnabled: true` when the new flag is absent and `setupComplete === true`.
  3. Add:
     ```ts
     export interface LinearApplyOptions {
       mapColumns: boolean;
       createLabel: boolean;
       scopeProject: boolean;
       enableRealtimeSync: boolean;
       enableAutoPull: boolean;
     }
     ```
  4. Refactor the existing wizard into reusable steps:
     - `selectTeam(...)`
     - `selectProjectScope(...)`
     - `mapColumnsToStates(...)`
     - `ensureSwitchboardLabel(...)`
  5. Add `applyConfig(options: LinearApplyOptions)` that:
     - validates the token using the current `isAvailable()` flow
     - reuses saved `teamId` / `teamName` unless the user must re-prompt for a selected action
     - runs the column-mapping prompt only when `mapColumns` is checked
     - runs label creation only when `createLabel` is checked
     - prompts for project scope only when `scopeProject` is checked, and clears `projectId` when it is unchecked so stale scoping does not linger silently
     - persists `realTimeSyncEnabled` and `autoPullEnabled`
  6. Keep `setup()` as the legacy wrapper used by old command paths, translating to a legacy option preset rather than preserving a second full wizard implementation.
- **Edge Cases Handled:** old configured workspaces retain their current sync behavior after migration, reapplying without `scopeProject` cannot leave an old project filter hidden in config, and unchecked mapping or label options preserve existing state instead of wiping it unless the user explicitly changed that surface.

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** this provider still owns `_operationMode`, global mode broadcasts, mode-based gating for automation and live sync, the ClickUp plan-content watcher sync path, and the card-move sync hooks. This is the highest-risk file in the plan.
- **Logic:**
  1. Remove the global operation-mode state and replace every mode-based decision with per-integration config checks.
  2. Gate each integration's push behavior on its own `realTimeSyncEnabled` flag.
  3. Gate each integration's pull/automation behavior on its own `autoPullEnabled` flag plus any existing prerequisites such as enabled automation rules.
  4. Keep `initializeIntegrationAutoPull()` as the central scheduler bootstrap, but stop treating auto-pull and automation as a global mode.
  5. Continue broadcasting ClickUp and Linear state to the Kanban webview, but include the new `realTimeSyncEnabled` flag in those payloads.
- **Implementation:**
  1. Remove or replace:
     - `private _operationMode`
     - `getOperationMode()`
     - `_getOperationModeNeedsSetup(...)`
     - `setOperationMode(...)`
     - the `switchOperationMode` message case
     - the `operationModeChanged` broadcast in `_refreshBoardWithData()`
  2. Update `_buildClickUpState(...)` and `_buildLinearState(...)` to include:
     - `realTimeSyncEnabled`
     - existing `autoPullEnabled`
     - existing interval values
  3. Update `_queueClickUpSync(...)` and `_queueLinearSync(...)` so they load config and return early unless:
     - `config?.setupComplete === true`
     - `config.realTimeSyncEnabled === true`
     - the existing sync prerequisites for the specific integration still hold
  4. Update `_setupPlanContentWatcher()` so the direct ClickUp `debouncedSync(...)` path only runs when ClickUp `realTimeSyncEnabled` is true; otherwise it should skip ClickUp push while still emitting the file-change event for other subscribers.
  5. Update `_configureClickUpAutomation(...)` and `_configureLinearAutomation(...)` so they no longer read `_operationMode`. They should schedule polling only when:
     - the integration is configured
     - `autoPullEnabled === true`
     - there is at least one enabled automation rule
  6. Update `applyLiveSyncConfig(...)` so it no longer requires "coding mode". Instead:
     - read the existing global live-sync config from `.switchboard/state.json`
     - determine whether at least one configured integration has `realTimeSyncEnabled === true`
     - start `ContinuousSyncService` only when both the global live-sync toggle and at least one per-integration real-time sync flag are enabled
     - otherwise stop the service cleanly
  7. Keep `initializeIntegrationAutoPull()` configuring all four schedulers (`clickup`, `clickup-automation`, `linear`, `linear-automation`), but let the new per-integration config flags decide whether each scheduler actually runs.
  8. Update any `saveIntegrationAutoPullSettings` or setup-result paths so they re-run the same scheduler reconfiguration after config writes.
- **Edge Cases Handled:** removing the global mode from this file prevents the Kanban board and setup panel from drifting apart, per-integration sync disablement suppresses all existing write paths instead of only some of them, and timer reconfiguration still flows through the current scheduler that already knows how to handle in-flight jobs safely.

#### [MODIFY] `src/services/ContinuousSyncService.ts`
- **Context:** this service still assumes it starts and stops based on Board Management Mode and it always attempts to sync both ClickUp and Linear when a plan has linked external ids.
- **Logic:**
  1. Remove outdated mode-based comments and notification text.
  2. Gate ClickUp and Linear content-sync writes on each integration's own `realTimeSyncEnabled` flag.
  3. Allow the service to run when only one integration is enabled for real-time sync.
- **Implementation:**
  1. Update the class comments and notification text so they reference "enabled integrations" instead of Board Management Mode.
  2. In `_syncToClickUp(...)`, load ClickUp config and return early unless:
     - `config?.setupComplete === true`
     - `config.realTimeSyncEnabled === true`
     - the plan has a linked `clickupTaskId`
  3. In `_syncToLinear(...)`, load Linear config and return early unless:
     - `config?.setupComplete === true`
     - `config.realTimeSyncEnabled === true`
     - the plan has a linked `linearIssueId`
  4. Update any service-start notification so it no longer promises that both integrations will always sync; it should describe syncing to whichever integrations are currently enabled.
- **Edge Cases Handled:** one disabled integration no longer causes noisy failed sync attempts for every edited plan, and the global live-sync service can continue working for the other integration without a fake dependency on the removed global mode.

#### [MODIFY] `src/webview/kanban.html`
- **Context:** the Kanban header still renders `#mode-toggle-btn`, tracks `currentOperationMode` / `currentOperationNeedsSetup`, and expects `operationModeChanged` messages from the extension host.
- **Logic:**
  1. Remove the global mode state machine from the Kanban webview.
  2. Keep the header control discoverable by repurposing it into a setup shortcut that opens the project-management accordion in the setup panel.
  3. Update any integration-status copy that still references Board Management Mode so it reflects per-integration real-time sync and auto-pull instead.
- **Implementation:**
  1. Replace the old mode-button semantics:
     - remove `currentOperationMode`
     - remove `currentOperationNeedsSetup`
     - remove `updateModeToggleButtonState()`
     - remove the `case 'operationModeChanged'` handler
     - remove the `postKanbanMessage({ type: 'switchOperationMode', ... })` click path
  2. Keep the button slot, but repurpose `#mode-toggle-btn` into a neutral setup shortcut:
     - button label should be static, not mode-driven
     - click handler should only send `postKanbanMessage({ type: 'openSetupPanel', section: 'project-mgmt' })`
  3. Remove or simplify the old `.mode-toggle-btn.coding-mode`, `.mode-toggle-btn.board-management-mode`, and `.mode-toggle-btn.needs-setup` CSS branches so styling matches the new single-purpose shortcut.
  4. Update any integration settings modal copy and tooltips that still speak in terms of Coding Mode vs Board Management Mode to refer to:
     - per-integration real-time sync
     - per-integration auto-pull
     - setup-panel configuration
- **Edge Cases Handled:** the Kanban board no longer listens for a message type that the host stopped broadcasting, and the header control remains useful instead of silently disappearing or misrepresenting removed runtime state.

#### [MODIFY] `src/test/operation-mode-toggle-regression.test.js`
- **Context:** this test is currently hard-coded to the legacy operation-mode architecture across `TaskViewerProvider.ts`, `KanbanProvider.ts`, `setup.html`, and `kanban.html`.
- **Logic:**
  1. Replace the old assertions with regression coverage for the new architecture instead of deleting the test outright.
  2. Assert that the old global mode payloads and setup-panel mode updater are gone.
  3. Assert that the Kanban header control is now a setup shortcut and that setup-panel checkbox state is hydrated from integration state plus the existing design-doc setting.
- **Implementation:**
  1. Remove regex expectations for:
     - `operationModeChanged`
     - `updateOperationModeUi(...)`
     - `setOperationMode(...)`
     - `switchOperationMode`
  2. Replace them with expectations that:
     - `setup.html` no longer contains the standalone mode subsection
     - `kanban.html` no longer posts `switchOperationMode`
     - `kanban.html` still posts `openSetupPanel` for the header shortcut
     - `TaskViewerProvider.postSetupPanelState()` no longer emits `operationModeChanged`
     - `getIntegrationSetupStates()` returns per-integration enablement fields
  3. Keep the file name if that minimizes churn, but rewrite the assertions to protect the new checkbox architecture instead of the retired mode architecture.
- **Edge Cases Handled:** this prevents future regressions from quietly reintroducing the removed global mode plumbing while still preserving a focused regression file for the surfaces that changed most.

#### [MODIFY] `src/test/integration-auto-pull-regression.test.js`
- **Context:** this regression currently asserts the global auto-pull and automation scheduling architecture, but it does not know about per-integration real-time sync.
- **Logic:**
  1. Keep the scheduler assertions, because `KanbanProvider` still owns timer initialization.
  2. Update the test so it expects per-integration config flags rather than a global mode guard.
  3. Add assertions that the Kanban payloads include the new `realTimeSyncEnabled` field.
- **Implementation:**
  1. Update provider regexes so they expect:
     - `realTimeSyncEnabled` in `ClickUpConfig` and `LinearConfig` usage
     - `realTimeSyncEnabled` in `_buildClickUpState(...)` and `_buildLinearState(...)`
     - `_configureClickUpAutomation(...)` / `_configureLinearAutomation(...)` to key off integration config instead of `_operationMode`
     - `applyLiveSyncConfig(...)` to gate on the global live-sync config plus per-integration real-time sync enablement instead of `this._operationMode === 'coding'`
  2. Remove assertions that require `operationModeChanged` or `switchOperationMode`.
  3. Keep the existing expectations around `initializeIntegrationAutoPull()` configuring all scheduler categories, because that orchestration still belongs here even after the gating changes.
- **Edge Cases Handled:** the scheduler stays covered while the plan removes global mode, so future refactors cannot accidentally preserve the old mode guard or drop the new per-integration gating.

#### [MODIFY] `src/test/integrations/clickup/clickup-sync-service.test.js`
- **Context:** this file already tests ClickUp config normalization and setup flow, so it is the right place to cover the option-aware apply refactor.
- **Logic:**
  1. Extend the current config normalization assertions to include `realTimeSyncEnabled`.
  2. Add focused tests for option-aware apply behavior and dependency validation.
  3. Keep legacy `setup()` coverage by asserting that the compatibility wrapper still delegates to the option-aware flow.
- **Implementation:**
  1. Add normalization coverage for:
     - legacy config without `realTimeSyncEnabled`
     - configured legacy workspaces defaulting to `realTimeSyncEnabled === true`
  2. Add apply-flow tests covering:
     - provisioning only the folder
     - enabling real-time sync with existing mappings
     - rejecting `enableRealtimeSync` when no folder or mappings exist
     - rejecting `createCustomFields` when no mapped list exists
     - preserving existing folder/list ids on re-apply
  3. Keep the current `setup({ columns })` test, but assert that it lands on the same final config shape as the new option-aware path.
- **Edge Cases Handled:** the risky ClickUp apply refactor gets direct service coverage, not just regex-based architectural coverage.

#### [MODIFY] `src/test/integrations/linear/linear-sync-service.test.js`
- **Context:** this file already covers Linear config normalization and setup behavior, so it is the correct place to verify option-aware setup and the new real-time sync flag.
- **Logic:**
  1. Extend normalization assertions to include `realTimeSyncEnabled`.
  2. Add focused apply-flow coverage for mapping, label creation, project scope, and behavior-flag persistence.
  3. Verify that unchecked project scope clears stale `projectId` instead of silently preserving it.
- **Implementation:**
  1. Add normalization coverage for:
     - legacy config without `realTimeSyncEnabled`
     - configured legacy workspaces defaulting to `realTimeSyncEnabled === true`
  2. Add apply-flow tests covering:
     - mapping columns only
     - label creation only
     - enabling real-time sync with existing mappings
     - enabling auto-pull without touching mappings
     - clearing project scope when the checkbox is unchecked
  3. Keep one compatibility-wrapper test so `setup()` still behaves like the legacy command entry point even after the internal refactor.
- **Edge Cases Handled:** the Linear refactor is protected against stale project scope, accidental mapping wipes, and legacy-workspace drift.

## Verification Plan
### Automated Tests
- `npm run compile`
- `npm run compile-tests`
- `node src/test/setup-panel-migration.test.js`
- `node src/test/operation-mode-toggle-regression.test.js`
- `node src/test/integration-auto-pull-regression.test.js`
- `node src/test/integrations/clickup/clickup-sync-service.test.js`
- `node src/test/integrations/linear/linear-sync-service.test.js`

### Manual Checks
- Fresh workspace, ClickUp: select only folder + lists + real-time sync, confirm the apply flow provisions only the requested resources, the panel rehydrates truthful summaries, and ClickUp mappings remain editable below the new checkbox group.
- Fresh or existing workspace, Linear: reapply with `scopeProject` unchecked after a previously scoped setup and confirm `projectId` is cleared while mappings and rules remain intact.
- Existing configured workspace: open the setup panel and verify legacy configs hydrate as already enabled for real-time sync instead of showing misleading empty checkboxes.
- Notion: save a valid token with the checkbox enabled and confirm the setup panel still reflects the existing planner design-doc toggle rather than a second conflicting state flag.
- Kanban board: click the repurposed header control and confirm it opens the project-management accordion instead of sending a removed `switchOperationMode` message.

## Preserved Original Draft
> [!NOTE]
> The sections below are preserved verbatim per request. Use the plan above as the authoritative spec when there is conflict.

## Problem Statement

The current ClickUp and Linear integration setup flows are opaque and opinionated:

**ClickUp Setup Issues:**
- Single "SETUP CLICKUP" button that performs multiple actions implicitly
- Assumes user wants Coding Mode (real-time sync)
- Always creates "AI Agents" folder
- Always creates lists for all kanban columns
- Always creates custom fields
- No way to opt out of specific features
- Users don't understand what will happen before clicking

**Linear Setup Issues:**
- Similar single-button approach (though slightly more flexible with column mapping)
- Assumes certain behaviors
- Less transparent about what features are being enabled

**Operation Mode Panel Issues:**
- Separate panel for a runtime toggle that should be part of setup
- Takes up significant space for what could be a simple selection
- Confusing placement in setup panel when it's a runtime configuration

## Proposed Solution

Replace the current setup buttons with checkbox-based option lists under each integration heading. This makes the setup transparent and gives users granular control.

### ClickUp Integration Checkboxes

```
ClickUp
[Not configured]

API Token
[Enter ClickUp API token]

Setup Options
[ ] Create "AI Agents" folder in selected space
[ ] Create lists for each kanban column
[ ] Create custom fields (sessionId, planId, syncTimestamp)
[ ] Enable real-time sync (Coding Mode) - syncs column moves to ClickUp
[ ] Enable auto-pull from ClickUp (Board Management Mode) - auto-creates plans from tasks
```

### Linear Integration Checkboxes

```
Linear
[Not configured]

API Token
[Enter Linear API token]

Setup Options
[ ] Map columns to Linear states
[ ] Create "switchboard" label
[ ] Scope to specific project (optional)
[ ] Enable real-time sync (Coding Mode) - syncs column moves to Linear
[ ] Enable auto-pull from Linear (Board Management Mode) - auto-creates plans from issues
```

### Notion Integration (Simplify)

Notion is simpler (just token), but could benefit from similar transparency:

```
Notion
[Not configured]

Integration Token
[Enter Notion integration token]

Setup Options
[ ] Enable design document fetching for planner prompts
```

## Implementation Plan

### Phase 1: HTML Structure Changes

1. **Remove Operation Mode Panel**
   - Delete the separate "OPERATION MODE" subsection
   - Move mode selection into individual integration checkbox lists

2. **Redesign ClickUp Section**
   - Replace "SETUP CLICKUP" button with checkbox list
   - Add descriptive text for each checkbox explaining what it does
   - Keep API token input field
   - Add "Apply" button that runs selected options

3. **Redesign Linear Section**
   - Replace setup flow with checkbox list
   - Keep team/project selection prompts (these are necessary)
   - Add mode checkboxes (real-time sync vs auto-pull)
   - Add "Apply" button

4. **Redesign Notion Section**
   - Add simple checkbox for enabling feature
   - Keep token input

### Phase 2: JavaScript Changes

1. **Update Message Types**
   - Change from `setupClickUp` to `applyClickUpConfig` with options object
   - Change from `setupLinear` to `applyLinearConfig` with options object
   - Change from `setupNotion` to `applyNotionConfig` with options object

2. **Update UI State Management**
   - Track which checkboxes are checked
   - Update descriptions dynamically based on selections
   - Show/hide additional options based on selections (e.g., project scope only if checkbox checked)

3. **Remove Operation Mode UI Code**
   - Remove `updateOperationModeUi` function
   - Remove mode button event listeners
   - Remove mode-related CSS classes if any

### Phase 3: Backend Changes

1. **ClickUp Service Refactor**
   - Split `setup()` method into granular functions:
     - `createFolder()`
     - `createLists()`
     - `createCustomFields()`
   - Update `applyConfig()` to call only selected functions
   - Add mode-specific logic (real-time sync vs auto-pull)

2. **Linear Service Refactor**
   - Keep column mapping (this is core functionality)
   - Make label creation optional
   - Make project scoping optional
   - Add mode-specific logic

3. **TaskViewerProvider Updates**
   - Update `handleApplyClickUpConfig` to accept options object
   - Update `handleApplyLinearConfig` to accept options object
   - Update `handleApplyNotionConfig` to accept options object
   - Remove `handleSwitchOperationMode` (mode now part of integration config)

4. **KanbanProvider Updates**
   - Remove standalone `setOperationMode` method
   - Read mode from integration configs instead
   - Update automation start/stop logic to check individual integration configs

### Phase 4: Validation & Edge Cases

1. **Validation**
   - Ensure at least one option is selected before allowing apply
   - Validate dependencies (e.g., can't enable sync without folder/lists)
   - Show clear error messages for invalid configurations

2. **Backwards Compatibility**
   - Migration path for existing configs:
     - If existing config has `setupComplete: true`, assume all options were enabled
     - Offer to reconfigure with new options on first load
   - Preserve existing token storage

3. **UI Polish**
   - Add tooltips or help text for complex options
   - Show summary of what will happen before applying
   - Add loading states during configuration

## Benefits

1. **Transparency**: Users see exactly what will happen before applying
2. **Flexibility**: Users can opt out of features they don't need
3. **Education**: Checkbox descriptions teach users what each feature does
4. **Simpler UI**: Removes confusing separate Operation Mode panel
5. **Better UX**: Granular control instead of all-or-nothing setup

## Open Questions

1. Should we allow reconfiguration after initial setup, or require manual config editing?
2. Should mode selection be per-integration or global?
   - Current design: per-integration (checkbox under each)
   - Alternative: global mode that applies to all configured integrations
3. Should we add a "Recommended defaults" preset that checks common options?

## Files to Modify

- `src/webview/setup.html` - UI structure
- `src/services/SetupPanelProvider.ts` - Message handling
- `src/services/TaskViewerProvider.ts` - Config application
- `src/services/KanbanProvider.ts` - Mode/automation logic
- `src/services/ClickUpSyncService.ts` - Granular setup functions
- `src/services/LinearSyncService.ts` - Granular setup functions

## Direct Reviewer Pass — 2026-04-13

### Reviewer scope note

- During review, the user explicitly clarified that the removed `switchboard.setupClickUp` / `switchboard.setupLinear` legacy setup path is intentionally unsupported and should stay removed. This reviewer pass treated the Setup panel as the sole supported setup entry point and did **not** count legacy-command removal as a defect.

### Findings addressed

- **MAJOR — Realtime-sync checkbox state did not reconfigure live sync at runtime.** `handleApplyClickUpConfig(...)` and `handleApplyLinearConfig(...)` reconfigured auto-pull timers, but they did not rerun `KanbanProvider.applyLiveSyncConfig(...)`. That left `ContinuousSyncService` stale after an apply: enabling realtime sync in Setup would not start live sync immediately, and disabling it would not stop live sync immediately.
- **MAJOR — ClickUp hydration misrepresented untouched columns as intentionally excluded.** `ClickUpSyncService._normalizeConfig(...)` populated empty legacy/new `columnMappings` with every canonical column set to `''`. The mapping editor interprets explicit empty strings as **excluded**, not **unmapped**, so folder-only setups and legacy configs with no mappings rendered false exclusions and broke the `CREATE LISTS FOR UNMAPPED` helper.

### Fixed items

- Updated `src/services/TaskViewerProvider.ts` so successful ClickUp and Linear apply flows now rerun both:
  - `initializeIntegrationAutoPull()`
  - `applyLiveSyncConfig(resolvedRoot)`
- Updated `src/services/ClickUpSyncService.ts` so empty `columnMappings` normalize to `{}` instead of synthetic blank mappings for every canonical column. This preserves the crucial distinction between:
  - **unmapped** (no explicit user decision yet)
  - **excluded** (explicitly opted out)
- Updated regression coverage so the reviewer fixes are protected:
  - `src/test/integration-auto-pull-regression.test.js`
  - `src/test/integrations/clickup/clickup-sync-service.test.js`

### Files changed in reviewer pass

- `src/services/ClickUpSyncService.ts`
- `src/services/TaskViewerProvider.ts`
- `src/test/integration-auto-pull-regression.test.js`
- `src/test/integrations/clickup/clickup-sync-service.test.js`
- `.switchboard/plans/redesign_integration_setup_as_checkbox_options.md`

### Validation results

- `npm run compile` — success.
- `npm run compile-tests` — success.
- `node src/test/setup-panel-migration.test.js` — success.
- `node src/test/operation-mode-toggle-regression.test.js` — success.
- `node src/test/integration-auto-pull-regression.test.js` — success.
- `node src/test/integrations/clickup/clickup-sync-service.test.js` — success.
- `node src/test/integrations/linear/linear-sync-service.test.js` — success.

### Remaining risks

- **NIT / deferred UX polish:** the setup-panel apply buttons still rely on backend validation when no options are selected instead of proactively disabling the button in the webview. That is noisy UX, but it is not a correctness defect after the reviewer-pass fixes.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-13T22:59:33.954Z
**Format Version:** 1
