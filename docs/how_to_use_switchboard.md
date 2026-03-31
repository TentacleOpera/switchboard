# How to Use Switchboard — Best Practices to Save Quota, Improve Quality and Increase Speed

## 1. Write a PRD or design doc first
Switchboard has an Append Design Doc feature that attaches your overall vision to every planner prompt. This ensures every agent understands the big picture before touching a single plan.

If you use the Google Drive desktop app, you can link a doc that syncs from GDrive automatically — so your agents are always working from the latest version without you doing anything.

This also removes friction from your daily planning. Once your design doc is registered in Switchboard, you can write post-it note-length goals in the kanban and send them straight to the Planner to flesh out. No need to re-explain the project every session.

## 2. Batch tasks together
Switchboard instructs agents to use their native subagent features for batch work. This matters because most providers don't charge extra for subagent requests.

For example: if you send 10 plans to Copilot Opus in a single batch, Switchboard tells it to deploy 10 subagents — one per plan. You get the same cost and quality as working on a single plan, but for 10 tasks simultaneously. Unbatched, those same 10 plans would cost 10x as much in quota and take 10x as long.

Batch everything. There is no downside. Even without subagents, batching tasks means you only pay for the system prompt and context window once, rather than 10 times. 

## 3. Use Sonnet as the Lead Coder, Opus as the Planner

Opus is the most popular coding model, but Switchboard works best when Sonnet does the coding. Opus' real value is in the planning phase — identifying edge cases, structuring the approach, and producing the routing table. Using Opus again to write the code offers severely diminishing returns over Sonnet.

The most cost-effective balance for a batch of 10 plans:

1. Send the batch to Opus in the Planner slot — it details the plans and assigns complexity
2. Send the planned batch to Sonnet in the Lead Coder slot to implement
3. Send the coded batch to Sonnet or Opus in the Reviewer slot for a single review pass

This workflow costs approximately 7 Copilot credits for 10 plans. Sending each plan to Opus individually for coding costs 30 credits for the same output. That's a quota saving of 69% with better code quality from the adversarially review process.

## 4. Use pair programming mode with IDE agents
If you're using an IDE agent (Windsurf, Antigravity, or Cursor) as your coder, pair programming mode can extend your quota by up to 30% by offloading low-complexity work to a cheap CLI agent like Gemini CLI Flash or Qwen CLI.

To set it up:

1. Turn on Pair Programming at the top of the AUTOBAN
2. Make sure your plans have a complexity value set before sending them to the Coder column
3. Use the Copy Coding Prompt buttons — either on individual cards or in the column header — to copy a prompt to your clipboard

Switchboard automatically sends all low-complexity work to your cheap Coder CLI agent. The copied prompt references only the complex work, which you paste into your IDE agent. Your expensive IDE quota only touches the tasks that actually need it.

## 5. Spread work across IDE agents using unlimited models

Most premium IDE subscriptions include access to capable models on generous or unlimited quotas alongside their expensive flagship. These models are worth using deliberately rather than defaulting to the premium model for everything.

### Using unlimited models for investigation

Windsurf includes unlimited access to Kimi K2.5. When you hit a hard bug, rather than burning Opus credits on diagnosis, ask Kimi to walk through the relevant code step by step and append its findings directly to the plan. Opus then receives a pre-diagnosed problem with the groundwork already done — better input, lower cost, faster resolution. This effectively uses Windsurf to extend your Opus quota across other subscriptions.

### Running a mixed-model cycle within a single subscription

In Antigravity, rather than sending everything to Opus, run a plan-code-review cycle across models: Gemini plans, Sonnet improves the plan and later reviews the output, Gemini implements. This cycle produces comparable quality to a single Opus pass at significantly lower quota cost — Opus in Antigravity is expensive, and the one-shot approach burns through it fast. Switchboard's pair programming mode and complexity routing make this cycle easy to set up without manual prompt switching.