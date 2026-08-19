# Add MCP config distribution — push MCP server configs to all agents from terminals.html

## Goal

Users running multiple AI coding CLIs (Claude Code, Cursor, Devin, Windsurf) must currently configure MCP servers separately for each platform — `.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor, `~/.codeium/windsurf/mcp_config.json` for Windsurf, etc. A user who wants ClickUp MCP, MongoDB MCP, and RevenueCat MCP available to all their agents must manually create or edit N config files per platform, with no central management. Add a "Setup MCP" button to terminals.html that pushes MCP server configs to every active terminal agent in one click. Each agent receives the configs and registers them with its own platform — Switchboard does not need to know platform-specific config formats.

### Problem analysis and root cause

Switchboard's agents tab (`terminals.html`) manages a fleet of PTY terminals running AI coding CLIs. The user enters startup commands (e.g., `claude`, `cursor`, `devin`) and Switchboard spawns them. Each CLI platform has its own MCP server config mechanism:

- Claude Code: `.mcp.json` in workspace root, or `claude mcp add` CLI command
- Cursor: `.cursor/mcp.json` (workspace) or `~/.cursor/mcp.json` (global)
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Devin: web dashboard or session environment parameters
- Gemini CLI: `.gemini/settings.json` with `mcpServers` key
- Kiro: `.kiro/settings/mcp.json`

Switchboard already knows about all these config paths (see `extension.ts` lines 967-973, which clean up stale `switchboard` entries from each). But there is no mechanism to push MCP server configs TO these files — only cleanup logic to remove old Switchboard entries.

The root cause is that MCP server configuration is per-platform with no universal format or discovery mechanism. Each platform reads its own config file in its own location. There is no "register once, discover everywhere" protocol. The user is the manual bridge between "I want this MCP server" and "N platform config files."

### Solution approach

Instead of Switchboard writing per-platform config files (which requires knowing each format and risks overwriting user configs), Switchboard sends a setup message to each terminal agent via `ptySendPrompt`. The agent — which knows its own platform — receives the MCP server configs and registers them itself. Switchboard is the config source; the agent is the config writer.

This works because:
1. Switchboard already has `ptySendPrompt` — the mechanism to send prompts to terminals
2. AI agents can edit files and run CLI commands in their own environment
3. Each agent knows its own platform's MCP config format better than Switchboard does
4. The user clicks one button instead of editing N files

**Feedback gap (architecture review finding):** The push-via-prompt architecture is fire-and-forget — Switchboard confirms *dispatch* (the `ptySendPrompt` call succeeded), not *registration* (the agent actually wrote the config). The toast says "dispatched to N terminals," not "registered." Registration confirmation comes from the agent's terminal output, which the user must read. This is inherent to the design and acceptable — Switchboard cannot verify agent-side file writes — but the implementer and user must understand the toast measures dispatch, not outcome.

## Metadata

**Complexity:** 4
**Tags:** ui, backend, infrastructure, cli

## User Review Required

No.

## Complexity Audit

### Routine
- Adding a "Setup MCP" button to terminals.html sidebar (next to CLEAR ALL, SAVE AS GROUP, LINK UP)
- Adding a modal/dialog for MCP server config entry (name, command, args, env)
- Storing MCP server configs in `GlobalIntegrationConfigService` (`~/.switchboard/integration-config.json`)
- Sending a `ptySendPrompt` to each active terminal with the MCP setup instructions
- New API endpoint: `GET /mcp/config` (returns stored MCP server configs) and `POST /mcp/config` (saves them)

### Complex / Risky
- **Agent platform diversity** — the setup message must work across Claude Code, Cursor, Devin, Windsurf, and others. Each platform has different MCP registration mechanisms. The message should be platform-agnostic: "Here are MCP server configs, register them with your platform." The agent figures out how. But some agents may not understand the instruction or may not have MCP support.
- **Config format** — MCP server configs have a standard shape (`command`, `args`, `env`) that all platforms use. Switchboard stores this neutral shape and the agent translates to its platform's format.
- **Idempotency** — clicking "Setup MCP" multiple times should not create duplicate entries. The setup message should instruct agents to update existing entries, not append duplicates.

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — add MCP server config storage

Add an `mcpServers` field to `GlobalConfig`:

```ts
export interface GlobalConfig {
    // ... existing fields
    /**
     * MCP server configs to push to all agents via the "Setup MCP" button.
     * Each entry follows the standard MCP server config shape (command/args/env).
     * Platform-agnostic — agents translate to their own config format.
     */
    mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
    name: string;           // e.g. "clickup", "mongodb", "switchboard"
    command: string;        // e.g. "npx", "node"
    args: string[];         // e.g. ["-y", "@clickup/mcp-server"]
    env?: Record<string, string>;  // e.g. { "CLICKUP_TOKEN": "..." }
    description?: string;   // human-readable, shown in UI
}
```

Add getter/setter methods. The class uses `loadGlobalSync()` for synchronous reads and `loadGlobal()` (async) / `saveGlobal(config)` (async) for writes — there is no `readConfig` or `writeConfig` method:

> **Superseded:** `this.readConfig()` for reading and `await this.writeConfig(config)` for writing.
> **Reason:** These methods do not exist on `GlobalIntegrationConfigService`. The class provides `loadGlobalSync()` (sync read), `loadGlobal()` (async read), and `saveGlobal(config)` (async write). The original code would fail to compile.
> **Replaced with:** `this.loadGlobalSync()` for the sync getter and `this.loadGlobal()` + `await this.saveGlobal(config)` for the async setter.

```ts
static getMcpServers(): McpServerConfig[] {
    const config = this.loadGlobalSync();
    return config.mcpServers || [];
}

static async setMcpServers(servers: McpServerConfig[]): Promise<void> {
    const config = await this.loadGlobal();
    config.mcpServers = servers;
    await this.saveGlobal(config);
}
```

### 2. `src/services/LocalApiServer.ts` — add MCP config endpoints

**Important:** `GlobalIntegrationConfigService` is NOT currently imported in `LocalApiServer.ts`. The implementer must add the import at the top of the file:

```ts
import { GlobalIntegrationConfigService, McpServerConfig } from './GlobalIntegrationConfigService';
```

> **Superseded:** "following the existing pattern for other config endpoints"
> **Reason:** There are NO existing `GlobalIntegrationConfigService` endpoints in `LocalApiServer.ts`. Config access in this codebase goes through the verb system (`/setup/verb/<name>` → `_handleSetupVerb` → `SetupPanelProvider`). The top-level route pattern (`/mcp/config`) follows the kanban/task route style (`/kanban/move`, `/task/clickup`), not a config-endpoint pattern. The original claim was misleading about which pattern is being followed.
> **Replaced with:** Top-level REST routes in `_handleRequest`, following the kanban/task route pattern (pathname-matched `if/else` branches in the `_handleRequest` chain). This is a deliberate choice: the `/mcp/` namespace is self-contained like `/kanban/`, and the feature doesn't need the verb system's schema validation or catalog registration.

Add two endpoints for reading/writing MCP server configs:

```
GET /mcp/config — returns { servers: McpServerConfig[] }
POST /mcp/config — body: { servers: McpServerConfig[] }, saves to integration-config.json
```

In `_handleRequest` (the `if/else` chain starting at line 4410), add routing for these paths. Insert the new branches alongside the existing top-level routes (e.g., after the `/health` and `/metadata/*` branches, before the `/kanban/*` branches):

```ts
if (pathname === '/mcp/config' && req.method === 'GET') {
    const servers = GlobalIntegrationConfigService.getMcpServers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers }));
    return;
}

if (pathname === '/mcp/config' && req.method === 'POST') {
    const body = await this._parseJsonBody(req);
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    // Validate: each server must have name + command
    for (const s of servers) {
        if (!s.name || !s.command) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Server missing name or command: ${JSON.stringify(s)}` }));
            return;
        }
    }
    await GlobalIntegrationConfigService.setMcpServers(servers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
}
```

**Note on auth:** The top-level routes in `_handleRequest` (e.g., `/health`, `/kanban/move`) do not uniformly call `_checkAuth`. The webview is same-origin localhost. If the implementer finds that other config-adjacent routes call `_checkAuth`, add it here for consistency. If not, follow the `/kanban/move` pattern (no explicit auth call in the route — the localhost-only check at line 4413 is the gate).

### 3. `src/webview/terminals.html` — add "Setup MCP" button

Add a button in the sidebar ops block (`.sidebar-ops`), after the LINK UP button at line 2074:

```html
<button type="button" id="btn-setup-mcp" class="secondary-btn w-full"
        title="Push MCP server configs to all active terminals">SETUP MCP</button>
```

### 4. `src/webview/terminals.js` — MCP setup modal and dispatch

Add a modal dialog for managing MCP server configs and a dispatch function that sends the setup message to all active terminals.

**Modal UI:** when the user clicks "SETUP MCP", show a modal with:
- List of currently configured MCP servers (name, command, args, env)
- Add/edit/delete buttons for each server
- A "SEND TO ALL TERMINALS" button that dispatches the setup message

**Dispatch function:**

> **Superseded:** `fetch('/terminals/verb/ptyListTerminals')` (bare GET fetch) and `terminal.name` / `terminal.isAlive` field access in the dispatch loop.
> **Reason:** The verb endpoints are POST-only — the router at line 4521 checks `req.method === 'POST'`. A bare `fetch()` defaults to GET and would receive 405 Method Not Allowed. Additionally, the `ptyListTerminals` response returns terminal objects with `friendlyName` (not `name`) and `status` (not `isAlive`). Since `terminal.name` is `undefined`, `!terminal.name` evaluates to `true`, causing `continue` to fire for every terminal — the loop body would never execute and zero terminals would receive the setup message. Confirmed at line 2529: `fleet.some(t => t && t.friendlyName === name && t.status === 'active')`.
> **Replaced with:** POST fetch with JSON body `{}` for `ptyListTerminals`, and `terminal.friendlyName` / `terminal.status === 'active'` for field access.

> **Superseded:** `clearBeforePrompt: false` as the only option on the `ptySendPrompt` call.
> **Reason:** The relay code at line 2563 explicitly passes `standingOrders: false` to prevent the agent's standing-orders block from being appended to the message. Omitting it risks inflating the MCP setup message with unrelated directives.
> **Replaced with:** Add `standingOrders: false` alongside `clearBeforePrompt: false`.

> **Superseded:** Toast message "MCP setup sent to N terminals."
> **Reason:** "Sent" implies the MCP servers were registered. The `ptySendPrompt` success only confirms *dispatch* (the message reached the terminal), not *registration* (the agent wrote the config). This is a metric-vs-goal gap: the toast measures the call, not the outcome.
> **Replaced with:** "MCP setup dispatched to N terminals. Check each terminal for registration confirmation."

```js
async function setupMcpOnAllTerminals() {
    const configRes = await fetch('/mcp/config');
    const { servers } = await configRes.json();
    if (!servers || servers.length === 0) {
        showPaneToast('No MCP servers configured. Add some first.');
        return;
    }

    // Build the setup message — platform-agnostic instructions
    const serverLines = servers.map(s => {
        const envStr = s.env ? `\n  env: ${JSON.stringify(s.env)}` : '';
        return `- name: ${s.name}\n  command: ${s.command}\n  args: ${JSON.stringify(s.args)}${envStr}`;
    }).join('\n');

    const setupMessage = `You have been asked to set up MCP servers by Switchboard. Register the following MCP servers with your platform (e.g., claude mcp add, .cursor/mcp.json, ~/.codeium/windsurf/mcp_config.json). If an entry with the same name already exists, update it — do not create duplicates.

MCP servers to register:

${serverLines}

After registering, confirm which servers were set up. If your platform does not support MCP, say so.`;

    // Get all active terminals — ptyListTerminals is POST-only
    const listRes = await fetch('/terminals/verb/ptyListTerminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const listData = await listRes.json();
    const terminals = (listData && Array.isArray(listData.terminals) ? listData.terminals : []);

    let dispatched = 0;
    for (const terminal of terminals) {
        // ptyListTerminals returns friendlyName and status, not name/isAlive
        if (!terminal.friendlyName || terminal.status !== 'active') continue;
        try {
            const res = await fetch('/terminals/verb/ptySendPrompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: terminal.friendlyName,
                    data: setupMessage,
                    clearBeforePrompt: false,
                    standingOrders: false
                })
            });
            const result = await res.json();
            if (result.success) dispatched++;
        } catch (err) {
            console.error(`Failed to dispatch MCP setup to ${terminal.friendlyName}:`, err);
        }
    }

    if (dispatched === 0) {
        showPaneToast('No active terminals to dispatch MCP setup to.');
    } else {
        showPaneToast(`MCP setup dispatched to ${dispatched} terminal${dispatched !== 1 ? 's' : ''}. Check each terminal for registration confirmation.`);
    }
}
```

**Button wiring** (in the existing event listener setup section, near `btnLinkUp` at line 1089):

```js
const btnSetupMcp = document.getElementById('btn-setup-mcp');
if (btnSetupMcp) {
    btnSetupMcp.addEventListener('click', () => {
        showMcpSetupModal();
    });
}
```

### 5. `src/webview/terminals.js` — MCP setup modal

The modal allows the user to manage MCP server configs before pushing them:

```js
function showMcpSetupModal() {
    // Modal with:
    // - List of configured MCP servers (from GET /mcp/config)
    // - Add new server form (name, command, args as comma-separated, env as key=value pairs)
    // - Edit/delete existing servers
    // - "Save" button → POST /mcp/config
    // - "Send to All Terminals" button → setupMcpOnAllTerminals()
    // The modal follows the same pattern as the existing link-modal (openLinkModal at line 9513)
}
```

### 6. `src/webview/terminals.html` — modal HTML

> **Superseded:** `<div id="mcp-setup-modal" class="modal hidden">` with `class="modal-content"`.
> **Reason:** The existing modal in `terminals.html` (line 2125) uses `<div id="link-modal" class="link-modal" hidden>` — a specific class name (`link-modal`) and the HTML `hidden` attribute (not a `.hidden` CSS class). There is no `.modal` or `.modal.hidden` CSS rule in `terminals.html`. The proposed markup would render unstyled and visible on page load.
> **Replaced with:** Follow the `link-modal` pattern: use a dedicated class (e.g., `mcp-modal`) with the `hidden` attribute, and add corresponding CSS rules mirroring `.link-modal` / `.modal-content` / `.modal-header` / `.modal-body` / `.modal-footer`.

Add the modal dialog HTML after the existing `link-modal` block (after line ~2160), following the `link-modal` structure:

```html
<div id="mcp-setup-modal" class="mcp-modal" hidden>
    <div class="modal-content">
        <div class="modal-header">
            <span class="modal-title">MCP Server Setup</span>
            <button type="button" class="modal-close-btn" id="mcp-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
            <div id="mcp-server-list"></div>
            <div class="mcp-server-form">
                <input type="text" id="mcp-server-name" placeholder="Server name (e.g. clickup)" />
                <input type="text" id="mcp-server-command" placeholder="Command (e.g. npx)" />
                <input type="text" id="mcp-server-args" placeholder="Args (comma-separated)" />
                <input type="text" id="mcp-server-env" placeholder="Env (KEY=value, comma-separated)" />
                <input type="text" id="mcp-server-desc" placeholder="Description (optional)" />
                <button type="button" id="mcp-add-server" class="secondary-btn">ADD SERVER</button>
            </div>
        </div>
        <div class="modal-footer">
            <button type="button" id="mcp-setup-cancel" class="secondary-btn">CANCEL</button>
            <button type="button" id="mcp-setup-save" class="secondary-btn">SAVE CONFIG</button>
            <button type="button" id="mcp-setup-send" class="secondary-btn is-teal">SEND TO ALL TERMINALS</button>
        </div>
    </div>
</div>
```

Add CSS rules mirroring the existing `.link-modal` styles (line 1850 area), substituting `.mcp-modal` for `.link-modal`.

### 7. Setup panel integration (optional)

Add an MCP servers section to `setup.html` (the extension's setup panel) for users who prefer to configure MCP servers from the setup panel rather than terminals.html. This would use the same `GET /mcp/config` and `POST /mcp/config` endpoints. The setup panel already has sections for ClickUp, Linear, Notion integrations — an MCP servers section fits naturally.

This is optional for the initial implementation — the terminals.html modal is the primary UI.

## Edge-Case & Dependency Audit

**Agent platform diversity** — the setup message is platform-agnostic: "Register these MCP servers with your platform." Claude Code agents will use `claude mcp add` or edit `.mcp.json`. Cursor agents will edit `.cursor/mcp.json`. Devin agents will note they need dashboard configuration. Windsurf agents will edit `mcp_config.json`. The agent knows its platform; Switchboard does not need to. If an agent doesn't understand the instruction or doesn't support MCP, it will say so — no harm done.

**Idempotency** — the setup message instructs agents to update existing entries, not create duplicates. Agents that support `claude mcp add --force` or equivalent will update in place. Agents that edit config files manually should check for existing entries by name before appending.

**Secrets in env vars** — MCP server configs may contain API tokens (e.g., `CLICKUP_TOKEN`). These are stored in `~/.switchboard/integration-config.json` (machine-global, not in the repo). The setup message sends them to terminal agents via `ptySendPrompt` — the same channel used for all terminal communication. No new security surface.

**Standalone mode** — the MCP config endpoints (`GET/POST /mcp/config`) are on LocalApiServer, which runs in both extension and standalone mode. The terminals.html UI is served by the same server. The feature works identically in standalone mode.

**Empty terminal fleet** — if no active terminals, the dispatch function shows a toast: "No active terminals to dispatch MCP setup to." No error.

**Config validation** — the `POST /mcp/config` endpoint validates that each server has a `name` and `command`. Args defaults to `[]`, env defaults to `{}`. No other validation — the agent will report if a config is invalid for its platform.

**Existing MCP cleanup** — `extension.ts` lines 963-989 clean up stale `switchboard` MCP entries from per-platform config files on activation. This is unrelated to the config distribution feature — it removes old entries from the removed `@switchboard/mcp` server. The new feature does not write to per-platform config files; agents do that themselves. No conflict.

**Concurrent setup** — if the user clicks "Setup MCP" while a previous setup is still in flight, the second click sends a duplicate message. This is harmless — the idempotency instruction tells agents to update, not duplicate. A simple debounce on the button prevents accidental double-clicks.

**Dispatch vs registration feedback gap** — the toast confirms dispatch (the `ptySendPrompt` call succeeded), not registration (the agent wrote the config). The user must read each terminal's output to confirm registration. This is inherent to the push-via-prompt architecture and is documented in the Solution approach section above.

## Dependencies

- None. This plan is self-contained. It uses existing infrastructure (`ptySendPrompt`, `GlobalIntegrationConfigService`, LocalApiServer endpoints, terminals.html UI).

## Adversarial Synthesis

Key risks: (1) five code-level bugs in the original plan — phantom `readConfig`/`writeConfig` methods, missing `GlobalIntegrationConfigService` import in `LocalApiServer.ts`, GET on a POST-only `ptyListTerminals` endpoint, wrong field names (`name`/`isAlive` vs `friendlyName`/`status`) that would silently skip all terminals, and a modal HTML pattern that doesn't match the existing `link-modal` structure — all corrected with Superseded callouts above; (2) dispatch-vs-registration feedback gap — the toast measures dispatch, not outcome, inherent to the push-via-prompt architecture; (3) missing `standingOrders: false` on `ptySendPrompt` risking message inflation. Mitigations: all code bugs corrected with accurate codebase references; toast renamed to "dispatched" with explicit check-terminal instruction; `standingOrders: false` added. Residual risk: some agents may not understand the setup instruction or may not support MCP — they will report back in their terminal, and the user can configure those manually.

## Verification Plan

### Automated Tests
- **New:** `src/test/mcp-config-distribution-contract.test.js`:
  - `GET /mcp/config` returns empty array when no servers configured
  - `POST /mcp/config` with valid servers saves and `GET` returns them
  - `POST /mcp/config` rejects server missing `name` or `command` (400)
  - `GlobalIntegrationConfigService.getMcpServers()` / `setMcpServers()` round-trip
- `npm run compile-tests` must be clean.
- `npm run catalog:check`, `npm run parity:check` — run to confirm.

### Manual
1. Open terminals.html. Click "SETUP MCP". Confirm the modal appears (styled, hidden on load).
2. Add an MCP server (e.g., name: `clickup`, command: `npx`, args: `-y, @clickup/mcp-server`). Save. Confirm it persists across page reloads.
3. Start a Claude Code terminal. Click "SEND TO ALL TERMINALS". Confirm the Claude Code agent receives the setup message and registers the MCP server (check `.mcp.json` or run `claude mcp list`). Read the terminal output for registration confirmation.
4. Start a Cursor terminal. Click "SEND TO ALL TERMINALS". Confirm the Cursor agent receives the setup message and registers the MCP server (check `.cursor/mcp.json`).
5. Click "SEND TO ALL TERMINALS" again. Confirm no duplicate entries are created.
6. Delete an MCP server from the modal. Save. Confirm it's removed from config.
7. Test with no active terminals — confirm the toast message appears ("No active terminals to dispatch MCP setup to.").

**Recommendation:** Complexity 4 → **Send to Coder.**
