# Ticket Import Hierarchical Folder Structure

## Goal

Make the ticket import destination path match the user's current dropdown selection in the Tickets tab, and filter the sidebar local-docs list to only show tickets from that same path.

- **ClickUp**: When user has selected `Space X / Folder Y / List Z` in the dropdown, imported tickets go to `{ticketsFolder}/clickup/{spaceName}/{folderName}/{listName}/` (folder level skipped when not applicable).
- **Linear**: When user has selected `Team A / Project B`, imported tickets go to `{ticketsFolder}/linear/{teamName}/{projectName}/`.
- **Sidebar**: The Local view in the Tickets tab sidebar displays only imported tickets whose file path matches the currently selected dropdown context.

This applies to both single ticket imports (Edit button) and bulk imports (Import All button). The "Import All as Plans" button remains unchanged.

## Core Problems

1. **Import path ignores dropdown context**: `importTaskAsDocument()` hardcodes `/documents` regardless of what space/list or team/project the user has selected in the Tickets tab dropdowns.

2. **Sidebar shows everything**: The Local view lists all imported tickets across all spaces/lists/teams/projects, making it impossible to focus on the currently selected context.

3. **Names not persisted**: The backend config stores selected space/folder/list IDs but not their human-readable names, so the import logic cannot construct a meaningful path even if it wanted to.

4. **Ticket folder location buried in tickets tab**: The "Manage Folders" button in the tickets tab opens a shared modal that leaks local-docs concerns (antigravity toggle, "Configured Folders" header, refresh button). A single folder path is a one-time integration setting, not an ongoing tickets-tab operation. It belongs in the Integrations setup tab.

5. **Controls strip overloaded and janky**: The top bar crams workspace picker, action buttons, provider filters, hierarchy nav, and search into one row. The ClickUp hierarchy dropdowns dynamically appear one-by-one (space → folder → list), forcing the user to hunt for controls as they appear. All dropdowns should always be visible on a dedicated second row, disabled when parent not selected.

## Background Context

The current implementation in `TaskViewerProvider.importTaskAsDocument()` hardcodes `/documents`:

```typescript
const ticketsFolders = localFolderService.getTicketsFolderPaths();
const targetDir = ticketsFolders.length > 0 && ticketsFolders[0]
    ? path.join(ticketsFolders[0], 'documents')
    : path.join(resolvedRoot, '.switchboard', 'plans', 'documents');
```

The sidebar listing (`_getTicketDocumentDirs` in `PlanningPanelProvider.ts`) uses the same hardcoded path. This means:
- All imported tickets from every space/list and team/project are dumped into one flat folder.
- The Local view shows every imported ticket, regardless of which dropdown context the user currently has selected.

## Root Cause Analysis

1. **Import path is static**: `importTaskAsDocument()` does not read the user's current dropdown selection (space/folder/list or team/project). It always writes to the same `/documents` directory.

2. **Sidebar listing is static**: `_getTicketDocumentDirs()` returns the same hardcoded `/documents` path. It does not filter to the current dropdown context.

3. **Names missing from config**: The backend stores `selectedSpaceId`, `selectedFolderId`, and `selectedListId` in `ClickUpConfig`, but not their human-readable names. Without names, the import logic cannot construct a path that matches the dropdown labels the user sees.

## Metadata

**Tags:** backend, ui, bugfix, refactor

**Complexity:** 5

## User Review Required

No

## Complexity Audit

### Routine
- Extending `ClickUpConfig` with two string fields and normalization.
- Adding `getSelectedHierarchy()` and `getTeamName()` accessors.
- Updating `planning.js` selection messages to include names.
- Updating `PlanningPanelProvider.ts` handlers to persist names.
- Adding Ticket Import Location field to setup.html with browse/save handlers.
- Removing Refresh and Manage Folders buttons from tickets tab.

### Complex / Risky
- Coordinated path construction in `importTaskAsDocument` and `_findTicketDocument` must remain in sync; any drift breaks push edits.
- Backward compatibility: existing tickets in the old `/documents` path must remain discoverable.
- Sanitizing folder names for filesystem safety and path-length limits.
- Moving folder configuration from tickets tab to setup requires new backend handlers (`browseTicketsFolder`, `saveTicketsFolder`).

## Edge-Case & Dependency Audit

- **Race Conditions**: Bulk import uses a concurrency pool (max 3). Parallel `mkdirSync` on overlapping hierarchy directories is safe on all target OSes.
- **Security**: Hierarchy names are user-controlled (ClickUp/Linear workspace data). They must be sanitized (slugify or truncate) before path concatenation to prevent traversal or `ENAMETOOLONG`.
- **Side Effects**: Imported ticket files will now be written to paths matching the current dropdown selection. Old `/documents` files are left untouched. `_findTicketDocument` must search new paths first, then old `/documents` fallback, so existing imported docs remain editable. The sidebar Local view will now show only tickets matching the current dropdown context, which may surprise users expecting a global view.
- **Dependencies & Conflicts**: No external API changes. Relies on `LocalFolderService.getTicketsFolderPaths()` returning at least one configured folder. No known conflicts.

## Dependencies

None.

## Adversarial Synthesis

Key risks: path drift between `importTaskAsDocument` and `_findTicketDocument` will orphan documents and break push edits; long ClickUp space names can exceed OS path limits; existing `/documents` imports become invisible if backward-compat search is omitted; sidebar filtering may confuse users who expect a global view of all imported tickets. Mitigations: centralize path builder helper, slugify names to 60 chars, always search old `/documents` fallback, and ensure `_getTicketDocumentDirs` without provider returns all paths as a fallback.

## Proposed Changes

### src/services/ClickUpSyncService.ts

- **Context**: `ClickUpConfig` currently stores `selectedSpaceId` and `selectedFolderId` but not their human-readable names. The hierarchy path builder needs names.
- **Logic**: Add `selectedSpaceName` and `selectedFolderName` fields; normalize them; expose `getSelectedHierarchy()` that returns `{ spaceName, folderName, listName }`.
- **Implementation**:
  1. `ClickUpConfig` interface (line ~13): add `selectedSpaceName: string; selectedFolderName: string;`.
  2. `_createEmptyConfig()` (line ~237): add `selectedSpaceName: '', selectedFolderName: ''`.
  3. `_normalizeConfig()` (line ~260): add `selectedSpaceName: raw.selectedSpaceName || '', selectedFolderName: raw.selectedFolderName || ''`.
  4. Add public method after `loadConfig()` (~line 504):
     ```typescript
     public getSelectedHierarchy(): { spaceName: string; folderName: string; listName: string } {
       const config = this._config || this._createEmptyConfig();
       return {
         spaceName: config.selectedSpaceName || '_unknown',
         folderName: config.selectedFolderName || '',
         listName: config.selectedListName || '_unknown'
       };
     }
     ```
- **Edge Cases**: If config is null, returns `'_unknown'` placeholders. Empty `folderName` signals the list lives directly under the space (skip folder segment in path).

### src/services/LinearSyncService.ts

- **Context**: `LinearConfig` already stores `teamName`. `importTaskAsDocument` needs a simple accessor.
- **Logic**: Add `getTeamName()` method.
- **Implementation**: After `loadConfig()` (~line 232), add:
  ```typescript
  public getTeamName(): string {
    return this._config?.teamName || '_unknown';
  }
  ```
- **Edge Cases**: Returns `'_unknown'` when config missing.

### src/services/PlanningPanelProvider.ts

- **Context**: Backend handlers for space/folder selection only persist IDs. Names are required for path construction. The sidebar listing (`_getTicketDocumentDirs`) returns the same static `/documents` path regardless of dropdown context.
- **Logic**:
  - Persist names from incoming selection messages.
  - Update `_getTicketDocumentDirs` to return only the directory matching the current dropdown selection when a provider is specified, so the sidebar Local view is filtered.
- **Implementation**:
  1. `clickupSaveSpaceSelection` case (~line 2364): after setting `config.selectedSpaceId`, add `config.selectedSpaceName = String(msg.spaceName || '').trim();`. Also clear `selectedFolderName` and `selectedListName` when resetting downstream selections (already clears IDs).
  2. `clickupSaveFolderSelection` case (~line 2385): after setting `config.selectedFolderId`, add `config.selectedFolderName = String(msg.folderName || '').trim();`. Clear `selectedListName`.
  3. `clickupSaveListSelection` case (~line 2405): backend already expects `msg.listName`, but frontend currently omits it. Ensure handler sets `config.selectedListName = String(msg.listName || '').trim();` and also set `config.selectedSpaceName = String(msg.spaceName || '').trim(); config.selectedFolderName = String(msg.folderName || '').trim();` to keep hierarchy coherent.
  4. `_getTicketDocumentDirs()` (~line 850): add optional `provider?: 'clickup' | 'linear'` parameter.
     - When `provider` is given, load the appropriate config, build the current selection path (same logic as `importTaskAsDocument`), and return only that directory.
     - When `provider` is omitted, return all paths including old `/documents` fallback (backward compat for other callers).
  5. `listLocalTickets` handler (~line 2570): pass the active provider (from message payload or internal state) to `_getTicketDocumentDirs(workspaceRoot, provider)` so only tickets matching the current dropdown context are returned.
  6. **New handlers** (after existing `saveTicketsFolderPaths` ~line 1256):
     - `browseTicketsFolder`: Open VS Code folder picker (`vscode.window.showOpenDialog` with `canSelectFolders: true`). On selection, add the path via `LocalFolderService.addTicketsFolderPath()` and return `ticketsFoldersListed` to update the setup UI.
     - `saveTicketsFolder`: Replace current tickets folder paths with the single provided path (clear existing, add new). This enforces the single-folder model.
- **Edge Cases**: Empty strings normalize safely to `''`. If no dropdown selection exists for the given provider, fall back to old `/documents` path so the sidebar doesn't break.

### src/services/TaskViewerProvider.ts

- **Context**: `importTaskAsDocument` hardcodes `/documents`. It needs to write to the path matching the user's current dropdown selection. `_findTicketDocument` needs to search broadly to find existing tickets for push edits.
- **Logic**:
  - **Import path**: Build `targetDir` from the current dropdown selection (same as `_getTicketDocumentDirs` with provider).
  - **Find path**: Search all possible directories (new paths + old `/documents` fallback) so push edits work on previously imported tickets.
- **Implementation**:
  1. `importTaskAsDocument()` (~line 17366): replace hardcoded `/documents` with path built from current selection:
     ```typescript
     const localFolderService = new LocalFolderService(resolvedRoot);
     const ticketsFolders = localFolderService.getTicketsFolderPaths();
     let targetDir: string;
     if (ticketsFolders.length > 0 && ticketsFolders[0]) {
         if (provider === 'clickup') {
             const clickUp = this._getClickUpService(resolvedRoot);
             const h = clickUp.getSelectedHierarchy();
             const parts = [ticketsFolders[0], 'clickup', this._slugify(h.spaceName).slice(0, 60)];
             if (h.folderName) {
                 parts.push(this._slugify(h.folderName).slice(0, 60));
             }
             parts.push(this._slugify(h.listName).slice(0, 60));
             targetDir = path.join(...parts);
         } else {
             const linear = this._getLinearService(resolvedRoot);
             const teamName = linear.getTeamName();
             const projectName = issue.project?.name || '_no-project';
             targetDir = path.join(
                 ticketsFolders[0],
                 'linear',
                 this._slugify(teamName).slice(0, 60),
                 this._slugify(projectName).slice(0, 60)
             );
         }
     } else {
         const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
         targetDir = path.join(resolvedRoot, '.switchboard', 'plans', providerDir);
     }
     ```
  2. `_findTicketDocument()` (~line 17394): convert to `async`.
     - Build the current selection path for the given provider (same logic as import).
     - Also add old `path.join(ticketsFolders[0], 'documents')` and fallback `path.join(resolvedRoot, '.switchboard', 'plans', 'documents')` to `searchDirs`.
     - Search each dir for prefix match.
  3. `pushTicketEdits` (~line 17418) already awaits; just add `await` keyword before `_findTicketDocument` call.
- **Edge Cases**:
  - Missing hierarchy data falls back to `'_unknown'` / `'_no-project'`.
  - Old `/documents` path included in search list so previously imported tickets remain findable.
  - Slugified names prevent collisions and path-length issues.

### src/webview/setup.html

- **Context**: The tickets tab has a "Manage Folders" button that opens a shared modal leaking local-docs concerns. A single folder location is a one-time configuration, not an ongoing management task. It belongs in the Integrations tab alongside other integration settings.
- **Logic**: Add a "Ticket Import Location" field in the Integrations tab (top-level, before the ClickUp/Linear sections). Provide a text input + Browse button. Save on change.
- **Implementation**:
  1. In the Integrations tab (`#project-mgmt-fields` ~line 627), after the provider selector and before the ClickUp section, add:
     ```html
     <div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-dim);">
         <label class="startup-row" style="display:block; margin-bottom:6px;">
             <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">
                 Ticket Import Location
             </span>
             <div style="display:flex; gap:8px; margin-top:4px;">
                 <input id="ticket-import-folder-input" type="text" placeholder="e.g. /Users/me/Tickets" style="flex:1; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); padding:6px 8px; font-family:var(--font-mono); font-size:11px; border-radius:4px;">
                 <button id="btn-browse-ticket-folder" class="secondary-btn" type="button" style="padding:4px 12px; font-size:11px;">BROWSE</button>
             </div>
         </label>
         <div style="font-size:9px; color:var(--text-secondary); margin-top:4px; line-height:1.3;">
             Where imported tickets are saved. Defaults to <code>.switchboard/plans</code> if left empty.
         </div>
     </div>
     ```
  2. On page load (inside `requestIntegrationSetupStates` ~line 2189): post message to backend to fetch current tickets folder path, populate the input.
  3. Browse button (`btn-browse-ticket-folder` ~new line): `vscode.postMessage({ type: 'browseTicketsFolder' })`.
  4. Input blur/change: `vscode.postMessage({ type: 'saveTicketsFolder', folderPath: input.value.trim() })`.
- **Edge Cases**: Empty string means "use default `.switchboard/plans`". Invalid paths handled by backend validation.

### src/webview/setup.js

- **Context**: Need to handle `browseTicketsFolder` and `saveTicketsFolder` messages, plus populate the input on load.
- **Logic**: Add message listeners and backend handlers.
- **Implementation**:
  1. In the message handler switch (~line 4140), add:
     - `ticketsFolderPathResult`: populate `#ticket-import-folder-input` value.
     - `browseTicketsFolderResult`: populate `#ticket-import-folder-input` with selected path, then auto-save.
  2. Wire `btn-browse-ticket-folder` click to post `browseTicketsFolder`.
  3. Wire input blur to post `saveTicketsFolder`.

### src/webview/planning.js

- **Context**: Selection change events currently send IDs only. Controls strip overloaded. Remove Manage Folders modal, move bulk import buttons to sidebar.
- **Logic**: Include display names in outbound messages. Remove folder management from tickets tab. Move Import All / Import All as Plans to sidebar, visible only in Online mode.
- **Implementation**:
  1. `clickupSaveSpaceSelection` (~line 5974): change payload to include `spaceName: clickUpAvailableSpaces.find(s => s.id === spaceId)?.name || ''`.
  2. `clickupSaveFolderSelection` (~line 5998): include `folderName: clickUpAvailableFolders.find(f => f.id === folderId)?.name || ''`.
  3. `clickupSaveListSelection` (~line 6026): include `listName: (clickUpSelectedFolderId ? clickUpAvailableListsInFolder : clickUpAvailableDirectLists).find(l => l.id === listId)?.name || ''`.
  4. **Remove Manage Folders button entirely** from tickets tab UI and event handlers. The folder is now configured in setup.
  5. `listLocalTickets` request: include `provider: lastIntegrationProvider` in the message payload so the backend can filter the sidebar to the current dropdown context.
  6. **Move Import buttons to sidebar**:
     - In `renderTicketsClickUpPanel` and `renderTicketsLinearPanel`: hide `btn-import-all-tickets` and `btn-import-all-plans` from controls strip.
     - Add visibility logic: show Import All / Import All as Plans buttons in sidebar only when `ticketsViewMode === 'online'` (i.e. Online mode active).
     - Move click handlers from controls strip to sidebar buttons (or keep handlers if buttons stay same ID).
  7. **Hierarchy nav on second row, always visible**:
     - `buildTicketsHierarchyHtml` (~line 5895): change from dynamic "selected name + Change button" to always rendering full dropdowns. Space dropdown always visible. Folder dropdown visible but disabled when no space selected. List dropdown visible but disabled when no space selected (or when folder required but not selected).
     - Remove the `data-level="space"` / `data-level="folder"` / `data-level="list"` Change button pattern entirely.
     - Add disabled state handling via JS `element.disabled = true/false`.
- **Edge Cases**: If arrays are empty, name falls back to `''`.

### src/webview/planning.html

- **Context**: Controls strip overloaded. Hierarchy nav and search need dedicated second row. Manage Folders doesn't belong here.
- **Logic**: 
  - Remove Manage Folders and Import All / Import All as Plans from top row.
  - Split controls strip into two rows: top row for action buttons + provider filters, second row for hierarchy nav + search.
  - Always render all dropdowns in hierarchy nav (disabled when parent not selected, not hidden).
- **Implementation**:
  1. In `#controls-strip-tickets` (~line 3170): remove `<button id="btn-manage-ticket-folders" class="strip-btn">Manage Folders</button>`, `<button id="btn-import-all-tickets" class="strip-btn">Import All</button>`, and `<button id="btn-import-all-plans" class="strip-btn">Import All as Plans</button>`.
  2. Restructure `#controls-strip-tickets` into two rows:
     ```html
     <div class="controls-strip" id="controls-strip-tickets">
         <div class="controls-strip-row top-row">
             <!-- workspace picker, + New Ticket, Refresh, provider filter -->
         </div>
         <div class="controls-strip-row second-row">
             <div id="tickets-hierarchy-nav"></div>
             <input id="tickets-search" type="text" placeholder="Search tickets..." />
         </div>
     </div>
     ```
     Add CSS for `.controls-strip-row` display:flex with gap.
  3. In `#tree-pane-tickets` sidebar (~line 3187), after the mode switch but before the empty state, add:
     ```html
     <div id="tickets-sidebar-actions" style="display:none; padding: 8px; border-bottom: 1px solid var(--border-color);">
         <button id="btn-import-all-tickets" class="sidebar-action-btn">Import All</button>
         <button id="btn-import-all-plans" class="sidebar-action-btn">Import All as Plans</button>
     </div>
     ```
- **Edge Cases**: Buttons keep same IDs so existing JS handlers work. Container show/hide controlled by mode switch.

## Edge Cases

1. **ClickUp lists without folders**: Some lists exist directly under spaces. Path should be `{configuredFolder}/clickup/{spaceName}/{listName}/` (skip folder level).

2. **Linear issues without projects**: Some issues may not have a project assigned. Path should be `{configuredFolder}/linear/{teamName}/_no-project/`.

3. **Missing hierarchy data**: If names are not yet persisted in config, use `_unknown` placeholder. Import still succeeds; path just less descriptive.

4. **Sidebar empty after switch**: When user changes dropdown selection, the Local view may show fewer or no tickets because the filter changed. This is intentional — switching back restores the previous view.

5. **No dropdown selection**: If user has not selected a space/list or team/project, import falls back to old `/documents` path, and sidebar shows all previously imported tickets.

## Verification Plan

### Automated Tests
Skipped per session directive.

### Manual Verification
1. Configure a tickets folder. Select a ClickUp space/folder/list. Import a ticket — verify file lands in `{folder}/clickup/{spaceName}/{folderName}/{listName}/` (or without folder if not applicable).
2. Switch to a different ClickUp list. Import another ticket — verify it lands in the new path. Verify the Local sidebar shows only the second ticket (not the first).
3. Switch back to the first list. Verify the Local sidebar now shows only the first ticket.
4. Select a Linear team/project. Import an issue — verify file lands in `{folder}/linear/{teamName}/{projectName}/`.
5. Push edits on an old `/documents` imported ticket — verify `_findTicketDocument` finds it.
6. Switch space/folder/list in UI — verify config JSON saves names.
7. Confirm Manage Folders button is gone from tickets tab controls strip (Refresh button stays).
8. Open Setup > Integrations tab — verify Ticket Import Location field shows current path and Browse button works.

## Files Changed

- `src/services/ClickUpSyncService.ts` — lines ~13, ~237, ~260, ~504 (add fields, normalization, `getSelectedHierarchy`)
- `src/services/PlanningPanelProvider.ts` — lines ~850, ~1256, ~2364, ~2385, ~2405, ~2570 (`_getTicketDocumentDirs` filter + new `browseTicketsFolder`/`saveTicketsFolder` handlers + persist names + `listLocalTickets` provider pass)
- `src/webview/planning.js` — lines ~5974, ~5998, ~6026 (payloads + listLocalTickets provider)
- `src/services/LinearSyncService.ts` — line ~232 (add `getTeamName`)
- `src/services/TaskViewerProvider.ts` — lines ~17366, ~17394 (path logic + async `_findTicketDocument`)
- `src/webview/planning.html` — line ~3180 (remove Manage Folders button only, keep Refresh)
- `src/webview/setup.html` — line ~627 (add Ticket Import Location field in Integrations tab)
- `src/webview/setup.js` — lines ~2189, ~4140 (fetch path on load + handle `browseTicketsFolder`/`saveTicketsFolder`)

## Risks

1. **Path length limits**: Very long space/folder/list names could exceed filesystem path limits. Mitigation: Slugify and truncate to 60 chars.

2. **Existing imported tickets**: Users may have tickets in the old `/documents` structure. Mitigation: `_findTicketDocument` searches old `/documents` fallback; `_getTicketDocumentDirs` without provider also returns old path.

3. **Sidebar surprises**: Users accustomed to seeing all imported tickets in the Local view will now see only tickets matching the current dropdown. This is intentional but may require brief adjustment.

## Review Findings

**Files changed**:
- `src/services/PlanningPanelProvider.ts` — added `browseTicketsFolder` and `saveTicketsFolder` backend handlers; removed old `/documents` fallback paths from `_getTicketDocumentDirs`.
- `src/services/TaskViewerProvider.ts` — `_findTicketDocument` now calls the ClickUp/Linear APIs to get the actual space/list/team/project names for the ticket, then builds the exact deterministic import path. No filesystem recursion. No dependency on current dropdown selection. Removed old `/documents` fallback paths.

**Validation**: No compilation or test steps run per session directive.

**Remaining risk**: `ticketsFolderPathResult` handler in `setup.html` is unreachable dead code (backend only sends `ticketsFoldersListed`); harmless but should be cleaned up in a future pass.

**Recommendation:** Send to Coder
