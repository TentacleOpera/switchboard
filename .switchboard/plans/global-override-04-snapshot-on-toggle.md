# Global Override 04: Snapshot-on-Toggle Mechanism

## Metadata

**Complexity:** 5
**Tags:** backend, feature, ux
**Project:** switchboard

## Goal

### Problem

When a user turns ON a scope override switch for the first time, the scoped store (workspace config or project_config) may be empty for some keys. Without a snapshot, the board would suddenly show default/empty values instead of the user's current configuration — a jarring experience.

### Background

Today's settings live in `globalState` and the workspace `config` table (mirrored). When workspace override is ON, reads check workspace config first. When project override is ON, reads check `project_config` first. If the scoped store is empty for a key, the read falls through to the next tier — so the board might look fine initially. But the first time the user changes a setting, it writes to the scoped store, and other unchanged settings might appear to "reset" if they were coming from a higher tier that's now shadowed.

### Root Cause

No copy mechanism exists to populate the scoped store from the current effective values on first toggle.

### Desired Outcome

When a user turns ON a switch and the scoped store is empty (or missing keys), the current effective values for all known settings are copied into that scoped store. The board looks identical before and after the toggle. Subsequent changes write to the scoped store.

**Depends on:** Plan 01 (project_config table), Plan 02 (scope-aware layer), Plan 03 (toggle handlers).

## Implementation

### 1. Known settings key registry — `KanbanProvider.ts`

Define a constant array of all scope-aware setting keys:

```typescript
private static readonly SCOPE_AWARE_KEYS: string[] = [
    'kanban.cliTriggersEnabled',
    'kanban.dynamicComplexityRoutingEnabled',
    'kanban.allowUnknownComplexityAutoMove',
    'kanban.clearTerminalBeforePrompt',
    'kanban.clearTerminalBeforePromptDelay',
    'kanban.columnDragDropModes',
    'kanban.routingMapConfig',
    'kanban.orderOverrides',
    'kanban.pairProgrammingMode',
    'kanban.featureWorkflowMode',
    'autoArchive.enabled',
    'autoArchive.triggerColumn',
    'autoArchive.thresholdHours',
    // Automation/autoban keys — enumerate from setAutomationMode/updateAutobanConfig handlers
    // Kanban column structure keys — enumerate from saveKanbanColumn handler
    // Role config keys — handled by plan 05, but include the prefix pattern
];
```

**Note:** This list must be maintained as new scope-aware settings are added. Consider auto-discovering keys from `globalState.keys()` and `config` table rows at snapshot time to catch any missed keys.

### 2. Snapshot method — `KanbanProvider.ts`

```typescript
private async _snapshotSettingsToScope(target: 'workspace' | 'project', project?: string): Promise<void> {
    for (const key of KanbanProvider.SCOPE_AWARE_KEYS) {
        // Read current effective value (using the OLD resolution, before the new scope is active)
        const currentValue = this._getSetting<any>(key, undefined);
        if (currentValue === undefined) continue; // skip keys with no value

        if (target === 'workspace') {
            await db.setConfigJson(key, currentValue);
        } else if (target === 'project' && project) {
            await db.setProjectConfigJson(project, key, currentValue);
        }
    }
    // Also snapshot role config keys (plan 05 coordinates this)
}
```

**Important:** The snapshot must read using the *current* (pre-toggle) resolution, not the new scoped resolution. This means the snapshot should run *before* setting `_workspaceOverrideEnabled` / `_projectOverrideEnabled` to `true`, OR the snapshot method should use the flat `_getSetting` explicitly.

### 3. Workspace override snapshot

In the `setWorkspaceOverride` handler (from plan 03), before activating the override:

```
1. Check if workspace config table already has all SCOPE_AWARE_KEYS
   — if yes, skip snapshot (values already there from existing mirror behavior)
2. If any keys are missing, run _snapshotSettingsToScope('workspace')
3. Then set _workspaceOverrideEnabled = true
```

**Optimization:** Since the existing `_updateSetting` already mirrors to workspace config, most keys will already be present. The snapshot mainly covers keys that only exist in `globalState` and were never written from the kanban board (e.g., settings set via VS Code settings UI or older code paths).

### 4. Project override snapshot

In the `setProjectOverride` handler (from plan 03), before activating the override:

```
1. Check if project_config(project) has any rows
   — if it already has rows, skip snapshot (user previously toggled ON, data is dormant)
2. If empty, run _snapshotSettingsToScope('project', project)
   — reads current effective values (workspace config or globalState) and copies to project_config
3. Then set _projectOverrideEnabled = true
```

### 5. Toggle OFF behavior — no deletion

When a switch is turned OFF:
- **Workspace OFF:** No data deletion. Workspace config rows remain. Reads revert to `globalState → workspace config` fallback order.
- **Project OFF:** No data deletion. `project_config` rows for that project remain dormant. If the user toggles back ON, the snapshot check finds existing rows and skips — previous values are restored.

**Rationale:** Users may toggle OFF temporarily and expect their scoped settings to still be there when they toggle back ON. Deletion would be destructive. A separate "Reset to inherited" action (phase 3) can provide explicit clearing if desired.

### 6. Role config snapshot coordination

Role configs (`switchboard.prompts.roleConfig_*`) need special handling because they go through `TaskViewerProvider`. The snapshot should:
1. Discover all role config keys from `globalState.keys()` (filter for `switchboard.prompts.roleConfig_` prefix)
2. For each, read the current value via `TaskViewerProvider.getRoleConfig`
3. Write to the target scope:
   - Workspace: `db.setConfigJson(key, value)` (already happens via mirror, but ensure completeness)
   - Project: `db.setProjectConfigJson(project, key, value)`

Plan 05 handles the scope-aware role config read/write path; this plan handles the snapshot copy.

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanProvider.ts` | `SCOPE_AWARE_KEYS` registry, `_snapshotSettingsToScope` method, snapshot calls in `setWorkspaceOverride` / `setProjectOverride` handlers, role config key discovery for snapshot |

## Test Plan

- [ ] Toggle Workspace ON for first time (workspace config missing some keys): missing keys copied from globalState, board looks identical
- [ ] Toggle Workspace ON when workspace config already has all keys: no duplicate writes, board looks identical
- [ ] Toggle Project ON for first time (project_config empty): all current effective values copied to project_config, board looks identical
- [ ] Toggle Project ON when project_config already has rows (dormant from previous toggle): snapshot skipped, previous values restored
- [ ] Toggle Project OFF: project_config rows remain (dormant), board reverts to workspace/global resolution
- [ ] Toggle Project OFF then ON: previous project settings restored
- [ ] Change a setting after snapshot: writes go to the scoped store only
- [ ] Role configs are included in the snapshot
