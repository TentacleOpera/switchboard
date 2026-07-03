# Comms Monitor: Fix Stuck "Running" Status and Add Stop/Disable Controls

## Goal

The Comms Monitor has no way to be turned off. When the user kills the monitor terminal manually (closes the terminal panel, Ctrl+C, etc.), the AUTOMATION/COMMS tab status line stays stuck on "🟢 Monitor terminal: running" permanently. There is no "Stop" button — the only way to get the status to update is to reload the window. Additionally, the monitor's polling loop (`_mcpMonitorTimer`) keeps running in the background even after the terminal is dead, silently attempting ticks that no-op on the dead-terminal guard.

This plan fixes three problems:
1. **Stuck status:** The webview is never notified when the monitor terminal dies, so the status line never updates from 🟢 to 🔴.
2. **No stop button:** There is no UI control to stop the monitor — the user can only launch, never stop.
3. **Loop keeps running:** The polling interval (`_mcpMonitorTimer`) is never stopped when the terminal dies, wasting timer cycles on no-op ticks.

### Problem Analysis & Root Cause

**Symptom 1 — stuck "running" status:** The user kills the monitor terminal. The AUTOMATION/COMMS tab still shows "🟢 Monitor terminal: running". The status never changes to 🔴.

**Root cause 1 (confirmed by code reading):** The status is pushed to the webview by `_postMcpMonitorConfig` (`TaskViewerProvider.ts:20487`), which calls `_isMcpMonitorTerminalRunning` (line 20592) to check if a live terminal with the name "MCP Monitor" exists. This method is correct — it checks `exitStatus === undefined`. The problem is **when `_postMcpMonitorConfig` is called**:

- On launch (line 20583) — ✅ correct, pushes "running"
- On config change (line 20484) — ✅ but only if the user changes config
- On sidebar init (line 8921) — ✅ but only once
- On `getMcpMonitorConfig` request (line 9990) — ✅ but only when explicitly requested

**It is NEVER called when the terminal closes.** The terminal-close handler (`handleTerminalClosed`, line 15914) is called by `onDidCloseTerminal` (`extension.ts:1712`). It cleans up state.json and calls `_refreshTerminalStatuses` (line 15953) — but `_refreshTerminalStatuses` (line 18561) only pushes terminal statuses to the sidebar, **not** the MCP monitor config to the kanban webview. There is no call to `_postMcpMonitorConfig` anywhere in the terminal-close path.

So: terminal dies → `handleTerminalClosed` runs → state.json is cleaned → sidebar terminal list updates → but the kanban webview's `isMcpMonitorTerminalRunning` flag is never updated. The webview is stuck with the last-pushed value (`true`), and the status line shows 🟢 forever.

**Symptom 2 — no stop button:** The status line (kanban.html:7883-7897) has two branches:
- `isMcpMonitorTerminalRunning === true` → shows "🟢 running" text, **no button**
- `isMcpMonitorTerminalRunning === false` → shows "🔴 No monitor terminal running" + a "Launch" button

There is no "Stop" button in the running branch. The user cannot stop the monitor from the UI — they must manually kill the terminal in the VS Code terminal panel.

**Symptom 3 — loop keeps running:** `_startMcpMonitorLoop` (line 20390) sets `setInterval` and is only stopped by `_stopMcpMonitorLoop` (line 20403), which is called from:
- `setMcpMonitorConfigFromKanban` when `enabled === false` (line 20393)
- `dispose()` (line 19076) — extension deactivation only

It is **never called when the terminal dies**. So the interval keeps firing every 5 minutes, calling `_enqueueMcpMonitorTick` → `_mcpMonitorTick`, which hits the dead-terminal guard (line 20432: `if (!terminal || terminal.exitStatus !== undefined) return;`) and returns. The timer runs forever, doing nothing, until the extension is deactivated or the user disables the monitor.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, terminal, lifecycle, bugfix, ux, stop-button
- **Complexity:** 4
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/extension.ts`

## Complexity Audit

**Moderate.** The fix spans four files but each change is small and follows existing patterns:
- The terminal-close notification is a one-line addition to `handleTerminalClosed` (call `_postMcpMonitorConfig`).
- The loop-stop-on-terminal-death is a targeted check in `handleTerminalClosed` (if the closed terminal was the monitor, stop the loop).
- The Stop button is a UI addition to the running branch of the status line, plus a new message handler + backend method to kill the terminal and stop the loop.
- The `onDidCloseTerminal` → `refresh()` call at `extension.ts:2883` already exists but doesn't push monitor config — we add the push in `handleTerminalClosed` where we have the terminal reference.

**Risk:** The `handleTerminalClosed` method uses `terminal.processId` (async, 1s timeout) to identify the terminal. The monitor terminal might not have a PID resolvable by name. We should also check by name — if the closed terminal's name matches "MCP Monitor" (or "Comms Monitor" after the rename), treat it as the monitor terminal regardless of PID resolution.

## Edge-Case & Dependency Audit

- **Terminal killed by VS Code (not user):** VS Code fires `onDidCloseTerminal` when a terminal exits for any reason (user close, process exit, panel disposal). All paths trigger `handleTerminalClosed`, so the fix covers all close scenarios.
- **Terminal name after rename:** The companion rename plan changes the terminal name from "MCP Monitor" to "Comms Monitor". The name-matching logic in `handleTerminalClosed` must use the same name literal as `launchMcpMonitorTerminal`. If the rename hasn't shipped, use "MCP Monitor"; if it has, use "Comms Monitor". The plan uses a constant to avoid drift.
- **Multiple windows:** `onDidCloseTerminal` fires in the window that owned the terminal. If the monitor terminal was in a different window, this window's `handleTerminalClosed` won't fire for it. The existing `_isMcpMonitorTerminalRunning` already handles this (it checks `vscode.window.terminals` which is per-window). The `_postMcpMonitorConfig` push is also per-window. No cross-window issue.
- **Stop button while a tick is in-flight:** If the user clicks Stop while `_mcpMonitorTick` is mid-send (`_mcpMonitorInFlight === true`), the tick will complete its `sendRobustText` call. The `finally` block resets `_mcpMonitorInFlight`. Then `_stopMcpMonitorLoop` clears the interval. No race — the in-flight send completes, no further ticks fire. This is acceptable (one final prompt may be sent before the stop takes effect).
- **Stop button vs. disable monitor:** "Stop" kills the terminal and stops the loop. "Disable" (the on/off dropdown) sets `enabled: false` in config and stops the loop but does NOT kill the terminal. These are separate actions. The Stop button is for "I want this terminal gone now." The disable dropdown is for "I don't want the monitor to run at all." Both should work independently.
- **Re-launch after stop:** After stopping, the status line shows 🔴 + "Launch" button. Clicking Launch calls `launchMcpMonitorTerminal`, which creates a fresh terminal and restarts the loop. This already works — no change needed.
- **`_stopMcpMonitorLoop` also cancels the config-change timer and first-prompt timer** (from companion plans). Calling it on terminal death correctly cancels all pending timers.
- **No `confirm()` dialogs.** The Stop button stops immediately — no confirmation, per project rules.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — notify the webview and stop the loop when the monitor terminal closes

In `handleTerminalClosed` (line 15914), after the state cleanup and before the final `_refreshTerminalStatuses`, add a check for whether the closed terminal was the monitor terminal. If so, stop the loop and push the updated config:

```ts
    public async handleTerminalClosed(terminal: vscode.Terminal) {
        try {
            const pid = await this._waitWithTimeout(terminal.processId, 1000, undefined);
            let cleanedTerminalName: string | undefined;
            await this.updateState(async (state) => {
                // ... existing state cleanup ...
            });

            if (cleanedTerminalName) {
                this.clearTerminalAgentInfo(cleanedTerminalName);
            }

            await this._removeAutobanTerminalReferences(cleanedTerminalName || terminal.name);

            // NEW: If the closed terminal was the Comms Monitor, stop the polling
            // loop and push the updated status to the kanban webview so the status
            // line flips from 🟢 to 🔴.
            const monitorName = this._normalizeAgentKey(this._stripIdeSuffix('MCP Monitor'));
            const closedName = this._normalizeAgentKey(this._stripIdeSuffix(terminal.name));
            if (closedName === monitorName) {
                this._stopMcpMonitorLoop();
                await this._postMcpMonitorConfig();
            }

            this._refreshTerminalStatuses();
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to handle terminal closure:', e);
        }
    }
```

**Note on the name literal:** Use `'MCP Monitor'` here to match `launchMcpMonitorTerminal` (line 20513) and `_isMcpMonitorTerminalRunning` (line 20594). If the companion rename plan ships, update all three to `'Comms Monitor'` together. The rename plan already documents this.

### 2. `src/services/TaskViewerProvider.ts` — add a `stopMcpMonitorTerminal` public method

Add a method that kills the terminal and stops the loop, for the Stop button:

```ts
    /**
     * Kill the Comms Monitor terminal and stop the polling loop.
     * Called by the "Stop" button in the COMMS tab.
     */
    public async stopMcpMonitorTerminal(): Promise<void> {
        const targetName = 'MCP Monitor';
        const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(targetName));

        // Find and dispose the live monitor terminal
        const live = vscode.window.terminals.find(t => {
            const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
            return tName === strippedTarget && t.exitStatus === undefined;
        });
        if (live) {
            live.dispose();
        }

        // Stop the polling loop and cancel any pending timers
        this._stopMcpMonitorLoop();

        // Push updated status to the kanban webview (status flips to 🔴)
        await this._postMcpMonitorConfig();
    }
```

### 3. `src/extension.ts` — register the stop command

Register a command for the Stop button (near line 1335 where `launchMcpMonitorTerminal` is registered):

```ts
    const stopMcpMonitorTerminalDisposable = vscode.commands.registerCommand('switchboard.stopMcpMonitorTerminal', async () => {
        await taskViewerProvider.stopMcpMonitorTerminal();
    });
    context.subscriptions.push(stopMcpMonitorTerminalDisposable);
```

### 4. `src/services/KanbanProvider.ts` — add a `stopMcpMonitorTerminal` message handler

Add a case in the message handler (near line 5752 where `launchMcpMonitorTerminal` is handled):

```ts
            case 'stopMcpMonitorTerminal': {
                await vscode.commands.executeCommand('switchboard.stopMcpMonitorTerminal');
                break;
            }
```

### 5. `src/webview/kanban.html` — add a Stop button to the running status branch

Update the status line (line 7883-7897) to show a Stop button when the monitor is running:

```js
            // Status Line
            const statusLine = document.createElement('div');
            statusLine.style.cssText = 'margin-top:8px; padding-top:6px; border-top:1px dashed var(--border-color); font-size:9px; line-height:1.3;';
            if (isMcpMonitorTerminalRunning) {
                statusLine.innerHTML = '🟢 <strong>Monitor terminal:</strong> running';
                const stopBtn = document.createElement('button');
                stopBtn.textContent = 'Stop Monitor';
                stopBtn.style.cssText = 'display:block; margin-top:6px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--accent-red, #c0392b); color:var(--bg-primary); border:none; border-radius:3px;';
                guardInteraction(stopBtn);
                stopBtn.addEventListener('click', () => {
                    stopBtn.disabled = true;
                    stopBtn.textContent = 'Stopping…';
                    postKanbanMessage({ type: 'stopMcpMonitorTerminal' });
                });
                statusLine.appendChild(stopBtn);
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

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — status updates on manual kill (the core bug fix):**
   - Launch the monitor terminal. Confirm status shows "🟢 running".
   - Kill the terminal manually (click the trash icon in the VS Code terminal panel, or Ctrl+C then close).
   - **Within ~1 second**, confirm the status line flips to "🔴 No monitor terminal running" + "Launch Monitor Terminal" button. This is the fix — previously it stayed stuck on 🟢.
3. **Manual — Stop button works:**
   - Launch the monitor terminal. Confirm status shows "🟢 running" + "Stop Monitor" button.
   - Click "Stop Monitor". Confirm the terminal is killed (disappears from the terminal panel) and the status flips to "🔴 No monitor terminal running" + "Launch" button.
4. **Manual — loop stops on terminal death:**
   - Launch the monitor with a 1-minute interval. Let one tick fire (confirm a prompt was sent).
   - Kill the terminal manually.
   - Wait 2 minutes (two interval cycles). Confirm no errors are logged from `_mcpMonitorTick` — the interval was cleared by `_stopMcpMonitorLoop` in `handleTerminalClosed`. (Before the fix, the interval would keep firing and hitting the dead-terminal guard every minute.)
5. **Manual — loop stops on Stop button:**
   - Launch the monitor with a 1-minute interval. Click "Stop Monitor".
   - Wait 2 minutes. Confirm no tick errors in the console — the interval was cleared.
6. **Manual — re-launch after stop:**
   - After stopping (either via button or manual kill), click "Launch Monitor Terminal". Confirm a new terminal is created, the status flips to 🟢, and the loop restarts. The first prompt should arrive (per the 30s one-shot companion plan).
7. **Manual — disable vs. stop are independent:**
   - Launch the monitor. Set the on/off dropdown to "off" (disable). Confirm the loop stops but the terminal stays alive (disable doesn't kill the terminal).
   - Set the dropdown back to "on". Confirm the loop restarts and the existing terminal receives prompts.
   - Now click "Stop Monitor". Confirm the terminal is killed and the loop stops.
   - Set the dropdown to "on" (it should still be on — stop doesn't change `enabled`). Click "Launch" to get a new terminal.
8. **Manual — in-flight tick completes on stop:**
   - Launch the monitor with a 1-minute interval. Wait for a tick to start (watch for the prompt in the terminal). Immediately click "Stop Monitor".
   - Confirm the in-flight `sendRobustText` completes (the prompt finishes typing). The terminal is then disposed. No crash or error.
9. **Regression:** Other terminal closures (agent grid terminals, autoban terminals) are unaffected — the monitor-specific check in `handleTerminalClosed` only fires when the terminal name matches "MCP Monitor". The existing `handleTerminalClosed` state cleanup and autoban reference removal still run for all terminals.
