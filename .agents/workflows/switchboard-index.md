---
description: Front door for Switchboard — routes the user's request to the right Switchboard skill so they never have to know skill names
---

# Switchboard

The single entry point. The user describes what they want in plain language and **you** pick the skill — they never have to memorize skill names.

## The opener

When the user types a bare `/switchboard` (no request attached), reply with a **short, welcoming prompt** — not a status read-out. Do NOT announce which environment you detected, do NOT list capabilities that are unavailable, do NOT show tables or workflow internals. Just invite them in with a few plain-language examples, e.g.:

> **Switchboard** — tell me what you want to do and I'll take it from there. For example:
> - **Plan something** — talk it through and I'll write up a plan you can merge
> - **Capture ideas fast** — dump thoughts now, sort them later
> - **Sharpen an existing plan** — deepen or pressure-test one you've already got
> - **Group related plans into a feature**
>
> What are you working on?

Keep it to that scale. All the routing below happens **behind the scenes** once they tell you what they want — it never appears in the opener.

If the user types `/switchboard <request>` (a request is already attached), skip the opener and route straight to the right skill.

## Route by intent (behind the scenes)

Match the request to a skill and invoke it. Environment detection is silent and 3-way — it picks the route, never narrates which environment was detected:

| Environment | Signal | Behavior |
| :--- | :--- | :--- |
| **Local** (IDE / Antigravity desktop app) | `.switchboard/api-server-port.txt` present **and** the LocalApiServer answers a live health check (`curl -s http://127.0.0.1:$PORT/health`) | **Management console** hub — board-driving, can launch a planning/chat session on request. Routed on board-driving intent (see below). |
| **Cloud remote** (Claude/Codex remote VM) | Shell available, `.switchboard/` present in the repo, **no** reachable server | **Plan-mode brake** — stop, plan, do not code until a plan is approved. |
| **Claude Cowork** | Handled by the separate `switchboard-cowork` skill (exported from the Setup panel) — not this detection path | Routes through the bundled MCP transport. |

**Health-check, not just file-presence.** A stale port file (extension crashed/closed) must not misdetect local. Probe the port file **and** hit `/health` with a short timeout. On file-present-but-unreachable, fall through to the cloud/plan-mode branch — the documented safe default (planning, not destructive board action). State the detected mode in one line only if the user asks or a route decision needs explaining; never announce it unprompted.

**Bare `/switchboard` (no request attached) always shows the friendly opener above** — never a status read-out, regardless of environment. The local→console route fires only once the user expresses board-driving intent (either `/switchboard <request>` with a board action, or a follow-up in the opened session). Only then does the management console's Entry Protocol read-out appear.

### Local branch (board-driving intent)

Route to the **`switchboard-manage`** skill body (read `.claude/skills/switchboard-manage/SKILL.md` or the `.agents/skills/switchboard-manage/SKILL.md` source) — the management-console persona. It drives the board over the localhost HTTP API and can launch a planning/chat session on request (absorbing the old `switchboard-chat` consultative-planning persona as a sub-action: "start a planning session" inside the console).

### Cloud branch (plan-mode brake)

Route to the **plan-brake behavior** — the consultative planning persona (the old `switchboard-chat` body, read `.agents/workflows/switchboard-chat.md`). Explicitly withhold all code changes until a plan is written and the user explicitly approves implementation. This is the highest-value job in a cloud VM: stop the agent from spinning up a branch and coding immediately when the user only wanted to plan.

### Intent → skill table

| The user wants to… | Use |
| :--- | :--- |
| Plan / consult on what to build | Local → **`switchboard-manage`** console's planning sub-action; Cloud → plan-brake persona (`switchboard-chat` body). If they want Linear/Notion tracking, use the `sw-remote.md` playbook instead. |
| Capture ideas rapidly, no analysis | **`memo`** ("start memo capture" → `process memo`) |
| Deepen / adversarially review **one** plan | **`improve-plan`** |
| Reconcile & restructure a **feature's** subtasks | **`improve-feature`** |
| Split **one plan** into Complex/Risky + Routine tiers | **`switchboard-split`** |
| Tier a whole **feature** by complexity (high/low) | **`improve-feature`** high/low mode |
| Create a new feature | **`create-feature`** |
| Improve a plan stored in **Linear** | **`improve-remote-plan`** |
| Reply to a Notion/Linear **remote-control** card | **`notion-api`** / **`linear-api`** |
| Move a kanban card | **`kanban-operations`** locally; remotely via Notion/Linear MCP (the file-based git control plane is retired) |
| Query board state | **`query-switchboard-kanban`** locally; remotely read the git-exported `kanban-board.md` |
| ClickUp tasks/docs | **`clickup-*`** family |
| Score a change's complexity | **`complexity-scoring`** |
| Research a topic with sources | **`web-research`** |
| Search old plans / conversations | **`archive`** / **`query-archive`** |

## How to respond

- **You do the routing.** Match the request, then invoke the skill (its slash command, or read `.claude/skills/<name>/SKILL.md`) — don't reimplement it. Name the skill in a line at most; keep the focus on doing the work, not describing the machinery.
- **Chain when natural**, e.g. planning → `create-feature` → `improve-feature`.
- **Surface a gap only when a request actually hits one.** A few skills need the running extension (`clickup-*`, `improve-remote-plan`, live `kanban.db`/DuckDB reads). In a remote session, don't preemptively warn about them — only if the user asks for one, say the direct route needs the extension and offer the remote equivalent (plan work → plain plan-file edits with `**Feature:**`/`**Project:**` frontmatter; board moves → Notion/Linear MCP).
- **Only ask a question if genuinely ambiguous**, and then just one; otherwise pick the best fit and proceed.
- **`/switchboard` + `/memo` are the only front doors.** `/sw` and `/sw-remote` were retired and folded into this router — do not tell users to type them. `switchboard-chat` and `switchboard-manage` are now internal skills this router loads — not separate commands the user needs to know. The workflow verbs (`improve-plan`, `improve-feature`, `switchboard-split`) remain typeable for power users but are not advertised as front doors.
