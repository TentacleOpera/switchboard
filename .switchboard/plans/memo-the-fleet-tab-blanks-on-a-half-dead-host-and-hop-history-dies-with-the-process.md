# The Fleet Tab Blanks on a Half-Dead Host, Hides Its Own Staleness, and Loses Hop History on Restart

## Goal

The Fleet tab must distinguish "the board is unreachable" from "the pty host is down", must show how old its data is, and must not be the only record of why a hop fired.

### Problem analysis

Three reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. One surface, and the first two compound: the tab hides the information that would explain what it is showing.

## Metadata

- **Complexity:** 4
- **Tags:** shell, fleet, hops, bugfix

## User Review Required

None. Change 3 is a schema addition and is the largest of the three.

## Proposed Changes

### 1. A live board with a dead pty host reports the board unreachable

`refreshFleetTab` (`shell.js:558-583`) has a single guard:

```js
if (!termRes || termRes.status !== 200 || !hopRes || hopRes.status !== 200) { renderFleetOffline(); return; }
```

Both `ptyListTerminals` and `getHopState` must return 200 or the tab renders nothing.

`renderFleetOffline` then sets the three hop-reason spans and hides `#dock-fleet-content` — **the div those spans live inside** (`shell.html:702` wraps `:722`). So the reasons it just wrote are hidden by the same function, and the operator is left with "No running Switchboard instance reachable for this workspace."

That message is false in the case that matters: the board is running, the pty host is not. Degrade per source rather than all-or-nothing, and do not write into a container you are about to hide.

### 2. `evaluatedAt` is served and never rendered

`getHopState` returns `getHopFullState` verbatim (`TaskViewerProvider.ts:3599-3601`), which carries `evaluatedAt` (`:28098`). `grep -c evaluatedAt src/webview/shell.js` returns 0.

With a 60-second poll, the tab can be a minute stale with nothing on screen saying so — and staleness is exactly what an operator needs to know when deciding whether a hop has stalled. Render it.

### 3. Hop reasons and the feed die with the process

`_hopLastReasons` and `_hopFeed` are plain instance fields capped at 50 entries (`TaskViewerProvider.ts:1818`, `:1826`, `:27997`). No hop table exists in `KanbanDatabase.ts`.

So the only record of why a hop fired or stopped is in memory, capped, and gone on restart. Anyone asking "why did this hop run last night" has no answer.

This is a schema addition rather than a render fix, which is why it is the largest of the three and can land independently of the other two. Take the next free migration version at implementation time; do not reserve one.

## Verification Plan

1. Stop the pty host with the board running. The Fleet tab reports the pty host down and still renders board-derived state; it does not claim the board is unreachable.
2. The hop reason spans are visible in the degraded state, not written into a hidden container.
3. The tab shows how old its data is, and the value moves as the poll runs.
4. Hop reasons survive a restart and can be read back for a period longer than 50 entries.
