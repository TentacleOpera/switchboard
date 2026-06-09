# Eliminate VS Code Config as Mapping Source of Truth

Problem Statement

The kanban workspace dropdown is broken because workspaceDatabaseMappings is stored in VS Code's configuration system, which is subject to folder-level overrides, workspace-file hand-edits, and config cascade behavior.
The mappings defined in setup.html's multi-repo tab are not authoritative — they can be overridden by any .vscode/settings.json in any open folder.

The fix: setup.html writes mappings to the kanban database itself. All reads come from the database. VS Code config is eliminated from the mapping flow entirely.

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 1: DB Pointer Files (Break the Chicken-and-Egg)

What they are

A single-line text file at <parentFolder>/.switchboard/db-pointer containing the absolute path to the kanban.db that this parent workspace uses. Only created in parent workspace folders — the same folders that already
have .switchboard/ directories. Never in child or dropdown workspaces.

Why only parent folders

  • Child workspaces (workspaceFolders) and dropdown workspaces (dropdownWorkspaces) are explicitly blocked from having .switchboard/ directories by isAllowedSwitchboardLocation(). They must not get pointer files.
  • The parent folder is the authority — it owns the DB and the .switchboard/ directory. The pointer file tells the system where the DB lives.
  • Child/dropdown workspaces discover their parent by scanning open parent DBs for matching entries (see Part 2).

Pointer file format

/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db

Just one line. Absolute path. No JSON wrapping. If the path doesn't exist or the file is empty, it's ignored and the default path is used.

When pointer files are written

  • setup.html save: When the user saves mappings, SetupPanelProvider writes a db-pointer file in each mapping's parentFolder/.switchboard/ directory.
  • initializeWorkspaceDatabase: When the user creates a new mapping via "Initialize Database", the pointer is written after the DB is created.
  • Migration: On first activation after this change, the existing VS Code config mappings are read one final time, pointer files are written for each mapping's parentFolder, and the mappings are written to each DB's conf
  ig table.

When pointer files are NOT written

  • Never in child workspace folders (they don't have .switchboard/)
  • Never in dropdown workspace folders (they don't have .switchboard/)
  • Never in unmapped standalone workspaces (they use the default .switchboard/kanban.db path, no pointer needed)

DB path resolution (new priority order)

In KanbanDatabase.forWorkspace():

  1. Check for .switchboard/db-pointer in the workspace root → if it exists and points to a valid file, use that path
  2. Check kanban.dbPath VS Code setting (legacy, will be deprecated) → if set, use that path
  3. Default: {workspaceRoot}/.switchboard/kanban.db

This replaces the current workspaceDatabaseMappings-based DB path resolution. The pointer file is the new way to say "this workspace's DB lives over there."

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 2: Mapping Content in the Database

Storage mechanism

The existing config table in kanban.db:

CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

Already stores workspace_id. We add a new key:

  • Key: workspace_mappings
  • Value: JSON string of the full mappings configuration

Example value:

{
  "enabled": true,
  "mappings": [
    {
      "id": "mapping-1777423703660",
      "name": "Autism360App",
      "dbPath": "/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db",
      "parentFolder": "/Users/patrickvuleta/Documents/Gitlab",
      "workspaceFolders": ["/Users/patrickvuleta/Documents/Gitlab/ai", ...],
      "dropdownWorkspaces": ["/Users/patrickvuleta/Documents/Gitlab/analytics-dashboard"],
      "mode": "connect"
    },
    {
      "id": "mapping-1777426138438",
      "name": "Switchboard",
      "dbPath": "/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db",
      "parentFolder": "/Users/patrickvuleta/Documents/GitHub/switchboard",
      "workspaceFolders": [],
      "dropdownWorkspaces": [],
      "mode": "connect"
    }
  ]
}

Why the config table, not a new table

  • The config table already exists, already has getConfig()/setConfig() methods
  • Mappings are a single document (not rows that need individual querying)
  • The entire mapping config is always read/written as a unit by setup.html
  • No schema migration needed — just a new key-value row

Which DB stores the mappings

Every parent workspace's DB stores the full mappings document. When a multi-root workspace has two parent workspaces (e.g., Autism360App and Switchboard), both DBs contain the same mappings JSON. This is intentional:

  • It ensures any parent DB can answer "is folder X a child of mine?" without consulting another DB
  • It makes the system resilient to one DB being unavailable
  • Setup.html writes to all parent DBs on save (it already knows all the DB paths)

New methods on KanbanDatabase

  • getWorkspaceMappings(): Promise<{ enabled: boolean; mappings: WorkspaceDatabaseMapping[] }> — reads from config table key workspace_mappings
  • setWorkspaceMappings(mappings: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] }): Promise<boolean> — writes to config table key workspace_mappings

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 3: Child/Dropdown Workspace Discovery

The problem

Child and dropdown workspaces don't have .switchboard/ directories or pointer files. How does the system know they're mapped?

The solution: scan parent DBs

When the extension activates (or when the kanban board initializes), it:

  1. Scans all open workspace folders for .switchboard/db-pointer files
  2. Opens each DB pointed to by those pointer files
  3. Reads workspace_mappings from each opened DB
  4. Builds a lookup map: for each open workspace folder, check if it's listed as a child or dropdown in any parent's mappings
  5. Redirects child/dropdown folders to their parent's DB instance

This is a one-time scan at initialization, cached for the session. The existing _mappingCache in WorkspaceIdentityService.ts already provides this pattern.

Fallback for unmapped folders

If an open workspace folder has no pointer file AND isn't listed as a child/dropdown in any parent DB, it's treated as an independent workspace with its own .switchboard/kanban.db. This is the current default behavior.

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 4: File-by-File Changes

4.1 KanbanDatabase.ts

Add:

  • getWorkspaceMappings() method — reads config table key workspace_mappings, returns parsed JSON or { enabled: false, mappings: [] }
  • setWorkspaceMappings(mappings) method — writes to config table key workspace_mappings
  • static writeDbPointer(parentFolder: string, dbPath: string) — writes db-pointer file to parentFolder/.switchboard/
  • static readDbPointer(workspaceRoot: string): string | null — reads db-pointer file, returns path or null

Modify:

  • forWorkspace() — Replace the workspaceDatabaseMappings config read with: (1) check readDbPointer(), (2) fallback to kanban.dbPath setting, (3) default path. Remove the entire block that reads workspaceDatabaseMappings
  to resolve the DB path.
  • _redirectToParentIfMapped() — This method currently reads VS Code config to redirect child roots to parents. Replace with: scan the mapping cache (built at initialization from DB reads). If the workspace root is
  listed as a child/dropdown in any cached mapping, return the parent. No VS Code config read.

4.2 WorkspaceIdentityService.ts

Add:

  • buildMappingIndexFromDbs(dbs: Map<string, KanbanDatabase>) — A new function that reads workspace_mappings from each open parent DB and builds a module-level index: Map<string, string> mapping each child/dropdown root
  to its parent root. Also stores the full mappings document for later queries.
  • getMappingsFromIndex(): { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } — Returns the cached mappings from the index, not from VS Code config.

Modify:

  • isDropdownWorkspace() — Read from the mapping index instead of VS Code config
  • resolveEffectiveWorkspaceRootFromMappings() — Read from the mapping index instead of VS Code config
  • clearMappingCache() — Also clear the mapping index

4.3 KanbanProvider.ts

Modify:

  • _getAllowedRoots() — Read mappings from the mapping index (via getMappingsFromIndex()) instead of VS Code config
  • _getWorkspaceItems() — Read mappings from the mapping index instead of VS Code config. Also fix the empty array truthiness bug: replace (m.workspaceFolders && m.workspaceFolders[0]) with (Array.isArray(m.workspaceFold
  ers) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined)
  • _getKanbanPlansFoldersToWatch() — Read from mapping index instead of VS Code config
  • resolveEffectiveWorkspaceRoot() — Read from mapping index instead of VS Code config
  • Constructor or _revealBoard() — Add initialization step: scan open folders for pointer files, open parent DBs, call buildMappingIndexFromDbs(). This must happen before any mapping-dependent code runs.

4.4 SetupPanelProvider.ts

Modify:

  • getWorkspaceMappings handler — Read from the DB's getWorkspaceMappings() instead of VS Code config. If no DB is open yet (edge case), fall back to VS Code config for backward compat.
  • setWorkspaceMappingEnabled handler — Write to DB via setWorkspaceMappings(). Also write pointer files for each mapping's parentFolder. Optionally also write to VS Code config during migration period.
  • saveWorkspaceMappings handler — Write to DB via setWorkspaceMappings(). Write pointer files for each mapping's parentFolder. After DB write succeeds, also write to VS Code config (migration period only).
  • initializeWorkspaceDatabase handler — After creating the DB and saving the mapping, write the pointer file and the DB config entry.

4.5 TaskViewerProvider.ts

Modify:

  • _filterMappedRoots() — Read from mapping index instead of VS Code config
  • _validateNoSwitchboardPollution() — Read from mapping index instead of VS Code config
  • _getAllowedRoots() — Read from mapping index instead of VS Code config
  • getWorkspaceDatabasesByRoot() — Read from mapping index instead of VS Code config
  • _initializeWatcherFolders() — Read from mapping index instead of VS Code config

4.6 GlobalPlanWatcherService.ts

Modify:

  • _getAllMappedFolders() — Read from mapping index instead of VS Code config
  • Config change listener — Keep listening for workspaceDatabaseMappings changes during migration period, but also listen for a new custom event switchboard.mappingsChanged that fires when the DB is updated

4.7 switchboardLocationGuard.ts

Modify:

  • isAllowedSwitchboardLocation() — Read from mapping index instead of VS Code config. This is called early (during .switchboard creation), so the mapping index must already be built. If the index isn't available yet,
  fall back to a conservative default (block creation in any folder that isn't a known parent).

4.8 extension.ts

Remove:

  • migrateWorkspaceDatabaseMappings() function — This function is dangerous. It reads folder-scoped config and overwrites workspace-scoped config. It can destroy setup.html's mappings. Remove it entirely.

Add:

  • One-time migration at activation: If workspaceDatabaseMappings exists in VS Code config with enabled: true and non-empty mappings, AND no db-pointer files exist yet, write pointer files and DB config entries from the
  VS Code config values. Then set a flag in extension globalState so this migration never runs again. This is the bridge from the old system to the new.

Modify:

  • Config change listener — During migration period, if workspaceDatabaseMappings changes in VS Code config, propagate the change to the DB. After migration period, this listener can be removed.
  • Remove the .vscode/settings.json entry for workspaceDatabaseMappings in the switchboard repo itself (the immediate cause of the current bug)

4.9 package.json

Modify (later, after migration period):

  • Mark switchboard.workspaceDatabaseMappings as deprecated in the description
  • Eventually remove the setting entirely

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 5: Initialization Order

The critical constraint is that the mapping index must be built before any code reads mappings. The activation sequence becomes:

  1. Extension activates
  2. Run one-time migration (if needed): read VS Code config, write pointer files + DB config entries
  3. Scan open workspace folders for .switchboard/db-pointer files
  4. Open each pointed-to DB (or default .switchboard/kanban.db for folders without pointers)
  5. Read workspace_mappings from each DB → build the mapping index
  6. For remaining open folders not matched by pointers: check the mapping index to see if they're children/dropdowns of any parent
  7. Initialize KanbanProvider with the mapping index already built
  8. KanbanProvider uses the index for all mapping queries — no VS Code config reads

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 6: Empty Array Truthiness Bug

Fix in _getWorkspaceItems() (KanbanProvider.ts lines 688, 726) and any similar patterns in other files:

Current:

m.parentFolder || (m.workspaceFolders && m.workspaceFolders[0])

Fixed:

m.parentFolder || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined)

This affects the Switchboard mapping which has workspaceFolders: []. Currently [][0] returns undefined silently, but the intent is clearer with the explicit length check.

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 7: Migration Strategy

Phase 1 (This PR): Dual-write, DB-primary read

  • Setup.html writes to BOTH DB and VS Code config
  • All reads come from DB (via mapping index)
  • Pointer files are written for all parent folders
  • One-time migration writes existing VS Code config mappings to DB
  • Remove migrateWorkspaceDatabaseMappings() function
  • Remove the workspaceDatabaseMappings entry from switchboard's .vscode/settings.json

Phase 2 (Next release): DB-only

  • Setup.html writes to DB only (stops writing to VS Code config)
  • Remove the VS Code config change listener for workspaceDatabaseMappings
  • Remove the workspaceDatabaseMappings setting from package.json
  • Remove all fallback reads of VS Code config

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Part 8: What This Fixes

┌────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Current Bug                                            │ How This Fixes It                                                                                                       │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Folder-level .vscode/settings.json overrides mappings  │ Eliminated — no VS Code config reads for mappings                                                                       │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Workspace file hand-edits diverge from setup.html      │ Eliminated — only setup.html writes to DB                                                                               │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ No workspace file at all                               │ Works fine — pointer files are per-folder, DB stores mappings                                                           │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Bouncing dropdown                                      │ Eliminated — reads always return what setup.html wrote                                                                  │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ migrateWorkspaceDatabaseMappings() overwrites mappings │ Eliminated — function removed                                                                                           │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Empty array truthiness in _getWorkspaceItems           │ Fixed with explicit .length > 0 check                                                                                   │
├────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Cross-machine persistence                              │ DB is already designed for cloud sync; pointer files can be committed to git                                            │

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

## Review Pass Results (2026-05-27)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | MAJOR | `setWorkspaceMappingEnabled` reads current mappings from VS Code config instead of DB — the exact bug source this plan eliminates | **FIXED** |
| 2 | MAJOR | `setWorkspaceMappingEnabled` skips DB write when mapping has no `dbPath` | **DEFERRED** (edge case: mappings without dbPath can't be written to DB anyway) |
| 3 | MAJOR | `saveWorkspaceMappings` writes to VS Code Workspace target, risking re-creating folder overrides | **FIXED** — removed all VS Code config writes (no migration period needed; feature is unreleased) |
| 4 | NIT | `getMappingsFromIndex` VS Code config fallback has no warning when hit | **FIXED** — removed fallback entirely, returns empty defaults |
| 5 | MAJOR | Race between `forWorkspace()` calls and `initializeMappingIndex()` completion | **DEFERRED** (activation sequence is correct; risk is theoretical) |
| 6 | NIT | Empty array truthiness fix correctly implemented (even better than plan — also handles `parentWorkspaceFolder`) | **VERIFIED** |
| 7 | NIT | `(m as any).parentWorkspaceFolder` type-unsafe access in `_getAllowedRoots` | **DEFERRED** (legacy compat shim) |
| 8 | NIT→MAJOR | `initializeMappingIndex` only scans open workspace folders | **DOWNGRADED** (parent folders are always open workspace folders in multi-root setup) |
| 9 | MAJOR | `switchboard.mappingsChanged` doesn't rebuild mapping index | **ALREADY HANDLED** — extension.ts handler calls `initializeMappingIndex()`; cleaned up dead duplicate registration in GlobalPlanWatcherService |
| 10 | NIT | `migrateWorkspaceDatabaseMappings()` correctly removed | **VERIFIED** |
| 11 | NIT | `.vscode/settings.json` entry correctly removed | **VERIFIED** |
| 12 | MAJOR | Config change listener propagates VS Code config back to DB, re-creating the folder-level override bug | **FIXED** |

### Additional Fixes Applied (Pre-existing Bugs Found During Review)

| # | File | Fix |
|---|------|-----|
| A | KanbanProvider.ts:662 | Missing closing `}` for `resolveRoutedRole()` method — TS1128 error |
| B | TaskViewerProvider.ts:855 | Missing closing `}` for `_resolveWorkspaceRoot()` method — TS1128 error |
| C | extension.ts:186 | `dbPath` typed as `string \| null` but used where `string` required — TS2345 error |
| D | SetupPanelProvider.ts:9 | Missing `WorkspaceDatabaseMapping` type import — TS2304 error |

### Stage 2: Balanced Synthesis — What Was Fixed vs Deferred

**Fixed now:**
1. `setWorkspaceMappingEnabled` reads from DB, not VS Code config
2. `getMappingsFromIndex` returns empty defaults instead of falling back to VS Code config
3. Removed dead `switchboard.mappingsChanged` registration in GlobalPlanWatcherService
4. Removed VS Code config → DB propagation in config change listener
5. **Eliminated entire migration period** — removed all VS Code config reads/writes for mappings:
   - `saveWorkspaceMappings`: no longer writes to VS Code config
   - `initializeWorkspaceDatabase`: reads from DB instead of VS Code config; no VS Code config write
   - `getWorkspaceMappings` handler: no VS Code config fallback
   - `migrateConfigToDatabase()`: deleted entirely
   - `workspaceDatabaseMappings` config change listener: deleted entirely
   - `kanban.dbPath` VS Code setting fallback in `forWorkspace()`: deleted
   - `kanban.dbPath` VS Code setting fallback in `initializeMappingIndex()`: deleted
6. Fixed 4 pre-existing TypeScript errors (A–D above)

**Deferred:**
- Finding 2: `setWorkspaceMappingEnabled` edge case with missing `dbPath`
- Finding 5: Theoretical race between `forWorkspace()` and index build
- Finding 7: `(m as any).parentWorkspaceFolder` type-unsafe access

### Files Changed by Review

- `src/services/SetupPanelProvider.ts` — All VS Code config reads/writes removed; DB-only
- `src/services/WorkspaceIdentityService.ts` — VS Code config fallback removed; stale comments updated
- `src/services/GlobalPlanWatcherService.ts` — Config listener removed; dead command registration removed
- `src/extension.ts` — `migrateConfigToDatabase()` removed; config listener removed; `kanban.dbPath` fallback removed; unused imports removed
- `src/services/KanbanDatabase.ts` — `kanban.dbPath` VS Code setting fallback removed from `forWorkspace()`
- `src/services/KanbanProvider.ts` — Missing closing brace fixed
- `src/services/TaskViewerProvider.ts` — Missing closing brace fixed

### Validation Results

TypeScript typecheck (`tsc --noEmit`): **PASS** — only pre-existing TS2835 errors remain (unrelated relative import path issues in ClickUpSyncService.ts and KanbanProvider.ts).

### Remaining Risks

1. **Stale comments**: Several comments still reference `workspaceDatabaseMappings` as the source. These are misleading but not functionally harmful. Should be cleaned up in a follow-up.

2. **Test files**: Test files still reference `workspaceDatabaseMappings` in mock VS Code config objects. These tests may need updating to mock DB reads instead.

3. **package.json setting**: The `switchboard.workspaceDatabaseMappings` and `switchboard.kanban.dbPath` settings still exist in `package.json`. They should be removed in a follow-up.

