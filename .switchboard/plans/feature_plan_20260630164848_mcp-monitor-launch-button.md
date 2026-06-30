# Add Launch Button for MCP Monitor Terminal in Automation Tab

## Goal

The MCP Monitor in the **Automation** tab has no way to actually launch the monitor terminal from the UI. The status line tells the user to "launch one as the `mcp_monitor` role with a cheap/local model and permission-bypass flags" and gives a raw CLI command — but there is no button to do it. The user is left to figure out that they must (1) go to the **Agents** tab, (2) enable the hidden `mcp_monitor` agent visibility (default: off), (3) go back and click the main **Agents** button to create the full agent grid — which spawns every visible agent terminal, not just the monitor. There is no single-action "Launch Monitor" path.

### Problem Analysis & Root Cause

**What exists today:**

1. **The MCP Monitor loop** (`TaskViewerProvider._startMcpMonitorLoop` at `:20123`) fires on an interval and calls `_mcpMonitorTick()` (`:20153`). The tick resolves a terminal named "MCP Monitor" from `vscode.window.terminals` — if none is found, the tick silently no-ops (`:20165-20168`).

2. **The status line** in the automation tab (`kanban.html:7669-7673`) shows:
   - 🟢 "Monitor terminal: running" if a live "MCP Monitor" terminal is found
   - 🔴 "No monitor terminal running: launch one as the `mcp_monitor` role with a cheap/local model and permission-bypass flags (e.g. `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`)"

   This is a dead end — it tells the user *what* to do but provides no button or link to do it.

3. **The only terminal creation path** is `createAgentGrid()` in `extension.ts:2628`, triggered by the main **Agents** button (`switchboard.createAgentGrid` command). It creates terminals for *all* visible agents. The MCP Monitor terminal is only included if `visibleAgents.mcp_monitor !== false` (`extension.ts:2693,2701-2703`).

4. **`mcp_monitor` is hidden by default** — `getVisibleAgents()` returns `mcp_monitor: false` (`TaskViewerProvider.ts:3893`). So clicking the Agents button does NOT create the MCP Monitor terminal unless the user has already gone to the Agents tab and toggled it visible.

5. **The autoban terminal creation path** (`addAutobanTerminalFromKanban` → `_createAutobanTerminal`) cannot be used for `mcp_monitor` because it is explicitly filtered out as a non-pool role (`TaskViewerProvider.ts:7420-7422` — "Roles like 'jules_monitor' are not in the pool; passing them to _createAutobanTerminal raises an error").

**Root cause:** The MCP Monitor feature was built with the assumption that the user would manually configure the `mcp_monitor` agent role as visible and then use the general Agents grid button. There is no dedicated, single-purpose launch path for the monitor terminal. The status line's instruction to "launch one as the `mcp_monitor` role" is a manual CLI instruction with no UI affordance, making the feature effectively unusable without reading documentation.

## Metadata

**Tags:** feature, ui, automation, mcp, terminal
**Complexity:** 4

## Complexity Audit

### Routine
- Add a "Launch Monitor Terminal" button to the MCP Monitor config panel in `kanban.html`, shown when no monitor terminal is running.
- Add a new message type (`launchMcpMonitorTerminal`) in the kanban webview → `KanbanProvider` message handler.
- Add a new method on `TaskViewerProvider` to create just the MCP Monitor terminal (create terminal, register it, send startup command) — modeled on the per-agent loop inside `createAgentGrid()` but scoped to a single role.
- Register a new VS Code command `switchboard.launchMcpMonitorTerminal` in `extension.ts`.

### Complex / Risky
- **Terminal creation must match the singleton guard's resolution logic.** `_mcpMonitorTick()` and `_isMcpMonitorTerminalRunning()` both resolve the terminal by stripping IDE suffixes and normalizing the name "MCP Monitor" (`TaskViewerProvider.ts:20159-20162,20247-20250`). The new launch method must create a terminal whose name resolves to the same normalized key, otherwise the tick will never find it. The grid creation path uses `name: agent.name` (i.e., "MCP Monitor") with `vscode.TerminalLocation.Panel` — the new method must do the same.
- **Startup command must be sent after shell readiness.** `createAgentGrid()` waits for `onDidStartTerminalShellExecution` before sending the startup command (`extension.ts:2862-2886`), with a 5s safety timeout. The new launch method must replicate this wait — sending the command before the shell is ready will silently fail. The fallback startup command for `mcp_monitor` is `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"` (`TaskViewerProvider.ts:3854`), retrieved via `getAgentStartupCommand('mcp_monitor')`.
- **Visibility auto-enable.** If the user clicks "Launch Monitor Terminal" but `mcp_monitor` is not visible, the terminal should still be created — the launch button is a direct action, not conditional on the Agents-tab visibility toggle. However, to avoid the `clearGridBlockers()` path in `createAgentGrid()` disposing the terminal on the next Agents-button press, the launch method should also set `visibleAgents.mcp_monitor = true` so the terminal is recognized as a managed grid terminal going forward.

## Edge-Case & Dependency Audit

- **Terminal already exists:** If a live "MCP Monitor" terminal is already running, the launch button should be hidden (the status line already shows 🟢 running). If the user clicks launch and a terminal exists but is exited (zombie), the method should dispose the zombie and create a fresh one.
- **Multiple windows:** The singleton guard in `_mcpMonitorTick()` ensures only the window with a live monitor terminal dispatches ticks. Launching from window B when window A already has a monitor terminal would create a second terminal — but only one will receive ticks (whichever the tick in each window resolves). This is acceptable: the user explicitly requested a launch. The status line will show 🟢 in both windows if both have a terminal, but only one window's tick will fire (the other's tick resolves its own local terminal). This matches the existing design.
- **Shell not ready / command fails:** The 5s safety timeout from `createAgentGrid()` must be replicated. If the shell never reports ready, the startup command is sent anyway (best-effort), matching the existing grid behavior.
- **No `claude` binary on PATH:** If the startup command fails (binary not found), the terminal will show a shell error. This is the same behavior as the general Agents grid — no special handling needed. The terminal is created and registered regardless; the user can manually type a different command.
- **Dependency on existing plan:** The plan `feature_plan_20260625120003_mcp-monitor-dropdown-reverts-and-misplaced.md` fixes a config-echo bug where the dropdown reverts to Off. That bug does not block this feature — the launch button operates independently of the dropdown's persisted state. However, if both plans are implemented, the dropdown echo fix should land first so that enabling the monitor and launching the terminal work in sequence without the dropdown snapping back.
- **Migration:** No migration needed. `visibleAgents` is an existing shipped config key in `~/.switchboard/integration-config.json`. Setting `mcp_monitor: true` is an additive write that preserves all other keys (the existing `loadGlobal`/`saveGlobal` round-trips the whole object).

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

**Add a new public method `launchMcpMonitorTerminal()`:**

```typescript
public async launchMcpMonitorTerminal(): Promise<void> {
    const targetName = 'MCP Monitor';
    const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(targetName));

    // Dispose any zombie (exited) terminal with the same name
    const existing = vscode.window.terminals.find(t => {
        const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
        return tName === strippedTarget;
    });
    if (existing && existing.exitStatus !== undefined) {
        existing.dispose();
    }

    // If a live terminal already exists, just reveal it
    const live = vscode.window.terminals.find(t => {
        const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
        return tName === strippedTarget && t.exitStatus === undefined;
    });
    if (live) {
        live.show();
        return;
    }

    // Auto-enable mcp_monitor visibility so createAgentGrid doesn't dispose it
    await this.setVisibleAgent('mcp_monitor', true);

    // Create the terminal
    const terminal = vscode.window.createTerminal({
        name: targetName,
        location: vscode.TerminalLocation.Panel,
    });
    terminal.show();
    try {
        await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
    } catch { /* ignore */ }

    // Register in state
    await this.updateState(async (state: any) => {
        if (!state.terminals) state.terminals = {};
        const key = this._suffixedName(targetName);
        if (!state.terminals[key]) state.terminals[key] = {};
        state.terminals[key].purpose = 'agent-grid';
        state.terminals[key].role = 'mcp_monitor';
        state.terminals[key].friendlyName = targetName;
        state.terminals[key].lastSeen = new Date().toISOString();
        state.terminals[key].ideName = vscode.env.appName;
    });
    this.refresh();

    // Wait for shell readiness, then send startup command
    const cmd = await this.getAgentStartupCommand('mcp_monitor');
    if (cmd && cmd.trim()) {
        const shellReady = new Promise<void>((resolve) => {
            const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
                if (e.terminal === terminal) {
                    disposable.dispose();
                    resolve();
                }
            });
            setTimeout(() => { disposable.dispose(); resolve(); }, 5000);
        });
        await shellReady;
        terminal.sendText(cmd.trim(), true);
    }

    // Push updated status to kanban
    await this._postMcpMonitorConfig();
}
```

**Add a `setVisibleAgent` helper** (if one does not already exist — check during implementation; the existing `getVisibleAgents` reads from `GlobalIntegrationConfigService`, so the setter should write there additively):

```typescript
public async setVisibleAgent(role: string, visible: boolean): Promise<void> {
    const config = await GlobalIntegrationConfigService.getAgentConfig<Record<string, boolean>>('visibleAgents') || {};
    config[role] = visible;
    await GlobalIntegrationConfigService.setAgentConfig('visibleAgents', config);
}
```

### File: `src/extension.ts`

**Register a new command:**

```typescript
const launchMcpMonitorTerminalDisposable = vscode.commands.registerCommand('switchboard.launchMcpMonitorTerminal', async () => {
    await taskViewerProvider.launchMcpMonitorTerminal();
});
context.subscriptions.push(launchMcpMonitorTerminalDisposable);
```

### File: `src/services/KanbanProvider.ts`

**Add a message handler case** (in the `switch (msg.type)` block, near the existing `setMcpMonitorConfig` case at `:5504`):

```typescript
case 'launchMcpMonitorTerminal': {
    await vscode.commands.executeCommand('switchboard.launchMcpMonitorTerminal');
    break;
}
```

### File: `src/webview/kanban.html`

**Replace the dead-end status line (lines 7669-7673)** with a status line that includes a launch button when no terminal is running:

```js
// Status Line
const statusLine = document.createElement('div');
statusLine.style.cssText = 'margin-top:8px; padding-top:6px; border-top:1px dashed var(--border-color); font-size:9px; line-height:1.3;';
if (isMcpMonitorTerminalRunning) {
    statusLine.innerHTML = '🟢 <strong>Monitor terminal:</strong> running';
} else {
    statusLine.innerHTML = '🔴 <strong>No monitor terminal running.</strong>';
    const launchBtn = document.createElement('button');
    launchBtn.textContent = 'Launch Monitor Terminal';
    launchBtn.style.cssText = 'display:block; margin-top:6px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--accent-teal); color:var(--bg-primary); border:none; border-radius:3px;';
    guardInteraction(launchBtn);
    launchBtn.addEventListener('click', () => {
        launchBtn.disabled = true;
        launchBtn.textContent = 'Launching…';
        postKanbanMessage({ type: 'launchMcpMonitorTerminal' });
    });
    statusLine.appendChild(launchBtn);
}
mcpConfigPanel.appendChild(statusLine);
```

The button sends a `launchMcpMonitorTerminal` message to the host, which creates the terminal, sends the startup command, and pushes the updated `isMcpMonitorTerminalRunning` status back. The next `renderAutobanPanel()` cycle will show 🟢 running.

## Verification Plan

1. Open the Switchboard kanban board in VS Code.
2. Click the **Automation** tab.
3. Set the MCP Monitor dropdown to **On** to expand the config panel.
4. Verify the status line shows 🔴 "No monitor terminal running." with a **Launch Monitor Terminal** button below it.
5. Click **Launch Monitor Terminal**. Verify:
   - The button text changes to "Launching…" and disables.
   - A new terminal named "MCP Monitor" appears in the VS Code terminal panel.
   - The startup command (`claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`) is sent to the terminal.
6. Wait for the next kanban refresh cycle (~5s). Verify the status line now shows 🟢 "Monitor terminal: running" and the launch button is gone.
7. Click the main **Agents** button. Verify the MCP Monitor terminal is NOT disposed (it should be recognized as a managed grid terminal because `visibleAgents.mcp_monitor` was auto-set to `true`).
8. Close the MCP Monitor terminal manually. Verify the status line reverts to 🔴 with the launch button.
9. Click **Launch Monitor Terminal** again. Verify a fresh terminal is created (zombie disposal path).
10. Open a second VS Code window with the same workspace. Verify the second window also shows 🟢 if it resolves the same terminal, or 🔴 with a launch button if it does not. Either way, only one window's monitor tick should fire (singleton guard).
