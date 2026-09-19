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

**Decided 2026-09-15 by the operator: reuse.**

Look up an existing `tier='team'` worktree before provisioning. Removal-on-stop was rejected because
"stop" is not reliably observed — a crash, a closed laptop or a killed host leaks exactly what is
leaking today, so a cleanup path that depends on a graceful stop does not close the hole.

## Settled Design

- **Reuse:** `provisionTeamWorktree` looks up an existing `tier='team'` row for the team and returns
  it instead of provisioning a second.
- **No removal on stop.** Deliberate — see the decision above. A stale worktree persisting across
  restarts is the accepted cost, and is bounded at one per team rather than one per start.
- **A worktree with uncommitted work is never removed silently**, in any path this plan touches.

## Proposed Changes

### `provisionTeamWorktree` (`:15313`) and its two callers
- **Logic:** apply the recorded decision — either look up an existing `tier='team'` row before provisioning, or register removal on stop.
- **Edge case:** a worktree with uncommitted work must never be removed silently, whichever branch is chosen.

## Verification Plan

### Goal Invariants

1. Two consecutive autostarts of the same team do not produce two `tier='team'` worktree rows. *(Paired: a team that has never started still provisions one on first start.)*


## Scope correction (2026-09-19) — autostart is gone, the leak is not

The title and premise say **autostart**. There is no team autostart any more: the boot sweep
was removed by `teams-start-when-a-card-needs-them-not-at-boot`, and the
spawn-a-team-around-a-bare-head-role-terminal trigger is gone too (`findTeamForHeadRole` is
now reached only by the autoban dispatch-target lookup).

**The leak survives, on a different path.** `provisionTeamWorktree` is still called from
`startAgentGroupById` (`KanbanProvider.ts`) and from `TaskViewerProvider`, on every
EXPLICIT start of a team whose `worktreeMode` is `'auto'` — a fresh branch and worktree each
time, with nothing reusing or removing them. Re-title around that; the accumulation
analysis below stands unchanged.

**It got worse on 2026-09-19.** The guard is
`worktreeMode === 'auto' && !team.startWorktree`, and the per-team `startWorktree` text
field was removed from the Teams tab that day because it never did what it claimed (it was
read only as this negative guard, never as a spawn cwd, so typing a path silently suppressed
provisioning and left the team in the workspace root). With no way to set it, the
suppression can no longer be reached: an auto-mode team now provisions unconditionally on
every start. Any reuse/cleanup design has to carry that, or restore a control that actually
selects a worktree rather than one that only disables the feature.
