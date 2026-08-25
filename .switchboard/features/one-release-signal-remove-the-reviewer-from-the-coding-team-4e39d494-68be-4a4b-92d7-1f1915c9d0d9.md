# One release signal: remove the reviewer from the coding team

**Complexity:** 6

## Goal

A coding team holds exactly one card, and exactly one fact releases it: the lead's completion post. A second release signal exists today — a card leaving its coding column frees the team while the previous card is still live work, so the lead starts its next subtask while a reviewer or a fix round is still editing the same worktree, landing in the same commit. This feature removes the reviewer seat from the coding team, which is the sole justification for the lead's card-movement exception, and removes board position and a stale holder name from the release decision.

## How the Subtasks Achieve This

- **The coding team has no reviewer seat:** rewrites the coding head prompt so the lead's
  only ending for a subtask is commit-then-post. Deletes the `POST /kanban/dispatch` /
  `targetColumn` call and the reviewer roster check, which makes the card-movement
  prohibition unconditional — the absolute form `teamWiring.ts:909` records as impossible
  while a reviewer seat existed to justify the exception.
- **A queued card has no holder; only completed_at releases a team:** removes board
  position from the in-flight predicate so nothing but the lead's completion post frees a
  team, and releases `dispatched_terminal` when a card returns to the queue so the holder
  fact means what it says. Without the second half, the escalation ladder deadlocks on the
  card it just re-staged.
- **Delete the head-prompt compat machinery for an unreleased surface:** removes fifteen
  frozen prompt snapshots and nine recognisers that migrate persisted team groups across
  revisions of a feature that never shipped. They constrain nothing and actively mislead —
  they read as proof the surface is released, so the next reader adds a sixteenth instead
  of editing the live text.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A queued card has no holder; only completed_at releases a team](../plans/one-release-signal-remove-the-reviewer-from-the-coding-team.md) — **CODER CODED**
- [ ] [The coding team has no reviewer seat](../plans/the-coding-team-has-no-reviewer-seat.md) — **CODER CODED**
- [ ] [Delete the head-prompt compat machinery for an unreleased surface](../plans/delete-head-prompt-compat-machinery.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

1. **The two behavioural subtasks run in parallel.** *The coding team has no reviewer seat*
   touches `teamWiring.ts` and `terminals.js`; *A queued card has no holder* touches
   `LocalApiServer.ts` and `KanbanDatabase.ts`. Zero file overlap — two seats, no worktree
   contention.
2. **They ship together.** The prompt change alone leaves the second release signal
   reachable by any other card mover; the predicate change alone leaves the lead with a
   card-movement path that now silently blocks rather than releases.
3. **The machinery deletion follows the prompt subtask.** It edits the same two files, so
   it cannot run concurrently with it.
4. **The machinery deletion is droppable.** Cutting it costs only that the next reader
   repeats the inference it exists to prevent.

## Team Dispatch Instructions

- **The coding team has no reviewer seat — Coder.** Acceptance: no `targetColumn` and no
  reviewer roster check survive in the live prompt; the extension and browser copies are
  byte-identical; the prompt states one ending with a subtask planId. Scope: prompt text in
  both copies — no predicate or migration changes.
- **A queued card has no holder — Lead Coder.** Acceptance: the in-flight predicate contains
  no column comparison; a queued card carries no `dispatched_terminal`; fail → re-stage →
  pop dispatches without a 409. Scope: predicate, holder release, `stillCoding`, and the
  three other `dispatched_terminal` readers.
- **Delete the head-prompt compat machinery — Coder, after the prompt subtask.** Acceptance:
  no `OLD_` / `PRE_` / `CURRENT_BUGGY_` prompt constant remains; the structural seed and
  `teamGroup` flag migrations still run. Note: `stage-marker-commit`,
  `standing-orders-marker` and `team-scoped-routing` are RED AT HEAD for unrelated reasons —
  record their pre-change output first, or a new failure is indistinguishable from the
  existing one.

