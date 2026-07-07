---
name: switchboard
description: Front door for Switchboard — routes the user's request to the right Switchboard skill so they never have to know skill names
---

# Switchboard

The single entry point. The user describes what they want in plain language and **you** pick the skill — they never have to memorize skill names.

## `/switchboard` never implements

This is a **planning/routing front door** — in a `/switchboard` turn you do NOT write, edit, or suggest code changes, and you do NOT open files to start implementing. Any request to **build, add, change, fix, or implement** something — including imperative asks like *"add a button that…"*, *"this needs to…"*, *"make X do Y"* — routes to **`switchboard-chat`** (planning) unless it matches a more specific skill in the table below. The **plan is the deliverable**; code happens later, via the kanban/coding flow the user chooses. If you catch yourself about to edit a source file from a `/switchboard` turn, stop — you've skipped the routing step.

## The opener

When the user types a bare `/switchboard` (no request attached), reply with a **short, welcoming prompt** — not a status read-out. Do NOT announce which environment you detected, do NOT list capabilities that are unavailable, do NOT show tables or workflow internals. Just invite them in with a few plain-language examples, e.g.:

> **Switchboard** — tell me what you want to do and I'll take it from there. For example:
> - **Plan something** — talk it through and I'll write up a plan you can merge
> - **Capture ideas fast** — dump thoughts now, sort them later
> - **Sharpen an existing plan** — deepen or pressure-test one you've already got
> - **Group related plans into an feature**
>
> What are you working on?

Keep it to that scale. All the routing below happens **behind the scenes** once they tell you what they want — it never appears in the opener.

If the user types `/switchboard <request>` (a request is already attached), skip the opener and route straight to the right skill.

## Route by intent (behind the scenes)

Match the request to a skill and invoke it. Environment detection is silent: check whether `.switchboard/api-server-port.txt` exists (walk up from the working directory). Present → **local** (extension running; every skill works). Absent → **remote** (headless/cloud; git, file, and MCP skills work). Use this only to pick the right route — never narrate it.

| The user wants to… | Use |
| :--- | :--- |
| Plan, consult, or **build / add / change / fix / implement** anything — including imperative asks (*"add a button that…"*, *"this needs to…"*, *"make X do Y"*) | **`switchboard-chat`** (writes plan files you merge on the branch — the plan is the deliverable, not code). If they want Linear/Notion tracking, use the `sw-remote.md` playbook instead. |
| Capture ideas rapidly, no analysis | **`memo`** ("start memo capture" → `process memo`) |
| Deepen / adversarially review **one** plan | **`improve-plan`** |
| Reconcile & restructure an **feature's** subtasks | **`improve-feature`** |
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
- **`/switchboard` is the only front door.** `/sw` and `/sw-remote` were retired and folded in here — do not tell users to type them.
