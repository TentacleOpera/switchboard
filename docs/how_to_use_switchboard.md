# How to Use Switchboard — Best Practices and Platform Guide

Switchboard is a full-lifecycle platform for managing AI agent teams. This guide covers how to set up your workflow from planning to deployment, and how to optimize execution for accuracy, speed, and cost.

## 1. Onboarding: The Lifecycle Flow

To get the most out of Switchboard, follow the standard full-lifecycle pipeline:

1. **Define your Project & Constitution**: Create a project on the Kanban board (**+ Add Project**), set repo-wide inviolate rules (Constitution) in the Project Panel, and write the project's requirements in its PRD (Project Panel → PROJECTS tab).
2. **Setup your Requirements**: Turn on **PROJECT CONTEXT** so the active project's PRD is injected into every agent prompt; optionally add Notion design-doc links for richer specs.
3. **Break into Features & Plans**: Write individual plan files into `.switchboard/plans/`, and group related plans into Features (Project Panel → FEATURES tab) so they can be planned and shipped together — optionally inside an isolated git worktree. See section 5.
4. **Orchestrate via the Board**: Drag and drop plans through Kanban columns to dispatch work to your CLI or copy prompts for IDE chat agents.
5. **Multi-Repo Execution**: Coordinate agents across multiple codebases simultaneously using the Control Plane.
6. **Self-Review**: Run the Reviewer agent to catch bugs and verify implementations against the plans and attached Design Doc.
7. **Sync & Archive**: Auto-sync state back to ClickUp or Linear, and archive completed plans into DuckDB.

---

## 1.5. Capturing Issues with Memo Mode

During testing or exploration, use `/switchboard-memo` to enter capture mode. Each message is appended verbatim to `.switchboard/memo.md` — no analysis, no code changes, just capture. When you're done, either open the Memo sub-tab in the sidebar (Agents & Terminals tab → Memo sub-tab) to dispatch entries to the planner or copy the planner prompt to clipboard, or send `process memo` in chat to exit capture mode and create one plan per entry. You can also open the Memo tab directly via the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`).

### Four front-door commands
Switchboard's chat entry points are consolidated into four slash commands:
- **`/switchboard`** — The local management console: drive the board, plans, features, dispatch, and automation while the VS Code extension is running. This is the primary front door — start here when unsure.
- **`/switchboard-cloud`** — Cloud-VM planning brake: plan first, do not auto-code in a remote VM.
- **`/switchboard-remote`** — Remote Switchboard control: drive plans via Linear or Notion when the local machine is off.
- **`/switchboard-memo`** — Memo capture mode (see above).

The old commands (`/sw`, `/switchboard-chat`, bare `/memo`) have been retired in favor of these four.

---

## 2. Setting Up Your Constitution & Requirements

The Project Constitution is your spec-driven governance model. Instead of typing the same rules into every prompt:
- Define rules in the Project Panel (CONSTITUTION tab). They are injected as inviolate invariants in every coding and review prompt.
- **Use per-project PRDs for requirements.** Create a project on the Kanban board, write its requirements on the Project Panel's **PROJECTS** tab (saved to `.switchboard/projects/<project>/prd.md`), and flip the **PROJECT CONTEXT** toggle (on the Kanban board) on. The active project's PRD is then injected — under the header `PROJECT REQUIREMENTS (PRD):` — into *every* dispatched prompt (planner, lead, coder, reviewer, tester, orchestrator), not just the planner. This is the modern replacement for the legacy planner-only Design Doc setting.
- Set up a Notion design doc integration to fetch and cache external PRDs directly.

### Let the Architect guide you
If you're not sure where to start with governance, open the **Project panel → ARCHITECT** tab and click **Open Architect Terminal**. It launches a guided session (through your Planner terminal) that walks you through writing and refining your PRD, Constitution, `CLAUDE.md`/`AGENTS.md` system files, and tuning insights, showing which of those docs already exist. Prefer to paste it into a chat agent instead? Use **Copy Architect Prompt**.

---

## 3. Quota-Saving and Optimization Tactics

While Switchboard is a full-lifecycle delivery tool, it is also designed to be highly cost-effective. Here are key tactics to maximize your premium model quotas:

### Task Batching
Switchboard instructs agents to use their native subagent features for batch work. Batching tasks means you pay for system prompts and context windows once, rather than multiple times. Send columns of plans together.

### The Opus/Sonnet Split
Opus is extremely capable but expensive. Use Opus in the **Planner** role to write detailed plans, identify edge cases, and assign complexity. Then, use Sonnet in the **Lead Coder** role to implement the code, and Sonnet or Opus in the **Reviewer** slot. This plan-code-review split reduces primary credit costs significantly compared to running Opus for every single task.

### Pair Programming Mode
When pair programming is enabled, Switchboard routes low-complexity boilerplate tasks to a cheap Coder agent (like Gemini CLI Flash) in parallel, reserving your premium IDE coder (like Windsurf, Antigravity, or Cursor) for complex architectural and logic tasks.
- **CLI Parallel**: Both agents run automatically in terminals.
- **Hybrid**: Clipboard prompt for IDE chat (complex), terminal dispatch for Coder (boilerplate).
- **Full Clipboard**: Clipboard prompts for both.

### Spreading Work Across Models
IDE subscriptions often include capable models on unlimited quotas (e.g., Kimi K2.5 in Windsurf, Gemini Flash in Antigravity). Use them strategically:
- Ask an unlimited model to walk through a bug and append its diagnostics to the plan file before routing it to a premium coder.
- Run mixed-model cycles (Gemini plans, Sonnet reviews, Gemini implements) to save flagship model credits.

### The NotebookLM Airlock
Access unlimited Gemini Pro planning quota:
1. Click the **Airlock** tab and click **Bundle Code** to create docx bundles of your repo in `.switchboard/airlock/`.
2. Upload the bundles to a Google NotebookLM notebook.
3. Ask NotebookLM to write plans according to the generated "How to Plan" guide.
4. Copy the output and click **Import from Clipboard** on the board.

---

## 4. Automated Triage & Remote Control

### One-Click Triage Pipeline *(pre-release — currently hidden)*
The triage setup, along with the ClickUp/Linear **Kanban Board Mapping** and **Kanban Automation** setup sections, is hidden in the current build while it's hardened; the underlying Ticket Updater flow still exists but isn't exposed in the UI. When available: in the Setup panel, click "ENABLE TRIAGE PIPELINE" under ClickUp or Linear to auto-create a Bug Triage board. Bugs are pulled in, routed to the Ticket Updater agent, and triage verdicts (severity, area, assessment, recommended action, routing — ≤120 words) are synced back as comments. The agent never overwrites the ticket description.

### Remote Control (Linear / Notion / ClickUp)
Drive your board from your phone or browser via a remote provider. Configure it in the **Project panel → REMOTE tab** and toggle it on/off from the Kanban toolbar remote-control button:
- **Provider** — Linear, Notion, or ClickUp (push-only mirror).
- **Boards to sync** — which project boards participate.
- **Remote mode** — *Ingest (pull only)* just mirrors remote state; *Full (pull + mirror + dispatch)* also dispatches the target column's agent.
- **Poll comments from remote** / **Push status & content to remote** — independent toggles.
- **Silent syncing** — keep mirroring even while pinging is off.
- **Ping frequency** — 30–120s (default 60).

Moving a remote issue between states dispatches the corresponding Kanban column agent (in Full mode); comments are routed to the current column's agent. A **Sync Health** panel shows last poll/push status, rate-limit backoff, and persistent-failure warnings. Config is stored in the Kanban DB (key `remote.config`), not `settings.json`.

Separately, **Board State Export** (Setup panel) mirrors board state to git — `none`, `control-plane`, or `wiki` — via `switchboard.boardStateExport`.

### MCP Monitor — watch your comms without leaving the board
Turn on the **MCP Monitor** in the Kanban Automation panel to have Switchboard ping a dedicated Claude terminal on an interval (1–30 min) that checks your connected MCP sources — Slack, Gmail, Google Calendar, or a custom instruction — and reports anything needing attention in that terminal pane. Pick the sources to watch and the cadence; the status line shows whether the monitor terminal is running (launch it if not). Off by default, and read-only — it never dispatches work.

### Orchestration Automation Mode — unattended batch management
Also in the Kanban Automation panel: switch the automation mode to **Orchestration** and click **Start orchestrator** to launch an orchestrator agent that batch-manages the board unattended. On each interval tick it groups loose plans into features, fans work out across per-feature worktrees and terminals, verifies progress against git/board state, triages agent requests, and merges completed features back to main. This is the unattended equivalent of clicking **Orchestrate** on each feature manually — ideal for letting a fleet of agents work through a backlog overnight.

### Auto-Archive — keep the board (and free-tier limits) tidy
On the Kanban **Setup** tab, enable the **Auto-Archive Rule** to automatically complete + archive any plan that sits in a chosen column past a dwell threshold (default 2 hours). The archive rides your unified push out to Linear/Notion, which helps stay under Linear's free-tier active-issue cap. Off by default. Heads-up: the dwell clock uses the plan's last-updated time, so editing or commenting on a plan resets it — a busy plan may never auto-archive.

---

## 5. Orchestrating with Features

When a feature is too big for one plan, group its plans into a **Feature** so they move and ship as a unit. Manage features in the **Project Panel → FEATURES** tab.

### Building a feature
- Click **+ New Feature** (name + optional description; tick **Add to Kanban board** to show it as a card), or select a plan on the board and click **PROMOTE TO FEATURE**.
- Use **+ Subtask** to attach existing plans. Subtasks disappear from the main board (so you don't see duplicates) and travel with the feature when you drag it.
- Feature cards are easy to spot — purple left border and a `FEATURE · N subtasks` badge.

### Three ways to run a feature
Click the **?** button in the Features tab for this same cheat-sheet:
- **Step** — Drag the feature column-to-column on the board. Each column's agent batch-processes every subtask before the feature advances. Best when you want to watch each stage.
- **Orchestrate** — Click **Orchestrate** on the feature. One Orchestrator agent runs the whole feature end-to-end with native subagents. Enable the **Orchestrator** role in the Kanban Agents tab to dispatch directly; otherwise the button just copies the assembled prompt for you to paste.
- **Split (recommended)** — Drag the feature to the **Planner** column first so every subtask plan gets improved, *then* click **Orchestrate** to hand the polished feature to the Orchestrator. You get better plans *and* coordinated implementation.

### Worktree isolation
Bind a feature to its own git worktree/branch so its agents never collide with your main checkout. Manage worktrees from the Kanban **WORKTREES** panel — dispatched agents automatically `cd` into the worktree and switch to its branch, and you can merge or abandon the worktree when the feature is done. This is ideal for running several features in parallel without branch churn.

### Feature-scoped agent configuration
Each role can have independent agent settings when working on features versus single plans. In the Prompts tab, a **Features** subsection per role lets you override three things for feature dispatches only:
- **Workflow file** — use a different planning workflow for features than for standalone plans.
- **Subagent policy** — no subagents, use subagents, or a custom subagent, independent of your general setting.
- **Worktree mode** — decouple the worktree decision from the subagent decision.

This means a feature can use a different planning workflow or subagent strategy without changing your defaults for single-plan work.

> Deleting a feature only detaches its subtasks (they return to the board) — it never destroys the underlying plans.

---

## 6. Design in the Loop (Stitch & Claude)

The Design panel keeps UI work inside the IDE so it can feed straight into plans and code. It has six tabs: **STITCH**, **STITCH HTML**, **BRIEFS**, **HTML PREVIEWS**, **IMAGES**, and **DESIGN SYSTEM**.

### Google Stitch
Generate and refine UI screens on the **STITCH** tab. Authenticate once with your Stitch API key or OAuth token (stored in VS Code `SecretStorage`), pick a sync destination folder, and download HTML/PNG output plus design tokens to hand off to coders. The **STITCH HTML** tab browses your cached Stitch HTML output organized per project, so you can preview, inspect, and tweak generated screens without hunting through folders.

### Claude (claude.ai/design)
Import designs from Claude's design tool via the **DESIGN SYSTEM** tab's "Claude Design Systems" source:
1. (Optional) Paste a `claude.ai/design` URL or project ID into the project field (or leave blank to list your projects).
2. Click **Copy import prompt** (or **Import from Claude Design** to send directly).

The prompt instructs the agent to import the design into your repo **using the repo's existing components and styles**, and running `/design-login` first if you're not authenticated. Nothing is stored in Switchboard — your Claude agent does the import. To automate it from the board, enable the **Claude Designer** agent role.

### Claude Artifacts round-trip
The **HTML PREVIEWS** tab and the Planning panel's HTML tab include **Copy upload prompt** / **Upload to Claude Artifacts** buttons that push a local HTML file to claude.ai as an Artifact, plus a download prompt to pull an Artifact back into your repo. This gives you a repeatable loop: pull an artifact down, edit it with any agent, push it back — useful for stakeholder-facing documents and prototypes hosted on claude.ai.

All tabs share the panel's folder browsing, **Link to Folder** buttons (copy a configured folder's path to the clipboard), HTML/image previews with zoom, and the **BRIEFS** / **DESIGN SYSTEM** infrastructure.

### Inspect Mode — tweak a previewed element and hand it to the coder
Every sandboxed HTML preview in Switchboard has an **Inspect Mode** button in its controls strip — the Stitch HTML tab, the Design panel's **HTML PREVIEWS** tab, and the Planning panel's HTML tab. Once a screen or prototype is close enough, you don't need to regenerate it or leave the preview to make small surgical edits. Inspect Mode is the handoff from preview to in-file tweak:

1. Click **Inspect Mode** to toggle hover-to-select on.
2. Hover the rendered page — elements highlight as you move the cursor.
3. Click the element you want to change. A tweak popup (docked top-right of the preview) opens showing the element's **CSS selector** and a truncated **HTML snippet** — the payload that lets the agent grep straight to the right node instead of reading the whole file.
4. Type your change (e.g. "make this button dark blue", "tighten this card's padding").
5. **Send to Agent** delivers a composed prompt — file path, selector, snippet, and your instruction — to the **coder** agent terminal (it falls back to the clipboard if no terminal is registered). **Copy Prompt** puts the same prompt on the clipboard for an IDE chat agent instead.
6. The agent edits the file in place and the preview **auto-refreshes** to show the result. Switchboard never rewrites the file itself, so your tweaks are never clobbered by a regeneration.

While inspect is on, links and buttons inside the preview are inert so you can select without navigating away. Press **Escape** (with focus in the preview) or click **Inspect Mode** again to turn it off. If the file is saved or auto-refreshed mid-composition, the popup closes and the selection resets — but your typed instruction is preserved so you don't lose your draft.

This works identically across all three HTML preview surfaces, so the same tweak-and-handoff loop applies whether you're refining a Stitch-generated screen, a Design-panel HTML prototype, or an HTML file browsed from the Planning panel.

---

## 7. Tickets Tab — PM Tool Management Inside VS Code

The Planning panel's **TICKETS** tab lets you browse, search, filter, import, and create tickets directly from ClickUp or Linear without leaving VS Code. Features include:
- **Workspace / provider / project pickers** and **state / status filters** to narrow the view.
- **+ New Ticket** to create a ticket inline; **Refetch** to re-pull from the source; **Sync changes** to push local edits back.
- **Hierarchy navigation** via breadcrumbs for parent/child ticket navigation.
- **Ticket preview meta bar** with Edit, Save, Cancel, Push (push to PM tool), Delete, Status dropdown, Tags, Comment, Attachments, Open (open in browser), Diagram Prompt, + Subtask, and Convert to Subtask.
- **Sidebar actions**: **Link all** (copy all ticket paths), **Import all to kanban**.

This is the day-to-day PM surface for triage and ticket management — complementing the Kanban board's plan-centric workflow.

---

## 8. Project Manager Role & the Manage Button

The **Project Manager** is a core agent role (on by default) that provides a host-agnostic management console — you can drive the board over the LocalApiServer HTTP API from any chat host (Claude Desktop, claude.ai, Antigravity, etc.) while VS Code runs in the background.

Activate it via the **Manage** button in the Implementation panel, or the board's **Run Selected Plans** targeted-pass button. The manager console:
- Presents plan lists with numbered titles (no raw UUIDs or filenames).
- Offers proactive follow-up suggestions after every list ("Dispatch any of these, or group some into a feature?").
- Delivers natural-language dispatch reports naming the receiving agent.
- Can self-service open agent terminals via the API instead of directing you to the IDE.
