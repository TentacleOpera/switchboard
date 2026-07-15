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
8. [Projects, Features & Governance](#8-projects-features--governance)
9. [Design Panel (Google Stitch + Claude)](#9-design-panel-google-stitch--claude)
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
25. [File Layout & Runtime State](#25-file-layout--runtime-state)
26. [Kanban Database Schema](#26-kanban-database-schema)
27. [Webview Panels Reference](#27-webview-panels-reference)
28. [Memo Capture Mode](#28-memo-capture-mode)
29. [Automated Triage Pipeline](#29-automated-triage-pipeline)
30. [Remote Control (provider-agnostic)](#30-remote-control-provider-agnostic)
31. [Troubleshooting / FAQ](#31-troubleshooting--faq)
32. [Using Switchboard with claude.ai](#32-using-switchboard-with-claudeai)

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
Run `Switchboard: Setup AI Protocol Files` (`switchboard.setup`) to initialize `.agents/` workflow files and personas in your workspace. This seeds the workflow contracts and agent personas that Switchboard uses for prompt generation.

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
| `project_manager` | Project Manager | Host-agnostic management console — drives the board over the LocalApiServer HTTP API. Core role, on by default; activated via the **Manage** button (and the board's **Run Selected Plans** targeted-pass button). |
| `ticket_updater` | Ticket Updater | Reads imported tickets and posts short triage verdicts (severity, area, assessment, recommended action, routing) back to ClickUp/Linear as comments. Never overwrites the ticket description. |
| `researcher` | Researcher | Research tasks. |
| `splitter` | Splitter Agent | Splits large plans into sub-plans. |
| `gatherer` | Context Gatherer | Gathers code context before planning. |
| `orchestrator` | Orchestrator | Runs an entire Feature end-to-end with native subagents. Off by default — enable in the Kanban Agents tab to dispatch features directly (otherwise **Orchestrate** copies the prompt). Defaults to a subagent-per-subtask policy and can optionally use a git worktree per plan. See §8 (Features). |
| `claude_designer` | Claude Designer | Imports a design from claude.ai/design into a target folder using the repo's existing components and styles. Off by default. See §9 (Design Panel → DESIGN SYSTEM tab, Claude Design Systems source). |
| `mcp_monitor` | MCP Monitor | Monitor-only role. On an interval it pings a dedicated Claude terminal to check your connected MCP sources (Slack, Gmail, Google Calendar, custom) and report anything needing attention. Off by default; it is read-only and cannot receive execute dispatches. See §4 (MCP Monitor). |

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

### MCP Monitor
The **MCP Monitor** watches your connected MCP sources on a timer and surfaces anything that needs attention — without you having to open Slack/Gmail/Calendar yourself. It runs in the Kanban **Automation** panel:
- **MCP MONITOR** on/off dropdown.
- **Interval** — 1 / 2 / 5 / 10 / 15 / 30 minutes (one global cadence; default 5 min, off).
- **Watched Sources** — checklist of **Slack**, **Gmail**, **Google Calendar**, and **Custom** (with a free-text custom-instruction box).
- **Status line + Launch Monitor Terminal** — shows "🟢 Monitor terminal: running" or "🔴 No monitor terminal running", and launches the dedicated terminal.

On each tick Switchboard sends a read-only prompt to the dedicated "MCP Monitor" Claude terminal, which checks the selected sources through your claude.ai MCP servers and reports back in that terminal pane. It requires the `mcp_monitor` role terminal (launch via `switchboard.launchMcpMonitorTerminal`). Config is stored machine-globally.

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

## 8. Projects, Features & Governance

This section covers **Projects**, **Features**, the **Constitution**, and the **System** doc. Most of this is managed in the **Project Panel** (`switchboard.openProjectPanel`) — the PROJECTS, FEATURES, CONSTITUTION, and SYSTEM tabs. The exceptions are board-level project actions — creating a project, assigning plans to it, and the **PROJECT CONTEXT** toggle — which live on the **Kanban board** (`switchboard.openKanban`) control strip because they act on the board.

### Projects
A **Project** is a workspace-scoped grouping of plans *and* the carrier of project-wide context (a PRD / spec). Use projects to slice one repo's board into areas (e.g. `frontend`, `backend`, `infra`) and to give every agent working in that area the same requirements.

**Create a project (on the Kanban board)** — On the Kanban tab control strip, click **+ (Add Project)** and enter a name. The project is created immediately in the workspace's Kanban database.

**Assign plans to a project** — Select one or more plans on the board, choose the target workspace/project in the **Workspace/Project Selector**, and click **ASSIGN**.

**Filter / delete** — The Workspace/Project Selector filters the board to a single project (or "No Project"). The **Delete Project** icon button removes the selected project.

**Per-project PRD (Product Requirements Document)** — Each project can have a PRD: a loose set of requirements respected across every plan in that project, independent of features. Author it on the **Project Panel's PROJECTS tab** — pick the project, write the requirements, and click **SAVE PRD**. It is stored at `.switchboard/projects/<project>/prd.md` (git-trackable; a path hint shows the exact file).

**PROJECT CONTEXT toggle** — The **PROJECT CONTEXT** button on the Kanban control strip is off by default. When you turn it on, the active project's PRD is injected into **every dispatched prompt** — planner, lead, coder, reviewer, tester, and orchestrator — under the verbatim header:

```
PROJECT REQUIREMENTS (PRD):
```

For most roles the full PRD content is inlined; for the **Orchestrator** a link to the PRD file is passed instead (so the prompt stays slim and subagents read the file directly). This is the modern, per-project replacement for the older workspace-wide planner Design Doc setting (see *Append Design Doc / Legacy* below).

**Projects vs. Features** — A Project is a *persistent* organizational scope plus a shared spec; it has no run lifecycle. A **Feature** is an *executable* grouping of plans (its subtasks) with three run modes — see below. A plan can belong to a project and a feature at the same time.

Project state is stored in the Kanban database: the `projects` table (`id`, `name`, `workspace_id`, `created_at`) and the `project` / `project_id` columns on `plans` (see §26).

### Features
A **Feature** groups several related plans (its *subtasks*) so they can be planned and shipped as one coordinated unit. Features are managed in the **FEATURES** tab of the Project Panel and stored as files in `.switchboard/features/`.

**Creating and managing features**
- **+ New Feature** — Opens a dialog: *Feature Name* (required), *Description* (optional, markdown), and an *Add to Kanban board* checkbox (show the feature as a card immediately). Click **Create**.
- **PROMOTE TO FEATURE** (Kanban board) — Select a plan on the board and promote it; its file moves from `.switchboard/plans/` to `.switchboard/features/` and it becomes a feature.
- **+ Subtask** — Attach an existing plan to the selected feature. Subtasks are hidden from the main Kanban board (to avoid duplication) and reappear there if detached.
- **Orchestrate** — Assemble the feature + all subtasks into an orchestrator prompt (preview modal with **Copy Prompt** / **Send to Orchestrator**).
- **Delete Feature** — Deletes the feature only; its subtasks are **detached** (returned to the board), never destroyed.

**Feature cards on the board** — Feature cards have a 4px purple left border, a faint purple tint, and a `FEATURE · N subtasks` badge. Selecting one shows a purple glow (overriding the theme's normal selection color). Subtasks travel with the feature: dragging a feature to a new column cascades the move to every subtask.

**Three ways to run a feature** (the **?** button in the Features tab shows this cheat-sheet):
1. **Step** — Drag the feature column-to-column on the board; each column's agent batch-processes every subtask before the feature advances.
2. **Orchestrate** — Click **Orchestrate**; one Orchestrator agent runs the whole feature end-to-end with native subagents. Enable the **Orchestrator** role in the Kanban Agents tab to dispatch directly — otherwise the button copies the assembled prompt to paste manually.
3. **Split (recommended)** — Drag the feature to the **Planner** column to improve every subtask plan, *then* click **Orchestrate** to hand the improved feature to the Orchestrator to implement.

**Worktree dispatch routing** — A feature can be bound to a dedicated git worktree and branch so its agents work in isolation from your main checkout. Manage worktrees from the Kanban **WORKTREES** panel. Dispatched agents automatically `cd` into the worktree path and `git switch` to its branch before running; a worktree can later be marked `merged` (Switchboard removes it from disk) or `abandoned`. This makes it practical to run several features in parallel without branch churn.

Feature state is stored in the Kanban database (`plans.is_feature`, `plans.feature_id`, `plans.worktree_id`, `plans.worktree_status`, and the `worktrees` table — see §26).

### Constitution (Spec-Driven Governance)
Set inviolate rules and invariants in the Project panel. Switchboard automatically injects them into Planner and Coder prompts using the verbatim header:

```
PROJECT CONSTITUTION:
The following are inviolate rules and invariants for this project:
```

This ensures every agent-generated plan and code change respects your architectural guidelines, security policies, or style guides.

### Append Design Doc (Legacy)
Before per-project PRDs (above), context was attached workspace-wide and only to the **planner** prompt via these settings. They remain wired for back-compat, but for new work prefer the per-project PRD + **PROJECT CONTEXT** toggle, which applies to *all* roles. If you use the Google Drive desktop app, you can point a Design Doc link at a local synced file so agents always read the latest requirements.

Settings: `switchboard.planner.designDocEnabled`, `switchboard.planner.designDocLink`, `switchboard.planner.designSystemDocEnabled`, `switchboard.planner.designSystemDocLink`

---

## 9. Design Panel (Google Stitch + Claude)

Open with `switchboard.openDesignPanel`.

The Design panel keeps UI generation inside the IDE so output feeds straight into plans and code. It has six tabs: **STITCH**, **STITCH HTML**, **BRIEFS**, **HTML PREVIEWS**, **IMAGES**, and **DESIGN SYSTEM**. (For a control-by-control breakdown of every tab, see §27.)

### STITCH tab — Google Stitch
Generate and refine UI screens with Google Stitch. Authenticate by entering your Stitch API key or OAuth access token directly in the Design panel — credentials are held in VS Code's `SecretStorage`, never in `settings.json`. Output (HTML/PNG) and design tokens download to a chosen sync-destination folder, organized into per-project subfolders.

Settings:
- `switchboard.stitch.authMode` — `apiKey` | `oauth`
- `switchboard.stitch.defaultProjectId` — Default Stitch project ID
- `switchboard.stitch.defaultOutputFolder` — Default folder for downloaded assets (relative to workspace root)
- `switchboard.stitch.defaultModelId` — `GEMINI_3_FLASH` | `GEMINI_3_1_PRO` (default: `GEMINI_3_FLASH`)
- `switchboard.stitch.defaultCreativeRange` — `EXPLORE` | `REFINE` | `REIMAGINE` (default: `EXPLORE`)

### STITCH HTML tab — browse cached Stitch screens
The **STITCH HTML** tab browses your cached Stitch HTML output organized per project. A project dropdown selector lets you switch between Stitch projects, and each screen can be previewed, inspected (see Inspect Mode below), and tweaked in place. This replaces the old method of hunting through flat output folders.

### Claude (claude.ai/design) — import via DESIGN SYSTEM tab
Claude design import lives in the **DESIGN SYSTEM** tab under the "Claude Design Systems" source. It does not call an API or store a key — instead it generates a prompt that a Claude agent (CLI or chat) runs to import a design into your repo.

Workflow:
1. *(Optional)* Paste a `claude.ai/design` URL or project ID into the **claude.ai/design URL or ID (optional)** field (or leave blank to list your projects).
2. Click **Copy import prompt** (or **Import from Claude Design** to send directly to a Claude agent). The copied prompt reads, roughly:
   > Import a design from claude.ai/design into this repository, writing the implementation into `<folder>`, built with the repo's existing components and styles. *[If you gave a project: "Use the Claude Design project: `<ref>`." Otherwise: "First list my available claude.ai/design projects and ask me which one (and which screen) to import."]* If you're not logged in to Claude Design, run `/design-login` first.
3. Paste the prompt to your Claude agent, which imports the design.

To automate the import from the Kanban board, enable the **Claude Designer** agent role (off by default; see §3).

> **No Anthropic API key is stored in Switchboard.** Authentication happens inside your Claude agent via `/design-login`.

### Claude Artifacts round-trip
The **HTML PREVIEWS** tab and the Planning panel's HTML tab include **Copy upload prompt** and **Upload to Claude Artifacts** buttons that push a local HTML file to claude.ai as an Artifact. A corresponding download prompt pulls an Artifact back into your repo. This gives you a repeatable loop: pull an artifact down, edit it with any agent, push it back — useful for stakeholder-facing documents and prototypes hosted on claude.ai.

### Inspect Mode — tweak any HTML preview element
Every sandboxed HTML preview in Switchboard has an **Inspect Mode** button in its controls strip — the STITCH HTML tab, the HTML PREVIEWS tab, and the Planning panel's HTML tab. Click to toggle hover-to-select on, hover to highlight an element, click to select it, then type a tweak instruction in the popup. **Send to Agent** delivers a composed prompt (file path + CSS selector + HTML snippet + your instruction) to the coder agent terminal; **Copy Prompt** puts it on the clipboard. The agent edits the file in place and the preview auto-refreshes. Press **Escape** or click the button again to exit. Your typed instruction is preserved across auto-refreshes.

### Folder management & Link to Folder
Every folder-browsing tab (STITCH HTML, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM) uses a **Manage Folders** button to configure which folders are browsed, and a **Link** button on each folder header that copies that folder's path to the clipboard (handy for pasting into agent prompts). Folder paths are sourced from the `switchboard.research.*` settings (see §10).

---

## 10. Research / Local Docs Panel

Manage local research, design system files, and Antigravity Brain artifacts.

### Settings
- `switchboard.research.localFolderPaths` — Paths to folders containing research files (`.md`, `.txt`, `.markdown`, `.rst`, `.adoc`). Supports `~` for home directory.
- `switchboard.research.htmlFolderPaths` — Paths to folders containing HTML prototype files (`.html`, `.htm`) for preview.
- `switchboard.research.designFolderPaths` — Paths to folders containing design system files and image assets (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`).

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

**Capabilities beyond import.** ClickUp is a **push-only mirror** — Switchboard pushes state and content *out* to ClickUp but does not poll ClickUp changes back (for two-way remote control, use Linear or Notion). What's supported:
- **Content push** — local plan edits update the linked ClickUp task description.
- **Move task between lists** — including status auto-mapping when the source status has no name-match in the target list, and reporting when a task lives in multiple/sprint lists.
- **Feature round-trip** — importing a ClickUp parent-with-subtasks creates a Switchboard feature + subtasks, and local features push out as native parent/child ClickUp tasks.
- **Agent-driven surface** (via skills / LocalApiServer): create/modify tasks, comments, file attachments, and docs/doc-pages.

### Linear
- Set API token: `switchboard.setLinearToken` — Token stored in `SecretStorage`
- Import issues: `switchboard.importFromLinear`
- Query issues: `switchboard.linearQueryIssues`
- Get issue: `switchboard.linearGetIssue`
- Update state: `switchboard.linearUpdateState`
- Add comment: `switchboard.linearAddComment`
- Update description: `switchboard.linearUpdateDescription`

**Capabilities beyond import.** Unlike ClickUp, Linear is a full two-way provider:
- **Bidirectional description sync** — editing an issue's description in Linear now flows back into the local plan file automatically (with hash-based loop prevention), not only on the both-sides-changed conflict path.
- **Status/column sync both directions** via Remote Control polling (see §30).
- **Move an issue to a different Linear project.**
- **Feature round-trip** — import a parent-with-subtasks as a feature; push a local feature out as parent/child issues.
- **Comments + attachments** on top-level issues are captured into the plan body on import.
- **Archive / unarchive** via the idempotent `issueArchive` / `issueUnarchive` mutations — used by the Auto-Archive Rule (§14) to keep you under Linear's free-tier active-issue cap.

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

### Auto-Archive Rule
A provider-agnostic rule that automatically completes and archives a plan once it has sat in a designated board column past a dwell threshold — handy for keeping a board (and a free-tier Linear workspace) from filling up. Configure it on the Kanban **Setup** tab → *Auto-Archive Rule*:
- **Enable auto-archive** — checkbox (**off by default**).
- **Archive-trigger column** — dropdown populated from the live board columns.
- **Dwell threshold (hours)** — number input (default 2).

When a plan has been in the trigger column longer than the threshold it is moved to Completed, archived locally, and the archive rides the unified push out to Linear/Notion. **Caveat:** the dwell timer uses the plan's `updatedAt` as a proxy for time-in-column, so any edit or comment on the plan resets the clock — a frequently-touched plan may never trip the rule.

---

## 15. Status Bar Hub

A grouped actions dropdown in the VS Code status bar. When `compactMode` is enabled, all visible Switchboard status bar actions are grouped into a single hub dropdown. When disabled, individual buttons are shown.

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
| `switchboard.kanban.completedLimit` | integer | 100 | resource | Max cards in Completed column (1–500) |
| `switchboard.kanban.dbPath` | string | `""` | resource | Custom Kanban DB path |
| `switchboard.kanban.controlPlaneRoot` | string | `""` | resource | Explicit Control Plane folder override |
| `switchboard.workspaceDatabaseMappings` | object | — | window | *Deprecated*: mappings now stored in DB |
| `switchboard.workspace.ignoreStrategy` | string | `targetedGitignore` | resource | Git ignore strategy |
| `switchboard.workspace.ignoreRules` | array | `[]` | resource | Stored ignore rules |
| `switchboard.archive.dbPath` | string | `""` | resource | DuckDB archive database path |
| `switchboard.archive.autoArchiveCompleted` | boolean | true | resource | Auto-archive completed plans |
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
| `switchboard.memo.hotkey` | string | `cmd+shift+alt+m` | — | Hotkey to open the memo tab (requires window reload to take effect) |
| `switchboard.statusBar.showMemoButton` | boolean | false | window | Show a dedicated memo button in the status bar |

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
| `switchboard.refresh` | Refresh sidebar |
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
| `switchboard.openPlanningPanel` | Open Artifacts Panel |
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

Switchboard exposes **four front doors** in IDE chat agents (Windsurf, Cursor, Antigravity, Claude Code) — identical on every host:

- **`/switchboard`** — Local management console. Drive the board, plans, features, and dispatch when the VS Code extension is running. The primary front door. The console presents plan lists with numbered titles (no raw UUIDs or filenames), offers proactive follow-up suggestions after every list ("Dispatch any of these, or group some into a feature?"), delivers natural-language dispatch reports naming the receiving agent, and can self-service open agent terminals via the API instead of directing you to the IDE.
- **`/switchboard-cloud`** — Cloud-VM planning mode. Plan first, do not auto-code in a remote VM. Consultative planning persona.
- **`/switchboard-remote`** — Remote control. Drive plans via Linear or Notion MCP when the local machine / VS Code extension is off.
- **`/switchboard-memo`** — Enter memo capture mode. Appends each message verbatim to `.switchboard/memo.md` without analysis or action. Process entries via the Memo sub-tab in the sidebar, or send `process memo` to exit and create one plan per entry. Clear the conversation to leave without processing.

**Internal workflows** (extension-dispatched, not user commands — the planner, feature planner, accuracy add-on, and orchestrator are launched by the engine by path):

- **improve-plan** — Deep planning and adversarial review. Launched by the planner role.
- **improve-feature** — Reconcile & restructure a feature's subtasks. Launched by the feature planner.
- **accuracy** — High-accuracy mode with self-review. Coder prompt add-on.
- **switchboard-orchestrator** — Orchestration batch manager. System-launched by the AUTOMATION tab.

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

---

## 25. File Layout & Runtime State

### File Protocol
- `.switchboard/` — Core runtime data (state, sessions, plans, context maps, archives)
- `.agents/` — Workflow markdown contracts and persona files
- `state.json` — Lock-protected, atomically written shared state
- `sessions/*.json` — Run sheets tracking session ID, plan file, topic, workflow timeline
- `sessions/activity.jsonl` — Audit stream for workflow/dispatch events
- `plans/` — Locally created and mirrored plan files
- `context-maps/` — Analyst-generated context map artifacts

### Git Ignore Integration
- `switchboard.workspace.ignoreStrategy` controls how `.switchboard/` files are excluded from git
- `WorkspaceExcludeService` manages the ignore strategy

---

## 26. Kanban Database Schema

The board state is persisted in a local SQLite database at `.switchboard/kanban.db`, using `sql.js` (WASM SQLite compiled to JavaScript). When the DB file is unavailable, the board falls back to file-derived state from run-sheet events in `.switchboard/sessions/*.json`.

**Custom DB path:** `switchboard.kanban.dbPath` (resource-scoped, default `""` — uses `.switchboard/kanban.db` in the workspace root). Useful for cloud-synced multi-machine setups where the DB lives in a shared Dropbox/iCloud folder.

**Control Plane DB:** `switchboard.kanban.controlPlaneRoot` (resource-scoped, default `""`). When set, the DB is read from the Control Plane root instead of the workspace root. See [Multi-Repo Control Plane](#7-multi-repo-control-plane).

### Tables

#### `plans` (primary table)

Stores one row per plan/card on the Kanban board.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `plan_id` | TEXT | *(PK)* | Unique plan identifier (UUID or hash) |
| `session_id` | TEXT | *(NOT NULL)* | Session identifier for run-sheet tracking |
| `topic` | TEXT | *(NOT NULL)* | Plan title / display name |
| `plan_file` | TEXT | `NULL` | Relative path to the `.md` plan file (stored relative; expanded to absolute at read time) |
| `kanban_column` | TEXT | `'CREATED'` | Current column name (e.g. `CREATED`, `PLANNING`, `LEAD CODED`, `CODER CODED`, `CODE REVIEW`, `COMPLETED`) |
| `status` | TEXT | `'active'` | Lifecycle status: `active`, `completed`, `archived`, `deleted` |
| `complexity` | TEXT | `'Unknown'` | Complexity score as string integer `'1'`–`'10'`, or `'Unknown'` |
| `tags` | TEXT | `''` | Comma-separated tag list |
| `dependencies` | TEXT | `''` | Comma-separated plan IDs this plan depends on |
| `repo_scope` | TEXT | `''` | Repository scope filter for multi-repo setups |
| `project` | TEXT | `''` | Project name for project-level grouping |
| `workspace_id` | TEXT | *(NOT NULL)* | Workspace identifier (SHA-256 hash of workspace root, truncated to 16 chars) |
| `created_at` | TEXT | *(NOT NULL)* | ISO timestamp of plan creation |
| `updated_at` | TEXT | *(NOT NULL)* | ISO timestamp of last update |
| `last_action` | TEXT | `NULL` | Last workflow action (e.g. `planner`, `coder`, `handoff`, `jules`) |
| `source_type` | TEXT | `'local'` | Origin: `local`, `brain`, `clickup-automation`, `linear-automation` |
| `brain_source_path` | TEXT | `''` | Relative path to Antigravity brain source file |
| `mirror_path` | TEXT | `''` | Relative path to mirrored plan file |
| `routed_to` | TEXT | `''` | Agent role dispatched to: `lead`, `coder`, `intern`, or `''` |
| `dispatched_agent` | TEXT | `''` | Terminal/tool name (e.g. `claude cli`, `copilot cli`) |
| `dispatched_ide` | TEXT | `''` | IDE name (e.g. `Visual Studio Code`, `Cursor`, `Windsurf`) |
| `clickup_task_id` | TEXT | `''` | ClickUp task ID for PM sync |
| `linear_issue_id` | TEXT | `''` | Linear issue ID for PM sync |
| `worktree_id` | INTEGER | `NULL` | FK to `worktrees.id` for feature-based worktree dispatch |
| `worktree_status` | TEXT | `'none'` | Worktree state: `none`, `active`, `merged`, `deleted` |
| `is_feature` | INTEGER | `0` | `1` if this plan is a feature, `0` otherwise |
| `feature_id` | TEXT | `''` | `plan_id` of the parent feature (empty if standalone) |
| `workspace_name` | TEXT | `''` | Human-readable workspace name (backfilled from config) |
| `project_id` | INTEGER | `NULL` | FK to `projects.id` for project-level grouping |

**Upsert semantics:** `INSERT ... ON CONFLICT(plan_file, workspace_id) DO UPDATE`. The unique constraint is on `(plan_file, workspace_id)`, not on `session_id` (changed in V20 migration). On conflict, `status` is only revived from `deleted` → `active` when the incoming record has `status = 'active'`; all other status transitions require explicit `updateStatus()` calls.

#### `config`

Key-value store for workspace-level configuration.

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT (PK) | Configuration key (e.g. `workspace_id`, `workspace_mappings`, `stitch.manifest`) |
| `value` | TEXT | JSON or plain-text value |

#### `migration_meta`

Tracks which schema migrations have been applied.

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT (PK) | Always `kanban_db_migration_version` |
| `value` | TEXT | Numeric migration version (e.g. `35`) |

#### `projects`

Workspace-scoped project registry for grouping plans.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, AUTOINCREMENT) | Project ID |
| `name` | TEXT | Project name |
| `workspace_id` | TEXT | Workspace scope |
| `created_at` | TEXT | Creation timestamp |

**Unique constraint:** `(name, workspace_id)`

#### `worktrees`

Git worktree registry for feature-based dispatch routing.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, AUTOINCREMENT) | Worktree ID |
| `branch` | TEXT (UNIQUE) | Git branch name |
| `path` | TEXT | Filesystem path to worktree |
| `feature_id` | TEXT | `plan_id` of associated feature (nullable) |
| `created_at` | TEXT | Creation timestamp |
| `status` | TEXT | `active` or other lifecycle state |
| `project` | TEXT | Project name (added V34) |
| `agents_open_with_grid` | INTEGER | Whether agents auto-open with grid (added V34) |

#### `plan_events`

Event sourcing table for workflow/dispatch events.

| Column | Type | Description |
|--------|------|-------------|
| `event_id` | INTEGER (PK, AUTOINCREMENT) | Event ID |
| `plan_id` | TEXT | FK to `plans.plan_id` (nullable) |
| `event_type` | TEXT | Event type (e.g. `dispatch`, `column_change`, `status_change`) |
| `workflow` | TEXT | Workflow phase |
| `action` | TEXT | Specific action taken |
| `timestamp` | TEXT | ISO timestamp |
| `device_id` | TEXT | Device identifier for multi-device sync |
| `vector_clock` | TEXT | Vector clock for causal ordering |
| `payload` | TEXT | JSON event payload |

#### `activity_log`

Audit stream for workflow and dispatch events.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, AUTOINCREMENT) | Log entry ID |
| `timestamp` | TEXT | ISO timestamp |
| `event_type` | TEXT | Event type |
| `payload` | TEXT | JSON payload |
| `correlation_id` | TEXT | Correlation ID for tracing |
| `session_id` | TEXT | Session ID |

#### `kanban_meta`

Key-value store for Kanban-level metadata (parser versioning, backfill tracking).

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT (PK) | Metadata key |
| `value` | TEXT | Metadata value |

#### `imported_docs`

Centralized registry of imported documents from PM tools (ClickUp docs, Linear issues, Notion pages).

| Column | Type | Description |
|--------|------|-------------|
| `slug_prefix` | TEXT | URL-safe slug prefix |
| `source_id` | TEXT | Source system ID (e.g. ClickUp doc ID) |
| `remote_doc_id` | TEXT | Remote document ID |
| `doc_name` | TEXT | Document name |
| `parent_doc_name` | TEXT | Parent document name (for hierarchy) |
| `file_path` | TEXT | Local file path |
| `imported_at` | TEXT | Import timestamp |
| `last_synced_at` | TEXT | Last sync timestamp |
| `content_hash` | TEXT | Content hash for change detection |
| `workspace_id` | TEXT | Workspace scope |
| `display_order` | INTEGER | Sort order |
| `content_type` | TEXT | `doc` or `ticket` (added V33) |

**Primary key:** `(slug_prefix, workspace_id)`

#### `import_sync_meta`

Tracks sync health for imported documents.

| Column | Type | Description |
|--------|------|-------------|
| `workspace_id` | TEXT (PK) | Workspace ID |
| `last_heal_scan_at` | TEXT | Last heal scan timestamp |
| `orphaned_entries` | INTEGER | Count of orphaned DB entries |
| `orphaned_files` | INTEGER | Count of orphaned files on disk |

#### `linear_issue_links`

Maps Linear issues to local plan file paths.

| Column | Type | Description |
|--------|------|-------------|
| `issue_id` | TEXT (PK) | Linear issue ID |
| `plan_path` | TEXT | Local plan file path |
| `synced_at` | TEXT | Last sync timestamp |

#### `stitch_projects`

Stitch project cache (promoted from config blob in V32).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | Stitch project ID |
| `name` | TEXT | Project name |
| `update_time` | TEXT | Last update time from Stitch API |
| `updated_at` | TEXT | Local cache timestamp |

#### `stitch_screens`

Stitch screen cache (promoted from config blob in V32).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | Stitch screen ID |
| `project_id` | TEXT | FK to `stitch_projects.id` |
| `name` | TEXT | Screen name |
| `device_type` | TEXT | `AGNOSTIC`, `DESKTOP`, `MOBILE`, `TABLET` |
| `status` | TEXT | Generation status |
| `status_msg` | TEXT | Status message |
| `updated_at` | TEXT | Local cache timestamp |

### Indexes

| Index | Table | Columns | Type |
|-------|-------|---------|------|
| `idx_plans_column` | `plans` | `kanban_column` | Non-unique |
| `idx_plans_workspace` | `plans` | `workspace_id` | Non-unique |
| `idx_plans_status` | `plans` | `status` | Non-unique |
| `idx_plans_workspace_name` | `plans` | `workspace_name` | Non-unique |
| `idx_plans_project_id` | `plans` | `project_id` | Non-unique |
| `idx_plans_plan_file_workspace` | `plans` | `(plan_file, workspace_id)` | **UNIQUE** |
| `idx_plans_repo_scope` | `plans` | `(workspace_id, repo_scope)` | Non-unique |
| `idx_plans_clickup_task` | `plans` | `(workspace_id, clickup_task_id)` | Non-unique |
| `idx_plans_linear_issue` | `plans` | `(workspace_id, linear_issue_id)` | Non-unique |
| `idx_plans_project` | `plans` | `(workspace_id, project)` | Non-unique |
| `idx_plans_worktree` | `plans` | `worktree_id` | Non-unique |
| `idx_plans_feature_id` | `plans` | `feature_id` | Non-unique |
| `idx_plans_is_feature` | `plans` | `is_feature` | Non-unique |
| `idx_projects_workspace` | `projects` | `workspace_id` | Non-unique |
| `idx_worktrees_workspace` | `worktrees` | `workspace_id` | Non-unique |
| `idx_events_plan` | `plan_events` | `(plan_id, timestamp)` | Non-unique |
| `idx_events_time` | `plan_events` | `timestamp` | Non-unique |
| `idx_activity_time` | `activity_log` | `timestamp` | Non-unique |
| `idx_activity_session` | `activity_log` | `(session_id, timestamp)` | Non-unique |
| `idx_imported_docs_source` | `imported_docs` | `(source_id, workspace_id)` | Non-unique |
| `idx_imported_docs_parent` | `imported_docs` | `(parent_doc_name, workspace_id)` | Non-unique |
| `idx_imported_docs_workspace` | `imported_docs` | `workspace_id` | Non-unique |
| `idx_imported_docs_doc_name` | `imported_docs` | `(doc_name, workspace_id)` | Non-unique |
| `idx_imported_docs_type` | `imported_docs` | `(content_type, workspace_id)` | Non-unique |
| `idx_stitch_screens_project` | `stitch_screens` | `project_id` | Non-unique |

### Migration System

The database uses a versioned migration system tracked in `migration_meta`. The current schema version is **35**. Migrations run automatically on database initialization via `_runMigrations()`.

**Key migrations:**

| Version | Description |
|---------|-------------|
| V2 | Added `brain_source_path`, `mirror_path` columns; created `config` table |
| V3 | Fixed zombie plans (active status in COMPLETED column); consolidated `workspace_id` from config |
| V4 | Added `tags` column |
| V5 | Created `plan_events` and `activity_log` tables for event sourcing |
| V6 | Added `dependencies` column; consolidated `workspace_id` from config |
| V7 | Added `routed_to`, `dispatched_agent`, `dispatched_ide` for routing analytics |
| V8 | Migrated legacy complexity values (`Low` → `3`, `High` → `8`) |
| V9 | Added `clickup_task_id` column and lookup index |
| V10 | Repaired completed rows incorrectly rewritten to `archived` status |
| V12 | Added `linear_issue_id` column and lookup index |
| V13 | Added `repo_scope` column and filtered-query index |
| V14 | Created `kanban_meta` table |
| V15 | Created `imported_docs` and `import_sync_meta` tables |
| V16 | Cleared incorrect `repo_scope = 'switchboard'` values |
| V17 | Added `needs_path_fix` sentinel for relative→absolute path repair |
| V18 | Added `needs_relative_conversion` sentinel; established invariant: DB stores relative paths only |
| V19 | Deduplicated plans by `session_id`; enforced unique index |
| V20 | **Breaking:** Removed `UNIQUE` from `session_id`; added `UNIQUE(plan_file, workspace_id)`; recreated `plan_events` with FK to `plan_id` |
| V21 | Normalized absolute `plan_file` paths to relative |
| V22 | Repaired `workspace_id` fragmentation and corrupted `kanban_column` values |
| V23 | Created `projects` table; added `project` column to `plans` |
| V24–V25 | Recreated `worktrees` table without unused `path` column |
| V26 | Added `worktree_id` column to `plans` |
| V27 | Added `worktree_status` column to `plans` |
| V28 | Normalized `__unassigned__` sentinel values to empty string in `plans.project` |
| V29 | Added `is_feature` and `feature_id` columns for feature support |
| V30 | Recreated `worktrees` table with `feature_id` FK; migrated legacy meta keys |
| V31 | Fixed `worktrees.feature_id` type from INTEGER to TEXT |
| V32 | Promoted Stitch manifest blob to `stitch_projects` and `stitch_screens` tables |
| V33 | Added `content_type` column to `imported_docs` for unified ticket/doc registry |
| V34 | Added `project` and `agents_open_with_grid` columns to `worktrees` |
| V35 | Backfilled `workspace_name` and `project_id` in `plans` from config and `projects` table |

**Version-gated migrations** (V19+): Destructive migrations are wrapped in transactions and only execute if the current migration version is below the target. Failed migrations roll back and do not stamp the version, allowing retry on next initialization.

**Pre-migration backups:** Before running migrations, `_writePreMigrationBackup()` creates a backup copy of the DB file.

### Fallback Behavior

When the database file is unavailable (corrupted, permissions, missing `sql.js` WASM), the board falls back to file-derived state by scanning run-sheet events in `.switchboard/sessions/*.json`. This provides read-only access to plan metadata but cannot persist changes.

### Related Commands

- `switchboard.resetKanbanDb` — Deletes the local DB and rebuilds from plan files
- `switchboard.reconcileKanbanDbs` — Merges split databases (for Control Plane migration)
- `switchboard.fullSync` — Forces file→DB sync and refreshes the board

### Related Settings

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `switchboard.kanban.completedLimit` | integer | 100 | resource | Max cards in Completed column (1–500) |
| `switchboard.kanban.dbPath` | string | `""` | resource | Custom Kanban DB path |
| `switchboard.kanban.controlPlaneRoot` | string | `""` | resource | Explicit Control Plane folder override |

---

## 27. Webview Panels Reference

This section documents the UI controls and functionality of each Switchboard webview panel.

### Sidebar (`implementation.html`)

The primary Switchboard sidebar, hosted by `TaskViewerProvider`. Provides onboarding, quick-launch buttons, agent/terminal management, plan actions, and a live activity feed.

**Onboarding Wizard**
Shown on first launch (or when setup is incomplete):
- **Step 1: Initialize** — Seeds `.agents/` workflow files, personas, and `.switchboard/` directory.
- **Step 2a: Control Plane Question** — Choose between in-repo setup (writes `AGENTS.md`, `.agents/`, `.switchboard/` into the current repo) or external Control Plane setup (scaffolds into a parent folder with repo cloning via PAT).
- **Step 2: CLI Config** — Configure startup commands for each agent role (Planner, Lead Coder, Coder, Intern, Reviewer, Acceptance Tester, Analyst, Jules). Toggle agent visibility with checkboxes. Set Jules auto-sync preference.

**Quick-Launch Buttons**
Row of buttons at the top of the sidebar for rapid panel access:
- **KANBAN** — Opens the Kanban board
- **PLANNING** — Opens the Planning/Artifacts panel
- **SETUP** — Opens the Setup panel
- **DESIGN** — Opens the Design panel
- **PROJECT** — Opens the Project panel

**Agents & Terminals Tab**
Two sub-tabs:
- **Agents** — Lists all configured agents with dispatch buttons. Shows agent status (alive/dead), terminal PID, and role.
- **Terminals** — Terminal operations:
  - **OPEN AGENT TERMINALS** — Creates terminal grid for all visible agents. Toggles to **CLEAR TERMINALS** when terminals are active.
  - **RESET ALL AGENTS** — Deregisters all terminals (`switchboard.deregisterAllTerminals`).
  - **AGENT SETUP** — Opens Kanban board to the Agents tab.

**Plan Actions**
- **COMPLETE** — Mark the active plan as completed.
- **RECOVER** — Recover a completed plan (shown when a completed plan is selected).
- **COPY** — Copy the active plan's file path to clipboard.
- **CREATE** — Create a new draft plan (`switchboard.initiatePlan`).

**Live Activity Feed**
Collapsible accordion showing recent dispatch and autoban events. Each entry shows timestamp, agent role, plan title, and event type. **Load More** button fetches older events (50 at a time).

### Kanban Board (`kanban.html`)

The central orchestration panel, hosted by `KanbanProvider`. Eight tabs: KANBAN, AGENTS, PROMPTS, AUTOMATION, REMOTE, WORKTREES, UAT, SETUP. (The per-project PRD editor lives on the Project Panel's PROJECTS tab — see below.)

**KANBAN Tab**
The board itself with drag-and-drop columns. Controls strip:
- **Workspace/Project Selector** — Filter the board by workspace and project. **ASSIGN** button assigns the selected plan(s) to the chosen workspace/project.
- **PROMOTE TO FEATURE** — Convert selected plans to a feature or manage an existing feature.
- **+ (Add Project)** — Create a new project (prompts for a project name).
- **Delete Project** — Remove the selected project (icon button).
- **PROJECT CONTEXT** — Toggle (off by default). When on, the active project's PRD (authored on the Project Panel's PROJECTS tab) is injected into every dispatched prompt across all roles.
- **Scan Folders** — Force immediate plan scan (`switchboard.triggerPlanScan`).
- **AUTOBAN** — Start/stop the automation engine.
- **Remote Control** — Start/stop remote control (Linear / Notion / ClickUp; configured in the Project panel → REMOTE tab).
- **CLI Triggers** — Toggle between CLI terminal dispatch and clipboard prompt mode.
- **Collapse Coders** — Toggle collapsed view for coder columns.
- **Pair Programming Mode** dropdown — Select CLI Parallel / Hybrid / Full Clipboard.
- **CHAT PROMPT** — Copy chat prompt (multi-plan if plans selected, otherwise general consultation).
- Sub-bar: **Pause/Reset AUTOBAN timers**, status messages, worktree indicator.
- Column headers: **+ (Add Plan)**, **Import from Clipboard** (multi-plan supported with `### PLAN N START` markers), **Backlog/New toggle** (CREATED column only), card count.

**AGENTS Tab**
Configure agent visibility and CLI startup commands:
- **Visibility toggles** — Show/hide each built-in agent (Context Gatherer, Planner, Code Researcher, Splitter, Lead Coder, Coder, Intern, Reviewer, Acceptance Tester, Analyst, Ticket Updater, Researcher, Jules).
- **CLI command inputs** — Startup command for each agent.
- **Jules auto-sync** — Toggle auto git add/commit/push before Jules dispatch.
- **Custom Agents** — Add custom agents with name, startup command, and prompt add-ons (configured in the PROMPTS tab).

**PROMPTS Tab**
Per-role prompt customization:
- **Role Selector** — Dropdown to select agent role (includes custom agents, each with a short description).
- **Planner Config** (shown for Planner role):
  - **Workflow File** — Enable/disable, set workflow file path (e.g., `.agents/skills/improve-plan/SKILL.md`), validate path.
  - **Add-ons** — Switchboard Safeguards, Planning Feature Reference, Project Constitution Reference, Project PRD Reference, Aggressive Pair Programming, Git Prohibition, Clear Antigravity Context, Caveman Output, Skip Compilation, Skip Tests. Git strategy controls are grouped into labeled accordions with visible descriptions.
  - **Subagent Policy** — Not Specified / No Subagents / Use Subagents / Custom Subagent (with name input).
  - **Features subsection** — Per-role feature-scoped overrides that apply only when dispatching a feature (not a standalone plan): **Feature Workflow File** (override the general workflow), **Feature Subagent Policy** (independent of the general setting), and **Worktree Mode** (decouple the worktree decision from the subagent decision). A **Features accordion** groups feature-only add-ons separately from general add-ons.
- **Research Complexity** (shown for Researcher/Code Researcher): Quick / Standard / Deep / Academic. Save to Local Docs toggle.
- **Non-Planner Add-ons** — Role-specific add-ons (inline challenge, accurate coding, pair programming, etc.). Also includes a **Features accordion** for feature-only add-ons and a **Walkthrough Suppression** checkbox.
- **Edit Prompt Template** — Live preview of the composed prompt, editable before dispatch.

**AUTOMATION Tab**
Automation panel for configuring AUTOBAN rules and timing per column. Includes batch size, complexity filter, routing mode, max sends per terminal, global session cap, and terminal pool management. Also hosts the **MCP Monitor** controls (on/off, interval, watched sources, launch status — see §4).

**Orchestration mode** — Switch the automation mode to **Orchestration** and click **Start orchestrator** to launch an orchestrator agent that batch-manages the board unattended. On each interval tick it groups loose plans into features, fans work out across per-feature worktrees and terminals, verifies progress against git/board state, triages agent requests, and merges completed features back to main. This is the unattended equivalent of clicking **Orchestrate** on each feature manually. The orchestrator persona is system-launched (never invoked ad hoc); see `.agents/skills/switchboard-orchestrator/SKILL.md` for details.

**REMOTE Tab** (Project panel)
Configure Remote Control — provider (Linear / Notion / ClickUp), boards to sync, remote mode (Ingest / Full), comment-polling and push toggles, silent syncing, and ping frequency. Includes a Sync Health panel. See §30. (This config tab lives in the Project panel; the start/stop toggle is on the Kanban toolbar.)

**WORKTREES Tab**
Manage git worktrees for feature-based dispatch routing. Organized into **Epics**, **Projects**, and **Unbound** sections. Create, list, and delete worktrees associated with features. Includes a **Suppress main repo agent terminals** checkbox (with descriptive text explaining the routing order) so dispatched agents only run in their worktree terminals, not the main repo. Kanban plan cards display a **worktree icon** indicating active vs. merged/deleted worktree status.

**UAT Tab**
User Acceptance Testing checklist. **REFRESH** button reloads the UAT checklist from the database. Shows test items with pass/fail status tracking.

**SETUP Tab**
Board-level configuration:
- **Routing Configuration** — **OPEN ROUTING MAP** to configure complexity-based routing rules (drag complexity levels to agent tiers).
- **Batch Operations** — **Unknown → Auto** toggle: include plans with unknown complexity in batch moves.
- **Terminal Context** — **Clear before prompt** toggle with configurable delay (0–10000ms). Sends `/clear` to CLI agents before dispatching.
- **Kanban Structure** — **ADD COLUMN** / **RESTORE DEFAULTS**. Drag active middle columns to reorder. New and Completed stay fixed.

### Project Panel (`project.html`)

Hosted by `PlanningPanelProvider` (project mode). Tabs: KANBAN PLANS, PROJECTS, FEATURES, CONSTITUTION, SYSTEM, TUNING, **ARCHITECT**, and **REMOTE** (Remote Control config — see §30).

> Note: Project *creation*, plan-to-project *assignment*, and the **PROJECT CONTEXT** toggle live on the **Kanban panel** (`kanban.html`) board control strip — see its KANBAN tab above — because they act on the board. The per-project **PRD editor** lives on this Project Panel's PROJECTS tab.

**KANBAN PLANS Tab**
- **Workspace filter**, **Column filter** — Filter plans by workspace and Kanban column.
- **Import** — Scan configured AI IDE folders and pick unclaimed plans.
- **Create** — Create a new plan.
- **CHAT PROMPT** — Copy general chat planning prompt.
- **Search** — Filter plans by text.
- Plan list with selection and preview.

**PROJECTS Tab**
Authors the per-project **Product Requirements (PRD)** that the Kanban board's PROJECT CONTEXT toggle injects:
- **Project dropdown** — Pick a project to edit (or "No projects — add one on the Kanban board with +").
- **SAVE PRD** — Write the editor content to `.switchboard/projects/<project>/prd.md` (git-trackable). A path hint shows the exact file path.
- **Editor** — Markdown textarea for the project's product requirements. See §8 (Projects).

**FEATURES Tab**
- **Workspace filter**, **+ New Feature**, **?** (How to Run a Feature — 3 ways).
- Feature list pane (sidebar) with a preview/edit pane.
- Per-feature actions: **Orchestrate** (assemble + dispatch the feature orchestration prompt), **+ Subtask** (attach an existing plan), **Delete Feature** (detaches subtasks).
- **New Feature modal** — Name, description, *Add to Kanban board* checkbox.
- See §8 (Features) for the full workflow.

**CONSTITUTION Tab**
- **Constitution Reference** indicator with **Turn off** button.
- **Build via Planner** — Send constitution to Planner for plan generation.
- **Copy Build Prompt** — Copy the build prompt to clipboard.
- **Update via Planner** / **Copy Update Prompt** — Update an existing constitution via Planner.
- **Enable as Planning Reference** — Inject constitution into all planner prompts.
- **Edit** / **Save** / **Cancel** — Inline constitution editor.
- **Delete** — Remove constitution.
- **⚙ (Set Path)** — Change the constitution file path.
- Constitution list pane with file selection.

**SYSTEM Tab**
Authors a **System reference document** (architecture / system notes) the same way as the Constitution tab — **Build via Planner**, **Copy Build Prompt**, **Edit** / **Save** / **Cancel** / **Delete**, with a document list pane and inline editor.

**TUNING Tab**
Adversarial insight extraction and governance tuning:
- **Workspace filter** — Filter insights by workspace.
- **Extract Insights** — Scan reviewed plans and extract adversarial insights.
- **Propose Governance Updates** — Review all insights and propose governance file updates.
- **Refresh** — Reload insight list.
- **Insight filter** — Filter by status (All / Open / Resolved).
- Insight list with status management.

**ARCHITECT Tab**
A guided "Architect Mode" for setting up project **governance** — your PRD, Constitution, System files (`CLAUDE.md` / `AGENTS.md`), and tuning insights. It doesn't add an agent role; it launches a guided session through your existing Planner terminal.
- **Open Architect Terminal** — Dispatches the Switchboard Architect prompt to the Planner terminal (or spins up an ad-hoc "Switchboard Architect" terminal if no Planner terminal is registered).
- **Copy Architect Prompt** — Copies the same guided-governance prompt to the clipboard.
- **Governance-doc sidebar + preview** — Shows which of PRD / Constitution / `CLAUDE.md` / `AGENTS.md` / tuning insights exist, with a clickable preview pane.

**REMOTE Tab**
Remote Control configuration (provider, boards, mode, push/comment toggles, silent syncing, ping frequency, Sync Health). See §30.

### Design Panel (`design.html`)

Hosted by `DesignPanelProvider`. Six tabs:

**STITCH Tab**
Google Stitch integration for AI-powered UI generation:
- **Project Selector** — Choose Stitch project. **+ New Project** to create (opens an in-webview modal). **Refresh Projects** to re-fetch. **Rebuild Cache** to re-download preview images. **Force Reload Screens** to re-fetch screen list. **Download Design Tokens** for color palette. **Open DESIGN.md** for handoff file. **⚙️ Auth** to configure authentication.
- **Sync Destination** — Select workspace for downloaded assets.
- **Generation Strip** — Prompt input, device type (Agnostic/Desktop/Mobile/Tablet), model (Flash/Pro), **+ Attach** reference files, **Generate Screen**.
- **Preview Pane** — Screen preview with **DL HTML** / **DL PNG** download buttons, destination folder selector, **Close**.
- **Refine Row** — Refine prompt input, creative range (Explore/Refine/Reimagine), **Apply Edit**, **+3 Variants** with aspect selection (Layout, Color, Images, Font, Text).
- **Thumbnail Strip** — Scrollable screen thumbnails with collapse toggle.

**STITCH HTML Tab**
Browse cached Stitch HTML screens organized per project:
- **Project dropdown** — Select which Stitch project's cached HTML to browse.
- **Controls strip** — Workspace filter, file search, **Inspect Mode** button (toggle hover-to-select element mode for in-place tweaks — see §9).
- **Preview pane** — Renders the selected HTML file (sandboxed iframe) with a zoom toolbar (zoom in/out, reset, fit; hold **Space** + scroll/drag to pan & zoom). Tweak popup docked top-right when Inspect Mode is active.

**BRIEFS Tab**
Design brief management:
- **Workspace filter**, **Manage Folders**, **New Brief**, **Delete**, **Edit**, **Send to Stitch** (auto-names the project from the brief title and immediately generates), **Link** (per-brief — copies the brief's file path to clipboard), **Save** / **Cancel** (edit mode).
- **Search** — Filter briefs by text.

**HTML PREVIEWS Tab**
Browse HTML prototype files:
- **Workspace filter**, **Manage Folders**, **Open in Browser**, **Copy Link**.
- **Controls strip** — **Inspect Mode** button (toggle hover-to-select element mode — see §9), **Copy upload prompt** / **Upload to Claude Artifacts** (push the selected HTML file to claude.ai as an Artifact — see §9).
- **Search** — Filter previews by text.

**IMAGES Tab**
Browse image assets:
- **Workspace filter**, **Manage Folders**, **Copy Link**.
- **Search** — Filter images by text.

**DESIGN SYSTEM Tab**
Design system documentation, Stitch design systems, and Claude design systems:
- **Local Docs sub-tab** — **Workspace filter**, **Manage Folders**, **Set as Active Design Doc**, **Link**, **Edit**, **Save** / **Cancel**. Search filter.
- **Stitch Design Systems sub-tab** — View Stitch project design systems, **Create Design System**, **Refresh List**. Requires a Stitch project to be selected.
- **Claude Design Systems sub-tab** — Import designs from claude.ai/design. **claude.ai/design URL or ID (optional)** input, **Copy import prompt**, **Import from Claude Design** (sends the import prompt to a Claude agent). No API key stored — see §9.

### Planning / Artifacts Panel (`planning.html`)

Hosted by `PlanningPanelProvider`. Five tabs:

**DOCS Tab**
Unified document browser for local plans and docs (merges the former Local Docs and Online Docs tabs into one):
- **Workspace filter**, **Sync Mode** dropdown (Auto Sync All / Sync Selected Containers).
- **Source filter chips** (Local · ClickUp · Linear · Notion) to narrow the tree by source.
- **Import**, **Edit**, **Save**, **Cancel**, **Sync to Online** — Document management actions.
- **Search** — Filter docs by text.
- Sidebar with document tree (collapsible source sections with doc counts, sync indicators per doc), preview pane with markdown rendering.
- Breadcrumb navigation for nested documents.

**TICKETS Tab**
PM tool ticket management (ClickUp/Linear):
- **Workspace picker**, **Provider selector** (ClickUp/Linear), **Project picker**, **State filter**, **Status filter**.
- **+ New Ticket**, **Refetch** (re-fetch from source), **Sync changes** (push local edits back).
- **Hierarchy navigation** — Breadcrumb for parent/child ticket navigation.
- **Search** — Filter tickets by text.
- Sidebar: **Link all** (copy all ticket paths), **Import all to kanban**, ticket tree with **Load More** pagination.
- Ticket preview meta bar: **Edit**, **Save**, **Cancel**, **Push** (push to PM tool), **Delete**, **Status** dropdown, **Tags**, **Comment**, **Attachments**, **Open** (open in browser), **Diagram Prompt**, **+ Subtask**, **Convert to Subtask**.
- Comment input area with **Post Comment** / **Cancel**.
- Subtasks navigation injected at top of preview.
- Tags display with chip UI.

**RESEARCH Tab**
AI-assisted research workflow:
- **Step 1: Draft Prompt** — Research topic input, **Copy Prompt Template**, **Draft with Analyst Agent**.
- **Step 2: Run in Google AI Studio** — Link to aistudio.google.com, instructions for Search Grounding.
- **Step 3: Save Results** — **Destination folder** selector, **Manage Folders**, **Import from Clipboard**.

**HTML Tab**
Browse and preview HTML files from configured folders, with Inspect Mode and Claude Artifacts round-trip:
- **Workspace filter**, **Manage Folders**, file search.
- **Controls strip** — **Inspect Mode** button (toggle hover-to-select element mode for in-place tweaks — see §9), **Copy upload prompt** / **Upload to Claude Artifacts** (push the selected HTML file to claude.ai as an Artifact — see §9).
- **Preview pane** — Renders the selected HTML file (sandboxed iframe) with a zoom toolbar. Tweak popup docked top-right when Inspect Mode is active.

**NotebookLM Tab**
Zero-cost planning via Google NotebookLM:
- **Step 1: Bundle Code** — Package code into docx files for NotebookLM.
- **Step 2: Upload to NotebookLM** — **Open NotebookLM** link, **Open Folder** (airlock folder).
- **Step 3: Copy Sprint Planning Prompt** — Generate prompt for NotebookLM to write expanded plans.
- **Step 4: Import Plans** — Paste expanded plans from NotebookLM. Matching titles overwrite; others create new plans.

### Setup Panel (`setup.html`)

Hosted by `SetupPanelProvider`. Ten tabs:

**Setup Tab**
- **Switchboard Guide** — **Copy Tutorial Prompt** (copies prompt referencing the user manual) and **Open Docs** (opens manual in markdown preview).
- **Git Ignore Strategy** — Dropdown (targetedGitignore / localExclude / custom / none) with read-only rules preview.
- **Workflow Settings**:
  - **Auto-commit When Moving to Code Review** — Commit uncommitted changes before a plan enters Code Review.
  - **Exclude Reviewed & Backlog from Sidebar** — Hide reviewed/backlog plans from sidebar dropdown.
  - **Persist Switchboard Panels Across IDE Restarts** — Reopen Kanban, Project, Planning, and Design panels on restart.
- **Prompt Settings Export / Import** — Export prompt configurations to `.switchboard/settings.json`, import from file.
- **Reinitialise Plugin** — Restore `.switchboard/`, `AGENTS.md`, `.agents/` if deleted.

**Database Tab**
- **Additional plan folder** — Ingest `.md` files from an external folder.
- **Databases list** — View and manage Kanban databases for open workspaces.

**Control Plane Tab**
- **External Switchboard Configuration** — Explanation of Control Plane concept.
- **Open Control Plane Setup** — Opens modal with:
  - **Migrate Existing** / **Fresh Setup** mode toggle.
  - **Detection & Status** — Effective root, source, selected workspace, repo filter. Explicit root override input with save/reset. Clear cache button. Detect control plane button.
  - **Migrate Existing pane** — Preview migration, execute migration (merge databases, copy plan files, promote shared config).
  - **Fresh Setup pane** — Set up fresh control plane, scaffold & clone repositories (parent dir, workspace name, repo URLs, PAT).

**Multi-Repo Tab**
- **Workspace-to-Database Routing** — Enable mapping, add databases, save mappings.
- **Migrate Settings** — Copy DB settings to global.

**ClickUp Tab**
- **Artifacts Panel Visibility** — Show ClickUp docs in Artifacts panel.
- **API Token** — Enter and apply ClickUp token (stored in SecretStorage).
- **Ticket Import** — Import location folder, auto-sync toggle.
- **Kanban Board Mapping** — Enable Kanban sync, create AI Agents folder, create mapped lists, create custom fields, exclude backlog. Column mappings with create unmapped/save.
- **Kanban Automation** — Enable realtime push sync, delete sync, complete sync, auto-pull. Automation rules (add rule, save automation).

**Linear Tab**
- **Artifacts Panel Visibility** — Show Linear docs in Artifacts panel.
- **API Token** — Enter and apply Linear token (stored in SecretStorage).
- **Ticket Import** — Import location folder, auto-sync toggle.
- **Kanban Board Mapping** — Enable Kanban sync, map columns to Linear workflow states, create Switchboard label, exclude backlog, include/exclude projects.
- **Kanban Automation** — Enable realtime push sync, complete sync, delete (archive) sync, auto-pull. Automation rules (add rule, save automation).

**Notion Tab**
- **Artifacts Panel Visibility** — Show Notion docs in Artifacts panel.
- **Integration Token** — Enter and apply Notion token (stored in SecretStorage).

**Plan Scanner Tab**
- **Enable periodic scan** — Master toggle.
- **Scan Speed** — Very Fast (3s) / Fast (5s) / Normal (10s) / Relaxed (30s) / Slow (60s) / Off.
- **IDE Presets** — Toggle scanning for Antigravity, Windsurf/Devin, Cursor, Claude Code.
- **Chat Plan Destinations** — Folders where chat agents write plans. Add multiple destinations.
- **Custom Sources** — Add custom plan-file source paths for other tools.

**Theme Tab**
- **Theme Selection** — Afterburner (cyberpunk) / Claudify (Claude terracotta accent).
- **Animation** — Enable/disable animated CRT sweep beam in planning panel preview.

**Status Bar Tab**
- **Show Terminal Controls** — Agents/Clear/Reset terminal buttons.
- **Show Kanban Open Button** — Open Kanban from status bar.
- **Show Artifacts Panel Open Button** — Open Artifacts panel from status bar.
- **Show Design Panel Open Button** — Open Design panel from status bar.
- **Show Project Panel Open Button** — Open Project panel from status bar.

**Custom Prompts Modal** (accessible from Setup tab)
- **Role tabs** — Select agent role to customize.
- **Default Prompt Preview** — Read-only base prompt structure.
- **Mode** — Append / Prepend / Replace (plan list always appended).
- **Custom instructions** — Textarea for role-specific prompt override.
- **Clear Override** / **Save All Overrides**.

---

## 28. Memo Capture Mode

An append-only capture mode for progressively logging issues, bugs, and ideas during testing or exploration — without breaking your flow with analysis or code changes.

### How to Enter
- Type `/switchboard-memo` in your IDE chat, or
- Open the Memo sub-tab directly via the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`).

### Behavior
- Every message you send is appended verbatim to `.switchboard/memo.md`. No analysis, no action.
- Every capture-mode reply begins with the marker `[MEMO CAPTURE ACTIVE]`.

### How to Process
Open the Memo sub-tab in the sidebar (**Agents & Terminals** tab → **Memo** sub-tab). Three buttons:
- **Send to Planner** — dispatch entries to the planner and clear the memo.
- **Copy Prompt** — copy the planner prompt to clipboard and clear the memo.
- **Clear** — clear the memo without processing.

### How to Exit
Send exactly `process memo` (case-insensitive, as the entire message) to exit capture mode and create one plan file per entry in `.switchboard/plans/`. The memo file is cleared after all plan files are created successfully, so re-running produces no duplicates. If any plan file write fails, the memo is NOT cleared — report the failure and retry. To leave without processing, clear the conversation.

### Guaranteed Capture
The Memo sub-tab also supports direct capture without agent involvement — type into the textarea and it saves automatically to `.switchboard/memo.md` via the extension backend (guaranteed capture, immune to host system prompt overrides).

### Settings
- `switchboard.memo.hotkey` (default `cmd+shift+alt+m`)
- `switchboard.statusBar.showMemoButton` (default `false`)

---

## 29. Automated Triage Pipeline

> **Not currently exposed (pre-release).** The one-click triage setup — along with the ClickUp/Linear **Kanban Board Mapping** and **Kanban Automation** setup sections — is hidden in the current build while it's being hardened. The underlying functionality (the Ticket Updater agent and triage board) still exists in code, but there is no UI to enable it. The description below documents the intended behavior for when it returns.

One-click setup for auto-pulling bugs from ClickUp or Linear and routing them to the triage agent.

### Setup
Setup panel → ClickUp or Linear tab → **"⚡ ENABLE TRIAGE PIPELINE (ONE-CLICK)"**. This creates a "Bug Triage" board with sensible defaults (all editable afterward). *(This control is currently hidden — see the note above.)*

### Triage Verdict
The Ticket Updater agent posts a structured verdict as a comment:
- **Severity** — blocker / high / normal / low
- **Area** — one or two tags
- **Assessment** — 1–2 sentence root-cause hypothesis
- **Recommended action** — the concrete next step
- **Routing** — auto / needs-human

The verdict is posted via the `clickup_api` or `linear_api` skill — it **never overwrites the ticket description**, comment only. Target ≤120 words per verdict. The agent resolves the provider ticket ID from the plan metadata (the `**ClickUp Task ID:**` or `**Linear Issue ID:**` line).

---

## 30. Remote Control (provider-agnostic)

Drive your Kanban board from a remote surface — the **Linear** or **Notion** mobile/web app, or a push-only **ClickUp** mirror.

### How It Works
Remote Control polls the active provider on a timer (no webhooks). In **Full** mode it mirrors remote state changes onto Kanban columns and dispatches the target column's agent; in either mode it ingests comments and routes each to the current column's agent. Delta polling asks the provider "what changed since my cursor?" — state and comments are two separate streams with two cursors.

### Providers & capabilities
Providers implement a common seam and declare capabilities (`pull`, `push`, `projectContextPush`, `archive`); the UI gates controls on capability, not on provider name.

| Provider | Pull | Push | Notes |
| :--- | :--- | :--- | :--- |
| **Linear** | ✓ | ✓ | Full remote-control surface. |
| **Notion** | ✓ | ✓ | Full; drive via the Notion app / MCP. |
| **ClickUp** | — | ✓ | Push-only stakeholder-visibility mirror (no inbound dispatch). |

(A separate **git-native** channel — control-plane / wiki — mirrors whole-board state via git; see *Board State Export* below and §on the Control Plane. It is configured by `switchboard.boardStateExport`, not by this tab.)

### Configuration
Configure in the **Project panel → REMOTE** tab (the config tab moved here from the Kanban panel; only the start/stop toggle remains on the Kanban toolbar):
- **Provider** — Linear / Notion / ClickUp (push-only)
- **Workspace** and **Boards to sync** (multi-select)
- **Silent syncing** — keep selected boards mirrored even while pinging is off
- **Remote mode** — *Ingest (pull only)* or *Full (pull + mirror + dispatch)*. Full is disabled for providers without `pull`.
- **Poll comments from remote** — comment-polling toggle
- **Push status & content to remote** — push toggle; disabled for providers without `push`
- **Ping frequency** — 30–120s (default 60)
- **Start / Stop Remote Control** button (active state shows "Pinging…")

Toggle remote control on/off from the Kanban toolbar remote-control button as well.

### Sync Health
While remote control is active, a **Sync Health** panel (auto-refreshed ~every 15s) surfaces:
- **Last poll** — ✓/✗ with timestamp and truncated error (red on failure)
- **Last push** — ✓/✗ with timestamp and error
- **Rate-limit backoff** — "⏳ Rate-limited — backing off…" when the provider returns 429/529 (60s window)
- **Persistent failure** — "⚠ N consecutive failures — check token/connection" once failures reach 3

### Guards
- **Self-comment marker** — skips its own outbound comments on ingest.
- **State echo guard** (5-minute TTL) — prevents re-applying a state that matches the current column.
- **Per-card sequential queue** — no two agents run for one card simultaneously.
- **Comment cursor** — advanced only AFTER dispatch completes (reload-safe); first-encounter cursor seeding prevents replaying the entire comment history on first start.
- **Per-poll card cap** — 100 cards (most-recently-updated first; remainder deferred to the next cycle).

### Config Storage
Stored in the Kanban DB `config` table (key `remote.config`), **not** in `settings.json`. The `RemoteConfig` fields: `provider` (`linear`|`notion`|`clickup`), `boards` (string[]), `silentSync` (boolean), `pingFrequencySeconds` (30–120, default 60), `mode` (`ingest`|`full`), `push` (boolean), `comments` (boolean). The poll loop runs when the toolbar toggle is on and stops when it's off.

### Board State Export (git-native mirror)
Independently of the provider channel above, board state can be mirrored to git so it travels with the repo. Set the destination in the **Setup** panel → *Board State Export*:
- `none` — no git footprint (default)
- `control-plane` — push to the control-plane repo
- `wiki` — push to `<remote>.wiki.git`

Outbound pushes commit `.switchboard/kanban-board.md` and `.switchboard/kanban-state-*.md` ("switchboard: update board state mirror"); inbound state/comment deltas are read back from git with a commit-SHA cursor and an author trust gate (`switchboard.planAutoFetch.trustedAuthors`). Settings: `switchboard.boardStateExport`, `switchboard.boardStateExport.remoteUrl`.

---

## 31. Troubleshooting / FAQ

### Setup Issues
**Q: The sidebar shows "Setup Required" — what do I do?**
A: Click the status bar item or run `Switchboard: Setup AI Protocol Files` (`switchboard.setup`). This seeds `.agents/` workflow files and personas.

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


## 32. Using Switchboard with claude.ai

Switchboard's planning workflows are not limited to VS Code. You can drive the planning phase — kanban triage, plan authoring, improvement runs — entirely from [claude.ai](https://claude.ai), with the extension running locally to execute the resulting plans.

### Prerequisites

- The Switchboard extension must be open in VS Code so that `kanban-board.md` stays up to date (it is written on every board change).
- `kanban-board.md` must not be gitignored (Switchboard manages this automatically from Setup → Git Ignore Strategy → `targetedGitignore`).

### Entering planning mode: `/switchboard`

Type `/switchboard` in any claude.ai chat. In a cloud/remote session (no reachable local API), this loads the plan-mode brake persona: a consultative planner that gathers requirements, challenges assumptions, and produces implementation plans — but does not write code until you approve a plan.

Once active, the skill reads `.switchboard/kanban-board.md` so you can address your board by column:

> "What's in the Created column?"
> "Which plans in Backlog have no complexity score?"
> "Summarise everything currently in Code Reviewed."

### Available workflows on claude.ai

The four front doors work on claude.ai:

| Command | What it does |
|---------|--------------|
| `/switchboard` | Local management console — drive the board, plans, dispatch |
| `/switchboard-cloud` | Cloud-VM planning mode — plan first, no auto-code |
| `/switchboard-remote` | Remote control via Linear/Notion MCP |
| `/switchboard-memo` | Capture a burst of ideas as plan stubs — exits with `process memo` |

> **Note:** `/memo`, `/improve-plan`, `/improve-feature`, `/switchboard-split`, `/sw`, and `/sw-remote` were retired and folded into the four `switchboard-` front doors. Internal workflows (improve-plan, improve-feature, accuracy, orchestrator) are now extension-dispatched skills, not user commands.

### Chaining: triage then bulk-improve

The most powerful pattern is to chain `/switchboard` with the planner across a whole column:

1. Type `/switchboard` and ask Claude to list everything in a column (e.g. "show me all Created plans").
2. Claude reads `kanban-board.md` and lists the plans with titles and file paths.
3. Say "improve each of those" — Claude works through all of them in the same session, one after another, producing improved plan files it commits back to `.switchboard/plans/`.

This lets you queue up a full planning sprint from your phone or a browser tab while the local extension handles execution.

