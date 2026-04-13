# Add Kanban Column Management to Setup Panel

## Goal
Add first-class Kanban column management controls to the setup panel so users can add, edit, delete, reorder, and reset board columns without breaking the current built-in lanes, custom-agent lanes, or drag/drop dispatch behavior.

## Metadata
**Tags:** backend, UI
**Complexity:** 8

## User Review Required
> [!NOTE]
> - Existing workspaces will begin persisting a new `customKanbanColumns` array inside `.switchboard/state.json` the first time a user saves setup-panel column changes.
> - Verify one full reload cycle after implementation so the saved structure, deleted lanes, and restored defaults all survive a restart.
> - **Clarification:** Add/edit/delete persistence should flow through the existing setup autosave path (`saveStartupCommands`) instead of inventing separate persistence channels for every button. A dedicated `restoreKanbanDefaults` message is still acceptable if clearing workspaceState-only overrides cannot be done safely through autosave alone.
> - **Clarification:** "Delete column" means "remove the lane from the board configuration," not "delete the underlying agent." Built-in lanes become hidden via `visibleAgents`, agent-derived lanes flip `includeInKanban` to `false`, and user-defined lanes are removed from `customKanbanColumns`.
> - **Clarification:** Keep current role-based workflow naming for runsheet updates. This feature adds configurable target columns, not a new workflow taxonomy.

## Complexity Audit
### Routine
- Add a new persisted `customKanbanColumns` data model in `src/services/agentConfig.ts` and parse it from `.switchboard/state.json` without breaking older state files that do not contain the new key.
- Extend `src/services/TaskViewerProvider.ts` setup-panel payloads so `handleGetKanbanStructure()` returns user-defined columns and `handleSaveStartupCommands()` persists them through the existing autosave path.
- Add setup-panel controls in `src/webview/setup.html` for Add Column, Edit, Delete, and Restore Defaults, reusing the same local-state/autosave pattern already used for other setup sections.
- Add focused regression tests that lock the schema, setup-panel wiring, and target-column dispatch behavior.

### Complex / Risky
- The current Kanban dispatch path assumes "target column" and "dispatch role" are effectively the same thing. That assumption breaks as soon as two custom columns point at the same agent or a custom column label does not match the agent's default lane. If this coupling is not broken deliberately, cards dropped into a user-defined column will dispatch to the right agent but land in the wrong board column.
- The current board progression logic in `src/services/KanbanProvider.ts` collapses adjacent columns by shared `kind`, which is correct for the built-in coded lanes but wrong for multiple arbitrary user-defined columns. If left unchanged, `moveSelected`/`moveAll` can skip custom columns unpredictably.
- Delete and restore flows now span three storage layers at once: `.switchboard/state.json` (`customKanbanColumns`, `customAgents`, `visibleAgents`), workspaceState (`kanban.orderOverrides`, `kanban.columnDragDropModes`), and the live board model. If cleanup is partial, stale overrides will resurrect removed columns or preserve old drag/drop modes after edit/reset.
- `src/webview/setup.html` currently rebuilds custom structure rows from `lastCustomAgents` in `syncLocalKanbanStructureWithCustomAgents()`. If that logic is not refactored, every setup-panel refresh will silently discard newly added user-defined columns from the local UI state before autosave completes.

## Edge-Case & Dependency Audit
- **Race Conditions:** The setup panel already autosaves asynchronously, and the Kanban board already performs optimistic drag/drop before the provider reasserts DB state. This plan must keep custom-column edits atomic across local setup state and persisted state: reorder/save/restore cannot race each other into writing stale `customKanbanColumns`, stale `kanban.orderOverrides`, or stale `kanban.columnDragDropModes`. For board actions, a failed dispatch to the assigned role must not leave the card stranded in a user-defined lane that was never actually dispatched.
- **Security:** `triggerPrompt` is user-authored prompt content, not executable shell input. The implementation must store it as plain configuration data, sanitize IDs/labels/roles the same way the repo already sanitizes custom-agent identifiers, and only inject the prompt into the existing agent-dispatch message/clipboard flow. Do not add any new shell execution path or extra logging of prompt text.
- **Side Effects:** This feature changes how board columns are modeled, not how agents are defined. Built-in lanes must stay fixed at the ends, existing custom-agent columns must continue working, older state files must load with `customKanbanColumns = []`, and editing a column's drag/drop mode in setup must not be masked forever by an old workspaceState override. The board must still honor current built-in routing for `PLAN REVIEWED`, pair-programming side effects, and existing custom-agent lanes.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active **New** plans: none. Active **Planned** plans: only this plan. There is therefore no active dependency that blocks implementation. There is still file-level merge pressure with non-active but nearby plans in `.switchboard/plans/`, especially `brain_d0af6b8e9d4ebeb25e1a1e589f9466909476ce67f72b582d06a5fefbfefcce85.md` (**Visual Kanban Structure Reordering Plan**), `brain_bc840efb8f0c3860ff3dc5f42de29899d676bda0e1f871379e62b566974fc430.md` (**Fix Setup Panel Organization and Implement Modern Autosave**), `make_team_lead_column_visibility_consistent_with_other_agents.md`, and `add_project_management_accordion_to_central_setup.md`, because they all overlap `src/webview/setup.html`, `src/services/TaskViewerProvider.ts`, and `src/services/KanbanProvider.ts`. Those items are not active conflicts by rule, but they are real merge hotspots.

## Adversarial Synthesis
### Grumpy Critique
> This is not an "Add Column" button. It is a data-model and dispatch-path rewrite wearing a little setup-panel hat. If someone treats it like UI chrome, they are going to ship decorative columns that render beautifully, save unreliably, and dispatch cards straight into the wrong lane because the current system still assumes "column == role target." Drop a card into a shiny new custom column assigned to `coder`, and without a deliberate fix the card will happily run coder logic and then snap to `CODER CODED` on refresh. Bravo. You built a fake lane.
>
> The second trap is pretending all "custom columns" are the same thing. They are not. Today the repo has built-in lanes, custom-agent lanes derived from `includeInKanban`, and now this plan wants user-authored lanes with their own prompt text and mode. If you jam those into `CustomAgentConfig`, delete semantics become nonsense. If you leave `syncLocalKanbanStructureWithCustomAgents()` alone, the webview will eat user-defined lanes alive. If you forget workspaceState cleanup, deleted columns will come back from the dead with stale drag/drop modes. This feature is one of those lovely internal tools changes where a sloppy implementation looks done right until the second reload.

### Balanced Response
> The safe implementation is to make user-defined columns first-class Kanban configuration records rather than overloading custom-agent state. `src/services/agentConfig.ts` becomes the shared source of truth for all three column sources: built-in, custom-agent-derived, and custom-user. `src/services/TaskViewerProvider.ts` owns persistence through the existing autosave path, while `src/webview/setup.html` stops rebuilding local structure solely from `lastCustomAgents`.
>
> The routing risk is handled explicitly rather than implicitly. `src/services/KanbanProvider.ts` must resolve a full dispatch specification from the target column, not just a role string, and then call a provider helper that updates the card to the explicit target column after dispatch. That keeps user-defined lanes real, not cosmetic. Finally, restore/delete flows must prune workspaceState overrides so edited or deleted columns do not resurrect on refresh. The tests below lock those failure modes directly.

## Preserved Original Draft
### Current Behavior
- Kanban columns are derived from `DEFAULT_KANBAN_COLUMNS` in `agentConfig.ts` plus custom agents with `includeInKanban: true`
- Users can reorder middle columns via drag-and-drop
- Fixed columns (CREATED, COMPLETED) cannot be moved
- No way to add arbitrary columns, delete columns, or reset to defaults

### Desired Behavior
1. **Add Column**: User can click "Add Column" to create a new custom column with:
   - Column label (required)
   - **Agent assignment** (dropdown): Which agent role handles cards dropped in this column
   - **Trigger prompt** (textarea): The prompt sent to the assigned agent when a card is dropped here
   - **Drag-drop mode**: CLI Agent or Clipboard Prompt (same as custom agent creator)
2. **Edit Column**: User can modify existing custom columns to change agent, prompt, or mode
3. **Delete Column**: User can delete non-fixed columns (both built-in and custom)
4. **Restore Defaults**: User can reset all column changes back to the default configuration

### Files to Modify

### 1. `/src/services/agentConfig.ts`
- Add new `customColumns` storage field to `CustomAgentConfig` or workspace state
- Update `buildKanbanColumns()` to include user-defined custom columns
- Add helper functions for column CRUD operations

### 2. `/src/services/TaskViewerProvider.ts`
- Add `handleAddKanbanColumn()`, `handleDeleteKanbanColumn()`, `handleRestoreKanbanDefaults()` methods
- Update `handleGetKanbanStructure()` to include custom columns
- Wire up message handlers for new operations

### 3. `/src/services/SetupPanelProvider.ts`
- Add message handlers: `addKanbanColumn`, `deleteKanbanColumn`, `restoreKanbanDefaults`
- Route to `TaskViewerProvider` methods

### 4. `/src/webview/setup.html`
- Add "Add Column" button to kanban structure section
- Add delete button (×) to each non-fixed column row
- Add "Restore Defaults" button at bottom of kanban structure panel
- Add modal/prompt for entering new column label and optional role association
- Update `renderKanbanStructureList()` to show delete buttons

### Implementation Details

### Data Model
```typescript
interface CustomKanbanColumn {
  id: string;           // unique identifier (e.g., "custom_123")
  label: string;        // display label
  assignedAgent: string; // agent role triggered when card dropped here (e.g., 'lead', 'coder', 'custom_agent_xyz')
  triggerPrompt: string; // prompt sent to assigned agent on drop
  order: number;        // display order
  kind: 'custom-user';  // distinguish from agent-derived columns
  autobanEnabled: boolean;
  dragDropMode: 'cli' | 'prompt';
}
```

### UI Flow

#### Add/Edit Column Modal
Similar to the custom agent creator modal, with these fields:
1. **Column Label** (text input, required): Display name for the column
2. **Assigned Agent** (dropdown, required): Select which agent handles cards dropped here
   - Options: All built-in agents (planner, lead, coder, reviewer, tester, intern, analyst, team-lead)
   - Plus all configured custom agents
3. **Trigger Prompt** (textarea): The prompt instructions sent to the assigned agent
   - Hint text: "What should the agent do when a card is dropped here?"
   - Similar to custom agent "Prompt Instructions" field
4. **Drag-Drop Mode** (dropdown):
   - "CLI Agent" (default): Trigger agent via CLI command
   - "Clipboard Prompt": Copy prompt to clipboard only

#### Column Lifecycle
1. User clicks "Add Column" -> modal opens with empty form
2. User fills fields -> clicks Save -> new column inserted before COMPLETED, orders recalculated
3. User clicks "Edit" on custom column -> modal opens pre-filled -> Save updates configuration
4. User clicks x on column -> confirmation -> column removed, orders recalculated
5. User clicks "Restore Defaults" -> confirmation -> all custom columns removed, order overrides cleared, built-in visibility reset

### State Persistence
Store custom columns in `.switchboard/state.json` under `customKanbanColumns` array.

### Complexity
Medium-High (7/10) - Requires UI changes, data model extension, agent/prompt configuration UI similar to custom agent creator, and full CRUD operations across multiple files.

### Testing Considerations
- Verify columns persist after reload
- Verify restore defaults clears all customizations
- Verify drag-and-drop still works with custom columns
- Verify delete updates order of remaining columns correctly
- Verify assigned agent dropdown shows all available agents (built-in + custom)
- Verify trigger prompt is saved and retrieved correctly
- Verify drag-drop mode (CLI vs Prompt) is respected when card dropped in column

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Treat user-defined columns as first-class column configuration, not as a thin alias over `CustomAgentConfig`. Keep scope focused on setup-panel CRUD, persistence, and real drag/drop behavior on the Kanban board. Do not expand this feature into a broader conversational-routing or workflow-taxonomy rewrite unless a concrete implementation dependency forces it.

### Clarification - column source model and persistence boundary
- The current code already has two column sources:
  1. built-in lanes from `DEFAULT_KANBAN_COLUMNS`
  2. custom-agent lanes derived from `customAgents[].includeInKanban`
- This feature adds a third source:
  3. user-authored lanes stored in `.switchboard/state.json.customKanbanColumns`
- Keep those sources separate in storage and in the in-memory model. That separation is what makes delete/edit/restore semantics precise:
  - built-in lane delete => hide lane from board
  - agent-derived lane delete => `includeInKanban = false`
  - user-authored lane delete => remove config object entirely
- **Clarification:** Do not retrofit user-defined columns into `CustomAgentConfig`. Agent configuration and board-lane configuration are related, but they are not the same object.

### Shared Kanban column schema
#### [MODIFY] `src/services/agentConfig.ts`
- **Context:** This file is already the canonical source for built-in roles, custom-agent parsing, and the merged Kanban column builder. User-defined columns must be added here or the setup panel, board, and persistence layer will each invent a slightly different shape.
- **Logic:**
  1. Add a dedicated `CustomKanbanColumnConfig` interface for persisted user-authored lanes.
  2. Extend `KanbanColumnDefinition` so the merged column model can describe where a lane came from and, for user-authored lanes, what extra prompt text and drag/drop mode it carries.
  3. Add `parseCustomKanbanColumns(raw: unknown): CustomKanbanColumnConfig[]`, following the same defensive parsing pattern already used by `parseCustomAgents()`.
  4. Update `buildKanbanColumns()` to accept both `customAgents` and `customKanbanColumns`, then emit one sorted merged list with explicit source/kind metadata.
  5. Keep old workspaces backward-compatible by returning `[]` when the new key is absent or malformed.
  6. Preserve the fixed built-in lanes and current custom-agent behavior exactly as-is when `customKanbanColumns` is empty.
- **Implementation:**
```typescript
export interface CustomKanbanColumnConfig {
    id: string;
    label: string;
    role: string;
    triggerPrompt: string;
    order: number;
    dragDropMode: 'cli' | 'prompt';
}

export interface KanbanColumnDefinition {
    id: string;
    label: string;
    role?: string;
    order: number;
    kind: 'created' | 'review' | 'coded' | 'reviewed' | 'custom-agent' | 'custom-user' | 'completed';
    source: 'built-in' | 'custom-agent' | 'custom-user';
    autobanEnabled: boolean;
    dragDropMode: 'cli' | 'prompt';
    hideWhenNoAgent?: boolean;
    triggerPrompt?: string;
}
```
- **Edge Cases Handled:** A dedicated parser prevents malformed JSON from crashing column construction, keeps older state files valid, and prevents duplicate or invalid custom-column IDs from contaminating the merged board structure.

### Setup structure state, persistence, and explicit target-column dispatch
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** This file currently owns setup-panel data exchange (`handleGetKanbanStructure()`, `handleUpdateKanbanStructure()`, `handleSaveStartupCommands()`), and it already contains the prompt-building and dispatch machinery needed to route plans to agents. It is the correct place to persist the new column config and expose a safe helper for "dispatch to this exact custom lane."
- **Logic:**
  1. Expand `SetupKanbanStructureItem` so the webview receives enough metadata to render and edit all lane types:
     - `source`
     - `assignedAgent`
     - `triggerPrompt`
     - `dragDropMode`
     - `editable`
     - `deletable`
  2. Add a private reader for `.switchboard/state.json.customKanbanColumns`, using the shared parser from `agentConfig.ts`.
  3. Update `_buildKanbanColumnsForWorkspace()` and `_buildSetupKanbanStructure()` so setup rendering uses the same merged definition list as the board.
  4. Update `handleGetKanbanStructure()` to return user-authored lanes, agent-derived lanes, and built-ins in one ordered list.
  5. Extend `handleUpdateKanbanStructure(sequence)` so reordering writes to all three storage targets correctly:
     - built-in lanes -> `kanban.orderOverrides` via `KanbanProvider`
     - agent-derived lanes -> `customAgents[].kanbanOrder`
     - user-authored lanes -> `customKanbanColumns[].order`
  6. Extend `handleSaveStartupCommands(message)` to accept and persist `customKanbanColumns` from the setup webview alongside the existing startup/custom-agent/visibility payload.
  7. Normalize delete semantics during save:
     - built-in lane hidden => update `visibleAgents`
     - agent-derived lane removed from board => set `includeInKanban = false`
     - user-authored lane deleted => omit from the persisted `customKanbanColumns` array
  8. Add one explicit public helper for custom-column board actions, for example `dispatchConfiguredKanbanColumnAction(...)`, that:
     - resolves session IDs to plan files
     - builds the base prompt with the existing `_buildKanbanBatchPrompt()`
     - appends the user-authored `triggerPrompt` as additional instructions
     - dispatches via CLI or clipboard
     - updates the run sheet with the existing role-based workflow name
     - updates the Kanban column to the explicit custom `targetColumn` instead of `_targetColumnForRole(role)`
  9. If restore-defaults requires clearing workspaceState-only overrides atomically, add `handleRestoreKanbanDefaults()` here and let the setup panel call it directly instead of trying to simulate reset through a sequence of partial autosaves.
- **Implementation:**
```typescript
type SetupKanbanStructureItem = {
    id: string;
    label: string;
    role?: string;
    kind: string;
    source: 'built-in' | 'custom-agent' | 'custom-user';
    fixed: boolean;
    reorderable: boolean;
    visible: boolean;
    order: number;
    assignedAgent?: string;
    triggerPrompt?: string;
    dragDropMode: 'cli' | 'prompt';
    editable: boolean;
    deletable: boolean;
};
```
- **Edge Cases Handled:** This keeps older workspaces working with no migration, prevents deleted custom lanes from surviving in stale state, and solves the core bug where a card dispatched to a user-defined lane would otherwise be moved to the role's default built-in column on refresh.

### Setup-panel message bridge
#### [MODIFY] `src/services/SetupPanelProvider.ts`
- **Context:** The setup-panel webview already routes `saveStartupCommands`, `getKanbanStructure`, and `updateKanbanStructure` through this provider. It should stay thin so the setup panel has exactly one authoritative backend for column state.
- **Logic:**
  1. Keep add/edit/delete persistence on the existing `saveStartupCommands` message path; no new CRUD-specific transport is required if the message payload is extended cleanly.
  2. Add a `restoreKanbanDefaults` message case only if the reset flow needs backend-side cleanup of workspaceState overrides that autosave alone cannot clear safely.
  3. After save or restore, trigger the same UI refresh path already used for other setup saves so Kanban, sidebar, and setup views all rehydrate from the same persisted state.
- **Implementation:**
  - Keep `case 'saveStartupCommands': await this._taskViewerProvider.handleSaveStartupCommands(message);`
  - Add `case 'restoreKanbanDefaults': await this._taskViewerProvider.handleRestoreKanbanDefaults(); await vscode.commands.executeCommand('switchboard.refreshUI');`
  - Re-request `kanbanStructure` after reset so the modal/list UI does not keep stale local rows.
- **Edge Cases Handled:** A single persistence path prevents drift between "reorder saved here" and "column CRUD saved somewhere else," which is the easiest way to create irreconcilable setup-panel state.

### Setup panel UI and autosave payload
#### [MODIFY] `src/webview/setup.html`
- **Context:** The current Kanban Structure accordion is reorder-only. More importantly, the current local-state helper `syncLocalKanbanStructureWithCustomAgents()` reconstructs "custom" rows from `lastCustomAgents`, which would overwrite arbitrary user-authored columns on the next hydration or autosave.
- **Logic:**
  1. Add an "Add Column" button near the existing Kanban Structure header and a "Restore Defaults" button in the same section.
  2. Add a dedicated Add/Edit Column modal in the same style as the custom-agent modal, with these exact fields:
     - label
     - assigned agent role
     - trigger prompt
     - drag/drop mode
  3. Replace the current "custom rows come from `lastCustomAgents` only" logic with explicit local state for user-authored columns. The webview can still derive agent-derived rows from `lastCustomAgents`, but it must preserve user-authored rows coming from `kanbanStructure`.
  4. Update `renderKanbanStructureList()` so each row renders the correct controls by source:
     - built-in fixed (`CREATED`, `COMPLETED`): no delete, no edit
     - built-in non-fixed: hide/show control, no label edit
     - custom-agent-derived: remove-from-board action and drag/drop mode display, but no agent deletion
     - user-authored: edit + delete controls
  5. Update `collectSetupSavePayload()` so it includes `customKanbanColumns` in addition to the existing startup/custom-agent/visibility payload.
  6. Update `flushSetupAutosave()` / `queueSetupAutosave()` so add/edit/delete operations use the same debounce/autosave path as other setup changes.
  7. Keep the existing reorder list and drag handles intact so this feature layers on top of the current reorder UX rather than replacing it.
- **Implementation:**
  - Touch the existing Kanban-structure-related webview surfaces already in use:
    - markup near the Kanban Structure accordion
    - state vars around `lastCustomAgents` / `lastKanbanStructure`
    - `syncLocalKanbanStructureWithCustomAgents()`
    - `getRenderableKanbanStructure()`
    - `renderKanbanStructureList()`
    - `collectSetupSavePayload()`
    - `flushSetupAutosave()`
    - hydration handlers for `customAgents` and `kanbanStructure`
  - Add one new local state collection for persisted user-authored lanes rather than inferring them from the agent list.
- **Edge Cases Handled:** This prevents the UI from dropping custom lanes during hydration, ensures dropdown options stay in sync with built-in + custom agents, and lets restore/default actions reset the UI immediately instead of waiting for a full extension reload.

### Board dispatch, prompt-on-drop, progression, and override cleanup
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** This file currently assumes the board can determine behavior from a column ID alone using hard-coded role mappings and source-column prompt generation. That is no longer enough once multiple distinct target columns can point at the same agent while carrying different prompts or modes.
- **Logic:**
  1. Add a reader for `customKanbanColumns` and build the merged board column definitions with the same shared helper used by setup.
  2. Add a helper that resolves a full dispatch spec from the target column, not just a role string. The resolved object needs, at minimum:
     - `targetColumn`
     - `role`
     - `source`
     - `dragDropMode`
     - `triggerPrompt`
  3. Update `triggerAction` and `triggerBatchAction`:
     - built-in and existing custom-agent columns can continue using the current command path
     - user-authored columns must call the new `TaskViewerProvider` helper so successful dispatch updates the card to the explicit custom lane rather than the role's default built-in lane
  4. Update `promptOnDrop` so when the target lane is a user-authored prompt-mode column, the copied text is generated from the target lane's assigned agent plus its `triggerPrompt`, not from the source column being completed.
  5. Update `moveSelected` and `moveAll` so if the next ordered column is a user-authored lane, the board uses the resolved target-column dispatch spec instead of assuming `_columnToRole(nextCol)` is sufficient.
  6. Update `_getNextColumnId()` so it only collapses the built-in parallel coded lanes (`TEAM LEAD CODED`, `LEAD CODED`, `CODER CODED`, `INTERN CODED`) rather than skipping arbitrary adjacent columns that merely share a broad `kind`.
  7. Add a public cleanup helper used by setup save/reset to prune stale `kanban.orderOverrides` and `kanban.columnDragDropModes` entries for deleted columns, or clear them entirely during restore defaults.
  8. **Clarification:** Keep MCP/conversational target expansion out of this pass unless the implementation necessarily touches those paths. The user requirement here is setup-panel CRUD plus actual board drag/drop behavior.
- **Implementation:**
  - Touch the existing drag/drop and forward-move entry points already proven in this repo:
    - `case 'triggerAction'`
    - `case 'triggerBatchAction'`
    - `case 'promptOnDrop'`
    - `case 'moveSelected'`
    - `case 'moveAll'`
    - `_getNextColumnId()`
    - any column-definition loader currently built from `_getCustomAgents()` + `_buildKanbanColumns(...)`
- **Edge Cases Handled:** This is the change that makes user-defined lanes real. It supports multiple distinct columns assigned to the same agent, prevents prompt-mode custom lanes from copying the wrong prompt, and stops deleted lanes from leaving behind ghost override entries that still influence the board after refresh.

### Regression coverage for setup, persistence, and explicit target-column dispatch
#### [CREATE] `src/test/kanban-custom-column-management-regression.test.js`
- **Context:** The repo already uses source-based regression tests for fragile UI/service wiring. This feature crosses `agentConfig.ts`, `TaskViewerProvider.ts`, `SetupPanelProvider.ts`, and `setup.html`, so it needs a dedicated lock that proves the state shape and webview wiring exist.
- **Logic:**
  1. Read `src/services/agentConfig.ts`, `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, and `src/webview/setup.html` as source text.
  2. Assert `agentConfig.ts` declares `CustomKanbanColumnConfig` and parses `customKanbanColumns`.
  3. Assert `TaskViewerProvider.ts` persists `customKanbanColumns` through `handleSaveStartupCommands()` and returns the expanded setup structure fields.
  4. Assert `SetupPanelProvider.ts` still routes `saveStartupCommands` and, if implemented, routes `restoreKanbanDefaults`.
  5. Assert `setup.html` contains Add Column / Restore Defaults controls, the custom-column modal fields, and `customKanbanColumns` in the autosave payload.
- **Implementation:**
  - Follow the existing regression-test pattern used elsewhere in `src/test/*.test.js`: read source files with `fs.readFileSync(...)` and use `assert.match(...)`/`assert.doesNotMatch(...)` for the critical strings and function signatures.
- **Edge Cases Handled:** Locks the webview/service contract so a future refactor cannot silently drop the new state key or revert the setup panel back to reorder-only behavior.

### Regression coverage for board behavior
#### [CREATE] `src/test/kanban-custom-column-dispatch-regression.test.js`
- **Context:** The most failure-prone part of the feature is not rendering the new column - it is making board actions respect the custom column's explicit target lane, assigned role, and trigger prompt.
- **Logic:**
  1. Read `src/services/KanbanProvider.ts` and `src/services/TaskViewerProvider.ts`.
  2. Assert there is a dedicated helper or branch for dispatching to configured custom columns rather than relying only on `_targetColumnForRole(role)`.
  3. Assert `promptOnDrop` has a target-column-aware path for user-authored prompt-mode lanes.
  4. Assert `_getNextColumnId()` special-cases the built-in coded lanes instead of collapsing every repeated custom kind.
  5. Assert `TaskViewerProvider.ts` exposes the explicit-target dispatch helper that appends the saved `triggerPrompt`.
- **Implementation:**
  - Keep the test source-based and focused. The goal is to freeze the intended coupling points so future refactors cannot accidentally revert custom-column dispatch back to "role default column" behavior.
- **Edge Cases Handled:** This catches the exact regression where the UI saves a custom column successfully, but actual drag/drop still routes the card to the built-in role lane or copies a prompt based on the wrong stage.

## Verification Plan
### Automated Tests
- Add `src/test/kanban-custom-column-management-regression.test.js`.
- Add `src/test/kanban-custom-column-dispatch-regression.test.js`.
- Run `npm run compile` to verify the new shared column model, setup payload changes, and board helpers still compile into the extension bundle.
- Run `npm test` so the new regression files execute under the existing test harness.
- Record that `npm run lint` currently fails at baseline because ESLint 9 cannot find an `eslint.config.*` file in this repo; do not broaden this feature to repair repo-wide lint tooling.

### Manual Checks
1. Open the setup panel, add a user-authored column with:
   - label: `Design Review`
   - assigned agent: `reviewer`
   - trigger prompt: a short review instruction
   - drag/drop mode: `cli`
   Verify the lane appears in the Kanban Structure list, survives autosave, and still exists after reloading the window.
2. Edit the same column to switch drag/drop mode from `cli` to `prompt`, then reload and verify the mode did not revert because of stale `kanban.columnDragDropModes` workspaceState.
3. Hide a non-fixed built-in lane and remove one agent-derived lane from the board. Verify the underlying built-in role and custom-agent definition still exist, but the lanes disappear from the structure and board.
4. Drag a card into a user-authored CLI column assigned to `coder`. Verify the coder receives work, and after refresh the card remains in the user-authored column rather than snapping to `CODER CODED`.
5. Drag a card into a user-authored prompt-mode column. Verify the copied clipboard prompt includes the column's configured `triggerPrompt`, and the board records the card in the intended target lane.
6. Use `moveSelected` / `moveAll` flows on a board that includes multiple adjacent user-authored lanes. Verify the board does not skip them because of over-broad same-kind collapsing.
7. Click Restore Defaults. Verify:
   - user-authored lanes are removed
   - built-in default visibility returns
   - agent-derived lanes are reset to their default "not explicitly shown" state
   - stale order/mode overrides do not resurrect deleted columns on the next refresh

## Agent Recommendation
Send to Lead Coder

## Direct Reviewer Pass (2026-04-12)

### Stage 1 - Grumpy Principal Engineer
- [MAJOR] The setup model finally made custom lanes real, then `_getNextColumnId()` tried to herd them straight back into the legacy reviewer/tester tunnel. With the old hard-coded post-review hop, `moveSelected` / `moveAll` could still skip user-authored lanes after `CODE REVIEWED` and pretend column order was merely decorative.
- [MAJOR] The explicit-target dispatch helper updated the DB column but left the plan-file footer behind. That is how you build a lane that looks real on the board, dispatches real work, and then leaves a different persistence story lying around for state-based recovery paths.
- [NIT] A couple of nearby source-based guards were still policing the old literal shapes instead of the new contract, which meant they were watching wallpaper while the real invariants moved.

### Stage 2 - Balanced Synthesis
- **Keep:** The shared column schema, setup autosave persistence, explicit dispatch-spec resolution, and custom-user prompt/CLI routing architecture are the right foundation.
- **Fix now:** Make `_getNextColumnId()` honor ordered custom lanes after review instead of only the legacy hard-coded tester path; persist plan-file Switchboard State when direct `TaskViewerProvider` dispatch paths move a card; tighten the regression guards so they pin the new contract rather than outdated source formatting.
- **Defer:** Cross-reset/import round-tripping for non-built-in lane IDs still depends on the broader plan-state/import model and deserves a dedicated follow-up if custom-lane state must survive DB rebuilds from plan files alone.

### Fixed Items
- Updated `src/services/KanbanProvider.ts` so `_getNextColumnId()` respects ordered custom lanes while still special-casing only built-in coded/tester behavior.
- Updated `src/services/TaskViewerProvider.ts` so direct configured-column / direct-dispatch column updates also write the plan-file Switchboard State footer.
- Expanded `src/test/kanban-custom-column-dispatch-regression.test.js` to lock both target-column persistence and the refined progression rules.
- Updated `src/test/split-coded-columns-regression.test.js` so the nearby split-lane guard matches the current shared column shape instead of the pre-column-management literal format.

### Files Changed
- `src/services/TaskViewerProvider.ts`
- `src/services/KanbanProvider.ts`
- `src/test/kanban-custom-column-dispatch-regression.test.js`
- `src/test/split-coded-columns-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `node src/test/kanban-custom-column-management-regression.test.js` - **PASSED**
- `node src/test/kanban-custom-column-dispatch-regression.test.js` - **PASSED**
- `node src/test/split-coded-columns-regression.test.js` - **PASSED**
- `npm run lint` - **FAILED (baseline repo issue: ESLint 9 cannot find an `eslint.config.*` file)**

### Remaining Risks
- Non-built-in lane IDs still rely on the wider DB/state model for durable recovery; if plans must round-trip custom lane IDs through plan-file-only reimport/reset flows, that needs dedicated parser/import design.
- `npm test` was not used as acceptance here because the repo's current lint baseline blocks `pretest` before the suite can run.
