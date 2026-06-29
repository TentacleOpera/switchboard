---
name: switchboard-remote-notion
description: Drive a Switchboard board remotely through Notion via the Notion MCP connector
disable-model-invocation: true
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
  Switchboard **Remote tab**, and the one-time **"Run Notion setup sync"** must have been run
  (it creates the plans DB, the Comments DB, and matches the `Kanban Column` options to the
  real board columns). If a column you set doesn't dispatch, that setup likely hasn't run.

## Steps

1. **Find the plans database.** Use Notion MCP search/query to locate the Switchboard plans
   database (titled "Switchboard Kanban Backup") and the "Switchboard Comments" database.

2. **Create or find the card's page.** Either edit an existing page (setup sync created one per
   board card) or create a brand-new page in the plans DB for new work — the next ping imports
   a new page as a new local markdown plan automatically.

3. **Write the implementation plan into the page BODY.** Author it fully *before* moving the
   card. The local poll reads the page body and writes it to the local plan file — so the body
   is the source of truth the local agent runs against. Convention: **write the body completely,
   THEN flip the column** (a half-written body can be picked up if you flip too early). Note: an
   empty body is skipped (the poll won't overwrite a local plan with nothing), so always author
   the body when you intend to revise it.

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
