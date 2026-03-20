# Switchboard

**Combine multiple subscriptions to extend daily quotas, stay under rate limits and double the value of your subcriptions**

Switchboard is a VS Code extension that combines CLI agents (Copilot CLI, Claude Code, Gemini CLI, Codex), IDE chat agents (Windsurf, Antigravity), local LLMs and also(!) NotebookLM into a single pipeline. It uses a **CLI-BAN Routing Board** as the central pipeline control surface — create plans, drag-and-drop them into new coluns to trigger CLI agents, batch entire sprints into single prompts, and auto-route work by complexity.

The pair programming mode can also increase chat-based quotas like Windsurf or Antigravity by as much as 50%. This offloads boilerplate work from Opus in Windsurf to Gemini CLI Flash or another cheap CLI of your choice. Windsurf Opus gets sent the complex part of the plan, Flash gets sent the simple parts of the plan, then Opus reviews Flash's work. 

Ultimately, Switchboard gives you the option of combining smaller subscriptions into a single workflow instead of having to spend $100+ for a Claude Max or Google Ultra subscription. With Google Pro ($20), Copilot Pro ($10) and Windsurf ($20) you can achieve similar results for half the cost. 

*By Grabthar's Hammer, what a savings.*

Switchboard achieves this with no authentication hacks, no API keys. Just the official VS Code API (`terminal.sendText`) and a local SQLite database running in your repo. Unlike other frameworks like OpenCode, you're not burning tokens on automation, and there's no danger of breaching ToS. 

![Switchboard](https://raw.githubusercontent.com/TentacleOpera/switchboard/main/docs/switchboardui.png)


## Example Workflow

Here's what a real session looks like — combining Windsurf, Copilot CLI, and Gemini CLI:


Here's what a real session looks like — combining Windsurf, Copilot CLI, Gemini CLI and NotebookLM:
1. During setup, you enter your CLI Agent commands (e.g. copilot --allow-all-tools) into the setup menu. Switchboard will now start VS Code terminals with those commands and track their PIDs so it can send messages using the VS Code API terminal.sendText
2. Create 5 plans in the CLI-BAN **New** column using the **Create Plan** button
3. Press the **Copy prompt for all plans** button and press control-v to paste the planning prompt into Windsurf
4. The CLI-BAN auto-advances the plans to the Planner column and saves the state to the database
5. Windsurf Opus uses the MCP tool `get_kanban_state` to find all 5 plans, adds high detail to each along with a complexity score, and recommends which agents should handle each
6. Switchboard regex-parses the plans and records Opus' complexity recommendations to the database
7. Press **Move All Plans** at the top of the CLI-BAN Planned column to route high-complexity tasks to Copilot CLI Opus, and low-complexity boilerplate to Gemini CLI Flash
8. Each terminal processes its assigned plans in a single turn using native subagents
9. When all tasks finish, press **Move All Plans** in the coder columns to send a review request to Gemini CLI Pro, which uses its native subagents to compare all the implementations against the plans
10. Upload all your code to NotebookLM using the Airlock tab (this converts the code to docx files for NotebookLM compatability) and use the sprint planning prompt button to ask it to produce plans using free Gemini Pro quota, then paste them into the Switchboard CLI-BAN
11. And so on

**Result:** 5 - 10 tasks fully architected, implemented, and reviewed across Windsurf, Copilot, Gemini and NotebookLM, all without typing a single prompt. The execution load was distributed across multiple providers, keeping you well under the rate limits of any single service.

**Video guide:** Setup videos are linked on the project page.


## Features

### CLI-BAN Routing Board

The CLI-BAN is the central pipeline control surface. Each column represents an agent role, and each card is a plan. Think of it less as a project management board and more as a stateless execution trigger — plans enter, get routed to the right agent, and exit as completed work.

- **Drag-and-drop** individual cards, multi-select cards, or use buttons to advance all cards to the next stage
- **Complexity-based auto-routing** — when you advance plans, the plugin reads the complexity classification and routes high-complexity tasks to your Lead Coder (e.g. Opus) and low-complexity tasks to your standard Coder (e.g. GPT, Flash)
- **Custom agents** — Switchboard ships with 5 built-in agent roles, but you can add your own roles to the CLI-BAN and customize their automated prompts via the setup menu

### Persistent state tracking

Because the CLI-BAN stores all plan state locally in SQLite, it enables asynchronous, multi-day workflows. You can plan on Monday, execute on Tuesday, and review on Wednesday — without losing context or being forced to keep a chat session alive.

Standard "vibe coding" — the plan-code-plan-code loop in a single IDE chat — forces you to burn through your daily quotas linearly. If you hit your Windsurf limit mid-feature, your work stops until tomorrow. Your context is trapped in an ephemeral chat window, and you're held hostage by API reset timers.

Switchboard decouples planning from execution, acting like a true Agile development team. Spend your entire Day 1 Windsurf Opus quota doing deep architectural planning and storing those blueprints in the CLI-BAN. Then walk away. On Day 2, when quotas reset, or using a fleet of cheaper background agents, you execute the sprint.

### Pair Programming Mode

Press the **Pair Programming** switch and when you drag a plan card into the Lead Coder column, Switchboard will split it and send the low-complexity tasks in that plan to the Coder column as well. Once the Coder completes the tasks, the Lead Coder will review. This can reduce your Opus usage by as much as 50% by offloading easy work to a cheap coder like Gemini Flash instead of asking Opus to handle boilerplate.
Alternatively, press the 'Pair Programming' button on a plan card to copy the complex work to your clipboard to paste into Windsurf or Antigravity, and automatically send the simple work to the Coder agent. This achieves the same effect, saving as much as 50% of yout IDE agent quota. 

### Task Batching

Select multiple cards in the CLI-BAN to send them as a batch to an agent. This saves quota because every time you send a prompt, you're also sending hidden system instructions and asking the agent to spin up research tasks. Batching means the agent only does this once. All task batches include an instruction for the agent to use its native subagents if available, so that you still get focused attention on each task. 

### AUTOBAN Automation

Press the **START AUTOBAN** button at the top of the CLI-BAN to start processing plans through stages on an automated timer. This automation uses no API keys, and does not waste quota on 'orchestrator' agents. Instead, Switchboard spins up multiple terminals per role, with each terminal running a separate CLI agent, and rotates plans gatling-style. Every few minutes a plan is sent to an agent, and by the time the rotation completes, the first terminal is free for a new plan. Each CLI is also instructed to use its own native subagent features, so at full speed you have multiple terminals each running their own subagents to chew through a large backlog.

Because each CLI terminal is only being triggered every few fminutes, this automation does not trigger any provider rate throttling. 


### Plan Review Comments

Highlight text within a plan to send a targeted comment to the Planner agent referencing that exact text, enabling precise planning improvement conversations. A great use of this is to run Claude Code Sonnet in the Planner terminal — after Copilot/Windsurf Opus writes the initial plans, ask Sonnet questions about them without spending Copilot quota.

### Google Jules Integration

If you're running low on quota and have a Google Pro subscription, press a button in the CLI-BAN to start sending tasks to Jules, which gives you 100 free Gemini requests per day. This works well for low-priority backlog items.

### Cross-IDE Workflows

Plan with Antigravity and Gemini CLI, then move the plan to Windsurf running Opus to implement or review. In the CLI-BAN or sidebar, click **COPY** to copy the plan link to your clipboard, then paste it into your other IDE's chat along with an automatically generated implementation prompt.


## Personality & Aesthetic

Switchboard has a distinct flavor. The UI is a minimalist, diegetic **sci-fi command center** — pipeline control surfaces, routing boards, and system status panels designed to feel like you're operating a starship engineering console, not a project management tool.

More importantly, the built-in **Reviewer** agent ships with a **"Grumpy Principal Engineer"** persona. This isn't a gimmick — it's a practical solution to a real problem. When you're reviewing large batches of automated code output, dry AI-generated reviews blur together into an unreadable wall of polite suggestions. The Grumpy Engineer persona enforces strict code accuracy while making the output genuinely engaging and highly readable. Every review reads like feedback from a battle-scarred staff engineer who has seen your exact mistake deployed to production before — pointed, memorable, and impossible to skim past. It turns the most tedious part of the pipeline (reading 11 code reviews in a row) into something you actually want to read.


## NotebookLM Airlock

The Airlock feature bridges your IDE and Google's NotebookLM, giving you quota-free sprint planning. NotebookLM gives Google Pro subscribers unlimited Gemini Pro use in a sandboxed environment — excellent for planning without burning IDE quotas.

For example, if you use Antigravity Gemini Pro for planning, you exhaust your weekly Pro quota in about 10 plans. With Airlock, you use **0 quota** on 10 plans.

1. Open the **Airlock** tab and click **Bundle Code** — creates docx bundles of your repo in `.switchboard/airlock/`, plus a manifest and a "How to Plan" skill
2. Open NotebookLM, create a new notebook, upload the entire airlock folder as sources
3. Ask NotebookLM to "follow the How to Plan guide and generate plans for every task in the New column"
4. Copy the output, then use the **Import from Clipboard** button at the top of the CLI-BAN — Switchboard saves each plan into your database
5. Use the CLI-BAN to assign to agents as normal

The `manifest.md` file included in the Airlock folder maps your repo: file locations across bundles, file sizes, and any introductory comments at the top of each file. 

## IDE Chat Workflows

Use these within the Antigravity or Windsurf chat to replicate sidebar or CLI-BAN actions. *The buttons and CLI-BAN are generally faster since they are programmatically controlled.*

| Command | What it does |
| :--- | :--- |
| `/chat` | Ideation mode — discuss requirements before any plan is written. |
| `/improve-plan` | Deep planning, dependency checks, and adversarial review in one pass. |
| `/challenge` | Internal adversarial review pass (advisory-only, no CLI-BAN auto-move). |
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

* **VS Code Extension:** Manages terminals, sidebar UI, CLI-BAN Routing Board, plan watcher, and inbox watcher.
* **Bundled MCP Server:** Exposes tools to agents (`send_message`, `check_inbox`, `get_kanban_state`, `start_workflow`, `run_in_terminal`, etc.).
* **SQLite Database:** Stores plans, routing state, and complexity classifications locally.
* **File Protocol:** All coordination happens via `.switchboard/` in your workspace — transparent, auditable, and entirely local.

## Privacy & License
No telemetry. No external servers. All coordination data is workspace-local. Open source — MIT License.

[GitHub](https://github.com/TentacleOpera/switchboard/) · [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=TentacleOpera.switchboard)
