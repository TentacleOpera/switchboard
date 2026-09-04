# The Board Console's Menu Becomes Filters and Commands

kanbanColumn: CREATED

## Goal

The board console's menu offers two things — what am I looking at, and what do I want to do — instead of one flat list that mixes filters with actions.

### Problem analysis

The board console's menu (`cmdBoardConsole`, `cli.ts:2449`) is a flat list of five items that mixes two different kinds of thing:

```
  [1] Browse & Dispatch by Column
  [2] Search Plans & Features
  [3] Filter by Project
  [4] Inspect Fleet Status
  [5] Setup & Scaffolding Wizard
```

**Three of those five are filters, not actions.** Project, search, and column are all ways of narrowing what you are looking at. They sit as peers of "inspect fleet" and "run the setup wizard", which are things you *do*. An operator who wants their high-priority cards in one project has to pick one narrowing dimension, lose it when they back out, and pick another.

**And the actions the operator actually wants are not there.** Viewing features has no entry at all. Starting a team has no entry. The two things on the menu that are genuinely actions are fleet status and a setup wizard nobody runs twice.

**The fix is to stop mixing them.** Filters become one entry that sets state applied to everything (`8db0da5c`). Commands becomes one entry opening a submenu of what an operator does. Two items where there were five, and both halves get bigger rather than the menu getting longer.

This card is the Commands half. It replaces the board console's menu; it does not touch the top-level front door, which keeps its own job of starting servers and opening this console.

## Metadata

- **Complexity:** 5
- **Feature:** The /switchboard front door
- **Tags:** cli, ux

## User Review Required

None.

## Proposed Changes

### 1. The console's menu becomes two entries

```
  [f] Set filters          → starred | project | column | search      (8db0da5c)
  [c] Commands             → view features
                             view cards & dispatch
                             view fleet
                             start a team
                             more: setup & scaffolding
  [b] Back
```

Everything that was a filter moves under Set filters. Everything that was an action moves under Commands. Setup goes to the bottom of the submenu — it is run once, not every session.

Every current menu item has a destination — nothing is dropped:

| today | becomes |
| :--- | :--- |
| `[1]` Browse & Dispatch by Column | action *view cards & dispatch*; the column choice becomes a filter value |
| `[2]` Search Plans & Features | filter value *search* |
| `[3]` Filter by Project | filter value *project* |
| `[4]` Inspect Fleet Status | action *view fleet*, behaviour unchanged |
| `[5]` Setup & Scaffolding Wizard | action, demoted under *more* |
| `[b]` Back | unchanged |

**`[2]` keeps its UUID lookup.** `consoleSearch` (`:2242`) matches on title *or* planId substring, so pasting a prefix still finds the card — as a filter that narrows to it, dispatched from the shared list rather than a separate screen.

**`[1]` is the one real behaviour change.** Choosing a column is mandatory today; it is the only entry into the card list. As a filter it becomes optional, so an unset column means cards across all columns. That is what makes "show me my starred cards" expressible at all, but the default view is wider than today's — state that in the header so it reads as intentional.

### 2. Add the actions that are missing

*View features* and *start a team* have no entry today. A command menu that lists only what already exists reproduces the current menu with extra nesting. These are the reason the operator wants the menu.

### 3. Everything under it honours the session filters

A command menu that ignores the filter set is two features that do not compose. Viewing features, viewing cards and dispatching all apply whatever is currently set, and all say so.

### 4. Do not add depth to the common path

Viewing cards and dispatching is the daily action. From the console's menu it must stay one keystroke into Commands and then the action — not deeper. Grouping that buries the daily path has traded one complaint for another.

### 5. An entry must do something

"Start a team" and "view features" must resolve to real behaviour, not a menu entry that errors. Where the underlying command does not exist, either it is built as part of this or it is not listed. A menu advertising an action it cannot perform is worse than a shorter menu.

## Edge-Case & Dependency Audit

1. **Depends on the session filters card** for change 2. The menu can ship first with no filtering, but then must be revisited — say so rather than shipping it as finished.
2. **This card is `cmdBoardConsole` (`:2449`), not `cmdMainMenu`.** `759c05b5` and `5fb04de7` restructure the top-level front door and do not overlap with it — the front door keeps starting servers and opening this console.
3. **`9572d35f` changes what Browse & Dispatch lists**; this changes where it is reached from. Both land, and 9572d35f's subtask exclusion is independent of either.
4. **`consoleFilterByProject` (`:2322`) and `consoleSearch` (`:2242`) already exist** as menu targets. They become filter values under `8db0da5c`, not deletions — the code moves, the capability does not go away.
4. **Server-offline state changes what is available.** Actions needing a running server are shown unavailable with their key, not renumbered away — same rule as `5fb04de7`.
5. **Non-TTY is unaffected.**

## Verification Plan

1. The front door offers the filter set and the command menu, and states what Enter does.
2. Every entry in the command menu performs a real action.
3. Actions under it honour the active session filters and say so.
4. The most common action remains one keystroke from the front door.
5. With no server running, unavailable entries are shown unavailable rather than removed.
6. Setup, scaffolding and help are reachable but not competing with daily actions.
7. The board console's menu has two entries plus Back, and the top-level front door is unchanged.
8. Project filtering and search are still reachable — as filter values, not menu items.
9. A UUID prefix typed into search still finds and dispatches its card.
10. With no column filter set, the card list spans all columns and the header says so.
