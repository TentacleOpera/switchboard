# Comms Monitor: Capture Agent Output and Display in COMMS Tab UI

## Goal

The Comms Monitor feature (`.switchboard/features/mcp-monitor-improvements-643b487f-15a9-457f-b625-d1db2f2e434a.md`) is not fully implemented. The agent (Claude in the monitor terminal) produces output when it checks Slack/Gmail/Calendar, but that output is only visible in the terminal pane. The user has to manually check the terminal to see results. The feature should capture the agent's output (when there's something to report) and display it in the COMMS tab UI so the user doesn't need to switch to the terminal.

### Problem Analysis & Root Cause

**Symptom:** The Comms Monitor polls Slack/Gmail/Calendar via a Claude terminal. When Claude finds new messages, the results appear only in the terminal pane. The user must manually check the terminal to see what was found. There is no in-UI display of the monitor's findings.

**Root cause (confirmed by code reading):** The Comms Monitor's tick cycle (`_mcpMonitorTick` in `src/services/TaskViewerProvider.ts`, line ~20499) sends a prompt to the terminal via `sendRobustText` and then persists the `sourceLastCheckAt` baseline. It does NOT capture or display the terminal output. There is no output capture mechanism anywhere in the comms monitor code:

- `_mcpMonitorTick` (line ~20499): sends prompt, updates baseline, returns. No output capture.
- `_postMcpMonitorConfig` (line ~20665): pushes config + status to webview. No output field.
- The webview's `updateMcpMonitorConfig` handler (kanban.html ~6879): updates config, status, presets. No output display.
- The COMMS tab UI (`createCommsPanel` in kanban.html ~8895): shows config, lifecycle buttons, status line, help text. No output/results area.

**The feature file** (`mcp-monitor-improvements-643b487f-15a9-457f-b625-d1db2f2e434a.md`) describes the monitor as one that "periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar" and the intro text in the UI says "Results appear in the monitor terminal pane." The feature's subtasks focused on lifecycle, polling, prompt quality, and naming — none of them implemented output capture. This is a gap in the feature's implementation.

**Technical challenge:** VS Code's `vscode.window.onDidWriteTerminalData` API (which would allow capturing terminal output) is a **proposed API** — it requires `--enable-proposed-api` and is not available in published extensions. The standard `vscode.Terminal` API does not provide output reading capabilities. Alternative approaches:

1. **Shell integration API:** `vscode.window.onDidStartTerminalShellExecution` provides a `TerminalShellExecution` object with a `stdout` reader — but this only works for shell commands, not interactive CLI agents like Claude.
2. **Pseudoterminal API:** Create the monitor terminal as a `Pseudoterminal` instead of a standard terminal, which gives full control over input/output. However, this would break the current approach of launching Claude in a real terminal.
3. **File-based capture:** Instruct Claude to write its findings to a file (e.g., `.switchboard/comms-monitor-latest.md`) as part of the prompt, then read and display that file in the UI. This is the most reliable approach for a published extension.
4. **Clipboard capture:** After the prompt is sent, wait for Claude to finish, then read the terminal output via clipboard. This is fragile and unreliable.

## Metadata

- **Tags:** feature, comms-monitor, ui, output-capture, ux
- **Complexity:** 6
- **Project:** switchboard
- **Repo:** (root — single-repo extension)
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`, possibly `src/services/GlobalIntegrationConfigService.ts`

## Complexity Audit

### Routine
- Adding a results display area to the COMMS tab UI (HTML/CSS in `createCommsPanel`).
- Reading a file and posting its contents to the webview.
- Adding a "Latest Results" section with timestamp and content.

### Complex / Risky
- **Output capture strategy:** The core challenge. The file-based approach (option 3) is the most reliable for a published extension but requires modifying the prompt to instruct Claude to write to a file, then reading that file after a delay. The timing is tricky — the extension must wait for Claude to finish processing before reading the file.
- **Detecting when Claude is done:** There's no reliable signal that Claude has finished responding. The extension would need to poll for the output file's modification time or use a sentinel marker.
- **Prompt modification:** The prompt must instruct Claude to write findings to a specific file path, which changes the prompt format and may affect Claude's behavior.

## Edge-Case & Dependency Audit

### Edge Cases
- Claude responds "All clear" (nothing to report) — the output file should reflect this or not be written.
- Claude errors or doesn't respond — the output capture should timeout gracefully and show "No response received."
- Multiple sources checked in one tick — the output should show results for all sources.
- Terminal is closed mid-response — the file may be partially written or not written at all.
- File write permissions — the `.switchboard/` directory should exist, but verify.

### Dependencies
- The prompt change must be compatible with the existing `_buildMcpMonitorPrompt` structure and the `promptOverride` feature (user-provided prompts won't include the file-write instruction).
- The output file path must be consistent between the prompt and the reader.
- The display must handle markdown-formatted output (Claude's bullet lists).

### Security
- The output file is written by Claude in the workspace directory. It should be sanitized before display in the webview (prevent XSS). The webview already uses `textContent` for most display, but if markdown rendering is used, it must be sanitized.

## Proposed Changes

### Approach: File-based output capture

**1. Modify the prompt** to instruct Claude to write findings to a file:

In `_buildMcpMonitorPrompt` (line ~20553), add a postscript to the preamble:

```ts
const outputPath = path.join(this._resolveWorkspaceRoot() ?? '', '.switchboard', 'comms-monitor-latest.md');
const preamble = `Check the following for anything new that needs my attention ${boundary}. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything — EXCEPT write your findings to the file \`${outputPath}\` using your file-write tool. Format the file as markdown with a timestamp header and bullet points.`;
```

**2. Add output capture to `_mcpMonitorTick`** (line ~20499):

After `sendRobustText` completes, schedule a delayed file read (e.g., 60s) to allow Claude time to process and write the file:

```ts
if (prompt) {
    await sendRobustText(terminal, prompt, true);
    this._mcpMonitorLastSendAt = Date.now();
    // Persist sourceLastCheckAt...
    
    // Schedule output capture — read the results file after a delay
    // to give Claude time to process and write.
    if (this._mcpMonitorOutputTimer) {
        clearTimeout(this._mcpMonitorOutputTimer);
    }
    this._mcpMonitorOutputTimer = setTimeout(async () => {
        this._mcpMonitorOutputTimer = undefined;
        await this._captureMcpMonitorOutput();
    }, 60 * 1000); // 60s for Claude to respond + write file
}
```

**3. Add the output capture method:**

```ts
private async _captureMcpMonitorOutput(): Promise<void> {
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) return;
    const outputPath = path.join(workspaceRoot, '.switchboard', 'comms-monitor-latest.md');
    try {
        const content = await fs.promises.readFile(outputPath, 'utf-8');
        const stat = await fs.promises.stat(outputPath);
        const message = {
            type: 'commsMonitorOutput',
            output: content,
            timestamp: stat.mtime.toISOString()
        };
        this._view?.webview.postMessage(message);
        this._kanbanProvider?.postMessage(message);
    } catch {
        // File doesn't exist or can't be read — Claude hasn't written it yet
        // or responded "All clear" without writing. Post a "no output" state.
        const message = {
            type: 'commsMonitorOutput',
            output: null,
            timestamp: new Date().toISOString()
        };
        this._view?.webview.postMessage(message);
        this._kanbanProvider?.postMessage(message);
    }
}
```

**4. Add a results display area to the COMMS tab UI** in `createCommsPanel` (kanban.html ~8895):

Add a "Latest Results" section after the status line:

```js
// ─── Latest Results ───
const resultsSection = document.createElement('div');
resultsSection.id = 'comms-monitor-results';
resultsSection.style.cssText = 'margin-top:8px; padding:8px; border:1px solid var(--border-color); border-radius:4px; background:var(--panel-bg2); font-family:var(--font-mono); font-size:10px; color:var(--text-primary); max-height:200px; overflow-y:auto; white-space:pre-wrap;';
if (window.__commsMonitorOutput) {
    resultsSection.textContent = window.__commsMonitorOutput;
} else {
    resultsSection.textContent = '(no results yet — start polling to see monitor output)';
}
mcpConfigPanel.appendChild(resultsSection);
```

**5. Add a message handler** for `commsMonitorOutput` in the webview:

```js
case 'commsMonitorOutput': {
    window.__commsMonitorOutput = msg.output
        ? `[${new Date(msg.timestamp).toLocaleTimeString()}]\n${msg.output}`
        : `[${new Date(msg.timestamp).toLocaleTimeString()}] No output captured (Claude may have responded "All clear" or not yet finished).`;
    if (!isCommsPanelInteracting) {
        renderCommsPanel();
    } else {
        commsPanelRenderPending = true;
    }
    break;
}
```

**6. Clean up the output timer in `_stopMcpMonitorLoop`:**

```ts
private _stopMcpMonitorLoop() {
    if (this._mcpMonitorTimer) { clearInterval(this._mcpMonitorTimer); this._mcpMonitorTimer = undefined; }
    if (this._mcpMonitorFirstPromptTimer) { clearTimeout(this._mcpMonitorFirstPromptTimer); this._mcpMonitorFirstPromptTimer = undefined; }
    if (this._mcpMonitorConfigChangeTimer) { clearTimeout(this._mcpMonitorConfigChangeTimer); this._mcpMonitorConfigChangeTimer = undefined; }
    if (this._mcpMonitorOutputTimer) { clearTimeout(this._mcpMonitorOutputTimer); this._mcpMonitorOutputTimer = undefined; }
}
```

**7. Add the timer field** to the class:

```ts
private _mcpMonitorOutputTimer: NodeJS.Timeout | undefined;
```

## Verification Plan

1. Start the Comms Monitor terminal, check auth, start polling.
2. Wait for the first tick (should be ~2s after the start-polling fix is applied, or ~30s on current code).
3. Wait ~60s after the prompt is sent for Claude to process and write the output file.
4. Verify the "Latest Results" section in the COMMS tab shows Claude's findings (bullet list with timestamp).
5. If Claude responds "All clear", verify the results section shows "No output captured" or the "All clear" response.
6. Stop polling — verify the output timer is cancelled and no further output capture attempts are made.
7. Restart polling — verify the output capture cycle resumes.
8. Verify the output file (`.switchboard/comms-monitor-latest.md`) is overwritten on each tick, not appended to.
9. Verify the results display handles markdown-formatted content correctly (bullet points, bold text, etc.).
10. Verify XSS safety — if Claude writes HTML/script tags in the output, they should be displayed as text, not rendered.
