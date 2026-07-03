# Comms Monitor: Per-Source Intervals

## Goal

Each monitored source (Slack, Gmail, Google Calendar, Custom) should have its own configurable polling interval. A user might want to check Slack every 2 minutes (time-sensitive DMs), but Google Calendar and Gmail every 30 minutes (less urgent). Currently there is a single global `intervalMinutes` that applies to all sources equally — so the user is forced to either over-poll the less urgent sources (wasting tokens) or under-poll the urgent ones (missing time-sensitive messages).

### Problem Analysis & Root Cause

**Symptom:** The user wants Slack checked every 2 minutes but Calendar/Gmail every 30 minutes. They can't — there's one interval dropdown that applies to everything. Setting it to 2 minutes wastes tokens on Calendar/Gmail checks; setting it to 30 minutes means Slack DMs are delayed.

**Root cause (confirmed by code reading):**

1. **Config schema:** `McpMonitorConfig` (`GlobalIntegrationConfigService.ts:39`) has a single `intervalMinutes: number` field. There's no per-source interval concept.

2. **Timer architecture:** `_startMcpMonitorLoop` (`TaskViewerProvider.ts:20482` — verified 2026-07-03) creates a single `setInterval` at `intervalMs = Math.max(cfg.intervalMinutes, 1) * 60 * 1000`, wired to `_enqueueMcpMonitorTick` (line 20502), which serializes into `_mcpMonitorTick` (line 20512). Every tick builds a prompt from ALL configured sources and sends it. There's no notion of "this source is due but that one isn't." (Companion `_stopMcpMonitorLoop` is at line 20495.)

3. **Prompt builder:** `_buildMcpMonitorPrompt` (line 20552 — verified) iterates all sources in `cfg.sources` and includes every one in every prompt. There's no filtering by "is this source due for a check?" **NOTE (verified against current code):** the real preamble today is a FIXED string `"Check the following for anything new that needs my attention since your previous check. ..."` — there is currently NO `lastCheckAt`-derived boundary. The `lastCheckAt` timestamp boundary this plan's code block references is introduced by the sibling "first-prompt-after-startup" plan and does not yet exist on `main`. See Cross-Plan Conflicts.

4. **UI:** The interval selector (kanban.html:7626-7643 — verified; global interval `<div>` row) is a single dropdown above the source checklist. It's global — no per-source control. `saveMonitorConfig` is defined at lines 7732-7747, and the global dropdown's change listener is wired at line 7753.

> **Anchor correction (2026-07-03 improve-plan pass):** The original draft cited `_startMcpMonitorLoop@20390`, `_mcpMonitorTick@20420`, `_buildMcpMonitorPrompt@20460`, in-flight guard@20438, debounce@20444, and kanban rows @7799-7817 / @7847-7875 / state @6139. All of these were stale. Verified current anchors: `_startMcpMonitorLoop@20482`, `_enqueueMcpMonitorTick@20502`, `_mcpMonitorTick@20512`, in-flight guard@20530, debounce@20536, `_buildMcpMonitorPrompt@20552`, `SOURCE_PRESETS@20475`; kanban global interval row @7626-7643, sources checklist @7673-7701, `saveMonitorConfig@7732`, state default `mcpMonitorConfig@6078`. Config service: `McpMonitorConfig` interface@39, `DEFAULT_MCP_MONITOR_CONFIG@47`, `getMcpMonitorConfigSync@221`, `getMcpMonitorConfig@233`, `setMcpMonitorConfig@245`, and the `GlobalConfig.mcpMonitor` inline type @15-21.

**Design decision — single timer with due-source filtering (not multiple timers):**

Two approaches were considered:

- **Option A: Multiple `setInterval` timers, one per source.** Each fires independently and sends a prompt for just that source. Simple conceptually, but means multiple separate prompts in the terminal — potentially overlapping if two timers fire close together, and the in-flight guard (line 20438) would silently drop the second one.

- **Option B: Single timer at the GCD of all source intervals, with due-source filtering.** One `setInterval` fires at the shortest configured interval. On each tick, the code checks which sources are due (based on their individual intervals and per-source `lastCheckAt` timestamps) and builds a prompt containing only the due sources. If no sources are due, the tick is a no-op. If multiple sources are due, they're coalesced into a single prompt.

**Option B is chosen.** It produces cleaner terminal output (one prompt per tick with only the due sources, not a flood of single-source prompts), avoids the in-flight guard conflict, and naturally coalesces sources that share a common interval. The GCD timer fires more often than some sources need, but the due-check is a cheap timestamp comparison — the no-op ticks cost nothing (no prompt is sent).

Example: Slack every 2 min, Gmail every 30 min, Calendar every 30 min. The timer fires every 2 minutes (GCD of 2 and 30). Most ticks only include Slack. Every 15th tick (30 min / 2 min), Gmail and Calendar are also due and get included alongside Slack.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, polling, intervals, per-source, config, ux
- **Complexity:** 6
- **Project:** switchboard
- **Files touched:** `src/services/GlobalIntegrationConfigService.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`

## Complexity Audit

**Moderate-complex.** The change touches the config schema, the timer architecture, the prompt builder, and the UI. Each individual change is moderate, but the timer redesign (single global interval → GCD timer with per-source due-checking) is the most involved part.

**Config migration:** The existing `intervalMinutes` field is replaced by `sourceIntervals: Record<string, number>`. For backward compatibility, the read path maps a legacy `intervalMinutes` to all sources using that value. This is a read-time compat shim — the config file is only rewritten when the user changes settings.

**Per-source `lastCheckAt`:** The companion plan introduces a single global `lastCheckAt` for the diff baseline. This plan requires per-source `lastCheckAt` timestamps (so each source's diff window is independent). The read path maps a legacy global `lastCheckAt` to all sources.

**Risk:** The GCD calculation must handle edge cases (all sources at the same interval, one source at 1 minute and another at 30, sources toggled on/off mid-stream). The due-check logic must be correct — a source that was toggled off and back on should get a fresh `lastCheckAt` (not resume from a stale timestamp hours ago).

## Edge-Case & Dependency Audit

- **Backward compat — existing `intervalMinutes`:** Existing installs have `intervalMinutes: 5` and no `sourceIntervals`. The read path maps this to `sourceIntervals: { slack: 5, gmail: 5, gcal: 5, custom: 5 }`. Existing behavior is preserved — all sources poll at the legacy interval.
- **Backward compat — existing global `lastCheckAt`:** The companion plan adds a global `lastCheckAt`. This plan makes it per-source. The read path maps a legacy global `lastCheckAt` to all sources' `lastCheckAt`. The first per-source tick after upgrade uses the legacy timestamp as its baseline.
- **GCD timer frequency:** If the user sets Slack to 1 minute and Calendar to 30 minutes, the timer fires every 1 minute. 29 out of 30 ticks are Slack-only (Calendar isn't due). The no-op cost is negligible — it's a timestamp comparison, not a prompt send. If no sources are due at all (e.g. all sources were just checked), the tick sends nothing.
- **Source toggled off then on:** If the user unchecks Gmail and rechecks it later, its `lastCheckAt` is stale (from before it was unchecked). The next tick after re-enabling will include Gmail with a large diff window (since the old timestamp). This is acceptable — it's a one-time catch-up. Alternatively, clearing `lastCheckAt` on re-enable would make it default to "past 24 hours" — also acceptable. Decision: **keep the stale timestamp** — it's more correct (the user genuinely hasn't checked Gmail since then).
- **All sources unchecked:** If the user unchecks all sources, `sourceIntervals` is empty, the GCD is undefined. The loop should stop (no sources to poll). `_startMcpMonitorLoop` checks for this and calls `_stopMcpMonitorLoop` if no sources are configured.
- **Custom source interval:** The custom source gets its own interval like any other. The interval applies to whatever the custom instruction is.
- **In-flight guard:** The in-flight guard (line 20438) prevents overlapping sends. If a tick is in-flight when the next GCD tick fires, the new tick is skipped. This is correct — the next GCD tick will pick up any sources that were due during the skipped tick.
- **Debounce:** The secondary debounce (line 20444) uses `intervalMs * 0.5`. With per-source intervals, the debounce should use the GCD interval (the timer's actual frequency), not any individual source's interval. This prevents the debounce from blocking high-frequency ticks when a slow source is configured.
- **Companion plan interactions:**
  - The persistent `lastCheckAt` plan adds a global `lastCheckAt`. This plan makes it per-source. If the global plan ships first, the per-source migration reads the global value. If this plan ships first, the global plan is superseded.
  - The 30s one-shot first prompt plan fires a single tick after launch. With per-source intervals, the one-shot should fire a tick that includes ALL sources (first check covers everything), then subsequent ticks filter by due-source.
  - The config-change immediate-tick plan fires a tick on config change. With per-source intervals, a config change should restart the loop (to recompute the GCD) and fire an immediate tick for the changed sources.
- **No `confirm()` dialogs.**

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — replace `intervalMinutes` with `sourceIntervals`, make `lastCheckAt` per-source

```ts
export interface McpMonitorConfig {
    enabled: boolean;
    pollingEnabled: boolean;
    targetRole: string;
    sources: string[];
    customInstruction: string;
    // DEPRECATED — replaced by sourceIntervals. Kept for backward-compat read mapping.
    intervalMinutes?: number;
    // NEW: per-source interval in minutes. e.g. { slack: 2, gmail: 30, gcal: 30 }
    sourceIntervals: Record<string, number>;
    // NEW: per-source last-check timestamp (ISO UTC). e.g. { slack: '2026-07-03T...', gmail: '...' }
    sourceLastCheckAt: Record<string, string>;
    // DEPRECATED — replaced by sourceLastCheckAt. Kept for backward-compat read mapping.
    lastCheckAt?: string;
}
```

Update `DEFAULT_MCP_MONITOR_CONFIG`:

```ts
export const DEFAULT_MCP_MONITOR_CONFIG: McpMonitorConfig = {
    enabled: false,
    pollingEnabled: false,
    targetRole: 'mcp_monitor',
    sources: ['slack'],
    customInstruction: '',
    sourceIntervals: { slack: 5, gmail: 5, gcal: 5, custom: 5 },
    sourceLastCheckAt: {},
};
```

In `getMcpMonitorConfig` (line 233), add backward-compat mapping:

```ts
        const cfg = globalConfig.mcpMonitor || {};
        const legacyInterval = cfg.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes ?? 5;
        const legacyLastCheck = cfg.lastCheckAt;
        // Build sourceIntervals: use per-source values if present, else fall back to legacy intervalMinutes
        const allSourceKeys = ['slack', 'gmail', 'gcal', 'custom'];
        const sourceIntervals: Record<string, number> = {};
        for (const key of allSourceKeys) {
            sourceIntervals[key] = Math.max(cfg.sourceIntervals?.[key] ?? legacyInterval, 1);
        }
        // Build sourceLastCheckAt: use per-source values if present, else fall back to legacy global lastCheckAt
        const sourceLastCheckAt: Record<string, string> = {};
        for (const key of allSourceKeys) {
            sourceLastCheckAt[key] = cfg.sourceLastCheckAt?.[key] ?? legacyLastCheck ?? '';
        }
        return {
            enabled: cfg.enabled ?? (cfg.pollingEnabled ?? false),
            pollingEnabled: cfg.pollingEnabled ?? cfg.enabled ?? false,
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            intervalMinutes: legacyInterval,
            sourceIntervals,
            sourceLastCheckAt,
            lastCheckAt: legacyLastCheck,
        };
```

In `setMcpMonitorConfig` (line 245), write the new fields through using the same `?? current.X` pattern.

### 2. `src/services/TaskViewerProvider.ts` — GCD timer with per-source due-checking

Replace `_startMcpMonitorLoop` (line 20390):

```ts
    private async _startMcpMonitorLoop() {
        const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        if (!cfg.pollingEnabled) {
            this._stopMcpMonitorLoop();
            return;
        }
        // Compute the GCD of all active source intervals — this is the timer frequency.
        const activeSources = (cfg.sources || []).filter(s => (cfg.sourceIntervals[s] ?? 5) > 0);
        if (activeSources.length === 0) {
            this._stopMcpMonitorLoop();
            return;
        }
        const intervals = activeSources.map(s => cfg.sourceIntervals[s] ?? 5);
        const gcdInterval = this._gcd(intervals);
        const intervalMs = Math.max(gcdInterval, 1) * 60 * 1000;

        if (this._mcpMonitorTimer) {
            clearInterval(this._mcpMonitorTimer);
        }
        this._mcpMonitorTimer = setInterval(() => this._enqueueMcpMonitorTick(), intervalMs);
    }

    private _gcd(numbers: number[]): number {
        const gcd2 = (a: number, b: number): number => b === 0 ? a : gcd2(b, a % b);
        return numbers.reduce((acc, n) => gcd2(acc, n));
    }
```

Replace `_mcpMonitorTick` (line 20420) to filter sources by due-status:

```ts
    private async _mcpMonitorTick() {
        const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        if (!cfg.pollingEnabled) return;

        const openTerminals = vscode.window.terminals || [];
        const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix('MCP Monitor'));
        const terminal = openTerminals.find(t => {
            const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
            return tName === strippedTarget;
        });

        if (!terminal || terminal.exitStatus !== undefined) return;
        if (this._mcpMonitorInFlight) return;

        // Determine which sources are due for a check
        const now = Date.now();
        const dueSources: string[] = [];
        for (const src of (cfg.sources || [])) {
            const intervalMs = Math.max(cfg.sourceIntervals[src] ?? 5, 1) * 60 * 1000;
            const lastCheckStr = cfg.sourceLastCheckAt[src] ?? '';
            const lastCheckMs = lastCheckStr ? new Date(lastCheckStr).getTime() : 0;
            if (now - lastCheckMs >= intervalMs) {
                dueSources.push(src);
            }
        }

        if (dueSources.length === 0) return;  // no sources due, no-op tick

        this._mcpMonitorInFlight = true;
        try {
            const prompt = this._buildMcpMonitorPrompt(cfg, dueSources);
            if (prompt) {
                await sendRobustText(terminal, prompt, true);
                this._mcpMonitorLastSendAt = Date.now();
                // Persist per-source lastCheckAt for each source that was included
                const nowIso = new Date().toISOString();
                const updatedLastCheck = { ...cfg.sourceLastCheckAt };
                for (const src of dueSources) {
                    updatedLastCheck[src] = nowIso;
                }
                await GlobalIntegrationConfigService.setMcpMonitorConfig({
                    sourceLastCheckAt: updatedLastCheck
                });
            }
        } finally {
            this._mcpMonitorInFlight = false;
        }
    }
```

### 3. `src/services/TaskViewerProvider.ts` — update prompt builder to accept due sources

Update `_buildMcpMonitorPrompt` (line 20460) to accept a `dueSources` parameter and only include those sources:

```ts
    private _buildMcpMonitorPrompt(cfg: McpMonitorConfig, dueSources?: string[]): string {
        const sourcesToCheck = dueSources || cfg.sources || [];
        const boundary = cfg.lastCheckAt
            ? `since ${new Date(cfg.lastCheckAt).toUTCString()}`
            : 'in the past 24 hours';
        const preamble = `Check the following for anything new that needs my attention ${boundary}. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything.`;
        const lines: string[] = [];
        for (const src of sourcesToCheck) {
            if (src === 'custom') {
                if (cfg.customInstruction && cfg.customInstruction.trim()) {
                    lines.push(cfg.customInstruction.trim());
                }
            } else {
                const text = TaskViewerProvider.SOURCE_PRESETS[src];
                if (text) {
                    lines.push(text);
                }
            }
        }
        if (lines.length === 0) return '';
        const body = preamble + "\n\n" + lines.map(line => `- ${line}`).join('\n');
        return normalizeNewlines(body);
    }
```

Note: the `boundary` uses the per-source `lastCheckAt` from the config. For a more precise prompt, each source line could include its own boundary — but that's a refinement for the companion prompt-preview plan. This plan keeps the global boundary for simplicity; the per-source `lastCheckAt` is used for the due-check, not the prompt text.

### 4. `src/webview/kanban.html` — replace global interval dropdown with per-source interval selectors

Remove the global interval row (lines 7799-7817). Instead, add an interval selector next to each source checkbox in the sources checklist (lines 7847-7875):

```js
            Object.entries(presetsToRender).forEach(([key, label]) => {
                const labelWrapper = document.createElement('label');
                labelWrapper.style.cssText = 'display:flex; align-items:flex-start; gap:6px; cursor:pointer; font-size:9px; color:var(--text-secondary); line-height:1.2;';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = key;
                checkbox.checked = activeSources.has(key);
                checkbox.style.cssText = 'margin:1px 0 0 0; cursor:pointer; flex-shrink:0;';
                guardInteraction(checkbox);

                const span = document.createElement('span');
                span.textContent = label;
                span.style.cssText = 'flex:1;';

                // Per-source interval selector
                const intervalSelect = document.createElement('select');
                intervalSelect.style.cssText = autobanSelectStyle + ' flex:0 0 auto; margin-left:4px;';
                guardInteraction(intervalSelect);
                const currentInterval = (mcpMonitorConfig.sourceIntervals && mcpMonitorConfig.sourceIntervals[key]) || mcpMonitorConfig.intervalMinutes || 5;
                [1, 2, 5, 10, 15, 30, 60].forEach(minutes => {
                    const opt = document.createElement('option');
                    opt.value = String(minutes);
                    opt.textContent = `${minutes}m`;
                    if (currentInterval === minutes) opt.selected = true;
                    intervalSelect.appendChild(opt);
                });
                intervalSelect.addEventListener('change', () => {
                    saveMonitorConfig();
                });

                labelWrapper.appendChild(checkbox);
                labelWrapper.appendChild(span);
                labelWrapper.appendChild(intervalSelect);
                sourcesList.appendChild(labelWrapper);

                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        activeSources.add(key);
                    } else {
                        activeSources.delete(key);
                    }
                    if (key === 'custom') {
                        customInstructionRow.style.display = checkbox.checked ? 'block' : 'none';
                    }
                    saveMonitorConfig();
                });
            });
```

### 5. `src/webview/kanban.html` — update `saveMonitorConfig` to send `sourceIntervals`

```js
            const saveMonitorConfig = () => {
                const enabled = mcpSelect.value === 'on';
                const customInstruction = customInstructionTextarea.value;
                const sources = Array.from(activeSources);
                // Build sourceIntervals from the per-source dropdowns
                const sourceIntervals = {};
                sourcesList.querySelectorAll('select').forEach(sel => {
                    // Find the source key from the parent label's checkbox
                    const cb = sel.parentElement.querySelector('input[type="checkbox"]');
                    if (cb) {
                        sourceIntervals[cb.value] = parseInt(sel.value, 10);
                    }
                });
                mcpMonitorConfig = { ...mcpMonitorConfig, enabled, sources, customInstruction, sourceIntervals };
                postKanbanMessage({
                    type: 'setMcpMonitorConfig',
                    config: {
                        enabled,
                        sources,
                        customInstruction,
                        sourceIntervals
                    }
                });
            };
```

### 6. `src/webview/kanban.html` — update webview state default

Near line 6139:

```js
        let mcpMonitorConfig = {
            enabled: false,
            pollingEnabled: false,
            intervalMinutes: 5,
            sourceIntervals: { slack: 5, gmail: 5, gcal: 5, custom: 5 },
            sourceLastCheckAt: {},
            targetRole: 'mcp_monitor',
            sources: ['slack'],
            customInstruction: ''
        };
```

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — per-source intervals appear:**
   - Enable the monitor. Confirm each source checkbox now has its own interval dropdown next to it (showing "5m" by default).
3. **Manual — different intervals per source:**
   - Check Slack, set its interval to "2m". Check Gmail, set its interval to "30m". Check Calendar, set its interval to "30m".
   - Start the terminal and polling. Confirm the config is saved to `~/.switchboard/integration-config.json` with `sourceIntervals: { slack: 2, gmail: 30, gcal: 30 }`.
4. **Manual — GCD timer fires at the shortest interval:**
   - With Slack at 2m and Gmail/Calendar at 30m, the timer fires every 2 minutes.
   - After 2 minutes: confirm a prompt is sent containing only Slack (Gmail and Calendar aren't due).
   - After another 2 minutes (4 min total): confirm another Slack-only prompt.
   - Continue until 30 minutes: confirm a prompt is sent containing Slack + Gmail + Calendar (all three are due).
5. **Manual — no-op ticks send nothing:**
   - With only Calendar checked at 30m, the timer fires every 30 minutes. Between ticks, no prompts are sent. Confirm no errors or empty prompts appear in the terminal.
6. **Manual — per-source lastCheckAt persists:**
   - After a Slack-only tick, inspect `~/.switchboard/integration-config.json`. Confirm `sourceLastCheckAt.slack` is updated but `sourceLastCheckAt.gmail` is unchanged (Gmail wasn't checked).
7. **Manual — backward compat (legacy `intervalMinutes`):**
   - On an install with existing `mcpMonitor.intervalMinutes: 5` (no `sourceIntervals`), open the COMMS tab.
   - Confirm all source interval dropdowns default to "5m" (legacy interval mapped to all sources).
   - Confirm polling works at 5-minute intervals for all sources — existing behavior preserved.
8. **Manual — source toggled off then on:**
   - Check Slack (2m) and Gmail (30m). Let both run for a few ticks. Uncheck Gmail. Wait 30+ minutes. Recheck Gmail.
   - Confirm the next tick after re-enabling includes Gmail with a large diff window (since its `lastCheckAt` is from before it was unchecked). This is the catch-up behavior.
9. **Manual — all sources unchecked:**
   - Uncheck all sources. Confirm the loop stops (no timer running, no ticks). The GCD is undefined when no sources are active.
10. **Regression:** The on/off dropdown, custom instruction field, and source checkboxes still work. The `setMcpMonitorConfig` backend handler preserves `sourceLastCheckAt` when it's not specified in a partial config update.
