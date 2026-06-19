# Switchboard — Comprehensive User Manual

*Last updated: June 2026. Sourced from live codebase (`package.json`, `extension.ts`, `agentConfig.ts`, `setup.html`, runtime services).*

---

## Table of Contents

1. [Introduction & Overview](#1-introduction--overview)
2. [Installation & First-Time Setup](#2-installation--first-time-setup)
3. [Agent Roles & Configuration](#3-agent-roles--configuration)
4. [The AUTOBAN (Kanban Board)](#4-the-autoban-kanban-board)
5. [Planning Tools & Workflows](#5-planning-tools--workflows)
6. [Pair Programming Mode](#6-pair-programming-mode)
7. [Multi-Repo Control Plane](#7-multi-repo-control-plane)
8. [Project Panel](#8-project-panel)
9. [Design Panel (Google Stitch)](#9-design-panel-google-stitch)
10. [Research / Local Docs Panel](#10-research--local-docs-panel)
11. [PM Tool Sync](#11-pm-tool-sync)
12. [NotebookLM Airlock](#12-notebooklm-airlock)
13. [Google Jules Integration](#13-google-jules-integration)
14. [Archive System](#14-archive-system)
15. [Status Bar Hub](#15-status-bar-hub)
16. [Themes](#16-themes)
17. [Core Workflows](#17-core-workflows)
18. [Quota Economics](#18-quota-economics)
19. [Prompt Controls](#19-prompt-controls)
20. [All Settings Reference](#20-all-settings-reference)
21. [All Commands Reference](#21-all-commands-reference)
22. [IDE Chat Commands](#22-ide-chat-commands)
23. [Privacy & Security](#23-privacy--security)
24. [Architecture](#24-architecture)
25. [Troubleshooting / FAQ](#25-troubleshooting--faq)

---

## 1. Introduction & Overview

Switchboard is a full-lifecycle AI agent platform for VS Code. It lets you manage your entire delivery pipeline — from spec and planning through code execution, review, and archiving — by dragging cards on a Kanban board instead of typing into chat.

**Key principles:**
- **Zero-overhead coordination** — No orchestration agent, no gateway, no API keys required for local execution. Direct VS Code API control.
- **Drag-and-drop orchestration** — Move cards to dispatch real work to terminal-based or IDE chat-based AI agents.
- **CLI & IDE agent pipeline** — Combine chat-based agents (Windsurf, Cursor, Antigravity) and CLI-based tools (Claude Code, Gemini CLI, Copilot CLI).
- **Spec-driven governance** — Inject project-wide rules (Constitution) automatically into every agent prompt.
- **Multi-repo Control Plane** — Run a single board that orchestrates agents across multiple repositories with a shared local database.
- **100% local-first** — No external proxy servers, no telemetry, no tracking.

---

## 2. Installation & First-Time Setup

### Installing
Install **Switchboard** from the VS Code Marketplace. That's it — no gateway, no runtime, no external servers.

### Opening the Sidebar
After install, the Switchboard icon appears in the VS Code sidebar. Click it to open the Setup panel. If setup is needed, a status bar item will show `$(rocket) Switchboard: Setup Required`.

### Git Ignore Strategy
Switchboard creates a `.switchboard/` directory in your workspace for runtime state. Configure how these files are excluded from git:

- **`targetedGitignore`** (default) — Writes targeted rules to `.gitignore` while keeping shared plans, reviews, sessions, and workflow files tracked.
- **`localExclude`** — Writes rules to `.git/info/exclude` (local only, not committed).
- **`custom`** — Write your own rules to `.gitignore` (editable).
- **`none`** — Do not manage ignore rules (manual management required).

Settings: `switchboard.workspace.ignoreStrategy`, `switchboard.workspace.ignoreRules`

### Setup Wizard
Run `Switchboard: Setup AI Protocol Files` (`switchboard.setup`) to initialize `.agent/` workflow files and personas in your workspace. This seeds the workflow contracts and agent personas that Switchboard uses for prompt generation.

---

## 3. Agent Roles & Configuration

Switchboard ships with the following built-in agent roles (defined in `agentConfig.ts`):

| Role ID | Label | Description |
|---------|-------|-------------|
| `planner` | Planner | Premium model (Opus, Sonnet, Gemini Pro). Writes plans and assigns complexity. |
| `lead` | Lead Coder | High-complexity tasks. |
| `coder` | Coder | Low-complexity / boilerplate (e.g., Gemini Flash). |
| `intern` | Intern | Simple, guided tasks. |
| `reviewer` | Reviewer | Compares implementation to plans (Grumpy Principal Engineer persona). |
| `tester` | Acceptance Tester | Validates finished work. |
| `analyst` | Analyst | General research and context map generation. |
| `ticket_updater` | Ticket Updater | Updates PM tool ticket statuses. |
| `researcher` | Researcher | Research tasks. |
| `splitter` | Splitter Agent | Splits large plans into sub-plans. |
| `gatherer` | Context Gatherer | Gathers code context before planning. |

### Custom Roles
Add custom agents in the Setup panel. Each custom agent supports:
- **`id`** — Unique identifier
- **`role`** — Role string (auto-generated from id if not specified)
- **`name`** — Display name
- **`startupCommand`** — CLI command to launch the agent
- **`promptInstructions`** — Custom prompt instructions
- **`includeInKanban`** — Whether the agent gets its own Kanban column
- **`kanbanOrder`** — Column sort order
- **`dragDropMode`** — `cli` (terminal dispatch), `prompt` (clipboard copy), or `disabled`
- **`addons`** — Optional add-ons: `includeInlineChallenge`, `accurateCodingEnabled`, `pairProgrammingEnabled`, `workspaceTypeDetection`, `switchboardSafeguards`

### CLI Agent Startup Commands
Configure CLI agent startup commands in Setup (e.g., `gemini --approval-mode yolo`). These are the commands Switchboard sends to terminals when dispatching work.

Settings: `switchboard.cli.command`, `switchboard.cli.args`, `switchboard.cli.yolo`, `switchboard.cli.yoloFlags`

### Complexity Routing
The Planner assigns complexity (1-10) to route plans:
- High complexity → Lead Coder
- Low complexity → Coder
- Very low → Intern

Complexity is determined by (in priority order):
1. **Manual override** — `**Manual Complexity Override:** Low|High|Unknown` in the plan file (set via Review panel dropdown)
2. **Agent recommendation** — Regex match for "Send it to the Lead Coder" → High, "Send it to the Coder" → Low
3. **Band B fallback** — Parses the Complexity Audit section for `Band B` items. If no meaningful Band B items → Low, otherwise → High

---

## 4. The AUTOBAN (Kanban Board)

The AUTOBAN is the central control surface. Open it with `Switchboard: Open KANBAN` (`switchboard.openKanban`).

### Built-In Columns

| Column ID | Label | Order | Role | AUTOBAN | Drag-Drop Mode |
|-----------|-------|-------|------|---------|----------------|
| `CREATED` | New | 0 | — | Yes | CLI |
| `CONTEXT GATHERER` | Context Gatherer | 50 | gatherer | Yes | CLI |
| `RESEARCHER` | Researcher | 90 | researcher | No | Prompt |
| `PLAN REVIEWED` | Planned | 100 | planner | Yes | CLI |
| `SPLITTER` | Splitter | 110 | splitter | No | Prompt |
| `LEAD CODED` | Lead Coder | 180 | lead | Yes | CLI |
| `CODER CODED` | Coder | 190 | coder | Yes | CLI |
| `INTERN CODED` | Intern | 200 | intern | Yes | CLI |
| `CODE REVIEWED` | Reviewed | 300 | reviewer | No | CLI |
| `ACCEPTANCE TESTED` | Acceptance Tested | 350 | tester | No | CLI |
| `TICKET UPDATER` | Ticket Updater | 9000 | ticket_updater | No | Prompt |
| `COMPLETED` | Completed | 9999 | — | No | CLI |

Columns with `hideWhenNoAgent: true` stay hidden unless the corresponding agent is configured.

### Column Controls
- **Drag-and-drop** — Route cards to dispatch work.
- **Move Selected** / **Move All** — Advance cards in a column. When advancing from `PLAN REVIEWED`, complexity-based partition routing splits cards to Lead Coder, Coder, or Intern.
- **Copy Prompt Selected** / **Copy Prompt All** — Generate prompt text and copy to clipboard.
- **Move Card Forward** / **Move Card Backwards** — Non-dispatch column moves (no agent trigger).

### Routing Modes
- **CLI Triggers** — Dragging a card dispatches to a terminal (default).
- **Prompt mode** — Dragging a card copies the prompt to clipboard instead.
- Toggle via the Kanban UI (`toggleCliTriggers` message).

### AUTOBAN Automation
Click **START AUTOBAN** to automate the queue on a timer. Configuration:

| Column | Default Enabled | Default Interval |
|--------|----------------|-----------------|
| `CREATED` | Yes | 10 min |
| `PLAN REVIEWED` | Yes | 20 min |
| `LEAD CODED` | Yes | 15 min |
| `CODER CODED` | Yes | 15 min |

Additional AUTOBAN settings:
- **Batch size** — 1–5 cards per dispatch (default 3)
- **Complexity filter** — `all`, `low_only`, or `high_only`
- **Routing mode** — `dynamic`, `all_coder`, or `all_lead`
- **Max sends per terminal** — Default 10
- **Global session cap** — Default 200
- **Terminal pools** — Up to 5 terminals per role, rotated round-robin

Commands: `switchboard.setAutobanEnabledFromKanban`, `switchboard.setAutobanPausedFromKanban`, `switchboard.resetAutobanTimersFromKanban`, `switchboard.addAutobanTerminalFromKanban`, `switchboard.removeAutobanTerminalFromKanban`, `switchboard.resetAutobanPoolsFromKanban`

### Kanban Database
The board state is persisted in a local SQLite database (`.switchboard/kanban.db`), using `sql.js` (WASM SQLite). When the DB is unavailable, the board falls back to file-derived state from run-sheet events in `.switchboard/sessions/*.json`.

Settings: `switchboard.kanban.completedLimit` (1–500, default 100), `switchboard.kanban.dbPath` (custom DB path for cloud-synced multi-machine setups)

---

## 5. Planning Tools & Workflows

### Creating Plans
- Click **Create Plan** in the AUTOBAN (`switchboard.initiatePlan`)
- Import from clipboard (`switchboard.importPlanFromClipboard`)
- Import NotebookLM plans (`switchboard.importNotebookLMPlans`)
- Import unclaimed plans from AI IDE folders (`switchboard.importUnclaimedPlans`)

### Plan Scanner
Periodically scans AI IDE/agent folders for newly generated plan files and imports them onto the Kanban board.

Settings:
- `switchboard.planScanner.enabled` (default: true)
- `switchboard.planScanner.intervalSeconds` (default: 10, min 3, max 300)
- `switchboard.planScanner.presets.antigravity` — Scan Google Antigravity brain plans
- `switchboard.planScanner.presets.windsurfDevin` — Scan Windsurf / Devin Desktop plans
- `switchboard.planScanner.presets.cursor` — Scan Cursor plans
- `switchboard.planScanner.presets.claudeCode` — Scan Claude Code plans
- `switchboard.planScanner.scanSwitchboardPlans` — Include workspace's own `.switchboard/plans/`
- `switchboard.planScanner.customSources` — Custom plan-file sources for any other tool
- `switchboard.planScanner.chatPlanDestinations` — Directories the chat agent writes plans to

### Plan Watcher
Periodically scans for plan files created outside the editor.

Settings: `switchboard.planWatcher.periodicScanEnabled` (default: true), `switchboard.planWatcher.scanIntervalMs` (default: 10000, min 2000, max 300000)

### Plan Review Panel
A dedicated panel for contextual plan inspection and inline commenting. Features:
- **Text selection + comment** — Highlight plan text, type a comment, and send it to the Planner agent for targeted improvements
- **Inline metadata editing** — Column, complexity (manual override), dependencies, topic, and full plan text editing
- **Send to Agent** — Dispatch the plan to the next agent
- **Complete Plan** — Mark as completed
- **Delete Plan** — Remove with confirmation
- **Copy Plan Link** — Copy absolute file path to clipboard

Setting: `switchboard.review.autoRefresh` (default: true), `switchboard.plans.defaultOpenMode` (`preview` | `edit`, default: `preview`)

### Code Mapping
Generate code path prompts to gather context before writing code. Use the Analyst's "GENERATE CONTEXT MAP" action to produce structured context maps in `.switchboard/context-maps/`.

---

## 6. Pair Programming Mode

Splits tasks: Lead Coder gets complex parts, cheap Coder CLI handles boilerplate.

**Modes:**
- **CLI Parallel** — Dispatch both agents to terminals automatically.
- **Hybrid** — Clipboard prompt for IDE chat (Lead Coder), terminal dispatch for Coder.
- **Full Clipboard** — Both agents get clipboard prompts / notifications.

Setting: `switchboard.pairProgramming.aggressive` (default: false) — When enabled, the planner classifies more tasks as Band A (routine), shifting work to the cheaper Coder agent.

Command: `switchboard.setPairProgrammingModeFromKanban`

---

## 7. Multi-Repo Control Plane

Run a single board that orchestrates agents across multiple repositories with a shared local database.

### Commands
- `switchboard.scaffoldMultiRepo` — Multi-Repo: Scaffold Control Plane
- `switchboard.setupControlPlane` — Set Up Control Plane
- `switchboard.clearControlPlaneCache` — Clear Control Plane Cache
- `switchboard.refreshControlPlaneRuntime` — Refresh Control Plane Runtime
- `switchboard.reconcileKanbanDbs` — Reconcile Kanban Databases (merge split databases)
- `switchboard.resetKanbanDb` — Reset Kanban Database (deletes local DB and rebuilds from plan files)

### Settings
- `switchboard.kanban.controlPlaneRoot` — Explicit Control Plane folder override. Must point to a folder containing `.switchboard/kanban.db`.
- `switchboard.controlPlane.onboardingDismissed` — Suppress the one-time Control Plane onboarding offer.

---

## 8. Project Panel

Open with `switchboard.openProjectPanel`.

### Projects
Mini-workspaces for organizing related plans.

### Epics
Groups of plans. Supports worktree dispatch routing — agents can be dispatched to git worktrees associated with an epic.

### Constitution (Spec-Driven Governance)
Set inviolate rules and invariants in the Project panel. Switchboard automatically injects them into Planner and Coder prompts using the verbatim header:

```
PROJECT CONSTITUTION:
The following are inviolate rules and invariants for this project:
```

This ensures every agent-generated plan and code change respects your architectural guidelines, security policies, or style guides.

### Append Design Doc
Attach a Design Doc / PRD to all planner prompts for consistent context delivery. If you use the Google Drive desktop app, you can point to a local synced file so your agents always work from the latest requirements.

Settings: `switchboard.planner.designDocEnabled`, `switchboard.planner.designDocLink`, `switchboard.planner.designSystemDocEnabled`, `switchboard.planner.designSystemDocLink`

---

## 9. Design Panel (Google Stitch)

Open with `switchboard.openDesignPanel`.

Generate design assets inside the IDE using Google Stitch. Authenticate by entering your Stitch API key or OAuth access token directly in the Design panel — credentials are held in VS Code's `SecretStorage`, never in `settings.json`.

### Settings
- `switchboard.stitch.authMode` — `apiKey` | `oauth`
- `switchboard.stitch.defaultProjectId` — Default Stitch project ID
- `switchboard.stitch.defaultOutputFolder` — Default folder for downloaded assets (relative to workspace root)
- `switchboard.stitch.defaultModelId` — `GEMINI_3_FLASH` | `GEMINI_3_1_PRO` (default: `GEMINI_3_FLASH`)
- `switchboard.stitch.defaultCreativeRange` — `EXPLORE` | `REFINE` | `REIMAGINE` (default: `EXPLORE`)

---

## 10. Research / Local Docs Panel

Manage local research, design system files, and Antigravity Brain artifacts.

### Settings
- `switchboard.research.localFolderPaths` — Paths to folders containing research files (`.md`, `.txt`, `.markdown`, `.rst`, `.adoc`). Supports `~` for home directory.
- `switchboard.research.htmlFolderPaths` — Paths to folders containing HTML prototype files (`.html`, `.htm`) for preview.
- `switchboard.research.designFolderPaths` — Paths to folders containing design system files and image assets (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`).
- `switchboard.research.antigravityBrainEnabled` — Show Antigravity session artifacts in the LOCAL DOCS panel (default: false).

---

## 11. PM Tool Sync

### ClickUp
- Set API token: `switchboard.setClickUpToken` — Token stored in `SecretStorage`
- Import tasks: `switchboard.importFromClickUp`
- Find list: `switchboard.clickupFindList`
- Find task: `switchboard.clickupFindTask`
- Search tasks: `switchboard.clickupSearchTasks`
- Get subtasks: `switchboard.clickupGetSubtasks`
- Create task: `switchboard.clickupCreateTask`
- Update task: `switchboard.clickupUpdateTask`
- Add comment: `switchboard.clickupAddComment`

### Linear
- Set API token: `switchboard.setLinearToken` — Token stored in `SecretStorage`
- Import issues: `switchboard.importFromLinear`
- Query issues: `switchboard.linearQueryIssues`
- Get issue: `switchboard.linearGetIssue`
- Update state: `switchboard.linearUpdateState`
- Add comment: `switchboard.linearAddComment`
- Update description: `switchboard.linearUpdateDescription`

### Notion
- Set API token: `switchboard.setNotionToken` — Token stored in `SecretStorage`
- Fetch design doc: `switchboard.fetchNotionDesignDoc` — Fetches and caches a Notion page as design doc

### Ticket Import / Refine
- `switchboard.importLinearTask` — Import a single Linear issue as a plan
- `switchboard.importClickUpTask` — Import a single ClickUp task as a plan
- `switchboard.importTaskAsDocument` — Import a task as a document (plan or doc mode)
- `switchboard.importAllTasks` — Bulk import all tasks from a provider
- `switchboard.pushTicketEdits` — Push edits back to the PM tool
- `switchboard.deleteTicket` — Delete a ticket
- `switchboard.changeTicketStatus` — Change ticket status
- `switchboard.postTicketComment` — Post a comment to a ticket
- `switchboard.downloadAttachment` — Download an attachment from a ticket
- `switchboard.getAttachmentList` — Get attachment list for a ticket
- `switchboard.refineTask` — Refine a task description
- `switchboard.askAgentTask` — Ask an agent about a task

### Operation Modes
- **Coding Mode** (`switchboard.defaultMode = "action"`, default) — Bidirectional, real-time sync on every column move.
- **Board Management Mode** (`switchboard.defaultMode = "plan"`) — Pulls tasks automatically, processes cards independently, and writes back only when `COMPLETED`.

### Live Sync Mode
Automatically syncs edits back to ClickUp/Linear every 30 seconds.
- Pause/resume from card right-click menu.
- Sync status indicators (pulsing green, amber, red).
- Conflict detection and auto-idle pause.

### Auto-Pull Timers
Optionally enable automatic updates on a 5/15/30/60-minute timer. Managed via `IntegrationAutoPullService` with per-workspace `setTimeout` scheduling.

---

## 12. NotebookLM Airlock

Create code bundles to feed into Google NotebookLM for free sprint planning.

1. Click the **Airlock** tab and click **Bundle Code** to create docx bundles of your repo in `.switchboard/airlock/`.
2. Upload the bundles to a Google NotebookLM notebook.
3. Ask NotebookLM to write plans according to the generated "How to Plan" guide.
4. Copy the output and click **Import from Clipboard** on the board.

Command: `switchboard.importNotebookLMPlans`

---

## 13. Google Jules Integration

Send low-priority tasks directly to Jules (100 free requests/day).

Setting: `switchboard.jules.autoSync` (default: false) — When enabled, automatically runs `git add/commit/push` before sending plans to Jules.

Kanban messages: `julesLowComplexity` (dispatch low-complexity plans), `julesSelected` (dispatch selected plans).

---

## 14. Archive System

### DuckDB Plan Archive
Completed plans are archived into a DuckDB database for historical research.

Settings:
- `switchboard.archive.dbPath` — Path to DuckDB archive database (e.g., `~/GoogleDrive/SwitchboardArchives/{workspace}.duckdb`). Leave empty to disable archiving.
- `switchboard.archive.autoArchiveCompleted` (default: true) — Automatically archive plans when moved to `COMPLETED` column.

### Searching Archives
Use the `/archive` IDE chat command to search the DuckDB plan archive.

---

## 15. Status Bar Hub

A grouped actions dropdown in the VS Code status bar. When `compactMode` is enabled, all visible Switchboard status bar actions are grouped into a single hub dropdown. When disabled, individual buttons are shown.

### Settings
- `switchboard.statusBar.showAgentOpenToggle` (default: false) — Show the agent file-open guard toggle
- `switchboard.statusBar.showTerminalControls` (default: false) — Show Agents/Clear/Reset terminal buttons
- `switchboard.statusBar.showKanbanButton` (default: false) — Show Open Kanban button
- `switchboard.statusBar.showArtifactsButton` (default: false) — Show Open Artifacts Panel button
- `switchboard.statusBar.showDesignButton` (default: false) — Show Open Design Panel button
- `switchboard.statusBar.showProjectButton` (default: false) — Show Open Project Panel button
- `switchboard.statusBar.compactMode` (default: true) — Group into single hub dropdown

Command: `switchboard.openHub`

---

## 16. Themes

Skin the UI to taste.

### Settings
- `switchboard.theme.name` — `afterburner` | `claudify` (default: `afterburner`)
  - **Afterburner** — Cyberpunk theme, brighter cyan, Hanken Grotesk, scanline effects
  - **Claudify** — Afterburner with Claude terracotta accent and Poppins headings
- `switchboard.theme.disableCyberAnimation` (default: false) — Disable the animated rolling CRT sweep beam

---

## 17. Core Workflows

### Batching
Send multiple plans in one prompt. Pay system prompt overhead once. Switchboard instructs agents to use their native subagent features for batch work — dispatch one sub-agent per plan for concurrent execution.

### Pair Programming
See [Pair Programming Mode](#6-pair-programming-mode).

### Plan Review Comments
Highlight plan text in the Review panel to send targeted feedback to the Planner agent. The comment references the exact quoted text and your question/comment.

### Code Mapping
Use the Analyst's "GENERATE CONTEXT MAP" action to produce structured context maps in `.switchboard/context-maps/` before writing code.

### Report and Send Back
Testing failed? Press **Report** to return cards with logs to the Coder column for rework.

### Cross-IDE Workflows
Copy links and prompts to share state between Antigravity, Windsurf, and Cursor. Terminal registry supports cross-IDE gating — terminals registered by one IDE are not claimed by another.

### Agent File Opening Prevention
When enabled, Switchboard auto-closes any file that gets opened in the editor (prevents agents from opening files that clutter your workspace). Use `switchboard.forceOpenFile` to override and open a specific file.

Settings: `switchboard.preventAgentFileOpening` (default: false)
Command: `switchboard.togglePreventAgentFileOpening`

---

## 18. Quota Economics

### Task Batching
Batching tasks means you pay for system prompts and context windows once rather than multiple times. Send columns of plans together.

### Opus/Sonnet Split
Use Opus in the **Planner** role to write detailed plans, identify edge cases, and assign complexity. Use Sonnet in the **Lead Coder** role to implement code. Use Sonnet or Opus in the **Reviewer** slot. This plan-code-review split reduces primary credit costs.

### Pair Programming Mode
When enabled, Switchboard routes low-complexity boilerplate tasks to a cheap Coder agent (like Gemini CLI Flash) in parallel, reserving your premium IDE coder for complex architectural and logic tasks.

### Spreading Work Across Models
IDE subscriptions often include capable models on unlimited quotas (e.g., Kimi K2.5 in Windsurf, Gemini Flash in Antigravity). Use them strategically for planning, review, or implementation to save flagship model credits.

### NotebookLM Airlock
Access unlimited Gemini Pro planning quota by bundling your repo and uploading to NotebookLM. See [NotebookLM Airlock](#12-notebooklm-airlock).

### Google Jules
Send low-priority tasks to Jules (100 free requests/day). See [Google Jules Integration](#13-google-jules-integration).

---

## 19. Prompt Controls

- **Stricter coder prompts**: `switchboard.accurateCoding.enabled` (default: false) — Coder prompts include instructions to follow the `accuracy.md` workflow.
- **Inline challenge**: `switchboard.leadCoder.inlineChallenge` (default: false) — Lead Coder execution prompts include an inline challenge step before implementation.
- **Advanced reviewer mode**: `switchboard.reviewer.advancedMode` (default: false) — Reviewer prompts include deep regression analysis instructions (caller tracing, race condition checks, orphaned reference detection). Token-intensive.
- **Unified team prompt rigor**: `switchboard.team.strictPrompts` (default: false) — When enabled, both planner and reviewer prompts use strict mode.

---

## 20. All Settings Reference

All settings are defined in `package.json` contributes.configuration. Scope: `application` = global, `resource` = per-workspace, `window` = per-window.

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `switchboard.defaultMode` | string (`action` \| `plan`) | `action` | — | Default mode for switchboard commands |
| `switchboard.stitch.authMode` | string (`apiKey` \| `oauth`) | — | application | Stitch authentication mode |
| `switchboard.stitch.defaultProjectId` | string | `""` | application | Default Stitch project ID |
| `switchboard.stitch.defaultOutputFolder` | string | `""` | resource | Default folder for Stitch assets |
| `switchboard.stitch.defaultModelId` | string (`GEMINI_3_FLASH` \| `GEMINI_3_1_PRO`) | `GEMINI_3_FLASH` | resource | Default AI model for Stitch |
| `switchboard.stitch.defaultCreativeRange` | string (`EXPLORE` \| `REFINE` \| `REIMAGINE`) | `EXPLORE` | resource | Default creative range for Stitch |
| `switchboard.controlPlane.onboardingDismissed` | boolean | false | — | Suppress Control Plane onboarding offer |
| `switchboard.cli.command` | string | `""` | — | CLI command to launch for handoff |
| `switchboard.cli.args` | array | `[]` | — | Default arguments for CLI agent |
| `switchboard.cli.yolo` | boolean | false | — | Enable auto-approve mode |
| `switchboard.cli.yoloFlags` | object | — | — | Auto-approve flags per CLI provider |
| `switchboard.polling.initialWait` | integer | 120 | — | Initial wait (seconds) before first workflow check |
| `switchboard.polling.interval` | integer | 60 | — | Subsequent polling interval (seconds) |
| `switchboard.accurateCoding.enabled` | boolean | false | — | Coder prompts include accuracy.md workflow |
| `switchboard.leadCoder.inlineChallenge` | boolean | false | — | Lead Coder prompts include inline challenge step |
| `switchboard.reviewer.advancedMode` | boolean | false | — | Reviewer prompts include deep regression analysis |
| `switchboard.pairProgramming.aggressive` | boolean | false | — | Shift more tasks to cheaper Coder agent |
| `switchboard.terminal.clearBeforePrompt` | boolean | true | — | Send /clear before dispatching prompts |
| `switchboard.terminal.clearBeforePromptDelay` | number | 2000 | — | Milliseconds to wait after /clear (0–10000) |
| `switchboard.jules.autoSync` | boolean | false | — | Auto git add/commit/push before Jules dispatch |
| `switchboard.planner.designDocEnabled` | boolean | false | — | Append Design Doc / PRD link to planner prompts |
| `switchboard.planner.designDocLink` | string | `""` | — | URL or path to Design Doc / PRD |
| `switchboard.planner.designSystemDocEnabled` | boolean | false | — | Append Design System Doc link to planner prompts |
| `switchboard.planner.designSystemDocLink` | string | `""` | — | URL or path to Design System Doc |
| `switchboard.team.strictPrompts` | boolean | false | — | Unified team prompt rigor (planner + reviewer) |
| `switchboard.review.strictPrompts` | boolean | false | — | *Deprecated*: use `team.strictPrompts` |
| `switchboard.planner.strictPrompts` | boolean | false | — | *Deprecated*: use `team.strictPrompts` |
| `switchboard.plans.defaultOpenMode` | string (`preview` \| `edit`) | `preview` | — | Default mode for opening plans from sidebar |
| `switchboard.review.autoRefresh` | boolean | true | resource | Auto-refresh Review panel on plan file change |
| `switchboard.security.strictInboxAuth` | boolean | true | application | Require session token auth for inbox dispatch |
| `switchboard.research.localFolderPaths` | array | `[]` | application | Paths to local research files |
| `switchboard.research.htmlFolderPaths` | array | `[]` | application | Paths to HTML prototype files |
| `switchboard.research.designFolderPaths` | array | `[]` | application | Paths to design system files |
| `switchboard.research.antigravityBrainEnabled` | boolean | false | — | Show Antigravity session artifacts |
| `switchboard.kanban.completedLimit` | integer | 100 | resource | Max cards in Completed column (1–500) |
| `switchboard.kanban.dbPath` | string | `""` | resource | Custom Kanban DB path |
| `switchboard.kanban.controlPlaneRoot` | string | `""` | resource | Explicit Control Plane folder override |
| `switchboard.workspaceDatabaseMappings` | object | — | window | *Deprecated*: mappings now stored in DB |
| `switchboard.workspace.ignoreStrategy` | string | `targetedGitignore` | resource | Git ignore strategy |
| `switchboard.workspace.ignoreRules` | array | `[]` | resource | Stored ignore rules |
| `switchboard.archive.dbPath` | string | `""` | resource | DuckDB archive database path |
| `switchboard.archive.autoArchiveCompleted` | boolean | true | resource | Auto-archive completed plans |
| `switchboard.preventAgentFileOpening` | boolean | false | — | Auto-close opened files |
| `switchboard.excludeReviewedBacklogFromDropdown` | boolean | true | — | Hide reviewed/backlog plans from sidebar dropdown |
| `switchboard.planWatcher.periodicScanEnabled` | boolean | true | resource | Enable periodic plan file scanning |
| `switchboard.planWatcher.scanIntervalMs` | integer | 10000 | resource | Scan interval (2000–300000 ms) |
| `switchboard.planScanner.enabled` | boolean | true | resource | Master switch for Plan Scanner |
| `switchboard.planScanner.intervalSeconds` | integer | 10 | resource | Seconds between scanner sweeps (3–300) |
| `switchboard.planScanner.presets.antigravity` | boolean | true | resource | Scan Antigravity brain plans |
| `switchboard.planScanner.presets.windsurfDevin` | boolean | true | resource | Scan Windsurf / Devin plans |
| `switchboard.planScanner.presets.cursor` | boolean | true | resource | Scan Cursor plans |
| `switchboard.planScanner.presets.claudeCode` | boolean | true | resource | Scan Claude Code plans |
| `switchboard.planScanner.scanSwitchboardPlans` | boolean | true | resource | Include workspace's `.switchboard/plans/` |
| `switchboard.planScanner.customSources` | array | `[]` | resource | Custom plan-file sources |
| `switchboard.planScanner.chatPlanDestinations` | array | `[]` | resource | Directories for chat agent plan output |
| `switchboard.notionBackup` | object | `{}` | — | Notion database backup configuration |
| `switchboard.autoSelectFirstWorkspace` | boolean | true | — | Auto-select first workspace on activation |
| `switchboard.statusBar.showAgentOpenToggle` | boolean | false | window | Show agent-open guard toggle |
| `switchboard.statusBar.showTerminalControls` | boolean | false | window | Show terminal control buttons |
| `switchboard.statusBar.showKanbanButton` | boolean | false | window | Show Open Kanban button |
| `switchboard.statusBar.showArtifactsButton` | boolean | false | window | Show Open Artifacts button |
| `switchboard.statusBar.showDesignButton` | boolean | false | window | Show Open Design button |
| `switchboard.statusBar.showProjectButton` | boolean | false | window | Show Open Project button |
| `switchboard.statusBar.compactMode` | boolean | true | window | Group into single hub dropdown |
| `switchboard.persistPanels` | boolean | false | — | Reopen panels on VS Code restart |
| `switchboard.theme.cyberPanel` | boolean | false | — | *Deprecated*: Cyber Panel is always active |
| `switchboard.theme.disableCyberAnimation` | boolean | false | — | Disable animated CRT sweep beam |
| `switchboard.theme.name` | string (`afterburner` \| `claudify`) | `afterburner` | window | Visual theme for webviews |

---

## 21. All Commands Reference

All commands registered in `extension.ts` and declared in `package.json`:

### Setup & Configuration
| Command ID | Title |
|------------|-------|
| `switchboard.setup` | Switchboard: Setup AI Protocol Files |
| `switchboard.setupIDEs` | Switchboard: Setup IDEs |
| `switchboard.openSetupPanel` | Switchboard: Open Setup |

### Kanban & Board
| Command ID | Title |
|------------|-------|
| `switchboard.openKanban` | Switchboard: Open KANBAN |
| `switchboard.resetKanbanDb` | Switchboard: Reset Kanban Database |
| `switchboard.reconcileKanbanDbs` | Switchboard: Reconcile Kanban Databases |
| `switchboard.fullSync` | Full sync (file→DB + refresh) |
| `switchboard.refreshUI` | Refresh UI |
| `switchboard.mappingsChanged` | Clear mapping cache |

### Plans
| Command ID | Title |
|------------|-------|
| `switchboard.initiatePlan` | Create a draft plan ticket |
| `switchboard.importPlanFromClipboard` | Import plan from clipboard |
| `switchboard.importNotebookLMPlans` | Import NotebookLM plans |
| `switchboard.importUnclaimedPlans` | Import unclaimed plans from AI IDE folders |
| `switchboard.openPlan` | Open plan (preview or edit mode) |
| `switchboard.copyPlanFromKanban` | Copy plan from Kanban |
| `switchboard.completePlanFromKanban` | Complete plan from Kanban |
| `switchboard.restorePlanFromKanban` | Restore plan from Kanban |
| `switchboard.deletePlanFromReview` | Delete plan from Review panel |
| `switchboard.moveKanbanCardByPlanFile` | Move Kanban card by plan file |
| `switchboard.kanbanForwardMove` | Move card forward |
| `switchboard.kanbanBackwardMove` | Move card backward |

### Agent Dispatch
| Command ID | Title |
|------------|-------|
| `switchboard.triggerAgentFromKanban` | Trigger agent from Kanban (single) |
| `switchboard.triggerBatchAgentFromKanban` | Trigger batch agent from Kanban |
| `switchboard.batchDispatchLow` | Batch dispatch low-complexity plans |
| `switchboard.dispatchToCoderTerminal` | Dispatch to coder terminal |
| `switchboard.copyChatPrompt` | Copy chat prompt |
| `switchboard.triggerPlanScan` | Trigger plan scan |

### Terminal Management
| Command ID | Title |
|------------|-------|
| `switchboard.createAgentGrid` | Open Agent Terminals |
| `switchboard.createAgentGridEditor` | Open Agent Terminals (editor) |
| `switchboard.disposeAllGridTerminals` | Dispose all grid terminals |
| `switchboard.deregisterAllTerminals` | Reset Agent Terminals |
| `switchboard.clearAllTerminals` | Clear Agent Terminals |
| `switchboard.focusTerminal` | Focus terminal by PID |
| `switchboard.focusTerminalByName` | Focus terminal by name |
| `switchboard.focusAllTerminals` | Focus all terminals |
| `switchboard.revealWorktreeTerminal` | Reveal worktree terminal |

### AUTOBAN
| Command ID | Title |
|------------|-------|
| `switchboard.setAutobanEnabledFromKanban` | Enable/disable AUTOBAN |
| `switchboard.setAutobanPausedFromKanban` | Pause/resume AUTOBAN |
| `switchboard.resetAutobanTimersFromKanban` | Reset AUTOBAN timers |
| `switchboard.addAutobanTerminalFromKanban` | Add AUTOBAN terminal |
| `switchboard.removeAutobanTerminalFromKanban` | Remove AUTOBAN terminal |
| `switchboard.resetAutobanPoolsFromKanban` | Reset AUTOBAN pools |

### Pair Programming
| Command ID | Title |
|------------|-------|
| `switchboard.setPairProgrammingModeFromKanban` | Set pair programming mode |

### Multi-Repo
| Command ID | Title |
|------------|-------|
| `switchboard.scaffoldMultiRepo` | Multi-Repo: Scaffold Control Plane |
| `switchboard.setupControlPlane` | Set Up Control Plane |
| `switchboard.clearControlPlaneCache` | Clear Control Plane Cache |
| `switchboard.refreshControlPlaneRuntime` | Refresh Control Plane Runtime |

### Panels
| Command ID | Title |
|------------|-------|
| `switchboard.openPlanningPanel` | Open Planning Panel |
| `switchboard.openProjectPanel` | Open Project Panel |
| `switchboard.openDesignPanel` | Open Design Panel |
| `switchboard.openHub` | Open Status Bar Hub |
| `switchboard.triggerPlanningPanelSync` | Trigger Planning Panel sync |

### ClickUp
| Command ID | Title |
|------------|-------|
| `switchboard.setClickUpToken` | Set ClickUp API Token |
| `switchboard.importFromClickUp` | Import Tasks from ClickUp |
| `switchboard.clickupFindList` | Find ClickUp list |
| `switchboard.clickupFindTask` | Find ClickUp task |
| `switchboard.clickupSearchTasks` | Search ClickUp tasks |
| `switchboard.clickupGetSubtasks` | Get ClickUp subtasks |
| `switchboard.clickupCreateTask` | Create ClickUp task |
| `switchboard.clickupUpdateTask` | Update ClickUp task |
| `switchboard.clickupAddComment` | Add ClickUp comment |

### Linear
| Command ID | Title |
|------------|-------|
| `switchboard.setLinearToken` | Set Linear API Token |
| `switchboard.importFromLinear` | Import Issues from Linear |
| `switchboard.linearQueryIssues` | Query Linear issues |
| `switchboard.linearGetIssue` | Get Linear issue |
| `switchboard.linearUpdateState` | Update Linear issue state |
| `switchboard.linearAddComment` | Add Linear comment |
| `switchboard.linearUpdateDescription` | Update Linear issue description |

### Notion
| Command ID | Title |
|------------|-------|
| `switchboard.setNotionToken` | Set Notion API Token |
| `switchboard.fetchNotionDesignDoc` | Fetch Notion Design Doc |

### Ticket Import / Refine
| Command ID | Title |
|------------|-------|
| `switchboard.importLinearTask` | Import Linear task |
| `switchboard.importClickUpTask` | Import ClickUp task |
| `switchboard.importTaskAsDocument` | Import task as document |
| `switchboard.importAllTasks` | Import all tasks |
| `switchboard.pushTicketEdits` | Push ticket edits |
| `switchboard.deleteTicket` | Delete ticket |
| `switchboard.changeTicketStatus` | Change ticket status |
| `switchboard.postTicketComment` | Post ticket comment |
| `switchboard.downloadAttachment` | Download attachment |
| `switchboard.getAttachmentList` | Get attachment list |
| `switchboard.refineTask` | Refine task |
| `switchboard.askAgentTask` | Ask agent about task |

### Review & Comments
| Command ID | Title |
|------------|-------|
| `switchboard.sendReviewComment` | Send review comment to Planner |
| `switchboard.analystMapFromKanban` | Analyst context map (single) |
| `switchboard.analystMapFromKanbanBatch` | Analyst context map (batch) |

### File Opening
| Command ID | Title |
|------------|-------|
| `switchboard.forceOpenFile` | Override file open prevention |
| `switchboard.togglePreventAgentFileOpening` | Toggle agent file opening prevention |

### Workspace
| Command ID | Title |
|------------|-------|
| `switchboard.cleanWorkspace` | Clean Working Memory |
| `switchboard.housekeepNow` | Run housekeeping (clean transient state) |
| `switchboard.selectSession` | Select session |
| `switchboard.syncImportedPlans` | Sync imported plans |
| `switchboard.refreshIntegrationCache` | Refresh integration cache |
| `switchboard.updateSidebarTerminals` | Update sidebar terminal statuses (internal) |

---

## 22. IDE Chat Commands

These are slash commands available in IDE chat agents (Windsurf, Cursor, Antigravity) when the Switchboard workflow files are installed:

- **`/switchboard-chat`** — PM consultation workflow. Activate to get planning advice and project management guidance.
- **`/improve-plan`** — Deep planning and adversarial review. Runs a multi-phase workflow to write, critique, and refine plans.
- **`/archive`** — Search the DuckDB plan archive for historical plans and conversations.
- **`/export`** — Save the current conversation to the archive for future reference.

---

## 23. Privacy & Security

- **100% Local-First** — No external proxy servers, no telemetry, no tracking.
- **Secure SecretStorage** — API tokens for ClickUp, Linear, Notion, and Stitch are saved in VS Code's `SecretStorage`. Keys are never sent to third-party endpoints.
- **No telemetry** — Switchboard does not phone home. All audit data is local-only (`.switchboard/sessions/activity.jsonl`).
- **MIT License** — Fully open source.

### Security Model
- Signed dispatch auth envelope (`HMAC-SHA256`) for terminal dispatch
- Strict token + signature validation in dispatch path
- Nonce replay protection
- Stale execute timestamp rejection
- Agent-name/path containment checks before filesystem sinks
- Security-critical settings enforced at application scope
- `switchboard.security.strictInboxAuth` (default: true) — Require session token authentication for all inbox dispatch messages

---

## 24. Architecture

### VS Code Extension
- Extension host (`src/extension.ts`) owns UI, terminal references, startup/setup workflows, and file watchers
- `TaskViewerProvider` — Sidebar webview, dispatch actions, state refresh loops
- `KanbanProvider` — Kanban board webview panel, column-to-role dispatch mapping, complexity routing
- `SetupPanelProvider` — Setup panel webview, configuration management
- `PlanningPanelProvider` — Planning panel webview
- `DesignPanelProvider` — Design panel webview (Google Stitch)
- `ReviewProvider` — Plan review panel webview

### Local SQLite DB
- `KanbanDatabase` (`src/services/KanbanDatabase.ts`) — Uses `sql.js` (WASM SQLite)
- Database file: `.switchboard/kanban.db`
- Schema: `plans` table with `plan_id` (PK), `session_id` (unique), `topic`, `plan_file`, `kanban_column`, `status`, `complexity`, `workspace_id`, `created_at`, `updated_at`, `last_action`, `source_type`
- Upsert semantics via `INSERT ... ON CONFLICT(plan_id) DO UPDATE`
- Fallback: file-derived state from run-sheet events when DB unavailable

### DuckDB Plan Archive
- `ArchiveManager` (`src/services/ArchiveManager.ts`) — Archives completed plans
- Path configurable via `switchboard.archive.dbPath`

### File Protocol
- `.switchboard/` — Core runtime data (state, sessions, plans, context maps, archives)
- `.agent/` — Workflow markdown contracts and persona files
- `state.json` — Lock-protected, atomically written shared state
- `sessions/*.json` — Run sheets tracking session ID, plan file, topic, workflow timeline
- `sessions/activity.jsonl` — Audit stream for workflow/dispatch events
- `plans/` — Locally created and mirrored plan files
- `context-maps/` — Analyst-generated context map artifacts

### Git Ignore Integration
- `switchboard.workspace.ignoreStrategy` controls how `.switchboard/` files are excluded from git
- `WorkspaceExcludeService` manages the ignore strategy

---

## 25. Troubleshooting / FAQ

### Setup Issues
**Q: The sidebar shows "Setup Required" — what do I do?**
A: Click the status bar item or run `Switchboard: Setup AI Protocol Files` (`switchboard.setup`). This seeds `.agent/` workflow files and personas.

**Q: I don't see any terminals after clicking "OPEN AGENT TERMINALS"**
A: Make sure you've configured CLI agent startup commands in the Setup panel. The command (e.g., `gemini --approval-mode yolo`) must be valid and the CLI tool must be installed.

### Kanban Database Problems
**Q: Kanban board is empty or showing stale data**
A: Try `switchboard.fullSync` to force a file→DB sync and refresh. If that doesn't work, use `switchboard.resetKanbanDb` to delete the DB and rebuild from plan files.

**Q: Cards are in wrong columns after a DB reset**
A: The file-derived fallback uses `deriveKanbanColumn()` which may disagree with DB-managed column positions. Run `switchboard.fullSync` after any DB reset.

### Sync Conflicts
**Q: Live Sync shows a red indicator**
A: A conflict was detected. Live Sync auto-pauses on conflict. Resume from the card right-click menu after resolving the conflict in your PM tool.

**Q: ClickUp/Linear import says "No new tasks"**
A: Tasks that are already tracked (by session ID) are skipped. Use `switchboard.importUnclaimedPlans` to see all unclaimed plans and pick which to add.

### Agent Not Dispatching
**Q: Dragging a card doesn't trigger the agent**
A: Check that CLI Triggers mode is enabled (not Prompt mode). Verify the target terminal is registered and still open. If the terminal was closed, Switchboard shows a warning notification.

**Q: AUTOBAN is enabled but not dispatching**
A: Check per-column enable state and intervals. Verify terminal pools have terminals. Check `globalSessionCap` and `maxSendsPerTerminal` limits. Check `complexityFilter` — if set to `low_only` or `high_only`, cards not matching are skipped.

### Plan Scanner Not Detecting Files
**Q: Plans from my AI IDE aren't showing up**
A: Verify the corresponding preset is enabled (`switchboard.planScanner.presets.*`). Ensure the folders exist (presets are auto-skipped if folders don't exist). Check `switchboard.planScanner.intervalSeconds` — lower values mean faster detection. For custom tools, configure `switchboard.planScanner.customSources`.

### Theme Not Applying
**Q: I changed the theme but the UI looks the same**
A: Close and reopen any open Switchboard panels (Kanban, Setup, Planning). The theme applies on panel load.

### Agent File Opening
**Q: Files keep auto-closing when I'm trying to work**
A: `switchboard.preventAgentFileOpening` is enabled. Disable it via the status bar toggle or run `switchboard.togglePreventAgentFileOpening`. To open a specific file while the guard is active, right-click and select "Override Open" (`switchboard.forceOpenFile`).
