# Comms Monitor: Start Polling Button Should Immediately Poll, Not Wait 30s

## Goal

The "Start Polling" button in the COMMS tab of `kanban.html` is meant to immediately poll the configured channels. Instead, it waits ~30 seconds before sending the first prompt to the monitor terminal. The user expects near-instant feedback when they click "Start Polling" — the first check should fire within 1–3 seconds, not 30.

### Problem Analysis & Root Cause

**Symptom:** User clicks "Start Polling" in the COMMS tab. The monitor terminal sits idle for ~30 seconds before the first prompt appears. The user perceives this as "about a minute" because the 30s timer delay is compounded by `sendRobustText` delivery overhead (PRE_PASTE_SETTLE_MS + POST_PASTE_SETTLE_MS + NEWLINE_DELAY + CLI_CONFIRM_ENTER_DELAY ≈ 2.3s for CLI agents).

**Root cause (confirmed by code reading):** `startMcpMonitorPolling()` in `src/services/TaskViewerProvider.ts` (line 20821) schedules the first prompt via a 30-second `setTimeout` one-shot (lines 20828–20831):

```ts
this._mcpMonitorFirstPromptTimer = setTimeout(() => {
    this._mcpMonitorFirstPromptTimer = undefined;
    this._enqueueMcpMonitorTick();
}, 30 * 1000);
```

This 30s delay was an intentional design choice from the consolidated lifecycle plan (`feature_plan_20260703160000_comms-monitor-lifecycle-polling-consolidated.md`), meant to give the user time to verify auth before the first check. However, the three-step launch flow (Start Terminal → Check Auth → Start Polling) already separates auth verification from polling — by the time the user clicks "Start Polling", they have already verified auth. The 30s delay is therefore redundant and degrades UX.

The GCD interval timer (`_startMcpMonitorLoop`, line 20473) also does not fire immediately — `setInterval` waits a full period before the first tick (line 20489). So even without the 30s one-shot, the first check would wait for the full GCD interval (e.g., 5 minutes).

## Metadata

- **Tags:** bugfix, ux
- **Complexity:** 3
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`

## User Review Required

No user review needed before coding. The change is a single constant swap (`30 * 1000` → `2 * 1000`) in a well-understood code path. The three-step launch flow already gates auth separately, so reducing the first-prompt delay has no security or correctness implications. The existing guards (`_mcpMonitorInFlight`, `pollingEnabled` check, live-terminal check) make an immediate or near-immediate tick safe.

## Complexity Audit

### Routine
- Reduce the 30s first-prompt `setTimeout` to a short delay (1–3s) or fire immediately via `_enqueueMcpMonitorTick()`.
- The tick already has an in-flight guard (`_mcpMonitorInFlight`, line 20535) and a `pollingEnabled` check (line 20519), so an immediate tick is safe.

### Complex / Risky
- None. The change is a single constant/method call swap in an already-tested code path.

## Edge-Case & Dependency Audit

### Race Conditions
- An immediate tick via `_enqueueMcpMonitorTick()` serializes on `_mcpMonitorTickQueue` (line 20507), so it cannot interleave with a concurrent interval tick. The in-flight guard (`_mcpMonitorInFlight`, line 20535) prevents double-sends.
- If the user clicks "Start Polling" and then immediately "Stop Polling", the queued tick will run after `pollingEnabled` is set to false and return early at the `if (!cfg.pollingEnabled) return;` guard (line 20519). Safe.
- If the user clicks "Start Polling" twice rapidly, the `clearTimeout` guard (lines 20825–20827) cancels the previous timer before setting a new one, preventing timer stacking.

### Security
- None. The first-prompt timer only enqueues a read-only check tick; it does not bypass auth or expose data.

### Side Effects
- Reducing the delay means the first prompt is sent sooner after the config write. The config write (`setMcpMonitorConfig`) is awaited before the timer is set, so the config is always committed before the tick fires. A 2s buffer is more than sufficient for the webview to reflect the updated state.
- The `_stopMcpMonitorLoop()` method (line 20492) already clears `_mcpMonitorFirstPromptTimer` (lines 20497–20499), so stopping polling always cancels the pending one-shot regardless of its delay value.

### Dependencies & Conflicts
- None. The three-step launch flow (Start Terminal → Check Auth → Start Polling) is already implemented and separates auth from polling. No other plan or feature depends on the 30s delay value.

### Terminal Readiness
- The terminal must be running for the tick to send a prompt. `_mcpMonitorTick` checks for a live terminal (lines 20522–20532) and returns silently if none is found. An immediate tick when the terminal isn't running yet is a no-op, not an error.
- A short delay (e.g., 2s) is preferable to truly immediate (0ms) to allow the webview message round-trip to complete and the config write to settle.

## Dependencies

No external dependencies.

## Adversarial Synthesis

Key risks: (1) A 2s delay might still feel sluggish if the terminal is already warm and the user expects sub-second response; (2) if the config write is slow (e.g., disk contention), the 2s buffer might not be enough and the tick could read stale config. Mitigations: (1) The 2s delay is a conservative choice — it can be reduced to 1s or 0s in a follow-up if users want faster response; the serialization queue and in-flight guard make even 0ms safe. (2) The config write is awaited before the timer is set, so the tick always reads fresh config; the 2s buffer is for webview UI consistency, not config correctness.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `startMcpMonitorPolling()` (line 20821)

**Context:** `startMcpMonitorPolling()` is Step 3 of the three-step launch flow. It sets `pollingEnabled: true`, starts the GCD interval loop, and schedules a one-shot first-prompt timer. The 30s delay on that timer is the bug.

**Logic:** Replace the 30s `setTimeout` with a short 2s delay — enough for the config write to settle and the webview to update, but fast enough that the user perceives it as immediate.

**Implementation:** Change `30 * 1000` to `2 * 1000` on line 20831. The full method after the change:

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

The only change is `30 * 1000` → `2 * 1000` on the `setTimeout` delay (line 20831).

**Edge Cases:**
- If the terminal is not running when the 2s timer fires, `_mcpMonitorTick` returns silently at the live-terminal check (lines 20529–20532). No error, no side effect.
- If the user clicks "Stop Polling" before the 2s timer fires, `_stopMcpMonitorLoop()` clears the timer (lines 20497–20499) and sets `pollingEnabled: false`. If the tick was already enqueued (race between timer callback and stop), the tick returns early at the `pollingEnabled` guard (line 20519). Safe.
- Repeated Start/Stop cycles: the `clearTimeout` guard (lines 20825–20827) prevents timer stacking.

Also update the JSDoc comment on `startMcpMonitorPolling()` (lines 20816–20820) to reflect the new delay:

```ts
/**
 * Step 3 of the three-step launch: enable polling, start the GCD timer,
 * and schedule a 2s first-prompt one-shot so the first check arrives
 * quickly without waiting a full interval.
 */
```

## Verification Plan

1. Launch the Comms Monitor terminal (Start Terminal button).
2. Click "Check Auth" and verify Claude responds.
3. Click "Start Polling" and measure the time until the first prompt appears in the monitor terminal.
4. **Expected:** First prompt appears within ~3–5 seconds (2s delay + sendRobustText delivery overhead).
5. **Before fix:** First prompt appears after ~32–35 seconds.
6. Verify that "Stop Polling" still cancels the first-prompt timer if clicked before the 2s delay elapses.
7. Verify that repeated "Start Polling" → "Stop Polling" → "Start Polling" cycles don't stack up multiple timers (the `clearTimeout` guard at lines 20825–20827 handles this).
8. Verify that clicking "Start Polling" without a running terminal does not produce an error (the tick should silently return at the live-terminal check, lines 20529–20532).

---

**Routing recommendation:** Complexity 3 → Send to Intern
