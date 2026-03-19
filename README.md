# Switchboard

**Combine any AI subscription into automated pipelines — double the value of each subscription, no API keys required.**

Switchboard is a VS Code extension that lets you coordinate CLI agents (Copilot CLI, Claude Code, Gemini CLI, Codex), IDE chat agents (Windsurf, Antigravity), and local LLMs into a unified dev pipeline. It uses a **Kanban board** as the central control surface — create plans, drag-and-drop them to agents, batch tasks, and auto-route work by complexity.

No authentication hacks, no API keys. Just the official VS Code API (`terminal.sendText`) and a local SQLite database running in your repo.

![Switchboard](https://raw.githubusercontent.com/TentacleOpera/switchboard/main/docs/switchboardui.png)


## Example Workflow

Here's what a real session looks like — combining Windsurf, Copilot CLI, and Gemini CLI:

1. Create 11 plans in the Kanban board **New** column using the **Create Plan** button
2. Ask Windsurf Opus to "run the improve plan workflow on all plans in the New Kanban column"
3. Opus uses the MCP tool `get_kanban_state` to find all 11 plans, adds high detail to each, and recommends which agents should handle them — all in a single turn for the cost of **1 Windsurf credit**
4. The plugin parses the plans and records Opus' complexity recommendations to the database
5. Press **Advance All Plans** at the top of the Kanban — high-complexity tasks auto-route to Opus in Copilot, low-complexity tasks route to GPT running in a separate Copilot terminal
6. Each terminal processes all its assigned plans in a single turn using native subagents — GPT implements 9 low-complexity plans for **1 credit**, Opus implements 2 high-complexity plans for **3 credits**
7. When all tasks finish, press **Advance All Plans** in the coder columns to send a review request to Gemini CLI, which uses its native subagents to compare all 11 implementations against the plans

**Result:** 11 tasks fully planned, implemented, and reviewed for the cost of 1 Windsurf credit and 4 Copilot credits — **$0.39 real dollar cost**. Doing this one-by-one in Copilot Opus would cost $0.99+ and be significantly slower.

**Video guide:** Setup videos are linked on the project page.


## Quick Start

1. Open the **Switchboard sidebar** (click the icon in the activity bar).
2. Click **Setup** → **Initialise**. This auto-configures the MCP for Antigravity, Windsurf, and VS Code-compatible IDEs in one click.
3. Enter your CLI startup commands in Setup (e.g., `copilot --allow-all-tools`, `gemini`, `codex --full-auto`), save, then click **Open Terminals**.
4. Authenticate in each terminal and choose your models.
5. Draft a plan using `/chat` in your AI chat, refine it, or click **Create Plan** in the Kanban.
6. Drag-and-drop plans on the **Kanban board**, use the **Advance All** buttons, or use sidebar **Send** buttons to dispatch work to your agents.


## Features

### Kanban Board

The Kanban board is the central control surface. Each column represents an agent role, and each card is a plan.

- **Drag-and-drop** individual cards, multi-select cards, or use buttons to advance all cards to the next stage
- **Complexity-based auto-routing** — when you advance plans, the plugin reads the complexity classification and routes high-complexity tasks to your Lead Coder (e.g. Opus) and low-complexity tasks to your standard Coder (e.g. GPT, Flash)
- **Custom agents** — Switchboard ships with 5 built-in agent roles, but you can add your own roles to the Kanban and customize their automated prompts via the setup menu

### Task Batching

Per-prompt subscriptions like Copilot and Windsurf charge per prompt with no upper limit on work done. Switchboard exploits this by batching multiple plans into a single prompt. Why spend 1 credit per plan when you can spend 1 credit on 2, 3, 4, or 9 plans?

Use a cheaper model (Gemini CLI, Claude Code, Antigravity) to create highly detailed plans, then use the Kanban to send them to Copilot or Windsurf Opus to implement in one prompt. **$10 buys 100 Opus prompts in Copilot — that's 100 substantial features after planning.**

### AUTOBAN Automation

No API keys, and no wasted tokens on spawning automation processes. Instead, Switchboard spins up multiple terminals per role (e.g. 5 × Lead Coder with Copilot in each) and rotates plans gatling-style — every few minutes a plan is sent to an agent, and by the time the rotation completes, the first terminal is free for a new plan. Each CLI is also instructed to use its own native subagent features, so at full speed you have multiple terminals each running their own subagents to chew through a large backlog.

Use the **Advance All** button to send each task in a column to the next agent on a timer. For example, create 10 plans, advance them all to the Planner on a 5-minute timer. Come back in an hour and advance them all to the Lead Coder on a 10-minute timer.

### Plan Review Comments

Highlight text within a plan to send a targeted comment to the Planner agent referencing that exact text, enabling precise planning improvement conversations. A great use of this is to run Claude Code Sonnet in the Planner terminal — after Copilot/Windsurf Opus writes the initial plans, ask Sonnet questions about them without spending Copilot credits.

### Google Jules Integration

If you're running low on quota and have a Google Pro subscription, press a button in the Kanban board to start sending tasks to Jules, which gives you 100 free Gemini requests per day. This works well for low-priority backlog items.

### Cross-IDE Workflows

Plan with Antigravity and Gemini CLI, then move the plan to Windsurf running Opus to implement or review. In the Kanban or sidebar, click **COPY** to copy the plan link to your clipboard, then paste it into your other IDE's chat.


## NotebookLM Airlock

The Airlock feature bridges your IDE and Google's NotebookLM, giving you quota-free sprint planning. NotebookLM gives Google Pro subscribers unlimited Gemini Pro use in a sandboxed environment — excellent for planning without wasting IDE quotas.

For example, if you use Antigravity Gemini Pro for planning, you exhaust your weekly Pro quota in about 10 plans. With Airlock, you use **0 quota** on 10 plans.

1. Open the **Airlock** tab and click **Bundle Code** — creates docx bundles of your repo in `.switchboard/airlock/`, plus a manifest and a "How to Plan" skill
2. Open NotebookLM, create a new notebook, upload the entire airlock folder as sources
3. Ask NotebookLM to "follow the How to Plan guide and generate plans for every task in the New Kanban column"
4. Copy the output, then use the **Import from Clipboard** button at the top of the Kanban — Switchboard saves each plan into your database
5. Use the Kanban to assign to agents as normal

The `manifest.md` file included in the Airlock folder maps your repo: file locations across bundles, file sizes, and any introductory comments at the top of each file. The Airlock panel also includes an option to have your Analyst agent add explanatory comments to each file, which then get pulled into the manifest.

### Why NotebookLM?

NotebookLM reads all source files fully instead of truncating the middle like other web AI tools. The only caveat is that it truncates code blocks in markdown/txt, which is why Switchboard converts code into docx prose.


## Automated Pipelines

The sidebar includes panels for asynchronous team automation:

| Command | What it does |
| :--- | :--- |
| `Pipeline` | Every 10 minutes, picks an open plan and passes it to the next agent in your chain (Planner → Coder → Reviewer). |
| `Auto Agent` | Sends the active plan to Planner, Lead Coder, and Reviewer on a 7-minute timer between stages. |
| `Lead + Coder` | Reads the plan's complexity split and routes low/medium work to the Coder, complex work to the Lead Coder. |
| `Coder + Reviewer` | Sends the plan to the Coder, then asks the Reviewer to verify — lifts cheap coding quality without needing Opus. |


## Agent Roles

Switchboard ships with 5 built-in agent roles. You can add custom roles via the setup menu (e.g. a "Frontend Coder" that only works on UI tasks).

| Role | Recommended tool | Purpose |
| :--- | :--- | :--- |
| Lead Coder | Copilot CLI (Opus 4.6) | Large feature implementation |
| Coder | Qwen, Gemini Flash 3, Codex 5.3 Low | Boilerplate and routine work |
| Planner | Codex 5.3 High, Gemini 3.1 CLI | Plan hardening and edge cases |
| Reviewer | Codex 5.3 High | Bug finding and verification |
| Analyst | Qwen, Gemini Flash 3 | Research and investigation |


## IDE Chat Workflows

Use these within the Antigravity chat to replicate sidebar or Kanban actions. *The buttons and Kanban are generally faster since they are programmatically controlled.*

| Command | What it does |
| :--- | :--- |
| `/chat` | Ideation mode — discuss requirements before any plan is written. |
| `/improve-plan` | Deep planning, dependency checks, and adversarial review in one pass. |
| `/challenge` | Internal adversarial review pass (advisory-only, no Kanban auto-move). |
| `/handoff` | Route sanity-checking for micro-specs to a CLI agent; ends at spec decomposition. |
| `/handoff-lead` | Send everything to your Lead Coder agent in one shot. |
| `/handoff-chat` | Copy the plan to the clipboard for pasting into Windsurf or another IDE. |
| `/handoff-relay` | Current model does the complex work, then pauses for a model switch. |
| `/accuracy` | High-precision implementation mode with mandatory self-review gates. |

> Use `--all` with any handoff to skip complexity splitting and send the whole plan.


## Trust, Account Safety & The ToS

Switchboard was built to be completely local. **There are no proxy servers, no external API keys, and no ToS violations.**

The coordination layer is strictly file-based. Switchboard uses the official VS Code `terminal.sendText` API to automate agents running in your own terminals, under your own standard authentication. Everything happens entirely on your machine. [Read the architectural analysis here.](docs/ToS_COMPLIANCE.md)

## Architecture

* **VS Code Extension:** Manages terminals, sidebar UI, Kanban board, plan watcher, and inbox watcher.
* **Bundled MCP Server:** Exposes tools to agents (`send_message`, `check_inbox`, `get_kanban_state`, `start_workflow`, `run_in_terminal`, etc.).
* **SQLite Database:** Stores plans, Kanban state, and complexity classifications locally.
* **File Protocol:** All coordination happens via `.switchboard/` in your workspace — transparent, auditable, and entirely local.

## Privacy & License
No telemetry. No external servers. All coordination data is workspace-local. Open source — MIT License.

[GitHub](https://github.com/TentacleOpera/switchboard/) · [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=TentacleOpera.switchboard)
