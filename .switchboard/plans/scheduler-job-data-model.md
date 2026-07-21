# Scheduler Job Data Model & Comms Config Migration

## Goal

Introduce a generic **Scheduled Job** data model as the foundation for a terminal-agnostic Switchboard scheduler, and migrate the existing singleton Comms Monitor config onto it without losing user settings.

**Problem & background.** Switchboard's only self-owned scheduler today is the Comms Monitor, whose entire configuration lives in a single fixed-shape blob, `McpMonitorConfig` ([GlobalIntegrationConfigService.ts:46-59](src/services/GlobalIntegrationConfigService.ts#L46)), persisted machine-globally to `~/.switchboard/integration-config.json`. It hard-codes the comms use case: `sources`, `slackChannels`, `gmailLabel`, `sourceIntervals`, etc. There is exactly one monitor, one terminal, one config. Meanwhile the "Automation" tab's `antigravity-batch` mode owns *no* scheduling at all — it only emits a one-shot prompt and borrows Antigravity's `manage_task` timer ([KanbanProvider.ts:5000](src/services/KanbanProvider.ts#L5000)). There is no shared concept of "run this prompt on this schedule against this target," so every scheduled behavior is bespoke.

**Root cause.** Scheduling is not a first-class concept. The recurrence, the prompt, and the execution target are fused into one comms-specific config object. To generalize (comms as *one* job among board-automation, reconciliation, and custom jobs) the config must be refactored into a reusable `Job` shape where **source/prompt, schedule/interval, and target are orthogonal fields**.

This plan is **data-model only** — it ships no user-visible behavior on its own; it unblocks plans 2–4 (local engine generalization, prompt presets/external targets, and the Scheduler UI).

## Implementation Steps

1. **Define a `ScheduledJob` interface** (in `GlobalIntegrationConfigService.ts`, beside `McpMonitorConfig`): `{ id: string; label: string; enabled: boolean; source: 'comms' | 'board-batch' | 'reconcile' | 'custom'; target: 'local-terminal' | 'antigravity' | 'cloud'; intervalMinutes: number; promptOverride?: string; sourceConfig: Record<string, unknown> }`. `sourceConfig` holds source-specific fields (the comms fields — `sources`, `slackChannels`, `slackDmOnly`, `slackChannelOnly`, `gmailLabel`, `sourceIntervals`, `customInstruction`, `sourceLastCheckAt` — move here verbatim so nothing is lost).
2. **Add a `SchedulerConfig` container**: `{ jobs: ScheduledJob[] }`, persisted in the same `integration-config.json`. Provide `getSchedulerConfigSync()`, `getSchedulerConfig()`, `setSchedulerConfig()` mirroring the existing `getMcpMonitorConfigSync`/`getMcpMonitorConfig`/`setMcpMonitorConfig` accessors ([:237-284](src/services/GlobalIntegrationConfigService.ts#L237)).
3. **One-time migration.** On first read where `SchedulerConfig` is absent but a legacy `McpMonitorConfig` exists, synthesize a single `ScheduledJob` from it: `source: 'comms'`, `target: 'local-terminal'`, `enabled` ← `pollingEnabled`, `label: 'Comms Monitor'`, and pack all comms fields into `sourceConfig`. Preserve `targetRole: 'mcp_monitor'` inside `sourceConfig` so the terminal-identity logic in plan 2 still resolves. Write the migrated `SchedulerConfig` back; keep the legacy blob readable (do not delete) for one release as a rollback safety net.
4. **Keep the legacy accessors as thin shims** that read/write the migrated comms job, so plan 2 can cut over incrementally rather than in one atomic change.
5. **Interval semantics.** Preserve the current GCD-of-`sourceIntervals` behavior for the comms job (it drives one terminal from multiple per-source intervals — see [`_startMcpMonitorLoop`, TaskViewerProvider.ts:21927-21942](src/services/TaskViewerProvider.ts#L21927)). For non-comms jobs, `intervalMinutes` is the single source of truth. Document this split in a code comment so it is not mistaken for dead code.

## Metadata

- **Complexity:** 5
- **Tags:** backend, refactor, feature, reliability

## Verification Plan

### Automated Tests
- Unit test: given a legacy `integration-config.json` containing only `mcpMonitor`, `getSchedulerConfig()` returns exactly one job with `source:'comms'`, `target:'local-terminal'`, and every legacy field preserved under `sourceConfig`.
- Unit test: round-trip `setSchedulerConfig()` → `getSchedulerConfig()` is stable and merges defaults like the existing config accessors.
- Unit test: legacy `getMcpMonitorConfigSync()` shim returns values consistent with the migrated comms job.

### Manual Acceptance
- With an existing Comms Monitor configured (sources, channels, intervals), upgrade and confirm the settings survive as a migrated job (inspect `integration-config.json`).
- Confirm no user-visible behavior changes yet (the loop and terminal still work exactly as before via the shims).
