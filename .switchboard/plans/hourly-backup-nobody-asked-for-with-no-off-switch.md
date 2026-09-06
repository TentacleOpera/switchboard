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
- **Tags:** backups, storage, infrastructure, both-hosts, raspberry-pi

## User Review Required

None. Change 3 is a decision this card takes rather than defers.

## Proposed Changes

### 1. Off by default, and a real setting

Add a contributed setting for the scheduled local backup — enabled and interval — defaulting to
**off**. `startScheduledBackups` is called only when it is on, from both roots.

Off is the correct default because the operator did not ask for this and cannot currently see it
happening. A feature that consumes 786 MB a day without appearing in any settings surface is not a
default, it is a surprise.

### 2. Bound retention by size, not by a count of whole copies

Replace the `_maxHourly + _maxDaily` count cap with a byte budget, and report the current usage
where the operator can see it. Thirty-one copies of a database is a policy expressed in the wrong
unit — it says nothing about how much disk it will take, and the answer changes as the board grows.

### 3. Decide whether the local copy earns its place at all

Whoever implements this must answer, in the plan, what a same-disk hourly copy protects against
that the orphan-branch snapshot does not. The honest candidates are a corrupt write and an
accidental mass deletion — both of which the *event-driven* `pre-migration` and `bulk-change`
snapshots already cover, and cover better, because they fire at the dangerous moment rather than on
a clock.

If the answer is "nothing", delete the scheduled path rather than adding a setting for it. Shipping
a switch for a feature that should not exist is the more expensive outcome.

### 4. Say it is running

While it is on, the operator sees the last run, the next run and the disk in use — the Database
panel is the obvious home. A background process writing gigabytes must be visible from the UI, not
discoverable only by running `du`.

## Edge-Case & Dependency Audit

1. **Both composition roots.** Both call it today, so both must respect the setting. An
   unwired setting on one host means the standalone board — the one most likely to be on a Pi —
   keeps writing hourly while the UI says it is off.
2. **Existing backup directories are the operator's.** Turning the schedule off must not delete
   what is already there. Offer a clear-now action; never prune as a side effect of a settings
   change.
3. **The multi-host lock stays.** `_runScheduledBackup` records a schedule-skip when another host
   ran within the interval, and `schedule.backup.lastRun` / `lastSkip` live in the config table.
   That coordination is correct and unrelated — keep it.
4. **Do not touch `writeDbBackup`.** Its retention bug has its own card. Changing both at once
   makes either one impossible to verify.
5. **`switchboard.notionBackup` is a different feature.** Do not fold it in.

## Verification Plan

1. A fresh install runs no scheduled backup, and `~/.switchboard/backups/` stays empty through
   several hours of board uptime.
2. Turning the setting on produces backups at the configured interval; turning it off stops them
   within one interval, on **both** hosts, verified by reading both composition roots.
3. Retention holds the directory under its byte budget as the database grows, rather than at a
   fixed number of copies.
4. Turning the setting off leaves existing backup directories untouched.
5. The Database panel shows last run, next run and bytes in use while the schedule is on.
6. `writeDbBackup`'s `bulk-change` and `pre-migration` snapshots still fire, unchanged by any of
   this.
7. If change 3 concludes the scheduled path should go, the card records that decision and the
   settings work in change 1 is not built.
