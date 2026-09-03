# Board Collapse 03 — Apply the Board and Panel Decisions

## Goal

Apply five of the sixteen signed conflict decisions: the Created column's button, the feature/subtask column rule, the query-kanban skill, Tickets persistence, and card ordering. Each is one commit.

### Problem analysis

Five places where two or three cards give different answers to one question about the board or a panel. The decisions were taken by the operator on 2026-09-04 and are not open for re-litigation. What remains is applying them: deleting the losing card, rescoping the winner, and recording the sequencing so a coder picking either one up cannot undo the other.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Rescoping preserves the plan id and filename.
3. **No git working-tree operation** while this runs. Commits are fine — one per decision.
4. Deleting a card uses the board's delete path so the `.md` goes with it.
5. Do not touch `src/`.

## Metadata

- **Complexity:** 5
- **Tags:** board-hygiene, kanban, tickets, plans

## Proposed Changes

### Decision 1 — the Created column's blank-feature button

**Signed: the explicit button wins.** A manual action beats a mode switch on a dispatch surface; the toggle also rides the batch-move path that silently preempts fan-out when the dispatch came from a custom user prompt.

- Keep *Replace the Created Column's Blank-Feature Button with an Explicit "Send N plans to planner team"* (`46eafd1c`).
- Delete *Repurpose Created Column's Blank-Feature Button as a Planner Fan-Out Toggle for Batch Move* (`847915da`). It already declares itself mutually exclusive with `46eafd1c`.
- Its sibling *Remove STAGING column gate — allow drag-back from any column* is unrelated to the choice; detach it to a loose plan in Planned.
- Feature *Batch Entry Into a Queue* then has no subtasks. Remove it.
- Verify the surviving plan still resolves the planner pool via `getRoleTerminalSet('planner', root, { allowPtyFleet: true })`; that correction came from the deleted card and must not be lost.

### Decision 6 — a subtask's column is its feature's column

**Signed: one rule, one reconcile.** Aligning subtasks to the feature, never demoting a feature at startup.

- *Every Feature Move Carries Its Subtasks* keeps the single startup reconcile and the cascade delegation. Unchanged.
- *Feature Creation Can Produce a Column-Mixed Feature* — keep the creation-time rule (a new feature starts at its least-advanced plan's column; groupings across the coding boundary are refused). Delete its one-shot startup pass and the `feature_column_reconcile_v1` config flag; those duplicate the sibling's reconcile with the opposite resolution rule.
- *A Subtask's Column Is Its Feature's Column* — keep the exported predicate, the handler-layer refusal in both hosts, and the loose-work exclusion. Delete its own "reconcile before enforcing" pass.
- *Auto-Column Feature-Scoped Subtasks to PLAN REVIEWED on Import* — rewrite to one rule: **a newly linked subtask adopts its feature's current column, never a named one.** The common case is a plan reviewer adding a subtask to a Planned feature, and it must start in Planned alongside it; the same code puts a subtask added to a New feature in New. Move the card into *Board State Integrity* via `assign-to-feature.js`.
- Feature *Eliminate Manual Card Moves* is then left with only the SQL guardrail, which Board Collapse 05 deletes. Remove the feature after that lands, or now if 05 has already run.
- Record the landing order in the *Board State Integrity* feature file: cascade and reconcile, then the refusal, then creation-time resolution, then the import hook.

### Decision 13 — the query-kanban skill

**Signed: both, in order.** Correction to an earlier reading: the label plan pins the **label-to-id table**, not a SQL table, and every agent needs that table whichever way it reads the board.

- *Three skills instruct agents to use POSIX-only tooling* lands first and removes the SQL templates in favour of the Node helper and the board endpoint.
- *The column label→id mapping is a hand-copy that has drifted* lands second. Rescope it to re-anchor on the rewritten file (its current line citations will be stale), keep the corrected table and its contract test, and delete any wording that presents the storage ids as values for a SQL `WHERE` clause. Both `.agents/` and `.claude/` copies are edited directly per Board Collapse 02.
- Add the sequencing note to both plans.

### Decision 15 — Tickets persistence

**Signed: one state mechanism, the host store, wired once.**

- Merge *Tickets Tab Source Selection Not Sticky Across Restarts in Browser/Standalone* into *Give `tickets.root` a single source of truth*. They fix the same broken `restoredTabState` push and the same `persistTabState` arm from two different features. Carry across the merged plan the detail worth keeping: embed the restored state in the `rootsFetched` HTTP body so the standalone browser path gets it without a separate push.
- Delete the merged-away card; the feature *Tickets Panel: Title, Description, Sync Badge and Source Selection* drops to three subtasks.
- Rescope *Wire the Tickets sidebar collapse toggle* to persist through the host store, per root, once the push exists. Delete its `vscode.setState` persistence and its instruction forbidding a `persistTab` write "for later" — that instruction was written against the gap the sibling closes.

### Decision 16 — one comparator for render and optimistic moves

**Signed: the optimistic insert calls the same column comparator the render uses.**

At HEAD `moveCardElements` already carries a second hand-rolled rule — queue position when the target is STAGING, timestamp everywhere else — that knows nothing of the priority order-by shipped in `4df54319`, the star, or the creation-date rule being added. The optimistic star plan proposes a third copy.

- *Kanban card jumps to middle on copy-prompt advance* — keep the timestamp bump (still needed so the card's data matches the backend and the position signature changes); replace its insert-by-timestamp walk with the shared comparator.
- *Fix Created Column Sort — Use createdAt* — comparator change only; it inherits correct optimistic placement.
- *The Priority Star Applies Optimistically* — delete its private repositioning routine from the plan; it uses the same shared routine.
- In feature *Two Kanban Sort Defects*, replace "no ordering constraint" with "comparator extraction first", and delete the stale note that both must land before the priority-star work — that shipped.

## Verification Plan

- Five commits, one per decision, each reversible alone.
- The board carries no card proposing a planner fan-out toggle, and no feature named *Batch Entry Into a Queue*.
- Exactly one active plan proposes a startup reconcile of feature/subtask columns.
- The import-hook plan's text names no specific column.
- `GET /kanban/plans?planId=` for the tickets collapse toggle returns a plan whose text no longer contains `vscode.setState`.
- No active plan proposes its own card-repositioning routine; all three name the shared comparator.
- `git status` shows only `.switchboard/` changes.
