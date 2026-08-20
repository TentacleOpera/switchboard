---
description: 'Switchboard Operator Control in the Browser Shell'
---

# Switchboard Operator Control in the Browser Shell

**Complexity:** 5

## Goal

Put a UFO icon in the browser shell rail that is the single control surface for the Switchboard Operator. When dimmed, clicking it starts the operator — if an agent is configured, the server creates a pty terminal, boots the lead/coder CLI, and delivers the orchestrator persona prompt (seating the orchestrator into that terminal); if no agent is configured, it copies a prompt to the clipboard telling the agent to read the board and become the orchestrator (no terminal created). When lit, clicking it stops the operator via POST /orchestration/stop. The icon lights when the operator registers (POST /orchestration/adopt) and dims when it deregisters or is stopped. No heartbeat, timeout, or liveness polling — the user is the reliable signal.

## How the Subtasks Achieve This

- **Orchestrator Visibility and Control in the Shell Rail**: Adds the UFO icon to the shell rail, wires the `autobanStateSync`/`updateAutobanConfig` relay from terminals.js to shell.js, renders the icon (dimmed when inactive, lit with animated lights when active), wires `POST /orchestration/stop` in the standalone bootstrap, and handles the lit-click (stop the operator). Also documents `POST /orchestration/stop` in the skill files. This is the visibility + stop half of the feature.
- **Switchboard Operator Start from Shell Rail**: Changes the dimmed-click handler from clipboard-copy to `POST /orchestration/start`. When an agent is configured, the server creates a pty terminal, boots the lead/coder CLI, and delivers the **persona prompt** (`buildOrchestratorKickoffPrompt` — "You are the Switchboard orchestrator. Read and follow `switchboard-orchestrator/SKILL.md` now. `UNATTENDED=true`..."). The agent in the terminal adopts the seat itself via `POST /orchestration/adopt`. When no agent is configured, the server returns a clipboard prompt ("Run /switchboard workflow to start orchestration") — NO terminal is created. Makes `_buildOrchestratorKickoffPrompt` public so the standalone bootstrap can call it. This is the start half of the feature.

## Dependencies & sequencing

The visibility plan must land first — it creates the UFO button, the state relay, and the stop wiring that the start plan builds on. The start plan supersedes the visibility plan's dimmed-click handler (clipboard-copy → `POST /orchestration/start`). Execute sequentially: visibility plan first, then start plan.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Orchestrator Visibility and Control in the Shell Rail](../plans/orchestrator-visibility-and-control-in-shell-rail.md) — **CODE REVIEWED**
- [ ] [Switchboard Operator Start from Shell Rail](../plans/operator-start-from-shell-rail.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

Both subtasks reviewed and PASSED after three fix rounds. Four CRITICAL and four MAJOR defects were found and fixed across `src/webview/shell.js`, `src/webview/shell.html`, `src/webview/terminals.js`, `src/standalone/bootstrap.ts`, `src/services/LocalApiServer.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, and two test files. The two that mattered most: the UFO icon never rendered on cold load (its only creator fired on a relayed message, and the assumed resync carrier was dropped by wsHub surface filtering), and two rapid dimmed-clicks would have booted two competing orchestrator terminals because the seat guard could not fire — the server never seats, the agent adopts later. Validation: `npm run compile` exit 0 / 0 errors, `test:contract:shell-terminal-strip` 46 passed / 0 failed, `test:contract:orchestrator-tick` 38 checks pass. Remaining risks, both accepted and documented in the subtask plans: the relay stays fail-closed on the terminals panel being mounted (no node-pty ⇒ icon renders dimmed but never lights), and shell readiness before persona-prompt delivery is a fixed 1500ms delay rather than a pty readiness signal, matching the extension host.
