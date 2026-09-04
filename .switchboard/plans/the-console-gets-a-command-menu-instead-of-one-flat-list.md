# The Console Gets a Command Menu Instead of One Flat List

kanbanColumn: CREATED

## Goal

The console's front door offers two things — what am I looking at, and what do I want to do — instead of one flat list mixing card browsing with server lifecycle and setup.

### Problem analysis

The front door (`cli.ts:1993-2012`) is a single list of five items that mixes categories: starting a server, running a setup wizard, reading help, checking diagnostics, and browsing the board. They have nothing in common except being things the binary can do.

Meanwhile the operator's common actions are not on it at all. Viewing features, viewing the fleet, starting a team — all exist as separate subcommands or nowhere, and none is reachable from the interactive front door. So the operator either memorises the subcommand surface or uses the browser.

The result is a menu that is simultaneously too long and missing the things it is wanted for.

**This is the shape the operator asked for:** a command menu grouping the common actions, sitting beside the filter set. Both are one keystroke from the front door, and everything under the command menu honours the filters.

**How this composes with `759c05b5`.** That card defines the front door's top bifurcation — server lifecycle (`[G]`) versus board work (`[C]`). This card defines what lives inside the board-work arm. They are different levels of the same structure and both land:

```
switchboard
  [G] GUI / server      → start local | start tailnet          (759c05b5)
  [C] Board console     → [f] set filters                      (8db0da5c)
                          [c] commands ─ view features
                                         view fleet
                                         view cards & dispatch
                                         start a team
                                         diagnostics
                                         more: setup, help      (this card)
```

`5fb04de7` then binds Enter to the likely arm and gives every key a stable meaning, and `9572d35f` fixes what a column listing contains. Four cards, one structure, no overlap.

## Metadata

- **Complexity:** 5
- **Feature:** The /switchboard front door
- **Tags:** cli, ux

## User Review Required

None.

## Proposed Changes

### 1. A command menu, grouping what an operator actually does

One submenu holding the common actions, each already existing somewhere as a subcommand:

- view features
- view the fleet
- view cards and dispatch
- start a team
- server status and diagnostics

Setup, scaffolding and help are not common actions. They belong behind the same menu but at the bottom, or behind a single "more" entry — not competing for attention with the things done every session.

This menu is the contents of `759c05b5`'s `[C]` arm, not a replacement for it. Server lifecycle stays on the `[G]` arm where that card puts it.

### 2. Everything under it honours the session filters

A command menu that ignores the filter set is two features that do not compose. Viewing features, viewing cards and dispatching all apply whatever is currently set, and all say so.

### 3. Do not add depth to the common path

The operator's most frequent action must stay reachable in one keystroke from the front door. A menu that groups well but buries the daily action two levels down has traded one complaint for another — that is the exact failure noted against `759c05b5` in `5fb04de7`.

### 4. Actions the CLI does not have yet are out of scope here

"Start a team" and "view features" must resolve to real behaviour, not a menu entry that errors. Where the underlying command does not exist, either it is built as part of this or it is not listed. A menu advertising an action it cannot perform is worse than a shorter menu.

## Edge-Case & Dependency Audit

1. **Depends on the session filters card** for change 2. The menu can ship first with no filtering, but then must be revisited — say so rather than shipping it as finished.
2. **Four cards touch `cmdMainMenu`** — `759c05b5` (the top split), this one (the `[C]` arm's contents), `5fb04de7` (Enter binding and stable keys), `9572d35f` (column listing). They compose, but they edit the same function: sequence them rather than dispatching in parallel.
3. **`759c05b5` should land first.** It defines the structure this fills in.
4. **Server-offline state changes what is available.** Actions needing a running server are shown unavailable with their key, not renumbered away — same rule as `5fb04de7`.
5. **Non-TTY is unaffected.**

## Verification Plan

1. The front door offers the filter set and the command menu, and states what Enter does.
2. Every entry in the command menu performs a real action.
3. Actions under it honour the active session filters and say so.
4. The most common action remains one keystroke from the front door.
5. With no server running, unavailable entries are shown unavailable rather than removed.
6. Setup, scaffolding and help are reachable but not competing with daily actions.
7. The command menu sits inside `759c05b5`'s board-work arm, and the GUI arm still starts a server.
