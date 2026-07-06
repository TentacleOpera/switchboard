# Global Override 02: Scope-Aware Settings Read/Write Layer

## Metadata

**Complexity:** 7
**Tags:** backend, refactor, feature
**Project:** switchboard

## Goal

### Problem

All settings reads and writes in `KanbanProvider` go through flat methods (`_getSetting` / `_updateSetting`) that have no concept of scope. They check `globalState` first, then the workspace `config` table. There is no way to read or write a project-scoped setting, and no way to make workspace config take precedence over globalState.

### Background

`KanbanProvider._getSetting<T>(key, defaultValue)` (line 471) checks `globalState` → workspace `config` table → default. `_updateSetting<T>(key, value)` (line 500) writes to `globalState` + mirrors to workspace `config` table. ~15 direct message handlers (`toggleCliTriggers`, `updateRoutingConfig`, `saveKanbanColumn`, etc.) call these methods. `_reloadSettingsFromStore()` (line 516) also uses `_getSetting`.

### Root Cause

The read/write methods are scope-unaware. They need to be replaced with scope-aware variants that resolve based on the override switch states and active project filter.

### Desired Outcome

New `_getScopedSetting` / `_updateScopedSetting` methods that resolve reads and writes based on the override tier. All existing handlers routed through them. This is the backbone that makes every tab setting scope-aware.

**Depends on:** Plan 01 (project_config storage layer must exist).

## Implementation

### 1. Override state fields — `KanbanProvider.ts`

Add fields:
- `_workspaceOverrideEnabled: boolean` (default `false`)
- `_projectOverrideEnabled: boolean` (default `false`)

Load these in the constructor and `_reloadSettingsFromStore` from the workspace `config` table:
```typescript
this._workspaceOverrideEnabled = this._getSetting<boolean>('kanban.workspaceOverrideEnabled', false);
this._projectOverrideEnabled = this._getSetting<boolean>('kanban.projectOverrideEnabled', false);
```
(These two keys use the existing flat `_getSetting` since they are the control, not the data.)

### 2. Scope-aware read — `_getScopedSetting<T>(key, defaultValue)`

Resolution order:

```
1. If _projectOverrideEnabled AND _projectFilter is a specific project (not null, not __unassigned__):
     → check project_config(project, key) via db.getProjectConfigJsonSync
     → if found, return it
2. If _workspaceOverrideEnabled:
     → check workspace config table via db.getConfigJsonSync
     → if found, return it
3. Check globalState (existing _getSetting globalState check)
4. If neither override is ON:
     → check workspace config table (legacy fallback, current behavior)
5. Return defaultValue
```

Key insight: when both overrides are OFF, the order is `globalState → workspace config` (today's behavior). When workspace override is ON, workspace config takes precedence over globalState. When project override is ON, project_config takes precedence over everything.

### 3. Scope-aware write — `_updateScopedSetting<T>(key, value)`

Write target:

```
- If _projectOverrideEnabled AND _projectFilter is a specific project:
    → write to project_config(project, key) ONLY via db.setProjectConfigJson
    → do NOT write to globalState or workspace config
- Else if _workspaceOverrideEnabled:
    → write to workspace config table ONLY via db.setConfigJson
    → do NOT write to globalState
- Else (both OFF):
    → write to globalState + mirror to workspace config (current _updateSetting behavior)
```

### 4. Route all existing handlers through scoped methods

Replace every `_getSetting` / `_updateSetting` call with `_getScopedSetting` / `_updateScopedSetting` for scope-aware keys. Affected locations:

| Location | Setting Key(s) | Current Method |
|---------|---------------|---------------|
| Constructor / `_reloadSettingsFromStore` (lines 377-392, 517-527) | `kanban.cliTriggersEnabled`, `kanban.dynamicComplexityRoutingEnabled`, `kanban.columnDragDropModes`, `kanban.routingMapConfig`, `kanban.allowUnknownComplexityAutoMove`, `kanban.orderOverrides` | `_getSetting` → `_getScopedSetting` |
| `toggleCliTriggers` (line 6882) | `kanban.cliTriggersEnabled` | `_updateSetting` → `_updateScopedSetting` |
| `toggleDynamicComplexityRouting` (line 6909) | `kanban.dynamicComplexityRoutingEnabled` | same |
| `toggleAllowUnknownComplexityAutoMove` (line 6921) | `kanban.allowUnknownComplexityAutoMove` | same |
| `toggleClearTerminalBeforePrompt` (line 6933) | `kanban.clearTerminalBeforePrompt` | same |
| `updateClearTerminalBeforePromptDelay` | `kanban.clearTerminalBeforePromptDelay` | same |
| `updateRoutingConfig` (line 6970) | `kanban.routingMapConfig` | same |
| `setColumnDragDropMode` (line 6975) | `kanban.columnDragDropModes` | same |
| `setPairProgrammingMode` (line 6528) | `kanban.pairProgrammingMode` | same |
| `setFeatureWorkflowMode` (line 6887) | `kanban.featureWorkflowMode` | same |
| `saveKanbanColumn` / `updateKanbanStructure` / `toggleKanbanColumnVisibility` (lines 8527-8566) | kanban column structure keys | same |
| `saveAutoArchiveConfig` (line 8522) | `autoArchive.*` keys | same |
| `setAutomationMode` / `updateAutobanConfig` / `toggleAutoban` / `toggleAutobanPause` (lines 6458-6528) | automation keys | same |
| Order override saves (lines 622, 5207-5208, 5239-5240) | `kanban.orderOverrides`, `kanban.columnDragDropModes` | same |

**Exception:** `selectedRole` stays workspace-scoped (ephemeral UI state, already handled specially in the `saveSetting` handler).

### 5. Generic `saveSetting` / `getSetting` handler updates (lines 8347-8381)

The generic handler currently routes to `_updateSetting` / `_getSetting`. Update it:
- `saveSetting`: use `_updateScopedSetting` for non-roleConfig keys. For `roleConfig_*` keys, route through the scope-aware role config path (plan 05 handles this in detail; for now, role configs continue through TaskViewerProvider but the underlying `updateSetting` call in TaskViewerProvider should be updated in plan 05).
- `getSetting`: use `_getScopedSetting` for non-roleConfig keys.
- `selectedRole` stays as-is (workspaceState).

### 6. Config epoch invalidation

When override state changes or project filter changes, the `_configEpoch` (used in snapshot keys for board refresh) must be incremented so the board re-reads settings. Add a bump in the `setWorkspaceOverride` / `setProjectOverride` handlers (plan 03) and in `setProjectFilter`.

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanProvider.ts` | New `_workspaceOverrideEnabled`/`_projectOverrideEnabled` fields, `_getScopedSetting`/`_updateScopedSetting` methods, replace all `_getSetting`/`_updateSetting` calls for scope-aware keys, update generic `saveSetting`/`getSetting` handler |

## Test Plan

- [ ] Both overrides OFF: `_getScopedSetting` returns same values as old `_getSetting` (no regression)
- [ ] Both overrides OFF: `_updateScopedSetting` writes to globalState + workspace config (same as old `_updateSetting`)
- [ ] Workspace ON: read checks workspace config before globalState
- [ ] Workspace ON: write goes to workspace config only, globalState untouched
- [ ] Project ON (specific project): read checks project_config first
- [ ] Project ON: write goes to project_config only
- [ ] Project ON + Workspace ON: project_config takes precedence on read
- [ ] Switching project filter: subsequent scoped reads use the new project's project_config
- [ ] All existing toggle/update handlers work correctly in all three scope states
- [ ] `_reloadSettingsFromStore` loads from the correct scope
