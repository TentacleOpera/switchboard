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

## User Review Required

- Confirm whether orphan `state.json` should be renamed to `.migrated.bak` (preserving downgrade path) or deleted outright.
- Confirm if any external scripts, CI pipelines, or onboarding docs read `.switchboard/state.json` directly (bypassing the bridge). If so, they need migration too.

## Complexity Audit

### Routine
- Replacing `fs.readFile/writeFile` with `db.getConfigJson/setConfigJson` in methods with known key mappings.
- Swapping `import { stateFs as fs }` back to `import * as fs from 'fs'` where no state paths remain.
- Deleting `stateConfigBridge.ts` and `stateLockfile` references.
- Updating comments and log strings that mention `state.json`.

### Complex / Risky
- Refactoring `TaskViewerProvider.updateState()` generic batched updater into explicit per-key db operations (or a db transaction batch helper) without losing atomicity.
- `cleanWorkspace.ts` `resetStateFile()` and `pruneZombieTerminalEntries()` are on the activation hot path; errors here prevent extension startup.
- `KanbanDatabase.ts` still imports `STATE_KEY_TO_CONFIG` from the bridge; inlining this mapping is a prerequisite for bridge deletion.
- Six regression tests regex-match source code for `state.json` strings; any change to method internals will break assertions even if behavior is correct.
- `PlanningPanelProvider.ts` and `extension.ts` use the `stateFs` alias for general filesystem operations; must audit every call site to ensure no hidden state.json dependency remains.
- Terminal recovery in `extension.ts` (line 566–582) reads `runtime.terminals` before `cleanWorkspace` resets state; timing-sensitive and startup-critical.

## Edge-Case & Dependency Audit

- **Race Conditions:** `updateState()` currently batches multiple updaters under a single lockfile write. Decomposing into per-key db writes without a transaction wrapper could leave the runtime state partially updated if the process crashes mid-batch.
- **Security:** No new attack surface introduced. Legacy `state.json` may contain sensitive tokens; orphan cleanup should rename to `.migrated.bak` rather than unlink, preserving auditability and downgrade compatibility.
- **Side Effects:** Removing the bridge changes `fs.existsSync('...state.json')` from always-true to filesystem-reality. Any code that relied on the intercept (e.g., early-return guards) will now follow the false branch.
- **Dependencies & Conflicts:** `KanbanDatabase._runConfigMigrations` depends on `STATE_KEY_TO_CONFIG` from `stateConfigBridge.ts`. Bridge deletion must happen *after* the mapping is inlined into `KanbanDatabase.ts`.

## Dependencies

- No external session dependencies.
- Internal dependency: Step 0 (inline `STATE_KEY_TO_CONFIG` into `KanbanDatabase.ts`) must complete before Step 7 (bridge deletion).

## Adversarial Synthesis

Key risks: (1) Generic `updateState` batch-updater atomicity loss without a db transaction wrapper; (2) `STATE_KEY_TO_CONFIG` import chain making bridge deletion order-sensitive; (3) brittle regex-based regression tests failing on source code changes. Mitigations: decompose `updateState` into explicit per-key db calls with a `setConfigBatch` helper; inline the key map into `KanbanDatabase` first; schedule a dedicated test-assertion audit as a blocking sub-task.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** Lines 191–206 (`_getLiveSyncConfig`), 429–441 (`_getCustomKanbanColumns`), 2241–2278 (`_getDefaultPromptOverrides` / `_saveDefaultPromptOverrides`), 2373–2390 (`_getStartupCommands`), 2394–2412 (`_saveStartupCommands`), 3285–3299 (`_getCustomAgents`), 3401–3415 (`_getAgentNames`), 3469–3483 (`_getVisibleAgents`), 3487–3495 (`_hasAssignedAgent`).
- **Logic:** Each method currently constructs `statePath = .../state.json`, checks `fs.existsSync(statePath)`, reads/writes via `fs.promises.readFile/writeFile`, then parses or builds a JSON blob. Replace with direct `KanbanDatabase` config calls using the mapping already established by the bridge.
- **Implementation:**
  - `_getLiveSyncConfig`: `db.getConfigJson('planning.liveSyncConfig', { enabled: false, syncIntervalMs: 30000, conflictCheckEnabled: false })`
  - `_getCustomKanbanColumns`: `db.getConfigJson('kanban.customColumns', [])` then `parseCustomKanbanColumns(...)`
  - `_getDefaultPromptOverrides`: `db.getConfigJson('agents.promptOverrides', {})`
  - `_saveDefaultPromptOverrides`: `db.setConfigJson('agents.promptOverrides', overrides)`
  - `_getStartupCommands`: read `agents.startupCommands`, `agents.visibleAgents`, `agents.julesAutoSyncEnabled`, `kanban.autoCommitOnCodeReview` individually via `getConfigJson`
  - `_saveStartupCommands`: write the same keys individually via `setConfigJson`
  - `_getCustomAgents`: `db.getConfigJson('agents.customAgents', [])` then `parseCustomAgents(...)`
  - `_getAgentNames`: read `agents.startupCommands` and `agents.customAgents` via `getConfigJson`
  - `_getVisibleAgents`: read `agents.customAgents` and `agents.visibleAgents` via `getConfigJson`
  - `_hasAssignedAgent`: read `agents.customAgents` via `getConfigJson`
  - Remove `import { stateFs as fs }` and switch to `import * as fs from 'fs'` if any non-state fs calls remain.
- **Edge Cases:** `existsSync` no longer returns true for state.json; ensure methods handle missing config gracefully (default values cover this).

### `src/services/PlanningPanelProvider.ts`
- **Context:** Line 5125 (`_getKanbanColumnDefinitions`) constructs `statePath` and reads `customAgents`, `customKanbanColumns`, `visibleAgents`. Also lines 235, 244, 255, 586, 659, 709 use `fs.existsSync/readFileSync` for general file operations (docs, HTML, preview paths).
- **Logic:** Only `_getKanbanColumnDefinitions` hits state.json. General fs ops pass through the bridge anyway and can use normal `fs`.
- **Implementation:**
  - In `_getKanbanColumnDefinitions`, replace state.json read with:
    - `db.getConfigJson('agents.customAgents', [])`
    - `db.getConfigJson('kanban.customColumns', [])`
    - `db.getConfigJson('agents.visibleAgents', [])`
  - Swap `import { stateFs as fs }` to `import * as fs from 'fs'`.
- **Edge Cases:** None; normal fs calls unchanged.

### `src/services/TaskViewerProvider.ts`
- **Context:** Lines 1630–1699 (`updateState` / `_processUpdateQueue`), 16566–16577 (`_writeFileAtomic` state.json branch), 1009–1013 (`_resolveStateFilePath`), 14307 (`updateState` callers for terminals), 5206–5207 (`_persistLastAccessedDebounced`), 5216–5229 (`loadLastAccessedFromState`).
- **Logic:** `updateState` is the heart of the problem. It queues batched closures, acquires a lock, reads synthetic state, applies all closures, writes back. Callers mutate `state.terminals`, `state.chatAgents`, `state.session`, etc. Instead of preserving the generic updater, decompose each caller to use direct db operations.
- **Implementation:**
  - Add a private helper `_updateRuntimeConfig(key: string, updater: (val: any) => any)` that reads, mutates, and writes a single config key via `getConfigJson/setConfigJson`.
  - For batched multi-key updates, add `_batchRuntimeUpdate(updates: Record<string, any>)` that applies all `setConfigJson` calls sequentially (SQLite serialized writes are safe; add a lightweight in-memory mutex if needed).
  - Replace `updateState` callers with explicit key-targeted updates:
    - Terminal registry sync → `runtime.terminals`
    - Chat agent state → `runtime.chatAgents`
    - Session state → `runtime.session`
    - Context → `runtime.context`
    - Tasks → `runtime.tasks`
    - Teams → `runtime.teams`
    - Jules sessions → `runtime.jules`
  - `_writeFileAtomic`: remove the `getWorkspaceRootFromStatePath` branch; it becomes dead code after bridge removal.
  - `_persistLastAccessedDebounced` already uses db directly; update comments from "state.json" to "db config".
  - `loadLastAccessedFromState` already uses db directly; update comments.
  - Remove `import { stateFs as fs, stateLockfile as lockfile, getWorkspaceRootFromStatePath }` and switch to normal `fs` plus remove lockfile.
- **Edge Cases:** If two `updateState` batches fire concurrently, the old lockfile serialized them. SQLite writes through a single `KanbanDatabase` instance are already serialized, but cross-key consistency may need a simple `Promise` chain or mutex.

### `src/lifecycle/cleanWorkspace.ts`
- **Context:** Lines 110–130 (`resetStateFile`), 146–191 (`pruneZombieTerminalEntries`), 229–235 (`cleanWorkspace`), 53–104 (`readPersistedFields`).
- **Logic:** Both functions treat `state.json` as the source of truth. After bridge removal, they must speak db.
- **Implementation:**
  - `resetStateFile(statePath)`:
    - Remove `statePath` parameter; accept `workspaceRoot: string`.
    - Reset `runtime.session`, `runtime.context`, `runtime.tasks`, `runtime.terminals`, `runtime.chatAgents`, `runtime.teams` to their `INITIAL_STATE` defaults via `db.setConfigJson`.
    - Preserve user-configured keys by reading them from db first: `agents.startupCommands`, `agents.visibleAgents`, `agents.customAgents`, `runtime.autoban`, `planning.ingestionFolder`, `runtime.jules`, `runtime.julesPollingDegraded`, `runtime.julesPollingLastCheckedAt`, `runtime.julesPollingDegradedAt`. Then re-write them after the reset.
    - Remove lockfile usage entirely.
  - `pruneZombieTerminalEntries(statePath)`:
    - Remove `statePath` parameter; accept `workspaceRoot: string`.
    - Read `runtime.terminals` via `db.getConfigJson('runtime.terminals', {})`.
    - Prune dead PIDs in memory.
    - Write back via `db.setConfigJson('runtime.terminals', terminals)`.
    - Return pruned count.
  - `cleanWorkspace`:
    - Update call sites to pass `workspaceRoot` instead of `statePath`.
    - Remove comment references to "state.json".
  - Swap `import { stateFs as fs, stateLockfile as lockfile }` to `import * as fs from 'fs'`.
- **Edge Cases:** If db is not yet ready during activation, `KanbanDatabase.forWorkspace(...).ensureReady()` must be awaited first. `extension.ts` already warms the db before calling `cleanWorkspace` (line 561), so this is safe.

### `src/extension.ts`
- **Context:** Lines 571–582 (terminal recovery pre-cleanWorkspace), 726 (`getStateFilePath` helper), 1546/1557/1562 (comments referencing state.json), 1957 (background pruner comment), 2164/2167 (state parse error message), 2443 (log string).
- **Logic:** Terminal recovery reads old terminal names before `cleanWorkspace` resets them. `getStateFilePath` still returns a state.json path; callers may use it.
- **Implementation:**
  - Terminal recovery block (lines 569–582): replace with direct db read:
    ```ts
    const db = KanbanDatabase.forWorkspace(effectiveStateRoot);
    const oldTerminals = await db.getConfigJson<Record<string, any>>('runtime.terminals', {});
    for (const name of Object.keys(oldTerminals)) { oldTerminalNames.add(name); }
    ```
  - `getStateFilePath` helper: deprecate or remove; no remaining callers after refactor. If kept for external API compatibility, return `null` and log a deprecation warning.
  - Comment sweep: replace all "state.json" references with "runtime config" or "db config".
  - Log string at line 2443: change "persisted to state.json" to "persisted to db config".
  - Swap `import { stateFs as fs }` to `import * as fs from 'fs'`.
- **Edge Cases:** If db is not warmed, `getConfigJson` returns default `{}`; terminal recovery gracefully skips.

### `src/services/KanbanDatabase.ts`
- **Context:** Line 7 imports `STATE_KEY_TO_CONFIG` from bridge. Line 2863+ `_runConfigMigrations` uses it.
- **Logic:** The migration must survive bridge deletion.
- **Implementation:**
  - Inline a private `static _STATE_KEY_TO_CONFIG` mapping (or copy the object literal) directly into `KanbanDatabase.ts`.
  - Update `_runConfigMigrations` to use the local copy.
  - Remove `import { STATE_KEY_TO_CONFIG } from './stateConfigBridge'`.
  - Add orphan cleanup at end of `_runConfigMigrations` (after all migrations):
    ```ts
    const stateJsonPath = path.join(sbDir, 'state.json');
    if (fs.existsSync(stateJsonPath)) {
        try {
            fs.renameSync(stateJsonPath, stateJsonPath + '.migrated.bak');
        } catch (err) {
            console.warn('[KanbanDatabase] Failed to archive state.json:', err);
        }
    }
    ```
  - Add a `setConfigBatch` helper if desired for TaskViewerProvider atomicity:
    ```ts
    public async setConfigBatch(entries: Record<string, unknown>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        for (const [key, value] of Object.entries(entries)) {
            this._db.run('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
        }
        return this._persist();
    }
    ```
- **Edge Cases:** Renaming to `.migrated.bak` instead of `unlink` preserves downgrade path. `setConfigBatch` uses a single `_persist()` at the end; if full atomicity is required, wrap in `this._db.exec('BEGIN') ... exec('COMMIT')`.

### Test Files
- **Context:** See Affected Files list.
- **Logic:** Tests grep source strings; updating implementation changes the strings.
- **Implementation:** For each test:
  - `kanban-custom-column-management-regression.test.js`: update regex to expect `db.getConfigJson('kanban.customColumns', ...)` instead of `state.json` read.
  - `plan-ingestion-config-regression.test.js`: update assertion to expect `db.setConfigJson('planning.ingestionFolder', ...)` instead of `state.planIngestionFolder = ...`.
  - `plan-ingestion-target-regression.test.js`: same as above.
  - `custom-lane-roundtrip-regression.test.js`: update test setup to seed db config directly rather than writing `state.json`.
  - `plan-creation-status-regression.test.js`: update comment/assertion message from "state.json collides" to "db plan file collision".
  - `kanban-auto-export.test.ts`: no change needed.
- **Edge Cases:** None.

### `src/services/stateConfigBridge.ts`
- **Context:** Entire file.
- **Logic:** Delete after all call sites and KanbanDatabase mapping are migrated.
- **Implementation:** Delete file. Remove all imports across codebase (already listed in Affected Files).
- **Edge Cases:** Ensure no dynamic `require('./stateConfigBridge')` exists anywhere (grep for it).

## Verification Plan

### Automated Tests
- Run the existing regression test suite. Because tests are skipped in this session per directive, the verification plan documents the expected test updates:
  1. `kanban-custom-column-management-regression.test.js` — regex match updated.
  2. `plan-ingestion-config-regression.test.js` — string assertions updated.
  3. `plan-ingestion-target-regression.test.js` — string assertions updated.
  4. `custom-lane-roundtrip-regression.test.js` — db seeding instead of file writing.
  5. `plan-creation-status-regression.test.js` — assertion message updated.
  6. `kanban-auto-export.test.ts` — no change.
- Manual verification steps (to be performed by user):
  1. Custom kanban columns persist across reload.
  2. Custom agents persist across reload.
  3. Startup commands persist across reload.
  4. Terminal registry correctly prunes zombies after process kill.
  5. `cleanWorkspace` completes without error on activation.
  6. Orphaned `state.json` is renamed to `.migrated.bak` on first activation after upgrade.
  7. No duplicate `state.json` recreated after cleanup.

**Recommendation:** Complexity is 7 → **Send to Lead Coder**.
