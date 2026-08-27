---
name: switchboard-remote
description: Remote Connections & Remote Control — drive plans via Linear, Notion, or external AI surfaces (side-by-side or away from desk)
---

# Connections & Remote Switchboard Session Entry Point

You are entering a **Connections & Remote Switchboard planning session**. Drive board planning either remotely (away from desk) or side-by-side using external AI surfaces (e.g. Gemini Spark or Claude Cowork). Plans live in Linear, Notion, or external file return paths. MCP or file watchers serve as the integration layer.

This is the external/remote counterpart to `/sw` (switchboard-chat). Use `/sw` when you have local access; use `/sw-remote` for external surfaces or away-from-desk control.

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

An **feature** is a parent card that groups related subtask cards. Moving a feature's
`Kanban Column` cascades the move to all its subtasks on the local machine — so you
can dispatch a whole group of work in one action.

### To create a feature (Notion)
1. Create the feature's page in the plans DB (same as any card).
2. Check the **Is Feature** checkbox property.
3. The page is now a feature — it can have subtasks.

### To create a feature (Linear)
1. Create the feature's issue in the mapped Linear project.
2. Create subtask issues and set their **parent** to the feature issue.
3. The local poll detects the parent/child relationship and mirrors it — the feature
   cascades subtask moves automatically.

### To assign a subtask to a feature (Notion)
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
- A feature with no subtasks is harmless (it just cascades to nothing).

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

## Plan Sizing & Feature Grouping

**Plan Sizing — split before drafting.** Before writing any plan file, assess whether the work is one plan or multiple. Auto-split into separate plan files when EITHER signal is present:
- **3+ distinct deliverables:** the work produces 3+ independent outputs (e.g. 3+ pages, 3+ components that don't share a root cause, 3+ API endpoints in different domains, 3+ unrelated bug fixes).
- **2+ independently-shippable phases:** the work has sequential stages where each could be shipped on its own.
When splitting: write each as a separate plan file with its own Goal, Metadata, and Verification Plan. If the user explicitly asks for a single plan, respect that and write one.

**Feature Grouping.** When the work described will span 3 or more plan files on a related topic (sharing a common feature area or root cause):
- **Early (during scoping):** Flag it once: *"This looks like it will produce 3+ related plans — once they're all drafted, want me to group them under a feature?"* Do not create anything yet.
- **Closing (when all plans are drafted):** Offer again: *"You now have [N] plans covering [topic] — want me to create a feature to group them?"*

The gate depends on who initiated grouping: if the user already asked for grouping or a feature (e.g. "split these into plans and create a feature"), the original ask IS the confirmation — create the feature now without a second confirm. If you are proposing grouping the user did not request, only create the feature if the user confirms. In a remote session, feature creation follows the `/create-feature` skill (direct file write to `.switchboard/features/`) or the `create-feature.js` script if the extension is reachable.

## 8b. Linear Steps (if Linear is the provider)

Linear is the provider to prefer when the operator is on a **phone** — it has a first-class
mobile app, and its structured queries are not tier-gated the way some Notion connectors are.
These steps mirror section 8.

1. **Find the board.** `list_projects` to locate the mapped Switchboard project. If several
   Switchboard projects exist, confirm which one before writing anything.

2. **Read the real status names.** `list_issue_statuses` **every session** — do not carry names
   over from a previous one. Users rename statuses, and the mapped column names are what drive
   local dispatch.

3. **Create or find the card's issue.** Either update an existing issue (one per board card) or
   create a new issue in the mapped project — the next poll imports a new issue as a new local
   markdown plan automatically.

4. **Write the plan into the issue DESCRIPTION.** Author it fully *before* moving the card, and
   ground it in the synced project context per section 7. The local poll reads the description
   and writes it to the local plan file, so the description is the source of truth the local
   agent runs against. **Write the description completely, THEN change the status** — a
   half-written description can be picked up if you flip too early. An empty description is
   skipped, so always author it when you intend to revise.

5. **Trigger the local agent: change the status.** Set the issue's status to the trigger state
   for the work you want (a planning state to refine, a coding state to implement). The poll
   mirrors the state locally and dispatches that column's agent.

6. **Converse without a state change: add a comment.** A comment on the issue is routed to the
   card's **current** column agent as input. This is the Linear equivalent of the Notion
   Comments-DB row, and needs no relation field — the issue *is* the addressing.

7. **Read results.** On a later turn, re-read the issue description and its comments. Local
   agents post back as comments, and the description carries whatever the local plan file now
   says.

### Features (Linear)

Per the Features section above: create the feature's issue, then set each subtask issue's
**parent** to it. The local poll mirrors the parent/child relationship, so changing the
**feature's** status cascades to all subtasks and dispatches each one's column agent.

### Automation rules — label-triggered pipelines

Linear has a capability Notion does not: **automation rules** keyed on a label plus a set of
states. Configured in Switchboard's Remote tab, each rule is
`{ name, triggerLabel, triggerStates, targetColumn, finalColumn, writeBackOnComplete }`, and a
card matching **both** the label and one of the states is imported into `targetColumn` — with the
result written back to the card when it completes, if `writeBackOnComplete` is set.

For an agent driving the board remotely this means: **applying a label can be a dispatch action**,
not just metadata. Before using labels that way, ask the operator which rules are configured — a
label you add casually may fire a pipeline. Conversely, if the operator wants a repeatable
"file a card, get work done" path, a rule is the mechanism to suggest rather than hand-moving
statuses each time.

## 9. Driving from a phone

This skill *is* the phone answer for Switchboard. The board itself is a desktop surface — it has
no responsive layout and its kanban card moves use HTML5 drag-and-drop, which does not fire on
touch devices at all — so a phone drives the board **through the tracker**, not through the board.

What that means in practice:

- **Prefer Linear.** Real mobile app, no tier-gated queries, comments as the message bus.
- **Latency is the design, not a defect.** Local results appear after the next poll (30-120s).
  Write, put the phone away, read the answer later. Do not sit and refresh — and do not tell the
  user something failed because it has not appeared yet.
- **One action per turn is usually right.** Author the description fully, then change the status.
  The half-written-body race in step 4 is more likely on a phone, where the operator is
  interrupted mid-edit.
- **Nothing here requires exposing the host.** The tracker is reachable from the phone; the host
  is not, and does not need to be. Never suggest opening a port, a tunnel or a proxy to make a
  phone work — that is a different and much larger decision, and the tracker path exists so it is
  not needed.

## 10. What the tracker cannot show you

The mirror is faithful for plans, statuses, features and comments. It carries **nothing** for the
following, so do not offer them, and say plainly that they are desk-only if asked:

- **Missions.** Mission state, membership, launch/stop, and dependency gating are local-only —
  there is no mission representation in the sync at all. A question like "why hasn't this card
  moved" may have a mission-gating answer that is invisible from here. Say so rather than
  guessing.
- **Memo capture.** Local-only. There is no memo surface on the tracker.
- **Worktree diffs and git state.** Not mirrored. "Did the agent do something sane?" cannot be
  answered from the tracker unless an agent wrote the answer into a comment.
- **Live terminal output.** Not mirrored, and not something to attempt — agents report by posting
  comments, and that is the only stream available here.

When the operator asks for one of these, the honest answer is that it needs the board, plus an
offer to have an agent post the specific thing they want as a comment. Do not speculate about
local state you cannot see — the sync's silence is not evidence that nothing is happening.

## 11. Remote mode is what makes agents talk to you

This is the most important operational fact in this skill, and it is a **pre-flight item**, not a
detail.

When a board is under remote control, `REMOTE_MODE_DIRECTIVE` is injected into **every** agent
role on dispatch. Its text:

> REMOTE MODE: You are running under remote control — the user is NOT at the terminal. If you need
> to ask the user anything or report a blocker, post it as a comment on the linked issue using
> `.agents/protocols/linear-api/SKILL.md` (or `.agents/protocols/clickup-api/SKILL.md`). Do NOT
> wait on terminal input. Continue with any work you can do without the answer.

So the question-and-answer loop already exists and is bidirectional:

- **Agent → operator.** The agent posts through the host-side comment bridge. Comments are
  stamped with a self-marker **host-side**, never by the agent, which is what stops Switchboard's
  own comments from being re-ingested as operator input. Agents never call the tracker API
  directly.
- **Operator → agent.** Your comment on the issue is routed to that card's current column agent as
  input, with the marker filtering Switchboard's own comments out.

**Why this matters when you are driving remotely:**

- **Confirm remote control is actually ON for the board you are working**, per the pre-flight in
  section 6. It is gated per board. With it off, a dispatched agent that hits a question **blocks
  on terminal input nobody is watching** — the work stalls silently and no comment ever appears.
  If cards seem to stop mid-flight with no explanation, this is the first thing to check.
- **A quiet card is not necessarily a stuck card.** The directive tells agents to continue with
  whatever does not need the answer, so silence can mean "still working". Read the comments before
  concluding anything.
- **Answer in the thread, not by editing the description.** A reply is a comment; the description
  is the plan body and rewriting it mid-flight fights the poll.
- **Do not design around this loop's absence.** If asked how to get an answer back from an agent,
  the answer is "it already comes back as a comment" — not a tunnel, not a port, not a new
  channel.

### Planned change — where a comment goes

The statements above that a comment is routed to the card's **current column agent** describe
today's behaviour and are correct as written. A planned change
(`a-card-comment-cannot-reach-the-seat-holding-the-work.md`) routes a comment on an **in-flight**
card to the seat actually holding it — the card's `dispatched_terminal` — and leaves column routing
in place for every other card. Until that ships, assume column routing. After it ships, this section
is what to update.
