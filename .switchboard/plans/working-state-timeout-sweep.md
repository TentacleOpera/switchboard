# 20-minute working-state timeout sweep

## Goal

Guarantee an activity light always turns off eventually, even if an agent forgets (or is
unable) to write its `**Stage Complete:**` marker. In the 10-second periodic scan, clear the
working state of any card whose `dispatched_at` is older than 20 minutes.

### Core problem & root cause

The marker-based OFF-switch (`stage-complete-marker-clears-working-state.md`) depends on the
agent cooperating. Remote agents crash, get killed, or skip instructions. Without a timeout, a
single missed marker leaves a light stuck ON forever, eroding trust in the indicator. A
time-based sweep is the safety net that makes the light self-healing.

### Design

The watcher already runs a periodic scan every `_scanIntervalMs = 10000`
(`src/services/GlobalPlanWatcherService.ts:29`) via `_startPeriodicScan()` (`136-171`), with an
overlap guard (`_scanInProgress`, `152-153`) and a per-folder loop (`151-169`) that already
obtains a `KanbanDatabase.forWorkspace(workspaceRoot)` handle (`line 215`). Add one sweep step
after the folder loop (~`line 165`).

## Metadata

- **Project:** switchboard
- **Tags:** kanban, watcher, backend, reliability
- **Complexity:** 3

## Implementation

1. **Sweep query/method.** Add `db.clearStaleWorkingState(workspaceId, maxAgeMs)` that runs
   `UPDATE plans SET dispatched_at = NULL WHERE dispatched_at IS NOT NULL AND dispatched_at <
   ?` (cutoff = now − 20 min, compared as ISO strings, which sort chronologically). Return the
   count of rows cleared for logging.

2. **Call it from the scan loop.** In the `_startPeriodicScan` interval callback
   (`GlobalPlanWatcherService.ts:151-169`), after `_scanForNewFiles` / `_processManifest` per
   folder, call the sweep for that workspace. Latency to clear a stale light is ≤ one scan
   interval (~10s past the 20-min mark) — acceptable.

3. **Fire a board refresh only when something changed.** If `clearStaleWorkingState` returns
   `> 0`, fire the existing plan-changed notification so the board re-renders the now-off
   lights; if `0`, do nothing (avoid needless refreshes every 10s).

4. **Configurability.** Read the timeout from a setting (e.g.
   `switchboard.activityLight.timeoutMs`, default `20 * 60 * 1000`), mirroring how the scan
   interval is read from `switchboard.planWatcher.scanIntervalMs` (`line 144`).

## User Review Required

- Confirm 20 minutes as the default timeout (and expose it as a setting).

## Complexity Audit

### Routine
- A single bounded `UPDATE ... WHERE dispatched_at < cutoff`.
- One call added inside an existing interval loop that already has a DB handle and overlap
  guard.

### Complex / Risky
- **Refresh gating.** Firing a board refresh unconditionally every 10s would be wasteful and
  could fight in-flight UI updates; gate the refresh on `cleared > 0`.
- **Clock/timezone consistency.** `dispatched_at` (set in
  `working-state-model-and-dispatch-on.md`) and the cutoff must use the same format/zone (ISO
  UTC recommended) or the comparison misfires. Verify both write UTC ISO strings.

## Edge-Case & Dependency Audit

- **Dependency:** requires `dispatched_at` from `working-state-model-and-dispatch-on.md`.
  Complements `stage-complete-marker-clears-working-state.md` (marker clears early; sweep is the
  fallback).
- **Long-running legitimate work:** a genuine 25-minute agent run has its light cleared at 20
  min while still working. Mitigations to note (not necessarily build now): agents could
  re-touch `dispatched_at` via a heartbeat, or the timeout could be raised. Default 20 min is a
  deliberate "prefer a false-off over a stuck-on" trade — document it for the user.
- **Overlap guard:** the sweep runs inside the `_scanInProgress`-guarded callback, so it never
  overlaps itself.
- **Multi-workspace:** sweep must be scoped per `workspace_id` (the loop is already per folder).
