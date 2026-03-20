# Switchboard - combine multiple subscriptions to extend daily quotas, stay under rate limits and double the value of your subcriptions

Switchboard is a Windsurf-compatible extension (developed partly in Windsurf) that combines CLI agents (Copilot CLI, Claude Code, Gemini CLI, Codex), IDE chat agents (Windsurf, Antigravity), local LLMs and also(!) NotebookLM into a single pipeline. This received good engagement during beta, with over a hundred Github stars and full security vetting from testers. 

Switchboard uses a **CLI-BAN Routing Board** as the central pipeline control surface — create plans, drag-and-drop them to trigger CLI agents, batch entire sprints into single prompts, and auto-route work by complexity.

The pair programming mode can also increase chat-based quotas like Windsurf or Antigravity by as much as 50%. This offloads boilerplate work from Opus in Windsurf to Gemini CLI Flash or another cheap CLI of your choice. Windsurf Opus gets sent the complex part of the plan, Flash gets sent the simple parts of the plan, then Opus reviews Flash's work. 

Ultimately, Switchboard gives you the option of combining smaller subscriptions into a single workflow instead of having to spend $100+ for a Claude Max or Google Ultra subscription. With Google Pro ($20), Copilot Pro ($10) and Windsurf ($20) you can achieve similar results for half the cost. 

*By Grabthar's Hammer, what a savings.*

Switchboard achieves this with no authentication hacks, no API keys. Just the official VS Code API (`terminal.sendText`) and a local SQLite database running in your repo. Unlike other frameworks like OpenCode, you're not burning tokens on automation, and there's no danger of breaching ToS. 

## Example Workflow

Here's what a real session looks like — combining Windsurf, Copilot CLI, Gemini CLI and NotebookLM:

1. During setup, you enter your CLI Agent commands (e.g. copilot --allow-all-tools) into the setup menu. Switchboard will now start VS Code terminals with those commands and track their PIDs so it can send messages using the VS Code API terminal.sendText
2. Create 5 plans in the CLI-BAN **New** column using the **Create Plan** button, outlining the basic goals of each
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

## Installation and open source

You can install Switchboard from any VS Code marketplace. 

You can also check out the open source repo and vet it yourself for security issues: 

## Features

For a full feature list, see the project readme. 

* CLI-BAN Routing Board with drag and drop triggers for CLI agents, prompt buttons for IDE chat agents, complexity-based auto-routing and custom agent creation
* Persistent state tracking - plans are stored in a SqLite database with stage and complexity information, so you can plan a batch on Monday, wait for quotas to reset, then implement on Tuesday. This allows you to make the most of time-quota subscriptions. 
* Pair programming - combine different subscriptions, even IDE chat + CLI on a single task to reduce Opus use
* Task batching - combine multiple plans into one prompt to save quota by reducing the amount of hidden system instructions sent per plan
* **AUTOBAN** - timer-based automation that rotates plans through multiple CLI-BAN stages without wasting quota on orchestrator agents
* Plan review - highlight text in any plan and send the comments with a line reference to the Planner agent for precise plan improvements 
* NotebookLM Airlock - upload your repo to NotebookLM as docx files, then paste NotebookLM response as plans straight back into the database, allowing you to access unlimite Gemini Pro quota for planning and bug hunting. Works exactly like Githob Copilot Chat... except you don't pay any quota. 
* Theatrical agent personality - the 'Grumpy' principle engineer who is triggered by the Kanban Planning and Code Review columns is also triggered by half-baked plans and bad code
* Google Jules integration - if running low on quota and you have a Google Pro suscription, press a button in the CLI-BAN to start sending tasks to Jules, which gives you 100 free Gemini requests per day

