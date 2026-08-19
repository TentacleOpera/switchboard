# Switchboard Operator Start from Shell Rail

## Goal

The shell rail's UFO button (built in the sibling plan "Orchestrator Visibility and Control in the Shell Rail") currently copies a prompt to clipboard when dimmed-clicked. It should instead actually start the operator when an agent is configured: create a pty terminal, boot the lead/coder CLI, and deliver the orchestrator persona prompt — seating the orchestrator into that terminal. When no lead/coder agent is configured, it must NOT create a terminal — it copies a prompt to the clipboard informing the agent to read the board and become the orchestrator itself.

### Problem Analysis

**Current state:**
- `POST /orchestration/start` exists in `LocalApiServer` (line 3190) but `orchestrationStart` is not wired in the standalone bootstrap — returns 503.
- The extension host's `startOrchestratorFromKanban` (TaskViewerProvider.ts:10807) creates a terminal via `vscode.window.createTerminal`, boots the lead/coder CLI, and delivers the persona prompt via `_buildOrchestratorKickoffPrompt` (line 10753). This uses VS Code APIs that do not exist in standalone.
- Standalone has the pty equivalents: `ptyFleetService.create(role, name, cwd)` for terminal creation and `deliverPrompt(handle, text, opts)` for prompt delivery. These are already used by the board dispatch path and the memo send-to-planner path.
- `getStartupCommands(root)` is public on `TaskViewerProvider` (line 7197) and available in standalone — returns the lead/coder startup commands.
- `_buildOrchestratorKickoffPrompt(root, initiatorProject)` is private on `TaskViewerProvider` (line 10753) — builds the direct persona prompt ("You are the Switchboard orchestrator. Read and follow `.agents/skills/switchboard-orchestrator/SKILL.md` now. UNATTENDED=true..."). It handles three modes: fresh start (interview), resume (armed), and stale-session. The standalone bootstrap needs access to this prompt — the method must be made public (or wrapped in a public accessor).
- The `/switchboard` launcher (`.agents/workflows/switchboard.md`) is the chat-agent flow: the agent adopts the seat itself (Step 2). It explicitly says "Never call `POST /orchestration/start` from here." This is the right prompt for the **clipboard fallback** (no terminal — the agent reads it in a chat and becomes the orchestrator), NOT for the terminal path.

**Root cause:** The standalone bootstrap never wired `orchestrationStart` because the extension host implementation depends on `vscode.window.createTerminal`. The pty equivalents exist but were not connected to the orchestration start path.

**Two paths, one button:**
- **Agent configured (terminal path):** The server creates a pty terminal, boots the CLI, and delivers the **persona prompt** (`_buildOrchestratorKickoffPrompt` output). The agent in the terminal reads `switchboard-orchestrator/SKILL.md`, runs the pre-flight, calls `POST /orchestration/adopt` to seat itself, and on user confirmation calls `POST /orchestration/confirm` to arm. The server does NOT seat the orchestrator — the agent does, after reading the prompt. This mirrors the extension host's `startOrchestratorFromKanban` flow exactly.
- **Agent NOT configured (clipboard fallback):** The server does NOT create a terminal. It returns a clipboard prompt that tells the agent to read the board and become the orchestrator — the `/switchboard` launcher text. The shell copies it to the clipboard. The agent that receives it follows the launcher flow (liveness check → adopt seat).

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, backend, api, refactor
**Project:** Browser Switchboard

## User Review Required

- **Terminal naming.** The extension host creates a terminal named "Orchestrator" (`ORCHESTRATOR_TERMINAL_NAME`). The standalone pty equivalent should use the same name for consistency. Confirm, or specify a different name (e.g. "Switchboard Operator").

> **Resolved:** The prompt variant question is settled. The terminal path uses the **persona prompt** (`_buildOrchestratorKickoffPrompt` output — "You are the Switchboard orchestrator. Read and follow `.agents/skills/switchboard-orchestrator/SKILL.md` now. `UNATTENDED=true`..."). The clipboard fallback (no agent configured) uses the **`/switchboard` launcher** text ("Run /switchboard workflow to start orchestration"). The launcher prompt is the chat-agent flow; the persona prompt is the seated-terminal flow. They are not interchangeable.

## Complexity Audit

### Routine
- Wiring `orchestrationStart` in the standalone bootstrap options object — the `LocalApiServerOptions` interface already declares the optional field.
- Calling `getStartupCommands(root)` to read the lead/coder CLI command — already public and available in standalone.
- Updating the shell.js dimmed-click handler to call `POST /orchestration/start` instead of copying to clipboard.

### Complex / Risky
- **Standalone `orchestrationStart` implementation.** Must replicate `startOrchestratorFromKanban`'s flow using pty equivalents: create terminal via `ptyFleetService.create`, boot the CLI, wait for shell readiness, deliver the persona prompt via `deliverPrompt`. The extension host uses `vscode.window.onDidStartTerminalShellExecution` for the shell-readiness wait — standalone needs a different approach (delay or pty readiness signal).
- **`_buildOrchestratorKickoffPrompt` visibility.** The method is private on `TaskViewerProvider` (line 10753). The standalone bootstrap needs to call it to get the persona prompt. Must be made public (or wrapped in a public accessor) — the method is pure (reads files, checks state, no side effects), so exposing it is safe.
- **Clipboard fallback response shape.** The server must return a distinct response for the no-agent case (`{ success: true, mode: 'clipboard', prompt: '...' }`) so the shell knows to copy to clipboard instead of showing a "started" toast. The shell handler must branch on `mode`.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Double-click start.** Two rapid dimmed-clicks could create two operator terminals. The existing `startOrchestratorFromKanban` guards against this by checking for an existing `orchestratorSeat` first (lines 10820-10840) — reuse the same guard: if a seat already exists, deliver the kickoff to the seated terminal instead of creating a new one.
- **Terminal not ready for prompt.** A freshly-created pty terminal's shell may not be ready to receive text immediately. The extension host waits for `onDidStartTerminalShellExecution` with a 5s safety timeout. Standalone needs an equivalent — a delay (like the 1500ms in `startOrchestratorFromKanban` line 10973) or a pty readiness signal from `ptyFleetService`.

**Security:**
- `POST /orchestration/start` is loopback-only and auth-gated (`_checkAuth`). The shell's fetch uses `credentials: 'same-origin'`. No new auth surface.

**Side Effects:**
- Creating a pty terminal spawns a real process. If the user clicks start then immediately clicks stop, the terminal is left alive (stop only disarms + clears the seat; it does not kill the terminal). This matches the extension host behavior — `stopOrchestratorFromKanban` does not close the terminal either.
- The operator agent will call `POST /orchestration/adopt` as part of its startup, which records the seat and triggers the `autobanStateSync` broadcast — lighting the UFO icon (the sibling plan's relay).
- **No terminal spawned in the clipboard fallback.** When no agent is configured, the server returns `{ success: true, mode: 'clipboard', prompt }` without creating any process. The shell copies the prompt. No side effects.

**Dependencies & Conflicts:**
- **node-pty required for the terminal path.** `ptyFleetService.create` requires node-pty. Without it, the terminal path cannot create a terminal — fall back to the clipboard response.
- **lead/coder startup command.** The operator boots the `lead` CLI (falling back to `coder`). If neither is configured, the server returns the clipboard fallback — NO terminal is created.
- **`_buildOrchestratorKickoffPrompt` must be made public.** The standalone bootstrap calls it to get the persona prompt. Without this change, the bootstrap cannot access the prompt and would have to duplicate the three-way branching logic (interview/resume/stale-session) — fragile and prone to drift.
- **Sibling plan dependency.** This plan changes the dimmed-click behavior defined in "Orchestrator Visibility and Control in the Shell Rail." The sibling plan's clipboard-copy fallback is superseded by this plan's `POST /orchestration/start` call — but the clipboard copy returns as the server-driven fallback when no agent is configured.

## Dependencies

- `orchestrator-visibility-and-control-in-shell-rail.md` — the sibling plan that builds the UFO button, the state relay, and the stop behavior. This plan changes the dimmed-click handler from clipboard-copy to `POST /orchestration/start`.

## Adversarial Synthesis

Key risks: (1) the standalone `orchestrationStart` must replicate the terminal-create + CLI-boot + prompt-deliver flow without `vscode.window` APIs — the pty equivalents exist but the shell-readiness wait is delay-only (1500ms), not signal-based, so a slow CLI boot could drop the prompt; (2) `_buildOrchestratorKickoffPrompt` is private and must be exposed — renaming it touches three internal call sites (lines 10822, 10971, 11037); (3) the clipboard fallback must NOT create a terminal — the server must return a distinct response shape so the shell knows to copy instead of showing a "started" toast; (4) the `orchestrationStart` return type change from `void` to a result object is safe (all callers ignore the return value today) but must be applied to both the interface and the extension host implementation. Mitigations: use the 1500ms delay (same as the extension host's fallback) and document that a pty readiness signal would be more robust; make `buildOrchestratorKickoffPrompt` public and update all three call sites; return `{ success: true, mode: 'clipboard', prompt }` for the no-agent case and branch on `mode` in the shell handler.

## Proposed Changes

### 1. Make `_buildOrchestratorKickoffPrompt` public on TaskViewerProvider

**File:** `src/services/TaskViewerProvider.ts`

The standalone bootstrap needs to call `_buildOrchestratorKickoffPrompt` (line 10753) to get the persona prompt for the terminal path. The method is pure — it reads files (`session.md`, `SKILL.md`), checks `_autobanState.orchestratorArmed`, and returns a prompt string. No side effects. Safe to expose.

Change the visibility:

```ts
// Before (line 10753):
private async _buildOrchestratorKickoffPrompt(

// After:
public async buildOrchestratorKickoffPrompt(
```

Drop the leading underscore to signal the method is now part of the public surface. Update the three internal call sites (lines 10822, 10971, 11037) to use the new name.

### 2. Wire `orchestrationStart` in standalone bootstrap

**File:** `src/standalone/bootstrap.ts`

Add `orchestrationStart` to the `LocalApiServerOptions` object (~line 2364, alongside `taskViewerVerb`). The implementation has two paths:

**Terminal path (agent configured):** Create a pty terminal, boot the CLI, deliver the persona prompt. The agent in the terminal adopts the seat itself via `POST /orchestration/adopt`.

**Clipboard fallback (no agent configured):** Return `{ success: true, mode: 'clipboard', prompt }` — NO terminal created. The shell copies the prompt.

**Logic:**
1. Check for an existing `orchestratorSeat` — if one exists with a terminal name, deliver the persona prompt to that terminal instead of creating a new one (same guard as `startOrchestratorFromKanban` lines 10820-10840).
2. Read startup commands via `taskViewerProvider.getStartupCommands(workspaceRoot)` → `startupCommands['lead'] || startupCommands['coder']`.
3. If a startup command exists: create a pty terminal via `ptyFleetService.create('orchestrator', 'Orchestrator', workspaceRoot)`, send the startup command into it, wait for shell readiness (1500ms delay, same as extension host fallback at line 10973), then deliver the persona prompt via `deliverPrompt`. Return `{ success: true, mode: 'terminal' }`.
4. If no startup command exists: return `{ success: true, mode: 'clipboard', prompt: 'Run /switchboard workflow to start orchestration' }`. Do NOT create a terminal.

**Implementation:**
```ts
orchestrationStart: async (workspaceRootArg?: string) => {
    const root = workspaceRootArg || workspaceRoot;

    // 1. Guard: if a seat already exists, deliver to the seated terminal.
    const seat = (taskViewerProvider as any)._autobanState?.orchestratorSeat;
    if (seat?.terminalName) {
        const handle = ptyFleetService.get(seat.terminalName);
        if (handle && handle.status === 'active') {
            const { prompt } = await taskViewerProvider.buildOrchestratorKickoffPrompt(root, undefined);
            await deliverPrompt(handle, prompt, getPromptDeliveryOptions());
            return { success: true, mode: 'terminal' };
        }
    }

    // 2. Read the lead/coder startup command.
    const startupCommands = await taskViewerProvider.getStartupCommands(root);
    const startupCommand = startupCommands['lead'] || startupCommands['coder'] || '';

    if (startupCommand && startupCommand.trim()) {
        // 3. Terminal path: create pty terminal, boot CLI, deliver persona prompt.
        const handle = await ptyFleetService.create('orchestrator', 'Orchestrator', root);
        // Boot the CLI into the terminal.
        await deliverPrompt(handle, startupCommand.trim(), { clearBeforePrompt: false });
        await new Promise(r => setTimeout(r, 1500)); // shell readiness wait
        const { prompt } = await taskViewerProvider.buildOrchestratorKickoffPrompt(root, undefined);
        await deliverPrompt(handle, prompt, getPromptDeliveryOptions());
        return { success: true, mode: 'terminal' };
    } else {
        // 4. Clipboard fallback: NO terminal created.
        return { success: true, mode: 'clipboard', prompt: 'Run /switchboard workflow to start orchestration' };
    }
},
```

**Note:** `orchestrationStart` now returns a result object instead of `void`. The `LocalApiServer` handler at line 3200 currently ignores the return value and sends a fixed success message. Update the handler to pass through the `mode` and `prompt` fields so the shell can branch on them.

**File:** `src/services/LocalApiServer.ts` (line 3200)

```ts
// Before:
await orchestrationStart(workspaceRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ success: true, message: 'Orchestrator seated and awaiting confirmation — pre-flight interview delivered. Call POST /orchestration/confirm after the user answers to arm.' }));

// After:
const result = await orchestrationStart(workspaceRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ success: true, ...result }));
```

### 3. Update shell.js dimmed-click handler

**File:** `src/webview/shell.js`

> **Superseded:** The dimmed-click handler in the sibling plan copies "Run /switchboard workflow to start orchestration" to the clipboard.
> **Reason:** The user wants the button to actually start the operator when an agent is configured — create a terminal, boot the CLI, deliver the persona prompt — not just copy text. Clipboard copy is the fallback when no agent is configured (server-driven, not a client-side guess).
> **Replaced with:** The dimmed-click handler calls `POST /orchestration/start`. The server decides: if an agent is configured, it creates a terminal and delivers the persona prompt (returns `mode: 'terminal'`). If not, it returns `mode: 'clipboard'` with the prompt text — the shell copies it. No terminal is created in the clipboard path.

Change the `else` branch in `createOrchestratorIcon`'s click handler:

```js
} else {
    // Dimmed click: start the operator.
    btn.dataset.tooltip = 'Operator: starting…';
    fetch('/orchestration/start', { method: 'POST', credentials: 'same-origin' })
        .then(res => res.json())
        .then(result => {
            if (result.success && result.mode === 'terminal') {
                showStripToast('Operator started — check the Orchestrator terminal');
            } else if (result.success && result.mode === 'clipboard') {
                // No agent configured — copy the prompt to clipboard.
                const text = result.prompt || 'Run /switchboard workflow to start orchestration';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(() => {
                        showStripToast('Copied: ' + text);
                    }).catch(() => {
                        showStripToast(text);
                    });
                } else {
                    showStripToast(text);
                }
            } else {
                showStripToast('Failed to start operator: ' + (result.error || 'unknown'));
            }
        })
        .catch(err => {
            showStripToast('Failed to start operator: ' + err.message);
        });
}
```

### 4. Update `LocalApiServerOptions` interface for return type

**File:** `src/services/LocalApiServer.ts`

The `orchestrationStart` option type (line 399) currently returns `Promise<void>`. Update it to return a result object so the handler can pass through `mode` and `prompt`:

```ts
// Before (line 399):
orchestrationStart?: (workspaceRoot?: string) => Promise<void>;

// After:
orchestrationStart?: (workspaceRoot?: string) => Promise<{ success: boolean; mode?: string; prompt?: string; error?: string }>;
```

The extension host's implementation (TaskViewerProvider.ts:3510) currently returns `void` — update it to return `{ success: true, mode: 'terminal' }` for consistency.

## Verification Plan

### Automated Tests
1. **Standalone start endpoint (terminal path):** Start the standalone server with node-pty available and a lead agent configured. Call `POST /orchestration/start`. Verify the response is `{ success: true, mode: 'terminal' }` and a pty terminal named "Orchestrator" is created with the lead/coder CLI booted into it.
2. **Persona prompt delivery:** Verify the prompt delivered to the terminal is the persona prompt from `buildOrchestratorKickoffPrompt` — it contains "You are the Switchboard orchestrator" and "UNATTENDED=true", NOT the `/switchboard` launcher text.
3. **Seat guard:** Adopt a seat first, then call `POST /orchestration/start`. Verify no second terminal is created — the persona prompt is delivered to the seated terminal.
4. **No lead/coder configured (clipboard fallback):** With no lead or coder startup commands, call `POST /orchestration/start`. Verify the response is `{ success: true, mode: 'clipboard', prompt: 'Run /switchboard workflow to start orchestration' }` and NO terminal is created.
5. **Shell dimmed-click (terminal):** With an agent configured, click the dimmed UFO icon. Verify `POST /orchestration/start` is called and a toast appears saying "Operator started — check the Orchestrator terminal."
6. **Shell dimmed-click (clipboard fallback):** With no agents configured, click the dimmed UFO icon. Verify the clipboard fallback fires (prompt copied) and a toast appears with the prompt text. No terminal created.
7. **Start then stop:** Click dimmed (start), wait for the icon to light (operator adopts seat), click lit (stop). Verify `POST /orchestration/stop` is called and the icon dims.

## Out of Scope

- **Renaming "Orchestrator" to "Switchboard Operator" in the codebase.** The terminal name, state fields, API endpoints, and skill files all use "orchestrator." Renaming is a separate effort. This plan uses "Switchboard Operator" in user-facing text (tooltips, toasts) but keeps the codebase identifiers as-is.
- **Closing the operator terminal on stop.** `stopOrchestratorFromKanban` disarms and clears the seat but does not kill the terminal. This matches the extension host behavior. Killing the terminal is a separate decision.
- **Heartbeat, timeout, or liveness polling.** Same as the sibling plan — the user is the reliable signal.
