# Comms Monitor: Stop Polling Kills the Terminal Instead of Just Stopping Polling

## Goal

When the user clicks "Stop Polling" in the COMMS tab, the monitor terminal is killed immediately. The user does not always want the terminal killed — "Stop Polling" should only stop the polling loop and leave the terminal alive. Killing the terminal is the job of the separate "Stop Monitor" button. The user just wants polling to stop while keeping the terminal (and Claude's session) alive so they can resume polling later without re-launching.

### Problem Analysis & Root Cause

**Symptom:** User clicks "Stop Polling" in the COMMS tab. The monitor terminal is killed immediately (disposed/closed). The user expected only the polling loop to stop, with the terminal remaining alive.

**Root cause investigation (confirmed by code reading):**

The backend wiring is actually correct — `stopMcpMonitorPolling()` in `src/services/TaskViewerProvider.ts` (line ~20821) does NOT kill the terminal:

```ts
public async stopMcpMonitorPolling(): Promise<void> {
    await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: false });
    this._stopMcpMonitorLoop();
    await this._postMcpMonitorConfig();
}
```

Only `stopMcpMonitorTerminal()` (line ~20832) disposes the terminal:

```ts
public async stopMcpMonitorTerminal(): Promise<void> {
    // ...
    if (live) {
        live.dispose();
    }
    // ...
}
```

The webview button wiring is also correct:
- `stopPollBtn` ("Stop Polling") → `stopMcpMonitorPolling` message → `switchboard.stopMcpMonitorPolling` command (line ~9241)
- `stopTermBtn` ("Stop Monitor") → `stopMcpMonitorTerminal` message → `switchboard.stopMcpMonitorTerminal` command (line ~9252)

**So why does the user see the terminal killed?** The UI renders BOTH buttons simultaneously when polling is active (line ~9256–9265):

```js
lifecycleRow.appendChild(startTermBtn);
if (isMcpMonitorTerminalRunning) {
    lifecycleRow.appendChild(checkAuthBtn);
    if (isMcpMonitorPolling) {
        lifecycleRow.appendChild(stopPollBtn);       // gray "Stop Polling"
    } else {
        lifecycleRow.appendChild(startPollBtn);
    }
    lifecycleRow.appendChild(stopTermBtn);            // red "Stop Monitor"
}
```

When polling is active, the user sees four buttons in a row: **Start Terminal | Check Auth | Stop Polling | Stop Monitor**. The "Stop Monitor" button is red (`--accent-red`) and visually more prominent than the gray "Stop Polling" button. The user is likely clicking "Stop Monitor" (the red button) thinking it stops polling — but it actually kills the terminal.

**Contributing factor — Issue 3 (stuck button):** If the "Stop Polling" button appears to not work (due to the interaction-guard race described in the Issue 3 plan), the user may click the more prominent red "Stop Monitor" button as a fallback, which does kill the terminal.

**The core UX problem:** The two stop buttons are visually adjacent, both labeled with "Stop", and the destructive one (kill terminal) is more visually prominent (red) than the benign one (stop polling, gray). The user's mental model is "I want to stop the monitoring" → clicks the red "Stop" button → terminal is killed.

## Metadata

- **Tags:** bugfix, ux, comms-monitor, terminal, polling
- **Complexity:** 3
- **Project:** switchboard
- **Repo:** (root — single-repo extension)
- **Files touched:** `src/webview/kanban.html`

## Complexity Audit

### Routine
- Restructuring the button layout to visually separate "Stop Polling" from "Stop Monitor".
- Renaming/relabeling buttons for clarity.
- Pure UI/CSS change in `kanban.html`.

### Complex / Risky
- None. No backend changes needed — the wiring is correct, the problem is UX clarity.

## Edge-Case & Dependency Audit

### Edge Cases
- User wants to both stop polling AND kill the terminal — the "Stop Monitor" button should still be available, just visually separated or less prominent.
- User stops polling, then wants to restart polling without re-launching the terminal — this should work (terminal is still alive, just click "Start Polling").

### Dependencies
- **Issue 3 (stuck button):** If the "Stop Polling" button doesn't visually update after clicking (interaction-guard race), the user can't tell polling stopped and may click "Stop Monitor" as a fallback. Fixing Issue 3 is a prerequisite for this fix to be fully effective — the user needs to see that "Stop Polling" worked.
- No backend dependencies — the `stopMcpMonitorPolling` / `stopMcpMonitorTerminal` split is already correct.

## Proposed Changes

### `src/webview/kanban.html` — Restructure stop controls for clarity

**1. Visually separate "Stop Polling" from "Stop Monitor":**

Move "Stop Monitor" to a separate row with a visual divider, so it's clearly a different action from "Stop Polling":

```js
// ─── Lifecycle controls (three-step launch + stop) ───
const lifecycleRow = document.createElement('div');
lifecycleRow.style.cssText = 'margin-top:8px; display:flex; flex-wrap:wrap; gap:6px;';
const btnBaseStyle = 'padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; border:none; border-radius:3px;';

// ... startTermBtn, checkAuthBtn, startPollBtn, stopPollBtn unchanged ...

// Move "Stop Monitor" to a separate row with a divider
const terminalControlRow = document.createElement('div');
terminalControlRow.style.cssText = 'margin-top:6px; padding-top:6px; border-top:1px dashed var(--border-color); display:flex; gap:6px;';

const stopTermBtn = document.createElement('button');
stopTermBtn.textContent = 'Kill Terminal';
stopTermBtn.style.cssText = btnBaseStyle + ' background:var(--panel-bg2); border:1px solid var(--accent-red, #c0392b); color:var(--accent-red, #c0392b);';
guardCommsInteraction(stopTermBtn);
stopTermBtn.addEventListener('click', () => {
    stopTermBtn.disabled = true;
    stopTermBtn.textContent = 'Killing…';
    postKanbanMessage({ type: 'stopMcpMonitorTerminal' });
});

// Show controls conditionally
lifecycleRow.appendChild(startTermBtn);
if (isMcpMonitorTerminalRunning) {
    lifecycleRow.appendChild(checkAuthBtn);
    if (isMcpMonitorPolling) {
        lifecycleRow.appendChild(stopPollBtn);
    } else {
        lifecycleRow.appendChild(startPollBtn);
    }
}
mcpConfigPanel.appendChild(lifecycleRow);

// Terminal kill control on a separate row
if (isMcpMonitorTerminalRunning) {
    terminalControlRow.appendChild(stopTermBtn);
    mcpConfigPanel.appendChild(terminalControlRow);
}
```

Key changes:
- **"Stop Monitor" → "Kill Terminal"**: More explicit label — the user knows this destroys the terminal.
- **Separate row with divider**: Visually separates the polling controls from the terminal-killing control.
- **Red outline instead of red fill**: Less visually prominent — the destructive action shouldn't be the most eye-catching button. Red outline on gray background signals "danger" without drawing the eye as much as a solid red fill.
- **"Stopping…" → "Killing…"**: More accurate label for the in-progress state.

**2. Add a tooltip to "Stop Polling" for clarity:**

```js
stopPollBtn.title = 'Stop the polling loop. The terminal stays alive — you can restart polling later without re-launching.';
```

**3. Add a tooltip to "Kill Terminal" for clarity:**

```js
stopTermBtn.title = 'Kill the monitor terminal and stop polling. Claude\'s session will be lost.';
```

## Verification Plan

1. Start the Comms Monitor terminal, check auth, start polling.
2. Verify the button layout: "Start Terminal | Check Auth | Stop Polling" on the main row, "Kill Terminal" on a separate row below a divider.
3. Click "Stop Polling" — verify the terminal stays alive, polling stops, and the button switches to "Start Polling".
4. Click "Start Polling" again — verify polling resumes without needing to re-launch the terminal.
5. Click "Kill Terminal" — verify the terminal is disposed and the UI updates to show "Start Terminal" only.
6. Verify the "Kill Terminal" button is less visually prominent than before (red outline vs red fill) while still clearly signaling a destructive action.
7. Verify tooltips appear on hover for both "Stop Polling" and "Kill Terminal".
