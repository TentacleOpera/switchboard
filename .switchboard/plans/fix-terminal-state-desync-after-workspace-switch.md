# Fix Terminal State Desync After Workspace Switch

## Goal
Clear the in-memory terminal dispatch map (`_registeredTerminals`) on workspace switch and ensure `_terminalAgentInfo` is preserved correctly so that after switching workspaces, newly opened terminals are correctly detected and the dispatch map is not stale.

## Problem
The user reports the following bug sequence:
1. Open terminals in workspace A
2. Switch to workspace B via kanban dropdown
3. Reset terminals (deregisterAllTerminals)
4. Open new terminals in workspace B
5. Close implementation.html sidebar
6. Reopen implementation.html sidebar → 'start coding' buttons stay greyed out (system cannot find active terminals)
7. Switch back to workspace A → NOW terminals appear (but with wrong terminal names from stale state)

**Key insight**: The sidebar reopen in workspace B fails to detect terminals because the in-memory maps still contain stale entries from workspace A. Only when switching back to workspace A does something trigger a proper refresh that clears or updates the maps. This suggests:

1. **Sidebar reopen doesn't trigger terminal refresh**: When the sidebar is closed and reopened, the `resolveWebviewView` method and the `ready` message handler do not clear the in-memory maps before calling `_refreshTerminalStatuses()`. This causes stale entries to persist and interfere with terminal detection.

2. **Workspace switch DOES trigger refresh**: Switching workspaces via kanban dropdown triggers some refresh mechanism (likely through KanbanProvider's state updates), which causes `_refreshTerminalStatuses()` to be called and read from the correct workspace's state.json. However, the in-memory maps are still stale, causing wrong terminal names to be displayed.

3. **Two-part fix needed**:
   - Clear in-memory maps on workspace switch (to prevent stale references when switching between workspaces)
   - Clear in-memory maps on sidebar reopen (to ensure fresh state when the sidebar is closed and reopened in the same workspace)

## Root Cause
In `src/services/TaskViewerProvider.ts`:
- **In-memory terminal registry is global, not per-workspace**: The `_registeredTerminals` Map and `_terminalAgentInfo` Map are instance-level fields that persist across workspace switches
- **No workspace switch handler**: When the user switches workspaces via the kanban dropdown (`selectWorkspace` message in KanbanProvider.ts), TaskViewerProvider has no mechanism to clear these in-memory maps
- **State.json is per-workspace**: Each workspace has its own `.switchboard/state.json` with its own `state.terminals` object, but the in-memory maps are not synchronized with the current workspace's state
- **Stale PID/name mappings**: After switching to workspace B and opening new terminals, the in-memory maps may contain stale entries from workspace A. When the sidebar reopens, `_refreshTerminalStatuses()` reads from the new workspace's state.json but the in-memory maps still have old entries, causing mismatches

### Specific Code Locations

**In-memory maps (not cleared on workspace switch):**
- Line 289: `private _registeredTerminals?: Map<string, vscode.Terminal>` — workspace-scoped, must be cleared on switch
- Line 294: `private _terminalAgentInfo = new Map<string, { role: string; displayName: string }>()` — **intentionally workspace-agnostic** (see lines 291-293 comment: "This survives workspace switches because it's derived from the actual running terminal, not from the currently-selected workspace's state.json.")

**Workspace switch trigger (no TaskViewerProvider handler):**
- `src/services/KanbanProvider.ts` line 4152: `case 'selectWorkspace':` calls `this.setCurrentWorkspaceRoot(msg.workspaceRoot)` but does not notify TaskViewerProvider to clear `_registeredTerminals`

**State resolution (workspace-aware):**
- Line 907-913: `_resolveStateWorkspaceRoot()` uses `_resolveWorkspaceRoot()` which delegates to KanbanProvider for the current workspace
- Line 16431-16433: `_refreshTerminalStatuses()` calls `_resolveStateFilePath()` to get the current workspace's state.json

**Terminal registration (updates in-memory maps):**
- Line 13899: `state.terminals[suffixedKey] = { ... }` — writes to state.json
- Line 13919: `this._registeredTerminals.set(suffixedKey, terminal)` — writes to in-memory map
- Line 13860/13929: `this._terminalAgentInfo.set(existingName, { role, displayName })` — writes to in-memory agent info cache

**Terminal deregistration (clears in-memory maps):**
- Line 14032: `this._registeredTerminals?.clear()` — called in `_deregisterAllTerminals()`
- Line 14033: `this._terminalAgentInfo.clear()` — called in `_deregisterAllTerminals()`
- Line 13978: `this.clearTerminalAgentInfo(cleanedTerminalName)` — called in `handleTerminalClosed()`

**The gap:** `_deregisterAllTerminals()` is only called when the user explicitly clicks "Reset Agent Terminals" or on extension startup. It is NOT called when the user switches workspaces via the kanban dropdown.

## Metadata
- **Tags:** bugfix, reliability
- **Complexity:** 4

## User Review Required
- [ ] Confirm that clearing `_registeredTerminals` on workspace switch is the desired behavior (vs. preserving them across workspaces)
- [ ] Confirm that `_terminalAgentInfo` should NOT be cleared on workspace switch (per its existing design: workspace-agnostic). Clearing it would break `getActualTerminalAgentNames()` in the Kanban board.
- [ ] Confirm whether the sidebar-reopen bug (step 6 greyed-out buttons) should be fixed by the same mechanism, or if it is a separate issue. The "start coding" dispatch path reads `_registeredTerminals`, which is re-populated only via explicit `registerTerminals()` — clearing it on sidebar reopen would not help unless `_refreshTerminalStatuses()` is extended to also repopulate `_registeredTerminals`.

## Complexity Audit

### Routine
- Add a new `clearRegisteredTerminalsMap()` method in TaskViewerProvider that clears only `_registeredTerminals` (not `_terminalAgentInfo`)
- Call this method from KanbanProvider's `selectWorkspace` handler, after `setCurrentWorkspaceRoot()` and `reinitializePlanWatcher()`
- `_taskViewerProvider` field already exists in KanbanProvider (line 137); no new wiring needed

### Complex / Risky
- **`_terminalAgentInfo` must NOT be cleared on workspace switch**: The codebase has an explicit comment (lines 291-293) stating this map "survives workspace switches because it's derived from the actual running terminal." Clearing it would break `getActualTerminalAgentNames()` (line 451) which is called by KanbanProvider at line 3285 to display role badges. The plan must clear ONLY `_registeredTerminals`.
- **Sidebar-reopen bug (step 6) is not fixed by this change**: The "start coding" dispatch path checks `_registeredTerminals` (line 8425). After clearing on workspace switch, this map stays empty until `registerTerminals()` is called again. `_refreshTerminalStatuses()` repopulates the sidebar UI from state.json but does NOT repopulate `_registeredTerminals`. A separate fix is needed if the sidebar-reopen greyed-out behavior must be resolved.
- **Risk of over-clearing**: If `clearRegisteredTerminalsMap()` is called on every sidebar reopen (as the original plan proposed), it will wipe the dispatch map every time the user collapses/expands the sidebar panel — even mid-session. This is avoided by restricting the call to workspace switch events only.

## Edge-Case & Dependency Audit

- **Race Conditions**: If a terminal is being registered during a workspace switch, the clear could race with the registration. However, terminal registration is rare and typically happens after the switch is complete. The clear should be synchronous and fast (just clearing one Map), so the window for race conditions is small.
- **Security**: No impact. The maps only contain terminal references and metadata; no sensitive data or auth is involved.
- **Side Effects**: Clearing `_registeredTerminals` will cause subsequent `handleSendToTerminal` calls to fail with "terminal not found" until `registerTerminals()` is called in the new workspace. This is the correct behavior — terminals from workspace A should not receive commands in workspace B.
- **Dependencies & Conflicts**: `getActualTerminalAgentNames()` reads `_terminalAgentInfo`, not `_registeredTerminals`. As long as `_terminalAgentInfo` is preserved, Kanban role badges continue to display correctly after workspace switch. `_refreshTerminalStatuses()` reads from state.json (file), not from `_registeredTerminals`, so the sidebar terminal status panel is unaffected.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan erroneously proposed clearing `_terminalAgentInfo` on workspace switch, contradicting an explicit architectural design decision — this must be corrected to clear only `_registeredTerminals`. (2) Clearing `_registeredTerminals` on sidebar reopen (proposed in the original plan) is overly aggressive and would break dispatch during normal panel collapse/expand. (3) The sidebar-reopen greyed-out bug (step 6) is not fully resolved by this change alone, since `_refreshTerminalStatuses()` does not repopulate `_registeredTerminals`. Mitigations: Scope the new method to clear only `_registeredTerminals`; restrict the call site to `selectWorkspace` only (not `resolveWebviewView`); document the sidebar-reopen limitation as a known gap.

## Solution
Add one targeted mechanism: clear **only** the `_registeredTerminals` dispatch map when the user switches workspaces via the kanban dropdown.

**Do NOT** clear `_terminalAgentInfo` — it is intentionally workspace-agnostic and must survive workspace switches.

**Do NOT** call the clear on sidebar reopen (`resolveWebviewView`) — this is too broad and does not fix the sidebar greyed-out bug anyway.

This ensures that:
- Stale terminal dispatch references from workspace A are cleared when switching to workspace B
- `_terminalAgentInfo` (the workspace-agnostic role/displayName cache) is preserved for Kanban board role badges
- The sidebar always reads terminal status from the current workspace's state.json (via `_refreshTerminalStatuses()`)

### Changes Required

**File: `src/services/TaskViewerProvider.ts`**

**Change 1 — Add public method to clear only the dispatch map** (after `clearAllTerminalAgentInfo()` at line 444):
```typescript
/**
 * Clears the in-memory terminal dispatch map (_registeredTerminals) only.
 * NOTE: Does NOT clear _terminalAgentInfo — that map is intentionally
 * workspace-agnostic (see field comment) and must survive workspace switches
 * so that getActualTerminalAgentNames() remains correct for Kanban role badges.
 */
public clearRegisteredTerminalsMap(): void {
    this._registeredTerminals?.clear();
    console.log('[TaskViewerProvider] Cleared _registeredTerminals dispatch map (workspace switch)');
}
```

**File: `src/services/KanbanProvider.ts`**

**Change 2 — Call clear method on workspace switch** (in the `selectWorkspace` case handler, at line 4180, after `reinitializePlanWatcher`):
```typescript
case 'selectWorkspace':
    if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
        this.setCurrentWorkspaceRoot(msg.workspaceRoot);

        // ... existing filter logic (lines 4156-4176) ...

        this._setupSessionWatcher();
        // Sync TaskViewerProvider's plan watcher to the new workspace
        this._taskViewerProvider?.reinitializePlanWatcher(msg.workspaceRoot);
        // Clear stale terminal dispatch references from the previous workspace.
        // _terminalAgentInfo is intentionally preserved (workspace-agnostic).
        this._taskViewerProvider?.clearRegisteredTerminalsMap();
        await this._refreshBoard(msg.workspaceRoot);
    }
    break;
```

**File: `src/extension.ts`**

**Change 3 — Verify TaskViewerProvider reference is passed to KanbanProvider** (no code change expected):
- The field `private _taskViewerProvider?: TaskViewerProvider` already exists at KanbanProvider line 137
- It is set via the existing setter at line 149
- Verify in extension.ts that `kanbanProvider.setTaskViewerProvider(taskViewerProvider)` (or equivalent) is called during initialization

## Proposed Changes

### src/services/TaskViewerProvider.ts
- **Context**: Add a public method to clear only the `_registeredTerminals` dispatch map on workspace switch; deliberately preserve `_terminalAgentInfo`
- **Logic**: Clear `_registeredTerminals` synchronously when the workspace switches; do NOT touch `_terminalAgentInfo`
- **Implementation**:
  - Add `clearRegisteredTerminalsMap()` method after `clearAllTerminalAgentInfo()` at line 444
- **Edge Cases**: The method is safe to call even if `_registeredTerminals` is already null/undefined (optional chaining). Does not affect `_terminalAgentInfo` or any state.json.

### src/services/KanbanProvider.ts
- **Context**: Call TaskViewerProvider's clear method when workspace switches
- **Logic**: In the `selectWorkspace` message handler, after `reinitializePlanWatcher()` at line 4180, clear the dispatch map
- **Implementation**: Add `this._taskViewerProvider?.clearRegisteredTerminalsMap()` call at line ~4181
- **Edge Cases**: The optional chaining (`?.`) handles the case where `_taskViewerProvider` is not set

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for this specific workspace switch scenario. Manual verification required.

### Manual Verification Steps
1. Open terminals in workspace A (e.g., coder, reviewer)
2. Register them via sidebar ("Register All Terminals")
3. Switch to workspace B via kanban dropdown
4. Verify sidebar still shows Kanban role badges correctly (confirms `_terminalAgentInfo` was NOT cleared)
5. Reset terminals (click "Reset Agent Terminals" in sidebar)
6. Open new terminals in workspace B
7. Register them via sidebar
8. Switch back to workspace A via kanban dropdown
9. Verify 'start coding' buttons show the correct terminal names from workspace A (not stale names from workspace B) **[FIXES STEP 7 BUG]**
10. Repeat the sequence with different terminal configurations to ensure robustness

**Known limitation**: The sidebar-reopen greyed-out buttons bug (original step 6) is NOT fixed by this change. After the workspace switch clears `_registeredTerminals`, the user must re-register terminals in the new workspace to re-enable the dispatch map. This is expected behavior: `_refreshTerminalStatuses()` repopulates the UI display from state.json but does not repopulate the dispatch map.

## Risk Assessment
- Low risk: The change only clears `_registeredTerminals` (terminal dispatch map), not `_terminalAgentInfo` (workspace-agnostic role cache)
- No breaking changes: Terminals are already workspace-scoped in the persisted state (state.json); this fix aligns the in-memory dispatch map with that model
- Minimal code change: One new method (~5 lines), one new call site (1 line)
- `getActualTerminalAgentNames()` continues to work correctly after workspace switch since `_terminalAgentInfo` is preserved

## Recommendation
Complexity 4 → **Send to Coder**
