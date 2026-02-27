# Switchboard

**The subscription-based alternative to API frameworks like OpenCode. Combine your existing AI subscriptions to get more premium model output for less — without a single API key.**

Switchboard adds a **sidebar panel to VS Code** where you create, manage, and dispatch plans to AI agents. It bridges IDE-based agents (Antigravity, Windsurf, Copilot Chat) and CLI agents (Copilot CLI, Qwen, Codex, Gemini CLI) so they can collaborate on the same plans inside your repo. Each agent uses its own subscription so you don't need to enter any API keys. You coordinate them from the sidebar.

![Switchboard](https://raw.githubusercontent.com/TentacleOpera/switchboard/main/icon.png)

## Why

Different AI subscriptions have wildly different pricing structures. Claude Opus is powerful but token-heavy. Copilot CLI charges per-prompt with no upper limit per session. Qwen, Codex, and Gemini Flash are cheap. By combining this you can dramatically optimise your token use. For example, plan a large feature with Antigravity. Then send it to Copilot Opus to one-shot using their per-prompt pricing. Then send it to Codex CLI for code review. 

Result: You achieve Opus-level results without thrashing Opus in one subscription. 

## Trust and Account Safety

The coordination layer is file-based and local — no API keys, no third-party servers, no ToS violations. You use your own subscriptions throughout. This makes it very different to OpenCode and other proxy services that have been banned by Google. Switchboard happens entirely on your machine, without touching anyone else's backend servers. [I asked Claude to analyse the architecture and confirm this.](docs/ToS_COMPLIANCE.md)

## What it does

- **Mirrors plans** from the Antigravity brain into your repo — CLI agents can't access the Antigravity brain folder directly, so Switchboard copies plans into your workspace where any terminal agent can read them (skipped automatically if not using Antigravity)
- **Sends plans to terminals** using the official VS Code `terminal.sendText` API
- **Coordinates agents automatically** by logging the current state of your active plans and assigning different terminals to work on them
- **Works across IDEs** — install in both Antigravity and Windsurf; they share the same plan files

## Quick start

1. Open the **Switchboard sidebar** (click the icon in the activity bar)
2. Click **Setup** → **Initialise** — this auto-configures the MCP for Antigravity, Windsurf, and VS Code-compatible IDEs in one click
3. Enter your CLI startup commands in Setup (e.g. `copilot chat`, `qwen`), save, then click **Open Terminals**
4. Authenticate in each terminal and choose your models
5. Draft a plan using `/chat` in your AI chat, refine with `/enhance` or `/challenge`, or click **Create Plan**
6. Use the sidebar **Send** buttons to dispatch the plan to your agents



## Agent roles

| Role | Recommended tool | Purpose |
|:-----|:-----------------|:--------|
| Lead Coder | Copilot CLI (Opus) | Large feature implementation |
| Coder | Qwen, Gemini Flash, Codex Low | Boilerplate and routine work |
| Planner | Codex High | Plan hardening and edge cases |
| Reviewer | Codex High | Bug finding and verification |
| Analyst | Qwen, Gemini | Research and investigation |


## IDE Chat Workflows

| Command | What it does |
|:--------|:------------|
| `/chat` | Ideation mode — discuss requirements before any plan is written |
| `/enhance` | Deepen and stress-test an existing plan |
| `/challenge` | Adversarial review — a grumpy persona finds flaws, then synthesizes fixes |
| `/handoff` | Route simple work to a CLI agent, keep complex work in the current session |
| `/handoff-lead` | Send everything to your Lead Coder agent in one shot |
| `/handoff-chat` | Copy the plan to clipboard for pasting into Windsurf or another IDE |
| `/handoff-relay` | Current model does the complex work, then pauses for a model switch |
| `/accuracy` | High-precision implementation mode with mandatory self-review gates |

Use `--all` with any handoff to skip complexity splitting and send the whole plan.

NOTE: the handoff workflows are secondary controls to the sidebar buttons. 

## Example workflow (Antigravity)

```
1. /chat in Antigravity Flash → get a rough plan
2. Switch to Sonnet → type /enhance → deepen the plan with edge cases
3. Type /challenge → adversarial review catches the gaps
4. Press 'Start Coding' in the sidebar → Copilot Opus implements the hardened plan for a few Copilot credits
```


## Team Automation

The sidebar includes a panel for team automation.

| Command | What it does |
|:--------|:------------|
| `Pipeline` | Every 10 minutes, the plugin scans the list of active plans and sends one to the next stage of Planner, Coder or Review depending on its log history |
| `Auto Agent` | Sends the active plan to the Planner, Lead Coder and Reviewer agents on a 7 minute timer between stages |
| `Lead + Coder` | Once you have made an enhanced plan with a complexity split, sends the high complexity work to the Lead Coder and the low complexity work to the Coder |
| `Coder + Reviewer` | Sends the plan to the Coder, and asks them to notify the Reviewer once done — lifts cheap coding quality without needing Opus |



## How it works

- **VS Code Extension**: Manages terminals, sidebar UI, plan watcher, and inbox watcher
- **Bundled MCP Server**: Exposes tools to agents (`send_message`, `check_inbox`, `start_workflow`, `run_in_terminal`, etc.)
- **File protocol**: All coordination happens via `.switchboard/` in your workspace — transparent, auditable, no lock-in

## Privacy

No telemetry. No external servers. All coordination data is workspace-local.


## License

MIT
