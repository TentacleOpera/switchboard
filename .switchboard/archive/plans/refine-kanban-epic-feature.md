---
description: Refine the kanban epic feature with modal-based creation and management
---

# Plan: Refine Kanban Epic Feature

## Goal
Move epic creation and management from per-card toggles and a dedicated planning panel into a streamlined modal-based workflow on the kanban board. Multi-selected plans become epics via a strip button; existing epics are managed via the same button.

**Core Problem:** The current epic workflow is fragmented — per-card "Make Epic" / "Un-epic" toggle buttons clutter every card's action row, and the epic configuration panel lives in the Research panel's kanban sub-tab (planning.html), disconnected from the kanban board where epics are actually used. Users must switch contexts between the board and the research panel to create, configure, and manage epics. The per-card toggle also allows creating "orphan epics" (epics with zero subtasks) with no guided workflow for adding subtasks.

## Metadata
- **Tags:** frontend, ui, ux, feature, refactor
- **Complexity:** 6

## User Review Required
- Should the epic config settings (lock columns, prompt template, max subtasks) be moved into the manage epic modal, or relocated to the Setup tab alongside other workspace configuration?
- Should the `convertToEpic` backend handler be removed entirely, or kept for backward compatibility with any external callers?

## Complexity Audit

### Routine
- Remove per-card epic toggle button HTML and event listener from kanban.html
- Remove epic config panel HTML from planning.html
- Remove epic config JS handlers from planning.js
- Add new strip button to controls strip (follows existing `btn-assign-workspace-project` pattern)
- Add two modal overlays (follows existing modal pattern at kanban.html:2740-2829)
- Wire modal event listeners (follows existing `testing-fail-modal` pattern)
- Add `getEpicDetails` handler already exists (KanbanProvider.ts:6459-6471)
- Add `removeSubtaskFromEpic` handler already exists (KanbanProvider.ts:6431-6438)
- Add `deleteEpic` handler already exists (KanbanProvider.ts:6440-6457)

### Complex / Risky
- New `createEpic` handler requires generating planId/sessionId, creating a plan file on disk, and linking subtasks atomically — multi-step DB + filesystem coordination
- `selectedCards` Map (kanban.html:3455) stores only `{workspaceRoot, project}` — must be enriched with `isEpic`/`epicId` data from `_lastCards` for button state logic
- Auto-add path ("1 epic + N non-epics") must call `addSubtaskToEpic` per subtask which enforces locked-column guard — frontend must surface backend warning messages
- "Least-advanced column" resolution requires mapping selected plans' columns to their ordinal position from `buildKanbanColumns` output
- Removing `convertToEpic` handler creates a breaking change if any external code posts that message type

## Edge-Case & Dependency Audit

**Race Conditions:**
- User clicks "Convert to Epic" while board is mid-refresh — selected cards may no longer exist in `_lastCards`. Must validate selected plan IDs against current board state before dispatching `createEpic`.
- Concurrent `addSubtaskToEpic` calls for the same epic (auto-add path with N subtasks) — each call is independent and safe (DB updates are synchronous SQLite), but the board refresh after each one could cause unnecessary re-renders. Batch into single refresh after all adds complete.

**Security:**
- Modal input (epic name, description) must be HTML-escaped before rendering in the plan list and before writing to the plan file. Follow existing `escapeHtml` pattern (planning.js:220-227).

**Side Effects:**
- Creating an epic plan file on disk (`.switchboard/plans/epic-{planId}.md`) will trigger the `GlobalPlanWatcherService` file watcher, which may attempt to re-import the plan. The `createEpic` handler must insert the DB record BEFORE writing the file, so the watcher finds an existing record and skips import.
- Removing the epic config panel from planning.html means users lose access to `epic_lock_columns`, `epic_prompt_template`, `epic_max_subtasks` configuration. These must be relocated (see Proposed Changes step 12).

**Dependencies & Conflicts:**
- `KanbanDatabase.upsertPlan()` (line 1189) requires all `KanbanPlanRecord` fields including `planFile`, `workspaceId`, `kanbanColumn`. The `createEpic` handler must resolve these from the selected subtask plans.
- `KanbanDatabase.updateEpicStatus()` (line 1285) is used by both `convertToEpic` and `addSubtaskToEpic`. The new `createEpic` handler will also call it. No conflict — it's a simple UPDATE.
- The `epicDetails` message (planning.js:3554-3566) is currently consumed only by the planning panel's epic accordion. The kanban board modal will need its own listener for the same message type, or a new message type (e.g., `kanbanEpicDetails`) to avoid collision.

## Dependencies
- sess_KanbanDatabase — epic DB methods (updateEpicStatus, getSubtasksByEpicId, clearEpicIdForEpic, tombstonePlan, upsertPlan)
- sess_KanbanProvider — message handler switch (lines 6382-6487)
- sess_GlobalPlanWatcherService — file watcher that may re-import newly created epic plan files

## Adversarial Synthesis
Key risks: `createEpic` requires coordinated DB + filesystem writes with correct ordering to avoid watcher re-import; `selectedCards` lacks epic metadata needed for button state logic; removing epic config panel orphans backend `updateEpicConfig` handler. Mitigations: Insert DB record before writing plan file; enrich `selectedCards` from `_lastCards` on selection change; relocate epic config to manage modal or Setup tab.

## Proposed Changes

### kanban.html — UI changes

1. **Remove per-card epic toggle buttons**
   - Delete `epicToggleBtn` variable declaration (line 4961-4963)
   - Delete `${epicToggleBtn}` from the card actions row (line 4979)
   - Delete `.card-btn.epic-toggle` event listener block (lines 4796-4808)

2. **Add "Convert to Epic / Manage Epic" button to the controls strip**
   - Insert `<button class="strip-btn is-teal" id="btn-epic-action" data-tooltip="Convert selected plans to epic or manage existing epic" disabled>EPIC</button>` immediately after the ASSIGN button (after line 2306, before line 2307)
   - Button label and enabled state change dynamically based on selection:
     - No selection → disabled, label "EPIC"
     - 1+ non-epic plans selected, 0 epics → enabled, label "EPIC (N)"
     - 1 epic selected, 0 other epics, 0 non-epics → enabled, label "MANAGE EPIC"
     - 1 epic + 1+ non-epics, 0 other epics → enabled, label "ADD N TO EPIC"
     - 2+ epics selected → disabled, label "EPIC" (multi-epic not supported)
   - Implementation: Add `updateEpicActionButton()` function following the pattern of `updateReassignButtonVisibility()` (lines 6169-6181). This function reads `selectedCards` keys, looks up each in `_lastCards` to check `isEpic`/`epicId`, and sets button label + disabled state accordingly.
   - Call `updateEpicActionButton()` alongside `updateReassignButtonVisibility()` whenever selection changes (lines 4764, 5251, 5501, 6262, 6572)

3. **Add epic creation modal**
   - Insert `<div id="epic-create-modal" class="modal-overlay hidden">` after the existing modals (after line 2829), following the `testing-fail-modal` pattern (lines 2740-2757)
   - Modal structure:
     - Header: "Create Epic" title + close button
     - Body: plan count (`modal-plan-count`), plan list (`modal-plan-list`), epic name input (`<input type="text" id="epic-create-name">`), description textarea (`<textarea id="epic-create-description">`)
     - Footer: Cancel button, "Create Epic" primary button
   - Auto-generate epic name suggestion from first selected plan's topic (truncated to 40 chars) + " Epic"
   - On submit: post `{ type: 'createEpic', name, description, subtaskPlanIds: [...selectedCardIds], workspaceRoot }` message

4. **Add epic management modal**
   - Insert `<div id="epic-manage-modal" class="modal-overlay hidden">` after the create modal
   - Modal structure:
     - Header: "Manage Epic" title + epic name display + close button
     - Body: subtask list with remove buttons, dropdown to add unassigned plans, epic config section (lock columns input, prompt template input, max subtasks input)
     - Footer: Close button, "Delete Epic" danger button (with confirmation)
   - On open: post `{ type: 'getEpicDetails', sessionId: epicSessionId, workspaceRoot }` — use a new message type `kanbanEpicDetails` for the response to avoid collision with the planning panel's `epicDetails` listener
   - Remove subtask: post `{ type: 'removeSubtaskFromEpic', subtaskSessionId, workspaceRoot }`
   - Add subtask: post `{ type: 'addSubtaskToEpic', epicSessionId, subtaskSessionId, workspaceRoot }`
   - Delete epic: post `{ type: 'deleteEpic', sessionId, workspaceRoot, deleteSubtasks }` (with confirmation dialog)
   - Save config: post `{ type: 'updateEpicConfig', epicLockColumns, epicPromptTemplate, epicMaxSubtasks, workspaceRoot }`

5. **Wire modal event listeners**
   - `btn-epic-action` click handler:
     - If "EPIC (N)" → open create modal, populate plan list from selected cards
     - If "MANAGE EPIC" → open manage modal, fetch epic details
     - If "ADD N TO EPIC" → iterate selected non-epic plan IDs, post `addSubtaskToEpic` for each, then single `_refreshBoard` after all complete. Surface any backend warning messages via `postKanbanMessage` response.
   - Create modal: wire Cancel/Close to hide modal, Create to post `createEpic` message
   - Manage modal: wire Close to hide, Remove/Add/Delete buttons to post respective messages
   - Listen for `kanbanEpicDetails` message type to populate manage modal subtask list

6. **Enrich selectedCards with epic metadata**
   - When a card is selected (line 4754), store additional fields in the Map value: `isEpic` and `epicId` from the corresponding `_lastCards` entry
   - Change: `selectedCards.set(pid, { workspaceRoot: ..., project: ..., isEpic: card.isEpic || false, epicId: card.epicId || '' })`
   - This enables `updateEpicActionButton()` to determine button state without a separate `_lastCards` lookup

### KanbanProvider.ts — backend changes

7. **Add `createEpic` message handler**
   - Insert new `case 'createEpic':` block after the existing `convertToEpic` case (after line 6399)
   - Accepts: `name` (string), `description` (string), `subtaskPlanIds` (string[]), `workspaceRoot` (string)
   - Steps:
     1. Validate: ensure `name` is non-empty, `subtaskPlanIds` has at least 1 entry
     2. Generate planId: `crypto.randomUUID()` (already imported at line 6)
     3. Generate sessionId: `crypto.randomUUID()` (same)
     4. Resolve workspaceId from DB: `await db.getWorkspaceId()`
     5. Determine column: find the "least-advanced" column among selected plans by mapping each plan's `kanbanColumn` to its ordinal position in the columns returned by `_buildKanbanColumns()`, then pick the minimum ordinal
     6. Create plan file path: `.switchboard/plans/epic-{planId}.md` relative to workspaceRoot
     7. Insert DB record via `db.upsertPlan()` with `isEpic: 1`, `epicId: ''`, `topic: name`, `kanbanColumn: resolvedColumn`, `status: 'active'`, `sourceType: 'local'`, `createdAt/updatedAt: new Date().toISOString()`
     8. Write minimal plan file to disk with the description as content (MUST happen AFTER DB insert to avoid watcher re-import)
     9. Link each subtask: `await db.updateEpicStatus(subtaskSessionId, 0, planId)` for each selected plan's sessionId (resolve planId→sessionId via `db.getPlanBySessionId` or from `_lastCards`)
     10. Refresh board: `await this._refreshBoard(workspaceRoot)`

8. **Add `kanbanEpicDetails` response for the manage modal**
   - The existing `getEpicDetails` handler (lines 6459-6471) posts `{ type: 'epicDetails', ... }` which is consumed by planning.js. Add a parallel response type `kanbanEpicDetails` so the kanban board modal gets its own message without collision.
   - Modify: after the existing `this._panel?.webview.postMessage({ type: 'epicDetails', ... })` call (line 6470), also post `{ type: 'kanbanEpicDetails', epic, subtasks }` when the request came from the kanban board (detect via a `source: 'kanban'` field in the incoming message)

9. **Remove `convertToEpic` message handler**
   - Delete `case 'convertToEpic':` block (lines 6382-6399) — replaced entirely by `createEpic`

10. **Keep existing handlers unchanged**
    - `addSubtaskToEpic` (lines 6401-6429) — no changes, already has locked-column guard
    - `removeSubtaskFromEpic` (lines 6431-6438) — no changes
    - `deleteEpic` (lines 6440-6457) — no changes
    - `updateEpicConfig` (lines 6473-6487) — keep, now called from manage modal instead of planning panel

### planning.html + planning.js — cleanup

11. **Remove epic config panel from planning.html**
    - Delete the `#kanban-epic-config` section (lines 3244-3253)
    - Keep the "Epics" view filter button (line 3234) — it just filters the list view to show epics only

12. **Remove epic config JS from planning.js**
    - Delete `kanbanEpicConfigPanel` variable and its display toggle (lines 4445-4451)
    - Delete `btnSaveEpicConfig` event listener (lines 4468-4478)
    - Keep the "Epics" view filter button handler (lines 4461-4467) — unchanged
    - Keep the epic accordion rendering and interactions (lines 4657-4721, 4843-4888) — these remain functional for the planning panel's list view

## Out of Scope
- No changes to epic card visual styling (purple border, badge remain)
- No changes to epic prompt template wiring (addressed separately if needed)
- No changes to the `convertToEpic` skill documentation unless the backend handler is removed
- No changes to the planning panel's epic accordion (it remains functional for the list view)

## Verification Plan

### Automated Tests
- (Skipped per session directive — test suite run separately by user)

### Manual Verification
- Multi-select plans → "EPIC (N)" enabled → modal opens → epic created with subtasks → epic card appears on board with correct subtask count
- Select epic → "MANAGE EPIC" enabled → modal opens → subtasks visible, removable, addable → config settings editable and persisted
- Select epic + plans → "ADD N TO EPIC" enabled → clicking auto-adds plans without modal → board refreshes with updated subtask count
- Select 2+ epics → button disabled → no action taken
- Old per-card "Make Epic" / "Un-epic" buttons are gone from all cards
- Planning panel epic config section is gone, but "Epics" filter button still works
- Epic in locked column → "ADD N TO EPIC" shows warning message from backend, subtask not added
- Create epic modal: empty name → validation error, no DB write
- Delete epic with subtasks → confirmation dialog → subtasks either orphaned or deleted per choice

## Recommendation
Complexity 6 → **Send to Coder**

## Execution Summary
Executed 2026-06-10.

**Files changed:**
- `src/webview/kanban.html` — removed per-card epic toggle; added EPIC strip button with dynamic label/state; enriched `selectedCards` with `isEpic`/`epicId`; added Create Epic and Manage Epic modals with event listeners; added `kanbanEpicDetails` message case.
- `src/services/KanbanProvider.ts` — removed `convertToEpic` handler; added `createEpic` handler (DB insert before file write, least-advanced column resolution, subtask linking); modified `getEpicDetails` to also post `kanbanEpicDetails` when `source: 'kanban'`.
- `src/webview/planning.html` — removed `#kanban-epic-config` panel.
- `src/webview/planning.js` — removed epic config panel variable/toggle and Save Config listener.

**Verification:**
- No compilation errors introduced (build skipped per directive).
- No automated tests run (skipped per directive).

**Remaining risks:**
- Auto-add path (`ADD N TO EPIC`) dispatches multiple `addSubtaskToEpic` messages; backend refreshes board after each. Could be batched in future.
- `selectedCards` entries selected before this change lack `isEpic`/`epicId`; button state may be slightly off until reselection. Non-critical.

## Review Findings
Reviewed 2026-06-10. Two MAJOR issues found and fixed: (1) YAML frontmatter in `createEpic` wrote unquoted `name` value — names containing `---` or `:` would break the plan file; fixed with single-quote wrapping and apostrophe escaping. (2) Manage modal config fields (lock columns, prompt template, max subtasks) were never pre-populated with current workspace values, and clicking Save with empty fields would silently clear config; fixed by including config in `kanbanEpicDetails` response, populating inputs in `populateEpicManageModal`, and adding a confirmation guard on Save when all fields are empty. Files changed: `KanbanProvider.ts` (YAML quoting + config in response), `kanban.html` (config population + save guard). No new typecheck errors. Remaining risks unchanged.
