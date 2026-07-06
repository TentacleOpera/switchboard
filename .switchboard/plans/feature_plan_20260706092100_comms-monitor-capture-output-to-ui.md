# Comms Monitor: Capture Agent Output and Display in COMMS Tab UI

## Goal

The Comms Monitor feature (`.switchboard/features/mcp-monitor-improvements-643b487f-15a9-457f-b625-d1db2f2e434a.md`) is not fully implemented. The agent (Claude in the monitor terminal) produces output when it checks Slack/Gmail/Calendar, but that output is only visible in the terminal pane. The user has to manually check the terminal to see results. The feature should capture the agent's output (when there's something to report) and display it in the COMMS tab UI so the user doesn't need to switch to the terminal.

### Problem Analysis & Root Cause

**Symptom:** The Comms Monitor polls Slack/Gmail/Calendar via a Claude terminal. When Claude finds new messages, the results appear only in the terminal pane. The user must manually check the terminal to see what was found. There is no in-UI display of the monitor's findings.

**Root cause (confirmed by code reading):** The Comms Monitor's tick cycle (`_mcpMonitorTick` in `src/services/TaskViewerProvider.ts`, line 20517) sends a prompt to the terminal via `sendRobustText` and then persists the `sourceLastCheckAt` baseline. It does NOT capture or display the terminal output. There is no output capture mechanism anywhere in the comms monitor code:

- `_mcpMonitorTick` (line 20517): sends prompt, updates baseline, returns. No output capture.
- `_postMcpMonitorConfig` (line 20683): pushes config + status to webview. No output field.
- The webview's `updateMcpMonitorConfig` handler (kanban.html line 6888): updates config, status, presets. No output display.
- The COMMS tab UI (`createCommsPanel` in kanban.html line 8904): shows config, lifecycle buttons, status line, help text. No output/results area.

**The feature file** (`mcp-monitor-improvements-643b487f-15a9-457f-b625-d1db2f2e434a.md`) describes the monitor as one that "periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar" and the intro text in the UI says "Results appear in the monitor terminal pane." The feature's subtasks focused on lifecycle, polling, prompt quality, and naming — none of them implemented output capture. This is a gap in the feature's implementation.

**Technical challenge:** VS Code's `vscode.window.onDidWriteTerminalData` API (which would allow capturing terminal output) is a **proposed API** — it requires `--enable-proposed-api` and is not available to published extensions. The standard `vscode.Terminal` API does not provide output reading capabilities. Alternative approaches:

1. **Shell integration API:** `vscode.window.onDidStartTerminalShellExecution` provides a `TerminalShellExecution` object with a `stdout` reader — but this only works for shell commands, not interactive CLI agents like Claude.
2. **Pseudoterminal API:** Create the monitor terminal as a `Pseudoterminal` instead of a standard terminal, which gives full control over input/output. However, this would break the current approach of launching Claude in a real terminal.
3. **File-based capture:** Instruct Claude to write its findings to a file (e.g., `.switchboard/comms-monitor-latest.md`) as part of the prompt, then read and display that file in the UI. This is the most reliable approach for a published extension.
4. **Clipboard capture:** After the prompt is sent, wait for Claude to finish, then read the terminal output via clipboard. This is fragile and unreliable.

## Metadata

- **Tags:** feature, ui, ux
- **Complexity:** 7
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`, possibly `src/services/GlobalIntegrationConfigService.ts`

## User Review Required

**This plan modifies the Comms Monitor prompt preamble** — the instruction that Claude receives on every poll tick. Adding a file-write directive changes Claude's behavior and may affect response quality. The 60-second delay before reading the output file is a heuristic guess; if Claude is slow or unresponsive, the user will see stale or "no output" results. The prompt change must also coexist with Plan 2's preamble-clarity fix (see Dependencies). **User should confirm:**

1. Is a 60s capture delay acceptable, or should the timer be configurable?
2. Is it acceptable that user-provided `promptOverride` prompts will NOT include the file-write instruction (meaning output capture silently disables for custom prompts)?
3. Should the "Latest Results" area render markdown (risk: XSS from Claude-written content) or display raw text only (safe but less readable)?

## Complexity Audit

### Routine
- Adding a results display area to the COMMS tab UI (HTML/CSS in `createCommsPanel` at line 8904).
- Reading a file and posting its contents to the webview via the established `this._view?.webview.postMessage(message)` + `this._kanbanProvider?.postMessage(message)` push pattern (confirmed at lines 20695-20696).
- Adding a "Latest Results" section with timestamp and content.
- Adding the `_mcpMonitorOutputTimer` field alongside existing timer fields (lines 358-360).
- Adding timer cleanup to `_stopMcpMonitorLoop` (line 20492).

### Complex / Risky
- **Output capture strategy:** The core challenge. The file-based approach (option 3) is the most reliable for a published extension but requires modifying the prompt to instruct Claude to write to a file, then reading that file after a delay. The timing is tricky — the extension must wait for Claude to finish processing before reading the file.
- **Detecting when Claude is done:** There's no reliable signal that Claude has finished responding. The extension would need to poll for the output file's modification time or use a sentinel marker. The 60s fixed delay is a **guess** — Claude may respond in 10s or 90s depending on source count and MCP server latency. A too-short delay reads stale data; a too-long delay makes the feature feel sluggish.
- **Prompt modification:** The prompt must instruct Claude to write findings to a specific file path, which changes the prompt format and may affect Claude's behavior. This instruction is appended to the preamble in `_buildMcpMonitorPrompt` (line 20571) and must coexist with Plan 2's preamble-clarity fix to the same text.
- **Claude file-write reliability:** Claude may not reliably write to the file. In testing, Claude sometimes responds "All clear" without writing the file, or ignores the file-write instruction entirely. The fallback path (no file found → "No output captured") handles this but may confuse users who see Claude's terminal output but not the UI display.
- **XSS risk from Claude-written markdown:** The output file is written by Claude and could contain arbitrary content including HTML/script tags. The webview must use `textContent` (not `innerHTML`) for display, or sanitize the content if markdown rendering is desired.

## Edge-Case & Dependency Audit

### Race Conditions
- **Tick overlap:** If the polling interval is shorter than Claude's response time + the 60s capture delay, a new tick could fire before the previous output capture completes. The `_mcpMonitorInFlight` guard (line 20535) prevents concurrent `sendRobustText` calls, but the output timer fires independently. If a new tick sends a new prompt while the old output timer is pending, the old timer should be cancelled (the plan's `clearTimeout` before setting a new timer handles this). However, the output file may be overwritten by the new prompt's response before the old timer reads it — this is acceptable since the old response is stale anyway.
- **File read during write:** Claude may be mid-write when the 60s timer fires. `fs.promises.readFile` could read a partially-written file. Mitigation: the file is small (a few KB of bullet points), and Claude's file-write tool writes atomically in most cases. If partial reads are a concern, read the file, wait 500ms, read again, and only post if the content matches.
- **Interaction guard vs. output update:** The `isCommsPanelInteracting` guard (line 6225) prevents `renderCommsPanel()` from firing while the user is typing in the COMMS panel. If an output message arrives during interaction, the render is skipped. Per the feature's shipping order, the **Stop Polling stuck-button fix (sibling plan)** ships first and adds a `commsPanelRenderPending` flag to the codebase; this handler should use that same deferred-render pattern so output updates are not silently lost during interaction. If implemented before the stuck-button fix, fall back to the simple skip-render pattern (the next unrelated `renderCommsPanel()` call picks up the new `window.__commsMonitorOutput` value).

### Security
- **XSS from Claude-written content:** The output file is written by Claude in the workspace directory. It could contain `<script>` tags, `<img onerror=...>` payloads, or other HTML injection. The webview MUST use `textContent` for display (the plan's code does this correctly). If markdown rendering is desired in the future, a sanitizer (e.g., DOMPurify) must be added first. **Do not use `innerHTML` with Claude-written content.**
- **File path injection:** The `outputPath` is constructed from `_resolveWorkspaceRoot()` (returns `string | null`, confirmed at line 1318) plus a hardcoded `.switchboard/comms-monitor-latest.md` suffix. There is no user-controlled component in the path, so path traversal is not a concern.
- **Sensitive data in output file:** Claude's findings may include email subjects, Slack message previews, or calendar event details. The output file is stored in the workspace's `.switchboard/` directory (which should be `.gitignore`d). Verify that `.switchboard/` is in the workspace's `.gitignore` to prevent accidental commits of sensitive monitor output.

### Side Effects
- **Prompt preamble change affects all monitor users:** The file-write instruction is added to the shared preamble in `_buildMcpMonitorPrompt` (line 20586). Every poll tick will include this instruction, even for users who don't care about the UI display. The instruction adds ~40 tokens to each prompt, slightly increasing Claude's processing time and token usage.
- **Output file persists between sessions:** The `.switchboard/comms-monitor-latest.md` file is not cleaned up when polling stops or the extension deactivates. On next startup, the UI may display stale results from a previous session. Consider clearing the file when polling starts, or showing the file's modification timestamp prominently so the user can see how old the data is.
- **`promptOverride` bypasses file-write instruction:** If a user provides a custom `promptOverride` (line 20573), the entire template is replaced — including the file-write instruction. Output capture will silently fail for custom prompts. This should be documented in the UI or the file-write instruction should be appended separately (after the override check).

### Dependencies & Conflicts
- **Plan 2 preamble conflict (CRITICAL):** This plan modifies the preamble string in `_buildMcpMonitorPrompt` (line 20586). Plan 2 (the prompt-clarity fix) also modifies the same preamble. If both plans are implemented, the preamble changes must be merged carefully. **Sequencing: Plan 2 should ship first** (it rewrites the preamble for clarity), then this plan appends the file-write instruction to the clarified preamble. If this plan ships first, Plan 2's rewrite may accidentally remove the file-write instruction.
- **Assumption: `vscode.window.onDidWriteTerminalData` is proposed-only.** This plan chooses the file-based approach specifically because `onDidWriteTerminalData` is assumed to be a proposed API unavailable to published extensions. **This assumption needs confirming against the current VS Code API surface.** If the API has been stabilized since this analysis, a terminal-capture approach would be simpler and more reliable than the file-based workaround. However, as of VS Code 1.96, `onDidWriteTerminalData` remains in the `vscode.proposed` namespace and requires `--enable-proposed-api`, so the file-based approach is correct for a published extension.
- **Claude file-write reliability is unproven.** The 60s delay is a guess. Claude's response time varies widely depending on the number of sources, MCP server latency, and model load. In practice, Claude may take 15-90 seconds to respond. The 60s delay may be too short (miss the response) or too long (user waits unnecessarily). A polling approach (check file every 10s for up to 120s) would be more robust but adds complexity.

## Dependencies

- No external session dependencies.
- **Soft sequencing dependency on Plan 2** (same preamble in `_buildMcpMonitorPrompt`): Plan 2 should ship first to avoid preamble merge conflicts. This plan appends the file-write instruction after Plan 2's clarity fix is in place. If Plan 2 has not shipped, the implementer must manually reconcile both preamble changes.

## Adversarial Synthesis

This plan bets its entire output-capture mechanism on Claude reliably writing a file within 60 seconds — a behavior that is neither guaranteed nor tested. The 60s fixed delay is a brittle heuristic: too short for complex multi-source checks, too long for simple "All clear" responses. The file-write instruction silently disables for `promptOverride` users, creating an inconsistent experience. The preamble modification conflicts with Plan 2's pending rewrite of the same string. And the proposed-API assumption that motivated the file-based approach may be outdated. Despite these risks, the file-based approach is the only viable path for a published extension, and the fallback "no output" state handles the most common failure mode gracefully.

## Proposed Changes

### Approach: File-based output capture

**1. Modify the prompt** to instruct Claude to write findings to a file:

In `_buildMcpMonitorPrompt` (line 20571), modify the preamble at line 20586 to include the file-write instruction. **Note:** If Plan 2 has already shipped, append this to the clarified preamble; otherwise, integrate both changes in one edit.

**Research-confirmed wording** (web research found that Claude may output "All clear" inline without calling its file-write tool — the instruction must be explicit and mandatory):

```ts
const outputPath = path.join(this._resolveWorkspaceRoot() ?? '', '.switchboard', 'comms-monitor-latest.md');
const preamble = `Check the following for anything new that needs my attention ${boundary}. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything — EXCEPT you MUST call your filesystem write tool to save your findings (or "All clear" with the timestamp) to the file \`${outputPath}\` as markdown with a timestamp header and bullet points. Do not output your final analysis solely in natural language — always write it to that file.`;
```

**Important:** The `promptOverride` early-return at line 20573 bypasses this preamble entirely. If the user has a custom prompt, the file-write instruction is never included and output capture silently fails. Consider appending the file-write instruction AFTER the override check as a separate postscript, so it applies to all prompts. For example:

```ts
// After the promptOverride check and template construction:
if (prompt && outputPath) {
    prompt += `\n\nIMPORTANT: You MUST call your filesystem write tool to save your findings (or "All clear" with the timestamp) to the file \`${outputPath}\` as markdown with a timestamp header and bullet points. Do not output your final analysis solely in natural language — always write it to that file.`;
}
```

**Research note — Claude permission prompts:** If Claude Code is NOT spawned with `--dangerously-skip-permissions` (or `--permission-mode auto-accept`), it may halt mid-execution waiting for user confirmation before writing the file, causing the output capture to time out. The monitor terminal's startup command (verify in `getAgentStartupCommand('mcp_monitor')` and any custom override) should include one of these flags, OR the file-write instruction should be scoped to a tool the agent is pre-authorized to use. This is an implementation-time check — confirm the startup command grants auto-write permission before relying on file-based capture.

**2. Add output capture to `_mcpMonitorTick`** (line 20517):

After `sendRobustText` completes (line 20556), set up a **file watcher** (research-confirmed superior to a fixed 60s polling timer — the watcher fires the moment Claude writes the file, eliminating the timing gamble). Insert after the `sourceLastCheckAt` persistence block (line 20564):

```ts
if (prompt) {
    await sendRobustText(terminal, prompt, true);
    this._mcpMonitorLastSendAt = Date.now();
    // Persist sourceLastCheckAt for the sent sources only (successful send).
    const nowIso = new Date().toISOString();
    const updatedBaselines: Record<string, string> = {};
    for (const src of dueSources) {
        updatedBaselines[src] = nowIso;
    }
    await GlobalIntegrationConfigService.setMcpMonitorConfig({ sourceLastCheckAt: updatedBaselines });

    // Output capture: watch the results file rather than polling on a fixed timer.
    // Web research confirmed vscode.workspace.createFileSystemWatcher is stable and
    // fires the instant Claude writes the file — no 60s timing gamble. A fallback
    // timeout (90s) covers the case where Claude never writes (responds inline,
    // errors, or the terminal is closed mid-response). Research found typical
    // multi-source MCP response latency is 15-45s, so 90s is a generous upper bound.
    this._startMcpMonitorOutputCapture();
}
```

**2a. Add the output-capture orchestration method** (new method, insert near `_postMcpMonitorConfig` at line 20683):

```ts
private _startMcpMonitorOutputCapture(): void {
    // Tear down any previous capture cycle (watcher + fallback timer).
    this._disposeMcpMonitorOutputCapture();

    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) return;
    const outputPath = path.join(workspaceRoot, '.switchboard', 'comms-monitor-latest.md');
    const outputUri = vscode.Uri.file(outputPath);

    // Watcher fires the moment Claude writes/overwrites the results file.
    this._mcpMonitorOutputWatcher = vscode.workspace.createFileSystemWatcher(
        outputUri.fsPath, false, false, false
    );
    this._mcpMonitorOutputWatcher.onDidChange(() => this._captureMcpMonitorOutput());
    this._mcpMonitorOutputWatcher.onDidCreate(() => this._captureMcpMonitorOutput());

    // Fallback: if Claude never writes the file (inline "All clear", error, or
    // terminal closed), post a "no output" state after 90s so the UI isn't
    // stuck on a stale "(no results yet)" message indefinitely.
    this._mcpMonitorOutputFallbackTimer = setTimeout(async () => {
        await this._captureMcpMonitorOutput(); // reads stale-or-missing file
    }, 90 * 1000);
}
```

**3. Add the output capture method** (new method, insert near `_postMcpMonitorConfig` at line 20683):

The push pattern follows the verified `_postMcpMonitorConfig` pattern at lines 20695-20696: `this._view?.webview.postMessage(message)` + `this._kanbanProvider?.postMessage(message)`.

```ts
private async _captureMcpMonitorOutput(): Promise<void> {
    // Dispose the watcher + fallback timer once capture fires (watcher from
    // the onDidChange/onDidCreate callback, or from the fallback timeout).
    this._disposeMcpMonitorOutputCapture();

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

private _disposeMcpMonitorOutputCapture(): void {
    if (this._mcpMonitorOutputWatcher) {
        this._mcpMonitorOutputWatcher.dispose();
        this._mcpMonitorOutputWatcher = undefined;
    }
    if (this._mcpMonitorOutputFallbackTimer) {
        clearTimeout(this._mcpMonitorOutputFallbackTimer);
        this._mcpMonitorOutputFallbackTimer = undefined;
    }
}
```

**4. Add a results display area to the COMMS tab UI** in `createCommsPanel` (kanban.html line 8904):

Add a "Latest Results" section after the help text (after line 9262, before `container.appendChild(mcpConfigPanel)` at line 9264):

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

**5. Add a message handler** for `commsMonitorOutput` in the webview message switch (kanban.html, after the `updateMcpMonitorConfig` case at line 6888):

**Note on the interaction guard:** The `commsMonitorOutput` handler MUST use the same deferred-render pattern as the `updateMcpMonitorConfig` handler. Per the feature's shipping order, the **Stop Polling stuck-button fix (sibling plan)** ships FIRST and adds a `commsPanelRenderPending` flag to the codebase — by the time this plan is implemented, that flag exists. If this plan is implemented in isolation (before the stuck-button fix), fall back to the simple skip-render pattern shown in the original plan draft; otherwise use the pending-flag pattern below so output updates are not silently lost when they arrive during user interaction.

```js
case 'commsMonitorOutput': {
    window.__commsMonitorOutput = msg.output
        ? `[${new Date(msg.timestamp).toLocaleTimeString()}]\n${msg.output}`
        : `[${new Date(msg.timestamp).toLocaleTimeString()}] No output captured (Claude may have responded "All clear" or not yet finished).`;
    if (!isCommsPanelInteracting) {
        commsPanelRenderPending = false;
        renderCommsPanel();
    } else {
        // State updated but DOM is stale — defer render until guard expires
        // (same pattern as updateMcpMonitorConfig after the stuck-button fix).
        commsPanelRenderPending = true;
    }
    break;
}
```

**6. Clean up the output capture in `_stopMcpMonitorLoop`** (line 20492):

Add the new cleanup after the existing `_mcpMonitorConfigChangeTimer` block (line 20501-20504). Uses the `_disposeMcpMonitorOutputCapture` helper (disposes both the watcher and the fallback timer):

```ts
private _stopMcpMonitorLoop() {
    if (this._mcpMonitorTimer) { clearInterval(this._mcpMonitorTimer); this._mcpMonitorTimer = undefined; }
    if (this._mcpMonitorFirstPromptTimer) { clearTimeout(this._mcpMonitorFirstPromptTimer); this._mcpMonitorFirstPromptTimer = undefined; }
    if (this._mcpMonitorConfigChangeTimer) { clearTimeout(this._mcpMonitorConfigChangeTimer); this._mcpMonitorConfigChangeTimer = undefined; }
    this._disposeMcpMonitorOutputCapture(); // disposes watcher + fallback timer
}
```

**7. Add the capture fields** to the class, alongside the existing timer fields at lines 358-360:

```ts
private _mcpMonitorOutputWatcher?: vscode.FileSystemWatcher;
private _mcpMonitorOutputFallbackTimer?: NodeJS.Timeout;
```

## Verification Plan

**All steps are manual. No compilation or automated tests.**

1. Start the Comms Monitor terminal, check auth, start polling.
2. Wait for the first tick (should be ~2s after the start-polling fix is applied, or ~30s on current code).
3. The file watcher fires the moment Claude writes the results file (research-confirmed typical latency 15-45s for multi-source MCP checks). If Claude doesn't write within 90s, the fallback timer posts "No output captured." Verify the results appear promptly after Claude finishes, not after a fixed 60s wait.
4. Verify the "Latest Results" section in the COMMS tab shows Claude's findings (bullet list with timestamp).
5. If Claude responds "All clear", verify the results section shows "No output captured" or the "All clear" response.
6. Stop polling — verify the output timer is cancelled and no further output capture attempts are made.
7. Restart polling — verify the output capture cycle resumes.
8. Verify the output file (`.switchboard/comms-monitor-latest.md`) is overwritten on each tick, not appended to.
9. Verify the results display handles markdown-formatted content as plain text (bullet points, bold text shown as `**bold**` literals, not rendered).
10. Verify XSS safety — if Claude writes `<script>alert(1)</script>` or `<img onerror=alert(1)>` in the output, they should be displayed as text via `textContent`, not rendered as HTML.
11. Set a `promptOverride` in the COMMS config — verify that output capture still works (if the postscript approach is used) or gracefully shows "no output" (if the preamble-only approach is used).
12. Verify that `.switchboard/comms-monitor-latest.md` is in `.gitignore` (or add it) to prevent sensitive monitor output from being committed.

---

**Routing recommendation:** Complexity 7 → **Lead Coder**. The 60s-timing gamble, Claude file-write reliability, XSS surface, preamble conflict with Plan 2, and the `promptOverride` bypass all require careful judgment during implementation. A routine coder would likely miss the interaction-guard pattern or introduce an XSS hole via `innerHTML`.
