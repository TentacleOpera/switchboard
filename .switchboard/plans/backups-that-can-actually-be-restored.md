# Backups that can actually be restored — a set, a verified write, and a non-destructive restore

## Goal

Turn the two write-only backup mechanisms into a backup *system*: consistent sets
that pair the database with the plan files from the same moment, verified when
written, stored in the backups sibling so they outlive the repo, and restorable
without destroying what is there — in both hosts.

### Problem Analysis

**Nothing reads `dbbackup/`.** `writeDbBackup` (`KanbanDatabase.ts:7337`) writes
full DB snapshots to `<workspaceRoot>/.switchboard/dbbackup/kanban.db.backup.<reason>.<ts>`,
with a per-reason throttle, a per-reason content dedupe (size pre-check, then byte
compare) and pruning grouped by reason. It is careful, correct work — and **no code
anywhere opens one of those files.** Recovery today is a manual file copy that has
never been documented or tested. A backup nobody has ever restored is a hope, not a
backup.

**The one restore that exists is reachable only by destroying the database first.**
`restoreFromBackup` is called from exactly one place: the reset-DB command
(`extension.ts:1578`), which unlinks the database file (`:1567`) *before* restoring.
So there is no way to restore without a delete, no way to preview what a restore
would do, and no way to recover from a partial restore — the original is already
gone.

**And it restores the smaller of the two artifacts.** That path reads
`kanban-state-backup.json`, which carries active plan **metadata rows only** —
`plan_id, topic, plan_file, kanban_column, complexity, tags, feature_id, project…`
(`:9118-9122`). No plan bodies, and none of the features, projects, worktrees,
missions, dependencies or events the database also holds. It is a useful last
resort and it is not a database backup.

**Nobody's database is backed up on a schedule.** `writeDbBackup` has two callers:
`'pre-migration'` (internal, `:7399`) and `'bulk-change'`
(`PlanIngestionEngine.ts:1004`). Both are incidental. **An install that never
migrates and never bulk-imports has no backups at all** — and the steady-state
install, someone using the board daily without upgrading, is exactly that install.

**A database and its plan files must be captured together.** Plan identity keys on
the file path, and the DB holds the row that points at it. A database from Tuesday
restored beside plan files from Friday produces cards pointing at files that no
longer exist and files with no cards — in both directions, silently. Loose
per-artifact snapshots cannot express "these two belong together", so consistency
has to be a property of the backup's structure.

**Backups live inside what they back up.** Both paths are under
`<workspaceRoot>/.switchboard/`, so losing that checkout loses the backups with it
— the one scenario a backup exists for.
`canonical-control-plane-layout-with-sibling-repos.md` supplies the `-backups`
sibling; this plan is what puts something worth keeping in it.

**Restore is extension-only.** The reset command lives in `extension.ts`, so the
standalone host can *write* backups through `KanbanDatabase` and has no way to
restore one. That is the composition-root divergence class this project has a rule
about, arrived at by the operation living in a VS Code command rather than a
service.

### Root Cause

Each backup was added to protect one specific operation — a migration, a bulk
import — and each did its narrow job. Nobody wrote the recovery side, because
recovery is the part you only need when something has already gone wrong, and the
absence is invisible until then.

### Non-goals

- **Backing up terminal logs.** They are diagnostics with their own retention
  (`terminal-logs-live-in-the-logs-sibling.md`).
- **Plan revision history.** Storing plan bodies as versioned rows is a separate
  optional plan; this one keeps files as files. A database may be the only copy of
  history; never the only copy of current.
- **Off-machine or encrypted backup.** The sibling may be a git repo with a remote
  if the user wants that; nothing here uploads anywhere or manages keys.
- **Backing up the secrets store.** A set must never contain `secrets.enc` or
  `.master-key`. The key sits beside the ciphertext it decrypts, so sweeping both
  into a store that may be a git repo hands over the credentials rather than
  protecting them — and the extension's own tokens live in the OS keychain, which a
  file backup cannot reach anyway. See
  `state-home-derives-from-an-explicit-control-plane.md`; a set is portable because
  it holds no credentials, and the consequence — a restored board has no
  integrations connected until they are re-entered — belongs in the restore UI, or
  it reads as a failed restore.
- **Replacing `writeDbBackup`'s throttle, dedupe or pruning.** They work; they get
  extended, not rewritten.
- **Backing up the control plane.** Its definitions are regenerable from an
  extension bundle of the matching version — the retention plan says so — so they
  are the one thing here that is genuinely not data loss.
- **Confirm gates.** Per project rule, none. A restore is confirmed by being
  non-destructive, not by a dialog.

## Metadata

**Complexity:** 6
**Tags:** reliability, backend, database, devops, infrastructure

## Dependencies

- `canonical-control-plane-layout-with-sibling-repos.md` for the `-backups`
  derived path. Without it this plan still works, writing to
  `.switchboard/backups/` — it is better with the sibling, not blocked on it.

## Proposed Changes

### 1. A backup is a set, not a file

```
<backupsRoot>/2026-08-27T14-03-11-scheduled/
├── kanban.db              # full snapshot, as writeDbBackup produces today
├── plans/                 # every plan + feature .md at that moment
└── manifest.json
```

`manifest.json` is what makes it a set rather than a coincidence:

```json
{ "schema": 1, "createdAt": "…", "reason": "scheduled",
  "host": "extension | standalone", "switchboardVersion": "…",
  "dbSchemaVersion": 67,
  "counts": { "plans": 412, "features": 23, "projects": 5, "planFiles": 412 },
  "dbSha256": "…",
  "planFiles": [ { "path": "plans/foo.md", "sha256": "…", "bytes": 8231 } ] }
```

The counts and hashes exist so a restore can say *"this set is internally
consistent"* before touching anything, and so a human can tell two sets apart
without opening a database. `dbSchemaVersion` is what lets a restore refuse a set
from a newer version rather than corrupting a downgrade.

**Plan files are copied, not referenced.** Under the canonical layout they are in
`-plans`, a git repo — so git is their primary history. The copy is for the cases
git does not cover: a lost clone, a force-push over history, or a plan deleted and
committed. Cheap (markdown), and it is what makes the set self-contained.

### 2. Write it, then open it

After writing a set: open the copied database, read its schema version, count
plans, and compare against the manifest. Hash the plan files as they are copied
and verify the manifest matches.

A truncated write, a full disk, or a partially-flushed `export()` all produce a
file that looks fine and is not. The check costs one read of something just
written, and it is the difference between "a backup exists" and "a backup works".

A set that fails verification is renamed `*.FAILED` and reported, never silently
left looking valid.

### 3. Scheduled backups, because the current triggers are incidental

Add `'scheduled'` and `'manual'` to the existing reasons, and a daily default
(configurable, off never — a backup nobody asked for is the one they will need).
Reuse `ScheduledJobsService` rather than adding a timer.

Keep every existing trigger and every existing property: the per-reason throttle,
the per-reason content dedupe, and pruning grouped by reason with its mtime
fallback for legacy un-timestamped files (`_pruneDbBackups`). The dedupe matters
more once backups are periodic — a board nobody touched for a week should produce
one set, not seven.

### 4. Restore, non-destructively, in both hosts

A `BackupService` on the shared side, with three operations:

- **`list()`** — sets found in the backups root, newest first, each with its
  manifest summary and a validity verdict.
- **`inspect(setId)`** — what a restore would change: plans added, removed, and
  differing between the set and the live board; plan files that would be written;
  whether the set's `dbSchemaVersion` is older, equal or newer than the current
  one. Reads only.
- **`restore(setId, { plans, planFiles })`** — restore the database, the plan
  files, or both.

**Never unlink first.** Restore writes the recovered database to a new path,
verifies it opens and counts match, and only then swaps it in — keeping the
displaced database as `kanban.db.pre-restore.<ts>`. The current reset path deletes
before restoring (`extension.ts:1567`), which means a failed restore leaves
nothing. That ordering is the bug this plan exists to not repeat.

**A newer `dbSchemaVersion` is refused**, with the versions named. Restoring a set
from a newer build into an older one is a migration in reverse, and the migrations
in this codebase are explicitly one-way ("never edit a shipped Vnn body").

**Plan files are restored additively by default** — missing files written, existing
files left alone, differences reported — with overwrite as an explicit choice.
Plan files are the most valuable content in the system and a restore that
overwrites a plan someone edited this morning is a data-loss event wearing a
recovery hat.

**Both hosts reach it the same way**: an HTTP route in the DB-direct family, wired
in both roots already, plus a Setup surface. The VS Code reset command becomes a
thin caller of `restore()` rather than the only path to it.

### 5. Surface it

A Backups panel in Setup: the sets, their dates, reasons, counts, sizes and
validity; the last successful backup and its age; buttons to back up now, inspect,
and restore. Plus a warning when the newest valid set is older than the schedule
implies — a backup system that has silently stopped is worse than none, because it
is trusted.

### Migration

- **Legacy backups keep working.** `dbbackup/kanban.db.backup.<reason>.<ts>` files
  are listed as single-artifact sets (database only, no manifest, no plan files) and
  are restorable as such. An install with only legacy files can still recover — and
  per project rules, they are left in place, not moved or unlinked.
- **`kanban-state-backup.json` stays**, keeps being written, and stays wired into
  the reset path as the last-resort metadata recovery it already is. It is not the
  database backup and the UI should not imply it is.
- New sets go to the derived `-backups` sibling when it exists,
  `.switchboard/backups/` otherwise. Nothing existing is relocated.

## Verification Plan

1. **A written set verifies** — back up, then assert the copied database opens, its
   schema version and plan count match the manifest, and every plan file hash
   matches.
2. **A corrupted set is caught** — truncate the copied database and truncate one
   plan file, independently. Assert each is detected at write time, the set is
   marked `*.FAILED`, and it never appears as restorable.
3. **Restore is non-destructive** — restore with the live database held open and
   busy; assert the original is preserved as `kanban.db.pre-restore.<ts>`, and that
   a restore failing mid-way leaves the original in place and serving. Kill the
   process during the swap and assert the same.
4. **Inspect tells the truth** — a set with 3 plans the board lacks, 2 the board has
   and it lacks, and 1 that differs, reports exactly that and writes nothing.
5. **Schema guard** — a set stamped a newer `dbSchemaVersion` is refused with both
   versions named; an older one restores and migrates forward normally.
6. **Plan files additive** — restore into a workspace where one plan was edited
   this morning; assert it is untouched and reported as differing, and that
   overwrite is a separate explicit action.
7. **Consistency is the point** — build a deliberately mismatched pair (database
   from set A, plan files from set B). Assert the system cannot produce it, and that
   a restore of one set never mixes artifacts across sets.
8. **Existing behaviour preserved** — `pre-migration` and `bulk-change` still fire;
   the per-reason throttle, the content dedupe and the pruning grouping all behave
   as before, including a future-stamped file reading as "no recent snapshot" and
   legacy un-timestamped files pruning by mtime.
9. **Scheduled coverage** — an install that never migrates and never bulk-imports
   accumulates sets on the schedule. This is the gap the plan opens with; assert it
   closes.
10. **Survives losing the checkout** — with the sibling configured, take a set, then
    delete the code repo's `.switchboard/` entirely. Assert the set is present,
    valid, and restores. On today's layout this fails by construction.
11. **Legacy restore** — an install with only `dbbackup/` loose files lists them and
    restores one.
11a. **No credentials in a set** — assert no set contains `secrets.enc`,
     `.master-key`, or `integration-config.json`, including when the state home has
     been relocated under a control plane.
12. **Both hosts** — back up, inspect and restore under the extension host and the
    standalone host, and assert the standalone host is not restore-only-in-theory.
    This is the divergence that exists today.

### Goal Invariants

- Every backup written has been opened and checked before being called a backup.
- A restore never destroys the state it is replacing, on any path including
  failure.
- A database and the plan files beside it always come from the same moment.
- A backup exists on a schedule, not only when something else happened to trigger
  one.
- Backups outlive the loss of the repository they back up.
- Both hosts can restore, not only write.
- No existing backup file becomes unreadable or unreachable.
