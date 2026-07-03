# Comms Monitor: Apply Source Changes Immediately Without Terminal Restart

## Goal

When the user checks or unchecks source checkboxes (Slack, Gmail, Calendar, Custom) in the AUTOMATION tab while the monitor terminal is already running, the change should take effect on the very next prompt — without restarting the terminal. Currently, adding a source mid-stream has no visible effect until the user shuts down and relaunches the terminal, which is confusing and bad UX.

### Problem Analysis & Root Cause

**Symptom:** The monitor terminal is running. The user checks the Gmail checkbox (in addition to the already-checked Slack). No new prompt appears. The user waits, sees nothing change, concludes the feature is broken, and restarts the terminal — at which point the new source finally appears in the prompt.

**Root cause (confirmed by code reading):** Two compounding issues in the config-change path:

1. **No immediate tick on config change.** `setMcpMonitorConfigFromKanban` (`TaskViewerProvider.ts:20481`) saves the config, then calls `_startMcpMonitorLoop()` (line 20483). `_startMcpMonitorLoop` (line 20390) **clears the existing interval and sets a new one** (lines 20396-20400). `setInterval` does not fire immediately — the next tick is a full `intervalMs` away (default 5 minutes). So the user's source change is persisted to disk but no prompt is sent for up to 5 minutes. There is no call to `_enqueueMcpMonitorTick()` in the config-change path.

2. **Debounce would block an immediate tick even if we added one.** Even if `setMcpMonitorConfigFromKanban` enqueued a tick, `_mcpMonitorTick` (line 20420) has a secondary debounce guard at line 20444: `if (Date.now() - this._mcpMonitorLastSendAt < intervalMs * 0.5) return;`. If a tick fired recently (within 2.5 minutes for a 5-minute interval), the immediate tick would be silently discarded. So the user could add a source, see the tick fire (in logs), but get no prompt because the debounce ate it.

**Why restarting "fixes" it:** `launchMcpMonitorTerminal` (line 20512) creates a fresh terminal and (per the companion plan) schedules a 30s one-shot first prompt. That one-shot calls `_enqueueMcpMonitorTick` → `_mcpMonitorTick`, which reads fresh config from disk (line 20421: `const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig()`). The fresh config has the new sources, so the prompt includes them. The user concludes "restart fixes it" — but the real issue is that config changes don't trigger an immediate tick.

**Key observation:** `_mcpMonitorTick` already reads fresh config from disk on every tick (line 20421). The config IS persisted correctly by `setMcpMonitorConfig`. The only problem is timing — no tick is triggered when config changes, and the debounce would block it if it were.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, automation, kanban, bugfix, ux, config-change
- **Complexity:** 3
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`

## Complexity Audit

**Routine.** The fix is entirely within `TaskViewerProvider.ts` and follows patterns already in the file (`setTimeout` for debounced actions, `_enqueueMcpMonitorTick` for serialized ticks, `clearTimeout` for cleanup). No schema changes, no UI changes, no migrations. The only subtlety is coalescing rapid checkbox toggles so we don't enqueue a flood of ticks — handled with a 500ms debounce timer.

## Edge-Case & Dependency Audit

- **Rapid checkbox toggling:** The user checks Slack, then Gmail, then Calendar in quick succession. Each checkbox `change` event calls `saveMonitorConfig` → `postKanbanMessage({ type: 'setMcpMonitorConfig', ... })` → `setMcpMonitorConfigFromKanban`. Without coalescing, this enqueues 3 ticks, each reading progressively more sources. The first tick sends a prompt with only Slack+Gmail; the second and third are debounce-blocked. Result: the prompt only has Slack+Gmail, not Calendar. **Fix:** use a 500ms `setTimeout` in `setMcpMonitorConfigFromKanban` that clears any pending timer before setting a new one. All rapid changes coalesce into a single tick that reads the final config with all sources.
- **Debounce bypass:** The coalesced tick must not be blocked by the secondary debounce (line 20444). Reset `_mcpMonitorLastSendAt = 0` when the coalesced tick fires, so the debounce check passes. This is safe — the user explicitly changed config, so an immediate prompt is intentional.
- **In-flight guard:** If a regular interval tick is in-flight when the config-change tick fires, the in-flight guard (line 20438) causes the config-change tick to skip. This is acceptable — the in-flight tick reads fresh config (line 20421), so it already includes the new sources. The config-change tick is a "best effort" immediate trigger; if a tick is already running, the new sources will be in that tick's prompt.
- **Monitor disabled during the 500ms window:** If the user unchecks all sources or disables the monitor within the 500ms coalescing window, the timer fires and enqueues a tick. `_mcpMonitorTick` reads config (line 20421), sees `enabled: false` or empty sources, and returns early (line 20422 / `_buildMcpMonitorPrompt` returns `''` at line 20476). No stray prompt. Safe.
- **Terminal dies during the 500ms window:** The tick's dead-terminal guard (line 20432) returns early. No error. Safe.
- **Timer cleanup on stop:** The coalescing timer must be cleared in `_stopMcpMonitorLoop` to avoid a stray tick after the monitor is disabled.
- **No `confirm()` dialogs.** No UI changes at all — this is a pure backend timing fix.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — add a config-change coalescing timer field

Add next to the existing MCP monitor timer fields (around line 358-361):

```ts
    private _mcpMonitorConfigChangeTimer?: NodeJS.Timeout;
```

### 2. `src/services/TaskViewerProvider.ts` — enqueue a coalesced immediate tick on config change

In `setMcpMonitorConfigFromKanban` (line 20481), add a call to schedule the coalesced tick:

```ts
    public async setMcpMonitorConfigFromKanban(config: Partial<McpMonitorConfig>) {
        await GlobalIntegrationConfigService.setMcpMonitorConfig(config);
        await this._startMcpMonitorLoop();
        this._postMcpMonitorConfig();
        this._scheduleMcpMonitorConfigChangeTick();
    }
```

### 3. `src/services/TaskViewerProvider.ts` — add the coalescing scheduler method

Add alongside the other MCP monitor helpers (after `_stopMcpMonitorLoop`, around line 20408):

```ts
    /**
     * When the user changes monitor config (sources, interval, etc.) while the
     * terminal is already running, enqueue an immediate tick so the change is
     * reflected in the very next prompt — without requiring a terminal restart.
     * A 500ms debounce coalesces rapid checkbox toggles into a single tick.
     * The debounce clock is reset so the tick isn't blocked by a recent send.
     */
    private _scheduleMcpMonitorConfigChangeTick() {
        if (this._mcpMonitorConfigChangeTimer) {
            clearTimeout(this._mcpMonitorConfigChangeTimer);
        }
        this._mcpMonitorConfigChangeTimer = setTimeout(() => {
            this._mcpMonitorConfigChangeTimer = undefined;
            // Reset the secondary debounce so this tick isn't blocked by a
            // recent interval send. The user explicitly changed config, so an
            // immediate prompt is intentional.
            this._mcpMonitorLastSendAt = 0;
            this._enqueueMcpMonitorTick();
        }, 500);
    }

    private _cancelMcpMonitorConfigChangeTick() {
        if (this._mcpMonitorConfigChangeTimer) {
            clearTimeout(this._mcpMonitorConfigChangeTimer);
            this._mcpMonitorConfigChangeTimer = undefined;
        }
    }
```

### 4. `src/services/TaskViewerProvider.ts` — cancel the coalescing timer when the monitor stops

Extend `_stopMcpMonitorLoop` (line 20403) to also cancel the config-change timer:

```ts
    private _stopMcpMonitorLoop() {
        if (this._mcpMonitorTimer) {
            clearInterval(this._mcpMonitorTimer);
            this._mcpMonitorTimer = undefined;
        }
        this._cancelMcpMonitorConfigChangeTick();
    }
```

This covers the "user disables the monitor" path (`setMcpMonitorConfigFromKanban` → `_startMcpMonitorLoop` → `if (!cfg.enabled) { this._stopMcpMonitorLoop(); return; }` at lines 20392-20394). Note: `_scheduleMcpMonitorConfigChangeTick` is called in `setMcpMonitorConfigFromKanban` *after* `_startMcpMonitorLoop`, so if the monitor was disabled, `_stopMcpMonitorLoop` runs first and cancels the timer, then `_scheduleMcpMonitorConfigChangeTick` sets a new one. The 500ms timer fires, enqueues a tick, which reads `enabled: false` and returns early. To be fully clean, we could skip scheduling the tick when `enabled` is false — but the early return in `_mcpMonitorTick` makes this harmless. For belt-and-suspenders, wrap the schedule call:

```ts
    public async setMcpMonitorConfigFromKanban(config: Partial<McpMonitorConfig>) {
        await GlobalIntegrationConfigService.setMcpMonitorConfig(config);
        await this._startMcpMonitorLoop();
        this._postMcpMonitorConfig();
        // Only schedule an immediate tick if the monitor is enabled —
        // otherwise the tick would fire and no-op on the disabled check.
        if (config.enabled !== false) {
            this._scheduleMcpMonitorConfigChangeTick();
        }
    }
```

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — add source mid-stream (the core fix):**
   - Enable the monitor with only Slack checked. Launch the terminal. Wait for the first prompt (30s one-shot or interval). Confirm the prompt contains only the Slack line.
   - While the terminal is still running, check the Gmail checkbox in the AUTOMATION tab.
   - **Within ~1 second** (500ms coalescing + tick processing), a new prompt appears in the terminal containing both the Slack and Gmail lines. No terminal restart needed. This is the fix.
3. **Manual — remove source mid-stream:**
   - With Slack + Gmail active and the terminal running, uncheck Gmail.
   - Confirm the next prompt (within ~1 second) contains only the Slack line.
4. **Manual — rapid toggling coalesces:**
   - With the terminal running, rapidly check Slack, Gmail, and Calendar in quick succession (under 500ms apart).
   - Confirm only **one** new prompt appears (not three), and it contains all three sources. The 500ms coalescing window merged the changes.
5. **Manual — debounce bypass works:**
   - Set interval to 1 minute. Let a regular interval tick fire (prompt sent). Immediately check a new source.
   - Confirm a new prompt appears within ~1 second, even though a tick just fired. The debounce reset (`_mcpMonitorLastSendAt = 0`) allowed the config-change tick through.
6. **Manual — disable monitor cancels pending tick:**
   - Check a source, then within the 500ms window switch the monitor to "off".
   - Confirm no prompt is sent after the 500ms mark. Either the timer was cancelled by `_stopMcpMonitorLoop` (if `enabled: false` short-circuits the schedule), or the tick fired and hit the `if (!cfg.enabled) return` guard. Either way, no stray prompt.
7. **Manual — terminal dies during coalescing window:**
   - Check a source, then kill the terminal within the 500ms window.
   - Confirm no error is thrown (the dead-terminal guard at line 20432 returns early).
8. **Manual — in-flight tick already covers the change:**
   - If a regular interval tick is in-flight when a source is checked, the config-change tick may be skipped by the in-flight guard. Confirm that the in-flight tick's prompt includes the new source (it reads fresh config at line 20421). If the in-flight tick already sent before the config was saved, the config-change tick fires after it and sends an updated prompt. Either way, the user sees the new source without restarting.
9. **Regression:** Regular interval polling continues to work unchanged. The 30s one-shot from the companion plan is unaffected. The debounce for regular interval ticks is unchanged (only config-change ticks reset the debounce clock).
