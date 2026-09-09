# The Board Takes an Hourly Backup Nobody Asked For, Onto the Same Disk, With No Way to Turn It Off

kanbanColumn: CREATED

## Goal

Local scheduled backups are off unless the operator turns them on, retention is bounded by size
rather than by a count of whole-database copies, and the feature justifies itself against the
durability the product already ships.

### Problem analysis

**Measured on this machine, 2026-09-06.** `~/.switchboard/backups/` held **14 snapshots totalling
786 MB**, all written within a single day, each a whole copy of a 9 MB database plus a manifest and
the plans tree. The oldest was under 36 hours old. Nothing had asked for any of them.

**There is no off switch.** `BackupService.startScheduledBackups(intervalMs = 3600000)` — one hour,
hardcoded as a parameter default — is called **unconditionally** from both composition roots,
`extension.ts:780` and `standalone/bootstrap.ts:3997`. Neither call passes an interval and neither
is gated on anything. `switchboard.notionBackup` is the only backup-shaped key in
`package.json`'s contributed configuration, and it governs something else entirely. An operator who
does not want this has nowhere to say so.

> **Superseded:** `extension.ts:780` and `standalone/bootstrap.ts:3997` as the call sites.
> **Reason:** Both line numbers are wrong and will mislead an implementer. `extension.ts:780` is the
> closing `});` of the `setOnDatabaseRestored` callback; the actual `startScheduledBackups()` call is
> at `extension.ts:781`. `standalone/bootstrap.ts:3997` is an unrelated comment about seat
> orientation (`// landed on a coder mid-clear…`); the actual call is ~800 lines further down, at
> `standalone/bootstrap.ts:4805`. Verified 2026-09-08.
> **Replaced with:** `extension.ts:781` and `standalone/bootstrap.ts:4805`.

**Retention counts copies, not bytes.** `_pruneRetention` caps at `_maxHourly + _maxDaily`, which
default to 24 and 7 — **31 whole-database snapshots**. At the observed set size that is roughly
1.7 GB of steady-state disk, reached automatically, on any machine that leaves the board running.

**The cost lands hardest exactly where the product is trying to go.** A Raspberry Pi board host has
a 29 GB SD card and had already written 18.3 GB in 13 hours from ordinary operation. Adding an
unrequested hourly whole-file copy to that disk attacks the one component whose wear is the reason
to buy an SSD in the first place.

**And it contradicts the product's own stated position.** A shared libSQL store was rejected in
part because *"it asks the operator to run infrastructure to use a kanban board"* — standing up a
server, managing a credential, reasoning about a lease. That reasoning is sound. It is also
impossible to reconcile with shipping an unconfigurable hourly backup regime that consumes more
disk than the rejected option would have, and that the operator cannot decline. If running
infrastructure is too much to ask, so is silently operating a backup service on the operator's
behalf.

**The durability story already exists and needs no disk.** `BoardSnapshotPublisher` publishes
`board.json` to the orphan branch `switchboard/board` — the same mechanism cited as one of the two
reasons libSQL was unnecessary. A snapshot in git is off-machine, versioned, diffable and free. An
hourly copy of the database *next to the database* survives neither a disk failure nor an SD card
wearing out, which are the two failures a Pi deployment actually faces.

**Boundary — this is not the retention card that already exists.** `Kanban DB Backup Retention
Deletes the Most Valuable Snapshot First` covers `KanbanDatabase.writeDbBackup`: event-driven
`bulk-change` and `pre-migration` snapshots named `kanban.db.backup.*`, capped at 5, pruned by a
lexicographic sort that deletes by reason before time. Different writer, different directory,
different bug. **Two independent backup systems run in this product**, which is itself worth
noticing. Fix them separately; do not merge the cards.

## Metadata

- **Complexity:** 3
- **Tags:** infrastructure, reliability, backend

## User Review Required

None. Change 3 is a decision this card takes rather than defers.

## Complexity Audit

### Routine
- Deleting the unconditional `startScheduledBackups()` call from `extension.ts:781` and
  `standalone/bootstrap.ts:4805` — two single-line removals, mirrored across both roots.
- Removing the now-dead `_hourlyTimer` / `startScheduledBackups` / `stopScheduledBackups` /
  `_runScheduledBackup` / `_scheduledIntervalMs` surface from `BackupService.ts` (or leaving it
  for the manual path — see Proposed Changes).
- Recording the keep-vs-delete decision and its reasoning in this plan.

### Complex / Risky
- None under the deletion path. The scheduled timer is the only behavior change; the event-driven
  `writeDbBackup` (pre-migration / bulk-change), the manual `createBackup`, the shutdown backup,
  the orphan-branch `BoardSnapshotPublisher`, and the multi-host store-lock coordination are all
  untouched.

## Edge-Case & Dependency Audit

**Race Conditions**
- None introduced. The deletion *removes* a timer that today races for the store lock every hour
  alongside `RetentionService`'s rotation tick. Removing it strictly reduces lock contention.

**Security**
- `~/.switchboard/backups/` is created `0o700`, files `0o600`, and `validateBackupPath` rejects
  cloud-sync and git-work-tree locations. None of this changes; the manual/shutdown/pre-restore
  paths still use the same `_executeCreateBackup` and keep these guards.

**Side Effects**
- Existing backup directories are the operator's. Deleting the timer must not delete what is
  already on disk — offer a clear-now action via the Database panel, never prune as a side effect.
- `shutdown()` still calls `createBackup({ type: 'shutdown' })` (`BackupService.ts:227`). That is
  an event-driven, requested backup, not a scheduled one — keep it.
- The Database panel's "Automatic Rolling Backups" card (`database.html:596-607`) and the
  "Backup Last Run" / "Backup Last Skip" schedule-status fields (`database.html:620-624`) currently
  reflect the scheduled path. After deletion they go idle (last-run frozen, no next-run); the panel
  copy ("Switchboard maintains point-in-time backup sets … with automated retention pruning") must
  be updated so an operator is not told a scheduler is running when it is not.

**Dependencies & Conflicts**
- `RetentionService` (`startScheduledRotation`) is a *separate* scheduled disk-writing service
  started unconditionally from both roots right after `BackupService`. It already ships the correct
  cross-host config pattern (`kanban.retention` in `kanban_meta`, `enabled: false` default, gated
  inside the tick at `RetentionService.ts:309`). It is out of scope for this card, but it is the
  precedent the keep-path alternative (see Proposed Changes, Alternative B) must mirror — not a
  `package.json` contributed setting.
- `KanbanDatabase.writeDbBackup` (event-driven `pre-migration` / `bulk-change`) has its own
  retention card. Do not touch it.
- `switchboard.notionBackup` is a different feature. Do not fold it in.

## Dependencies

None. This plan does not depend on any other in-flight plan. The sibling retention card
(`kanban-db-backup-retention-deletes-the-wrong-files`) is independent and must stay independent.

## Adversarial Synthesis

Key risks: (1) the keep-vs-delete decision was deferred to the implementer, biasing toward "keep"
(the more-expensive outcome the plan itself warns against); (2) the proposed `package.json`
contributed setting is extension-first and the standalone host's shim cannot honor or surface it —
a divergence trap; (3) wrong line numbers would send an implementer to an unrelated comment.
Mitigations: decide "delete the timer, keep `createBackup`" in this plan; name `RetentionService`
as the config precedent for any future keep-path; correct the line numbers to `extension.ts:781`
and `standalone/bootstrap.ts:4805`.

## Proposed Changes

> **Decision recorded in this improve pass (Change 3, resolved):** the scheduled timer protects
> against nothing the event-driven paths and the orphan-branch snapshot do not already cover. The
> honest answer to "what does a same-disk hourly copy protect against?" is **nothing**. The plan's
> own Problem analysis is the evidence: `writeDbBackup` fires at the dangerous moment
> (`pre-migration`, `bulk-change`), `BoardSnapshotPublisher` is off-machine, and the scheduled copy
> sits next to the database it copies — surviving neither of the two failures a Pi deployment
> faces. Therefore **delete the scheduled path** rather than building a setting, a retention
> rewrite, and a UI for a feature that should not exist.
>
> The backup *capability* (`createBackup` for manual / shutdown / pre-restore) stays — it is
> event-driven, requested, and the only producer of a manifested full point-in-time set including
> the plans tree. Only the *clock* is removed.

### `src/extension.ts` (line 781)

**Context.** The extension host unconditionally calls `backupService.startScheduledBackups()` at
line 781, immediately after wiring `setOnDatabaseRestored`. The `context.subscriptions` dispose
block at 782-786 calls `stopScheduledBackups()`.

**Logic.** Remove the `startScheduledBackups()` call. The dispose block can stay (calling
`stopScheduledBackups()` on a never-started timer is a no-op guarded by `if (this._hourlyTimer)`)
or be removed for clarity. Prefer removing both the call and the dispose registration, since there
is nothing to stop.

**Implementation.**
```ts
// DELETE line 781:
backupService.startScheduledBackups();
// DELETE lines 782-786 (the dispose registration for stopScheduledBackups), OR leave them —
// they are a harmless no-op once the timer is never started.
```

**Edge cases.** The `setOnDatabaseRestored` wiring at 773-780 stays — restore notification is
unrelated to the scheduler and is needed by the manual/shutdown restore paths.

### `src/standalone/bootstrap.ts` (line 4805)

**Context.** The standalone host unconditionally calls `backupService.startScheduledBackups()` at
line 4805, mirroring the extension. There is no dispose registration (the standalone process exit
stops the timer implicitly).

**Logic.** Remove the call. This is the host most likely to run on a Pi — the one this card exists
to protect — so this removal is the load-bearing one.

**Implementation.**
```ts
// DELETE line 4805:
backupService.startScheduledBackups();
```

**Edge cases.** The `setOnDatabaseRestored` wiring at 4797-4804 stays for the same reason as the
extension. `RetentionService.startScheduledRotation()` at 4808 is a separate service and is out of
scope — do not touch it.

### `src/services/BackupService.ts`

**Context.** `startScheduledBackups` (144), `stopScheduledBackups` (217), `_runScheduledBackup`
(163), `_hourlyTimer` (63), and `_scheduledIntervalMs` (156) are the scheduled-path surface.
`createBackup` (242), `_executeCreateBackup` (278), `shutdown` (224), `_pruneRetention` (735),
and the restore methods are the event-driven/manual surface.

**Logic.** Remove the scheduled-path surface. Keep `createBackup`, `_executeCreateBackup`,
`shutdown`, `_pruneRetention`, and the restore methods — they serve manual / shutdown /
pre-restore backups, which are requested and event-driven. `_pruneRetention`'s count cap
(`_maxHourly + _maxDaily`) becomes near-moot (only manual/shutdown/pre-restore sets are pruned,
which are rare), so the byte-budget rewrite from the original Change 2 is **not built** — there is
no scheduled producer to fill a 31-set steady state.

**Implementation.**
- Delete `startScheduledBackups`, `stopScheduledBackups`, `_runScheduledBackup`, `_hourlyTimer`,
  `_scheduledIntervalMs`.
- Delete the `BackupServiceOptions.maxHourly` / `maxDaily` fields and the `_maxHourly` / `_maxDaily`
  members if no other caller references them (verify with a grep before deleting — the constructor
  defaults at 79-80 are the only setters found this pass).
- Keep `createBackup`'s in-process `_lock` queueing (249-275) and the store-lock acquisition
  (255-260) — a manual backup can still race a rotation tick, and the lock is the coordination.

**Edge cases.** `shutdown()` (224) calls `createBackup({ type: 'shutdown' })` then
`stopScheduledBackups()`. After deletion, `stopScheduledBackups()` is gone — remove that call from
`shutdown()` too, or keep a no-op stub. Prefer removing it; the timer no longer exists.

### `src/webview/database.html` (lines 596-624) and `src/webview/database.js`

**Context.** The "Automatic Rolling Backups" card describes an automated retention regime, and the
"Backup Last Run" / "Backup Last Skip" schedule-status fields reflect the scheduled path. The
"BACKUP NOW" button (`btn-backup-now`) and the backup list (`backups-container`) serve the manual
path and stay.

**Logic.** Update the card copy so an operator is not told a scheduler is running when it is not.
The schedule-status fields go idle (last-run frozen at the final scheduled tick, no further
updates); either hide them or relabel them as "Last manual/scheduled backup" with a note that
scheduled backups are retired. Keep "BACKUP NOW" and the backup list.

**Implementation.**
- `database.html:602-603`: change the description from "automated retention pruning" to reflect
  that backups are manual / shutdown / pre-restore only.
- `database.html:620-624`: relabel or hide "Backup Last Run" / "Backup Last Skip". These read
  `schedule.backup.lastRun` / `lastSkip` from `kanban_meta` via `scheduleState.ts`; the keys are not
  deleted (they remain accurate history), but no new scheduled values are written.

**Edge cases.** Do not delete `schedule.backup.lastRun` / `lastSkip` rows from `kanban_meta` — they
are the operator's history. The `scheduleState.ts` module stays for `RetentionService`'s
`rotation` kind, which still uses it.

### Decision record (this plan)

**Context.** The original Change 3 deferred the keep-vs-delete decision to the implementer.

**Logic.** This improve pass resolves it: **delete the scheduled path.** The evidence is the plan's
own Problem analysis. The keep-path alternative is recorded below so a future operator request to
restore scheduled copies uses the correct seam.

**Alternative B (not built — recorded for the future):** if scheduled copies are ever wanted again,
do NOT add a `package.json` contributed setting. The standalone host's `vscodeShim`
(`StandaloneConfiguration`, `vscodeShim.ts:234-248`) reads from `config.json` via
`StandaloneHostPathConfigProvider`, not from `package.json` defaults, and `inspect()` returns
all-undefined layers — so a contributed setting is extension-first and the standalone host gets a
silent default with no UI to change it. Instead mirror `RetentionService`: a `kanban.backup` key in
`kanban_meta`, `enabled: false` default, gated inside a recreated tick, exposed via LocalApiServer
(`/database/backup/config`, mirroring `/database/retention/config`) and the Database panel. That
is the cross-host-correct pattern already shipped in this repo.

## Verification Plan

### Automated Tests
*(Skipped this run per session directive — checks remain written down.)*

1. A fresh install runs no scheduled backup, and `~/.switchboard/backups/` receives no
   *scheduled* writes through several hours of board uptime. (Manual/shutdown/pre-restore writes
   are unaffected and not asserted here.)
2. `grep -n "startScheduledBackups" src/extension.ts src/standalone/bootstrap.ts` returns no
   matches in either composition root — the both-hosts invariant.
3. `RetentionService.startScheduledRotation()` is still called from both roots (unchanged).
4. `KanbanDatabase.writeDbBackup` still fires on `pre-migration` and `bulk-change` (unchanged —
   covered by its own card's tests).
5. `BackupService.createBackup({ type: 'manual' })` and `shutdown()` still produce a verified
   backup set with a manifest, row counts, and the plans tree.

### Goal Invariants
- Assert `startScheduledBackups` is absent from `src/extension.ts` (the call site at line 781 is
  gone).
- Assert `startScheduledBackups` is absent from `src/standalone/bootstrap.ts` (the call site at
  line 4805 is gone).
- Assert `BackupService.createBackup` is still present and exported from
  `src/services/BackupService.ts` (the capability survives; only the clock was removed).
- Assert `RetentionService.startScheduledRotation` is still called from both
  `src/extension.ts` and `src/standalone/bootstrap.ts` (the sibling service is untouched).
- Assert `KanbanDatabase.writeDbBackup` is still present in `src/services/KanbanDatabase.ts`
  (the event-driven path is untouched).
- Negative invariant paired: assert no `setInterval` referencing `3600000` or
  `_runScheduledBackup` remains in `src/services/BackupService.ts` (the timer is gone, not just
  unwired).

## Outstanding Questions

- **[user]** If an operator has come to depend on the scheduled copies as a poor-man's offsite
  (e.g. a cron job that rsyncs `~/.switchboard/backups/` elsewhere), deleting the scheduler breaks
  that pipeline silently. Proceeding on the assumption that no documented operator relies on the
  scheduled path — the plan's own Problem analysis shows it was never announced, has no setting,
  and writes to a directory the operator is told nothing about. If this assumption is wrong, build
  Alternative B (RetentionService-mirror) instead of deleting.

## Implementation Summary

Scheduled backup timer deleted; backup capability retained. Removed the unconditional `startScheduledBackups()` call and its `stopScheduledBackups()` dispose registration from `src/extension.ts`, and the unconditional `startScheduledBackups()` call from `src/standalone/bootstrap.ts` (the Pi-relevant host). In `src/services/BackupService.ts`, deleted `startScheduledBackups`, `stopScheduledBackups`, `_runScheduledBackup`, `_hourlyTimer`, and `_scheduledIntervalMs`, removed the `stopScheduledBackups()` call from `shutdown()`, and pruned the now-unused `readScheduleState`/`LastRunRecord` imports; kept `createBackup`, `_executeCreateBackup`, `shutdown`, `_pruneRetention`, and the restore paths, plus the `maxHourly`/`maxDaily` options (still referenced by `db-backup-hygiene-contract.test.js`). Updated `src/webview/database.html`: renamed the "Automatic Rolling Backups" card to "Backups" with copy stating backups are manual/shutdown/pre-restore only, and relabeled the schedule-status fields as history (rotation still scheduled, untouched). `RetentionService.startScheduledRotation` and `KanbanDatabase.writeDbBackup` confirmed untouched in both roots; `schedule.backup.lastRun`/`lastSkip` rows in `kanban_meta` are not deleted (retained as history, still updated by manual/shutdown backups).
