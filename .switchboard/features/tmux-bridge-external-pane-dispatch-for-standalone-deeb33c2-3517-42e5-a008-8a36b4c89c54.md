# tmux Bridge: External Pane Dispatch for Standalone

**Complexity:** 7

## Goal

Add a tmux transport bridge so standalone Switchboard can dispatch prompts into tmux panes it does not own. Part 1 delivers the transport module behind the existing TerminalBackend seam with tests and no wiring. Part 2 wires it into standalone dispatch: pane discovery, runtime.terminals registration, dispatch pre-flight visibility, and sendToTerminal/triggerAction resolution, all gated behind an opt-in setting that defaults off. Part 3 makes the bridge reachable on Windows by documenting and smoothing the WSL path — tmux does not exist on native Windows, but running Switchboard inside WSL2 makes the bridge work as designed because WSL is Linux.

## How the Subtasks Achieve This

- **tmux Bridge Part 1: Transport Layer**: Implements the `TerminalBackend` / `TerminalHandle` seam for tmux — `send-keys` for text delivery, `load-buffer`/`paste-buffer` for multi-line prompts, pane discovery via `list-panes`. New module and tests only; no wiring into host seams or dispatch paths, so no behaviour change for any existing user.
- **tmux Bridge Part 2: Standalone Dispatch Integration**: Wires the Part 1 transport into standalone Switchboard. tmux panes become registerable in `runtime.terminals`, visible to the `/kanban/dispatch` pre-flight, and reachable from `sendToTerminal` and `triggerAction`. Adoption is explicit and opt-in (default off) with a bare-shell refusal guard, because a tmux pane runs whatever the user left in it.
- **WSL Standalone Support for tmux Bridge on Windows**: Makes the bridge reachable on Windows by smoothing the WSL path. Detects WSL at runtime, fixes browser opening from inside WSL (calls `cmd.exe` instead of the absent `xdg-open`), adds a discovery hint on native Windows, and ships a setup guide. No change to the server bind, loopback guards, or any security boundary — WSL2's localhost forwarding already makes the board reachable from a Windows browser.

## Dependencies & sequencing

Part 1 must land before Part 2 — Part 2 consumes `TmuxTerminalBackend`, `isTmuxAvailable()`, `listTmuxPanes()`, and `sendPromptToTmux()` from Part 1. Part 1 is purely additive (new files, no existing call sites touched) and can ship independently. Part 2 depends on Part 1 being complete. Part 3 can land in parallel with Parts 1 and 2 — it touches only the CLI browser-open path and adds a new doc file, with no dependency on the transport or dispatch code.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [tmux Bridge Part 1: Transport Layer](../plans/tmux-bridge-1-transport-layer.md) — **CREATED** — ID: 8bc07323-3c00-4614-b48f-e5069c263f83
- [ ] [tmux Bridge Part 2: Standalone Dispatch Integration](../plans/tmux-bridge-2-standalone-dispatch-integration.md) — **CREATED** — ID: f1965bc4-a221-4928-a64f-1c3165eaae2f
- [ ] [WSL Standalone Support for tmux Bridge on Windows](../plans/wsl-standalone-support-for-tmux-bridge-on-windows.md) — **CREATED** — ID: b59e9fae-6409-480b-ba24-829db3891932
<!-- END SUBTASKS -->

