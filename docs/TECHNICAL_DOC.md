# Switchboard Technical Documentation (Comprehensive Audit)

Last audited against runtime code: February 27, 2026

This document describes how the plugin currently works in code, not how older docs or prompts describe it.

## 1) System architecture

Switchboard is a local orchestration stack with three main layers:

1. VS Code extension host (`src/extension.ts`)
2. Bundled MCP server child process (`src/mcp-server/mcp-server.js`)
3. Workspace protocol/state surface (`.agent/` and `.switchboard/`)

At runtime:

- The extension owns UI, terminal references, startup/setup workflows, and file watchers.
- The MCP server owns tool APIs (`send_message`, `start_workflow`, etc.), workflow enforcement, and persistent shared state updates.
- Agents coordinate through filesystem artifacts and inbox messages under `.switchboard/`.

## 2) Persistent filesystem model

### `.agent/`

- Workflow markdown contracts and persona files copied during setup.
- Runtime may reference role personas from `.agent/personas/roles/*.md`.

### `.switchboard/` (core runtime data)

- `state.json`: canonical shared state for session/workflow/agent data
- `inbox/<agent>/`: incoming durable messages (JSON)
- `outbox/<agent>/`: legacy/deprecated path still referenced by some tooling
- `sessions/`: run sheets and `activity.jsonl` audit stream
- `plans/features/`: locally created feature plans
- `plans/antigravity_plans/`: mirrored Antigravity brain plans
- `context-maps/`: analyst-generated context map artifacts for planner handoff
- `plan_tombstones.json`: deterministic hash tombstones used to block resurrecting archived/deleted Antigravity plan sessions
- `handoff/`: staged delegation artifacts
- `archive/YYYY-MM/...`: archived inbox/results/plan/session artifacts
- `cooldowns/`: sender-recipient-action dispatch lock files
- `housekeeping.policy.json`: retention policy

## 3) Activation and bootstrap (`activate`)

On startup, the extension does all of the following:

1. Reads enforced security/runtime settings:
   - `switchboard.security.strictInboxAuth` (application scope)
   - `switchboard.runtime.workspaceMode` (application scope)
2. Creates/loads a persistent dispatch signing key in `ExtensionContext.secrets`.
3. Sets process env for child components:
   - `SWITCHBOARD_STRICT_INBOX_AUTH`
   - `SWITCHBOARD_DISPATCH_SIGNING_KEY`
4. Runs lifecycle cleanup:
   - removes transient dirs/files (`inbox`, `outbox`, `cooldowns`, debug log)
   - resets `state.json` baseline (preserving `startupCommands`)
   - disposes likely orphaned Switchboard terminals
5. Initializes `TaskViewerProvider` and sidebar webview.
6. Starts `InboxWatcher`.
7. Spawns bundled MCP server via `fork(..., stdio + ipc)` in workspace context.
8. Starts health monitoring:
   - initial delayed probe
   - steady-state poll every 120s
   - degraded poll every 15s
   - auto-heal restart after repeated degraded checks
9. Starts heartbeat registration loop for local terminals (updates `lastSeen`).

Setup wizard behavior (current):

- Initial protocol setup no longer prompts for Light vs Strict rigor.
- Setup persists workspace prompt-rigor settings to Light defaults:
  - `switchboard.team.strictPrompts = false`
  - `switchboard.planner.strictPrompts = false`
  - `switchboard.review.strictPrompts = false`

## 4) Extension <-> MCP IPC contract

The extension handles MCP child-process IPC message types:

- `createTerminal`
- `focusTerminal`
- `sendToTerminal`
- `renameTerminal`
- `registerTerminal`
- `registerTerminalsBatch`
- `pruneTerminal`
- `healthProbe`

Key safety behavior on `sendToTerminal`:

- Requires valid terminal name and string payload.
- Requires source metadata (`source.actor`, `source.tool`).
- Blocks rapid fan-out broadcast to different targets unless `allowBroadcast=true`.
- Falls back to live VS Code terminal lookup if registry is stale.

## 5) MCP server runtime internals

`mcp-server.js` runs stdio MCP transport and registers tools from `register-tools.js`.

Notable runtime behavior:

- Lifecycle hooks for `SIGTERM`, `SIGINT`, `disconnect`, `uncaughtException`, `unhandledRejection`.
- Hourly stale-terminal warning sweep ("ZombieReaper").
- Internal IPC handler supports terminal registration, batch registration, prune, and health probe response.

## 6) State management model (`state-manager.js`)

`state.json` is lock-protected and atomically written:

- `proper-lockfile` for write lock
- read-modify-write via `updateState(...)`
- write-to-temp then rename (`atomicWrite`)
- retry logic for transient FS errors on Windows

Baseline state shape:

- `session`: active workflow context for session-scope operations
- `terminals`: registered terminal agents (role/status/workflow fields)
- `chatAgents`: registered chat agents
- `teams`: team definitions
- plus context/task and optional runtime extensions (for example audit metadata)

## 7) Workflow runtime model (`workflows.js`)

Runtime workflows currently registered:

- `accuracy` (5 phases)
- `handoff-lead` (3 phases)
- `handoff` (3 phases)
- `handoff-chat` (3 phases)
- `handoff-relay` (2 phases)
- `challenge` (5 phases)
- `chat` (4 phases)

Workflow state can be session-level or agent-level (`targetAgent`).

`start_workflow`:

- Validates workflow name against runtime registry
- supports `force=true` replacement of active workflow
- detects stale markdown-only workflow definitions and returns `STALE_RUNTIME`

`complete_workflow_phase`:

- validates phase ordering and artifact existence
- validates required tool evidence when `requiredTools` is declared
- validates prohibited tool usage against persona/tool gates
- auto-stops workflow on terminal phase and restores suspended workflow stack when applicable

## 8) Tool surface and enforcement (`register-tools.js`)

Primary tools:

- `start_workflow`, `get_workflow_state`, `stop_workflow`
- `run_in_terminal`
- `get_team_roster`, `set_agent_status`, `handoff_clipboard`
- `send_message`, `check_inbox`
- `complete_workflow_phase`

Dynamic schema note:

- Workflow enum is derived from `WORKFLOWS` keys at runtime.

Action-level workflow gates:

- `execute` allowed only in: `handoff`, `challenge`, `handoff-lead`
- `delegate_task` allowed only in: `handoff`

## 9) Dispatch pipeline (`send_message`)

`send_message` only accepts actions:

- `execute`
- `delegate_task`

Pipeline:

1. Resolve sender from env and workflow context.
2. Resolve recipient from workflow action routing.
3. Enforce workflow + phase gate + recipient lock rules.
4. Apply cooldown lock by sender/recipient/action (unless opt-out).
5. Build metadata:
   - normalized `phase_gate`
   - dispatch metadata (`dispatch_id`, TTL, expires, queue mode)
6. Inject security fields for dispatch actions:
   - `sessionToken`
   - `auth` envelope with `hmac-sha256-v1`, nonce, payloadHash, signature
7. Attempt direct terminal push over IPC for `execute`.
8. If direct push fails or not attempted, persist message to `.switchboard/inbox/<recipient>/msg_*.json`.

Important current behavior:

- Message payload is intentionally kept raw (no persona/guardrail wrapping in payload text).
- Persona and dispatch metadata travel in message fields/metadata.

## 10) Inbox read semantics (`check_inbox`)

`check_inbox` supports:

- `box`: `inbox` or `outbox` (default currently `outbox`)
- `filter`: `all` / `delegate_task` / `execute`
- `since`, `limit`, `verbose`

It reads message JSON files and truncates payload previews unless verbose mode is requested.

## 11) Inbox execution path (`InboxWatcher`)

Detection stack:

- VS Code file watcher on inbox tree
- native `fs.watch` fallback (gitignored path resilience)
- periodic poll (60s heartbeat)

Message handling:

- Parses `msg_*.json` in each inbox folder.
- Strict mode auth checks for dispatch actions:
  - requires session token
  - validates token against active session
  - validates HMAC envelope
  - replay protection via nonce cache (execute path)
  - stale timestamp rejection for execute (>5 minutes)

Action handling:

- `execute`:
  - resolves target terminal with role/name fallbacks
  - sanitizes payload leading mode-trigger chars
  - warns on shell metacharacters
  - sends with robust pacing/chunking
  - writes `.result.json`, then deletes original message
- `delegate_task`:
  - intentionally left in recipient inbox for file-based pickup (no greedy re-routing)

Housekeeping:

- archives processed and stale unprocessed inbox messages
- prunes empty non-static dirs
- rotates stale signals and old log artifacts

## 12) Sidebar/webview subsystem (`TaskViewerProvider`)

Core responsibilities:

- Webview event handling for setup, terminal actions, run-sheet actions, orchestration controls
- state/status refresh loops for session, terminals, plans, activity, Jules, interactive orchestrator, pipeline orchestrator, and coder-reviewer workflow phases
- dispatch actions initiated from UI (`triggerAgentAction`)
- lifecycle management for `InteractiveOrchestrator` and `PipelineOrchestrator` with explicit mutual exclusion (`pipelineStart` stops orchestrator, `orchestratorStart` stops pipeline)
- Coder -> Reviewer chained workflow session tracking with timeout/interval timers and cleanup on dispose

Dispatch behavior in sidebar:

- tries direct terminal push first for local terminals
- falls back to inbox message write for cross-window/offline delivery
- attaches session token and signed auth envelope on file dispatch
- internal dispatch path (`_handleTriggerAgentActionInternal`) returns success/failure so higher-level automation can fail fast

Role-driven payload construction:

- `planner`: review/enhance instructions with artifact paths
  - enhance prompt now includes explicit anti-scope-drift guardrails:
    - no net-new product requirements/scope
    - clarifications allowed only when strictly implied, and labeled as clarifications
- `reviewer`: direct reviewer-executor payload template
  - final verdict guardrail:
    - "Not Ready" is for unresolved defects/unmet requirements, not purely blocked test environments
- `lead`/`coder`: execution payload with plan anchor and focus directives
- `coder` (workflow helper mode): supports `create-signal-file` instruction for Coder -> Reviewer handoff (`.switchboard/inbox/Reviewer/<sessionId>.md`)
- `team`: splits by plan Band A/B signals and dispatches to lead/coder targets
- `jules`: triggers remote cloud session after git push verification checks

Webview layout/runtime notes:

- Agents panel is split into sub-tabs: `Agents`, `Auto`, `Cloud`
- `Auto` tab contains Auto-Agent controls, Pipeline controls, Lead+Coder composite action, and Coder -> Reviewer controls
- `Cloud` tab contains Jules controls
- Analyst panel supports two direct actions:
  - `SEND QUESTION` (general analyst dispatch)
  - `GENERATE CONTEXT MAP` (structured prompt to produce `.switchboard/context-maps/context-map_<timestamp>.md` and call `handoff_clipboard`)
- Plan selection gating is now consistently applied across major action cards/buttons:
  - actions are disabled when no plan is selected (`isPlanSelected()` gate)

## 13) Plan and run-sheet lifecycle

Switchboard supports two major plan sources:

1. Local plan creation under `.switchboard/plans/features`
2. Mirrored Antigravity brain plans under `.switchboard/plans/antigravity_plans`

Run sheets (`.switchboard/sessions/*.json`) track:

- `sessionId`
- `planFile`
- topic metadata
- workflow/event timeline

Brain mirror subsystem includes:

- startup scanning and mirror candidate filtering
- deterministic SHA-256 path-based mirror IDs (`brain_<hash>.md`)
- deduplication and migration of legacy run-sheet formats
- bidirectional sync with sidecar support (`.resolved`, `.resolved.N`)
- tombstone seed/load gate (`_ensureTombstonesLoaded`) used before startup scans and mirror events
- atomic tombstone writes (`.tmp` + rename) and hash validation before accepting entries
- hard-stop resurrection guard: skips mirror/session recreation when a completed archived sibling exists for deterministic `antigravity_<hash>`
- duplicate-pruning pass removes stale active runsheets shadowed by archived completed runsheets
- tombstone updates on completed-session archival and manual delete flows (tombstone written before destructive delete sequence)
- plan-file runsheet dedupe now checks both active and completed runsheets before watcher-driven creation:
  - `TaskViewerProvider._handlePlanCreation(...)` calls `SessionActionLog.findRunSheetByPlanFile(..., { includeCompleted: true })`
  - prevents "completed plan resurrection" as a new active session when plan files are edited later

## 14) Security model summary

Implemented controls in runtime:

- signed dispatch auth envelope (`HMAC-SHA256`)
- strict token + signature validation in execute/delegate dispatch path
- nonce replay protection (execute)
- stale execute timestamp rejection
- agent-name/path containment checks before filesystem sinks
- security-critical settings enforced at application scope
- workspace runtime mode explicitly gated and warned

Failure mode:

- if strict auth is enabled and signing key is unavailable, dispatch is rejected.

## 15) Observability and audit data

Audit and activity telemetry is local-only:

- `.switchboard/sessions/activity.jsonl` for workflow/dispatch events
- session run-sheet event streams
- output channels for extension/MCP/Jules diagnostics

Payload sanitization is applied to audit logs for sensitive keys.

## 16) Tests and verification entry points

Useful regression tests in `src/test`:

- `workflow-contract-consistency.test.js`
- `workflow-controls.test.js`
- `send-message-guards.test.js`
- `state-manager.test.js`
- `inbox-watcher.test.js`
- `session-action-log.test.ts`
- `interactive-orchestrator.test.ts`
- `pipeline-orchestrator-regression.test.js`
- `coder-reviewer-workflow.test.js`
- `tombstone-registry-regression.test.js`
- `workspace-scope-regression.test.js`

Typical maintainer checks:

- `npx tsc -p . --noEmit`
- `node src/test/workflow-contract-consistency.test.js`
- `node src/test/workflow-controls.test.js`
- `node src/test/send-message-guards.test.js`
- `node src/test/pipeline-orchestrator-regression.test.js`
- `node src/test/coder-reviewer-workflow.test.js`
- `node src/test/tombstone-registry-regression.test.js`
- `node src/test/workspace-scope-regression.test.js`

## 17) Known runtime/documentation drift (important)

1. Workflow registry drift:
   - `.agent/workflows/enhance.md` exists but `enhance` is not in runtime `WORKFLOWS`.
   - `register-tools.js` still contains references to non-runtime workflows (`autoplan`, `julesplan` aliases/guards).
2. Inbox/outbox semantic drift:
   - `send_message` is inbox-first with direct terminal push optimization.
   - `check_inbox` still defaults `box='outbox'` and retains stale `request_review` filtering logic.
3. Duplicate robust terminal send implementations:
   - one in `extension.ts`
   - another in `services/terminalUtils.ts`
   - behavior is similar but not identical (newline pacing differences).
4. Persona payload formatting drift:
   - MCP `send_message` keeps raw payload + metadata/persona fields.
   - Sidebar local/remote execute helpers can still inline persona wrappers in payload text.
5. Setup template drift:
   - default generated setup text in `extension.ts` still documents legacy/removed tool/workflow names.

These drifts are maintenance risks and should be addressed before adding new protocol features.
