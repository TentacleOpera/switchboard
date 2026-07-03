# MCP Monitor: First Prompt 30s After Startup + Persistent Diff Baseline

## Goal

The MCP Monitor automation in the kanban.html **AUTOMATION** tab should send its first check prompt to the monitor terminal ~30 seconds after the `claude` startup command is sent, so the user has visible evidence that the automation is working. Currently the user launches the monitor terminal, the status flips to "🟢 Monitor terminal: running", but no prompt is sent for the full polling interval (default 5 minutes) — making the feature appear broken.

A second, related gap: the "since your previous check" diff baseline currently lives only in Claude's session memory. If the user clears the terminal, Claude restarts, the session context is evicted, or the IDE/extension reloads, that baseline is lost and the next check silently reverts to a "past 24 hours" first-check behavior — over-reporting and breaking the incremental-diff contract. This plan closes that gap by persisting the diff baseline on disk and injecting it explicitly into every prompt.

### Problem Analysis & Root Cause

**Symptom 1 (no first prompt):** User clicks *Launch Monitor Terminal* in the AUTOMATION tab. A terminal opens, `claude` is started, the kanban status reads "🟢 running", but no monitor prompt ever appears in the terminal pane. The user concludes the automation does nothing.

**Symptom 2 (silent baseline reset):** After a terminal clear / Claude restart / IDE reload, the next monitor prompt re-scans the past 24 hours instead of just the delta since the last check, producing duplicate reports the user has already seen.

**Root cause (confirmed by code reading):**

1. `launchMcpMonitorTerminal()` (`src/services/TaskViewerProvider.ts:20604`) creates the terminal, waits for shell readiness (up to 5s), sends the startup command via `terminal.sendText(cmd.trim(), true)` at line 20671, then calls `_postMcpMonitorConfig()` (line 20675). **It never schedules an early/first monitor tick and never calls `_startMcpMonitorLoop()`.**

2. `_startMcpMonitorLoop()` (line 20482) sets up the polling via `setInterval(this._enqueueMcpMonitorTick(), intervalMs)` (line 20492) where `intervalMs = Math.max(cfg.intervalMinutes, 1) * 60 * 1000` (default 5 minutes). `setInterval` does **not** fire immediately — the first tick is a full interval after the loop starts. So even when the loop is already running (started at construction, line 487, or via `setMcpMonitorConfigFromKanban`, line 20573→`_startMcpMonitorLoop`, line 20575), the freshly-launched terminal waits up to 5 minutes for its first prompt.

3. There is no "first prompt" path at all. The only prompt sender is `_mcpMonitorTick()` (line 20512), invoked exclusively by the interval timer via `_enqueueMcpMonitorTick()` (line 20502).

4. `_buildMcpMonitorPrompt` (line 20552, preamble literal at line 20553) emits a **fixed** string: `"Check the following for anything new that needs my attention since your previous check..."`. There is no server-side timestamp, no `lastCheckAt` for the monitor, and no "past 24 hours" string in the prompt. The "since previous check" reference is interpreted entirely by Claude reading its own prior turn in the session. The only MCP-monitor timing state in the extension is `_mcpMonitorLastSendAt` (line 360), used purely for debounce (line 20536) — not for prompt content. So the diff baseline is Claude-owned, not extension-owned, and is lost on any session reset.

> **Anchor note (verified 2026-07-03):** Line numbers in this plan were re-verified against the current `TaskViewerProvider.ts`. Symbols are the stable anchors — the surrounding line numbers drift as the 20k-line file changes. Current symbol map: `_startMcpMonitorLoop`≈20482, `_stopMcpMonitorLoop`≈20495, `_enqueueMcpMonitorTick`≈20502, `_mcpMonitorTick`≈20512, `_buildMcpMonitorPrompt`≈20552, `setMcpMonitorConfigFromKanban`≈20573, `_postMcpMonitorConfig`≈20579, `launchMcpMonitorTerminal`≈20604, `_isMcpMonitorTerminalRunning`≈20684, `handleTerminalClosed`≈16006. Fields `_mcpMonitorTimer`/`_mcpMonitorTickQueue`/`_mcpMonitorLastSendAt`/`_mcpMonitorInFlight` at lines 358–361.

**Why 30 seconds:** The startup command is `claude` (or a configured agent binary), which takes several seconds to initialize its REPL. Sending the prompt immediately would land before Claude is ready to accept input and the text would be eaten by the shell. A 30-second delay gives Claude time to boot before the first check prompt is typed into the pane.

**Why persist `lastCheckAt` on disk:** The extension already persists MCP monitor config to `~/.switchboard/integration-config.json` (`GlobalIntegrationConfigService.ts:245`). Adding a `lastCheckAt` field there survives IDE restarts, extension reloads, and Claude session resets — because it's a file on disk, not Claude's context. Injecting that timestamp into the prompt text means Claude no longer needs to remember its prior turn; the prompt *tells* it the window.

## Metadata

- **Tags:** bugfix, ux, reliability, feature
- **Complexity:** 5
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/webview/kanban.html`

## User Review Required

- **First-prompt delay = 30s (hard-coded).** Confirm 30s is the right wait for `claude` REPL boot. If a slower agent binary is configured as the startup command, 30s may fire before the REPL accepts input. Consider whether this should be configurable (out of scope now; flagged).
- **Global vs per-source `lastCheckAt`.** This plan uses a single global baseline. If the `per-source-intervals` sibling ships, a newly-enabled source will over-report once (documented, accepted). Confirm this trade-off is acceptable rather than per-source timestamps.
- **Boundary format in prompt.** The prompt injects `since <UTC toUTCString()>`. Confirm UTC (not local time) is acceptable in the user-visible prompt text.
- **Epic-level coordination.** This plan touches several shared surfaces (see notes in Proposed Changes). It should not be coded independently of its siblings — see Dependencies and the cross-plan notes.

## Complexity Audit

### Routine
- Adding one private timer field (`_mcpMonitorFirstPromptTimer`) next to existing timer fields (lines 358-361).
- A `setTimeout`/`clearTimeout` one-shot pair mirroring the existing `setInterval`/`clearInterval` discipline used by `_mcpMonitorTimer`.
- Appending an optional `lastCheckAt?: string` field to `McpMonitorConfig` + `GlobalConfig.mcpMonitor` and threading it through the existing `get`/`set` accessor pair — a purely additive, backward-compatible config change.
- Swapping one hard-coded phrase in `_buildMcpMonitorPrompt` for a computed `boundary` string; rest of the method untouched.
- Copy edit to one `textContent` string in kanban.html.

### Complex / Risky
- **Timer lifecycle:** cancelling the one-shot if the terminal dies or the user disables the monitor — handled by extending `_stopMcpMonitorLoop` with `clearTimeout` discipline already used elsewhere.
- **Config-file write amplification:** `_mcpMonitorTick` now writes `lastCheckAt` to `~/.switchboard/integration-config.json` on every successful send (~12 writes/hour at the 5-min default) — negligible, no batching needed.
- **Shared-surface contention:** five of this plan's edits land on functions/blocks also edited by sibling subtasks (`launchMcpMonitorTerminal`, `_stopMcpMonitorLoop`, `_buildMcpMonitorPrompt`, the `McpMonitorConfig` schema, the kanban.html monitor UI block). Additive per this plan, but requires epic-level merge — the primary risk is a sibling clobbering this plan's edit, not a logic fault.

**(Prose detail, preserved.) Routine-to-moderate.** The change is localized to three files and follows existing patterns already in the codebase (`setTimeout`/`setInterval`, `_enqueueMcpMonitorTick`, terminal lifecycle guards, and the `getMcpMonitorConfig`/`setMcpMonitorConfig` persistence pair). No data migrations, no schema changes, no new dependencies.

The two mildly risky aspects:
1. **Timer lifecycle** (cancelling the one-shot if the terminal dies or the user disables the monitor) — handled with the same `clearTimeout`/`clearInterval` discipline already used for `_mcpMonitorTimer`.
2. **Config-file write amplification** — `_mcpMonitorTick` now writes `lastCheckAt` to `~/.switchboard/integration-config.json` on every successful send (every interval). This is a small JSON file written via `fs.promises.writeFile` (already used by `setMcpMonitorConfig`). At the default 5-minute interval this is 12 writes/hour — negligible. No batching or throttling needed.

**Migration note:** `lastCheckAt` is a new optional field on the persisted `mcpMonitor` object. Existing installs have no `lastCheckAt` and the read path defaults to `undefined`, which the prompt builder treats as "first ever check" → "past 24 hours". This is a clean additive change — no migration required, no compat shim, and existing installs behave exactly as they do today until the first successful send writes the new field.

## Edge-Case & Dependency Audit

- **Race Conditions:** The one-shot `setTimeout(30s)` can race with (a) the regular interval tick, (b) the user disabling the monitor, and (c) the terminal dying. All three are serialized/guarded: ticks funnel through `_enqueueMcpMonitorTick` (a promise chain, line 20502) plus the `_mcpMonitorInFlight` boolean (line 20530), so two ticks never send concurrently; disable clears the one-shot via `_stopMcpMonitorLoop`; a dead terminal is caught by the exitStatus guard (line 20524). The `lastCheckAt` write is inside the in-flight window, so no interleaved write can race it.
- **Security:** None. The prompt is read-only by construction ("do NOT take any actions"). `lastCheckAt` is a timestamp written to an already-existing user-owned config file; no new secrets, no new network surface, no new IPC.
- **Side Effects:** New disk write on every successful tick (`setMcpMonitorConfig({ lastCheckAt })`); the prompt text now varies with persisted state; the kanban help copy changes. No effect on autoban or other agent-grid terminals.
- **Dependencies & Conflicts:** Depends on the existing `GlobalIntegrationConfigService` get/set pair and `sendRobustText`. Conflicts are cross-plan (shared surfaces) — see the "Shared surface" notes in Proposed Changes and the `## Dependencies` section below.

**Detailed edge-case walkthrough (preserved):**

- **Terminal exits during the 30s window:** The one-shot tick calls `_enqueueMcpMonitorTick()`, which calls `_mcpMonitorTick()`, which already guards `if (!terminal || terminal.exitStatus !== undefined) return;` (line 20524). Safe — a dead terminal simply skips the send. Note also `handleTerminalClosed` (line 16006) fires when the monitor terminal is closed; the one-shot need not be cancelled there because the tick's dead-terminal guard already no-ops, but cancelling it there would be a harmless defensive add (out of scope for this plan).
- **User disables MCP monitor during the 30s window:** `setMcpMonitorConfigFromKanban` (line 20573) → `_startMcpMonitorLoop()` (line 20575) → `if (!cfg.enabled) { this._stopMcpMonitorLoop(); return; }` (lines 20484-20487) → `_stopMcpMonitorLoop()` (line 20495) clears the interval. The one-shot must also be cleared here to avoid a stray prompt after disable (see change #4).
- **User launches a second monitor terminal:** `launchMcpMonitorTerminal` reuses an existing live terminal (lines 20618-20625, `if (live) { live.show(); return; }`) and only creates a new one if none is live. The one-shot is scheduled only on the create path because the reuse path returns early before reaching the scheduling call (or, if re-scheduled, is harmless — the in-flight guard at line 20530 prevents duplicate sends).
- **Loop already running when terminal launches:** Calling `_startMcpMonitorLoop()` again is safe — it clears the existing interval before setting a new one (lines 20488-20492).
- **Startup command is empty / not configured:** `launchMcpMonitorTerminal` only sends a command if `cmd && cmd.trim()` (line 20660). The 30s one-shot should still fire in this case (the terminal is a plain shell and can still receive the prompt). Place the one-shot scheduling outside the `if (cmd)` block (after line 20672, before `_postMcpMonitorConfig()`).
- **Secondary debounce (line 20536):** `Date.now() - this._mcpMonitorLastSendAt < intervalMs * 0.5`. On a fresh launch `_mcpMonitorLastSendAt` is `0`, so this never blocks the first tick. No change needed.
- **VS Code webview `confirm()` ban:** No confirm dialogs are introduced (per project rule — confirm gates are silent no-ops in VS Code webviews and are banned). The launch button already disables itself during launch (kanban.html:7718, `launchBtn.disabled = true`).
- **`lastCheckAt` write only on success:** The timestamp is persisted *after* `sendRobustText` succeeds. If the send throws or the terminal is dead, the baseline does not advance, so the next tick re-covers the same window (correct — Claude never saw the prompt). The `try/finally` keeps `_mcpMonitorInFlight` reset on failure; the `await setMcpMonitorConfig` call sits inside the `try` after the successful send.
- **First-ever check (no `lastCheckAt`):** `getMcpMonitorConfig` returns `lastCheckAt: undefined`. The prompt builder falls back to "in the past 24 hours". On the first successful send, `lastCheckAt` is written. Subsequent ticks use the explicit timestamp.
- **Claude session reset / terminal cleared mid-stream:** The persisted `lastCheckAt` is unaffected — it's on disk. The next tick injects "since <timestamp>" into the prompt, so the restarted Claude gets the correct boundary without relying on its own (now-empty) context. This is the core fix for symptom 2.
- **IDE / extension restart:** `_mcpMonitorLastSendAt` (in-memory debounce clock) is lost on restart, but `lastCheckAt` on disk survives. The first tick after restart reads `lastCheckAt` from config and injects the correct boundary. The debounce guard (line 20536) uses `_mcpMonitorLastSendAt = 0` after restart, so it never blocks — correct.
- **Newly-enabled source mid-stream:** A single global `lastCheckAt` is shared across all sources. If the user enables Gmail after Slack was running, the first Gmail check says "since <when Slack was last checked>" and may over-report Gmail items from that window. This is acceptable (one-time over-report on newly-enabled sources) and far better than the current silent reset. Per-source timestamps would be over-engineering for this feature.
- **Clock skew / manual config edit:** If a user manually edits `lastCheckAt` to a future time, the prompt would ask Claude for "since <future>" which Claude handles gracefully (reports nothing new → "All clear"). Not a crash risk.

## Dependencies

This subtask is 1 of 10 in the **MCP Monitor improvements** epic. It has no external session dependencies, but it shares code surfaces with several siblings that must be merged, not applied blindly:

- `sess_epic_mcp_monitor — editable-prompt-preview` — co-edits `_buildMcpMonitorPrompt`. The `${boundary}` injection must compose with any editable/stored prompt template. **Reconcile before coding either.**
- `sess_epic_mcp_monitor — per-source-intervals` — co-edits the `McpMonitorConfig` interface, the `setMcpMonitorConfig` merge block, and the loop/tick structure. Additive to the schema; but if intervals become per-source, the single global `lastCheckAt` and single first-prompt one-shot may need to fan out.
- `sess_epic_mcp_monitor — stuck-running-status-and-stop-control` — co-edits `_stopMcpMonitorLoop`. Merge both cleanup extensions.
- `sess_epic_mcp_monitor — separate-terminal-auth-polling` — co-edits `launchMcpMonitorTerminal`. If launch now polls for auth before the terminal is usable, the 30s first-prompt timer should be started *after* auth completes, not at launch, or it may fire into an auth prompt.
- `sess_epic_mcp_monitor — rename-display-labels` — may rewrite the same kanban.html help copy this plan edits, and touches display labels; must NOT change the `'MCP Monitor'` terminal-name literal (the singleton guard key).
- `sess_epic_mcp_monitor — dedicated-tab` — relocates the monitor UI block in kanban.html; the help-text edit must follow the block to its new location.

(No blocking upstream session prerequisites — these are peer coordination points, resolved at epic synthesis.)

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) shared-surface contention — five edits land on functions/blocks also edited by siblings, so the dominant failure mode is a merge clobber, not a logic bug; (2) the 30s first-prompt one-shot racing terminal disable/death, mitigated by extending `_stopMcpMonitorLoop` and the existing exitStatus + in-flight guards; (3) the global `lastCheckAt` over-reporting once on a newly-enabled source (accepted). Mitigations: treat every shared surface as append-only with an explicit epic-level merge note, gate the one-shot behind the same lifecycle cleanup as the interval, and persist `lastCheckAt` only after a confirmed successful send so a failed tick never advances the baseline.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — add a one-shot "first prompt" timer field

Add a new private field next to the existing MCP monitor timer fields (around line 358-361):

```ts
private _mcpMonitorFirstPromptTimer?: NodeJS.Timeout;
```

### 2. `src/services/TaskViewerProvider.ts` — schedule the 30s first prompt after launch

> **Shared surface.** `launchMcpMonitorTerminal` is a shared surface coordinated at the epic level (touched by `separate-terminal-auth-polling`, `stuck-running-status-and-stop-control`, and `dedicated-tab` siblings). Keep its existing design (terminal creation, zombie disposal, live-reuse early return, state registration, shell-readiness wait). This plan only **appends** two calls at the tail — it does not restructure the method.

In `launchMcpMonitorTerminal()` (line 20604), after the startup command is sent and before `_postMcpMonitorConfig()`, ensure the loop is running and schedule a one-shot 30-second tick. Replace the tail of the method (lines 20658-20675):

```ts
        // Wait for shell readiness, then send startup command
        const cmd = await this.getAgentStartupCommand('mcp_monitor');
        if (cmd && cmd.trim()) {
            const shellReady = new Promise<void>((resolve) => {
                const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
                    if (e.terminal === terminal) {
                        disposable.dispose();
                        resolve();
                    }
                });
                setTimeout(() => { disposable.dispose(); resolve(); }, 5000);
            });
            await shellReady;
            terminal.sendText(cmd.trim(), true);
        }

        // Ensure the polling loop is running for this freshly launched terminal.
        await this._startMcpMonitorLoop();

        // Send the first monitor prompt ~30s after the startup command so the
        // user sees immediate evidence the automation is working. Claude needs
        // time to boot before it can accept typed input.
        this._scheduleMcpMonitorFirstPrompt();

        // Push updated status to kanban
        await this._postMcpMonitorConfig();
```

### 3. `src/services/TaskViewerProvider.ts` — add the scheduler/cancel helper methods

Add alongside `_startMcpMonitorLoop` / `_stopMcpMonitorLoop` (after `_stopMcpMonitorLoop` ends at line 20500, before `_enqueueMcpMonitorTick` at line 20502):

```ts
    private _scheduleMcpMonitorFirstPrompt() {
        if (this._mcpMonitorFirstPromptTimer) {
            clearTimeout(this._mcpMonitorFirstPromptTimer);
        }
        this._mcpMonitorFirstPromptTimer = setTimeout(() => {
            this._mcpMonitorFirstPromptTimer = undefined;
            this._enqueueMcpMonitorTick();
        }, 30_000);
    }

    private _cancelMcpMonitorFirstPrompt() {
        if (this._mcpMonitorFirstPromptTimer) {
            clearTimeout(this._mcpMonitorFirstPromptTimer);
            this._mcpMonitorFirstPromptTimer = undefined;
        }
    }
```

### 4. `src/services/TaskViewerProvider.ts` — cancel the one-shot when the monitor stops

> **Shared surface / cross-plan coordination.** `_stopMcpMonitorLoop` is also touched by the `stuck-running-status-and-stop-control` sibling (which adds an explicit user-facing Stop control). Both plans extend the same method by **adding** cleanup calls — they compose additively (each adds its own `clearTimeout`/`clearInterval`), but the epic must merge both extensions into one method body rather than letting one plan's edit clobber the other's. Preserve the existing `_mcpMonitorTimer` clearing.

Extend `_stopMcpMonitorLoop()` (line 20495) to also cancel the first-prompt timer:

```ts
    private _stopMcpMonitorLoop() {
        if (this._mcpMonitorTimer) {
            clearInterval(this._mcpMonitorTimer);
            this._mcpMonitorTimer = undefined;
        }
        this._cancelMcpMonitorFirstPrompt();
    }
```

This covers the "user disables MCP monitor" path (which calls `_stopMcpMonitorLoop()` via `setMcpMonitorConfigFromKanban` → `_startMcpMonitorLoop`'s `if (!cfg.enabled) { this._stopMcpMonitorLoop(); return; }` branch at lines 20484-20487).

### 5. `src/webview/kanban.html` — update help text to mention the 30s first prompt

> **Shared surface.** The kanban.html MCP-monitor UI block (AUTOMATION tab, help text at line 7729, launch button at 7713-7722, status line at 7706-7724) is coordinated at the epic level — the `rename-display-labels`, `editable-prompt-preview`, `stuck-running-status-and-stop-control`, and `dedicated-tab` siblings all edit this same block. This plan only rewrites the `mcpHelp.textContent` copy string; keep the surrounding DOM construction as-is. If `rename-display-labels` rewrites this copy too, the epic must reconcile a single final wording rather than double-editing.

Update the help text at line 7729 (currently the "How it works: every selected interval…" string) so the user knows a first prompt is coming shortly after launch, and that the diff baseline survives restarts:

```js
            mcpHelp.textContent = 'How it works: when you launch the monitor terminal, Switchboard sends the first check prompt about 30 seconds after Claude starts up (so you can see it working right away). The first check covers the past 24 hours; every check after that reports only what is new since the previous check. The baseline is saved to disk, so it survives terminal clears, Claude restarts, and IDE reloads. The monitor re-checks every selected interval, asking your terminal to check the selected sources (Slack, Gmail, Google Calendar, or a custom instruction) via your claude.ai MCP servers. The terminal reports what\'s new in its pane.';
```

---

## Phase 2: Persistent `lastCheckAt` diff baseline

The one-shot (Phase 1) makes the first prompt reliable. This phase makes the *diff chain* reliable by moving the "since previous check" baseline out of Claude's session memory and onto disk, then injecting it explicitly into every prompt.

### 6. `src/services/GlobalIntegrationConfigService.ts` — add `lastCheckAt` to the config schema

> **Shared surface / cross-plan coordination.** The `McpMonitorConfig` schema (interface at line 39) plus the `GlobalConfig.mcpMonitor` shape (line 15), the two read accessors (`getMcpMonitorConfigSync` line 221, `getMcpMonitorConfig` line 233), and the `setMcpMonitorConfig` merge block (lines 248-254) are a shared surface. The `per-source-intervals` sibling adds its own fields (per-source interval map) to the **same** interface and the **same** merge object literal. Both plans' additions are purely additive, but the epic must merge them into one interface + one merge block. `lastCheckAt` must stay OUT of `DEFAULT_MCP_MONITOR_CONFIG` (line 47) so it defaults to `undefined`.

Add the optional field to both the persisted shape and the typed config. In `GlobalConfig.mcpMonitor` (line 15) and `McpMonitorConfig` (line 39):

```ts
    mcpMonitor?: {
        enabled?: boolean;
        intervalMinutes?: number;
        targetRole?: string;
        sources?: string[];
        customInstruction?: string;
        lastCheckAt?: string;   // ISO UTC timestamp of the last successful monitor prompt send
    };
```

```ts
export interface McpMonitorConfig {
    enabled: boolean;
    intervalMinutes: number;
    targetRole: string;
    sources: string[];
    customInstruction: string;
    lastCheckAt?: string;   // ISO UTC, undefined until the first successful send
}
```

### 7. `src/services/GlobalIntegrationConfigService.ts` — read/write `lastCheckAt` through the config accessors

In `getMcpMonitorConfigSync` (line 221) and `getMcpMonitorConfig` (line 233), add the field to the returned object:

```ts
            lastCheckAt: cfg.lastCheckAt,
```

In `setMcpMonitorConfig` (line 245), add it to the merged write so partial updates preserve it:

```ts
        globalConfig.mcpMonitor = {
            enabled: config.enabled ?? current.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            intervalMinutes: Math.max(config.intervalMinutes ?? current.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: config.targetRole ?? current.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: config.sources ?? current.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: config.customInstruction ?? current.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            lastCheckAt: config.lastCheckAt ?? current.lastCheckAt,
        };
```

Note: `lastCheckAt` is intentionally **not** in `DEFAULT_MCP_MONITOR_CONFIG` — it should be `undefined` (not a stale default) until the first successful send.

### 8. `src/services/TaskViewerProvider.ts` — inject the timestamp into the prompt text

> **Shared surface — coordinate at epic level, do not unilaterally redesign.** `_buildMcpMonitorPrompt` (line 20552) is the single prompt-construction surface for the monitor and is also targeted by the `editable-prompt-preview` sibling (which makes the prompt user-editable/previewable). This plan's change is a **minimal, backward-compatible edit**: it only swaps the hard-coded `since your previous check` phrase in the preamble for a computed `boundary` variable, preserving the rest of the method (source-preset loop, `custom` handling, empty-guard, `normalizeNewlines`) verbatim. **Cross-plan reconciliation required:** if `editable-prompt-preview` turns the preamble into a stored/editable template, the dynamic `${boundary}` must be injected into that template (e.g. via a `{{since}}` placeholder or by prepending the boundary line) rather than hard-coded here — otherwise the editable prompt and the persisted baseline will silently diverge. Flag to the epic synthesizer; do not merge the two designs in this pass.

Replace the fixed preamble in `_buildMcpMonitorPrompt` (line 20553, the `const preamble = ...` literal) with a boundary-aware one. The method already receives `cfg`; it now reads `cfg.lastCheckAt`:

```ts
    private _buildMcpMonitorPrompt(cfg: McpMonitorConfig): string {
        const boundary = cfg.lastCheckAt
            ? `since ${new Date(cfg.lastCheckAt).toUTCString()}`
            : 'in the past 24 hours';
        const preamble = `Check the following for anything new that needs my attention ${boundary}. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything.`;
        const lines: string[] = [];
        const sources = cfg.sources || [];
        for (const src of sources) {
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

### 9. `src/services/TaskViewerProvider.ts` — persist `lastCheckAt` on successful send

In `_mcpMonitorTick` (the `try { ... } finally { ... }` block at lines 20540-20549), write the timestamp *after* `sendRobustText` succeeds. The write sits inside the `try` (so a failed send does not advance the baseline), and the `finally` still resets `_mcpMonitorInFlight`:

```ts
        this._mcpMonitorInFlight = true;
        try {
            const prompt = this._buildMcpMonitorPrompt(cfg);
            if (prompt) {
                await sendRobustText(terminal, prompt, true);
                this._mcpMonitorLastSendAt = Date.now();
                await GlobalIntegrationConfigService.setMcpMonitorConfig({
                    lastCheckAt: new Date().toISOString()
                });
            }
        } finally {
            this._mcpMonitorInFlight = false;
        }
```

## Verification Plan

1. **Build:** `npm run compile` (webpack) succeeds with no type errors. Note: `dist/` is not used during dev/testing per project rules — verification is via installed VSIX.
2. **Manual — first prompt appears:**
   - Open the Switchboard kanban panel → AUTOMATION tab.
   - Enable MCP Monitor (select "on"), pick at least one source (e.g. Slack), set interval to 1 minute for faster iteration.
   - Click *Launch Monitor Terminal*.
   - Observe: terminal opens, `claude` startup command is sent.
   - **Within ~30 seconds**, the first check prompt is typed into the monitor terminal pane (visible text). This is the fix — previously nothing appeared for 5 minutes.
3. **Manual — disable cancels first prompt:**
   - Launch the monitor terminal, then within the 30s window switch MCP Monitor to "off".
   - Confirm no prompt is sent after the 30s mark (the one-shot was cancelled by `_stopMcpMonitorLoop`).
4. **Manual — terminal dies during window:**
   - Launch the monitor terminal, then close/kill the terminal within the 30s window.
   - Confirm no error is thrown (the `_mcpMonitorTick` dead-terminal guard returns early) and no crash occurs.
5. **Manual — subsequent interval still works:**
   - After the first 30s prompt, confirm the regular interval (e.g. 1 min) continues to send subsequent prompts on schedule.
6. **Manual — first prompt says "past 24 hours":**
   - Delete `~/.switchboard/integration-config.json` (or remove the `mcpMonitor.lastCheckAt` key) to simulate a first-ever run.
   - Launch the monitor terminal and wait for the 30s prompt.
   - Confirm the prompt text in the terminal contains "in the past 24 hours" (not "since <timestamp>").
7. **Manual — subsequent prompt says "since <timestamp>":**
   - After the first successful send, inspect `~/.switchboard/integration-config.json` and confirm `mcpMonitor.lastCheckAt` is now an ISO string.
   - Wait for the next interval tick. Confirm the prompt text contains "since <UTC timestamp>" matching the persisted value.
8. **Manual — baseline survives Claude restart (the core Phase 2 fix):**
   - Let the monitor run at least one successful tick so `lastCheckAt` is persisted.
   - Clear the terminal / restart Claude in the monitor pane (simulating a session reset).
   - Wait for the next interval tick. Confirm the prompt still says "since <timestamp>" (read from disk), NOT "past 24 hours". Claude reports only the delta since the persisted timestamp, not a full 24h re-scan.
9. **Manual — baseline survives IDE reload:**
   - Let the monitor run one tick, then reload the VS Code window (Developer → Reload Window).
   - Re-enable the monitor if needed, wait for the next tick. Confirm the prompt uses the persisted `lastCheckAt` boundary.
10. **Manual — failed send does not advance baseline:**
    - With the monitor running, kill the terminal mid-interval so the next tick's `sendRobustText` targets a dead terminal (the dead-terminal guard at line 20432 returns early before the send).
    - Inspect `~/.switchboard/integration-config.json` — `lastCheckAt` should be unchanged (the write only happens after a successful send).
    - Relaunch the terminal; the next prompt should cover the window since the *last successful* send, not since the failed tick.
11. **Regression:** Existing automation-engine (autoban) behavior and other agent-grid terminal launches are unaffected — changes are scoped to the MCP monitor path. The `setMcpMonitorConfig` signature change is additive (`lastCheckAt` optional), so existing callers in `kanban.html` and `KanbanProvider.ts` that pass partial config are unaffected.
