---
description: Drive a Switchboard board remotely through Notion via the Notion MCP connector
---

# Switchboard Remote Control via Notion (MCP control surface)

This orients a **claude.ai** session that drives a developer's local Switchboard board
**through Notion**, using the **Notion MCP connector**. You are not editing a human's Notion
workspace — Notion is an **agent control surface**. The human tells you what they want; you
author the plan, trigger execution on their machine, and read results back, all over Notion MCP.

## How the loop works
- Switchboard polls Notion on a timer (no webhooks). It mirrors a card's `Kanban Column`
  onto the local board and dispatches that column's agent — exactly like a manual drag.
- A dedicated **"Switchboard Comments"** database is the async message bus. You post rows
  (`From = Remote`); the local agent replies as rows (`From = Switchboard`).
- Read-back latency is bounded by the poll interval (≤ the configured ping frequency).

## Pre-flight
- Remote Control must be **enabled with provider = Notion** and the board mapped in the
  Switchboard **Remote tab** (in the Project panel), and the one-time **"Run Notion setup
  sync"** must have been run (it creates the plans DB, the Comments DB, and matches the
  `Kanban Column` options to the real board columns). If a column you set doesn't dispatch,
  that setup likely hasn't run.

## Ground every plan in the synced project context (read this FIRST)

You have **no repo access** — no GitHub, no git, no file system. What you DO have is the
**project-context mirror**: Switchboard syncs the workspace's curated planning context —
**Dev Docs + project PRDs + the workspace constitution** — outward to the tracker. Read it
**before authoring any plan**, so your plan names real modules, files, and conventions
instead of being a "post-it note" that sends the local execution agent in the wrong direction.

**Where to find it:**
- **Notion:** a page titled **"Switchboard Project Context — \<workspace\>"**, created beside
  the plans database ("Switchboard Kanban Backup"). Find it with Notion MCP search.
- **Linear (Linear-native sessions):** a document titled **"Switchboard Project Context"**
  on the project itself (project documents, not an issue body).

**How to use it:**
1. Read the constitution first (project principles and hard rules — plans must respect them).
2. Read the PRD of the project the card belongs to (WHAT the product requires).
3. Read the Dev Docs (HOW the codebase is put together — modules, seams, conventions).
4. Author the plan **citing concrete paths, symbols, and conventions from the Dev Docs**, so
   the local agent — which DOES have the repo — can navigate straight to the work.

**Rules and edge cases:**
- **Never edit the synced context on the tracker.** It is regenerated from Switchboard
  (project.html) on every sync — your edits will be silently overwritten. Author **plans**
  (cards), not doc edits. If the context is wrong, say so in a plan or comment so the human
  fixes it at the source.
- **Check staleness.** The context header carries its `Synced at` timestamp. If it looks
  stale, note that in your plan and tell the user they can push a fresh copy via
  **Remote tab → Sync Context Now** in Switchboard's Project panel.
- **No context found?** Context sync isn't enabled or has never run. Fall back to planning
  from the card text alone (the original behavior), state that limitation in the plan, and
  tell the user to enable **Project Context Sync** in the Remote tab.
- **Notion tier differences:** precise database property queries are tier-gated on some
  plans. If structured queries fail, fall back to `notion-search` / `notion-fetch` by title
  ("Switchboard Project Context"). Only navigation efficiency changes — the flow above stays
  the same.

## Steps

1. **Find the plans database.** Use Notion MCP search/query to locate the Switchboard plans
   database (titled "Switchboard Kanban Backup") and the "Switchboard Comments" database.

2. **Create or find the card's page.** Either edit an existing page (setup sync created one per
   board card) or create a brand-new page in the plans DB for new work — the next ping imports
   a new page as a new local markdown plan automatically.

3. **Write the implementation plan into the page BODY.** Author it fully *before* moving the
   card, **grounded in the synced project context** (see the section above) — cite the
   concrete paths, modules, and conventions the Dev Docs name. The local poll reads the page
   body and writes it to the local plan file — so the body is the source of truth the local
   agent runs against. Convention: **write the body completely, THEN flip the column** (a
   half-written body can be picked up if you flip too early). Note: an empty body is skipped
   (the poll won't overwrite a local plan with nothing), so always author the body when you
   intend to revise it.

4. **Trigger the local agent: set `Kanban Column`.** Read the board's real column names first
   (they are the select options). Set `Kanban Column` to the **trigger** column for the work
   you want (e.g. a planning column to refine, a coding column to implement). The poll mirrors
   the column locally and dispatches that column's agent.

5. **Converse without a state change: add a Comments-DB row.** To send an instruction or
   question without moving the card, create a row in the "Switchboard Comments" database:
   - `Message` = your text
   - `Plan` = relation to the card's page  ← **REQUIRED.** A row with no `Plan` relation
     cannot be routed and is dropped.
   - `From` = `Remote`
   The comment is routed to the card's **current** column agent.

6. **Read results.** On a later turn, query the "Switchboard Comments" database for rows with
   `From = Switchboard` (the local agent's replies), and/or re-read the card's page body.

## Capability note
Every Notion MCP connector reliably supports database query, create-page/row, and property
updates — which is all this flow needs. If your specific connector lacks create-row, fall back
to creating a child page under the Comments DB with the same properties, or report the gap to
the user.
