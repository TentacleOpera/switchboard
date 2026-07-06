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
(`src/services/GlobalPlanWatcherService.ts:30`) via `_startPeriodicScan()` (`137-172`), with an
overlap guard (`_scanInProgress` at line 153). The interval callback runs **two** per-folder
loops: `_scanForNewFiles(folder)` (157-159) then `_processManifest(folder)` (164-166). Add a
**third** per-folder sweep loop after the manifest loop (after line 166). Each iteration
obtains its own DB handle via `KanbanDatabase.forWorkspace(folder)` + `ensureReady()` +
`getWorkspaceId()` (mirroring `_handlePlanFile` at 452-469) — do not assume a handle is
already open for the folder.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, watcher, backend, reliability
- **Complexity:** 3

## Implementation

1. **Sweep query/method.** Add `db.clearStaleWorkingState(workspaceId, maxAgeMs)` that runs
   `UPDATE plans SET dispatched_at = NULL WHERE dispatched_at IS NOT NULL AND dispatched_at <
   ?` (cutoff = now − 20 min, compared as ISO strings, which sort chronologically). Return the
   count of rows cleared for logging.

2. **Call it from the scan loop.** In the `_startPeriodicScan` interval callback
   (`GlobalPlanWatcherService.ts:152-170`), after the two existing per-folder loops, add a
   third `for (const folder of folders)` loop that acquires a DB handle and calls
   `clearStaleWorkingState(workspaceId, maxAgeMs)` for that workspace. Latency to clear a
   stale light is ≤ one scan interval (~10s past the 20-min mark) — acceptable.

3. **Fire a board refresh only when something changed.** If `clearStaleWorkingState` returns
   `> 0`, fire `this._onPlanDiscovered.fire({ uri: vscode.Uri.file(folder), workspaceRoot:
   folder })` for that workspace — `KanbanProvider` subscribes at `KanbanProvider.ts:535` →
   `refreshIfShowing(workspaceRoot)` (536), so this re-renders the now-off lights. If `0`, do
   nothing (avoid needless refreshes every 10s).

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

## Dependencies

- Requires the `dispatched_at` column from `working-state-model-and-dispatch-on.md` (B-1).
- Complements `stage-complete-marker-clears-working-state.md` (B-2): the marker clears the
  light early when the agent cooperates; this sweep is the authoritative backstop when it
  doesn't. Both converge on the same write (`dispatched_at = NULL`).

## Proposed Changes

### src/services/KanbanDatabase.ts
- **Context:** owns `dispatched_at` (added by B-1).
- **Logic:** add `clearStaleWorkingState(workspaceId, maxAgeMs): Promise<number>` running
  `UPDATE plans SET dispatched_at = NULL WHERE workspace_id = ? AND dispatched_at IS NOT NULL
  AND dispatched_at < ?` (cutoff = `new Date(Date.now() - maxAgeMs).toISOString()`); return
  `getRowsModified()` for the refresh gate. Use `_persistedUpdate`-style execution.
- **Edge cases:** ISO-UTC string comparison sorts chronologically only if `dispatched_at` was
  written as UTC ISO (B-1 must write `new Date().toISOString()`, which is UTC `Z`-suffixed);
  scope by `workspace_id` so multi-workspace boards don't cross-clear.

### src/services/GlobalPlanWatcherService.ts
- **Context:** `_startPeriodicScan` interval callback (152-170) already loops folders twice.
- **Logic:** add a third per-folder loop (after line 166) that gets a DB handle
  (`KanbanDatabase.forWorkspace(folder)` + `ensureReady()` + `getWorkspaceId()`), reads the
  timeout from `switchboard.activityLight.timeoutMs` (default 20 min), calls
  `clearStaleWorkingState`, and fires `_onPlanDiscovered.fire({ uri: vscode.Uri.file(folder),
  workspaceRoot: folder })` only when the cleared count > 0.
- **Edge cases:** runs inside the `_scanInProgress` guard so it never overlaps itself; a
  just-dispatched card (< 20 min) is never in scope; gate the refresh on `> 0` to avoid
  10-second needless re-renders.

### package.json (setting)
- **Logic:** declare `switchboard.activityLight.timeoutMs` (number, default 1200000) in the
  configuration contributions, mirroring `switchboard.planWatcher.scanIntervalMs`.

## Adversarial Synthesis

Key risks: (1) clock/timezone mismatch — if `dispatched_at` and the cutoff are not both UTC
ISO strings, the `<` comparison misfires and lights either never time out or time out
instantly; mitigation is to write/read only `new Date().toISOString()` on both sides. (2) the
sweep is a 10-second background write on the shared sql.js handle — a long-running genuine
agent (25 min) has its light cleared at 20 min while still working; this is a deliberate
"prefer false-off over stuck-on" trade that should be documented to the user, with the timeout
exposed as a setting. (3) firing the refresh unconditionally would fight in-flight UI updates
every 10s — the `> 0` gate is mandatory.

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX.

### Manual checks
- Dispatch a card (light ON) and do NOT write a marker → confirm the light turns OFF within
  ~20 min + one scan interval (~10s) with no agent action.
- Set `switchboard.activityLight.timeoutMs` to a small value (e.g. 30s) → confirm a dispatched
  card's light clears at ~30s+10s, proving the setting is honored.
- Confirm a card that gets a `**Stage Complete:**` marker before the timeout clears via the
  marker (B-2), not the sweep (no double-work — both null the same column).
- Confirm no board flicker every 10s when no lights are stale (refresh gated on `> 0`).
- In a multi-workspace setup, confirm a stale light in workspace A is cleared without
  affecting workspace B.

### Recommendation
Complexity 3 → **Send to Intern.**
