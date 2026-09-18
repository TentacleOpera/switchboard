# The CLI board console is a one-shot prompt with 20 exits: no way back, features mixed into the plan list, and no order at all

## Goal

Make `switchboard`'s board console navigable. Every prompt gets a way back, the list distinguishes features from plans, and cards are ordered by the board's own priority signals instead of arriving in whatever order the API returned.

### Problem Analysis

Four defects, all in `cmdBoardConsole` (`src/standalone/cli.ts:1873-2057`), and all fixable from data the CLI already receives.

**1. There is no way out of a menu except out of the program.** The function contains **20 `exitFlushed` calls** in 192 lines. Every terminal state — chosen, declined, empty, or mistyped — ends the process:

- Enter at the main menu → exit
- Enter at the column picker → exit
- Enter at the card picker → exit (the prompt says so: *"or Enter to exit"*)
- an empty board → exit
- an empty column → exit
- a mistyped selection → `exitFlushed(5)`, a **non-zero** exit for a typo

**2. The console does not loop, though the menu above it does.** `cmdMainMenu` (`:1731`) is a `for (;;)` that re-renders after each action. `cmdBoardConsole` renders once, reads one answer, runs one action, falls into `finally { prompter.close(); }` and returns. So dispatching a card ends the session — there is no "dispatch another", and no path back to the menu you came from. The two adjacent surfaces in the same file behave oppositely.

**3. Features and plans are one undifferentiated list.** Browse-by-column does:

```ts
const colPlans = plans.filter((p: any) => String(p?.kanbanColumn) === selectedCol);
colPlans.forEach((p, i) => console.log(`  ${formatPlanLine(p, i)}`));
```

`formatPlanLine` (`:677-684`) renders prefix, column, title and project — nothing else. A feature and one of its own subtasks appear as sibling numbered rows with no way to tell them apart, and selecting either dispatches it.

**4. Nothing is ordered.** `colPlans` is the API's array order, unsorted. Starred cards, the board's manual ordering, and complexity are all absent from the display and from the sort.

**Everything needed is already on the wire.** A card from `GET /kanban/plans` carries, among others:

```
isFeature   featureId   priorityStarred   columnOrder
complexity  queuePosition   recommendedRole   worktreeStatus
```

The CLI reads `planId`, `kanbanColumn`, `topic` and `project`, and discards the rest. This is not a data-availability problem and needs no new endpoint.

### Root Cause

**The console was built as a command with a prompt attached, not as a navigator.** `exitFlushed` is the only control-flow primitive it has: every branch that finishes, declines, or fails resolves by ending the process, because there is no enclosing loop for a branch to return to. Once that is the shape, "go back" is unrepresentable — the nearest available behaviour is "exit", so every prompt offers exit and the help text honestly advertises it.

The display defects follow from the same one-shot framing. A list you will see exactly once, immediately before choosing from it, does not obviously need sorting or type markers; a list you navigate does. The board's own priority signals were never plumbed because nothing in a single-shot flow asked for them.

**A mistyped selection exiting non-zero is the sharpest symptom.** `exitFlushed(5)` on an out-of-range number treats operator typos as a caller error, in an interactive TTY session where the only possible recovery is to re-launch and re-navigate from the top.

### Non-goals

- **Do not add a TUI framework or full-screen rendering.** This stays a line-oriented prompt console; the fix is loop structure and sorting, not a new dependency.
- **Do not change the non-interactive subcommands.** `plans`, `ready`, `dispatch` and `--json` keep their exact output and exit codes — scripts depend on them, and `dispatch`'s documented codes (0/1/2/3/4/5/6) are a contract.
- **Do not change what dispatch does.** This plan changes how a card is chosen, never how it is sent.

### Sizing note

Kept as one plan rather than split. All four defects live in one function, and separating "navigation" from "display" would put two agents in the same render path for no independent shippability — the ordering and the feature markers only become observable once there is a list you return to.

## Metadata

**Topic:** The CLI board console becomes navigable
**Complexity:** 4
**Tags:** cli, standalone, ux, usability

## User Review Required

None. The four defects and the expected behaviour were stated directly.

## Complexity Audit

### Routine
- Sorting the card list.
- Adding markers to `formatPlanLine`.

### Complex / Risky
- **`exitFlushed` is doing two different jobs and only one may change.** Some calls end an *interaction* (the operator declined, the list was empty); others end the *program* on a real failure (`HTTP != 200`, no running instance). Converting the wrong ones turns a hard failure into a silent loop. Classify all 20 individually — interaction-end becomes `return` to the caller; program-end stays.
- **Non-TTY and piped invocations must keep exiting.** The console is reachable only from a TTY path today, but a loop that never terminates without a TTY answer is a hang, not a bug report. The existing `process.stdin.isTTY` guard at `:1732` covers the menu; verify the console cannot be entered without one.
- **SIGINT is registered per-prompt** (`:1927-1931`) with `process.once` and removed after each `ask`. In a loop this registers and removes repeatedly — verify no listener leak across many iterations, and that Ctrl-C still exits the program immediately from any depth rather than merely popping one level.
- **`prompter.close()` is in a `finally`.** With a loop, the prompter must outlive the iterations and close exactly once on real exit; closing it inside the loop leaves subsequent `ask` calls reading a dead interface, which presents as the console silently exiting.
- **Sort stability with a manual order.** `columnOrder` is the board's own drag-ordering and may be null for cards never dragged. A sort that puts nulls first or last arbitrarily will reorder the board's list relative to the GUI. Decide the null placement deliberately and state it.

## Edge-Case & Dependency Audit

**Race conditions:** The board can change between renders. The console re-fetches per action today; a loop should re-fetch on each return to a list so a dispatched card's new column is reflected, rather than caching the first read for the session.

**Security:** None. Read paths and the dispatch call are unchanged.

**Side effects:** `formatPlanLine` is used by other CLI output paths. Adding markers there changes those too — either confirm that is wanted everywhere, or give the console its own formatter.

**Dependencies & conflicts:** None. `cli.ts` is standalone-only; the extension has no board console.

## Adversarial Synthesis

Key risks: (1) converting a failure `exitFlushed` into a `return`, so an HTTP failure silently re-renders the menu forever instead of reporting — mitigation: classify all 20 by hand, and verify a server stopped mid-session still exits non-zero; (2) closing the prompter inside the loop, which makes every prompt after the first return null and looks exactly like a clean exit — mitigation: an explicit test that navigates back and forth ten times; (3) sorting starred-first but ignoring `columnOrder`, so the CLI's order silently disagrees with the board the operator is looking at — mitigation: verification compares the CLI's order against the GUI column; (4) treating a typo as input validation and keeping the non-zero exit — in an interactive prompt a typo is not a caller error, it is a re-prompt.

## Proposed Changes

**1. A loop with a stack (`cmdBoardConsole`).**

Wrap the console in `for (;;)` as `cmdMainMenu` already is. Each sub-flow — browse, search, filter, fleet — returns to the console menu instead of exiting. The console's own `q`/Enter returns to the front-door menu when it was entered from there, and exits when invoked directly.

**2. `b` for back, everywhere, and typos re-prompt.**

Every prompt accepts `b` (back) and Enter, both returning one level rather than ending the process. An out-of-range or unparseable selection re-prompts with a one-line message; `exitFlushed(5)` is removed from the interactive path. Update each prompt's text — the current *"or Enter to exit"* is accurate today and must not survive the change that makes it false.

**3. Features separated from plans, and subtasks attributed.**

In a column listing, group features first under a `FEATURES` heading and plans under `PLANS`, using `isFeature`. Mark a plan that carries a `featureId` as a subtask of its feature. Give the console its own formatter rather than changing `formatPlanLine`'s other callers.

**4. Order by the board's own signals.**

Sort each list: starred first (`priorityStarred`), then the board's manual order (`columnOrder`), then complexity descending, then title. Show a star glyph and the complexity on each row so the order is legible rather than mysterious. State the null-`columnOrder` placement in a comment.

**5. Re-fetch on return.**

On returning to a list after an action, re-fetch rather than reusing the session's first read, so a just-dispatched card shows its new column.

## Verification Plan

1. Enter the board console, browse a column, press `b` at the card picker. The column list is shown again — the process is still running.
2. Press `b` again. The console menu is shown. Press `b` once more from a console entered via the front-door menu: the front-door menu is shown, not an exit.
3. Dispatch a card. The console returns to a list and the dispatched card shows its **new** column, proving the re-fetch.
4. Type `zzz` at a numbered prompt. A one-line message is shown and the prompt repeats. The process does not exit and `$?` is never 5.
5. Press Enter at every prompt in turn. Each returns one level; none ends the process except at the outermost level.
6. Ctrl-C from three levels deep exits the program immediately.
7. In a column holding both features and their subtasks, confirm features are listed under their own heading and subtasks are marked as belonging to a feature.
8. Star two cards in the GUI and re-enter the column. Both sort to the top, marked, and the remaining order matches the GUI column's order top-to-bottom.
9. Navigate in and out of lists ten times, then dispatch. The prompt still accepts input — the readline interface was not closed early.
10. Stop the server mid-session and choose a list. The console reports the failure and exits **non-zero** — a real failure is still a failure.
11. Regression: `switchboard plans`, `switchboard ready --json`, and `switchboard dispatch <id>` produce byte-identical output and the same exit codes as before.
12. Run the console with stdin piped rather than a TTY. It refuses with guidance and exits, rather than hanging on a prompt.

## Implementation Summary

Refactored `cmdBoardConsole` in `src/standalone/cli.ts` into a looping, navigable console interface. Added dedicated `formatConsoleCard` and `compareConsoleCards` functions to separate features from plans, attribute subtasks to their parent features, and sort cards by starred priority, manual column order, complexity descending, and title. Replaced exit calls on interactive branches with level returns (`b`/Enter) and typo re-prompting while preserving hard non-zero exits on server unreachable errors. Updated `doDispatch` to return numeric exit codes instead of unconditionally exiting, allowing dispatch actions within the interactive console to re-fetch and re-render board state.
