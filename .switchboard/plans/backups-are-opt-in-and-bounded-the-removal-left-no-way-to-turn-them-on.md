# Backups Are Opt-In and Bounded — the Removal Left No Way to Turn Them On

## Goal

Scheduled backups exist, default **off**, can be turned **on**, are bounded by **bytes** rather than by
a count of whole-database copies, and never duplicate backup coverage the operator already has. A
crashed backup collects itself.

### Problem analysis

**Backups have demonstrated value on this machine.** On 2026-09-14 the board database was corrupted,
and recovery required comparing it against the sets in `~/.switchboard/backups/`. That is the case
*for* the feature, and it is why this plan is not "delete the backup system". The defect was never
that backups exist — it was that they were **automatic, unrequested, unbounded and unswitchable**.

**The removal overshot.** *The Board Takes an Hourly Backup Nobody Asked For* set out to make local
scheduled backups "off unless the operator turns them on". What shipped (`d20c399f`, 2026-09-09) was
the deletion of `startScheduledBackups` outright. The result is not opt-in — it is **absence**:

- `startScheduledBackups` exists nowhere in `src/`.
- There is **no configuration key** for it. `package.json`'s only backup-shaped key is
  `switchboard.notionBackup`, which governs something else.
- So an operator who — after a corruption incident — decides they *do* want scheduled local backups
  has no way to say so.

The plan's goal had two halves, "off by default" and "turnable on". Only the first shipped.

**The retention design is still the one the plan called wrong, just currently unreachable.**
`BackupService` retains `_maxHourly + _maxDaily`, defaulting to `24 + 7` — **31 whole-database
snapshots** (`:78-79`, `:658` "Count-based retention pruning"). At the observed ~44 MB per set that is
~1.4 GB of steady state. Nothing schedules today, so it does not bite; the moment anything does, or if
operator-initiated backups accumulate, it bites exactly as before.

**Do not duplicate coverage the operator already has.** A whole-file copy of the database onto the
same disk is the weakest form of backup available: it does not survive disk failure, and it is
redundant on any machine already running snapshots, Time Machine, `restic`/`borg`, or a NAS target. On
a Pi it is actively harmful — the original plan measured 18.3 GB written in 13 hours of ordinary
operation on a 29 GB SD card, and whole-database copies attack the one component whose wear is the
reason to fit an SSD. Default-off is the correct posture precisely because the product cannot know
what else is protecting that disk.

**Crashed runs leak permanently.** `_executeCreateBackup` writes to a `<timestamp>.in-progress`
directory and promotes it on success. Nothing collects one that never completes. Three are stranded:

```
19M   2026-09-09T02-42-08-852Z.in-progress
24M   2026-09-09T20-37-53-842Z.in-progress
44M   2026-09-14T00-16-16-473Z.in-progress
```

87 MB that was never a usable backup and never will be. This is **live**, not historical:
`createBackup` remains reachable from `SetupPanelProvider.ts:1017` and four `LocalApiServer.ts`
endpoints (`:2184`, `:2311`, `:2329`, `:2356`), so every interrupted operator-initiated backup adds
another. `createBackup` also takes a lock (`:182`, released `:200`), so a killed run can strand a lock
beside the directory.

**Audit of the sibling directories, 2026-09-14.** Two are fine; one is an orphan.

| Directory | Size | Bounded? | Writer |
| :--- | :--- | :--- | :--- |
| `configbackup/` | 44 KB, 10 files | **Yes** — `_pruneSnapshots` caps at 10 | `extension.ts:2990`, `GlobalIntegrationConfigService.ts:241` |
| `dbbackup/` | 260 KB, 1 file | **Yes** — retention fixed by *Kanban DB Backup Retention Deletes the Wrong Files* (COMPLETED) | `KanbanDatabase.writeDbBackup` (`:9506`), at migration only |
| `board-backups/` | **9.5 MB, 1 file** | **No policy — and no writer** | **none found anywhere in the repo** |

`configbackup` is the *correct* version of the bug the kanban retention plan fixed: it sorts by
filename and slices from the front, which is safe only because its timestamp sits immediately after
the prefix. The kanban one put `reason` before the timestamp and therefore deleted by reason. Same
code shape, opposite outcome, and nothing enforces the filename ordering that is the whole invariant.

`board-backups/038bffef-…db.pre-sync-20260909-090219.bak` is the orphan. Grepping `board-backups`
across the entire repository returns exactly one hit — this plan. Nothing in `src/`, `cmd/` or
`internal/` creates that directory, names that file, or prunes it. It belongs to the same family as
`boards/038bffef.pre-transfer.20260914-090002.bak` (10 MB) and
`integration-config.json.pre-transfer-20260828-095628`: artifacts of a sync/transfer path whose code is
not in the tree.

### Root cause

"Turn it off" was implemented as "remove it", which is a different thing and loses a capability the
operator turned out to need. Separately, no component owns `~/.switchboard` as a whole — each writer
owns only its own subdirectory, so a writer that is deleted, or was never in the tree, owns nothing and
its output becomes nobody's responsibility.

### Non-goals

- **Deleting the backup feature.** It earned its place on 2026-09-14.
- **Any default-on scheduled backup.** Off unless asked, on every host.
- **Deleting operator backups automatically.** Retention applies to what the feature creates once
  enabled; the existing 1.9 GB is offered for review, never swept silently.

## Metadata

**Tags:** reliability, infrastructure, database, backend
**Complexity:** 6

## User Review Required

1. **What survives the review sweep.** The Sep 9–10 sets are the ones consulted during the corruption
   recovery. Asserted default: **keep nothing automatically, delete nothing automatically** — list them
   with sizes and dates and let the operator choose. A tool that deletes the artifacts that just saved
   the database, on the grounds that they are stale, is the worst possible failure here.
2. **Retention budget once enabled.** Asserted default: a **byte ceiling** (proposed 500 MB) rather
   than a set count, so one 44 MB set cannot become 31 of them.

## Complexity Audit

### Routine

- Restoring the scheduled timer method on `BackupService` — the deleted `_runScheduledBackup`
  (`d20c399f`) already had the correct shape (store lock, per-machine schedule dedup via
  `scheduleState`, skip-surface recording). Reintroducing it is reconstruction, not new design.
- Declaring `configbackup/` and `dbbackup/` in the directory owner — both already bound themselves;
  the owner only names them.
- Startup size report — a `du`-equivalent enumeration plus a log line, no state.

### Complex / Risky

- **Byte-budget retention replacing count-based** (`BackupService._pruneRetention`, `:661-696`).
  Touches the eviction path every backup runs; a bug here deletes good backups or keeps too many.
  Must preserve "newest is never evicted" and "failed/`.in-progress` sets never count".
- **The opt-in config read** — per `AGENTS.md`, "absent" and "false" must be distinguishable (the
  plan's own verification demands it). A bare `getConfigJson(key, false)` default is an
  indistinguishable fallback and is the exact bug pattern the rules call out. The read must tag its
  source (`{ value, source }`), mirroring `RetentionService.getConfig`'s `ResolvedRetentionConfig`.
- **The `.in-progress` collector** runs on every startup and at the top of every `createBackup` — a
  sweep that deletes directories. The threshold and the "is a live run possible?" guard must be
  correct or it deletes a backup in progress.
- **The directory owner** is a new component enumerating `~/.switchboard` and attributing each
  subdirectory to a live writer. A new writer creating a subdirectory mid-scan is a race; the owner
  reports a snapshot and never fails the boot on an unattributed dir.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two `createBackup` calls in one process are already serialized by the in-process `_lock`
  (`BackupService:175-201`). The `.in-progress` collector at the top of `createBackup` therefore never
  races a *same-process* write. A *different-process* write is guarded by the store lock
  (`tryAcquireStoreLock`, `:181`) — but the collector must not require that lock (it runs at startup
  before any backup is attempted), so it must use an age threshold, not the lock, to decide liveness.
- The directory owner scans the filesystem; a writer creating a subdir mid-scan produces a transient
  unattributed entry. Mitigation: report the snapshot, attribute is best-effort, never block boot.

**Security**
- The `.in-progress` collector deletes directories. It must refuse to follow symlinks and must only
  operate inside the configured `_backupDir` — the same containment `storeLock.safeUnlink` enforces
  for lock files. A path-traversal via a crafted `.in-progress` name is the failure mode.
- The byte-budget eviction deletes backup set directories; same containment requirement.

**Side Effects**
- Byte-budget retention can delete the *second-newest* set if the newest alone exceeds the budget.
  This is correct (newest is never evicted) but the operator should see it in the log, not discover it
  by absence.
- The directory owner's "unattributed" report is the first thing that would have surfaced
  `board-backups/` — but it is also a new log surface that could noise up a clean boot if a transient
  dir appears. Mitigation: only report dirs that persist across two scans, or that match a known
  backup-artifact filename pattern.

**Dependencies & Conflicts**
- `scheduleState` (`src/services/scheduleState.ts`) is intact and still used by `createBackup`
  (manual path records last-run) and `RetentionService` (rotation). The restored scheduled path
  reuses `readScheduleState`/`writeLastRun`/`writeLastSkip` — no new schedule-state surface needed.
- `RetentionService` already runs on a 6-hour timer and owns `getStorageStats`. The directory owner
  overlaps with it; see Architecture Review below for the "extend RetentionService vs new component"
  decision.
- `storeLock` (`src/services/storeLock.ts`) is a lockfile with PID + process-start-time + bounded-age
  stale detection (`MAX_AGE_MS = 5 min`). A killed run's lock is **self-healing**: the next
  `tryAcquireStoreLock` reclaims it (PID dead → stale → reclaim). The `.in-progress` collector does
  **not** need to release the store lock explicitly.

## Dependencies

- `sess_20260909_d20c399f` — the removal commit that deleted `startScheduledBackups` and
  `_runScheduledBackup` from `BackupService.ts` (-76 lines), `extension.ts` (-7), `bootstrap.ts` (-2).
  This plan reintroduces the scheduled path it removed, gated behind a config key.
- `sess_20260914_corruption_recovery` — the board database corruption incident that established the
  value of the backup feature and motivated default-off-but-turnable-on rather than deletion.

## Adversarial Synthesis

Key risks: (1) the opt-in config read silently defaulting to `false` without source tagging — the
exact indistinguishable-fallback pattern `AGENTS.md` bans; (2) the `.in-progress` collector deleting a
directory a concurrent cross-process run is still writing, if the age threshold is too short or the
liveness guard is wrong; (3) byte-budget retention evicting the second-newest set when one set alone
exceeds the budget — correct but surprising if unlogged. Mitigations: tag the config source
(`ResolvedScheduledBackupConfig` mirroring `ResolvedRetentionConfig`), use an age threshold well
beyond any real backup duration for the collector's liveness guard, and log every eviction with the
set id and remaining byte total.

## Proposed Changes

### 1. Collect stranded `.in-progress` directories

On startup, and at the top of `createBackup`, any `*.in-progress` older than a short threshold is
incomplete by definition — a live run holds the lock. Remove it and release any lock it stranded.
This is the only change that stops new residue accruing; it is independent of every decision below and
ships first.

> **Superseded:** "Remove it and release any lock it stranded."
> **Reason:** `storeLock` (`src/services/storeLock.ts:118-140`) is a lockfile with PID + process-start-time + bounded-age stale detection (`MAX_AGE_MS = 5 min`). A killed run's lock is self-healing — the next `tryAcquireStoreLock` reclaims it when the PID is dead or the lock exceeds `MAX_AGE_MS`. The `.in-progress` collector does not need to touch the store lock; the lock is in `~/.switchboard/locks/`, keyed by the store path, not the backup dir, and never co-located with the `.in-progress` directory.
> **Replaced with:** Collect the `.in-progress` **directory** only. The store lock self-heals and needs no explicit release. Two sweep points with distinct invariants:
> - **Startup sweep** (`BackupService` constructor or a `collectStrandedInprogress()` called from both composition roots' startup, after `BackupService.getInstance`): at startup no live run exists in this process, so sweep **all** `*.in-progress` dirs unconditionally (the process just started; anything still `.in-progress` is from a prior, dead run).
> - **`createBackup` top-of-call sweep** (`BackupService.ts:168`, after acquiring the in-process `_lock` but before the store lock): a *different* process may be writing a `.in-progress` concurrently, so sweep only dirs older than a threshold (proposed 10 min — well beyond any real backup duration; the store lock's own `MAX_AGE_MS` is 5 min, so a dir older than 10 min cannot belong to a live lock holder). Same-process concurrency is already excluded by the in-process `_lock`.
>
> Containment: refuse symlinks, operate only inside `_backupDir`, `lstat` before `rm` (mirror `storeLock.safeUnlink` at `:146-179`).

### 2. Restore the "on" half — a real opt-in

Reintroduce a scheduled path behind a config key that defaults **false**, with the interval
configurable rather than a hardcoded parameter default. The setting's description states plainly that
this writes whole-database copies to the same disk and is unnecessary if the machine already has
backup coverage — so the operator opts in knowing what it costs.

**Clarification (implied by existing requirements, not new scope):** the config key, its read, and the
per-machine schedule dedup must follow the patterns the codebase already established:

- **Config store:** the DB config table (`KanbanDatabase.getConfig`/`setConfig`, `:6943`/`:6954`), key
  `kanban.scheduledBackups`, value `{ enabled: boolean, intervalMs: number }`. This mirrors
  `RetentionService`'s `kanban.retention` key (`RetentionService.ts:37`). An env override
  (`SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED`) parallels `RetentionService`'s
  `SWITCHBOARD_RETENTION_ENABLED` (`:99-113`).
- **Source tagging (required by `AGENTS.md` fallback rule):** return
  `{ value, source: 'config_store' | 'env' | 'default' }` — a `ResolvedScheduledBackupConfig`
  mirroring `ResolvedRetentionConfig` (`RetentionService.ts:24-27`). "Absent" (`source: 'default'`,
  `value.enabled = false`) and "explicitly false" (`source: 'config_store'`,
  `value.enabled = false`) must be distinguishable in the log, as the Verification Plan demands.
- **Per-machine dedup:** reuse `readScheduleState(db, 'backup')` / `writeLastRun` / `writeLastSkip`
  (`scheduleState.ts`) exactly as the deleted `_runScheduledBackup` did (`d20c399f` diff) — so N
  standalone processes on one store produce one backup per interval, not N.
- **Method location:** `startScheduledBackups(intervalMs?)` and `_runScheduledBackup(intervalMs)` are
  restored **inside `BackupService`** (shared class), reconstructed from the `d20c399f` diff. The
  *capability* is shared; the *wiring* (calling `startScheduledBackups` after reading the config) is
  standalone-only — see Change 7.

### 3. Retention bounded by bytes

Replace `_maxHourly + _maxDaily` with a byte ceiling, evicting oldest-first until under budget. A
count of whole-database copies is not a budget; it is a multiplier on a database that grows.

**Implementation detail (`BackupService.ts:661-696`, `_pruneRetention`):**
- Replace `_maxHourly`/`_maxDaily` fields (`:63-64`) with `_maxBackupBytes` (constructor option
  `maxBackupBytes`, default 500 MB per User Review item 2).
- Eviction: enumerate valid sets (exclude `.in-progress` and `.FAILED` as today, `:671`), sort oldest
  first, sum `sizeBytes` (via `_getDirSize`, `:698`), evict from the oldest until `total <= budget`.
  **Never evict the newest set** even if it alone exceeds the budget — the effective budget is
  `max(_maxBackupBytes, largestSingleSet)`. Log every eviction with the set id and the remaining byte
  total so the operator can see the budget bite.
- The byte ceiling is read from the same `kanban.scheduledBackups` config (or a sibling
  `kanban.backupBudgetBytes` key), with the same source-tagging pattern. A hardcoded 500 MB default
  on the constructor option is a *presentation* default (the budget is operator-visible in the log),
  not a behaviour-changing indistinguishable fallback — but the *read* must still tag its source.

### 4. Offer the existing accumulation for review

Report the 1.9 GB with per-set dates and sizes, and delete only on explicit operator action. Not a
migration step, not a startup sweep.

**Implementation:** a standalone-only startup log line (see Change 6) and an API endpoint exposing
`BackupService.listBackups()` (already exists at `LocalApiServer.ts:2311`/`_handleDatabaseBackups`)
with per-set `sizeBytes` and `timestamp`. No new deletion path — the existing
`_handleDatabaseRestore` and manual `createBackup` are the only mutators; nothing here deletes.

### 5. One owner for the control-plane directory

A component that knows every subdirectory a Switchboard writer may create and reports the total.
`configbackup/` and `dbbackup/` already bound themselves and need only to be **declared**. The work is
the two unowned cases — `backups/` (writer deleted) and `board-backups/` (writer never found). Any
directory the owner cannot attribute to a live writer is reported as **unattributed** rather than
silently tolerated, which is what would have surfaced `board-backups/` the day it appeared.

> **Architecture Review — alternative considered:** extend `RetentionService` (which already runs on a 6-hour timer and owns `getStorageStats` at `:236-250`) to enumerate and attribute `~/.switchboard` subdirectories, rather than a new component.
> **Decision:** extend `RetentionService`. It already has the lifecycle (timer, shutdown wiring in both roots), the storage-stats surface, and the DB access. A new component would duplicate lifecycle management and a second timer. The attribution is a new method on `RetentionService` (`enumerateControlPlaneDirs()` → `Array<{ name, sizeBytes, writer, attributable }>`), called from the existing scheduled rotation and from the standalone startup report (Change 6). The writer registry is a static map: `{ 'backups': 'BackupService', 'configbackup': 'GlobalIntegrationConfigService', 'dbbackup': 'KanbanDatabase.writeDbBackup', 'board-backups': null, 'boards': 'KanbanDatabase', 'locks': 'storeLock' }`. Any subdir not in the map is `unattributed`.

### 6. Report the total where an operator sees it

Startup logs control-plane size against a budget. The climb from 786 MB (Sep 6) to 1.9 GB (Sep 14)
happened over eight days with nothing surfacing it.

**Implementation:** standalone-only, in `src/standalone/bootstrap.ts` after `BackupService.getInstance`
(`:5394`) and `RetentionService.getInstance` (`:5406`): call
`RetentionService.enumerateControlPlaneDirs()`, log each dir's size + writer + attributable flag, and
the total against the configured budget. This is the appliance's startup; the extension does not own
it (Change 7).

### 7. Standalone is the target; the extension gets what shared code gives it

`CLAUDE.md` (2026-09-14): the extension host is being removed in a **hard cutover** — it ships
once alongside everything else and never has to interoperate with the new host. A feature is
never blocked, narrowed or deferred to preserve extension-host behaviour, and **new code must
not be written into the legacy host to keep it compatible.** The staged removal is the board
feature *VS Code Becomes a Sidebar, and Stops Being a Second Host* — Stages 1, 2, 2b and 3 are
all in **PLAN REVIEWED**, none built, so the extension is still a live host today.

**The distinction that matters here:** shared code is not legacy-host code. A fix that lands in a
module both roots already consume reaches the extension for free and is not throwaway. What is
forbidden is *new extension-specific wiring* added so the legacy host keeps pace.

`BackupService` is shared — constructed at `src/extension.ts:802` and `src/standalone/bootstrap.ts:5394`, shut down at `extension.ts:4432` and `bootstrap.ts:5513`.

- **Changes 1 and 3** (stranded-`.in-progress` collection, byte-budget retention) belong **inside `BackupService`**, not at the call sites. Both hosts then get them with no extension-specific code — the collector can run from the constructor or the existing `shutdown()` path that both already call.
- **Change 2** (the opt-in scheduled path) is **standalone only**. Do not reintroduce a scheduled backup into the extension host: it is the host being deleted, and the Pi is where the disk budget actually exists.
- **Changes 4, 5 and 6** (review report, directory owner, startup size report) are standalone only — they belong to the appliance's startup, which the extension does not own.

Verification therefore covers both hosts only for the shared-service changes, and standalone alone for the rest. Say so explicitly in the PR rather than leaving a reviewer to infer it.

## Verification Plan

### Automated Tests

- **Unit** — an `.in-progress` older than the threshold is removed at startup; a newer one, or one
  holding a live lock, is left alone.
- **Unit** — a `createBackup` killed mid-write leaves nothing behind after the next startup, lock
  included.
- **Contract** — with the config key absent or false, no scheduled backup ever runs; with it true, one
  runs at the configured interval. Absent and false must be distinguishable in the log.
- **Contract** — retention evicts to a byte ceiling: seed sets past the budget, assert oldest-first
  eviction and that the newest is never evicted.
- **Contract** — no automatic path deletes anything under `backups/`; the report still lists it.
- **Contract** — the sweep never touches `boards/*.db`, `-wal` or `-shm`.
- **Parity** — collector, gate and retention all run under both composition roots.

> **Superseded:** "Parity — collector, gate and retention all run under both composition roots."
> **Reason:** Change 7 explicitly makes the gate (Change 2, the scheduled-path wiring) **standalone-only**. Asserting the gate runs under both composition roots contradicts that decision and would force new extension-specific wiring — the exact throwaway work `CLAUDE.md` forbids. The collector (Change 1) and retention (Change 3) are inside `BackupService` (shared), so they do run under both roots; the gate does not.
> **Replaced with:** **Parity — the `.in-progress` collector (Change 1) and byte-budget retention (Change 3) run under both composition roots** (they live inside `BackupService`, constructed at `extension.ts:802` and `bootstrap.ts:5394`). **The scheduled-path gate (Change 2) and the directory-owner/startup-report (Changes 5–6) are standalone-only** and are verified under the standalone root alone. The config-key *read* (source-tagged `ResolvedScheduledBackupConfig`) is shared code inside `BackupService` and is unit-tested independently of which root wires the timer.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. An interrupted backup leaks nothing.
2. Scheduled backups are off by default and **can be turned on**.
3. Retention is a byte budget, not a count of database copies.
4. No automatic process deletes operator backups.
5. Every directory under `~/.switchboard` is attributable to a live writer, or reported as not.

## Completion Summary

Implemented all seven changes. Change 1 (`collectStrandedInprogress`) lives inside `BackupService` — startup sweep fire-and-forget from the constructor (both roots get it, no extension-specific wiring), createBackup-top sweep age-thresholded at 10 min with symlink/path containment. Change 2 restores `startScheduledBackups`/`_runScheduledBackup` behind a source-tagged `ResolvedScheduledBackupConfig` (config key `kanban.scheduledBackups`, env `SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED`), wired standalone-only in `bootstrap.ts`. Change 3 replaces count-based `_maxHourly`/`_maxDaily` with byte-budget `_maxBackupBytes` (default 500 MB, config key `kanban.backupBudgetBytes`), evicting oldest-first with newest-never-evicted and per-eviction logging. Change 5 adds `RetentionService.enumerateControlPlaneDirs()` with a static writer registry; Change 6 calls it from `bootstrap.ts` startup to log each dir's writer and total against the budget. Change 4 is satisfied by the existing `listBackups` API endpoint (already exposes per-set `sizeBytes`/`timestamp`). Updated `db-backup-hygiene-contract.test.js` for the byte-budget retention API.

## Review Findings

Reviewed `src/services/BackupService.ts`, `src/services/RetentionService.ts`, `src/standalone/bootstrap.ts` (wiring, already committed in `a2a38748`) and `src/test/db-backup-hygiene-contract.test.js`. Fixed three findings in `BackupService.ts`: byte-budget retention would have deleted the 31 pre-existing operator sets (1.8 GB, the Sep 9–10 corruption-recovery sets) on the very next backup, violating Goal Invariant 4 — a persisted retention epoch (`kanban.backupRetentionEpochMs`, seeded from service construction time) now excludes pre-feature sets from both the budget total and eviction, reporting them for review instead; the startup `.in-progress` sweep was unconditional even though `~/.switchboard/backups` is machine-global and shared with the extension host, so it is now age-thresholded like the `createBackup` sweep; and `effectiveBudget = max(budget, largestSingleSet)` let one oversized *old* set raise the ceiling for everything, so it now uses the newest (non-evictable) set's size. Added a contract test (`test_pre_epoch_sets_are_never_auto_evicted`) guarding the first fix. Verification: `npm run compile-tests` clean, `npm run test:contract:db-backup-hygiene` 5/5 pass (wired in CI at `.github/workflows/integration-tests.yml:1015`), `npm run standalone-parity:check` pass. Remaining risk: the `.in-progress` collector, the opt-in gate and the control-plane enumeration have no automated check that discriminates on their correctness — passing the retention suite is not evidence those three work, so the verdict on them is provisional.

## Deferred Findings

- MAJOR — `src/test/db-backup-hygiene-contract.test.js:29` — plan's Automated items 1 and 2 (`.in-progress` older than threshold removed at startup; a newer one left alone; a killed `createBackup` leaves nothing behind) have no test; the collector ships unverified.
- MAJOR — `src/services/BackupService.ts:305` — the plan's Automated item "with the config key absent or false, no scheduled backup ever runs; with it true, one runs at the configured interval; absent and false distinguishable in the log" has no test. The source tagging is implemented and logged at `bootstrap.ts:5519` but nothing discriminates on it.
- MAJOR — `src/services/BackupService.ts:352` — `setScheduledBackupConfig` and `setBackupBudgetBytes` have no callers anywhere: no API endpoint, CLI verb or UI writes them. An operator can only turn scheduled backups on via `SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED=1` or by hand-editing the `config` table. Goal Invariant 2 is met via the env var (matching the `SWITCHBOARD_RETENTION_ENABLED` precedent) but the DB-config half of the design is unreachable.
- MAJOR — `src/services/RetentionService.ts:294` — `enumerateControlPlaneDirs`'s docblock claims it is "called from the existing scheduled rotation and from the standalone startup report"; only `bootstrap.ts:5493` calls it. A subdirectory that appears after boot is never reported until the next restart, which is the case `board-backups/` was meant to catch.
- NIT — `src/services/RetentionService.ts:305` — the plan's mitigation "only report dirs that persist across two scans, or that match a known backup-artifact filename pattern" is not implemented; a transient directory logs as UNATTRIBUTED once.
- NIT — `src/services/RetentionService.ts:330` — `_getDirSize` duplicates `BackupService._getDirSize` verbatim.
- NIT — `src/services/BackupService.ts:1072` — `_pruneRetention` now walks every set with `_getDirSize` on every backup (31 sets × ~40 files on the reference machine) where the count-based path only stat'd the directory.
- NIT — `src/services/BackupService.ts:320` — the retention epoch is stored per-workspace in that board's `config` table while the backup dir is machine-global; two workspaces seed two epochs. The skew is conservative in both directions (it only ever spares more sets), but "which epoch governs this set?" is answered per reader.
- NIT — `src/services/BackupService.ts:315` — `SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED` set to anything other than `true`/`1` resolves to disabled with `source: 'env'`, silently shadowing a `config_store` value that says enabled. Tagged in the log, so it is diagnosable, but a typo disables the feature.
