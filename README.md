# Switchboard

**Full-lifecycle AI agent platform for VS Code — manage your entire delivery pipeline from spec to ship via drag-and-drop**

Switchboard orchestrates your AI agent team across the full delivery lifecycle: from spec/governance, planning, and design, through multi-repo execution, review, PM-tool sync, and archiving.

Manage the whole project by moving cards instead of typing into chat. This makes it practical to multitask across several agents at once while drinking a beer — you only need one hand to route code with Switchboard.

There is nothing to install beyond the extension itself. If you already have your agents open, you are ready. No gateway, no runtime, no external servers.

---

## How it works

- **Drag-and-drop orchestration** — Manage the whole project by moving cards to dispatch real work.
- **Zero-overhead coordination** — No orchestration agent, no gateway, and no API keys required for local execution. Direct VS Code API control.
- **CLI & IDE agent pipeline** — Combine the strengths of chat-based agents (Windsurf, Cursor, Antigravity) and CLI-based tools (Claude Code, Gemini CLI, Copilot CLI).
- **Spec-driven governance** — Inject project-wide rules (Constitution) automatically into every agent step.
- **Multi-repo Control Plane** — Run a single board that orchestrates agents across multiple repositories with a shared local database.
- **Design-in-the-loop** — Generate UIs with Google Stitch directly inside the IDE to feed requirements straight into plans and code.
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

### 3. Design in the Loop (Google Stitch)
Generate design assets inside the Design panel using Google Stitch. Authenticate by entering your Stitch API key or OAuth access token directly in the Design panel — those credentials are held in VS Code's `SecretStorage`, never in `settings.json`.
Settings (`settings.json`):
- `switchboard.stitch.authMode` (`apiKey` | `oauth`)
- `switchboard.stitch.defaultProjectId`
- `switchboard.stitch.defaultOutputFolder`
- `switchboard.stitch.defaultModelId` (`GEMINI_3_FLASH` | `GEMINI_3_1_PRO`)
- `switchboard.stitch.defaultCreativeRange` (`EXPLORE` | `REFINE` | `REIMAGINE`)

---

## Getting Started

### 1. Install
Install **Switchboard** from the VS Code Marketplace.

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

You can add custom roles in the Setup panel.

### 3. Create Plans
Click **Create Plan** in the AUTOBAN. You can also:
- Run the **Plan Scanner** to auto-detect and import plan files from Antigravity, Windsurf-Devin, Cursor, Claude Code, or custom paths.
- Generate plans at zero cost via **NotebookLM Airlock**.
- Run IDE chat commands like `/improve-plan` to write plans directly.

### 4. Run the Pipeline
Copy the Planning prompt, enrich the plans, and drag cards to trigger agents.

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

---

## Project Management & Sync

Organize plans into **Projects** (mini-workspaces) and **Epics** (groups of plans, supports worktree dispatch routing).

### ClickUp & Linear Sync
Configure tokens and mappings in Setup.
Commands:
- `Set ClickUp API Token`
- `Set Linear API Token`
- `Import Tasks from ClickUp`
- `Import Issues from Linear`
Settings: `switchboard.kanban.completedLimit`, `switchboard.kanban.dbPath`

### Notion Design Doc Integration
Fetch, cache, and append design documents to prompts.
Commands: `Set Notion API Token`, `Fetch Notion Design Doc`

### Operation Modes
- **Coding Mode** (default) — Bidirectional, real-time sync on every column move.
- **Board Management Mode** — Pulls tasks automatically, processes cards independently, and writes back only when `COMPLETED`.
Configure via: `switchboard.defaultMode` (`action` | `plan`)

### Live Sync Mode
Automatically syncs edits back to ClickUp/Linear every 30 seconds.
- Pause/resume from card right-click menu.
- Sync status indicators (pulsing green, amber, red).
- Conflict detection and auto-idle pause.

### Auto-Pull Timers
Optionally enable automatic updates on a 5/15/30/60-minute timer.

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

---

## Planning Tools

### IDE Chat Commands
- `/switchboard-chat` — PM consultation workflow.
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

- **Kanban** (`switchboard.openKanban`) — Visual board.
- **Setup** (`switchboard.openSetupPanel`) — Central configuration.
- **Planning** (`switchboard.openPlanningPanel`) — Authoring interface.
- **Project Panel** (`switchboard.openProjectPanel`) — Mini-workspaces, Epics, Constitution files.
  ![Project panel — Constitution](docs/TODO_project_panel.png)
- **Design Panel** (`switchboard.openDesignPanel`) — Google Stitch interface.
  ![Design panel — Stitch](docs/TODO_design_panel.png)
- **Research / LOCAL DOCS Panel** — Manage local research, design system files, and Antigravity Brain artifacts.
  ![Research panel — Local Docs](docs/TODO_research_panel.png)
  Settings: `switchboard.research.localFolderPaths`, `switchboard.research.htmlFolderPaths`, `switchboard.research.designFolderPaths`, `switchboard.research.antigravityBrainEnabled`
- **Status Bar Hub** (`switchboard.openHub`) — Grouped actions dropdown.
  Settings: `switchboard.statusBar.showAgentOpenToggle`, `switchboard.statusBar.showTerminalControls`, `switchboard.statusBar.showKanbanButton`, `switchboard.statusBar.showArtifactsButton`, `switchboard.statusBar.showDesignButton`, `switchboard.statusBar.showProjectButton`, `switchboard.statusBar.compactMode`

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
