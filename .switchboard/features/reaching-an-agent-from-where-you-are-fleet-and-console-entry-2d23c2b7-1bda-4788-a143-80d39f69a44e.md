# Reaching an Agent From Where You Are - Fleet and Console Entry Points

**Complexity:** 7

## Goal

Every agent surface in Switchboard is reachable from exactly one place, and it is usually not the place the operator is standing. The browser shell has no right-hand dock, so an agent terminal is always a mode switch away from the board. The Project Manager console has an entry point only in the VS Code sidebar, and its dispatch path cannot succeed in the standalone host anyway. And there is no way to reach the terminals cockpit from inside VS Code without hand-typing a runtime-assigned port. These three add the missing front doors. None of them render PTY terminals inside VS Code - the fleet stays in the browser.

## How the Subtasks Achieve This

- **Right-Hand Agent Dock in the Browser Shell**: adds a persistent right dock beside `#content` that auto-creates and hosts a live PTY seat via `?solo=`, with a role picker in its own header — the placement every agentic IDE has trained users to expect.
- **Project Manager Agent Has No Entry Point Outside the VS Code Sidebar**: adds a board MANAGE button present in both hosts, fixes the standalone liveness pre-flight that can never pass, and makes the clipboard fallback report success with the prompt in the response body.
- **Add an Open Terminal Grid Button Beside Open Agent Terminals**: registers a command plus Hub and status-bar entries that open the already-served cockpit in the system browser via `openExternal`, gated on pty readiness.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add an "Open Terminal Grid" Button Beside "Open Agent Terminals"](../plans/vscode-terminals-view-onto-pty-fleet.md) — **PLAN REVIEWED**
- [ ] [Right-Hand Agent Dock in the Browser Shell — a Persistent Agent Terminal Where IDE Users Expect Agent Chat](../plans/feature_plan_20260808220200_shell-right-agent-dock-terminal.md) — **PLAN REVIEWED**
- [ ] [Project Manager Agent Has No Entry Point Outside the VS Code Sidebar — Add a Board Button and Make the Dispatch Path Work Headlessly](../plans/feature_plan_20260808220300_project-manager-entry-point-browser-standalone.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**The terminals stay in the browser.** None of these subtasks render PTY terminals inside VS Code. The Open Terminal Grid subtask deliberately changes no dispatch behaviour at all — it is a way to *reach* the cockpit, nothing more. Making VS Code actions dispatch into browser PTY terminals is *One Board Operation Layer*'s allowPtyFleet subtask, not this feature.

The Open Terminal Grid subtask is fully independent and can land at any time. Route it through `vscode.env.openExternal`, never `simpleBrowser.show` — a webview-wrapped cross-origin iframe loses clipboard and `Ctrl+C` (`microsoft/vscode#182642`, `#129178`), and a terminal that cannot be interrupted is not a terminal.

⚠ **Cross-feature:** the agent dock and *Multi-Window Cockpit Reliability*'s solo pop-out sizing fix both own `?solo=` behaviour. **Land the sizing fix before or with the dock**, or the dock ships hosting a seat clamped to the cockpit grid cell.

⚠ The PM entry-point subtask edits the standalone `bootstrap.ts` verb surface, shared with *One Board Operation Layer*'s parity audit. Sequence them.
