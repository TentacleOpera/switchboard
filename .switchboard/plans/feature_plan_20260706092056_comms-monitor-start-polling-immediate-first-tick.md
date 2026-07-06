# Comms Monitor: Start Polling Button Should Immediately Poll, Not Wait 30s

## Goal

The "Start Polling" button in the COMMS tab of `kanban.html` is meant to immediately poll the configured channels. Instead, it waits ~30 seconds before sending the first prompt to the monitor terminal. The user expects near-instant feedback when they click "Start Polling" — the first check should fire within 1–3 seconds, not 30.

### Problem Analysis & Root Cause

**Symptom:** User clicks "Start Polling" in the COMMS tab. The monitor terminal sits idle for ~30 seconds before the first prompt appears. The user perceives this as "about a minute" because the 30s timer delay is compounded by `sendRobustText` delivery overhead (PRE_PASTE_SETTLE_MS + POST_PASTE_SETTLE_MS + NEWLINE_DELAY + CLI_CONFIRM_ENTER_DELAY ≈ 2.3s for CLI agents).

**Root cause (confirmed by code reading):** `startMcpMonitorPolling()` in `src/services/TaskViewerProvider.ts` (line ~20803) schedules the first prompt via a 30-second `setTimeout` one-shot:

```ts
this._mcpMonitorFirstPromptTimer = setTimeout(() => {
    this._mcpMonitorFirstPromptTimer = undefined;
    this._enqueueMcpMonitorTick();
}, 30 * 1000);
```

This 30s delay was an intentional design choice from the consolidated lifecycle plan (`feature_plan_20260703160000_comms-monitor-lifecycle-polling-consolidated.md`), meant to give the user time to verify auth before the first check. However, the three-step launch flow (Start Terminal → Check Auth → Start Polling) already separates auth verification from polling — by the time the user clicks "Start Polling", they have already verified auth. The 30s delay is therefore redundant and degrades UX.

The GCD interval timer (`_startMcpMonitorLoop`) also does not fire immediately — `setInterval` waits a full period before the first tick. So even without the 30s one-shot, the first check would wait for the full GCD interval (e.g., 5 minutes).

## Metadata

- **Tags:** bugfix, ux, comms-monitor, polling
- **Complexity:** 3
- **Project:** switchboard
- **Repo:** (root — single-repo extension)
- **Files touched:** `src/services/TaskViewerProvider.ts`

## Complexity Audit

### Routine
- Reduce the 30s first-prompt `setTimeout` to a short delay (1–3s) or fire immediately via `_enqueueMcpMonitorTick()`.
- The tick already has an in-flight guard and a `pollingEnabled` check, so an immediate tick is safe.

### Complex / Risky
- None. The change is a single constant/method call swap in an already-tested code path.

## Edge-Case & Dependency Audit

### Race Conditions
- An immediate tick via `_enqueueMcpMonitorTick()` serializes on `_mcpMonitorTickQueue`, so it cannot interleave with a concurrent interval tick. The in-flight guard (`_mcpMonitorInFlight`) prevents double-sends.
- If the user clicks "Start Polling" and then immediately "Stop Polling", the queued tick will run after `pollingEnabled` is set to false and return early at the `if (!cfg.pollingEnabled) return;` guard (line ~20501). Safe.

### Terminal Readiness
- The terminal must be running for the tick to send a prompt. `_mcpMonitorTick` checks for a live terminal (line ~20504–20514) and returns silently if none is found. An immediate tick when the terminal isn't running yet is a no-op, not an error.
- A short delay (e.g., 2s) is preferable to truly immediate (0ms) to allow the webview message round-trip to complete and the config write to settle.

### Dependencies
- None external. The three-step launch flow (Start Terminal → Check Auth → Start Polling) is already implemented and separates auth from polling.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `startMcpMonitorPolling()` (line ~20803)

Replace the 30s `setTimeout` with a short 2s delay (enough for the config write to settle and the webview to update, but fast enough that the user perceives it as immediate):

```ts
public async startMcpMonitorPolling(): Promise<void> {
    await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: true });
    await this._startMcpMonitorLoop();
    // First prompt: fire within 2s instead of 30s. The three-step launch
    // (Start Terminal → Check Auth → Start Polling) already gates on auth,
    // so the 30s grace period is redundant. A short delay lets the config
    // write settle and the webview update before the tick runs.
    if (this._mcpMonitorFirstPromptTimer) {
        clearTimeout(this._mcpMonitorFirstPromptTimer);
    }
    this._mcpMonitorFirstPromptTimer = setTimeout(() => {
        this._mcpMonitorFirstPromptTimer = undefined;
        this._enqueueMcpMonitorTick();
    }, 2 * 1000);
    await this._postMcpMonitorConfig();
}
```

The only change is `30 * 1000` → `2 * 1000` on the `setTimeout` delay.

## Verification Plan

1. Launch the Comms Monitor terminal (Start Terminal button).
2. Click "Check Auth" and verify Claude responds.
3. Click "Start Polling" and measure the time until the first prompt appears in the monitor terminal.
4. **Expected:** First prompt appears within ~3–5 seconds (2s delay + sendRobustText delivery overhead).
5. **Before fix:** First prompt appears after ~32–35 seconds.
6. Verify that "Stop Polling" still cancels the first-prompt timer if clicked before the 2s delay elapses.
7. Verify that repeated "Start Polling" → "Stop Polling" → "Start Polling" cycles don't stack up multiple timers (the `clearTimeout` guard at the top handles this).
