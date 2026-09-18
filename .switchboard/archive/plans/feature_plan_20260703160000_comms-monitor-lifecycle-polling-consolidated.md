# Comms Monitor: Lifecycle, Polling & Per-Source Scheduling (consolidated)

**Plan ID:** eca1c367-7b28-48ef-b107-5795bad66707

## Goal

Rebuild the Comms Monitor's backend lifecycle as one coherent unit: a **three-step launch** (Start Terminal → Check Auth → Start Polling), a **per-source polling scheduler** (each source has its own interval), a **reliable first check** ~30s after polling starts, a **persistent per-source diff baseline**, and **immediate application of config changes** without a terminal restart.

This plan **consolidates four subtasks** that all rewrote the same three methods (`_startMcpMonitorLoop`, `_mcpMonitorTick`, `_buildMcpMonitorPrompt`) and the same config interface (`McpMonitorConfig`) with mutually incompatible designs:

- *first-prompt-after-startup* — 30s one-shot + persistent diff baseline
- *apply-source-changes-immediately* — coalesced immediate tick on config change
- *separate-terminal-auth-polling* — split launch into terminal/auth/polling with a `pollingEnabled` gate
- *per-source-intervals* — GCD timer + per-source due-checking

They are merged here so there is a single authoritative implementation of each shared surface. (The three superseded companion plans and this one's predecessors have been removed; `editable-prompt-preview` remains separate and layers prompt-override + Slack/Gmail parameterization on top of the `_buildMcpMonitorPrompt` skeleton defined here.)

### Problem Analysis & Root Cause

Confirmed against current source (`src/services/TaskViewerProvider.ts`, symbols are the stable anchors):

- `launchMcpMonitorTerminal` (≈20604) creates the terminal and sends the startup command but **never starts the loop or schedules a first tick** → the "🟢 running but nothing happens for 5 minutes" symptom, and polling begins before the user can verify Claude auth / MCP servers.
- `_startMcpMonitorLoop` (≈20482) gates on `cfg.enabled` and builds one `setInterval` from a single `cfg.intervalMinutes`; `setInterval` doesn't fire immediately, and there is no per-source cadence.
- `_mcpMonitorTick` (≈20512) has an in-flight guard + secondary debounce and finds the terminal via the `'MCP Monitor'` literal; it sends every configured source on every tick.
- `_buildMcpMonitorPrompt` (≈20552) emits a fixed preamble with **no timestamp** — the "since previous check" boundary lives only in Claude's session memory and silently resets.
- Config changes (`setMcpMonitorConfigFromKanban` ≈20573) persist but trigger no immediate tick, so a source toggle appears to do nothing until the next interval.

**Clean break (no migration):** the Comms Monitor is unreleased dev work, so this plan changes the config shape freely — no compat shims, no legacy-field fallbacks.

## Metadata

- **Tags:** backend, feature, reliability, ux, bugfix
- **Complexity:** 7
- **Repo:** switchboard
- **Consolidates:** first-prompt-after-startup, apply-source-changes-immediately, separate-terminal-auth-polling, per-source-intervals

## User Review Required

- **Three-step launch replaces one-click "Launch".** Start Terminal → Check Auth (non-blocking diagnostic, no confirm gate) → Start Polling. Confirm this is the intended UX (it is the merged intent of the four source plans).
- **`_buildMcpMonitorPrompt` skeleton ownership.** This plan defines the final signature `_buildMcpMonitorPrompt(cfg, opts?: { dueSources?: string[] })`; the surviving `editable-prompt-preview` plan layers `promptOverride` + parameterized Slack/Gmail lines on top. Confirm that split.

## Complexity Audit

### Routine
- Additive config fields and accessors (`pollingEnabled`, `sourceIntervals`, `sourceLastCheckAt`) — clean shape, no migration.
- Three UI buttons replacing one, following existing button/guard patterns in `kanban.html`.
- Non-blocking auth-check prompt (same `sendRobustText` path as a normal tick).

### Complex / Risky
- **Single rewrite of `_startMcpMonitorLoop` + `_mcpMonitorTick`** into a GCD timer with per-source due-checking gated on `pollingEnabled`. This is the load-bearing change; it must be correct because it replaces the entire polling engine.
- **One consolidated `_stopMcpMonitorLoop` cleanup block** cancelling every timer (interval, 30s one-shot, config-change coalesce) — the three source plans each added their own `clearTimeout` here; here they are one block.
- **`_buildMcpMonitorPrompt` skeleton** shared with the separate `editable-prompt-preview` plan (sequence this first; that one layers on top).

## Edge-Case & Dependency Audit

### Race Conditions
- All immediate-tick paths (30s one-shot, config-change coalesce) funnel through `_enqueueMcpMonitorTick` (≈20502), which serializes on `_mcpMonitorTickQueue`; combined with the in-flight guard this prevents interleaving with an interval tick.
- The config-change coalesce resets `_mcpMonitorLastSendAt = 0` only on that path so its intentional immediate prompt isn't eaten by the secondary debounce — never reset globally.
- Per-source `sourceLastCheckAt` is written only for sources actually included in a successful send, after `sendRobustText` resolves (a failed send does not advance the baseline).

### Security
- Auth-check and monitor prompts are read-only by construction ("do NOT take any actions"). Tool scope is unchanged (`--allowedTools "mcp__*"`). No secrets touched.

### Side Effects
- Per-tick writes to `~/.switchboard/integration-config.json` for `sourceLastCheckAt` are small and low-frequency; no throttling needed.
- `pollingEnabled` is a clean new gate; `enabled` (if kept at all) means only config-panel visibility. No install-base impact — unreleased.

### Dependencies & Conflicts
- **Terminal-name literal** `'MCP Monitor'` is a lookup key; coordinate with the surviving `rename-display-labels` plan by routing all creation + lookup sites through a single `MCP_MONITOR_TERMINAL_NAME` constant.
- **Status-line UI** (the three-button flow) shares the `kanban.html` monitor block with `stuck-running-status-and-stop-control` (Stop button) and is relocated by `dedicated-tab` — sequence `dedicated-tab` first.
- **`_buildMcpMonitorPrompt`** shared with `editable-prompt-preview` (layers on top).
- **`_stopMcpMonitorLoop`** is called by `stuck-running-status-and-stop-control` (terminal-close hook) — no signature change here, so that plan just calls it.

## Dependencies

None external (`sess_…`). Internal ordering: land after `dedicated-tab` (UI relocation) and the `MCP_MONITOR_TERMINAL_NAME` constant (with `rename-display-labels`); land before `editable-prompt-preview` (which extends this plan's prompt-builder skeleton).

## Adversarial Synthesis

**Key risks:** (1) the GCD-timer + due-check rewrite is the whole polling engine — a wrong due-comparison silently under- or over-polls; (2) the three merged immediate-tick paths must all serialize through `_enqueueMcpMonitorTick` or they race an interval tick; (3) the prompt-builder skeleton is shared with `editable-prompt-preview`. **Mitigations:** single owner for the timer/tick rewrite (this plan); one consolidated `_stopMcpMonitorLoop` cleanup; funnel every tick through the queue; define the builder signature here and have the preview plan layer on top. No migration risk (unreleased).

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — clean config shape
`McpMonitorConfig` (no compat shims):
```ts
export interface McpMonitorConfig {
    enabled: boolean;                 // config-panel visibility only
    pollingEnabled: boolean;          // the loop gate
    targetRole: string;
    sources: string[];
    customInstruction: string;
    sourceIntervals: Record<string, number>;    // per-source minutes, e.g. { slack: 2, gmail: 30 }
    sourceLastCheckAt: Record<string, string>;   // per-source ISO UTC baseline
}
```
Update **all** accessors together — `getMcpMonitorConfig`, `getMcpMonitorConfigSync`, `setMcpMonitorConfig` (keep the `?? current.X` merge so partial writes preserve fields), and `DEFAULT_MCP_MONITOR_CONFIG` (`pollingEnabled: false`, `sourceIntervals: { slack: 5, gmail: 5, gcal: 5, custom: 5 }`, `sourceLastCheckAt: {}`). No legacy `intervalMinutes`/`lastCheckAt`/`enabled`-fallback.

### 2. `src/services/TaskViewerProvider.ts` — GCD timer gated on `pollingEnabled`
Rewrite `_startMcpMonitorLoop` to no-op unless `cfg.pollingEnabled`, compute the timer period as the GCD of active sources' intervals, and `setInterval(_enqueueMcpMonitorTick, gcd*60_000)`. Add a `_gcd(number[])` helper. Stop the loop if no sources are active.

### 3. `src/services/TaskViewerProvider.ts` — due-source tick
Rewrite `_mcpMonitorTick`: gate on `pollingEnabled`, resolve the terminal via `MCP_MONITOR_TERMINAL_NAME`, keep the in-flight guard, compute `dueSources` (those whose `now - sourceLastCheckAt[src] >= sourceIntervals[src]*60_000`), no-op if none due, build the prompt for `dueSources`, send, then persist `sourceLastCheckAt` for the sent sources only.

### 4. `src/services/TaskViewerProvider.ts` — prompt-builder skeleton
`_buildMcpMonitorPrompt(cfg, opts?: { dueSources?: string[] })`: boundary from the relevant `sourceLastCheckAt` (fallback "in the past 24 hours"); iterate `opts?.dueSources ?? cfg.sources`. This is the skeleton; `editable-prompt-preview` adds the `promptOverride` short-circuit and parameterized Slack/Gmail lines.

### 5. `src/services/TaskViewerProvider.ts` — three-step lifecycle
- `launchMcpMonitorTerminal`: create terminal + send startup command only — **no** loop start, **no** one-shot.
- `checkMcpMonitorAuth()`: send a read-only diagnostic prompt listing the configured sources; non-blocking, no confirm gate.
- `startMcpMonitorPolling()`: set `pollingEnabled: true`, start the loop, and schedule the **30s one-shot** first prompt here (via `_enqueueMcpMonitorTick`). `stopMcpMonitorPolling()`: set `pollingEnabled: false`, stop the loop.
- `setMcpMonitorConfigFromKanban`: after persisting, schedule a **coalesced (500ms) config-change tick** (resetting `_mcpMonitorLastSendAt = 0` on that path only) so source toggles apply on the next tick without a restart.
- `_stopMcpMonitorLoop`: **one** cleanup block clearing the interval, the 30s one-shot timer, and the config-change coalesce timer.

### 6. `src/services/{extension.ts, KanbanProvider.ts}` — commands + messages
Register `switchboard.{checkMcpMonitorAuth,startMcpMonitorPolling,stopMcpMonitorPolling}` and the matching kanban message cases.

### 7. `src/webview/kanban.html` — three-button control + per-source interval dropdowns
Replace the single Launch button with Start Terminal / Check Authentication / Start-Stop Polling (shown conditionally on terminal + polling state; all act immediately, no confirm gates). Add a per-source interval dropdown next to each source checkbox; `saveMonitorConfig` sends `sourceIntervals`. (Renders in whichever tab `dedicated-tab` places the monitor.)

## Verification Plan

### Automated Tests
- `npm run compile` (webpack) passes with no type errors after the config-shape change (the type gate for the interface + all accessors).
- **Config unit:** `DEFAULT_MCP_MONITOR_CONFIG` includes `pollingEnabled:false`, `sourceIntervals`, `sourceLastCheckAt`; `setMcpMonitorConfig` partial writes preserve unspecified fields.
- **Timer unit (via seam):** with `pollingEnabled:false` no `setInterval` is armed; with two sources at 2m and 30m the period is 2m (GCD); a second `_startMcpMonitorLoop` clears the prior timer (no leak).
- **Due-check unit:** only sources past their per-source interval appear in `dueSources`; `sourceLastCheckAt` advances only for sent sources.

### Manual smoke
Start Terminal (no polling yet) → Check Auth (diagnostic prompt appears) → Start Polling (first prompt within ~30s) → toggle a source (applies within ~1s, no restart) → set Slack 2m / Gmail 30m (Slack-only prompts between, all-source prompt at 30m) → Stop Polling (loop stops, terminal stays) → kill terminal (status 🟢→🔴).

## Recommendation

**Send to Lead Coder.** Complexity **7**: this replaces the entire polling engine (GCD timer + due-checking) and the launch lifecycle in one coordinated change. The migration risk that previously inflated this work is gone (unreleased clean break), but the timer/tick correctness and the single-owner discipline over the shared `_buildMcpMonitorPrompt` / `_stopMcpMonitorLoop` surfaces still warrant a senior owner.

## Review Findings

**Files changed:** `src/webview/kanban.html` (sourceIntervals fix — applied in Plan 4 review), `src/services/TaskViewerProvider.ts` (pollingEnabled reset on terminal death — applied in Plan 5 review; per-source boundary fix — applied in Plan 1 review). **Validation:** GCD timer computes correct period from active sources' intervals; due-source filtering checks `now - sourceLastCheckAt[src] >= sourceIntervals[src]*60_000`; three-step launch (terminal → auth → polling) correctly separates concerns; 30s one-shot lives in `startMcpMonitorPolling` not `launchMcpMonitorTerminal`; config-change coalesce (500ms) funnels through `_enqueueMcpMonitorTick`; `_stopMcpMonitorLoop` clears all three timers (interval, one-shot, coalesce); `sourceLastCheckAt` persisted only for sent sources on successful send; `sourceIntervals` now persisted via `saveMonitorConfig` (was missing — fixed in Plan 4); `pollingEnabled` reset on terminal death (was missing — fixed in Plan 5). **Remaining risks:** `_mcpMonitorLastSendAt` field is dead code (set but never read — NIT, harmless); the `_mcpMonitorTimer` clear-then-reassign in `_startMcpMonitorLoop` doesn't null the reference between clear and new assignment (theoretical only in single-threaded JS).
