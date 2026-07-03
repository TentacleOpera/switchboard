# Rename "MCP Monitor" to "Comms Monitor" (Display Labels Only)

## Goal

Rename all user-facing displays of "MCP Monitor" to "Comms Monitor" across the extension UI. The internal role key `mcp_monitor`, config field `mcpMonitor`, terminal-matching logic, and persisted state keys must remain unchanged — this is a **display-label-only rename** to reflect that the feature monitors communications (Slack, Gmail, Calendar), not "MCP" (which is the transport mechanism, not the user-facing purpose).

### Problem Analysis & Root Cause

**Symptom:** The feature is called "MCP Monitor" everywhere in the UI, but "MCP" is an implementation detail (Model Context Protocol — the transport used to talk to Slack/Gmail/Calendar servers). Users don't think in terms of "MCP"; they think "this monitors my comms." The name is confusing and doesn't communicate the feature's purpose.

**Root cause:** The name was chosen early to reflect the technical mechanism. The internal role key `mcp_monitor` is now baked into:
- Persisted config (`~/.switchboard/integration-config.json` → `mcpMonitor` field, `targetRole: 'mcp_monitor'`)
- Terminal state (`state.terminals[key].role = 'mcp_monitor'`)
- Agent visibility config (`visibleAgents.mcp_monitor`)
- Startup command fallback lookup (`getAgentStartupCommand('mcp_monitor')`)
- Safety invariant checks (`role === 'mcp_monitor'`)
- `sharedDefaults.js` (`DEFAULT_VISIBLE_AGENTS.mcp_monitor`, `BUILT_IN_AGENT_LABELS`)

Renaming the internal key would break **all existing installs** — their persisted config references `mcp_monitor`, their terminal state has `role: 'mcp_monitor'`, and the code looks up startup commands by that key. Per the project's migration rules (CLAUDE.md): state that shipped in a released version MUST be migrated on change. A key rename would require a full migration of config files, state files, and visibility settings across ~4,000 installs — high risk, low value.

**Decision: display-only rename.** The internal key `mcp_monitor` stays. Only the human-readable labels shown in the UI change to "Comms Monitor". This is zero-risk to existing installs because no persisted key changes.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, rename, ux, display-only
- **Complexity:** 2
- **Project:** switchboard
- **Files touched:** `src/webview/sharedDefaults.js`, `src/webview/kanban.html`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`

## Complexity Audit

**Routine.** This is a string-replacement task across four files, touching only display labels. No logic changes, no schema changes, no migrations. The only risk is missing a label location or accidentally renaming an internal key — mitigated by an exhaustive grep audit (performed during investigation) and a verification grep step.

**What does NOT change (critical):**
- The role key string `'mcp_monitor'` in all code paths (config lookups, state, startup commands, safety checks).
- The config field name `mcpMonitor` in `GlobalIntegrationConfigService.ts`.
- The `targetRole: 'mcp_monitor'` default.
- The terminal name matching logic (`_stripIdeSuffix('MCP Monitor')` → see below for the one exception).

**The terminal-name edge case:** `launchMcpMonitorTerminal` (TaskViewerProvider.ts:20513) creates a terminal named `'MCP Monitor'`, and `_mcpMonitorTick` (line 20426) / `_isMcpMonitorTerminalRunning` (line 20594) find it by matching that name. If we rename the terminal to "Comms Monitor", the matching logic must use the new name. This is safe because the match is always against the same literal — we change both the creation literal and the lookup literals together. Existing live terminals named "MCP Monitor" from a prior session would no longer be found by the new lookup — but the launch function disposes zombie terminals and creates a fresh one, so the user just relaunches once. This is acceptable and documented in the verification plan.

## Edge-Case & Dependency Audit

- **Existing live terminals named "MCP Monitor":** After the rename, the tick logic looks for "Comms Monitor". A terminal from a pre-rename session named "MCP Monitor" won't be found → tick skips it (dead-terminal guard). The user clicks "Launch" again → a new "Comms Monitor" terminal is created. One-time inconvenience, no data loss.
- **Persisted terminal state with `role: 'mcp_monitor'`:** The role key in state is unchanged (`'mcp_monitor'`). The `friendlyName` field (line 20560) changes from `'MCP Monitor'` to `'Comms Monitor'` — this is a display field, not a lookup key. Existing state with `friendlyName: 'MCP Monitor'` is harmless (it's only used for display; the lookup uses `role`).
- **Agent grid label:** `BUILT_IN_AGENT_LABELS` in `sharedDefaults.js` (line 47) has `{ key: 'mcp_monitor', label: 'MCP Monitor' }`. The `key` stays `'mcp_monitor'`; only `label` changes to `'Comms Monitor'`.
- **Extension.ts agent push:** Line 2647 pushes `{ name: 'MCP Monitor', role: 'mcp_monitor' }`. The `role` stays; `name` changes to `'Comms Monitor'`.
- **Console log / error messages:** Internal log strings like `[MCP Monitor] Tick failed` (line 20415) are developer-facing. Renaming them to `[Comms Monitor]` is cosmetic but keeps logs consistent with the new UI name. Low priority but included for consistency.
- **No `confirm()` dialogs introduced.**

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` — update the agent label

Line 47:

```js
    { key: 'mcp_monitor', label: 'Comms Monitor' }
```

### 2. `src/webview/kanban.html` — update all display labels

- Line 7777: `mcpLabel.textContent = 'COMMS MONITOR:';`
- Line 7949: `mcpDesc.textContent = 'The Comms Monitor periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar for new messages and events — so you don\'t have to open those apps manually. Results appear in the monitor terminal pane.';`
- Line 7903 (help text, if not already updated by the companion plan): replace "MCP Monitor" with "Comms Monitor" in the help text.
- Line 7884: `statusLine.innerHTML = '🟢 <strong>Comms Monitor terminal:</strong> running';`
- Line 7886: `statusLine.innerHTML = '🔴 <strong>No comms monitor terminal running.</strong>';`
- Line 7888: `launchBtn.textContent = 'Launch Comms Monitor Terminal';`

### 3. `src/services/TaskViewerProvider.ts` — update terminal name and display strings

- Line 20513: `const targetName = 'Comms Monitor';`
- Line 20426: `const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix('Comms Monitor'));`
- Line 20594: `const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix('Comms Monitor'));`
- Line 16425: `const displayName = role === 'jules_monitor' ? "Jules Monitor" : "Comms Monitor";`
- Line 20560: `state.terminals[key].friendlyName = 'Comms Monitor';` (was `targetName`, which is now `'Comms Monitor'` — this line already uses `targetName` so it updates automatically, but verify).
- Line 20415: `console.error('[Comms Monitor] Tick failed:', err);`
- Line 3893: `console.log(\`[TaskViewerProvider] Applied comms_monitor fallback command: ${cmd}\`);` (cosmetic — the role key in the log stays `mcp_monitor` for code-searchability; alternatively keep as-is. Recommended: change the display portion but keep the key reference: `Applied mcp_monitor (Comms Monitor) fallback command`.)

### 4. `src/extension.ts` — update the agent grid name

- Line 2647: `agents.push({ name: 'Comms Monitor', role: 'mcp_monitor' });`
- Line 2675: `agentNames.add('Comms Monitor');`
- Line 2692: `vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, 'Comms Monitor'));`
- Line 2694: `outputChannel?.appendLine(\`[Extension] Disposing hidden grid terminal '${terminal.name}' for agent 'Comms Monitor'\`);`
- Line 2697-2698: `registeredTerminals.delete('Comms Monitor');` and `registeredTerminals.delete(suffixedName('Comms Monitor'));`

### What does NOT change (verification checklist)

- `GlobalIntegrationConfigService.ts`: `mcpMonitor` field name, `targetRole: 'mcp_monitor'` default — **unchanged**.
- `sharedDefaults.js` line 13: `mcp_monitor: false` in `DEFAULT_VISIBLE_AGENTS` — **unchanged** (this is the key, not the label).
- `TaskViewerProvider.ts` line 3931: `mcp_monitor: false` in defaults — **unchanged**.
- `TaskViewerProvider.ts` line 20536: `await this.setVisibleAgent('mcp_monitor', true);` — **unchanged**.
- `TaskViewerProvider.ts` line 20559: `state.terminals[key].role = 'mcp_monitor';` — **unchanged**.
- `TaskViewerProvider.ts` line 20567: `await this.getAgentStartupCommand('mcp_monitor');` — **unchanged**.
- `TaskViewerProvider.ts` line 3891: `if (role === 'mcp_monitor' && ...)` — **unchanged**.
- `TaskViewerProvider.ts` line 16423: `if (role === 'jules_monitor' || role === 'mcp_monitor')` — **unchanged**.
- `KanbanProvider.ts` line 5753: `'switchboard.launchMcpMonitorTerminal'` command ID — **unchanged** (renaming the command ID would break keybindings and external references; the command is internal).
- `extension.ts` line 1335: `'switchboard.launchMcpMonitorTerminal'` registration — **unchanged**.

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Grep audit — no stray "MCP Monitor" display labels remain:**
   - `grep -rn "MCP Monitor" src/` (excluding `dist/`) should return **zero** matches in display strings. The only acceptable remaining matches are in code comments or the command ID `launchMcpMonitorTerminal` (which is internal, not displayed).
   - `grep -rn "MCP MONITOR" src/` should return **zero** matches.
3. **Grep audit — internal keys preserved:**
   - `grep -rn "'mcp_monitor'" src/` should return the **same** matches as before the rename (config lookups, state, startup command, safety checks).
   - `grep -rn "mcpMonitor" src/services/GlobalIntegrationConfigService.ts` should be **unchanged**.
4. **Manual — AUTOMATION tab label:**
   - Open the kanban AUTOMATION tab. Confirm the dropdown label reads "COMMS MONITOR:" (not "MCP MONITOR:").
   - Confirm the description text says "Comms Monitor" (not "MCP Monitor").
   - Confirm the launch button reads "Launch Comms Monitor Terminal".
5. **Manual — terminal name:**
   - Click "Launch Comms Monitor Terminal". Confirm the created terminal is named "Comms Monitor" in the VS Code terminal panel.
   - Confirm the status line reads "🟢 Comms Monitor terminal: running".
6. **Manual — agent grid:**
   - If the agent grid is visible, confirm the monitor agent tile is labeled "Comms Monitor".
7. **Manual — existing installs (migration safety):**
   - On an install with pre-existing `~/.switchboard/integration-config.json` containing `mcpMonitor` config: confirm the config is still read correctly (the field name didn't change). The monitor enables, the interval persists, sources persist.
   - On an install with a live terminal from a pre-rename session (named "MCP Monitor"): confirm the tick logic does not find it (expected — name mismatch). Click "Launch" → new "Comms Monitor" terminal is created and ticks work.
8. **Regression:** The `switchboard.launchMcpMonitorTerminal` command ID is unchanged — any existing keybindings or external command references still work.
