Switchboard: I built a drag and drop AI orchestration tool because I was sick of hitting rate limits, and I wanted to code one-handed
What's happening here: Dragged three cards to the Lead Coder column, which triggered an automatic prompt to Copilot to use subagents to complete each plan. Meanwhile, another button generated a code review prompt for Windsurf Opus and auto-moved those plans to the Reviewed column.

Switchboard is a different approach to AI orchestration. A visual kanban auto-triggers agents via drag and drop, no prompts required. This allows you to run entire agent teams while drinking a beer, since you only need one hand to code with Switchboard.

It does this programmatically using the VS Code API, so unlike other orchestration frameworks, you don't need an actual orchestration agent. Nor do you need API keys, complex setup, or anything else. You just start your CLI subscriptions in terminals and start dragging cards around to trigger them, automatically sending them prompts you defined beforehand.


Switchboard also works with chat-based agents like Windsurf, Antigravity and Cursor. You can switch the board between trigger mode, which auto-sends prompts to terminals, and paste mode, which auto-copies prompts to your clipboard. That way you can combine the strengths of different subscriptions. For example, create 10 plans and tell the free Kimi 2.5 in Windsurf to gather context. Then shove them all into Claude Code to plan. Then punt them into GitHub Copilot as a single prompt to take advantage of its native subagents, before asking Windsurf Opus to review the work.
What else it does:

Batch and parallelise — send entire columns of plans to agents in one prompt with instructions to spawn subagents. Save tokens by reducing system prompt overhead and increase coding speed
Assign by complexity — put an Opus subscription in the Planner slot and it will organise which tasks can be sent to cheap agents based on a complexity threshold you set, so you can eke all possible value out of cheap agents
Increase Opus quota — Switchboard's pair programming mode splits work between subscriptions. Opus in Windsurf working with Gemini CLI estimated token savings of 35% by offloading low complexity work to Gemini
Amplify other tools — put Claude Code, OpenCode, Copilot Squads, or anything else into the kanban to route between them
No repo pollution — kanban state, routing rules and archived plans live in a database you can place outside your repo, so you can share across machines without random files appearing in every commit


Install from any VS Code marketplace. Full details in the readme: [link]