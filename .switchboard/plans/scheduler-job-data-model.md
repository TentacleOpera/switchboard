# Scheduler Job Data Model & Comms Config Migration

## Goal

Introduce a generic **Scheduled Job** data model as the foundation for a terminal-agnostic Switchboard scheduler, and migrate the existing singleton Comms Monitor config onto it without losing user settings.

**Problem & background.** Switchboard's only self-owned scheduler today is the Comms Monitor, whose entire configuration lives in a single fixed-shape blob, `McpMonitorConfig` ([GlobalIntegrationConfigService.ts:46-59](src/services/GlobalIntegrationConfigService.ts#L46)), persisted machine-globally to `~/.switchboard/integration-config.json`. It hard-codes the comms use case: `sources`, `slackChannels`, `gmailLabel`, `sourceIntervals`, etc. There is exactly one monitor, one terminal, one config. Meanwhile the "Automation" tab's `antigravity-batch` mode owns *no* scheduling at all — it only emits a one-shot prompt and borrows Antigravity's `manage_task` timer ([KanbanProvider.ts:5000](src/services/KanbanProvider.ts#L5000)). There is no shared concept of "run this prompt on this schedule against this target," so every scheduled behavior is bespoke.

**Root cause.** Scheduling is not a firstclass concept. The recurrence, the prompt, and the execution target are fused into one comms-specific config object. To generalize (comms as *one* job among board-automation, reconciliation, and custom jobs) the config must be refactored into a reusable `Job` shape where **source/prompt, schedule/interval, and target are orthogonal fields**.

This plan is **data-model only** — it ships no user-visible behavior on its own; it unblocks plans 2–4 (local engine generalization, prompt presets/external targets, and the Scheduler UI).

## Metadata

- **Complexity:** 5
- **Tags:** backend, refactor, feature, reliability

## User Review Required

No user-facing decision is required before implementation. The migration is lossless and the legacy shims preserve behavior. Reviewer should confirm the `ScheduledJob.sourceConfig` shape and the `schemaVersion` field before coding (see Adversarial Synthesis).

## Complexity Audit

### Routine
- Adding a new `ScheduledJob` interface and `SchedulerConfig` container beside the existing `McpMonitorConfig` in `GlobalIntegrationConfigService.ts`.
- Mirroring the existing `getMcpMonitorConfigSync` / `getMcpMonitorConfig` / `setMcpMonitorConfig` accessor pattern for the new `getSchedulerConfigSync` / `getSchedulerConfig` / `setSchedulerConfig`.
- Packing the comms fields verbatim into `sourceConfig` (no transformation).

### Complex / Risky
- **One-time migration with concurrent-read safety.** `integration-config.json` is machine-global and can be read by multiple workspaces/IDEs simultaneously; a naive "read → migrate → write back" on first read races and can clobber a concurrent write.
- **Shim fidelity.** The legacy accessors must remain byte-for-byte consistent with the migrated comms job, including the `?? DEFAULT_MCP_MONITOR_CONFIG` default-merge semantics — any drift silently changes comms behavior in plan 2.
- **Untyped `sourceConfig` bag.** `Record<string, unknown>` is a deliberate escape hatch but every downstream consumer (plan 2's terminal-identity lookup, plan 4's comms sub-form) must cast; type drift is silent.

## Edge-Case & Dependency Audit

- **Race Conditions:** Concurrent first-read migration. Mitigation: write the migrated `SchedulerConfig` only if absent (compare-and-swap on the file), and log a warning if a legacy `mcpMonitor` is present alongside a stale `scheduler` — do not overwrite a newer `scheduler` with a re-migrated one.
- **Security:** No new surface. `integration-config.json` is already machine-global with the same access semantics.
- **Side Effects:** Migration writes the file once on first read after upgrade. Existing comms behavior is unchanged because plans 2–4 cut over incrementally via shims.
- **Dependencies & Conflicts:** This plan owns `GlobalIntegrationConfigService.ts` for the new types and accessors. Plans 2–4 consume the new accessors but must not delete the legacy shims until all three have cut over. No other in-flight feature touches this file.

## Dependencies

- `plan://scheduler-local-execution-engine` — consumes `ScheduledJob` / `SchedulerConfig` and the comms shim.
- `plan://scheduler-prompt-presets-external-targets` — consumes `source` / `target` union values.
- `plan://scheduler-ui-replace-comms-tab` — renders `SchedulerConfig.jobs` and writes via `setSchedulerConfig`.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) concurrent first-read migration clobbering a parallel write to `integration-config.json`; (2) silent type drift through the untyped `sourceConfig` bag; (3) shim drift breaking comms behavior mid-cutover. Mitigations: compare-and-swap migration guarded by a `schemaVersion` field, typed discriminated `sourceConfig` per source, and a snapshot test asserting the legacy accessor returns identical values pre/post migration.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`
- **Context:** Add the new types beside `McpMonitorConfig` ([:46-59](src/services/GlobalIntegrationConfigService.ts#L46)) and the new accessors beside the legacy ones ([:237-293](src/services/GlobalIntegrationConfigService.ts#L237)).
- **Logic:**
  - Define `ScheduledJob`: `{ id: string; label: string; enabled: boolean; source: 'comms' | 'board-batch' | 'reconcile' | 'custom'; target: 'local-terminal' | 'antigravity' | 'cloud'; intervalMinutes: number; promptOverride?: string; sourceConfig: Record<string, unknown> }`.
  - Define `SchedulerConfig`: `{ schemaVersion: number; jobs: ScheduledJob[] }` (the `schemaVersion` field anchors future migrations — without it, the next migration has no anchor to branch on).
  - Add `getSchedulerConfigSync()`, `getSchedulerConfig()`, `setSchedulerConfig()` mirroring the legacy accessor shape, including the default-merge pattern.
  - Migration: on first read where `scheduler` is absent but `mcpMonitor` is present, synthesize one job (`source: 'comms'`, `target: 'local-terminal'`, `enabled` ← `pollingEnabled`, `label: 'Comms Monitor'`, pack all comms fields into `sourceConfig`, preserve `targetRole: 'mcp_monitor'` inside `sourceConfig`). Write back only if `scheduler` is still absent on re-read (compare-and-swap). Keep the legacy `mcpMonitor` blob readable (do not delete) for one release as a rollback safety net.
  - Convert the legacy `getMcpMonitorConfigSync` / `getMcpMonitorConfig` / `setMcpMonitorConfig` into thin shims that read/write the migrated comms job (find it by `source === 'comms'`).
- **Implementation:** Preserve the existing `?? DEFAULT_MCP_MONITOR_CONFIG` default-merge semantics exactly in the shim. Document the GCD-of-`sourceIntervals` interval semantics for the comms job in a code comment (the loop lives in plan 2; the comment here prevents the split being mistaken for dead code).
- **Edge Cases:** Empty `mcpMonitor` (no configured comms) → migrate to an empty/disabled comms job so the shape is stable. `scheduler` present but `schemaVersion` newer than known → do not migrate, log, return as-is (forward-compat).

### `src/services/__tests__/GlobalIntegrationConfigService.test.ts` (or co-located test file)
- **Context:** New unit tests for migration and round-trip.
- **Logic:** See Verification Plan.

## Verification Plan

### Automated Tests
- Unit test: given a legacy `integration-config.json` containing only `mcpMonitor`, `getSchedulerConfig()` returns exactly one job with `source:'comms'`, `target:'local-terminal'`, and every legacy field preserved under `sourceConfig`.
- Unit test: round-trip `setSchedulerConfig()` → `getSchedulerConfig()` is stable and merges defaults like the existing config accessors.
- Unit test: legacy `getMcpMonitorConfigSync()` shim returns values consistent with the migrated comms job (snapshot the pre/post shapes — they must be identical).
- Unit test: a second call to migrate (when `scheduler` already present) does not overwrite and does not re-migrate from `mcpMonitor`.

### Manual Acceptance
- With an existing Comms Monitor configured (sources, channels, intervals), upgrade and confirm the settings survive as a migrated job (inspect `integration-config.json`).
- Confirm no user-visible behavior changes yet (the loop and terminal still work exactly as before via the shims).

## Routing

**Complexity 5 → Send to Coder.** Single-file refactor with a well-scoped migration; the only moderate risk is the concurrent-write guard, which is a known pattern.
