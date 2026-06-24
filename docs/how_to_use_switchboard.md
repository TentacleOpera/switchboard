# How to Use Switchboard — Best Practices and Platform Guide

Switchboard is a full-lifecycle platform for managing AI agent teams. This guide covers how to set up your workflow from planning to deployment, and how to optimize execution for accuracy, speed, and cost.

## 1. Onboarding: The Lifecycle Flow

To get the most out of Switchboard, follow the standard full-lifecycle pipeline:

1. **Define your Project & Constitution**: Register a project and set its inviolate rules (Constitution) in the Project panel.
2. **Setup your Requirements**: Set up your Design Doc / PRD and Notion links to feed design systems and specifications directly to agents.
3. **Break into Epics & Plans**: Group tasks into Epics (supporting worktree routing) and individual plan files inside `.switchboard/plans/`.
4. **Orchestrate via the Board**: Drag and drop plans through Kanban columns to dispatch work to your CLI or copy prompts for IDE chat agents.
5. **Multi-Repo Execution**: Coordinate agents across multiple codebases simultaneously using the Control Plane.
6. **Self-Review**: Run the Reviewer agent to catch bugs and verify implementations against the plans and attached Design Doc.
7. **Sync & Archive**: Auto-sync state back to ClickUp or Linear, and archive completed plans into DuckDB.

---

## 1.5. Capturing Issues with Memo Mode

During testing or exploration, use `/memo` to enter capture mode. Each message is appended verbatim to `.switchboard/memo.md` — no analysis, no code changes, just capture. When you're done, either open the Memo sub-tab in the sidebar (Agents & Terminals tab → Memo sub-tab) to dispatch entries to the planner or copy the planner prompt to clipboard, or send `process memo` in chat to exit capture mode and create one plan per entry. You can also open the Memo tab directly via the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`).

---

## 2. Setting Up Your Constitution & Requirements

The Project Constitution is your spec-driven governance model. Instead of typing the same rules into every prompt:
- Define rules in the Project panel. They are injected as inviolate invariants in every coding and review prompt.
- Use the **Append Design Doc** feature to attach your product vision to all planner prompts. If you use the Google Drive desktop app, you can point to a local synced file so your agents always work from the latest requirements.
- Set up a Notion design doc integration to fetch and cache PRDs directly.

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

### One-Click Triage Pipeline
In the Setup panel, click "ENABLE TRIAGE PIPELINE" under ClickUp or Linear to auto-create a Bug Triage board. Bugs are pulled in, routed to the Ticket Updater agent, and triage verdicts (severity, area, assessment, recommended action, routing — ≤120 words) are synced back as comments. The agent never overwrites the ticket description.

### Linear Remote Control
Drive your board from your phone via the Linear app. Configure in the Kanban REMOTE tab — select boards, set ping mode (manual/constant), and ping frequency (30-120s). Moving a Linear issue between states dispatches the corresponding Kanban column agent; comments are routed to the current column's agent. Toggle from the toolbar remote control button. Config stored in the Kanban DB, not `settings.json`.
