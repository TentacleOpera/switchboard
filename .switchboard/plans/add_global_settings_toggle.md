# Add Global Settings Toggle

## Goal

Add a toggle in setup.html workspace tab that enables global settings (persist across workspace switches). This toggle should be on by default to prevent user confusion about settings disappearing when switching workspaces.

## Metadata

**Tags:** ux, settings, persistence
**Complexity:** 5

## Problem

All user settings are currently workspace-scoped and reset when switching workspaces via the kanban dropdown. This is confusing because users expect their customizations (role prompts, routing configs, etc.) to persist across workspaces.

**Current workspace-scoped settings:**
- kanban.cliTriggersEnabled
- kanban.dynamicComplexityRoutingEnabled
- kanban.columnDragDropModes
- kanban.routingMapConfig
- kanban.allowUnknownComplexityAutoMove
- kanban.orderOverrides
- kanban.controlPlaneRoot
- switchboard.prompts.roleConfig_* (planner, coder, lead, reviewer, tester, intern, analyst)

**File-based settings (intentionally workspace-specific, not changing):**
- state.customAgents
- state.customKanbanColumns
- state.visibleAgents
- state.startupCommands

## Solution

Add a "Global Settings" toggle in setup.html workspace tab. When enabled, settings are stored in globalState instead of workspaceState, making them persist across workspace switches. Default to ON.

## Proposed Changes

### src/webview/setup.html

#### [ADD] Global settings toggle in workspace tab

Add a toggle in the workspace configuration tab:

```html
<div class="setup-option-group">
    <label class="setup-toggle-wrapper">
        <input type="checkbox" id="global-settings-toggle" checked>
        <span class="toggle-slider"></span>
    </label>
    <div style="display:flex; flex-direction:column; gap:4px; margin-left: 12px;">
        <span class="setup-label-text">Global Settings</span>
        <span class="setup-label-desc">Persist settings across workspace switches. When disabled, settings are workspace-specific.</span>
    </div>
</div>
```

Add event listener:
```javascript
const globalSettingsToggle = document.getElementById('global-settings-toggle');
globalSettingsToggle.addEventListener('change', () => {
    const enabled = globalSettingsToggle.checked;
    postSetupMessage({ type: 'setGlobalSettingsEnabled', enabled });
});
```

Add initialization to load current state:
```javascript
postSetupMessage({ type: 'getGlobalSettingsEnabled' });
```

Add message handler:
```javascript
case 'globalSettingsEnabled':
    globalSettingsToggle.checked = message.enabled;
    break;
```

---

### src/services/SetupPanelProvider.ts

#### [ADD] Global settings enabled storage

Store the toggle state in globalState (this setting itself should always be global):

```typescript
private _globalSettingsEnabled: boolean = true; // Default to ON

// In constructor
this._globalSettingsEnabled = this._context.globalState.get<boolean>('switchboard.globalSettingsEnabled', true);

// Add message handler
case 'setGlobalSettingsEnabled': {
    this._globalSettingsEnabled = data.enabled;
    await this._context.globalState.update('switchboard.globalSettingsEnabled', data.enabled);
    break;
}
case 'getGlobalSettingsEnabled': {
    this._view?.webview.postMessage({
        type: 'globalSettingsEnabled',
        enabled: this._globalSettingsEnabled
    });
    break;
}
```

#### [ADD] Helper methods for settings storage

Add helper methods that route to globalState or workspaceState based on the toggle:

```typescript
private async _getSetting<T>(key: string, defaultValue: T): Promise<T> {
    if (this._globalSettingsEnabled) {
        return this._context.globalState.get<T>(key, defaultValue);
    }
    // For workspace-scoped settings, we need the current workspace root
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) return defaultValue;
    return this._context.workspaceState.get<T>(key, defaultValue);
}

private async _setSetting<T>(key: string, value: T): Promise<void> {
    if (this._globalSettingsEnabled) {
        await this._context.globalState.update(key, value);
    } else {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        await this._context.workspaceState.update(key, value);
    }
}
```

---

### src/services/KanbanProvider.ts

#### [MODIFY] Settings storage to use globalState when enabled

Replace direct workspaceState access with conditional logic based on global settings flag.

First, add reference to SetupPanelProvider to check the flag:

```typescript
private _setupPanelProvider?: SetupPanelProvider;

public setSetupPanelProvider(provider: SetupPanelProvider): void {
    this._setupPanelProvider = provider;
}
```

Then modify settings reads/writes. Example for kanban settings:

```typescript
// Old:
this._cliTriggersEnabled = this._context.workspaceState.get<boolean>('kanban.cliTriggersEnabled', true);

// New:
private _isGlobalSettingsEnabled(): boolean {
    return this._setupPanelProvider?._globalSettingsEnabled ?? true;
}

private async _getSetting<T>(key: string, defaultValue: T): Promise<T> {
    if (this._isGlobalSettingsEnabled()) {
        return this._context.globalState.get<T>(key, defaultValue);
    }
    return this._context.workspaceState.get<T>(key, defaultValue);
}

private async _setSetting<T>(key: string, value: T): Promise<void> {
    if (this._isGlobalSettingsEnabled()) {
        await this._context.globalState.update(key, value);
    } else {
        await this._context.workspaceState.update(key, value);
    }
}

// Usage:
this._cliTriggersEnabled = await this._getSetting<boolean>('kanban.cliTriggersEnabled', true);
```

Apply this pattern to all kanban settings:
- kanban.cliTriggersEnabled
- kanban.dynamicComplexityRoutingEnabled
- kanban.columnDragDropModes
- kanban.routingMapConfig
- kanban.allowUnknownComplexityAutoMove
- kanban.orderOverrides
- kanban.controlPlaneRoot

---

### src/services/TaskViewerProvider.ts

#### [MODIFY] Role config storage to use globalState when enabled

Apply the same pattern for role config settings:

```typescript
// Add reference to SetupPanelProvider
private _setupPanelProvider?: SetupPanelProvider;

public setSetupPanelProvider(provider: SetupPanelProvider): void {
    this._setupPanelProvider = provider;
}

private _isGlobalSettingsEnabled(): boolean {
    return this._setupPanelProvider?._globalSettingsEnabled ?? true;
}

// Modify role config reads (lines 5392, 5429-5434, 13040-13086)
const plannerConfig = this._isGlobalSettingsEnabled()
    ? this._context.globalState.get<any>('switchboard.prompts.roleConfig_planner')
    : this._context.workspaceState.get<any>('switchboard.prompts.roleConfig_planner');
```

Apply to all roleConfig_* settings:
- switchboard.prompts.roleConfig_planner
- switchboard.prompts.roleConfig_coder
- switchboard.prompts.roleConfig_lead
- switchboard.prompts.roleConfig_reviewer
- switchboard.prompts.roleConfig_tester
- switchboard.prompts.roleConfig_intern
- switchboard.prompts.roleConfig_analyst

Also modify the saveSetting/getSetting message handlers to use conditional storage.

---

### Migration Logic

#### [ADD] Migration on toggle enable/disable

When the user toggles global settings, migrate settings between workspaceState and globalState:

```typescript
case 'setGlobalSettingsEnabled': {
    const wasEnabled = this._globalSettingsEnabled;
    this._globalSettingsEnabled = data.enabled;
    await this._context.globalState.update('switchboard.globalSettingsEnabled', data.enabled);
    
    // If enabling for the first time, migrate workspaceState to globalState
    if (!wasEnabled && data.enabled) {
        await this._migrateWorkspaceStateToGlobal();
    }
    
    // If disabling, migrate globalState to current workspace's workspaceState
    if (wasEnabled && !data.enabled) {
        await this._migrateGlobalStateToWorkspace();
    }
    break;
}

private async _migrateWorkspaceStateToGlobal(): Promise<void> {
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) return;
    
    const keysToMigrate = [
        'kanban.cliTriggersEnabled',
        'kanban.dynamicComplexityRoutingEnabled',
        'kanban.columnDragDropModes',
        'kanban.routingMapConfig',
        'kanban.allowUnknownComplexityAutoMove',
        'kanban.orderOverrides',
        'kanban.controlPlaneRoot',
        'switchboard.prompts.roleConfig_planner',
        'switchboard.prompts.roleConfig_coder',
        'switchboard.prompts.roleConfig_lead',
        'switchboard.prompts.roleConfig_reviewer',
        'switchboard.prompts.roleConfig_tester',
        'switchboard.prompts.roleConfig_intern',
        'switchboard.prompts.roleConfig_analyst'
    ];
    
    for (const key of keysToMigrate) {
        const value = this._context.workspaceState.get(key);
        if (value !== undefined) {
            await this._context.globalState.update(key, value);
            // Optionally: clear workspaceState after successful migration
            // await this._context.workspaceState.update(key, undefined);
        }
    }
}

private async _migrateGlobalStateToWorkspace(): Promise<void> {
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) return;
    
    const keysToMigrate = [
        'kanban.cliTriggersEnabled',
        'kanban.dynamicComplexityRoutingEnabled',
        'kanban.columnDragDropModes',
        'kanban.routingMapConfig',
        'kanban.allowUnknownComplexityAutoMove',
        'kanban.orderOverrides',
        'kanban.controlPlaneRoot',
        'switchboard.prompts.roleConfig_planner',
        'switchboard.prompts.roleConfig_coder',
        'switchboard.prompts.roleConfig_lead',
        'switchboard.prompts.roleConfig_reviewer',
        'switchboard.prompts.roleConfig_tester',
        'switchboard.prompts.roleConfig_intern',
        'switchboard.prompts.roleConfig_analyst'
    ];
    
    for (const key of keysToMigrate) {
        const value = this._context.globalState.get(key);
        if (value !== undefined) {
            await this._context.workspaceState.update(key, value);
            // Optionally: clear globalState after successful migration
            // await this._context.globalState.update(key, undefined);
        }
    }
}
```

---

## Verification Plan

### Manual Tests

1. **Enable global settings (default state)**
   - Open setup.html workspace tab
   - Verify "Global Settings" toggle is checked (default ON)
   - Configure a custom role prompt in kanban
   - Switch workspace
   - Switch back
   - Verify role prompt persists

2. **Disable global settings**
   - Uncheck "Global Settings" toggle
   - Configure different settings in different workspaces
   - Switch between workspaces
   - Verify settings are now workspace-specific (different per workspace)

3. **Re-enable global settings**
   - Check "Global Settings" toggle
   - Verify migration happens (settings from current workspace become global)
   - Verify settings now persist across workspace switches

4. **Migration test**
   - Start with global settings disabled
   - Configure settings in workspace A
   - Enable global settings
   - Verify workspace A's settings are now global
   - Verify they persist when switching to workspace B

### Regression Testing

- Kanban functionality still works with both global and workspace-scoped settings
- Role config customization still works in both modes
- Routing config still works in both modes
- No breaking changes to existing functionality

## Files to Modify

- `src/webview/setup.html` - add global settings toggle
- `src/services/SetupPanelProvider.ts` - add toggle storage and helper methods
- `src/services/KanbanProvider.ts` - use conditional storage for kanban settings
- `src/services/TaskViewerProvider.ts` - use conditional storage for role configs

## Migration Notes

- Default to ON to prevent user confusion
- Migration only happens when enabling for the first time (workspaceState → globalState)
- No data loss - settings are preserved during migration
- File-based settings (state.json) remain workspace-specific by design
