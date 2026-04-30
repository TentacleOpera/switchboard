# Unified Sync Config for Multi-Root Workspaces

## Goal

Establish a single source of truth for planning sync configuration across all workspace roots, eliminating the need for duplicate `.switchboard/planning-sync-config.json` files in every root while ensuring consistent sync behavior regardless of which root is "active".

## Metadata
**Tags:** backend, UX, reliability
**Complexity:** 6
**Repo:** (single-repo)

## User Review Required

⚠️ **Breaking Change Notice**: Users who currently have different `planning-sync-config.json` files in different workspace roots (intentionally or accidentally) will experience changed behavior. The system will now use only the first config found and ignore others.

**Migration Path**: Users with per-root configs should consolidate to a single config file in the first workspace root.

## Problem

In multi-root workspaces, the planning panel currently reads `planning-sync-config.json` from only one root (the "active" root at panel open time). This forces users to either:

1. Duplicate config files across every root (maintenance burden)
2. Accept that sync only works when the "right" root is active (unreliable)
3. Limit themselves to single-root workflows (defeats purpose of multi-root)

This penalizes users with well-architected codebases (monorepos, separated concerns).

## Root Cause Analysis

1. **Single-root assumption**: `open()` method reads config from `_getWorkspaceRoot()` only (lines 180-192 in `PlanningPanelProvider.ts`)
2. **No unified discovery**: No mechanism to find "the one config" across all roots
3. **No precedence rules**: When multiple configs exist, behavior is undefined

## Proposed Solution

Implement **Unified Config Discovery**: Search all workspace roots, use first-found config as the single source of truth for the entire workspace.

### Precedence Rules

1. **Primary**: Config in the first workspace root (VS Code's order)
2. **Secondary**: Config found in any other root (logged for transparency)
3. **Fallback**: Default `no-sync` mode if none found

### Behavior

- **One config rules all**: Sync settings apply workspace-wide, regardless of which root has the active file
- **Explicit per-root override**: Future enhancement could allow root-specific overrides
- **Clear logging**: User sees which root's config is being used

## Complexity Audit

### Routine
- **Adding `_resolveSyncConfig()` helper method** (lines 48-72 area): Single-file addition to `PlanningPanelProvider.ts` using existing `_getWorkspaceRoots()` pattern already present at line 271-273
- **Updating `open()` method** (lines 180-192): Replacing single-root config read with unified discovery call - straightforward method body replacement
- **Updating `_sendOnlineDocsReady()`** (lines 815-845): Similar pattern - replace direct config read with unified helper call
- **Type definitions for config**: Adding simple interface/type for return value of `_resolveSyncConfig()`
- **Logging additions**: Console.log statements for transparency about which root's config is used

### Complex / Risky
- **Config save operations (`savePlanningContainerSelection` message handler, lines 290-318)**: Must ensure container selections are written to the SAME root where config was discovered, not the active root. This requires storing the resolved config source root and using it for all subsequent writes.
- **Config path caching decision**: Must decide whether to cache the resolved config path (performance) vs re-discovering on every call (freshness). Trade-off between consistency and responsiveness.
- **Race conditions during config migration**: If user moves config file while panel is open, behavior could be inconsistent between read and write operations.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Config file moves during active session**: If a user moves `planning-sync-config.json` from root A to root B while the panel is open, subsequent save operations may write to the wrong location. **Mitigation**: Resolve config path once at panel open and cache it; subsequent operations use cached path.
- **Config write conflicts**: Multiple VS Code windows with the same multi-root workspace could write to the config simultaneously. **Mitigation**: Existing file writes are atomic; we rely on Node.js file system atomicity guarantees.

**Security:**
- **No new security risks introduced**: The change only affects WHICH config file is read/written, not HOW it's parsed or validated.
- **Path traversal**: All paths are constructed using `path.join()` with workspace root prefixes from VS Code's API, not user input. **Verification**: Existing code pattern at line 295-296 uses this safely.

**Side Effects:**
- **Breaking change for multi-config users**: Users with different configs in different roots will now only see the first config.
- **Log spam**: If we log on every config read, console could get noisy. **Mitigation**: Log only when config is first discovered or when source changes.
- **File watcher implications**: If we add file watchers for config changes, this could increase resource usage. **Clarification**: Out of scope for this plan; future enhancement.

**Dependencies & Conflicts:**
None. Kanban board shows no active plans in CREATED or PLANNED columns that would conflict with this work.

## Dependencies

None

## Adversarial Synthesis

Key risks: Config path caching could stale if config moves; multi-config users experience breaking change; save operations may target wrong root if not using cached source. Mitigations: Cache resolved path at panel open with source root; log config source clearly for debugging; validate all write operations use cached source root.

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/PlanningPanelProvider.ts` | Add `_resolveSyncConfig()` helper; update `open()`, `_sendOnlineDocsReady()`, `savePlanningContainerSelection`, and `triggerSync()` to use unified discovery |

## Implementation

### Step 1: Add unified config resolution helper

#### Context
The `PlanningPanelProvider` class currently has no mechanism to discover config across multiple workspace roots. We need a helper that searches all roots and returns the first valid config found, along with metadata about where it was found.

#### Logic
1. Get all workspace roots using existing `_getWorkspaceRoots()` method (line 271)
2. Iterate through roots in order (VS Code's order is preserved)
3. For each root, attempt to read `.switchboard/planning-sync-config.json`
4. Return immediately on first successful read with path, parsed config, and source root
5. If no config found in any root, return default config with null path and empty sourceRoot

#### Implementation
**File:** `src/services/PlanningPanelProvider.ts`
**Location:** After line 47 (after private field declarations, before constructor)

```typescript
private _resolvedConfigCache: {
    configPath: string | null;
    config: { syncMode?: string; browseFilterContainers?: Record<string, string> };
    sourceRoot: string;
} | null = null;

private async _resolveSyncConfig(): Promise<{
    configPath: string | null;
    config: { syncMode?: string; browseFilterContainers?: Record<string, string> };
    sourceRoot: string;
}> {
    // Return cached result if available (resolves race condition on repeated calls)
    if (this._resolvedConfigCache) {
        return this._resolvedConfigCache;
    }

    const allRoots = this._getWorkspaceRoots();
    const defaultConfig = { syncMode: 'no-sync', browseFilterContainers: {} };

    // Search all roots for config
    for (const root of allRoots) {
        const configPath = path.join(root, '.switchboard', 'planning-sync-config.json');
        try {
            const raw = await fs.promises.readFile(configPath, 'utf8');
            const config = JSON.parse(raw);
            console.log(`[PlanningPanel] Using sync config from: ${root}`);
            const result = { configPath, config, sourceRoot: root };
            this._resolvedConfigCache = result;
            return result;
        } catch (err) {
            // Config not found in this root, continue searching
            // Clarification: Only swallow ENOENT errors; log others for debugging
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn(`[PlanningPanel] Error reading config from ${root}:`, err);
            }
        }
    }

    // No config found in any root
    const result = { configPath: null, config: defaultConfig, sourceRoot: '' };
    this._resolvedConfigCache = result;
    return result;
}
```

#### Edge Cases Handled
- **Empty workspace**: `_getWorkspaceRoots()` returns empty array; falls through to default config
- **Permission denied on config file**: Logged as warning, continues searching other roots
- **Invalid JSON in config file**: Logged as warning, continues searching other roots
- **Repeated calls**: Cached result prevents multiple file system operations

### Step 2: Update `open()` method to use unified config discovery

#### Context
Current `open()` method (lines 180-192) only reads config from the active workspace root via `_getWorkspaceRoot()`. This must be updated to use unified discovery.

#### Logic
1. Replace the single-root config read block with unified discovery
2. Use `sourceRoot` from resolved config for sync operations (ensures sync uses correct root)
3. Store resolved config for later use by other methods

#### Implementation
**File:** `src/services/PlanningPanelProvider.ts`
**Location:** Lines 180-192 (inside `open()` method, after panel setup)

Replace existing code block:
```typescript
// OLD CODE (lines 180-192):
// const workspaceRoot = this._getWorkspaceRoot();
// if (workspaceRoot) {
//     const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
//     try {
//         const raw = await fs.promises.readFile(configPath, 'utf8');
//         const config = JSON.parse(raw);
//         const syncMode = config.syncMode || 'no-sync';
//         if (syncMode !== 'no-sync') {
//             await this.triggerSync(workspaceRoot, syncMode);
//         }
//     } catch { /* no config yet */ }
// }

// NEW CODE:
// Unified config discovery across all roots
const { config, sourceRoot } = await this._resolveSyncConfig();
const syncMode = config.syncMode || 'no-sync';

if (syncMode !== 'no-sync' && sourceRoot) {
    await this.triggerSync(sourceRoot, syncMode);
}
```

#### Edge Cases Handled
- **No config found**: `sourceRoot` is empty string, `syncMode` defaults to `'no-sync'`, no sync triggered
- **Config found in non-active root**: Sync still triggered using correct `sourceRoot`

### Step 3: Update `_sendOnlineDocsReady()` for unified container filters

#### Context
Current method (lines 815-845) reads `browseFilterContainers` from active root only. Must use unified discovery for consistency.

#### Logic
1. Call `_resolveSyncConfig()` to get unified config
2. Extract `browseFilterContainers` from resolved config (or empty object if none)
3. Send to webview as before

#### Implementation
**File:** `src/services/PlanningPanelProvider.ts`
**Location:** Lines 821-831 (inside `_sendOnlineDocsReady()` method)

Replace existing code block:
```typescript
// OLD CODE (lines 821-831):
// let browseFilterContainers: Record<string, string> = {};
// const workspaceRoot = this._getWorkspaceRoot();
// if (workspaceRoot) {
//     try {
//         const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
//         const content = await fs.promises.readFile(configPath, 'utf8');
//         const config = JSON.parse(content);
//         browseFilterContainers = config.browseFilterContainers || {};
//     } catch { /* no config yet */ }
// }

// NEW CODE:
// Load browse filter containers from unified config
const { config } = await this._resolveSyncConfig();
const browseFilterContainers = config.browseFilterContainers || {};
```

#### Edge Cases Handled
- **Config has no `browseFilterContainers` field**: Falls back to empty object `{}`
- **Config file malformed**: `_resolveSyncConfig()` handles error and returns default

### Step 4: Update `savePlanningContainerSelection` to use unified config root

#### Context
The message handler at lines 290-318 currently saves container selections to the active workspace root. This causes data loss in multi-root workspaces when the config exists in a different root. Must write to the SAME root where config was discovered.

#### Logic
1. Get resolved config path and source root from `_resolveSyncConfig()`
2. If config exists, write to that same path
3. If no config exists, create in first root (same as discovery precedence)
4. Update cached config after write

#### Implementation
**File:** `src/services/PlanningPanelProvider.ts`
**Location:** Lines 290-318 (case 'savePlanningContainerSelection' block)

Replace existing code block:
```typescript
// OLD CODE (lines 290-318):
// const workspaceRoot = this._getWorkspaceRoot();
// if (!workspaceRoot) { break; }
// try {
//     const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
//     let config: any = {};
//     try {
//         const content = await fs.promises.readFile(configPath, 'utf8');
//         config = JSON.parse(content);
//     } catch { /* no existing config */ }
//     if (!config.browseFilterContainers) {
//         config.browseFilterContainers = {};
//     }
//     if (containerId && containerId !== '__all__') {
//         config.browseFilterContainers[sourceId] = containerId;
//     } else {
//         delete config.browseFilterContainers[sourceId];
//     }
//     await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
//     await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
// } catch (error) {
//     console.error('[PlanningPanel] Failed to save container selection:', error);
// }

// NEW CODE:
try {
    const { configPath, sourceRoot, config: existingConfig } = await this._resolveSyncConfig();
    let targetConfigPath = configPath;
    let targetRoot = sourceRoot;

    // No existing config — create in first root
    if (!targetConfigPath) {
        const allRoots = this._getWorkspaceRoots();
        if (allRoots.length === 0) { break; }
        targetRoot = allRoots[0];
        targetConfigPath = path.join(targetRoot, '.switchboard', 'planning-sync-config.json');
        console.log(`[PlanningPanel] Creating new config in: ${targetRoot}`);
    }

    // Build updated config
    const config = { ...existingConfig };
    if (!config.browseFilterContainers) {
        config.browseFilterContainers = {};
    }
    if (containerId && containerId !== '__all__') {
        config.browseFilterContainers[sourceId] = containerId;
    } else {
        delete config.browseFilterContainers[sourceId];
    }

    await fs.promises.mkdir(path.dirname(targetConfigPath), { recursive: true });
    await fs.promises.writeFile(targetConfigPath, JSON.stringify(config, null, 2), 'utf8');

    // Update cache to reflect new state
    this._resolvedConfigCache = {
        configPath: targetConfigPath,
        config,
        sourceRoot: targetRoot
    };
} catch (error) {
    console.error('[PlanningPanel] Failed to save container selection:', error);
}
```

#### Edge Cases Handled
- **No config exists**: Creates new config in first root
- **No workspace roots**: Early exit (shouldn't happen but defensive)
- **Write fails (permissions)**: Error logged, cache not updated
- **Concurrent saves**: Last write wins (acceptable for this use case)

### Step 5: Update `triggerSync()` to use unified config discovery

#### Context
`triggerSync()` (lines 1637-1669) currently reads config from `workspaceRoot` parameter. When called without mode, it should use unified discovery to find the correct config.

#### Logic
1. When `syncMode` is not provided, use `_resolveSyncConfig()` to find mode
2. Continue using provided `workspaceRoot` for sync operations (source of truth for sync target)

#### Implementation
**File:** `src/services/PlanningPanelProvider.ts`
**Location:** Lines 1640-1651 (inside `triggerSync()` method)

Replace existing code block:
```typescript
// OLD CODE (lines 1640-1651):
// let mode: string = syncMode || 'no-sync';
// if (!syncMode) {
//     const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
//     try {
//         const raw = await fs.promises.readFile(configPath, 'utf8');
//         const config = JSON.parse(raw);
//         mode = config.syncMode || 'no-sync';
//     } catch {
//         mode = 'no-sync';
//     }
// }

// NEW CODE:
let mode: string = syncMode || 'no-sync';
if (!syncMode) {
    const { config } = await this._resolveSyncConfig();
    mode = config.syncMode || 'no-sync';
}
```

#### Edge Cases Handled
- **No config found**: Defaults to `'no-sync'`
- **Mode explicitly provided**: Uses provided mode (no change in behavior)

## Verification Plan

### Automated Tests
- **Compile check**: `npm run compile` must pass without TypeScript errors
- **Unit test** (if test suite exists): Mock `_getWorkspaceRoots()` returning multiple roots, verify `_resolveSyncConfig()` returns first root with config
- **Unit test**: Verify `_resolveSyncConfig()` caches result and returns same object on repeated calls

### Manual Verification Steps
1. **Single-root workspace** (regression test):
   - Open panel → verify existing sync behavior unchanged
   - Save container selection → verify written to `.switchboard/planning-sync-config.json`

2. **Multi-root workspace, config in root A only**:
   - Open panel from file in root A → sync should work
   - Open panel from file in root B → sync should still work (using root A's config)
   - Check console log: should show `[PlanningPanel] Using sync config from: /path/to/rootA`

3. **Multi-root workspace, no config**:
   - Delete all `planning-sync-config.json` files
   - Open panel → should open with `no-sync` mode
   - Save container selection → should create config in first root only

4. **Container filter persistence across roots**:
   - Open panel from root A, select container filter for a source
   - Close panel, open from root B
   - Verify container filter selection is persisted (read from root A's config)

## Execution Summary

**Status:** COMPLETED  
**Executed by:** Task Runner  
**Date:** 2026-04-30

### Changes Implemented

All 5 steps from the Implementation section were completed:

1. **Added `_resolvedConfigCache` field** (line 38) - Caches resolved config to prevent race conditions and redundant file system operations

2. **Added `_resolveSyncConfig()` method** (lines 104-140) - Searches all workspace roots for the first `planning-sync-config.json` and returns config, path, and source root

3. **Updated `open()` method** (lines 224-230) - Uses unified config discovery instead of single-root config read

4. **Updated `_sendOnlineDocsReady()`** (lines 860-862) - Loads browseFilterContainers from unified config

5. **Updated `savePlanningContainerSelection`** (lines 329-371) - Writes container selections to the same root where config was discovered; creates new config in first root if none exists; updates cache after write

6. **Updated `triggerSync()`** (lines 1685-1690) - Uses unified config discovery when syncMode is not provided

### Files Changed

| File | Lines Modified |
|------|----------------|
| `src/services/PlanningPanelProvider.ts` | +73 lines (added cache field, `_resolveSyncConfig()` method, updated 4 existing methods) |

### Verification Results (Initial Implementation)

- `npm run compile` - **PASSED** (webpack compiled successfully in 13406ms)

### Key Implementation Notes

- The `_resolveSyncConfig()` method caches its result to prevent redundant file system operations and race conditions
- All write operations (`savePlanningContainerSelection`) update the cache to maintain consistency
- If no config exists anywhere, new configs are created in the first workspace root (matching VS Code's order)
- Logging added for transparency: `[PlanningPanel] Using sync config from: /path/to/root` and `[PlanningPanel] Creating new config in: /path/to/root`
- Error handling distinguishes between ENOENT (file not found, continues searching) vs other errors (logged as warnings)

---

## Reviewer Pass Results

**Reviewer:** Direct Reviewer-Executor  
**Date:** 2026-04-30

### Stage 1: Grumpy Review Findings

#### [CRITICAL] Cache Invalidation — Cache Never Cleared
**Location:** `src/services/PlanningPanelProvider.ts`, lines 38-42 (cache field)

The `_resolvedConfigCache` is set once and never cleared. When a user closes and reopens the panel after moving config files, stale cached config from the old location would be used.

#### [MAJOR] `triggerSync()` Still Reads Config from `workspaceRoot` for `sync-selected` Mode
**Location:** `src/services/PlanningPanelProvider.ts`, lines 1698-1705

The `sync-selected` mode was reading `selectedContainers` directly from `workspaceRoot` parameter instead of using unified config discovery. This bypassed the unified discovery entirely.

#### [MAJOR] Dead Variable — `workspaceRoot` Assigned but Never Used for Sync
**Location:** `src/services/PlanningPanelProvider.ts`, line 225

The `workspaceRoot` variable was fetched via `_getWorkspaceRoot()` but then `sourceRoot` from resolved config was used for sync instead.

#### [NIT] `_sendOnlineDocsReady()` Logs Unnecessarily
**Location:** `src/services/PlanningPanelProvider.ts`, line 879

Every call logs roots count, which gets noisy.

#### [NIT] Error Swallowing in `triggerSync()`
**Location:** `src/services/PlanningPanelProvider.ts`, line 1705

Silent catch block makes debugging impossible.

### Stage 2: Balanced Synthesis

**What to Keep:**
- `_resolveSyncConfig()` helper structure with proper ENOENT vs other error handling
- `savePlanningContainerSelection` implementation for cache management
- `_sendOnlineDocsReady()` using unified config for `browseFilterContainers`

**What to Fix (Applied):**
1. Clear cache at start of `open()` to ensure fresh discovery
2. Fix `triggerSync()` `sync-selected` mode to use unified config discovery
3. Remove dead code (unused `workspaceRoot` assignment)
4. Add `selectedContainers` to config type definition

**What Can Defer:**
- Logging noise reduction
- Error visibility improvements
- Docs folder watcher watching all roots vs just active

### Fixes Applied

| Fix | Location | Description |
|-----|----------|-------------|
| Cache clearing | `open()` line 181-182 | Added `this._resolvedConfigCache = null;` at start of `open()` |
| Remove dead code | `open()` line 225 | Removed unused `workspaceRoot` variable assignment |
| Fix `sync-selected` mode | `triggerSync()` lines 1697-1703 | Use `_resolveSyncConfig()` instead of direct file read |
| Type fix | Lines 40, 106 | Added `selectedContainers?: string[]` to config type |

### Files Changed (Review Fixes)

| File | Changes |
|------|---------|
| `src/services/PlanningPanelProvider.ts` | 4 fixes: cache clearing, dead code removal, sync-selected fix, type update |

### Verification Results (Post-Review)

- `npm run compile` - **PASSED** (webpack compiled successfully in 21898ms)

### Remaining Risks

1. **Docs folder watcher scope**: The watcher still only watches the active workspace root. If docs are in a different root, changes won't be detected. This is existing behavior, not a regression.
2. **No file watcher for config changes**: If user modifies `planning-sync-config.json` while panel is open, changes won't be detected until panel reopens. Out of scope for this plan.
3. **Multiple VS Code windows**: Concurrent writes from multiple windows could cause conflicts. Relies on Node.js file system atomicity.

### Status

**REVIEW COMPLETE — Ready for User Acceptance Testing**
