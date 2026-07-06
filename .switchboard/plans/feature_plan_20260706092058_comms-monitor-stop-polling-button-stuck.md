# Comms Monitor: Stop Polling Button Stuck — UI Never Updates After Stop

## Goal

The "Stop Polling" button in the COMMS tab does not properly stop polling from the user's perspective. After clicking it, the button stays stuck on "Stop Polling" (it should toggle back to "Start Polling"), and a "Stopping…" state appears and never clears. The user has no reliable way to stop polling via the UI.

### Problem Analysis & Root Cause

**Symptom 1 — "Stop Polling" button stays stuck:** The user clicks "Stop Polling". The button label does not change back to "Start Polling". The polling appears to continue (or at least the UI never reflects that polling has stopped).

**Symptom 2 — "Stopping…" state stuck:** A "Stopping…" text appears and never clears.

**Root cause investigation (confirmed by code reading):**

The "Stop Polling" button (`stopPollBtn`) in `src/webview/kanban.html` (line ~9237) has a minimal click handler:

```js
stopPollBtn.addEventListener('click', () => {
    postKanbanMessage({ type: 'stopMcpMonitorPolling' });
});
```

No visual feedback is provided — the button doesn't disable, doesn't change text, and doesn't show a "stopping" state. The UI update relies entirely on the backend sending an `updateMcpMonitorConfig` message with `isPolling: false`, which triggers `renderCommsPanel()` to re-render with `startPollBtn` instead of `stopPollBtn`.

The backend `stopMcpMonitorPolling()` in `src/services/TaskViewerProvider.ts` (line ~20821) does the right thing:
1. Sets `pollingEnabled: false`
2. Calls `_stopMcpMonitorLoop()` (clears all timers)
3. Calls `_postMcpMonitorConfig()` (sends `isPolling: false` to webview)

**The problem is the interaction guard.** When the user clicks "Stop Polling", the button receives focus, triggering `guardCommsInteraction` (line ~8877):

```js
const guardCommsInteraction = (el) => {
    el.addEventListener('focus', () => {
        isCommsPanelInteracting = true;
        if (commsPanelInteractionTimer) {
            clearTimeout(commsPanelInteractionTimer);
        }
        commsPanelInteractionTimer = setTimeout(() => {
            isCommsPanelInteracting = false;
            commsPanelInteractionTimer = null;
        }, 500);
    });
};
```

The `updateMcpMonitorConfig` handler (line ~6879) checks this guard:

```js
case 'updateMcpMonitorConfig': {
    mcpMonitorConfig = msg.config || mcpMonitorConfig;
    isMcpMonitorTerminalRunning = !!msg.isMonitorRunning;
    isMcpMonitorPolling = !!msg.isPolling;
    // ...
    if (!isCommsPanelInteracting) {
        renderCommsPanel();
    }
```

**If the `updateMcpMonitorConfig` message arrives within 500ms of the button click**, `isCommsPanelInteracting` is still `true`, and `renderCommsPanel()` is skipped. The state variables (`isMcpMonitorPolling`, etc.) ARE updated, but the DOM is not re-rendered. The button stays stuck on "Stop Polling" because the old DOM is still showing.

This is a race condition: if the backend responds quickly (config write + post is fast), the message arrives before the 500ms guard expires, and the re-render is suppressed. The state is correct in memory but the DOM is stale.

**Symptom 2 — "Stopping…" stuck:** The "Stop Monitor" button (`stopTermBtn`, line ~9245) sets `stopTermBtn.textContent = 'Stopping…'` and `stopTermBtn.disabled = true` on click. This text is only cleared by a panel re-render. If the re-render is suppressed by the interaction guard, the "Stopping…" text persists indefinitely.

**Secondary issue:** Even when the guard expires (after 500ms), there is no mechanism to trigger a deferred re-render. The `updateMcpMonitorConfig` message was already processed (state updated, render skipped), and no further message is sent. The DOM remains stale until the next config change or panel interaction forces a re-render.

## Metadata

- **Tags:** bugfix, ui, ux, comms-monitor, polling, race-condition
- **Complexity:** 4
- **Project:** switchboard
- **Repo:** (root — single-repo extension)
- **Files touched:** `src/webview/kanban.html`

## Complexity Audit

### Routine
- Add a deferred re-render when the interaction guard suppresses an update.
- Add visual feedback to the "Stop Polling" button (disabled state + text change).

### Complex / Risky
- The interaction guard exists for a good reason (preventing re-renders from clobbering user input in text fields). The fix must not break that protection — it should only defer the render, not bypass the guard entirely.

## Edge-Case & Dependency Audit

### Race Conditions
- The core race: `updateMcpMonitorConfig` arrives while `isCommsPanelInteracting === true`. State is updated but DOM is stale.
- **Fix approach:** When the render is skipped due to the guard, set a flag (`commsPanelRenderPending = true`). When the guard timer expires, check the flag and trigger a re-render if needed.

### Edge Cases
- User clicks "Stop Polling" then immediately types in a config field — the deferred render should not clobber the typing. Solution: the deferred render only fires if no new interaction has occurred since the guard expired.
- User clicks "Stop Polling" multiple times rapidly — each click sends a `stopMcpMonitorPolling` message, but the backend is idempotent (setting `pollingEnabled: false` twice is harmless).

### Dependencies
- None external. The fix is entirely in the webview JavaScript.

## Proposed Changes

### `src/webview/kanban.html` — Deferred re-render when guard suppresses update

**1. Add a pending-render flag** (near line ~6216, where `isCommsPanelInteracting` is declared):

```js
let isCommsPanelInteracting = false;
let commsPanelInteractionTimer = null;
let commsPanelRenderPending = false;
```

**2. Update the `guardCommsInteraction` function** (line ~8877) to check the pending flag when the guard expires:

```js
const guardCommsInteraction = (el) => {
    el.addEventListener('focus', () => {
        isCommsPanelInteracting = true;
        if (commsPanelInteractionTimer) {
            clearTimeout(commsPanelInteractionTimer);
        }
        commsPanelInteractionTimer = setTimeout(() => {
            isCommsPanelInteracting = false;
            commsPanelInteractionTimer = null;
            // If a config update was suppressed while the guard was active,
            // re-render now so the DOM reflects the current state.
            if (commsPanelRenderPending) {
                commsPanelRenderPending = false;
                renderCommsPanel();
            }
        }, 500);
    });
};
```

**3. Update the `updateMcpMonitorConfig` handler** (line ~6879) to set the pending flag when render is skipped:

```js
case 'updateMcpMonitorConfig': {
    mcpMonitorConfig = msg.config || mcpMonitorConfig;
    isMcpMonitorTerminalRunning = !!msg.isMonitorRunning;
    isMcpMonitorPolling = !!msg.isPolling;
    mcpMonitorPresets = msg.presets || mcpMonitorPresets;
    mcpMonitorResolvedCmd = msg.resolvedStartupCommand || '';
    if (!isCommsPanelInteracting) {
        commsPanelRenderPending = false;
        renderCommsPanel();
    } else {
        // State updated but DOM is stale — defer render until guard expires.
        commsPanelRenderPending = true;
    }
    break;
}
```

**4. Add visual feedback to the "Stop Polling" button** (line ~9237):

```js
stopPollBtn.addEventListener('click', () => {
    stopPollBtn.disabled = true;
    stopPollBtn.textContent = 'Stopping…';
    postKanbanMessage({ type: 'stopMcpMonitorPolling' });
});
```

This gives immediate visual feedback. The button text and disabled state are reset when the panel re-renders (the re-render creates a fresh `startPollBtn` or `stopPollBtn`).

## Verification Plan

1. Start the Comms Monitor terminal, check auth, and start polling.
2. Click "Stop Polling" — verify the button immediately shows "Stopping…" and disables.
3. Within ~1 second, verify the panel re-renders and the button switches to "Start Polling" (enabled).
4. **Before fix:** The button stays stuck on "Stop Polling" and never updates.
5. Click "Start Polling" again, then immediately click "Stop Polling" — verify the cycle works repeatedly.
6. Type in a config text field (e.g., custom instruction), then while still focused, have the backend send a config update (e.g., by changing a source interval in another panel) — verify the text field is NOT clobbered and the deferred render fires after focus is lost.
7. Click "Stop Monitor" — verify "Stopping…" appears and then the panel re-renders to show only "Start Terminal" (no monitor running).
