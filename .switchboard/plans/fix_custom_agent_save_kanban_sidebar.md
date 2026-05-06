# Fix: Custom Agent Save Not Adding Agent to Kanban or Sidebar

## Goal

Add missing IPC message handlers (`saveCustomAgent`, `deleteCustomAgent`, `getCustomAgents`) in `KanbanProvider._handleMessage()` and corresponding persistence methods in `TaskViewerProvider` so that custom agents created via the kanban Agents tab are persisted to `.switchboard/state.json` and appear in the kanban columns and sidebar.

## Metadata
**Tags:** backend, bugfix, workflow
**Complexity:** 5

## User Review Required

- Confirm that the `CustomAgentConfig` type includes all fields sent by the kanban webview (`kanban.html:2409`): `id`, `name`, `role`, `startupCommand`, `includeInKanban`, `kanbanOrder`, `dragDropMode`. If the webview sends additional fields not in the type, they will be silently dropped by `parseCustomAgents`.
- Decide whether `handleSaveCustomAgent` should also call `_postSidebarConfigurationState` + `postSetupPanelState` (as `handleSaveKanbanColumn` does at `TaskViewerProvider.ts:5719-5722`) or rely solely on the `broadcastToWebviews` call in `KanbanProvider`'s handler. **Clarification:** The current plan relies on `broadcastToWebviews` + `_refreshBoard` in `KanbanProvider`; this is sufficient because `_refreshBoard` triggers `refreshUI` which calls `_postSidebarConfigurationState` internally. However, if the user wants immediate sidebar update without waiting for the board refresh cycle, mirroring the `handleSaveKanbanColumn` pattern would be safer.

## Problem

When a user creates and saves a custom agent via the Agents tab in `kanban.html`, the agent:
- **Does NOT appear** in the kanban board columns (even when `includeInKanban` is checked)
- **Does NOT appear** in the sidebar (`implementation.html`) agent list
- **Disappears** from the kanban Agents tab on panel reload

## Root Cause

The kanban webview sends three IPC message types that have **no backend handlers**:

| Message | Sent From | Handler Exists? |
|---------|-----------|-----------------|
| `saveCustomAgent` | `kanban.html:2409` | **NO** |
| `deleteCustomAgent` | `kanban.html:2437` | **NO** |
| `getCustomAgents` | `kanban.html:4533` | **NO** |

The `KanbanProvider._handleMessage()` switch statement (`KanbanProvider.ts:3088-4789`) handles 30+ message types but is missing all three. The custom agent is only added to the in-memory `agentsTabCustomAgents` array in the webview; it is never persisted to `.switchboard/state.json`. Since the kanban columns and sidebar both read custom agents from `state.json`, the saved agent is invisible everywhere.

## Complexity Audit

### Routine
- Adding three `case` blocks to `_handleMessage()` in `KanbanProvider.ts` — follows the exact pattern of existing handlers like `saveKanbanColumn` / `deleteKanbanColumn` (`KanbanProvider.ts:4748-4767`)
- Adding two public methods to `TaskViewerProvider.ts` — mirrors `handleSaveKanbanColumn` (`TaskViewerProvider.ts:5707-5723`) and `handleDeleteKanbanColumn` (`TaskViewerProvider.ts:5725-5739`)
- `parseCustomAgents` is already imported; `updateState` and `getCustomAgents` already exist; `broadcastToWebviews` already exists
- The kanban webview (`kanban.html`) already sends these messages and already handles `customAgents` broadcast responses (`kanban.html:4519-4525`)
- The sidebar (`implementation.html`) already handles `customAgents` broadcasts (`implementation.html:2945-2949`)
- `buildKanbanColumns` in `agentConfig.ts:232-233` already filters for `includeInKanban`

### Complex / Risky
- **State consistency on delete**: `handleDeleteCustomAgent` must clean up `visibleAgents` and `startupCommands` entries for the deleted role. If these cleanup operations fail silently (e.g., `state.visibleAgents` is `undefined`), the orphaned entries persist but cause no functional harm — they are inert keys in maps keyed by a role that no longer exists.
- **`_refreshBoard` indirection**: `_refreshBoard` (`KanbanProvider.ts:1430-1450`) delegates to `vscode.commands.executeCommand('switchboard.refreshUI', _workspaceRoot)` rather than calling `_refreshBoardImpl` directly. This means the board refresh is asynchronous and may complete after the `saveCustomAgentResult` success message is posted. The webview must not assume the column is visible immediately after receiving `success: true` — it should wait for the `updateColumns` message. **Clarification:** The existing kanban webview already handles this pattern correctly for `saveKanbanColumn` (which also calls `refreshUI` at `KanbanProvider.ts:4755`).

## Edge-Case & Dependency Audit

- **Race Conditions**: If the user rapidly saves then deletes the same custom agent, the `updateState` queue (100ms debounced in `TaskViewerProvider.ts:935-938`) serializes operations. The delete will always execute after the save completes. No race.
- **Security**: No auth/permission concerns. Custom agents are workspace-local configuration stored in `.switchboard/state.json`. No secrets are handled.
- **Side Effects**: `broadcastToWebviews` posts to sidebar and setup panel. `_refreshBoard` triggers a full `refreshUI` command which re-reads state.json and pushes to all webviews. These are idempotent operations.
- **Dependencies & Conflicts**: No conflicts detected. Kanban board CREATED and BACKLOG columns are empty. No other plans in progress modify `KanbanProvider._handleMessage()` or `TaskViewerProvider` custom-agent handling.

## Dependencies

None

## Adversarial Synthesis

**Risk Summary:** The primary risk is that `handleDeleteCustomAgent` fails to clean up `visibleAgents`/`startupCommands` entries if `state.visibleAgents` is `undefined` at delete time — this is a benign leak (orphaned keys with no effect). The secondary risk is that the webview assumes the kanban column is visible immediately after `saveCustomAgentResult` success, but the existing webview code already handles async column updates correctly. Both risks are low and have straightforward mitigations.

## Files to Change

- `src/services/KanbanProvider.ts` — add `saveCustomAgent`, `deleteCustomAgent`, and `getCustomAgents` handlers in `_handleMessage()`
- `src/services/TaskViewerProvider.ts` — add public `handleSaveCustomAgent()` and `handleDeleteCustomAgent()` methods

## Proposed Changes

### src/services/TaskViewerProvider.ts

**Context:** Insert two new public methods immediately after `handleToggleKanbanColumnVisibility` (line 5758) and before `handleRestoreKanbanDefaults`. This groups them with the existing kanban-structure handler family (`handleSaveKanbanColumn` at line 5707, `handleDeleteKanbanColumn` at line 5725, `handleToggleKanbanColumnVisibility` at line 5741).

**Logic:**
- `handleSaveCustomAgent`: Resolve workspace root, call `updateState` to upsert the agent into `state.customAgents` (filter out existing by `id`, push new).
- `handleDeleteCustomAgent`: Resolve workspace root, call `updateState` to remove the agent by `id` from `state.customAgents`, and clean up `state.visibleAgents[role]` and `state.startupCommands[role]` for the deleted role.

**Implementation:**

```typescript
public async handleSaveCustomAgent(agent: CustomAgentConfig, workspaceRoot?: string): Promise<void> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) { return; }
    await this.updateState((state: any) => {
        const existing = parseCustomAgents(state.customAgents);
        const filtered = existing.filter((a: CustomAgentConfig) => a.id !== agent.id);
        filtered.push(agent);
        state.customAgents = filtered;
    });
}

public async handleDeleteCustomAgent(agentId: string, workspaceRoot?: string): Promise<void> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) { return; }
    await this.updateState((state: any) => {
        const existing = parseCustomAgents(state.customAgents);
        const deletedRole = existing.find((a: CustomAgentConfig) => a.id === agentId)?.role;
        state.customAgents = existing.filter((a: CustomAgentConfig) => a.id !== agentId);
        if (deletedRole) {
            if (state.visibleAgents) {
                delete state.visibleAgents[deletedRole];
            }
            if (state.startupCommands) {
                delete state.startupCommands[deletedRole];
            }
        }
    });
}
```

**Edge Cases:**
- `state.customAgents` is `undefined` or `null`: `parseCustomAgents` handles this (returns `[]`).
- Agent with duplicate `id`: upsert pattern (filter then push) ensures last write wins.
- Delete of non-existent agent: `existing.find()` returns `undefined`, `deletedRole` is falsy, cleanup is skipped. No error.

### src/services/KanbanProvider.ts

**Context:** Insert three new `case` blocks inside `_handleMessage()` switch statement, immediately before the closing `}` of the switch at line 4788. The last existing case is `toggleKanbanColumnVisibility` (lines 4778-4787). Insert after line 4787, before line 4788.

**Logic:**
- `saveCustomAgent`: Validate `msg.agent` and workspace, delegate to `TaskViewerProvider.handleSaveCustomAgent`, broadcast updated agent list, refresh board.
- `deleteCustomAgent`: Validate `msg.agentId` and workspace, delegate to `TaskViewerProvider.handleDeleteCustomAgent`, broadcast updated agent list, refresh board.
- `getCustomAgents`: Read agents from `TaskViewerProvider.getCustomAgents`, post to requesting webview.

**Implementation:**

```typescript
case 'saveCustomAgent': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !msg.agent || typeof msg.agent !== 'object') {
        this._panel?.webview.postMessage({ type: 'saveCustomAgentResult', success: false, error: 'Missing agent data or workspace' });
        break;
    }
    try {
        await this._taskViewerProvider?.handleSaveCustomAgent(msg.agent, workspaceRoot);
        const customAgents = await this._taskViewerProvider?.getCustomAgents(workspaceRoot) ?? [];
        this._taskViewerProvider?.broadcastToWebviews({ type: 'customAgents', customAgents });
        this._panel?.webview.postMessage({ type: 'saveCustomAgentResult', success: true });
        await this._refreshBoard(workspaceRoot);
    } catch (e: any) {
        this._panel?.webview.postMessage({ type: 'saveCustomAgentResult', success: false, error: e.message || 'Failed to save custom agent' });
    }
    break;
}
case 'deleteCustomAgent': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || typeof msg.agentId !== 'string') {
        this._panel?.webview.postMessage({ type: 'deleteCustomAgentResult', success: false, error: 'Missing agent ID or workspace' });
        break;
    }
    try {
        await this._taskViewerProvider?.handleDeleteCustomAgent(msg.agentId, workspaceRoot);
        const customAgents = await this._taskViewerProvider?.getCustomAgents(workspaceRoot) ?? [];
        this._taskViewerProvider?.broadcastToWebviews({ type: 'customAgents', customAgents });
        this._panel?.webview.postMessage({ type: 'deleteCustomAgentResult', success: true });
        await this._refreshBoard(workspaceRoot);
    } catch (e: any) {
        this._panel?.webview.postMessage({ type: 'deleteCustomAgentResult', success: false, error: e.message || 'Failed to delete custom agent' });
    }
    break;
}
case 'getCustomAgents': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) {
        this._panel?.webview.postMessage({ type: 'customAgents', customAgents: [] });
        break;
    }
    try {
        const customAgents = await this._taskViewerProvider?.getCustomAgents(workspaceRoot) ?? [];
        this._panel?.webview.postMessage({ type: 'customAgents', customAgents });
    } catch {
        this._panel?.webview.postMessage({ type: 'customAgents', customAgents: [] });
    }
    break;
}
```

**Edge Cases:**
- `_taskViewerProvider` is null/undefined: optional chaining (`?.`) ensures graceful degradation; error result is posted to webview.
- `_panel` is null/undefined: optional chaining on `postMessage` calls prevents crashes.
- `_refreshBoard` guard: `_refreshBoard` (`KanbanProvider.ts:1430-1450`) has `_isRefreshing` / `_refreshPending` guards that coalesce rapid successive calls.

### Step 3: Verify kanban column rebuild picks up the new agent

**Correction from original plan:** `_refreshBoard` (`KanbanProvider.ts:1430-1450`) does **not** call `_refreshBoardImpl` directly. It delegates to `vscode.commands.executeCommand('switchboard.refreshUI', _workspaceRoot)`. The `refreshUI` command eventually triggers `_refreshBoardImpl` (line 1452) which reads custom agents from `state.json` via `_getCustomAgents` (line 1464) and builds columns via `_buildKanbanColumns` (line 1467). The end result is the same: after the save handler calls `_refreshBoard`, the new column appears after the async refresh cycle completes.

Confirm `buildKanbanColumns` in `agentConfig.ts` already filters for `agent.includeInKanban === true` (`agentConfig.ts:232-233`). This is correct — only agents with the checkbox checked become columns.

### Step 4: Verify sidebar receives the broadcast

`TaskViewerProvider.broadcastToWebviews()` posts to both the sidebar and setup panel (`TaskViewerProvider.ts:2774-2776`). The sidebar (`implementation.html`) already handles `customAgents` and calls `renderAgentList()` (`implementation.html:2945-2949`). The kanban webview also handles `customAgents` (`kanban.html:4519-4525`).

## Verification Plan

### Automated Tests

No existing test suite covers `KanbanProvider._handleMessage()` or `TaskViewerProvider` custom-agent methods. If a test infrastructure exists for IPC message handling, add:

1. **`saveCustomAgent` handler test**: Mock `_taskViewerProvider.handleSaveCustomAgent` and `getCustomAgents`, send a `saveCustomAgent` message with a valid agent object, assert `handleSaveCustomAgent` was called with correct args, assert `broadcastToWebviews` was called, assert `saveCustomAgentResult` success response was posted.
2. **`deleteCustomAgent` handler test**: Same pattern, assert `handleDeleteCustomAgent` called, assert cleanup of `visibleAgents`/`startupCommands`.
3. **`getCustomAgents` handler test**: Mock `getCustomAgents` to return a known array, assert `customAgents` response contains the expected array.
4. **`handleDeleteCustomAgent` cleanup test**: Set up state with `visibleAgents` and `startupCommands` entries for a role, call `handleDeleteCustomAgent`, assert both entries are deleted.

### Manual Verification

1. Open the kanban board → Agents tab → click "Add Custom Agent"
2. Fill in name, startup command, check "Include in kanban", click Save
3. **Expected**: Agent appears in the Agents tab list, the kanban gains a new column for the agent, and the sidebar shows the agent in its agent list
4. Reload VS Code window
5. **Expected**: The custom agent persists in all three locations (Agents tab, kanban column, sidebar)
6. Delete the custom agent
7. **Expected**: Agent disappears from all three locations
8. **Edge case — rapid save/delete**: Create agent, immediately delete it. Expected: no column appears, no error.
9. **Edge case — duplicate save**: Create agent, edit name, save again. Expected: agent updates in-place, no duplicate column.

## Risks

- **State.json corruption**: Using `updateState` (which has a 100ms debounced queue) is the same pattern used by all other state mutations in the extension. Risk is low.
- **Role collision**: The kanban webview already sanitizes the role before sending (`agentsTabToCustomAgentRole`). The backend `parseCustomAgents` deduplicates by role. Risk is low.
- **Kanban column flicker**: `_refreshBoard` is already called after many other user actions. No additional flicker risk.

---

**Recommendation:** Complexity 5 → **Send to Coder**.

## Reviewer Pass

### Stage 1 (Grumpy)
- **NIT: Missing Explicit Broadcast in Handlers:** The plan explicitly asked to include `this._taskViewerProvider?.broadcastToWebviews({ type: 'customAgents', customAgents });` in the `saveCustomAgent` and `deleteCustomAgent` IPC message handlers in `KanbanProvider.ts`. The implementation skipped this! However, `handleSaveCustomAgent` inside `TaskViewerProvider.ts` invokes `_postSidebarConfigurationState`, which *already* calls `kanbanProvider.postMessage({ type: 'customAgents' })`. While skipping explicit broadcasts violates the precise plan steps, it effectively prevents double-broadcasting, so it's acceptable.
- **NIT: Kanban Order Defaulting:** The webview sends `kanbanOrder: 0` if `includeInKanban` is checked. `parseCustomAgents` gracefully defaults to 0 or uses `DEFAULT_CUSTOM_AGENT_KANBAN_ORDER` if not finite. No issues here.
- **NIT: `updateState` Debounce Semantics:** The `await this.updateState(...)` call correctly awaits the debounce flush (100ms), ensuring the file is persisted by the time `_postSidebarConfigurationState` reads it back via `getCustomAgents`. This prevents race conditions.

### Stage 2 (Balanced)
- The implementation is completely correct and properly functional. The decision to rely on `TaskViewerProvider`'s internal broadcasting (`_postSidebarConfigurationState`) rather than adding redundant `broadcastToWebviews` calls in `KanbanProvider._handleMessage` is technically superior, avoiding duplicate IPC messages.
- The kanban webview's manual fetch on `saveCustomAgentResult` (`getCustomAgents`) ensures the UI stays perfectly in sync even with asynchronous kanban refreshes.
- No material fixes required.

**Status:** Verified and Complete.
