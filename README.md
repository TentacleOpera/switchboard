# Switchboard

**The subscription-based alternative to API frameworks like OpenCode. Coordinate all your AI subscriptions, local LLMs, and CLI agents into a single team without a single API key.**

Switchboard adds a **sidebar panel and Kanban view** where you create, manage, and dispatch plans to AI agents. It bridges IDE-based agents (Antigravity, Windsurf, Copilot Chat) and CLI agents (Copilot CLI, Qwen, Codex, Gemini CLI) so they can collaborate on the same plans inside your repo. 

Instead of paying for expensive all-in-one API tiers, you get dramatically more AI usage by load-balancing your existing consumer subscriptions (e.g., Google Pro, Copilot, Codex) from the Kanban.

![Switchboard](https://raw.githubusercontent.com/TentacleOpera/switchboard/main/docs/switchboardui.png)


## How it Works

Switchboard uses the official Vs Code API (terminal.Sendtext) to send automated messages between terminals in which your CLI agents are registered. For example, say you have Antigravity, Claude Code and Codex. To use these together with Switchboard:

1. Add the Claude Code and Codex startup commands (e.g. Codex --full-auto) to the Switchboard terminal setpup menu and press the 'Open Agent Terminals' button
2. Create a plan in the Antigravity agent chat. Switchboard then auto-syncs the plan to the .switchboard/plans folder so the other agents can see it
3. Open the 'CLI-Ban' Kanban view via the sidebar, and drag the plan to the column which represents your Claude Code terminal. Switchboard sends a message to the terminal telling Claude to start coding
4. When Claude has finished, drag the plan task to the column which represents your Codex terminal. Switchboard sends a message to the Codex terminal to review the code implementation against the plan

**The result:** By combining three different subscriptions, you spread usage, making each last longer. Additionally, by reviewing your code with a different model, you also increase coding accuracy, and ensure that models do not make unauthorized changes.

**Automation:** The Kanban also allows for automation of batch tasks. For example, add 10 different feature ideas as 'post-it note' plans. Then click **MOVE ALL** to send them to the Planner Agent in sequence on a 5 minute delay between plans to improve. Come back in an hour, and do the same to send them all to the Lead Coder on a 10 minute delay between plans. 

**Video guide:** Watch a video guide to Switchboard on Loom

### Token Arbitrage

Another very effective use of Switchboard is to achieve token arbitrage by exploiting the per-prompt pricing structures of Copilot and Windsurf. These subscriptions allow you to pay per prompt, with no upper limit to the work done. Therefore, use Antigravity, Gemini CLI or Claude Code to make a highly detailed plan, then use the Kanban to send it to Copilot or Windsurf Opus to implement in one prompt. This is the recommended way to use Switchboard since it is extremely economical. $10 buys you 100 Claude Opus prompts in Copilot, which means 100 substantial features after you have planned them out.


### Trust, Account Safety & The ToS

Due to recent ToS bans hitting proxy services like OpenCode, Switchboard was built to be completely local. **There are no proxy servers, no external API keys, and no ToS violations.**

The coordination layer is strictly file-based. Switchboard uses the official VS Code `terminal.sendText` API to automate the agents running in your own terminals, under your own standard authentication. It happens entirely on your machine. [Read the architectural analysis here.](docs/ToS_COMPLIANCE.md)

Switchboard is open source: [Switchboard](https://github.com/TentacleOpera/switchboard/)

## Quick Start

1. Open the **Switchboard sidebar** (click the icon in the activity bar).
2. Click **Setup** → **Initialise**. This auto-configures the MCP for Antigravity, Windsurf, and VS Code-compatible IDEs in one click.
3. Enter your CLI startup commands in Setup (e.g., `copilot --allow-all-tools`, `qwen`, `codex --full-auto`), save, then click **Open Terminals** in the Terminal Operations panel.
4. Authenticate in each terminal and choose your models.
5. Draft a plan using `/chat` in your AI chat, refine it, or click **Create Plan**.
6. Use the sidebar **Send** buttons or click **Open CLI-BAN** and drag and drop tasks to dispatch the plan to your agents.


## NotebookLM Airlock

Switchboard also includes an 'Airlock' feature that bridges your IDE and Google's NotebookLM. NotebookLM allows (for Google Pro subscribers) unlimited use of Gemini Pro in a sandboxed environment. Therefore, it is excellent for making plans without wasting your IDE quotas. However, it ideally reads docx files, since it is optimised for document research. Therefore, to make use of this:

1. Open the 'Airlock' tab and click **Bundle Code** -> this creates docx bundles of your entire repo in the .switchboard/airlock folder, plus a manifest explaining your repo structure and a 'How to Plan' skill
2. Open NotebookLM, create a new notebook, and upload the entire contents of the airlock folder as sources
3. Ask NotebookLM to make a plan according to the How to Plan guide
4. Paste the plan back into the Switchboard airlock tab panel **->** Switchboard saves the plan as markdown inside the .switchboard/plans folder and syncs it to the Antigravity brain if using Antigravity
5. Use the CLI-BAN to assign to agents as normal

The 'manifest.md' file that is also created in the Airlock folder is a map of your repo. It includes the following information:
1. All the files, and where they are located in each bundle
2. The size of each file, so NotebookLM can identify the huge, important files from the simple helpers
3. Any introductory comments that appear at the top of each file

The Airlock panel includes an option to get your Analyst agent working on adding explanatory comments to the top of each file in your repo, so these will then be pulled into the manifest. This is a long running task that will take the Analyst some time to complete. 

### Why NotebookLM and not Gemini web or AI Studio?

NotebookLM is optimised for large research tasks, so reads all the source files fully, instead of truncating out the middle like other web AI tools are prone to do. The only issue is that NotebookLM will truncate out code blocks in markdown or txt files, hence why Switchboard uses docx to convert code into prose.  


## Cross-IDE workflows

Switchboard allows cross-IDE workflows, such as planning with Antigravity and Gemini CLI, then moving the plan across to Windsurf running Opus to implement or review. To do this, plan as normal, then in the CLI-BAN view or the Plan Select sidebar panel, click the **COPY** button. This copies the plan link to your clipboard. Paste this into your Windsurf chat, and type an instruction to work on the plan. 

## Automated Pipelines

The sidebar includes a panel for "dumb but effective" asynchronous team automation, removing the mental load of managing a backlog.

| Command | What it does |
| :--- | :--- |
| `Pipeline` | A state-tracking loop. Every 10 minutes, it picks an open plan and blindly passes it to the next agent in your chain (Planner → Coder → Reviewer). |
| `Auto Agent` | Sends the active plan to the Planner, Lead Coder, and Reviewer agents on a 7-minute timer between stages. |
| `Lead + Coder` | Reads your enhanced plan's complexity split (low, medium, or lazy). Routes the lazy/medium work to the standard Coder, and the rest to the Lead Coder. |
| `Coder + Reviewer` | Sends the plan to the Coder, and asks them to notify the Reviewer once done — lifts cheap coding quality without needing Opus 4.6. |

Additionally, the CLI-BAN has an automation option. Use the **MOVE ALL** button to send each task in a column to the next agent on a timer. For example, if you have created 10 plans, try using move all on a 5 minute timer to send them each to the Planner agent, 5 minutes apart. Then, come back in an hour and do the same thing to send them all to the Leader Coder, 10 minutes apart. 

## Agent Roles

Switchboard comes with suggested agent roles. Here are some recommendations for the agents to run in each terminaL

| Role | Recommended tool | Purpose |
| :--- | :--- | :--- |
| Lead Coder | Copilot CLI (Opus 4.6) | Large feature implementation |
| Coder | Qwen, Gemini Flash 3, Codex 5.3 Low | Boilerplate and routine work |
| Planner | Codex 5.3 High, Gemini 3.1 CLI | Plan hardening and edge cases |
| Reviewer | Codex 5.3 High | Bug finding and verification |
| Analyst | Qwen, Gemini Flash 3 | Research and investigation |

Additionally, Switchboard allows you to add custom terminals through the setup menu. For example, you may want to add a 'Frontend Coder' terminal, where you register Gemini and include in the automated prompt instructions to only work on the front-end aspects of a plan. 

## IDE Chat Workflows

Use these within the Antigravity chat to replicate the sidebar or CLI-BAN actions. *Note: The handoff workflows are secondary controls to the sidebar buttons. The buttons or CLI-BAN is generally faster and more effective, since they are programmatically controlled.*

| Command | What it does |
| :--- | :--- |
| `/chat` | Ideation mode — discuss requirements before any plan is written. |
| `/enhance` | Deepen and stress-test an existing plan. |
| `/challenge` | Adversarial review — a grumpy persona finds flaws, then synthesizes fixes. |
| `/handoff` | Route sanity-checking for micro-specs to a CLI agent; ends at spec decomposition. |
| `/handoff-lead` | Send everything to your Lead Coder agent in one shot. |
| `/handoff-chat` | Copy the plan to the clipboard for pasting into Windsurf or another IDE. |
| `/handoff-relay` | Current model does the complex work, then pauses for a model switch. |
| `/accuracy` | High-precision implementation mode with mandatory self-review gates. |

> Use `--all` with any handoff to skip complexity splitting and send the whole plan.

## Architecture

* **VS Code Extension:** Manages terminals, sidebar UI, plan watcher, and inbox watcher.
* **Bundled MCP Server:** Exposes tools to agents (`send_message`, `check_inbox`, `start_workflow`, `run_in_terminal`, etc.).
* **File Protocol:** All coordination happens via `.switchboard/` in your workspace — transparent, auditable, and entirely local.

## Privacy & License
No telemetry. No external servers. All coordination data is workspace-local. MIT License.
