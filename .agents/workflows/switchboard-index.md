---
description: Front door for Switchboard — detects the environment and routes the user's request to the right Switchboard skill so they never have to know skill names
---

# Switchboard

The single entry point. When the user types `/switchboard` (or asks "what can Switchboard do here" / doesn't know which skill they need), use this index: **detect the environment, then route their request to the right skill yourself.** The user describes what they want in plain language — you pick the skill. Do not make them memorize skill names.

## 1. Detect the environment (do this first)

Check whether `.switchboard/api-server-port.txt` exists (walk up from the working directory).

- **Present → LOCAL.** The VS Code extension and its LocalApiServer are running. Every skill below works, including the LocalApiServer-proxy ones.
- **Absent → REMOTE** (headless / cloud session, like Claude Code on the web). Only git / file / MCP skills work. The LocalApiServer-proxy skills are **not reachable** — do not invoke them; offer the git/file alternative instead.

State which mode you detected in one line, then route.

## 2. Route by intent

| The user wants to… | Use | Remote-safe? |
| :--- | :--- | :--- |
| Plan / consult on what to build | LOCAL → **`switchboard-chat`**. REMOTE → read `.agents/workflows/sw-remote.md` and follow it (the Linear/Notion planning playbook). | ✅ |
| Capture ideas rapidly, no analysis | **`memo`** ("start memo capture" → `process memo`) | ✅ |
| Deepen / adversarially review **one** plan | **`improve-plan`** | ✅ (edits the plan file) |
| Reconcile & restructure an **epic's** subtasks (merge/delete/rewrite/split) | **`improve-epic`** | ✅ (`git rm` + manifest) |
| Create a new epic | **`create-epic`** | ✅ (writes the epic file) |
| Improve a plan stored in **Linear** | **`improve-remote-plan`** | ⚠️ needs LocalApiServer |
| Reply to a Notion/Linear **remote-control** card | **`notion-api`** / **`linear-api`** | ⚠️ needs LocalApiServer |
| Move a kanban card / query board state | **`kanban-operations`** / **`query-switchboard-kanban`** | ⚠️ local (kanban.db) |
| ClickUp tasks/docs | **`clickup-*`** family | ⚠️ needs LocalApiServer |
| Score a change's complexity | **`complexity-scoring`** | ✅ |
| Research a topic with sources | **`web-research`** / **`deep-research`** | ✅ |
| Search old plans / conversations | **`archive`** / **`query-archive`** | ⚠️ local (DuckDB) |

If a request maps to a ⚠️ skill but you are REMOTE, say the direct route needs the running extension and offer the remote equivalent (e.g. plan work → `improve-remote-plan` or plain plan-file edits; board moves → a `manifest.json` column change; epic changes → `improve-epic`'s `git rm` + manifest path).

## 3. How to respond

- **You do the routing.** Match the user's plain-language request to the table, name the skill you're using in one line, then invoke it (its slash command, or read `.claude/skills/<name>/SKILL.md`) — don't reimplement it.
- **Chain when natural**, e.g. remote planning (`sw-remote.md` playbook) → `create-epic` → `improve-epic`.
- **`/switchboard` is the only front door.** `/sw` and `/sw-remote` were retired and folded into this router — do not tell users to type them.
- **Only ask a question if genuinely ambiguous**, and then just one; otherwise pick the best fit and proceed.
- **Remote gaps are honest gaps.** A few local-only capabilities (the splitter agent, `high-low` epic consolidation) have no remote skill yet — if the user asks for one remotely, say so rather than pretending.
