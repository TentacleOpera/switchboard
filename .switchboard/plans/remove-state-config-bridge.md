# Remove stateConfigBridge and Complete state.json Deprecation

## Metadata
**Complexity:** 7
**Tags:** refactor, database, migration, infrastructure

## Goal

Remove the `stateConfigBridge.ts` facade and refactor all legacy call sites to use direct database calls, completing the deprecation of state.json that began with the migration to kanban.db.

## Background

### Current State
- **Data migration complete:** state.json data was migrated to kanban.db `config` table via `KanbanDatabase._runConfigMigrations()`
- **Bridge pattern in place:** `stateConfigBridge.ts` intercepts all fs calls to `.switchboard/state.json` paths and redirects them to the db
- **Legacy call sites remain:** ~40 call sites still construct state.json paths and use fs operations, which the bridge intercepts

### Why This Matters
- The bridge is technical debt that adds complexity
- Call sites are misleading - they look like file operations but hit the db
- Confusing for developers debugging state-related issues
- Prevents cleanup of orphaned state.json files

### What the Bridge Does
- Maps legacy state keys to db config keys via `STATE_KEY_TO_CONFIG` (36 keys)
- Intercepts `fs.readFile/writeFile` for state.json paths
- Synthesizes state.json from db config on reads
- Parses and writes to db config on writes
- Provides no-op lockfile replacement

## Affected Files

### Files Using stateFs Bridge
1. **KanbanProvider.ts** (10 direct state.json references)
   - `_getLiveSyncConfig()` - reads liveSyncConfig
   - `_getCustomKanbanColumns()` - reads customKanbanColumns
   - `_getDefaultPromptOverrides()` - reads/writes defaultPromptOverrides
   - `_saveDefaultPromptOverrides()` - writes defaultPromptOverrides
   - `_getStartupCommands()` - reads startupCommands, visibleAgents, julesAutoSyncEnabled, autoCommitOnCodeReview
   - `_getCustomAgents()` - reads customAgents
   - `_getAgentNames()` - reads startupCommands, customAgents
   - `_getVisibleAgents()` - reads customAgents, visibleAgents

2. **PlanningPanelProvider.ts** (1 reference)
   - `_getKanbanColumnDefinitions()` - reads customAgents, customKanbanColumns, visibleAgents

3. **TaskViewerProvider.ts** (multiple references)
   - `updateState()` - generic state updater (uses bridge)
   - Comments reference state.json but some methods already use db directly (e.g., `_persistLastAccessed()`, `loadLastAccessedFromState()`)

4. **cleanWorkspace.ts** (uses bridge for reset operations)
   - `resetStateFile()` - resets runtime state via bridge
   - `pruneZombieTerminalEntries()` - prunes terminal entries via bridge

5. **extension.ts** (uses bridge for terminal recovery)
   - Reads old terminal names before cleanWorkspace
   - Various comments referencing state.json

### Test Files (update assertions, not functional code)
- kanban-auto-export.test.ts
- plan-creation-status-regression.test.js
- custom-lane-roundtrip-regression.test.js
- plan-ingestion-config-regression.test.js
- kanban-custom-column-management-regression.test.js
- plan-ingestion-target-regression.test.js

## Migration Strategy

### Phase 1: Direct DB Access Pattern
Replace each state.json read/write with direct `KanbanDatabase` config operations:

**Before:**
```typescript
const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
const content = await fs.promises.readFile(statePath, 'utf8');
const state = JSON.parse(content);
const value = state.customKanbanColumns;
```

**After:**
```typescript
const db = KanbanDatabase.forWorkspace(workspaceRoot);
const value = await db.getConfigJson('kanban.customColumns', []);
```

### Phase 2: Remove Bridge Dependencies
- Remove `import { stateFs as fs } from './stateConfigBridge'`
- Restore standard `import * as fs from 'fs'` where needed
- Remove `stateLockfile` usage (no-op anyway)

### Phase 3: Cleanup
- Delete `stateConfigBridge.ts`
- Update comments that reference state.json
- Add cleanup for orphaned state.json files

## Implementation Steps

### Step 1: KanbanProvider.ts Refactoring
Replace all state.json reads with direct db calls:

1. **_getLiveSyncConfig()**
   - Replace with `db.getConfigJson('planning.liveSyncConfig', { enabled: false, syncIntervalMs: 30000, conflictCheckEnabled: false })`

2. **_getCustomKanbanColumns()**
   - Replace with `db.getConfigJson('kanban.customColumns', [])` then `parseCustomKanbanColumns()`

3. **_getDefaultPromptOverrides()**
   - Replace with `db.getConfigJson('agents.promptOverrides', {})` then `parseDefaultPromptOverrides()`

4. **_saveDefaultPromptOverrides()**
   - Replace with `db.setConfigJson('agents.promptOverrides', overrides)`

5. **_getStartupCommands()**
   - Replace with multiple `getConfigJson()` calls for:
     - `agents.startupCommands`
     - `agents.visibleAgents`
     - `agents.julesAutoSyncEnabled`
     - `kanban.autoCommitOnCodeReview`

6. **_getCustomAgents()**
   - Replace with `db.getConfigJson('agents.customAgents', [])` then `parseCustomAgents()`

7. **_getAgentNames()**
   - Replace with db calls for startupCommands and customAgents

8. **_getVisibleAgents()**
   - Replace with db calls for customAgents and visibleAgents

9. **Remove import** - Change `import { stateFs as fs }` to `import * as fs from 'fs'` (only if still needed for non-state operations)

### Step 2: PlanningPanelProvider.ts Refactoring
1. **_getKanbanColumnDefinitions()**
   - Replace state.json read with db calls for:
     - `agents.customAgents`
     - `kanban.customColumns`
     - `agents.visibleAgents`

2. **Remove import** - Change `import { stateFs as fs }` to `import * as fs from 'fs'`

### Step 3: TaskViewerProvider.ts Refactoring
1. **updateState()** - This is a generic updater that currently:
   - Reads full state via bridge
   - Applies updater function
   - Writes back via bridge

   **Replace with:** Direct db operations for each key being updated, or remove if unused

2. **Audit other methods** - Check if any still use bridge for state operations

3. **Remove imports** - Remove `stateFs` and `stateLockfile` imports

### Step 4: cleanWorkspace.ts Refactoring
1. **resetStateFile()**
   - Replace with direct db operations to reset runtime.* config keys
   - Remove lockfile usage (no-op)

2. **pruneZombieTerminalEntries()**
   - Replace with db operation to read `runtime.terminals`
   - Prune entries
   - Write back via `db.setConfigJson('runtime.terminals', terminals)`

3. **Remove imports** - Remove `stateFs` and `stateLockfile` imports

### Step 5: extension.ts Refactoring
1. **Terminal recovery logic** (line 566-582)
   - Replace state.json read with db call to `runtime.terminals`

2. **Remove imports** - Remove `stateFs` import

3. **Update comments** - Remove/update references to state.json

### Step 6: Test Updates
Update test assertions to reflect db-based operations:

1. **kanban-custom-column-management-regression.test.js**
   - Update assertion to expect db read instead of state.json read

2. **plan-ingestion-config-regression.test.js**
   - Update assertion to expect db write instead of state.json write

3. **plan-ingestion-target-regression.test.js**
   - Update assertion to expect db write instead of state.json write

4. **custom-lane-roundtrip-regression.test.js**
   - Update to use db directly for test setup

5. **plan-creation-status-regression.test.js**
   - Update assertion message

6. **kanban-auto-export.test.ts**
   - Already tests kanban-state.json cleanup, no change needed

### Step 7: Remove Bridge
1. Delete `src/services/stateConfigBridge.ts`
2. Remove `STATE_KEY_TO_CONFIG` export from KanbanDatabase (if exported)
3. Search for any remaining imports of stateConfigBridge and remove

### Step 8: Add Orphan Cleanup
Add cleanup in `KanbanDatabase._runConfigMigrations()`:

```typescript
// Clean up orphaned state.json files after successful migration
const stateJsonPath = path.join(sbDir, 'state.json');
if (fs.existsSync(stateJsonPath)) {
    try {
        await fs.promises.unlink(stateJsonPath);
        console.log('[KanbanDatabase] Cleaned up orphaned state.json');
    } catch (err) {
        console.warn('[KanbanDatabase] Failed to cleanup state.json:', err);
    }
}
```

### Step 9: Update Documentation
1. Update comments in cleanWorkspace.ts that reference state.json
2. Update comments in agentConfig.ts that reference state.json
3. Update comments in agentPromptBuilder.ts that reference state.json
4. Update AGENTS.md if it references state.json

## Testing Strategy

### Unit Tests
- Run existing test suite to ensure no regressions
- Focus on:
  - KanbanProvider tests
  - TaskViewerProvider tests
  - cleanWorkspace tests
  - Integration tests for config operations

### Manual Testing
1. **Custom kanban columns**
   - Create custom columns
   - Restart extension
   - Verify columns persist

2. **Custom agents**
   - Create custom agent
   - Restart extension
   - Verify agent persists

3. **Startup commands**
   - Set startup commands
   - Restart extension
   - Verify commands persist

4. **Terminal persistence**
   - Open terminals
   - Close extension
   - Reopen extension
   - Verify terminals recovered correctly

5. **Live sync config**
   - Configure live sync
   - Restart extension
   - Verify config persists

### Migration Testing
1. **Fresh install**
   - Install extension in new workspace
   - Verify no state.json created
   - Verify all config in db

2. **Upgrade from old version**
   - Create workspace with old extension (has state.json)
   - Upgrade to new version
   - Verify migration runs
   - Verify data in db
   - Verify state.json cleaned up

## Rollback Plan

If issues arise after deployment:

1. **Revert code changes** to restore bridge
2. **Keep migration code** so users who already migrated don't lose data
3. **Release hotfix** with bridge restored
4. **Investigate root cause** before attempting removal again

## Risks

### High Risk
- **Breaking changes in legacy call sites** - Mitigation: Comprehensive testing
- **Migration edge cases** - Mitigation: Preserve unknown keys in legacy.state

### Medium Risk
- **Test failures** - Mitigation: Update test assertions as part of migration
- **Performance regression** - Mitigation: Benchmark db operations vs bridge

### Low Risk
- **Orphaned state.json files** - Mitigation: Add cleanup in migration
- **Confusing error messages** - Mitigation: Update error handling for db operations

## Success Criteria

1. All state.json references removed from production code
2. stateConfigBridge.ts deleted
3. All tests pass
4. Manual testing confirms config persistence works
5. Migration from old versions succeeds
6. Orphaned state.json files cleaned up
7. No performance regression

## Estimated Effort

- **KanbanProvider.ts refactoring:** 2-3 hours
- **PlanningPanelProvider.ts refactoring:** 30 minutes
- **TaskViewerProvider.ts refactoring:** 1-2 hours
- **cleanWorkspace.ts refactoring:** 1 hour
- **extension.ts refactoring:** 30 minutes
- **Test updates:** 1-2 hours
- **Bridge removal and cleanup:** 30 minutes
- **Testing:** 2-3 hours
- **Total:** 8-12 hours
