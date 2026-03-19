Switchboard release - combine any AI subscription into automated pipelines, double the value of each subscription

I just shipped to the VS Code Marketplace the release version of Switchboard. This is a VS Code plugin that batches tasks in a way that doubles the value of your subscriptions and allows you to build automated pipelines by combining any subscription you have. CLI agents like Copilot and Claude Code, IDE chat agents like Windsurf and Antigravity, and local LLMs can all work together.

Switchboard uses NO authentication hacks and NO API keys, just the official VS Code API terminal.Sendtext and a local SQlite database running in your repo. 

To explain, here is what the screenshot is showing - combining Windsurf, Copilot CLI and Gemini CLI into the one workflow:

1. I created 11 plans in the Kanban board New column by pressing the 'create plan' button
2. I asked Windsurf Opus to 'run the improve plan workflow on all plans in the New Kanban column'
3. Opus used the mcp tool get_kanban_state to find the 11 plans, and then added high detail to all of them, in a single turn for the cost of 1 Windsurf Opus use, as well as recommending which agents should action each plan
4. The plugin regex parsed the plans and added Opus' complexity recommendations to the database
5. I pressed the 'advance all plans' button  at the top of the Kanban. The plugin auto-routed the high complexity tasks to Opus in Copilot, and the low complexity tasks to GPT 5.4 running in a separate Copilot terminal, using terminal.Sendtext to send automated instructions to each terminal.
6. Each terminal was auto-instructed to process all plans in a single turn using their native subagents, so that GPT 5.4 implemented all 9 low complexity plans for the price of 1 credit, and Opus implemented both high complexity plans for the price of 3 credits. 
7. When all tasks were finished, I pressed the 'advance all plans' button in the coder and lead coder kanban columns to send a request to Gemini CLI to engage its native subagents to compare the 11 implementations against the plans 

**Results:** 11 tasks were fully planned, implemented and reviewed for the cost of 1 Windsurf Opus and 4 Copilot credits - $0.39 real dollar cost. Conversely, if I had just done this by prompting Copilot Opus one by one, it would have cost $0.99 plus have been much slower due to not engaging subagents.

OPEN SOURCE

This has been in beta for a couple weeks, with about a 100 Github stars so far:

I'm really grateful to the Antigraity community for testing it and suggesting improvements, most of which I've tried to incorporate. 

You can download it directly thorugh the VS Code marketplace in any VS Code fork IDE, if it looks useful to you. 

Setup guide videos are linked on the project readme. 

FEATURES 

**Cross-subscription automation, letting you combine any subscription into a dev pipeline**

You save the terminal setup commands (like copilot --allow-all-tools) into the Switchboard setup panel, then you click 'Open Terminals' and it spawns the terminals with those commands. Because they're running in a VS Code fork, VS Code handles all authentication for you using the normal VS Code methods. The plugin then saves the terminal PID to allow it to send automated messages. 

The SQlite plans database then ingests plans from any location you specify (e.g. custom plans folder, Antigravity brain), and provides tools for any AI to access the plans.

**Task batching to increase the value of per-prompt pricing of Copilot and Windsurf** 

If you don't run right up against the prompt limits of these two subscriptions you're leaving money on the table. Why spend 1 credit per plan when you can spend 1 credit per 2, 3, 4 or 9 plans?

**API-less AUTOBAN automation**

You don't enter any API key, and you don't ask agents to waste tokens on spawning their own automation processes. 

Instead, it works by spinning up extra terminals per role (e.g. 5 x lead coder with Copilot running in each) and rotating plans gatling-style, so that every 3 minutes a plan is sent to an agent, and after 15 minutes the first terminal is clear to receive a new plan. THe prompts include an instruction for each CLI to use their own subagent features as well, so at full automation speed you can have multiple terminals with each terminal running its own subagents to process a large backlog. 

**Kanban board where you drag and drop cards to trigger CLI agents**

You can do individual drag and drop, multi-select drag and drop, or use buttons to advance all cards to the next stage. 

**Add your own custom agents**

Switchboard starts with 5 hardcoded agent roles, but you can add your own roles to the Kanban and customize their automated prompts. 

**Plan review comments**

 Highlight text in a plan to send a comment to the Planner agent referencing that exact text so you can have more precise planning improvement conversations. I stole this feature from Antigravity since a few users noted it was the best part of that IDE. 

 A really good use of this is to have Claude Code Sonnet running in the Planner terminal, and after Copilot/Windsurf Opus writes the initial plans, ask Sonnet questions about them, since it won't cost Copilot credits then. 

**Airlock gives quota-free sprint planning**

This bundles your repo up into docx files along with a how to plan guide and kanban state doc. You can then upload the bundle to NotebookLM and ask it to "Follow the how to plan guide and generate high quality plans for every task in the New Kanban column". The Top of the Kanban board then has an 'import from clipboard' button which automatically saves each NotebookLM plan into your database. This is not worth it if you plan one by one, but will save significant time and tokens if you run this on a backlog of 10-20 tasks at once. 

For example, if you use Antigravity Gemini Pro for planning, you exhaust your weekly quota on the pro subscription in about 10 plans. With Airlock, you use 0 quota on 10 plans, since NotebookLM gives unlimited Gemini Pro use for subscribers. 

**Google Jules integration**

If you're running low on quota and have a Google Pro sub, you can press a button in the Kanban board to start sending your tasks to Jules, which give you 100 free Gemini requests a day. This works perfectly fine for low priority backlog items. 

**Make Antigravity Great Again**

Antigravity has recently been hit with some uh... unfathomably harsh usage limits. Switchboard offers a way around this, by giving a seamless interface for combining Notebook, Jules and GeminiCLI in the one workflow, as well as reducing reliance on Antigravity Opus quota by increasing the value of Windsurf and Copilot Opus. You can also use Flash in Antigravity more reliably since when using Switchboard, you're asking Opus in Copilot or Windsurf to determine which tasks Flash can actually handle, instead of guessing yourself. 
