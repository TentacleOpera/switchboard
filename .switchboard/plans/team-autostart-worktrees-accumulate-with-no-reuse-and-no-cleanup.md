# Team Autostart Worktrees Accumulate With No Reuse and No Cleanup

## Goal

Stop a fresh branch and worktree being provisioned on every team autostart, with nothing reusing or removing them.

### Problem analysis

Both start paths — `startTeamForWorkspace` (`TaskViewerProvider.ts:13284`) and `startAgentGroupById` (`KanbanProvider.ts:5085`) — call `provisionTeamWorktree` (`:15313`), which calls `_createSafetyWorktree` and `addWorktree(..., 'team')` **unconditionally**. There is no lookup of an existing `tier='team'` row, and no removal on stop.

So a branch and a worktree accumulate per autostart, per window open. The board's existing worktree cards cover abandonment and git visibility — not accumulation.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 5
**Tags:** bugfix, devops

## User Review Required

**Yes — a lifecycle decision:** reuse an existing team worktree, or create per start and remove on stop. Both are coherent; they imply different cleanup semantics.

## Proposed Changes

### `provisionTeamWorktree` (`:15313`) and its two callers
- **Logic:** apply the recorded decision — either look up an existing `tier='team'` row before provisioning, or register removal on stop.
- **Edge case:** a worktree with uncommitted work must never be removed silently, whichever branch is chosen.

## Verification Plan

### Goal Invariants

1. Two consecutive autostarts of the same team do not produce two `tier='team'` worktree rows. *(Paired: a team that has never started still provisions one on first start.)*
