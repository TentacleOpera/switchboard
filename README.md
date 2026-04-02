# Switchboard

**Drag and drop AI orchestration for VS Code — run your entire agent team without typing a single prompt**

Switchboard is a different approach to AI orchestration. A visual kanban auto-triggers agents via drag and drop, no prompts required. This allows you to run entire agent teams while drinking a beer, since you only need one hand to code with Switchboard.

There's nothing to install beyond the extension itself. If you already have your agents open, you're ready. No gateway, no runtime, no API keys, no config files. Just drag a card.

It does this programmatically using the VS Code API, so unlike other orchestration frameworks, you don't need an orchestration agent. You just start your CLI subscriptions in terminals and start dragging cards around to trigger them. Whenever you move a card into a column, Switchboard sends a pre-configured prompt referencing that task to the agent registered in that column. 

Switchboard also works with chat-based agents like Windsurf, Antigravity and Cursor. You can switch the board between trigger mode, which auto-sends prompts to terminals, and paste mode, which auto-copies prompts to your clipboard. That way you can combine the strengths of different subscriptions. For example, create 10 plans and tell the free Kimi 2.5 in Windsurf to gather context. Then shove them all into Claude Code to plan. Then punt them into GitHub Copilot as a single prompt to take advantage of its native subagents, before asking Windsurf Opus to review the work.

Doing it this way means you don't blow Claude Code quota on context gathering, you get 10 plans implemented for the price of 1 by taking advantage of Copilot's per-prompt pricing, and by switching to a different provider for code review, you'll catch issues that a single agent may have missed. 

![Switchboard Savings](docs/savings2.png)

What this shows: Using the pair programming mode, Windsurf Opus reported token savings of 35% by offloading routine parts of the plans to Gemini CLI. Meanwhile, Gemini CLI deployed subagents to code 5 plans in parallel. This was all done by batch moving plan cards.

---

## How it works

- **A visual kanban auto-triggers agents via drag and drop** — run entire agent teams without typing a single prompt
- **Works across both CLI and IDE agents** (Windsurf, Cursor, Antigravity, Copilot CLI, Gemini CLI) — combine all your subscriptions, not just CLIs
- **Batch and parallelise** — send entire columns of plans to agents in one prompt, with instructions to spawn subagents. Multiple tasks execute simultaneously without you doing anything
- **Assign by complexity** — put an Opus subscription in the Planner slot and it will organise which tasks can be sent to cheap agents based on a complexity threshold you set
- **Amplify other tools** — put Claude Code, OpenCode, Copilot Squads, or anything else into the kanban to route between them
- **No repo pollution** — kanban state, routing rules and archived plans live in a multi-repo database on Google Drive, so you can share across machines without random files appearing in every commit

---

## Getting started

For a detailed walkthrough, see our [How to use Switchboard](docs/how_to_use_switchboard.md) guide.

### 1. Install

Install from any VS Code marketplace. Search for **Switchboard**.

### 2. Set up your agent team

Open the Switchboard sidebar and navigate to **Setup**. Enter your CLI agent startup commands — for example `copilot --allow-all-tools` or `gemini --approval-mode yolo`. Switchboard boots them in VS Code terminals, tracks their PIDs, and dispatches messages using the official VS Code `terminal.sendText` API.

Assign agents to roles in the sidebar:

- **Planner** — your premium model (Opus, Windsurf, Copilot). Writes detailed plans, assigns complexity scores, recommends routing.
- **Lead Coder** — handles high-complexity tasks. Typically your best CLI agent.
- **Coder** — handles low-complexity and boilerplate. A cheap, fast model like Gemini Flash.
- **Reviewer** — compares implementations against plans, flags scope creep, and ships with the Grumpy Principal Engineer persona.
- **Analyst** — general purpose questions and research.

You can add custom agent roles with their own prompts and routing rules via the setup menu.

### 3. Create your first plans

Click **Create Plan** in the AUTOBAN to add plans to the New column. Write basic goals — Switchboard handles the detail. You can also:

- Import plans automatically from any folder you specify (point it at Antigravity Brain, a Claude Code output directory, or anywhere else)
- Use the NotebookLM Airlock to generate plans at zero token cost
- Use IDE chat commands like `/improve-plan` to deep-plan directly into the database

### 4. Run your pipeline

Hit **Copy All Plans** to generate a planning prompt. Paste it into your Planner agent. It reads the board, enriches each plan, assigns a complexity score, and produces a routing table — every task gets an agent recommendation. You can see exactly what it decided before anything runs.

Hit the column controls to route in one click. The board constructs every prompt automatically and dispatches it to the right agent. No tokens spent on coordination.

---

## The AUTOBAN

The AUTOBAN is the central control surface — a fully configurable kanban pipeline that actively controls your agent team. Dragging a card or pressing a column button doesn't just move a plan, it dispatches a prompt to the target agent.

Plan state is stored in a local database and prompts are dispatched using the VS Code terminal API. Everything runs on your machine — no external services, no hidden dependencies. For teams, a Google Drive sync option keeps your database out of your repo and accessible across machines.

### Column controls

Each column has a set of controls at the top:

- **Drag and drop** individual cards to trigger that column's agent
- **Move Selected** — route selected plans to the next stage
- **Move All** — route all plans in the column to the next stage
- **Copy Prompt Selected** — generate a prompt for selected plans and copy to clipboard
- **Copy Prompt All** — generate a prompt for all plans and copy to clipboard

### Routing modes

Set each column's routing mode using the toggle in the column header:

- **CLI Triggers** — plans are dispatched automatically via `terminal.sendText`
- **Prompt mode** — plans are copied to clipboard for manual pasting into IDE chat

### Complexity routing

When you advance plans, Switchboard reads the complexity classification your Planner assigned and routes automatically:

- High complexity → Lead Coder
- Low complexity → Coder
- Dynamic → routes based on the threshold you set in the setup menu

### AUTOBAN Automation

Press **START AUTOBAN** to process plans automatically on a timer. Switchboard spins up multiple terminals per role and rotates plans through stages without any manual input. Each CLI is instructed to use its own native subagents, so at full speed you have multiple terminals each running their own subagents working through your backlog. Because each terminal is only triggered every few minutes, this does not trip provider rate limits.

Configure per column:
- Agent count (number of terminals to spawn)
- Timing interval
- Batch size (plans per prompt)

---

## Core workflows

### Batching

Select multiple cards and send them as a single prompt. Every batch includes an instruction to use native subagents, so each task still gets focused attention — you just pay the system prompt overhead once instead of once per task.

### Pair programming mode

Pair programming splits high-complexity plans into two streams: Lead Coder handles the complex work while a cheaper Coder agent handles boilerplate simultaneously. This can reduce your primary IDE agent quota by up to 50%.

Enable with the **Pair Programming** toggle at the top of the AUTOBAN.

| Mode | Lead gets | Coder gets |
| :--- | :--- | :--- |
| **CLI Parallel** | CLI terminal dispatch | CLI terminal dispatch |
| **Hybrid** | Clipboard prompt → paste to IDE chat | CLI terminal dispatch |
| **Full Clipboard** | Clipboard prompt → paste to IDE chat | Notification button → clipboard prompt |

Enable **Aggressive Pair Programming** in the setup sidebar to shift more tasks to the Coder. Only truly complex work (new architectures, security logic, concurrency) goes to the Lead. Everything else goes to the Coder. The Reviewer becomes your primary quality gate in this mode.

### Plan review comments

Highlight text within any plan to send a targeted comment to your Planner referencing that exact text. Useful for precise plan improvements without rewriting the whole plan. A good use of this is running Claude Code Sonnet in the Planner terminal — ask Sonnet questions about Opus-written plans without spending Copilot quota.

### Cross-IDE workflows

Plan with Antigravity, implement in Windsurf. Click **Copy** on any plan to copy a link and auto-generated implementation prompt to your clipboard, then paste into your other IDE's chat.

---

## Advanced features

### NotebookLM Airlock

The Airlock bridges your IDE and Google NotebookLM, giving you quota-free sprint planning. NotebookLM gives Google Pro subscribers unlimited Gemini Pro in a sandboxed environment.

1. Open the **Airlock** tab and click **Bundle Code** — creates docx bundles of your repo in `.switchboard/airlock/`, plus a manifest and a "How to Plan" skill
2. Open NotebookLM, create a new notebook, upload the entire airlock folder as sources
3. Ask NotebookLM to "follow the How to Plan guide and generate plans for every task in the New column"
4. Copy the output, then use **Import from Clipboard** at the top of the AUTOBAN — Switchboard saves each plan into your database
5. Use the AUTOBAN to assign to agents as normal

### DuckDB plan archive

Completed plans are automatically sent to a DuckDB archive database rather than deleted. Search past tasks, query historical features, and review how complex systems were implemented over time without cluttering your active AUTOBAN. Query the archive using `/archive` in any IDE chat workflow.

### Google Jules integration

Running low on quota with a Google Pro subscription? Press a button in the AUTOBAN to start sending tasks to Jules — 100 free Gemini requests per day. Works well for low-priority backlog items. Enable `switchboard.jules.autoSync` to automatically run `git add/commit/push` before dispatching to Jules.

### Prompt Controls

Switchboard's automated prompts can be extended using the checkboxes in the Setup sidebar:

- **Accurate coding mode for Coder prompts** — adds stricter implementation instructions to Coder prompts
- **Inline challenge step for Lead Coder prompts** — forces the Lead Coder to adversarially challenge a plan before writing any code
- **Advanced reviewer mode** — enables deep regression analysis including orphaned reference checks and race condition detection. High token usage.
- **Aggressive pair programming** — shifts more tasks to the Coder agent. Use with a capable Reviewer as your quality gate.
- **Append PRD** — appends a link to your PRD to every automated prompt, so agents always have requirements context without you having to paste it manually. Supply a Google Drive local sync link to keep agents working from a living document.

### IDE chat commands

Use these within Antigravity or Windsurf chat:

| Command | What it does |
| :--- | :--- |
| `/chat` | Switches the AI into planning mode — no code, just collaborative plan writing saved directly to switchboard/plans |
| `/improve-plan` | Deep planning, dependency checks, and adversarial review in one pass |
| `/archive` | Query or search the historical DuckDB plan archive |
| `/export` | Export the current conversation to the plan archive database |

---

## The Grumpy Principal Engineer

The built-in Reviewer agent ships with a Grumpy Principal Engineer persona. When reviewing large batches of automated code output, dry AI-generated reviews blur together. The Grumpy Engineer enforces strict code accuracy while making the output genuinely engaging — every review reads like feedback from a battle-scarred staff engineer who has seen your exact mistake deployed to production before. Pointed, memorable, and impossible to skim past.

---

## Trust, account safety and the ToS

Switchboard is completely local. No proxy servers, no external API keys, no ToS violations.

Coordination uses the official VS Code `terminal.sendText` API to automate agents running in your own terminals, under your own standard authentication. Everything happens on your machine. [Read the full architectural analysis here.](docs/ToS_COMPLIANCE.md)

---

## Architecture

- **VS Code Extension** — manages terminals, sidebar UI, AUTOBAN, plan watcher, and inbox watcher
- **Bundled MCP Server** — exposes tools to agents (`send_message`, `check_inbox`, `get_kanban_state`, `start_workflow`, `run_in_terminal`)
- **Local database** — stores plans, routing state, and complexity classifications locally with optional Google Drive sync
- **DuckDB archive** — stores completed plans for historical querying
- **File Protocol** — all coordination happens via `.switchboard/` in your workspace — transparent, auditable, and entirely local

---

## Privacy and licence

No telemetry. No external servers. All coordination data is workspace-local. Open source — MIT License.

[GitHub](https://github.com/TentacleOpera/switchboard/) 