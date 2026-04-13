# Extend Event Monitoring and Ticket Write-Back to Linear

## Goal

The current event monitoring and ticket write-back functionality is hardcoded for ClickUp only. The `ClickUpAutomationService` provides:
1. **Event monitoring**: Polls ClickUp lists for tasks matching automation rules (by tags)
2. **Auto-plan creation**: Creates Switchboard plans from matching ClickUp tasks
3. **Write-back**: When plans complete (reach final column), writes results back to ClickUp

This functionality should be provider-agnostic and also work with Linear issues.

## Metadata
**Tags:** backend, database, UI
**Complexity:** 7

## User Review Required
> [!NOTE]
> - This plan stays within the original scope: extend the already-shipped Linear integration so it can poll for matching issues, create normal Switchboard plans, and write results back when those plans finish. Do **not** turn this into a new provider-abstraction project, a new command surface, or a reverse-sync feature.
> - **Clarification:** Preserve the original draft identifiers outside the metadata block: `Session ID: sess_1744503000000` and `Plan ID: extend_automation_to_linear`.
> - **Clarification:** The verified implementation path for Phase 4 is the central setup panel stack (`src/services/SetupPanelProvider.ts` → `src/services/TaskViewerProvider.ts` → `src/webview/setup.html`). The repo does **not** currently have any Linear automation save/render flow there.
> - **Clarification:** The repo already ships `LinearSyncService.setup()`, `LinearSyncService.importIssuesFromLinear()`, `KanbanProvider._getLinearService()`, and `KanbanProvider._configureLinearAutoPull()`. This plan must extend those concrete paths rather than replacing them.
> - **Clarification:** The draft's ownership-label answer (`switchboard:` prefix) conflicts with the currently shipped plain `switchboard` label created in `src/services/LinearSyncService.ts`. Implementation must handle that compatibility deliberately instead of assuming only one label shape exists.

## Complexity Audit
### Routine
- Add `LinearAutomationRule` normalization and matching helpers beside the existing ClickUp rule helpers in `src/models/PipelineDefinition.ts`.
- Extend `LinearConfig` normalization in `src/services/LinearSyncService.ts` so legacy configs default `automationRules` to `[]`, and add `saveAutomationSettings()` instead of inventing a second Linear config file.
- Add central setup-panel plumbing (`src/services/SetupPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/setup.html`) so Linear automation rules can actually be viewed and saved.
- Extend the existing Linear and shared integration test runners so the new automation code path is executed by CI-visible test commands.

### Complex / Risky
- Create `src/services/LinearAutomationService.ts` with polling, plan generation, dedupe, and write-back logic that mirrors `src/services/ClickUpAutomationService.ts` without regressing the existing Linear setup, sync-on-move, or import flows.
- Add `linear_issue_id` persistence and `'linear-automation'` source typing in `src/services/KanbanDatabase.ts` and `src/services/PlanFileImporter.ts` while staying compatible with the active ClickUp automation debt cleanup work.
- Schedule a distinct `'linear-automation'` runner in `src/services/IntegrationAutoPullService.ts` / `src/services/KanbanProvider.ts` so Linear import polling and Linear automation polling do not trample each other's `inFlight` state.
- Reconcile the draft's requested `switchboard:` ownership-label semantics with the plain `switchboard` label already produced by `LinearSyncService._createIssue()`.

## Edge-Case & Dependency Audit
- **Race Conditions:** `src/services/IntegrationAutoPullService.ts` keys timers by `workspaceRoot::integration` and prevents overlap with `inFlight`, so Linear automation must use its own `'linear-automation'` key instead of piggybacking on the existing `'linear'` import timer. `LinearAutomationService.poll()` must dedupe in three places: ownership-label detection, `KanbanDatabase.findPlanByLinearIssueId()`, and a stable file-path + `flag: 'wx'` write when creating the automation plan file.
- **Security:** Reuse `LinearSyncService.getApiToken()` and `LinearSyncService.graphqlRequest()`; do not add a second secret-storage key or log GraphQL requests that could expose Authorization headers. Write-back mutations must reject blank issue IDs and blank summaries before mutating Linear, and description write-back must preserve the existing issue description instead of replacing it blindly.
- **Side Effects:** Existing `.switchboard/linear-config.json` files currently omit `automationRules`, existing `plans` rows omit `linear_issue_id`, and the current setup panel only knows how to save ClickUp automation rules. The implementation must normalize old configs to `automationRules: []`, add DB storage via a forward-only migration, and keep current ClickUp setup behavior untouched.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active **New** plans: none. Active **Planned** plans and related `.switchboard/plans` files show:
  - `remove_clickup_automation_debt.md` is a real merge hotspot across `src/services/KanbanDatabase.ts`, `src/services/ClickUpAutomationService.ts`, `src/services/KanbanProvider.ts`, and ClickUp automation tests. This Linear plan must not revive the legacy `pipeline_id` / `is_internal` mechanics that debt-removal work is trying to delete.
  - `fix_custom_lane_import_roundtrip.md` is an indirect dependency for Phase 4 because both plans rely on kanban column IDs flowing through `TaskViewerProvider.handleGetKanbanStructure()` and setup-panel selectors. It is not blocking, but concurrent changes to custom-lane serialization require a merge review in `TaskViewerProvider.ts` and `setup.html`.
  - `fix_duplicate_switchboard_state_parsing_bug.md` is not a direct conflict; this plan should keep emitting one authoritative `## Switchboard State` footer and avoid spreading into `planStateUtils.ts` unless a verified parser gap is discovered during implementation.
  - Historical `linear_1_foundation.md`, `linear_2_setup_flow.md`, `linear_3_sync_on_move.md`, and `linear_import_pull_issues.md` are real prerequisites already embodied in the repo. Verified current code paths are `src/services/LinearSyncService.ts`, `src/services/KanbanProvider.ts::_getLinearService()`, `::_configureLinearAutoPull()`, and `LinearSyncService.importIssuesFromLinear()`. Extend those files; do not create parallel Linear clients or duplicate config formats.
  - Historical Linear setup/sync work created and applies a plain `switchboard` label, while this draft answered the ownership-label question with `switchboard:`. Compatibility logic must accept already-synced `switchboard`-labeled issues during rollout or upgrade the label strategy in one coordinated pass.

## Adversarial Synthesis
### Grumpy Critique
This draft was one lazy “just mirror `ClickUpAutomationService`” away from creating a ghost feature. Linear already has a real service stack, a real setup flow, a real import path, and a real setup-panel UI chain — and none of those paths know anything about automation rules today. If someone follows the original bullets literally without touching `TaskViewerProvider.ts`, `SetupPanelProvider.ts`, `setup.html`, `PlanFileImporter.ts`, and the auto-pull integration key, they will ship a shiny new `LinearAutomationService` that cannot be configured, cannot persist `linear_issue_id`, and cannot survive plan import. That is not provider parity; that is demo-ware with a TypeScript file attached.

And the risky parts were hand-waved exactly where the repo is already sharp-edged. `KanbanDatabase.ts` has already spent V10 on a different migration, `remove_clickup_automation_debt.md` is actively trying to change the same schema surface, and the current code creates a plain `switchboard` label while the draft blithely says “`switchboard:` prefix, yes” as if historical data will migrate itself out of embarrassment. No. Be explicit: use the existing Linear GraphQL client, add a distinct `linear-automation` timer, wire the importer/schema/setup-panel changes on purpose, and bridge the label mismatch deliberately instead of hoping concurrent plans and old workspaces magically agree.

### Balanced Response
The corrected plan closes those gaps by anchoring every change to the verified code paths that already exist. `LinearSyncService` remains the owner of GraphQL, token storage, and config normalization; `LinearAutomationService` is additive and mirrors ClickUp automation only where that behavior already exists; `PlanFileImporter` and `KanbanDatabase` gain the exact `linear_issue_id` / `'linear-automation'` persistence needed for dedupe and write-back; and the central setup panel gets the missing save/render plumbing for Linear automation rules. No new command surface, no speculative provider framework, and no reverse-sync scope is introduced.

It also turns the dangerous assumptions into explicit compatibility work. The scheduler gets its own `'linear-automation'` key so import polling and automation polling do not overlap, migration numbering is called out as “next free block” instead of reusing V10, and ownership detection deliberately accepts the currently shipped `switchboard` label while the draft’s `switchboard:` convention is rolled in. With those corrections plus targeted regression coverage, the work stays inside the original requirement set but becomes specific enough to implement without guesswork.

## Agent Recommendation

Send to Lead Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep this as a Linear automation parity pass built on the current repository shape. Every file listed below is tied to a verified code path that already exists in the repo today. Do not invent a second Linear client, a new config file, or a brand-new provider framework.

### Clarification - preserved context from the original draft
#### Problem Statement

ClickUp has a full automation pipeline (`ClickUpAutomationService.ts`) that:
- Polls ClickUp lists for tasks with matching tags
- Creates Switchboard plans from matching tasks
- Writes back automation results to ClickUp when plans complete

Linear only has basic sync (Switchboard → Linear state updates) but lacks the automation layer.

#### Current State
##### ClickUp Implementation
- `src/services/ClickUpAutomationService.ts` - Full automation logic (polling, plan creation, write-back)
- `src/models/PipelineDefinition.ts` - `ClickUpAutomationRule` interface and matching logic
- `src/services/KanbanDatabase.ts` - Stores `clickupTaskId` and `sourceType: 'clickup-automation'`
- `src/services/KanbanProvider.ts` - Wires automation to `IntegrationAutoPullService`

##### Linear Implementation
- `src/services/LinearSyncService.ts` - Basic sync (Switchboard → Linear state updates), import functionality
- **Missing**: Automation service equivalent to `ClickUpAutomationService`
- **Missing**: Write-back functionality
- **Missing**: Automation rules in `LinearConfig`

### Clarification - preserved original phase breakdown
#### Phase 1: Data Model Extensions

1. **Extend `LinearConfig`** (`src/services/LinearSyncService.ts`)
   - Add `automationRules: LinearAutomationRule[]`

2. **Create `LinearAutomationRule`** (`src/models/PipelineDefinition.ts`)
   - `name`, `enabled`, `triggerLabel`, `triggerStates`, `targetColumn`, `finalColumn`, `writeBackOnComplete`

3. **Add normalization/matching functions** (`src/models/PipelineDefinition.ts`)
   - `normalizeLinearAutomationRules()`
   - `matchesLinearAutomationRule()` - checks labels instead of tags

4. **Extend KanbanDatabase** (`src/services/KanbanDatabase.ts`)
   - Migration V10: Add `linear_issue_id` column
   - Add `findPlanByLinearIssueId()` method
   - Extend `sourceType` to include `'linear-automation'`

#### Phase 2: LinearAutomationService

Create `src/services/LinearAutomationService.ts` mirroring `ClickUpAutomationService.ts`:

- `poll(): Promise<LinearAutomationPollResult>`
- `_getWatchedStateIds(config)`
- `_taskHasSwitchboardOwnership(issue)` - check for `switchboard:` label
- `_buildStableAutomationId(issueId)`
- `_buildPlanContent(issue, rule, planId, sessionId)`
- `_buildWriteBackSummary()`
- `_resolveStoredRule()`
- `writeBackAutomationResult()` - uses Linear GraphQL mutations

**Write-back methods:**
- Comment: `commentCreate` mutation
- Description: `issueUpdate` mutation with merge logic

#### Phase 3: Integration Wiring

1. **Extend `AutoPullIntegration`** (`src/services/IntegrationAutoPullService.ts`)
   - Add `'linear-automation'` to the type

2. **Extend `KanbanProvider`** (`src/services/KanbanProvider.ts`)
   - Add `_linearAutomationServices: Map<string, LinearAutomationService>`
   - Add `_getLinearAutomationService()` factory
   - Add `_configureLinearAutomation()` method
   - Update `initializeIntegrationAutoPull()`

#### Phase 4: UI/Configuration

1. **Linear setup panel** - add automation rule configuration UI:
   - Rule name, enabled/disabled
   - Trigger label selector
   - Trigger states selector
   - Target/final column dropdowns
   - Write-back on complete checkbox

2. **LinearSyncService.saveAutomationSettings()** - save automation rules

### Clarification - migration numbering and verified file surface
- **Clarification:** `src/services/KanbanDatabase.ts` already uses V10 for completed-row repair, and the active `remove_clickup_automation_debt.md` plan proposes another follow-on schema cleanup. Implement the `linear_issue_id` change in the **next unused migration block**, not by reusing the literal V10 label from the original draft.
- **Clarification:** The original draft did not name `src/services/PlanFileImporter.ts`, `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, `src/webview/setup.html`, or the test runner files, but those are verified current-code dependencies of the stated requirements. Adding them here is implementation detail implied by the original phases, not new product scope.
- **Clarification:** The safest polling query shape is the one already proven in `LinearSyncService.importIssuesFromLinear()`: team/project pagination through `issues { nodes ... pageInfo { hasNextPage endCursor } }`, with client-side filtering on labels/state. Do not assume a more aggressive server-side GraphQL filter exists without testing it.

### Linear rule model and config normalization
#### [MODIFY] `src/models/PipelineDefinition.ts`
- **Context:** This file currently exports only `ClickUpAutomationRule`, `normalizeClickUpAutomationRules()`, and `matchesClickUpAutomationRule()`. There is no Linear rule shape today.
- **Logic:**
  1. Add `LinearAutomationRule` with `name`, `enabled`, `triggerLabel`, `triggerStates`, `targetColumn`, `finalColumn`, and `writeBackOnComplete`.
  2. Reuse the existing private `_normalizeString()` / `_normalizeStringArray()` helpers so Linear rule normalization follows the same trimming and de-duping semantics as ClickUp.
  3. Implement `normalizeLinearAutomationRules(raw)` so invalid rules are dropped, `enabled` defaults to `true`, and `triggerStates` is de-duped.
  4. Implement `matchesLinearAutomationRule(issue, rule)` against `issue.labels.nodes[].name` and `issue.state.id`.
- **Implementation:**
  - Persist `triggerLabel` as the selected **label name** (human-readable, same spirit as ClickUp `triggerTag`).
  - Persist `triggerStates` as **Linear state IDs** (stable across state renames, same spirit as `LinearConfig.columnToStateId`).
  - Export the new Linear helpers from this file and import them from `LinearSyncService.ts` / `LinearAutomationService.ts`.
- **Edge Cases Handled:** Invalid or partial rules normalize to `[]`; label names are trimmed/lowercased for matching; renamed state names do not break matching because the stored trigger state values are IDs.

#### [MODIFY] `src/services/LinearSyncService.ts`
- **Context:** `LinearConfig` currently stops at `pullIntervalMinutes`; `_normalizeConfig()` knows nothing about automation rules; `setup()` seeds config without `automationRules`; and there is no `saveAutomationSettings()` or helper for the setup panel to fetch labels/states.
- **Logic:**
  1. Import `LinearAutomationRule` / `normalizeLinearAutomationRules` from `src/models/PipelineDefinition.ts`.
  2. Add `automationRules: LinearAutomationRule[]` to `LinearConfig`.
  3. Extend `_normalizeConfig()` so legacy configs load as `automationRules: []`.
  4. Update `setup()` so the saved first-run config includes `automationRules: []`.
  5. Add `saveAutomationSettings(automationRules)` with the same guard pattern as `ClickUpSyncService.saveAutomationSettings()`.
  6. Add a small helper for setup-panel hydration (for example `getAutomationCatalog()` or paired `listAutomationStates()` / `listAutomationLabels()`) that uses the already-public `graphqlRequest()` plus `config.teamId`.
  7. Preserve current `syncPlan()` and `importIssuesFromLinear()` behavior; this plan extends them, it does not replace them.
- **Implementation:**
  - Reuse the existing `team(id: $teamId)` GraphQL pattern already used in `setup()` to fetch `states { nodes { id name type } }` and `labels { nodes { id name } }`.
  - Keep `switchboardLabelId` untouched for sync-on-move issue creation. The new automation rules live beside it in the same config file.
  - Do **not** create a second `.switchboard/*.json` file for Linear automation settings.
- **Edge Cases Handled:** Old configs remain valid, setup-complete is required before saving automation settings, and the setup panel can still render saved rules even if the live label/state fetch fails.

### Clarification - plan import and DB persistence required by the original phases
#### [MODIFY] `src/services/PlanFileImporter.ts`
- **Context:** The importer currently treats any `**Automation Rule:**` metadata as ClickUp automation and only extracts `ClickUp Task ID`. It will not recognize a Linear automation-generated plan file today.
- **Logic:**
  1. Add `extractLinearIssueId(content)` beside `extractClickUpTaskId(content)`.
  2. Change source-type detection to branch on both the presence of `**Automation Rule:**` and the provider-specific ID:
     - `clickup-automation` when a ClickUp task ID is present
     - `linear-automation` when a Linear issue ID is present
     - `local` otherwise
  3. Populate `linearIssueId` on imported records.
  4. Preserve the duplicate-state warning logic already provided by `inspectKanbanState()`.
  5. If `remove_clickup_automation_debt.md` lands first, keep the importer aligned with its reduced record shape and do not reintroduce `pipelineId` / `isInternal` coupling while adding Linear support.
- **Implementation:**
  - Require `LinearAutomationService._buildPlanContent()` to include a stable `> **Linear Issue ID:** {issue.id}` metadata line so importer dedupe has something authoritative to read.
  - Keep `Plan ID` and `Session ID` populated with the stable automation ID so repeated polls resolve to the same file/session identity.
  - Leave ordinary `linear_import_*.md` manual import plans as `sourceType: 'local'`.
- **Edge Cases Handled:** Manual plans that merely mention “Automation Rule” without a provider ID stay local; mixed ClickUp/Linear metadata is treated as invalid and should not silently pick a provider; duplicate state parsing remains deterministic.

#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** The DB schema currently stores `clickup_task_id` only, the `sourceType` union excludes `'linear-automation'`, `PLAN_COLUMNS` / `UPSERT_PLAN_SQL` know nothing about `linear_issue_id`, and `_readRows()` only maps `local`, `brain`, and `clickup-automation`.
- **Logic:**
  1. Extend `KanbanPlanRecord.sourceType` to include `'linear-automation'`.
  2. Add `linearIssueId?: string` to the record shape.
  3. Add `linear_issue_id TEXT DEFAULT ''` to `SCHEMA_SQL`, `PLAN_COLUMNS`, `UPSERT_PLAN_SQL`, `upsertPlans()`, and `_readRows()`.
  4. Add `CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)`.
  5. Add the next available migration block to `ALTER TABLE plans ADD COLUMN linear_issue_id TEXT DEFAULT ''` and create the index for existing DBs.
  6. Add `findPlanByLinearIssueId(workspaceId, linearIssueId)` mirroring `findPlanByClickUpTaskId()`.
  7. Keep the rest of the board queries compatible with any concurrent ClickUp debt-removal changes.
- **Implementation:**
  - Update both the write path (`upsertPlans`) and the read path (`_readRows`) in the same change so automation-created plans round-trip cleanly.
  - Treat blank issue IDs as non-values and return `null` early in `findPlanByLinearIssueId()`.
  - Update any record constructors in tests that need the new `linearIssueId` slot.
- **Edge Cases Handled:** Idempotent migration, safe lookup on blank IDs, and no dependency on the deprecated ClickUp pipeline fields if those disappear concurrently.

### Linear automation service
#### [CREATE] `src/services/LinearAutomationService.ts`
- **Context:** There is no Linear automation service today. The closest verified implementation is `src/services/ClickUpAutomationService.ts`, and the already-shipped Linear GraphQL/token/config owner is `src/services/LinearSyncService.ts`.
- **Logic:**
  1. Mirror the constructor shape of `ClickUpAutomationService` so the provider can inject `workspaceRoot`, the cached `LinearSyncService`, and `resolvePlansDir()`.
  2. Port the safe utility methods that matter from ClickUp automation: workspace-id resolution, path normalization, whitespace normalization, truncation, metadata extraction, file existence check, file reading, and stable automation ID generation.
  3. `_getRules(config)` should filter enabled Linear rules; `_getWatchedStateIds(config)` should de-dupe their `triggerStates`.
  4. `_taskHasSwitchboardOwnership(issue)` must bridge the repo mismatch by treating both the currently shipped `switchboard` label and any future `switchboard:*` labels as “already managed by Switchboard”.
  5. `poll()` should reuse the current `importIssuesFromLinear()` pagination pattern, fetch top-level issues for the configured team/project, skip closed/cancelled work, skip sub-issues for the initial scope, and then filter client-side by `issue.state.id` and lowercased label names.
  6. Before writing a plan file, dedupe by ownership label, `db.findPlanByLinearIssueId()`, and stable file path.
  7. `_buildPlanContent()` must emit the same plan structure the importer expects today: imported-metadata block, `## Metadata`, `## Goal`, `## Proposed Changes`, `## Linear Issue Notes`, and `## Switchboard State`.
  8. `_resolveStoredRule()` should mirror the ClickUp implementation and recover the saved rule name from plan metadata.
  9. `writeBackAutomationResult()` must support both `commentCreate` and description-update flows; description update must fetch the current description first and merge/append the summary instead of replacing it blindly.
  10. Write back only when the plan row is `sourceType === 'linear-automation'`, `linearIssueId` exists, `lastAction !== 'linear_writeback_complete'`, the stored rule still exists, `writeBackOnComplete === true`, and the current kanban column matches `rule.finalColumn`.
- **Implementation:**
  - Use plan metadata lines analogous to the ClickUp service, but with Linear-specific fields: `Imported from Linear issue`, `Linear Issue ID`, `Plan ID`, `Session ID`, `Automation Rule`, `URL`, current state, and labels.
  - Use a stable file name such as `linear_automation_<issue-slug>_<hash>.md` so repeated polls resolve to one canonical plan file.
  - Reuse `KanbanDatabase.forWorkspace(this._workspaceRoot)` and `db.updateLastAction(sessionId, 'linear_writeback_complete')` exactly the way ClickUp automation does.
  - Keep the default write-back execution aligned with ClickUp’s current “description append” behavior unless a verified existing config field already selects another target; the service-level support for comment write-back still needs to exist because the original draft explicitly required both GraphQL mutation paths.
- **Edge Cases Handled:** Multiple rule matches log and choose the first rule deterministically, deleted/missing issues fail the write-back with an error instead of looping forever, already-written plans do not duplicate, and already-written-back plans stay idempotent via `lastAction`.

### Integration timer and provider wiring
#### [MODIFY] `src/services/IntegrationAutoPullService.ts`
- **Context:** The shared timer service already supports `'clickup'`, `'linear'`, and `'clickup-automation'`. The scheduler logic itself is generic and does not need behavioral changes.
- **Logic:**
  1. Extend `AutoPullIntegration` to include `'linear-automation'`.
  2. Leave `configure()`, `stop()`, `stopWorkspace()`, and `_scheduleNext()` behavior unchanged; the new integration key is enough to isolate the Linear automation runner.
- **Implementation:** This is a type-surface change only, but it must land before `KanbanProvider._configureLinearAutomation()` can compile.
- **Edge Cases Handled:** Distinct integration key prevents Linear import polling from sharing a timeout/in-flight slot with Linear automation polling.

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The provider currently has `_clickUpAutomationServices`, `_linearServices`, `_configureClickUpAutomation()`, `_configureLinearAutoPull()`, and `initializeIntegrationAutoPull()` calling only ClickUp auto-pull, ClickUp automation, and Linear auto-pull. `dispose()` only clears `_clickUpAutomationServices`.
- **Logic:**
  1. Import `LinearAutomationService`.
  2. Add `_linearAutomationServices = new Map<string, LinearAutomationService>()`.
  3. Add `_getLinearAutomationService(workspaceRoot)` that reuses the cached `LinearSyncService` plus the existing `_getIntegrationImportDir(workspaceRoot)` helper.
  4. Add `_configureLinearAutomation(workspaceRoot)` mirroring `_configureClickUpAutomation()`:
     - stop `'linear-automation'` when setup is incomplete or no enabled rules exist
     - configure the shared scheduler with `config.pullIntervalMinutes`
     - reload config at run time
     - call `automation.poll()`
     - post `linearState` success/error through `_postLinearState()`
     - throw aggregated poll errors so the scheduler logs them
  5. Call `_configureLinearAutomation()` inside `initializeIntegrationAutoPull()`.
  6. Include `_linearAutomationServices` in `dispose()` cleanup and in the `knownRoots` set used for workspace-removal cleanup.
  7. Leave existing card-move sync hooks intact; this plan is additive to them, not a replacement.
- **Implementation:**
  - Follow the existing ClickUp automation structure closely so the provider owns only scheduling and service caching, not polling logic.
  - Keep the Linear setup success path posting `_postLinearState(workspaceRoot)` so the kanban header still reflects setup status immediately after configuration.
  - Reuse the existing `config.pullIntervalMinutes` for both Linear import auto-pull and Linear automation polling; do not add a second timer-setting UI because the original draft did not require one.
- **Edge Cases Handled:** Workspace removal stops both Linear timers, disabled rule sets tear down the automation runner cleanly, and provider disposal does not leak service instances or timeouts.

### Clarification - setup-panel plumbing required by the original Phase 4 UI work
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `ClickUpSetupState` exists, but there is no `LinearSetupState`; `getIntegrationSetupStates()` returns `clickupState` only; and `handleSaveClickUpAutomation()` exists without any Linear counterpart.
- **Logic:**
  1. Add `LinearSetupState` with `setupComplete`, current visible columns, available labels, available states, saved automation rules, and optional `error`.
  2. Extend `getIntegrationSetupStates()` to return `linearState?: LinearSetupState`.
  3. Build `linearState.columns` from the same `handleGetKanbanStructure()` result already used for ClickUp so the Linear rule UI sees the real current board columns.
  4. When Linear config exists and setup is complete, fetch current team labels/states through `LinearSyncService` helper(s) and include `config.automationRules`.
  5. Add `handleSaveLinearAutomation(automationRules)` mirroring ClickUp: save rules via `LinearSyncService.saveAutomationSettings()`, then `await this._kanbanProvider?.initializeIntegrationAutoPull()`.
  6. Preserve the current `handleSetupLinear()` setup flow; the automation section should appear only after setup succeeds.
- **Implementation:**
  - Keep the return shape backward-compatible by adding `linearState` instead of replacing the existing booleans.
  - If label/state fetch fails, still return saved rules + current columns + `error` so the UI can show the user's persisted configuration instead of blanking the section.
  - Preserve each rule's `enabled` flag in the setup-state payload instead of coercing every saved rule back to enabled on render.
  - Use the same `resolvedRoot` guard pattern as the existing ClickUp and Notion handlers.
- **Edge Cases Handled:** No workspace open, stale saved rules when API fetch fails, hidden custom columns excluded from selectors, and auto-pull reinitialized immediately after rule saves.

#### [MODIFY] `src/services/SetupPanelProvider.ts`
- **Context:** The webview provider routes `saveClickUpAutomation` but has no Linear automation message case today.
- **Logic:**
  1. Add `case 'saveLinearAutomation'`.
  2. Pass the normalized array payload to `TaskViewerProvider.handleSaveLinearAutomation()`.
  3. Post back `linearAutomationSaved`, then refresh the setup panel state and `switchboard.refreshUI`.
- **Implementation:** Mirror the exact flow already used for `saveClickUpAutomation` so the setup panel's success/error path stays consistent across integrations.
- **Edge Cases Handled:** Empty or malformed payloads become `[]`, and provider-level error handling still surfaces the message via `showErrorMessage`.

#### [MODIFY] `src/webview/setup.html`
- **Context:** The central setup panel currently ends the Linear subsection at the token input + `SETUP LINEAR` button. All automation rendering, payload collection, and success-message handling is ClickUp-only.
- **Logic:**
  1. Add a hidden `#linear-automation-section` below the existing Linear setup controls, mirroring the ClickUp automation layout.
  2. Add `lastLinearSetupState`, a clone helper, render helpers, payload collection, and “add rule” helpers parallel to the existing ClickUp automation code.
  3. Render each Linear rule card with:
     - rule name input
     - enabled/disabled checkbox
     - trigger label `<select>`
     - trigger states `<select multiple>`
     - start column `<select>`
     - final column `<select>`
     - write-back checkbox
  4. Update `integrationSetupStates` handling to hydrate both `clickupState` and `linearState`.
  5. Add `btn-linear-add-rule` / `btn-linear-save-automation` handlers that post `saveLinearAutomation`.
  6. Add `case 'linearAutomationSaved'` and improve the `linearSetupResult` success copy so users are told to review automation rules after setup.
- **Implementation:**
  - Reuse the visible-column list from `linearState.columns`, not a hard-coded canonical column array, so custom visible lanes appear in the selectors the same way ClickUp mapping UI already respects live board state.
  - Reuse the same compact field-card pattern as the ClickUp automation UI to keep markup and CSS churn minimal.
  - Persist `enabled`, `triggerLabel`, and `triggerStates` in the posted payload instead of hard-coding every saved rule back to `enabled: true`.
- **Edge Cases Handled:** Setup-incomplete hides the section, empty labels/states still show an editable but informative UI, saved rules survive a failed catalog refresh, and rule cards can be removed locally before save just like ClickUp.

### Tests and suite wiring
#### [CREATE / MODIFY] `src/test/integrations/linear/linear-automation-service.test.js`, `src/test/integration-auto-pull-regression.test.js`, `src/test/setup-panel-migration.test.js`, `src/test/integrations/shared/integration-auto-pull-service.test.js`, `src/test/integrations/linear/linear-sync-service.test.js`, `src/test/integrations/linear/linear-import-flow.test.js`, `src/test/integrations/run-integration-tests.js`
- **Context:** The repo already has strong ClickUp automation coverage and Linear coverage for GraphQL, setup/sync, and manual import, but there is no Linear automation test or runner entry today.
- **Logic:**
  1. Create `linear-automation-service.test.js` by following the proven shape of `clickup-automation-service.test.js`:
     - save a Linear config with enabled automation rules
     - mock paginated issue fetches
     - assert matching issues create exactly one plan file
     - run `importPlanFiles(workspaceRoot)` and assert `sourceType === 'linear-automation'`, `linearIssueId` is stored, and the target column matches the rule
     - move the imported plan to the rule's final column, rerun `poll()`, and assert write-back plus `lastAction === 'linear_writeback_complete'`
     - assert ownership-labeled issues and already-imported issue IDs are skipped
  2. Update `linear-sync-service.test.js` and `linear-import-flow.test.js` base configs/fixtures so `automationRules` is either present as `[]` or explicitly asserted to normalize to `[]`.
  3. Update `integration-auto-pull-regression.test.js` to expect `_configureLinearAutomation()` and `'linear-automation'` alongside the existing auto-pull/automation scheduler wiring.
  4. Update `setup-panel-migration.test.js` to expect `linearState` hydration and the `saveLinearAutomation` route.
  5. Update `integration-auto-pull-service.test.js` to exercise the third integration key.
  6. Update `run-integration-tests.js` so `npm run test:integration:linear` actually executes the new automation test file.
- **Implementation:**
  - Reuse the existing workspace/test harness helpers (`withWorkspace`, `installHttpsMock`, `SecretStorageMock`, `loadOutModule`) rather than inventing a new harness.
  - Keep ClickUp automation coverage intact; if the DB schema or importer changes touch ClickUp paths, rerun the existing ClickUp automation test as part of verification.
  - Prefer targeted regression assertions over broad snapshotting: issue ID persistence, scheduler wiring, and setup-panel message routing are the surfaces most likely to regress.
- **Edge Cases Handled:** Legacy configs without `automationRules`, separate timer keys in the shared auto-pull service, suite-runner omissions, and importer/source-type regressions.

## Verification Plan
### Automated Tests
- `npm run lint`
- `npm run compile`
- `node src/test/integration-auto-pull-regression.test.js`
- `node src/test/setup-panel-migration.test.js`
- `node src/test/integrations/shared/integration-auto-pull-service.test.js`
- `npm run test:integration:linear`
- `node src/test/integrations/clickup/clickup-automation-service.test.js`

### Manual Verification
- Configure Linear from the central setup panel, confirm the Linear automation section appears, add at least one rule, save it, and verify `.switchboard/linear-config.json` persists `automationRules`.
- Create or relabel a Linear issue so it matches one enabled rule, run the automation poll path, and confirm exactly one new plan file appears in the resolved plan-ingestion folder with `Linear Issue ID`, `Automation Rule`, and the expected `## Switchboard State`.
- Move that imported automation plan to the configured final column, run the poll path again, and confirm write-back occurs once and does not repeat after `lastAction` is marked complete.

### Clarification - preserved original testing strategy
- Unit tests: `src/test/integrations/linear/linear-automation-service.test.js`
- Integration tests: Linear GraphQL mocking, plan creation, write-back verification

### Clarification - preserved original migration path
- Database migration adds `linear_issue_id` column automatically
- Linear configs without `automationRules` get empty array default
- No breaking changes to existing ClickUp automation

### Clarification - preserved original open questions
1. Write-back target: Support both description and comment like ClickUp? **Yes**
2. Label ownership: Use `switchboard:` label prefix? **Yes** — compatibility note: the currently shipped plain `switchboard` label must still be handled during rollout.
3. Sub-issues: Import them? **Phase 2 - skip initially**

### Files to Modify

| File | Action | Verified reason |
|------|--------|-----------------|
| `src/services/LinearSyncService.ts` | MODIFY | Add `automationRules` to `LinearConfig`, normalize/save them, and expose label/state data for the setup panel |
| `src/models/PipelineDefinition.ts` | MODIFY | Add `LinearAutomationRule` interface and matching/normalization helpers |
| `src/services/KanbanDatabase.ts` | MODIFY | Add `linear_issue_id`, lookup helpers, and `'linear-automation'` source typing |
| `src/services/PlanFileImporter.ts` | MODIFY | Import Linear automation-generated plans with `linearIssueId` and `sourceType: 'linear-automation'` |
| `src/services/LinearAutomationService.ts` | CREATE | Implement polling, plan creation, dedupe, and write-back for Linear issues |
| `src/services/IntegrationAutoPullService.ts` | MODIFY | Add `'linear-automation'` integration key |
| `src/services/KanbanProvider.ts` | MODIFY | Wire up the Linear automation service and scheduler |
| `src/services/TaskViewerProvider.ts` | MODIFY | Expose/save Linear automation setup state through the central setup panel |
| `src/services/SetupPanelProvider.ts` | MODIFY | Route `saveLinearAutomation` messages |
| `src/webview/setup.html` | MODIFY | Add Linear automation rule UI and message handling |
| `src/test/integrations/linear/linear-automation-service.test.js` | CREATE | Cover poll → import → write-back flow |
| `src/test/integrations/linear/linear-sync-service.test.js` | MODIFY | Cover config normalization with `automationRules` |
| `src/test/integrations/linear/linear-import-flow.test.js` | MODIFY | Keep Linear import coverage aligned with the expanded config shape |
| `src/test/integration-auto-pull-regression.test.js` | MODIFY | Assert new scheduler wiring for `'linear-automation'` |
| `src/test/setup-panel-migration.test.js` | MODIFY | Assert setup-panel hydration/saving for Linear automation |
| `src/test/integrations/shared/integration-auto-pull-service.test.js` | MODIFY | Exercise a third integration key |
| `src/test/integrations/run-integration-tests.js` | MODIFY | Include the new Linear automation test in the `linear` suite |
