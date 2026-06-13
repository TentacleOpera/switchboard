# Fix Status Bar "Agents" Button to Locate Instead of Resending Startup Commands

## Goal
Adjust the status bar "Agents" button behavior so that if agent terminals are already open, it simply locates (focuses) the first terminal instead of resending CLI startup commands to all terminals.

## Metadata

**Tags:** ui, bugfix, cli

**Complexity:** 3

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

## User Review Required
None. This is a bugfix aligning the status bar button with existing locate behavior.

## Complexity Audit

### Routine
- Tracking newly created terminals in a `Set`
- Adding an early-return guard when all terminals already exist
- Filtering an existing loop with a `Set` membership check
- Reusing the existing `switchboard.focusTerminalByName` command

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None expected. Terminal creation, registration, and command sending are sequential within `createAgentGrid`.

### Security
- None. No new external input or authentication changes.

### Side Effects
- Skipping startup commands for existing terminals prevents duplicate command injection.
- `taskViewerProvider.setTerminalAgentInfo` is also skipped for existing terminals, leaving cached display names from prior initialization. Acceptable because display names are stable per role; they refresh on terminal reset if the startup command changes.

### Dependencies & Conflicts
- Depends on the existing `switchboard.focusTerminalByName` command registered earlier in `extension.ts` (lines 2017–2052).
- No conflicts with other commands or providers.

## Dependencies
- none

## Adversarial Synthesis
Key risks: (1) Early return assumes all agents are healthy; a stale terminal that passed `clearGridBlockers` but is unresponsive would be focused instead of recreated. (2) `focusTerminalByName` falls back to scanning VS Code terminals by normalized name, which could focus the wrong terminal if multiple windows have similarly named terminals. (3) If a startup command changes while terminals are open, existing terminals will not get the updated `setTerminalAgentInfo` cache because it is skipped. Mitigations: `clearGridBlockers` already prunes exited terminals; focus command uses the registered map first; display name caching is cosmetic and resolves on reset.

## Proposed Changes

### src/extension.ts
- **Context:** The `createAgentGrid` function (lines 2237–2492) opens a grid of agent terminals and unconditionally sends startup commands to every agent in the loop at lines 2457–2479. The `alreadyExisted` flag (line 2380) is tracked but never used to skip command sending.
- **Logic:** After the terminal creation loop, determine whether any terminals were actually created. If none were created, focus the first agent via the existing `switchboard.focusTerminalByName` command and exit. Otherwise, send startup commands only to the terminals that were newly created.
- **Implementation:** Add a `newlyCreatedTerminals` Set populated from `createdTerminals`. Insert an early-return block after the state-registration refresh (line 2429) that focuses the first agent when the Set is empty. In the command-sending loop (line 2457), wrap `terminal.sendText` with a `newlyCreatedTerminals.has(terminal)` guard. Adjust the final information message to differentiate between initialization and focus scenarios (or retain the existing message for the initialization case).
- **Edge Cases:** Partial grid state (some terminals missing) creates missing terminals and sends commands only to them. Terminal name matching remains unchanged because focusing relies on the same `focusTerminalByName` logic. Workspace switches are handled by `clearGridBlockers` before terminal creation.

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

## Verification Plan

### Automated Tests
- Skipped per session directive. The user will run the test suite separately.

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

**Recommendation:** Send to Intern
