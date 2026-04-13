# Comprehensive ClickUp Integration Enhancement

## Goal
Enhance the existing ClickUp integration in two directions already defined by this plan: dynamic column mapping for the real Kanban column set, and event-driven internal automation pipelines that trigger from ClickUp and write results back to the originating ticket.

## Metadata
**Tags:** backend, database, UI, infrastructure
**Complexity:** 9

## User Review Required
> [!NOTE]
> - This plan intentionally preserves the original two-part scope: **Flexible Column Mapping** and **Event-Driven Automation Pipelines**. It does **not** add new product scope beyond those existing requirements.
> - **Clarification:** current ClickUp setup/config UI already lives in `src/webview/setup.html` under the **ClickUp, Linear and Notion Integration** section, routed through `src/services/SetupPanelProvider.ts` and `src/services/TaskViewerProvider.ts`. The enhancement should extend that surface rather than invent a parallel setup flow.
> - **Clarification:** current ClickUp runtime behavior already exists in `src/services/ClickUpSyncService.ts` and `src/services/KanbanProvider.ts`, including config persistence, setup, sync-on-move, import, and auto-pull. The implementation must extend those exact files first, then add new services only where the existing ones would otherwise become overloaded.
> - **Clarification:** internal automation pipelines are explicitly internal-only per the original plan. They must not leak into normal ClickUp list mapping or the main Kanban board unless the feature explicitly asks for a debug/recovery view.
> - **Recommended Agent:** Send to Lead Coder

## Complexity Audit
### Routine
- Extend the existing ClickUp config contract in `src/services/ClickUpSyncService.ts` so saved mappings can represent real current columns rather than only `CANONICAL_COLUMNS`, while preserving legacy configs that were created by Parts 1-3.
- Expand the existing setup-panel integration state in `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, and `src/webview/setup.html` so the current ClickUp subsection can show mapping status, mapping controls, and automation-rule controls after setup completes.
- Add focused regression coverage to existing ClickUp tests such as `src/test/integrations/clickup/clickup-sync-service.test.js`, `src/test/integrations/clickup/clickup-import-flow.test.js`, and `src/test/integration-auto-pull-regression.test.js`.
- Reuse the current import/sync folder resolution path in `src/services/KanbanProvider.ts` so dynamic mappings, auto-pull, and any new automation-created plans continue to target the same ingestion destination.

### Complex / Risky
- Replace the current `CANONICAL_COLUMNS` assumption in `src/services/ClickUpSyncService.ts` setup flow without breaking existing setups, existing tests, or the current sync/import logic that still expects stable mapping keys.
- Add internal-only automation plans with persistent linkage to the originating ClickUp task, while keeping those plans out of the main Kanban board and out of normal Switchboard→ClickUp list-sync loops.
- Introduce an automation trigger engine that polls ClickUp, deduplicates work, avoids re-processing the same ticket, and coordinates with existing auto-pull/sync behavior in `src/services/KanbanProvider.ts`.
- Extend `src/services/KanbanDatabase.ts` and surrounding query paths safely so new internal pipeline records do not corrupt current board queries, plan recovery flows, or existing migration assumptions.

## Edge-Case & Dependency Audit
- **Race Conditions:** ClickUp already has setup, sync, import, and auto-pull surfaces. Dynamic mapping plus automation introduces overlapping triggers: setup writes config, auto-pull imports tasks, sync-on-move updates tasks, and automation polling may independently create internal plans. The implementation must ensure one task is not processed simultaneously by normal sync/import paths and automation-trigger paths. Persist task linkage and dedupe state before scheduling background work.
- **Security:** Keep all ClickUp credentials in VS Code `SecretStorage` through the existing token flow in `ClickUpSyncService.ts`. New mapping/automation UI state must not include tokens. Write-back logs must never dump full request bodies containing task content or custom-field IDs unnecessarily.
- **Side Effects:** Existing workspaces have `clickup-config.json` files normalized around canonical columns. A partial migration that updates setup but not runtime sync will create mappings that the rest of the service cannot honor. Internal-only plans also create a visibility hazard: if `isInternal`/`pipelineId` handling is incomplete, pipeline cards may appear in the main Kanban board or get synced back to ClickUp as if they were user plans.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` shows no active **New** or **Planned** plans that directly overlap ClickUp integration code paths; the only current active neighbors are `Fix Gitignore Rules for workspace-id` and the two completion/archive investigation plans, which do not target ClickUp files. Historical same-area plans in `.switchboard/plans/` are highly relevant context and should be treated as prior art rather than active blockers: `clickup_1_foundation.md`, `clickup_2_setup_flow.md`, `clickup_3_sync_on_move.md`, `clickup_import_pull_tasks.md`, `clickup_push_plan_content_to_tasks.md`, `clickup_setup_button_api_key_bug.md`, `add_auto_pull_and_timer_to_integration_setup.md`, and `make_integration_setup_buttons_discoverable.md`. Those files establish that the live ClickUp surfaces are `src/services/ClickUpSyncService.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, and `src/webview/setup.html`.

## Adversarial Synthesis
### Grumpy Critique
> This draft is trying to drive two different trucks through one tunnel and pretending they are the same feature. “Flexible column mapping” is an extension of the existing ClickUp setup/config/sync path. “Event-driven automation pipelines” is a new orchestration system with background polling, internal-only plans, database schema work, write-back rules, and visibility boundaries. If you do not split those concerns explicitly, you will get a half-upgraded `ClickUpSyncService` that still secretly trusts `CANONICAL_COLUMNS`, a shiny setup UI that saves mappings the runtime ignores, and internal pipeline cards leaking into the main board because no one fully owned the persistence/query model. The repo already has ClickUp setup, import, sync-on-move, and auto-pull. If this plan does not anchor every step in those real files, it is not a plan — it is a wish list stapled on top of an existing subsystem.

### Balanced Response
> The right fix is to preserve the original scope while separating it into two grounded implementation tracks. Part 1 extends the existing ClickUp setup/runtime surfaces so column mapping becomes dynamic, editable, and visible without breaking canonical-column installations. Part 2 builds automation on top of that foundation using explicit internal-plan persistence, dedicated services, and clear board-filtering rules so automation stays internal and write-back remains deterministic. The updated plan below names the exact current files that already own ClickUp setup, config, sync, and import behavior, then layers the new work on top of those surfaces instead of inventing a second integration stack.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The authoritative implementation path is the section below. The original architecture, use cases, and implementation phases are preserved later in this file as source material and must remain in scope, but any ambiguity should be resolved in favor of the file-specific implementation surfaces documented here.

### Clarification — Current authoritative ClickUp surfaces in the codebase
- `src/services/ClickUpSyncService.ts` already owns ClickUp config normalization, setup, one-way sync, import, retry logic, and the current hardcoded `CANONICAL_COLUMNS` behavior.
- `src/services/KanbanProvider.ts` already consumes `columnMappings` for ClickUp auto-pull and integration state, so dynamic mapping work must update that runtime as well as setup.
- `src/services/TaskViewerProvider.ts` already exposes `getIntegrationSetupStates()` and `handleSetupClickUp()`, which means setup-panel mapping/automation controls must flow through it.
- `src/services/SetupPanelProvider.ts` already routes the ClickUp setup-panel messages.
- `src/webview/setup.html` already renders the ClickUp subsection where mapping and automation controls belong.

### Low-Complexity / Routine Implementation Steps
1. Extend the persisted ClickUp config shape in `src/services/ClickUpSyncService.ts` so `columnMappings` no longer assumes only canonical columns, while keeping old configs readable and preserving existing `customFields`, `setupComplete`, and auto-pull fields.
2. Expand setup-panel state so ClickUp can surface current mapping status, list coverage, and automation-rule summaries using the existing `TaskViewerProvider` → `SetupPanelProvider` → `setup.html` message path.
3. Add mapping-focused regression coverage to the existing ClickUp test suite and keep current import/sync tests green for canonical-column setups.
4. Preserve current manual setup, manual import, and auto-pull entry points; this enhancement should extend them rather than replace them.

### High-Complexity / Complex / Risky Implementation Steps
1. Replace setup-time canonical list creation with dynamic column discovery sourced from the current Kanban column structure, while preserving existing mappings for already-configured workspaces.
2. Add explicit unmapped-column handling to runtime sync so the UI and logs can distinguish “column intentionally excluded” from “configuration incomplete” instead of silently skipping all unmapped columns.
3. Introduce internal-only automation pipeline plans with durable DB fields such as `pipelineId`, `isInternal`, and the originating ClickUp task ID so the system can deduplicate, route, and write back correctly.
4. Add a dedicated ClickUp automation service that polls, filters, deduplicates, and hands off to pipeline orchestration without colliding with existing auto-pull/import logic.
5. Keep internal automation plans off the main board and out of standard ClickUp list-sync code paths unless a future debug-only surface explicitly opts them in.
6. Ensure final-stage write-back can update the originating ClickUp task deterministically even if the internal pipeline has advanced through several hidden stages.

### Existing ClickUp config and setup flow
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** This file is the current single source of truth for ClickUp config, setup, sync, import, and retry behavior. The current blockers are explicit in code:
  - `columnMappings` defaults are seeded from `CANONICAL_COLUMNS`
  - `setup()` creates one list per canonical column
  - `syncPlan()` silently succeeds when a column is unmapped
- **Logic:**
  1. Replace the assumption that the config always contains only canonical keys. Normalize `columnMappings` as an arbitrary `Record<string, string>` while preserving any known legacy canonical keys already on disk.
  2. Split setup into two stages:
     - bootstrap folder/space selection and existing-list discovery
     - dynamic column mapping decisions for the workspace’s current columns
  3. Keep HTTP ownership in this service: setup, list discovery, list creation/reuse, task create/update, import, and write-back helpers should remain here so new automation code can reuse the existing authenticated client instead of duplicating REST logic.
  4. Make unmapped behavior explicit. Instead of returning bare success for an unmapped column, return enough information for callers to log or surface a configuration warning without treating it as a transport failure.
  5. Extend the persisted config with the original plan’s automation concepts using the existing `clickup-config.json` file rather than creating a second ClickUp config path. The normalized shape should preserve current fields and add nested sections such as:
     - `columnMappings`
     - `automationRules`
     - `pipelines`
  6. Reuse existing custom-field/task-link helpers for write-back so pipeline completion can update the original task deterministically.
- **Implementation detail to add to the plan:**
  - Explicitly document the normalized `clickup-config.json` shape after enhancement, for example:
```json
{
  "workspaceId": "team_123",
  "folderId": "folder_456",
  "spaceId": "space_789",
  "columnMappings": {
    "CREATED": "list_created",
    "Custom Agent Column": "list_custom"
  },
  "customFields": {
    "sessionId": "field_session",
    "planId": "field_plan",
    "syncTimestamp": "field_sync"
  },
  "automationRules": [
    {
      "name": "Bug Triage",
      "trigger": {
        "type": "tag",
        "tag": "bug",
        "lists": ["list_created", "list_backlog"]
      },
      "pipeline": "bug-investigation",
      "writeBack": {
        "target": "description",
        "format": "append"
      }
    }
  ],
  "pipelines": {
    "bug-investigation": {
      "internalOnly": true,
      "stages": [
        { "name": "BUG_RECEIVED", "agent": "analyst" },
        { "name": "BUG_ANALYSIS", "agent": "coder" },
        { "name": "ROOT_CAUSE", "agent": "lead" },
        { "name": "SOLUTION", "agent": "coder" },
        { "name": "COMPLETE", "writeBack": true }
      ]
    }
  },
  "setupComplete": true,
  "lastSync": null,
  "autoPullEnabled": false,
  "pullIntervalMinutes": 60
}
```
- **Edge Cases Handled:** Legacy canonical-only configs still load; existing task create/update/import logic keeps working; unmapped custom columns are no longer invisible failures; automation reuses the same authenticated HTTP layer instead of forking ClickUp REST behavior.

### Current column structure and runtime integration state
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** This file already consumes `config.columnMappings` for ClickUp auto-pull and owns the runtime Kanban column structure. It therefore has to become the source of discoverable current columns for setup-time mapping and the enforcement point for hiding internal automation plans from the main board.
- **Logic:**
  1. Add a public/internal helper that exposes the current workspace column structure using the existing column-building path rather than reconstructing it in `ClickUpSyncService`.
  2. Rework ClickUp auto-pull/mapped-list logic so it tolerates arbitrary current mapping keys instead of assuming only canonical ones.
  3. Add visible sync-state feedback for unmapped columns using the existing board/webview message surfaces, not a silent console-only skip.
  4. Filter internal automation plans out of main-board card queries/rendering while preserving an explicit path for pipeline progress tracking elsewhere.
  5. Ensure any automation scheduling/triggering logic coordinates with the existing `IntegrationAutoPullService` so ClickUp polling does not create duplicate imports or duplicate pipeline launches.
- **Edge Cases Handled:** Dynamic columns remain discoverable after agent-column changes; internal plans do not pollute the visible board; auto-pull and automation polling do not both process the same ClickUp list blindly.

### Setup-panel data routing
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The setup panel already depends on this file for integration-state hydration and setup actions. If column mappings and automation settings are editable in the setup UI, this file must expose the richer state and save entry points.
- **Logic:**
  1. Expand `getIntegrationSetupStates()` or add adjacent ClickUp-specific getters so the setup panel can receive:
     - current mapping coverage
     - available/unmapped columns
     - current automation-rule summaries
  2. Add save handlers for:
     - column mapping updates
     - automation-rule updates
     - pipeline definition updates
  3. Keep ClickUp token setup flow intact and separate from mapping/automation saves so token failure and config-edit failure stay distinguishable.
  4. For automation-triggered internal plans, use the same workspace-root resolution and plan-ingestion conventions already used elsewhere in `TaskViewerProvider`.
- **Edge Cases Handled:** Setup UI remains consistent after save/refresh; token setup and mapping edits do not stomp each other; automation-created plans use the same workspace context and ingestion rules as the rest of the extension.

#### [MODIFY] `src/services/SetupPanelProvider.ts`
- **Context:** The setup panel currently only routes `setupClickUp` and generic integration-state hydration for ClickUp. Any editable mapping/automation UI must flow through this same router.
- **Logic:**
  1. Add explicit message types for loading and saving ClickUp mapping and automation settings.
  2. Keep ClickUp message routing parallel to existing setup-panel message conventions instead of inventing a one-off channel.
  3. Re-broadcast refreshed setup state after saves so the setup panel reflects server-side normalization immediately.
- **Edge Cases Handled:** Setup-panel state stays authoritative after save; existing setup button behavior is preserved; no duplicate ClickUp transport path is introduced.

### Existing setup UI
#### [MODIFY] `src/webview/setup.html`
- **Context:** The current ClickUp subsection already renders token input and a `SETUP CLICKUP` button. This is the correct place to expose column mapping and automation controls for this plan’s existing scope.
- **Logic:**
  1. Keep the current ClickUp setup token/button flow intact at the top of the subsection.
  2. After setup completes, reveal a mapping editor that lists current Kanban columns and, for each one, offers:
     - create new list
     - map to existing list
     - exclude from sync
  3. Add a separate automation subsection in the same ClickUp card for:
     - rule list
     - pipeline selection
     - write-back target/format
  4. Ensure UI copy distinguishes:
     - normal ClickUp list mapping
     - internal-only automation pipelines
  5. Keep the section inside the existing `project-mgmt` accordion rather than duplicating ClickUp controls elsewhere.
- **Edge Cases Handled:** Existing users still see the familiar setup entry point; post-setup editing becomes possible without re-running setup; internal pipeline controls are clearly separated from board-column mapping controls.

### Internal pipeline persistence
#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** The original plan explicitly calls for internal pipeline plans and names `pipelineId` / `isInternal` in the data model. Current DB records do not carry those fields, so the main board cannot safely distinguish normal plans from internal automation work.
- **Logic:**
  1. Extend the plan schema/migrations with explicit fields for internal automation tracking, at minimum:
     - `pipeline_id`
     - `is_internal`
     - `clickup_task_id`
  2. Update row read/write helpers and relevant plan upsert paths so these fields survive all normal DB operations.
  3. Update board queries and any recovery/reconciliation logic that should exclude internal plans from the user-visible board by default.
  4. Preserve current behavior for normal plans by making the new fields default-safe (`NULL` / false).
- **Edge Cases Handled:** Old plans remain valid; internal pipeline rows can be queried and resumed without showing up in the normal board; ClickUp task linkage survives restarts and prevents duplicate automation launches.

### New automation services
#### [CREATE] `src/services/ClickUpAutomationService.ts`
- **Context:** The original plan introduces a polling/webhook-style event listener, trigger filtering, and rule matching. That behavior is too separate from one-way sync/import to leave buried inside `ClickUpSyncService.ts`.
- **Logic:**
  1. Poll configured ClickUp lists/workspaces based on the saved automation rules.
  2. Match tasks against trigger definitions (tags, lists, or equivalent original-plan conditions).
  3. Deduplicate against already-created internal pipeline plans using persisted `clickup_task_id` + `pipeline_id`.
  4. Hand matched tasks to pipeline orchestration and write-back only after durable task linkage is recorded.
- **Edge Cases Handled:** One ClickUp task does not launch the same pipeline repeatedly; automation polling remains isolated from generic import behavior; transport logic still reuses `ClickUpSyncService` HTTP helpers.

#### [CREATE] `src/services/PipelineManager.ts`
- **Context:** The original plan defines reusable pipeline templates with hidden stages and final write-back. That stage orchestration needs a dedicated owner.
- **Logic:**
  1. Load pipeline definitions from persisted config/state.
  2. Create and advance internal plan stages.
  3. Trigger the final write-back step when a terminal stage with `writeBack: true` is reached.
  4. Keep stage progression separate from main-board column logic.
- **Edge Cases Handled:** Pipeline advancement can be reasoned about independently from ClickUp HTTP logic; stalled pipeline state can be resumed; final write-back only fires once.

#### [CREATE] `src/models/PipelineDefinition.ts`
- **Context:** The original plan already named this file and the pipeline structure is substantial enough to justify a dedicated type/module.
- **Logic:**
  1. Define typed pipeline/stage structures used by both the setup UI save path and runtime automation services.
  2. Keep `internalOnly` and `writeBack` semantics explicit in the model rather than as loose object literals scattered across services.
- **Edge Cases Handled:** Setup/UI/runtime all validate the same pipeline shape; stage flags are consistent across persistence and execution.

### Extension activation / lifecycle
#### [MODIFY] `src/extension.ts`
- **Context:** The original plan already called for service registration, and any ClickUp automation service needs lifecycle ownership at activation/workspace changes just like existing integration services.
- **Logic:**
  1. Instantiate and initialize the automation service per active workspace.
  2. Reconfigure or stop it when workspace folders change or when relevant ClickUp config changes.
  3. Keep existing ClickUp setup/import/sync command wiring intact.
- **Edge Cases Handled:** Automation listeners do not leak across workspace changes; startup/shutdown behavior matches the rest of the extension’s integration lifecycle.

### Verification surface
#### [MODIFY / CREATE] `src/test/integrations/clickup/clickup-sync-service.test.js`
- **Context:** This file already validates ClickUp config normalization, setup, sync, and unmapped-column behavior.
- **Logic:** Extend it to cover dynamic/non-canonical mapping keys, setup preservation of existing mappings, and explicit unmapped-column outcomes.

#### [MODIFY] `src/test/integrations/clickup/clickup-import-flow.test.js`
- **Context:** Import still depends on the ClickUp config shape and column mapping semantics.
- **Logic:** Keep import coverage aligned with the enhanced config schema so setup-time mapping changes do not break import assumptions.

#### [MODIFY] `src/test/integration-auto-pull-regression.test.js`
- **Context:** ClickUp runtime already has auto-pull settings and scheduling through `KanbanProvider.ts`.
- **Logic:** Extend regression coverage so dynamic mappings and automation polling do not regress existing auto-pull behavior or destination-resolution guarantees.

#### [CREATE] `src/test/integrations/clickup/clickup-automation-service.test.js`
- **Context:** Automation polling, trigger matching, dedupe, and write-back are new runtime behavior and need isolated tests.
- **Logic:** Cover trigger match/no-match, duplicate suppression, internal pipeline creation, and final-stage write-back dispatch.

### Verification Plan
#### Automated Tests
- `npm run compile`
- `node src/test/integrations/clickup/clickup-sync-service.test.js`
- `node src/test/integrations/clickup/clickup-import-flow.test.js`
- `node src/test/integration-auto-pull-regression.test.js`
- `node src/test/integrations/clickup/clickup-automation-service.test.js`

#### Manual Validation
1. Run ClickUp setup in the existing setup panel and verify current workspace columns are offered for mapping rather than only `CANONICAL_COLUMNS`.
2. Map a custom Kanban column to a ClickUp list and verify sync-on-move uses that mapping.
3. Exclude a column from sync and verify the UI/runtime surfaces it as intentionally unmapped rather than silently doing nothing.
4. Configure an automation rule for a ClickUp tag such as `bug`, confirm an internal-only pipeline plan is created, and verify it does not appear in the normal board.
5. Advance the pipeline to its write-back stage and verify the originating ClickUp task is updated exactly once.

---

## Preserved Original Plan Content

## Use Cases

### Bug Triage Pipeline
- **Trigger**: New ClickUp ticket tagged with `bug` or added to specific list
- **Process**: Switchboard creates investigation pipeline (not visible in ClickUp)
- **Result**: AI investigates bug, writes findings back to ticket description/comments
- **Columns**: Internal only - never synced to ClickUp

### Feasibility Analysis Pipeline
- **Trigger**: New roadmap item or ticket tagged with `feasibility`
- **Process**: Switchboard runs technical analysis, risk assessment
- **Result**: Updates ticket with technical approach, risk score, implementation estimate
- **Columns**: Internal only - never synced to ClickUp

### Data Analysis Pipeline
- **Trigger**: Data request tickets tagged with `data-analysis`
- **Process**: Switchboard runs data queries, generates insights
- **Result**: Appends analysis results to ticket
- **Columns**: Internal only - never synced to ClickUp

### Flexible Column Sync (Original Requirement)
- **Use case**: Teams with custom agent columns want bidirectional sync to ClickUp
- **Current limitation**: Only 8 hardcoded canonical columns get ClickUp lists
- **Desired behavior**: Any column in kanban can be mapped to a ClickUp list
- **Setup wizard**: Should discover current columns and offer mapping options

## Core Architecture

### Part 1: Flexible Column Mapping

#### Problem
Current implementation:
- Only 8 hardcoded canonical columns (CREATED, BACKLOG, PLAN REVIEWED, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED) get ClickUp lists created during setup
- Custom agent columns don't get ClickUp lists
- Plans in unmapped columns are silently skipped during sync
- Users cannot configure which columns should sync to ClickUp

#### Solution

**1. Dynamic Column Discovery**
- Modify `ClickUpSyncService.setup()` to read current kanban column structure from `KanbanProvider`
- Instead of iterating through `CANONICAL_COLUMNS`, iterate through actual active columns in the workspace
- Prompt user to select which columns should have ClickUp lists created

**2. Column Mapping Configuration**
- Add UI in setup panel to view/edit column mappings
- Allow users to:
  - Map existing Switchboard columns to existing ClickUp lists
  - Create new ClickUp lists for unmapped columns
  - Exclude specific columns from sync
- Store mappings in `clickup-config.json` with structure:
  ```json
  {
    "columnMappings": {
      "CREATED": "list_id_1",
      "BACKLOG": "list_id_2",
      "Custom Agent Column": "list_id_3"
    }
  }
  ```

**3. Setup Flow Enhancement**
- After selecting space, show current kanban columns
- For each column, offer options:
  - "Create new list" (default for unmapped)
  - "Map to existing list" (dropdown of available lists)
  - "Exclude from sync" (checkbox)
- Allow bulk actions: "Create lists for all unmapped columns"

**4. Sync Behavior Update**
- Remove silent skip for unmapped columns
- Log warning when plan is in unmapped column
- Provide UI indicator in kanban for plans that failed to sync due to unmapped column
- Add "Fix mapping" quick action that opens setup panel to relevant section

**5. Runtime Column Addition Support**
- When user adds new custom agent column, detect change
- Prompt: "New column detected. Create ClickUp list for it?"
- Auto-create list or defer to manual setup

### Part 2: Event-Driven Automation Pipelines

### 1. Event Listener Layer
**ClickUp Webhook/Polled Listener**
- Listen for new tasks or task updates in specified lists
- Filter by tags (e.g., `bug`, `feasibility`, `data-analysis`)
- Polling fallback (since webhooks require external endpoint)
- Configurable: full board watch or specific lists

**Configuration**
```json
{
  "automationRules": [
    {
      "name": "Bug Triage",
      "trigger": {
        "type": "tag",
        "tag": "bug",
        "lists": ["Backlog", "To Do"]
      },
      "pipeline": "bug-investigation",
      "writeBack": {
        "target": "description",
        "format": "append"
      }
    }
  ]
}
```

### 2. Pipeline Definition Model
**Pipeline Templates**
- Define reusable automation workflows
- Each pipeline has internal Switchboard columns (invisible to ClickUp)
- Pipeline stages map to specific agents/tasks
- Example bug investigation pipeline:
  ```
  BUG_RECEIVED → BUG_ANALYSIS → ROOT_CAUSE → SOLUTION → COMPLETE
  (all internal, never exposed to ClickUp)
  ```

**Pipeline Configuration**
```json
{
  "pipelines": {
    "bug-investigation": {
      "stages": [
        { "name": "BUG_RECEIVED", "agent": "analyst" },
        { "name": "BUG_ANALYSIS", "agent": "coder" },
        { "name": "ROOT_CAUSE", "agent": "lead" },
        { "name": "SOLUTION", "agent": "coder" },
        { "name": "COMPLETE", "writeBack": true }
      ],
      "internalOnly": true
    }
  }
}
```

### 3. Ticket Write-Back Mechanism
**Write-Back Triggers**
- When pipeline reaches final stage marked with `writeBack: true`
- Configurable target: description, comments, custom fields
- Format options: append, prepend, replace

**Write-Back Content**
- Pipeline execution summary
- Agent outputs from each stage
- Final recommendations/results
- Metadata (duration, agents used)

### 4. Internal Kanban Model
**Separation of Concerns**
- Main kanban: User-visible, maps to ClickUp columns (existing behavior)
- Pipeline kanbans: Internal, invisible, per-pipeline column structures
- Database schema: Add `pipelineId` and `isInternal` flags to plans

**Plan Creation**
- When ClickUp event triggers, create plan with:
  - `sourceType: "clickup-automation"`
  - `pipelineId: "bug-investigation"`
  - `isInternal: true`
  - `clickupTaskId: "task_123"`
  - Internal column from pipeline definition

## Implementation Steps

### Phase 1: Flexible Column Mapping (Part 1)
1. **Modify ClickUpSyncService**
   - Add method `getActiveColumns()` that queries KanbanProvider for current structure
   - Update `setup()` to use dynamic column list instead of `CANONICAL_COLUMNS`
   - Add `updateColumnMappings()` to handle runtime column additions

2. **Update Setup Panel UI**
   - Add "Column Mappings" subsection in ClickUp setup
   - Render table of columns with mapping status
   - Add buttons to create/map/exclude columns

3. **Enhance KanbanProvider**
   - Add method to expose current column structure
   - Emit event when column structure changes

4. **Improve Error Handling**
   - Replace silent skip with logged warnings
   - Add visual indicator in kanban for sync failures
   - Add quick fix action

### Phase 2: Event Listener Infrastructure (Part 2)
1. Add `ClickUpAutomationService` class
2. Implement polling mechanism for new tasks (webhook later)
3. Add rule engine to match tickets against automation rules
4. Add configuration UI for defining automation rules

### Phase 3: Pipeline System (Part 2)
1. Create `PipelineDefinition` model and storage
2. Add pipeline template builder UI
3. Implement internal plan creation with pipeline association
4. Modify kanban to filter out internal plans from main view

### Phase 4: Write-Back Mechanism (Part 2)
1. Add `writeBack` handler to pipeline completion
2. Implement content formatting (summary, agent outputs)
3. Add ClickUp API calls to update task description/comments
4. Add error handling for write-back failures

### Phase 5: Pipeline Visibility (Part 2)
1. Add "Automation Pipelines" view in setup panel
2. Show active pipelines with progress
3. Allow manual intervention in stuck pipelines
4. Add pipeline history/log viewer

### Phase 6: Testing & Refinement
**For Part 1 (Column Mapping):**
- Test with custom agent columns
- Test mapping to existing ClickUp lists
- Test excluding columns from sync
- Test runtime column addition
- Verify backward compatibility with existing canonical-only setups

**For Part 2 (Automation Pipelines):**
- Test bug triage pipeline end-to-end
- Test feasibility analysis pipeline
- Test concurrent pipelines
- Add retry logic for failed write-backs
- Performance testing with high ticket volumes

## Files to Create
- `src/services/ClickUpAutomationService.ts`
- `src/services/PipelineManager.ts`
- `src/models/PipelineDefinition.ts`

## Files to Modify
**For Part 1 (Column Mapping):**
- `src/services/ClickUpSyncService.ts`
- `src/services/KanbanProvider.ts`
- `src/webview/setup.html`
- `src/services/SetupPanelProvider.ts`

**For Part 2 (Automation Pipelines):**
- `src/services/ClickUpSyncService.ts` (add automation methods)
- `src/services/KanbanDatabase.ts` (add pipeline fields)
- `src/services/KanbanProvider.ts` (filter internal plans)
- `src/webview/setup.html` (add pipeline configuration UI)
- `src/extension.ts` (register automation service)

## Backward Compatibility
- Existing column sync behavior unchanged (canonical columns still work)
- Internal plans excluded from main kanban by default
- Optional toggle to show internal plans for debugging
- Migration path: users opt-in to automation features
- Dynamic column mapping is opt-in (existing setups continue with canonical columns)

## Switchboard State

**Kanban Column:** CREATED
**Status:** active

## Reviewer-Executor Pass

### Stage 1 — Grumpy Principal Engineer
> **[MAJOR] Task-only dedupe is a design bug in a fake mustache.** The plan explicitly required dedupe on `clickup_task_id + pipeline_id`, but the automation poller was deduping on task ID alone. That means the first matching rule got to live and every additional configured pipeline for the same ClickUp task got strangled in the crib. You did not build “multiple automations”; you built “first come, first served.”
>
> **[MAJOR] Write-back selection was roulette, not determinism.** Final write-back was picking the first active rule for a pipeline at poll time instead of the rule that created the hidden plan. Reorder rules, tweak config, or add a second rule sharing the same pipeline, and the same finished plan could suddenly write to the wrong target with the wrong format. That is not automation. That is ticket vandalism with a scheduler.
>
> **[MAJOR] Internal plans were only half-hidden.** Active board queries filtered `is_internal`, but completed-plan queries did not. So the moment an internal pipeline got completed, the “hidden” card could stroll right back into user-visible completed surfaces wearing a cheap disguise. Spectacularly on-brand for a ghost-card bug.
>
> **[MAJOR] The pipeline engine is still mostly theatrical scenery.** `PipelineManager.advancePlan()` is referenced in the test and nowhere meaningful in runtime. So yes, the system can create hidden plans and, if something magically advances them, write back once. But an actual runtime stage executor/advancer is not wired here. Calling the end-to-end pipeline implementation “complete” is generous bordering on fiction.
>
> **[NIT] Verification had a banana peel in it.** These integration tests load from `out/`, so `npm run compile` alone does not validate the fresh test modules. Without `npm run compile-tests`, you are one stale build artifact away from congratulating yourself for testing yesterday’s code.

### Stage 2 — Balanced Synthesis
> Keep the structural work that is already solid: dynamic column mappings are persisted as arbitrary keys, setup/runtime state flows through the existing providers, unmapped vs excluded columns are surfaced, auto-pull/import reuses the shared plans directory, and active internal plans are already kept off the main board.
>
> Fix now: make automation dedupe pipeline-aware, bind write-back to the rule metadata captured when the internal plan is created, and filter internal plans out of completed queries as well as active ones. Add regression coverage for all three so the behavior cannot quietly slide back.
>
> Defer, but do not pretend it is done: there is still no real runtime stage progression path for the hidden pipelines. Until a production code path advances or executes those internal stages, the repo has automation-triggered plan creation plus write-back infrastructure, not a fully realized event-driven pipeline engine.

### Fixed Items Applied In This Reviewer Pass
- Updated `src/services/ClickUpAutomationService.ts` so ClickUp automation dedupe now keys on `clickup_task_id + pipeline_id`, allowing one task to create one internal plan per matched pipeline while still suppressing duplicate launches of the same pipeline.
- Updated `src/services/ClickUpAutomationService.ts` so write-back resolution now uses rule metadata persisted in the generated internal plan (`Automation Rule`, `Write-Back Target`, `Write-Back Format`) instead of whichever active rule happens to be first for a pipeline at poll time.
- Updated `src/services/KanbanDatabase.ts` so `getCompletedPlans()` excludes `is_internal` rows by default, keeping completed internal pipeline cards out of visible completed-board surfaces.
- Expanded `src/test/integrations/clickup/clickup-automation-service.test.js` to cover:
  - one internal plan per matched pipeline for the same ClickUp task,
  - deterministic write-back after rule-order changes,
  - exclusion of completed internal plans from visible completed queries.

### Files Changed In This Reviewer Pass
- `src/services/ClickUpAutomationService.ts`
- `src/services/KanbanDatabase.ts`
- `src/test/integrations/clickup/clickup-automation-service.test.js`
- `.switchboard/plans/flexible_clickup_column_mapping.md`

### Validation Results
- ✅ `npm run compile`
- ✅ `npm run compile-tests`
- ✅ `node src/test/integrations/clickup/clickup-sync-service.test.js`
- ✅ `node src/test/integrations/clickup/clickup-import-flow.test.js`
- ✅ `node src/test/integration-auto-pull-regression.test.js`
- ✅ `node src/test/integrations/clickup/clickup-automation-service.test.js`
- ⚠️ `npm run lint` currently fails before linting project files because ESLint 9 expects `eslint.config.(js|mjs|cjs)` while this repo is still configured with `.eslintrc.json`.

### Remaining Risks / Follow-Ups
- **MAJOR — Runtime pipeline progression is still not wired in production.** Internal ClickUp plans can be created and written back once they reach a terminal stage, but the reviewer pass found no runtime code path that advances those hidden stages outside of test code. This means the event listener and persistence layers exist, but a full end-to-end internal pipeline executor is still missing.
- **MANUAL VALIDATION NOT EXECUTED IN THIS PASS.** No live ClickUp workspace was exercised here, so setup UX, real list creation/reuse, and real write-back behavior against ClickUp APIs still need manual verification.
- **Tooling hygiene follow-up.** The repo lint script needs an ESLint 9-compatible config migration before `npm run lint` can serve as a reliable gate for future reviewer passes.

Success means any active workspace column can be intentionally mapped or excluded, while ClickUp-triggered internal pipelines remain hidden from the primary board and safely write results back to the originating task.

## Metadata

**Tags:** backend, database, UI, infrastructure
**Complexity:** 9

## User Review Required

> [!NOTE]
> - **Column review is required**: dynamic setup must let users confirm which active Switchboard columns create new ClickUp lists, reuse existing lists, or stay excluded.
> - **Existing setups must migrate safely**: preserve already-working canonical mappings in `.switchboard/clickup-config.json` and only ask users to review newly discovered columns.
> - **Automation is opt-in**: no ClickUp-triggered pipeline should run until the user explicitly saves one or more automation rules.
> - **Clarification:** initial listener delivery should use polling integrated with the existing integration scheduling path; this repo does not contain a hosted webhook receiver.

## Complexity Audit

### Routine
- **R1 — Config normalization in `src/services/ClickUpSyncService.ts`**: extend existing `ClickUpConfig` loading/saving so dynamic column mappings, excluded columns (represented as empty mappings), and automation definitions round-trip without breaking current config files.
- **R2 — Setup-panel plumbing in `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, and `src/services/TaskViewerProvider.ts`**: add UI state, message handlers, and save flows for mapping rows, bulk actions, and automation rule editors using the existing setup panel bridge.
- **R3 — Non-silent unmapped handling in `src/services/ClickUpSyncService.ts` + `src/webview/kanban.html`**: replace silent skip behavior with surfaced warnings and a "Fix mapping" entry point that reopens the ClickUp setup section.
- **R4 — Backward-compatible mapping migration**: merge existing canonical mappings with live column discovery rather than forcing users to rebuild the AI Agents folder or remap every list manually.

### Complex / Risky
- **C1 — Dynamic column discovery across live workspace structure**: current setup seeds from `CANONICAL_COLUMNS`. Converting setup, sync, auto-pull, and runtime drift detection to use the real current board/custom-agent column set must avoid circular dependencies and stale mapping state.
- **C2 — Internal automation pipeline persistence**: hidden ClickUp-triggered work needs schema support, dedupe identifiers, and board filtering so internal plans do not leak into the main board or trigger regular outbound sync paths incorrectly.
- **C3 — Event listener orchestration**: polling, auto-pull, move-sync, and plan-content push already touch ClickUp. Automation polling must reuse existing scheduling infrastructure and dedupe on task fingerprints to avoid duplicate pipeline launches and API rate spikes.
- **C4 — Write-back idempotency**: final pipeline summaries must append/replace task content exactly once per pipeline completion, handle retries, and avoid feedback loops when ClickUp task updates are themselves the polling source.

## Edge-Case & Dependency Audit

- **Race Conditions:** Mapping edits can overlap with card-move syncs, auto-pull imports, and plan-content push updates. The implementation must load the latest ClickUp config before each sync/write-back, use dedupe keys for automation triggers, and ensure runtime column detection prompts only once per newly discovered column set.
- **Security:** Continue storing the ClickUp token only in VS Code SecretStorage. Do not write tokens into `clickup-config.json`, pipeline logs, or ClickUp write-back comments. Sanitize write-back payloads the same way current task descriptions are sanitized and keep internal-only notes out of user-visible task fields unless explicitly configured.
- **Side Effects:** This plan can create additional ClickUp lists for newly mapped columns, create internal pipeline plans that should stay hidden from the main board, and add background polling/write-back traffic. Existing users may see new setup prompts for previously unmapped columns after upgrading.
- **Dependencies & Conflicts:**
  - **Active Kanban scan (`switchboard-get_kanban_state`)**: no direct dependency or likely conflict with `Investigate Completion and Archival Workflows` (New), `Investigate Completed Column Disappearance and Phantom Auto-Archive` (Planned), or `Fix Gitignore Rules for workspace-id` (Planned). Those active cards target archival or gitignore behavior, not ClickUp integration files.
  - **Historical ClickUp baseline (relevant, but not active conflict)**: `clickup_1_foundation.md`, `clickup_2_setup_flow.md`, `clickup_3_sync_on_move.md`, `clickup_import_pull_tasks.md`, and `clickup_push_plan_content_to_tasks.md` already established the current ClickUp service, setup panel flow, sync-on-move, import, and content push behavior. This plan must extend those exact paths without regressing them.
  - **Likely implementation dependency**: reuse current setup-panel kanban structure data from `TaskViewerProvider.handleGetKanbanStructure()` and current integration scheduling from `KanbanProvider.initializeIntegrationAutoPull()` / `src/services/IntegrationAutoPullService.ts` rather than introducing disconnected discovery or timer systems.

## Adversarial Synthesis

### Grumpy Critique

1. This plan used to mash two broad features together and hand-wave the handoff between "dynamic columns" and the actual code. If `ClickUpSyncService` still seeds anything important from `CANONICAL_COLUMNS`, custom columns will keep disappearing during setup, sync, or auto-pull no matter how nice the UI looks.
2. Hidden pipelines are a footgun unless schema, filtering, and write-back idempotency are specified together. If internal plans leak into the visible board or the same ClickUp update re-triggers the same automation run, users will get duplicate work, duplicate comments, and no clue which state is authoritative.
3. Polling, auto-pull, move-sync, and plan-content push already create enough ClickUp traffic. Add one more listener without a single dedupe/failure surface and you'll hit 429s, create partial state, and force someone to debug five different "almost the same" sync paths.

### Balanced Response

1. The plan now anchors column discovery to the existing setup-panel kanban-structure data path (`TaskViewerProvider` → `SetupPanelProvider` → `setup.html`) and requires `ClickUpSyncService` to consume discovered columns as explicit inputs, so setup/sync logic no longer depends on canonical columns except as a migration fallback.
2. Internal automation is constrained by explicit persistence changes in `KanbanDatabase.ts`, hidden-plan filtering in `KanbanProvider.ts`, and idempotent task fingerprint / pipeline-completion tracking in the new automation service. That keeps internal work isolated and prevents repeated launch/write-back loops.
3. Automation polling is explicitly folded into the existing integration scheduling path and outbound ClickUp updates continue to flow through the current ClickUp service utilities. This reduces the number of competing timers and gives one place to surface sync/mapping errors back to the UI.

## Proposed Changes

> [!IMPORTANT]
> Preserve the original scope exactly: (1) flexible mapping of real Switchboard columns to ClickUp lists and (2) ClickUp-triggered internal automation pipelines with write-back. Do not expand this into generic workflow productization beyond the use cases and pipeline model already described below.

### Preserved Use Cases

#### Bug Triage Pipeline
- **Trigger**: New ClickUp ticket tagged with `bug` or added to specific list
- **Process**: Switchboard creates investigation pipeline (not visible in ClickUp)
- **Result**: AI investigates bug, writes findings back to ticket description/comments
- **Columns**: Internal only - never synced to ClickUp

#### Feasibility Analysis Pipeline
- **Trigger**: New roadmap item or ticket tagged with `feasibility`
- **Process**: Switchboard runs technical analysis, risk assessment
- **Result**: Updates ticket with technical approach, risk score, implementation estimate
- **Columns**: Internal only - never synced to ClickUp

#### Data Analysis Pipeline
- **Trigger**: Data request tickets tagged with `data-analysis`
- **Process**: Switchboard runs data queries, generates insights
- **Result**: Appends analysis results to ticket
- **Columns**: Internal only - never synced to ClickUp

#### Flexible Column Sync (Original Requirement)
- **Use case**: Teams with custom agent columns want bidirectional sync to ClickUp
- **Current limitation**: Only 8 hardcoded canonical columns get ClickUp lists
- **Desired behavior**: Any column in kanban can be mapped to a ClickUp list
- **Setup wizard**: Should discover current columns and offer mapping options

### Preserved Core Architecture

#### Part 1: Flexible Column Mapping

##### Problem
Current implementation:
- Only 8 hardcoded canonical columns (CREATED, BACKLOG, PLAN REVIEWED, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED) get ClickUp lists created during setup
- Custom agent columns don't get ClickUp lists
- Plans in unmapped columns are silently skipped during sync
- Users cannot configure which columns should sync to ClickUp

##### Solution

**1. Dynamic Column Discovery**
- Replace setup-time iteration over `CANONICAL_COLUMNS` in `src/services/ClickUpSyncService.ts` with the current workspace column structure already available via `TaskViewerProvider.handleGetKanbanStructure()` and setup-panel state.
- Feed the discovered column list into setup/save flows so `ClickUpSyncService.setup(...)` creates or reuses lists for the actual active columns in the workspace.
- **Clarification:** keep canonical columns as a migration fallback for old configs only; do not let them remain the source of truth once live columns are known.

**2. Column Mapping Configuration**
- Add UI in `src/webview/setup.html` to view/edit column mappings.
- Allow users to:
  - Map existing Switchboard columns to existing ClickUp lists
  - Create new ClickUp lists for unmapped columns
  - Exclude specific columns from sync
- Store mappings in `clickup-config.json` with structure:
  ```json
  {
    "columnMappings": {
      "CREATED": "list_id_1",
      "BACKLOG": "list_id_2",
      "Custom Agent Column": "list_id_3"
    }
  }
  ```

**3. Setup Flow Enhancement**
- After selecting a space, show current kanban columns sourced from the live setup-panel structure.
- For each column, offer options:
  - "Create new list" (default for unmapped)
  - "Map to existing list" (dropdown of available lists)
  - "Exclude from sync" (checkbox / empty mapping)
- Allow bulk actions: "Create lists for all unmapped columns"

**4. Sync Behavior Update**
- Remove silent skip for unmapped columns
- Log warning when plan is in unmapped column
- Provide UI indicator in kanban for plans that failed to sync due to unmapped column
- Add "Fix mapping" quick action that opens setup panel to the ClickUp mapping section

**5. Runtime Column Addition Support**
- When user adds new custom agent column, detect change by comparing live kanban structure with saved ClickUp mapping keys
- Prompt: "New column detected. Create ClickUp list for it?"
- Auto-create list or defer to manual setup

#### Part 2: Event-Driven Automation Pipelines

##### 1. Event Listener Layer
**ClickUp Webhook/Polled Listener**
- Listen for new tasks or task updates in specified lists
- Filter by tags (e.g., `bug`, `feasibility`, `data-analysis`)
- Polling fallback (since webhooks require external endpoint)
- Configurable: full board watch or specific lists
- **Clarification:** first implementation should use polling only, wired through the existing integration scheduling path, with webhook support deferred until the repo actually has an endpoint story.

**Configuration**
```json
{
  "automationRules": [
    {
      "name": "Bug Triage",
      "trigger": {
        "type": "tag",
        "tag": "bug",
        "lists": ["Backlog", "To Do"]
      },
      "pipeline": "bug-investigation",
      "writeBack": {
        "target": "description",
        "format": "append"
      }
    }
  ]
}
```

##### 2. Pipeline Definition Model
**Pipeline Templates**
- Define reusable automation workflows
- Each pipeline has internal Switchboard columns (invisible to ClickUp)
- Pipeline stages map to specific agents/tasks
- Example bug investigation pipeline:
  ```
  BUG_RECEIVED → BUG_ANALYSIS → ROOT_CAUSE → SOLUTION → COMPLETE
  (all internal, never exposed to ClickUp)
  ```

**Pipeline Configuration**
```json
{
  "pipelines": {
    "bug-investigation": {
      "stages": [
        { "name": "BUG_RECEIVED", "agent": "analyst" },
        { "name": "BUG_ANALYSIS", "agent": "coder" },
        { "name": "ROOT_CAUSE", "agent": "lead" },
        { "name": "SOLUTION", "agent": "coder" },
        { "name": "COMPLETE", "writeBack": true }
      ],
      "internalOnly": true
    }
  }
}
```

##### 3. Ticket Write-Back Mechanism
**Write-Back Triggers**
- When pipeline reaches final stage marked with `writeBack: true`
- Configurable target: description, comments, custom fields
- Format options: append, prepend, replace

**Write-Back Content**
- Pipeline execution summary
- Agent outputs from each stage
- Final recommendations/results
- Metadata (duration, agents used)

##### 4. Internal Kanban Model
**Separation of Concerns**
- Main kanban: User-visible, maps to ClickUp columns (existing behavior)
- Pipeline kanbans: Internal, invisible, per-pipeline column structures
- Database schema: Add `pipelineId` and `isInternal` flags to plans

**Plan Creation**
- When ClickUp event triggers, create plan with:
  - `sourceType: "clickup-automation"`
  - `pipelineId: "bug-investigation"`
  - `isInternal: true`
  - `clickupTaskId: "task_123"`
  - Internal column from pipeline definition

### Routine Track (Low-Complexity / Low-Risk)

#### R1. Normalize dynamic mapping data without breaking current configs
##### MODIFY `src/services/ClickUpSyncService.ts`
- **Context:** `_normalizeConfig()`, `setup()`, `syncPlan()`, `syncColumn()`, and auto-pull-related consumers currently assume `columnMappings` was seeded from canonical columns.
- **Logic:**
  1. Add a helper that merges discovered live columns with existing saved mappings so legacy configs keep their current canonical IDs.
  2. Keep excluded columns as explicit empty mappings so sync/import logic can distinguish "known but intentionally excluded" from "new and unreviewed".
  3. Extend setup/save inputs to accept discovered columns and user mapping decisions rather than creating every list blindly.
  4. Update unmapped-column handling to return a surfaced warning state instead of a silent success.
- **Edge Cases Handled:** legacy `clickup-config.json` files missing new fields; saved mappings for columns that no longer exist; duplicate ClickUp list IDs reused intentionally for multiple columns only when the user explicitly chose that mapping.

#### R2. Turn the setup panel into a real mapping editor
##### MODIFY `src/webview/setup.html`
##### MODIFY `src/services/SetupPanelProvider.ts`
##### MODIFY `src/services/TaskViewerProvider.ts`
- **Context:** the setup UI currently shows only a token field and a single `SETUP CLICKUP` button.
- **Logic:**
  1. Reuse the existing `kanbanStructure` payload already posted into the setup panel to render current columns and statuses.
  2. Add a ClickUp mapping subsection with one row per live column, current mapping status, create/reuse/exclude controls, and bulk actions.
  3. Expand the message contract so the webview can request current mapping state, existing ClickUp lists, save mapping decisions, and reopen directly to this subsection after sync errors.
  4. Keep `SetupPanelProvider` as a thin message bridge; keep orchestration/state loading in `TaskViewerProvider`.
- **Edge Cases Handled:** setup panel opened before ClickUp token is saved; mapping editor reopened mid-setup; stale setup state after external config changes.

#### R3. Surface mapping failures and repair paths in the board UI
##### MODIFY `src/services/ClickUpSyncService.ts`
##### MODIFY `src/services/KanbanProvider.ts`
##### MODIFY `src/webview/kanban.html`
- **Context:** the current sync path logs a console message and pretends success when a card lands in an unmapped column.
- **Logic:**
  1. Track last unmapped column / sync warning state alongside the existing `clickupState` messaging used for setup and sync-error visibility.
  2. When a move or content push hits an unmapped column, expose a visible ClickUp warning state in the board UI.
  3. Wire the "Fix mapping" action to open `project-mgmt` and focus the ClickUp subsection rather than leaving the user to infer what failed.
- **Edge Cases Handled:** multiple unmapped columns discovered in one session; warning cleared once mapping is repaired; warning should not overwrite genuine auth/network sync errors.

#### R4. Keep existing import, push, and auto-pull behavior compatible
##### MODIFY `src/services/ClickUpSyncService.ts`
##### MODIFY `src/services/KanbanProvider.ts`
- **Context:** current auto-pull/import logic iterates over `Object.values(config.columnMappings)` and current push flows assume outbound sync only cares about mapped lists.
- **Logic:**
  1. Ensure empty mappings are filtered consistently so excluded columns do not create bogus import loops.
  2. Preserve current import and plan-content push behavior for already mapped lists.
  3. Make migration a no-op for users who never add custom columns or automation rules.
- **Edge Cases Handled:** config with empty-string mappings; repeated setup after initial canonical-only install; boards with no ClickUp-mapped columns after deliberate exclusions.

### Complex / Risky Track

#### C1. Detect runtime column drift and prompt once
##### MODIFY `src/services/KanbanProvider.ts`
##### MODIFY `src/services/TaskViewerProvider.ts`
##### MODIFY `src/services/ClickUpSyncService.ts`
- **Context:** custom agent columns can appear after initial setup, and the plan explicitly requires a prompt to create lists for newly added columns.
- **Logic:**
  1. Compare the live setup-kanban structure against saved ClickUp mapping keys whenever setup state is posted or the visible/custom-agent structure changes.
  2. Record a "new columns pending review" state so the UI can prompt once per newly detected set rather than on every refresh.
  3. Offer two explicit actions: auto-create ClickUp lists for the new columns or defer and leave them excluded/unmapped until the user revisits setup.
- **Edge Cases Handled:** renamed columns versus brand-new columns; workspace switching; repeated prompts after VS Code reload; users who intentionally exclude a column and should not be nagged again immediately.

#### C2. Add a ClickUp automation listener and rule engine
##### CREATE `src/services/ClickUpAutomationService.ts`
##### MODIFY `src/services/ClickUpSyncService.ts`
##### MODIFY `src/services/TaskViewerProvider.ts`
##### MODIFY `src/webview/setup.html`
##### MODIFY `src/extension.ts`
- **Context:** the repo currently supports ClickUp setup, outbound sync, content push, and import, but not ClickUp-triggered automation rules.
- **Logic:**
  1. Extend the ClickUp config model to persist `automationRules` and `pipelines` using the shapes preserved above.
  2. Implement a polling listener that fetches watched lists/tasks, filters by rule trigger, and deduplicates on task ID + last updated fingerprint.
  3. Register and dispose the automation service from extension startup using the same workspace/service lifecycle as existing ClickUp services.
  4. Reuse current ClickUp HTTP/token utilities instead of duplicating API clients.
- **Edge Cases Handled:** task edited twice between polls; closed tasks or tasks already tagged as handled; polling disabled when ClickUp is not configured; token revoked mid-session.

#### C3. Persist and hide internal pipeline work safely
##### CREATE `src/models/PipelineDefinition.ts`
##### CREATE `src/services/PipelineManager.ts`
##### MODIFY `src/services/KanbanDatabase.ts`
##### MODIFY `src/services/KanbanProvider.ts`
- **Context:** internal-only pipeline plans need durable storage and must stay invisible on the main board.
- **Logic:**
  1. Add schema support for `pipelineId`, `isInternal`, and `clickupTaskId` (or equivalent explicit identifiers) plus any necessary migration SQL.
  2. Extend plan record typing so `sourceType` can represent ClickUp automation-created plans without overloading existing local/brain semantics.
  3. Create a manager that instantiates pipeline stages as internal plans, advances them, and hands off to the correct agents/stages.
  4. Update board refresh/filter logic so internal plans are excluded from the main kanban and from normal outbound ClickUp list-sync behavior.
- **Edge Cases Handled:** reopened/edited ClickUp ticket should update the same pipeline rather than create a second one; internal plans should not be imported back as user-visible work; archived/completed internal runs should not pollute normal board counts.

#### C4. Make write-back explicit, idempotent, and recoverable
##### MODIFY `src/services/ClickUpAutomationService.ts`
##### MODIFY `src/services/PipelineManager.ts`
##### MODIFY `src/services/ClickUpSyncService.ts`
- **Context:** the feature promise includes writing investigation/analysis results back to the originating ClickUp task.
- **Logic:**
  1. When a pipeline reaches a stage with `writeBack: true`, compose a deterministic summary from stage outputs, duration, and metadata.
  2. Support `append`, `prepend`, and `replace` behaviors exactly as defined in the saved rule.
  3. Persist a completion/write-back fingerprint so retries or repolls do not duplicate the same summary/comment/custom-field update.
  4. Route all ClickUp writes through the shared ClickUp service utilities for retry/backoff and consistent auth/error behavior.
- **Edge Cases Handled:** partial write-back failure after pipeline success; task deleted or moved in ClickUp during pipeline execution; comment/description target unavailable; retry after temporary 429/5xx response.

#### C5. Add automation visibility and manual intervention controls without exposing internal columns
##### MODIFY `src/webview/setup.html`
##### MODIFY `src/services/SetupPanelProvider.ts`
##### MODIFY `src/services/TaskViewerProvider.ts`
- **Context:** the original scope includes an "Automation Pipelines" view, progress display, stuck-pipeline intervention, and history/log visibility.
- **Logic:**
  1. Add an automation subsection in the setup panel for rule editing, pipeline template editing, active-run status, and last write-back result.
  2. Expose only pipeline summaries/status there; do not reuse the main kanban columns for internal pipeline visualization.
  3. Provide a manual retry / reopen path for failed write-backs or stuck stages through the setup panel, not the main board.
- **Edge Cases Handled:** multiple pipelines active for different ClickUp tasks; user opens setup mid-run; failed pipeline resumed after config edit.

### Implementation Phases

#### Phase 1: Flexible Column Mapping (Part 1)
1. **Modify ClickUpSyncService**
   - Add live-column merge logic so setup and sync use discovered columns instead of only `CANONICAL_COLUMNS`.
   - Update `setup()` to accept/setup mappings from the current workspace column structure.
   - Add/update helper(s) for mapping repair and runtime column additions.
2. **Update Setup Panel UI**
   - Add a "Column Mappings" subsection in `src/webview/setup.html`.
   - Render a table/list of columns with mapping status and create/map/exclude controls.
   - Add bulk actions and reopen-to-fix behavior.
3. **Enhance KanbanProvider / TaskViewerProvider**
   - Reuse existing kanban-structure discovery for ClickUp setup state.
   - Detect newly introduced columns and surface a single review prompt.
4. **Improve Error Handling**
   - Replace silent skip with logged warnings + surfaced UI state.
   - Add a visual indicator in the kanban and a quick-fix action.

#### Phase 2: Event Listener Infrastructure (Part 2)
1. Create `src/services/ClickUpAutomationService.ts`.
2. Implement polling for new/updated tasks (webhook later).
3. Add rule matching against configured tags/lists.
4. Add configuration UI for defining automation rules.

#### Phase 3: Pipeline System (Part 2)
1. Create `src/models/PipelineDefinition.ts` and `src/services/PipelineManager.ts`.
2. Add pipeline template editing in the setup panel.
3. Implement internal plan creation with pipeline association and ClickUp task linkage.
4. Modify kanban refresh/filtering so internal plans stay off the main board.

#### Phase 4: Write-Back Mechanism (Part 2)
1. Add a `writeBack` handler to pipeline completion.
2. Implement content formatting (summary, agent outputs, metadata).
3. Add ClickUp API calls to update task description/comments/custom fields.
4. Add retry/dedupe handling for write-back failures.

#### Phase 5: Pipeline Visibility (Part 2)
1. Add an "Automation Pipelines" view in the setup panel.
2. Show active pipelines with progress/status.
3. Allow manual intervention in stuck pipelines.
4. Add pipeline history/log visibility.

#### Phase 6: Testing & Refinement
**For Part 1 (Column Mapping):**
- Test with custom agent columns.
- Test mapping to existing ClickUp lists.
- Test excluding columns from sync.
- Test runtime column addition.
- Verify backward compatibility with existing canonical-only setups.

**For Part 2 (Automation Pipelines):**
- Test bug triage pipeline end-to-end.
- Test feasibility analysis pipeline.
- Test concurrent pipelines.
- Add retry logic for failed write-backs.
- Performance test with higher ticket volumes and repeated poll cycles.

### Files to Create
- `src/services/ClickUpAutomationService.ts`
- `src/services/PipelineManager.ts`
- `src/models/PipelineDefinition.ts`

### Files to Modify
**For Part 1 (Column Mapping):**
- `src/services/ClickUpSyncService.ts`
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/SetupPanelProvider.ts`
- `src/webview/setup.html`
- `src/webview/kanban.html`

**For Part 2 (Automation Pipelines):**
- `src/services/ClickUpSyncService.ts` (shared ClickUp API/config utilities and write-back helpers)
- `src/services/KanbanDatabase.ts`
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/SetupPanelProvider.ts`
- `src/webview/setup.html`
- `src/extension.ts`

### Backward Compatibility
- Existing column sync behavior continues for users who only use canonical columns.
- Existing mapped lists in `.switchboard/clickup-config.json` are preserved and only supplemented with new live columns.
- Internal plans remain excluded from the main kanban by default.
- Optional debugging visibility for internal plans should remain a follow-up/controlled toggle, not the default behavior.
- Dynamic column mapping and automation pipelines remain opt-in enhancements over the current ClickUp setup.

## Verification Plan

### Automated Tests
- Run `npm run lint`.
- Run `npm run compile`.
- Run `npm run compile-tests`.
- Run `npm test`.
- Run `npm run test:integration:clickup` when a ClickUp test token/workspace is available for the existing integration harness.

### Manual Verification Steps
1. Start from an existing canonical-only ClickUp config and confirm setup preserves current mappings while surfacing any newly discovered custom columns.
2. Add a custom agent column, reopen setup, and verify the new column can be created, mapped to an existing list, or excluded.
3. Move a plan into an unmapped column and confirm the kanban shows a ClickUp warning with a working "Fix mapping" path.
4. Verify auto-pull/import still only scans mapped list IDs and does not choke on excluded columns.
5. Create a ClickUp ticket matching a saved automation rule (`bug`, `feasibility`, or `data-analysis`) and confirm:
   - one internal pipeline run is created,
   - it stays hidden from the main board,
   - it progresses through internal stages,
   - write-back updates the originating ClickUp task exactly once.
6. Repeat the same task update twice and confirm dedupe prevents duplicate pipeline launches/write-backs.
7. Break auth or force a 429/5xx scenario and confirm sync/pipeline errors surface visibly without corrupting saved mappings or duplicating work.

## Agent Recommendation

**Send to Lead Coder** — Complexity 9. This spans existing ClickUp services, setup-panel orchestration, kanban filtering, persistence, and new automation/write-back infrastructure, so it needs coordinated architectural ownership rather than a narrow one-file implementation.

## Switchboard State

**Kanban Column:** CREATED
**Status:** active
