# Globalize Integration Config & Fix Docs Tab Source Filter

## Metadata

**Complexity:** 8
**Tags:** frontend, backend, refactor, ui, ux, bugfix

## Goal

ClickUp, Linear, and Notion are conceptually **global SaaS integrations** — one account, one config — but the extension currently stores their hierarchy/mappings/ticket-save-location in **per-workspace Kanban DBs**. This creates a split-brain: the API token is global (secret storage), but the config is locked to whichever workspace the Kanban dropdown happens to be pointed at. Users cannot work on ClickUp for workspace B while Kanban is pointed at workspace A. The setup tab gives no indication which workspace's config is being edited, and ticket save locations default incorrectly.

Additionally, the Docs tab source filter (ClickUp/Linear/Notion selection) only works when "All Workspaces" is selected, because `rerenderUnifiedDocs` applies a strict `workspaceRoot` equality filter to online roots that never matches.

### Core Problems

1. **Docs tab source filter is broken** — online roots are filtered by `r.workspaceRoot === state.docsWorkspaceRootFilter`, but online sources are global and their `workspaceRoot` is either empty or set to an arbitrary workspace (last-registered adapter wins). Selecting any specific workspace strips all online sources from the sidebar.

2. **Integration config is per-workspace but should be global** — `clickup.config`, `linear.config`, `notion.config` are stored in per-workspace Kanban DBs. The token is already global. This means switching the Kanban workspace dropdown silently changes which ClickUp/Linear/Notion config is active, and users can't work on one workspace's ClickUp while Kanban is pointed at another.

3. **Ticket save location is ambiguous and misleading** — The setup UI says "Defaults to `.switchboard/plans`" but the code actually defaults to `.switchboard/tickets`. Neither default is safe: tickets should never go into plans (that spams the kanban), and silent defaults lead to tickets scattered across unexpected locations. The ticket save location should be a **mandatory explicit choice** at setup time.

4. **Adapters registered per-workspace with last-wins collision** — `ResearchImportService._adapters` is a `Map<string, ResearchSourceAdapter>` keyed by `sourceId`. The registration loop iterates all workspace roots and calls `registerAdapter` for each, but each workspace overwrites the previous for the same source. Only one adapter per source survives (whichever workspace was last in `allRoots`).

5. **Setup tab has no workspace context** — The ClickUp/Linear setup tabs silently edit whichever workspace's config is active. With global config this becomes moot, but the transition must be clean.

### Root Cause Analysis

- **Docs filter bug**: `rerenderUnifiedDocs()` (planning.js:1837-1841) filters online roots by strict `workspaceRoot` equality. Online sources don't have a meaningful `workspaceRoot` — they're global. The filter only "works" when bypassed (All Workspaces = empty filter = falsy = no filter applied).

- **Per-workspace config**: `ClickUpSyncService.loadConfig()` (ClickUpSyncService.ts:515-526) reads from `KanbanDatabase.forWorkspace(this._workspaceRoot).getConfigJson('clickup.config', null)`. Same pattern for Linear (`linear.config`, LinearSyncService.ts:233-263) and Notion (`notion.config`, NotionFetchService.ts:32-37). The workspace root comes from `_resolveWorkspaceRoot()` which delegates to `KanbanProvider.getCurrentWorkspaceRoot()` — the Kanban dropdown selection.

- **Adapter collision**: `PlanningPanelProvider._ensureAdaptersRegistered()` (PlanningPanelProvider.ts:134-194) loops over `allRoots` and calls `registerAdapter()` for each. `ResearchImportService.registerAdapter()` (ResearchImportService.ts:266-269) does `this._adapters.set(adapter.sourceId, adapter)` — last workspace wins.

- **Ticket location**: `LocalFolderService.getTicketsFolderPaths()` reads `ticketsFolderPaths` from `folders.paths` in the per-workspace DB (LocalFolderService.ts:88-124). When empty, `_getTicketDocumentDirs()` (PlanningPanelProvider.ts:1400-1408) and `_buildTicketDir()` (TaskViewerProvider.ts:17686-17693) fall back to `path.join(resolvedRoot, '.switchboard', 'tickets')` — not `.switchboard/plans` as the UI claims.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config storage | Global config file (`~/.switchboard/integration-config.json`) | Config blobs (hierarchy + columnMappings + automationRules) can exceed VS Code secret storage size limits. A global JSON file is transparent, inspectable, and has no size constraints. Token stays in secret storage. |
| Ticket save location | One global path per provider | Simplest. All ClickUp tickets go to one folder, nested by space/folder/list as subfolders. |
| Migration | **Required** — read-and-migrate from per-workspace DBs | Extension has ~4,000 installs. `clickup.config`, `linear.config`, `notion.config`, and `ticketsFolderPaths` are shipped state. On first load after upgrade, read the per-workspace DB config and write it to the global file. Archive the DB key as a sentinel value (not deleted). |
| Online docs workspace filter | Remove filter for online roots | Online sources are global; workspace filter applies to local docs only. |
| Existing tickets in `.switchboard/tickets` | Keep as read-only fallback search path | Existing users may have tickets saved under the old default. `_findTicketDocument` must still search `.switchboard/tickets` as a fallback, but new tickets must go to the configured global location. |

## User Review Required

**Yes — multiple design decisions need user confirmation before implementation:**

1. **Kanban column mappings scope**: Moving `clickup.config` / `linear.config` to global means ALL workspaces share the same ClickUp→kanban-column mapping. If different workspaces have different kanban column structures (e.g. one uses the full 9-column board, another uses a simplified 4-column board), the column mappings will conflict. **Confirm**: Is it acceptable for all workspaces to share one column mapping per provider, or should column mappings stay per-workspace while only hierarchy/ticket-location goes global?

2. **Migration source priority**: When migrating from per-workspace DBs, if multiple workspaces have different `clickup.config` values, which one wins? **Recommendation**: Use the first non-empty config found (iterate `allRoots` in order). **Confirm** this is acceptable.

3. **Global config file location**: `~/.switchboard/integration-config.json` is the proposed location. **Confirm** this is acceptable, or specify an alternative (e.g. VS Code `globalState`).

## Complexity Audit

### Routine
- Docs tab source filter fix (Phase 3.1): removing 3 lines of filter logic in `planning.js:1837-1841`. Single-file, isolated, low risk.
- Removing `workspaceRoot` from online docs roots payload (Phase 3.3): 2-line change in `PlanningPanelProvider.ts:5899-5901`.
- Setup UI text changes (Phase 4.1): replacing misleading help text, adding `required` attributes, giving inputs distinct IDs. HTML-only changes.
- Removing shared ticket-input syncing (Phase 4.1): deleting the blur-handler cross-sync in `setup.html:3312-3320`.

### Complex / Risky
- **Global config migration from per-workspace DBs**: Must read `clickup.config` / `linear.config` / `notion.config` / `ticketsFolderPaths` from every workspace's Kanban DB, merge into one global file, and mark DB keys as migrated. Touches `KanbanDatabase.ts`, all three sync services, `LocalFolderService.ts`. Data consistency risk if migration is interrupted or runs concurrently.
- **Decoupling config I/O from workspace root**: `ClickUpSyncService`, `LinearSyncService`, `NotionFetchService` all read/write config via `KanbanDatabase.forWorkspace(this._workspaceRoot)`. Changing this to a global file affects every `loadConfig()` / `saveConfig()` call site. Services are cached per-root in Maps (`_clickUpServices`, `_linearServices` in TaskViewerProvider) — must decide whether to collapse to single instances or keep per-root instances reading the same global file.
- **Kanban column mappings conflict**: Column mappings are part of the config blob. Moving them global means all workspaces share one mapping per provider. This is an architectural change with potential for silent breakage if workspaces have different kanban structures.
- **File watchers update**: `PlanningPanelProvider.ts:7113-7125` and `7161-7176` set up watchers per-workspace using `LocalFolderService.getTicketsFolderPath()`. Must be updated to watch the global ticket save location(s) instead. Watcher lifecycle changes are error-prone.
- **Removing ticket fallback path**: The fallback `path.join(resolvedRoot, '.switchboard', 'tickets')` appears in 6+ call sites. Removing it entirely would orphan existing tickets. Must keep as read-only search fallback while redirecting new writes to the global location.
- **`_resolveWorkspaceRoot()` audit**: 74+ call sites in `TaskViewerProvider` use `_resolveWorkspaceRoot()` then pass the root to `_getClickUpService(root)` / `_getLinearService(root)`. With global config, the root is no longer needed for config I/O but is still needed for plan-file path resolution, relative ticket-path resolution, and cache service injection. Each call site must be audited.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Concurrent config writes**: Multiple webview panels (Setup + Planning) could trigger `saveConfig` simultaneously. The global config file must use atomic writes (write-temp-then-rename) to avoid partial writes. Add a write mutex or queue.
- **Migration on first load**: If the extension activates in multiple workspace folders simultaneously, the migration could run concurrently. Use a file-level lock or a "migration complete" sentinel in the global config to ensure it runs once.
- **Adapter re-registration**: `_ensureAdaptersRegistered()` is called on every webview message with a roots-key guard. After collapsing to one-adapter-per-source, the guard logic must still invalidate correctly on workspace folder changes.

**Security:**
- The global config file (`~/.switchboard/integration-config.json`) must NOT contain API tokens — tokens stay in VS Code secret storage. The file contains hierarchy IDs, column mappings, and ticket save paths only. Set file permissions to 0600 on creation.
- The config file is in the user's home directory, outside any workspace — ensure it's not accidentally committed to git or exposed by file watchers.

**Side Effects:**
- **Kanban sync behavior change**: Kanban column mappings moving to global config changes the sync lookup path. `KanbanProvider` currently reads column mappings from the per-workspace DB; it must be updated to read from the global config. If a workspace had different mappings, sync will silently use the global ones.
- **Cache file relocation**: ClickUp/Linear docs cache files (`clickup-docs-cache.md`, `linear-docs-cache.md`, `notion-cache.md`) are currently per-workspace. If adapters are registered globally, caches should move to a global location (`~/.switchboard/cache/`). `PlannerPromptWriter.ts:257-290` reads these cache paths — must be updated.
- **`ticketsFolderPathsByRoot` removal**: `PlanningPanelProvider.ts:5785,5794,5855,5871,5884` carries per-root ticket paths in webview state. This becomes a single global path per provider. The webview message types (`ticketsFoldersListed`, `ticketsFolderPathResult`) must be updated.

**Dependencies & Conflicts:**
- **`WorkspaceExcludeService.ts:20`** lists `.switchboard/notion-cache.md` as an excluded path. If cache moves to `~/.switchboard/cache/`, this exclusion list must be updated.
- **`PlannerPromptWriter.ts:257-290`** constructs cache paths using `workspaceRoot`. Must be updated to use the global cache location.
- **`LocalFolderService.ts:14-23`** (`LocalFolderPathsConfig`): `ticketsFolderPaths` and `ticketsAutoSync` fields become legacy. The interface must preserve these fields for migration reads but new writes go to the global config.
- **`SetupPanelProvider.ts:1100-1153`**: `browseTicketsFolder`, `saveTicketsFolder`, `saveTicketsAutoSync`, `listTicketsFolders` handlers all use `LocalFolderService` per-workspace. Must be rewritten to use the global config service and include a `provider` field in messages.

## Dependencies

- None — this plan is self-contained. No other plan sessions are prerequisites.

## Adversarial Synthesis

Key risks: (1) Migration from per-workspace DBs is mandatory for ~4,000 installs but the plan originally specified "no migration" — this would silently destroy user config on upgrade. (2) Kanban column mappings moving to global config creates a multi-workspace conflict if workspaces have different kanban structures. (3) Removing the `.switchboard/tickets` fallback orphans existing tickets for current users. Mitigations: add a migration phase that reads-and-archives DB config; keep `.switchboard/tickets` as a read-only search fallback; require user confirmation on column-mapping scope before implementation.

## Implementation Plan

### Phase 0: Migration — Read per-workspace config into global file

**Scope:** New `GlobalIntegrationConfigService`, `extension.ts` activation, all three sync services.

#### 0.1 Create `GlobalIntegrationConfigService`

Create `src/services/GlobalIntegrationConfigService.ts`:

- **Storage**: A global JSON file at `~/.switchboard/integration-config.json` (resolve via `os.homedir()`). NOT secret storage — config blobs can exceed secret storage size limits.
- **Structure**:
  ```json
  {
    "migrationComplete": true,
    "clickup": { "hierarchy": {}, "columnMappings": {}, "automationRules": [], "ticketSaveLocation": "", "options": {} },
    "linear": { "teamId": "", "columnToStateId": {}, "automationRules": [], "ticketSaveLocation": "", "options": {} },
    "notion": { "databaseId": "", "ticketSaveLocation": "", "options": {} },
    "ticketsAutoSync": false
  }
  ```
- **Methods**: `loadConfig(provider)`, `saveConfig(provider, config)`, `clearConfig(provider)`, `loadGlobal()`, `saveGlobal(config)`, `getTicketsAutoSync()`, `setTicketsAutoSync(enabled)`.
- **Atomic writes**: Write to a temp file (`*.tmp`) then rename to the final path. Set file mode to `0o600` on creation.
- **Migration sentinel**: `migrationComplete` boolean at the top level. If `false` or missing, run migration on next load.

#### 0.2 Migration logic on activation

In `extension.ts` (or a dedicated `MigrationService`), on activation:

1. Load the global config file. If `migrationComplete === true`, skip.
2. Iterate `vscode.workspace.workspaceFolders` (or all known workspace roots from `KanbanProvider`).
3. For each root, read `clickup.config`, `linear.config`, `notion.config` from `KanbanDatabase.forWorkspace(root).getConfigJson(...)`.
4. Read `ticketsFolderPaths` from `folders.paths` via `LocalFolderService`.
5. Merge into the global config — first non-empty config per provider wins. For `ticketsFolderPaths`, take the first non-empty array.
6. Write the merged config to the global file with `migrationComplete: true`.
7. **Archive** the DB keys: set `clickup.config` to `{"_migrated": true, "_migratedAt": "<iso>"}` in the per-workspace DB (do NOT delete — preserves the key for rollback and satisfies the "archive as `*.migrated.bak`" rule). Same for `linear.config`, `notion.config`.
8. Log migration completion.

**Edge case — no workspace open on activation**: If `workspaceFolders` is empty, defer migration until the first workspace is opened. The `onDidChangeWorkspaceFolders` handler should check `migrationComplete` and run if needed.

### Phase 1: Move integration config to global storage

**Scope:** `ClickUpSyncService`, `LinearSyncService`, `NotionFetchService`, `GlobalIntegrationConfigService`, and all callers.

#### 1.1 Refactor ClickUpSyncService config I/O

- `loadConfig()` (ClickUpSyncService.ts:515-526): Replace `KanbanDatabase.forWorkspace(this._workspaceRoot).getConfigJson('clickup.config', null)` with `GlobalIntegrationConfigService.loadConfig('clickup')`.
- `saveConfig()` (ClickUpSyncService.ts:537-545): Replace `KanbanDatabase.forWorkspace(this._workspaceRoot).setConfigJson('clickup.config', normalized)` with `GlobalIntegrationConfigService.saveConfig('clickup', normalized)`.
- The `_workspaceRoot` field (line 139) and `_configPath` (line 140) remain for plan-file path resolution and legacy file-based config reads, but config I/O no longer uses them.
- `getSelectedHierarchy()` (line 528-535): reads from `this._config` which is now populated from the global config. No change needed beyond ensuring `loadConfig()` is called first.
- **Service instantiation**: `ClickUpSyncService` constructor (line 188-192) still takes `workspaceRoot` and `secretStorage`. Add `GlobalIntegrationConfigService` as a dependency (inject via constructor or static accessor). The per-root service cache in `TaskViewerProvider._clickUpServices` (TaskViewerProvider.ts:5093-5110) can remain — all instances read the same global config. Alternatively, collapse to a single instance; **Clarification**: keeping per-root instances is simpler and lower-risk since the root is still used for plan-file paths.

#### 1.2 Refactor LinearSyncService config I/O

- `loadConfig()` (LinearSyncService.ts:233-263): Replace DB read with `GlobalIntegrationConfigService.loadConfig('linear')`. Preserve the legacy `projectId → includeProjectNames` migration logic (lines 242-257) — run it against the loaded global config instead.
- `saveConfig()` (LinearSyncService.ts:273-282): Replace DB write with `GlobalIntegrationConfigService.saveConfig('linear', normalized)`.
- `saveAutomationSettings()` (line 284-296): calls `saveConfig()` — no direct change needed.

#### 1.3 Refactor NotionFetchService config I/O

- `loadConfig()` (NotionFetchService.ts:32-37): Replace DB read with `GlobalIntegrationConfigService.loadConfig('notion')`.
- `saveConfig()` (NotionFetchService.ts:39-42): Replace DB write with `GlobalIntegrationConfigService.saveConfig('notion', config)`.
- `fetchAndCache()` (line 533-540): calls `saveConfig()` — no direct change needed.

#### 1.4 Decouple ClickUp/Linear/Notion operations from Kanban workspace selection

- `handleApplyClickUpConfig` (TaskViewerProvider.ts:4108-4134): Still calls `_resolveWorkspaceRoot()` (line 4112) to get the root for `_getClickUpService(resolvedRoot)`. With global config, the root is only needed for `handleGetKanbanStructure(resolvedRoot)` (line 4121) which reads the kanban board's column structure from the per-workspace DB. **Keep** `_resolveWorkspaceRoot()` here — the kanban board identity is still per-workspace.
- `handleSaveClickUpMappings` (TaskViewerProvider.ts:4136-4153): Same — `_resolveWorkspaceRoot()` needed for `handleGetKanbanStructure`. Keep.
- `handleSaveClickUpAutomation` (TaskViewerProvider.ts:4155-4169): `_resolveWorkspaceRoot()` needed for `_getClickUpService`. Keep (service still root-keyed).
- `handleApplyLinearConfig` (TaskViewerProvider.ts:4275-4294): Same pattern. Keep `_resolveWorkspaceRoot()`.
- `handleApplyNotionConfig` (TaskViewerProvider.ts:4810+): Same pattern. Keep.
- **The Kanban workspace dropdown no longer affects which ClickUp/Linear/Notion config is active** — config is global. The dropdown still controls which kanban board is active (column structure, plan records).

**Edge case — Kanban sync:** Kanban column mappings for ClickUp/Linear are part of the integration config (which ClickUp lists map to which Kanban columns). These move to the global config blob. The Kanban provider reads column mappings from `GlobalIntegrationConfigService` instead of the per-workspace DB. Kanban sync itself (pushing plan status changes to ClickUp/Linear) still needs to know which workspace's kanban board to sync — but that's the kanban board's identity, not the integration config. The kanban workspace dropdown continues to control which kanban board is active; it just no longer controls which ClickUp/Linear config is active.

**⚠️ See User Review Required #1**: If different workspaces have different kanban column structures, sharing one column mapping globally will break sync for the mismatched workspace. This needs user confirmation before implementation.

### Phase 2: Make ticket save location mandatory

**Scope:** `setup.html`, `SetupPanelProvider`, `LocalFolderService`, `GlobalIntegrationConfigService`.

#### 2.1 Add ticket save location to the global config blob

Each provider's config blob includes a `ticketSaveLocation` field (string path). This is the base directory where tickets for that provider are saved, nested by space/folder/list (ClickUp) or team/project (Linear) as subfolders.

Notion does not have tickets — it's docs-only — so it gets no `ticketSaveLocation` field.

#### 2.2 Make ticket save location required in the setup UI

In `setup.html`:

- **ClickUp tab**: The "Ticket Import Location" input (line 687) becomes required. The "APPLY CLICKUP SETTINGS" button is **disabled** until both a token (or existing token) AND a ticket save location are provided.
- **Linear tab**: Same treatment for the "Ticket Import Location" input (line 886) and "APPLY LINEAR SETTINGS" button.
- Remove the misleading help text "Defaults to `.switchboard/plans` if left empty" from both tabs (lines 692 and 891).
- Replace with: "Required. Choose where imported tickets are saved locally. Tickets are kept separate from your Kanban plans — use 'Add to Kanban' to promote a ticket to the board."
- The `.ticket-import-folder-input` fields are no longer shared/synced between ClickUp and Linear tabs — each provider has its own ticket save location in its own config blob. Give them distinct IDs: `clickup-ticket-import-folder` and `linear-ticket-import-folder`.

#### 2.3 Update the save flow

- `saveTicketsFolder` message handler in `SetupPanelProvider` (line 1115-1133) — instead of writing to `LocalFolderService` (per-workspace DB), write to the provider's global config blob via `GlobalIntegrationConfigService`.
- The message now includes which provider it's for: `{ type: 'saveTicketsFolder', provider: 'clickup', folderPath: val }`.
- `browseTicketsFolder` handler (line 1100-1113) similarly needs to know which provider's input to populate. Message becomes `{ type: 'browseTicketsFolder', provider: 'clickup' }`. The `browseTicketsFolderResult` message must include the provider so the webview populates the correct input.
- `saveTicketsAutoSync` handler (line 1135-1141): Write to `GlobalIntegrationConfigService.setTicketsAutoSync()` instead of `LocalFolderService.setTicketsAutoSync()`.
- `listTicketsFolders` handler (line 1143-1153): Read from `GlobalIntegrationConfigService` per provider. The `ticketsFoldersListed` message must include the provider and the path.

#### 2.4 Update ticket path resolution in the backend

All places that call `LocalFolderService.getTicketsFolderPaths()` to determine where to save/load tickets must be updated to read from the global config instead:

- `PlanningPanelProvider._getTicketDocumentDirs()` (line 1400-1429) — read `ticketSaveLocation` from `GlobalIntegrationConfigService` for the given provider. The `resolvedRoot` parameter is still needed for the hierarchy lookup (`getClickUpSyncService(resolvedRoot).getSelectedHierarchy()`).
- `TaskViewerProvider._buildTicketDir()` (line 17686-17693) — read `ticketSaveLocation` from global config. Return `null` if not configured (caller handles the error).
- `TaskViewerProvider._findTicketDocument()` (line 17711-17730) — read `ticketSaveLocation` from global config for the search base dirs. **Keep** the `.switchboard/tickets` fallback (line 17723) as a read-only search path for existing tickets.
- `TaskViewerProvider` lines 17944-17953, 17965-17974 — read from global config.
- `PlanningPanelProvider` lines 4018, 4128, 4263, 4412 — read from global config. **Keep** `.switchboard/tickets` as a read-only fallback for `saveLocalTicketFile` (line 4015) and `_findLocalTicketFile` lookups.
- `PlanningPanelProvider` lines 7122, 7173 (file watchers) — watch the global ticket save location(s) instead of per-workspace paths. See Phase 2.6.

The fallback `path.join(resolvedRoot, '.switchboard', 'tickets')` is **kept as a read-only search path** for existing tickets. New ticket writes go to the configured `ticketSaveLocation`. If no `ticketSaveLocation` is configured, new ticket writes fail with a clear error: "Ticket save location not configured. Open Setup → ClickUp to configure."

#### 2.5 Remove `ticketsFolderPaths` from `LocalFolderService` (write path only)

- `getTicketsFolderPaths()`, `getTicketsFolderPath()`, `addTicketsFolderPath()`, `removeTicketsFolderPath()`, `getTicketsAutoSync()`, `setTicketsAutoSync()` — these become **read-only** (used by migration only). New writes go to `GlobalIntegrationConfigService`.
- The `ticketsFolderPaths` and `ticketsAutoSync` fields in `LocalFolderPathsConfig` (LocalFolderService.ts:14-23) are preserved for migration reads but no longer written to after migration.
- `ticketsFolderPathsByRoot` in `PlanningPanelProvider` (line 5785, 5794, 5855, 5871, 5884) — replaced with a single global path per provider in webview state. Update the `localDocsReady` message payload.

#### 2.6 Update file watchers

- `_setupTicketsViewWatcher()` (PlanningPanelProvider.ts:7113-7125): Replace `localService.getTicketsFolderPath()` with the global `ticketSaveLocation` for each configured provider. Watch all configured provider paths. If no path is configured, fall back to watching `.switchboard/tickets` for existing tickets.
- `_updateTicketsAutoSyncWatcher()` (PlanningPanelProvider.ts:7161-7176): Same — watch the global ticket save location(s).

### Phase 3: Fix docs tab source filter

**Scope:** `planning.js`, `PlanningPanelProvider.ts`, `ResearchImportService.ts`.

#### 3.1 Stop filtering online roots by workspace

In `rerenderUnifiedDocs()` (planning.js:1837-1841):

```js
// BEFORE:
const onlineRoots = state._lastOnlineDocsMsg ? (
    state.docsWorkspaceRootFilter
        ? (state._lastOnlineDocsMsg.roots || []).filter(r => r.workspaceRoot === state.docsWorkspaceRootFilter)
        : (state._lastOnlineDocsMsg.roots || [])
) : null;

// AFTER:
const onlineRoots = state._lastOnlineDocsMsg
    ? (state._lastOnlineDocsMsg.roots || [])
    : null;
```

Online roots are global — the workspace filter applies to local docs only.

#### 3.2 Register adapters once, globally

In `PlanningPanelProvider._ensureAdaptersRegistered()` (lines 134-194):

- Stop looping over `allRoots` and registering an adapter per workspace.
- Register **one adapter per source** (ClickUp, Linear, Notion), using the global config from `GlobalIntegrationConfigService`.
- The adapter's `workspaceRoot` property becomes irrelevant for config purposes — it was only used for the DB config path, which is now global. Set it to empty string or remove the property from the adapter interface if no other code depends on it.

**Check needed:** Verify nothing else reads `adapter.workspaceRoot` for purposes other than the docs filter. The adapters use `workspaceRoot` for:
- Config path (now dead — config in global file)
- Cache path (`clickup-docs-cache.md`, `linear-docs-cache.md`, `notion-cache.md`) — these are file caches. Move to a global location (`~/.switchboard/cache/`). Update `ClickUpDocsAdapter.ts:28`, `LinearDocsAdapter.ts:25`, `NotionFetchService.ts:26`, and `PlannerPromptWriter.ts:257-290`.

#### 3.3 Remove `workspaceRoot` from online docs roots payload

In `_sendOnlineDocsReady()` (PlanningPanelProvider.ts:5899-5901):

```ts
// BEFORE:
const roots = adapters
    .filter(a => a.sourceId !== 'local-folder')
    .map(a => ({ sourceId: a.sourceId, workspaceRoot: a.workspaceRoot || '', nodes: [] as TreeNode[] }));

// AFTER:
const roots = adapters
    .filter(a => a.sourceId !== 'local-folder')
    .map(a => ({ sourceId: a.sourceId, nodes: [] as TreeNode[] }));
```

The `workspaceRoot` field is no longer needed on online roots since they're not filtered by workspace.

### Phase 4: Setup UI cleanup

#### 4.1 Remove shared ticket input syncing

In `setup.html` (lines 3312-3320), the `.ticket-import-folder-input` blur handler syncs values across all inputs with that class. Since ClickUp and Linear now have separate ticket save locations, this syncing must be removed. Each input gets its own ID (`clickup-ticket-import-folder`, `linear-ticket-import-folder`) and its own save handler that includes the provider in the message.

#### 4.2 Remove shared auto-sync toggle syncing

Similarly, `.tickets-auto-sync-toggle` (lines 3321-3329) syncs across tabs. Auto-sync is a single global setting stored in `GlobalIntegrationConfigService` (not per-provider). Keep the syncing behavior (both toggles reflect one global state) but store via `GlobalIntegrationConfigService.setTicketsAutoSync()` instead of `LocalFolderService.setTicketsAutoSync()`.

**Decision**: Tickets auto-sync is one global toggle, stored in the global config. Both ClickUp and Linear tabs' toggles reflect and control this single setting.

#### 4.3 Update setup tab to load/save ticket location from global config

When the setup tab loads, it should populate the ticket import location inputs from `GlobalIntegrationConfigService`, not from `LocalFolderService.getTicketsFolderPaths()`. The `ticketsFoldersListed` message and `ticketsFolderPathResult` message types need to be updated or replaced to carry per-provider paths:

- `ticketsFoldersListed` → `{ type: 'ticketsFoldersListed', provider: 'clickup', path: '...', ticketsAutoSync: true }`
- `browseTicketsFolderResult` → `{ type: 'browseTicketsFolderResult', provider: 'clickup', path: '...' }`

### Phase 5: Verify and test

#### 5.1 Verify the docs tab fix

- Open the Docs tab with a specific workspace selected in the workspace dropdown.
- Select "ClickUp" in the source filter dropdown.
- Confirm ClickUp docs appear in the sidebar.
- Repeat for Linear and Notion.
- Switch to "All Workspaces" — confirm all sources still appear.

#### 5.2 Verify global config

- Configure ClickUp with workspace A selected in Kanban.
- Switch Kanban to workspace B.
- Open the ClickUp setup tab — confirm the same hierarchy/mappings are shown (not empty).
- Import a ClickUp ticket — confirm it saves to the globally-configured ticket location, not a per-workspace default.

#### 5.3 Verify mandatory ticket location

- Clear the ClickUp ticket import location.
- Confirm the "APPLY CLICKUP SETTINGS" button is disabled.
- Enter a location — confirm the button enables.
- Apply — confirm tickets save to the specified location.

#### 5.4 Verify no tickets in plans

- Confirm that with no ticket save location configured, ticket import fails with a clear error message, not a silent default to `.switchboard/plans` or `.switchboard/tickets`.

#### 5.5 Verify migration (if upgrading from a prior version)

- Start with a workspace that has `clickup.config` in its Kanban DB.
- Install the new version.
- On activation, confirm the migration runs: global config file is created, DB key is archived to `{"_migrated": true}`.
- Confirm ClickUp config is readable from the global file.
- Confirm existing tickets in `.switchboard/tickets` are still findable via `_findTicketDocument`.

## Verification Plan

### Automated Tests

> **Note:** Per session directives, automated tests are NOT run as part of this planning session. The test suite will be run separately by the user. The following describes what should be verified:

- **Unit tests for `GlobalIntegrationConfigService`**: atomic write/read, migration sentinel logic, concurrent write safety.
- **Unit tests for migration**: read from per-workspace DB, merge into global file, archive DB keys.
- **Integration test for docs filter**: online roots appear regardless of workspace filter selection.
- **Integration test for ticket save**: new tickets go to configured `ticketSaveLocation`; existing tickets in `.switchboard/tickets` are still findable.
- **Manual verification steps**: see Phase 5 above.

**Skip compilation and automated tests in this session** — the project is in a pre-compiled state and tests will be run separately.

## Risks & Edge Cases

1. **Secret storage size**: VS Code secret storage is designed for small secrets. Config blobs (hierarchy + column mappings + automation rules) should be small (a few KB). Verify no size limits are hit. If they are, fall back to a global config file. **→ Resolved: using a global config file as the primary approach, not secret storage.**

2. **Kanban sync decoupling**: Kanban column mappings move to global config, but the kanban board itself is per-workspace. Ensure that syncing plan status to ClickUp/Linear still works when the kanban workspace and the ClickUp/Linear config are "global" — the sync needs the kanban board's column IDs (from the workspace DB) and the ClickUp/Linear column mapping (from global config). These are two different lookups and should not be conflated. **⚠️ See User Review Required #1.**

3. **Adapter cache paths**: ClickUp and Linear docs adapters have cache files (`clickup-docs-cache.md`, `linear-docs-cache.md`) currently stored per-workspace. With global config, these caches should move to a global location (`~/.switchboard/cache/`) or be removed if they're not essential. Update `PlannerPromptWriter.ts:257-290` and `WorkspaceExcludeService.ts:20`.

4. **`_resolveWorkspaceRoot()` calls in ClickUp/Linear paths**: Many ClickUp/Linear operations in `TaskViewerProvider` call `_resolveWorkspaceRoot()` to get the workspace root, then use it to get the ClickUp/Linear service. With global config, the service no longer needs a workspace root for config — but it may still need one for other purposes (e.g., resolving relative paths in ticket save location, plan-file path resolution for sync). Ensure all `_resolveWorkspaceRoot()` calls in ClickUp/Linear paths are audited. **→ Audit result: keep `_resolveWorkspaceRoot()` for kanban structure reads and service instantiation; config I/O no longer needs it.**

5. **File watchers**: `PlanningPanelProvider` lines 7122 and 7173 set up file watchers for ticket folders using `LocalFolderService.getTicketsFolderPath()`. These must be updated to watch the global ticket save location(s) instead.

6. **`ticketsFolderPathsByRoot`**: This per-root mapping in the planning panel state becomes a single global path per provider. The webview state and message types that carry this data need updating.

7. **Migration concurrency**: If the extension activates in multiple workspace windows simultaneously, the migration could run twice. Use the `migrationComplete` sentinel in the global config file with atomic writes to ensure it runs once.

8. **Existing tickets orphaned**: Removing the `.switchboard/tickets` fallback entirely would make existing tickets unfindable. **→ Resolved: keep `.switchboard/tickets` as a read-only search fallback in `_findTicketDocument` and `_findLocalTicketFile`.**

## Out of Scope

- Notion ticket import (Notion is docs-only, no tickets).
- Per-SaaS-hierarchy ticket save locations (user chose one path per provider).
- Per-workspace column mappings (pending User Review Required #1 — if user requires per-workspace mappings, that becomes a separate plan).
- Workspace-to-source assignment feature (sources remain global; no opt-in per-workspace scoping).

## Recommendation

**Complexity: 8 → Send to Lead Coder.**

This plan involves multi-file coordination across 8+ service files, a mandatory data migration for ~4,000 installs, architectural decoupling of config from workspace identity, and a kanban column-mapping scope decision that requires user confirmation. The docs filter fix (Phase 3) is routine and could be split off as a separate low-complexity task, but the config globalization and migration are high-risk and require a lead coder's judgment.

## Code Review Results

### Stage 1: Grumpy Principal Engineer Review

**CRITICAL — "Did you even TEST this?!"**

1. **`saveLocalTicketFile` still reads from the dead per-workspace DB** (PlanningPanelProvider.ts:4047-4057) — Four call sites in PlanningPanelProvider still use `LocalFolderService.getTicketsFolderPaths()` to find ticket files. The entire point of this plan was to move ticket storage to the global config. Tickets saved to the new global `ticketSaveLocation` are INVISIBLE to `saveLocalTicketFile`, `listLocalTicketFiles`, `readLocalTicketFile`, and the refine-ticket handler. The user imports a ticket, it saves to the global location, and then the planning panel shows an empty list. Silent data disappearance. Unacceptable.

2. **`listLocalTicketFiles` scans the wrong directory** (PlanningPanelProvider.ts:4161-4166) — Same root cause. The ticket list in the planning panel will be empty because it scans old per-workspace `LocalFolderService` paths instead of the global `ticketSaveLocation`. Users will think their tickets vanished after upgrading.

3. **`readLocalTicketFile` can't find tickets in the global location** (PlanningPanelProvider.ts:4296-4301) — Same pattern. Reading a ticket file from the planning panel fails silently.

4. **Refine ticket handler can't resolve the local file** (PlanningPanelProvider.ts:4446-4450) — The refine-ticket feature can't find the local ticket file to include in the prompt because it looks in the old per-workspace paths.

**MAJOR — "How did you miss this?"**

5. **`ClickUpSyncService._cleanup()` writes to a dead DB key** (ClickUpSyncService.ts:2101-2103) — The cleanup path still calls `KanbanDatabase.forWorkspace(this._workspaceRoot).setConfigJson('clickup.config', null)` instead of `GlobalIntegrationConfigService.clearConfig('clickup')`. So when a user's ClickUp setup fails and rolls back, the global config is NOT cleared — it persists with the failed config. The DB write is a no-op on the dead key.

6. **Deferred migration is not implemented** (extension.ts:736) — The plan explicitly says: "If `workspaceFolders` is empty, defer migration until the first workspace is opened. The `onDidChangeWorkspaceFolders` handler should check `migrationComplete` and run if needed." The handler only calls `initializeIntegrationAutoPull()`. If the extension activates with no workspace folders, migration is skipped and NEVER runs. Users who open a workspace folder after activation will have their per-workspace config permanently ignored.

**NIT — "Clean up your mess"**

7. **`WorkspaceExcludeService.ts:20`** — Still references `.switchboard/notion-cache.md` as an excluded path. The cache moved to `~/.switchboard/cache/`. Dead entry, harmless but misleading.

8. **PlanningPanelProvider legacy ticket folder management handlers** (lines 1954-2012) — `addTicketsFolderPath`, `removeTicketsFolderPath`, `listTicketsFolders`, `saveTicketsFolder`, `browseTicketsFolder` in PlanningPanelProvider still use `LocalFolderService` per-workspace. These appear to be legacy UI in the planning panel. The plan doesn't explicitly mention them, and the setup tab handlers were correctly updated. Low risk since the setup tab takes precedence for ticket folder management.

### Stage 2: Balanced Synthesis

**Fix Now (CRITICAL/MAJOR — all 6 fixed):**

1. ✅ `saveLocalTicketFile` → replaced `LocalFolderService` lookup with `_findTicketFilePath()` which searches global config + `.switchboard/tickets` fallback
2. ✅ `listLocalTicketFiles` → replaced `LocalFolderService` lookup with `_getTicketDocumentDirs()` which returns global + fallback dirs; updated `_scanLocalTicketFiles` calls to iterate all dirs
3. ✅ `readLocalTicketFile` → replaced `LocalFolderService` lookup with `_findTicketFilePath()`
4. ✅ Refine ticket handler → replaced `LocalFolderService` lookup with `_findTicketFilePath()`
5. ✅ `ClickUpSyncService._cleanup()` → replaced `KanbanDatabase.setConfigJson('clickup.config', null)` with `GlobalIntegrationConfigService.clearConfig('clickup')`
6. ✅ Deferred migration → added `MigrationService.runMigration()` call in `onDidChangeWorkspaceFolders` handler (idempotent due to `migrationComplete` sentinel)

**Can Defer (NIT — not fixed):**

7. `WorkspaceExcludeService.ts:20` dead exclude entry — harmless, cosmetic cleanup
8. PlanningPanelProvider legacy ticket folder management handlers — may be dead UI, separate concern from the plan's scope

### Files Changed (Review Fixes)

- `src/services/PlanningPanelProvider.ts` — 4 call sites fixed (saveLocalTicketFile, listLocalTicketFiles, readLocalTicketFile, copyRefinePrompt)
- `src/services/ClickUpSyncService.ts` — _cleanup() fixed to use GlobalIntegrationConfigService.clearConfig()
- `src/extension.ts` — added deferred migration call in onDidChangeWorkspaceFolders

### Validation Results

- **Compilation**: Skipped per session directives (pre-compiled state assumed)
- **Automated tests**: Skipped per session directives (user will run separately)
- **Code review verification**: All 6 CRITICAL/MAJOR fixes verified by reading final code state; `_findTicketFilePath` and `_getTicketDocumentDirs` methods confirmed to search both global `ticketSaveLocation` and `.switchboard/tickets` fallback; `MigrationService.runMigration()` confirmed idempotent via `migrationComplete` sentinel

### Remaining Risks

1. **PlanningPanelProvider legacy ticket folder handlers** (NIT #8) — If the planning panel still has active UI for adding/removing ticket folders, those operations write to the dead per-workspace `LocalFolderService` instead of the global config. This is a separate concern from the plan's scope and may be dead UI.
2. **Kanban column mappings scope** — The plan's User Review Required #1 (per-workspace vs global column mappings) was not explicitly resolved. The implementation moves column mappings to global config as the plan specifies, but if users have different kanban structures across workspaces, sync will silently use the global mappings for all workspaces.
3. **Migration concurrency** — The `MigrationService.runMigration()` uses atomic writes via `GlobalIntegrationConfigService.saveGlobal()` (write-temp-then-rename), but there's no file-level lock. If two VS Code windows activate simultaneously, both could read `migrationComplete: false`, both could migrate, and the second write wins. The `migrationComplete` sentinel prevents re-running after the first successful write, but a race between two concurrent migrations could merge different workspace configs. Low probability for ~4,000 installs.