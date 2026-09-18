# Comms Monitor: Stop Polling Button Stuck — UI Never Updates After Stop

## Goal

The "Stop Polling" button in the COMMS tab does not properly stop polling from the user's perspective. After clicking it, the button stays stuck on "Stop Polling" (it should toggle back to "Start Polling"), and a "Stopping…" state appears and never clears. The user has no reliable way to stop polling via the UI.

### Problem Analysis & Root Cause

**Symptom 1 — "Stop Polling" button stays stuck:** The user clicks "Stop Polling". The button label does not change back to "Start Polling". The polling appears to continue (or at least the UI never reflects that polling has stopped).

**Symptom 2 — "Stopping…" state stuck:** A "Stopping…" text appears and never clears.

**Root cause investigation (confirmed by code reading):**

The "Stop Polling" button (`stopPollBtn`) in `src/webview/kanban.html` (line 9216) has a minimal click handler (line 9220):

```js
stopPollBtn.addEventListener('click', () => {
    postKanbanMessage({ type: 'stopMcpMonitorPolling' });
});
```

No visual feedback is provided — the button doesn't disable, doesn't change text, and doesn't show a "stopping" state. The UI update relies entirely on the backend sending an `updateMcpMonitorConfig` message with `isPolling: false`, which triggers `renderCommsPanel()` (line 9307) to re-render with `startPollBtn` instead of `stopPollBtn`.

The backend `stopMcpMonitorPolling()` in `src/services/TaskViewerProvider.ts` does the right thing:
1. Sets `pollingEnabled: false`
2. Calls `_stopMcpMonitorLoop()` (clears all timers)
3. Calls `_postMcpMonitorConfig()` (sends `isPolling: false` to webview)

**The problem is the interaction guard.** When the user clicks "Stop Polling", the button receives focus, triggering `guardCommsInteraction` (line 8886):

```js
const guardCommsInteraction = (el) => {
    const setInteracting = () => {
        isCommsPanelInteracting = true;
        if (commsPanelInteractionTimer) {
            clearTimeout(commsPanelInteractionTimer);
        }
        commsPanelInteractionTimer = setTimeout(() => {
            isCommsPanelInteracting = false;
            commsPanelInteractionTimer = null;
        }, 2000);
    };
    el.addEventListener('focus', setInteracting);
    el.addEventListener('change', setInteracting);
    el.addEventListener('input', setInteracting);
};
```

Note the guard duration is **2000 ms** (2 seconds), not 500 ms. The guard also fires on `change` and `input` events, not just `focus` — any keystroke in a guarded text field resets the timer.

The `updateMcpMonitorConfig` handler (line 6888) checks this guard:

```js
case 'updateMcpMonitorConfig': {
    mcpMonitorConfig = msg.config || mcpMonitorConfig;
    isMcpMonitorTerminalRunning = !!msg.isMonitorRunning;
    isMcpMonitorPolling = !!msg.isPolling;
    mcpMonitorPresets = msg.presets || mcpMonitorPresets;
    mcpMonitorResolvedCmd = msg.resolvedStartupCommand || '';
    if (!isCommsPanelInteracting) {
        renderCommsPanel();
    }
    break;
}
```

Additionally, `renderCommsPanel()` itself (line 9307) has a **second** guard check at line 9311:

```js
function renderCommsPanel() {
    try {
        const root = document.getElementById('comms-panel-root');
        if (!root) return;
        if (isCommsPanelInteracting) {
            console.log('[kanban] Skipping comms panel re-render: user interaction guard active');
            return;
        }
        root.innerHTML = '';
        root.appendChild(createCommsPanel());
    } catch (err) {
        console.error('[kanban webview] error rendering comms panel:', err);
    }
}
```

**If the `updateMcpMonitorConfig` message arrives within 2000 ms of the button click**, `isCommsPanelInteracting` is still `true`, and `renderCommsPanel()` is skipped. The state variables (`isMcpMonitorPolling`, etc.) ARE updated, but the DOM is not re-rendered. The button stays stuck on "Stop Polling" because the old DOM is still showing.

This is a race condition: if the backend responds quickly (config write + post is fast), the message arrives before the 2000 ms guard expires, and the re-render is suppressed. The state is correct in memory but the DOM is stale.

**Symptom 2 — "Stopping…" stuck:** The "Stop Monitor" button (`stopTermBtn`, line 9224) sets `stopTermBtn.textContent = 'Stopping…'` and `stopTermBtn.disabled = true` on click (line 9228). This text is only cleared by a panel re-render (the re-render creates fresh DOM elements). If the re-render is suppressed by the interaction guard, the "Stopping…" text persists indefinitely.

**Secondary issue:** Even when the guard expires (after 2000 ms), there is no mechanism to trigger a deferred re-render. The `updateMcpMonitorConfig` message was already processed (state updated, render skipped), and no further message is sent. The DOM remains stale until the next config change or panel interaction forces a re-render.

## Metadata

- **Tags:** bugfix, ui, ux
- **Complexity:** 4
- **Project:** switchboard
- **Files touched:** `src/webview/kanban.html`

## User Review Required

This plan modifies the interaction guard behavior in the COMMS panel. The guard exists to prevent re-renders from clobbering user input in text fields (e.g., custom instruction, source intervals). The fix adds a deferred-render mechanism that fires after the guard expires. Reviewers should confirm:

1. The deferred render does not clobber text-field input — it only fires 2 seconds after the last `focus`/`change`/`input` event, so the user is not actively typing when it triggers.
2. The `commsPanelRenderPending` flag correctly survives multiple config updates arriving while the guard is active (each update overwrites state, and the flag stays `true`; the deferred render uses the latest state).
3. The "Stop Polling" button's immediate visual feedback ("Stopping…" + disabled) is acceptable UX — the button is disabled for up to 2 seconds before the panel re-renders with "Start Polling".

## Complexity Audit

### Routine
- Add a deferred re-render flag (`commsPanelRenderPending`) and wire it into the guard timer callback and the `updateMcpMonitorConfig` handler.
- Add immediate visual feedback to the "Stop Polling" button (disabled state + "Stopping…" text change).

### Complex / Risky
- The interaction guard exists for a good reason (preventing re-renders from clobbering user input in text fields). The fix must not break that protection — it should only defer the render, not bypass the guard entirely. The deferred render fires only when `isCommsPanelInteracting` becomes `false` (guard timer expires), which is the same condition under which a normal render would proceed.
- The `renderCommsPanel()` function itself has a second guard check (line 9311). The deferred render call must execute after `isCommsPanelInteracting = false` is set in the timer callback, so the internal guard does not block it. The proposed code sets `isCommsPanelInteracting = false` before checking `commsPanelRenderPending`, so this is safe.
- Multiple `updateMcpMonitorConfig` messages may arrive while the guard is active. Each one updates state and sets `commsPanelRenderPending = true`. The flag is idempotent (setting it `true` again is a no-op). When the deferred render fires, it renders with the latest state — no updates are lost.

## Edge-Case & Dependency Audit

### Race Conditions
- **Core race:** `updateMcpMonitorConfig` arrives while `isCommsPanelInteracting === true`. State is updated but DOM is stale. **Fix:** Set `commsPanelRenderPending = true` when render is skipped; check it when the guard timer expires and call `renderCommsPanel()` if set.
- **Second config update while pending:** If another `updateMcpMonitorConfig` arrives while `commsPanelRenderPending` is already `true`, the state variables are updated to the latest values and the flag stays `true`. The deferred render will use the latest state — no render is lost.
- **Guard timer reset during pending render:** If the user interacts with another guarded element (e.g., clicks a text field) while a deferred render is pending, the guard timer is cleared and restarted. The deferred render will fire 2 seconds after the last interaction event, not the original button click. This is correct — the user is actively interacting, and the render should wait.
- **Can the deferred render be lost?** The only way the deferred render could be lost is if the guard timer is cleared without being replaced. But `guardCommsInteraction` always sets a new timer when clearing the old one (via `clearTimeout` + `setTimeout`). The timer always fires eventually unless the webview is destroyed, in which case nothing matters.

### Security
- No security implications. The fix is purely client-side UI state management. No user input is sent to the backend that wasn't already being sent.

### Side Effects
- The deferred render calls `renderCommsPanel()`, which does `root.innerHTML = ''; root.appendChild(createCommsPanel());`. This destroys and recreates all DOM elements in the COMMS panel. Any unsaved text-field input will be replaced with the backend's saved values. However, the guard ensures the user is not actively typing when the deferred render fires (2-second idle window), so this is safe.
- The "Stop Polling" button will show "Stopping…" and be disabled for up to 2 seconds (the guard duration). This is acceptable UX — the user sees immediate feedback that their click was received.

### Dependencies & Conflicts
- **Plan 5 (`comms-monitor-stop-polling-sends-clear`):** That plan restructures the button layout (renaming "Stop Monitor" to "Kill Terminal", moving it to a separate row). It explicitly depends on this plan: "Fixing Issue 3 is a prerequisite for this fix to be fully effective — the user needs to see that 'Stop Polling' worked." This plan must ship first so the "Stop Polling" button actually updates visually; otherwise the UX restructuring in Plan 5 cannot be properly verified.
- No other plans conflict with these changes. The deferred-render mechanism is additive and does not change the behavior of any other message handler or panel.

## Dependencies

- No external session dependencies. The fix is entirely in the webview JavaScript (`src/webview/kanban.html`).
- Plan 5 (`feature_plan_20260706092059_comms-monitor-stop-polling-sends-clear`) depends on THIS plan shipping first. Its button-layout restructuring assumes the "Stop Polling" button actually updates after clicking.

## Adversarial Synthesis

The deferred-render flag is a minimal, correct fix for the race condition, but it introduces a subtle temporal coupling: the render now depends on the guard timer firing. If the guard timer is ever cleared without replacement (e.g., by a future refactor that removes the `setTimeout` call), the deferred render is silently lost and the original bug resurfaces. The flag is also invisible to developers debugging the COMMS panel — there is no console log when a render is deferred, making it harder to diagnose why the DOM is stale. Adding a `console.log` when the render is deferred (matching the existing log in `renderCommsPanel` at line 9312) would improve debuggability. The 2-second guard duration means the user sees "Stopping…" for up to 2 seconds, which is noticeable but acceptable; a shorter guard would reduce the delay but increase the risk of clobbering text-field input.

## Proposed Changes

### `src/webview/kanban.html` — Deferred re-render when guard suppresses update

**1. Add a pending-render flag** (near line 6226, after `commsPanelInteractionTimer`):

```js
let isCommsPanelInteracting = false;
let commsPanelInteractionTimer = null;
let commsPanelRenderPending = false;
```

**2. Update the `guardCommsInteraction` function** (line 8886) to check the pending flag when the guard expires:

```js
const guardCommsInteraction = (el) => {
    const setInteracting = () => {
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
        }, 2000);
    };
    el.addEventListener('focus', setInteracting);
    el.addEventListener('change', setInteracting);
    el.addEventListener('input', setInteracting);
};
```

Note: The deferred render call executes after `isCommsPanelInteracting = false` is set, so the internal guard check in `renderCommsPanel()` (line 9311) will not block it.

**3. Update the `updateMcpMonitorConfig` handler** (line 6888) to set the pending flag when render is skipped:

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
        console.log('[kanban] Deferring comms panel re-render: user interaction guard active');
    }
    break;
}
```

The `console.log` matches the existing log in `renderCommsPanel()` (line 9312) and makes the deferred render visible during debugging.

**4. Add visual feedback to the "Stop Polling" button** (line 9220):

```js
stopPollBtn.addEventListener('click', () => {
    stopPollBtn.disabled = true;
    stopPollBtn.textContent = 'Stopping…';
    postKanbanMessage({ type: 'stopMcpMonitorPolling' });
});
```

This gives immediate visual feedback. The button text and disabled state are reset when the panel re-renders (the re-render creates a fresh `startPollBtn` or `stopPollBtn`). The deferred render ensures the re-render happens within ~2 seconds of the click.

## Verification Plan

1. Start the Comms Monitor terminal, check auth, and start polling.
2. Click "Stop Polling" — verify the button immediately shows "Stopping…" and disables.
3. Within ~2 seconds (the guard duration), verify the panel re-renders and the button switches to "Start Polling" (enabled).
4. **Before fix:** The button stays stuck on "Stop Polling" and never updates (the `updateMcpMonitorConfig` message arrives while the guard is active, and no deferred render exists).
5. Click "Start Polling" again, then immediately click "Stop Polling" — verify the cycle works repeatedly.
6. Type in a config text field (e.g., custom instruction), then while still focused, have the backend send a config update (e.g., by changing a source interval in another panel) — verify the text field is NOT clobbered while typing, and the deferred render fires 2 seconds after the last keystroke.
7. Click "Stop Monitor" — verify "Stopping…" appears and then the panel re-renders (within ~2 seconds) to show only "Start Terminal" (no monitor running).
8. Open the browser DevTools console — verify the `[kanban] Deferring comms panel re-render` log appears when a render is deferred, and no log appears when the render proceeds immediately.

Routing recommendation: **4 — Coder**. The fix is a straightforward flag + timer callback addition with one subtle ordering requirement (set `isCommsPanelInteracting = false` before checking the flag). No architectural changes, no backend modifications, but the race-condition reasoning requires careful review.
