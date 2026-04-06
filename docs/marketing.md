**Switchboard: no-setup drag and drop agent teams, also extends Opus quota by 35%**

What's happening here: Using Switchboard’s pair programming mode and dynamic complexity routing, Claude Code Opus offloaded routine coding to Antigravity Gemini Flash and reported token savings of 35% and a speed increase of 50%.

Switchboard is a different approach to AI teams. A visual kanban auto-triggers agents via drag and drop, no prompts required. This allows you to run cross-subscription agent teams while drinking a beer, since you only need one hand to code with Switchboard. 

The key difference between this and other kanban tools is that it triggers agents when you move a card. You're not updating kanban state after an agent works. Instead, you move a card to actually trigger the agent to start work.

**Key features**

1. Simple setup, no API keys: simply start your existing CLI agents in terminals and Switchboard maps them to columns
2. Works with anything: any CLI, local LLMs and even IDE chat agents in Windsurf, Antigravity and Cursor. Columns can be set to trigger mode, which sends prompts to terminals, and paste mode, which copies the prompts to clipboard for chat agents 
3. Dynamic complexity routing: a terminal running Copilot Opus gets complex work while GLM gets routine work, so you save quota by not asking Opus to do simple changes
4. Work batching: Drag and drop multiple plans at once to automatically trigger subagents from tools that have them
Customization: Comes with a preset agent team, but you can fully customize agent behaviour and automation rules to make Switchboard work with other frameworks 
5. Database state: Switchboard is powered by a structured database of plan metadata. This makes it easy to share state between developers, and trivially easy to keep Switchboard synced to JIRA/Clickup/whatever using their official MCP tools 


**Installation**

Switchboard works using the VS Code API so there's nothing to install beyond the extension itself.

Install free from any VS Code marketplace: [link]

Open source repo and readme: 

 
**Workflow example**

This is an example of a workflow I use all the time, combining Claude Code, Copilot and Windsurf.

1. Plan import: ask Gemini to draft 10 feature ideas. Press the ‘import from clipboard’ button and the single markdown block copied appears as 10 new markdown files in the kanban
2. Code mapping: press the code map button and it auto copies a research prompt to clipboard, asking to identify relevant code paths for all plans. I paste this into Windsurf running free Kimi 2.5, which attaches the research to the plans.
3. Batch plan: With Claude Code running in the Planner column, press the ‘advance All' button to move all 10 plans to Opus to plan in detail, using subagents to assign complexity scores and noting dependencies
4. Batch code: I have Copilot Opus in the Lead Coder role, Claude Code Sonnet as Coder and the Intern role is set to paste mode. I now press ‘Advance All' again.

Switchboard routes all 10 plans according to Opus' complexity scoring and dependency map. High complexity plans get batched to Copilot, medium go to Sonnet, low get copied to my clipboard. I paste those into free Windsurf Kimi.

5. Code review: I drag all plan cards to the reviewer column where Claude Code Sonnet is registered to check the implementation against the plan. Sonnet deploys subagents, writes findings to each plan and fixes critical issues

6. If manual testing fails, I select the offending plan(s) and press the ‘Report’ button. I enter a strongly worded complaint in all caps and press a button to send the plans back to the lead coder.

7. Clickup sync: At the end of a session I ask Windsurf to sync the Switchboard state with Clickup to maintain project management. Windsurf uses the Switchboard MCP to read the current Kanban state and then the official Clickup MCP to update tickets with the work states, code review findings and implementation details.

The last 3 steps means that it's super easy to stop work and pickup at any time. You don't need to do session management or ask an agent to regather context when you find a bug.
