# The Worktrees Tab Tells the Truth About Git

**Complexity:** 6

## Goal

Make the Worktrees tab reflect what is actually on disk. It never consults git worktree list, so a worktree it did not create is unreachable forever; and Abandon removes the checkout while leaving behind the branch and the Worktrees block in the feature file that still names the deleted path. Reconcile against git first, then let Abandon clean up the two things that outlive the checkout.

## How the Subtasks Achieve This

- **The Worktrees tab never looks at git** — reconciles the tab against git worktree list so it shows what is actually on disk, and lets Abandon act on a worktree that has no database row.
- **Abandoning a worktree removes the checkout and leaves everything that points at it** — cleans up the two things that outlive the checkout: the branch, and the Worktrees block in the feature file that still names the deleted path.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Abandoning a Worktree Removes the Checkout and Leaves Everything That Points At It](../plans/abandon-worktree-leaves-a-branch-and-a-stale-feature-block.md) — **PLAN REVIEWED** — ID: 48e6b307-2d8e-4f74-8f0a-bee08020d917
- [ ] [The Worktrees Tab Never Looks at Git, So a Worktree It Did Not Create Is Unreachable Forever](../plans/worktrees-tab-never-looks-at-git.md) — **PLAN REVIEWED** — ID: bf12d71f-ca27-48ef-b52b-b58a06d9df49
<!-- END SUBTASKS -->

## Dependencies & sequencing

Reconciliation lands first — it changes what Abandon can be handed, so the cleanup work should be written against the reconciled view rather than the database-only one. The two plans name each other.

The existing **Worktrees Tab Overhaul** and **Worktrees Tab UX Fixes** features are entirely CODE REVIEWED, so this is follow-on work rather than a duplicate home.

