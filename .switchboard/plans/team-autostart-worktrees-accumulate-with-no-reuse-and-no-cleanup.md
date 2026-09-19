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

## Decision (2026-09-19) — narrowed to one problem; the accumulation belongs elsewhere

This card was carrying two unrelated things. Split:

**KEEP, and it is now the whole card:** a team whose `worktreeMode` is `'auto'`
provisions a **fresh branch and worktree on every explicit start**, and nothing
reuses the one it made last time. `provisionTeamWorktree` is called unconditionally
from `startAgentGroupById` and from `TaskViewerProvider` once the mode is set, so
starting the same team three times leaves three checkouts. Re-title around
"every start", not "autostart" — autostart does not exist.

Re-verified 2026-09-19: **no team on this board sets `worktreeMode: 'auto'`**, so the
defect is currently dormant. It arms itself the first time an operator ticks the box
in the team editor, which is also the first time they would notice — the trap is that
nothing warns them, and the field that used to double as a suppression
(`startWorktree`) was removed the same day because it never worked as a spawn cwd.

**DROP — it is not this card's problem:** the worktree rows piling up on this board
were NOT produced by team provisioning. Measured: 17 rows in the `worktrees` table,
**every one pointing at a path that does not exist**, all `status: 'abandoned'`, and
all of them macOS paths (`/Users/patrickvuleta/Documents/GitHub/worktrees/...`) that
arrived in a board transfer. Git knows about one real worktree here. That is a
board-versus-git reconciliation problem and it is already covered by
`bf12d71f` / `d7a048e6` — see the note added to `bf12d71f`.

Coding this card should therefore touch reuse-on-start only, and leave the existing
rows alone.
