# MCP Monitor Permanently Leaks Into Open Agent Terminals Map

## Goal

Stop the MCP (Comms) Monitor terminal from permanently lingering in the "open agent terminals" map / agent grid after it is stopped, closed, or reset. The monitor is a transient, on-demand terminal and must be removed from the grid when its lifecycle ends, while built-in agent roles remain unaffected.

### Problem
When the user turns on the MCP (Comms) Monitor once via `launchMcpMonitorTerminal()`, the `mcp_monitor` role is permanently added to the "open agent terminals" map. Even after the monitor terminal is stopped or killed, it reappears every time the agent grid is opened (`createAgentGrid`). The user reports this is **not supposed to happen** — the MCP monitor should be a transient, on-demand terminal that is removed from the agent terminals map when stopped.

### Background Context
The MCP Monitor (a.k.a. "Comms Monitor") is a special on-demand terminal launched via a dedicated three-step flow (launch → check auth → start polling). It is NOT one of the standard built-in agent roles (planner, lead, coder, etc.) that the agent grid manages. It has its own lifecycle: `launchMcpMonitorTerminal()` / `stopMcpMonitorTerminal()`.

### Root Cause Analysis
The bug has two compounding causes:

1. **`setVisibleAgent('mcp_monitor', true)` is called on launch but never undone on stop.**
   - `launchMcpMonitorTerminal()` (TaskViewerProvider.ts:20643) calls `await this.setVisibleAgent('mcp_monitor', true)` to persistently mark the role as visible in the `visibleAgents` config (stored via `GlobalIntegrationConfigService` — persistent global state).
   - `stopMcpMonitorTerminal()` (TaskViewerProvider.ts:20751) disposes the terminal and stops polling, but **never calls `setVisibleAgent('mcp_monitor', false)`**.
   - `handleTerminalClosed()` (TaskViewerProvider.ts:15890) detects the MCP monitor closing and stops the polling loop, but also **never resets `visibleAgents.mcp_monitor`**.
   - Because `visibleAgents.mcp_monitor` remains `!== false`, `createAgentGrid()` (extension.ts:2661-2671) unconditionally includes the MCP monitor in every agent grid opening — so it appears "permanently added."

2. **`_registeredTerminals` in-memory map is never cleaned up for the MCP monitor.**
   - `launchMcpMonitorTerminal()` adds the terminal to `_registeredTerminals` (TaskViewerProvider.ts:20653).
   - `handleTerminalClosed()` cleans `state.terminals` (persistent) and `_terminalAgentInfo`, but does **not** delete from `_registeredTerminals` (the in-memory dispatch map). The stale reference to the disposed terminal persists until a full deregistration or workspace switch.

## Metadata
- **Tags:** bugfix, backend
- **Complexity:** 4
- **Affected Files:** `src/services/TaskViewerProvider.ts`

## User Review Required

Yes — review the deferred "Extension restart" edge case (Edge-Case #4 below) and decide whether the activation-time sweep follow-up should be bundled into this fix or tracked separately. The primary three changes are safe to implement as-is; the restart sweep is a non-blocking enhancement.

## Complexity Audit

### Routine
- Adding `setVisibleAgent('mcp_monitor', false)` calls to `stopMcpMonitorTerminal()` (TaskViewerProvider.ts:20751) and the MCP monitor branch of `handleTerminalClosed()` (TaskViewerProvider.ts:15937-15941).
- Deleting the MCP monitor entry from `_registeredTerminals` on stop/close (key: `this._suffixedName(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME)`, i.e. `this._suffixedName('Comms Monitor')`).
- Cleaning up the `state.terminals` entry explicitly in `stopMcpMonitorTerminal()` (belt-and-suspenders alongside the async `handleTerminalClosed` cleanup).
- Resetting `visibleAgents.mcp_monitor` in `_deregisterAllTerminals()` (TaskViewerProvider.ts:15953, after line 16000).

### Complex / Risky
- **Race condition consideration:** `stopMcpMonitorTerminal()` calls `live.dispose()`, which asynchronously triggers `handleTerminalClosed()`. Both paths will attempt to clean up. The cleanup must be idempotent — calling `setVisibleAgent('mcp_monitor', false)` twice is harmless (sets the same value), and `Map.delete` on a missing key is a no-op. No special guarding needed, but the order matters: `stopMcpMonitorTerminal()` should clean up state synchronously before relying on the async close event.
- **`setVisibleAgent` read-modify-write:** `setVisibleAgent` (TaskViewerProvider.ts:20765) does `getAgentConfig('visibleAgents')` → mutate → `setAgentConfig`. Two concurrent close paths both writing `mcp_monitor: false` is benign (equal values). This is a pre-existing atomicity characteristic of `setVisibleAgent`, not introduced by this fix; not in scope to refactor here.
- **`createAgentGrid` interaction:** Once `visibleAgents.mcp_monitor` is `false`, `createAgentGrid` (extension.ts:2661) will no longer include the monitor. But if the user manually re-launches the monitor, `launchMcpMonitorTerminal()` sets it back to `true` — this is correct behavior. The fix only ensures the flag is reset when the terminal is stopped/closed.

## Edge-Case & Dependency Audit

- **Race Conditions:** `stopMcpMonitorTerminal()` → `live.dispose()` → async `handleTerminalClosed()`. Both now reset visibility and delete from `_registeredTerminals`. Idempotent for equal values; `Map.delete` is a no-op on missing keys. `stopMcpMonitorTerminal` performs its cleanup synchronously so state is consistent even if the close event is delayed. See "Complex / Risky" above for the pre-existing `setVisibleAgent` read-modify-write note.
- **Security:** No security implications. No secrets, credentials, or elevated operations touched. `visibleAgents` is a UI-visibility flag only.
- **Side Effects:**
  - `setVisibleAgent('mcp_monitor', false)` writes to persistent global config via `GlobalIntegrationConfigService`. Cost: one global-state write per stop/close. Acceptable.
  - `_registeredTerminals?.delete(...)` mutates the in-memory dispatch map; safe — the disposed terminal is no longer dispatchable.
  - `state.terminals` cleanup in `stopMcpMonitorTerminal` duplicates the generic `handleTerminalClosed` cleanup; harmless redundancy.
- **Dependencies & Conflicts:**
  - `stopMcpMonitorPolling()` (TaskViewerProvider.ts:20740) is deliberately NOT modified — polling stop must keep the terminal in the grid. Only `stopMcpMonitorTerminal` (full kill) removes it.
  - `clearRegisteredTerminalsMap()` (workspace switch) clears `_registeredTerminals` but not `visibleAgents`; since `visibleAgents` is global config this is acceptable and workspace-independent.
  - `_deregisterAllTerminals()` already clears `_registeredTerminals` and `state.terminals`; this fix adds the missing `visibleAgents.mcp_monitor` reset so a dead column doesn't survive a full reset.

1. **User closes the terminal manually (X button) without clicking "Stop":** `handleTerminalClosed` fires and must reset `visibleAgents.mcp_monitor`. This is the most common path — covered by the fix in `handleTerminalClosed`.

2. **User clicks "Stop" button:** `stopMcpMonitorTerminal()` calls `live.dispose()`, which triggers `handleTerminalClosed`. Both paths clean up. The explicit cleanup in `stopMcpMonitorTerminal()` ensures state is consistent even if the close event is delayed.

3. **`deregisterAllTerminals()` (Reset button):** This already clears `_registeredTerminals` entirely and `state.terminals = {}`. However, it does NOT reset `visibleAgents.mcp_monitor`. After a reset, if the user opens the agent grid, the MCP monitor would still appear (as a dead column) because `visibleAgents.mcp_monitor` is still `true`. The fix should also reset `visibleAgents.mcp_monitor` in `_deregisterAllTerminals()`.

4. **Extension restart (KNOWN LIMITATION — deferred follow-up):** `visibleAgents` is persisted in global state. On restart, if `mcp_monitor` was left `true` from a previous session, the agent grid will include it. The fix in `handleTerminalClosed` won't help here since there's no close event after restart. A follow-up activation-time sweep should check whether the MCP monitor terminal actually exists (using the existing `_isMcpMonitorTerminalRunning()` helper at TaskViewerProvider.ts:20771) and reset the flag if not. This is a non-blocking secondary fix; the primary fix is ensuring `stopMcpMonitorTerminal` and `handleTerminalClosed` reset the flag. Tracked here so it survives into code review.

5. **Workspace switch:** `clearRegisteredTerminalsMap()` clears `_registeredTerminals` but not `visibleAgents`. Since `visibleAgents` is global config, this is acceptable — the flag state is workspace-independent.

## Dependencies

None. This is a self-contained bugfix in `src/services/TaskViewerProvider.ts` with no dependency on other plans or in-flight work.

## Adversarial Synthesis

Key risks: (1) a read-modify-write race in `setVisibleAgent` is exercised twice per stop (once direct, once via async `handleTerminalClosed`) — benign here because both write the same boolean, but it is a pre-existing atomicity gap not in scope to fix; (2) the extension-restart stale-flag case is a real, deferred bug that will re-add a dead `mcp_monitor` column after a window reopen because no close event fires to reset global state. Mitigations: keep the three primary changes (stop / close / reset paths) as written — they fully resolve the user-reported leak; record the activation-time sweep (using the existing `_isMcpMonitorTerminalRunning` helper) as an explicit follow-up so it is not lost; add a `console.warn` to the Change 3 `try/catch` so a config-write failure is not silently swallowed.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Clean up all state in `stopMcpMonitorTerminal()` (TaskViewerProvider.ts:20751-20763)

Add visibility reset, `_registeredTerminals` cleanup, and `state.terminals` cleanup to `stopMcpMonitorTerminal()` so it's self-contained and doesn't rely solely on the async `handleTerminalClosed` event. Belt-and-suspenders: the generic `handleTerminalClosed` cleanup also runs when `live.dispose()` fires the close event, but the explicit cleanup here guarantees consistent state even if the close event is delayed or dropped.

```typescript
public async stopMcpMonitorTerminal(): Promise<void> {
    const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME));
    const suffixedKey = this._suffixedName(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME);
    const live = (vscode.window.terminals || []).find(t => {
        const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
        return tName === strippedTarget && t.exitStatus === undefined;
    });
    if (live) {
        live.dispose();
    }
    // Clean up in-memory dispatch map
    this._registeredTerminals?.delete(suffixedKey);
    // Reset visibility so createAgentGrid no longer includes the monitor
    await this.setVisibleAgent('mcp_monitor', false);
    // Clean up persistent state entry
    await this.updateState(async (state: any) => {
        if (state.terminals && state.terminals[suffixedKey]) {
            delete state.terminals[suffixedKey];
        }
    });
    this.clearTerminalAgentInfo(suffixedKey);
    await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: false });
    this._stopMcpMonitorLoop();
    await this._postMcpMonitorConfig();
    this.refresh();
}
```

#### Change 2: Reset visibility in `handleTerminalClosed()` MCP monitor branch (TaskViewerProvider.ts:15937-15941)

In the existing MCP monitor detection block in `handleTerminalClosed()`, add the visibility reset and `_registeredTerminals` cleanup. The generic cleanup above this block already handles `state.terminals` (line 15917) and `_terminalAgentInfo` (line 15924); this addition completes the trio.

```typescript
if (closedStripped === monitorStripped) {
    await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: false });
    this._stopMcpMonitorLoop();
    // Reset visibility so the monitor doesn't reappear in the agent grid
    await this.setVisibleAgent('mcp_monitor', false);
    // Clean up in-memory dispatch map
    this._registeredTerminals?.delete(this._suffixedName(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME));
    await this._postMcpMonitorConfig();
}
```

#### Change 3: Reset MCP monitor visibility in `_deregisterAllTerminals()` (TaskViewerProvider.ts:16000-16001)

After `state.terminals = {}` and `this._registeredTerminals?.clear()` (line 16000), add a scoped reset of the MCP monitor visibility flag. Only `mcp_monitor` is reset — built-in agent visibility is meant to persist across resets by design. Use a `console.warn` (not a silent swallow) so a config-write failure is observable.

```typescript
// Reset the MCP monitor visibility flag so a dead monitor column doesn't
// reappear in the agent grid after a full reset.
try {
    await this.setVisibleAgent('mcp_monitor', false);
} catch (e) {
    console.warn('[TaskViewerProvider] Failed to reset mcp_monitor visibility during deregister-all:', e);
}
```

## Verification Plan

> Per session directives: **compilation and automated tests are SKIPPED**. Verification is manual, via an installed VSIX.

### Automated Tests
Skipped per session directive. No unit/integration tests will be run as part of this plan's verification.

### Manual Verification

1. **Launch → Stop → Open Agent Grid:** Launch the MCP monitor via the COMMS tab. Click "Stop." Open the agent grid (status bar "Agents" button). Confirm the MCP monitor does NOT appear as a terminal/column.

2. **Launch → Close terminal manually → Open Agent Grid:** Launch the MCP monitor. Close the terminal via the X button in the terminal panel. Open the agent grid. Confirm the MCP monitor does NOT appear.

3. **Launch → Reset → Open Agent Grid:** Launch the MCP monitor. Click the "Reset" status bar button (deregister all terminals). Open the agent grid. Confirm the MCP monitor does NOT appear.

4. **Launch → Stop → Relaunch:** Launch the MCP monitor, stop it, then launch it again. Confirm it works correctly on relaunch (the `setVisibleAgent('mcp_monitor', true)` in `launchMcpMonitorTerminal` re-enables it).

5. **Check `visibleAgents` state after stop:** After stopping the monitor, inspect the global config to confirm `visibleAgents.mcp_monitor` is `false` (or absent), not `true`.

6. **Check `_registeredTerminals` after stop:** After stopping, confirm `_registeredTerminals` no longer contains the MCP monitor key (no stale disposed-terminal reference).

7. **Known limitation check (informational, not a pass/fail):** Stop the monitor, reload the VS Code window, open the agent grid. A dead `mcp_monitor` column MAY still appear — this is the deferred restart-sweep follow-up (Edge-Case #4), not a regression of this fix. Confirm the three primary paths (stop / close-X / reset) all pass before considering the restart case.

---

**Recommendation:** Complexity 4 → **Send to Coder**. Routine single-file bugfix reusing existing helpers; one deferred non-blocking follow-up (activation-time sweep) recorded above.

## Review Findings

**Stage 1 (Grumpy Principal Engineer):** Welcome to the review. I came looking for blood and found... a clean kill. All three changes (stop/close/reset paths) match the plan verbatim. The double-trigger from `stopMcpMonitorTerminal → live.dispose() → handleTerminalClosed` is idempotent as the plan predicted — both paths write `mcp_monitor: false` and `Map.delete` is a no-op on missing keys. The `if (cleanedTerminalName)` guard at line 15920 prevents the spurious `clearTerminalAgentInfo(undefined)` call I was ready to flag. The `this.refresh()` addition is debounced (200ms) and doesn't double-trigger with `handleTerminalClosed`'s `_refreshTerminalStatuses()`. No orphaned references to removed identifiers. The `_deregisterAllTerminals` reset is correctly scoped to `mcp_monitor` only — built-in agent visibility persists by design. The extension-restart stale-flag case (Edge-Case #4) remains a known deferred limitation, not a regression.

- **NIT** `TaskViewerProvider.ts:15940` — `_registeredTerminals?.delete(...)` in `handleTerminalClosed` only fires for the MCP monitor branch; the generic close path never cleans `_registeredTerminals` for other terminal types, meaning non-MCP terminals may also leak stale in-memory references until a rebuild from state.json. Pre-existing, out of scope for this plan, but worth a future ticket.
- **NIT** `TaskViewerProvider.ts:20784` — `this.refresh()` is a new addition not in the original method; harmless (debounced) but technically redundant since `handleTerminalClosed` will fire and refresh anyway. Keep it — belt-and-suspenders matches the plan's philosophy.

**Stage 2 (Balanced):** No CRITICAL or MAJOR findings. Both NITs are pre-existing or cosmetic — no code fixes applied. The implementation is plan-compliant and regression-safe across all traced call paths (`launchMcpMonitorTerminal` → `stopMcpMonitorTerminal` → `handleTerminalClosed` → `_deregisterAllTerminals` → `createAgentGrid`).

**Files changed:** `src/services/TaskViewerProvider.ts` (3 edits: lines 15937-15940, 16005-16011, 20762-20784).
**Validation:** Compilation and automated tests skipped per session directive. Manual verification per plan's 7-step checklist (VSIX-based, not run in this review). Typecheck not run (skipped per directive).
**Remaining risks:** (1) Edge-Case #4 — extension restart leaves `visibleAgents.mcp_monitor = true` in global state with no close event to reset it; deferred activation-time sweep follow-up. (2) Generic `handleTerminalClosed` does not clean `_registeredTerminals` for non-MCP terminals — pre-existing leak, out of scope.
