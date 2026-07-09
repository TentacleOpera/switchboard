# PM Console Quick Action Button + Project Manager Agent Role

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature
**Project:** switchboard

## Goal

### Problem

The `switchboard-manage` skill is a host-agnostic management console persona that lets an
agent drive the Switchboard board over the LocalApiServer HTTP API. It is the only way to
manage the board from outside the VS Code webview (terminal agents, external coding hosts,
CI runners). But it has `disable-model-invocation: true` — it can only be activated by the
user explicitly triggering it — and there is no UI surface that tells the user it exists or
how to activate it. It is completely undiscoverable.

### Background

The Implementation panel's QUICK ACTIONS section (`implementation.html:1522`) has a 2×2 grid
of panel-opening buttons (Kanban, Artifacts, Design, Project) plus two full-width buttons
below (Setup, Guided Setup). Guided Setup is the existing precedent for a non-panel action:
it pre-flights workspace state, copies a tailored prompt to the clipboard, and tells the
user to paste it into their agent chat (`_handleGuidedSetup` at
`TaskViewerProvider.ts:22097`).

Terminal dispatch already exists via `sendPromptToAgentTerminal(role, text, workspaceRoot)`
(`TaskViewerProvider.ts:3281`), which resolves a role to a registered terminal agent, spawns
one if none exists, and sends the prompt. The `phone_a_friend` role
(`TaskViewerProvider.ts:3411`) is the closest analog — a non-coding conversational agent
that receives prompts via terminal dispatch.

Agent roles are defined across multiple locations:
- `agentConfig.ts:1` — `BuiltInAgentRole` type union (core roles only)
- `agentConfig.ts:111` — `BUILT_IN_AGENT_LABELS` record (core roles only)
- `sharedDefaults.js:2` — `DEFAULT_VISIBLE_AGENTS` (all roles including specialized)
- `sharedDefaults.js:19` — `DEFAULT_ROLE_CONFIG` (all roles with config entries)
- `sharedDefaults.js:37` — `BUILT_IN_AGENT_LABELS` array (all roles for UI rendering)
- `kanban.html:2880` — agents tab rows (visibility checkbox + startup command input)
- `TaskViewerProvider.ts:4437` — `getVisibleAgents` defaults

Specialized roles like `phone_a_friend`, `claude_artifacts`, `jules`, and `mcp_monitor`
exist in the UI/config layer but are NOT in the `BuiltInAgentRole` type — they don't go
through the kanban dispatch pipeline. The new `project_manager` role follows the same
pattern: it's a terminal-only conversational role, not a kanban card target.

### Root Cause

The skill was built as a backend capability with no frontend affordance. The discovery gap
is purely a UI problem — the plumbing (terminal dispatch, role registration, API server
health check) all exists and works.

### Solution

Add a "Manage" button to the QUICK ACTIONS section (teal, full-width, above Setup) and a
new `project_manager` agent role to the kanban agents tab. When clicked:

1. **Pre-flight**: Check that the LocalApiServer is running (port file exists +
   `isListening()`). If down, show an error — the manage skill hard-fails without it.
2. **Dispatch path**: If a `project_manager` terminal agent is registered, send the manage
   prompt directly to it via `sendPromptToAgentTerminal`.
3. **Fallback path**: If no PM terminal is registered, copy the manage prompt to clipboard
   and show an info message (same pattern as Guided Setup).

## Implementation

### 1. Add `project_manager` role to config layer

**`src/webview/sharedDefaults.js`**:
- Add `project_manager: false` to `DEFAULT_VISIBLE_AGENTS` (line 2).
- Add a `project_manager` entry to `DEFAULT_ROLE_CONFIG` (line 19):
  ```js
  project_manager: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } }
  ```
  Model on `phone_a_friend` (line 33) — same minimal addon set. `cavemanOutput: false`
  because the PM console reports structured status, not code diffs.
- Add `{ key: 'project_manager', label: 'Project Manager' }` to the
  `BUILT_IN_AGENT_LABELS` array (line 37).

**`src/services/TaskViewerProvider.ts`**:
- Add `project_manager: false` to the `getVisibleAgents` defaults object (line ~4437),
  alongside `phone_a_friend: false`.
- Add a startup command fallback in `getAgentStartupCommand` (line ~4388), modeled on
  `claude_artifacts`:
  ```ts
  if (role === 'project_manager' && (!cmd || cmd.trim() === '')) {
      cmd = 'claude';
      console.log(`[TaskViewerProvider] Applied project_manager fallback command: ${cmd}`);
  }
  ```

### 2. Add `project_manager` row to kanban agents tab

**`src/webview/kanban.html`** (after the Phone-a-Friend row at line 2903, inside the
Optional section):
```html
<div class="startup-row">
  <input type="checkbox" class="agents-tab-visible-toggle" data-role="project_manager"
    style="width:auto;margin:0;flex-shrink:0;">
  <label style="min-width:70px;">Project Manager</label>
  <input type="text" data-role="project_manager" id="agents-tab-cmd-project-manager"
    placeholder="e.g. claude" style="flex:1;">
</div>
<div class="agent-description">
  Host-agnostic management console — drives the board over the LocalApiServer HTTP API.
  Activate via the Manage button in the Implementation panel.
</div>
```

### 3. Add the "Manage" button to implementation.html

**`src/webview/implementation.html`** — insert a full-width teal button between the 2×2
grid (line 1531) and the Setup button (line 1532):
```html
<button id="btn-quick-manage" class="secondary-btn is-teal w-full"
  style="margin-top: 6px;"
  title="Activate the Switchboard management console in a terminal agent (or copy the prompt if no PM terminal is registered)">Manage</button>
```

Add the click listener (after line 1803, alongside the other quick-action listeners):
```js
const btnQuickManage = document.getElementById('btn-quick-manage');
if (btnQuickManage) btnQuickManage.addEventListener('click', () =>
  vscode.postMessage({ type: 'dispatchProjectManager' }));
```

### 4. Wire the message handler

**`src/services/TaskViewerProvider.ts`** — add routing case (line ~337 area):
```ts
case 'dispatchProjectManager': return await svc['dispatchProjectManager'](p);
```

Add switch case (line ~10070 area, alongside `guidedSetup`):
```ts
case 'dispatchProjectManager':
    await this._handleDispatchProjectManager();
    break;
```

Add the handler method (alongside `_handleGuidedSetup` at line ~22097):
```ts
private async _handleDispatchProjectManager(): Promise<void> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace root open.');
        return;
    }

    // 1. Pre-flight: API server liveness
    const port = this.getLocalApiServerPort();
    const serverAlive = !!this._localApiServer && this._localApiServer.isListening();
    if (!serverAlive || port === 0) {
        vscode.window.showErrorMessage(
            'Switchboard API server is not running. Open the Switchboard panel and try again.'
        );
        return;
    }

    // 2. Build the manage prompt
    const prompt = `Read .agents/skills/switchboard-manage/SKILL.md and follow its entry protocol. Report the board state for this workspace, then wait for my direction. The API server is running on port ${port}.`;

    // 3. Check for a registered project_manager terminal
    const agentName = await this._getAgentNameForRole('project_manager', workspaceRoot);
    let terminal: vscode.Terminal | undefined;
    if (agentName && this._registeredTerminals) {
        const suffixedKey = this._suffixedName(agentName);
        terminal = this._registeredTerminals.get(agentName) ||
                   this._registeredTerminals.get(suffixedKey);
    }

    if (terminal && terminal.exitStatus === undefined) {
        // Dispatch path: send prompt to the registered PM terminal
        terminal.show();
        const sendLockKey = this._normalizeAgentKey(
            this._stripIdeSuffix(terminal.name || agentName || 'project_manager')
        );
        await withTerminalSendLock(sendLockKey, async () => {
            await sendRobustText(terminal!, prompt, true);
        });
        vscode.window.showInformationMessage(
            'Manage prompt sent to Project Manager terminal.'
        );
    } else {
        // Fallback path: copy to clipboard
        try {
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'No Project Manager terminal registered — manage prompt copied. ' +
                'Paste it into your agent chat (Cmd/Ctrl+V), or register a PM terminal ' +
                'in the Kanban agents tab.'
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(
                `Couldn't copy to clipboard: ${err?.message || err}`
            );
        }
    }
}
```

**`src/services/taskViewerService.ts`** — add the service method (alongside
`guidedSetup` at line ~218):
```ts
async "dispatchProjectManager"(payload: any): Promise<any> {
    return this._ctx.handleMessage({ type: 'dispatchProjectManager', ...payload });
}
```

## Edge Cases & Risks

1. **Multi-root workspaces**: `_getWorkspaceRoot()` returns the first workspace folder.
   The manage skill's own entry protocol walks up from `$PWD` to find
   `.switchboard/api-server-port.txt`, so if the terminal agent's CWD is a different root,
   it will resolve correctly. The pre-flight checks the extension's own `_localApiServer`
   instance, which serves all roots.

2. **Terminal exited but still in `_registeredTerminals`**: The `exitStatus === undefined`
   check (modeled on `phone_a_friend` at line 3425) handles this — a dead terminal falls
   through to the clipboard fallback.

3. **API server port file exists but server is dead**: The pre-flight checks
   `isListening()` directly (not just the port file), so a stale port file won't produce a
   false positive. The watchdog (`_startApiServerWatchdog`) restarts the server within 30s,
   so a retry will likely succeed.

4. **`disable-model-invocation: true` on the skill**: This prevents the agent from
   auto-invoking the skill, but the prompt explicitly instructs the agent to read and
   follow the skill file — that's a user-directed action, not a model invocation. This is
   the same pattern Guided Setup uses (it tells the agent to "Read docs/...").

5. **Skill file path**: The prompt references `.agents/skills/switchboard-manage/SKILL.md`
   (the canonical path from AGENTS.md). If the agent host uses a different skills directory
   (e.g. `.claude/skills/`), the agent should still be able to find it — most hosts search
   both locations. If not, the user can adjust the startup command or the prompt.

6. **No migration needed**: `project_manager` is a new role that has never shipped. Per
   the CLAUDE.md migration rules, unreleased features take clean breaks. Existing installs
   will simply not have the role until they update — `DEFAULT_VISIBLE_AGENTS` and
   `DEFAULT_ROLE_CONFIG` are merged with saved state, so a missing key defaults to `false`
   / empty config without breaking anything.

## Verification

1. Open the Switchboard workspace in VS Code with the extension running.
2. Open the Implementation panel — verify the "Manage" button appears as a full-width teal
   button above Setup, styled like the grid buttons.
3. Open the Kanban panel → Agents tab — verify "Project Manager" appears in the Optional
   section with a visibility checkbox and startup command input.
4. **Clipboard fallback**: With no PM terminal registered, click "Manage" — verify an info
   message appears and the clipboard contains the manage prompt.
5. **Dispatch path**: Register a PM terminal (check the visibility checkbox, enter a
   startup command like `claude`, click OPEN AGENT TERMINALS). Click "Manage" — verify the
   prompt is sent to the PM terminal and an info message appears.
6. **API server down**: Stop the extension / close VS Code, reopen without the Switchboard
   panel active. Click "Manage" — verify an error message appears about the API server.
