# Global Override 05: Role Config Scope Awareness

## Metadata

**Complexity:** 5
**Tags:** backend, refactor, feature
**Project:** switchboard

## Goal

### Problem

Role configs (`switchboard.prompts.roleConfig_*`) — the Prompts tab and Agents tab settings — flow through `TaskViewerProvider`, not `KanbanProvider`. They have their own read/write path (`TaskViewerProvider.saveRoleConfig` / `getRoleConfig`) that goes to `globalState` + workspace config mirror. This path is completely separate from the scope-aware layer being built in plans 02-04, so role configs would NOT be scope-aware unless explicitly integrated.

### Background

`TaskViewerProvider.saveRoleConfig(key, value)` (line 630) calls `updateSetting` which writes to `globalState` + mirrors to workspace `config` table. `getRoleConfig(key)` (line 649) calls `getSetting` which reads from `globalState` only. The `KanbanProvider` `saveSetting`/`getSetting` message handler (lines 8347-8381) routes `roleConfig_*` keys to `TaskViewerProvider.saveRoleConfig` / `getRoleConfig`.

Role configs are also read by the prompt-building pipeline (`_getRoleConfig` in KanbanProvider line 493, and direct `getSetting` calls in TaskViewerProvider at lines 7989, 16315-16353, 16726) to assemble the prompts sent to CLI agents.

### Root Cause

The role config read/write path bypasses the scope-aware layer entirely. It needs to be routed through the scoped resolution so that project-scoped and workspace-scoped role configs work.

### Desired Outcome

Role configs are fully scope-aware: a project can have its own `roleConfig_coder`, `roleConfig_lead`, etc. that override the workspace and global role configs. The prompt-building pipeline uses the scoped values.

**Depends on:** Plan 01 (project_config table), Plan 02 (scope-aware layer pattern).

## Implementation

### 1. Scope-aware role config read — `KanbanProvider.ts`

Add a method that resolves role configs through the scope tiers:

```typescript
private _getScopedRoleConfig(role: string): any {
    const key = `switchboard.prompts.roleConfig_${role}`;

    // 1. Project tier
    if (this._projectOverrideEnabled && this._projectFilter && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        const projectVal = db.getProjectConfigJsonSync<any>(this._projectFilter, key, undefined);
        if (projectVal !== undefined) return projectVal;
    }

    // 2. Workspace tier (if workspace override ON)
    if (this._workspaceOverrideEnabled) {
        const wsVal = db.getConfigJsonSync<any>(key, undefined);
        if (wsVal !== undefined) return wsVal;
    }

    // 3. Global (existing behavior via TaskViewerProvider)
    return this._taskViewerProvider?.getRoleConfig(`roleConfig_${role}`) ?? undefined;
}
```

### 2. Scope-aware role config write — `KanbanProvider.ts`

```typescript
private async _updateScopedRoleConfig(role: string, value: unknown): Promise<void> {
    const key = `switchboard.prompts.roleConfig_${role}`;

    if (this._projectOverrideEnabled && this._projectFilter && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        // Write to project_config only
        const db = KanbanDatabase.forWorkspace(root);
        await db.setProjectConfigJson(this._projectFilter, key, value);
    } else if (this._workspaceOverrideEnabled) {
        // Write to workspace config only
        const db = KanbanDatabase.forWorkspace(root);
        await db.setConfigJson(key, value);
    } else {
        // Both OFF: existing behavior (globalState + workspace mirror)
        await this._taskViewerProvider?.saveRoleConfig(`roleConfig_${role}`, value);
    }

    // Invalidate prompt override cache
    this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
}
```

### 3. Update `saveSetting` / `getSetting` handler — `KanbanProvider.ts` (lines 8347-8381)

In the generic `saveSetting` handler, for `roleConfig_*` keys:
- Replace `this._taskViewerProvider.saveRoleConfig(key, value)` with `this._updateScopedRoleConfig(roleName, value)`

In the generic `getSetting` handler, for `roleConfig_*` keys:
- Replace `this._taskViewerProvider.getRoleConfig(key)` with `this._getScopedRoleConfig(roleName)`

### 4. Update prompt-building pipeline — `KanbanProvider.ts`

The existing `_getRoleConfig(role)` method (line 493) currently delegates to `TaskViewerProvider.getRoleConfig`. Update it to use `_getScopedRoleConfig`:

```typescript
private _getRoleConfig(role: string): any {
    return this._getScopedRoleConfig(role);
}
```

Also update the direct `getSetting` calls in `TaskViewerProvider` (lines 7989, 16315-16353, 16726) that read role configs during prompt assembly. These need to resolve through the scoped layer. Options:
- **Option A (preferred):** Route these through `KanbanProvider._getScopedRoleConfig` (requires KanbanProvider reference in TaskViewerProvider, or passing the resolved config down)
- **Option B:** Duplicate the scope resolution logic in TaskViewerProvider (requires passing override flags + project filter to TaskViewerProvider)

**Recommendation:** Option A. The prompt-building entry points in KanbanProvider should resolve role configs via the scoped method before passing them to TaskViewerProvider's prompt assembly, OR TaskViewerProvider should accept a "role config resolver" function.

### 5. Role config in snapshot — coordinate with plan 04

The snapshot mechanism (plan 04) must include role config keys. The `SCOPE_AWARE_KEYS` registry in plan 04 should discover role config keys dynamically:

```typescript
// Discover role config keys from globalState
const roleConfigKeys = this._context.globalState.keys()
    .filter(k => k.startsWith('switchboard.prompts.roleConfig_'));
// Also check workspace config table for any role config keys
```

The snapshot write for role configs:
- Workspace target: `db.setConfigJson(key, value)` (already mirrored, but ensure all keys present)
- Project target: `db.setProjectConfigJson(project, key, value)`

### 6. Export/import — `TaskViewerProvider.ts`

`exportPromptSettings()` (line 653) iterates `globalState` and `workspaceState` keys. Update it to also include:
- Project-scoped role configs from `project_config` (when project override is active)
- Workspace-scoped role configs from `config` table (when workspace override is active)

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanProvider.ts` | `_getScopedRoleConfig` / `_updateScopedRoleConfig` methods, update `_getRoleConfig` to use scoped variant, update `saveSetting`/`getSetting` handler for roleConfig keys, update prompt-building calls |
| `src/services/TaskViewerProvider.ts` | Update direct role config reads in prompt assembly to use scoped resolution (via callback or KanbanProvider reference), update `exportPromptSettings` to include scoped configs |

## Test Plan

- [ ] Both overrides OFF: role config read/write works as today (globalState + mirror)
- [ ] Workspace ON: changing a role config in Prompts tab writes to workspace config only
- [ ] Workspace ON: reading a role config checks workspace config before globalState
- [ ] Project ON: changing a role config writes to project_config only
- [ ] Project ON: reading checks project_config → workspace config → globalState
- [ ] Prompt preview reflects scoped role config values
- [ ] Dispatching a prompt to a CLI agent uses the scoped role config
- [ ] Export includes scoped role configs
- [ ] Snapshot (plan 04) copies role configs to the scoped store on first toggle
- [ ] Switching projects: role configs reload from the new project's scope
