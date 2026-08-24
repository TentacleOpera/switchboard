# Worktrees Consolidate to Two Models, and Streams Become a Stage Map

**Complexity:** 6

## Goal

Reduce four overlapping worktree models to the two the operator actually wants - per project, driven by the existing strip button, and per feature, driven by a STAGING toggle. Then change the Analyze pass from emitting the largest set that can start now to emitting a persisted stage map of ordered streams that run in parallel with each other, launched from the board.

## How the Subtasks Achieve This

- **Consolidate the worktree models: a STAGING toggle for features, the strip button for projects** — reduces four overlapping worktree models to the two the operator actually wants.
- **Mission cards: turn dispatch analysis into a stream map on a card** — changes the Analyze pass from emitting the largest set that can start now to emitting a persisted stage map of ordered streams that run in parallel, launched from the board.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Mission cards: turn dispatch analysis into a stream map on a card, launched from the board](../plans/staging-streams-parallel-dispatch-and-worktrees.md) — **PLAN REVIEWED**
- [ ] [Consolidate the worktree models: a STAGING toggle for features, the strip button for projects](../plans/worktree-models-consolidate-and-a-staging-toggle.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

Consolidate the worktree models first, so the streams work targets two models rather than four. The two plans cross-reference each other.

**Blocked on another feature, and known over-scoped.** The Mission cards subtask will be amended in place by the *Revise the in-flight plans for asserted completion* subtask of **Completion Is Asserted, Never Inferred** — dropping the stream_id and stream_seq schema it no longer needs, and recording a recommendation that its mission-card material be split out to the plans that now own it. That revision also states the subtask's complexity of 6 is stale afterwards. Do not code Mission cards until the revision has landed.

