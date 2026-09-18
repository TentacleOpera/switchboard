# Fix Local Docs Folder Manager: Per-Workspace Scoping and Modal Refresh

## Goal
Fix two issues in the Local Docs (and HTML/Design) folder manager:
1. **Add Folder appears to do nothing** — after selecting a folder in the picker, the modal list does not update.
2. **Cross-workspace folder leakage** — switching to a workspace with no folders configured still shows folders from other workspaces in the modal.

## Root Cause
`LocalFolderService` stores all folder paths (local, HTML, design) in **global VS Code settings** (`ConfigurationTarget.Global`). The workspace filter dropdown only filters the **file tree nodes**, not the folder configuration itself. This means:
- All workspaces share one global folder list.
- `_handleMessage` resolves `workspaceRoot` to the active/first root, but since settings are global, every root's `LocalFolderService` returns the same paths.
- The modal's `renderFolderListModal()` renders `state.localFolderPaths`, which reflects the global list — hence cross-workspace leakage.
- The "nothing happens" symptom is likely a stale-state issue: the modal renders before the async `localFoldersListed` response arrives, or the webview state and modal DOM get out of sync because `handleLocalDocsReady` (which calls `renderFolderListModal`) may be skipped by the signature-dedup guard in `_sendLocalDocsReady` when only `folderPaths` changed but `nodes` did not.

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, bugfix, ui

## User Review Required
- Confirm atomic migration strategy: global settings will be **cleared** after one-time copy to workspace config (no dual-source fallback). Existing users with global folders will have them migrated into the active workspace's config on first use, and the global keys will be deleted.
- Confirm that the `local-folder-config.json` schema will be extended (not replaced) — existing `LocalFolderConfig` fields preserved alongside new folder-path fields.

## Complexity Audit

### Routine
- Adding `workspaceRoot` to webview→backend messages for folder operations (mechanical, follows existing pattern from tickets handlers)
- Updating `renderFolderListModal()` / `renderHtmlFolderListModal()` / `renderDesignFolderListModal()` to read from workspace-keyed map instead of flat array
- Updating `_sendLocalDocsReady`, `_sendHtmlDocsReady`, `_sendDesignDocsReady` to compute per-root folder paths
- Adding `force=true` or targeted `localFoldersListed` after add/remove operations
- Updating `handleLocalDocsReady`, `handleHtmlDocsReady`, `handleDesignDocsReady` to consume folder-paths map

### Complex / Risky
- Schema extension of `local-folder-config.json`: existing `loadConfig()`/`saveConfig()` operate on `LocalFolderConfig` type; new folder-path fields must coexist without data loss on save
- Atomic migration from global settings to workspace config: must read global, write workspace, clear global in one pass; failure mid-migration leaves dual-source state
- Webview message format change: `folderPaths` changes from `string[]` to `{ [root: string]: string[] }` — all consumers must be updated atomically

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid add/remove**: User clicks Add Folder multiple times quickly. Each triggers `_sendLocalDocsReady(true)`. The debounced file watchers also fire. Could cause flickering. Mitigation: targeted `localFoldersListed` response after add/remove is faster than full tree scan; dedup guard still protects against watcher-induced duplicates.
- **Migration during concurrent reads**: Two roots' services read the same global settings simultaneously during migration. One might migrate and clear global before the other reads. Mitigation: migration is per-root (each root writes to its own workspace config); only the global clear is shared — use a migration flag in workspace config to prevent re-migration.

### Security
- Folder paths stored in workspace config file (`.switchboard/local-folder-config.json`) are within the workspace root, so they're already within the webview's `localResourceRoots`. No new exposure.
- `_resolveWorkspaceRoot(msg.workspaceRoot)` validates against `_getAllowedRoots()`, preventing path traversal.

### Side Effects
- Clearing global settings keys (`research.localFolderPaths`, `research.htmlFolderPaths`, `research.designFolderPaths`) will affect any extension that reads these settings directly. Switchboard is the only consumer, so this is safe.
- `_setupLocalFolderWatchers()` is called after add/remove — this recreates all watchers. With per-workspace config, each root's watchers will only cover its own folders, reducing unnecessary watcher count.

### Dependencies & Conflicts
- The `_getLocalFolderService()` factory creates a new instance per call (line 2881). With file-based config, every `getFolderPaths()` call does a disk read. An in-memory cache is needed to avoid I/O overhead in hot paths like `_sendLocalDocsReady`.
- The `_sendLocalDocsReady` signature dedup guard (line 3028) includes `folderPaths` in the signature. After switching to per-root maps, the signature format changes — the dedup guard will naturally invalidate on first call after migration.

## Dependencies
- None (self-contained change within LocalFolderService + PlanningPanelProvider + planning.js)

## Adversarial Synthesis
Key risks: schema collision in `local-folder-config.json` (existing `loadConfig`/`saveConfig` will overwrite new fields), missing `workspaceRoot` in webview messages (backend can't route to correct workspace), and dual-source-of-truth during migration (global settings fallback perpetuates leakage). Mitigations: use read-modify-write pattern for config file saves, add `workspaceRoot` to all folder operation messages following the tickets-handler pattern, and perform atomic migration with global-settings clear and migration flag.

## Proposed Changes

### `src/services/LocalFolderService.ts`

**Context**: This service already has `_configPath` pointing to `<workspaceRoot>/.switchboard/local-folder-config.json` (line 29) and `loadConfig()`/`saveConfig()` methods (lines 35-45) for the `LocalFolderConfig` schema. Folder paths are currently stored in global VS Code settings.

**Logic**:

1. **Extend the config file schema** (lines 6-11, 35-45):
   - The existing `LocalFolderConfig` interface covers `selectedFile`, `docTitle`, `setupComplete`, `lastFetchAt`.
   - Add a new interface `LocalFolderPathsConfig` with fields: `localFolderPaths: string[]`, `htmlFolderPaths: string[]`, `designFolderPaths: string[]`, `_migrated?: boolean`.
   - Create `loadFolderPathsConfig(): Promise<LocalFolderPathsConfig>` and `saveFolderPathsConfig(config: LocalFolderPathsConfig): Promise<void>` that read/write the SAME file as `loadConfig()`/`saveConfig()` but preserve all existing keys using a read-modify-write pattern: read full JSON, merge folder-paths fields, write back.
   - Update `saveConfig()` to also preserve folder-paths fields when writing `LocalFolderConfig` (and vice versa), so neither method erases the other's data.

2. **Add in-memory cache for folder paths** (new private fields):
   - `_folderPathsCache: LocalFolderPathsConfig | null = null`
   - Invalidate cache in `addFolderPath()`, `removeFolderPath()`, `addHtmlFolderPath()`, `removeHtmlFolderPath()`, `addDesignFolderPath()`, `removeDesignFolderPath()`.
   - `getFolderPaths()`, `getHtmlFolderPaths()`, `getDesignFolderPaths()` check cache first; on miss, call `loadFolderPathsConfig()`.

3. **Migrate `getFolderPaths()` from global settings to workspace config** (lines 79-95):
   - Read from `loadFolderPathsConfig()` first.
   - If `_migrated` is not set, perform one-time migration: read global `research.localFolderPaths` + legacy `research.localFolderPath`, write to workspace config, set `_migrated: true`, then **clear the global settings keys** (`research.localFolderPaths`, `research.localFolderPath`).
   - After migration, resolve paths via `resolveFolderPath()` as before.
   - Legacy singular-setting fallback only applies during migration (before `_migrated` is set).

4. **Migrate `addFolderPath()` to workspace config** (lines 102-120):
   - Read current paths from `loadFolderPathsConfig()`.
   - Add new path, write back via `saveFolderPathsConfig()`.
   - Invalidate cache.
   - Remove the global-settings `config.update()` call.

5. **Migrate `removeFolderPath()` to workspace config** (lines 122-146):
   - Same pattern as add: read from workspace config, filter, write back.
   - Invalidate cache.
   - Remove global-settings `config.update()` calls (both array and legacy singular).

6. **Apply same pattern to HTML folder methods** (lines 277-310):
   - `getHtmlFolderPaths()` → read from workspace config (with migration).
   - `addHtmlFolderPath()` → write to workspace config.
   - `removeHtmlFolderPath()` → write to workspace config.

7. **Apply same pattern to Design folder methods** (lines 436-469):
   - `getDesignFolderPaths()` → read from workspace config (with migration).
   - `addDesignFolderPath()` → write to workspace config.
   - `removeDesignFolderPath()` → write to workspace config.

8. **Remove `_getConfigurationTarget()` method** (lines 58-60) — no longer needed after migration.

**Edge Cases**:
- Config file doesn't exist yet: `loadFolderPathsConfig()` returns default empty config; `saveFolderPathsConfig()` creates the `.switchboard/` directory and file.
- Migration partially fails (e.g., write succeeds but global clear fails): `_migrated` flag in workspace config prevents re-migration; global keys may linger but won't be read. A future cleanup can handle orphaned global keys.
- Two `LocalFolderService` instances for the same root (since `_getLocalFolderService` creates new instances): cache is per-instance, so both may read from disk independently. This is acceptable since the file is tiny and reads are infrequent. If needed later, a shared cache can be added.

### `src/services/PlanningPanelProvider.ts`

**Context**: The provider handles webview messages and sends updates. Currently uses `allRoots[0]` for folder path config and a generic `workspaceRoot` fallback for folder operations.

**Logic**:

1. **Update `_handleMessage` folder operation cases to use `_resolveWorkspaceRoot`** (lines 1220-1303):
   - `addLocalFolder` (line 1220): Change `const service = this._getLocalFolderService(workspaceRoot)` to `const root = this._resolveWorkspaceRoot(msg.workspaceRoot); const service = this._getLocalFolderService(root || workspaceRoot)`.
   - `removeLocalFolder` (line 1235): Same pattern.
   - `listLocalFolders` (line 1242): Same pattern. Also include `workspaceRoot` in the response: `{ type: 'localFoldersListed', paths, workspaceRoot: root }`.
   - `addHtmlFolder` (line 1248): Same pattern.
   - `removeHtmlFolder` (line 1263): Same pattern.
   - `listHtmlFolders` (line 1270): Same pattern. Include `workspaceRoot` in response.
   - `addDesignFolder` (line 1276): Same pattern.
   - `removeDesignFolder` (line 1291): Same pattern.
   - `listDesignFolders` (line 1298): Same pattern. Include `workspaceRoot` in response.

2. **Update `_sendLocalDocsReady` to send per-root folder paths** (lines 2948-3062):
   - Replace the single `configuredFolderPaths: string[]` (line 2954) with `configuredFolderPathsByRoot: Record<string, string[]>` (map keyed by workspace root).
   - In the root loop (line 2966), compute each root's folder paths: `configuredFolderPathsByRoot[root] = localFolderService.getFolderPaths()`.
   - Remove the `configRoot` / `allRoots[0]` computation (lines 2956-2962).
   - Update the message payload (line 3041-3049): change `folderPaths: configuredFolderPaths` to `folderPathsByRoot: configuredFolderPathsByRoot`.
   - Update the signature computation (line 3028-3034) to use `configuredFolderPathsByRoot` instead of `configuredFolderPaths`.

3. **Update `_sendHtmlDocsReady` with same per-root pattern** (lines 3064-3147):
   - Replace `configuredFolderPaths` with `configuredFolderPathsByRoot: Record<string, string[]>`.
   - In root loop, compute per-root HTML folder paths.
   - Update message payload: `folderPathsByRoot` instead of `folderPaths`.

4. **Update `_sendDesignDocsReady` with same per-root pattern** (lines 3149-3229):
   - Same as HTML above.

5. **Send targeted `localFoldersListed` after add/remove** (lines 1220-1240):
   - After `addLocalFolder`: in addition to `_sendLocalDocsReady(true)`, send `this._panel?.webview.postMessage({ type: 'localFoldersListed', paths: service.getFolderPaths(), workspaceRoot: root })`.
   - After `removeLocalFolder`: same targeted response.
   - Apply same pattern to HTML and Design add/remove handlers.

**Edge Cases**:
- `_resolveWorkspaceRoot(msg.workspaceRoot)` returns `undefined` if the webview sends an invalid root. Fallback to the generic `workspaceRoot` (active/first root) as before.
- The `localDocsReady` message format change (`folderPaths` → `folderPathsByRoot`) is a breaking change for the webview. Both backend and webview must be updated in the same commit.

### `src/webview/planning.js`

**Context**: The webview maintains flat arrays for folder paths and renders modals from them. Workspace filter dropdowns exist but only filter tree nodes.

**Logic**:

1. **Change folder path state from flat arrays to workspace-keyed maps** (lines 24-26):
   - `localFolderPaths: []` → `localFolderPathsByRoot: {}` (was line 24)
   - `htmlFolderPaths: []` → `htmlFolderPathsByRoot: {}` (was line 25)
   - `designFolderPaths: persistedState.designFolderPaths || []` → `designFolderPathsByRoot: persistedState.designFolderPathsByRoot || {}` (was line 26)
   - Keep backward-compat: if `persistedState.designFolderPaths` exists (old format), convert to map using current workspace root as key.

2. **Add `workspaceRoot` to folder operation messages**:
   - `addLocalFolder` message: add `workspaceRoot: state.localWorkspaceRootFilter || currentWorkspaceRoot`
   - `removeLocalFolder` message: add `workspaceRoot: state.localWorkspaceRootFilter || currentWorkspaceRoot`
   - `listLocalFolders` message: add `workspaceRoot: state.localWorkspaceRootFilter || currentWorkspaceRoot`
   - Same for HTML and Design equivalents.

3. **Update `handleLocalDocsReady`** (lines 2355-2380):
   - Replace `state.localFolderPaths = msg.folderPaths || []` (line 2358) with `state.localFolderPathsByRoot = msg.folderPathsByRoot || {}`.
   - `renderFolderListModal()` should read from `state.localFolderPathsByRoot[state.localWorkspaceRootFilter || currentWorkspaceRoot] || []`.

4. **Update `renderFolderListModal`** (lines 1528-1564):
   - Change `const folderPaths = state.localFolderPaths || []` (line 1533) to `const folderPaths = state.localFolderPathsByRoot[state.localWorkspaceRootFilter || currentWorkspaceRoot] || []`.

5. **Update `localFoldersListed` handler** (lines 3717-3721):
   - Change `state.localFolderPaths = msg.paths || []` to write into the map: `state.localFolderPathsByRoot[msg.workspaceRoot || currentWorkspaceRoot] = msg.paths || []`.
   - Call `renderFolderListModal()` immediately (already does this).

6. **Update `handleHtmlDocsReady`** (lines 1566-1581):
   - Replace `state.htmlFolderPaths = msg.folderPaths || []` with `state.htmlFolderPathsByRoot = msg.folderPathsByRoot || {}`.

7. **Update `renderHtmlFolderListModal`** (lines 1583-1625):
   - Change to read from `state.htmlFolderPathsByRoot[state.htmlWorkspaceRootFilter || currentWorkspaceRoot] || []`.

8. **Update `htmlFoldersListed` handler** (lines 3723-3725):
   - Write into map: `state.htmlFolderPathsByRoot[msg.workspaceRoot || currentWorkspaceRoot] = msg.paths || []`.

9. **Update `handleDesignDocsReady`** (around line 300+):
   - Replace `state.designFolderPaths = msg.folderPaths || []` with `state.designFolderPathsByRoot = msg.folderPathsByRoot || {}`.

10. **Update `renderDesignFolderListModal`** (lines 1816+):
    - Change to read from `state.designFolderPathsByRoot[state.designWorkspaceRootFilter || currentWorkspaceRoot] || []`.

11. **Update `designFoldersListed` handler** (lines 3727-3729):
    - Write into map: `state.designFolderPathsByRoot[msg.workspaceRoot || currentWorkspaceRoot] = msg.paths || []`.

12. **Update `designWorkspaceRootFilter` change handler** (lines 306-318):
    - Replace `state.designFolderPaths = msg.folderPaths || []` with reading from the map.

**Edge Cases**:
- `currentWorkspaceRoot` may be empty on initial load. Fallback to first key in the map, or empty array.
- Persisted state migration: old `designFolderPaths` (flat array) must be converted to `designFolderPathsByRoot` map on first load.
- When "All Workspaces" is selected in the filter dropdown (empty string), the modal should show folders from ALL roots combined (concatenate all values in the map), matching the current "show everything" behavior. Clarification: This preserves the existing UX where "All Workspaces" shows all folders, while a specific workspace filter shows only that workspace's folders.

## Verification Plan

### Automated Tests
- (Skipped per session directive — test suite will be run separately by the user.)

### Manual Verification
1. Open a multi-root workspace (or simulate with two workspace folders).
2. Add a folder in Workspace A's Local Docs tab. Verify it appears in the Manage Folders modal immediately.
3. Switch workspace filter to Workspace B. Verify the modal shows only Workspace B's folders (empty if none configured).
4. Add a folder in Workspace B. Verify it appears immediately and does NOT appear in Workspace A's folder list.
5. Remove a folder from Workspace A. Verify it disappears immediately from the modal.
6. Close and reopen the panel. Verify both workspaces retain their separate folder lists.
7. Repeat steps 2-6 for HTML Preview and Design tabs.
8. Test migration: create a user with existing global `research.localFolderPaths` settings, open the panel, verify folders appear in the active workspace's config and global settings are cleared.

### Acceptance Criteria
- [ ] Opening the Manage Folders modal for Workspace A shows **only** Workspace A's configured folders.
- [ ] Switching to Workspace B (with no folders) shows an empty list, not Workspace A's folders.
- [ ] Clicking Add Folder, selecting a folder, and confirming immediately adds the folder to the modal list for the **current** workspace.
- [ ] Removing a folder immediately removes it from the modal list.
- [ ] Existing global folders are preserved via one-time migration into the active workspace's config.
- [ ] Global settings keys are cleared after migration (no dual-source-of-truth).
- [ ] HTML Preview and Design tabs exhibit the same per-workspace behavior.
- [ ] "All Workspaces" filter in the dropdown shows folders from all workspaces combined.

**Recommendation**: Send to Coder (complexity 6 — multi-file coordination with moderate risk, but mechanically repetitive across three tab types).

## Review Findings

Two MAJOR issues found and fixed in `src/webview/planning.js`: (1) `listDesignFolders` message at line 1884 was missing `workspaceRoot`, causing wrong-workspace fallback in multi-root setups — added the parameter; (2) `designDocsReady` handler (line 3609) skipped `renderDesignFolderListModal()`, leaving the design folder modal stale on backend refresh — added the call for parity with local/HTML tabs. Three NITs deferred: dead `_getLegacyFolderPath()` method in LocalFolderService, unused `activeRoot` variables in `_sendHtmlDocsReady`/`_sendDesignDocsReady`, and unreachable backward-compat branch for `persistedState.designFolderPaths`. No compilation or test runs performed per session directives. Remaining risk: the per-instance `_getLocalFolderService` factory (no caching across calls) means migration could race if two instances for the same root read simultaneously before `_migratedLocal` is persisted — mitigated by idempotent write and `.catch(() => {})` on global-settings clear.
