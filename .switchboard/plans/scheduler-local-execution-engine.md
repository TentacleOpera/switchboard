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

## Metadata

- **Complexity:** 7
- **Tags:** backend, refactor, reliability, feature

## User Review Required

Reviewer must confirm the per-job terminal-naming scheme (`Scheduler: <label>`) and the decision to keep the migrated comms job's terminal name as `Comms Monitor` (avoids orphaning a running terminal on upgrade). No user-facing product decision is open.

## Complexity Audit

### Routine
- Converting the singleton timer/queue/in-flight fields ([:447-454](src/services/TaskViewerProvider.ts#L447)) into `Map<jobId, …>` structures.
- Generalizing the command surface (`launchMcpMonitorTerminal`/`stopMcpMonitorTerminal` → accept `jobId`) and keeping the no-arg commands as shims targeting the comms job.
- Per-job output watcher keying.

### Complex / Risky
- **Per-job terminal identity without orphaning.** The constant `MCP_MONITOR_TERMINAL_NAME` is a de-facto lookup key consumed by two matching mechanisms (normalize-based in `TaskViewerProvider`, regex-based in `extension.ts`) and derives the `state.terminals` map key (per the comment at [:21905-21912](src/services/TaskViewerProvider.ts#L21905)). Renaming it for the comms job orphans the running terminal on upgrade; the migrated comms job MUST keep the literal name `Comms Monitor`.
- **Closed-terminal handler resolution.** The handler at [:17672](src/services/TaskViewerProvider.ts#L17672) currently closes the single loop; it must resolve the right job from the closed terminal or it will stop the wrong loop (or none).
- **GCD interval preservation.** The comms job's interval is the GCD of `sourceIntervals` ([:21941](src/services/TaskViewerProvider.ts#L21941)); non-comms jobs use a single `intervalMinutes`. The split must not leak the GCD logic into non-comms jobs or vice versa.
- **Prompt-builder dispatch.** Replacing the direct `_buildMcpMonitorPrompt` call with a `job.source` dispatch must preserve `promptOverride` precedence exactly.

## Edge-Case & Dependency Audit

- **Race Conditions:** Enabling/disabling a job while its tick is in-flight. Mitigation: the existing `_mcpMonitorInFlight` guard must be keyed per job (`Map<jobId, boolean>`) so disabling job A does not suppress job B's tick.
- **Security:** No new surface. The "never headless" constraint is a security/cost guardrail — the refactor must not introduce any `claude -p` call path for any `local-terminal` job, not just comms.
- **Side Effects:** N timers and N terminals can now run concurrently. Terminal disposal on job deletion must clear the timer, the queue, the watcher, and close the terminal or resources leak.
- **Dependencies & Conflicts:** Owns the scheduler loop fields and methods on `TaskViewerProvider`. Plan 1 must land first (provides `ScheduledJob`/`SchedulerConfig`). Plan 3's prompt builders are consumed via the `job.source` dispatch added here. Plan 4's UI calls the generalized commands. No conflict with the `antigravity-batch` mode (that path is plan 3's concern).

## Dependencies

- `plan://scheduler-job-data-model` — provides the `ScheduledJob`/`SchedulerConfig` types and the comms shim consumed here.
- `plan://scheduler-prompt-presets-external-targets` — supplies the `board-batch`/`reconcile`/`custom` prompt builders dispatched on `job.source`.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) orphaning the running comms terminal on upgrade by changing its name; (2) the closed-terminal handler stopping the wrong job's loop; (3) the "never headless" guardrail silently regressing for non-comms local jobs. Mitigations: keep the literal `Comms Monitor` name for the migrated job, resolve job-by-terminal via a `Map<terminalName, jobId>` index maintained at launch/stop, and add a unit test asserting no `claude -p` invocation appears in any `local-terminal` loop path.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** Generalize the singleton loop machinery into a per-job engine.
- **Logic:**
  - Convert `_mcpMonitorTimer`, `_mcpMonitorFirstPromptTimer`, `_mcpMonitorConfigChangeTimer`, `_mcpMonitorOutputWatcher`, `_mcpMonitorOutputFallbackTimer`, `_mcpMonitorTickQueue`, `_mcpMonitorLastSendAt`, `_mcpMonitorInFlight` ([:447-454](src/services/TaskViewerProvider.ts#L447)) into `Map<jobId, …>` structures.
  - Generalize `_startMcpMonitorLoop` → `_startSchedulerJobLoop(job)`; iterate all enabled `local-terminal` jobs at activation instead of the single call at [:640](src/services/TaskViewerProvider.ts#L640). Add `_stopSchedulerJobLoop(jobId)` that clears the timer, queue, watcher, and closes the terminal.
  - Per-job terminal identity: derive the name from the job (`Scheduler: <label>`), but keep `'Comms Monitor'` as the label for the migrated comms job so its terminal name is unchanged. Generalize `_isMcpMonitorTerminalRunning` ([:22460](src/services/TaskViewerProvider.ts#L22460)) and the terminal-closed handler ([:17672](src/services/TaskViewerProvider.ts#L17672)) to look up by job via a `Map<terminalName, jobId>` index maintained at launch/stop.
  - Per-job prompt builder: replace the direct `_buildMcpMonitorPrompt` call with a dispatch on `job.source`: `comms` → the existing comms builder (moved as-is), `custom`/`board-batch`/`reconcile` → use `job.promptOverride` (these sources are authored as prompts in plan 3). Preserve `promptOverride` precedence exactly as today.
  - Preserve tick semantics: keep the tick queue, `_mcpMonitorLastSendAt` debounce, in-flight guard (now per-job), and the GCD-interval computation for the comms job ([:21941](src/services/TaskViewerProvider.ts#L21941)). For non-comms jobs, tick on the job's single `intervalMinutes`.
  - Preserve output capture: keep the watcher/fallback ([:450-451](src/services/TaskViewerProvider.ts#L450)) but key it per job so each job's output routes to its own pane/state.
- **Implementation:** The `Map<terminalName, jobId>` index is the single source of truth for closed-terminal resolution; do not re-derive by string-matching the terminal name. The "never headless" constraint applies to every `local-terminal` job — no `claude -p` call path may be introduced for any source.
- **Edge Cases:** Job deleted while tick in-flight → `_stopSchedulerJobLoop` drains the queue then clears. Two jobs with the same label → disambiguate by appending the job id suffix to the terminal name (rare; UI should prevent duplicate labels in plan 4).

### `src/extension.ts`
- **Context:** Generalize the command surface ([:1564-1572](src/extension.ts#L1564)).
- **Logic:** Generalize `switchboard.launchMcpMonitorTerminal` / `switchboard.stopMcpMonitorTerminal` to accept a `jobId` argument; keep the no-arg forms as shims that target the comms job (find by `source === 'comms'`) so nothing else breaks mid-migration.

### `src/services/KanbanProvider.ts`
- **Context:** Generalize the message handlers ([:7301-7306](src/services/KanbanProvider.ts#L7301)).
- **Logic:** Accept a `jobId` on the `launchMcpMonitorTerminal`/`stopMcpMonitorTerminal` messages; keep the old no-arg messages as shims.

## Verification Plan

### Automated Tests
- Unit test: two enabled `local-terminal` jobs produce two independent timers and two terminal names; disabling one stops only its loop.
- Unit test: the migrated comms job still computes its interval as the GCD of `sourceIntervals` and builds the identical read-only prompt as before (snapshot the prompt string).
- Unit test: `promptOverride` still wins over the generated prompt for the comms job.
- Unit test: the closed-terminal handler resolves the correct job from the `Map<terminalName, jobId>` index and stops only that job's loop.
- Unit test: no `claude -p` (headless) invocation appears in any `local-terminal` loop path (grep-style assertion over the built prompt + the launch path).

### Manual Acceptance
- Existing comms job runs unchanged post-refactor: terminal named "Comms Monitor", interactive (not `-p`), read-only prompt, output appears in its pane.
- Add a second `local-terminal` job (e.g. a `custom` prompt every 5 min): confirm it spawns its own terminal and ticks independently of comms.
- Close one job's terminal: confirm only that job's loop stops (the closed-terminal handler resolves the right job).
- Confirm no headless `claude -p` invocation is introduced anywhere in the loop.

## Routing

**Complexity 7 → Send to Lead Coder.** Multi-field, multi-method refactor with a load-bearing guardrail (never-headless) and an upgrade-safety constraint (terminal name preservation); the per-job index and the closed-terminal resolution are the hard parts.
