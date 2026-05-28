# Fix: Lock Agent Names to Terminals (Kanban & Sidebar)

## Goal

Fix both the kanban board and sidebar implementation.html to display agent names derived from actual running terminals instead of workspace configuration, so that switching workspaces does not cause the displayed agent names to change while terminals remain running.

## Metadata

- **Tags:** [bugfix, frontend, backend]
- **Complexity:** 2

## Problem Description

The existing fix for `fix_agent_names_locked_to_terminals.md` added a terminal cache and modified `_getAgentNames()` to use it, but the fix is broken because `_registeredTerminals` is cleared on workspace switch. This causes `getActualTerminalAgentNames()` to return an empty map, making the terminal cache ineffective.

When switching workspaces via the kanban workspace picker:
1. KanbanProvider calls `clearRegisteredTerminalsMap()` on workspace switch (line 4196)
2. This clears `_registeredTerminals` in TaskViewerProvider
3. `getActualTerminalAgentNames()` checks `if (!this._registeredTerminals) return result;` (line 468)
4. Since `_registeredTerminals` is empty, it returns an empty map
5. The kanban board falls back to workspace configuration, showing wrong agent names
6. The sidebar also shows wrong agent names because it uses workspace-derived `lastStartupCommands`

**Example scenario:**
1. Start a lead coder terminal with gemini in workspace A
2. Switch to workspace B where lead coder is configured as claude
3. Both kanban and sidebar show "CLAUDE CLI" even though the terminal is still running gemini

## Root Cause Analysis

The `getActualTerminalAgentNames()` method in TaskViewerProvider requires `_registeredTerminals` to iterate over terminals and look up their cached agent info:

```typescript
// TaskViewerProvider.ts line 465-488
public getActualTerminalAgentNames(): Record<string, string> {
    const result: Record<string, string> = {};

    if (!this._registeredTerminals) return result;  // ← Returns empty if cleared

    for (const [name, terminal] of this._registeredTerminals.entries()) {
        // Skip exited terminals
        if (terminal.exitStatus !== undefined) {
            this._terminalAgentInfo.delete(name);
            continue;
        }

        const info = this._terminalAgentInfo.get(name);
        if (!info) continue;

        if (!(info.role in result)) {
            result[info.role] = info.displayName;
        }
    }

    return result;
}
```

However, KanbanProvider clears `_registeredTerminals` on workspace switch:

```typescript
// KanbanProvider.ts line 4191-4196
if (prevWorkspaceRoot !== this._currentWorkspaceRoot) {
    this._taskViewerProvider?.clearRegisteredTerminalsMap();
}
```

This is incorrect because:
- The terminals are still running and valid
- `_registeredTerminals` is a dispatch map, not workspace-specific state
- Clearing it breaks the ability to look up terminal agent info
- The `_terminalAgentInfo` cache is preserved but becomes inaccessible

## Files Affected

- `src/services/KanbanProvider.ts` - Remove incorrect `clearRegisteredTerminalsMap()` call on workspace switch
- `src/services/TaskViewerProvider.ts` - Make `getActualTerminalAgentNames()` work without `_registeredTerminals`, send terminal-derived names to sidebar
- `src/webview/implementation.html` - Use terminal-derived agent names instead of workspace-derived

## Proposed Solution

### Step 1: Remove incorrect `clearRegisteredTerminalsMap()` call

In KanbanProvider.ts, remove the call to `clearRegisteredTerminalsMap()` on workspace switch. The `_registeredTerminals` map is a dispatch map for sending commands to terminals, not workspace-specific state. Clearing it breaks agent name lookup:

```typescript
// In KanbanProvider.ts, around line 4191-4196
// BEFORE:
if (prevWorkspaceRoot !== this._currentWorkspaceRoot) {
    this._taskViewerProvider?.clearRegisteredTerminalsMap();
}

// AFTER: Remove this block entirely
// The _registeredTerminals map should persist across workspace switches
// because terminals are still running and valid
```

### Step 2: Make `getActualTerminalAgentNames()` work without `_registeredTerminals`

The current implementation requires `_registeredTerminals` to iterate over terminals. However, we can iterate directly over the `_terminalAgentInfo` cache and check if terminals are still alive using `vscode.window.terminals`:

```typescript
// In TaskViewerProvider.ts, replace getActualTerminalAgentNames() (lines 465-488)
public getActualTerminalAgentNames(): Record<string, string> {
    const result: Record<string, string> = {};

    // Get all currently open VS Code terminals
    const allTerminals = vscode.window.terminals;
    const terminalNames = new Set(allTerminals.map(t => t.name));

    // Iterate over cached agent info and check if terminal is still open
    for (const [name, info] of this._terminalAgentInfo.entries()) {
        // Skip if terminal is no longer open
        if (!terminalNames.has(name)) {
            this._terminalAgentInfo.delete(name);
            continue;
        }

        // First alive terminal per role wins (deterministic: Map iteration order)
        if (!(info.role in result)) {
            result[info.role] = info.displayName;
        }
    }

    return result;
}
```

This approach:
- Doesn't require `_registeredTerminals` to be populated
- Works correctly even if `_registeredTerminals` is cleared
- Still prunes stale cache entries for closed terminals
- Is workspace-agnostic by design

### Step 3: Send terminal-derived agent names to sidebar

In TaskViewerProvider.ts, modify the `_postSidebarConfigurationState` method to send terminal-derived agent names:

```typescript
// In TaskViewerProvider.ts, around line 3337-3342
const startupState = await this.handleGetStartupCommands(workspaceRoot);
this._view.webview.postMessage({ type: 'startupCommands', ...startupState });

// NEW: Send terminal-derived agent names
const terminalAgentNames = this.getActualTerminalAgentNames();
this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });
```

Also send terminal agent names when workspace changes:

```typescript
// In TaskViewerProvider.ts, around line 3338-3342 (inside handleWorkspaceChanged)
if (resolvedRoot) {
    this._view.webview.postMessage({ type: 'workspaceChanged', workspaceRoot: resolvedRoot });
}

const startupState = await this.handleGetStartupCommands(workspaceRoot);
this._view.webview.postMessage({ type: 'startupCommands', ...startupState });

// NEW: Send terminal-derived agent names on workspace switch
const terminalAgentNames = this.getActualTerminalAgentNames();
this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });
```

### Step 4: Update implementation.html to use terminal-derived names

In implementation.html, add a variable to store terminal-derived agent names and update the display logic:

```javascript
// In implementation.html, around line 2291 (near lastStartupCommands)
let lastStartupCommands = {};
let lastTerminalAgentNames = {}; // NEW

// In the message handler, add case for terminalAgentNames (around line 3003)
case 'commands':
    lastStartupCommands = message.commands;
    break;
case 'terminalAgentNames': // NEW
    lastTerminalAgentNames = message.agentNames || {};
    break;
```

Update the agent name display logic to prioritize terminal-derived names:

```javascript
// In implementation.html, around line 4806-4808 (in the agent row rendering)
if (roleId !== 'jules') {
    // Prioritize terminal-derived names (locked to actual terminals)
    if (lastTerminalAgentNames[roleId]) {
        name.innerText = `${label} - ${lastTerminalAgentNames[roleId]}`;
    } else if (lastStartupCommands[roleId]) {
        // Fallback to workspace configuration
        const cmd = lastStartupCommands[roleId].trim().split(/\s+/)[0].toUpperCase();
        name.innerText = `${label} - ${cmd} CLI`;
    } else {
        name.innerText = label;
    }
} else {
    name.innerText = label;
}
```

Also update the analyst agent display (around line 5515-5517):

```javascript
// Update analyst display
if (lastTerminalAgentNames['analyst']) {
    name.innerText = `ANALYST - ${lastTerminalAgentNames['analyst']}`;
} else if (lastStartupCommands['analyst']) {
    const cmd = lastStartupCommands['analyst'].trim().split(/\s+/)[0].toUpperCase();
    name.innerText = `ANALYST - ${cmd} CLI`;
} else {
    name.innerText = 'ANALYST';
}
```

### Step 5: Send terminal agent names on terminal state changes

In TaskViewerProvider.ts, send updated terminal agent names when terminals are created or closed:

```typescript
// In TaskViewerProvider.ts, around line 435 (setTerminalAgentInfo)
public setTerminalAgentInfo(suffixedName: string, role: string, displayName: string): void {
    this._terminalAgentInfo.set(suffixedName, { role, displayName });
    // NEW: Notify sidebar of updated terminal agent names
    this._notifyTerminalAgentNamesChanged();
}

// In TaskViewerProvider.ts, around line 438 (clearTerminalAgentInfo)
public clearTerminalAgentInfo(suffixedName: string): void {
    this._terminalAgentInfo.delete(suffixedName);
    // NEW: Notify sidebar of updated terminal agent names
    this._notifyTerminalAgentNamesChanged();
}

// Add new helper method
private _notifyTerminalAgentNamesChanged(): void {
    if (this._view) {
        const terminalAgentNames = this.getActualTerminalAgentNames();
        this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });
    }
}
```

## Testing Strategy

1. **Manual test scenario**:
   - Open workspace A with lead coder configured as gemini
   - Start a lead coder terminal
   - Verify kanban shows "GEMINI CLI" in column header
   - Verify sidebar shows "LEAD CODER - GEMINI CLI"
   - Switch to workspace B where lead coder is configured as claude
   - Verify kanban still shows "GEMINI CLI"
   - Verify sidebar still shows "LEAD CODER - GEMINI CLI"
   - Close the terminal
   - Verify kanban shows "CLAUDE CLI" (fallback to workspace config)
   - Verify sidebar shows "LEAD CODER - CLAUDE CLI"

2. **Regression tests**:
   - Ensure kanban agent display still works when no terminals are running
   - Ensure sidebar agent display still works when no terminals are running
   - Ensure workspace switching doesn't break other functionality
   - Ensure terminal creation updates agent names correctly
   - Ensure terminal closure updates agent names correctly

## Risks and Considerations

1. **Terminal dispatch map persistence**: Not clearing `_registeredTerminals` on workspace switch means the dispatch map persists. This is correct behavior because terminals are still running and valid.
2. **Message ordering**: Terminal agent names might arrive after startup commands on initial load — mitigated by prioritizing terminal names in display logic
3. **Race conditions**: Workspace switch during terminal creation could cause temporary inconsistency — mitigated by fallback to workspace config
4. **Backward compatibility**: If the sidebar doesn't receive terminal agent names (old extension version), it falls back to workspace config — no regression

## Success Criteria

- Kanban board agent names are locked to the terminals that created them
- Sidebar agent names are locked to the terminals that created them
- Switching workspaces does not change displayed terminal names in either kanban or sidebar
- Kanban and sidebar show consistent agent names
- Fallback to workspace configuration works when no terminals are running
- Terminal creation/closure updates agent names correctly in both kanban and sidebar

## Verification Plan

### Manual Tests
- Workspace switch does not change kanban agent names for running terminals
- Workspace switch does not change sidebar agent names for running terminals
- Kanban and sidebar show consistent agent names
- Terminal closure causes both kanban and sidebar to fall back to workspace config
- Terminal creation causes both kanban and sidebar to update to terminal-derived name

### Automated Tests
- Unit test: `getActualTerminalAgentNames()` works without `_registeredTerminals`
- Unit test: `getActualTerminalAgentNames()` prunes stale entries for closed terminals
- Unit test: terminal agent names are sent to sidebar on terminal creation
- Unit test: terminal agent names are sent to sidebar on terminal closure
- Unit test: sidebar prioritizes terminal-derived names over workspace config
- Integration test: workspace switch does not change kanban agent names
- Integration test: workspace switch does not change sidebar agent names
