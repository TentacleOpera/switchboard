# MCP Monitor improvements

**Complexity:** 6

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [MCP Monitor: First Prompt 30s After Startup + Persistent Diff Baseline](../plans/feature_plan_20260703130618_mcp-monitor-first-prompt-after-startup.md) — **CREATED**
- [ ] [Comms Monitor: Editable Prompt Preview with Timestamps, Channels, and DM/Channel Differentiation](../plans/feature_plan_20260703131419_comms-monitor-editable-prompt-preview.md) — **CREATED**
- [ ] [Rename "MCP Monitor" to "Comms Monitor" (Display Labels Only)](../plans/feature_plan_20260703131420_comms-monitor-rename-display-labels.md) — **CREATED**
- [ ] [Comms Monitor: Highlight Claude Dependency and Haiku Model in UI](../plans/feature_plan_20260703131421_comms-monitor-claude-dependency-haiku-highlight.md) — **CREATED**
- [ ] [Comms Monitor: Apply Source Changes Immediately Without Terminal Restart](../plans/feature_plan_20260703131937_comms-monitor-apply-source-changes-immediately.md) — **CREATED**
- [ ] [Move Comms Monitor to a Dedicated COMMS Tab](../plans/feature_plan_20260703132122_comms-monitor-dedicated-tab.md) — **CREATED**
- [ ] [Comms Monitor: Fix Stuck "Running" Status and Add Stop/Disable Controls](../plans/feature_plan_20260703133016_comms-monitor-stuck-running-status-and-stop-control.md) — **CREATED**
- [ ] [Comms Monitor: Separate Terminal Creation, Auth Check, and Polling Start](../plans/feature_plan_20260703134515_comms-monitor-separate-terminal-auth-polling.md) — **CREATED**
- [ ] [Comms Monitor: Per-Source Intervals](../plans/feature_plan_20260703140531_comms-monitor-per-source-intervals.md) — **CREATED**
- [ ] [Comms Monitor: Remove dontAsk Permission Mode from Startup Command](../plans/feature_plan_20260703142159_comms-monitor-remove-dontask-permission-mode.md) — **CREATED**
<!-- END SUBTASKS -->

---

**Plan ID:** 643b487f-15a9-457f-b625-d1db2f2e434a

## Goal

Take the "Comms Monitor" (currently named "MCP Monitor" in the UI) from a feature that *appears* broken to one that is legible, controllable, and trustworthy. Today a user launches the monitor terminal, sees "🟢 running", and then… nothing visible happens for up to 5 minutes; the diff baseline lives only in Claude's session memory and silently resets; there is no stop button and the status sticks on green after the terminal dies; the prompt is invisible and uneditable; and Calendar checks fail silently because `dontAsk` suppresses the permission prompt. This epic's 10 subtasks collectively fix the lifecycle, the controls, the prompt, and the naming.

## How the Subtasks Achieve This

The subtasks group into four themes:

- **Lifecycle & reliability** — *first-prompt-after-startup* (send the first check ~30s after launch + persist the diff baseline to disk), *apply-source-changes-immediately* (config changes take effect on the next tick without a restart), *stuck-running-status-and-stop-control* (flip status to 🔴 when the terminal dies, add a Stop button, stop the loop), and *separate-terminal-auth-polling* (split the one-shot "Launch" into Start Terminal → Check Auth → Start Polling so polling never runs before auth is verified).
- **Prompt quality & control** — *editable-prompt-preview* (render the exact prompt, make it editable, enrich Slack/Gmail with timestamps, channels, DM/channel differentiation) and *per-source-intervals* (each source gets its own polling cadence via a GCD timer with due-source filtering).
- **Setup legibility** — *claude-dependency-haiku-highlight* (surface the `claude` + MCP-server prerequisite and the Haiku model/cost) and *remove-dontask-permission-mode* (let permission-gated servers like Calendar prompt in the terminal the user is watching).
- **Information architecture & naming** — *dedicated-tab* (move the monitor out of the AUTOMATION tab into its own COMMS tab) and *rename-display-labels* (display-only "MCP Monitor" → "Comms Monitor", internal `mcp_monitor` key unchanged).

## Dependencies & sequencing

The subtasks are **not independent** — they converge on a small set of shared surfaces, so order matters. Verified against current source (symbols are the stable anchors; the plans' cited line numbers have drifted): `src/services/TaskViewerProvider.ts` (`_buildMcpMonitorPrompt`, `_startMcpMonitorLoop`/`_mcpMonitorTick`, `launchMcpMonitorTerminal`, `handleTerminalClosed`, the `'MCP Monitor'` terminal-name literal), `src/services/GlobalIntegrationConfigService.ts` (`McpMonitorConfig`), and the monitor UI block in `src/webview/kanban.html`.

Recommended order:

1. **Low-risk on-ramp (parallel-safe):** *remove-dontask* (isolated one-liner) and *rename-display-labels* (best paired with extracting a single `MCP_MONITOR_TERMINAL_NAME` constant, since the literal is a lookup key several subtasks add call sites to).
2. **Structure first:** *dedicated-tab* — it relocates the UI block that six other subtasks edit, so doing it early means those subtasks target the new home rather than being swept later. Land the union of `McpMonitorConfig` schema changes once here.
3. **Backend lifecycle as one coordinated change:** *separate-terminal-auth-polling* (introduces `pollingEnabled`), then *per-source-intervals* (GCD timer; supersedes the single interval and folds in the persistent baseline), then *first-prompt* (one-shot now scheduled from start-polling), then *apply-source-changes* and *stuck-running*. These rewrite the same three methods, so they must be merged against one agreed shape — not stacked.
4. **Prompt + UI polish last:** *editable-prompt-preview* (defines the final `_buildMcpMonitorPrompt` shape) and *claude-dependency-haiku-highlight*.

A detailed cross-plan inconsistency report and a proposed consolidation (which subtasks to merge/rewrite) is maintained separately during epic review and applied only on explicit approval — see the review summary. The subtask `.md` set is not altered without that approval.

## Metadata

- **Tags:** refactor, ux, bugfix, reliability, frontend, backend, feature
- **Complexity:** 7
- **Repo:** switchboard

## Epic reconciliation — merged end-state

Produced by running improve-plan across all 10 subtasks and reconciling their overlaps. This section is the **authoritative merged design** for the surfaces multiple subtasks contend; a coder must implement to this, not to any single subtask's isolated version.

**Consolidation applied.** The four backend-lifecycle subtasks (first-prompt-after-startup, apply-source-changes-immediately, separate-terminal-auth-polling, per-source-intervals) that all rewrote the same three methods + config have been **merged into one clean-break plan** (`feature_plan_20260703160000_comms-monitor-lifecycle-polling-consolidated.md`) and the four originals removed. Six subtasks remain: that consolidated plan plus rename-display-labels, dedicated-tab, claude-dependency-haiku-highlight, remove-dontask-permission-mode, stuck-running-status-and-stop-control, and editable-prompt-preview.

### Genuine bugs caught during reconciliation (fix regardless of ordering)
1. **per-source-intervals kills the loop on current `main`.** Its guard `if (!cfg.pollingEnabled)` reads a field that doesn't exist yet → `undefined` → the monitor stops on startup. Must use `cfg.pollingEnabled ?? cfg.enabled` until `pollingEnabled` lands.
2. **Config accessors drop fields.** `getMcpMonitorConfigSync`, `DEFAULT_MCP_MONITOR_CONFIG`, and the inline `GlobalConfig.mcpMonitor` type must be updated alongside `getMcpMonitorConfig`/`setMcpMonitorConfig`, or new fields are silently lost / the build breaks.
3. **dedicated-tab must extract by identifier, never by line range.** The monitor UI is non-contiguous and interleaved with the autoban engine in `createAutobanPanel`; a range delete destroys automation. Verify with grep after extraction.
4. **haiku-highlight's model-indicator test must assert the command *shape*** (`--model claude-haiku-4-5`), not the exact fallback string, which remove-dontask edits.

### Merged `_buildMcpMonitorPrompt` (contended by first-prompt, editable-preview, per-source)
Single signature: `_buildMcpMonitorPrompt(cfg, opts?: { dueSources?: string[]; })`. Compose in order:
1. If `cfg.promptOverride?.trim()` → return it verbatim (editable-preview).
2. Boundary from per-source `sourceLastCheckAt` for the sources in play (first-prompt + per-source), fallback "in the past 24 hours".
3. Iterate `opts?.dueSources ?? cfg.sources`; render Slack/Gmail via the parameterized helpers (editable-preview), others via presets.
4. Persist `sourceLastCheckAt` for the included sources on successful send only — this **supersedes** first-prompt's global `lastCheckAt` (kept only as a read-compat fallback).

### Single `McpMonitorConfig` schema (land once, clean break)
The consolidated plan owns the lifecycle fields (`pollingEnabled`, `sourceIntervals`, `sourceLastCheckAt`); `editable-prompt-preview` adds `promptOverride`, `slackChannels`, `slackDmOnly`, `slackChannelOnly`, `gmailLabel`. **No** legacy `intervalMinutes`/`lastCheckAt`/`enabled`-fallback shims (unreleased). Update every accessor together — `getMcpMonitorConfig`, `getMcpMonitorConfigSync`, `setMcpMonitorConfig`, and `DEFAULT_MCP_MONITOR_CONFIG` — keeping the `?? current.X` merge so partial writes preserve fields.

### Terminal-name constant
Extract `MCP_MONITOR_TERMINAL_NAME` (one definition) and route all creation + lookup sites through it — `_mcpMonitorTick`, `_isMcpMonitorTerminalRunning`, the new `handleTerminalClosed`/stop/auth lookups (stuck-running, separate-terminal), plus the `matchesGridAgentName` path in `extension.ts`. rename-display-labels changes the value in that one place. A missed site = monitor silently unfindable.

### One-shot ownership + timer lifecycle
The 30s first-prompt one-shot lives in `startMcpMonitorPolling` (separate-terminal owns the split), **not** in `launchMcpMonitorTerminal` (resolves the first-prompt contradiction). All immediate-tick paths funnel through `_enqueueMcpMonitorTick`. `_stopMcpMonitorLoop` gets one consolidated cleanup block cancelling every timer (first-prompt one-shot, apply-source coalesce timer, interval) — not three colliding edits.

### Upgrade behavior — RESOLVED (no migration)
The Comms Monitor is unreleased dev work, so the consolidated plan takes a **clean break**: no `enabled → pollingEnabled` compat shim, no legacy `intervalMinutes`/`lastCheckAt` mapping. `pollingEnabled` defaults to `false`; there is no install base to auto-resume, so the earlier auto-resume concern is moot.

### Sequence
Wave 0 (parallel): remove-dontask; rename + terminal-name constant. Wave 1: dedicated-tab (relocates the UI block 7 siblings edit — must precede UI polish); land the unified config schema. Wave 2 (one coordinated backend change): separate-terminal → per-source → first-prompt → apply-source → stuck-running. Wave 3: editable-preview (owns final prompt-builder shape) → haiku-highlight.
