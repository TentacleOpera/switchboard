# The Console Gets a Command Menu Instead of One Flat List

kanbanColumn: CREATED

## Goal

The console's front door offers two things — what am I looking at, and what do I want to do — instead of one flat list mixing card browsing with server lifecycle and setup.

### Problem analysis

The front door (`cli.ts:1993-2012`) is a single list of five items that mixes categories: starting a server, running a setup wizard, reading help, checking diagnostics, and browsing the board. They have nothing in common except being things the binary can do.

Meanwhile the operator's common actions are not on it at all. Viewing features, viewing the fleet, starting a team — all exist as separate subcommands or nowhere, and none is reachable from the interactive front door. So the operator either memorises the subcommand surface or uses the browser.

The result is a menu that is simultaneously too long and missing the things it is wanted for.

**This is the shape the operator asked for:** a command menu grouping the common actions, sitting beside the filter set. Both are one keystroke from the front door, and everything under the command menu honours the filters.

**Relationship to `759c05b5`.** That card also restructures the front door, splitting it into a GUI branch and a CLI branch. This is the same instinct with a better split: the division that matters is not "server vs board" but "set what I'm looking at" vs "do something". Reconcile the two before either is built — they must not both land.

## Metadata

- **Complexity:** 5
- **Feature:** The /switchboard front door
- **Tags:** cli, ux

## User Review Required

Change 1 carries one decision: whether this replaces `759c05b5` or is merged into it.

## Proposed Changes

### 1. A command menu, grouping what an operator actually does **[decision]**

One submenu holding the common actions, each already existing somewhere as a subcommand:

- view features
- view the fleet
- view cards and dispatch
- start a team
- server status and diagnostics

Setup, scaffolding and help are not common actions. They belong behind the same menu but at the bottom, or behind a single "more" entry — not competing for attention with the things done every session.

**The decision:** `759c05b5` proposes a GUI/CLI split of the same front door. Settle whether that card is superseded by this one or whether the two merge, before either is coded. Both rewriting `cmdMainMenu` independently is a guaranteed conflict.

### 2. Everything under it honours the session filters

A command menu that ignores the filter set is two features that do not compose. Viewing features, viewing cards and dispatching all apply whatever is currently set, and all say so.

### 3. Do not add depth to the common path

The operator's most frequent action must stay reachable in one keystroke from the front door. A menu that groups well but buries the daily action two levels down has traded one complaint for another — that is the exact failure noted against `759c05b5` in `5fb04de7`.

### 4. Actions the CLI does not have yet are out of scope here

"Start a team" and "view features" must resolve to real behaviour, not a menu entry that errors. Where the underlying command does not exist, either it is built as part of this or it is not listed. A menu advertising an action it cannot perform is worse than a shorter menu.

## Edge-Case & Dependency Audit

1. **Depends on the session filters card** for change 2. The menu can ship first with no filtering, but then must be revisited — say so rather than shipping it as finished.
2. **Conflicts with `759c05b5`** on the same function. One of them lands.
3. **Also conflicts with `5fb04de7`** (Enter binding, stable keys) and `9572d35f` (column listing) in the same code. Four cards, one `cmdMainMenu` — sequence them.
4. **Server-offline state changes what is available.** Actions needing a running server are shown unavailable with their key, not renumbered away — same rule as `5fb04de7`.
5. **Non-TTY is unaffected.**

## Verification Plan

1. The front door offers the filter set and the command menu, and states what Enter does.
2. Every entry in the command menu performs a real action.
3. Actions under it honour the active session filters and say so.
4. The most common action remains one keystroke from the front door.
5. With no server running, unavailable entries are shown unavailable rather than removed.
6. Setup, scaffolding and help are reachable but not competing with daily actions.
7. Exactly one of this card and `759c05b5` has been implemented.
