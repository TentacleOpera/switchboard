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
CI runners). But it has `disable-model-invocation: true` (set in
`.claude/skills/switchboard-manage/SKILL.md:5`; the `.agents/` mirror omits this flag) — it
can only be activated by the user explicitly triggering it — and there is no UI surface that
tells the user it exists or how to activate it. It is completely undiscoverable.

### Background

The Implementation panel's QUICK ACTIONS section (`implementation.html:1522`) has a 2×2 grid
of panel-opening buttons (Kanban, Artifacts, Design, Project) plus two full-width buttons
below (Setup, Guided Setup). Guided Setup is the existing precedent for a non-panel action:
it pre-flights workspace state, copies a tailored prompt to the clipboard, and tells the
user to paste it into their agent chat (`_handleGuidedSetup` at
`TaskViewerProvider.ts:22101`).

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

> **Note:** `sharedDefaults.js` uses the key `claude_designer` (lines 14, 32, 47), while
> `getVisibleAgents` defaults (`TaskViewerProvider.ts:4449`), `getAgentStartupCommand`
> (line 4408), and the kanban agents tab (`kanban.html:2901`) use `claude_artifacts`. This
> is a pre-existing codebase inconsistency, not introduced by this plan. The new
> `project_manager` role is added consistently to both layers.

### Root Cause

The skill was built as a backend capability with no frontend affordance. The discovery gap
is purely a UI problem — the plumbing (terminal dispatch, role registration, API server
health check) all exists and works.

### Solution

Add a "Manage" button to the QUICK ACTIONS section (teal, full-width, above Setup) and a
new `project_manager` agent role to the kanban agents tab. When clicked:

1. **Pre-flight**: Check that the LocalApiServer is running (port file exists +
   `isListening()`). If down, show an error — the manage skill hard-fails without it.
2. **Dispatch path**: If a `project_manager` terminal agent is registered (or open by
   normalized name), send the manage prompt directly to it via a manual terminal lookup +
   `sendRobustText` (deliberately NOT via `sendPromptToAgentTerminal`, which would
   auto-spawn a terminal — see Superseded callout in §4).
3. **Fallback path**: If no PM terminal is registered or open, copy the manage prompt to
   clipboard and show an info message (same pattern as Guided Setup).

> **Superseded:** Dispatch path: If a `project_manager` terminal agent is registered, send
> the manage prompt directly to it via `sendPromptToAgentTerminal`.
> **Reason:** `sendPromptToAgentTerminal` auto-spawns a terminal when none is found
> (`TaskViewerProvider.ts:3300-3319`), which would defeat the clipboard-fallback design.
> The plan deliberately wants a clipboard escape hatch when no PM terminal is configured,
> matching the Guided Setup precedent. Naming `sendPromptToAgentTerminal` in the Solution
> prose while the Implementation hand-rolls the lookup created a prose-vs-code
> contradiction that a downstream implementer could follow into the wrong behavior.
> **Replaced with:** A manual two-stage terminal lookup (registered terminals → open
> terminals by normalized name) + `sendRobustText` under `withTerminalSendLock`, with a
> clipboard fallback when no live terminal is found. This mirrors the Phone-a-Friend
> dispatch pattern (`TaskViewerProvider.ts:3414-3457`) without the spawn step.

## User Review Required

This plan adds a new UI affordance and a new agent role. No data migration is needed (the
role never shipped). Review the dispatch-vs-clipboard design decision and the prompt
wording before implementation.

## Complexity Audit

### Routine
- Adding a `project_manager` entry to `DEFAULT_VISIBLE_AGENTS`, `DEFAULT_ROLE_CONFIG`, and
  `BUILT_IN_AGENT_LABELS` in `sharedDefaults.js` — mechanical, models on `phone_a_friend`.
- Adding a `project_manager: false` default to `getVisibleAgents` and a startup-command
  fallback to `getAgentStartupCommand` — mechanical, models on `claude_artifacts`.
- Adding a kanban agents-tab row (checkbox + label + command input + description) —
  mechanical HTML, models on the Phone-a-Friend row.
- Adding the "Manage" button + click listener to `implementation.html` — mechanical,
  models on the Guided Setup button.
- Wiring the message handler (routing case + switch case + handler method + service
  method) — mechanical, models on the `guidedSetup` end-to-end path.

### Complex / Risky
- The dispatch-vs-clipboard branching logic in `_handleDispatchProjectManager` — two code
  paths with different failure modes (terminal send vs clipboard write), each needing its
  own error handling. Moderate, but well-scoped and patterned on existing dispatch code.
- Pre-flight liveness check validates dispatch-time, not execution-time (see Edge-Case &
  Dependency Audit) — a soft correctness risk, mitigated by the skill's own runtime
  port-file resolution and the API server watchdog.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Terminal could exit between the `exitStatus === undefined` check and the `sendRobustText`
  call. Low impact — `sendRobustText` fails gracefully and the error is logged; the user
  sees the terminal close. No data corruption path (this is a prompt send, not a state
  mutation).
- API server could die between the pre-flight check and the terminal agent's execution of
  the skill (minutes later). Mitigated: the skill's entry protocol re-resolves
  `.switchboard/api-server-port.txt` at runtime, and `_startApiServerWatchdog` restarts the
  server within 30s.

**Security:**
- The manage prompt is a static string with a port number interpolated from
  `getLocalApiServerPort()`. No user input flows into the prompt. No injection surface.
- `gitProhibition: true` on the role config prevents the PM agent from touching git.

**Side Effects:**
- Adding `project_manager` to `DEFAULT_ROLE_CONFIG` adds it to `ROLE_KEYS`
  (`sharedDefaults.js:54`), which may be iterated by setup/agents-tab rendering. Verified:
  the kanban agents tab renders rows from static HTML (not from `ROLE_KEYS`), and
  `BUILT_IN_AGENT_LABELS` is the UI-rendering source. No breakage.
- `PROMPT_OVERRIDE_EXCLUDED_KEYS` (`sharedDefaults.js:58`) excludes only `ticket_updater`;
  `phone_a_friend` is NOT excluded, so `project_manager` need not be excluded either.

**Dependencies & Conflicts:**
- No existing `project_manager`, `dispatchProjectManager`, or `btn-quick-manage` identifiers
  in `src/` (verified by grep) — net-new, no conflicts.
- The `switchboard-manage` skill exists at both `.agents/skills/switchboard-manage/SKILL.md`
  and `.claude/skills/switchboard-manage/SKILL.md` (verified). The prompt references the
  `.agents/` path (canonical host-agnostic location).

## Dependencies

None — this plan is self-contained. No prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the original Solution prose named `sendPromptToAgentTerminal` while the
Implementation hand-rolled the lookup — an implementer following the prose would
auto-spawn terminals and break the clipboard fallback; (2) the handler originally omitted
the `vscode.window.terminals` open-terminals scan that both `sendPromptToAgentTerminal`
and the Phone-a-Friend dispatch perform, causing a manually-opened PM terminal to fall
through to clipboard. Mitigations: the Solution prose is corrected with a Superseded
callout; the open-terminals scan is added to the handler to match the established
two-stage lookup pattern.

## Proposed Changes

### `src/webview/sharedDefaults.js`

**Context:** Defines default agent visibility, role config, and UI labels for all roles
including specialized (non-`BuiltInAgentRole`) ones.

**Logic:**
- Add `project_manager: false` to `DEFAULT_VISIBLE_AGENTS` (line 2), after `phone_a_friend`
  (line 15).
- Add a `project_manager` entry to `DEFAULT_ROLE_CONFIG` (line 19), after `phone_a_friend`
  (line 33):
  ```js
  project_manager: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } }
  ```
  > **Clarification:** This entry intentionally omits `skipCompilation` and `skipTests`
  > (which `phone_a_friend` at line 33 includes). The Project Manager is a non-coding
  > conversational role that reports board status — it never compiles or runs tests, so
  > those addon flags are irrelevant. Omitting them keeps the addon set minimal and
  > accurate. The plan's original wording ("same minimal addon set") is tightened to
  > "same minimal addon set, minus the coding-specific `skipCompilation`/`skipTests`
  > flags."
- Add `{ key: 'project_manager', label: 'Project Manager' }` to the
  `BUILT_IN_AGENT_LABELS` array (line 37), after `phone_a_friend` (line 50).

**Edge Cases:** `ROLE_KEYS` (line 54) is derived via `Object.keys(DEFAULT_ROLE_CONFIG)` —
adding the entry automatically includes it. No manual update needed.

### `src/services/TaskViewerProvider.ts`

**Context:** The extension's main provider. Holds terminal dispatch, role resolution,
API server liveness, and the webview message router.

**Logic — config-layer additions:**
- Add `project_manager: false` to the `getVisibleAgents` defaults object (line 4437),
  after `phone_a_friend: false` (line 4450).
- Add a startup-command fallback in `getAgentStartupCommand` (line 4388), after the
  `claude_import` fallback (line 4414), modeled on `claude_artifacts` (line 4407):
  ```ts
  if (role === 'project_manager' && (!cmd || cmd.trim() === '')) {
      cmd = 'claude';
      console.log(`[TaskViewerProvider] Applied project_manager fallback command: ${cmd}`);
  }
  ```

**Logic — message routing:**
> **Superseded:** Add routing case (line ~337 area):
> ```ts
> case 'dispatchProjectManager': return await svc['dispatchProjectManager'](p);
> ```
> **Reason:** The routing switch (lines 295-349) is alphabetically ordered. Line 337 is
> `guidedSetup` (a `g`-prefixed case). `dispatchProjectManager` starts with `d` and belongs
> between `deregisterAllTerminals` (line 315) and `editDbPath` (line 316). Placing it at
> 337 would violate the sorted convention and mislead maintainers doing a binary search.
> **Replaced with:** Add the routing case between `deregisterAllTerminals` (line 315) and
> `editDbPath` (line 316):
> ```ts
> case 'dispatchProjectManager': return await svc['dispatchProjectManager'](p);
> ```

- Add switch case (line 10070 area, alongside `guidedSetup` at line 10070):
  ```ts
  case 'dispatchProjectManager':
      await this._handleDispatchProjectManager();
      break;
  ```

**Logic — handler method** (alongside `_handleGuidedSetup` at line 22101):
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

    // 3. Resolve the PM terminal — two-stage lookup matching sendPromptToAgentTerminal
    //    (line 3286-3298) and the Phone-a-Friend dispatch (line 3411-3423):
    //    registered terminals first, then open terminals by normalized name.
    const agentName = await this._getAgentNameForRole('project_manager', workspaceRoot)
        || 'Project Manager';
    const suffixedKey = this._suffixedName(agentName);
    let terminal: vscode.Terminal | undefined;
    if (this._registeredTerminals) {
        terminal = this._registeredTerminals.get(agentName) ||
                   this._registeredTerminals.get(suffixedKey);
    }
    if (!terminal) {
        const openTerminals = vscode.window.terminals || [];
        const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(agentName));
        terminal = openTerminals.find(t => this._normalizeAgentKey(t.name) === strippedTarget);
    }

    if (terminal && terminal.exitStatus === undefined) {
        // Dispatch path: send prompt to the live PM terminal
        terminal.show();
        const sendLockKey = this._normalizeAgentKey(
            this._stripIdeSuffix(terminal.name || agentName)
        ) || agentName;
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

> **Superseded:** The original handler checked `_registeredTerminals` only (no
> open-terminals scan).
> **Reason:** Both `sendPromptToAgentTerminal` (line 3295-3298) and the Phone-a-Friend
> dispatch (line 3418-3423) fall back to scanning `vscode.window.terminals` by normalized
> name when the registered-terminals map misses. A user who opens a PM terminal manually
> (without going through the agents-tab checkbox ceremony) would have been sent to the
> clipboard fallback instead of receiving the dispatch. This diverges from the established
> two-stage lookup pattern.
> **Replaced with:** A two-stage lookup — registered terminals first, then
> `vscode.window.terminals` by normalized name — matching the pattern at lines 3286-3298.
> The agent-name fallback also uses `'Project Manager'` (mirroring the
> `role === 'claude_artifacts' ? 'Claude Artifacts' : role` pattern at line 3286) so the
> open-terminals scan has a stable name to match against even when no agent name is
> configured.

**Edge Cases:**
- `_getAgentNameForRole` may return `undefined` for an unconfigured role. The handler now
  falls back to the literal `'Project Manager'` so the open-terminals scan still works.
- `terminal.exitStatus === undefined` guards against a dead terminal still present in
  `_registeredTerminals` (mirrors Phone-a-Friend at line 3425).
- `sendRobustText`, `withTerminalSendLock`, `_suffixedName`, `_normalizeAgentKey`, and
  `_stripIdeSuffix` are all in scope — used by the sibling `sendPromptToAgentTerminal`
  (line 3332-3335) and Phone-a-Friend dispatch (line 3454-3457) in the same class.

### `src/services/taskViewerService.ts`

**Context:** The service layer that routes webview messages to the provider via
`handleMessage`.

**Logic:** Add the service method (alongside `guidedSetup` at line 218):
```ts
async "dispatchProjectManager"(payload: any): Promise<any> {
    return this._ctx.handleMessage({ type: 'dispatchProjectManager', ...payload });
}
```

**Edge Cases:** None — this is the same double-routing pattern as `guidedSetup` (line 218):
routing case → service method → `handleMessage` → switch case → handler.

### `src/webview/kanban.html`

**Context:** The kanban panel's agents tab, which lists all roles with a visibility
checkbox and a startup-command input.

**Logic:** Insert a `project_manager` row + description in the Optional section, **after
the Phone-a-Friend description div (line 2904) and before the Jules auto-sync label (line
2905)**:
```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="project_manager" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Project Manager</label><input type="text" data-role="project_manager" id="agents-tab-cmd-project-manager" placeholder="e.g. claude" style="flex:1;"></div>
<div class="agent-description">Host-agnostic management console — drives the board over the LocalApiServer HTTP API. Activate via the Manage button in the Implementation panel.</div>
```

> **Superseded:** "after the Phone-a-Friend row at line 2903, inside the Optional section"
> (with a multi-line formatted block).
> **Reason:** Line 2903 is the Phone-a-Friend row; line 2904 is its `agent-description`
> div; line 2905 is the Jules auto-sync label. "After the row at 2903" is ambiguous — an
> implementer could insert between 2903 and 2904, splitting the row from its description.
> The codebase uses single-line compact rows (see lines 2880-2904), not the multi-line
> formatted block the original plan proposed.
> **Replaced with:** Insert after the Phone-a-Friend description div (line 2904), before
> the Jules auto-sync label (line 2905), using the same single-line compact row format as
> the surrounding rows.

### `src/webview/implementation.html`

**Context:** The main sidebar's QUICK ACTIONS section.

**Logic:** Insert a full-width teal button between the 2×2 grid (ends at line 1531) and the
Setup button (line 1532):
```html
<button id="btn-quick-manage" class="secondary-btn is-teal w-full"
  style="margin-top: 6px;"
  title="Activate the Switchboard management console in a terminal agent (or copy the prompt if no PM terminal is registered)">Manage</button>
```

Add the click listener (after line 1803, alongside the other quick-action listeners at
lines 1795-1803):
```js
const btnQuickManage = document.getElementById('btn-quick-manage');
if (btnQuickManage) btnQuickManage.addEventListener('click', () =>
  vscode.postMessage({ type: 'dispatchProjectManager' }));
```

**Edge Cases:** The button uses `is-teal w-full` matching the grid buttons' teal style and
the Setup/Guided-Setup buttons' full-width style. The `margin-top: 6px` matches the spacing
between Setup and Guided Setup (line 1533).

## Verification Plan

### Automated Tests

None — per session directives, automated tests are skipped. This is a UI wiring change
with no test infrastructure targeting the webview message router.

### Manual Verification

1. Open the Switchboard workspace in VS Code with the extension running.
2. Open the Implementation panel — verify the "Manage" button appears as a full-width teal
   button above Setup, styled like the grid buttons.
3. Open the Kanban panel → Agents tab — verify "Project Manager" appears in the Optional
   section (after Phone-a-Friend, before the Jules auto-sync label) with a visibility
   checkbox and startup command input.
4. **Clipboard fallback**: With no PM terminal registered or open, click "Manage" — verify
   an info message appears and the clipboard contains the manage prompt (paste into a text
   editor to confirm).
5. **Dispatch path (registered)**: Register a PM terminal (check the visibility checkbox,
   enter a startup command like `claude`, click OPEN AGENT TERMINALS). Click "Manage" —
   verify the prompt is sent to the PM terminal and an info message appears.
6. **Dispatch path (open, unregistered)**: Open a terminal named "Project Manager"
   manually (without using the agents-tab checkbox). Click "Manage" — verify the prompt is
   sent to that terminal (exercises the open-terminals scan fallback).
7. **Dead terminal**: Close the registered PM terminal. Click "Manage" — verify it falls
   through to the clipboard fallback (the `exitStatus !== undefined` guard).
8. **API server down**: Stop the extension / close VS Code, reopen without the Switchboard
   panel active. Click "Manage" — verify an error message appears about the API server.

### Build / Compilation

Per session directives, compilation is skipped. The implementer should run `npm run
compile` (webpack) only when producing a VSIX for release; `src/` is the source of truth
and `dist/` is not used during development.

## Recommendation

Complexity 4 → **Send to Coder**. This is a multi-file wiring change (5 files) that reuses
existing patterns throughout — no new architecture, no data consistency risk, no breaking
changes. The two corrections (open-terminals scan, routing placement) keep it within the
routine-to-moderate band.
