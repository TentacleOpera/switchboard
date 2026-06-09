# Update Database Tab for Multi-Root Workspace Support

## Goal

Update the **Database** tab in `setup.html` to enumerate all active databases across a multi-root VS Code: workspace, showing per-database actions (change location, rebuild, Notion backup) while accounting for `workspaceDatabaseMappings` that cause multiple roots to share a single database.

## Metadata

- **Tags:** frontend, backend, database, UI
- **Complexity:** 7

## User Review Required

- Confirm Phase 1 limitation: mapped roots show read-only DB path with a redirect to the Workspace tab.
- Confirm whether per-root custom DB paths (outside mappings) need a new config key now, or can wait.

## Complexity Audit

### Routine
- Add `getAllDbPaths` message handler in `SetupPanelProvider.ts` (~line 563, alongside existing `getDbPath` handler).
- Update tab hydration in `setup.html` (~line 1521) to call `getAllDbPaths` instead of `getDbPath`.
- Add `allDbPathsUpdated` message handler in `setup.html` JavaScript.
- Update Notion backup/restore buttons to include `targetWorkspaceRoot` in posted messages.

### Complex / Risky
- **`handleGetAllDbPaths()` grouping logic in `TaskViewerProvider.ts`:** Must call `KanbanDatabase.forWorkspace(root)` for each workspace folder. This method has a side effect (creates/returns a cached `KanbanDatabase` instance), and grouping must use the instance's `.dbPath` property. Deduplication must be correct when mappings cause multiple roots to resolve to the same DB path.
- **Updating `handleSetLocalDb` / `handleSetCustomDbPath` / `handleSetPresetDbPath` / `handleResetDatabase`:** These currently call `this._getWorkspaceRoot()` which returns the first workspace folder. They must be updated to accept an optional `targetWorkspaceRoot`, resolve it via `this._resolveWorkspaceRoot(targetRoot)`, and use that resolved root for all DB path and migration operations. If no target is provided, fall back to the first root for backward compatibility.
- **Updating the `switchboard.resetKanbanDb` command in `extension.ts` (~line 1480):** Currently hardcodes `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`. Must be updated to accept an optional `workspaceRoot` argument so `handleResetDatabase` can target a specific root. The command registration signature changes from `registerCommand('switchboard.resetKanbanDb', async () => { ... })` to `registerCommand('switchboard.resetKanbanDb', async (workspaceRoot?: string) => { ... })`.
- **Dynamic UI rendering in `setup.html`:** The current static single-database section (`#current-db-path`, radio buttons, rebuild button, Notion section) must be replaced with a dynamic card list rendered by `renderDatabases(databases)`. This requires:
  - Generating unique element IDs per database card (e.g., `db-card-${index}`).
  - Binding event listeners to dynamically created elements (or using event delegation).
  - Handling `allDbPathsUpdated` array payload and clearing/re-rendering `#databases-list`.
  - Preserving `dbPathUpdated` backward compatibility for the sidebar webview, which also uses this message type. **Decision:** Keep `dbPathUpdated` as-is for the sidebar; the Database tab uses the new `allDbPathsUpdated` message.
- **Detecting mapped vs unmapped roots:** For `isMapped` in the `allDbPathsUpdated` payload and for disabling location changes on mapped roots, read `workspaceDatabaseMappings` config directly in `handleGetAllDbPaths()`. A root is mapped if it appears in any mapping's `workspaceFolders` array and the mapping's `mode` is not `'connect'` with a custom `dbPath`, OR if the root itself is the `parentFolder` of a mapping. Clarification: a root is considered "managed by mappings" if `KanbanDatabase.forWorkspace(root).dbPath` resolves to a path that is NOT the root's own `.switchboard/kanban.db` default AND the mapping config explicitly lists the root.

## Edge-Case & Dependency Audit

- **Race Conditions:** If the user rapidly switches tabs, multiple `getAllDbPaths` requests may be in flight. The frontend should only process the latest response (simplest: always overwrite `#databases-list` on `allDbPathsUpdated`).
- **Security:** No new security surfaces. DB paths shown in the UI are already known to the extension. No user input reaches the filesystem without validation through existing `KanbanDatabase.validatePath`.
- **Side Effects:** `KanbanDatabase.forWorkspace(root)` creates a cached DB instance and may create the `.switchboard` directory on disk. Calling it for all roots during `handleGetAllDbPaths()` is safe because it does not write to the DB file itself, only resolves paths.
- **Dependencies & Conflicts:**
  - The `switchboard.resetKanbanDb` command is used in multiple places (`TaskViewerProvider.ts`, `PlanningPanelCacheService.ts`). Updating its signature to accept an optional parameter must not break existing callers that pass no arguments.
  - The `dbPathUpdated` message is consumed by both `setup.html` and the sidebar webview. The sidebar must continue to work with the single-object payload.
  - `handleConfigureNotionBackup`, `handleBackupToNotion`, `handleRestoreFromNotion`, and `handleAutoCreateNotionDatabase` already accept `workspaceRoot?: string`. The frontend just needs to pass the correct root for each card.

## Dependencies

- None blocking. This plan is self-contained within the Switchboard extension.

## Adversarial Synthesis

Key risks: (1) `KanbanDatabase.forWorkspace()` side effects during discovery may create unexpected directories; (2) `resetKanbanDb` command hardcodes the first root and must be updated; (3) dynamic UI rendering without event delegation risks memory leaks or stale listeners; (4) mapped-root detection logic must stay in sync with `KanbanDatabase._redirectToParentIfMapped`. Mitigations: use `fs.existsSync` checks before path display, pass `workspaceRoot` through the reset command, use event delegation for dynamic cards, and derive `isMapped` from the same `workspaceDatabaseMappings` config that `KanbanDatabase` reads.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

**Context:** Contains `handleGetDbPath` (line 2842), `handleSetLocalDb` (line 6206), `handleSetCustomDbPath` (line 6242), `handleSetPresetDbPath` (line 6286), and `handleResetDatabase` (line 6439). Also contains `_getWorkspaceRoot` (line 586) and `_resolveWorkspaceRoot` (line 605).

**Logic & Implementation:**

1. **Add `handleGetAllDbPaths()`** after `handleGetDbPath` (around line 2870):
   ```ts
   public async handleGetAllDbPaths(): Promise<Array<{
       dbPath: string;
       workspaceRoots: string[];
       isMapped: boolean;
       parentFolder?: string;
   }>> {
       const folders = vscode.workspace.workspaceFolders || [];
       const config = vscode.workspace.getConfiguration('switchboard');
       const mappings = config.get<any>('workspaceDatabaseMappings', { enabled: false, mappings: [] });

       // Map: dbPath -> { workspaceRoots: string[], isMapped, parentFolder }
       const dbMap = new Map<string, { workspaceRoots: string[]; isMapped: boolean; parentFolder?: string }>();

       for (const folder of folders) {
           const root = folder.uri.fsPath;
           const db = KanbanDatabase.forWorkspace(root);
           const dbPath = db.dbPath;

           // Determine if this root is mapped
           let isMapped = false;
           let parentFolder: string | undefined;
           if (mappings.enabled && Array.isArray(mappings.mappings)) {
               const mapping = mappings.mappings.find((m: any) => {
                   if (!m.workspaceFolders || !Array.isArray(m.workspaceFolders)) return false;
                   const mappedFolders = m.workspaceFolders.map((f: string) => path.resolve(f));
                   return mappedFolders.includes(path.resolve(root));
               });
               if (mapping) {
                   isMapped = true;
                   parentFolder = mapping.parentFolder;
               }
           }

           const existing = dbMap.get(dbPath);
           if (existing) {
               existing.workspaceRoots.push(root);
           } else {
               dbMap.set(dbPath, { workspaceRoots: [root], isMapped, parentFolder });
           }
       }

       return Array.from(dbMap.entries()).map(([dbPath, info]) => ({
           dbPath,
           ...info
       }));
   }
   ```

2. **Update `handleSetLocalDb()`** (line 6206): Change signature to `handleSetLocalDb(targetWorkspaceRoot?: string): Promise<void>`. Replace `const wsRoot = this._getWorkspaceRoot()` with `const wsRoot = this._resolveWorkspaceRoot(targetWorkspaceRoot) || this._getWorkspaceRoot()`. If `targetWorkspaceRoot` is provided but resolves to null, show an error and return.

3. **Update `handleSetCustomDbPath()`** (line 6242): Change signature to `handleSetCustomDbPath(customPath: string, targetWorkspaceRoot?: string): Promise<void>`. Replace `const wsRoot = this._getWorkspaceRoot()` with the same target resolution as above.

4. **Update `handleSetPresetDbPath()`** (line 6286): Change signature to `handleSetPresetDbPath(preset: string, targetWorkspaceRoot?: string): Promise<void>`. Replace `const wsRoot = this._getWorkspaceRoot()` with the same target resolution.

5. **Update `handleResetDatabase()`** (line 6439): Change signature to `handleResetDatabase(targetWorkspaceRoot?: string): Promise<void>`. Pass the resolved root to the reset command: `vscode.commands.executeCommand('switchboard.resetKanbanDb', resolvedRoot)`.

6. **Sidebar compatibility:** The sidebar webview also sends `getDbPath` (handled around line 7843). Keep `handleGetDbPath` and `dbPathUpdated` unchanged for sidebar use. The Database tab will exclusively use `getAllDbPaths` / `allDbPathsUpdated`.

**Edge Cases:**
- If no workspace is open, `handleGetAllDbPaths()` returns an empty array. The frontend shows "Open a workspace to manage databases."
- If `targetWorkspaceRoot` does not resolve to a valid root, the set/reset handlers fall back to the first root (backward compatible) or show an error if no roots exist.
- `KanbanDatabase.forWorkspace(root)` may throw if `root` is invalid. Wrap the loop in `try/catch` and skip invalid roots.

### `src/extension.ts`

**Context:** `resetKanbanDb` command registered at line 1480.

**Logic & Implementation:**
Change the command handler signature to accept an optional `workspaceRoot` argument:
```ts
const resetKanbanDbDisposable = vscode.commands.registerCommand('switchboard.resetKanbanDb', async (targetWorkspaceRoot?: string) => {
    const workspaceRoot = targetWorkspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('No workspace open.');
        return;
    }
    // ... rest of implementation unchanged
});
```

**Edge Cases:**
- Existing callers that pass no arguments continue to work (fall back to first root).
- `targetWorkspaceRoot` that does not exist in `workspaceFolders` is still accepted because `KanbanDatabase.forWorkspace()` validates the root.

### `src/services/SetupPanelProvider.ts`

**Context:** Message switch statement in `_handleMessage` (line 104). Existing DB handlers at lines 563-579.

**Logic & Implementation:**
1. **Add `getAllDbPaths` case** after `getDbPath` (around line 567):
   ```ts
   case 'getAllDbPaths': {
       const allDbPaths = await this._taskViewerProvider.handleGetAllDbPaths();
       this._panel.webview.postMessage({ type: 'allDbPathsUpdated', databases: allDbPaths });
       break;
   }
   ```

2. **Update `setLocalDb` case** (line 568):
   ```ts
   case 'setLocalDb':
       await this._taskViewerProvider.handleSetLocalDb(
           typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
       );
       break;
   ```

3. **Update `setCustomDbPath` case** (line 571):
   ```ts
   case 'setCustomDbPath':
       await this._taskViewerProvider.handleSetCustomDbPath(
           message.path,
           typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
       );
       break;
   ```

4. **Update `setPresetDbPath` case** (line 574):
   ```ts
   case 'setPresetDbPath':
       await this._taskViewerProvider.handleSetPresetDbPath(
           message.preset,
           typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
       );
       break;
   ```

5. **Update `resetDatabase` case** (line 577):
   ```ts
   case 'resetDatabase':
       await this._taskViewerProvider.handleResetDatabase(
           typeof message.targetWorkspaceRoot === 'string' ? message.targetWorkspaceRoot : undefined
       );
       break;
   ```

6. **Update Notion cases** to pass `targetWorkspaceRoot`:
   The existing Notion handlers already accept `workspaceRoot`. Update the frontend to pass the correct root per card. No backend changes needed in `SetupPanelProvider.ts` for Notion cases beyond ensuring the frontend sends the right `workspaceRoot`.

**Edge Cases:**
- If `targetWorkspaceRoot` is not provided, behavior is identical to today (backward compatible).

### `src/webview/setup.html`

**Context:** Database tab content in `#db-sync-fields` (line 667). Tab hydration in `activateTab` (line 1521). `dbPathUpdated` handler (line 4309). Click listeners for DB actions (lines 3755-3802).

**Logic & Implementation:**

1. **Replace static DB section HTML** (lines 678-747) with a container for dynamic cards:
   ```html
   <div class="db-subsection">
       <div class="subsection-header">
           <span>Databases</span>
       </div>
       <div id="databases-list"></div>
       <div id="no-databases-placeholder" class="hidden" style="font-size:11px; color:var(--text-secondary); padding:12px; text-align:center;">
           Open a workspace to manage databases.
       </div>
   </div>
   ```
   Keep the Plan Ingestion section above it. Move the static Database Location, Rebuild, and Notion sections into the dynamic render function.

2. **Add `renderDatabases(databases)` function** in the `<script>` section:
   ```js
   function renderDatabases(databases) {
       const container = document.getElementById('databases-list');
       const placeholder = document.getElementById('no-databases-placeholder');
       if (!container) return;

       if (!databases || databases.length === 0) {
           container.innerHTML = '';
           placeholder?.classList.remove('hidden');
           return;
       }
       placeholder?.classList.add('hidden');

       container.innerHTML = databases.map((db, index) => {
           const isMapped = db.isMapped;
           const mappedBadge = isMapped ? `<span style="font-size:9px; color:var(--accent-orange); margin-left:8px;">Mapped</span>` : '';
           const foldersList = db.workspaceRoots.map(r => `<div style="font-size:10px; color:var(--text-secondary);">${r}</div>`).join('');
           const locationDisabled = isMapped ? 'disabled' : '';
           const mappedNote = isMapped ? `<div style="font-size:10px; color:var(--accent-orange); margin-top:4px;">Managed by Workspace Mappings — edit in the Workspace tab.</div>` : '';

           return `
           <div class="db-card" data-db-index="${index}" data-db-path="${escapeHtml(db.dbPath)}" style="border:1px solid var(--border-color); border-radius:4px; padding:12px; margin-bottom:12px; background:var(--panel-bg2);">
               <div style="font-family:var(--font-mono); font-size:10px; color:var(--accent-teal); margin-bottom:4px; word-break:break-all;">${escapeHtml(db.dbPath)}${mappedBadge}</div>
               <div style="margin-bottom:8px;">${foldersList}</div>

               <div class="db-subsection">
                   <div class="subsection-header"><span>Location</span></div>
                   ${mappedNote}
                   <div class="db-location-options">
                       <label class="db-radio-option"><input type="radio" name="db-location-${index}" value="local" checked ${locationDisabled}><span>Local</span></label>
                       <label class="db-radio-option"><input type="radio" name="db-location-${index}" value="google-drive" ${locationDisabled}><span>Google Drive</span></label>
                       <label class="db-radio-option"><input type="radio" name="db-location-${index}" value="dropbox" ${locationDisabled}><span>Dropbox</span></label>
                       <label class="db-radio-option"><input type="radio" name="db-location-${index}" value="icloud" ${locationDisabled}><span>iCloud</span></label>
                       <label class="db-radio-option"><input type="radio" name="db-location-${index}" value="custom" ${locationDisabled}><span>Custom</span></label>
                   </div>
                   <input type="text" id="db-custom-path-${index}" class="db-custom-path-input hidden" placeholder="Enter custom database path...">
                   <button class="db-update-location-btn db-action-btn w-full" data-db-index="${index}" style="margin-top:8px;" ${locationDisabled ? 'disabled' : ''}>UPDATE LOCATION</button>
               </div>

               <div class="db-subsection">
                   <div class="subsection-header"><span>Rebuild</span></div>
                   <div style="font-size:10px; color:var(--text-secondary); margin-bottom:8px; line-height:1.4;">Delete and recreate from plan files.</div>
                   <button class="db-reset-btn db-action-btn danger w-full" data-db-index="${index}">REBUILD DATABASE</button>
               </div>

               <div class="db-subsection">
                   <div class="subsection-header"><span>Notion Backup</span></div>
                   <input type="text" class="notion-db-url-input" data-db-index="${index}" placeholder="https://notion.so/workspace/..." style="width:100%;">
                   <div style="display:flex; gap:8px; margin-top:8px;">
                       <button class="notion-backup-btn db-action-btn" data-db-index="${index}" style="flex:1;">BACKUP</button>
                       <button class="notion-restore-btn db-action-btn" data-db-index="${index}" style="flex:1;">RESTORE</button>
                   </div>
                   <button class="notion-auto-setup-btn secondary-btn w-full" data-db-index="${index}" style="margin-top:8px;">AUTO-CREATE</button>
               </div>
           </div>
           `;
       }).join('');
   }
   ```

3. **Update tab hydration** (line 1521):
   ```js
   'database': () => {
       vscode.postMessage({ type: 'getAllDbPaths' });
       vscode.postMessage({ type: 'getStartupCommands' });
   }
   ```

4. **Add `allDbPathsUpdated` message handler** in the main `switch` block:
   ```js
   case 'allDbPathsUpdated': {
       renderDatabases(message.databases || []);
       break;
   }
   ```

5. **Replace static click listeners with event delegation:**
   Remove the static `db-update-location-btn`, `db-reset-btn`, `notion-backup-btn`, etc. listeners. Add a single delegation listener on `#databases-list`:
   ```js
   document.getElementById('databases-list')?.addEventListener('click', (e) => {
       const target = e.target.closest('.db-update-location-btn');
       if (target) {
           const index = target.dataset.dbIndex;
           // find selected radio for this index, post message with targetWorkspaceRoot from message.databases
       }
       // Similar for .db-reset-btn, .notion-backup-btn, etc.
   });
   ```
   Store the last received `databases` array in a variable (`lastAllDbPaths`) so click handlers can look up the correct `workspaceRoots[0]` to use as `targetWorkspaceRoot`.

6. **Keep `dbPathUpdated` handler** (line 4309) unchanged for sidebar compatibility, but it will no longer be used by the Database tab.

**Edge Cases:**
- If `databases` is empty array, show placeholder text.
- If a mapped root's location radio is clicked while disabled, the browser `disabled` attribute prevents selection.
- Rebuild confirmation modal remains a VS Code: modal (handled by backend), so no frontend confirmation needed.

## Verification Plan

### Automated Tests

1. **Unit test for `handleGetAllDbPaths()` grouping logic:**
   - Mock `vscode.workspace.workspaceFolders` with 3 roots where 2 share a mapping.
   - Assert the result is an array of 2 entries (one shared DB, one local DB).
   - Assert `workspaceRoots` arrays are correct.
   - Assert `isMapped` is `true` for the shared entry and `false` for the local entry.

2. **Unit test for backward compatibility:**
   - Call `handleSetLocalDb()` with no argument.
   - Assert it uses the first workspace root (mock `_getWorkspaceRoot` to return a known value).

3. **Unit test for `resetKanbanDb` command with optional argument:**
   - Call `vscode.commands.executeCommand('switchboard.resetKanbanDb', '/path/to/root')`.
   - Assert `KanbanDatabase.forWorkspace` is called with `/path/to/root`.
   - Call with no argument and assert it falls back to `workspaceFolders[0]`.

4. **Integration test for multi-root workspace:**
   - Open a multi-root workspace with 2 unmapped roots.
   - Switch to Database tab.
   - Assert 2 database cards are rendered.
   - Click Rebuild on the second card.
   - Assert `resetDatabase` message includes the second root's path in `targetWorkspaceRoot`.

### Manual Tests

1. Single-root workspace: Database tab shows 1 card. Rebuild and location change work.
2. Multi-root workspace without mappings: shows N cards, one per root. Each has independent location and rebuild.
3. Multi-root workspace with mappings: shows 1 card for the mapped DB with 2+ roots listed. Location is disabled with a note. Rebuild and Notion backup work.

---

**Recommendation:** Complexity is 7 (multi-file coordination, new message types, dynamic UI, command signature change). Send to **Lead Coder**.

---

## Reviewer Pass — 2026-05-15

### Stage 1: Adversarial Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **CRITICAL** | Database tab goes stale after any DB operation (setLocalDb, setCustomDbPath, setPresetDbPath, resetDatabase). These handlers send `dbPathUpdated` via `_postSharedWebviewMessage`, but the setup.html `dbPathUpdated` handler references removed DOM elements (`dbPathDisplay`, `dbCustomPathInput`) and never triggers a refresh of the dynamic card list. User changes DB location → UI shows old state until tab switch. | `TaskViewerProvider.ts:6286,6331,6482`; `setup.html:4342-4372` |
| 2 | **CRITICAL** | `isMapped` flag is order-dependent when grouping roots by shared DB path. When a second root is merged into an existing `dbMap` entry, its `isMapped` and `parentFolder` are silently discarded. If the first root processed is unmapped but the second is mapped, the grouped entry incorrectly shows `isMapped: false`, causing mapped DBs to appear editable. | `TaskViewerProvider.ts:2896-2901` |
| 3 | **MAJOR** | `dbPathUpdated` handler in setup.html references `dbCustomPathInput` (null) without null guard on lines 4361-4362 (`dbCustomPathInput.value = pathValue` / `.classList.remove('hidden')`). If a custom DB path is active, this throws `TypeError: Cannot set properties of null`. | `setup.html:4361-4362` |
| 4 | **MAJOR** | `dbConnectionResult` handler references phantom `dbPathDisplay` element — always null-guarded so no crash, but dead code. | `setup.html:4377-4383` |
| 5 | **MAJOR** | `getProposedPath()` function references null `dbCustomPathInput` (latent crash). Function has zero callers — dead code. | `setup.html:3455-3472` |
| 6 | **NIT** | Redundant ternary in Google Drive fallback: both `win32` and non-`win32` branches produce identical path. | `TaskViewerProvider.ts:6352-6354` |
| 7 | **NIT** | No test coverage for the entire feature (0 of 4 planned automated tests exist). | N/A |

### Stage 2: Balanced Synthesis

| Finding | Action | Rationale |
|---------|--------|-----------|
| #1 CRITICAL: stale DB tab | **Fix now** — Replace dead `dbPathUpdated` handler with `getAllDbPaths` refresh request | User-facing data staleness after every DB operation |
| #2 CRITICAL: isMapped order-dependent | **Fix now** — OR `isMapped` across roots sharing same DB, preserve first `parentFolder` | Incorrect UI state for mapped DBs depending on folder iteration order |
| #3 MAJOR: TypeError on null | **Fix now** — Subsumed by #1 fix (entire dead handler replaced) | Crash when custom DB path is active |
| #4 MAJOR: dead dbConnectionResult | **Fix now** — Replace with no-op comment | Small cleanup, prevents confusion |
| #5 MAJOR: dead getProposedPath | **Fix now** — Remove function | Latent crash risk, zero callers |
| #6 NIT: redundant ternary | **Fix now** — Collapse to single path | Trivial while in the area |
| #7 NIT: no tests | **Defer** | Not a code defect; flag as remaining risk |

### Stage 3: Code Fixes Applied

**Files changed:**

1. **`src/services/TaskViewerProvider.ts`** (lines 2896-2908):
   - Fixed `isMapped` OR logic: when merging a root into an existing `dbMap` entry, if the new root is mapped, set `existing.isMapped = true`. Also preserve `parentFolder` if not already set.
   - Fixed redundant Google Drive fallback ternary (line 6358-6359): collapsed `process.platform === 'win32' ? X : X` to just `X`.

2. **`src/webview/setup.html`**:
   - Removed orphaned `dbCustomPathInput` and `dbPathDisplay` variable declarations (was lines 1271-1272).
   - Replaced dead `dbPathUpdated` handler (was lines 4342-4372) with minimal handler that updates `workspaceRoot`/`currentDbPath` variables, calls `renderControlPlaneSelectionStatus`, and posts `getAllDbPaths` to refresh the Database tab card list.
   - Replaced dead `dbConnectionResult` handler with no-op comment.
   - Removed dead `getProposedPath()` function (was lines 3455-3472).

### Stage 4: Verification Results

- **TypeScript check (`tsc --noEmit`):** 2 pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated relative import path issues). No new errors introduced.
- **Test suite (`vscode-test`):** 47/47 tests passing. No regressions.
- **No new tests added** for this feature (deferred — see Remaining Risks).

### Remaining Risks

1. **No automated test coverage** for `handleGetAllDbPaths()` grouping logic, `targetWorkspaceRoot` parameter flow, or dynamic UI rendering. The plan specified 4 automated tests; none exist. This should be addressed before considering the feature production-hardened.
2. **`currentDbPath` variable** (setup.html line 1288) is now write-only (set in `dbPathUpdated` handler, never read after `getProposedPath` removal). Harmless but dead — can be removed in a future cleanup pass.
3. **`dbPathUpdated` message** is still sent by backend handlers to both sidebar and setup panel. The sidebar webview may have its own handler for this message type. The setup panel handler now only updates JS variables and requests a refresh — this is correct but should be verified that the sidebar still functions properly with the shared message.
