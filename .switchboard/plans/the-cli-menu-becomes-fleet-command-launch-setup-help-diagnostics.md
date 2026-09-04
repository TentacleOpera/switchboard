# The CLI Menu Becomes Fleet Command, Sync, Launch, Setup, Help, Diagnostics

kanbanColumn: CREATED

## Goal

The menu:

```
  Fleet command  →  Starred
                    Columns
                    Monitor
                    Teams
                    Agents
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
- **Tracker sync is not on the CLI at all.** Board synchronisation with the issue trackers is a large part of what Switchboard does, and `grep` for a sync, tickets or integration subcommand in `cli.ts` returns nothing. The capability exists only through the panel and the HTTP verb rail (`_handleTicketsVerb`, `LocalApiServer.ts:6117`), so an operator working over ssh cannot reach it.

The structure above fixes each by being the structure, not by adding items to a list.

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

| entry | what it is |
| :--- | :--- |
| **Starred** | starred cards only, across all columns |
| **Columns** | browse and dispatch by column — today's `consoleBrowseByColumn` (`:2191`) |
| **Monitor** | fleet status — today's `consoleInspectFleet` (`:2403`) |
| **Teams** | view teams, start a team |
| **Agents** | the agent roster |
| **Set Filters** | the filters applied to everything above |

Starred is first because it is the view the operator opens most and cannot currently reach at all.

### 3. Set Filters holds what the others narrow by

One screen listing the filters and their current values. Set once, applied to every view under Fleet command until changed.

The axes: starred, project, column, search. Project and search exist today as one-shot menu items (`consoleFilterByProject` `:2322`, `consoleSearch` `:2242`) — their matching logic is reused here rather than rewritten, and they stop being separate destinations.

Every view states what is filtering it, so a short list reads as a filtered result and never as an empty board. One key clears everything.

### 4. Sync — tracker integration on the CLI

A top-level entry for board/tracker synchronisation, opening the operations an operator needs away from the panel: fetch tickets, push board state, choose the project or list to sync against, and switch provider.

**Name it for the capability, not the vendor.** Switchboard syncs against more than one tracker and the verb rail already reflects that — `linearLoadProject`, `clickupLoadLists`, `switchTicketsProvider` are all on the same surface. A menu entry named for one provider becomes wrong the moment the operator uses another, and the currently-selected provider is a setting, not a fixed fact. Show the active provider *inside* the Sync menu instead.

**This is new CLI surface, not a menu change.** There is no sync subcommand today; the entry has to call the existing tickets verbs over HTTP. Scope accordingly — this is the largest single item on the menu, and it may warrant splitting out once the shape is settled.

### 5. Launch, and Stop when it is running

Launch opens Local or Remote. When a server is already running the entry reads **Stop** and stops it — one slot, one state-appropriate verb, rather than a Launch that cannot launch and no way to stop.

### 6. Setup, Help and Diagnostics stay as they are

Direct actions, unchanged behaviour, at the bottom. **Setup**, not "First time setup" — it is run again whenever a repo is scaffolded or a secret changes, and naming it for first use discourages exactly that.

## Edge-Case & Dependency Audit

1. **Nothing loses its capability.** Column browsing, fleet inspection, project filtering and search all survive — as Columns, Monitor, and values under Set Filters.
2. **Teams and Agents must do something before they are listed.** If the underlying command does not exist, build it here or leave the entry out. An entry that errors is worse than an absent one.
3. **Server-offline state** greys entries with their keys intact; it never renumbers.
4. **Stop needs to be a real shutdown**, not a signal kill — see `8eba302d`, which covers exactly this on Windows.
5. **`9572d35f`** fixes what a column listing contains (excluding subtasks). Independent of this and still needed.
6. **`5fb04de7`** binds Enter and stabilises keys on the same function. Same code, sequence them.
7. **`759c05b5`** proposed a GUI/CLI split of this menu. This supersedes it — reconcile before either is coded.
8. **Sync depends on a reachable provider.** An unconfigured or unauthenticated tracker must say so and offer the configuration path, not fail with a transport error.
9. **Do not build a second provider-selection model.** The active provider is already a setting behind `switchTicketsProvider`; read it, show it, and change it through the same verb.
10. **Non-TTY unaffected.**

## Verification Plan

1. The menu is the five entries above, in that order, with stable keys.
2. Fleet command opens the six entries listed.
3. Starred shows only starred cards, across all columns.
4. Set Filters narrows every view under Fleet command, and each says what is filtering it.
5. One key clears all filters.
6. Launch offers Local and Remote; with a server running the entry reads Stop and stops it.
7. Teams and Agents perform real actions.
8. Sync fetches tickets and reports what changed, and names the active provider.
9. Sync against an unconfigured tracker explains that and offers the configuration path.
10. Keys mean the same thing whether or not a server is running.
