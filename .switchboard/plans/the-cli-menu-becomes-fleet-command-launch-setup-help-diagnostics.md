# The CLI Menu Becomes Fleet Command, Sync, Launch, Setup, Help, Diagnostics

kanbanColumn: CREATED

## Goal

The menu:

```
  Fleet command  →  Starred
                    Columns
                    Status
                    Monitor
                    Teams
                    Agents
                    Missions
                    Set Filters
  Sync           →  fetch tickets
                    push board state
                    pick project / list
                    switch provider
  Launch         →  Local
                    Remote
                    (reads "Stop" when a server is running)
  Setup
  Help
  Diagnostics
```

### Problem analysis

Today the menu is a flat list whose contents change with server state (`cli.ts:1993-2012`), plus a second flat list inside the board console (`:2449`). Between them:

- **Starred has no entry.** Cards are sorted by star (`:730`) and rendered with one (`:756`), but there is no way to see only them. With 20 starred cards on a board of 2,507, the operator's most useful view is unreachable.
- **Teams and Agents have no entries.** Starting a team is not on either menu.
- **Filters are one-shot menu items**, not a set. Project and search are picked, used, and lost on the way back.
- **Numbers shift meaning with server state** — offline `[3]` is Setup, online `[3]` is Help — so learned keys are wrong half the time.
- **Stopping a running server is not offered at all.**
- **Missions are unreachable from the CLI.** `/mission-control/start`, `/stop`, `/adopt`, `/confirm`, `/handoff` and `/session-log` all exist (`LocalApiServer.ts:9887-9961`) plus a verb rail, and `grep -i mission` in `cli.ts` returns only comments about the protocol's jq reads. An operator over ssh can neither start a mission nor see one running.
- **A card has exactly one action: dispatch.** Picking a card in a column goes straight to `doDispatch` (`:2183-2186`). There is no way to star, unstar, inspect or move it. Starred is the headline view of this menu and nothing in the CLI can put a card into it — that requires the browser.
- **Tracker sync is not reachable from the CLI.** The capability itself is well covered — `e7e9f2f5` (*Board sync is a capability all three providers implement*, Planned) carries five subtasks on the provider seam, its contract test, Notion's misnamed backup, ClickUp restore orchestration and the Linear planId anchor. What none of that touches is the CLI: `grep` for a sync, tickets or integration subcommand in `cli.ts` returns nothing. Sync exists through the panel and the HTTP verb rail (`_handleTicketsVerb`, `LocalApiServer.ts:6117`) only, so an operator over ssh cannot reach any of it.

The structure above fixes each by being the structure, not by adding items to a list.

**This menu is for a human at a terminal, not for agents.** That is the line between this card and `ef40963b` (*The CLI is a peer control surface*, starred, New). That plan is about the agent-facing operation set — 559 auto-generated UI verbs against ten named commands, `switchboard verb` reaching only two routes, and agents falling back to unauthenticated `curl`. An agent never opens an interactive menu.

They overlap only where an operation serves both audiences. Where an entry here needs a command that does not exist, the command belongs on `ef40963b`; but this menu is not blocked on that plan's agent-facing scope, and most of what it arranges is already reachable.

## Metadata

- **Complexity:** 6
- **Feature:** The /switchboard front door
- **Tags:** cli, ux

## User Review Required

None.

## Proposed Changes

### 1. Five top-level entries

Fleet command, Launch, First time setup, Help, Diagnostics. Fleet command and Launch open sub menus; the other three act directly.

Keys are stable regardless of server state. Nothing renumbers.

### 2. Fleet command — the board and the fleet

Selecting **Columns** lists the columns with their card counts, the operator picks one, and its cards are listed with the active filters applied and dispatchable — the flow that exists today, narrowed by whatever is set and by `9572d35f`'s subtask exclusion.

Selecting **Starred** skips the column step entirely: starred cards across every column, dispatchable from the same list.

### 2b. Picking a card offers actions, not just dispatch

Today `consoleBrowseCardsInColumn` dispatches the moment a card is picked (`:2183-2186`). That is one action hardcoded as *the* action.

A picked card should offer what an operator does with one: dispatch, star or unstar, and view the plan. Starring matters most here — Starred is this menu's headline view, and without it the operator curates their priority list in the browser and only *reads* it from the CLI.

**Use the command the command-set plan defines; do not invent a second path.** `ef40963b` carries a `star` action as a bare boolean, which is correct — `priority_starred` (`KanbanDatabase.ts:11378`) is a flag. Priority is a *different* field, `priority` (`:11392`), a 1–4 level owned by `d1556fd0`. They share an endpoint and nothing else.

Star is what this menu needs: Starred is a view, and a flag is what puts a card in it. A priority action can appear here later if wanted, but it is not the same operation and must not be folded into the same entry.


| entry | what it is |
| :--- | :--- |
| **Starred** | starred cards only, across all columns |
| **Columns** | pick a column, see its cards, dispatch — today's `consoleBrowseByColumn` (`:2191`) |
| **Status** | fleet status, once — today's `consoleInspectFleet` (`:2403`) |
| **Monitor** | the same status, refreshing on a timer — **new** |
| **Teams** | view teams, start a team |
| **Agents** | the agent roster |
| **Missions** | running missions — start, watch, stop |
| **Set Filters** | the filters applied to everything above |

Starred is first because it is the view the operator opens most and cannot currently reach at all.

**Status and Monitor are two entries, not one.** Status answers "what is the fleet doing right now" and returns to the menu. Monitor is the one an operator leaves open on a second screen or a phone while a feature runs — the same content, redrawn on an interval, until a key exits. Only Status exists today.

Monitor is the one genuinely new capability in this sub menu. Keep it small: an interval, a redraw, and a key to leave. It does not need its own filters, its own layout language, or alerting — it is Status on a loop, and anything more is a different feature.

**Missions** exposes the mission-control routes that already exist: start one, watch its session log, stop it. The useful three for a human at a terminal; `adopt`, `confirm` and `handoff` are specialised and can wait until asked for.

`73ebf150` (*Mission Control — the front door, the role, and how missions start and are watched*, Planned) owns how missions work, and `d2953390` records that **a mission cannot currently be opened, its launch is not scoped to it, and nothing watches it**. That defect gates the watch half of this entry — start and stop are reachable now, watching is not until it lands.

### 3. Set Filters holds what the others narrow by

One screen listing the filters and their current values. Set once, applied to every view under Fleet command until changed.

The axes: **starred, project, search**. These narrow *within* whatever view is open. Project and search exist today as one-shot menu items (`consoleFilterByProject` `:2322`, `consoleSearch` `:2242`) — their matching logic is reused here rather than rewritten, and they stop being separate destinations.

**Column is deliberately not a filter axis.** It is a navigation choice, and Columns is where it is made. Listing it in both places gives "pick Planned in Columns while the column filter says New" no defined answer. Starred already spans all columns by definition; the operator narrowing to one column does it by opening that column.

Every view states what is filtering it, so a short list reads as a filtered result and never as an empty board. One key clears everything.

### 4. Sync — tracker integration on the CLI

A top-level entry for board/tracker synchronisation, opening the operations an operator needs away from the panel: fetch tickets, push board state, choose the project or list to sync against, and switch provider.

**Name it for the capability, not the vendor.** Switchboard syncs against more than one tracker and the verb rail already reflects that — `linearLoadProject`, `clickupLoadLists`, `switchTicketsProvider` are all on the same surface. A menu entry named for one provider becomes wrong the moment the operator uses another, and the currently-selected provider is a setting, not a fixed fact. Show the active provider *inside* the Sync menu instead.

**Expose existing capability; do not build sync.** `e7e9f2f5` owns the sync model; `ef40963b` owns whether it has CLI commands. This entry is where those commands appear in the menu.

It is still the largest item — no CLI sync surface exists today — and may warrant splitting out once the shape is settled. But the split is "arrange the commands", not "design sync" and not "invent the command set".

### 5. Launch, and Stop when it is running

Launch opens Local or Remote. When a server is already running the entry reads **Stop** and stops it — one slot, one state-appropriate verb, rather than a Launch that cannot launch and no way to stop.

### 6. Setup, Help and Diagnostics stay as they are

Direct actions, unchanged behaviour, at the bottom. **Setup**, not "First time setup" — it is run again whenever a repo is scaffolded or a secret changes, and naming it for first use discourages exactly that.

## Edge-Case & Dependency Audit

1. **Nothing loses its capability.** Column browsing, fleet inspection, project filtering and search all survive — as Columns, Monitor, and values under Set Filters.
2. **Teams, Agents, Sync and Missions depend on commands that may not exist yet.** Building them is `ef40963b`'s remit — `e7e9f2f5`'s for sync, `73ebf150`'s for missions — not this card's. An entry with nothing behind it is left out until its command lands; an entry that errors is worse than an absent one.
2b. **The watch half of Missions is gated on `d2953390`**, which records that a mission cannot be opened and nothing watches it. Start and stop can ship before it; watching cannot.
3. **Server-offline state** greys entries with their keys intact; it never renumbers.
4. **Stop needs to be a real shutdown**, not a signal kill — see `8eba302d`, which covers exactly this on Windows.
5. **`9572d35f`** fixes what a column listing contains (excluding subtasks). Independent of this and still needed.
6. **`5fb04de7`** binds Enter and stabilises keys on the same function. Same code, sequence them.
6b. **`ef40963b` overlaps but does not block.** It serves agents; this serves a human at a terminal. Where an entry needs a command that does not exist, that command belongs there — but the arrangement does not wait on its agent-facing scope.
6c. **Monitor must not hold the terminal hostage.** A redraw loop needs a clean exit on a single key, must not accumulate scrollback on every tick, and must survive the server going away without spinning on errors.
7. **`759c05b5`** proposed a GUI/CLI split of this menu. This supersedes it — reconcile before either is coded.
8. **Sync depends on a reachable provider.** An unconfigured or unauthenticated tracker must say so and offer the configuration path, not fail with a transport error.
9. **Do not build a second provider-selection model.** The active provider is already a setting behind `switchTicketsProvider`; read it, show it, and change it through the same verb.
9b. **Do not duplicate `e7e9f2f5`.** If a sync operation the CLI wants does not exist yet, it belongs on that feature, not here. This card adds a surface, never a capability.
10. **Non-TTY unaffected.**

## Verification Plan

1. The menu is the five entries above, in that order, with stable keys.
2. Fleet command opens the eight entries listed.
2b. Status reports once and returns; Monitor redraws on an interval until a key exits.
2c. Monitor with the server stopped reports that and stops, rather than looping on failures.
3. Starred shows only starred cards, across all columns, with no column step.
3b. Columns lists the columns with counts, and a chosen column lists its cards with the active filters applied.
3c. Setting a project or starred filter changes what a chosen column lists; there is no column filter to contradict the choice.
3d. Picking a card offers dispatch, star/unstar and view — not dispatch alone.
3e. A card starred from the console appears in Starred without leaving the CLI.
3f. Starring from the console goes through `ef40963b`'s `star` command, not a third path, and does not touch the separate `priority` field.
4. Set Filters narrows every view under Fleet command, and each says what is filtering it.
5. One key clears all filters.
6. Launch offers Local and Remote; with a server running the entry reads Stop and stops it.
7. Teams, Agents and Missions perform real actions.
7b. Missions can start and stop a mission from the CLI; watching works once `d2953390` lands.
8. Sync fetches tickets and reports what changed, and names the active provider.
9. Sync against an unconfigured tracker explains that and offers the configuration path.
10. Keys mean the same thing whether or not a server is running.
