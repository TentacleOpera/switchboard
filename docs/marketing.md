Switchboard: no-setup drag and drop agent teams, also extends Opus quota by 30%

What's happening here: Using the pair programming mode, Windsurf Opus reported token savings of 35% (and a 50% speed increase) by offloading routine coding to Gemini CLI. Meanwhile, Gemini CLI deployed subagents to code 5 low-complexity plans in parallel. This was all done by moving plan cards on the kanban.

Switchboard is a different approach to AI orchestration. A visual kanban auto-triggers agents via drag and drop, no prompts required. This allows you to run entire agent teams while drinking a beer, since you only need one hand to code with Switchboard.

There's nothing to install beyond the extension itself. If you already have your agents open, you're ready. No gateway, no runtime, no API keys, no config files. Just drag a card.

It does this programmatically using the VS Code API, so unlike other orchestration frameworks, you don't need an orchestration agent. You just start your CLI subscriptions in terminals. Whenever you move a card into a column, Switchboard uses VS Code's terminal.Sendtext to send a pre-configured prompt referencing that task to the agent registered in that column. 

Switchboard also works with chat-based agents like Windsurf, Antigravity and Cursor. You can switch the board between trigger mode, which auto-sends prompts to terminals, and paste mode, which auto-copies prompts to your clipboard. That way you can combine the strengths of different subscriptions. For example, create 10 plans and tell the free Kimi 2.5 in Windsurf to gather context. Then shove them all into Claude Code to plan. Then punt them into GitHub Copilot as a single prompt to take advantage of its native subagents, before asking Windsurf Opus to review the work.

This means you don't blow Claude Code quota on context gathering and you get 10 plans implemented for the price of 1 by taking advantage of Copilot's per-prompt pricing. Using a fresh model for review catches issues the coder would never flag about its own work.

What else it does:

* Assign by complexity: put an Opus subscription in the Planner slot and it will organise which tasks can be sent to cheap agents based on a complexity threshold you set, so you can eke all possible value out of cheap agents
* Batch and parallelise: send entire columns of plans to agents in one prompt with instructions to spawn subagents. Save tokens by reducing system prompt overhead and increase coding speed
* Amplify other tools: put Claude Code, OpenCode, Copilot Squads, or anything else into the kanban to route between them
* No repo pollution: kanban state, routing rules and archived plans live in a database you can place outside your repo, so you can share across machines without random files appearing in every commit
* NotebookLM integration: access unlimited Gemini Pro for planning by converting your code into Notebook-compatible files, then quickly import plans into Switchboard with a single 'copy plan from clipboard' button


Install from any VS Code marketplace. Full details in the readme: [link]