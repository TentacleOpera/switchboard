# Parallel feature-worktree runs: create, monitor and merge back a batch

**Complexity:** 8

## Goal

Let an operator take a batch of features off the board, run each in its own worktree with a coder and a reviewer, monitor them all from the Terminals panel, and merge the batch back once reviewed.

Today none of that flow is usable end to end. Worktree creation is one feature at a time; the agent terminals it seats are created as VS Code terminals regardless of where the operator is working, so they never appear in the browser cockpit and cannot be grouped by worktree; and there is no batch merge path at all.

The blocking prerequisite is surface-aware terminal routing: creation and prompt delivery must target whichever surface the operator is actually on, in either host, guarded by a ratchet so the rule stops regressing. Bulk creation and bulk merge-back sit on top of it.

## How the Subtasks Achieve This

- **Agent Terminals Must Open on the Surface the Operator Is Actually Using**: makes terminal creation and prompt delivery resolve the operator's active surface instead of hardcoding `vscode.window.createTerminal`, so worktree agents appear where the operator is looking — the VS Code panel, the standalone cockpit, or the browser cockpit backed by the extension. Also adds the ratchet guard and a two-surface contract test, so the rule is enforced mechanically rather than restated. Because autoban terminals and worktree terminals both flow through `_createAutobanTerminal`, this single change fixes both. Nothing else in the feature is usable until this lands.
- **Split a Board Selection of Features into Worktrees in One Action**: turns the existing one-at-a-time worktree creation into a bulk action over a board multi-select, seating a coder and a reviewer per tree rather than the full agent set. This is the setup half of the workflow — the friction that currently makes the whole topology unattractive to use.
- **Merge a Batch of Reviewed Feature Worktrees Back in One Pass**: the closing half. Extends the existing single-worktree merge prompt to an ordered queue over N trees, in a verify mode (the agent reads each plan file's appended review outcome first) and a trusted mode (the operator asserts the batch is good). Reuses the existing hierarchy resolution so subtask branches still converge into their feature integration branch instead of landing on main.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Split a Board Selection of Features into Worktrees in One Action](../plans/bulk-create-feature-worktrees-from-board-selection.md) — **CREATED**
- [ ] [Merge a Batch of Reviewed Feature Worktrees Back in One Pass](../plans/bulk-merge-back-reviewed-feature-worktrees.md) — **CREATED**
- [ ] [Agent Terminals Must Open on the Surface the Operator Is Actually Using](../plans/route-agent-terminals-to-the-active-surface.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Surface routing is a hard blocker for bulk creation.** Built on today's behaviour, the bulk-create button would produce twelve VS Code terminals and an empty cockpit — the reported single-worktree failure, six times over. Bulk creation's own plan file declares this prerequisite explicitly; do not start it first.

**Bulk merge-back is not blocked by either of the others.** It operates on worktrees that exist, however they were created, and does not depend on which surface their terminals live on. It is listed third because that is the order the workflow runs in, not because it is gated. It can be built in parallel with the other two.

**Shared external dependency:** bulk creation needs `createWorktreeForFeature` extracted from its `case` in `KanbanProvider.ts` into a callable provider method. The separate plan *"Dispatch analysis should recommend (and be able to create) per-feature worktrees when candidates are too entangled"* — which is **not** part of this feature — specifies the same extraction for its `POST /worktree/feature` route. Whichever lands first performs the extraction; the second consumes it and skips its own step. Doing it twice produces two implementations of worktree creation, which is the specific outcome that plan warns against.

**Suggested order:** surface routing → bulk creation → bulk merge-back, with bulk merge-back pulled forward if a second coder is free.

