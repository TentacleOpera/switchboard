# Fix Status Bar "Agents" Button to Locate Instead of Resending Startup Commands

## Goal
Adjust the status bar "Agents" button behavior so that if agent terminals are already open, it simply locates (focuses) the first terminal instead of resending CLI startup commands to all terminals.

## Problem Analysis

### Current Behavior
- The status bar "Agents" button (`terminalOpenStatusBarItem`) is registered with command `switchboard.createAgentGrid` (extension.ts line 1758)
- The `createAgentGrid` function (extension.ts lines 2237-2492) always sends startup commands to ALL agents (lines 2456-2479)
- The function tracks `alreadyExisted` for each terminal (line 2380) but does not use this flag to skip sending startup commands
- This causes duplicate startup commands to be sent to already-running agent terminals when the button is clicked

### Expected Behavior
- If all agent terminals are already open, clicking the "Agents" button should simply focus the first terminal (similar to the locate buttons in implementation.html)
- Startup commands should only be sent to newly created terminals
- This matches the behavior of the locate buttons in implementation.html, which send `focusTerminal` messages without sending commands

### Root Cause
The `createAgentGrid` function unconditionally sends startup commands to all agents in the loop (lines 2457-2479), regardless of whether each terminal was just created or already existed. The `alreadyExisted` flag is set but not used to conditionally skip command sending.

## Implementation Plan

### Step 1: Modify `createAgentGrid` to detect if all terminals already exist
- After the terminal creation loop (line 2411), check if all terminals in the grid already existed
- If `createdTerminals.length === 0` (no new terminals were created), all terminals were already open

### Step 2: Add logic to focus first terminal instead of sending commands
- If all terminals already existed:
  - Skip the startup command sending loop entirely
  - Call `switchboard.focusTerminalByName` to focus the first agent terminal (e.g., "Planner" or the first in the agents array)
  - Update the success message to reflect that terminals were focused rather than initialized
- If some or all terminals were newly created:
  - Keep the existing behavior of sending startup commands only to `createdTerminals`
  - The current logic already waits for shell readiness only for `createdTerminals` (line 2432), so this is partially correct

### Step 3: Update the command sending loop to respect `alreadyExisted`
- In the startup command loop (lines 2457-2479), add a check to only send commands to terminals that were newly created
- Track which terminals were newly created in a Set or Map during the creation loop
- Filter the command loop to only send commands to newly created terminals

### Files to Modify
- `src/extension.ts` - Modify the `createAgentGrid` function (lines 2237-2492)

### Detailed Changes

#### Change 1: Track newly created terminals
```typescript
// After line 2411, add:
const newlyCreatedTerminals = new Set(createdTerminals);
```

#### Change 2: Add early exit for all-terminals-exist case
```typescript
// After line 2429, add:
if (newlyCreatedTerminals.size === 0) {
    // All terminals already existed - just focus the first one
    const firstAgent = agents[0];
    if (firstAgent) {
        await vscode.commands.executeCommand('switchboard.focusTerminalByName', firstAgent.name);
        vscode.window.showInformationMessage(`Agent terminals already open. Focused: ${firstAgent.name}`);
    }
    return;
}
```

#### Change 3: Filter command sending to new terminals only
```typescript
// Modify line 2460 to check if terminal was newly created:
const terminal = gridTerminals.get(suffixedName(agent.name));
if (terminal && newlyCreatedTerminals.has(terminal)) {
    // Only send command if this terminal was newly created
    terminal.sendText(cmd.trim(), true);
    // ... rest of existing logic
}
```

## Edge Cases

### Partial Terminal State
- If some terminals exist but others don't, the function should create missing terminals and send commands only to the new ones
- The current logic already handles this correctly with the `createdTerminals` tracking

### Terminal Name Matching
- The function uses `matchesGridAgentName` for fuzzy matching (lines 2305-2313)
- Ensure the focus logic uses the same matching strategy or relies on the registered terminals map

### Workspace Switch
- If the user switches workspaces, terminals from the previous workspace might still exist
- The `clearGridBlockers` function (lines 2314-2364) should handle cleanup of stale terminals before the creation loop

## Testing

### Manual Testing Steps
1. Open agent terminals via the "Agents" status bar button
2. Click the "Agents" button again
3. Verify that:
   - No duplicate startup commands are sent to terminals
   - The first terminal is focused
   - A message appears indicating terminals were already open
4. Close one terminal and click the "Agents" button
5. Verify that:
   - The missing terminal is created
   - Startup command is sent only to the newly created terminal
   - Existing terminals do not receive duplicate commands

### Regression Testing
- Verify that the "OPEN AGENT TERMINALS" button in implementation.html still works correctly
- Verify that locate buttons in implementation.html still work correctly
- Verify that terminal reset functionality is unaffected

## Metadata

**Complexity:** 3

**Tags:** ui, bugfix, terminal
