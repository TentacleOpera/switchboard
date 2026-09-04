# The Console Gets Session Filters — Set Once, Applied Everywhere

kanbanColumn: CREATED

## Goal

An operator sets what they care about once. Every view in the console then shows only that, until they change it.

### Problem analysis

The console has no concept of what the operator is currently interested in. Narrowing exists only as per-invocation flags on the non-interactive subcommands — `--project`, `--search`, `--limit`, `--offset` — and the interactive console offers none of them. Nothing carries between views.

So the operator's actual question, *"show me my high-priority cards and let me dispatch them"*, has no expression. They browse a column, get every card in it, and re-narrow by eye each time they come back.

**The flags cannot become the answer.** Adding `--starred`, `--column`, `--feature` to each subcommand multiplies the surface without solving the interactive case, and the operator's complaint is precisely that there are too many options already.

**The board has the axes, the console has none of them.** Starred, project, column, feature-vs-loose, and search are all real dimensions the board sorts and renders on. `compareConsoleCards` (`cli.ts:719-731`) already reads `priorityStarred`; `filterPlans` (`:673`) already takes a project. The pieces exist as one-shot arguments, not as state.

**This absorbs two narrower filter cards.** `9572d35f` proposes a starred filter and `07922522` a project filter; both become values in this set rather than separate mechanisms. What does not fold in is `9572d35f`'s subtask exclusion — that is a correctness fix to what a column *is*, not a preference, and should land on its own.

**This is the board console's menu, not the top-level front door.** `cmdBoardConsole` (`cli.ts:2449`) currently lists Browse by Column, Search, Filter by Project, Inspect Fleet and Setup — three filters and two actions in one list. Set filters and Commands (`5144f7ef`) replace all five. The front door keeps its own job of starting servers and opening this console.

`consoleSearch` (`:2242`) and `consoleFilterByProject` (`:2322`) already exist and become values in this set. Their code moves; the capability does not go away.

## Metadata

- **Complexity:** 5
- **Feature:** The /switchboard front door
- **Tags:** cli, ux, board

## User Review Required

None.

## Proposed Changes

### 1. A filter set, held for the session

One screen that lists the available filters and their current values, reachable from the front door. Setting one applies it to every view until it is changed or cleared.

The axes worth having, all of which the board already has:

- **starred** — only high-priority cards
- **project** — including the unassigned set
- **column** — one column, or all
- **search** — title substring

Keep it to axes the board genuinely sorts and renders on. A filter nobody sets is another option in a menu the operator already finds crowded.

### 1b. Filters are settable inline, not only from the filters screen

A filters screen alone is a regression. Today, browsing a column is two keystrokes (`[1]`, pick) and searching is two (`[2]`, type). Routing both through a separate screen and back makes the two most common actions slower than they are now:

| action | today | filters-screen only | with inline keys |
| :--- | :--- | :--- | :--- |
| browse a column | 2 | 5 | 2 |
| search | 2 | 5 | 2 |

So every filter must have a key that works **from inside the card list**: search, column, project, starred, and clear. Change a filter and the list re-renders in place — no exit, no re-entry.

The filters screen from change 1 stays as the discoverable route: it is how an operator learns what can be narrowed and sees everything currently set. The inline keys are how it is used once known. Both, not one.

### 2. The active filter is always visible

Every view states what is filtering it. A short list must read as *"3 cards match"*, never as an empty board — that ambiguity is worse than no filter at all, because it looks like data loss.

### 3. Clearing is one keystroke

A single key resets to unfiltered from anywhere. An operator who cannot remember what they set must be able to get back to everything without hunting.

### 4. Filters compose, and are one predicate

Starred and project and column apply together. Build one predicate the views share rather than each view filtering its own way — the current split, where `filterPlans` handles project and the comparator handles starred and nothing handles column, is how they drifted apart.

### 5. Persist across restarts, and say the filter is remembered

An operator who set a filter yesterday should find it today, and must be told it is active on entry. A remembered filter that silently narrows the board is the worst version of this feature — it looks like cards disappeared.

## Edge-Case & Dependency Audit

1. **A remembered filter must announce itself on entry.** Not in a header the operator scrolls past — on the first screen, before any list.
2. **Zero matches states the filter, and offers the clear key.** Never a bare empty list.
3. **Subtask exclusion is not a filter.** It is what a column means; keep it in `9572d35f` and outside this set.
4. **Non-TTY is unaffected.** Scripted invocation keeps using flags; session filters are an interactive-only concept and must not silently apply to `--json` output.
5. **Supersedes the filter halves of `9572d35f` and `07922522`.** Reconcile before either is dispatched, or the same predicate gets written three times.
6. **Where the state lives** must be recorded — this is the config-read rule: a filter that came from a remembered value and one set this session must be distinguishable after the fact.

## Verification Plan

1. Setting starred narrows every view, not just the one it was set from.
2. Every filtered view says what is filtering it.
3. Zero matches reads as a filtered result and names the clear key.
4. Starred plus project plus column apply together, through one predicate.
5. One keystroke clears everything from any view.
5b. Browsing a specific column takes no more keystrokes than it does today.
5c. Searching takes no more keystrokes than it does today.
5d. Every filter can be changed from inside the card list, and the list re-renders without leaving it.
6. A filter set, then a restart, is active and announced on the first screen.
7. `--json` and non-TTY output ignore session filters entirely.
