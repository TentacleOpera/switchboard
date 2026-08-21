# A tracker comment re-dispatches a column agent — retire the per-card trigger that no longer matches how these tools are used

## Goal

Remove the comment-driven dispatch path. Trackers are for bulk moves and queued work — checking a project while away, advancing cards into a column so teams work through them — not per-card micro-control. Comment-triggered re-dispatch is the wrong shape, ClickUp cannot do it at all, and the orchestrator instructions column replaces the one thing it was good for.

### Problem Analysis

`RemoteControlService:883` polls comments on tracked cards and calls `onComment(plan, body)`. That resolves to `KanbanProvider._remoteDispatchComment` (`:3077`), which:

1. Appends the comment into the plan file as `## Inbound Comment (<timestamp>)`.
2. Calls `_remoteDispatchColumnAgent` — `switchboard.triggerAgentFromKanban`, *the same command a manual drag uses*.

So a comment re-dispatches the whole column role. Not an incremental nudge to a running agent — a fresh dispatch. A comment on a card mid-code starts the coder again.

Three reasons to retire rather than extend it:

- **It is the interaction model these tools are not used for.** The value of a tracker here is advancing a batch of cards and letting teams drain the queue, and the staging path already states the principle: *"staging is mechanical, and no judgement belongs in the correctness path of the one mechanism whose value is having none."*
- **It cannot be made symmetric cheaply, and shouldn't be.** `ClickUpRemoteProvider.fetchCommentDeltas` (`:119-121`) returns `{ deltas: [], nextCursor: sinceCursor }` — a hardcoded stub. Building a ClickUp comment bus would be a third implementation of a design being retired.
- **Its useful case has a better home.** "Tell the system something from my phone" is served by the instructions column, which routes to the project-management layer, works identically on all three providers, and replies where the tracker's own notifications fire.

The polling machinery around it is well built — `authoredBySelf` against feedback loops, a capped seen-set in the DB `config` table against Notion's inclusive minute-rounded cursor, and at-least-once delivery that deliberately stalls the cursor on failure (`:909-912`). None of that is wasted work; it is the shape the instructions column should reuse. What is being retired is the *dispatch* it feeds, not the discipline.

### Root Cause

Comment dispatch was built when a comment was the only available write channel from a tracker, and per-card was the only granularity anyone had. Both premises changed: the queue made batching the point, and the orchestrator gave remote requests a place to go.

### Non-goals

- **Not removing comment polling wholesale** if the content path or any other consumer needs it. Retire the dispatch, and remove the poll only if nothing else reads it.
- Not building a ClickUp comment bus.
- Not removing already-appended `## Inbound Comment` sections from existing plan files.

## Metadata

**Complexity:** 3
**Tags:** remote-control, cleanup, providers

## User Review Required

None.

## Complexity Audit

### Routine
- Removing a dep implementation and its call site.

### Complex / Risky
- **This shipped and someone may rely on it.** Anyone using Linear or Notion comments to nudge agents loses that. It is the intended outcome, but it needs to be a stated removal with the replacement named, not a silent one.
- **Deciding the fate of the poll itself.** `comments` defaults to `true` in `RemoteConfig` (`:303`, `parsed.comments !== false`). If nothing consumes comment deltas after this, the poll, its cursor, and its seen-set are dead weight and a per-cycle API cost against every configured provider. If something does, the flag stays and only the dispatch goes.

## Edge-Case & Dependency Audit

- **Check every consumer of `fetchCommentDeltas` before removing the poll.** `RemoteControlService:883` is the only one found, but the seen-set and cursor keys (`remote.commentCursor.*`, `remote.commentSeen.*`) are persisted config that other code may read.
- **`comments: true` is a shipped default.** Removing the field must preserve unknown and legacy keys in the stored blob, per the same rule as its sibling plan.
- **Do not delete the guard patterns.** `authoredBySelf`, the capped seen-set, and cursor-stall-on-failure are the reference implementation the instructions column should follow. Retire the consumer, keep the lesson.
- `_remoteDispatchColumnAgent` is also called from the column-move path. **Only the comment caller goes.**
- The plan-file append is a separate behaviour from the dispatch. Decide explicitly whether an inbound comment still lands in the plan file as a record; appending without dispatching is defensible and cheap.

## Dependencies

- **Should land after the orchestrator instructions column**, so the replacement exists before the capability is removed. Shipping the removal first leaves a window with no remote write channel at all.

## Adversarial Synthesis

The tempting middle path is to keep comment dispatch for Linear and Notion and declare ClickUp permanently exempt. That preserves an asymmetry as a feature, keeps a per-card model the system is moving away from, and leaves two implementations to maintain for a channel with a better replacement. If the design is wrong, exempting one provider from it is not the fix.

## Proposed Changes

1. **Remove the comment-triggered dispatch** — the `_remoteDispatchColumnAgent` call in `_remoteDispatchComment`, and the `onComment` dep if the plan-file append is dropped with it.
2. **Decide and implement the append's fate** — either keep inbound comments as a plan-file record with no dispatch, or remove both. State which and why.
3. **Audit consumers of `fetchCommentDeltas`** and remove the poll, its cursor keys and its seen-set only if none remain.
4. **Remove ClickUp's stub** rather than leaving a method that satisfies an interface and does nothing, if the poll goes.
5. **Note the removal and name the replacement** where a user configuring remote control will see it.

### Migration

Behaviour removal on shipped functionality. Preserve unknown and legacy keys if `comments` leaves the config blob. Existing `## Inbound Comment` sections in plan files stay as historical record.

## Verification Plan

1. **A comment dispatches nothing.** Comment on a tracked Linear card and a tracked Notion card; confirm no agent is dispatched and no terminal is created.
2. **Column moves still dispatch.** Confirm `_remoteDispatchColumnAgent` still fires from the column-move path — the shared-caller regression fence.
3. **The append behaves as decided.** Confirm the plan file either records the comment or does not, matching the decision.
4. **No dead cursors.** If the poll is removed, confirm nothing reads `remote.commentCursor.*` or `remote.commentSeen.*`.
5. **Legacy config tolerated.** Load a blob with `comments: true` and an unrecognised sibling; confirm no crash and the sibling survives a write.
6. **The replacement works first.** Confirm the instructions column is functional before this lands.

## Outstanding Questions

None.
