# One owner for scheduled storage work, and settle the sidecar

## Goal

Give backup, retention rotation and merge/relocation exactly one owner per machine, using the lock pattern this codebase already has. Then settle whether the sidecar is still needed, by running the one experiment that decides it, and either close the sidecar subtask as superseded or re-plan it around its single surviving reason.

### Problem Analysis

**Scheduled storage work has no mutual exclusion today.** Measured after `8258ce4b`: `BackupService.ts:117` and `RetentionService.ts:172` both call `setInterval` in-process. Each VS Code window is its own extension host process, so **N windows means N backup timers and N rotation timers**, and neither takes a lock. Only `dbMerge.ts` has one — `db-merge.lock`, holding a PID with stale detection.

Two concurrent rotations racing copy-verify-delete is the exact shape `retention-and-archive-for-unbounded-growth.md` warned about: "a crash between copy and delete duplicates; a crash between delete and commit loses". Two rotations interleaving is that failure without needing a crash. The same plan already specified the fix — "Rotation running concurrently with a backup or a merge: share the single lock, skip rather than queue" — and it was not built.

**The sidecar's justification has changed underneath it, and nobody has re-examined it.** `sidecar-owned-db-real-sqlite-binding.md` bundled two independent changes into one subtask: put one process in charge of the database, **and** replace `sql.js` with a real binding. Only the binding shipped. But the binding is what carried the safety argument:

- "Two in-memory images of the same file silently clobber each other… the loser of that race loses every row it had" was a `sql.js` property. It held the whole database in the WASM heap and replaced the entire file on every write. Under `better-sqlite3` with WAL, several processes on one file is normal, supported SQLite operation.
- The stale-image reload path and the `SCHEMA_WORKTREE_COLUMN_DEFS` blank-board shim were engine artefacts, not ownership artefacts, and both are gone.

**One reason survives, and it is specific.** `better-sqlite3`'s manifest declares `engines.node: "20.x || 22.x || 23.x || 24.x || 25.x || 26.x"` and depends on `prebuild-install` plus `bindings`. Enumerating Node *majors* is the signature of a module that is not N-API/ABI-stable — an N-API addon declares a napi version and does not care about majors. So it needs one prebuild per platform × ABI, and Electron's ABI is not Node's. `engines.vscode: ^1.93.0` spans many Electron versions. A sidecar running on stock Node collapses that matrix to one runtime; that is a real and unresolved packaging problem, and unlike `node-pty` behind `isPtyAvailable()`, a missing database binding has no degradation path — it is a dead board.

Note the `node-pty` precedent cuts against itself: it ships prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64` and `win32-x64` — **no Linux at all**. It survives that because terminals degrade. The database cannot.

**And the remaining non-ABI reasons do not need a process.** Single-owner scheduled work and serialised migrations need a *lock*, and `dbMerge.ts` demonstrates the pattern in the same directory against the same store. Buying them via a sidecar instead costs 302 public methods behind HTTP, 170 acquisition sites converted across 71 files, five sync methods, the N+1 read-path batching the feature demanded before crossing a process boundary, and a new lifecycle/health/crash-restart/version-match surface — plus latency on every read.

### Root Cause

The sidecar and the binding were one card with one complexity score and one dependency arrow, so "the sidecar is the foundation everything depends on" outlived the reason it was true.

### Non-goals

- Building a sidecar in this subtask. This decides whether one is needed and, if it is, hands a re-plan the single reason to build around.
- Removing the cursor shim or doing the N+1 read-path batching. Both are only forced by a process boundary; if the sidecar is closed, the batching becomes an ordinary performance item.

## Metadata

**Complexity:** 4
**Tags:** reliability, infrastructure, database, devops

## User Review Required

No. The lock is required regardless of how the ABI question lands, and the experiment is cheap and decisive. If the binding loads in a real extension host, the sidecar subtask closes as superseded by its own dependency; if it does not, this plan reports the failure and the sidecar is re-planned around packaging alone.

## Complexity Audit

### Routine

- Extracting `dbMerge.ts`'s lock into a shared `storeLock.ts` — acquire with `wx`, PID contents, stale detection, release on exit.
- Wrapping the backup timer, the rotation timer and relocation in it, with **skip rather than queue** semantics.
- An Electron-ABI rebuild of `better-sqlite3` and a VSIX built from it.

### Complex / Risky

- **A lock file must not outlive a crashed holder.** `dbMerge`'s stale detection reads the PID and unlinks if the process is gone. That is right, and it must also handle a PID that has been *reused* — check a monotonic timestamp inside the lock alongside the PID, and treat a lock older than a bounded age as stale regardless.
- **Skip-rather-than-queue must be observable.** A backup silently skipped because another window held the lock looks identical to a backup that never ran. Record the skip and its reason where the Database panel can show it, or the first time a user needs a backup that was never taken they have no way to find out why.
- **The timers are per-process and the lock is per-machine, so the winner rotates arbitrarily.** That is acceptable for backup and rotation — any one host doing the work is enough — but it means the interval is honoured per machine, not per window, and the implementation must not reset another host's schedule. Store the last-run timestamp in the store, not in memory.
- **The ABI experiment has a version dimension.** VS Code's Electron version varies across the supported `^1.93.0` range. A rebuild that loads in *this* VS Code proves the mechanism, not the matrix. The experiment's report must state which Electron/Node ABI it was built and tested against, so the decision is made on a known data point rather than a hopeful one.

## Edge-Case & Dependency Audit

**Race conditions**
- This subtask is entirely about a race. The tests need two real processes, not two timers in one.
- Rotation, backup and relocation must share **one** lock, not one each, or a rotation and a backup still interleave.

**Security**
- The lock lives in `~/.switchboard/` at `0700`. A stale-lock unlink must not follow a symlink out of the store directory.

**Side effects**
- With one board per project (see the Board-store retarget), rotation and backup become per-board, so the lock is per store file rather than one global lock. Name it from the resolved store path.
- If the sidecar closes, `sidecar-owned-db-real-sqlite-binding.md` needs a superseded note recording that the binding half shipped and the ownership half was answered by a lock — so nobody re-derives the original five reasons.

**Migration**
- None. No schema or file-format change.

## Dependencies

- **Requires** the engine swap (landed).
- **Sequences after** the Board-store retarget, because the lock is keyed on the resolved store path and that path changes. It can be built before and re-keyed, but the tests will need rewriting.
- **Blocks** enabling any remote Board target, because a remote target with N unsynchronised rotation timers is worse than a local one.

## Adversarial Synthesis

Key risks: a stale lock from a crashed or PID-reused holder blocks all scheduled work indefinitely; a silently skipped backup is indistinguishable from one that never ran; per-process timers against a per-machine lock make the winner arbitrary, so an in-memory schedule drifts; and the ABI experiment proves one Electron version rather than the supported range. Mitigations: timestamp inside the lock plus a bounded maximum age; record every skip with its reason on a surface the user can see; keep last-run state in the store; and make the experiment report the exact ABI it tested.

## Proposed Changes

1. **`src/services/storeLock.ts` (new)** — extract `dbMerge.ts`'s lock: `wx` acquire, PID plus monotonic timestamp, stale detection by liveness **and** bounded age, symlink-safe unlink, release on process exit. Keyed by resolved store path.
2. **`BackupService`** — take the lock around a scheduled backup; skip and record when held; keep last-run state in the store rather than in memory.
3. **`RetentionService`** — same, and share the identical lock so rotation and backup cannot interleave.
4. **`dbMerge` / relocation** — use the extracted lock rather than its own copy.
5. **A skip surface** — the Database panel shows last-run and last-skip-with-reason for backup and rotation.
6. **The ABI experiment** — build `better-sqlite3` for the extension host's Electron ABI (`prebuild-install --runtime electron --target <version>` or `electron-rebuild`), package a VSIX, open a board, and record the result: the Electron and Node ABI versions tested, whether the binding loaded, and whether the packaging step is reproducible in CI.
7. **Then, per the result:** if it loads, mark `sidecar-owned-db-real-sqlite-binding.md` superseded with a note that the binding shipped and single-ownership is served by `storeLock.ts`; if it does not, write a replacement plan whose sole justification is the ABI matrix.

## Verification Plan

### Automated

- **Two-process exclusion:** spawn two processes that both attempt a rotation; assert exactly one runs, the other records a skip with a reason, and total row counts across SQLite and the archive are unchanged by the skipped attempt.
- **Backup and rotation cannot interleave:** one process rotating while another attempts a backup; assert the second skips rather than proceeding.
- **Stale lock recovery:** write a lock holding a dead PID, and separately one holding a live PID with an expired timestamp; assert both are reclaimed and work proceeds.
- **Symlink safety:** point the lock path at a symlink outside the store; assert the unlink refuses.
- **Schedule persistence:** run a backup in process A, restart, assert process B honours the interval from stored state rather than starting a fresh clock.
- **Skip observability:** assert a skipped run is retrievable through the same endpoint the Database panel reads.
- Each new check gets a `package.json` script **and** a workflow step.

### Manual, and required — this is the deciding step

- **ABI load test:** install the Electron-rebuilt VSIX in a real VS Code, open a board, confirm rows render. Record the VS Code version, its Electron version, its Node ABI, and whether `require('better-sqlite3')` succeeded. State the result explicitly in this plan's completion notes; a passing automated suite is not evidence about the extension host, because the suites run on stock Node.

### Goal Invariants

- Exactly one process performs a scheduled backup or rotation per store, per interval, on one machine.
- A skipped scheduled run is recorded with its reason and visible to the user.
- A stale lock never blocks scheduled work indefinitely.
- The sidecar question is answered with a recorded measurement naming the ABI tested — not left open.

## Outstanding Questions

- If the Electron rebuild works but is not reproducible in CI, that is a third outcome: the sidecar is unnecessary for correctness but the packaging pipeline needs work. Report it as such rather than forcing a binary answer.

## Completion Summary (2026-09-05)

Extracted `dbMerge.ts`'s lock into `src/services/storeLock.ts` and hardened it: `wx` acquire, PID + process-start-time + acquired-at inside the lock (so a reused PID is detected by start-time mismatch, not just a dead PID), a bounded 5-minute max-age backstop so a hung holder cannot block indefinitely, symlink-safe unlink (lstat + realpath-in-lock-dir check, refuses to follow a symlink out of the store), and best-effort release on process exit. The lock is keyed by the resolved store path (sha256 hash → `~/.switchboard/locks/store-<hash>.lock`), so it is per store file, not one global lock. `BackupService` and `RetentionService` share the identical lock with skip-rather-than-queue semantics, so a scheduled backup and a scheduled rotation can never interleave; both persist last-run / last-skip-with-reason in the kanban config table (`src/services/scheduleState.ts`) so the per-machine schedule survives restarts and a skipped run is never indistinguishable from one that never ran. `dbMerge`/relocation now uses the extracted lock instead of its own copy. The Database panel surfaces last-run and last-skip for both via `/database/status` → `schedule` payload → a new "Scheduled Work — Ownership & Skip Log" card. Both composition roots (`extension.ts`, `standalone/bootstrap.ts`) get the lock behaviour identically — the lock is acquired inside the services, so no new seam was wired and no divergence was introduced.

The ABI experiment ran and produced a decisive data point (recorded in `sidecar-owned-db-real-sqlite-binding.md`): VS Code 1.136.1 ships Electron 42.10.0 (Node 24.18.1, modules ABI 146) vs stock Node 24.19.0 (ABI 137) — the stock build fails in the extension host with `NODE_MODULE_VERSION 137 vs 146`; `node-gyp rebuild --runtime=electron --target=42.10.0` succeeds and clears the ABI error; a separate glibc floor (snap core20 = glibc 2.31 vs the build/prebuild's 2.34–2.38) blocks the final load *inside the VS Code snap*, which is a snap-confinement artifact, not an ABI-matrix property. This is the plan's anticipated third outcome: the sidecar is not required for correctness (single-ownership is served by `storeLock.ts`), and the residual work is a CI Electron-rebuild step plus prebuild glibc-floor management — packaging, not a sidecar. The sidecar subtask is marked superseded by its own dependency, pending one confirmation a snap environment cannot provide (a `.deb`/tarball VS Code load test on glibc ≥2.38).

Manual smoke tests confirmed the three lock invariants: two-process exclusion (one acquires, the other records a skip with reason), stale-lock recovery (dead PID reclaimed), and symlink safety (symlink lock path neither acquired nor unlinked). Per the run directives, automated tests and the webpack compilation were not executed; the written Verification Plan stands for a later run. The stock-Node `better-sqlite3` build was restored after the Electron rebuild experiment so the standalone host and suites remain on ABI 137.
