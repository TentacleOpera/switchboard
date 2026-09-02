# tmux Bridge: External Pane Dispatch for Standalone

**Complexity:** 7

## Goal

Add a tmux transport bridge so standalone Switchboard can dispatch prompts into tmux panes it does not own. Part 1 delivers the transport module behind the existing TerminalBackend seam with tests and no wiring. Part 2 wires it into standalone dispatch: pane discovery, runtime.terminals registration, dispatch pre-flight visibility, and sendToTerminal/triggerAction resolution, all gated behind an opt-in setting that defaults off. Part 3 makes the bridge reachable on Windows by documenting and smoothing the WSL path — tmux does not exist on native Windows, but running Switchboard inside WSL2 makes the bridge work as designed because WSL is Linux. Part 4 extends the bridge to team seating: `startTeamForWorkspace` can seat a team's members as panes in a tmux session Switchboard creates and owns, instead of as children of the PTY fleet — one seating path, one team model, the terminal backend becomes a setting, not a second mode.

## How the Subtasks Achieve This

- **tmux Bridge Part 1: Transport Layer**: Implements the `TerminalBackend` / `TerminalHandle` seam for tmux — `send-keys` for text delivery, `load-buffer`/`paste-buffer` for multi-line prompts, pane discovery via `list-panes`. New module and tests only; no wiring into host seams or dispatch paths, so no behaviour change for any existing user.
- **tmux Bridge Part 2: Standalone Dispatch Integration**: Wires the Part 1 transport into standalone Switchboard. tmux panes become registerable in `runtime.terminals`, visible to the `/kanban/dispatch` pre-flight, and reachable from `sendToTerminal` and `triggerAction`. Adoption is explicit and opt-in (default off) with a bare-shell refusal guard, because a tmux pane runs whatever the user left in it.
- **WSL Standalone Support for tmux Bridge on Windows**: Makes the bridge reachable on Windows by smoothing the WSL path. Detects WSL at runtime, fixes browser opening from inside WSL (calls `cmd.exe` instead of the absent `xdg-open`), adds a discovery hint on native Windows, and ships a setup guide. No change to the server bind, loopback guards, or any security boundary — WSL2's localhost forwarding already makes the board reachable from a Windows browser.
- **A Team Can Be Seated Into A tmux Session Switchboard Owns**: Lets `startTeamForWorkspace` seat a team into a tmux session Switchboard creates and owns, instead of the PTY fleet. One seating path, one team model — the terminal backend becomes a workspace-scoped setting defaulting to `fleet`, so no existing user's behaviour changes. tmux panes survive ssh disconnect and laptop lid close; a fleet pane does not. Depends on Part 1 only (not Part 2 — this plan creates panes, not adopts them).

## Dependencies & sequencing

Part 1 must land before Part 2 — Part 2 consumes `TmuxTerminalBackend`, `isTmuxAvailable()`, `listTmuxPanes()`, and `sendPromptToTmux()` from Part 1. Part 1 is purely additive (new files, no existing call sites touched) and can ship independently. Part 2 depends on Part 1 being complete. Part 4 also depends on Part 1 (hard prerequisite — it consumes `TmuxTerminalBackend`, `isTmuxAvailable()`, `listTmuxPanes()`, `sendPromptToTmux()`, and `TMUX_IDE_NAME`), but does NOT depend on Part 2 — Part 4 creates panes rather than adopting them, so it does not use Part 2's adoption guard. Part 4 can land in parallel with Part 2 once Part 1 is complete. Part 3's WSL browser-open fix (WSL detection + `cmd.exe` routing + setup guide) is independent and can land in parallel with Parts 1, 2, and 4. However, Part 3's discovery hint (the native-Windows log message) calls `isTmuxAvailable()` from Part 1 and reads `switchboard.terminal.tmux.enabled` from Part 2, so that specific phase requires Parts 1 and 2 to be complete. If Part 3 ships first, defer the discovery hint.

## Team Dispatch Instructions

### tmux Bridge Part 1: Transport Layer
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - `isTmuxAvailable()` returns `false` without throwing when tmux is absent or no server is running
  - No `exec(`, `execSync(`, or `shell: true` in `tmuxBackend.ts` or `tmuxPromptDelivery.ts` (argv-only)
  - `dispose()` never issues `kill-pane`; `kill()` does
  - Confirm Enter is unconditional (two Enters, no regex gate) — `CLI_AGENT_REGEX` was deleted from the codebase
  - Temp files created for `load-buffer` are mode `0600` and unlinked in a `finally` even when `paste-buffer` throws
- **Must not touch:** `ptyBackend.ts`, `ptyFleetService.ts`, `ptyPromptDelivery.ts`, `terminalUtils.ts` — delivery logic is deliberately duplicated, not abstracted

### tmux Bridge Part 2: Standalone Dispatch Integration
- **Seat:** Lead Coder (complexity 7)
- **Acceptance:**
  - `getRegisteredTerminals()` unions PTY and tmux fleets, de-duplicated PTY-first
  - `reconcile()` drops rows for absent panes and keeps rows for present ones (not a blanket purge)
  - `tmuxAdoptPane` refuses `bash`/`zsh`/`fish`/`sh` via a shell blacklist regex on `pane_current_command`; `force: true` overrides
  - `isCompatibleIdeName('switchboard-tmux', <any vscode appName>)` returns `false` so old extension hosts filter tmux rows out
  - tmux verbs are on `/terminals/verb/` only, never `/kanban/verb/`
  - Setting off (default) = zero behaviour change for existing users
- **Must not touch:** `TaskViewerProvider.ts` — extension-host integration is out of scope; `LocalApiServer.ts` loopback bind and socket peer check are unchanged

### WSL Standalone Support for tmux Bridge on Windows
- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `detectWsl()` returns correct `{ wsl, version }` for WSL1, WSL2, native Linux, macOS, and native Windows
  - `openBrowser()` calls `cmd.exe` inside WSL, falls back to `wslview`, then prints the URL — never crashes
  - Native Windows with `tmux.enabled: true` prints the WSL hint; with `tmux.enabled: false` (default) prints nothing
  - No change to server bind address, socket peer check, or any security-sensitive file
- **Must not touch:** `LocalApiServer.ts`, `loopbackHostname.ts`, or any security-sensitive file

### A Team Can Be Seated Into A tmux Session Switchboard Owns
- **Seat:** Lead Coder (complexity 7)
- **Acceptance:**
  - With no `terminalBackend` setting, `startTeamForWorkspace` uses the PTY fleet exactly as today — zero behaviour change for existing installs
  - Setting `terminalBackend: 'tmux'` seats the team into a `sb-<teamname>` tmux session with one pane per member, `pane_title` set to each member's friendly name
  - Reconnect: restarting Switchboard with a surviving `sb-*` session reattaches if pane titles match the roster; refuses if they don't
  - `runtime.terminals` coexists: fleet entries (`switchboard-pty`) and tmux entries (`switchboard-tmux`) both survive a tmux team seating
  - Wire-supplied `payload.backend` is rejected in both hosts' `ptyStartTeam` verb arms
  - Both composition roots (extension `TaskViewerProvider.instantiateAgentGroup` + standalone `bootstrap.ts` `setAgentGroupInstantiator`) read the setting and branch on it
- **Must not touch:** The team model (roles, roster, definition resolution, standing orders, `instantiateAgentGroupCore` flow) — only the `createHeadWithDelegates` callback and `onCreated` registry update branch on the backend. `PtyFleetService` is not modified.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [tmux Bridge Part 1: Transport Layer](../plans/tmux-bridge-1-transport-layer.md) — **PLAN REVIEWED** — ID: 8bc07323-3c00-4614-b48f-e5069c263f83
- [ ] [tmux Bridge Part 2: Standalone Dispatch Integration](../plans/tmux-bridge-2-standalone-dispatch-integration.md) — **PLAN REVIEWED** — ID: f1965bc4-a221-4928-a64f-1c3165eaae2f
- [ ] [WSL Standalone Support for tmux Bridge on Windows](../plans/wsl-standalone-support-for-tmux-bridge-on-windows.md) — **PLAN REVIEWED** — ID: b59e9fae-6409-480b-ba24-829db3891932
- [ ] [A Team Can Be Seated Into A tmux Session Switchboard Owns](../plans/seat-a-team-into-a-switchboard-owned-tmux-session.md) — **PLAN REVIEWED** — ID: 05f70823-595e-42db-ae95-07cd01b0a860
<!-- END SUBTASKS -->

