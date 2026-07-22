# Switchboard Scheduler (replaces Comms)

**Complexity:** 7

## Goal

Generalize Switchboard's only self-owned scheduler (the Comms Monitor) into a terminal-agnostic Scheduler that runs any prompt on a schedule against a chosen target: a local interactive terminal (sub-hourly, laptop-on), Antigravity Scheduled Tasks, or a laptop-off cloud job. Comms becomes one source option rather than a top-level tab. No third-party integration is required: read-only cloud jobs read the existing switchboard/board snapshot, and off-machine board mutations reconcile locally via a copyable IDE-agent prompt that scans git-tracked plan files and moves cards through the sanctioned path.

## How the Subtasks Achieve This

- **Scheduler Job Data Model & Comms Config Migration**: Refactors the comms-specific `McpMonitorConfig` singleton into a reusable `ScheduledJob` shape where source/prompt, interval, and target are orthogonal, and migrates the existing Comms Monitor settings onto it losslessly. This is the foundation the other three build on; it ships no user-visible change on its own.
- **Generalize the Comms Monitor Loop into a Terminal-Agnostic Local Scheduler Engine**: Lifts the Comms Monitor's `setInterval` loop, dedicated terminal, tick queue, and output capture out of comms-specific methods and keys them by job id, so any `local-terminal` job runs on the same engine. Preserves the load-bearing constraints — never-headless interactive terminal, read-only comms, sub-hourly intervals — that justify the local target existing at all.
- **Scheduler Prompt Presets & External-Target (Antigravity/Cloud) Handoff**: Adds the source presets (board-batch, reconcile, comms, custom) and the external targets. External targets emit a portable prompt plus the explicit prerequisites the current Antigravity mode hides (the "honesty fix"). Cloud reads the already-shipped `switchboard/board` snapshot; off-machine board mutations reconcile via a copyable IDE-agent prompt that moves cards through the sanctioned `kanban_operations` path — no third-party integration.
- **Scheduler UI in the Automation Tab; Retire the Standalone Comms Tab**: Surfaces the scheduler as a `Scheduler` mode in the Automation tab with a source dropdown that demotes comms to one option, folds the antigravity-batch behavior in, and removes the standalone COMMS tab — the decluttering payoff.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Scheduler Job Data Model & Comms Config Migration](../plans/scheduler-job-data-model.md) — **LEAD CODED**
- [ ] [Generalize the Comms Monitor Loop into a Terminal-Agnostic Local Scheduler Engine](../plans/scheduler-local-execution-engine.md) — **LEAD CODED**
- [ ] [Scheduler Prompt Presets & External-Target (Antigravity/Cloud) Handoff](../plans/scheduler-prompt-presets-external-targets.md) — **LEAD CODED**
- [ ] [Scheduler UI in the Automation Tab; Retire the Standalone Comms Tab](../plans/scheduler-ui-replace-comms-tab.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Strictly sequential — each subtask depends on the one before it:

1. **Data Model** must land first; it defines the `ScheduledJob`/`SchedulerConfig` types and the migration every other subtask consumes.
2. **Local Execution Engine** depends on the data model (it iterates `local-terminal` jobs and reads per-job config).
3. **Prompt Presets & External Targets** depends on the engine's per-job prompt-builder dispatch and adds the non-comms sources/targets.
4. **Scheduler UI** depends on all three — it renders the job list, source/target dropdowns, and prerequisites blocks defined upstream, and removes the Comms tab last.

The migration (subtask 1) keeps legacy accessors as shims so subtasks 2–4 can cut over incrementally without a big-bang change.
