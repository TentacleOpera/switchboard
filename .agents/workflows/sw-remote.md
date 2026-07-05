---
description: Entry point for remote Switchboard planning sessions — orients Claude to use Linear/Notion MCP instead of local files
---

# Remote Switchboard Session Entry Point

You are entering a **remote Switchboard planning session**. The local machine and
VS Code extension are not running. Plans live in Linear or Notion — not in local
`.md` files. MCP (or the LocalApiServer proxy) is the control surface. Git is not
used for planning.

This is the remote counterpart to `/sw` (switchboard-chat). Use `/sw` when you have
local access; use `/sw-remote` when you don't.

## 1. Confirm Remote Context

Check which MCP servers are connected (Linear, Notion, GitHub):
- Report what's available and note any missing connections.
- If neither Linear nor Notion is connected, warn the user that remote planning won't
  be possible and offer to fall back to `/sw` if the user has local access.

## 2. Remote-Mode Rules

- Plans are stored in Linear/Notion — do NOT write `.md` files to
  `.switchboard/plans/` or commit to a branch for planning work.
- Use `list_issues` (Linear) / Notion database queries to read the current kanban
  state (not local `kanban.db` or `kanban-board.md`).
- To improve a plan: use `/improve-remote-plan` (not `/improve-plan`).
- To create a new plan: write directly to a new Linear issue or Notion page, set
  status to "Created".
- Column transitions happen via status updates in Linear/Notion — the extension
  picks them up on next IDE startup via the startup reconciler.
- To trigger local execution: set the Linear/Notion status to the execution-trigger
  state (confirm the name with `list_issue_statuses` first for Linear; read the
  `Kanban Column` select options for Notion).

## 3. Read Current Board State

- Query Linear/Notion for issues in the Switchboard-mapped project, grouped by status.
- Present a brief summary: how many plans per column, any plans in a state that
  suggests remote action is needed (e.g. "Created" plans that could be improved).

## 4. Prompt for Intent

After orientation, ask: "What would you like to work on?" — same consultative
opening as `/sw`.

## 5. Architecture Overview

- **Linear** is a two-way sync message bus: Switchboard polls Linear every 30–120s
  (configurable) and mirrors state changes locally.
- Moving a Linear issue to a new state → dispatches the Kanban column agent for that
  state on the local machine.
- Comments posted on a Linear issue → routed to the current column's agent as input.
- **Notion** equivalent: Switchboard polls the plans DB + Comments DB on a timer;
  `Kanban Column` property drives column mapping; "Switchboard Comments" database is
  the async message bus.
- Config is stored in the Kanban DB under key `remote.config`, not in `settings.json`;
  toggle is in the toolbar remote control button; configuration is in the Kanban
  REMOTE tab.

## 6. Pre-flight

- Remote Control must be enabled with the correct provider (Linear or Notion) and
  the board mapped in the Switchboard Remote tab.
- For Notion: the one-time "Run Notion setup sync" must have been run (creates the
  plans DB, Comments DB, and matches column options).
- For Linear: confirm the correct project is mapped.

## 7. Ground Every Plan in the Synced Project Context

You have **no repo access** — no GitHub, no git, no file system. What you DO have is
the **project-context mirror**: Switchboard syncs the workspace's curated planning
context — **Dev Docs + project PRDs + the workspace constitution** — outward to the
tracker. Read it **before authoring any plan**, so your plan names real modules,
files, and conventions instead of being a "post-it note" that sends the local
execution agent in the wrong direction.

**Where to find it:**
- **Notion:** a page titled **"Switchboard Project Context — \<workspace\>"**, created
  beside the plans database ("Switchboard Kanban Backup"). Find it with Notion MCP
  search.
- **Linear:** a document titled **"Switchboard Project Context"** on the project
  itself (project documents, not an issue body).

**How to use it:**
1. Read the constitution first (project principles and hard rules — plans must
   respect them).
2. Read the PRD of the project the card belongs to (WHAT the product requires).
3. Read the Dev Docs (HOW the codebase is put together — modules, seams,
   conventions).
4. Author the plan **citing concrete paths, symbols, and conventions from the Dev
   Docs**, so the local agent — which DOES have the repo — can navigate straight to
   the work.

**Rules and edge cases:**
- **Never edit the synced context on the tracker.** It is regenerated from
  Switchboard (project.html) on every sync — your edits will be silently overwritten.
  Author **plans** (cards), not doc edits. If the context is wrong, say so in a plan
  or comment so the human fixes it at the source.
- **Check staleness.** The context header carries its `Synced at` timestamp. If it
  looks stale, note that in your plan and tell the user they can push a fresh copy
  via **Remote tab → Sync Context Now** in Switchboard's Project panel.
- **No context found?** Context sync isn't enabled or has never run. Fall back to
  planning from the card text alone (the original behavior), state that limitation in
  the plan, and tell the user to enable **Project Context Sync** in the Remote tab.
- **Notion tier differences:** precise database property queries are tier-gated on some
  plans. If structured queries fail, fall back to `notion-search` / `notion-fetch` by title
  ("Switchboard Project Context"). Only navigation efficiency changes — the flow above stays
  the same.

## 8. Notion Steps (if Notion is the provider)

1. **Find the plans database.** Use Notion MCP search/query to locate the Switchboard
   plans database (titled "Switchboard Kanban Backup") and the "Switchboard Comments"
   database.

2. **Create or find the card's page.** Either edit an existing page (setup sync
   created one per board card) or create a brand-new page in the plans DB for new
   work — the next ping imports a new page as a new local markdown plan automatically.

3. **Write the implementation plan into the page BODY.** Author it fully *before*
   moving the card, **grounded in the synced project context** — cite the concrete
   paths, modules, and conventions the Dev Docs name. The local poll reads the page
   body and writes it to the local plan file — so the body is the source of truth the
   local agent runs against. Convention: **write the body completely, THEN flip the
   column** (a half-written body can be picked up if you flip too early). Note: an
   empty body is skipped (the poll won't overwrite a local plan with nothing), so
   always author the body when you intend to revise it.

4. **Trigger the local agent: set `Kanban Column`.** Read the board's real column
   names first (they are the select options). Set `Kanban Column` to the **trigger**
   column for the work you want (e.g. a planning column to refine, a coding column to
   implement). The poll mirrors the column locally and dispatches that column's agent.

5. **Converse without a state change: add a Comments-DB row.** To send an instruction
   or question without moving the card, create a row in the "Switchboard Comments"
   database:
   - `Message` = your text
   - `Plan` = relation to the card's page  ← **REQUIRED.** A row with no `Plan`
     relation cannot be routed and is dropped.
   - `From` = `Remote`
   The comment is routed to the card's **current** column agent.

6. **Read results.** On a later turn, query the "Switchboard Comments" database for
   rows with `From = Switchboard` (the local agent's replies), and/or re-read the
   card's page body.

## Features (grouping related work)

An **feature** is a parent card that groups related subtask cards. Moving an feature's
`Kanban Column` cascades the move to all its subtasks on the local machine — so you
can dispatch a whole group of work in one action.

### To create an feature (Notion)
1. Create the feature's page in the plans DB (same as any card).
2. Check the **Is Feature** checkbox property.
3. The page is now an feature — it can have subtasks.

### To create an feature (Linear)
1. Create the feature's issue in the mapped Linear project.
2. Create subtask issues and set their **parent** to the feature issue.
3. The local poll detects the parent/child relationship and mirrors it — the feature
   cascades subtask moves automatically.

### To assign a subtask to an feature (Notion)
1. Create or find the subtask's page.
2. Set its **Feature** relation property to point to the feature's page.
3. The local poll mirrors the link — the subtask now moves when the feature moves.

### To trigger a group of work
1. Set the `Kanban Column` (Notion) or Linear status on the **feature** card (not the subtasks).
2. The local cascade moves all subtasks to the same column and dispatches each
   subtask's column agent.

### Constraints
- A subtask can belong to only **one** feature (single-select relation / single parent).
- Only create feature/subtask links between cards on the **same synced board** —
  the local poll can only mirror links between cards it tracks.
- An feature with no subtasks is harmless (it just cascades to nothing).

## Edge Cases

- **Neither Linear nor Notion connected**: Skill degrades gracefully — explain the
  limitation and offer to fall back to `/sw` if the user has local access.
- **Multiple boards mapped**: If multiple Switchboard projects exist in Linear, guide
  the user to identify the correct one using `list_projects`.
- **User accidentally uses `/sw` in a remote session**: Not a hard error, but `/sw`
  will try to read local files that don't exist. Use `/sw-remote` for remote contexts.
- **Status name drift**: Linear status names can be renamed by the user. Always use
  `list_issue_statuses` rather than assuming names from prior sessions.
- **Read-back latency**: Results written by the local agent appear in the Linear
  issue / Notion page after the next sync cycle (up to 30–120s depending on poll
  frequency). Note this when checking results in a follow-up session.

## Capability Note

Every Notion MCP connector reliably supports database query, create-page/row, and
property updates — which is all this flow needs. If your specific connector lacks
create-row, fall back to creating a child page under the Comments DB with the same
properties, or report the gap to the user.

## Feature Grouping

When the work described will span 3 or more plan files on a related topic (sharing a
common feature area or root cause):

- **Early (during scoping):** Flag it once: *"This looks like it will produce 3+
  related plans — once they're all drafted, want me to group them under a feature?"*
  Do not create anything yet.
- **Closing (when all plans are drafted):** Offer again: *"You now have [N] plans
  covering [topic] — want me to create a feature to group them?"*

Only create the feature if the user confirms. In a remote session, feature creation follows
the `/create-feature` skill (direct file write to `.switchboard/features/`) or the
`create-feature.js` script if the extension is reachable.
