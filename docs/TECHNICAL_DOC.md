# Switchboard Technical Documentation (Comprehensive Audit)

Last audited against runtime code: March 19, 2026

This document describes how the plugin currently works in code, not how older docs or prompts describe it.

## 1) System architecture

Switchboard is a local orchestration stack with three main layers:

1. VS Code extension host (`src/extension.ts`)
2. Workspace protocol/state surface (`.agents/` and `.switchboard/`)

At runtime:

- The extension owns UI, terminal references, startup/setup workflows, and file watchers.
- Agents coordinate through direct terminal push and filesystem artifacts under `.switchboard/`.

## 2) Persistent filesystem model

### `.agents/`

- Workflow markdown contracts and persona files copied during setup.
- Runtime may reference role personas from `.agents/personas/roles/*.md`.

### `.switchboard/` (core runtime data)

- `state.json`: canonical shared state for session/workflow/agent data
- `sessions/`: run sheets and `activity.jsonl` audit stream
- `plans/`: locally created feature plans and mirrored Antigravity brain plans (unified root)
- `brain_plan_blacklist.json`: setup-seeded blacklist of pre-existing Antigravity brain plan stable paths (hard excluded from mirror adoption and sidebar visibility)
  - persisted schema: `{ version, generatedAt, entries[] }` where `entries` are stable canonical base-plan paths
- `context-maps/`: analyst-generated context map artifacts for planner handoff
- `plan_tombstones.json`: deterministic hash tombstones used to block resurrecting archived/deleted Antigravity plan sessions
- `archive/YYYY-MM/...`: archived plan/session/log artifacts
- `cooldowns/`: sender-recipient-action dispatch lock files

## 3) Activation and bootstrap (`activate`)

On startup, the extension does all of the following:

1. Reads enforced runtime settings:
   - `switchboard.runtime.workspaceMode` (application scope)
2. Runs lifecycle cleanup:
   - removes transient dirs/files (`inbox`, `outbox`, `cooldowns`, `handoff`, debug log, `housekeeping.policy.json`)
   - resets `state.json` baseline (preserving `startupCommands`)
   - disposes likely orphaned Switchboard terminals
3. Initializes `TaskViewerProvider` and sidebar webview.
4. Starts heartbeat registration loop for local terminals (updates `lastSeen`).

Setup wizard behavior (current):

- Initial protocol setup no longer prompts for Light vs Strict rigor.
- Setup persists workspace prompt-rigor settings to Light defaults:
  - `switchboard.team.strictPrompts = false`
  - `switchboard.planner.strictPrompts = false`
  - `switchboard.review.strictPrompts = false`
- Setup seeds `.switchboard/brain_plan_blacklist.json` by scanning `~/.gemini/antigravity/brain` using the same mirror-candidate rules and stable base-path normalization used by runtime mirroring.


## 4.5) Agent Access to Integrations

Agents can access Switchboard's Linear and ClickUp integrations through **Skill-based Invocations**: Run curl commands against the LocalApiServer.

### Smart Output (Default: Compact)
By default, skills return **compact, AI-readable output**:
- Issue/task lists are rendered as **markdown tables** with key fields only (no raw JSON dumps)
- Descriptions are truncated to 500 chars
- Custom fields and empty arrays are stripped
- Use `format="raw"` to get full unprocessed API responses when needed

### Composite Queries
- **ClickUp**: Set `subtasks=true` on a task GET to automatically fetch and embed subtasks in one call (saves a round-trip)
- **Linear**: Use GraphQL to fetch issues with children (sub-issues) in a single query

### State Tracking
The integrations automatically cache frequently used IDs (team_id, space_id, list_id, project_id) in `api_state.json` under the Switchboard state root. This reduces the need to navigate the hierarchy on every call.

### Security Model
- Skills only work with Linear/ClickUp API tokens configured in VS Code settings.
- The client passes the API auth token configured in VS Code settings (`switchboard.apiToken`) in the `Authorization: Bearer <token>` header.
- To prevent credentials exposure, there is no HTTP endpoint to retrieve the token from the LocalApiServer.
- If no `switchboard.apiToken` is configured, read-only requests (`GET` and `/resolve` endpoints) are allowed without authentication for development convenience, while write operations (POST/PUT/DELETE) are strictly denied.

### Linear Integration Examples

#### Skill-based Invocations (Preferred)
```bash
# Get port and call API with authorization header
PORT=$(cat .switchboard/api-server-port.txt)
TOKEN="your_switchboard_api_token" # Retrieve from secure config

curl -s -X POST http://localhost:$PORT/api/linear \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { issues(first: 10) { nodes { id title state { name } } } }",
    "variables": {},
    "format": "compact"
  }'
```


### ClickUp Integration Examples

#### Skill-based Invocations (Preferred)
```bash
# Get port and call API with authorization header
PORT=$(cat .switchboard/api-server-port.txt)
TOKEN="your_switchboard_api_token"

curl -s -X POST http://localhost:$PORT/api/clickup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "GET",
    "endpoint": "/v2/task/abc123",
    "query": {},
    "body": null,
    "subtasks": true,
    "format": "compact"
  }'
```


These skills work in standalone mode without requiring IPC bridging, providing a unified integration experience across all IDEs.

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
- `improve-plan` (3 phases)
- `chat` (4 phases)
- `review` (used by Kanban CODE REVIEWED advance)

> **Note:** `handoff`, `handoff-lead`, `handoff-chat`, `handoff-relay`, and `challenge` workflows are blocklisted during setup and removed from the workspace. They remain in the runtime registry for backward compatibility but are not distributed to new workspaces.

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
- `complete_workflow_phase`

Dynamic schema note:

- Workflow enum is derived from `WORKFLOWS` keys at runtime.

Action-level workflow gates:

- `execute` allowed only in: `handoff`, `challenge`, `handoff-lead`, `improve-plan`
- `delegate_task` allowed only in: `handoff`

## 9) Dispatch pipeline

Pipeline:

1. Resolve sender from env and workflow context.
2. Resolve recipient from workflow action routing.
3. Enforce workflow + phase gate + recipient lock rules.
4. Apply cooldown lock by sender/recipient/action (unless opt-out).
5. Attempt direct terminal push over IPC for `execute`.
6. If direct push fails, display warning notification.



## 12) Sidebar/webview subsystem (`TaskViewerProvider`)

Core responsibilities:

- Webview event handling for setup, terminal actions, run-sheet actions, orchestration controls
- state/status refresh loops for session, terminals, plans, activity, Jules, interactive orchestrator, pipeline orchestrator, AUTOBAN config, and coder-reviewer workflow phases
- dispatch actions initiated from UI (`triggerAgentAction`)
- lifecycle management for `InteractiveOrchestrator` and `PipelineOrchestrator` with explicit mutual exclusion (`pipelineStart` stops orchestrator, `orchestratorStart` stops pipeline)
- Coder -> Reviewer chained workflow session tracking with timeout/interval timers and cleanup on dispose

Dispatch behavior in sidebar:

- tries direct terminal push first for local terminals; if terminal not found, shows warning notification
- internal dispatch path (`_handleTriggerAgentActionInternal`) returns success/failure so higher-level automation can fail fast and roll back column move on failure

Role-driven payload construction:

- `planner`: review/enhance instructions with artifact paths
  - enhance prompt now includes explicit anti-scope-drift guardrails:
    - no net-new product requirements/scope
    - clarifications allowed only when strictly implied, and labeled as clarifications
- `reviewer`: direct reviewer-executor payload template
  - final verdict guardrail:
    - "Not Ready" is for unresolved defects/unmet requirements, not purely blocked test environments
- `lead`/`coder`: execution payload with plan anchor and focus directives
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

## 18) Kanban skills

Agents use direct database access via skills.

### `query_switchboard_kanban` skill

Located at `.agents/skills/query_switchboard_kanban.md`. Provides direct SQL access to `kanban.db` for state queries only (read-only). Kanban column transitions are system-managed.

- Agents read the database path from `.switchboard/workspace-id` (line 2).
- Example read: `sqlite3 <db_path> "SELECT session_id, topic, kanban_column FROM plans WHERE kanban_column = 'CREATED';"`

### `query_archive` skill

Located at `.agents/skills/query_archive/`. Documents direct DuckDB CLI commands for archive queries.


## 19) Batch prompt builder (`agentPromptBuilder.ts`)

All prompt-generation paths route through `buildKanbanBatchPrompt()` to ensure identical prompt text regardless of UI entry point (card copy, batch buttons, AUTOBAN dispatch, ticket-view "Send to Agent").

### Prompt structure by role

- **Planner**: improve/enhance instructions referencing `.agents/workflows/improve-plan.md`, with plan file list
- **Lead Coder**: execution payload with focus directive, batch execution rules, optional inline adversarial challenge block, plan file list
- **Coder**: same as lead but with optional `low-complexity` instruction hint and accuracy mode workflow reference (`.agents/workflows/accuracy.md`)
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
- output channels for extension/Jules diagnostics

Payload sanitization is applied to audit logs for sensitive keys.

## 22) Tests and verification entry points

Useful regression tests in `src/test`:

- `workflow-contract-consistency.test.js`
- `workflow-controls.test.js`
- `state-manager.test.js`
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
- `node src/test/pipeline-orchestrator-regression.test.js`
- `node src/test/coder-reviewer-workflow.test.js`
- `node src/test/tombstone-registry-regression.test.js`
- `node src/test/workspace-scope-regression.test.js`

## 23) Known runtime/documentation drift (important)

1. Workflow registry drift:
   - `.agents/workflows/enhance.md` exists but `enhance` is not in runtime `WORKFLOWS`.

3. Duplicate robust terminal send implementations:
   - one in `extension.ts`
   - another in `services/terminalUtils.ts`
   - behavior is similar but not identical (newline pacing differences).
3. Persona payload formatting drift:
    - Sidebar local execute helper can still inline persona wrappers in payload text.
5. Setup template drift:
   - default generated setup text in `extension.ts` still documents legacy/removed tool/workflow names (partially addressed — `send_message`/`check_inbox` removed from agent-facing docs, but `.cursorrules` and some doc references may persist).

6. Complexity classification:
   - The Band B parsing, agent recommendation regex, and manual override regex must be kept in sync manually.
7. Kanban DB vs file-derived state:
   - The SQLite DB is authoritative for column positions when available, but the file-derived fallback uses `deriveKanbanColumn()` which may disagree after manual DB column moves.
   - The `query_switchboard_kanban` skill provides direct DB access for agents.

These drifts are maintenance risks and should be addressed before adding new protocol features.



