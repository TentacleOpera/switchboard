# Fix Refresh Storm + Self-Healing API Server & Terminal Registry

## Goal

Stop the extension host from wedging (requiring a manual reload) and make the local API server and terminal-agent tracking recover on their own after any host blip. Symptom as reported: "send to terminal" can't find the agent terminals and the API server is unreachable (no `.switchboard/api-server-port.txt`), fixed only by reloading the extension.

### Problem & Background (root-cause analysis)

The host was **not** dead — it was **pinned**. Dev-tools logs showed `_refreshRunSheets` firing continuously, each iteration reading the full board (958 cards: 762 in CODE REVIEWED) and posting `updateBoard` to the webview. The decisive evidence: the column distribution was **byte-identical on every iteration** (`{"CODE REVIEWED":762,"PLAN REVIEWED":58,"CREATED":7,"CODER CODED":1,"BACKLOG":27,"INTERN CODED":3}`) — nothing was changing, so this is a pure refresh *loop*, not card churn.

The VS Code extension host is single-threaded. A continuous full-board refresh loop starves everything else on that thread:
- `LocalApiServer` request handling never gets a turn → `/kanban/move` etc. time out; if the loop is hot during activation, `_startLocalApiServer()` may not complete, so the port file is never written (and its failure is swallowed at `TaskViewerProvider.ts:988`).
- Terminal lookups (which `await` host calls) are starved → "send to terminal can't find the agent terminals."

Both the API server instance and the `registeredTerminals` map (`extension.ts` module scope) are **in-memory singletons** with no persistence, so a reload (which re-runs `activate()`) is the only thing that clears it today.

Three concrete bugs were confirmed from the logs (the first is the loop's collateral, the others are independent):

1. **`exportStateToFile` had no mutex/debounce** (`KanbanDatabase.ts`, called fire-and-forget from every `_persist()`). Concurrent calls wrote the **same** `kanban-state-*.md.tmp` path and raced on `rename` → `ENOENT: ... rename 'kanban-state-backlog.md.tmp' -> 'kanban-state-backlog.md'`. (`_persist` already avoided this for the DB file with a crypto-random tmp suffix; the state export never got the same treatment.)
2. **Jules status poll ran unconditionally** (`TaskViewerProvider.ts:442` starts a 30 s `setInterval` in the constructor with no gate; `_refreshJulesStatus` spawns `jules remote list` before checking for any tracked sessions). With Jules uninstalled/unused, every tick logged `spawn jules ENOENT`.
3. **Host-level `[createInstance] aoe depends on UNKNOWN service agentSessions`** — this is **Antigravity IDE internal**, not Switchboard. Flagged for the IDE side; relevant only because Switchboard's terminal/agent tracking runs inside that host.

## Metadata

**Complexity:** 6
**Tags:** bugfix, reliability, backend, performance, devops
**Affves:** published extension, ~4,000 installs — changes touch hot paths; review + manual verification required.

## User Review Required

Yes. Before implementation, the user must:
1. **Confirm the Task 1 root-cause correction (instrumentation 2026-06-30):** the dominant driver is a **plan-mirror watcher loop** — `_setupPlanWatcher` `onDidCreate` → `_handlePlanCreation` (`:13484`) → `_syncFilesAndRefreshRunSheets` (the dominant frame) → `_rescanAntigravityPlanSources` / `_mirrorBrainPlan` rewrites `.switchboard/plans/*.md` → watcher `onDidCreate` → loop, with the 3 s/4 s self-write TTLs expiring under starvation. The epic-regeneration path (its `registerPendingCreation` guard at `:8331` IS in place) and the `_onPlanDiscovered → refreshIfShowing` path are secondary, **not** the dominant driver. The primary fix is therefore the **single-flight coalescing guard** (trigger-independent, provably stops the observed storm) plus a content-unchanged no-op on `_mirrorBrainPlan`; the `_regenerateEpicFile` no-op, TTL hardening, and `_reloadIfStale` mtime fix are secondary / defense-in-depth.
2. **Confirm the Task 2 scope change**: the EADDRINUSE port-increment sub-task has been **dropped** (the server binds port `0` — `LocalApiServer.ts:86` — so the OS assigns a free port and EADDRINUSE is structurally impossible). The remaining Task 2 work (visibility + watchdog + start-promise timeout) stands.
3. **Confirm the Task 3 scope change**: a terminal→agent persistence + activate-time re-adoption layer **already ships** (`extension.ts:1769` `_syncTerminalRegistryWithStateImpl` reads `runtime.terminals`; `extension.ts:2827-2837` persists role/friendlyName/pid/ideName/worktreePath; activate calls it at `:718`). Task 3 is reframed from "build it" to "verify it survives a host restart once the storm is fixed; add a mid-session re-claim trigger only if verification fails."

## Complexity Audit

### Routine
- The `_regenerateEpicFile` content-comparison no-op (Task 1 secondary — epic-path hygiene): a single `if (newContent === existingContent) return;` before `:8331`. The code already reads `existingContent` and builds `newContent` — the comparison is a one-line guard.
- The `_reloadIfStale` backwards-mtime fix (Task 1 tertiary): change `===` to `>` at `:4084` — a one-line guard.
- Removing the temporary `console.log` diagnostic at `TaskViewerProvider.ts:14928` once the driver is fixed.
- Adding a `_julesCliUnavailable` flag + `clearInterval` on `spawn jules ENOENT` (Task 4) — small, localized, reuses the existing cleanup pattern at `:18417`.
- Logging the API-server start failure to an output channel instead of swallowing it (`:988` → `:989` already `console.error`s; promote to a `createOutputChannel` like `_julesDiagnosticsChannel` at `:293`).
- The applied fixes (export single-flight, Jules gate) — already in `src/`, verify-only.

### Complex / Risky
- **Single-flight coalescing on `_refreshRunSheets`/`_syncFilesAndRefreshRunSheets` (Task 1 PRIMARY A — circuit-breaker):** ~11 awaited direct call sites (`:2623, :2679, :13529, :13567, :13581, :13681, :13702, :14764, :14817, :14914, :15047`) must observe a completed refresh, so the guard must **coalesce** (one trailing run; resolve waiters on the in-flight run's completion), NOT reroute callers through the fire-and-forget `refresh()` (`:2612`). Also re-entry-guard `_rescanAntigravityPlanSources` (`:12581`).
- **`_mirrorBrainPlan` content no-op + self-mirror `suppressFollowupSync` (Task 1 PRIMARY B):** skip the mirror write/unlink when on-disk content is byte-identical, and pass `suppressFollowupSync` from `_handlePlanCreation` (`:13484`) for self-mirror creates. Risk: must distinguish a self-mirror create from a genuine external plan create (use the existing claim-marker / `registerPendingCreation` path) — mislabelling a real external create as self would skip its ingestion.
- **`_regenerateEpicFile` content-comparison fix (Task 1 secondary — epic-path hygiene):** the comparison `if (newContent === existingContent) return` must cover the full generated content. The existing code already reads `existingContent` (`:8312`) and builds `newContent` (`:8321-8329`), so the comparison is straightforward — but the content includes the BEGIN/END SUBTASKS markers and surrounding epic prose, so a whitespace or encoding difference could cause a false non-match and still trigger a write. Verify the comparison is exact (same encoding, no trailing newline drift).
- **Self-write TTL hardening (Task 1 secondary):** extending the `_pendingCreations` TTL from 3s to 10s reduces the race window but doesn't eliminate it under severe starvation. A content-hash check in `_handlePlanFile` is more robust but adds per-event hash overhead. Must not broadly suppress `epics/**` — genuine external edits must still be ingested.
- **`_reloadIfStale` backwards-mtime fix (Task 1 tertiary):** changing `===` to `>` at `:4084` is a one-line fix, but must confirm no legitimate use case writes with an older mtime (e.g. a backup restore). The instance cache (`forWorkspace` `:806`) dedupes by resolved db path — a path-resolution divergence (mappings/symlinks/case) yielding two instances for one file is the likely source of the backwards mtime and must be investigated.
- **Identical-snapshot skip (Task 1 backstop):** hashing the effective snapshot and gating the `postMessage`/`refreshWithData` push. Must key the cache by `(workspaceId, projectFilter, repoScope)` so a context switch always re-pushes, and must not starve the ~15 auxiliary messages `refreshWithData` posts (`updateColumns`, `updateWorkspaceSelection`, `updateAgentNames`, `cliTriggersState`, `epicWorkflowModeState`, … at `KanbanProvider.ts:1291-1364`) — the skip only gates the data push, not the loop driver upstream of it.
- **API-server watchdog (Task 2):** must use in-process liveness signals (`this._localApiServer` non-null + a flag set in the `listen` callback + port-file existence), NOT a self-HTTP round-trip — a network probe on a starved host times out and produces a false negative, making the watchdog kill/restart a healthy server in its own loop.
- **Start-promise timeout (Task 2):** `LocalApiServer.start()` (`:77`) returns a promise that resolves in the `listen` callback (`:86`); if the host is starved so the callback never fires, the promise **never settles** and the port file is never written. Adding a timeout race is the real fix for the "no port file" failure mode.

## Edge-Case & Dependency Audit

- **Single-flight trailing run (applied):** the `finally` re-invokes `exportStateToFile()` only if a request arrived mid-flight, guaranteeing the latest state is always written exactly once after a burst. No lost final write.
- **Jules gate (applied):** if a user later dispatches to Jules, `tracked` becomes non-empty and polling resumes automatically — no toggle needed. The `finally` at `:17420` still clears `_isRefreshingJules` on the early return.
- **`_regenerateEpicFile` content comparison (Task 1 secondary):** the early-return on `newContent === existingContent` must happen BEFORE `registerPendingCreation` (`:8331`) so no pending-creation entry is set for a skipped write (otherwise a stale entry could suppress a later genuine external edit to the same file within the TTL window). The comparison is exact string equality — verify no encoding/normalization drift between the `readFile` (`:8312`) and the constructed `newContent` (`:8321-8329`).
- **Self-write TTL race (Task 1 secondary):** the 3s `_pendingCreations` TTL (`:42-44`) is the actual gap, not missing guard coverage. Extending to 10s reduces the window; a content-hash check in `_handlePlanFile` eliminates it. Either way, the primary fixes (single-flight guard + `_mirrorBrainPlan` content no-op) make this defense-in-depth, not load-bearing.
- **`_reloadIfStale` backwards mtime (Task 1 tertiary):** changing `===` to `>` at `:4084` means a backup-restore (older mtime) won't trigger a reload — acceptable, since the restored file would be picked up on the next genuine write or `fullSync`. Must investigate the path-resolution divergence that produces two `KanbanDatabase` instances for one file (the source of the backwards mtime).
- **Identical-snapshot skip (Task 1 backstop):** must compare *effective* snapshot (post repo-scope/project filter) and must still push after a workspace/filter switch — key the cache by `(workspaceId, projectFilter, repoScope)` so a context switch always re-pushes. **Clarification:** the skip is a structural safety net that breaks visible ping-pong on a static board and slashes DB-read cost, but it does **not** stop an upstream driver from spinning the host — label it a palliative, not a cure. The single-flight coalescing guard (Primary A) + the `_mirrorBrainPlan` content no-op (Primary B) are the cure.
- **Single-flight guard (Task 1):** awaited callers (`:13529, :13681, :14764`, etc.) must still observe a completed refresh. Coalescing must resolve waiters on the in-flight run's completion, not silently drop their await.
- **API watchdog (Task 2):** must not double-start; reuse a single start path with an `isListening` check. Port-file writes already use tmp+rename (`:982`) — keep that. The watchdog interval itself must be cheap (a boolean + `fs.existsSync`) and storm-proof.
- **Start-promise timeout (Task 2):** on timeout, reject with a clear error, log to the output channel, and let the watchdog retry — do not leave a dangling unsettled promise.
- **Terminal re-adoption (Task 3 — reframed):** the existing `_syncTerminalRegistryWithStateImpl` matches by PID then name with a cross-IDE gate (`:1816-1820`) so it won't adopt another IDE's terminals. `deactivate()` disposes registered terminals (`extension.ts:3639`); re-adoption reconciles with that on a clean reload. **Confirmed (web research):** VS Code standard shell terminals created via `vscode.window.createTerminal(TerminalOptions)` (the type Switchboard uses at `extension.ts:2797-2802`) survive an extension-host restart — the underlying PTY-host process is outside the extension host, so `vscode.window.terminals` is fully populated on re-activation and re-claimable by `name`/`creationOptions`. Only `ExtensionTerminalOptions` pseudoterminals freeze (Switchboard does not use these). `onDidOpenTerminal` does NOT fire for surviving terminals during restart sync, so activation must iterate `vscode.window.terminals` directly — which `_syncTerminalRegistryWithStateImpl` already does (`:1779`).
- **Migration:** no persisted-state schema changes except the existing `runtime.terminals` store (already additive). Per the migration rule, keep any new keys additive and tolerate their absence.

## Dependencies

- None in `sess_XXXXXXXXXXXXX — <topic>` format. This plan is self-contained; the only external input is the user-supplied instrumentation frame (Task 1, blocked step).

## Uncertain Assumptions

- None remaining. The VS Code terminal-survival question was confirmed via web research (see Edge-Case & Dependency Audit → Terminal re-adoption): standard shell terminals survive an extension-host restart and are re-claimable by name; Switchboard uses `TerminalOptions` (not pseudoterminals), so the existing re-adoption layer is sound.

## Adversarial Synthesis

Key risks: (1) The instrumentation (2026-06-30) confirmed the dominant driver is a **plan-mirror watcher loop** — `_setupPlanWatcher` `onDidCreate` → `_handlePlanCreation` (`:13484`) → `_syncFilesAndRefreshRunSheets` (the dominant frame) → `_rescanAntigravityPlanSources` / `_mirrorBrainPlan` rewrites `.switchboard/plans/*.md` → watcher `onDidCreate` → loop, the short self-write TTLs (3 s/4 s) expiring under starvation. The epic-regeneration path (guard at `:8331` IS in place) and the `_onPlanDiscovered → refreshIfShowing → _refreshRunSheets` path are real but secondary. The earlier "epic-regen no-op is THE cure" framing was wrong: the cure is the single-flight coalescing guard (trigger-independent) + a `_mirrorBrainPlan` content no-op; the epic no-op and TTL hardening are defense-in-depth. (2) Task 2's original EADDRINUSE handling was dead code — the server binds port 0; the real "no port file" cause is an unsettled start promise on a starved host, fixed by a timeout race. (3) Task 3 proposed rebuilding a terminal persistence + re-adoption layer that already ships; the terminal symptom is storm collateral. Mitigations: content-comparison no-op as the cure, TTL hardening + `_reloadIfStale` backwards-mtime fix as defense-in-depth, single-flight coalesce + snapshot-skip as structural backstops, start-promise timeout + in-process watchdog for the API server, and verify existing terminal re-adoption rather than reimplementing it.

## Already Applied (in this session — verify, then review)

These contained, high-confidence fixes were made directly in `src/` (source of truth):

1. **`exportStateToFile` single-flight + unique tmp suffix** — `KanbanDatabase.ts`:
   - Added `_exportStateInFlight` / `_exportStatePending` (`:5622-5623`); while one export runs, further calls set a pending flag and exactly one trailing export runs after (`:5717-5722`). Collapses the burst.
   - Per-column and board tmp files now use `crypto.randomBytes(4)` suffixes (`:5693, :5712`), so even concurrent writers can never collide on the same `.tmp` → eliminates the ENOENT-on-rename race.
2. **Jules poll gated on usage** — `TaskViewerProvider.ts` `_refreshJulesStatus` (`:17165`): early-return when `_getTrackedJulesSessions()` is empty (`:17174-17181` — no Jules sessions ⇒ never spawn the CLI). Confirmed the `_isRefreshingJules` reset is in a `finally` (`:17420`), so the early return is safe.
3. **Diagnostic instrumentation** — `TaskViewerProvider.ts` `_refreshRunSheets` (`:14928`): logs the immediate caller frame (`new Error().stack`). The frame that repeats names the storm's trigger. **Temporary — remove once the driver is fixed (see Task 1).**

## Proposed Changes (remaining)

### Task 1 — Fix the refresh-loop driver
**Status: CONFIRMED via instrumentation (2026-06-30).** The repeating `[refreshRunSheets] caller:` frames were **`_syncFilesAndRefreshRunSheets`** (dominant) and **`Timeout._onTimeout`** (the `refresh()` 200 ms debounce at `:2612`, re-armed continuously), with occasional `refreshUI`. The board was static the whole time (byte-identical column distribution), and the logs also showed `[KanbanProvider] _regenerateEpicFile` firing repeatedly plus `[KanbanDatabase] External modification detected (mtime 814 → 738)` with the mtime going **backwards** (a competing writer).

**Confirmed root cause — a PLAN-MIRROR watcher loop (traced end-to-end, 2026-06-30):**

The dominant `_syncFilesAndRefreshRunSheets` frame is produced by the **plan-file** watcher, not the epic path:
1. `_setupPlanWatcher` watches `.switchboard/plans/**/*.md` (`:10282`); `onDidCreate` → `_handlePlanCreation` (`:10297`).
2. `_handlePlanCreation` (`:13484`) calls `_syncFilesAndRefreshRunSheets` (`:13498, :13506`) unless `suppressFollowupSync` — **this is the dominant instrumentation frame.**
3. `_syncFilesAndRefreshRunSheets` (`:15058`) → `_rescanAntigravityPlanSources` (`:12581`) → `_mirrorBrainPlan`, which **writes mirror plan files into `.switchboard/plans/`** (and unlinks duplicates).
4. Those mirror writes re-fire the plan watcher's `onDidCreate` → back to step 2. **Loop.** The dedup guards are present but **starvation-fragile**: `_recentNativePlanCreations` (4 s, `:10293`) and `_pendingCreations` (3 s, `:42-44`). Once the host is pinned, the watcher callbacks are delayed past those TTLs, the guards expire mid-flight, and the self-mirror writes get re-ingested — sustaining the loop. (Confirm whether `_mirrorBrainPlan` rewrites files whose content is unchanged; if so, that is the specific write to suppress.)

**Secondary / separate paths (real, but NOT the dominant driver — this corrects the prior diagnosis):**
- **Epic regeneration:** `_regenerateEpicFile` (`:8297`) DOES call `registerPendingCreation(epicAbsPath)` (`:8331`) before writing — its self-write guard IS in place (same 3 s TTL caveat). It is invoked only from mutation paths (card moves, epic creation, subtask assignment: `:4739, :4807, :6619, :6689+`), not from the refresh path.
- **`_onPlanDiscovered` subscribers:** `KanbanProvider:481` → `refreshIfShowing` → `_scheduleBoardRefresh` → `refreshUI` → `_refreshRunSheets` (the occasional `refreshUI` frame); `ContinuousSyncService:76` → `_handleFileChange` (integration sync). Neither calls `_syncFilesAndRefreshRunSheets` nor `_regenerateEpicFile`.

**Secondary contributor:** `_reloadIfStale` (`:4084`) reloads on *any* mtime inequality — `if (currentMtime === this._loadedMtime) return` only checks exact equality, so a **backwards** mtime from a competing writer triggers a reload→resync churn on top. **Session trigger:** the burst of new epic/plan files created this session tipped a 958-card board into a sustained loop.

**Primary fix A — single-flight coalescing on the refresh/sync path (THE circuit-breaker):**
- Add a single-flight guard so `_syncFilesAndRefreshRunSheets` (`:15058`) and `_refreshRunSheets` (`:14925`) cannot overlap: while one run is in flight, coalesce further calls into exactly one trailing run and resolve awaited waiters on the in-flight run's completion. This is **trigger-independent** and provably stops the observed storm regardless of which write path feeds it. Do **NOT** reroute the ~11 awaited direct call sites (`:2623, :2679, :13529, :13567, :13581, :13681, :13702, :14764, :14817, :14914, :15047`) through the fire-and-forget `refresh()` (`:2612`) — that breaks their control flow.
- Also guard `_rescanAntigravityPlanSources` (`:12581`) against re-entry — it is the write step that feeds the loop.

**Primary fix B — break the mirror→watch→mirror cycle at the write:**
- Make `_mirrorBrainPlan` a no-op when the mirror file's on-disk content is byte-identical to what it would write (compare before writing/unlinking) — a redundant mirror then neither rewrites the file nor trips the plan watcher.
- Have `_handlePlanCreation` (`:13484`) pass `suppressFollowupSync` when the `onDidCreate` is the extension's own mirror write (reuse the mirror's claim-marker / `registerPendingCreation` path), so a self-mirror create does not trigger another `_syncFilesAndRefreshRunSheets`.

**Secondary fix — `_regenerateEpicFile` content no-op (epic-path hygiene):**
- In `_regenerateEpicFile` (`:8297`), return early — before `registerPendingCreation` (`:8331`) and the write — when `newContent === existingContent` (`:8312` vs `:8321-8329`). Good hygiene for the secondary epic-regen loop; not the cure for the dominant storm. Comparison must cover the full generated content (subtask section + surrounding epic prose) with no encoding/newline drift.

**Secondary fix — harden the self-write TTLs (defense-in-depth, BOTH guards):**
- The 3 s `_pendingCreations` (`:42-44`) and 4 s `_recentNativePlanCreations` (`:10293`) TTLs are too short under starvation. Extend them, or (better) add a content-hash check so a file unchanged since registration is skipped even after TTL expiry. **CAUTION:** suppress *only* the extension's own writes — never broadly ignore `plans/**` or `epics/**`, or genuine agent-authored plan edits stop ingesting (a real feature).

**Tertiary fix — stop spurious DB reloads:**
- In `_reloadIfStale` (`:4084`), reload only when `currentMtime > this._loadedMtime` (ignore equal *and* backwards mtimes) so a competing/older write can't trigger a reload→resync. Confirm `forWorkspace`'s instance cache (`:761-814`, `_instancesByDbPath` `:806`) truly dedupes to one writer per resolved db path — a path-resolution divergence (mappings/symlinks/case) yielding two instances for one file is the likely source of the backwards mtime.

**Backstop & cleanup:**
- Identical-snapshot skip in `refreshWithData`, keyed by `(workspaceId, projectFilter, repoScope)` — slashes DB-read cost and breaks visible ping-pong; palliative, pair with Primary A/B.
- Remove the temporary diagnostic `console.log` at `:14928` once the driver fix lands.

### Task 2 — Self-healing local API server
**File:** `TaskViewerProvider.ts` (`_startLocalApiServer` `:889`), `LocalApiServer.ts` (`start` `:77`).
- Stop swallowing the start failure at `:988` — log to a dedicated output channel (pattern: `_julesDiagnosticsChannel` at `TaskViewerProvider.ts:293`) and surface a status-bar indicator so a dead server is visible, not silent.
- **DROPPED — Handle `EADDRINUSE` by trying the next port:** the server calls `this._server.listen(0, '127.0.0.1', ...)` (`LocalApiServer.ts:86`); port 0 means the OS assigns a free port, so EADDRINUSE is structurally impossible. Do not build a port-increment loop for a condition that cannot occur.
- **ADD — Start-promise timeout:** `LocalApiServer.start()` resolves in the `listen` callback (`:86`); if the host is starved so the callback never fires, the promise never settles and the port file is never written. Wrap `start()` in a timeout race (e.g. 5 s) → on timeout, reject, log to the output channel, and let the watchdog retry. This is the real fix for the "no port file ⇒ manual reload" failure mode.
- Add a lightweight watchdog (interval or lazy check) that verifies the server is listening via **in-process signals** (`this._localApiServer` non-null + an `isListening` flag set in the listen callback + port-file existence) and `api-server-port.txt` matches; if missing/dead, restart and rewrite the port file. Do NOT use a self-HTTP round-trip — it times out on a starved host and produces false negatives.

### Task 3 — Re-adoptable terminal registry (REFRAMED — verify, do not rebuild)
**Files:** `extension.ts` (`registeredTerminals` `:249`, `_syncTerminalRegistryWithStateImpl` `:1769`, terminal persistence `:2827-2837`), `TaskViewerProvider` terminal tracking.
- **Already shipped:** terminal→agent associations are persisted to `runtime.terminals` (via `state.terminals` writes at `extension.ts:2827-2837` → `stateConfigBridge.ts:38` → DB config). On `activate()`, `_syncTerminalRegistryWithStateImpl` (`:1769`) re-adopts existing VS Code terminals by PID then name match with a cross-IDE gate (`:1816-1820`), called from `:718`.
- **Reframed work:** (1) Fix the refresh storm (Task 1) so terminal lookups are no longer starved — the "can't find agent terminals" symptom is storm collateral per the root-cause analysis. (2) Verify the existing re-adoption survives a real extension-host restart (force restart with agent terminals open → "send to terminal" still targets the right terminal without a manual reload). (3) Only if verification fails: add a mid-session re-claim trigger (e.g. re-run `syncTerminalRegistryWithState` on `onDidOpenTerminal` / a terminal-close reconciliation) — do not build a new persistence layer.
- Re-adoption must not adopt unrelated user terminals — the existing cross-IDE gate + name match already enforces this.

### Task 4 — Harden the Jules gate (follow-on to the applied fix)
**File:** `TaskViewerProvider.ts`.
- On a `spawn jules ENOENT` (detected at `:17612` in `_runJulesCli`), set a `_julesCliUnavailable` flag (does not yet exist — confirmed) and `clearInterval(this._julesStatusPollTimer)` (declared `?:` at `:291`; cleanup pattern already exists at `:18417`) so even stale tracked sessions can't reintroduce the spawn spam.
- Optionally probe for the binary once before starting the timer in the constructor (`:442`).
- Reset the flag if a user later dispatches to Jules (so polling can resume).

## Verification Plan

> Suite run separately by the user; extension can't be exercised in the planning session. No compilation or automated tests run in this session per directives.

1. **Export race (applied):** rapid board mutations no longer produce `ENOENT ... rename kanban-state-*.md.tmp`; state files still update to the latest board.
2. **Jules (applied):** with no Jules sessions, `spawn jules ENOENT` no longer appears in the dev console; dispatching to Jules resumes polling.
3. **Refresh driver (Task 1 — confirmed):** the instrumentation confirmed `_syncFilesAndRefreshRunSheets` and `_regenerateEpicFile` firing repeatedly on a static board. After the content-comparison fix in `_regenerateEpicFile`, `[KanbanProvider] _regenerateEpicFile: epicPlanId=...` logs stop appearing for unchanged epics (no `writeFile` call). After the `_reloadIfStale` fix, `[KanbanDatabase] External modification detected (mtime X → Y)` with backwards mtime stops triggering reloads. The identical-distribution `[refreshRunSheets] DB returned...` log stops repeating. With the snapshot-skip, a static board produces no `updateBoard`/`runSheets` post on repeated ticks.
4. **API self-heal (Task 2):** kill/restart the server or delete the port file at runtime → watchdog restarts it and rewrites `api-server-port.txt` without a reload; `create-epic.js`/`move-card.js` work again. Starve the host during `start()` → the timeout fires, the failure is logged to the output channel (not swallowed), and the watchdog retries.
5. **Terminal self-heal (Task 3 — reframed):** force an extension-host restart (Developer: Restart Extension Host) with agent terminals open → "send to terminal" still targets the right terminal without a reload. Confirmed viable: Switchboard's terminals are standard `TerminalOptions` shells (`extension.ts:2797`) which survive a host restart and repopulate `vscode.window.terminals`; the existing `_syncTerminalRegistryWithStateImpl` (`:1769`) iterates them and re-claims by name/PID match. Only if this verification fails, implement the mid-session re-claim trigger.
6. **Jules hardening (Task 4):** with stale tracked sessions and Jules uninstalled, the first `ENOENT` sets the flag and stops the 30 s interval; no further spawn attempts until a new Jules dispatch.

## Out of Scope

- The Antigravity host `agentSessions` error (IDE-internal; report upstream).
- Reducing board size / archiving the 762 CODE REVIEWED cards (separate housekeeping — though it would reduce per-refresh cost).
- Rewriting the webview render path.

## Recommendation

Complexity 6 → **Send to Coder.** The primary fix (content-comparison no-op in `_regenerateEpicFile`) is a small, high-confidence change that breaks the loop at its source. The TTL hardening and `_reloadIfStale` backwards-mtime fix are defense-in-depth. The single-flight guard + snapshot-skip are structural backstops. Task 2's visibility/watchdog/timeout and Task 4's Jules hardening are localized. Task 3 is verify-only (the persistence layer ships). All changes touch hot paths in a 4,000-install extension and need real manual verification.
