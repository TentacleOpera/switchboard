# The Board Console Gets a Commands Sub Menu and a Filters Option

kanbanColumn: CREATED

## Goal

The board console's top level is two options: set filters, and commands. Commands opens a sub menu holding everything the console can do — what is on the menu today, plus the actions that are missing from it.

### Problem analysis

`cmdBoardConsole` (`cli.ts:2449`) puts everything on one flat list:

```
  [1] Browse & Dispatch by Column
  [2] Search Plans & Features
  [3] Filter by Project
  [4] Inspect Fleet Status
  [5] Setup & Scaffolding Wizard
  [b] Back / Exit
```

Two problems, and they are separate.

**The actions an operator wants are not on it.** Viewing features has no entry. Starting a team has no entry. What is there is a partial set, so the operator falls back to subcommands or the browser.

**There is no way to say what you care about.** Narrowing exists only as two of those menu items, each a one-shot that is lost the moment you back out of it. There is no persistent notion of "starred only" or "this project", so the operator re-narrows by eye every time.

Adding more items to the flat list solves neither — it is already the length the operator finds unwieldy.

## Metadata

- **Complexity:** 5
- **Feature:** The /switchboard front door
- **Tags:** cli, ux

## User Review Required

None.

## Proposed Changes

### 1. The console's top level becomes two options

```
  [f] Set filters      → lists the filters you can apply to everything else
  [c] Commands         → sub menu
  [b] Back / Exit
```

### 2. The Commands sub menu holds the current menu, plus what is missing

Everything on the console menu today moves into the sub menu unchanged. Nothing is removed, nothing is converted into something else, nothing changes behaviour:

```
  [c] Commands
        Browse & Dispatch by Column      (today's [1], unchanged)
        Search Plans & Features          (today's [2], unchanged)
        Filter by Project                (today's [3], unchanged)
        Inspect Fleet Status             (today's [4], unchanged)
        Setup & Scaffolding Wizard       (today's [5], unchanged)
        View Features                    NEW
        Start a Team                     NEW
```

`consoleBrowseByColumn` (`:2191`), `consoleSearch` (`:2242`), `consoleFilterByProject` (`:2322`) and `consoleInspectFleet` (`:2403`) are called from the sub menu instead of the top menu. They are not rewritten and not folded into anything.

### 3. Set filters is a new capability, not a rehoming of existing items

It lists what can be narrowed and holds the choice for the session, applied to every view until changed. That is `8db0da5c`.

It does **not** replace `Filter by Project` or `Search`. Those stay as commands and keep working exactly as they do. The filter set is the persistent version of the same idea, added alongside — an operator who wants a one-shot project view still uses the command.

### 4. Add the two missing actions

*View Features* and *Start a Team* are the reason the sub menu is wanted. A sub menu holding only what the flat menu already held is the same menu with an extra keystroke.

Both must resolve to real behaviour before they are listed. An entry that errors is worse than an absent one.

## Edge-Case & Dependency Audit

1. **Nothing is deleted.** Every current menu item exists in the sub menu with its current behaviour and its current implementation. This is a re-parenting, plus two additions.
2. **Do not convert menu items into filter values.** Search and project filtering stay as commands. The filter set is additive.
3. **`9572d35f` changes what Browse & Dispatch lists** (excluding subtasks); it is independent of where the entry sits, and both land.
4. **`759c05b5` and `5fb04de7` are `cmdMainMenu`**, the top-level front door. They do not overlap with this.
5. **Server-offline state**: entries needing a running server are shown unavailable with their key, not renumbered away.
6. **Non-TTY is unaffected.**

## Verification Plan

1. The board console's top level shows Set filters, Commands, and Back — nothing else.
2. Commands opens a sub menu containing all five of today's entries plus View Features and Start a Team.
3. Each of the five behaves exactly as it does today.
4. View Features and Start a Team perform real actions.
5. Filter by Project and Search still work as one-shot commands, unchanged by the existence of the filter set.
6. With no server running, unavailable entries show as unavailable rather than disappearing.
