# Comms Monitor: Stop Polling Kills the Terminal Instead of Just Stopping Polling

## Goal

When the user clicks "Stop Polling" in the COMMS tab, the monitor terminal is killed immediately. The user does not always want the terminal killed — "Stop Polling" should only stop the polling loop and leave the terminal alive. Killing the terminal is the job of the separate "Stop Monitor" button. The user just wants polling to stop while keeping the terminal (and Claude's session) alive so they can resume polling later without re-launching.

### Problem Analysis & Root Cause

**Symptom:** User clicks "Stop Polling" in the COMMS tab. The monitor terminal is killed immediately (disposed/closed). The user expected only the polling loop to stop, with the terminal remaining alive.

**Root cause investigation (confirmed by code reading):**

The backend wiring is actually correct — `stopMcpMonitorPolling()` in `src/services/TaskViewerProvider.ts` does NOT kill the terminal:

```ts
public async stopMcpMonitorPolling(): Promise<void> {
    await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: false });
    this._stopMcpMonitorLoop();
    await this._postMcpMonitorConfig();
}
```

Only `stopMcpMonitorTerminal()` disposes the terminal:

```ts
public async stopMcpMonitorTerminal(): Promise<void> {
    // ...
    if (live) {
        live.dispose();
    }
    // ...
}
```

The webview button wiring is also correct (verified against `src/webview/kanban.html`):
- `stopPollBtn` ("Stop Polling") → `stopMcpMonitorPolling` message → `switchboard.stopMcpMonitorPolling` command (line 9221)
- `stopTermBtn` ("Stop Monitor") → `stopMcpMonitorTerminal` message → `switchboard.stopMcpMonitorTerminal` command (line 9231)

**So why does the user see the terminal killed?** The UI renders BOTH buttons simultaneously when polling is active (lines 9235–9245):

```js
lifecycleRow.appendChild(startTermBtn);                          // line 9235
if (isMcpMonitorTerminalRunning) {                               // line 9236
    lifecycleRow.appendChild(checkAuthBtn);                       // line 9237
    if (isMcpMonitorPolling) {                                   // line 9238
        lifecycleRow.appendChild(stopPollBtn);                    // line 9239 — gray "Stop Polling"
    } else {
        lifecycleRow.appendChild(startPollBtn);                   // line 9241
    }
    lifecycleRow.appendChild(stopTermBtn);                        // line 9243 — red "Stop Monitor"
}
```

When polling is active, the user sees four buttons in a row: **Start Terminal | Check Auth | Stop Polling | Stop Monitor**. The "Stop Monitor" button is red (`--accent-red`, line 9226) and visually more prominent than the gray "Stop Polling" button (line 9218). The user is likely clicking "Stop Monitor" (the red button) thinking it stops polling — but it actually kills the terminal.

**Contributing factor — Issue 3 (stuck button):** If the "Stop Polling" button appears to not work (due to the interaction-guard race described in the Issue 3 plan), the user may click the more prominent red "Stop Monitor" button as a fallback, which does kill the terminal.

**The core UX problem:** The two stop buttons are visually adjacent, both labeled with "Stop", and the destructive one (kill terminal) is more visually prominent (red) than the benign one (stop polling, gray). The user's mental model is "I want to stop the monitoring" → clicks the red "Stop" button → terminal is killed.

## Metadata

- **Tags:** bugfix, ux
- **Complexity:** 3
- **Project:** switchboard
- **Files touched:** `src/webview/kanban.html`

## User Review Required

**Decision needed before coding:** The relabel from "Stop Monitor" to "Kill Terminal" is intentionally aggressive language to signal destructiveness. Review whether this wording is appropriate for the target user base, or whether a softer alternative like "End Terminal" or "Shut Down Terminal" is preferred. Additionally, confirm that moving the destructive action to a separate row below a divider is acceptable — this reduces discoverability of the kill action (which is the point), but users who legitimately want to stop everything may not immediately see the button. If the separate-row approach is rejected, an alternative is to keep both buttons on the same row but swap the visual prominence: make "Stop Polling" the more prominent teal button and "Kill Terminal" the subdued red-outline button.

## Complexity Audit

### Routine
- Restructuring the button layout to visually separate "Stop Polling" from "Kill Terminal" — pure DOM restructuring in `kanban.html` (lines 9224–9245).
- Renaming/relabeling `stopTermBtn.textContent` from "Stop Monitor" to "Kill Terminal" (line 9225) and the in-progress state from "Stopping…" to "Killing…" (line 9230).
- Changing `stopTermBtn` style from red fill to red outline on gray background (line 9226) — the CSS variables `--panel-bg2`, `--accent-red`, and `--border-color` are all confirmed to exist in the stylesheet (lines 19, 20, 29).
- Adding `title` tooltip attributes to `stopPollBtn` and `stopTermBtn`.
- Pure UI/CSS change in `kanban.html` — no backend wiring changes. The `stopMcpMonitorTerminal` message on line 9231 stays unchanged.

### Complex / Risky
- None. No backend changes needed — the wiring is correct, the problem is UX clarity.

## Edge-Case & Dependency Audit

### Race Conditions
- **Interaction guard vs. re-render:** The `guardCommsInteraction` wrapper on both buttons (lines 9219, 9227) prevents re-renders during click handling. Moving `stopTermBtn` to a separate row does not change this guard behavior. No new race condition is introduced.
- **Rapid double-click on "Kill Terminal":** The button already disables itself and changes text to "Killing…" on click (lines 9229–9230), preventing double-fire. This behavior is preserved unchanged.

### Security
- No security implications. Both buttons send pre-existing message types to the extension host. No user input is accepted; no new message types are introduced.

### Side Effects
- **Visual regression risk:** The separate-row layout adds a new `terminalControlRow` div between the lifecycle buttons and the existing status line (line 9247). The dashed border-top style reuses the same pattern as the status line divider (line 9249: `border-top:1px dashed var(--border-color)`), so visual consistency is maintained.
- **Discoverability reduction:** Moving "Kill Terminal" to a separate row makes it less immediately visible. This is intentional (reduce accidental destructive clicks) but could frustrate users who want to kill the terminal and don't see the button at first glance. The red outline + tooltip mitigate this partially.

### Dependencies & Conflicts
- **Sibling plan — Stop Polling stuck-button fix (Plan 3):** If the "Stop Polling" button doesn't visually update after clicking (interaction-guard race), the user can't tell polling stopped and may click "Kill Terminal" as a fallback. Fixing the stuck-button issue is a soft prerequisite for this fix to be fully effective — the user needs to see that "Stop Polling" worked before they'll trust it over the more visible destructive option.
- No backend dependencies — the `stopMcpMonitorPolling` / `stopMcpMonitorTerminal` split is already correct.
- No conflicts with other in-flight plans — this plan only modifies the COMMS panel button layout in `kanban.html`.

## Dependencies

- Soft prerequisite: the Stop Polling stuck-button fix (sibling plan) should ship first so users can see Stop Polling worked. Without that fix, users may still reach for "Kill Terminal" as a fallback even after this UX improvement, because "Stop Polling" appears unresponsive.
- No external dependencies.

## Adversarial Synthesis

**Risk Summary:** The plan correctly identifies that the destructive action is too visually prominent and too semantically ambiguous ("Stop Monitor" vs "Stop Polling"). However, the cure may overshoot: "Kill Terminal" is aggressive language that could alarm casual users, and moving the button to a separate row reduces discoverability for users who legitimately want to shut everything down. The red-outline restyle is a sound middle ground — it signals danger without screaming — but the label and layout changes together may make the terminal-killing path feel hidden rather than just de-prioritized. A user who wants to stop everything may scan the first row, see no obvious "stop everything" button, and feel lost.

## Proposed Changes

### `src/webview/kanban.html` — Restructure stop controls for clarity

**1. Visually separate "Stop Polling" from "Kill Terminal":**

Move "Kill Terminal" (formerly "Stop Monitor") to a separate row with a visual divider, so it's clearly a different action from "Stop Polling". The current code at lines 9183–9245 creates `lifecycleRow` (line 9183) and appends all buttons to it, including `stopTermBtn` at line 9243. The change extracts `stopTermBtn` into its own row:

```js
// ─── Lifecycle controls (three-step launch + stop) ───
// line 9183: lifecycleRow already exists
const lifecycleRow = document.createElement('div');
lifecycleRow.style.cssText = 'margin-top:8px; display:flex; flex-wrap:wrap; gap:6px;';  // line 9184
const btnBaseStyle = 'padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; border:none; border-radius:3px;';  // line 9185

// ... startTermBtn (line 9186), checkAuthBtn (line 9194), startPollBtn (line 9208), stopPollBtn (line 9216) unchanged ...

// Move "Stop Monitor" to a separate row with a divider
const terminalControlRow = document.createElement('div');
terminalControlRow.style.cssText = 'margin-top:6px; padding-top:6px; border-top:1px dashed var(--border-color); display:flex; gap:6px;';

// line 9224: stopTermBtn — relabel and restyle
const stopTermBtn = document.createElement('button');
stopTermBtn.textContent = 'Kill Terminal';   // was "Stop Monitor" (line 9225)
stopTermBtn.style.cssText = btnBaseStyle + ' background:var(--panel-bg2); border:1px solid var(--accent-red, #c0392b); color:var(--accent-red, #c0392b);';  // was red fill (line 9226)
guardCommsInteraction(stopTermBtn);
stopTermBtn.addEventListener('click', () => {
    stopTermBtn.disabled = true;
    stopTermBtn.textContent = 'Killing…';   // was "Stopping…" (line 9230)
    postKanbanMessage({ type: 'stopMcpMonitorTerminal' });  // unchanged (line 9231)
});

// Show controls conditionally — remove stopTermBtn from lifecycleRow
lifecycleRow.appendChild(startTermBtn);                          // line 9235
if (isMcpMonitorTerminalRunning) {                               // line 9236
    lifecycleRow.appendChild(checkAuthBtn);                       // line 9237
    if (isMcpMonitorPolling) {                                   // line 9238
        lifecycleRow.appendChild(stopPollBtn);                    // line 9239
    } else {
        lifecycleRow.appendChild(startPollBtn);                   // line 9241
    }
    // REMOVED: lifecycleRow.appendChild(stopTermBtn);           // was line 9243
}
mcpConfigPanel.appendChild(lifecycleRow);                        // line 9245

// Terminal kill control on a separate row
if (isMcpMonitorTerminalRunning) {
    terminalControlRow.appendChild(stopTermBtn);
    mcpConfigPanel.appendChild(terminalControlRow);
}
```

Key changes:
- **"Stop Monitor" → "Kill Terminal"** (line 9225): More explicit label — the user knows this destroys the terminal.
- **Separate row with divider**: Visually separates the polling controls from the terminal-killing control. The dashed border-top reuses the same `var(--border-color)` pattern as the status line divider at line 9249.
- **Red outline instead of red fill** (line 9226): Less visually prominent — the destructive action shouldn't be the most eye-catching button. Red outline on `var(--panel-bg2)` background signals "danger" without drawing the eye as much as a solid `var(--accent-red)` fill. All three CSS variables are confirmed to exist in the stylesheet (`--panel-bg2`: line 19, `--border-color`: line 20, `--accent-red`: line 29).
- **"Stopping…" → "Killing…"** (line 9230): More accurate label for the in-progress state.
- **No backend wiring change**: The `stopMcpMonitorTerminal` message type on line 9231 stays unchanged.

**2. Add a tooltip to "Stop Polling" for clarity:**

```js
// After stopPollBtn creation (line 9216–9222)
stopPollBtn.title = 'Stop the polling loop. The terminal stays alive — you can restart polling later without re-launching.';
```

**3. Add a tooltip to "Kill Terminal" for clarity:**

```js
// After stopTermBtn creation (line 9224–9232)
stopTermBtn.title = 'Kill the monitor terminal and stop polling. Claude\'s session will be lost.';
```

## Verification Plan

**Manual steps only — no compilation or automated tests required.**

1. Open the Switchboard extension in VS Code. Navigate to the COMMS tab.
2. Start the Comms Monitor terminal, check auth, start polling.
3. Verify the button layout: "Start Terminal | Check Auth | Stop Polling" on the main row, "Kill Terminal" on a separate row below a dashed divider.
4. Click "Stop Polling" — verify the terminal stays alive, polling stops, and the button switches to "Start Polling".
5. Click "Start Polling" again — verify polling resumes without needing to re-launch the terminal.
6. Click "Kill Terminal" — verify the terminal is disposed and the UI updates to show "Start Terminal" only.
7. Verify the "Kill Terminal" button is less visually prominent than before (red outline on gray background vs. the previous solid red fill) while still clearly signaling a destructive action.
8. Hover over "Stop Polling" — verify the tooltip appears: "Stop the polling loop. The terminal stays alive — you can restart polling later without re-launching."
9. Hover over "Kill Terminal" — verify the tooltip appears: "Kill the monitor terminal and stop polling. Claude's session will be lost."
10. Verify the dashed divider line between the polling controls row and the "Kill Terminal" row matches the visual style of the existing status line divider below it.

---

**Routing recommendation:** Complexity 3 → **1–3 Intern**. This is a pure UI restructuring with no backend changes, no new message types, and no migration concerns. The changes are confined to a single file (`kanban.html`) and involve only DOM restructuring, CSS restyling, and label/tooltip additions.
