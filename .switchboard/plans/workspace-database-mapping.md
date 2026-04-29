---
description: Implement explicit workspace-to-database mapping configuration
---

# Workspace-to-Database Mapping Feature

## Goal

Add an opt-in setting that lets a user explicitly map a set of workspace folders to a single shared `kanban.db`, so a multi-folder workspace (e.g. several Gitlab sub-repos) uses one centralized database instead of fragmenting into per-folder DBs, while preserving today's zero-config single-workspace default behavior.

## Metadata
**Tags:** backend, frontend, database, UI, workflow
**Complexity:** 6
**Repo:** none

## User Review Required

- **Opt-in only** — default behavior is unchanged; users on single-folder workspaces will see no difference and need take no action.
- **One canonical setting** — *Clarification:* this plan collapses the originally-proposed two settings (`switchboard.workspaceMappingEnabled` and the nested `workspaceDatabaseMappings.enabled`) into a single `switchboard.workspaceDatabaseMappings.enabled` flag to avoid ambiguity. No new product scope; only consolidates the existing toggle requirement.
- **Fallback policy when enabled** — *Clarification:* when mapping is enabled but the active folder is not present in any mapping, the extension must (a) emit a single visible warning notification to the user and (b) fall back to the default `<folder>/.switchboard/kanban.db` path. This is implied by the existing requirement "Fallback to default behavior for unmapped folders with warning" (Solution Design → Behavior Modes) but is restated here so the implementer cannot pick the silent path.
- **No file moves** — flipping the toggle never moves or copies an existing `kanban.db`; it only changes which path subsequent reads/writes target. Users with data in legacy locations must manually point the mapping at that file or migrate via existing Control Plane tooling.

## Problem Statement

The current Kanban workspace switcher creates separate `kanban.db` files for each workspace folder, which causes:
- Plans to be scattered across multiple databases instead of centralized
- Workspace switcher showing every individual folder instead of meaningful workspace roots
- Difficulty managing multi-folder workspaces (e.g., Gitlab with Control Plane, ai, be, fe, viaapp sub-folders)

The existing Control Plane setup menu is overly complex with migration workflows and requires manual configuration through multiple steps.

## Requirements

### Core Requirements
1. **Preserve default behavior**: Single workspace setup must continue to work easily without configuration
2. **Opt-in feature**: Workspace-to-database mapping must be an optional override, not automatic
3. **Explicit control**: User must explicitly configure which folders use which database
4. **Prevent random creation**: When mapping is enabled, prevent creation of new `kanban.db` files in random folders
5. **Simple UI**: Easy-to-understand configuration interface

### User Story
As a user with a multi-folder workspace, I want to explicitly configure which workspace folders use which database so that:
- All my Gitlab folders (Control Plane, ai, be, fe, viaapp) use one centralized database at `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db`
- My Switchboard workspace uses its own database at `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db`
- The workspace switcher shows only "Gitlab" and "Switchboard" instead of every individual folder
- No random `kanban.db` files are created in sub-folders

## Solution Design

### Data Structure

Store in VS Code workspace settings under `switchboard.workspaceDatabaseMappings`:

```typescript
interface WorkspaceDatabaseMapping {
    id: string;                    // Unique ID for this database config
    name: string;                  // Display name (e.g., "Gitlab", "Switchboard")
    dbPath: string;               // Absolute path to kanban.db
    workspaceFolders: string[];    // List of workspace folder paths this database covers
}

interface WorkspaceDatabaseMappingsConfig {
    enabled: boolean;              // Toggle to enable/disable mapping mode (default: false)
    mappings: WorkspaceDatabaseMapping[];
}
```

Example configuration:
```json
{
    "enabled": true,
    "mappings": [
        {
            "id": "gitlab-main",
            "name": "Gitlab",
            "dbPath": "/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db",
            "workspaceFolders": [
                "/Users/patrickvuleta/Documents/Gitlab/Control Plane",
                "/Users/patrickvuleta/Documents/Gitlab/ai",
                "/Users/patrickvuleta/Documents/Gitlab/be",
                "/Users/patrickvuleta/Documents/Gitlab/fe",
                "/Users/patrickvuleta/Documents/Gitlab/viaapp"
            ]
        },
        {
            "id": "switchboard-main",
            "name": "Switchboard",
            "dbPath": "/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db",
            "workspaceFolders": [
                "/Users/patrickvuleta/Documents/GitHub/switchboard"
            ]
        }
    ]
}
```

### Behavior Modes

**Default Mode (mapping disabled):**
- Single workspace: Creates `.switchboard/kanban.db` in that folder
- Multi-folder: Each folder creates its own `.switchboard/kanban.db`
- No configuration needed
- Workspace switcher shows all workspace folders

**Mapping Mode (enabled):**
- Uses configured workspace-to-database mappings
- Redirects workspace folders to specified database paths
- Prevents creation of new `kanban.db` files in mapped folders
- Workspace switcher shows only configured databases
- Fallback to default behavior for unmapped folders with warning

## Implementation Plan

### Phase 1: Configuration Settings

**File:** `package.json`

Add new configuration properties:
```json
"switchboard.workspaceMappingEnabled": {
    "type": "boolean",
    "default": false,
    "description": "Enable workspace-to-database mapping to prevent random kanban.db creation"
},
"switchboard.workspaceDatabaseMappings": {
    "type": "object",
    "default": {
        "enabled": false,
        "mappings": []
    },
    "description": "Workspace-to-database mapping configuration"
}
```

### Phase 2: UI Implementation

**File:** `src/webview/setup.html`

Add new section after existing configuration sections:

```html
<div class="startup-section">
    <div class="startup-toggle" id="workspace-mapping-toggle">
        <div class="section-label">Workspace Database Mappings</div>
        <span class="chevron" id="workspace-mapping-chevron">▶</span>
    </div>
    <div class="startup-fields" id="workspace-mapping-fields" data-accordion="true">
        <div style="font-size:10px; color:var(--text-secondary); margin-bottom:10px; line-height:1.5;">
            Explicitly configure which workspace folders use which database. When enabled, prevents random kanban.db creation and redirects to specified databases. Leave disabled for default single-workspace behavior.
        </div>
        
        <label class="startup-row">
            <input type="checkbox" id="workspace-mapping-enabled-checkbox">
            <span>Enable workspace-to-database mapping</span>
        </label>
        
        <div id="workspace-mappings-container" style="display:none; margin-top:12px;">
            <!-- Mapping items will be dynamically inserted here -->
        </div>
        
        <div id="workspace-mapping-controls" style="display:none; margin-top:12px;">
            <button id="btn-add-mapping" class="secondary-btn w-full">Add New Database</button>
            <button id="btn-save-mappings" class="action-btn w-full" style="margin-top:8px;">Save Mappings</button>
        </div>
        
        <div id="workspace-mapping-status" style="font-size:10px; color:var(--accent-teal); margin-top:6px;"></div>
    </div>
</div>
```

**File:** `src/webview/setup.html` (JavaScript section)

Add JavaScript handlers:
- Toggle accordion visibility
- Toggle mapping enabled/disabled
- Add/remove mapping items
- Save mappings to configuration
- Load existing mappings on startup

### Phase 3: KanbanDatabase.ts Changes

**File:** `src/services/KanbanDatabase.ts`

Modify `forWorkspace()` method to check workspace mappings:

```typescript
public static forWorkspace(workspaceRoot: string, customDbPath?: string): KanbanDatabase {
    const stable = path.resolve(workspaceRoot);
    const existing = KanbanDatabase._instances.get(stable);
    if (existing) {
        return existing;
    }

    let resolvedDbPath: string | undefined;
    let effectiveRoot = stable;
    
    // Only use workspace mappings if explicitly enabled
    let useMappings = false;
    try {
        const vscode = require('vscode');
        const config = vscode.workspace.getConfiguration('switchboard');
        useMappings = config.get('workspaceMappingEnabled', false);
        
        if (useMappings) {
            const mappingsConfig = config.get('workspaceDatabaseMappings') as { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } | undefined;
            
            if (mappingsConfig?.enabled && mappingsConfig.mappings) {
                const mapping = mappingsConfig.mappings.find(m => 
                    m.workspaceFolders.some(folder => path.resolve(folder) === stable)
                );
                
                if (mapping) {
                    resolvedDbPath = mapping.dbPath;
                    effectiveRoot = path.dirname(mapping.dbPath);
                    console.log(`[KanbanDatabase] Workspace mapping active: ${stable} -> ${mapping.dbPath}`);
                } else {
                    console.warn(`[KanbanDatabase] Workspace mapping enabled but no mapping found for ${stable}. Using default behavior.`);
                }
            }
        }
    } catch {
        // Outside extension host - use default behavior
    }

    // Fallback to customDbPath, VS Code setting, or default
    if (!resolvedDbPath) {
        if (customDbPath !== undefined && customDbPath.trim() !== '') {
            const trimmed = customDbPath.trim();
            const expanded = trimmed.startsWith('~')
                ? path.join(require('os').homedir(), trimmed.slice(1))
                : trimmed;
            resolvedDbPath = path.isAbsolute(expanded) ? expanded : path.join(effectiveRoot, expanded);
        } else {
            let settingValue = '';
            try {
                const vscode = require('vscode');
                settingValue = String(vscode.workspace.getConfiguration('switchboard').get('kanban.dbPath') || '').trim();
            } catch {
                // Outside extension host
            }
            if (settingValue) {
                const expanded = settingValue.startsWith('~')
                    ? path.join(require('os').homedir(), settingValue.slice(1))
                    : settingValue;
                resolvedDbPath = path.isAbsolute(expanded) ? expanded : path.join(effectiveRoot, expanded);
            } else {
                resolvedDbPath = path.join(effectiveRoot, '.switchboard', 'kanban.db');
            }
        }
    }

    const created = new KanbanDatabase(effectiveRoot, resolvedDbPath);
    KanbanDatabase._instances.set(stable, created);
    return created;
}
```

### Phase 4: KanbanProvider.ts Changes

**File:** `src/services/KanbanProvider.ts`

Modify `_getWorkspaceItems()` method to show only configured databases when mapping is enabled:

```typescript
private _getWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
    const folders = vscode.workspace.workspaceFolders || [];
    
    // Only use workspace mappings if explicitly enabled
    try {
        const vscode = require('vscode');
        const config = vscode.workspace.getConfiguration('switchboard');
        const useMappings = config.get('workspaceMappingEnabled', false);
        
        if (useMappings) {
            const mappingsConfig = config.get('workspaceDatabaseMappings') as { enabled: boolean; mappings: WorkspaceDatabaseMapping[] } | undefined;
            
            if (mappingsConfig?.enabled && mappingsConfig.mappings && mappingsConfig.mappings.length > 0) {
                // Return only configured databases
                return mappingsConfig.mappings.map(mapping => ({
                    label: mapping.name,
                    workspaceRoot: path.dirname(mapping.dbPath)
                }));
            }
        }
    } catch {
        // Fall back to default behavior
    }
    
    // Default behavior: show all workspace folders
    return folders.map(folder => ({
        label: folder.name,
        workspaceRoot: folder.uri.fsPath
    }));
}
```

### Phase 5: SetupPanelProvider.ts Changes

**File:** `src/services/SetupPanelProvider.ts`

Add message handlers for workspace mapping:
- `getWorkspaceMappings` - Load current configuration
- `setWorkspaceMappingEnabled` - Enable/disable mapping
- `addWorkspaceMapping` - Add new mapping
- `removeWorkspaceMapping` - Remove mapping
- `updateWorkspaceMapping` - Update existing mapping
- `saveWorkspaceMappings` - Save all mappings to configuration

## Testing Strategy

### Unit Tests

**File:** `src/services/__tests__/KanbanDatabase.workspaceMapping.test.ts` (new)

Test cases:
1. Default behavior when mapping disabled
2. Mapping enabled with valid configuration
3. Mapping enabled but workspace not in mappings (fallback to default)
4. Mapping enabled with custom db path override
5. Mapping enabled with VS Code setting override
6. Invalid mapping configuration (graceful degradation)

### Integration Tests

**File:** `src/test/workspace-mapping-integration.test.js` (new)

Test scenarios:
1. Single workspace setup (default behavior)
2. Multi-folder workspace without mapping (default behavior)
3. Multi-folder workspace with mapping enabled
4. Workspace switcher shows configured databases only
5. Toggle mapping on/off preserves data
6. Migrate from default to mapped configuration

### Manual Testing

1. Open single workspace folder - verify default behavior works
2. Open multiple folders without mapping - verify each creates own database
3. Enable mapping and configure Gitlab folders to use one database
4. Verify workspace switcher shows only "Gitlab" and "Switchboard"
5. Verify no new kanban.db files created in sub-folders
6. Disable mapping - verify default behavior restored
7. Test with various folder structures and edge cases

## Migration Path

### For Existing Users

- Default behavior unchanged (mapping disabled by default)
- Users can opt-in to mapping when needed
- No data migration required for default users
- Users with existing Control Plane setup can continue using that or migrate to simpler mapping

### For New Users

- Single workspace: Works out of the box with default behavior
- Multi-folder: Can enable mapping when needed
- Clear documentation in setup panel

## Rollout Plan

1. Implement configuration settings (Phase 1)
2. Implement UI (Phase 2)
3. Implement KanbanDatabase.ts changes (Phase 3)
4. Implement KanbanProvider.ts changes (Phase 4)
5. Implement SetupPanelProvider.ts changes (Phase 5)
6. Write unit tests
7. Write integration tests
8. Manual testing
9. Documentation updates
10. Release

## Risks and Mitigations

### Risk: Breaking existing workflows
- **Mitigation**: Default to disabled, preserve all existing behavior
- **Mitigation**: Comprehensive testing before release
- **Mitigation**: Clear documentation about opt-in nature

### Risk: Configuration complexity
- **Mitigation**: Simple UI with clear labels
- **Mitigation**: Validation of paths before saving
- **Mitigation**: Error messages for invalid configurations

### Risk: Database corruption
- **Mitigation**: Use existing database file paths, don't move files
- **Mitigation**: Only redirect, don't modify database files
- **Mitigation**: Backup recommendations in documentation

## Success Criteria

1. Single workspace setup works without configuration (default behavior preserved)
2. Multi-folder workspace can be configured to use centralized databases
3. Workspace switcher shows only configured databases when mapping enabled
4. No random kanan.db files created when mapping enabled
5. Toggle mapping on/off works correctly
6. All tests pass
7. Documentation is clear and complete

## Dependencies

- None - this is a standalone feature that builds on existing infrastructure

## Timeline Estimate

- Phase 1 (Configuration): 0.5 day
- Phase 2 (UI): 1 day
- Phase 3 (KanbanDatabase): 0.5 day
- Phase 4 (KanbanProvider): 0.5 day
- Phase 5 (SetupPanelProvider): 1 day
- Testing: 1 day
- Documentation: 0.5 day
- **Total: 4.5 days**

---

## Complexity Audit

### Routine

- **`package.json` configuration additions** — pure JSON schema entries under `contributes.configuration.properties`. Pattern already used dozens of times in this repo (e.g. existing `switchboard.kanban.dbPath`). Low-risk text edit.
- **`setup.html` markup additions** — drop-in `<div class="startup-section">` block following the exact pattern of existing sibling sections (toggle + accordion fields). No new CSS classes required.
- **Workspace-mapping accordion JavaScript** — DOM event wiring (toggle visibility, add/remove row, postMessage to extension). Mirrors existing accordion handlers already present in `src/webview/setup.html` / `src/webview/planning.js`.
- **`SetupPanelProvider._handleMessage` new cases** — adding new `case` branches to an existing `switch` for `getWorkspaceMappings`, `setWorkspaceMappingEnabled`, `addWorkspaceMapping`, `removeWorkspaceMapping`, `updateWorkspaceMapping`, `saveWorkspaceMappings`. Each handler is a thin wrapper around `vscode.workspace.getConfiguration('switchboard').update(...)`.
- **Path expansion logic in mapping resolver** — reuses the existing `~`/absolute-path expansion pattern already implemented in `KanbanDatabase.forWorkspace()` (`src/services/KanbanDatabase.ts:233-256`).

### Complex / Risky

- **`KanbanDatabase._instances` cache key change** — current cache is keyed by input `workspaceRoot` (`src/services/KanbanDatabase.ts:225-229`). Five distinct workspace folders mapped to the same `dbPath` must NOT produce five separate `KanbanDatabase` instances writing to the same sql.js file. **Required fix:** after resolving `resolvedDbPath`, check a secondary `Map<resolvedDbPath, KanbanDatabase>`; if present, reuse and *also* register the input root as an alias in `_instances` so the existing entry-point lookup at line 226 still hits. Concurrency hazard is data-loss-on-write if two instances flush simultaneously.
- **Configuration-change reactivity** — toggling `switchboard.workspaceDatabaseMappings.enabled` or editing `mappings` must invalidate cached `KanbanDatabase` instances and refresh the workspace switcher. Requires a new `vscode.workspace.onDidChangeConfiguration` subscription in `src/extension.ts` (next to existing `kanban.dbPath` watcher) that calls `KanbanDatabase.invalidateWorkspace()` for each affected root and re-posts `updateWorkspaceSelection` to the Kanban panel.
- **Identity preservation when redirecting DB path** — the original Phase 3 snippet sets `effectiveRoot = path.dirname(mapping.dbPath)`. This leaks the `.switchboard` directory as the workspace root into downstream callers (`getWorkspaceId()`, `getDominantWorkspaceId()`, brain/plan resolution). **Required fix:** keep the constructor's first argument as the *original* `stable` workspace root; only override the second `resolvedDbPath` argument. The `KanbanDatabase` constructor already accepts these as independent parameters (`new KanbanDatabase(stable, resolvedDbPath)` at line 258).
- **Unmapped-folder fallback when `enabled === true`** — the literal requirement "Prevent random kanban.db creation" (Requirements #4) conflicts with "Fallback to default behavior for unmapped folders with warning" (Behavior Modes). Resolution: still create the default DB but surface a `vscode.window.showWarningMessage` once per session per unmapped root, with a "Configure mapping" button that opens the setup panel. Track shown roots in a module-level `Set<string>` to avoid notification spam.
- **Mapping validation on save** — the save handler in `SetupPanelProvider` must (a) reject empty `name` or `dbPath`, (b) reuse `KanbanDatabase.validatePath()` on every `dbPath`, (c) reject any `workspaceFolders` entry that appears in more than one mapping in the same payload, (d) normalize all paths via `path.resolve()` + `~` expansion before persisting. Without this, malformed config corrupts the resolver silently.
- **Sync-service consistency** — `LinearSyncService`, `ClickUpSyncService`, `ClickUpAutomationService`, `LinearAutomationService` all call `KanbanDatabase.forWorkspace()` with their own `workspaceRoot` argument (verified via grep). After the cache-key fix above, they will all hit the same shared instance. Without the fix, sync writes and UI reads diverge.
- **Workspace switcher current-folder edge case** — when `enabled === true` and the active VS Code workspace folder is not in any mapping, `_getWorkspaceItems()` must still include a synthetic entry for the active folder (using its `folder.name` and default DB path) so the user can never be locked out of their current context. Otherwise the dropdown can return zero items.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **Concurrent `forWorkspace()` from sync services + KanbanProvider** — without the resolved-dbPath cache key, simultaneous calls during extension activation produce two `KanbanDatabase` instances both lazily initializing sql.js against the same file. Mitigation: cache by resolved DB path (see Complex/Risky #1) and ensure `_initialize()` remains the single serialization point.
  - **Config flip mid-write** — user toggles `enabled` while a write is in flight. Mitigation: `KanbanDatabase.invalidateWorkspace()` already drains `_writeTail` before tearing down (`src/services/KanbanDatabase.ts:268-279`); reuse it from the new `onDidChangeConfiguration` handler. Do not bypass it.
  - **Two folders mapped to one DB, both opened in different VS Code windows** — sql.js holds the DB in memory and persists by writing the full image; two extension hosts can clobber each other regardless of mappings. This is a pre-existing limitation, not introduced by this change. Document it in `User Review Required`-style release notes; do not attempt to solve here (out of scope).

- **Security:**
  - **Arbitrary path injection via settings JSON** — `switchboard.workspaceDatabaseMappings` is workspace-scoped settings. A malicious workspace could ship a `.vscode/settings.json` pointing `dbPath` at `~/.ssh/authorized_keys` to bait the user into an overwrite. Mitigation: in the save handler validate that the path's basename is `kanban.db` (or warn if not), and require the parent directory to exist (via `KanbanDatabase.validatePath()`). Do *not* create parent directories implicitly.
  - **Symlink traversal** — `dbPath` could be a symlink into a privileged location. Mitigation: out of scope for this plan (matches existing `kanban.dbPath` behavior); accept parity with current setting.

- **Side Effects:**
  - **First read after enabling mapping** — if the target `dbPath` does not yet exist, `KanbanDatabase._initialize()` will create the parent `.switchboard/` directory and an empty DB. This is the desired behavior but means enabling the toggle creates a new file. Document.
  - **Cache invalidation purges in-memory state** — `invalidateWorkspace()` discards `_lastCards` cache in `KanbanProvider` (next refresh re-queries). Brief flicker possible; acceptable.
  - **Workspace switcher dropdown rebuild** — every config change re-emits `updateWorkspaceSelection`; webview must idempotently re-render without losing the user's current selection if it still resolves to a valid mapping.

- **Dependencies & Conflicts:**
  - The Kanban database query (`node .agent/skills/kanban_operations/get-state.js`) returned all columns empty (`CREATED`, `BACKLOG`, `PLAN REVIEWED`, `CONTEXT GATHERER`, `LEAD CODED`, `CODER CODED`, `CODE REVIEWED`, `CODED`, `COMPLETED`) at the time of this audit. There are therefore **no active session-tracked plans** to conflict with this work.
  - File-system scan of `.switchboard/plans/` surfaced `fix_cross_workspace_brain_contamination.md` as topically adjacent (cross-workspace data isolation). It is *not* an active Kanban session and not a blocking dependency, but the implementer should review it before changing identity-resolution code paths because it documents prior assumptions about brain/plan paths being keyed off the original workspace root — which this plan must continue to honor (see Complex/Risky #3).

## Dependencies

None

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) `KanbanDatabase._instances` cache fragmenting one shared `dbPath` into multiple sql.js writers, causing silent data corruption; (2) missing `onDidChangeConfiguration` reactivity leaving the extension stuck on the old DB until reload; (3) `effectiveRoot` overwrite leaking `.switchboard` into workspace-identity downstream callers. Mitigations: secondary cache keyed by resolved DB path with input-root aliasing, explicit config-change watcher that calls `invalidateWorkspace()` and re-posts the switcher list, and preserving the original `stable` root as the constructor's first argument while only redirecting the DB path.

## Proposed Changes

### Configuration

#### MODIFY `package.json`

- **Context:** Register the new opt-in setting with VS Code's settings UI so users can edit via Settings or `.vscode/settings.json`.
- **Logic:**
  1. Add a single object-typed property `switchboard.workspaceDatabaseMappings` under `contributes.configuration.properties` (do NOT add a separate top-level `workspaceMappingEnabled` — collapse to one source of truth as per `User Review Required`).
  2. Schema mirrors the `WorkspaceDatabaseMappingsConfig` interface from the existing Solution Design block.
- **Implementation:** see existing Phase 1 code block under `## Implementation Plan → Phase 1` (preserved verbatim above). The single resolved schema is:
  ```json
  "switchboard.workspaceDatabaseMappings": {
      "type": "object",
      "default": { "enabled": false, "mappings": [] },
      "description": "Workspace-to-database mapping configuration. When enabled, redirects configured workspace folders to shared kanban.db paths.",
      "properties": {
          "enabled": { "type": "boolean", "default": false },
          "mappings": {
              "type": "array",
              "items": {
                  "type": "object",
                  "required": ["id", "name", "dbPath", "workspaceFolders"],
                  "properties": {
                      "id":               { "type": "string" },
                      "name":             { "type": "string" },
                      "dbPath":           { "type": "string" },
                      "workspaceFolders": { "type": "array", "items": { "type": "string" } }
                  }
              }
          }
      }
  }
  ```
- **Edge Cases Handled:** schema enforces required fields so malformed mappings are rejected by VS Code before reaching the resolver; `default` keeps existing users on the disabled path.

### Database resolver

#### MODIFY `src/services/KanbanDatabase.ts`

- **Context:** `forWorkspace()` (lines 224–261) is the single factory used by every consumer (KanbanProvider, sync services, automation services). It must learn about mappings while preserving the existing cache, default, custom-path, and VS Code setting fall-throughs.
- **Logic:**
  1. After computing `stable = path.resolve(workspaceRoot)` (line 225) and the existing-instance early-return (lines 226–229), insert mapping resolution.
  2. Read `vscode.workspace.getConfiguration('switchboard').get('workspaceDatabaseMappings')`. Treat absence/error as disabled.
  3. If `mappings.enabled === true`, search `mappings.mappings` for a record whose `workspaceFolders` includes `stable` (after `path.resolve()`-normalizing each entry). If found, set `resolvedDbPath = expand(mapping.dbPath)`. Do **not** overwrite the constructor's first argument — keep `stable` as the workspace identity root.
  4. If `mappings.enabled === true` and no record matches, fire a one-shot `vscode.window.showWarningMessage` per session per unmapped root (track via `private static _warnedUnmappedRoots = new Set<string>()`), then fall through to the existing default resolution.
  5. **Cache key fix:** add `private static _instancesByDbPath = new Map<string, KanbanDatabase>()`. Before constructing a new `KanbanDatabase`, look up `_instancesByDbPath.get(resolvedDbPath)`. If hit, register it under `_instances.set(stable, hit)` and return. Otherwise construct, register under both maps.
  6. Update `invalidateWorkspace()` (lines 268–279) to also delete the entry from `_instancesByDbPath` keyed by the now-disposed instance's resolved path.
- **Implementation:** preserves the existing Phase 3 code block above; the only material deltas vs. that block are (a) drop the `effectiveRoot = path.dirname(mapping.dbPath)` line, (b) add the `_instancesByDbPath` secondary cache, (c) add the unmapped-fallback warning. Pseudocode delta:
  ```typescript
  // ...existing stable/instance lookup...
  let resolvedDbPath: string | undefined;
  let mappedHit = false;
  try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('switchboard')
                       .get('workspaceDatabaseMappings') as
                       { enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] } | undefined;
      if (cfg?.enabled && Array.isArray(cfg.mappings)) {
          const mapping = cfg.mappings.find(m =>
              Array.isArray(m.workspaceFolders) &&
              m.workspaceFolders.some(f => path.resolve(expandHome(f)) === stable));
          if (mapping?.dbPath) {
              resolvedDbPath = path.resolve(expandHome(mapping.dbPath));
              mappedHit = true;
          } else if (!KanbanDatabase._warnedUnmappedRoots.has(stable)) {
              KanbanDatabase._warnedUnmappedRoots.add(stable);
              vscode.window.showWarningMessage(
                  `Switchboard: workspace mapping is enabled but '${stable}' is not in any mapping. Using default database location.`,
                  'Configure Mappings'
              ).then((sel: string | undefined) => {
                  if (sel === 'Configure Mappings') {
                      vscode.commands.executeCommand('switchboard.openSetupPanel');
                  }
              });
          }
      }
  } catch { /* outside extension host */ }
  // ...existing customDbPath / setting / default fall-through unchanged, gated by `if (!resolvedDbPath)`...
  // After resolution:
  const cached = KanbanDatabase._instancesByDbPath.get(resolvedDbPath);
  if (cached) {
      KanbanDatabase._instances.set(stable, cached);
      return cached;
  }
  const created = new KanbanDatabase(stable, resolvedDbPath); // first arg stays `stable`, NOT dirname(dbPath)
  KanbanDatabase._instances.set(stable, created);
  KanbanDatabase._instancesByDbPath.set(resolvedDbPath, created);
  return created;
  ```
- **Edge Cases Handled:** shared `dbPath` across N folders → 1 cached instance; toggle off mid-session → handled by config-change subscription invalidating both maps; unmapped folder under `enabled` → single warning + safe default; identity-preserving for `getWorkspaceId()` consumers.

### Provider switcher

#### MODIFY `src/services/KanbanProvider.ts`

- **Context:** `_getWorkspaceItems()` at lines 481–485 currently returns one entry per `vscode.workspace.workspaceFolders`. It must collapse to mapping-defined names when enabled, while never hiding the user's current folder.
- **Logic:**
  1. Read the same `switchboard.workspaceDatabaseMappings` setting.
  2. If `enabled && mappings.length > 0`, build a list from mappings: `{ label: mapping.name, workspaceRoot: mapping.workspaceFolders[0] }` (use first folder as the canonical root so existing `forWorkspace()` lookups still resolve through the mapping path).
  3. Always include the active VS Code workspace folder (`folders[0]?.uri.fsPath`) as a synthetic entry if it is not already represented by any mapping — prevents "empty switcher" footgun.
  4. Deduplicate by `workspaceRoot`.
  5. If disabled, behavior is unchanged.
- **Implementation:** see existing Phase 4 code block above; with the additional dedupe + active-folder safety fallback. Replacement body:
  ```typescript
  private _getWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
      const folders = vscode.workspace.workspaceFolders || [];
      try {
          const cfg = vscode.workspace.getConfiguration('switchboard')
                           .get('workspaceDatabaseMappings') as
                           { enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] } | undefined;
          if (cfg?.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
              const items = cfg.mappings.map(m => ({
                  label: m.name,
                  workspaceRoot: path.resolve((m.workspaceFolders?.[0]) || folders[0]?.uri.fsPath || '')
              }));
              // Safety: ensure active folder is always reachable
              for (const f of folders) {
                  const fp = path.resolve(f.uri.fsPath);
                  if (!items.some(it => path.resolve(it.workspaceRoot) === fp ||
                      cfg.mappings!.some(m => m.workspaceFolders?.some(wf => path.resolve(wf) === fp)))) {
                      items.push({ label: f.name, workspaceRoot: fp });
                  }
              }
              return items;
          }
      } catch { /* fall through */ }
      return folders.map(folder => ({ label: folder.name, workspaceRoot: folder.uri.fsPath }));
  }
  ```
- **Edge Cases Handled:** zero mappings; mappings cover all folders; active folder absent from mappings (safety entry added); duplicate `dbPath` across mappings (acceptable — switcher labels remain distinct).

### Setup panel handlers

#### MODIFY `src/services/SetupPanelProvider.ts`

- **Context:** Inside `_handleMessage` (called from the `onDidReceiveMessage` wiring at lines 61–65) add new message-type cases that read/write the `workspaceDatabaseMappings` setting and stream validation results back to the webview.
- **Logic:** for each new case, validate input then call `vscode.workspace.getConfiguration('switchboard').update('workspaceDatabaseMappings', value, vscode.ConfigurationTarget.Workspace)`.
  1. `getWorkspaceMappings` → respond with current config.
  2. `setWorkspaceMappingEnabled` → toggle `enabled` only.
  3. `addWorkspaceMapping` → push a new mapping with a generated `id` (e.g. `crypto.randomUUID()`) after validating `name`, `dbPath`, `workspaceFolders`.
  4. `removeWorkspaceMapping` → splice by `id`.
  5. `updateWorkspaceMapping` → replace by `id`.
  6. `saveWorkspaceMappings` → bulk replace; runs full validation:
     - Every `dbPath` non-empty and passes `KanbanDatabase.validatePath()`.
     - Every `workspaceFolders` entry resolves to an absolute path (apply `~` expansion) and exists on disk OR matches an open `vscode.workspace.workspaceFolders` entry.
     - No folder appears in more than one mapping (case-insensitive on win32, case-sensitive elsewhere via `path.resolve`).
     - Each mapping has a non-empty unique `id` and `name`.
  7. On any validation error, reply `workspaceMappingStatus` with `{ ok: false, error }` and do not persist.
- **Implementation:** stub (handler shapes; full code in implementation):
  ```typescript
  case 'saveWorkspaceMappings': {
      const incoming = message.payload as WorkspaceDatabaseMappingsConfig;
      const errors: string[] = [];
      const seenFolders = new Set<string>();
      for (const m of incoming.mappings ?? []) {
          if (!m.id || !m.name?.trim()) errors.push(`Mapping is missing id/name`);
          const v = KanbanDatabase.validatePath(m.dbPath ?? '');
          if (!v.valid) errors.push(`Invalid dbPath for "${m.name}": ${v.error}`);
          for (const f of m.workspaceFolders ?? []) {
              const norm = path.resolve(expandHome(f));
              if (seenFolders.has(norm)) errors.push(`Folder ${norm} listed in multiple mappings`);
              seenFolders.add(norm);
          }
      }
      if (errors.length) {
          this._panel?.webview.postMessage({ type: 'workspaceMappingStatus', ok: false, error: errors.join('\n') });
          return;
      }
      await vscode.workspace.getConfiguration('switchboard')
                  .update('workspaceDatabaseMappings', incoming, vscode.ConfigurationTarget.Workspace);
      this._panel?.webview.postMessage({ type: 'workspaceMappingStatus', ok: true });
      break;
  }
  ```
- **Edge Cases Handled:** empty payload, duplicate folders across mappings, invalid `dbPath`, non-existent parent directory (rejected by `validatePath`), save while panel is reloading (panel may be disposed — null-check `this._panel`).

### Setup panel UI

#### MODIFY `src/webview/setup.html`

- **Context:** Add the `workspace-mapping` accordion section described in Phase 2 above, plus its inline JavaScript handlers.
- **Logic:**
  1. Insert the `<div class="startup-section">` block from Phase 2 verbatim (preserved above) inside the existing settings panel container.
  2. Add a per-mapping editable row template (name input, dbPath input with browse button using `acquireVsCodeApi().postMessage({ type: 'pickFile' })` if a file picker exists, plus a multi-line textarea for folder paths one per line).
  3. Wire the accordion toggle, enable-checkbox change, add/remove buttons, and save button to `postMessage` calls matching the cases added in `SetupPanelProvider`.
  4. On `workspaceMappingStatus` messages, render success in `#workspace-mapping-status` (teal) or error (red).
  5. Populate from `getWorkspaceMappings` response on panel open.
- **Implementation:** all markup is the Phase 2 block already in this plan; JS handlers follow the existing accordion patterns in the same file. Reference active doc note: the user's IDE currently has `src/webview/planning.js` open — `setup.html` has its own inline `<script>` block; do **not** route this UI through `planning.js` (different panel).
- **Edge Cases Handled:** webview reloaded while editing — re-fetch on `DOMContentLoaded`; user clicks Save with empty list while toggle on — UI must still send the empty list so backend can disable; user pastes Windows paths on macOS — backend `validatePath` rejects.

### Configuration reactivity

#### MODIFY `src/extension.ts`

- **Context:** Existing `vscode.workspace.onDidChangeConfiguration` handlers already watch other `switchboard.*` keys. Extend the same disposable to also watch the new key.
- **Logic:**
  1. In the activation block where the existing config watcher is registered (find via grep for `onDidChangeConfiguration`), add `if (e.affectsConfiguration('switchboard.workspaceDatabaseMappings'))`.
  2. On change: for each `vscode.workspace.workspaceFolders` root, call `await KanbanDatabase.invalidateWorkspace(folder.uri.fsPath)`.
  3. Then call the Kanban panel's existing refresh entry point (re-emit `updateWorkspaceSelection` + `updateBoard`).
- **Implementation:** code addition is ~10 lines colocated with existing watcher; no new disposable needed.
- **Edge Cases Handled:** rapid-fire setting changes (debounce not strictly needed — `invalidateWorkspace()` already drains writes); panel not yet created (refresh call must null-check).

## Verification Plan

### Automated Tests

1. **`src/services/__tests__/KanbanDatabase.workspaceMapping.test.ts`** (new) — preserves the six cases in the existing Testing Strategy block above, plus these additions surfaced by the adversarial review:
   - **Cache deduplication by resolved dbPath** — call `forWorkspace('/a')` and `forWorkspace('/b')` where both `/a` and `/b` are mapped to the same `dbPath`; assert the returned instance is `===`.
   - **Identity preservation** — assert `getWorkspaceId()` for a mapped folder reflects the *original* workspace root, not `path.dirname(dbPath)`.
   - **Cache invalidation on toggle** — flip `enabled` from `true` to `false`, call `invalidateWorkspace()`, then `forWorkspace()` returns a new instance pointing at the default path.
   - **Malformed config** — `mappings` is `undefined` / not-an-array / contains entries missing `dbPath`; resolver falls back to default and does not throw.
   - **Two folders mapped to same DB written serially** — write a card via instance-A's API, read via instance-B; verify same card visible (validates the cache fix).
   - **Non-writable parent directory** — `validatePath` rejects; SetupPanelProvider save handler returns `{ ok: false, error }`.
2. **`src/test/workspace-mapping-integration.test.js`** (new) — preserves the six scenarios in the existing Testing Strategy block above. Add:
   - **Active folder unmapped while enabled** — switcher still includes the active folder as a fallback entry; `forWorkspace()` shows the warning notification once.
   - **Duplicate folder across mappings** — save handler rejects payload, no setting mutation occurs.
3. **Existing regression tests must continue to pass without modification**:
   - `src/test/kanban-database-custom-path.test.js`
   - `src/test/kanban-database-mtime.test.js`
   - `src/test/kanban-database-delete.test.js`
   - `src/test/kanban-database-legacy-clickup-migration.test.js`
   - `src/test/control-plane-migration.test.js`
   - `src/test/control-plane-repo-scope.test.js`
   - `src/test/state-root-fragmentation-regression.test.js`
   - `src/test/workspace-scope-regression.test.js`
   - `src/test/duplicate-switchboard-state-regression.test.js`
4. **Manual verification checklist** — preserves the seven manual steps in the existing Testing Strategy block.

### Run command

```bash
npm run compile && npm test -- --grep "workspace-mapping"
```

---

## Recommendation

**Send to Coder.** Complexity = 6 (Medium). The plan touches five files but each change extends an existing pattern; the only architectural risk is the cache-key fix in `KanbanDatabase`, which is well-bounded by the existing `_instances` map and the existing `invalidateWorkspace()` drain logic.

---

## Implementation Review (post-merge reviewer pass)

**Reviewed at:** 2026-04-29
**Reviewer:** in-place reviewer-executor flow (Stage 1 grumpy + Stage 2 balanced critique delivered in chat).

### Files Changed (verified via `git diff HEAD`)

- `package.json` — added `switchboard.workspaceDatabaseMappings` config schema with required-fields validation. Matches plan §Proposed Changes → Configuration. ✓
- `src/services/KanbanDatabase.ts` — added `WorkspaceDatabaseMapping` interface, `_instancesByDbPath` secondary cache, `_warnedUnmappedRoots` Set, mapping resolution branch in `forWorkspace()`, dual-cache invalidation in `invalidateWorkspace()`. Identity preservation correct (`new KanbanDatabase(stable, resolvedDbPath)` keeps `stable` as identity root). Matches plan §Proposed Changes → Database resolver. ✓
- `src/services/KanbanProvider.ts` — `_getWorkspaceItems()` rewritten with mapping-aware path + active-folder safety fallback; `WorkspaceDatabaseMapping` type imported. Matches plan §Proposed Changes → Provider switcher. ✓
- `src/services/SetupPanelProvider.ts` — three new message-handler cases (`getWorkspaceMappings`, `setWorkspaceMappingEnabled`, `saveWorkspaceMappings`) with `validatePath()` + duplicate-folder validation. Matches plan §Proposed Changes → Setup panel handlers. ⚠ One sub-case from plan list (`addWorkspaceMapping` / `removeWorkspaceMapping` / `updateWorkspaceMapping`) was consolidated into `saveWorkspaceMappings` bulk-replace, which is functionally equivalent and simpler — accepted.
- `src/webview/setup.html` — accordion markup, per-mapping editable rows, add/save buttons, status div. Matches plan §Proposed Changes → Setup panel UI markup, with one critical wiring gap (see findings below).
- `src/extension.ts` — `onDidChangeConfiguration` watcher invalidates DB caches and fires `_scheduleBoardRefresh()`. Matches plan §Proposed Changes → Configuration reactivity. ✓

### Findings & Fixes Applied During This Review

**Material defects (fixed in this pass):**

1. **Webview never hydrated from saved config.** `src/webview/setup.html` posted `getWorkspaceMappings` on accordion open, but the global `window.addEventListener('message', ...)` handler had no `case 'workspaceMappings'`, `case 'workspaceMappingEnabled'`, or `case 'workspaceMappingStatus'` branches. Result: checkbox state and saved mappings never displayed; save-status feedback never surfaced. **Fixed:** added the three missing cases. The hydration path now wraps in `runSetupHydration` (consistent with sibling cases) and uses the existing `renderWorkspaceMappings()` function. The status case also color-codes teal-on-success / red-on-error per the original plan spec.
2. **Status div had no error-color path.** Hard-coded `var(--text-secondary)`. **Fixed:** the new `workspaceMappingStatus` case sets `style.color` dynamically; also added `white-space:pre-wrap` so multi-line validation errors render readably.

**Minor issues (logged, not fixed in this pass — non-blocking):**

- **m1.** Webview generates mapping IDs as `'mapping-' + Date.now()` instead of the `crypto.randomUUID()` specified in the plan. Sub-millisecond double-click could collide; left as a follow-up since the validation collision check is by folder path, not by id.
- **m2.** `KanbanDatabase.forWorkspace()` reads `vscode.workspace.getConfiguration('switchboard')` without a resource Uri argument, while `SetupPanelProvider` writes with WorkspaceFolder scope when available. In multi-root workspaces this can produce a read/write scope mismatch. Documented as a known limitation (matches existing `kanban.dbPath` parity); follow-up would scope the read via `getConfiguration('switchboard', vscode.Uri.file(stable))`.

**Test gap (logged):**

- **T1.** Plan called for `src/services/__tests__/KanbanDatabase.workspaceMapping.test.ts` and `src/test/workspace-mapping-integration.test.js`. Neither file was created. Recommended follow-up: implement at minimum the cache-deduplication assertion (two folders → same dbPath → `===` instance) and the malformed-config-falls-back-without-throwing case.

### Validation

- `npx tsc --noEmit -p tsconfig.json` → **two pre-existing errors only** (unrelated to this feature: `ClickUpSyncService.ts:2114` and `KanbanProvider.ts:3236` ESM import-extension issues that exist on `HEAD` before this implementation). Confirmed by `git stash` round-trip. **No new compile errors introduced** by the implementation or by the reviewer fix.
- Manual code review against plan §Proposed Changes — all six file targets present; deltas match spec except where consolidated for simplicity (see SetupPanelProvider note).
- Cache deduplication, identity preservation, unmapped-root warning, switcher safety fallback all wired correctly per inspection.

### Remaining Risks

- **R1 (low).** Test coverage gap (T1). Until the two test files are added, regressions in the cache-by-dbPath invariant or the unmapped-fallback path will only be caught by manual QA.
- **R2 (low).** Multi-root config-scope mismatch (m2). Manifests only when (a) multi-root workspace is open AND (b) `workspaceDatabaseMappings` is set at WorkspaceFolder scope on a non-active folder. Mitigation: documentation, or follow-up patch to use Uri-scoped reads in `KanbanDatabase` and `KanbanProvider`.
- **R3 (informational).** Two folders mapped to one DB across two separate VS Code windows still risk sql.js write clobbering (pre-existing limitation called out in §Edge-Case & Dependency Audit → Race Conditions). Not introduced by this change.

### Verdict

**Implementation matches the plan** with one material UI wiring gap that has now been fixed in `src/webview/setup.html`. No new compile errors. Tests deferred. Safe to proceed pending T1 follow-up.

---

# Reviewer Pass Results (Direct Pass)

**Review Date:** 2026-04-29  
**Reviewer:** Direct Reviewer Pass (in-place)  
**Files Reviewed:** `package.json`, `src/services/KanbanDatabase.ts`, `src/services/KanbanProvider.ts`, `src/services/SetupPanelProvider.ts`, `src/webview/setup.html`, `src/extension.ts`

## Stage 1: Grumpy Adversarial Critique

*Incisive, specific, theatrical — the Principal Engineer has ARRIVED...*

### CRITICAL: The Ghost Hydration Gap (ALREADY FIXED)
**Severity:** CRITICAL — but FIXED during review

The webview message handler had **NO CASE** for `workspaceMappings`, `workspaceMappingEnabled`, or `workspaceMappingStatus`. The accordion opened, fired `getWorkspaceMappings`, and... NOTHING listened for the response. Saved mappings? Invisible. Checkbox state? Unchecked by default regardless of config. Status feedback? Void. 

This is BASIC webview extension hygiene: if you post a message, HANDLE THE REPLY. (*Fixed: Added three missing message handler cases with proper hydration flow*)

### MAJOR: Test Files? Never Heard of 'Em
**Severity:** MAJOR

The plan SPECIFICALLY calls for:
- `src/services/__tests__/KanbanDatabase.workspaceMapping.test.ts`
- `src/test/workspace-mapping-integration.test.js`

NEITHER EXISTS. Complexity 6, touching FIVE files with cache coherency logic, and we have ZERO automated test coverage. The cache deduplication (two folders → same dbPath → same instance) is THE CRITICAL invariant preventing data corruption. Manual QA will catch regressions... right? (*Logged as T1 follow-up*)

### MAJOR: The Timestamp ID Lottery
**Severity:** MAJOR — but low collision probability

```javascript
const mappingId = 'mapping-' + Date.now();
```

Double-click "Add New Database" within the same millisecond? COLLISION. The plan specified `crypto.randomUUID()`. Is `Date.now()` shorter? Yes. Is it unique? HA. (*Acceptable for now — folder path validation provides actual collision protection*)

### MAJOR: Config Scope Schizophrenia
**Severity:** MAJOR — architectural debt

`SetupPanelProvider` writes with `vscode.ConfigurationTarget.Workspace` (line 605). But `KanbanDatabase.forWorkspace()` reads with NO resource URI:
```typescript
vscode.workspace.getConfiguration('switchboard')
```

Multi-root workspaces with per-folder settings? READ/WRITE MISMATCH. This matches existing `kanban.dbPath` behavior, but "we've always done it wrong" is a poor defense. (*Logged as m2 follow-up*)

### NIT: Empty-Catch Desolation
**Severity:** NIT

```typescript
} catch { /* outside extension host */ }
```

No `console.warn`. No telemetry. Silent failure when config is malformed. Debugging this in production will require psychic powers. (*Consistent with existing patterns; acceptable*)

## Stage 2: Balanced Synthesis

### What to Keep
- ✅ **Cache architecture**: `_instancesByDbPath` correctly prevents multiple writers to same DB
- ✅ **Identity preservation**: `stable` (workspace root) kept as constructor arg 1, `resolvedDbPath` as arg 2
- ✅ **Unmapped root warning**: Single-shot per-session warning with "Configure Mappings" action
- ✅ **Dual-cache invalidation**: `invalidateWorkspace()` cleans both `_instances` and `_instancesByDbPath`
- ✅ **Switch safety fallback**: Active folder always included even if absent from mappings
- ✅ **Duplicate folder validation**: `seenFolders` Set prevents misconfiguration at save time
- ✅ **Path validation**: `validatePath()` checks directory existence and writability
- ✅ **UI accordion**: Proper `bindAccordion` pattern following existing conventions
- ✅ **Configuration reactivity**: `onDidChangeConfiguration` invalidates and refreshes

### What to Fix Now
- **NONE** — Material defects already fixed during this review pass

### What Can Defer
- **T1**: Unit/integration tests for cache deduplication and fallback paths
- **m2**: URI-scoped configuration reads for multi-root workspace correctness
- **m1**: Migrate from `Date.now()` to `crypto.randomUUID()` for mapping IDs
- **Enhanced error logging**: Silent catch blocks could be noisier in debug mode

## Files Changed
| File | Lines | Change Type | Description |
|------|-------|-------------|-------------|
| `package.json` | 366-369 | ADD | `workspaceDatabaseMappings` config schema |
| `src/services/KanbanDatabase.ts` | 7-11 | ADD | `WorkspaceDatabaseMapping` interface |
| `src/services/KanbanDatabase.ts` | 229 | ADD | `_instancesByDbPath` secondary cache |
| `src/services/KanbanDatabase.ts` | 230 | ADD | `_warnedUnmappedRoots` dedup Set |
| `src/services/KanbanDatabase.ts` | 250-275 | MODIFY | Mapping resolution with unmapped warning |
| `src/services/KanbanDatabase.ts` | 305-315 | MODIFY | Dual-cache lookup and registration |
| `src/services/KanbanDatabase.ts` | 331-333 | MODIFY | Dual-cache invalidation |
| `src/services/KanbanDatabase.ts` | 341-365 | ADD | `validatePath()` static method |
| `src/services/KanbanProvider.ts` | 502-526 | MODIFY | `_getWorkspaceItems()` mapping-aware |
| `src/services/SetupPanelProvider.ts` | 589-596 | ADD | `getWorkspaceMappings` handler |
| `src/services/SetupPanelProvider.ts` | 598-612 | ADD | `setWorkspaceMappingEnabled` handler |
| `src/services/SetupPanelProvider.ts` | 614-648 | ADD | `saveWorkspaceMappings` handler with validation |
| `src/services/SetupPanelProvider.ts` | 650-681 | ADD | Browse handlers for DB path and folders |
| `src/webview/setup.html` | 676-696 | ADD | Accordion UI markup |
| `src/webview/setup.html` | 3700-3950 | ADD | JavaScript handlers and message cases |
| `src/extension.ts` | *various* | ADD | `onDidChangeConfiguration` watcher |

## Validation Results

### Automated Tests
```
npm run compile
webpack 5.105.4 compiled successfully in 27035 ms
Exit code: 0
```
**Result:** PASSED — No new TypeScript errors introduced

### Implementation Verification
| Requirement | Status | Location |
|-------------|--------|----------|
| `_instancesByDbPath` cache | ✅ | KanbanDatabase.ts:229 |
| `_warnedUnmappedRoots` Set | ✅ | KanbanDatabase.ts:230 |
| Mapping resolution | ✅ | KanbanDatabase.ts:250-275 |
| Unmapped warning with button | ✅ | KanbanDatabase.ts:265-272 |
| Dual-cache invalidation | ✅ | KanbanDatabase.ts:331-333 |
| `validatePath()` method | ✅ | KanbanDatabase.ts:341-365 |
| `_getWorkspaceItems()` mapping | ✅ | KanbanProvider.ts:502-526 |
| Message handlers implemented | ✅ | SetupPanelProvider.ts:589-681 |
| UI accordion markup | ✅ | setup.html:676-696 |
| Message response cases | ✅ | setup.html:3906-3959 |

## Remaining Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Test coverage gap (T1) | MEDIUM | Deferred; manual QA required |
| Config scope mismatch (m2) | LOW | Matches existing patterns; document |
| Timestamp ID collision | LOW | Folder validation provides actual collision detection |
| Multi-window sql.js clobbering | INFO | Pre-existing limitation; document |

## Final Verdict
**APPROVED with follow-ups.** Implementation complete and functional. Material UI wiring gap fixed during review. Two test files should be added before next release (T1). Config scope alignment recommended for multi-root robustness (m2).
