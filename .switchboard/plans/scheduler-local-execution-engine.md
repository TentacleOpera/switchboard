# Generalize the Comms Monitor Loop into a Terminal-Agnostic Local Scheduler Engine

## Goal

Lift the Comms Monitor's local scheduling machinery — its `setInterval` loop, dedicated terminal, tick queue, and output capture — into a **generic engine that can run any `ScheduledJob`** whose `target` is `local-terminal`, while preserving the guardrails that make comms correct.

**Problem & background.** The only real, self-owned scheduler in Switchboard is buried inside comms-specific methods on `TaskViewerProvider`: `_startMcpMonitorLoop()` ([:21927](src/services/TaskViewerProvider.ts#L21927)), the timer/queue/in-flight fields ([:447-454](src/services/TaskViewerProvider.ts#L447)), `launchMcpMonitorTerminal()`/`stopMcpMonitorTerminal()` ([:22266](src/services/TaskViewerProvider.ts#L22266), [:22402](src/services/TaskViewerProvider.ts#L22402)), and the single hard-coded terminal name `MCP_MONITOR_TERMINAL_NAME = 'Comms Monitor'` ([:21913](src/services/TaskViewerProvider.ts#L21913)). It is started once at activation ([:640](src/services/TaskViewerProvider.ts#L640)). Everything assumes exactly one job.

**Root cause.** The engine and the comms use case are the same code. To make comms "just one job," the loop must be keyed by **job id** (N timers, N terminals) and the prompt must come from a per-job builder rather than the hard-coded `_buildMcpMonitorPrompt`.

**Load-bearing constraints that must survive the refactor** (see memory / prior incidents):
- **Never headless.** The comms job must run in an *interactive, subscription-authed* Claude terminal via `sendText`, never `claude -p` (headless is API-billed and loses claude.ai MCP connectors). This constraint is the whole reason the local target exists.
- **Read-only comms.** The comms prompt is strictly read-only ("do NOT take any actions").
- **Sub-hourly niche.** The local target is the only one that can poll faster than hourly; keep minute-granularity intervals.

This plan depends on the `ScheduledJob`/`SchedulerConfig` model from **Scheduler Job Data Model & Comms Config Migration**.

## Implementation Steps

1. **Key the loop by job id.** Convert the singleton timer/queue/in-flight fields ([:447-454](src/services/TaskViewerProvider.ts#L447)) into `Map<jobId, …>` structures. Generalize `_startMcpMonitorLoop` into `_startSchedulerJobLoop(job)` and add `_stopSchedulerJobLoop(jobId)`; iterate all `local-terminal` jobs at activation instead of the single call at [:640](src/services/TaskViewerProvider.ts#L640).
2. **Per-job terminal identity.** Derive the terminal name from the job (`Scheduler: <label>`), keeping `'Comms Monitor'` as the label for the migrated comms job so its terminal name is unchanged (avoids orphaning a running terminal on upgrade). Generalize `_isMcpMonitorTerminalRunning` ([:22460](src/services/TaskViewerProvider.ts#L22460)) and the terminal-closed handler ([:17672](src/services/TaskViewerProvider.ts#L17672)) to look up by job.
3. **Per-job prompt builder.** Replace the direct call to `_buildMcpMonitorPrompt` with a dispatch on `job.source`: `comms` → the existing comms builder (moved as-is), `custom`/`board-batch`/`reconcile` → use `job.promptOverride` (these sources are authored as prompts in plan 3). Preserve `promptOverride` precedence exactly as today.
4. **Preserve tick semantics.** Keep the tick queue, `_mcpMonitorLastSendAt` debounce, in-flight guard, and the GCD-interval computation for the comms job ([:21941](src/services/TaskViewerProvider.ts#L21941)). For non-comms jobs, tick on the job's single `intervalMinutes`.
5. **Preserve output capture.** Keep the output watcher/fallback ([:450-451](src/services/TaskViewerProvider.ts#L450)) but key it per job so each job's output routes to its own pane/state.
6. **Command surface.** Generalize the `launchMcpMonitorTerminal`/`stopMcpMonitorTerminal` commands ([extension.ts:1564-1572](src/extension.ts#L1564)) and their message handlers ([KanbanProvider.ts:7301-7306](src/services/KanbanProvider.ts#L7301)) to accept a `jobId`, keeping the old no-arg commands as shims that target the comms job (so nothing else breaks mid-migration).

## Metadata

- **Complexity:** 7
- **Tags:** backend, refactor, reliability, feature

## Verification Plan

### Automated Tests
- Unit test: two enabled `local-terminal` jobs produce two independent timers and two terminal names; disabling one stops only its loop.
- Unit test: the migrated comms job still computes its interval as the GCD of `sourceIntervals` and builds the identical read-only prompt as before (snapshot the prompt string).
- Unit test: `promptOverride` still wins over the generated prompt for the comms job.

### Manual Acceptance
- Existing comms job runs unchanged post-refactor: terminal named "Comms Monitor", interactive (not `-p`), read-only prompt, output appears in its pane.
- Add a second `local-terminal` job (e.g. a `custom` prompt every 5 min): confirm it spawns its own terminal and ticks independently of comms.
- Close one job's terminal: confirm only that job's loop stops (the closed-terminal handler resolves the right job).
- Confirm no headless `claude -p` invocation is introduced anywhere in the loop.
