# Switchboard

**Full-lifecycle AI agent platform for VS Code — manage your entire delivery pipeline from spec to ship via drag-and-drop**

Switchboard orchestrates your AI agent team across the full delivery lifecycle: from spec/governance, planning, and design, through multi-repo execution, review, PM-tool sync, and archiving.

Manage the whole project by moving cards instead of typing into chat. This makes it practical to multitask across several agents at once while drinking a beer — you only need one hand to route code with Switchboard.

There is nothing to install beyond the extension itself. If you already have your agents open, you are ready. No gateway, no runtime, no external servers.

---

## Install

Download the latest packaged extension from the **[Releases page](https://github.com/TentacleOpera/switchboard/releases/latest)**, then install it:

- **VS Code UI:** Extensions panel → `…` menu → **Install from VSIX…** → pick the downloaded `.vsix`.
- **CLI:** `code --install-extension switchboard-<version>.vsix`

Direct link for the current build:
`https://github.com/TentacleOpera/switchboard/releases/download/v1.7.6/switchboard-1.7.6.vsix`

---

## How it works

- **Drag-and-drop orchestration** — Manage the whole project by moving cards to dispatch real work.
- **Zero-overhead coordination** — No orchestration agent, no gateway, and no API keys required for local execution. Direct VS Code API control.
- **CLI & IDE agent pipeline** — Combine the strengths of chat-based agents (Windsurf, Cursor, Antigravity) and CLI-based tools (Claude Code, Gemini CLI, Copilot CLI).
- **Spec-driven governance** — Inject project-wide rules (Constitution) automatically into every agent step.
- **Multi-repo Control Plane** — Run a single board that orchestrates agents across multiple repositories with a shared local database.
- **Design-in-the-loop** — Generate UIs with Google Stitch *or* import designs from Claude (claude.ai/design) directly inside the IDE to feed requirements straight into plans and code.
- **Features & worktrees** — Group related plans into Features and run them three ways (step the board, hand to a single Orchestrator agent, or split planning from implementation), with optional git-worktree isolation per feature.
- **PM tool sync** — Map plan states to ClickUp, Linear, and Notion in real time or on completion.

---

## The Full Lifecycle (Differentiators)

### 1. Constitution (Spec-Driven Governance)
Set inviolate rules and invariants in the Project panel. Switchboard automatically injects them into the Planner and Coder prompts using the verbatim header:
```
PROJECT CONSTITUTION:
The following are inviolate rules and invariants for this project:
```
This ensures every agent-generated plan and code change respects your architectural guidelines, security policies, or style guides. Managed in the Project panel, not as a `settings.json` key.

### 2. Multi-Repo Control Plane
Ditch per-repo files. Set up a shared Control Plane to orchestrate work across multiple repositories from a single board.
Commands:
- `Multi-Repo: Scaffold Control Plane` (`switchboard.scaffoldMultiRepo`)
- `Set Up Control Plane` (`switchboard.setupControlPlane`)
- `Clear Control Plane Cache` (`switchboard.clearControlPlaneCache`)
- `Reconcile Kanban Databases` (`switchboard.reconcileKanbanDbs`)
- `Reset Kanban Database` (`switchboard.resetKanbanDb`)
Setting: `switchboard.kanban.controlPlaneRoot`

### 3. Design in the Loop (Google Stitch + Claude)
The Design panel keeps UI generation inside the IDE so design output flows straight into your plans and code. It has six tabs: **STITCH**, **STITCH HTML**, **BRIEFS**, **HTML PREVIEWS**, **IMAGES**, and **DESIGN SYSTEM**.

**Google Stitch** — Generate and refine UI screens with Stitch. Authenticate by entering your Stitch API key or OAuth access token directly in the Design panel — those credentials are held in VS Code's `SecretStorage`, never in `settings.json`. The **STITCH HTML** tab browses cached Stitch HTML output organized per project, so you can preview, inspect, and tweak generated screens without leaving the IDE.
Settings (`settings.json`):
- `switchboard.stitch.authMode` (`apiKey` | `oauth`)
- `switchboard.stitch.defaultProjectId`
- `switchboard.stitch.defaultOutputFolder`
- `switchboard.stitch.defaultModelId` (`GEMINI_3_FLASH` | `GEMINI_3_1_PRO`)
- `switchboard.stitch.defaultCreativeRange` (`EXPLORE` | `REFINE` | `REIMAGINE`)

**Claude (claude.ai/design)** — Import designs from Claude's design tool via the **DESIGN SYSTEM** tab's "Claude Design Systems" source. Enter a `claude.ai/design` URL or project ID (or leave blank to list your projects), then click **Copy import prompt** or **Import from Claude Design** to send a ready-to-paste prompt that tells a Claude agent to import the design into your repo *using the repo's existing components and styles* (it runs `/design-login` first if needed). No Anthropic API key is stored in Switchboard — the import is run by your Claude agent. The optional **Claude Designer** agent role automates this from the board.

**Claude Artifacts round-trip** — The **HTML PREVIEWS** tab and the Planning panel's HTML tab include **Copy upload prompt** / **Upload to Claude Artifacts** buttons that push a local HTML file to claude.ai as an Artifact, and a corresponding download prompt to pull an Artifact back into your repo. This gives you a repeatable loop: pull an artifact down, edit it with any agent, push it back.

All tabs share the Design panel's folder browsing, **Link to Folder** buttons (copy a configured folder's path to the clipboard), and **BRIEFS** / **DESIGN SYSTEM** infrastructure.

### Inspect Mode — tweak any HTML preview element and hand it to an agent
Every sandboxed HTML preview in Switchboard has an **Inspect Mode** button in its controls strip — the **STITCH** HTML tab, the Design panel's **HTML PREVIEWS** tab, and the Planning panel's HTML tab. It is the handoff point from a generated or prototyped screen to surgical, in-file tweaks: no need to leave the preview, hunt through large anonymous markup, or hand-write element descriptions.

1. Click **Inspect Mode** to toggle hover-to-select on.
2. Hover the rendered page — elements highlight as you move the cursor.
3. Click the element you want to change. A tweak popup (docked top-right of the preview) opens, showing the element's **CSS selector** and a truncated **HTML snippet**.
4. Type your change in the popup (e.g. "make this button dark blue", "tighten this card's padding").
5. **Send to Agent** delivers a composed prompt — the file path, the selector, the snippet, and your instruction — to the **coder** agent terminal (falls back to clipboard if no terminal is registered). **Copy Prompt** puts the same prompt on the clipboard.
6. The agent edits the file in place; the preview **auto-refreshes** to show the result. Switchboard never regenerates the file, so your tweaks are never clobbered.

While inspect is on, links and buttons inside the preview are inert so you can select without navigating away. Press **Escape** (with focus in the preview) or click **Inspect Mode** again to exit. If the file is saved or auto-refreshed mid-composition, the popup closes and the selection resets but your typed instruction is preserved.

---

## Getting Started

### 1. Install
Install **Switchboard** from the VS Code Marketplace, or sideload the latest `.vsix` from the [Releases page](https://github.com/TentacleOpera/switchboard/releases/latest).

### 2. Set Up Your Agent Team
Open the Switchboard sidebar, go to **Setup**, and enter your CLI agent startup commands (e.g., `gemini --approval-mode yolo`). Or connect your chat-based IDE agents.
Configure roles:
- **Planner** — Premium model (Opus, Sonnet, Gemini Pro). Writes plans and assigns complexity.
- **Team Lead** — Optional orchestration coordinator.
- **Lead Coder** — High-complexity tasks.
- **Coder** — Low-complexity/boilerplate (e.g., Gemini Flash).
- **Intern** — Simple, guided tasks.
- **Reviewer** — Compares implementation to plans (Grumpy Principal Engineer).
- **Acceptance Tester** — Validates finished work.
- **Analyst** — General research.
- **Ticket Updater** — Reads imported tickets and posts short triage verdicts (severity, area, recommended action) back to ClickUp/Linear as comments.
- **Orchestrator** — Runs an entire Feature end-to-end with native subagents (off by default; enable in the Kanban Agents tab).
- **Project Manager** — Host-agnostic management console; drive the board over the LocalApiServer HTTP API from any chat host. Core role, on by default; activated via the **Manage** button in the Implementation panel (or the board's **Run Selected Plans** targeted-pass button).
- **Claude Designer** — Imports a design from claude.ai/design into the target folder using the repo's existing components and styles (off by default).
- **MCP Monitor** — Read-only monitor role; on an interval it pings a dedicated Claude terminal to check connected MCP sources (Slack, Gmail, Google Calendar, custom) and report what needs attention (off by default).

You can add custom roles in the Setup panel.

### 3. Create Plans
Click **Create Plan** in the AUTOBAN. You can also:
- Run the **Plan Scanner** to auto-detect and import plan files from Antigravity, Windsurf-Devin, Cursor, Claude Code, or custom paths.
- Generate plans at zero cost via **NotebookLM Airlock**.
- Run IDE chat commands like `/improve-plan` to write plans directly.

### 4. Run the Pipeline
Copy the Planning prompt, enrich the plans, and drag cards to trigger agents.

---

## Using Switchboard with claude.ai

All Switchboard planning workflows are available directly in [claude.ai](https://claude.ai) — no VS Code required for the planning phase.

### Quick start

Type `/switchboard` in any claude.ai chat to enter Switchboard's management console. The skill reads your committed `kanban-board.md` snapshot so you can reference your board by column name:

> "What's in the Created column?"
> "Review all plans in Backlog and tell me which ones have missing dependencies."

### Four front-door commands

- **`/switchboard`** — The local management console: drive the board, plans, features, dispatch, and automation while the VS Code extension is running.
- **`/switchboard-cloud`** — Cloud-VM planning brake: plan first, do not auto-code in a remote VM.
- **`/switchboard-remote`** — Remote Switchboard control: drive plans via Linear or Notion when the local machine is off.
- **`/switchboard-memo`** — Memo capture mode: append-only, no analysis. Exit with `process memo`.

### Chaining workflows

Once you've identified plans with `/switchboard`, you can run other Switchboard workflows across them in the same session:

- **`/improve-plan`** — deep-plan with adversarial review. Ask Claude to run it on every plan in a given column at once, rather than one at a time.
- **`/switchboard-memo`** — capture a burst of new ideas as plan stubs without interrupting your flow.

**Example:** Open claude.ai, type `/switchboard`, ask "show me everything in Created", then say "run `/improve-plan` on each of those" — Claude will work through all of them in one session.

---

## The AUTOBAN

The AUTOBAN is the central control surface. Dragging a card triggers terminal execution or copies the prompt.

### Column Controls
- **Drag-and-drop** to route cards.
- **Move Selected** / **Move All** — Advance cards.
- **Copy Prompt Selected** / **Copy Prompt All** — Generate prompt text.

### Routing Modes
- **CLI Triggers** — Dispatched to terminals.
- **Prompt mode** — Copied to clipboard.

### Complexity Routing
Planner assigns complexity (1-10) to route plans:
- High complexity → Lead Coder
- Low complexity → Coder
Configure the cutoff in Setup.

### AUTOBAN Automation
Click **START AUTOBAN** to automate the queue on a timer.
Configure per column:
- Agent count (number of terminals)
- Timing interval
- Batch size

### MCP Monitor
Also in the Automation panel: turn on the **MCP Monitor** to have Switchboard periodically ping a dedicated Claude terminal that checks your connected MCP sources (Slack, Gmail, Google Calendar, or a custom instruction) and reports anything needing attention. Pick a single global interval (1–30 min) and the sources to watch; a status line shows whether the monitor terminal is running. Off by default.

### Orchestration Automation Mode
Also in the Automation panel: switch the automation mode to **Orchestration** and click **Start orchestrator** to launch an orchestrator agent that batch-manages the board unattended. On each interval tick it groups loose plans into features, fans work out across per-feature worktrees and terminals, verifies progress against git/board state, triages agent requests, and merges completed features back to main. This is the unattended equivalent of clicking **Orchestrate** on each feature manually.

---

## Project Management & Sync

Organize plans into **Projects** (areas within a repo that also carry shared requirements) and **Features** (groups of related plans with coordinated execution).

### Projects
A **Project** slices a repo's board into areas (e.g. `frontend`, `backend`, `infra`) and carries a shared spec for that area. Create one on the Kanban board control strip with **+ (Add Project)**, assign plans with **ASSIGN**, and filter the board with the Workspace/Project selector.

Each project can hold a **PRD** (Product Requirements Document) authored on the Project Panel's **PROJECTS** tab and stored at `.switchboard/projects/<project>/prd.md` (git-trackable). Toggle **PROJECT CONTEXT** on the Kanban control strip to inject the active project's PRD — under the header `PROJECT REQUIREMENTS (PRD):` — into *every* dispatched prompt (planner, lead, coder, reviewer, tester, orchestrator). This is the per-project, all-roles successor to the old workspace-wide planner Design Doc setting.

### Features
A Feature groups several plans (its subtasks) so they can be planned and shipped together. Manage features in the **Project Panel → FEATURES** tab: **+ New Feature** to create one (with an optional "Add to Kanban board"), **+ Subtask** to attach existing plans, **Orchestrate** to hand the whole feature to an Orchestrator agent, and **Delete Feature** (subtasks are detached, never destroyed). You can also select a plan on the board and click **PROMOTE TO FEATURE**.

On the Kanban board, feature cards show a purple left border and a `FEATURE · N subtasks` badge; their subtasks are hidden from the main board to avoid duplication and travel with the feature when you drag it (cascade move).

**Three ways to run a feature** (see the `?` help in the Features tab):
- **Step** — Drag the feature column-to-column on the board; each column's agent batch-processes every subtask.
- **Orchestrate** — Click **Orchestrate**; one Orchestrator agent runs the whole feature end-to-end with native subagents.
- **Split (recommended)** — Drag the feature to the **Planner** column to improve every subtask plan, *then* **Orchestrate** to hand the improved feature to the Orchestrator to implement.

**Worktree isolation** — A feature can be bound to a dedicated git worktree/branch so its agents work in isolation. Manage worktrees from the Kanban WORKTREES panel; dispatched agents `cd` into the worktree and switch to its branch automatically, and the worktree can later be merged or abandoned.

**Feature-scoped agent configuration** — Each role can have independent agent settings when working on features versus single plans. In the Prompts tab, a **Features** subsection per role lets you override the workflow file, subagent policy, and worktree mode for feature dispatches only — so a feature can use a different planning workflow or subagent strategy than a standalone plan without changing your defaults.

### ClickUp & Linear Sync
Configure tokens in Setup.
Commands:
- `Set ClickUp API Token`
- `Set Linear API Token`
- `Import Tasks from ClickUp`
- `Import Issues from Linear`
Settings: `switchboard.kanban.completedLimit`, `switchboard.kanban.dbPath`

Beyond token + import, both integrations now do more:
- **ClickUp** (push-only mirror — pushes out, doesn't poll back): outbound content push, move a task between lists (with status auto-mapping), feature round-trip (import parent+subtasks as a feature; push local features out as native parent/child tasks), plus agent-driven task/comment/attachment/doc creation.
- **Linear** (full two-way): bidirectional description sync (Linear edits flow back into the plan file), status/column sync via Remote Control, move an issue between projects, feature round-trip, comments + attachments captured on import, and archive/unarchive used by the Auto-Archive rule.

### Notion Design Doc Integration
Fetch, cache, and append design documents to prompts.
Commands: `Set Notion API Token`, `Fetch Notion Design Doc`

### Operation Modes
- **Coding Mode** (default) — Bidirectional, real-time sync on every column move.
- **Board Management Mode** — Pulls tasks automatically, processes cards independently, and writes back only when `COMPLETED`.
Configure via: `switchboard.defaultMode` (`action` | `plan`)

### Automated Triage Pipeline (ClickUp & Linear) — *pre-release, not currently exposed*
> The one-click triage setup and the ClickUp/Linear **Kanban Board Mapping** and **Kanban Automation** setup sections are hidden in the current build while they're hardened. The Ticket Updater agent and triage flow still exist under the hood, but there's no UI to enable them yet.

When exposed: one-click setup creates a "Bug Triage" board that auto-pulls bugs from ClickUp or Linear, routes them to the Ticket Updater agent for triage verdicts (severity, area, recommended action, routing), and syncs the verdicts back as comments on the source ticket. The agent never overwrites the ticket description — it posts a short structured comment only (target ≤120 words).

### Remote Control (provider-agnostic)
Drive your Kanban board from a remote surface — the **Linear** or **Notion** mobile/web app, or a **ClickUp** mirror. Switchboard polls the active provider on a timer (no webhooks): moving a card between remote states mirrors it onto the board and dispatches that column's agent, and comments posted remotely are routed to the card's current column agent.

Configure it in the **Project panel → REMOTE tab**; start/stop from the Kanban toolbar remote-control button. Controls:
- **Provider** — Linear, Notion, or ClickUp (push-only stakeholder mirror).
- **Boards to sync** — pick which project boards participate.
- **Remote mode** — *Ingest (pull only)* mirrors remote state without dispatching, or *Full (pull + mirror + dispatch)* also runs the column agent. (Full is disabled for push-only providers.)
- **Poll comments from remote** and **Push status & content to remote** — independent toggles (push is disabled for providers that don't support it).
- **Silent syncing** — keep boards mirrored even while pinging is off.
- **Ping frequency** — 30–120s (default 60).

A **Sync Health** panel surfaces last poll/push status, rate-limit backoff, and persistent-failure warnings so silent breakage (bad token, revoked connection) is visible. Config is stored in the Kanban database (key `remote.config`), not in `settings.json`.

### Board State Export (git-native mirror)
Independently of the provider channel, Switchboard can mirror board state to git so it travels with your repo. Set **Board State Export** in the Setup panel — `none` (no git footprint), `control-plane` (push to the control-plane repo), or `wiki` (push to `<remote>.wiki.git`). Settings: `switchboard.boardStateExport`, `switchboard.boardStateExport.remoteUrl`.

### Live Sync Mode
Automatically syncs edits back to ClickUp/Linear every 30 seconds.
- Pause/resume from card right-click menu.
- Sync status indicators (pulsing green, amber, red).
- Conflict detection and auto-idle pause.

### Auto-Pull Timers
Optionally enable automatic updates on a 5/15/30/60-minute timer.

### Auto-Archive Rule
Automatically complete + archive a plan once it has sat in a designated board column past a dwell threshold — useful for keeping a board (and a free-tier Linear workspace) from filling up. Configure on the Kanban Setup tab: enable checkbox, trigger column, and dwell hours (default 2). Off by default. Note the dwell timer keys off the plan's `updatedAt`, so editing or commenting on a plan resets its clock.

---

## Core Workflows

### Batching
Send multiple plans in one prompt. Pay system prompt overhead once.

### Pair Programming Mode
Splits tasks: Lead Coder gets complex parts, cheap Coder CLI handles boilerplate.
- **CLI Parallel** — Dispatch both to terminals.
- **Hybrid** — Clipboard for IDE chat (Lead), terminal for Coder.
- **Full Clipboard** — Both on clipboard/notifications.
- Settings: `switchboard.pairProgramming.aggressive` (shifts more tasks to Coder)

### Plan Review Comments
Highlight plan text to send targeted feedback to the Planner.

### Code Mapping
Generate code path prompts to gather context before writing code.

### Report and Send Back
Testing failed? Press **Report** to return cards with logs to the Coder column.

### Cross-IDE Workflows
Copy links and prompts to share state between Antigravity, Windsurf, and Cursor.

### Memo Capture Mode
Use `/switchboard-memo` to enter append-only capture mode. Every message you send is appended verbatim to `.switchboard/memo.md` — no analysis, no action. This is ideal for logging issues, bugs, and ideas during testing without breaking your flow. Process captured entries into plan files using the Memo sub-tab in the sidebar (Copy Prompt or Send to Planner buttons), or send `process memo` in chat to exit capture mode and create one plan per entry. You can also open the Memo tab directly with the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`).

---

## Planning Tools

### IDE Chat Commands
- `/switchboard` — Local management console (board, plans, features, dispatch, automation).
- `/switchboard-cloud` — Cloud-VM planning brake (plan first, do not auto-code).
- `/switchboard-remote` — Remote control via Linear or Notion when the local machine is off.
- `/switchboard-memo` — Memo capture mode (append-only issue/idea logging).
- `/improve-plan` — Deep planning and adversarial review.
- `/archive` — Search DuckDB plan archives.
- `/export` — Save current conversation to archives.

### Plan Scanner
Periodically scans AI IDE/agent folders for newly generated plan files and imports them.
Settings:
- `switchboard.planScanner.enabled`
- `switchboard.planScanner.intervalSeconds`
- `switchboard.planScanner.presets.antigravity`
- `switchboard.planScanner.presets.windsurfDevin`
- `switchboard.planScanner.presets.cursor`
- `switchboard.planScanner.presets.claudeCode`
- `switchboard.planScanner.scanSwitchboardPlans`
- `switchboard.planScanner.customSources`
- `switchboard.planScanner.chatPlanDestinations`

---

## Panels

- **Kanban** (`switchboard.openKanban`) — Visual board plus tabs for Agents, Prompts, Automation, Remote, Worktrees, UAT, and Setup. Projects are created here (board toolbar) and the PROJECT CONTEXT toggle lives here.
- **Setup** (`switchboard.openSetupPanel`) — Central configuration.
- **Planning** (`switchboard.openPlanningPanel`) — Authoring interface with four tabs: **DOCS** (unified local + online document browser), **TICKETS** (ClickUp/Linear ticket management), **RESEARCH** (AI-assisted research workflow), and **NotebookLM** (zero-cost planning).
- **Project Panel** (`switchboard.openProjectPanel`) — Projects (per-project PRDs), Features, Constitution, System docs, Tuning insights, the **Architect** tab (guided governance setup), and the **Remote** tab (Remote Control config).
  ![Project panel — Constitution](docs/TODO_project_panel.png)
- **Design Panel** (`switchboard.openDesignPanel`) — Six tabs: STITCH (Google Stitch), STITCH HTML (browse cached Stitch HTML by project), BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM (includes Claude Design Systems import).
  ![Design panel — Stitch](docs/TODO_design_panel.png)
- **Planning / Research Panel** — Manage local research, design system files, and Antigravity Brain artifacts.
  ![Research panel — Local Docs](docs/TODO_research_panel.png)
  Settings: `switchboard.research.localFolderPaths`, `switchboard.research.htmlFolderPaths`, `switchboard.research.designFolderPaths`
- **Status Bar Hub** (`switchboard.openHub`) — Grouped actions dropdown.
  Settings: `switchboard.statusBar.showTerminalControls`, `switchboard.statusBar.showKanbanButton`, `switchboard.statusBar.showArtifactsButton`, `switchboard.statusBar.showDesignButton`, `switchboard.statusBar.showProjectButton`, `switchboard.statusBar.compactMode`

### Themes
Skin the UI to taste. Settings: `switchboard.theme.name` (`afterburner` | `claudify`), `switchboard.theme.disableCyberAnimation` (turn off the animated cyber background).

---

## Quota Economics (Feature)

### NotebookLM Airlock
Creates code bundles in `.switchboard/airlock/` to feed into Google NotebookLM for free sprint planning. Import back with **Import from Clipboard**.

### Google Jules Integration
Send low-priority tasks directly to Jules (100 free requests/day).
Setting: `switchboard.jules.autoSync` (auto-commit/push before dispatch)

### Prompt Controls
- **Stricter coder prompts**: `switchboard.accurateCoding.enabled`
- **Inline challenge**: `switchboard.leadCoder.inlineChallenge`
- **Advanced reviewer mode**: `switchboard.reviewer.advancedMode`
- **Unified team prompt rigor**: `switchboard.team.strictPrompts`

---

## The Grumpy Principal Engineer

The built-in Reviewer agent features a Grumpy Principal Engineer persona. It turns dry AI reviews into engaging, pointed feedback to ensure strict compliance without sounding robotic.

---

## Privacy and License

- **100% Local-First** — No external proxy servers, no telemetry, no tracking.
- **Secure SecretStorage** — API tokens for ClickUp, Linear, and Notion are saved locally in VS Code's `SecretStorage`. Keys are never sent to third-party endpoints.
- **MIT License** — Fully open source.

---

## Architecture

- **VS Code Extension** — Terminal orchestration, file watchers, status bar hub.
- **Local SQLite DB** — Kanban state, project mappings.
- **DuckDB Plan Archive** — Auto-archives completed tasks (`switchboard.archive.dbPath`, `switchboard.archive.autoArchiveCompleted`).
- **File Protocol** — Inter-agent messaging via `.switchboard/`.
- **Git Ignore Integration** — Excludes temporary files (`switchboard.workspace.ignoreStrategy`, `switchboard.workspace.ignoreRules`).

---

## Migration: `.agent/` → `.agents/`

Switchboard previously scaffolded its workflow, persona, rule, and skill assets into a `.agent/` directory. It now uses `.agents/` because **Antigravity only autoloads `.agents/`** — a directory named `.agent/` is invisible to it.

**What happened on upgrade:**
- Switchboard scaffolds a fresh `.agents/` directory in your workspace.
- Your old `.agent/` directory is left untouched (it is now inert).

**Cleaning up the old `.agent/` directory:**
- Open the **Setup** tab in the Switchboard sidebar. If a stale `.agent/` folder is detected, a cleanup card will appear with a **Clean up old .agent/ directory** button.
- The button shows a confirmation modal listing the exact path(s) to be deleted. Deletion is guarded: it will refuse if no `.agents/` sibling exists or if your configuration still references `.agent/`.
- You can also delete `.agent/` manually — Switchboard never deletes it automatically.

---

## Links

- [GitHub Repository](https://github.com/TentacleOpera/switchboard/)
- [Comprehensive User Manual](docs/switchboard_user_manual.md)
- [How to Use Switchboard (Detailed Guide)](docs/how_to_use_switchboard.md)
