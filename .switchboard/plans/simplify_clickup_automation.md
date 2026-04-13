# Simplify ClickUp Automation

## Goal
Remove the overengineered hidden-pipeline layer and replace it with a flat ClickUp -> visible Switchboard plan workflow that uses existing Kanban columns and one final write-back hook. Keep the change constrained to ClickUp automation simplification; do not introduce new Kanban concepts, new storage locations, or new non-ClickUp behaviors.

## Metadata
**Tags:** backend, database, UI
**Complexity:** 7

## User Review Required
> [!NOTE]
> - Treat the current ClickUp automation experiment as disposable. If any workspace or test fixture still contains nested pipeline config or hidden pipeline records from today's implementation, delete that state and rebuild from scratch instead of migrating it.
> - If it is simpler during implementation, treat the current automation layer as throwaway: remove the pipeline code/UI/tests first, then build the flat-rule version fresh.
> - **Clarification:** Use the existing ClickUp setup panel (`src/webview/setup.html`), existing ClickUp config file (`.switchboard/clickup-config.json`), existing plan ingestion folder resolution (`TaskViewerProvider.getPlanIngestionFolder()`), and existing integration auto-pull timer (`IntegrationAutoPullService`). Do not add parallel storage or setup flows.
> - **Clarification:** Automation-created plans should remain visible on the main Kanban board. If the runtime still needs to identify them for write-back, use persisted metadata such as `sourceType: 'clickup-automation'`, `ClickUp Task ID`, and `Automation Rule`, but do not mark them `isInternal`.
> - **Clarification:** When multiple flat rules match one ClickUp task, choose the first enabled rule in saved order and log the overlap; do not recreate the old one-task-to-many-pipelines behavior.
> - **Recommended Agent:** Send to Lead Coder

## Complexity Audit
### Routine
- Flatten the setup payload from `automationRules + pipelines` to rules-only in `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, and `src/webview/setup.html`.
- Remove `PipelineManager` construction and imports from `src/services/KanbanProvider.ts`.
- Keep the existing `clickup-automation` timer slot in `src/services/IntegrationAutoPullService.ts` unchanged; only swap the service logic behind it.
- Rewrite the ClickUp automation regression test to assert one visible plan per task and one write-back path.
- Preserve the current manual ClickUp import path and current write-back helper in `src/services/ClickUpSyncService.ts`.

### Complex / Risky
- Replace the nested pipeline model outright with a flat rule model, with no migration layer and no support code for the discarded design.
- Prevent duplicate ClickUp tasks when visible automation-created plans later sync through normal `ClickUpSyncService.syncPlan()` by honoring stored `clickupTaskId` first.
- Replace direct DB hidden-plan creation with file-first ingestion while still guaranteeing dedupe before `PlanFileImporter` has processed the new file.
- Distinguish automation-created visible plans from ordinary ClickUp-imported plans without relying on hidden/internal branches.
- Make final write-back trigger off the configured `finalColumn`, not generic completion status, so it stays stable if the concurrent "Restore Completed Column Visibility and Preserve Completed Status" work changes `COMPLETED` semantics.

## Edge-Case & Dependency Audit
- **Race Conditions:** Automation polling can re-see a matching ClickUp task before `PlanFileImporter` registers the newly written file. The creation path needs both a deterministic filename check and a DB `findPlanByClickUpTaskId()` check. A user can also move a newly created automation plan before the next automation poll; `ClickUpSyncService.syncPlan()` must use `plan.clickupTaskId` if present, otherwise the first move creates a duplicate ClickUp task. Final write-back must be idempotent across repeated polls, so reuse `lastAction === 'clickup_writeback_complete'` or an equally explicit persisted marker.
- **Security:** Keep ClickUp tokens in VS Code `SecretStorage` only. Do not log request bodies containing plan content, and keep existing authenticated REST calls centralized in `src/services/ClickUpSyncService.ts`.
- **Side Effects:** Visible automation-created plans will now participate in the same Kanban board and potentially the same normal ClickUp sync path as other plans. That is intentional, but only if task linkage is direct and duplication-safe. This plan intentionally discards today's experimental hidden-pipeline config/data rather than preserving it.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` returned no direct file-level conflict with the active `Fix Terminal Disconnect on Minimize` plan or the two opaque `Imported Plan` cards in **New**. The only active plan with plausible semantic overlap is `restore_completed_column_visibility_and_preserve_completed_status.md` in **Planned**, because this simplification frequently uses `COMPLETED` as a likely `finalColumn`; write-back must therefore key off the rule's stored `finalColumn`, not `status === completed` alone. Historical, same-area plans in `.switchboard/plans/` are relevant prior art rather than active blockers: `flexible_clickup_column_mapping.md` is the exact design being simplified, `clickup_3_sync_on_move.md` and `clickup_push_plan_content_to_tasks.md` define the existing sync/write-back surfaces that should be reused, and `clickup_import_pull_tasks.md` is the cleanest reference for file-first visible plan creation. The active `Imported Plan` cards do not expose enough metadata in Kanban state to prove or disprove ClickUp overlap, and no matching ClickUp-focused filenames in `.switchboard/plans/` were found for those entries.

## Adversarial Synthesis
### Grumpy Critique
> Oh, marvelous - a "simple" refactor that only touches config normalization, plan creation, task linkage, the setup UI, the auto-pull scheduler, and write-back semantics. What could possibly go wrong? The original draft talks as if deleting `PipelineManager.ts` automatically deletes the complexity. It does not. Right now the codebase uses three different facts in one tangled knot: "this came from ClickUp," "this should stay hidden," and "this should write back at the end." If you rip out the stage graph without choosing one canonical creation path, you will either keep a secret DB-only ingestion path in disguise or spray duplicate markdown files into `.switchboard/plans/`.
>
> And the biggest landmine is not even the pipeline UI - it is `ClickUpSyncService.syncPlan()`. If a visible automation-created plan still carries the originating `clickupTaskId`, but sync logic keeps looking up tasks only by `planId`, the first time a user drags that card you create a second ClickUp task and call it "automation." That is not automation; that is ticket mitosis. Also, the draft hand-waves away rule persistence while simultaneously demanding "use the rule that triggered creation." Pick one. Either persist a minimal rule identifier, or stop promising deterministic final write-back after the user edits the setup panel.
>
> Finally, if write-back fires off generic completion state instead of the configured `finalColumn`, the concurrent completed-column work will roast this feature alive. Simplicity is not the absence of code; it is one canonical path with one canonical source of truth.

### Balanced Response
> The simplification becomes real only if the implementation chooses one end-to-end path and carries that decision through every layer. The updated plan does that: new automation-triggered plans are created through the existing plan-ingestion flow as visible markdown plans, tagged at import time with `sourceType: 'clickup-automation'` but not `isInternal`. `ClickUpSyncService.syncPlan()` is explicitly updated to honor `plan.clickupTaskId` first so visible automation plans update the originating task instead of creating duplicates. Final write-back remains deterministic by keeping minimal persisted metadata (`ClickUp Task ID` plus `Automation Rule`) and triggering only when the plan reaches the configured `finalColumn`. The old hidden pipeline state machine is removed outright, and the same-day experimental config/data behind it is discarded rather than migrated.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Treat the sections below as the authoritative execution order. The preserved original plan material later in this file remains useful context, but any ambiguity should be resolved in favor of the exact file paths and runtime behaviors listed here.

### Low-Complexity / Routine Implementation Steps
1. Flatten the setup payload in `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, and `src/webview/setup.html` from nested `automationRules + pipelines` to a flat rules list that maps **tag -> starting column -> final column -> write-back enabled**.
2. Keep the `clickup-automation` scheduler slot in `src/services/KanbanProvider.ts`; only remove the `PipelineManager` dependency and swap in the simplified automation service signature.
3. Preserve the existing authenticated ClickUp client and write-back helper in `src/services/ClickUpSyncService.ts` instead of building new REST plumbing.
4. Update the ClickUp automation tests so they assert one visible plan per task, not one hidden plan per matched pipeline.
5. Preserve normal manual ClickUp imports as `sourceType: 'local'`; only automation-created files should register as `sourceType: 'clickup-automation'`.

### High-Complexity / Complex / Risky Implementation Steps
1. Replace `src/models/PipelineDefinition.ts` and the ClickUp automation config contract outright with the flat rule model; do not add a migration or fallback layer for the discarded nested pipeline design.
2. Replace `PipelineManager`'s hidden direct DB plan creation with file-first plan creation in `src/services/ClickUpAutomationService.ts`, using deterministic filenames and embedded metadata so dedupe survives restarts and importer timing.
3. Update `src/services/ClickUpSyncService.ts` so visible automation-created plans use `clickupTaskId` as the canonical existing-task link. Without this, the normal sync-on-move path duplicates the originating ClickUp task.
4. Distinguish automation-created visible plans from ordinary ClickUp imports using `sourceType: 'clickup-automation'` in `src/services/PlanFileImporter.ts`, not `isInternal`.
5. Trigger final write-back only when `plan.kanbanColumn === rule.finalColumn` and `writeBackOnComplete === true`, then mark the plan with `lastAction = 'clickup_writeback_complete'` so repeated polls do not spam ClickUp.

### Clarification - Prefer deletion over migration
- `src/services/KanbanDatabase.ts`: if clickup-only hidden-plan state (`pipeline_id`, `is_internal`, old helper branches, or old query filters) gets in the way, remove it or leave it unused, but do not add migration code or runtime preservation paths for the discarded implementation.
- `src/services/IntegrationAutoPullService.ts`: keep the shared timer service unchanged.
- `src/extension.ts`: no direct ClickUp automation orchestration lives here today; the runtime wiring is already owned by `src/services/KanbanProvider.ts`.

### Automation rule model
#### [MODIFY] `src/models/PipelineDefinition.ts`
- **Context:** This file currently defines the entire nested pipeline model (`ClickUpPipelineDefinition`, stage helpers, default pipelines, nested trigger objects, write-back target/format abstraction). That is the abstraction the simplification plan is removing, but multiple files already import this path, so deleting the file outright would create churn for no product value.
- **Logic:**
  1. Keep the file path but collapse it to the flat automation rule model.
  2. Replace nested `trigger`, `pipeline`, and stage definitions with a flat rule shape.
  3. Keep `matchesClickUpAutomationRule()` and rule normalization in this file so `src/services/ClickUpSyncService.ts`, `src/services/TaskViewerProvider.ts`, and `src/webview/setup.html` all continue to rely on one shared contract.
  4. Make normalization strict for the new flat rule shape only. Unsupported nested pipeline config is intentionally out of scope and should be discarded rather than translated.
  5. Remove default pipelines and stage helper exports entirely.
- **Implementation:**
  - Replace the exported automation rule contract with a flat shape along the lines of:
    ```typescript
    export interface ClickUpAutomationRule {
        name: string;
        enabled?: boolean;
        triggerTag: string;
        triggerLists: string[];
        targetColumn: string;
        finalColumn: string;
        writeBackOnComplete: boolean;
    }
    ```
  - Keep a shared matcher with the same external role:
    ```typescript
    export function matchesClickUpAutomationRule(
        task: { tags?: Array<{ name?: string }> } | null | undefined,
        listId: string,
        rule: ClickUpAutomationRule
    ): boolean
    ```
  - Keep a flat-rule normalizer only:
    ```typescript
    export function normalizeClickUpAutomationRules(
        rawRules: unknown
    ): ClickUpAutomationRule[]
    ```
  - Remove exports that only exist to support the stage graph: `ClickUpPipelineStageDefinition`, `ClickUpPipelineDefinition`, `ClickUpPipelineMap`, `DEFAULT_CLICKUP_PIPELINES`, `getPipelineInitialStage`, `getPipelineNextStage`, and `getPipelineWriteBackStage`.
- **Edge Cases Handled:** Flat rules become the only runtime contract; old nested config is intentionally unsupported; all other files keep importing the same model path without a repo-wide rename.

### ClickUp config, existing-task linkage, and write-back reuse
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** This service already owns ClickUp config I/O, setup, import, sync-on-move, and the write-back HTTP helper. The simplification must reuse this service instead of inventing a second client. It also currently has the exact duplicate-ticket bug vector: visible automation-created plans would not reuse `clickupTaskId`.
- **Logic:**
  1. Remove `pipelines` from the public `ClickUpConfig` shape and from persisted writes.
  2. During config load, parse only the new flat-rule array. Do not read, translate, or preserve the discarded nested pipeline shape.
  3. Simplify `saveAutomationSettings()` so it accepts only `ClickUpAutomationRule[]`.
  4. Delete the hidden-pipeline skip branch from `syncPlan()`. The simplified feature has no hidden plans. Use `plan.clickupTaskId` as the first-choice existing task ID before `_findTaskByPlanId(plan.planId, config)`.
  5. Keep `writeBackAutomationResult()` as the sole write-back transport. The simplification should not fork comment/description update logic into the automation service.
  6. Keep `importTasksFromClickUp()` skipping automation-handled tasks via `matchesClickUpAutomationRule()`, but feed it the flat rule shape.
- **Implementation:**
  - Update the config interface to:
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
      pullIntervalMinutes: AutoPullIntervalMinutes;
      automationRules: ClickUpAutomationRule[];
    }
    ```
  - Flatten config loading:
    ```typescript
    automationRules: normalizeClickUpAutomationRules(raw.automationRules)
    ```
  - Remove `pipelines` from `_normalizeConfig()`, initial config seeding in `setup()`, and `saveAutomationSettings()`.
  - Delete the current `syncPlan()` guard that skips `isInternal === true || (plan.pipelineId && plan.clickupTaskId)`.
  - Change the task-link branch in `syncPlan()` to:
    ```typescript
    const existingTaskId =
      String(plan.clickupTaskId || '').trim()
      || await this._findTaskByPlanId(plan.planId, config);
    ```
  - Keep `_updateTask()` responsible for updating custom fields/timestamps on the originating task so the system claims the existing ClickUp task instead of creating a second one later.
- **Edge Cases Handled:** Visible automation-created plans update the originating ClickUp task; no new REST client or new config file is introduced; discarded hidden-pipeline state is not preserved.

### Canonical automation creation and final write-back
#### [MODIFY] `src/services/ClickUpAutomationService.ts`
- **Context:** This file is the runtime engine that currently creates one hidden internal plan per matched pipeline, scans stage graphs for write-back, and depends on `PipelineManager.ts`. This is the core file that must become truly simple.
- **Logic:**
  1. Change the constructor to accept `workspaceRoot`, `ClickUpSyncService`, and `resolvePlansDir: () => Promise<string>`. Do **not** keep a stage/pipeline manager dependency.
  2. Keep `_taskHasSwitchboardOwnership()` and watched-list discovery, but flatten rule matching to the new rule shape.
  3. Replace the current "every matched rule creates a separate plan" behavior with **one visible plan per ClickUp task**: choose the first enabled matching rule in config order, and skip all later matches for that task during the same poll.
  4. Reuse the normal plan-ingestion path: resolve the ingestion folder from the callback, write a normal markdown plan file, let `PlanFileImporter` register the DB record, and do not call `db.upsertPlans()` directly for new automation-created visible plans.
  5. Write deterministic filenames and embedded metadata so dedupe does not depend entirely on importer timing: stable file name based on task ID and/or a short hash, embedded `Plan ID`, embedded `Session ID`, embedded `ClickUp Task ID`, embedded `Automation Rule`, no embedded `Pipeline ID`, and no embedded `Internal Plan: true`.
  6. Build the generated markdown as a normal visible plan: H1 from ClickUp task name, `## Goal` from task description, `## Proposed Changes` with a simple placeholder derived from the task/request, and `## Switchboard State` set to `rule.targetColumn` and `active`.
  7. For write-back, query the DB for plans with `sourceType === 'clickup-automation'`, `clickupTaskId` present, `status !== 'deleted'`, and `lastAction !== 'clickup_writeback_complete'`. Then read the plan file, parse the stored `Automation Rule`, resolve the current rule, and write back only when `plan.kanbanColumn === rule.finalColumn` and `rule.writeBackOnComplete === true`.
  8. Reuse the existing summary wrapper before write-back, but remove all pipeline-specific labels from it.
- **Implementation:**
  - Replace the multi-pipeline loop in `poll()` with a single-match branch:
    ```typescript
    const matchedRule = activeRules.find((rule) => matchesClickUpAutomationRule(task, listId, rule));
    if (!matchedRule) {
        result.skipped++;
        continue;
    }
    ```
  - Replace direct internal-plan creation with `fs.promises.writeFile(planFile, stub, 'utf8')`.
  - Generate plan metadata headers similar to:
    ```markdown
    > Imported from ClickUp task `task-123`
    > **ClickUp Task ID:** task-123
    > **Automation Rule:** Bug Summary
    > **URL:** https://clickup.local/task-123
    > **List:** CREATED
    > **ClickUp Status:** open
    ```
  - Reuse `db.findPlanByClickUpTaskId(workspaceId, task.id)` for runtime dedupe, but also skip creation when the deterministic target file already exists and has not yet been imported.
  - Reuse `db.updateLastAction(sessionId, 'clickup_writeback_complete')` for idempotency after successful write-back.
- **Edge Cases Handled:** No more one-task-to-many-hidden-plans explosion; file-first creation matches the rest of the repo; repeated polls stay idempotent; write-back remains tied to the original rule.

### Stage manager removal
#### [DELETE] `src/services/PipelineManager.ts`
- **Context:** After `src/services/ClickUpAutomationService.ts` owns flat rule matching, normal plan file generation, and final-column write-back scanning, `src/services/PipelineManager.ts` no longer provides unique value. Every method in the file exists only to support the stage graph that this plan is explicitly removing.
- **Logic:**
  1. Delete the file.
  2. Remove the import and construction site in `src/services/KanbanProvider.ts`.
  3. Remove the test harness dependency in `src/test/integrations/clickup/clickup-automation-service.test.js`.
  4. Ensure there are no remaining references to `createInternalPlan()`, `advancePlan()`, `getPlansAwaitingWriteBack()`, or `markWriteBackComplete()`.
- **Implementation:** No replacement file is required; the needed logic moves into `src/services/ClickUpAutomationService.ts`.
- **Edge Cases Handled:** The runtime no longer has a second private Kanban engine competing with the main board.

### Visible automation plan registration
#### [MODIFY] `src/services/PlanFileImporter.ts`
- **Context:** If automation-created plans are written as normal markdown files, the importer needs one lightweight way to identify them for later write-back scans. The current importer already extracts `ClickUp Task ID`, `Plan ID`, `Session ID`, and `isInternal`; it just always marks these files as `sourceType: 'local'`.
- **Logic:**
  1. Detect the presence of `Automation Rule` metadata.
  2. If present, set `sourceType: 'clickup-automation'`.
  3. Do not add any new hidden/internal branch for this feature; automation-created plans are plain visible plans.
  4. Preserve current ClickUp task ID extraction so dedupe and later sync/write-back logic continue to work.
- **Implementation:**
  - Add:
    ```typescript
    const automationRuleName = extractEmbeddedMetadata(content, 'Automation Rule');
    const sourceType = automationRuleName ? 'clickup-automation' : 'local';
    ```
  - Replace the hardcoded record assignment with `sourceType`.
- **Edge Cases Handled:** Ordinary ClickUp imports remain `local`; automation-created visible plans gain a stable identity without a new DB table or new config file.

### Runtime scheduler wiring
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** This file already owns the shared integration timer service and currently constructs `ClickUpAutomationService` with `PipelineManager`. The scheduler surface is already correct; only the dependency graph is wrong.
- **Logic:**
  1. Remove `PipelineManager` import.
  2. Update `_getClickUpAutomationService()` to pass the plan-ingestion-folder callback directly.
  3. Keep `_configureClickUpAutomation()` and the `clickup-automation` timer key unchanged so existing auto-pull/test wiring stays stable.
  4. Do not change `src/services/IntegrationAutoPullService.ts`.
- **Implementation:**
  - Replace:
    ```typescript
    new ClickUpAutomationService(
        resolved,
        this._getClickUpService(resolved),
        new PipelineManager(resolved, async () => this._getIntegrationImportDir(resolved))
    );
    ```
  - With:
    ```typescript
    new ClickUpAutomationService(
        resolved,
        this._getClickUpService(resolved),
        async () => this._getIntegrationImportDir(resolved)
    );
    ```
- **Edge Cases Handled:** The existing scheduler keeps working; no new timer surface or workspace lifecycle hook is introduced.

### Setup state hydration and save plumbing
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The setup panel state still exposes `automationRules` and `pipelines`, and the save handler still accepts both. That is the exact payload shape that keeps the pipeline abstraction alive.
- **Logic:**
  1. Remove `ClickUpPipelineMap` from the imports.
  2. Update `ClickUpSetupState` so it exposes only `automationRules`.
  3. In `getIntegrationSetupStates()`, stop sending `pipelines`.
  4. Change `handleSaveClickUpAutomation()` to accept only `ClickUpAutomationRule[]`.
  5. After saving, continue calling `initializeIntegrationAutoPull()` so the runtime picks up the flat rules immediately.
- **Implementation:**
  - Replace:
    ```typescript
    type ClickUpSetupState = {
        setupComplete: boolean;
        columns: ClickUpSetupColumnState[];
        availableLists: Array<{ id: string; name: string }>;
        mappedCount: number;
        excludedCount: number;
        unmappedCount: number;
        automationRules: ClickUpAutomationRule[];
        pipelines: ClickUpPipelineMap;
        error?: string;
    };
    ```
  - With:
    ```typescript
    type ClickUpSetupState = {
        setupComplete: boolean;
        columns: ClickUpSetupColumnState[];
        availableLists: Array<{ id: string; name: string }>;
        mappedCount: number;
        excludedCount: number;
        unmappedCount: number;
        automationRules: ClickUpAutomationRule[];
        error?: string;
    };
    ```
  - Replace the save handler signature:
    ```typescript
    public async handleSaveClickUpAutomation(
        automationRules: ClickUpAutomationRule[]
    ): Promise<{ success: boolean; error?: string }>
    ```
  - Replace the save call with:
    ```typescript
    await this._getClickUpService(resolvedRoot).saveAutomationSettings(automationRules);
    ```
- **Edge Cases Handled:** The setup panel keeps using the same state-loading entry point; the runtime reconfigures immediately after each save; no parallel save command is introduced.

#### [MODIFY] `src/services/SetupPanelProvider.ts`
- **Context:** The setup panel router currently forwards both `automationRules` and `pipelines`. The message name can stay the same, but the payload must stop carrying pipeline state.
- **Logic:**
  1. Keep the message type `saveClickUpAutomation`.
  2. Pass only the rules array to `TaskViewerProvider.handleSaveClickUpAutomation()`.
  3. Keep the post-save UI refresh and `switchboard.refreshUI` calls unchanged.
- **Implementation:**
  - Replace:
    ```typescript
    const result = await this._taskViewerProvider.handleSaveClickUpAutomation(
        Array.isArray(message.automationRules) ? message.automationRules : [],
        message.pipelines && typeof message.pipelines === 'object' ? message.pipelines : {}
    );
    ```
  - With:
    ```typescript
    const result = await this._taskViewerProvider.handleSaveClickUpAutomation(
        Array.isArray(message.automationRules) ? message.automationRules : []
    );
    ```
- **Edge Cases Handled:** No new setup-panel command names; old UI refresh behavior remains stable.

### Setup UI simplification
#### [MODIFY] `src/webview/setup.html`
- **Context:** The current UI explicitly exposes "Internal Automation Pipelines," an "ADD PIPELINE" button, a pipeline textarea editor, and rule cards that reference pipeline IDs plus write-back target/format. That is the product surface this plan is eliminating.
- **Logic:**
  1. Keep the ClickUp token and column-mapping UI intact.
  2. Replace the automation subsection copy so it describes visible plan creation using existing Kanban columns.
  3. Remove the entire pipeline editor: `btn-clickup-add-pipeline`, `clickup-pipelines-list`, the pipeline card renderer, and `serializePipelineStages()` / `parsePipelineStages()` usage from this surface.
  4. Change each rule card to flat fields: rule name, trigger tag, optional list scope (multi-select, since current matching already supports it), start column select, final column select, and a write-back enabled checkbox.
  5. Populate column selects from `lastClickupSetupState.columns`.
  6. Make `collectClickupAutomationPayload()` return only `{ automationRules }`.
  7. Keep the save button and message type unchanged.
- **Implementation:**
  - Replace the section header/copy from **Internal Automation Pipelines** to copy that explicitly says "Create a normal Switchboard plan when a ClickUp task matches a tag; write the result back when that plan reaches the configured final column."
  - Change the rule payload assembly to a flat structure similar to:
    ```javascript
    automationRules.push({
        name,
        triggerTag: tag,
        triggerLists: lists,
        targetColumn,
        finalColumn,
        writeBackOnComplete: writeBackEnabled,
        enabled: true
    });
    ```
  - Seed new rule cards from the current visible column list instead of `pipelineIds`.
- **Edge Cases Handled:** The UI no longer asks users to maintain a second hidden workflow model; existing list-scoping behavior is preserved; the setup panel stays inside the current ClickUp integration surface.

### Regression coverage for the simplified flow
#### [MODIFY] `src/test/integrations/clickup/clickup-automation-service.test.js`
- **Context:** The current test is still proving the behavior this plan is removing: one hidden internal plan per pipeline, off-board visibility, and `PipelineManager.advancePlan()`-driven write-back.
- **Logic:**
  1. Remove `PipelineManager` from the test harness.
  2. Seed only the flat automation rule shape.
  3. Assert one created plan per task, not one plan per matching pipeline.
  4. Assert the created plan is visible to `getBoard(workspaceId)` and has `sourceType === 'clickup-automation'`, `isInternal === false`, and populated `clickupTaskId`.
  5. Move the persisted plan into the configured `finalColumn` by updating the DB record and/or plan state the same way the live runtime does, then run `automation.poll()` again and assert one write-back.
  6. Assert repeated polls do not write back twice once `lastAction === 'clickup_writeback_complete'`.
- **Implementation:**
  - Replace the first-poll assertions from `created === 2`, `getBoard().length === 0`, `isInternal === true` to `created === 1`, `getBoard().length === 1`, `isInternal === false`.
  - Replace pipeline-stage advancement with direct final-column state:
    ```javascript
    const completedPlan = Object.assign({}, createdPlan, {
        kanbanColumn: 'COMPLETED',
        updatedAt: new Date().toISOString()
    });
    await db.upsertPlans([completedPlan]);
    ```
    or the equivalent plan-state helper used by the runtime.
- **Edge Cases Handled:** The test now proves the actual simplified contract: one visible plan, one originating task, one idempotent final write-back.

#### [MODIFY] `src/test/integration-auto-pull-regression.test.js`
- **Context:** The scheduler should still use the shared `clickup-automation` timer slot even after `PipelineManager` disappears.
- **Logic:**
  1. Keep the existing assertions around `_configureClickUpAutomation()`.
  2. Update any brittle regex expectations that assumed pipeline-specific construction/imports.
  3. Preserve the assertion that `src/services/KanbanProvider.ts` continues to initialize ClickUp auto-pull, ClickUp automation polling, and Linear auto-pull together.
- **Implementation:** Narrow the regression to scheduler ownership and `automation.poll()` invocation, not the deleted stage-manager wiring.
- **Edge Cases Handled:** The simplification does not accidentally disable runtime polling.

### Clean-slate cleanup of the discarded experiment
#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** Because this feature was created today and is intentionally being redone from scratch, the implementation should not preserve old hidden pipeline rows or helper branches if they only exist for the discarded design.
- **Logic:**
  1. Remove any ClickUp-automation-specific hidden-plan query branches that are no longer needed once `PipelineManager.ts` and nested pipelines are gone.
  2. If `pipeline_id`, `is_internal`, or pipeline-scoped `findPlanByClickUpTaskId(..., pipelineId?)` are only retained for the discarded feature, delete them instead of adding preservation code.
  3. If local dev/test workspaces contain hidden pipeline rows from the discarded implementation, purge them rather than migrating them.
- **Implementation:** Prefer deletion/reset over migration. If schema drops are straightforward, remove the unused clickup-only hidden-plan fields; if schema removal is disproportionately risky, leave the columns dormant but do not add preservation logic for the discarded design.
- **Edge Cases Handled:** The new visible flow ships without carrying dead branches for an unused experiment.

## Verification Plan
### Automated Tests
- Run `npm run compile`.
- Run `npm run compile-tests` before the node-based integration checks.
- Run `node src/test/integrations/clickup/clickup-automation-service.test.js`.
- Run `node src/test/integrations/clickup/clickup-import-flow.test.js` to confirm normal file-first ClickUp imports still behave like ordinary local plans.
- Run `node src/test/integration-auto-pull-regression.test.js`.

### Manual Validation
1. Start from a clean workspace state for ClickUp automation: delete any experimental nested automation config and any hidden pipeline records/files from today's discarded implementation before validating the rebuilt flow.
2. Configure one rule such as `bug` -> `CREATED` -> `COMPLETED` with write-back enabled, then poll a matching ClickUp task and confirm exactly one visible plan file is created in the configured plan ingestion folder.
3. Confirm the resulting DB record is visible on the board, has `sourceType: 'clickup-automation'`, keeps `clickupTaskId`, and is not hidden by `isInternal`.
4. Move that plan through normal Kanban columns and confirm the existing ClickUp task is updated in place rather than duplicated.
5. Move the plan into the configured `finalColumn`, run another automation poll, and confirm the plan content is written back once and only once.
6. Confirm ordinary ClickUp imports still create `sourceType: 'local'` plans and are not swept into the automation write-back scan.

---

_Preserved original plan material below. The sections above are the authoritative improved spec; the original content remains verbatim so none of the existing goal statements or implementation notes are lost._

Remove the overengineered "internal pipeline" disaster and replace it with simple, user-controlled Kanban workflows that work with custom columns.

## Background

The previous plan `flexible_clickup_column_mapping.md` created an overengineered mess that tried to build a parallel "hidden" Kanban system inside the existing Kanban. This was completely unnecessary and ignored the simple fact that:

1. **Unmapped columns already don't sync to ClickUp** - this IS the "hiding" mechanism
2. **Users already have custom columns** - they can create CREATED, ANALYSED, REVIEWED, COMPLETED or whatever flow they want
3. **Existing Kanban workflow already works** - users can move cards manually OR use automation to move them
4. **The only missing piece was**: when a plan reaches the final column, write the results back to ClickUp

The old implementation added:
- Special "internal" columns like BUG_RECEIVED, BUG_ANALYSIS
- A separate PipelineManager with its own advance logic
- Complex deduplication on task+pipeline combinations
- Hidden flags and filtering
- Write-back rule resolution from persisted metadata

**All of this was unnecessary.** The existing Kanban system already handles columns, movement, and visibility. The only needed addition was: trigger on ClickUp tag match, create plan, write back when completed.

## The Simple Approach

### How It Should Work

1. **User creates their own Kanban columns** (e.g., CREATED, ANALYSED, REVIEWED, COMPLETED)
2. **User maps some columns to ClickUp** (e.g., CREATED → ClickUp list), leaves others unmapped
3. **User creates automation rules** that say: "when ClickUp task has tag X, create a Switchboard plan"
4. **Switchboard creates the plan** in the starting column (e.g., CREATED)
5. **User handles the plan** however they want:
   - Manually move it through columns
   - Use existing automation to move it
   - Set up custom triggers
6. **When plan reaches the designated "final" column** (e.g., COMPLETED), Switchboard writes results back to the original ClickUp task

That's it. No special columns. No hidden pipelines. No parallel systems.

### What Gets Removed

Delete or severely simplify:
- `PipelineManager.ts` - the entire separate advancement system
- `ClickUpAutomationService.ts` - reduce to simple trigger+writeback
- `PipelineDefinition.ts` - remove pipeline stage definitions
- Internal plan flags (`isInternal`, `pipelineId`, `clickupTaskId` from KanbanDatabase if not needed elsewhere)
- Special handling in KanbanDatabase for filtering internal plans
- Complex write-back rule resolution (just use the rule that triggered the creation)

### What Stays (Simplified)

- Config persistence for automation rules (just: trigger tag → target column → write-back enabled/disabled)
- ClickUp polling to watch for matching tasks
- Plan creation when tag matches
- Write-back when plan reaches designated "final" column

## Implementation Plan

### Phase 1: Remove the Overengineered Mess

1. **Delete PipelineManager.ts entirely**
   - Remove all internal plan creation logic
   - Remove stage advancement logic
   - Remove special internal column handling

2. **Delete PipelineDefinition.ts** (or reduce to minimal types)
   - Remove pipeline stage definitions
   - Remove complex trigger matching (keep simple tag matching)
   - Remove write-back target/format abstraction (keep simple: always write to description as append, or make it a simple config option)

3. **Clean up KanbanDatabase.ts**
   - Remove `is_internal`, `pipeline_id`, `clickup_task_id` columns if they're only for this feature
   - Remove queries that filter by `is_internal`
   - If these columns are used elsewhere, keep them but stop using them for this feature

4. **Clean up ClickUpAutomationService.ts**
   - Remove the complex deduplication logic (task+pipeline)
   - Remove the per-pipeline plan creation
   - Remove the rule-metadata persistence in plan content
   - Keep: polling, simple tag matching, plan creation via existing mechanisms

### Phase 2: Implement the Simple Version

1. **Simplified automation config**
   ```typescript
   interface ClickUpAutomationRule {
     name: string;
     enabled: boolean;
     triggerTag: string;           // e.g., "bug", "feasibility"
     targetColumn: string;         // e.g., "CREATED", "ANALYSED"
     finalColumn: string;          // e.g., "COMPLETED"
     writeBackOnComplete: boolean; // whether to write back when reaching finalColumn
   }
   ```
   That's it. No stages, no pipelines, no complex write-back targets.

2. **Simplified automation service**
   - Poll ClickUp lists for tasks
   - When task has matching tag AND no existing Switchboard plan linked to it:
     - Create plan via existing PlanFileImporter or direct DB insert
     - Put it in `targetColumn`
     - Store the ClickUp task ID in plan metadata (for write-back later)
   - When a plan reaches `finalColumn` AND `writeBackOnComplete` is true:
     - Write plan content/result back to ClickUp task
     - Mark as written back (simple flag, not complex state machine)

3. **Use existing Kanban for everything else**
   - Plans appear on the board in their starting column
   - Users move them manually OR use whatever automation they want
   - No special "internal" handling - it's just a normal plan that happens to have a ClickUp source

### Phase 3: UI Updates

1. **Setup panel simplification**
   - Remove pipeline configuration UI
   - Remove automation rules with complex write-back targets
   - Show simple: Tag → Starting Column → Final Column → Write Back checkbox

2. **Remove "internal plans" visibility toggles**
   - These plans are just normal plans with a ClickUp source
   - They show on the board like anything else
   - If user doesn't want to see them, they put them in a column that's collapsed or not mapped

## Files to Modify/Delete

### Delete
- `src/services/PipelineManager.ts`
- `src/models/PipelineDefinition.ts` (or reduce to minimal interfaces)

### Major Simplification
- `src/services/ClickUpAutomationService.ts` - reduce ~80%
- `src/services/KanbanDatabase.ts` - remove internal plan queries/columns
- `src/services/TaskViewerProvider.ts` - remove complex automation save handlers
- `src/webview/setup.html` - remove pipeline UI, simplify to tag→column mapping

### Keep (as-is or minor updates)
- `src/services/ClickUpSyncService.ts` - mostly fine, may need write-back helper
- `src/services/KanbanProvider.ts` - remove automation coordination if present
- `src/extension.ts` - remove automation service initialization

## Migration Path

Since this feature likely hasn't been used in production yet (given it was overengineered and incomplete):

1. **Remove all internal plan artifacts** - DB columns, files, etc.
2. **Document the simple workflow** - create plan from ClickUp, let user handle it
3. **If any test data exists** - delete it, start fresh

## Verification Plan

1. **Compile passes** - `npm run compile`
2. **Tests updated** - remove/simplify ClickUp automation tests
3. **Manual test**:
   - Configure: Tag "bug" → Start in "CREATED" → Complete in "COMPLETED" → Write back
   - Create ClickUp task with "bug" tag
   - Verify Switchboard plan created in CREATED
   - Move plan through columns manually
   - Verify write-back when reaching COMPLETED
4. **Test with custom columns**:
   - User creates ANALYSED, REVIEWED columns
   - Configure automation to use these
   - Verify flow works end-to-end

## Success Criteria

- User can configure: "when ClickUp task has tag X, create Switchboard plan in column Y"
- Plan appears on Kanban like any other plan
- User moves plan through their custom columns however they want (manual or automation)
- When plan reaches designated "complete" column, results write back to ClickUp
- No special "internal" or "hidden" concepts
- No parallel column systems
- Just: ClickUp trigger → Kanban plan → Kanban workflow → ClickUp write-back

## References

- **Old overengineered plan**: `flexible_clickup_column_mapping.md` - referred to as the "overengineered piece of crap" that tried to build a hidden pipeline system instead of using the existing Kanban workflow

## Switchboard State

**Kanban Column:** CREATED
**Status:** active

## Post-Implementation Review

### Stage 1 - Grumpy Critique
- **[MAJOR]** The poller briefly achieved peak overconfidence: once any rule declared explicit `triggerLists`, the runtime stopped watching mapped lists for unscoped rules. That means a configuration that *looked* valid in the setup UI could silently fail to create automation plans for backlog tasks that should have matched the catch-all rule. Splendid. A “simple” automation system that ignores eligible tasks because one neighboring rule got opinionated is how you breed haunted support tickets.
- **[NIT]** The schema and importer still carry dormant `pipeline_id` / `is_internal` fossils. They are not driving the simplified runtime anymore, so this is not a release blocker, but the graveyard is still visible if you know where to look.
- **[NIT]** Legacy experiment cleanup still runs during polling. That matches the clean-slate intent and it behaved correctly in verification, but it is noisier than a one-time cleanup path and should stay on the watchlist if polling volume grows.

### Stage 2 - Balanced Synthesis
- **Keep** the flat automation rule model, visible markdown plan creation, `clickupTaskId`-first sync path, final-column-gated write-back, simplified setup-panel payload, and the updated regression coverage proving one visible plan and one idempotent write-back path.
- **Fix now** the mixed scoped/unscoped watched-list bug so unscoped rules still observe mapped lists even when other rules use explicit `triggerLists`.
- **Defer** dormant schema cleanup and poll-time legacy cleanup optimization. They are acceptable as non-blocking cleanup debt after the functional path is stable.

### Reviewer Fixes Applied
- Updated `src/services/ClickUpAutomationService.ts` so `_getWatchedListIds()` unions explicit trigger lists with mapped lists whenever any enabled rule is unscoped.
- Added `testMixedScopedAndUnscopedRulePolling()` to `src/test/integrations/clickup/clickup-automation-service.test.js` to lock the regression down.

### Files Changed During Reviewer Pass
- `src/services/ClickUpAutomationService.ts`
- `src/test/integrations/clickup/clickup-automation-service.test.js`

### Validation Results
- **PASS** `npm run compile`
- **PASS** `npm run compile-tests`
- **PASS** `node src/test/integrations/clickup/clickup-automation-service.test.js`
- **PASS** `node src/test/integrations/clickup/clickup-import-flow.test.js`
- **PASS** `node src/test/integration-auto-pull-regression.test.js`

### Remaining Risks
- Dormant `pipeline_id` / `is_internal` compatibility fields remain in the database and importer path. They are inactive in the simplified runtime, but still technical debt.
- Legacy ClickUp automation cleanup still executes during polling. It is functionally acceptable for the current clean-slate rebuild, but worth revisiting if poll cost becomes noticeable.
- This reviewer pass did not include live manual validation against a real ClickUp workspace; automated verification passed, but the manual validation checklist in this plan remains recommended.
