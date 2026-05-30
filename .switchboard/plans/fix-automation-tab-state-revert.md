# Fix Automation Tab State Revert Bug

## Goal

Replace the focus/blur interaction guard in `kanban.html`'s automation panel with a timeout-based debounce so that user changes to dropdown and number-input controls are not lost when `terminalStatuses` backend messages arrive mid-interaction.

## Metadata

- **Tags:** frontend, bugfix, reliability, UI, UX
- **Complexity:** 3

## User Review Required

No breaking changes. All changes are isolated to client-side JavaScript inside `src/webview/kanban.html`. The guard logic is already behind a feature flag (`isAutobanPanelInteracting`), so no new interface contracts are introduced.

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html`)
- Three small, co-located edits within the same closure (~6120–6770 lines)
- No new state variables exposed outside the closure
- Timeout API is already used extensively elsewhere in the file
- No backend changes required

### Complex / Risky
- The `maxSendsInput` change handler at line 6536 manually resets `isAutobanPanelInteracting = false` and calls `renderAutobanPanel()` immediately; this must be updated to respect the timeout or it will race against the debounce guard (see Proposed Changes, Change 4)

## Edge-Case & Dependency Audit

**Race Conditions**
- The original bug is a race between the `change` event and the `terminalStatuses` message — the fix closes it by extending the guard window past `blur`.
- After the fix, `maxSendsInput`'s manual `isAutobanPanelInteracting = false` (line 6536) could race against the timer: another dropdown's guard could be cleared before its 2-second window expires. Fix: remove the manual reset and rely on the timer; remove the immediate `renderAutobanPanel()` call from that handler as well, since the panel will re-render naturally on the next `terminalStatuses` message once the timer clears.
- Rapid sequential interactions (user opens dropdown A, closes it, opens dropdown B) — each interaction resets the same timer, so the guard stays active continuously. This is correct behavior.

**Security**
- None. All changes are in a sandboxed webview with no new message channels.

**Side Effects**
- During the 2-second guard window, `terminalStatuses` updates to the terminal pool chips (alive/dead indicators, send counts) will not be displayed until the guard clears. This is a known, acceptable trade-off noted in the original plan. The window is reduced from the plan's proposed 5 seconds to 2 seconds to minimize staleness.

**Dependencies & Conflicts**
- `guardInteraction` is called for: `agentSelect`, `columnSelect`, `intervalSelect`, `batchSelect`, `complexitySelect`, `routingSelect`, `maxSendsInput`, and per-rule selects (added dynamically in the column rules section). The change is applied once inside `guardInteraction`; all callers benefit automatically.
- The `blur` event handler currently registered inside `guardInteraction` is vestigial — it does `isAutobanPanelInteracting = false` which the timeout already handles. It must be removed to avoid clearing the guard early.
- Per-rule selects inside `createAutobanPanel` also call `guardInteraction` (via the column rules section). These are covered automatically since they use the same shared function.

## Dependencies

- None. No prior sessions required.

## Adversarial Synthesis

Key risks: (1) The `maxSendsInput` handler manually resets `isAutobanPanelInteracting = false` and calls `renderAutobanPanel()` — if left unchanged, it will defeat the debounce for concurrent interactions on other controls. (2) The vestigial `blur` handler sets `isAutobanPanelInteracting = false` immediately, undoing the timeout before it fires. Mitigations: Remove both the manual flag reset at line 6536 and the `blur` listener from `guardInteraction`; reduce the timeout from 5 s to 2 s to limit terminal-status staleness.

## Proposed Changes

### `src/webview/kanban.html`

#### Change 1 — Add debounce timer variable (line ~6125)

Add `autobanPanelInteractionTimer` alongside the existing `isAutobanPanelInteracting` declaration.

**Context**: Line 6125 declares `let isAutobanPanelInteracting = false;`. The new variable must live in the same closure scope so `guardInteraction` can reference it.

**Before** (line 6125):
```javascript
let isAutobanPanelInteracting = false;
```

**After**:
```javascript
let isAutobanPanelInteracting = false;
let autobanPanelInteractionTimer = null; // debounce timer for re-render guard
```

**Edge Cases**: None — `null` is the correct initial value for a timer handle.

---

#### Change 2 — Replace `guardInteraction` with timeout-based version (lines 6160–6163)

**Context**: The current implementation at lines 6160–6163 uses focus/blur to toggle the flag. Blur fires *after* the `change` event completes, but a `terminalStatuses` message can arrive in the micro-task gap before blur. The timeout approach keeps the guard alive for 2 seconds after any interaction, completely eliminating the race.

**Before** (lines 6160–6163):
```javascript
const guardInteraction = (el) => {
    el.addEventListener('focus', () => { isAutobanPanelInteracting = true; });
    el.addEventListener('blur', () => { isAutobanPanelInteracting = false; });
};
```

**After**:
```javascript
const guardInteraction = (el) => {
    const setInteracting = () => {
        isAutobanPanelInteracting = true;
        if (autobanPanelInteractionTimer) {
            clearTimeout(autobanPanelInteractionTimer);
        }
        // Block re-renders for 2 seconds after the last interaction event
        autobanPanelInteractionTimer = setTimeout(() => {
            isAutobanPanelInteracting = false;
            autobanPanelInteractionTimer = null;
        }, 2000);
    };
    el.addEventListener('focus', setInteracting);
    el.addEventListener('change', setInteracting); // also block on value change
    el.addEventListener('input', setInteracting);  // catch mid-typing on number inputs
    // Note: blur is intentionally omitted — the timeout handles guard clearance
};
```

**Logic**: `focus` catches the moment the user opens a dropdown or enters a field. `change` ensures the guard is refreshed after the value changes (key safety event). `input` catches continuous typing in number fields (e.g., `maxSendsInput`) before `change` fires. Omitting `blur` prevents premature guard clearance.

**Edge Cases**: Timer is always cancelled-and-reset before setting a new one, so rapid sequential interactions keep the guard continuously active without leaking timers.

---

#### Change 3 — Add console logging to `renderAutobanPanel` (lines 6762–6768)

**Context**: The current check at line 6765 silently returns. Adding a log aids debugging during testing and future maintenance.

**Before** (lines 6762–6768):
```javascript
function renderAutobanPanel() {
    const root = document.getElementById('automation-panel-root');
    if (!root) return;
    if (isAutobanPanelInteracting) return;
    root.innerHTML = '';
    root.appendChild(createAutobanPanel());
}
```

**After**:
```javascript
function renderAutobanPanel() {
    const root = document.getElementById('automation-panel-root');
    if (!root) return;
    if (isAutobanPanelInteracting) {
        console.log('[kanban] Skipping autoban panel re-render: user interaction guard active');
        return;
    }
    root.innerHTML = '';
    root.appendChild(createAutobanPanel());
}
```

**Edge Cases**: None — the guard check and log are pure reads with no side effects.

---

#### Change 4 — Remove manual flag reset from `maxSendsInput` handler (lines 6531–6538)

**Context**: The `maxSendsInput` change handler at line 6536 does `isAutobanPanelInteracting = false` then calls `renderAutobanPanel()` immediately. This was added to force the session-cap badge to refresh after a max-sends change. After Change 2, this manual reset would defeat the debounce guard for any concurrent interaction on another control. The immediate `renderAutobanPanel()` call is also redundant — the panel will re-render on the next `terminalStatuses` message once the guard clears (within 2 seconds). Remove both lines.

**Before** (lines 6531–6538):
```javascript
maxSendsInput.addEventListener('change', () => {
    const value = Math.max(1, Math.min(100, parseInt(maxSendsInput.value, 10) || 10));
    state.maxSendsPerTerminal = value;
    maxSendsInput.value = String(value);
    postKanbanMessage({ type: 'updateAutobanMaxSends', maxSendsPerTerminal: value });
    isAutobanPanelInteracting = false;
    renderAutobanPanel();
});
```

**After**:
```javascript
maxSendsInput.addEventListener('change', () => {
    const value = Math.max(1, Math.min(100, parseInt(maxSendsInput.value, 10) || 10));
    state.maxSendsPerTerminal = value;
    maxSendsInput.value = String(value);
    postKanbanMessage({ type: 'updateAutobanMaxSends', maxSendsPerTerminal: value });
    // Guard clearance and re-render are handled by the debounce timer in guardInteraction
});
```

**Edge Cases**: The session-cap badge value displayed in the panel (`sessionSendCount / globalSessionCap`) is sourced from `autobanConfig` which is updated via backend message. The badge will refresh on the next `terminalStatuses` or autoban-config message after the guard clears — acceptable latency is ≤2 seconds.

---

## Verification Plan

### Manual Testing

1. Open the kanban Automation tab.
2. Change the **MAX BATCH SIZE** dropdown to a non-default value.
3. Wait 30 seconds (well beyond the prior ~20s revert window).
4. Verify the value has not reverted.
5. Change the **COMPLEXITY** dropdown — verify it persists after 30 seconds.
6. Change the **ROUTING** dropdown — verify it persists.
7. Change **MAX SENDS / TERMINAL** input — verify value persists and badge updates within ~2 seconds.
8. Perform rapid successive changes on multiple dropdowns — verify all final values persist.
9. Open the browser console and confirm `[kanban] Skipping autoban panel re-render: user interaction guard active` logs appear during active interaction.
10. Verify that after ≥2 seconds of inactivity, a `terminalStatuses` message causes the panel to re-render (terminal pool chips update).

### Automated Tests

- None applicable (webview JS tested manually per the project's established pattern for kanban.html changes).

## Risks

- **Low**: The 2-second guard window means terminal alive/dead indicators are delayed by up to 2 seconds during active interaction. Acceptable — terminal liveness changes on the order of seconds are not time-critical in the automation panel context.
- **Fallback**: If the timeout approach proves insufficient in edge cases (e.g., very slow machines where `terminalStatuses` arrives before the `change` event), the alternative is selective re-rendering: only rebuild the terminals pool chips section on each message, preserving the form control values. This is more invasive but more robust.

## Files Changed

- `src/webview/kanban.html` — 4 small, co-located edits within the autoban panel closure (lines ~6125, ~6160–6163, ~6531–6538, ~6762–6768)

---

**Recommendation**: **Send to Intern** (Complexity 3 — routine single-file edits, well-understood pattern, low risk)
