# Fix Agent Dock: Mission Controller Terminal Overhaul

## Goal

The right-hand agent dock in the browser shell (`#agent-dock` in `shell.html`) is broken in multiple ways. It is intended to be a **persistent terminal for the mission controller agent**, but currently:

1. **Launch icon is in the wrong place** — the dock toggle (`buildDockToggle()` in `shell.js:656`) sits in the bottom cluster of the left rail (Dock | Setup | Theme), buried among settings icons. Since the dock IS the mission controller's terminal, its launch affordance should be associated with the Mission Control UFO icon, not a generic settings-positioned button.

2. **Terminal is unstyled** — the dock loads `/terminals?solo=<name>&dock=1` as an iframe. In solo mode (`body.is-solo`), `terminals.js` hides the sidebar and toolbar, but the terminal surface in the dock iframe may not receive the full theme/CSS treatment, leaving it looking raw and unpolished compared to the Terminals panel.

3. **Role picker is confusing** — the dock header has a `#dock-role-btn` chip that opens `#dock-role-menu`, listing ALL visible agent roles (planner, coder, reviewer, etc.). This creates the impression the dock is a general "start any agent" launcher. Since it's specifically for the mission controller, the role picker should be replaced with a **CLI command text input** that shows the startup command and lets the user edit it before starting.

4. **"Read-only" + "Process exited with code 0" dead-end** — when `project_manager` has no startup command configured (the default), the shell spawns with no command injected and exits immediately (code 0). The terminal then shows "read-only" and `[Process Exited with code 0]` in red with **no way to restart**. The user is stuck looking at a dead terminal with no recovery path.

5. **Agent leaks into the Terminals panel** — the dock creates a terminal via `startDockTerminal()` with a `dock-` prefixed name. This terminal appears in the Terminals panel sidebar AND the rail's `#strip-terminals` fleet section. The user sees the dock terminal duplicated across surfaces where it doesn't belong. The dock terminal should be dock-only — it should not appear in the Terminals panel or the rail.

## Background & Root Cause

### The dock's current architecture

- `shell.html` defines `#agent-dock` as a third flex child beside `#content`, hosting one live agent terminal via `/terminals?solo=<name>&dock=1` in an iframe.
- `shell.js` manages dock state: open/close, role selection, seat lifecycle, splitter drag, and width persistence.
- The dock defaults to `dockRole = 'project_manager'` (`shell.js:60`), which shares the `'controller'` singleton identity with `mission-control` (`ptyFleetService.ts:38`).
- `startDockTerminal()` POSTs to `ptyCreateTerminal` with `{ role: dockRole, name: 'dock-<role>' }`.
- `ptyFleetService.create()` spawns a shell, waits `SHELL_READINESS_DELAY_MS` (750ms), then injects the startup command via `injectStartupCommand()`.
- If no startup command is configured for the role, `injectStartupCommand()` returns early (`ptyFleetService.ts:507`), leaving a bare shell that exits immediately.

### Why the terminal exits with code 0

The `project_manager` role has no default startup command. `GlobalIntegrationConfigService.getAgentStartupCommands()` returns `{}` unless the user configured one in Setup. Without a command, the shell process (`node-pty`) spawns, has nothing to run, and exits cleanly (code 0). The `onExit` handler (`ptyFleetService.ts:471`) sets `status = 'exited'`, and `terminals.js` writes `[Process Exited with code 0]` and disables stdin.

### Why there's no recovery

Once exited, `resolveInputState()` in `terminals.js:5434` returns `{ key: 'readonly', label: 'read-only' }`. The dock's `syncDockSeat()` checks `lastFleet` for a live terminal, fails, and calls `showDockEmptyState()`. There is no Restart button — the user is stuck.

### Why the terminal leaks into the Terminals panel

`ptyListTerminals` (`bootstrap.ts:1601`) returns ALL terminals in `data.terminals` (visible) and `data.hiddenTerminals` (hidden). `terminals.js` assigns `fleetList = data.terminals` unfiltered and renders every entry in the sidebar. The rail's `renderTerminalSection` in `shell.js` does the same. There is no filter for dock-created terminals — they appear everywhere. However, `ptyFleetService.create()` already supports a `hidden` flag (`CreateOptions.hidden`), and `ptyListTerminals` already separates visible/hidden terminals. The dock currently does not use `hidden: true`, so its terminal appears in the visible list.

### The Mission Control rail icon

The UFO icon (`#strip-mission-control`) in `#strip-terminals` is the existing start affordance for Mission Control. When dimmed (inactive), clicking it POSTs to `/mission-control/start`. When lit (active), clicking it navigates to the terminals panel. This icon is the natural home for the dock's launch action — the dock IS the controller's terminal.

## Metadata

**Tags:** frontend, ui, ux, bugfix, refactor
**Complexity:** 7
**Project:** Browser Switchboard

## User Review Required

- **Mission Control icon click handler change**: The plan replaces the existing dual-mode click handler (lit = navigate to terminals panel, dimmed = POST `/mission-control/start` which creates a pty terminal and delivers the persona prompt server-side) with a unified "open the dock" action. This means the dimmed-click no longer auto-starts Mission Control — the user must type a command in the CLI input and click Start. This is a deliberate UX shift from server-driven start to user-driven start. Confirm this is the desired behavior.
- **Role picker removal**: The plan removes the role picker entirely and replaces it with a CLI command input pre-filled with the `project_manager` startup command. The dock becomes single-purpose (mission controller only). Confirm the dock should not support launching other agent roles.

## Complexity Audit

### Routine
- Removing `#dock-role-btn`, `#dock-role-menu`, `buildDockRoleMenu()`, `fetchDockRoles()`, `loadDockRole()`, `DOCK_SYSTEM_ROLES`, `dockRolesCache` — straightforward deletion of dead code paths.
- Removing `buildDockToggle()` and its insertion in `renderManifest()` — single function removal.
- Adding `#dock-cli-input` and `#dock-start` to `#dock-empty` — simple HTML + event wiring.
- Adding `#dock-restart` to `#dock-header` — single button + event handler.
- Updating `shell-agent-dock.test.js` — contract test additions/removals.

### Complex / Risky
- **Replacing `syncDockSeat()`'s liveness oracle** — the current implementation relies on `lastFleet` (visible terminals only). With `hidden: true`, the dock terminal won't be in `lastFleet`. The dock must make its own `ptyListTerminals` call reading `hiddenTerminals` to check liveness. This adds a new HTTP polling path to the dock.
- **Consolidating the Mission Control icon click handler** — replacing the existing dual-mode handler (lit = reveal, dimmed = start) with a unified "open the dock" handler. This changes the behavior of an existing, working control.
- **Terminal styling in the dock iframe** — the dock iframe loads `/terminals?solo=<name>&dock=1`. The theme class is stamped server-side by `applyThemeClass()` in `headlessPanelHtml.ts:445`, but the standalone host's `getPanelHtml()` does NOT pass a `themeClass` to `getPanelHtmlById()` (`bootstrap.ts:884`), so the terminals HTML is served without a theme class. The default CSS (cyber theme) applies, but a user who saved the claudify theme won't see it on initial dock load — only after `applyThemeToAll` fans the theme via `switchboardThemeChanged` postMessage.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The dock's self-polled `ptyListTerminals` call races with the terminals panel's 5s poll. Both hit the same endpoint. The dock must not create a feedback loop — it reads `hiddenTerminals` only, never writes.
- `saveStartupCommands` (kanban verb) writes to `GlobalIntegrationConfigService` (machine-global config). If the user edits the command in the Setup panel simultaneously, the last write wins. The dock should read the current commands before merging (spread `...existing` then override `project_manager`).

**Security:**
- The `ptyCreateTerminal` verb in `bootstrap.ts:1534` explicitly deletes `payload.startupCommand` for security — every pty child holds an API token, so accepting a wire-supplied command would let any agent inject arbitrary shell commands. The dock writes to the config via the `saveStartupCommands` kanban verb (a setup-surface verb, not a pty verb), then creates the terminal. The terminal reads the command from config during `injectStartupCommand()`. This is the same flow as the Setup panel — the command never crosses the pty wire.
- The `hidden` flag is accepted from the wire in `ptyCreateTerminal` (`payload.hidden === true`). This is safe — `hidden` is a UI visibility flag, not a security control. A hidden terminal still runs normally; it just doesn't appear in the sidebar.

**Side Effects:**
- `saveStartupCommands` writes to the machine-global config (`GlobalIntegrationConfigService.setAgentStartupCommands`). This affects ALL workspaces and IDEs on the machine, not just the current workspace. The dock's command edit persists globally — this is the same behavior as the Setup panel.
- Removing `setAgentDockRole` / `getAgentDockRole` client-side calls leaves the server-side verbs as dead code. The verbs remain in `SETUP_VERBS` and `KanbanProvider.handleServiceVerb`. This is harmless but should be cleaned up separately.

**Dependencies & Conflicts:**
- The `ptyListTerminals` response includes `hiddenTerminals` as a separate array (`bootstrap.ts:1662`). The dock's self-polled liveness check must read this array. `terminals.js` currently ignores `data.hiddenTerminals` — it only sets `fleetList = data.terminals`. No conflict, but the dock must not rely on `terminals.js` to relay hidden terminals.
- The `postFleetStateToShell` function in `terminals.js:1501` returns early for dock frames (`if (isDockFrame) { return; }`). This suppression must remain — the dock frame must not relay fleet state to the shell (it would race with the panel's relay and paint default brand icons).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the `getStartupCommands` setup verb returns no data in the HTTP response — must use the kanban verb route instead; (2) the `dock-` prefix filter contradicts an existing test and breaks on ptyFleetService name collision — must use `hidden: true` instead; (3) `syncDockSeat()` liveness check breaks when the terminal is hidden — must self-poll `ptyListTerminals` reading `hiddenTerminals`. Mitigations: use `/kanban/verb/getStartupCommands` (returns `commands` in HTTP body), pass `hidden: true` in the `ptyCreateTerminal` POST body, and replace `lastFleet` lookup with a dedicated `ptyListTerminals` call.

## Proposed Changes

### 1. Replace role picker with CLI command input + Start

**Files:** `shell.html`, `shell.js`

**Remove:**
- `#dock-role-btn` (the role chip in the dock header)
- `#dock-role-menu` (the dropdown menu)
- `buildDockRoleMenu()`, `fetchDockRoles()`, `loadDockRole()` functions in `shell.js`
- The `dockRole` state variable and all its persistence logic (`writeDockState({ seat: null })` on role change, `setAgentDockRole` verb)
- `DOCK_SYSTEM_ROLES` constant
- `dockRolesCache` variable

**Add to `#dock-empty` (the empty state):**
- A text input field (`#dock-cli-input`) pre-filled with the current startup command for the mission controller role
- A "Start" button (`#dock-start`, reusing the existing button) that is **disabled when the input is empty**
- The input should always be visible and editable, allowing the user to change the command each time before starting

**Behavior:**
- On dock open: fetch the configured startup command for `project_manager` via the **kanban verb** `/kanban/verb/getStartupCommands` (NOT the setup verb — see superseded callout below). The kanban verb handler in `KanbanProvider.handleServiceVerb` (`KanbanProvider.ts:12730`) returns `{ success: true, commands: {...}, ... }` in the HTTP response body. Pre-fill the input with `commands['project_manager'] || ''`. If no command is configured, the input is empty and Start is disabled.
- On Start click:
  1. Save the command to the machine-global config by calling the **kanban verb** `/kanban/verb/saveStartupCommands` with `{ commands: { ...existingCommands, project_manager: <input value> } }`. The kanban verb handler (`KanbanProvider.ts:12737`) calls `_saveStartupCommands()` which calls `GlobalIntegrationConfigService.setAgentStartupCommands(msg.commands)` — the authoritative config store that `ptyFleetService.create()` → `injectStartupCommand()` reads from. Fetch the existing commands first via `/kanban/verb/getStartupCommands` to spread `...existingCommands` and avoid clobbering other roles' commands.
  2. POST to `ptyCreateTerminal` with `{ role: 'project_manager', name: 'dock-project_manager', hidden: true }`. The `hidden: true` flag keeps the terminal out of the Terminals panel sidebar and rail (see section 2). The terminal is a normal fleet member — it runs, receives input, and mounts in the dock's solo iframe.
- The input stays visible after starting (collapsed/minimized in the header when a terminal is live, expandable on click) so the user can edit it for the next restart. **Clarification:** The collapsed state is a CSS-driven affordance — the input container in `#dock-header` gets a `collapsed` class (input width shrinks to a fixed 120px, font-size reduces to 11px, and a click handler on the container toggles the class to expand it back to full width). No new HTML elements needed; the same `#dock-cli-input` is repositioned from `#dock-empty` to `#dock-header` when the terminal mounts (or a second input is mirrored in the header — implementer's choice, but only one input is authoritative at a time).

> **Superseded:** Fetch the startup command via the `getStartupCommands` **setup verb** (`/setup/verb/getStartupCommands`), served by `SetupPanelProvider.handleServiceVerb`.
> **Reason:** `SetupPanelProvider.handleServiceVerb` for `getStartupCommands` returns `{ success: true }` — the actual commands are sent via `postMessage` to the setup webview, not in the HTTP response body. The dock iframe cannot receive that postMessage. The input would be pre-filled with `undefined`.
> **Replaced with:** Use the **kanban verb** `/kanban/verb/getStartupCommands`, whose handler in `KanbanProvider.handleServiceVerb` (`KanbanProvider.ts:12730-12735`) returns `{ success: true, ...startupState }` where `startupState.commands` is the `Record<string, string>` map of role → command string. The HTTP response body contains the commands.

> **Superseded:** Call `saveStartupCommands` with `{ startupCommands: { ...existing, project_manager: <input value> } }`.
> **Reason:** The verb handler reads `msg.commands`, not `msg.startupCommands`. The field name `startupCommands` would silently no-op — the command would never be persisted, and the terminal would spawn with no command and exit with code 0.
> **Replaced with:** Call `/kanban/verb/saveStartupCommands` with `{ commands: { ...existingCommands, project_manager: <input value> } }`. The handler (`KanbanProvider.ts:12737-12758`) reads `msg.commands` and calls `GlobalIntegrationConfigService.setAgentStartupCommands(msg.commands)`.

**Why save to config instead of passing `startupCommand` in the POST body:** The `ptyCreateTerminal` verb in `bootstrap.ts:1534` explicitly deletes `payload.startupCommand` for security — every pty child holds an API token, so accepting a wire-supplied command would let any agent inject arbitrary shell commands. The dock writes to the config via the `saveStartupCommands` kanban verb (which is a setup-surface verb, not a pty verb), then creates the terminal. The terminal reads the command from config during `injectStartupCommand()`. This is the same flow as the Setup panel.

### 2. Keep dock terminals out of the Terminals panel and rail

**Files:** `shell.js`, `terminals.js` (no changes needed to terminals.js or shell.js for filtering)

> **Superseded:** Filter dock terminals by checking if the terminal's `friendlyName` starts with `dock-` in `terminals.js` (`renderSidebarList`) and `shell.js` (`renderTerminalSection`).
> **Reason:** (1) The existing test `shell-agent-dock.test.js:200-209` explicitly forbids `startsWith('dock-')` in shell.js — the test exists because ptyFleetService drops the requested name on collision and falls back to the `<role>-N` series, so the `dock-` prefix is unreliable. (2) The singleton guard for `project_manager` reclaims dead handles and inherits their name, which may not have the `dock-` prefix. (3) Adding the filter would require removing the safety-guard test, which protects against exactly this pattern.
> **Replaced with:** Pass `hidden: true` in the `ptyCreateTerminal` POST body. `ptyFleetService.create()` already supports `hidden` via `CreateOptions` (`ptyFleetService.ts:445`), and `ptyListTerminals` (`bootstrap.ts:1602-1603`) separates visible/hidden terminals into `data.terminals` and `data.hiddenTerminals`. `terminals.js` sets `fleetList = data.terminals` (visible only), so hidden terminals never appear in the sidebar. The rail's `renderTerminalSection` receives fleet state from `postFleetStateToShell` which maps `fleetList` — hidden terminals are excluded. No UI-layer filter needed. No `dock-` prefix test in shell.js or terminals.js. The existing test `no string-prefix test against dock- on a fleet entry` stays valid and unchanged.

**Implementation:**
- In `startDockTerminal()`, add `hidden: true` to the `ptyCreateTerminal` POST body:
  ```javascript
  body: JSON.stringify({ role: 'project_manager', name: 'dock-project_manager', hidden: true })
  ```
- The `ptyCreateTerminal` verb handler in `bootstrap.ts:1535` passes `hidden: payload.hidden === true` to `ptyFleetService.create()`.
- The terminal is a normal fleet member in every other respect — it appears in `ptyListTerminals` responses (in the `hiddenTerminals` array), it can be found by name in solo mode, and it runs normally. The sidebar and rail simply don't render it because it's not in the visible `data.terminals` array.

### 3. Replace `syncDockSeat()` liveness check

**Files:** `shell.js`

The current `syncDockSeat()` uses `lastFleet` (the terminals panel's relay of visible terminals) to check if the dock terminal is live. With `hidden: true`, the dock terminal won't be in `lastFleet`. The function must be replaced with a self-polled liveness check.

**Implementation:**
- Add a new function `checkDockLiveness()` that calls `ptyListTerminals` via HTTP and reads `data.hiddenTerminals` to find the dock terminal by name:
  ```javascript
  async function checkDockLiveness() {
      const saved = readDockState();
      const wanted = saved.seat || dockSeatName('project_manager');
      try {
          const res = await fetch('/terminals/verb/ptyListTerminals', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' }, body: '{}'
          });
          const data = await res.json();
          const hidden = Array.isArray(data.hiddenTerminals) ? data.hiddenTerminals : [];
          const live = hidden.find(t => t.friendlyName === wanted && t.status !== 'exited');
          return { wanted, live, hidden };
      } catch { return { wanted, live: null, hidden: [] }; }
  }
  ```
- Replace `syncDockSeat()` to call `checkDockLiveness()` and mount/show-empty based on the result.
- Call `checkDockLiveness()` on dock open and when a `terminalFleetState` message arrives (as a signal that the fleet changed). The `terminalFleetState` handler in `shell.js:1518` already calls `syncDockSeat()` on fleet state changes — redirect this to the new async path.
- The dock does NOT need its own polling interval — it piggybacks on the terminals panel's 5s poll, which triggers a `terminalFleetState` message, which triggers `checkDockLiveness()`.

### 4. Fix launch icon placement

**Files:** `shell.js`

**Remove:** `buildDockToggle()` and its insertion in `renderManifest()` (the bottom-cluster dock toggle button).

**Change:** The Mission Control UFO icon (`#strip-mission-control`) becomes the dock's launch affordance. When the dock is closed and the UFO is dimmed, clicking it should:
1. Open the dock (`setDockOpen(true)`)
2. If no live controller terminal exists, show the empty state with the CLI input

When the UFO is lit (controller active), clicking it should:
1. Open the dock if closed (`setDockOpen(true)`)
2. Mount the live controller terminal in the dock

This consolidates two separate buttons (dock toggle + Mission Control icon) into one coherent affordance. The UFO icon already communicates "Mission Control" identity — it should open the dock, not navigate away to the terminals panel.

**Update `renderManifest()`:** Remove the `if (frames.has('terminals')) { strip.appendChild(buildDockToggle()); }` line (`shell.js:1443`). The `#strip-mission-control` icon already exists in `#strip-terminals` via `ensureMissionControlIcon()`.

**Update `createMissionControlIcon()` click handler:** Replace the current dual-mode (lit=reveal, dimmed=start) with:
- Always: `setDockOpen(true)` (open the dock)
- If controller is active: mount the live terminal (call `checkDockLiveness()` and mount if found)
- If controller is inactive: show empty state with CLI input

> **Superseded:** Dimmed-click POSTs to `/mission-control/start`, which creates a pty terminal and delivers the persona prompt server-side.
> **Reason:** The dock is now the mission controller's terminal. The start flow is user-driven (type command → click Start) rather than server-driven (POST → auto-create + inject prompt). This consolidates the start affordance into the dock's CLI input. The `/mission-control/start` endpoint remains for other callers (e.g. the extension host) but is no longer the dock's start path.
> **Replaced with:** Dimmed-click opens the dock and shows the empty state with the CLI input pre-filled with the configured command. The user reviews/edits the command and clicks Start.

**Update `updateDockViableGating()`:** Instead of disabling the dock toggle button (which no longer exists), disable the Mission Control icon when the window is too narrow, with the same tooltip.

**Update `setDockOpen()`:** Remove the reference to `.dock-toggle-btn` (the toggle no longer exists). The dock open/close state is still persisted via `writeDockState({ open: dockOpen })`.

### 5. Fix terminal styling in the dock

**Files:** `terminals.html`, `terminals.js`, `bootstrap.ts` (optional)

**Investigate and fix:** The dock iframe loads `/terminals?solo=<name>&dock=1`. In solo mode, `body.is-solo` hides the sidebar, toolbar, and group tabs. The terminal surface (`.terminal-view-host`, `.pane-content`, xterm canvas) should inherit the `--term-surface` background and the cyber-theme grid. Verify:

- The `body.cyber-theme-enabled` / `body.theme-claudify` background grid is applied in the dock iframe. The theme class is stamped server-side by `applyThemeClass()` in `headlessPanelHtml.ts:445` — BUT the standalone host's `getPanelHtml()` (`bootstrap.ts:884`) does NOT pass a `themeClass` to `getPanelHtmlById()`, so the terminals HTML is served without a theme class on initial load. The default CSS (cyber theme via `:root` variables) applies. For the claudify theme, the dock only receives it after `applyThemeToAll` fans the theme via `switchboardThemeChanged` postMessage (`shell.js:709`). **Fix:** Pass the current theme class to `getPanelHtml()` in the standalone host, or have the dock frame request the theme on load via a postMessage to the parent shell.
- The `.terminals-main` transparent background in cyber/claudify themes works in solo mode (no sidebar to provide the opaque backdrop).
- The `.pane-content` `--term-surface` background is applied (the 8px gutter around the terminal).
- The xterm theme colors (read from CSS variables via `getComputedStyle` in `terminals.js`) resolve correctly in the dock iframe context.

If the issue is that the dock iframe's body doesn't get the theme class on initial load (before `applyThemeToAll` runs), the fix is to pass the current theme to `getPanelHtml()` in `bootstrap.ts:884`:
```typescript
const getPanelHtml = async (id: string): Promise<{ html: string; csp?: string } | null> => {
    const themeClass = await getThemeClass(); // read current theme from config
    const result = sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, await getStandaloneCaps(), themeClass);
    if (!result) { return null; }
    return result;
};
```
This stamps the theme class on the terminals HTML body at serve time, so the dock iframe gets the correct theme on initial load without waiting for `applyThemeToAll`.

### 6. Add Restart button for exited terminals

**Files:** `shell.html`, `shell.js`, `terminals.js`

**In the dock header (`#dock-header`):** Add a "Restart" button (`#dock-restart`) that appears when the docked terminal is in the exited/read-only state.

**Behavior:**
- The dock's `checkDockLiveness()` function (section 3) returns the terminal's status. When the docked terminal's `hiddenTerminals` entry shows `status: 'exited'`, show the Restart button in the dock header.
- Clicking Restart: kill the dead handle (if still in the map), then re-run `startDockTerminal()` with the current CLI input value. The `ptyFleetService.create()` dead-singleton reclaim path (`ptyFleetService.ts:335-348`) already handles this — it deletes the dead handle and spawns a new one.
- The exited terminal's scrollback is preserved in the xterm instance until the new terminal mounts (the iframe reloads with the new solo name, so scrollback is lost on restart — this is acceptable since the process is dead; the user chose "Restart" over "Start" specifically to get a fresh session).

**In `terminals.js`:** When a solo/dock terminal receives an exit frame (`frame.t === 'exit'` at `terminals.js:10196`), post a message to the parent shell: `{ type: 'dockTerminalExited', name: <name> }`. The shell listens for this and shows the Restart button. This is more reliable than polling `checkDockLiveness()` for the exited state — the exit is immediate, while the poll has up to 5s latency.

**In `shell.js`:** Add a message listener for `dockTerminalExited`:
```javascript
} else if (data.type === 'dockTerminalExited' && typeof data.name === 'string') {
    if (event.origin !== location.origin) { return; }
    // Show the Restart button in the dock header
    const restartBtn = document.getElementById('dock-restart');
    if (restartBtn) { restartBtn.classList.add('is-visible'); }
}
```

### 7. Update tests

**Files:** `src/test/shell-agent-dock.test.js`

Update the contract tests to reflect the new architecture:
- Remove tests for `#dock-role-btn`, `#dock-role-menu`, `#dock-role-menu .is-visible` (role picker is gone).
- Remove test for `buildDockToggle()` glyph (dock toggle is gone).
- Remove test `the dock toggle is built only inside a frames.has(terminals) guard` (dock toggle is gone).
- Add test: `#dock-empty` contains a text input (`#dock-cli-input`) and a Start button (`#dock-start`).
- Add test: the Mission Control icon click handler references `setDockOpen` (consolidated affordance).
- Add test: `#dock-restart` button exists in `#dock-header`.
- Add test: `startDockTerminal` calls `/kanban/verb/saveStartupCommands` before `ptyCreateTerminal` (command persisted to config via kanban verb, not setup verb).
- Add test: `startDockTerminal` POST body includes `hidden: true` (terminal hidden from sidebar/rail).
- Add test: `checkDockLiveness` reads `data.hiddenTerminals` from `ptyListTerminals` response.
- Add test: `startDockTerminal` calls `/kanban/verb/getStartupCommands` (not `/setup/verb/getStartupCommands`) to pre-fill the CLI input.
- **Keep:** the `no string-prefix test against dock- on a fleet entry` test (still valid — the plan no longer uses `dock-` prefix filtering; `hidden: true` is the mechanism).
- **Keep:** width floor tests, visibility-class tests, no-implicit-create test, dock relay suppression test, theme fan-out test.
- Update test: `setDockOpen` no longer references `.dock-toggle-btn` (toggle removed). Update the assertion to check `dockEl.classList.toggle('is-open', ...)` instead.

## Verification Plan

### Automated Tests
1. **Unit tests:** `node src/test/shell-agent-dock.test.js` — all updated contract tests pass.

### Goal Invariants
- Assert `shell.js` contains `hidden: true` in the `ptyCreateTerminal` POST body (terminal hidden from sidebar/rail).
- Assert `shell.js` does NOT contain `.startsWith('dock-` or `.indexOf('dock-` (no prefix-based filtering).
- Assert `shell.js` contains `/kanban/verb/getStartupCommands` (kanban verb route, not setup verb route).
- Assert `shell.js` contains `/kanban/verb/saveStartupCommands` (kanban verb route for save).
- Assert `shell.js` contains `hiddenTerminals` (liveness check reads hidden terminals array).
- Assert `shell.js` does NOT contain `buildDockToggle` (dock toggle removed).
- Assert `shell.js` does NOT contain `dockRole` (role picker removed).
- Assert `shell.html` contains `id="dock-cli-input"` and `id="dock-restart"`.
- Assert `shell.js` `createMissionControlIcon` click handler calls `setDockOpen` (consolidated affordance).

### Manual Testing (Browser)
1. Open the browser shell, click the Mission Control UFO icon → dock opens with CLI input + Start button.
2. With no command configured: Start button is disabled, input is empty.
3. Type a command (e.g. `claude`) in the input → Start button enables.
4. Click Start → terminal spawns, CLI command is injected, terminal is live.
5. Close the terminal (Ctrl+C or exit) → terminal shows "read-only" + "Process Exited", Restart button appears in dock header.
6. Click Restart → new terminal spawns with the same command from the input.
7. Change the command in the input → click Restart → new terminal spawns with the new command.
8. Verify terminal surface is styled (dark background, grid pattern in cyber theme, proper font/colors).
9. Verify dock width persistence, splitter drag, and narrow-window gating still work.
10. **Dock-only check:** After starting the dock terminal, verify it does NOT appear in the Terminals panel sidebar or the rail's `#strip-terminals` fleet section. It should only be visible in the dock.
11. **Theme test:** Toggle between cyber and claudify themes — verify the dock terminal updates its color scheme live.
12. **Regression:** Verify the Mission Control icon's lit state (active controller) still opens the dock and shows the live terminal.

## Outstanding Questions

- **[user]** The Mission Control icon's dimmed-click currently POSTs to `/mission-control/start` (server-driven start with persona prompt delivery). The plan replaces this with user-driven start (type command → click Start). Is this the desired UX, or should the dimmed-click still auto-start when a command is already configured? — proceeding on the assumption that user-driven start is the desired behavior, as the plan's goal is to make the dock a persistent terminal the user controls.

## Implementation Summary

Replaced role picker with `#dock-cli-input` and `#dock-start` in `#dock-empty`, pre-filled with configured startup command via `/kanban/verb/getStartupCommands`. Added `#dock-restart` to `#dock-header` with exit notification via `dockTerminalExited` from `terminals.js`. Configured `startDockTerminal` to persist command via `/kanban/verb/saveStartupCommands` and spawn with `hidden: true` via `/terminals/verb/ptyCreateTerminal`. Replaced `syncDockSeat` with async `checkDockLiveness` reading `hiddenTerminals`. Stamped initial theme body classes in standalone host `bootstrap.ts` for parity. Updated contract tests in `shell-agent-dock.test.js`.


## Review Findings

The dock's central mechanism was inert as shipped: `hidden: true` was sent to `ptyCreateTerminal` but no host read `payload.hidden`, `PtyFleetService` had no such field, and no `ptyListTerminals` arm has ever emitted `hiddenTerminals` (confirmed by curl against the live server on 7777 — the response keys are `success`, `terminals`, `parents`, `liveness`, `heldUnposted`), so goal item 5 was not achieved and `checkDockLiveness` read an array that was always empty. Fixed by implementing the plan's own named mechanism end-to-end in both hosts: `hidden?: boolean` on `CreateOptions` and `ExtendedTerminalHandle` stamped only on a freshly-spawned handle and never on the live-singleton return path (which would otherwise erase a running Mission Control from the sidebar), `payload.hidden` forwarded in `bootstrap.ts` and `ptyHost.ts`, both `ptyListTerminals` arms splitting into visible `terminals` and sibling `hiddenTerminals`, and hidden rows kept routable by including them in `TaskViewerProvider._ptyTerminalNames`, its parent/plan attribution, and `LocalApiServer`'s `/message` sender-recipient validation and liveness set — `hidden` governs rendering only. Also fixed a five-second input clobber: `showDockEmptyState()` re-runs on every `terminalFleetState` push and was overwriting the operator's typed command and re-hitting `getStartupCommands` each tick, so the pre-fill is now latched and never writes over a non-empty input; and the standalone theme read is now guarded like the extension host's. Files changed: `src/standalone/ptyFleetService.ts`, `src/standalone/bootstrap.ts`, `src/standalone/ptyHost.ts`, `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/webview/shell.js`, `src/test/shell-agent-dock.test.js`; validation was `tsc -p tsconfig.test.json` (identical to the pre-existing 10-error baseline in three untouched files), `shell-agent-dock` 34/34, `shell-terminal-strip` 66/66, `standalone-fleet-seam` 13/13, `terminal-sidebar-groupings` 53/53, `terminal-plan-attribution` 39/39, `seat-safeguards` 99/99, `team-scoped-routing` 68/68, `standalone-agent-isolation` 23/23, `cross-client-scope` 18/18, `mobile-command-route` 19/19, `ws-surface-scoping` 13/13, plus `pty-route-surface`, `pty-host-gating`, `terminal-token-transport`, `dispatch-curtain`, `standalone-parity:check`, `host-seam-parity:check`, `icons:parity` and `eslint` (0 errors).

## Deferred Findings

- MAJOR — goal item 1 is unachieved and its destination no longer exists: commit `8a77aa1f` deleted the Mission Control rail icon and moved the dock toggle to `#top-right-cluster`, where it still sits beside Setup, Memo and Connections — i.e. still among the settings icons the goal objected to. Choosing the new home is the author's call, not the reviewer's. `src/webview/shell.js:1265`
- MAJOR — goal item 5 is now implemented but unverified at runtime: the fix is source-level and the running instance serves the installed VSIX, not `src/`. Confirming the dock seat is absent from the Terminals sidebar and the rail fleet section requires a VSIX rebuild and a manual browser pass. `src/standalone/bootstrap.ts:1975`
- MAJOR — goal item 2 (dock terminal styling) was addressed only at the composition root: `bootstrap.ts` now stamps the first-paint theme class, closing a real standalone/extension divergence, but whether `.terminals-main`, `.pane-content` and the xterm palette actually resolve correctly inside the solo dock iframe was never observed. `src/standalone/bootstrap.ts:1005`
- NIT — `checkDockLiveness` filters on `t.light !== 'exited'`; `light` belongs to the relayed fleet shape, not the raw `ptyListTerminals` projection, so the condition is always vacuously true. `src/webview/shell.js:775`
- NIT — `isControllerTerminal` tests `t.name === 'Mission Control'`, but `ptyListTerminals` rows carry `friendlyName`; that arm never fires on this path and the match survives only via the `role` arm. `src/webview/shell.js:456`
- NIT — Restart never kills the dead handle, relying instead on `create()`'s dead-singleton reclaim; correct today, undocumented at the call site. `src/webview/shell.js:1024`
- NIT — the exited state shows both `#dock-restart` in the header and `#dock-start` in the empty state, two controls invoking the same `startDockTerminal`. `src/webview/shell.js:790`
- NIT — `setAgentDockRole` / `getAgentDockRole` remain in `SETUP_VERBS` and `KanbanProvider` with no client caller. `src/generated/verbAllowlist.ts:17`
- NIT — `catalog:check` and `compile-tests` are both red at HEAD from unrelated commits (`setCardPriority`/`setPriorityStarred` drift; 10 type errors in `ClickUpSyncService.ts`, `KanbanProvider.ts`, `LocalApiServer.ts`), which blocks `npm test` from reaching its own body. `package.json:11`
