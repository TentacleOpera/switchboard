# Fix Implementation Sidebar Tab Persistence on Reopen

## Goal
When the implementation.html sidebar is closed and reopened, it should preserve the user's last tab selection instead of always defaulting to 'terminals'. The 'terminals' default should only apply on extension START (first load), not on every sidebar reopen.

## Problem
In `implementation.html`, the `currentAgentTab` variable is initialized to 'terminals' at line 3310. When the sidebar is closed and reopened, the JavaScript re-initializes, resetting `currentAgentTab` to 'terminals' regardless of the user's previous tab selection. The persisted tab state from `workspaceState` is sent via the `initialState` message, but the webview does not use it to restore the sub-tab selection.

## Root Cause
In `src/webview/implementation.html`:
- Line 3310: `let currentAgentTab = 'terminals';` - Initial default is hardcoded to 'terminals'
- Line 2510: `setActiveTab(message.activeTab || 'agents', false);` - Sets the main tab (agents/activity) from initialState, but does NOT restore the sub-tab (terminals/agents/project)
- The `initialState` message includes `activeTab` (main tab) but does NOT include the sub-tab state (terminals/agents/project)

In `src/services/TaskViewerProvider.ts`:
- Line 248: `private static readonly ACTIVE_TAB_STATE_KEY = 'switchboard.activeTab';` - Only persists the main tab (agents/activity), not the sub-tab
- Line 4296: `const activeTab = this._context.workspaceState.get<string>(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, 'agents');` - Only reads main tab state
- The sub-tab state (terminals/agents/project) is never persisted to workspaceState

## Metadata
- **Tags:** [bugfix, UI, UX, frontend]
- **Complexity:** 3

## User Review Required
- [ ] Confirm that sub-tab persistence should survive across VS Code sessions (workspaceState) vs. only within a single session (in-memory). Current plan uses workspaceState to match the existing main-tab pattern.
- [ ] Confirm that the 'terminals' default on first load (no persisted state) is the desired behavior.

## Complexity Audit

### Routine
- Add workspaceState persistence for sub-tab selection in TaskViewerProvider (reuses existing `ACTIVE_TAB_STATE_KEY` pattern at line 248)
- Pass sub-tab state via initialState message (add one field to payload at line 4336–4350)
- Restore sub-tab from initialState in implementation.html (add 3 lines to handler at line 2507–2553)
- Persist sub-tab changes on switch (add 1 line to `switchAgentTab` at line 3312–3349)
- Add message handler for `setActiveSubTab` (follow pattern at line 7972–7976)
- Validate sub-tab values against known set ('agents', 'terminals', 'project')

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — state is restored synchronously in the `initialState` message handler before any user interaction can occur. The `switchAgentTab` call during restore sends async messages, but these are idempotent data requests that don't affect tab state.
- **Security:** Low — the `setActiveSubTab` handler must validate `data.tab` against the known sub-tab values ('agents', 'terminals', 'project') to prevent arbitrary string injection into workspaceState. Without validation, a malformed message could persist an invalid tab name that causes a blank panel on next restore.
- **Side Effects:** When restoring to 'terminals' tab via `switchAgentTab`, 7 `vscode.postMessage` calls fire (`getStartupCommands`, `getVisibleAgents`, etc.). These are idempotent and harmless, but worth noting as they execute on every sidebar reopen when the persisted tab is 'terminals'.
- **Dependencies & Conflicts:** None — uses existing workspaceState infrastructure. The `setActiveTab` function (lines 2345–2352) is vestigial (always sends `tab: 'agents'`) but does not conflict with sub-tab persistence.

## Dependencies
- None

## Adversarial Synthesis
Key risks: invalid persisted sub-tab values causing blank panels on restore, and missing input validation allowing arbitrary strings into workspaceState. Mitigations: validate sub-tab values against the known set in both the message handler and the restore path; fall back to 'terminals' for unrecognized values.

## Solution
Add persistence for the sub-tab selection (terminals/agents/project) in workspaceState, pass it via the initialState message, and restore it in the webview on load. Only default to 'terminals' on first extension load when no persisted state exists.

### Changes Required

**File: `src/services/TaskViewerProvider.ts`**

**Change 1 — Add sub-tab state key constant** (at line 248, after `ACTIVE_TAB_STATE_KEY`):
```typescript
private static readonly ACTIVE_TAB_STATE_KEY = 'switchboard.activeTab';
private static readonly ACTIVE_SUB_TAB_STATE_KEY = 'switchboard.activeSubTab'; // NEW
```

**Change 2 — Persist sub-tab state** (in `_sendInitialState`, at line 4296, after the `activeTab` read):
```typescript
const activeTab = this._context.workspaceState.get<string>(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, 'agents');
const activeSubTab = this._context.workspaceState.get<string>(TaskViewerProvider.ACTIVE_SUB_TAB_STATE_KEY, 'terminals'); // NEW
```

**Change 3 — Send sub-tab state in initialState message** (in the message payload, at line 4345, after `activeTab`):
```typescript
{
    type: 'initialState',
    // ... existing fields
    activeTab,
    activeSubTab, // NEW
    // ... rest of fields
}
```

**Change 4 — Save sub-tab state when changed** (add new message handler in `onDidReceiveMessage`, at line 7976, after the `setActiveTab` case):
```typescript
case 'setActiveTab': {
    const activeTab = data.tab === 'activity' ? 'activity' : 'agents';
    await this._context.workspaceState.update(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, activeTab);
    break;
}
case 'setActiveSubTab': { // NEW
    const validSubTabs = ['agents', 'terminals', 'project'];
    const activeSubTab = validSubTabs.includes(data.tab) ? data.tab : 'terminals';
    await this._context.workspaceState.update(TaskViewerProvider.ACTIVE_SUB_TAB_STATE_KEY, activeSubTab);
    break;
}
```

**File: `src/webview/implementation.html`**

**Change 5 — Restore sub-tab from initialState** (in the `initialState` case, at line 2510, after `setActiveTab` call):
```javascript
case 'initialState':
case 'mcpStatus':
    updateMcpStatus(message);
    setActiveTab(message.activeTab || 'agents', false);
    if (message.type === 'initialState') {
        // Restore sub-tab selection from persisted state
        if (message.activeSubTab) {
            const validSubTabs = ['agents', 'terminals', 'project'];
            currentAgentTab = validSubTabs.includes(message.activeSubTab) ? message.activeSubTab : 'terminals';
            switchAgentTab(currentAgentTab);
        }
        toggleOnboarding(message.needsSetup === true);
        // ... rest of existing initialState handling
    }
    break;
```

**Change 6 — Persist sub-tab changes** (in `switchAgentTab` function, at line 3312, after `currentAgentTab = tab;`):
```javascript
function switchAgentTab(tab) {
    currentAgentTab = tab;
    // Persist sub-tab selection
    vscode.postMessage({ type: 'setActiveSubTab', tab: tab });
    const tabs = { agents: agentListStandard, terminals: agentListTerminals, project: agentListProject };
    // ... rest of existing function
}
```

## Proposed Changes

### src/services/TaskViewerProvider.ts
- **Context:** Add persistence for sub-tab selection (terminals/agents/project) to workspaceState
- **Logic:** Store and retrieve sub-tab state using the same pattern as the main tab (agents/activity). Validate sub-tab values against the known set to prevent invalid persisted state.
- **Implementation:** Add state key constant at line 248, read from it in `_sendInitialState` at line 4296, include in initialState message payload at line 4345, add validated message handler at line 7976
- **Edge Cases:** Invalid or stale persisted values fall back to 'terminals' default. Future sub-tab additions require updating the `validSubTabs` array in both the handler and the restore path.

### src/webview/implementation.html
- **Context:** Restore sub-tab selection from initialState on webview load
- **Logic:** When initialState message is received, restore the sub-tab if available and valid; otherwise use default 'terminals'. Persist sub-tab changes via `switchAgentTab`.
- **Implementation:** Add sub-tab restoration with validation in initialState handler at line 2510. Add `vscode.postMessage` call in `switchAgentTab` at line 3313.
- **Edge Cases:** When restoring to 'terminals', `switchAgentTab` fires 7 data-request messages — these are idempotent and harmless. Unknown persisted values fall back to 'terminals'.

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for this webview UI component. Manual verification required.

### Manual Verification Steps
1. Open implementation.html sidebar → verify "Terminals" sub-tab is active by default (first load)
2. Switch to "Agents" sub-tab → close sidebar → reopen sidebar → verify "Agents" sub-tab is still active
3. Switch to "Project" sub-tab → close sidebar → reopen sidebar → verify "Project" sub-tab is still active
4. Switch to "Terminals" sub-tab → close sidebar → reopen sidebar → verify "Terminals" sub-tab is still active
5. Reload VS Code extension → verify the last sub-tab selection is preserved after extension restart
6. Open agent terminals → switch to "Agents" → close terminals → verify tab stays on "Agents" (does not auto-switch to "Terminals")
7. Manually set `switchboard.activeSubTab` to an invalid value (e.g. "nonexistent") in workspaceState → reopen sidebar → verify it falls back to "Terminals" instead of showing a blank panel

## Recommendation
Complexity 3 → **Send to Intern**
