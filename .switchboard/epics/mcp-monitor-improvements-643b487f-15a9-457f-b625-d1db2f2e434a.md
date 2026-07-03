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

<!-- BEGIN IMPROVE-PLAN (epic coordination layer) -->

**Plan ID:** 643b487f-15a9-457f-b625-d1db2f2e434a

## Goal

Coordinate the 10 Comms Monitor (formerly "MCP Monitor") subtasks into a single, conflict-free execution program. Each subtask is individually well-specified and self-contained, but they are **not independent**: at least three of them rewrite the *same* method (`_buildMcpMonitorPrompt`), three touch the same gating flag/timer (`_startMcpMonitorLoop` / `_mcpMonitorTick`), four extend the same config interface (`McpMonitorConfig`), and every UI subtask targets the same block of `kanban.html`. Applied naïvely in filename order they will produce merge conflicts, superseded designs re-introduced, and a terminal-name lookup that silently stops matching. This epic layer defines the ordering, the merge points, and the invariants that keep the subtasks from stepping on each other.

### Core problem & root-cause context (why this coordination is needed)

All 10 subtasks orbit three source files:

- `src/services/TaskViewerProvider.ts` — the monitor lifecycle, timer, tick, and prompt builder.
- `src/services/GlobalIntegrationConfigService.ts` — the `McpMonitorConfig` schema + accessors.
- `src/webview/kanban.html` — the monitor UI (currently inside `createAutobanPanel`).

Confirmed against current source (line numbers have drifted from what the subtasks cite; **symbols are the stable anchors**, not line numbers):

- `_startMcpMonitorLoop` (now ~`20482`) gates on `cfg.enabled` and builds one `setInterval` from a single `cfg.intervalMinutes`. `setInterval` does not fire immediately → the "no first prompt for 5 minutes" symptom.
- `_mcpMonitorTick` (now ~`20512`) has an in-flight guard and a secondary debounce (`intervalMs * 0.5`); it finds the terminal by the literal `'MCP Monitor'`.
- `_buildMcpMonitorPrompt` (now ~`20552`) emits a **fixed** preamble ("…since your previous check…") with no injected timestamp and no per-source parameterization.
- `launchMcpMonitorTerminal` (now ~`20604`) creates the terminal and sends the startup command but **never** starts the loop or schedules a first tick.
- `handleTerminalClosed` (now ~`16006`) never notifies the monitor webview → the "stuck 🟢 running" symptom.

Because these are the exact surfaces the subtasks rewrite, the epic's job is to say **in what order** and **against which merged shape** each subtask lands.

## Metadata

- **Tags:** refactor, ux, bugfix, reliability, frontend, backend, feature
- **Complexity:** 7
- **Repo:** switchboard

## User Review Required

- **Ship as one coordinated change or as a sequence of small PRs?** The backend trio (separate-terminal, per-source-intervals, first-prompt/baseline) rewrite the same three methods with incompatible diffs. Recommendation: land them as one coordinated backend change (or in the strict order below with a rebase between each), **not** as three parallel branches.
- **Does `enabled` → `pollingEnabled` (subtask 8) count as shipped state that needs migration?** Per CLAUDE.md, `mcpMonitor.enabled` shipped in a released version. The plan uses a read-time compat shim (`pollingEnabled ?? enabled ?? false`), which is correct — confirm this is acceptable rather than a file migration.
- **Is auto-moving the epic card to PLAN REVIEWED desired?** This review emits a remote plan-import manifest that requests the transition; the stale-guard means it only applies if the card is still at CREATED.

## Complexity Audit

### Routine
- Subtask 10 (remove `--permission-mode dontAsk`) — one-line fallback-string change, no shared surface, zero ordering constraints.
- Subtask 3 (display-only rename) — string replacements; the only subtlety is the shared terminal-name literal (addressed by the constant extraction below).
- Subtask 4 (dependency + Haiku indicator) — additive UI + one additive field on the config push message.

### Complex / Risky
- **Shared-method collision on `_buildMcpMonitorPrompt`.** Subtasks 1, 2, and 9 each rewrite this method with a *different* signature (boundary injection; `promptOverride` + parameterized Slack/Gmail lines; a `dueSources?` parameter + filtering). Applied independently, the last one to merge silently discards the others' logic.
- **Shared gating flag + timer.** Subtask 8 replaces the `enabled` loop-gate with `pollingEnabled`; subtask 9 replaces the single `setInterval` with a GCD timer + per-source due-checking; subtasks 1 and 5 add one-shot/coalesced ticks. All four edit `_startMcpMonitorLoop` and/or `_mcpMonitorTick`.
- **Superseded config fields.** Subtask 1 adds a global `lastCheckAt`; subtask 9 replaces it with per-source `sourceLastCheckAt` and deprecates `intervalMinutes`. If 1 ships as-written and 9 ships later, 9 must fold 1's persistence logic into the per-source path — not sit beside it.
- **Terminal-name lookup drift.** The literal `'MCP Monitor'` is a *lookup key* in `_mcpMonitorTick` and `_isMcpMonitorTerminalRunning`, and subtasks 7 and 8 add **new** lookups (`handleTerminalClosed`, `stopMcpMonitorTerminal`, `checkMcpMonitorAuth`, stop/start-polling). Subtask 3 renames the literal to `'Comms Monitor'`. If any lookup is missed, the monitor terminal stops being found and every tick no-ops silently.
- **UI relocation.** Subtask 6 moves *all* monitor UI out of `createAutobanPanel` into a new `createCommsPanel`. Every other UI subtask (1 help-text, 2 preview, 3 labels, 4 notice, 7 stop button, 8 three-button flow, 9 per-source dropdowns) edits that same block. Order determines whether they target the old location and get moved, or the new one directly.

## Edge-Case & Dependency Audit

- **Race Conditions:** The tick queue (`_enqueueMcpMonitorTick` → serialized `_mcpMonitorTickQueue`) plus the in-flight guard already serialize sends. New immediate-tick paths (subtask 5's coalesced tick, subtask 1's 30s one-shot, subtask 8's start-polling one-shot) must all funnel through `_enqueueMcpMonitorTick`, never call `_mcpMonitorTick` directly, or they can interleave with an interval tick. Subtask 5's `_mcpMonitorLastSendAt = 0` debounce-reset must fire only for the config-change tick, not globally.
- **Security:** Subtask 10 removes `dontAsk`, *widening* interactivity but **not** tool scope (`--allowedTools "mcp__*"` is unchanged) — Claude may now prompt for permission but cannot use non-MCP tools. Prompts are read-only by construction ("do NOT take any actions"). No secrets touched. The editable `promptOverride` (subtask 2) is sent verbatim to a terminal the user controls — acceptable, but note it bypasses the read-only preamble if the user rewrites it.
- **Side Effects:** Per-tick config writes to `~/.switchboard/integration-config.json` (baseline persistence, subtasks 1/9) are small and low-frequency (≤ a few/hour at default intervals) — no throttling needed. All config-schema additions are optional/additive; the `enabled → pollingEnabled` and `intervalMinutes → sourceIntervals` changes use read-time compat shims, so ~4,000 existing installs keep working without a file migration (satisfies CLAUDE.md migration rule).
- **Dependencies & Conflicts:** See the execution order and per-file merge map in Proposed Changes. The hard constraints: (a) extract a terminal-name constant before/with subtask 3; (b) do the UI relocation (subtask 6) before the UI-polish subtasks, or accept a sweep; (c) treat subtasks 8 + 9 + 1 as one backend change against a single merged `_buildMcpMonitorPrompt` / `_startMcpMonitorLoop` / `_mcpMonitorTick`; (d) land the full `McpMonitorConfig` schema once rather than four times.

## Dependencies

None external. All dependencies are **internal to this epic** — expressed as the execution order and per-file merge map below. No cross-session (`sess_…`) dependencies.

## Adversarial Synthesis

**Key risks:** (1) three subtasks rewrite `_buildMcpMonitorPrompt` with incompatible signatures — merge, don't stack; (2) the `'MCP Monitor'` string is a lookup key in 2 existing + 4 new call sites and is renamed by subtask 3 — a single missed site makes the monitor silently dead; (3) subtask 9 supersedes subtask 1's global `lastCheckAt`/`intervalMinutes`, so shipping 1 as-written then 9 later leaves dead fields. **Mitigations:** extract a `MCP_MONITOR_TERMINAL_NAME` constant first so the rename and every lookup move together; land the config schema once (pollingEnabled + sourceIntervals + sourceLastCheckAt) with read-time compat shims; treat the backend trio (8→9→1) as one coordinated change against merged method shapes; do subtask 6 (tab move) before UI polish; ship subtasks 10, 4, 3 independently as the low-risk on-ramp.

## Proposed Changes

This epic adds no *new* product scope — it sequences the existing subtasks and defines their merge points. Two small net-new refactors are recommended as **clarifications** (strictly implied by the existing plans' own conflict notes), not new features:

### Clarification A — extract a shared terminal-name constant (`src/services/TaskViewerProvider.ts`)
- **Context:** `'MCP Monitor'` appears as a live lookup key in `_mcpMonitorTick` and `_isMcpMonitorTerminalRunning`; subtasks 7 & 8 add four more lookups; subtask 3 renames it. Every subtask independently re-notes "keep the literal in sync."
- **Logic/Implementation:** Introduce `private static readonly MCP_MONITOR_TERMINAL_NAME = 'MCP Monitor';` (renamed to `'Comms Monitor'` by subtask 3 in one place) and route all creation + lookup sites through it.
- **Edge Cases:** A live terminal created under the old name before the rename won't match the new constant — expected one-time relaunch, already documented in subtask 3.

### Clarification B — land `McpMonitorConfig` once (`src/services/GlobalIntegrationConfigService.ts`)
- **Context:** Subtasks 1, 2, 8, 9 each extend the interface + `getMcpMonitorConfig` + `setMcpMonitorConfig`.
- **Logic/Implementation:** Apply the union in one pass: `pollingEnabled`, `promptOverride`, `slackChannels`, `slackDmOnly`, `slackChannelOnly`, `gmailLabel`, `sourceIntervals`, `sourceLastCheckAt` (deprecating `intervalMinutes`/`lastCheckAt` via read-time mapping). Keep the `?? current.X` merge pattern so partial writes preserve unspecified fields.
- **Edge Cases:** Compat mappings `pollingEnabled ?? enabled`, `sourceIntervals[k] ?? intervalMinutes`, `sourceLastCheckAt[k] ?? lastCheckAt` cover every shipped-config shape; `lastCheckAt` intentionally has no default (undefined = first-ever check).

### Execution order (recommended)

**Wave 0 — low-risk on-ramp (independent, any order):**
1. Subtask 10 — remove `dontAsk` from the fallback command.
2. Subtask 3 — display-only rename **+ Clarification A** (extract the terminal-name constant).

**Wave 1 — structure:**
3. Subtask 6 — move the monitor UI into a dedicated COMMS tab (`createCommsPanel`). Do this before UI polish so later subtasks target the new home.
4. Clarification B — land the full `McpMonitorConfig` schema.

**Wave 2 — backend lifecycle (one coordinated change, in this internal order):**
5. Subtask 8 — split terminal / auth / polling; introduce the `pollingEnabled` gate; remove any loop-start from `launchMcpMonitorTerminal`.
6. Subtask 9 — GCD timer + per-source due-checking; supersede global `lastCheckAt`/`intervalMinutes` with per-source fields (fold subtask 1's persistence into this).
7. Subtask 1 — first-prompt one-shot (now scheduled from `startMcpMonitorPolling`, per subtask 8) + persistent baseline (now per-source, per subtask 9).
8. Subtask 5 — config-change coalesced immediate tick.
9. Subtask 7 — stuck-status fix + stop controls (`handleTerminalClosed` hook, stop button; uses the constant from Clarification A).

**Wave 3 — prompt content + UI polish (target merged backend + COMMS tab):**
10. Subtask 2 — editable prompt preview (defines the final `_buildMcpMonitorPrompt(cfg, dueSources?)` shape: promptOverride short-circuit → boundary → parameterized Slack/Gmail lines → dueSources filter).
11. Subtask 4 — dependency + Haiku/model indicator.

### Merge map for `_buildMcpMonitorPrompt` (the single most-contended symbol)
Final signature: `_buildMcpMonitorPrompt(cfg: McpMonitorConfig, dueSources?: string[])`.
1. If `cfg.promptOverride?.trim()` → return it verbatim (subtask 2).
2. Compute `boundary` from the relevant per-source `sourceLastCheckAt` (subtasks 1 + 9), fallback "in the past 24 hours".
3. Iterate `dueSources ?? cfg.sources`; render Slack/Gmail via the parameterized helpers (subtask 2), others via presets.
4. Persist `sourceLastCheckAt` for the included sources on successful send only (subtask 9, superseding subtask 1's global write).

## Verification Plan

### Automated Tests
- `npm run compile` (webpack) must pass with no type errors after each wave — this is the type-safety gate that catches the config-schema and method-signature merges. (`dist/` is not exercised in dev/test per CLAUDE.md; the VSIX is the runtime.)
- **Grep invariants (run after Wave 0 and again at the end):**
  - `grep -rn "MCP Monitor" src/` → only the command ID `launchMcpMonitorTerminal` and comments remain; all display + lookup literals route through `MCP_MONITOR_TERMINAL_NAME`.
  - `grep -rn "'mcp_monitor'" src/` → unchanged count (internal role key must never be renamed).
  - `grep -rn "_buildMcpMonitorPrompt" src/services/TaskViewerProvider.ts` → exactly one definition with the merged `(cfg, dueSources?)` signature.
- **Post-merge manual smoke (covers the cross-cutting seams the unit gate can't):** launch from the COMMS tab → first prompt within ~30s → toggle a source mid-run → change a per-source interval → kill the terminal (status flips 🟢→🔴, loop stops) → confirm a restart reads the persisted per-source baseline (prompt says "since <timestamp>", not a 24h re-scan). Each subtask's own Verification Plan remains the authoritative per-subtask checklist.

## Recommendation

**Send to Lead Coder.** Epic complexity **7**: the individual subtasks are routine-to-moderate, but the coordination surface (three shared methods, one shared config interface, one shared UI block, a rename that touches six lookup sites) carries real merge and silent-breakage risk that warrants a senior owner sequencing the waves and holding the merge map for `_buildMcpMonitorPrompt`.

<!-- END IMPROVE-PLAN (epic coordination layer) -->
