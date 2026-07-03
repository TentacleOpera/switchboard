# Comms Monitor: Separate Terminal Creation, Auth Check, and Polling Start

## Goal

The Comms Monitor currently conflates three distinct steps into a single "Launch" action: (1) creating the terminal, (2) sending the `claude` startup command, and (3) starting the polling loop. This creates an authentication problem: if the user is not authenticated with Claude (or hasn't configured their MCP servers), the polling loop starts immediately and every tick sends a prompt whose tool calls fail with auth errors — burning tokens on failures the user can't see or recover from.

This plan separates the flow into three distinct, user-controlled buttons:
1. **Start Terminal** — creates the terminal and sends the `claude` startup command. Does NOT start polling.
2. **Check Authentication** — sends a real MCP test prompt to the terminal (e.g. "List your connected MCP servers and their available tools") so the user can see in the terminal whether Claude is authenticated and MCP servers are reachable. This is a **diagnostic only** — no confirmation gate, no blocking. The user looks at the terminal output and decides whether things are working.
3. **Start Polling** — starts the periodic polling loop. Available whenever a terminal is running — no auth gate. If auth is broken, the user sees errors in the terminal and clicks "Stop Polling" themselves.

### Problem Analysis & Root Cause

**Symptom:** The user clicks "Launch Monitor Terminal". A terminal opens, `claude` starts, and the polling loop immediately begins sending prompts. If the user hasn't authenticated Claude (no API key, expired session) or hasn't configured MCP servers (no Slack/Gmail/Calendar connectors), every prompt's tool calls fail silently in the terminal. The user sees the monitor "running" but getting errors, with no way to diagnose or control the flow.

**Root cause (confirmed by code reading against current `src/`):** `launchMcpMonitorTerminal` (`TaskViewerProvider.ts:20604`) creates and reveals the terminal, then sends the startup command:
1. Creates the terminal via `vscode.window.createTerminal` (line 20631)
2. Waits for shell readiness and sends the startup command via `terminal.sendText(cmd.trim(), true)` (line 20671)
3. Pushes status to the kanban via `_postMcpMonitorConfig()` (line 20675)

> **Accuracy correction (2026-07-03 improve-plan pass):** In the *current* checked-in code, `launchMcpMonitorTerminal` does **NOT** call `_startMcpMonitorLoop()` and does **NOT** schedule any first prompt — no `_scheduleMcpMonitorFirstPrompt` symbol exists in `TaskViewerProvider.ts` yet. Those are additions expected from companion plans ("first-prompt-after-startup", "apply-source-changes-immediately"). Today the loop is started in two places: (a) on activation at `TaskViewerProvider.ts:487` (`void this._startMcpMonitorLoop();`) and (b) in `setMcpMonitorConfigFromKanban` at `TaskViewerProvider.ts:20575` (called when the config panel saves). Both currently gate on `cfg.enabled`. So the "polling auto-starts on launch" symptom is only literally true once the companion plans land; without them, polling starts when the user toggles the on/off dropdown to "on" (which sets `enabled: true`). This plan still holds — it decouples the loop gate from `enabled` — but the "removes loop-start from launch" step is only meaningful in combination with the companion plans that add it.

There is no separation between "terminal exists" and "polling is active." The `enabled` config flag (`McpMonitorConfig.enabled`, `GlobalIntegrationConfigService.ts:40`) is the only control, and it's a single boolean that gates both the config panel visibility (`kanban.html:7615`/`7623`) and the loop (`_startMcpMonitorLoop` at `TaskViewerProvider.ts:20482`, guard at line 20484). Setting `enabled: true` starts the loop regardless of whether the terminal is live or authenticated.

**The auth gap:** `_mcpMonitorTick` (`TaskViewerProvider.ts:20512`, `enabled` guard at line 20514) reads config, finds the terminal, builds the prompt (`_buildMcpMonitorPrompt` at line 20552), and calls `sendRobustText`. It never checks whether Claude is actually authenticated or whether MCP servers are configured. If Claude returns an auth error, the terminal shows it, but the extension has no visibility — it just keeps sending prompts every interval. The user has to manually look at the terminal, realize the errors, and figure out what's wrong. And because polling auto-started, the errors are already happening before the user has a chance to verify their setup.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, authentication, ux, terminal, polling, lifecycle
- **Complexity:** 5
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/extension.ts`

## Complexity Audit

**Moderate.** The change separates one combined action into three independent buttons and adds a new `pollingEnabled` config field. No `authConfirmed` field or confirmation gate — the auth check is a pure diagnostic that sends a test prompt, and the user decides when to start polling. This is simpler than a gated wizard flow.

The individual changes:
- Config schema: add `pollingEnabled` (additive, backward-compatible read mapping from legacy `enabled`).
- Backend: split `launchMcpMonitorTerminal` (remove polling start), add `checkMcpMonitorAuth` (send test prompt), add `startMcpMonitorPolling` / `stopMcpMonitorPolling`.
- UI: replace the single Launch button with three buttons (Start Terminal, Check Auth, Start/Stop Polling), shown conditionally based on terminal state and polling state.

**Risk:** Low. The `pollingEnabled` field is additive with a backward-compat read fallback (`pollingEnabled ?? enabled ?? false`), so existing installs with `enabled: true` continue polling automatically. The auth check is non-blocking — it just sends text to the terminal, same as a normal tick.

## Edge-Case & Dependency Audit

- **Backward compatibility — existing `enabled: true` installs:** Existing users have `enabled: true` in their config. After this plan, `pollingEnabled` controls the loop. The `getMcpMonitorConfig` read path maps `enabled: true` → `pollingEnabled: true` for configs that don't have the new field. This is a read-time compat shim, not a file migration.
- **Terminal killed between steps:** If the user creates the terminal (step 1) but kills it before starting polling (step 3), the polling button disappears (the terminal-close handler from the companion plan pushes updated status). If polling was active, the loop stops (companion plan's `handleTerminalClosed` calls `_stopMcpMonitorLoop`).
- **Auth check when no terminal exists:** The "Check Authentication" button is only visible when a terminal is running. If the user somehow triggers it without a terminal, the backend method returns early (no terminal found).
- **Auth check while polling is active:** The user can click "Check Authentication" while polling is running — it just sends an additional test prompt to the terminal. The polling loop continues unaffected. This is fine — it's a diagnostic.
- **Auth expires mid-polling:** The user authenticates, starts polling, but the Claude session expires hours later. Tool calls start failing. The polling loop continues (it doesn't know auth failed). The user sees errors in the terminal, clicks "Stop Polling," re-authenticates in the terminal, and clicks "Start Polling" again. This is the expected recovery flow.
- **MCP server not configured (vs. Claude auth failure):** The auth check prompt asks Claude to check authentication status for each MCP server and explain how to authenticate if needed. If MCP servers aren't configured, Claude will report no servers connected. If servers are configured but not authenticated (e.g. Slack OAuth not completed), Claude will explain how to authenticate. Both cases are visible to the user in the terminal output, with actionable guidance from Claude.
- **Re-start polling after stop:** After stopping polling (but keeping the terminal), the user can restart polling without re-creating the terminal or re-checking auth. The "Start Polling" button is available whenever a live terminal exists.
- **Companion plan interactions:**
  - The "Stop Monitor" button plan adds a stop control that kills the terminal. This plan adds "Stop Polling" (stops the loop, keeps the terminal). They're different actions.
  - The 30s one-shot first prompt plan starts polling after launch. After this plan, the one-shot should only fire after the user clicks "Start Polling," not after terminal creation.
  - The dedicated COMMS tab plan moves the UI. This plan's UI changes target whatever tab the monitor lives in.
- **No `confirm()` dialogs.** All buttons act immediately.

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — add `pollingEnabled` field

Extend `GlobalConfig.mcpMonitor` (line 15) and `McpMonitorConfig` (line 39):

```ts
    mcpMonitor?: {
        enabled?: boolean;          // controls config panel visibility (on/off dropdown)
        pollingEnabled?: boolean;   // NEW: whether the periodic polling loop is active
        intervalMinutes?: number;
        targetRole?: string;
        sources?: string[];
        customInstruction?: string;
        lastCheckAt?: string;
    };
```

```ts
export interface McpMonitorConfig {
    enabled: boolean;              // config panel visibility
    pollingEnabled: boolean;       // NEW: loop active
    intervalMinutes: number;
    targetRole: string;
    sources: string[];
    customInstruction: string;
    lastCheckAt?: string;
}
```

In `getMcpMonitorConfig` (line 233) and `getMcpMonitorConfigSync` (line 221), add backward-compat mapping:

```ts
        return {
            enabled: cfg.enabled ?? (cfg.pollingEnabled ?? false),
            pollingEnabled: cfg.pollingEnabled ?? cfg.enabled ?? false,  // fall back to legacy enabled
            intervalMinutes: Math.max(cfg.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            lastCheckAt: cfg.lastCheckAt,
        };
```

In `setMcpMonitorConfig` (line 245), write the new field through:

```ts
        globalConfig.mcpMonitor = {
            enabled: config.enabled ?? current.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            pollingEnabled: config.pollingEnabled ?? current.pollingEnabled ?? current.enabled ?? false,
            intervalMinutes: Math.max(config.intervalMinutes ?? current.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: config.targetRole ?? current.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: config.sources ?? current.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: config.customInstruction ?? current.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            lastCheckAt: config.lastCheckAt ?? current.lastCheckAt,
        };
```

### 2. `src/services/TaskViewerProvider.ts` — gate the loop on `pollingEnabled` instead of `enabled`

In `_startMcpMonitorLoop` (line 20390), check `pollingEnabled`:

```ts
    private async _startMcpMonitorLoop() {
        const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        if (!cfg.pollingEnabled) {
            this._stopMcpMonitorLoop();
            return;
        }
        if (this._mcpMonitorTimer) {
            clearInterval(this._mcpMonitorTimer);
        }
        const intervalMs = Math.max(cfg.intervalMinutes, 1) * 60 * 1000;
        this._mcpMonitorTimer = setInterval(() => this._enqueueMcpMonitorTick(), intervalMs);
    }
```

### 3. `src/services/TaskViewerProvider.ts` — remove polling start from `launchMcpMonitorTerminal`

The existing `launchMcpMonitorTerminal` (line 20512) creates the terminal and sends the startup command. Remove any `_startMcpMonitorLoop()` and `_scheduleMcpMonitorFirstPrompt()` calls from this method (added by companion plans). Terminal creation should NOT start polling:

```ts
    public async launchMcpMonitorTerminal(): Promise<void> {
        // ... existing terminal creation + startup command code (lines 20513-20580) ...
        // DO NOT call _startMcpMonitorLoop() here.
        // DO NOT call _scheduleMcpMonitorFirstPrompt() here.

        // Push updated status to kanban
        await this._postMcpMonitorConfig();
    }
```

### 4. `src/services/TaskViewerProvider.ts` — add `checkMcpMonitorAuth` method

Sends a real MCP diagnostic prompt to the terminal so the user can see whether Claude is authenticated and MCP servers are connected:

```ts
    /**
     * Send a diagnostic prompt to the monitor terminal that tests whether Claude
     * is authenticated and MCP servers are connected. The user reads the terminal
     * output to determine if things are working. This is non-blocking — it just
     * sends text to the terminal, same as a normal tick.
     */
    public async checkMcpMonitorAuth(): Promise<boolean> {
        const targetName = 'MCP Monitor';
        const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(targetName));
        const terminal = vscode.window.terminals.find(t => {
            const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
            return tName === strippedTarget && t.exitStatus === undefined;
        });
        if (!terminal) {
            return false;
        }
        const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        const testPrompt = this._buildMcpMonitorAuthPrompt(cfg);
        await sendRobustText(terminal, testPrompt, true);
        return true;
    }

    /**
     * Build the auth-check prompt from the user's selected sources. Lists the
     * specific MCP servers Claude should check so the response covers exactly
     * the services the monitor is configured to use.
     */
    private _buildMcpMonitorAuthPrompt(cfg: McpMonitorConfig): string {
        const sources = cfg.sources || [];
        const sourceNames: string[] = [];
        for (const src of sources) {
            if (src === 'custom') {
                if (cfg.customInstruction && cfg.customInstruction.trim()) {
                    sourceNames.push(cfg.customInstruction.trim());
                }
            } else if (src === 'slack') {
                sourceNames.push('Slack');
            } else if (src === 'gmail') {
                sourceNames.push('Gmail');
            } else if (src === 'gcal') {
                sourceNames.push('Google Calendar');
            }
        }
        if (sourceNames.length === 0) {
            return 'Am I authenticated to use MCP servers? Check each connected MCP server and report its authentication status. If any are not authenticated, explain how I can authenticate.';
        }
        const list = sourceNames.map(n => `- ${n}`).join('\n');
        return `Am I authenticated to use these MCP servers?\n${list}\n\nCheck each one and report its authentication status. If any are not authenticated, explain how I can authenticate.`;
    }
```

### 5. `src/services/TaskViewerProvider.ts` — add `startMcpMonitorPolling` and `stopMcpMonitorPolling` methods

```ts
    /**
     * Start the periodic polling loop. Available whenever a terminal is running.
     * No auth gate — the user is responsible for verifying auth before starting.
     */
    public async startMcpMonitorPolling(): Promise<void> {
        await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: true });
        await this._startMcpMonitorLoop();
        // Schedule the first prompt (30s one-shot from companion plan)
        this._scheduleMcpMonitorFirstPrompt();
        await this._postMcpMonitorConfig();
    }

    /**
     * Stop the polling loop but keep the terminal alive.
     */
    public async stopMcpMonitorPolling(): Promise<void> {
        await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: false });
        this._stopMcpMonitorLoop();
        await this._postMcpMonitorConfig();
    }
```

### 6. `src/extension.ts` — register the new commands

Near line 1335 (where `launchMcpMonitorTerminal` is registered):

```ts
    const checkMcpMonitorAuthDisposable = vscode.commands.registerCommand('switchboard.checkMcpMonitorAuth', async () => {
        return taskViewerProvider.checkMcpMonitorAuth();
    });
    context.subscriptions.push(checkMcpMonitorAuthDisposable);

    const startMcpMonitorPollingDisposable = vscode.commands.registerCommand('switchboard.startMcpMonitorPolling', async () => {
        await taskViewerProvider.startMcpMonitorPolling();
    });
    context.subscriptions.push(startMcpMonitorPollingDisposable);

    const stopMcpMonitorPollingDisposable = vscode.commands.registerCommand('switchboard.stopMcpMonitorPolling', async () => {
        await taskViewerProvider.stopMcpMonitorPolling();
    });
    context.subscriptions.push(stopMcpMonitorPollingDisposable);
```

### 7. `src/services/KanbanProvider.ts` — add message handlers

Near line 5752 (where `launchMcpMonitorTerminal` is handled):

```ts
            case 'checkMcpMonitorAuth': {
                await vscode.commands.executeCommand('switchboard.checkMcpMonitorAuth');
                break;
            }
            case 'startMcpMonitorPolling': {
                await vscode.commands.executeCommand('switchboard.startMcpMonitorPolling');
                break;
            }
            case 'stopMcpMonitorPolling': {
                await vscode.commands.executeCommand('switchboard.stopMcpMonitorPolling');
                break;
            }
```

### 8. `src/webview/kanban.html` — add `pollingEnabled` to webview state

Near line 6139:

```js
        let mcpMonitorConfig = { enabled: false, pollingEnabled: false, intervalMinutes: 5, targetRole: 'mcp_monitor', sources: ['slack'], customInstruction: '' };
```

The `updateMcpMonitorConfig` handler (line 6803) already replaces config wholesale (`mcpMonitorConfig = msg.config`), so the new field flows through automatically.

### 9. `src/webview/kanban.html` — replace the status line with three-button control panel

Replace the status line (lines 7880-7898) with a three-button flow. No wizard gating — the buttons are shown conditionally based on terminal and polling state, but there's no auth-confirmation gate:

```js
            // Status & Controls — three independent buttons
            const controlsContainer = document.createElement('div');
            controlsContainer.style.cssText = 'margin-top:8px; padding-top:6px; border-top:1px dashed var(--border-color); font-size:9px; line-height:1.3;';

            // Terminal status + Start Terminal button
            const termStatus = document.createElement('div');
            termStatus.style.cssText = 'margin-bottom:6px;';
            if (isMcpMonitorTerminalRunning) {
                termStatus.innerHTML = '🟢 <strong>Terminal:</strong> running';
            } else {
                termStatus.innerHTML = '🔴 <strong>Terminal:</strong> not started';
                const startTermBtn = document.createElement('button');
                startTermBtn.textContent = 'Start Terminal';
                startTermBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--accent-teal); color:var(--bg-primary); border:none; border-radius:3px;';
                guardInteraction(startTermBtn);
                startTermBtn.addEventListener('click', () => {
                    startTermBtn.disabled = true;
                    startTermBtn.textContent = 'Starting…';
                    postKanbanMessage({ type: 'launchMcpMonitorTerminal' });
                });
                termStatus.appendChild(startTermBtn);
            }
            controlsContainer.appendChild(termStatus);

            // Check Authentication button (only if terminal is running)
            if (isMcpMonitorTerminalRunning) {
                const authRow = document.createElement('div');
                authRow.style.cssText = 'margin-bottom:6px;';
                const authLabel = document.createElement('div');
                authLabel.innerHTML = '🔐 <strong>Authentication Check</strong>';
                authRow.appendChild(authLabel);

                const checkAuthBtn = document.createElement('button');
                checkAuthBtn.textContent = 'Check Authentication';
                checkAuthBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); border-radius:3px;';
                guardInteraction(checkAuthBtn);
                checkAuthBtn.addEventListener('click', () => {
                    checkAuthBtn.disabled = true;
                    checkAuthBtn.textContent = 'Check sent — see terminal…';
                    postKanbanMessage({ type: 'checkMcpMonitorAuth' });
                    // Re-enable after 3s so the user can retry
                    setTimeout(() => {
                        checkAuthBtn.disabled = false;
                        checkAuthBtn.textContent = 'Check Authentication';
                    }, 3000);
                });
                authRow.appendChild(checkAuthBtn);

                const authHelp = document.createElement('div');
                authHelp.style.cssText = 'margin-top:4px; font-size:8px; color:var(--text-secondary); line-height:1.3;';
                authHelp.textContent = 'Sends a prompt asking Claude to check authentication status for each MCP server and explain how to authenticate if needed. Check the terminal output — if servers are authenticated, you\'re good to start polling. If not, follow the instructions Claude provides to authenticate, then retry.';
                authRow.appendChild(authHelp);

                controlsContainer.appendChild(authRow);

                // Polling controls (only if terminal is running)
                const pollingRow = document.createElement('div');
                if (mcpMonitorConfig.pollingEnabled) {
                    pollingRow.innerHTML = '✅ <strong>Polling:</strong> active';
                    const stopPollingBtn = document.createElement('button');
                    stopPollingBtn.textContent = '⏸ Stop Polling';
                    stopPollingBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); border-radius:3px;';
                    guardInteraction(stopPollingBtn);
                    stopPollingBtn.addEventListener('click', () => {
                        postKanbanMessage({ type: 'stopMcpMonitorPolling' });
                    });
                    pollingRow.appendChild(stopPollingBtn);
                } else {
                    pollingRow.innerHTML = '⬜ <strong>Polling:</strong> stopped';
                    const startPollingBtn = document.createElement('button');
                    startPollingBtn.textContent = '▶ Start Polling';
                    startPollingBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--accent-teal); color:var(--bg-primary); border:none; border-radius:3px;';
                    guardInteraction(startPollingBtn);
                    startPollingBtn.addEventListener('click', () => {
                        postKanbanMessage({ type: 'startMcpMonitorPolling' });
                    });
                    pollingRow.appendChild(startPollingBtn);
                }
                controlsContainer.appendChild(pollingRow);
            }

            mcpConfigPanel.appendChild(controlsContainer);
```

### 10. `src/webview/kanban.html` — update the on/off dropdown semantics

The existing on/off dropdown (line 7778) sets `enabled`, which now controls only panel visibility (not the loop). The `saveMonitorConfig` function (line 7906) should not change `pollingEnabled` — that's controlled by the Start/Stop Polling buttons:

```js
            const saveMonitorConfig = () => {
                const enabled = mcpSelect.value === 'on';  // panel visibility only
                const intervalMinutes = parseInt(intervalSelect.value, 10);
                const customInstruction = customInstructionTextarea.value;
                const sources = Array.from(activeSources);
                mcpMonitorConfig = { ...mcpMonitorConfig, enabled, intervalMinutes, sources, customInstruction };
                postKanbanMessage({
                    type: 'setMcpMonitorConfig',
                    config: {
                        enabled,           // panel visibility
                        intervalMinutes,   // polling interval (used when polling starts)
                        sources,
                        customInstruction
                        // pollingEnabled is preserved on the backend (setMcpMonitorConfig uses ?? current.X)
                    }
                });
            };
```

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — three-button flow:**
   - Enable the monitor (on/off dropdown → "on"). Config panel appears.
   - Confirm the status shows "🔴 Terminal: not started" + "Start Terminal" button. No auth or polling buttons visible.
   - Click "Start Terminal". Terminal opens, `claude` starts. Status updates to "🟢 Terminal: running". Auth check and polling buttons appear.
   - Confirm NO polling has started (no prompt sent, no interval timer running).
3. **Manual — auth check (diagnostic):**
   - Click "Check Authentication". Confirm the terminal receives a prompt listing the specific selected sources, e.g.: "Am I authenticated to use these MCP servers?\n- Slack\n- Gmail\n\nCheck each one and report its authentication status. If any are not authenticated, explain how I can authenticate."
   - Look at the terminal output. If Claude is authenticated and MCP servers are configured, Claude reports auth status as OK. If not, Claude explains how to authenticate — follow those steps, then retry.
   - Confirm the button re-enables after 3 seconds (can retry).
4. **Manual — start polling:**
   - Click "▶ Start Polling". Confirm the polling loop starts (30s one-shot fires, then interval begins). Status updates to "✅ Polling: active" + "⏸ Stop Polling" button.
5. **Manual — stop polling (keeps terminal):**
   - Click "⏸ Stop Polling". Confirm the interval stops (no more prompts). Status updates to "⬜ Polling: stopped" + "▶ Start Polling" button. The terminal is still alive.
   - Click "▶ Start Polling" again. Confirm polling resumes without re-creating the terminal.
6. **Manual — auth check while polling:**
   - Start polling. Click "Check Authentication". Confirm the test prompt is sent alongside the polling prompts — no conflict, no crash. Polling continues.
7. **Manual — terminal killed resets the flow:**
   - Start the terminal, start polling. Kill the terminal manually.
   - Confirm the status resets: "🔴 Terminal: not started" + "Start Terminal" button. Auth and polling buttons disappear. Polling stops (companion plan's `handleTerminalClosed` calls `_stopMcpMonitorLoop`).
8. **Manual — backward compat (existing `enabled: true`):**
   - On an install with existing `mcpMonitor.enabled: true` (no `pollingEnabled` field), open the COMMS tab.
   - Confirm the config panel is visible (enabled maps to panel visibility).
   - Confirm `pollingEnabled` is read as `true` (falls back to `enabled`), so polling shows as active if a terminal is running. Existing users aren't disrupted.
9. **Regression:** The on/off dropdown still controls config panel visibility. Source checkboxes, interval, and custom instruction still save correctly. The `setMcpMonitorConfig` backend handler preserves `pollingEnabled` when it's not specified in the partial config.
