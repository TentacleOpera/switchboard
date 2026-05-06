# Add Analyst Terminal Integration to Planning Panel

## Goal
Enable the Planning Panel's "SEND TO ANALYST" button to send research prompts to the analyst terminal using the VS Code command pattern (same as KanbanProvider).

## Metadata
**Tags:** backend, UI
**Complexity:** 4

---

## User Review Required
No breaking changes. Users will be able to send research prompts directly from the Planning Panel to the analyst terminal.

## Complexity Audit

### Routine
- Register VS Code command `switchboard.sendToAnalystFromPlanningPanel` in `src/extension.ts` (follow pattern at lines 1587-1591)
- Register VS Code command `switchboard.checkAnalystAvailability` in `src/extension.ts`
- Add message handler cases in `src/services/PlanningPanelProvider.ts` (lines 683-712 already have placeholders)
- Add message response handler in `src/webview/planning.js` for `sendToAnalystResult` and `analystAvailabilityResult`
- UI button state management (SENT/FAILED/SEND TO ANALYST) in `src/webview/planning.js` (lines 147-161 already implemented)

### Complex / Risky
- Terminal resolution logic: Must handle IDE-suffixed terminal names (e.g., `analyst-VS Code:` vs `analyst`) via `normalizeAgentKey` and `stripIdeSuffix` helpers
- Direct terminal push vs inbox fallback: If terminal is not locally registered, message must fall back to inbox delivery via `_dispatchExecuteMessage`
- Error propagation: VS Code command execution errors must be caught and returned to webview for UI feedback

## Edge-Case & Dependency Audit

**Race Conditions:**
- Command execution race: Multiple rapid clicks on "SEND TO ANALYST" could queue multiple dispatches. Mitigation: UI disables button during send (lines 156-159 already set innerText to 'SENT' for 2 seconds).
- Terminal lookup race: Terminal may be closed between availability check and dispatch. Mitigation: `_getAgentNameForRole` re-reads state.json on each call; terminal existence re-verified at dispatch time.

**Security:**
- F-04 SECURITY: Agent name validation via `_isValidAgentName` must be performed before dispatch (prevents path traversal in inbox directory creation).
- F-08 SECURITY: Session token injection for inbox auth must be included for fallback inbox delivery.
- Prompt content: No sanitization needed as prompt is user-generated content dispatched to user's own terminal (trusted destination).

**Side Effects:**
- Terminal focus: Command will focus the analyst terminal window (via `_focusTerminalByName`), which may disrupt user's current context.
- Inbox directory creation: If terminal not locally available, creates `.switchboard/inbox/<agentName>/` directory.
- State persistence: No state mutations; purely dispatch operation.

**Dependencies & Conflicts:**
- None - The Kanban board has 0 active plans. No cross-plan conflicts detected.
- Requires `sendRobustText` utility from `src/services/terminalUtils.ts` (already imported in TaskViewerProvider).
- Depends on `registeredTerminals` Map from extension.ts (lines 462) being populated via `syncTerminalRegistryWithState`.
- Reuses existing `_getAgentNameForRole`, `_focusTerminalByName`, `_dispatchExecuteMessage` methods in TaskViewerProvider.

---

## Dependencies
None

---

## Current Architecture

### Existing Pattern (KanbanProvider)
```typescript
// KanbanProvider.ts
await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot)
```

### Desired Pattern (PlanningPanelProvider)
```typescript
// PlanningPanelProvider.ts
await vscode.commands.executeCommand('switchboard.sendToAnalystFromPlanningPanel', prompt)
```

---

## Adversarial Synthesis
Key risks: Terminal resolution complexity with IDE-suffixed names, inbox fallback path untested from Planning Panel context, lack of user feedback if analyst terminal closed between check and send. Mitigations: Use proven `_getAgentNameForRole` and `_dispatchExecuteMessage` methods from TaskViewerProvider, implement try/catch with postMessage error responses, add 2-second UI debounce on send button.

---

## Proposed Changes

### src/extension.ts

#### [MODIFY] `src/extension.ts`

**Context:** Register two new VS Code commands for analyst integration from Planning Panel.

**Logic:**
1. Add command registration after line 1686 (after `dispatchToCoderTerminal` command registration)
2. `switchboard.sendToAnalystFromPlanningPanel`: Delegates to `taskViewerProvider.handleSendToAnalystFromPlanningPanel(prompt)`
3. `switchboard.checkAnalystAvailability`: Returns `{ available: boolean }` by checking if analyst role is assigned in state.json

**Implementation:**
```typescript
// After line 1686 (after dispatchToCoderTerminalDisposable)

const sendToAnalystFromPlanningPanelDisposable = vscode.commands.registerCommand(
    'switchboard.sendToAnalystFromPlanningPanel',
    async (prompt: string): Promise<{ success: boolean; error?: string }> => {
        try {
            const result = await taskViewerProvider.handleSendToAnalystFromPlanningPanel(prompt);
            return { success: result };
        } catch (err) {
            return { success: false, error: String(err) };
        }
    }
);
context.subscriptions.push(sendToAnalystFromPlanningPanelDisposable);

const checkAnalystAvailabilityDisposable = vscode.commands.registerCommand(
    'switchboard.checkAnalystAvailability',
    async (): Promise<{ available: boolean }> => {
        const workspaceRoot = getPreferredWorkspaceRoot();
        if (!workspaceRoot) {
            return { available: false };
        }
        const analystAgent = await taskViewerProvider.getAgentNameForRole('analyst', workspaceRoot);
        return { available: !!analystAgent };
    }
);
context.subscriptions.push(checkAnalystAvailabilityDisposable);
```

**Edge Cases Handled:**
- No workspace open: Returns `{ available: false }`
- No analyst assigned: Returns `{ available: false }`
- Command execution error: Caught and returned as `{ success: false, error: ... }`

---

### src/services/TaskViewerProvider.ts

#### [MODIFY] `src/services/TaskViewerProvider.ts`

**Context:** Add public method to expose `_getAgentNameForRole` for command handler and implement analyst dispatch from Planning Panel.

**Logic:**
1. Add public wrapper `getAgentNameForRole(role, workspaceRoot)` that calls private `_getAgentNameForRole`
2. Add public method `handleSendToAnalystFromPlanningPanel(prompt: string): Promise<boolean>` that mirrors `_handleSendAnalystMessage` but returns boolean success

**Implementation:**
```typescript
// Add after line 5523 (after dispatchToCoderTerminal method)

/** Public accessor for role resolution (used by command handlers) */
public async getAgentNameForRole(role: string, workspaceRoot?: string): Promise<string | undefined> {
    return this._getAgentNameForRole(role, workspaceRoot);
}

/** Handle analyst dispatch from Planning Panel research tab */
public async handleSendToAnalystFromPlanningPanel(prompt: string): Promise<boolean> {
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace root found.');
        return false;
    }

    const targetAgent = await this._getAgentNameForRole('analyst', workspaceRoot);
    if (!targetAgent) {
        vscode.window.showErrorMessage("No agent assigned to role 'analyst'. Please assign a terminal first.");
        return false;
    }

    // F-04 SECURITY: Validate agent name
    if (!this._isValidAgentName(targetAgent)) {
        vscode.window.showErrorMessage(`Invalid analyst agent name: ${targetAgent}`);
        return false;
    }

    // Focus terminal for immediate feedback
    await this._focusTerminalByName(targetAgent);

    // Dispatch using existing pipeline
    await this._dispatchExecuteMessage(workspaceRoot, targetAgent, prompt, {
        source: 'planning-panel',
        type: 'analyst-research'
    });

    return true;
}
```

**Edge Cases Handled:**
- No workspace: Error message and return false
- No analyst role assigned: Error message and return false  
- Invalid agent name: F-04 security validation
- Terminal not open: `_dispatchExecuteMessage` handles inbox fallback automatically

---

### src/services/PlanningPanelProvider.ts

#### [MODIFY] `src/services/PlanningPanelProvider.ts` lines 683-712

**Context:** Replace placeholder handlers for `checkAnalystAvailability` and `sendToAnalyst` with actual VS Code command calls.

**Logic:**
1. Replace `case 'checkAnalystAvailability'` (lines 683-691) with command execution
2. Replace `case 'sendToAnalyst'` (lines 693-712) with command execution

**Implementation:**
```typescript
case 'checkAnalystAvailability': {
    try {
        const result = await vscode.commands.executeCommand<{ available: boolean }>(
            'switchboard.checkAnalystAvailability'
        );
        this._panel?.webview.postMessage({
            type: 'analystAvailabilityResult',
            available: result?.available ?? false
        });
    } catch (err) {
        this._panel?.webview.postMessage({
            type: 'analystAvailabilityResult',
            available: false
        });
    }
    break;
}

case 'sendToAnalyst': {
    const prompt = msg.prompt;
    if (!prompt) {
        this._panel?.webview.postMessage({
            type: 'sendToAnalystResult',
            success: false,
            error: 'No prompt provided'
        });
        break;
    }

    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
            'switchboard.sendToAnalystFromPlanningPanel',
            prompt
        );
        this._panel?.webview.postMessage({
            type: 'sendToAnalystResult',
            success: result?.success ?? false,
            error: result?.error
        });
    } catch (err) {
        this._panel?.webview.postMessage({
            type: 'sendToAnalystResult',
            success: false,
            error: String(err)
        });
    }
    break;
}
```

**Edge Cases Handled:**
- Command not registered: Caught and returns `available: false` / `success: false`
- No prompt provided: Returns error before calling command
- Command throws: Caught and returned to webview

---

### src/webview/planning.js

#### [MODIFY] `src/webview/planning.js`

**Context:** Add message response handlers for `analystAvailabilityResult` and `sendToAnalystResult` (lines 221 in original placeholder, but actually needs to be added in message handler).

**Logic:**
1. Find the message handler switch statement (around line 300-400 based on existing patterns)
2. Add cases for `analystAvailabilityResult` and `sendToAnalystResult`
3. `analystAvailabilityResult`: Show/hide the "SEND TO ANALYST" button based on availability
4. `sendToAnalystResult`: Update button state (already partially implemented at lines 147-161 but needs response handler)

**Clarification:** The button click handler at lines 147-161 already posts `sendToAnalyst` message and updates UI optimistically. The response handler should handle error states and confirm success.

**Implementation:**
```javascript
// In the message handler switch statement (near other case handlers)

case 'analystAvailabilityResult': {
    const sendToAnalystBtn = document.getElementById('btn-send-to-analyst');
    if (sendToAnalystBtn) {
        sendToAnalystBtn.style.display = message.available ? 'block' : 'none';
    }
    break;
}

case 'sendToAnalystResult': {
    const sendToAnalystBtn = document.getElementById('btn-send-to-analyst');
    if (sendToAnalystBtn) {
        if (message.success) {
            sendToAnalystBtn.innerText = 'SENT';
            setTimeout(() => {
                if (sendToAnalystBtn) sendToAnalystBtn.innerText = 'SEND TO ANALYST';
            }, 2000);
        } else {
            sendToAnalystBtn.innerText = 'FAILED';
            console.error('[Research] Failed to send to analyst:', message.error);
            setTimeout(() => {
                if (sendToAnalystBtn) sendToAnalystBtn.innerText = 'SEND TO ANALYST';
            }, 2000);
        }
    }
    break;
}
```

**Edge Cases Handled:**
- Button may not exist (null check)
- Success: Shows "SENT" for 2 seconds
- Failure: Shows "FAILED", logs error, resets after 2 seconds

---

## Implementation Plan (Legacy - Preserved)

### Phase 1: Register VS Code Command

**File:** `src/extension.ts`

**Changes:**
**Clarification:** Implementation updated to use `TaskViewerProvider` methods rather than direct terminal manager access.

---

## Verification Plan

### Automated Tests
- None required - follows established patterns already tested via `dispatchToCoderTerminal` and `_handleSendAnalystMessage`

### Manual Testing
1. **Setup:**
   - Open Switchboard workspace in VS Code
   - Create terminal named "analyst" and register it to `analyst` role via sidebar
   - Open Planning Panel via command palette or sidebar

2. **Availability Check:**
   - Navigate to Research tab in Planning Panel
   - Verify "SEND TO ANALYST" button is visible when analyst terminal is registered
   - Unregister analyst terminal
   - Verify button is hidden

3. **Send Prompt:**
   - Enter research topic in text area
   - Click "SEND TO ANALYST"
   - Verify button shows "SENT" then returns to "SEND TO ANALYST"
   - Verify analyst terminal receives prompt text
   - Verify terminal is focused

4. **Error Cases:**
   - Close analyst terminal after availability check but before sending
   - Click "SEND TO ANALYST"
   - Verify button shows "FAILED" and error logged to console
   - Verify error message shown via `vscode.window.showErrorMessage`

5. **Integration:**
   - Test with Kanban panel open simultaneously (ensure no conflicts)
   - Test with only Planning Panel open (no Kanban)
   - Test with multiple workspace roots

---

## Verification Steps (Legacy - Preserved)

1. **Manual Testing:**
   - Open Planning Panel
   - Verify "SEND TO ANALYST" button appears when analyst is available
   - Click button, verify prompt is sent to analyst terminal
   - Check analyst terminal receives the prompt
   - Test error case (no analyst terminal running)

2. **Integration Testing:**
   - Test with Kanban panel also open (ensure no conflicts)
   - Test with only Planning Panel open

---

## Files Changed

|| File | Changes |
||------|---------|
|| `src/extension.ts` | Register `switchboard.sendToAnalystFromPlanningPanel` and `switchboard.checkAnalystAvailability` commands |
|| `src/services/PlanningPanelProvider.ts` | Replace placeholder handlers with VS Code command calls |
|| `src/webview/planning.js` | Add sendToAnalystResult message handler (already done in previous plan) |

---

## Research Required

Before implementation, need to:

1. **Find how terminal manager is accessed in extension.ts**
   - Search for `triggerAgentFromKanban` implementation
   - Copy the same pattern for accessing terminal manager

2. **Verify command registration location**
   - Find where other `switchboard.*` commands are registered
   - Add new commands in the same location

---

## Estimated Effort

- **Phase 1** (Register Commands in extension.ts): 15 minutes
- **Phase 2** (Add TaskViewerProvider methods): 20 minutes
- **Phase 3** (Update PlanningPanelProvider handlers): 15 minutes
- **Phase 4** (Update planning.js response handlers): 10 minutes
- **Testing**: 30 minutes

**Total:** ~1.5 hours

---

## Code Review Results

**Reviewer:** Antigravity (Claude Opus 4.6 Thinking)
**Date:** 2026-05-02
**Status:** ✅ APPROVED

### Files Changed (Validated)

| File | Status |
|------|--------|
| `src/extension.ts` (lines 1688-1712) | ✅ Commands registered correctly with try/catch |
| `src/services/TaskViewerProvider.ts` (lines 5562-5597) | ✅ Public wrappers + F-04 security validation |
| `src/services/PlanningPanelProvider.ts` (lines 683-729) | ✅ Upgraded from placeholder to live command execution |
| `src/webview/planning.js` (lines 147-169, 1507-1533) | ✅ Button handlers + message response handlers |

### Findings

| ID | Severity | Description | Resolution |
|----|----------|-------------|------------|
| G-01 | MAJOR | `originalText` variable scoped inside `try` but referenced in `catch` (shared code surface from research tab plan) | **FIXED** — hoisted `originalText` above `try` block |
| G-02 | NIT | `handleSendToAnalystFromPlanningPanel` doesn't distinguish dispatch failure types | DEFERRED — command handler propagation is correct |
| G-03 | NIT | Terminal focus happens before dispatch (may disrupt user if dispatch fails) | DEFERRED — acceptable UX trade-off |

### Verification

- **TypeScript compilation:** ✅ No new errors (2 pre-existing dynamic import extension warnings)
- **Code review:** All plan requirements implemented exactly as specified

### Remaining Risks

- Terminal resolution with IDE-suffixed names relies on proven `_getAgentNameForRole` path (tested via Kanban flow)
- Inbox fallback path via `_dispatchExecuteMessage` untested from Planning Panel context specifically

**Recommendation:** Send to Coder (Complexity 4 ≤ 6)
