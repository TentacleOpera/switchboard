# Switchboard Technical Documentation (Comprehensive Audit)

Last audited against runtime code: March 19, 2026

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
- `plans/`: locally created feature plans and mirrored Antigravity brain plans (unified root)
- `brain_plan_blacklist.json`: setup-seeded blacklist of pre-existing Antigravity brain plan stable paths (hard excluded from mirror adoption and sidebar visibility)
  - persisted schema: `{ version, generatedAt, entries[] }` where `entries` are stable canonical base-plan paths
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
- Setup seeds `.switchboard/brain_plan_blacklist.json` by scanning `~/.gemini/antigravity/brain` using the same mirror-candidate rules and stable base-path normalization used by runtime mirroring.

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

## 4.5) Agent Access to Integrations

Agents can access Switchboard's Linear and ClickUp integrations through the `call_linear_api` and `call_clickup_api` MCP tools. These tools use direct HTTP API calls and work in all IDEs (VS Code, Antigravity, Windsurf, etc.) without requiring IPC bridging.

### Smart Output (Default: Compact)
By default, both tools return **compact, AI-readable output**:
- Issue/task lists are rendered as **markdown tables** with key fields only (no raw JSON dumps)
- Descriptions are truncated to 500 chars
- Custom fields and empty arrays are stripped
- Use `format="raw"` to get full unprocessed API responses when needed

### Composite Queries
- **ClickUp**: Set `subtasks=true` on a task GET to automatically fetch and embed subtasks in one call (saves a round-trip)
- **Linear**: Use GraphQL to fetch issues with children (sub-issues) in a single query

### State Tracking
The tools automatically cache frequently used IDs (team_id, space_id, list_id, project_id) in `api_state.json` under the Switchboard state root. This reduces the need to navigate the hierarchy on every call.

### Security Model
- Tools only work with Linear/ClickUp API tokens configured in VS Code settings
- Tokens are passed to the MCP server via environment variables
- No arbitrary VS Code command execution (unlike the removed execute_vscode_command tool)

### Linear API Tool
- `call_linear_api` — Call Linear GraphQL or REST API directly
  - GraphQL: Provide `query` and optional `variables`
  - REST: Provide `method`, `endpoint`, and optional `body`
  - `format`: `"compact"` (default) or `"raw"`
  - Example: `call_linear_api(query="query { issues(first: 10) { nodes { id title state { name } } } }")`

### ClickUp API Tool
- `call_clickup_api` — Call ClickUp REST API directly
  - Provide `method`, `endpoint`, and optional `query`/`body`
  - `subtasks=true`: Fetch task + subtasks in one call (composite query)
  - `format`: `"compact"` (default) or `"raw"`
  - Example: `call_clickup_api(method="GET", endpoint="/v2/list/123/task")`
  - Example with subtasks: `call_clickup_api(method="GET", endpoint="/v2/task/abc123", subtasks=true)`

These tools work in standalone mode without requiring IPC bridging, providing a unified integration experience across all IDEs.

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
- `improve-plan` (3 phases)
- `challenge` (5 phases)
- `chat` (4 phases)
- `review` (used by Kanban CODE REVIEWED advance)

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
- state/status refresh loops for session, terminals, plans, activity, Jules, interactive orchestrator, pipeline orchestrator, AUTOBAN config, and coder-reviewer workflow phases
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
- `Auto` tab contains Auto-Agent controls, Pipeline controls, Lead+Coder composite action, Coder -> Reviewer controls, and AUTOBAN configuration
- `Cloud` tab contains Jules controls
- `KanbanProvider` instance is owned by `TaskViewerProvider` and opened via `switchboard.openKanban` command
- `ReviewProvider` instance is owned by `TaskViewerProvider` and opened via `reviewPlan` Kanban message or sidebar action
- Analyst panel supports two direct actions:
  - `SEND QUESTION` (general analyst dispatch)
  - `GENERATE CONTEXT MAP` (structured prompt to produce `.switchboard/context-maps/context-map_<timestamp>.md` and call `handoff_clipboard`)
- Plan selection gating is now consistently applied across major action cards/buttons:
  - actions are disabled when no plan is selected (`isPlanSelected()` gate)

## 13) Plan and run-sheet lifecycle

Switchboard supports two major plan sources:

1. Local plan creation under `.switchboard/plans/`
2. Mirrored Antigravity brain plans under `.switchboard/plans/` (unified with local plans)

Run sheets (`.switchboard/sessions/*.json`) track:

- `sessionId`
- `planFile`
- topic metadata
- workflow/event timeline

Brain mirror subsystem includes:

- setup-time blacklist seeding of pre-existing global brain plans into `.switchboard/brain_plan_blacklist.json`
- runtime blacklist load gate in watcher/mirror flow (`_loadBrainPlanBlacklist(workspaceRoot)` in brain watcher setup)
- hard blacklist mirror skip before any adoption/mirroring (`Mirror skipped (brain_plan_blacklist)`)
- run-sheet visibility blacklist exclusion in `_refreshRunSheets` (blacklisted brain sources never populate the dropdown)
- mirror candidate filtering for scan/seeding (`brainDir/<session>/<file>.md` + supported `.resolved` sidecars)
- deterministic SHA-256 path-based mirror IDs (`brain_<hash>.md`)
- deduplication and migration of legacy run-sheet formats
- bidirectional sync with sidecar support (`.resolved`, `.resolved.N`)
- tombstone seed/load gate (`_ensureTombstonesLoaded`) used before mirror events
- atomic tombstone writes (`.tmp` + rename) and hash validation before accepting entries
- hard-stop resurrection guard: skips mirror/session recreation when a completed archived sibling exists for deterministic `antigravity_<hash>`
- duplicate-pruning pass removes stale active runsheets shadowed by archived completed runsheets
- tombstone updates on completed-session archival and manual delete flows (tombstone written before destructive delete sequence)
- plan-file runsheet dedupe now checks both active and completed runsheets before watcher-driven creation:
  - `TaskViewerProvider._handlePlanCreation(...)` calls `SessionActionLog.findRunSheetByPlanFile(..., { includeCompleted: true })`
  - prevents "completed plan resurrection" as a new active session when plan files are edited later

## 14) Kanban board subsystem (`KanbanProvider`)

The Kanban board is the central dispatch and visualization surface, rendered as a `WebviewPanel` in the editor area.

### Data model

- **`KanbanCard`**: `{ sessionId, topic, planFile, column, lastActivity, complexity, workspaceRoot }`
- **`KanbanColumn`**: string ID (e.g. `CREATED`, `PLAN REVIEWED`, `LEAD CODED`, `CODER CODED`, `CODE REVIEWED`)
- Columns are dynamically built from 5 built-in columns plus custom agents via `buildKanbanColumns(customAgents)` from `agentConfig.ts`
- Custom agents with `includeInKanban: true` are inserted into the column ordering based on their `kanbanOrder` property

### Persistence — dual-layer (SQLite + file-derived fallback)

Primary state is persisted in a **local SQLite database** (`KanbanDatabase` in `src/services/KanbanDatabase.ts`):

- Database file: `.switchboard/kanban.db`
- Schema: `plans` table with `plan_id` (PK), `session_id` (unique), `topic`, `plan_file`, `kanban_column`, `status`, `complexity`, `workspace_id`, `created_at`, `updated_at`, `last_action`, `source_type`
- Indexes on `kanban_column` and `workspace_id`
- Uses `sql.js` (WASM SQLite) loaded via `createRequire` from the extension bundle
- Upsert semantics via `INSERT ... ON CONFLICT(plan_id) DO UPDATE`
- Migration tracking via `migration_meta` table

Fallback: when the DB is unavailable (init failure, WASM load error), the board falls back to **file-derived state** from run-sheet events in `.switchboard/sessions/*.json`, using `deriveKanbanColumn()` from `kanbanColumnDerivation.ts`.

Migration bootstrap (`KanbanMigration`):
- On first DB-backed refresh, `KanbanMigration.bootstrapIfNeeded()` seeds the DB from the file-derived snapshot
- Subsequent refreshes use `syncNewPlansOnly()` to add new plans without overwriting DB-managed column positions

### Refresh and watchers

- VS Code `FileSystemWatcher` on `**/.switchboard/sessions/*.json` and `**/.switchboard/state.json`
- Native `fs.watch` fallback for gitignored `.switchboard/` paths
- 300ms debounced refresh on any change
- Workspace identity scoping via `.switchboard/workspace_identity.json`

### Webview message protocol

Key inbound messages from the Kanban webview:

| Message type | Behavior |
| :--- | :--- |
| `triggerAction` | Single card drag-drop dispatch: resolves column→role, dispatches via `switchboard.triggerAgentFromKanban` |
| `triggerBatchAction` | Multi-select drag-drop batch dispatch |
| `moveSelected` / `moveAll` | Advance selected/all cards in a column; `PLAN REVIEWED` uses complexity-based partition routing |
| `promptSelected` / `promptAll` | Generate batch prompt, copy to clipboard, advance cards |
| `batchPlannerPrompt` | Generate planner prompt for all `CREATED` cards, copy to clipboard |
| `batchLowComplexity` | Generate coder prompt for low-complexity `PLAN REVIEWED` cards |
| `batchDispatchLow` | Dispatch low-complexity plans via command |
| `julesLowComplexity` / `julesSelected` | Dispatch low-complexity or selected plans to Jules |
| `moveCardForward` / `moveCardBackwards` | Non-dispatch column moves |
| `createPlan` | Triggers `switchboard.initiatePlan` |
| `importFromClipboard` | Triggers `switchboard.importPlanFromClipboard` |
| `reviewPlan` | Opens the Review panel for a card |
| `completePlan` | Marks a plan as completed |
| `toggleAutoban` | Enables/disables AUTOBAN from the Kanban UI |
| `toggleCliTriggers` | Enables/disables CLI trigger dispatch on drag-drop |
| `analystMapSelected` | Sends selected plans to analyst for context map generation |
| `selectWorkspace` | Switches active workspace in multi-root setups |

### Column-to-role dispatch mapping

`_columnToRole()` maps target columns:

- `PLAN REVIEWED` → `planner`
- `LEAD CODED` → `lead`
- `CODER CODED` → `coder`
- `CODED` → `lead` (legacy alias)
- `CODE REVIEWED` → `reviewer`
- Custom agent columns → their role ID

### MCP integration

`handleMcpMove(sessionId, target)` is the entry point for conversational Kanban routing via the `move_kanban_card` MCP tool. It resolves natural-language targets (e.g. "lead coder", "reviewer", column labels) through a normalized alias map built from built-in roles, column definitions, and custom agents. Complexity-routed targets (`team`, `coded`) resolve dynamically per-session based on plan complexity.

## 15) Complexity classification and auto-routing

`KanbanProvider.getComplexityFromPlan()` reads a plan file and returns `'Low'`, `'High'`, or `'Unknown'`. The classification drives the complexity-based auto-routing when advancing plans from the `PLAN REVIEWED` column.

Priority chain:

1. **Manual override**: `**Manual Complexity Override:** Low|High|Unknown` — user-set via the Review panel dropdown, supersedes all heuristics
2. **Agent recommendation**: regex match for "Send it to the Lead Coder" → `High`, "Send it to the Coder" → `Low` — written by the improve-plan workflow
3. **Band B fallback**: parses the Complexity Audit section for `Band B` items. Lines are normalized (stripped of markdown formatting, decorative labels like "Complex/Risky", and empty markers like "None", "N/A", "—"). If no meaningful Band B items remain → `Low`, otherwise → `High`

Auto-routing behavior:

- When advancing from `PLAN REVIEWED`, `_partitionByComplexityRoute()` splits session IDs into routed groups (`intern`, `coder`, `lead`, and optional `team-lead`)
- `_targetColumnForDispatchRole()`: `intern` → `INTERN CODED`, `coder` → `CODER CODED`, `lead` → `LEAD CODED`, `team-lead` → `TEAM LEAD CODED`
- Both `moveSelected` and `moveAll` use this partition when the source column is `PLAN REVIEWED`

The same complexity classification logic is duplicated in `register-tools.js` for the MCP `get_kanban_state` tool (kept aligned via the `normalizeBandBLine` helper).

### Team Lead routing override

- `TEAM LEAD CODED` remains a built-in column with `hideWhenNoAgent: true`, so it stays hidden unless Team Lead is enabled.
- Setup exposes `kanban.teamLeadComplexityCutoff` on the same 0-10 scale used elsewhere: `0` disables Team Lead routing, higher values route scores at or above the cutoff to `team-lead` before the standard routing map runs.
- Pair-programming mode still only rewrites `intern -> coder`; it does not rewrite `team-lead`.
- Team Lead board placement is controlled by `kanban.teamLeadKanbanOrder`, which overrides the built-in column order when `buildKanbanColumns()` clones the default column definitions for the current workspace.
- Scores below the Team Lead cutoff, or all scores when the cutoff is `0`, continue through the normal Lead/Coder/Intern routing flow.

## 16) AUTOBAN automation subsystem

AUTOBAN provides API-less batch automation by rotating plans across multiple terminal instances per role on configurable timers.

### Configuration state (`autobanState.ts`)

```
AutobanConfigState {
    enabled: boolean
    batchSize: number                          // 1–5, default 3
    complexityFilter: 'all' | 'low_only' | 'high_only'
    routingMode: 'dynamic' | 'all_coder' | 'all_lead'
    maxSendsPerTerminal: number                // default 10
    globalSessionCap: number                   // default 200
    sessionSendCount: number
    sendCounts: Record<string, number>         // per-terminal send counts
    terminalPools: Record<string, string[]>    // user-configured pools
    managedTerminalPools: Record<string, string[]>  // auto-managed pools
    poolCursor: Record<string, number>         // round-robin cursor per role
    rules: Record<string, AutobanRuleState>    // per-column enable + interval
    lastTickAt?: Record<string, number>        // last dispatch timestamp per column
}
```

### Per-column rules (defaults)

| Column | Enabled | Interval |
| :--- | :--- | :--- |
| `CREATED` | true | 10 min |
| `PLAN REVIEWED` | true | 20 min |
| `LEAD CODED` | true | 15 min |
| `CODER CODED` | true | 15 min |

### Terminal pool rotation

- Up to `MAX_AUTOBAN_TERMINALS_PER_ROLE` (5) terminals per role
- `getNextAutobanTerminalName()` rotates through the pool using a cursor
- `LEAD CODED` and `CODER CODED` share a reviewer pool (`AUTOBAN_SHARED_REVIEWER_COLUMNS`)
- `shouldSkipSharedReviewerAutobanDispatch()` prevents double-dispatching to the shared reviewer

### Dispatch flow

1. AUTOBAN tick fires per enabled column at configured interval
2. Selects eligible cards (respects `complexityFilter`, `globalSessionCap`, `maxSendsPerTerminal`)
3. Groups cards into batches of `batchSize`
4. Selects target terminal via pool rotation
5. Generates prompt via `buildKanbanBatchPrompt()` (same canonical builder used by manual dispatch)
6. Dispatches to terminal via `terminal.sendText`
7. Updates send counts and advances cards to next column

### Sidebar ↔ Kanban sync

- Autoban config is managed from the sidebar (`TaskViewerProvider`)
- Config state is relayed to the Kanban webview via `updateAutobanConfig(state)` message
- Kanban UI displays enable/disable toggle and reflects current AUTOBAN state

### ClickUp / Linear auto-pull

- `ClickUpSyncService` and `LinearSyncService` persist `autoPullEnabled` and `pullIntervalMinutes` alongside their existing integration config, with load/save normalization so legacy configs default to `false` and `60`.
- `KanbanProvider` owns timed integration imports via `IntegrationAutoPullService`, which uses per-workspace `setTimeout` scheduling instead of overlapping `setInterval` loops.
- The Kanban webview remains the only integration settings surface: once setup is complete, the ClickUp / Linear strip buttons open an auto-pull modal instead of re-running setup immediately.
- Manual imports and timed imports must resolve the same destination folder through `TaskViewerProvider.getPlanIngestionFolder(workspaceRoot)` with `.switchboard/plans` only as the fallback.

## 17) Plan Review subsystem (`ReviewProvider`)

The Review panel is a dedicated `WebviewPanel` for contextual plan inspection and inline commenting.

### Core types

- `ReviewPlanContext`: session ID, topic, plan file path, workspace root, initial mode (`edit` | `review`)
- `ReviewCommentRequest`: session ID, topic, plan file path, selected text, comment
- `ReviewCommentResult`: success flag, message, target agent, preferred role
- `ReviewTicketData`: full plan ticket view — column, complexity, dependencies, plan text, rendered HTML, action log, mtime for optimistic concurrency

### Webview message protocol

| Message type | Behavior |
| :--- | :--- |
| `selectionChanged` | Tracks current text selection and bounding rect for comment anchoring |
| `submitComment` | Dispatches `ReviewCommentRequest` via `switchboard.sendReviewComment` command — sends a targeted comment referencing the selected plan text to the Planner agent |
| `setColumn` / `setComplexity` / `setDependencies` / `setTopic` / `savePlanText` | Ticket metadata updates via `_applyTicketUpdate()` |
| `sendToAgent` | Dispatches the plan to the next agent via `switchboard.reviewSendToAgent` |
| `completePlan` | Marks plan completed via `switchboard.completePlanFromKanban` |
| `deletePlan` | Deletes plan with confirmation via `switchboard.deletePlanFromReview` |
| `copyPlanLink` | Copies the plan's absolute file path to clipboard |
| `getOpenPlans` | Returns other open plan options for navigation |

### Comment dispatch flow

1. User selects text within the rendered plan markdown
2. User types a comment and submits
3. `ReviewProvider` builds a `ReviewCommentRequest` with the selected text anchor and comment
4. Extension dispatches to the Planner terminal via `switchboard.sendReviewComment`, which constructs a prompt referencing the exact quoted text and the user's question/comment
5. The Planner agent responds in-terminal with targeted plan improvements

### Ticket metadata editing

The Review panel supports inline editing of plan metadata:

- **Column**: move card to any Kanban column
- **Complexity**: manual override (`Low` / `High` / `Unknown`) — persists as `**Manual Complexity Override:** <value>` in the plan markdown, which takes priority in `getComplexityFromPlan()`
- **Dependencies**: list of dependency plan session IDs
- **Topic**: plan title
- **Plan text**: full markdown editing with optimistic concurrency via `expectedMtimeMs`

## 18) MCP Kanban tools

### `get_kanban_state`

Registered in `register-tools.js`. Returns the full Kanban board state or a filtered single-column view.

- **Parameters**: `column` (optional) — supports internal IDs (`CREATED`, `PLAN REVIEWED`, etc.) and UI labels (`New`, `Planned`, etc.)
- **Column resolution**: `resolveRequestedKanbanColumn()` normalizes input through alias map (`KANBAN_COLUMN_ALIASES`), exact match, and label match
- **Data source**: tries SQLite DB first via `readKanbanStateFromDb()`, falls back to file-derived state from run-sheets + plan registry
- **Response format**: JSON map of column ID → `{ id, label, items[] }` where each item has `topic`, `sessionId`, `createdAt`
- Custom agent columns are dynamically included via `getKanbanColumnDefinitions()` which merges built-in columns with `customAgents` from `state.json`

### `move_kanban_card`

Registered in `register-tools.js`. Routes a plan to a target agent/column via the Kanban dispatch pipeline.

- **Parameters**: `sessionId` (required), `target` (required) — conversational destination string
- **Dispatch path**: delegates to `KanbanProvider.handleMcpMove()` which resolves the target through the normalized alias map, checks role visibility/assignment, and dispatches via `switchboard.triggerAgentFromKanban`
- **Complexity routing**: targets like `team` and `coded` use dynamic per-session complexity resolution

## 19) Batch prompt builder (`agentPromptBuilder.ts`)

All prompt-generation paths route through `buildKanbanBatchPrompt()` to ensure identical prompt text regardless of UI entry point (card copy, batch buttons, AUTOBAN dispatch, ticket-view "Send to Agent").

### Prompt structure by role

- **Planner**: improve/enhance instructions referencing `.agent/workflows/improve-plan.md`, with plan file list
- **Lead Coder**: execution payload with focus directive, batch execution rules, optional inline adversarial challenge block, plan file list
- **Coder**: same as lead but with optional `low-complexity` instruction hint and accuracy mode workflow reference (`.agent/workflows/accuracy.md`)
- **Reviewer**: reviewer-executor payload with mode directive (no auxiliary workflow), plan file list

### Key directives included in all batch prompts

- **Focus directive**: "Each plan file path below is the single source of truth" — prevents confusion from directory mirroring
- **Batch execution rules**: instructs platforms with parallel sub-agents to dispatch one sub-agent per plan for concurrent execution
- **Critical instructions**: treat each plan as isolated context, execute fully before moving to next, report issues but continue processing

`columnToPromptRole()` maps Kanban columns to prompt builder roles for the `promptSelected`/`promptAll` actions.

## 20) Security model summary

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

## 21) Observability and audit data

Audit and activity telemetry is local-only:

- `.switchboard/sessions/activity.jsonl` for workflow/dispatch events
- session run-sheet event streams
- output channels for extension/MCP/Jules diagnostics

Payload sanitization is applied to audit logs for sensitive keys.

## 22) Tests and verification entry points

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

## 23) Known runtime/documentation drift (important)

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

6. Complexity classification duplication:
   - `KanbanProvider.getComplexityFromPlan()` and `register-tools.js` `getComplexityFromPlan()` implement the same logic independently.
   - The Band B parsing, agent recommendation regex, and manual override regex must be kept in sync manually.
7. Kanban DB vs file-derived state:
   - The SQLite DB is authoritative for column positions when available, but the file-derived fallback uses `deriveKanbanColumn()` which may disagree after manual DB column moves.
   - `get_kanban_state` MCP tool has its own DB read path separate from `KanbanProvider._refreshBoard()`.

These drifts are maintenance risks and should be addressed before adding new protocol features.
