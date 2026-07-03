# Comms Monitor: Fix Stuck "Running" Status and Add Stop/Disable Controls

## Goal

The Comms Monitor has no way to be turned off. When the user kills the monitor terminal manually (closes the terminal panel, Ctrl+C, etc.), the AUTOMATION/COMMS tab status line stays stuck on "🟢 Monitor terminal: running" permanently. There is no "Stop" button — the only way to get the status to update is to reload the window. Additionally, the monitor's polling loop (`_mcpMonitorTimer`) keeps running in the background even after the terminal is dead, silently attempting ticks that no-op on the dead-terminal guard.

This plan fixes three problems:
1. **Stuck status:** The webview is never notified when the monitor terminal dies, so the status line never updates from 🟢 to 🔴.
2. **No stop button:** There is no UI control to stop the monitor — the user can only launch, never stop.
3. **Loop keeps running:** The polling interval (`_mcpMonitorTimer`) is never stopped when the terminal dies, wasting timer cycles on no-op ticks.

### Problem Analysis & Root Cause

**Symptom 1 — stuck "running" status:** The user kills the monitor terminal. The AUTOMATION/COMMS tab still shows "🟢 Monitor terminal: running". The status never changes to 🔴.

**Root cause 1 (confirmed by code reading — anchors verified against current `src/` on 2026-07-03):** The status is pushed to the webview by `_postMcpMonitorConfig` (`TaskViewerProvider.ts:20579`), which calls `_isMcpMonitorTerminalRunning` (line 20684) to check if a live terminal with the name "MCP Monitor" exists. This method is correct — it checks `exitStatus === undefined`. Note: `_postMcpMonitorConfig` posts the message `{ type: 'updateMcpMonitorConfig', ..., isMonitorRunning }` to **both** the sidebar (`this._view`) and the kanban panel (`this._kanbanProvider`). The webview stores `msg.isMonitorRunning` into its local `isMcpMonitorTerminalRunning` flag (kanban.html:6734, in the `updateMcpMonitorConfig` case at 6732). The problem is **when `_postMcpMonitorConfig` is called**:

- On launch (line 20675, end of `launchMcpMonitorTerminal`) — ✅ correct, pushes "running"
- On config change (line 20576, `setMcpMonitorConfigFromKanban`) — ✅ but only if the user changes config
- On sidebar init (line 9013) — ✅ but only once
- On `getMcpMonitorConfig` request (line 10082) — ✅ but only when explicitly requested

**It is NEVER called when the terminal closes.** The terminal-close handler (`handleTerminalClosed`, line 16006) is called by `onDidCloseTerminal` (`extension.ts:1715`, which calls `taskViewerProvider.handleTerminalClosed(terminal)` at line 1727). It cleans up state.json and calls `_refreshTerminalStatuses` (the call is at line 16045) — but `_refreshTerminalStatuses` (definition at line 18653) only pushes terminal statuses to the sidebar, **not** the MCP monitor config to the kanban webview. There is no call to `_postMcpMonitorConfig` anywhere in the terminal-close path.

So: terminal dies → `handleTerminalClosed` runs → state.json is cleaned → sidebar terminal list updates → but the kanban webview's `isMcpMonitorTerminalRunning` flag is never updated. The webview is stuck with the last-pushed value (`true`), and the status line shows 🟢 forever.

**Symptom 2 — no stop button:** The status line (kanban.html:7706-7724) has two branches:
- `isMcpMonitorTerminalRunning === true` → shows "🟢 running" text, **no button**
- `isMcpMonitorTerminalRunning === false` → shows "🔴 No monitor terminal running" + a "Launch" button

There is no "Stop" button in the running branch. The user cannot stop the monitor from the UI — they must manually kill the terminal in the VS Code terminal panel.

**Symptom 3 — loop keeps running:** `_startMcpMonitorLoop` (line 20482) sets `setInterval` and is only stopped by `_stopMcpMonitorLoop` (line 20495), which is called from:
- `_startMcpMonitorLoop` itself when `cfg.enabled === false` (line 20485); this is reached via `setMcpMonitorConfigFromKanban` → `_startMcpMonitorLoop` (line 20575)
- `dispose()` (line 19168) — extension deactivation only

It is **never called when the terminal dies**. So the interval keeps firing at the configured interval, calling `_enqueueMcpMonitorTick` → `_mcpMonitorTick`, which hits the dead-terminal guard (line 20524: `if (!terminal || terminal.exitStatus !== undefined) return;`) and returns. The timer runs forever, doing nothing, until the extension is deactivated or the user disables the monitor.

## Metadata

- **Tags:** bugfix, ui, ux, reliability, frontend
- **Complexity:** 5
- **Project:** switchboard
- **Repo:** (root — single-repo extension)
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/extension.ts`
- **Domain keywords (not schema tags):** comms-monitor, mcp-monitor, terminal-lifecycle, stop-button

## User Review Required

- **Stop button label + placement:** The plan places a red "Stop Monitor" button in the running branch of the COMMS-tab status line. This same status-line block is being restructured by sibling plans — see *Cross-plan conflicts* below. Confirm the button label ("Stop Monitor") and the destructive-red styling before merge, since the sibling **separate-terminal-auth-polling** adds its own controls to the same line.
- **Immediate stop, no confirm:** Per project rules, "Stop Monitor" disposes the terminal immediately with no `confirm()` gate. Confirm this is the desired behavior (it is the mandated one).
- **Terminal-name literal source of truth:** This plan hard-codes `'MCP Monitor'`. If the rename sibling (**rename-display-labels**) lands first, the reviewer must ensure a single shared constant/literal is used across all call sites (see below) rather than two plans hard-coding different strings.

## Complexity Audit

**Moderate (5).** The fix spans four files but each change is small and follows existing patterns. The single non-trivial dimension is cross-plan coordination on the shared COMMS-tab status-line block and the shared `'MCP Monitor'` terminal-name literal (both touched by sibling plans in this epic), which is what keeps this above a pure Routine score.

### Routine
- The terminal-close notification is a small addition to `handleTerminalClosed` (call `_stopMcpMonitorLoop` + `_postMcpMonitorConfig` when the closed terminal is the monitor).
- The loop-stop-on-terminal-death is a targeted name-match check in `handleTerminalClosed`.
- The Stop button is a UI addition to the running branch of the status line, plus a new message handler + backend method — a near-exact mirror of the existing `launchMcpMonitorTerminal` command → handler → method chain (command registered `extension.ts:1338`, handler `KanbanProvider.ts:6269`, method `TaskViewerProvider.ts:20604`).
- The `onDidCloseTerminal` → `refresh()` call at `extension.ts:2915` already exists but doesn't push monitor config — we add the push in `handleTerminalClosed` where we have the terminal reference.

### Complex / Risky
- **Shared status-line surface.** The running/not-running branch in kanban.html (7706-7724) is simultaneously restructured by **dedicated-tab** (relocates the block) and **separate-terminal-auth-polling** (adds polling controls to the same line). Adding a Stop button here without coordinating risks a merge collision or a visually crowded status line. Keep the button additive and note the coordination rather than redesigning the block.
- **Terminal-name literal drift.** `'MCP Monitor'` is hard-coded at four call sites (20518, 20605, 20686, plus the new lookups this plan adds). The **rename-display-labels** sibling renames it to "Comms Monitor". Name matching in `handleTerminalClosed` and `stopMcpMonitorTerminal` MUST use the exact same literal as `launchMcpMonitorTerminal`, or the Stop/auto-detect logic silently no-ops.
- **`_stopMcpMonitorLoop` is a shared extension point.** Siblings **first-prompt-after-startup** and **apply-source-changes-immediately** also extend/call it. Calling it from a new path (terminal close, Stop button) must remain idempotent and must not fight those plans' timer additions.
- **PID-vs-name identification risk (original note, preserved):** The `handleTerminalClosed` method uses `terminal.processId` (async, 1s timeout) to identify the terminal for state cleanup. The monitor terminal might not have a PID resolvable in time. Our monitor check does NOT rely on PID — it matches on the normalized terminal name directly (`terminal.name` is always available synchronously on the close event), so it is robust regardless of PID resolution.

## Edge-Case & Dependency Audit

### Race Conditions
- **Stop button while a tick is in-flight:** If the user clicks Stop while `_mcpMonitorTick` is mid-send (`_mcpMonitorInFlight === true`), the tick will complete its `sendRobustText` call. The `finally` block (line 20547-20549) resets `_mcpMonitorInFlight`. Then `_stopMcpMonitorLoop` clears the interval. No race — the in-flight send completes, no further ticks fire. This is acceptable (one final prompt may be sent before the stop takes effect).
- **Close event vs. relaunch race:** `handleTerminalClosed` already guards against deleting a newly-registered same-name terminal via the `liveWithSameName` check (line 16024). Our monitor detection runs *after* state cleanup and independently re-queries `vscode.window.terminals`, so if a fresh monitor terminal is already live the `_postMcpMonitorConfig` push will correctly report 🟢 (its `_isMcpMonitorTerminalRunning` scan sees the live one). Stopping the loop on a stale close is still safe because `_startMcpMonitorLoop` is re-invoked on the next config/launch.

### Security
- **No new surface.** No new user input is parsed; the Stop button posts a fixed `{ type: 'stopMcpMonitorTerminal' }` message with no payload. The command handler takes no arguments. Terminal disposal uses the standard VS Code `terminal.dispose()` API. No injection, no privilege change.

### Side Effects
- **Terminal killed by VS Code (not user):** VS Code fires `onDidCloseTerminal` when a terminal exits for any reason (user close, process exit, panel disposal). All paths trigger `handleTerminalClosed`, so the fix covers all close scenarios.
- **Stop button vs. disable monitor:** "Stop" kills the terminal and stops the loop. "Disable" (the on/off dropdown) sets `enabled: false` in config and stops the loop but does NOT kill the terminal. These are separate actions. The Stop button is for "I want this terminal gone now." The disable dropdown is for "I don't want the monitor to run at all." Both should work independently. Note: Stop does NOT change persisted `enabled`, so a later Launch behaves normally.
- **Re-launch after stop:** After stopping, the status line shows 🔴 + "Launch" button. Clicking Launch calls `launchMcpMonitorTerminal`, which creates a fresh terminal and restarts the loop. This already works — no change needed.
- **`_stopMcpMonitorLoop` also cancels any config-change timer and first-prompt timer** (added by companion plans). Calling it on terminal death correctly cancels all pending timers. It must remain idempotent (current impl at 20495 already null-checks `_mcpMonitorTimer`).
- **No `confirm()` dialogs.** The Stop button stops immediately — no confirmation, per project rules (see CLAUDE.md; `window.confirm()` is a silent no-op in VS Code webviews anyway).

### Dependencies & Conflicts
- **Terminal name after rename:** The companion **rename-display-labels** plan changes the terminal name from "MCP Monitor" to "Comms Monitor". The name-matching logic in `handleTerminalClosed` AND the new `stopMcpMonitorTerminal` must use the same name literal as `launchMcpMonitorTerminal` (line 20605). If the rename hasn't shipped, use "MCP Monitor"; if it has, use "Comms Monitor". Prefer a single shared constant to avoid drift across the four call sites (20518, 20605, 20686, and the two new lookups this plan adds).
- **Shared status-line block:** kanban.html 7706-7724 is also edited by **dedicated-tab** (moves the block to a new tab) and **separate-terminal-auth-polling** (adds polling controls to the same status line). Coordinate merge order; keep the Stop button additive.
- **Shared `_stopMcpMonitorLoop`:** also extended/called by **first-prompt-after-startup** and **apply-source-changes-immediately**. This plan only *calls* it (does not change its signature), minimizing conflict.
- **Multiple windows:** `onDidCloseTerminal` fires in the window that owned the terminal. If the monitor terminal was in a different window, this window's `handleTerminalClosed` won't fire for it. The existing `_isMcpMonitorTerminalRunning` already handles this (it checks `vscode.window.terminals` which is per-window). The `_postMcpMonitorConfig` push is also per-window. No cross-window issue.

## Dependencies

- `sess_rename-display-labels — MCP Monitor → Comms Monitor terminal-name literal` (soft: this plan must use whichever literal is live; prefer a shared constant)
- `sess_dedicated-tab — relocation of the COMMS-tab status-line block` (soft: merge-order coordination on kanban.html 7706-7724)
- `sess_separate-terminal-auth-polling — polling controls added to the same status line` (soft: shared UI surface)
- `sess_first-prompt-after-startup — extends _stopMcpMonitorLoop / adds first-prompt timer`
- `sess_apply-source-changes-immediately — extends _stopMcpMonitorLoop timer handling`

(These are epic siblings, not hard blockers — this plan can ship independently against the current `'MCP Monitor'` literal and current status-line block; the reviewer coordinates final merge order.)

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the shared COMMS status-line block and the `'MCP Monitor'` name literal are both being edited by sibling plans, so an uncoordinated merge could collide or leave the Stop/auto-detect logic matching a stale name; (2) calling `_stopMcpMonitorLoop` from new paths must stay idempotent alongside sibling timer additions. Mitigations: match the terminal name via the exact same literal/constant as `launchMcpMonitorTerminal`, keep the Stop button strictly additive to the status line, and rely on name-based (not PID-based) detection so terminal-close handling is robust. The behavioral core (push config on close, stop loop on death, immediate no-confirm stop) is low-risk and mirrors existing patterns.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — notify the webview and stop the loop when the monitor terminal closes

In `handleTerminalClosed` (line 16006), after `_removeAutobanTerminalReferences` (line 16043) and before the final `_refreshTerminalStatuses` (line 16045), add a check for whether the closed terminal was the monitor terminal. If so, stop the loop and push the updated config. **Clarification:** the exact current body around the insertion point is:

```ts
            if (cleanedTerminalName) {
                this.clearTerminalAgentInfo(cleanedTerminalName);      // line 16040
            }

            await this._removeAutobanTerminalReferences(cleanedTerminalName || terminal.name);  // 16043

            // NEW: If the closed terminal was the Comms Monitor, stop the polling
            // loop and push the updated status to the kanban webview so the status
            // line flips from 🟢 to 🔴. Match by NAME (available synchronously on the
            // close event) rather than PID, so detection is robust even when
            // terminal.processId does not resolve within the 1s timeout.
            const monitorName = this._normalizeAgentKey(this._stripIdeSuffix('MCP Monitor'));
            const closedName = this._normalizeAgentKey(this._stripIdeSuffix(terminal.name));
            if (closedName === monitorName) {
                this._stopMcpMonitorLoop();
                await this._postMcpMonitorConfig();
            }

            this._refreshTerminalStatuses();   // existing call at line 16045
```

The surrounding `try { ... } catch (e) { console.error('[TaskViewerProvider] Failed to handle terminal closure:', e); }` wrapper is already present (16007 / 16046-16048) — do not duplicate it.

**Note on the name literal:** Use `'MCP Monitor'` here to match `launchMcpMonitorTerminal` (line 20605), `_mcpMonitorTick` (line 20518) and `_isMcpMonitorTerminalRunning` (line 20686). If the companion **rename-display-labels** plan ships, update all four to `'Comms Monitor'` together — ideally via a single shared constant. The rename plan already documents this coordination.

### 2. `src/services/TaskViewerProvider.ts` — add a `stopMcpMonitorTerminal` public method

Add a method that kills the terminal and stops the loop, for the Stop button. Place it near `launchMcpMonitorTerminal` (line 20604) so the launch/stop pair lives together and shares the same name literal:

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

Register a command for the Stop button (immediately after the `launchMcpMonitorTerminal` registration at lines 1338-1341, which reads `vscode.commands.registerCommand('switchboard.launchMcpMonitorTerminal', ...)`):

```ts
    const stopMcpMonitorTerminalDisposable = vscode.commands.registerCommand('switchboard.stopMcpMonitorTerminal', async () => {
        await taskViewerProvider.stopMcpMonitorTerminal();
    });
    context.subscriptions.push(stopMcpMonitorTerminalDisposable);
```

### 4. `src/services/KanbanProvider.ts` — add a `stopMcpMonitorTerminal` message handler

Add a case in the message handler immediately after the `launchMcpMonitorTerminal` case (lines 6269-6272):

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
