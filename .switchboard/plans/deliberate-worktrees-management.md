# Deliberate Worktrees Management

## Goal

Replace the current ephemeral worktree feature with a deliberate worktrees management system. Users can explicitly create and manage worktrees via a dedicated tab, assign coder agents to specific worktrees, and cards are automatically routed to worktrees during bulk moves. Worktree context is written to plan files when moving to review, so reviewers handle merges as part of normal review.

## Metadata

- **Tags:** [workflow, git, ui]
- **Complexity:** 6

## User Review Required

- Confirm worktree naming convention (user-defined vs auto-generated)
- Confirm whether worktrees should be auto-cleaned after successful review or persist
- Confirm UI placement of worktrees tab (new tab vs subsection of existing tab)

## Sub-Plans

This plan has been split into three sequential sub-plans for coder agent accuracy:

| # | Plan | Complexity | Description |
|---|------|-----------|-------------|
| A | [deliberate-worktrees-a-cleanup-schema.md](./deliberate-worktrees-a-cleanup-schema.md) | 4 | Remove old worktree code + update DB schema. Prerequisite for B and C. |
| B | [deliberate-worktrees-b-tab-backend.md](./deliberate-worktrees-b-tab-backend.md) | 3 | Worktrees tab UI + management backend. Depends on A. |
| C | [deliberate-worktrees-c-routing-review.md](./deliberate-worktrees-c-routing-review.md) | 4 | Card routing + plan file context + optional cleanup. Depends on A and B. |

**Execution order**: A → B → C. Plans B and C cannot start until A is complete and verified.

## Pre-Work Completed

- `has_worktree` column dropped from both local databases (switchboard and gitlab) via direct SQL
- `kanban_meta` entries with `worktree_%` keys deleted from both databases
- No migration logic needed — old worktree feature was experimental/unused

## Success Criteria

- Old worktree code completely removed (no `hasWorktree`, `mergeWorktrees`, `worktreeCounts`, `openWorktreeForCoderAgents` references)
- Worktrees tab functional for creating/managing worktrees
- Cards round-robin assigned to worktrees during bulk moves
- Worktree context appended to plan files on review move
- Reviewer can handle merge from worktree context
- Optional cleanup after successful review
- `gitProhibitionEnabled` field preserved for role-config addon use
- Fresh database creation produces correct schema (no `has_worktree`, has `worktrees` table and `worktree_id`)

## Recommendation

**Complexity: 6 → Send to Coder** (per sub-plan: 4, 3, 4)

Each sub-plan is a focused, self-contained task that a coder agent can complete in a single session. The split ensures agents don't need to maintain excessive context across long-running tasks.
