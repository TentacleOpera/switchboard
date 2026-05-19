# Fix: Lock Agent Names to Terminals

## Goal

Lock agent display names in the kanban board to the actual running terminals that created them, so that switching workspaces does not cause the displayed agent names to change to the new workspace's configuration while the original terminal is still running.

## Metadata

- **Tags:** [bugfix, frontend, backend]
- **Complexity:** 5

## User Review Required

- Verify that the binary-derived display name (e.g., "GEMINI CLI") is the desired lock target, not the terminal's VS Code display name (e.g., "Lead Coder").
- Confirm whether the sidebar (implementation.html) should also be fixed to show correct agent names after workspace switches, or if only the kanban board column headers need fixing.

## Complexity Audit

### Routine
- Add `_terminalAgentInfo` cache map to TaskViewerProvider (single field addition)
- Add `setTerminalAgentInfo()` / `clearTerminalAgentInfo()` public methods to TaskViewerProvider
- Add `getActualTerminalAgentNames()` public method to TaskViewerProvider
- Modify `_getAgentNames()` in KanbanProvider to merge terminal-derived names (3 call sites already identified)
- Populate cache in grid creation code (extension.ts ~line 3044)
- Populate cache in autoban terminal creation (TaskViewerProvider.ts ~line 5668)
- Clean up cache entries on terminal disposal (extension.ts deactivation, TaskViewerProvider deregisterAllTerminals)

### Complex / Risky
- **Stale cache entries for exited terminals**: The `_registeredTerminals` map may retain entries with `exitStatus !== undefined`. The `getActualTerminalAgentNames()` method must skip these, and a periodic cleanup or on-demand pruning is needed to prevent unbounded growth.
- **Autoban multiple terminals per role**: Autoban can create "Coder 2", "Coder 3" etc. for the same role. The cache stores per-terminal entries, and `getActualTerminalAgentNames()` must deterministically pick one (first alive terminal found).

## Edge-Case & Dependency Audit

- **Race Conditions**: Workspace switch during terminal creation could cause the cache to not yet have an entry for the new terminal. Mitigated by falling back to workspace configuration (current behavior) — no regression.
- **Security**: No new attack surface. The cache is in-memory only and populated from trusted code paths.
- **Side Effects**: None expected. The cache is additive — existing behavior is preserved as fallback.
- **Dependencies & Conflicts**: No external dependencies. Internal dependency on `_registeredTerminals` map (already shared via `setRegisteredTerminals()`).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The original plan's code referenced a non-existent `_getTerminalState()` method and incorrectly assumed `terminal.name` contains the binary-derived display name — it contains the role label instead. (2) Stale cache entries for exited terminals could cause ghost agent names if not pruned. Mitigations: Use a workspace-agnostic in-memory cache populated at terminal creation time with the correct binary-derived name; prune stale entries by checking `terminal.exitStatus` on each read.

## Problem Description

When switching workspaces via the kanban.html dropdown picker, the agent names in the sidebar implementation.html agents tab switch to reflect the new workspace's agent configuration, but the actual terminal agent names do not update correctly.

**Example scenario:**
1. Start a lead coder terminal with gemini (called "gemini cli")
2. Switch workplaces where lead coder is defined as claude
3. The terminal name suddenly changes to "claude cli" in the sidebar, even though the terminal agent is still running gemini cli
4. The agent names need to be locked to the terminals that created them

## Root Cause Analysis

The issue stems from how agent names are resolved in `KanbanProvider.ts`:

1. **Dynamic agent name lookup**: The `_getAgentNames()` method (lines 2756-2795) reads agent names from the current workspace's `state.json` file every time the board refreshes
2. **Workspace switch trigger**: When `selectWorkspace` message is received (line 3687-3691), the board refreshes and calls `_getAgentNames()` with the new workspace root
3. **Webview update**: The new workspace's agent names are sent via `updateAgentNames` message to the webview (lines 1044, 1751, 1865)
4. **Display mismatch**: The sidebar implementation.html agents tab updates to show the new workspace's agent names, but the actual terminals were created with the OLD workspace's agent configuration
5. **Terminal registry isolation**: The actual terminal names are stored in the `registeredTerminals` map in `extension.ts` and are not affected by workspace switches

**Key insight**: Agent names are being dynamically looked up from workspace state.json rather than being derived from the actual running terminals. This causes a mismatch between displayed names and actual terminal identities when workspaces switch.

**Critical code detail**: The `_getAgentNames()` method derives display names by parsing `startupCommands` from state.json:
```typescript
const binary = cmd.split(/\s+/)[0];
const name = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase();
result[role] = `${name} CLI`;
```
This binary-derived name (e.g., "GEMINI CLI") is NOT stored anywhere else — it's computed on-the-fly each time. The terminal's `.name` property is the role label (e.g., "Lead Coder"), not the binary name. A new cache is needed to persist the correct display name.

## Files Affected

- `src/services/KanbanProvider.ts` - `_getAgentNames()` method and `updateAgentNames` message dispatch
- `src/services/TaskViewerProvider.ts` - Terminal registry management, agent name resolution, and new cache
- `src/extension.ts` - `registeredTerminals` map, grid terminal creation, and terminal disposal

## Proposed Solution

### Approach: Workspace-Agnostic Agent Name Cache (Preferred)

Add a workspace-agnostic in-memory cache to TaskViewerProvider that stores the binary-derived agent display name for each terminal at creation time. When `_getAgentNames()` is called, it prioritizes this cache over workspace configuration for roles with running terminals.

### Implementation Details

**Step 1: Add agent info cache to TaskViewerProvider**

Add a new private field and public methods to `TaskViewerProvider.ts`:

```typescript
// In TaskViewerProvider.ts, add as class field (near line 287):
// Cache: suffixed terminal name → { role, displayName }
// Populated at terminal creation time with the binary-derived display name.
// This survives workspace switches because it's derived from the actual
// running terminal, not from the currently-selected workspace's state.json.
private _terminalAgentInfo = new Map<string, { role: string; displayName: string }>();

// Public method to populate the cache:
public setTerminalAgentInfo(suffixedName: string, role: string, displayName: string): void {
    this._terminalAgentInfo.set(suffixedName, { role, displayName });
}

// Public method to clear a single entry:
public clearTerminalAgentInfo(suffixedName: string): void {
    this._terminalAgentInfo.delete(suffixedName);
}

// Public method to clear all entries:
public clearAllTerminalAgentInfo(): void {
    this._terminalAgentInfo.clear();
}
```

**Step 2: Add `getActualTerminalAgentNames()` to TaskViewerProvider**

```typescript
// In TaskViewerProvider.ts
/**
 * Returns a mapping of role → agent display name for all alive terminals
 * that have cached agent info. This is workspace-agnostic — it reads from
 * the in-memory cache, not from any workspace's state.json.
 */
public getActualTerminalAgentNames(): Record<string, string> {
    const result: Record<string, string> = {};

    if (!this._registeredTerminals) return result;

    for (const [name, terminal] of this._registeredTerminals.entries()) {
        // Skip exited terminals
        if (terminal.exitStatus !== undefined) {
            // Prune stale cache entry
            this._terminalAgentInfo.delete(name);
            continue;
        }

        const info = this._terminalAgentInfo.get(name);
        if (!info) continue;

        // First alive terminal per role wins (deterministic: Map iteration order)
        if (!(info.role in result)) {
            result[info.role] = info.displayName;
        }
    }

    return result;
}
```

**Step 3: Populate cache in grid terminal creation (extension.ts)**

In the grid creation code (extension.ts, around line 3044-3051), after sending the startup command, compute and store the display name:

```typescript
// After the existing startup command send (line ~3044):
for (const agent of agents) {
    let cmd = await taskViewerProvider.getAgentStartupCommand(agent.role, effectiveWorkspaceRoot);
    if (cmd && cmd.trim()) {
        const terminal = registeredTerminals.get(suffixedName(agent.name));
        if (terminal) {
            terminal.sendText(cmd.trim(), true);
            mcpOutputChannel?.appendLine(`[Extension] Sent startup command for '${agent.name}' (${agent.role}): ${cmd.trim()}`);

            // NEW: Cache the binary-derived agent display name
            const binary = cmd.trim().split(/\s+/)[0];
            const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
            taskViewerProvider.setTerminalAgentInfo(suffixedName(agent.name), agent.role, displayName);
        }
    }
}
```

**Step 4: Populate cache in autoban terminal creation (TaskViewerProvider.ts)**

In the autoban terminal creation code (TaskViewerProvider.ts, around line 5694-5699), after sending the startup command:

```typescript
// After the existing startup command send (line ~5698):
const startupCommands = await this.getStartupCommands(workspaceRoot);
const startupCommand = startupCommands[normalizedRole];
if (startupCommand && startupCommand.trim()) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    terminal.sendText(startupCommand.trim(), true);

    // NEW: Cache the binary-derived agent display name
    const binary = startupCommand.trim().split(/\s+/)[0];
    const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
    this._terminalAgentInfo.set(suffixedUniqueName, { role: normalizedRole, displayName });
}
```

**Step 5: Populate cache in terminal registration (TaskViewerProvider.ts)**

In the terminal registration code (TaskViewerProvider.ts, around line 13730-13768), when an existing terminal is found and its role is auto-detected:

```typescript
// After the existing role auto-detection (line ~13762):
if (state.terminals[existingName].role === 'none') {
    // ... existing auto-detection logic ...
    state.terminals[existingName].role = autoRole;
}

// NEW: Cache the agent display name if we can derive it
if (autoRole !== 'none') {
    const startupCommands = await this.getStartupCommands();
    const cmd = startupCommands[autoRole];
    if (cmd && cmd.trim()) {
        const binary = cmd.trim().split(/\s+/)[0];
        const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
        this._terminalAgentInfo.set(existingName, { role: autoRole, displayName });
    }
}
```

**Step 6: Modify `_getAgentNames()` in KanbanProvider.ts**

Refactor `_getAgentNames()` (lines 2756-2797) to prioritize terminal-derived names:

```typescript
private async _getAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
    // First, get actual terminal names from running terminals (workspace-agnostic)
    const terminalAgentNames = this._taskViewerProvider?.getActualTerminalAgentNames() || {};

    // Then get configured agent names from state.json (for roles without running terminals)
    const configuredNames = await this._getConfiguredAgentNames(workspaceRoot);

    // Merge: prioritize terminal names (locked to actual terminals), fall back to configured
    const result: Record<string, string> = { ...configuredNames };
    for (const [role, terminalName] of Object.entries(terminalAgentNames)) {
        result[role] = terminalName;
    }

    return result;
}

/**
 * Extract the existing _getAgentNames logic into a helper that reads
 * from workspace state.json only (no terminal awareness).
 */
private async _getConfiguredAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
    const result: Record<string, string> = {};
    const builtInRoles = buildKanbanColumns([])
        .map(column => column.role)
        .filter((role): role is string => Boolean(role));
    const fallbackRoles = [...new Set([...builtInRoles, 'analyst'])];

    try {
        if (fs.existsSync(statePath)) {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            const commands = { ...(state.startupCommands || {}) };
            const customAgents = parseCustomAgents(state.customAgents);
            const roles = [...new Set([...fallbackRoles, ...customAgents.map(agent => agent.role)])];
            for (const agent of customAgents) {
                commands[agent.role] = agent.startupCommand;
            }

            for (const role of roles) {
                const cmd = (commands[role] || '').trim();
                if (cmd) {
                    const binary = cmd.split(/\s+/)[0];
                    const name = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase();
                    result[role] = `${name} CLI`;
                } else {
                    result[role] = 'No agent assigned';
                }
            }
        } else {
            for (const role of fallbackRoles) {
                result[role] = 'No agent assigned';
            }
        }
    } catch (e) {
        console.error('[KanbanProvider] Failed to read agent names from state:', e);
        for (const role of fallbackRoles) {
            result[role] = 'No agent assigned';
        }
    }
    return result;
}
```

**Step 7: Clean up cache on terminal disposal**

In extension.ts deactivation (line ~4568-4575), add cache cleanup:

```typescript
// Before the existing terminal disposal loop (line ~4568):
taskViewerProvider.clearAllTerminalAgentInfo();

for (const [name, terminal] of registeredTerminals) {
    try {
        terminal.dispose();
    } catch {
        // Terminal may already be closed
    }
}
registeredTerminals.clear();
```

In TaskViewerProvider's `deregisterAllTerminals` (line ~13918), add cache cleanup:

```typescript
// After the existing this._registeredTerminals?.clear() (line ~13918):
this._terminalAgentInfo.clear();
```

**Step 8: Test workspace switching**

- Create terminal with gemini in workspace A
- Switch to workspace B where lead coder is configured as claude
- Verify terminal name remains "GEMINI CLI" in kanban column header
- Verify dispatch still works correctly
- Verify sidebar shows correct terminal data

### Alternative Approach (Fallback)

If the above approach proves complex, an alternative is to:

1. Store terminal names in a workspace-agnostic location (e.g., global state or VS Code globalState)
2. Update the agent name display logic to read from this workspace-agnostic store
3. Only update this store when terminals are actually created/renamed, not on workspace switches

However, this approach is less clean and introduces additional state management complexity.

## Testing Strategy

1. **Manual test scenario**:
   - Open workspace A with lead coder configured as gemini
   - Start a lead coder terminal
   - Verify terminal shows "GEMINI CLI" in kanban column header
   - Switch to workspace B where lead coder is configured as claude
   - Verify terminal still shows "GEMINI CLI" in kanban column header
   - Verify dispatch to lead coder still works

2. **Regression tests**:
   - Ensure existing terminal creation still works
   - Ensure terminal name resolution for dispatch still works
   - Ensure agent grid initialization still works
   - Ensure workspace switching doesn't break other functionality
   - Ensure autoban terminals get correct cached names
   - Ensure custom agents get correct cached names
   - Ensure terminals created before this fix (no cache entry) fall back to workspace config

## Risks and Considerations

1. **Terminal registry consistency**: Need to ensure terminal metadata (role mapping) is consistently maintained in the new cache
2. **Race conditions**: Workspace switches during terminal creation could cause temporary inconsistencies — mitigated by fallback to workspace config
3. **Backward compatibility**: Terminals created before this fix won't have cache entries — falls back to workspace config (current behavior, no regression)
4. **Performance**: Scanning terminal registry on every refresh is O(n) where n = number of registered terminals — negligible for typical agent counts (< 20)
5. **Stale cache entries**: Exited terminals leave cache entries — mitigated by pruning in `getActualTerminalAgentNames()` on each read

## Success Criteria

- Agent names in kanban column headers are locked to the terminals that created them
- Switching workspaces does not change displayed terminal names
- Dispatch functionality continues to work correctly across workspace switches
- No performance degradation on board refresh
- Autoban and custom agent terminals display correct names
- Terminals without cache entries fall back gracefully to workspace configuration

## Verification Plan

### Automated Tests
- Unit test: `getActualTerminalAgentNames()` returns correct mapping for alive terminals
- Unit test: `getActualTerminalAgentNames()` skips exited terminals and prunes stale entries
- Unit test: `getActualTerminalAgentNames()` deterministically picks first alive terminal per role for autoban
- Unit test: `_getAgentNames()` prioritizes terminal-derived names over workspace config
- Unit test: `_getAgentNames()` falls back to workspace config for roles without running terminals
- Integration test: Workspace switch does not change agent names for running terminals

## Review & Execution Results
**Stage 1: Grumpy Review**
- [CRITICAL] The terminal close event in `handleTerminalClosed` did not prune `_terminalAgentInfo`, causing stale cache entries.
- [MAJOR] The plan was missing a call to `clearTerminalAgentInfo()` during specific terminal closes, though it cleared on `deregisterAllTerminals()`.
- [NIT] No additional issues identified in the core cache approach.

**Stage 2: Balanced Synthesis**
- We must add cleanup for `_terminalAgentInfo` inside `handleTerminalClosed()` using the cleaned terminal name to prevent unbound memory growth and stale lookups.

**Fixes Applied:**
- Added `clearTerminalAgentInfo(cleanedTerminalName)` in `src/services/TaskViewerProvider.ts` -> `handleTerminalClosed()`.
- Verified compilation and types.

**Validation Results:**
- `npm run compile` completes with 0 errors.
- Cache cleanup handles lifecycle correctly.