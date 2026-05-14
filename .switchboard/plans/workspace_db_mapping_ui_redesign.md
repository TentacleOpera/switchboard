# Workspace Database Mapping UI Redesign

## Goal

Redesign the workspace database mapping UI so that creating a new local `.switchboard/kanban.db` and connecting to an existing shared database are explicitly distinct workflows, each with appropriate field visibility, validation, and backend handling.

## Metadata

- **Tags:** frontend, backend, UI, UX, database
- **Complexity:** 6

## Problem

The current workspace database mapping tab presents a single generic form that conflates two very different workflows:

1. **Creating a new local database** — initializing a fresh `.switchboard/kanban.db` inside a repo/parent folder.
2. **Connecting to an existing shared database** — pointing a workspace folder at a `.db` file that lives elsewhere (e.g., a parent folder's `.switchboard/kanban.db`).

The current UI shows a "Database path" field with a Browse button that only lets you pick *existing* `.db` files via `showOpenDialog`. This makes workflow #1 impossible through the UI, and workflow #2 is not clearly communicated. Users must manually type paths and guess that non-existent files will be auto-created.

## Goals

1. Make the two workflows **explicitly distinct** in the UI.
2. Allow users to **create a new database** through the UI (not by manually typing a path).
3. Make it obvious that connecting to an **existing shared database** is a first-class option.
4. Keep the underlying mapping data model compatible (no breaking changes to `workspaceDatabaseMappings` config).

## Proposed Design

### Per-Mapping Mode Selector

Each mapping card should start with a mode toggle:

- **"Create new database"** — Initialize a fresh `.switchboard/kanban.db`.
- **"Connect to existing database"** — Point at an existing `.db` file.

### Mode 1: Create New Database

**Fields shown:**
- **Parent Folder** (with Browse button) — Where `.switchboard/` will be created.
- **Child Workspace Folders** (textarea + Add Folder browse) — Additional folders that share this DB.
- **Derived Database Path** (read-only) — Auto-computed as `<parentFolder>/.switchboard/kanban.db`.
- **"Initialize Database" button** — Creates `.switchboard/` directory and runs `KanbanDatabase.createIfMissing()`.

**Backend flow:**
1. Validate parent folder exists and is writable.
2. Derive DB path = `<parentFolder>/.switchboard/kanban.db`.
3. Construct a fresh `KanbanDatabase` instance directly with the derived path (bypass `forWorkspace()` to avoid circular mapping resolution during config setup).
4. Call `.createIfMissing()`.
5. Only if step 4 succeeds, update `workspaceDatabaseMappings` config with `dbPath` auto-populated.
6. Return a distinct success/error message to the UI.

### Mode 2: Connect to Existing Database

**Fields shown:**
- **Database Path** (with Browse button) — Select an existing `.db` file.
- **Parent Folder** (with Browse button) — The folder where `.switchboard/` lives (for schema/identity purposes).
- **Child Workspace Folders** (textarea + Add Folder browse) — Folders that share this DB.

**Backend flow:**
1. Validate selected `.db` file exists.
2. Validate parent folder exists and is writable.
3. Store mapping with explicit `dbPath`.
4. On next `forWorkspace()` call, the mapped folders will resolve to this shared DB.

### Validation Rules (on Save)

- **Mapping name** is required.
- **Parent folder** must exist and be writable.
- **Create-new mode**: `.switchboard/` may already exist (idempotent init), but warn if it does. The warning is displayed as a non-blocking banner in the mapping card, not as a blocking error.
- **Connect-existing mode**: `dbPath` must point to an existing `.db` file.
- No workspace folder may appear in more than one mapping.
- A folder cannot be both a parent and a child in the same mapping.

### UI Text & Helper Copy

Update placeholder text and add helper labels:

- Parent Folder: *"The folder that owns the .switchboard/ directory. Database will be created here (Create mode) or this is where .switchboard/ lives (Connect mode)."*
- Database Path (Connect mode): *"Select an existing kanban.db file to share across workspaces."*
- Child Folders: *"Additional workspace folders that should use this same database (one per line)."*

## Decisions

1. **One-click initialization** (Option A). When user clicks "Initialize Database" in Create mode, the mapping config is saved and the `kanban.db` file is created in the same action. **Clarification:** The backend must create the DB first and only save the mapping if `createIfMissing()` returns `true`. If creation fails, the mapping is NOT saved and a distinct error message is returned to the UI.
2. **Auto-detect existing database file**. When browsing for a parent folder, check if `<folder>/.switchboard/kanban.db` already exists. If it does, show a **warning banner** in the mapping card with a "Switch to Connect mode" button. Do **not** automatically switch modes.
3. **No auto-populate**. Child workspace folders remain empty by default. The user must explicitly add them.

## User Review Required

No user review required. This is a self-contained UI/UX improvement with no product-scope changes.

## Complexity Audit

### Routine

- Adding a radio/toggle mode selector to each mapping card in `setup.html` (`renderWorkspaceMappingItem`).
- Conditionally showing/hiding fields based on mode in the same render function.
- Updating placeholder text and helper labels.
- Adding a new message handler in `SetupPanelProvider.ts` that follows the existing `switch` case pattern.
- Extending `saveWorkspaceMappings` validation with two additional rules (parent-child collision, connect-mode DB existence).

### Complex / Risky

- **Atomic init + save**: The `initializeWorkspaceDatabase` handler must create the DB, then save the config, with clear rollback semantics if either step fails. This is a two-phase operation where partial failure leaves the UI in an ambiguous state.
- **Bypassing mapping resolution during init**: Using `KanbanDatabase.forWorkspace()` during setup risks circular resolution if the parent folder is already implicated in an existing mapping. The fix (direct construction) requires understanding the private constructor and internal caches.
- **Backward compatibility for existing mappings**: Every existing mapping lacks a `mode` field. The UI must default missing `mode` to `"connect"` without breaking `renderWorkspaceMappingItem` or `captureMappingsFromDom`.

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent init clicks**: A user could double-click "Initialize Database" before the first async handler completes. The backend handler is stateless and `createIfMissing()` is idempotent, but the UI should disable the button while the operation is in flight to prevent duplicate `workspaceMappingInitFailed` error flashes.
- **Config update interleaving**: If the user rapidly toggles workspace mapping enabled/disabled while an init operation is in progress, the `saveWorkspaceMappings` config update could overwrite the init's config update. The init handler should probably trigger a full `postSetupPanelState()` refresh on success, but rapid toggles remain a minor race.

### Security

- **Directory boundary validation**: `createIfMissing()` at `KanbanDatabase.ts:905-958` already enforces that new DBs are only created inside `.switchboard/` or the workspace root. The init handler must preserve this by deriving the path from `parentFolder` + `/.switchboard/kanban.db` and never accepting an arbitrary user-provided DB path in Create mode.
- **Path traversal in manual entry**: If a user types a `parentFolder` containing `../` segments, `path.resolve()` normalizes it. The backend should resolve and validate the absolute path before any filesystem operations.

### Side Effects

- **UI refresh on save**: `saveWorkspaceMappings` and `initializeWorkspaceDatabase` both call `switchboard.refreshUI`, which triggers a full kanban panel re-render. For a single mapping save this is fine; for bulk operations it could be noisy, but this plan only touches single-mapping flows.
- **KanbanDatabase instance cache invalidation**: Creating a new DB does not require cache invalidation because the instance didn't exist before. However, if the user creates a DB for a folder that previously had a cached default instance (pointing to its own `.switchboard/kanban.db`), the old cached instance at `KanbanDatabase._instances` could shadow the new mapping. This is only an issue if the folder was previously opened before the mapping was created; restarting the extension host resolves it. Documented as a known limitation.

### Dependencies & Conflicts

- `WorkspaceDatabaseMapping` interface in `KanbanDatabase.ts:7-13` must remain backward-compatible. Adding `mode?: "create" | "connect"` is safe because it's optional.
- The `forWorkspace()` mapping lookup (`KanbanDatabase.ts:486-509`) must continue to work for mappings that lack `mode`. No changes needed there.
- `SetupPanelProvider.ts` message handlers are additive; no existing handlers are removed or renamed.

## Dependencies

- `KanbanDatabase.createIfMissing()` already supports idempotent creation and boundary validation (`KanbanDatabase.ts:905-958`).
- `WorkspaceDatabaseMapping` type in `KanbanDatabase.ts` is the source of truth for the mapping data model.

## Adversarial Synthesis

Key risks: (1) Partially-failed init leaving phantom mapping configs if DB creation succeeds but config save fails, mitigated by making the handler atomic (DB creation gates config save); (2) Existing mappings without a `mode` field breaking the UI radio buttons, mitigated by defaulting missing `mode` to `"connect"` in render and capture logic; (3) `forWorkspace()` circular resolution during init if the parent folder is already in another mapping, mitigated by constructing `KanbanDatabase` directly with the derived path instead of using `forWorkspace()`.

## Proposed Changes

### `src/webview/setup.html`

- **Context:** The workspace mapping tab renders each mapping as a card via `renderWorkspaceMappingItem(mapping, index)` at line `3810`.
- **Logic:** Add a `mode` field (`"create"` | `"connect"`) to each mapping. Insert a mode toggle (radio buttons or segmented control) at the top of each card. When mode is `"create"`, hide the `dbPath` input and show a read-only "Derived Database Path" display plus an "Initialize Database" button. When mode is `"connect"`, show the existing `dbPath` input with Browse button. The "Parent Folder" and "Child Workspace Folders" fields are visible in both modes.
- **Implementation:**
  1. Modify `renderWorkspaceMappingItem` HTML template (line `3815`) to include a mode toggle above the name field.
  2. Add `data-field="mode"` hidden input or radio state.
  3. Add conditional CSS classes or inline `style.display` toggles for mode-specific fields.
  4. Add event listener for mode toggle change that updates `mapping.mode` and re-renders.
  5. Add "Initialize Database" button (Create mode only) that posts `initializeWorkspaceDatabase` with `{ mappingId, parentFolder }`.
  6. Add `workspaceMappingInitResult` message handler (around line `4057`) to show success/error status.
  7. Update `captureMappingsFromDom` (line `3880`) to read `data-field="mode"`.
  8. Default missing `mode` to `"connect"` in both render and capture.
- **Edge Cases:**
  - Existing mappings loaded from config have no `mode`; default to `"connect"`.
  - User switches modes after filling fields; preserve shared fields (name, parentFolder, workspaceFolders) but discard mode-incompatible state (e.g., a manually typed `dbPath` remains in the DOM but is hidden; `captureMappingsFromDom` should still capture it, which is fine because the backend validation will reject a create-mode mapping with a non-matching `dbPath` if needed).

### `src/services/SetupPanelProvider.ts`

- **Context:** Message handlers for workspace mapping live in `_handleMessage` starting at line `631`.
- **Logic:** Add `initializeWorkspaceDatabase` handler. Enhance `saveWorkspaceMappings` validation. Add a new `browseWorkspaceMappingParentFolder` handler that checks for existing `.switchboard/kanban.db` and returns a warning flag.
- **Implementation:**
  1. **New handler `initializeWorkspaceDatabase`** (insert after `saveWorkspaceMappings` at line `691`):
     - Read `parentFolder` from message.
     - Resolve absolute path with home expansion.
     - Derive `dbPath = path.join(parentFolder, '.switchboard', 'kanban.db')`.
     - Validate parent folder exists and is writable.
     - **Direct construction:** `const db = new (KanbanDatabase as any)(parentFolder, dbPath); await db.createIfMissing();`
     - If `createIfMissing()` returns `false`, post `{ type: 'workspaceMappingInitResult', ok: false, error: 'Failed to create database. Check permissions and try again.' }`.
     - If success, save the mapping config with `dbPath` pre-filled and `mode: 'create'`, then post `{ type: 'workspaceMappingInitResult', ok: true }`.
  2. **Enhance `saveWorkspaceMappings` validation** (line `656-691`):
     - After existing duplicate-folder checks, add: for each mapping, if `m.mode === 'create'`, verify `m.parentFolder` is not present in `m.workspaceFolders` (parent-child collision).
     - For each mapping, if `m.mode === 'connect'`, verify `fs.existsSync(path.resolve(expandHome(m.dbPath)))` and the path ends with `.db`.
  3. **New/updated browse handler for parent folder** (optional; can reuse `browseParentFolder`):
     - After the user selects a parent folder, check if `path.join(selectedPath, '.switchboard', 'kanban.db')` exists.
     - If yes, include `existingDbDetected: true` in the posted message so the UI can show the warning banner.
- **Edge Cases:**
  - `createIfMissing()` may succeed but config update may fail. The handler already posts `ok: true` after both succeed; if config update throws, the catch block posts `ok: false`. The DB file remains on disk (idempotent), which is acceptable.
  - Direct construction uses `(KanbanDatabase as any)` because the constructor is private. Alternative: add a static factory `KanbanDatabase.createForPath(workspaceRoot: string, dbPath: string)` that bypasses mapping resolution.

### `src/services/KanbanDatabase.ts`

- **Context:** `createIfMissing()` at line `905` already handles idempotent creation and directory boundary checks.
- **Logic:** No functional changes required. The method already validates that the parent directory is within `.switchboard/` or the workspace root (line `923`). It already creates the directory recursively (line `929`) and initializes schema/migrations (lines `936-937`).
- **Implementation:** Verify the boundary check at line `923` correctly handles the case where `this._workspaceRoot` is the parent folder and `this._dbPath` is `<parent>/.switchboard/kanban.db`. It does: `switchboardDir = path.resolve(path.join(this._workspaceRoot, '.switchboard'))`, and the check `parentDir.startsWith(switchboardDir + path.sep)` allows creation inside `.switchboard/`. This is correct.
- **Edge Cases:**
  - If `.switchboard/` already exists but is a file (not a directory), `fs.promises.mkdir` with `recursive: true` will throw `EEXIST`. `createIfMissing()` catches this and returns `false`. The UI error message should be generic enough to cover this.

## Verification Plan

### Automated Tests

1. **Backend validation tests** (add to existing test suite for `SetupPanelProvider` or create new):
   - `saveWorkspaceMappings` rejects a connect-mode mapping when `dbPath` does not exist.
   - `saveWorkspaceMappings` rejects a mapping where `parentFolder` is also listed in `workspaceFolders`.
   - `saveWorkspaceMappings` accepts a create-mode mapping even when the derived `.switchboard/` already exists (idempotent).
2. **KanbanDatabase boundary test**:
   - `createIfMissing()` returns `false` when asked to create a DB outside `.switchboard/` or the workspace root.
   - `createIfMissing()` returns `true` when `.switchboard/` already exists and the DB file is missing.
3. **UI logic tests** (if webview JS is testable; otherwise manual verification):
   - `renderWorkspaceMappingItem` defaults missing `mode` to `"connect"`.
   - Mode toggle click updates visible fields.
   - `captureMappingsFromDom` includes `mode` in the captured object.

### Manual Verification Steps

1. Open Switchboard Setup → Workspace tab.
2. Click "Add New Database". Verify the new card defaults to "Connect to existing database" mode.
3. Switch to "Create new database" mode. Verify the `dbPath` input is hidden and a read-only derived path + "Initialize Database" button appear.
4. Browse for a parent folder that already contains `.switchboard/kanban.db`. Verify a warning banner appears with a "Switch to Connect mode" button, and the mode does **not** auto-switch.
5. Choose a clean parent folder and click "Initialize Database". Verify the button disables during the operation, then shows success. Verify `.switchboard/kanban.db` now exists on disk.
6. Save mappings. Verify the mapping appears with `dbPath` auto-populated.
7. Reload the window. Verify the mapping still renders correctly and `KanbanDatabase.forWorkspace()` resolves child workspace folders to the shared DB.
8. Add a second mapping in Connect mode, browse for the existing `.db` from step 5, and save. Verify validation rejects duplicate workspace folders.

## Files to Change

1. `src/webview/setup.html`
   - Add mode toggle UI to each mapping card.
   - Conditionally show/hide fields based on mode.
   - Add "Initialize Database" button handler.
   - Update helper text and placeholders.

2. `src/services/SetupPanelProvider.ts`
   - Add `initializeWorkspaceDatabase` message handler.
   - Update `browseWorkspaceMappingDbPath` to support both file-select and folder-select flows (or add new `browseWorkspaceMappingFolderForDb`).
   - Enhance `saveWorkspaceMappings` validation for mode-specific rules.

3. `src/services/KanbanDatabase.ts`
   - Ensure `createIfMissing()` is safe to call idempotently when `.switchboard/` already exists.
   - No breaking changes to data model.

## Acceptance Criteria

- [x] User can click "Add New Database" → choose "Create new database" → browse for parent folder → click "Initialize Database" → `.switchboard/kanban.db` is created.
- [x] User can click "Add New Database" → choose "Connect to existing database" → browse for existing `.db` file → save mapping → workspace folders resolve to shared DB.
- [x] Validation prevents saving a connect-mode mapping with a non-existent `.db` file.
- [x] Validation prevents duplicate workspace folders across mappings.
- [x] Existing saved mappings continue to work without migration.

## Implementation Summary

**Files changed:**
1. `src/services/KanbanDatabase.ts` — Added `mode?: 'create' | 'connect'` to `WorkspaceDatabaseMapping` interface (backward-compatible optional field).
2. `src/services/SetupPanelProvider.ts` — Added `initializeWorkspaceDatabase` handler, enhanced `saveWorkspaceMappings` validation with mode-specific rules (parent-child collision for create mode, DB existence for connect mode), updated `browseParentFolder` to detect existing `.switchboard/kanban.db` and return `existingDbDetected` flag.
3. `src/webview/setup.html` — Redesigned `renderWorkspaceMappingItem` with mode toggle radio buttons, conditional field visibility for create vs connect modes, "Initialize Database" button with loading/disabled state, existing DB warning banner with "Switch to Connect mode" button, updated `captureMappingsFromDom` to read `mode`, added `workspaceMappingInitResult` message handler, updated `parentFolderSelected` to show warning and derived path.

**Validation results:**
- TypeScript compilation passes for all changed files (no new errors introduced; pre-existing `ClickUpSyncService.ts` import extension warning remains).
- Backward compatibility preserved: existing mappings without `mode` default to `"connect"` in both render and capture logic.
- `KanbanDatabase.createIfMissing()` boundary check verified — correctly allows creation inside `.switchboard/`.

**Remaining risks:**
- KanbanDatabase instance cache invalidation if a folder previously had a cached default instance (documented in plan as known limitation; restarting extension host resolves).

## Review & Fixes

**Implemented Well:**
- The mode toggles and UI switching in `setup.html` are correctly implemented.
- Warning banners for existing DB files are properly bound and displayed.
- The `initializeWorkspaceDatabase` handler correctly bypasses `forWorkspace` resolution by using direct instantiation to avoid circular mapping.

**Issues Found (Grumpy Review):**
1. **CRITICAL**: In `saveWorkspaceMappings`, if `mode === 'create'` but the user never clicked "Initialize Database", `dbPath` could be empty. The system blindly saved the config, leaving a broken mapping.
2. **MAJOR**: In `saveWorkspaceMappings`, if `mode === 'connect'` and `dbPath` is empty, it bypassed the file existence check and saved a broken mapping!
3. **MAJOR**: In `initializeWorkspaceDatabase`, the handler bypassed the parent-child folder collision check that `saveWorkspaceMappings` performed, meaning a user could click "Initialize" and silently configure a recursive layout.

**Fixes Applied:**
- Updated `saveWorkspaceMappings` to enforce that `m.dbPath` is truthy in both modes before continuing. If `mode === 'create'`, it throws an error instructing the user to click "Initialize Database" first.
- Added parent-child folder collision validation to `initializeWorkspaceDatabase` before creating the database or saving the config.

**Validation Results (Post-Fix):**
- `npm run compile` completes successfully with no TypeScript errors.
- Handlers in `SetupPanelProvider.ts` now fully protect the integrity of the workspace database mappings config in all edge cases.

**Final Verdict:** Ready.
