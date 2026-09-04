# Six Pieces of State and Code With No Reader, and Two Stores That Disagree

## Goal

Remove or reconnect six pieces of shipped state and code that nothing reads, and settle the agent-visibility key that two stores answer differently.

### Problem analysis

Six reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. Each is small. They are filed together because they are one class — something was built or written and its reader was removed, renamed, or never existed — and because two active features already own that class: *Delete the Dead Paths* and *Retire the state two removals left behind*.

Most of these belong on those features rather than as new cards. The exception is the last, which is a live disagreement rather than dead weight.

## Metadata

- **Complexity:** 3
- **Tags:** cleanup, dead-code, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Two database accessors with no production caller

`getActiveDispatchedByTerminal` (`KanbanDatabase.ts:10649`) and `getActiveDispatchedRowsByTerminal` (`:10712`) have no callers outside `src/test`. Every live call site uses the plural `getActiveDispatchedByTerminals`.

Belongs on *Delete the Dead Paths*.

### 2. Orphaned `kanban.blockedNotifyPacing` config rows

The only occurrence of the key anywhere in `src/` is a test asserting the name must **not** appear in the plan engine. No reader, no writer, no prune pass — and the rows are on disk in installs that once used it.

Not card-sized alone. Belongs inside *Retire the state two removals left behind*, which already owns the drop-on-read pattern for exactly this.

### 3. A third board-card builder that is dead and drops feature fields

Three builders exist: `_buildBoardCards` (`KanbanProvider.ts:2122`), the inline literal at `:4055-4076` which emits every field, and `_refreshBoardWithData` at `:4240` whose literal at `:4300-4322` **omits** `isFeature`, `featureId`, `subtaskCount` and `missionId`. A repo-wide grep finds no caller for the third.

Delete it, or route all three through the shared builder. Leaving a dead builder that drops feature fields is an invitation for someone to call it.

### 4. Duplicate manifests and an orphan icon

`manifest.json` and `manifest.webmanifest` are byte-identical (md5 matches across all four committed copies), and `LocalApiServer.ts:1684` tries both filenames while `:9362` routes both paths. `apple-touch-icon.png` is committed, identical in md5 to `icon-180.png`, and referenced nowhere outside a test comment.

Belongs on *Delete the Dead Paths*.

### 5. The halt-reason invariant is vacuous rather than met

`grep stopReason src/services/autobanState.ts` returns nothing, and `_stopAutobanEngine` survives only in three comments in `TaskViewerProvider.ts`. The anchor plan's invariant — "every self-stop carries a reason" — is unmet, not met: there is no self-stop to carry one.

One line either way, but it should be a recorded decision rather than a silently vacuous invariant. Pairs with the completion and supervision cards.

### 6. Two stores disagree about which agents are visible

Verified live on this machine. `~/.switchboard/integration-config.json` holds `agents.visibleAgents` with **22 roles**. The `kanban.db` config key of the same name holds **15**, missing exactly `orchestrator`, `phone_a_friend`, `project_manager`, `claude_designer`, `claude_artifacts` and `mcp_monitor`.

The database key is frozen — it stopped gaining roles when the global file became authoritative — and it is still readable, so whichever reader is asked determines the answer.

Note for whoever codes this: there is a **third** store. `PlanningPanelProvider.ts:7746` reads a `state.json` path for the same concept, with a silent catch. Find the last reader of each before retiring anything.

## Verification Plan

1. The two singular accessors are gone, or have a caller.
2. `kanban.blockedNotifyPacing` rows are pruned by the retirement pass, and the key appears in no live read path.
3. One board-card builder remains, or all three emit the same field set.
4. One manifest is served; `apple-touch-icon.png` is removed or referenced.
5. The halt-reason invariant is either implemented or deleted, with the choice recorded in the anchor plan.
6. One store answers agent visibility. The other two are retired, and a test asserts the retired keys have no reader.
