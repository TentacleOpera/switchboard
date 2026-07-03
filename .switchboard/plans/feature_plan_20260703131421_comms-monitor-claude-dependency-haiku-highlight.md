# Comms Monitor: Highlight Claude Dependency and Haiku Model in UI

## Goal

The Comms Monitor (formerly MCP Monitor) depends on the `claude` CLI being installed and configured with MCP servers (Slack, Gmail, Google Calendar connectors). The current AUTOMATION tab UI does not communicate this dependency — a user without Claude installed or without MCP servers configured will launch the monitor terminal, see it fail silently, and not understand why. Additionally, the monitor uses the Haiku model to minimize token costs (the fallback startup command at `TaskViewerProvider.ts:3892` already specifies `--model claude-haiku-4-5`), but the UI never tells the user this, so they may override the startup command with a more expensive model without realizing the cost implications.

This plan adds:
1. A **dependency notice** in the AUTOMATION tab that explicitly states the Claude + MCP server requirement, with a quick checklist of what's needed.
2. A **model indicator** that shows which model the monitor will use (Haiku by default), with a note about cost savings.
3. A **warning** if the user has overridden the startup command with a non-Haiku model, so they understand the cost tradeoff.

### Problem Analysis & Root Cause

**Symptom 1 (hidden dependency):** The user enables the Comms Monitor, clicks "Launch", and the terminal opens. If `claude` is not installed, the terminal shows a shell error (`command not found: claude`) but the AUTOMATION tab still says "🟢 running". If Claude is installed but no MCP servers are configured, Claude starts but the prompt fails when it tries to call `mcp__slack__*` tools. In both cases the user has no idea what went wrong or what prerequisites they're missing.

**Root cause 1:** The UI (`kanban.html:7773-7954`) renders the monitor config panel with source checkboxes, interval, and a launch button — but zero prerequisite information. The help text at line 7903 mentions "via your claude.ai MCP servers" in passing, but doesn't frame it as a hard dependency or tell the user how to set it up. There's no check for whether `claude` is on the PATH or whether MCP servers are configured.

**Symptom 2 (hidden model / cost):** The fallback startup command (`TaskViewerProvider.ts:3892`) is `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`. This already uses Haiku — good. But the user can override this via the agent startup command config (`getAgentStartupCommand`, line 3880), and if they set a custom command without `--model claude-haiku-4-5`, they silently switch to the default (more expensive) model. The UI gives no indication of which model is in use or why Haiku was chosen.

**Root cause 2:** The startup command is resolved in the backend (`getAgentStartupCommand`) and sent to the terminal, but the resolved command is never surfaced to the UI. The webview has no visibility into which model flag is present.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, ux, claude, haiku, cost, dependency
- **Complexity:** 3
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`

## Complexity Audit

**Routine-to-moderate.** The change involves: (a) a backend method to resolve and return the startup command string to the webview (so the UI can display the model), (b) a static dependency-notice block in the HTML, and (c) a client-side model-detection check on the command string. No data migrations, no schema changes. The model detection is a simple string check (`--model claude-haiku` or `--model haiku` in the command). The Claude-installed check is best done client-side by attempting to detect the binary — but since the webview is sandboxed, the backend should expose a "prerequisites check" result.

**Design decision — don't over-engineer the prerequisite check:** A full "is claude installed + are MCP servers configured" check would require shelling out to `claude --version` and inspecting `~/.claude/mcp.json` or similar. This is fragile and varies by Claude version. Instead, this plan adds a **static notice** (always visible) that tells the user what's needed, plus a **model indicator** derived from the resolved startup command. A future plan can add a live prerequisite check if the static notice proves insufficient.

## Edge-Case & Dependency Audit

- **Startup command not yet resolved:** `getAgentStartupCommand` is async (reads config). The webview needs the resolved command to display the model. The backend should push it as part of the `_postMcpMonitorConfig` message (which already sends config to the webview). Add a `resolvedStartupCommand` field to that message.
- **Custom startup command with no model flag:** If the user's custom command is `claude` (no `--model`), the model indicator should say "Default model (not Haiku — higher cost)" rather than assuming Haiku. The fallback command has Haiku; a custom override may not.
- **Custom startup command with a different Haiku variant:** `--model claude-haiku-4-5`, `--model haiku`, `--model claude-3-5-haiku` should all be detected as "Haiku". Use a substring match for `haiku` (case-insensitive) in the command string.
- **Custom startup command with Sonnet/Opus:** Detect `sonnet` or `opus` in the command and show a cost warning.
- **Command is not `claude` at all:** If the user configures a completely different binary (e.g. `my-custom-agent`), the model detection should say "Custom command (model unknown)".
- **Dependency notice always visible:** The notice is static text, not conditional on any check. This is intentional — it's always relevant when the monitor is enabled. It should be compact so it doesn't dominate the panel.
- **No `confirm()` dialogs.** The cost warning is informational text, not a blocking dialog.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — include resolved startup command in the config push

In `_postMcpMonitorConfig` (line 20487), add the resolved startup command to the message:

```ts
    private async _postMcpMonitorConfig() {
        const config = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        const isMonitorRunning = this._isMcpMonitorTerminalRunning(config.targetRole);
        const resolvedStartupCommand = await this.getAgentStartupCommand('mcp_monitor');
        const message = {
            type: 'updateMcpMonitorConfig',
            config,
            isMonitorRunning,
            presets: TaskViewerProvider.SOURCE_PRESETS,
            resolvedStartupCommand   // NEW
        };
        this._view?.webview.postMessage(message);
        this._kanbanProvider?.postMessage(message);
    }
```

### 2. `src/webview/kanban.html` — store the resolved command in webview state

In the `updateMcpMonitorConfig` message handler (line 6803), store the resolved command:

```js
                  mcpMonitorConfig = msg.config || mcpMonitorConfig;
                  mcpMonitorPresets = msg.presets || mcpMonitorPresets;
                  mcpMonitorResolvedCmd = msg.resolvedStartupCommand || '';
```

Add the variable declaration near line 6139:

```js
        let mcpMonitorResolvedCmd = '';
```

### 3. `src/webview/kanban.html` — add the dependency notice block

Insert the notice at the top of the config panel (after `mcpConfigPanel` is created, line 7797, before the interval row). This is always visible when the panel is shown:

```js
            // Dependency Notice
            const depNotice = document.createElement('div');
            depNotice.style.cssText = 'padding:6px 8px; margin-bottom:8px; border:1px solid var(--accent-teal-dim); border-radius:4px; background:color-mix(in srgb, var(--accent-teal) 6%, transparent); font-size:9px; line-height:1.4; color:var(--text-primary);';
            depNotice.innerHTML = `
                <strong>📋 Prerequisites:</strong><br>
                This monitor requires the <code style="color:var(--accent-teal);">claude</code> CLI with MCP servers configured for the sources you want to watch.<br>
                <span style="color:var(--text-secondary);">• Install Claude: <code>npm i -g @anthropic-ai/claude-code</code></span><br>
                <span style="color:var(--text-secondary);">• Add MCP servers (Slack, Gmail, Calendar) via Claude's MCP config</span><br>
                <span style="color:var(--text-secondary);">• The monitor runs in a dedicated terminal using these servers</span>
            `;
            mcpConfigPanel.appendChild(depNotice);
```

### 4. `src/webview/kanban.html` — add the model indicator with cost warning

Insert the model indicator after the dependency notice, before the interval row:

```js
            // Model Indicator
            const modelRow = document.createElement('div');
            modelRow.style.cssText = 'padding:6px 8px; margin-bottom:8px; border:1px solid var(--border-color); border-radius:4px; background:var(--panel-bg2); font-size:9px; line-height:1.4;';

            const detectModel = (cmd) => {
                if (!cmd || !cmd.trim()) return { name: 'Unknown', isHaiku: false, isCustom: false };
                const lower = cmd.toLowerCase();
                if (!lower.includes('claude')) return { name: 'Custom command', isHaiku: false, isCustom: true };
                if (lower.includes('haiku')) return { name: 'Haiku', isHaiku: true, isCustom: false };
                if (lower.includes('sonnet')) return { name: 'Sonnet', isHaiku: false, isCustom: false };
                if (lower.includes('opus')) return { name: 'Opus', isHaiku: false, isCustom: false };
                return { name: 'Default (not Haiku)', isHaiku: false, isCustom: false };
            };

            const modelInfo = detectModel(mcpMonitorResolvedCmd);
            const modelIcon = modelInfo.isHaiku ? '💰' : '⚠️';
            const modelColor = modelInfo.isHaiku ? 'var(--accent-teal)' : 'var(--text-secondary)';
            const modelNote = modelInfo.isHaiku
                ? 'Using Haiku to minimize token costs. Each check is a short read-only query — Haiku is ideal.'
                : modelInfo.isCustom
                    ? 'Custom command detected. Model unknown — verify it uses Haiku for cost efficiency.'
                    : 'Not using Haiku. This monitor runs frequently — consider --model claude-haiku-4-5 to reduce costs.';

            modelRow.innerHTML = `
                <span style="color:${modelColor};">${modelIcon}</span>
                <strong style="color:var(--text-primary);">Model: ${modelInfo.name}</strong><br>
                <span style="color:var(--text-secondary);">${modelNote}</span>
            `;
            mcpConfigPanel.appendChild(modelRow);
```

### 5. `src/webview/kanban.html` — show the resolved command in a collapsible details element

For transparency, show the actual command that will be sent (collapsible to avoid clutter):

```js
            // Resolved command (collapsible)
            const cmdDetails = document.createElement('details');
            cmdDetails.style.cssText = 'margin-bottom:8px; font-size:9px; color:var(--text-secondary);';
            const cmdSummary = document.createElement('summary');
            cmdSummary.textContent = 'Startup command (resolved)';
            cmdSummary.style.cssText = 'cursor:pointer; color:var(--text-secondary);';
            const cmdPre = document.createElement('pre');
            cmdPre.style.cssText = 'margin-top:4px; padding:4px; background:var(--panel-bg); border:1px solid var(--border-color); border-radius:3px; font-size:9px; color:var(--text-primary); white-space:pre-wrap; word-break:break-all;';
            cmdPre.textContent = mcpMonitorResolvedCmd || '(not resolved)';
            cmdDetails.appendChild(cmdSummary);
            cmdDetails.appendChild(cmdPre);
            mcpConfigPanel.appendChild(cmdDetails);
```

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — dependency notice visible:**
   - Open AUTOMATION tab, enable the monitor. Confirm the "📋 Prerequisites" notice is visible at the top of the config panel, listing the `claude` CLI requirement, MCP server setup, and the dedicated terminal note.
3. **Manual — model indicator shows Haiku (default):**
   - With no custom startup command configured (using the fallback), confirm the model indicator shows "💰 Model: Haiku" with the cost-savings note.
   - Expand "Startup command (resolved)" — confirm it shows `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`.
4. **Manual — model indicator shows non-Haiku warning:**
   - Configure a custom startup command for `mcp_monitor` that uses `--model claude-sonnet-4` (via the Setup tab or config file).
   - Reopen the AUTOMATION tab. Confirm the model indicator shows "⚠️ Model: Sonnet" with the cost warning recommending Haiku.
5. **Manual — custom command detection:**
   - Configure a custom startup command that is not `claude` (e.g. `my-agent`). Confirm the indicator shows "⚠️ Model: Custom command" with the "model unknown" note.
6. **Manual — resolved command updates on config change:**
   - Change the startup command in Setup, return to AUTOMATION tab. Confirm the resolved command and model indicator reflect the new command (the `_postMcpMonitorConfig` push includes `resolvedStartupCommand`).
7. **Regression:** The `_postMcpMonitorConfig` message now includes `resolvedStartupCommand` — existing message handlers that destructure the message (line 6803) ignore unknown fields, so no breakage. The `updateMcpMonitorConfig` handler in the webview only reads `config`, `presets`, and (now) `resolvedStartupCommand` — extra fields are harmless.
