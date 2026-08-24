# Retention and archive policy for a global database that never gets deleted

## Goal

Give the global database a bounded working set. Define what ages out of the hot database, when, and where it goes, so that "long-term persistence across every project forever" does not mean "one file that grows without limit and is never pruned".

### Problem Analysis

Consolidation plus long-term persistence removes both of the mechanisms that currently bound database size, and neither removal is obvious until it bites.

**Per-repo databases were self-limiting.** A project's `kanban.db` grew with that project, and when the project was abandoned the file was simply never opened again — dead weight on disk, but never loaded, never scanned, never in memory. A single global database loads all of it, and every query pays for every project the user has ever touched.

**"Long-term persistence" is an explicit commitment not to delete.** That makes growth monotonic by design. The tables that grow without bound are the event and log tables, not the entity tables: `plan_events` / `plan_events_v20` (one row per workflow transition, per plan, forever — with a `payload TEXT` column), `activity_log`, `job_runs`, and `board_move_requests`. Entity tables (`plans`, `projects`, `worktrees`) grow with real work and are self-limiting in practice. So the retention problem is concentrated in four append-only tables.

**The archive machinery already exists but is not load-bearing.** `ArchiveManager.ts` (332 lines) and `AutoArchiveService.ts` (318 lines) provide a DuckDB archive of historical plans and conversations, and the cold DB is resolved "next to the hot DB" (`KanbanDatabase.ts:1237`, `:1271`). Today archiving is an optional convenience; after consolidation it is the only thing standing between the hot database and unbounded growth. It needs a defined policy, a default that is on, and a guarantee that archived data is queryable rather than merely moved out of sight.

### Root Cause

Retention was never designed because the per-repo topology made it unnecessary. Abandoning a project was an implicit, free retention policy. Consolidation converts that implicit policy into no policy at all.

### Control-plane content changes the scope

The scaffold plan moves control-plane definitions (protocols, skills, workflows, personas, rules — roughly 744K of text) into the store as bodies, with a version and content hash per row. That is the first time the store holds document content rather than metadata, and it grows on a different axis from everything else here: not per workflow transition, but **per extension release**, since a superseded definition version is exactly the kind of thing "long-term persistence" implies keeping.

So retention has a second target: historical `control_plane` rows. Unlike the event tables, these are trivially safe to prune — they are regenerable from any extension bundle of the matching version, so pruning them is not data loss in any sense. Recommendation: keep the current version plus one prior (rollback safety), plus every row carrying a local override regardless of age, and prune the rest on release. This should be the *first* rotation enabled, since it is the only one with no recovery risk at all.

### Non-goals

- Deleting user data. This is archival and rotation, not deletion; "long-term persistence" is the requirement being honoured, not overridden.
- Changing what the archive is (DuckDB stays).
- Compressing or restructuring `payload` JSON.

## Metadata

**Complexity:** 5
**Tags:** database, performance, reliability, backend, feature

## User Review Required

Yes — the policy itself is a product decision, not a technical one:

1. **What ages out, and after how long?** Recommendation: event/log rows older than 180 days move to the archive; entity rows never age out on time alone.
2. **Do whole dormant workspaces age out?** A workspace with no activity for a year could move to the archive wholesale, leaving a stub so it can be reactivated. Recommendation: yes, at 12 months, reversible.
3. **Is archived data still visible in the UI?** Recommendation: yes but opt-in — a "include archived" toggle on history views, served from the DuckDB archive, so nothing appears destroyed.

## Complexity Audit

### Routine

- A size/row-count reporting surface (per table, per workspace) in the Setup panel — needed before any policy can be tuned honestly.
- A scheduled rotation job in the sidecar (reuse `ScheduledJobsService`).
- `VACUUM` / `PRAGMA incremental_vacuum` after a rotation, so archived space is actually returned.
- Config keys for the retention windows, with the defaults above.

### Complex / Risky

- **Rotation must be transactional across two databases.** Rows move from SQLite to DuckDB: copy, verify, then delete. A crash between copy and delete duplicates; a crash between delete and commit loses. The only safe order is copy-verify-then-delete-in-a-transaction, with the delete keyed on exactly the row ids that were verified present in the archive.
- **`plan_events` is referenced by plan history views.** Aging events out changes what those views can show. Any query that assumes the full event history is present must either join the archive or be explicit that it shows the retained window only. Silently truncated history is worse than visibly truncated history.
- **Dormant-workspace archival is reversible and must prove it.** Moving a workspace out and back must be lossless across all ~19 scoped tables, with id remapping in both directions — the same machinery as per-project export/import. Reuse it; do not write a third implementation.
- **Growth measurement has to precede policy.** Setting a 180-day window without knowing the actual row rates is guesswork. The reporting surface should ship first, ideally in the same release as consolidation, so the policy is tuned against real data.

## Edge-Case & Dependency Audit

**Race conditions**
- Rotation running concurrently with a backup or a merge: share the single lock, skip rather than queue.
- Rotation deleting rows a live board query is mid-read on: WAL gives readers a consistent snapshot, so this is safe with the real binding and unsafe without it.

**Security**
- The DuckDB archive now aggregates every project's history. Same posture as the global DB: `0600`, `0700` directory, refuse a path inside a git work tree or a sync folder.

**Side effects**
- `AutoArchiveService` currently archives on its own schedule; folding it into one rotation job avoids two services competing for the same rows.
- `VACUUM` rewrites the whole file and needs free space equal to the database size. On a nearly-full disk it must be skipped with a warning, not attempted and failed.
- Archive path resolution currently follows `db-pointer` (`:1237`, `:1271`); that resolution is removed by the global-database plan, so the archive path must be repointed at the global store in that plan, not this one.

**Migration**
- Existing per-repo DuckDB archives need consolidating alongside their SQLite counterparts, or explicitly left in place and read where found. Recommendation: leave them, read where found, and archive new rotations to the global archive — merging historical archives is not worth the risk.
- No destructive default. Ship rotation off, report sizes for one release, then enable defaults.

## Dependencies

- **Requires** the single-global-database plan (this is a consequence of it).
- **Interacts with the control-plane scaffold plan** — that plan is what first puts bodies in the store, so the `control_plane` rotation above cannot be built before it lands.
- **Requires** the real-binding plan (safe concurrent rotation, and `VACUUM` needs a real binding).
- **Reuses** the export/import id-remapping machinery from the backup/export plan for dormant-workspace archival.

## Adversarial Synthesis

Key risks: rotation must be transactional across two databases (SQLite to DuckDB — crash between copy and delete duplicates, crash between delete and commit loses); `plan_events` is referenced by plan history views, so aging events out silently truncates visible history; and dormant-workspace archival must be reversible and lossless across all ~19 scoped tables with id remapping in both directions. Mitigations: copy-verify-then-delete-in-a-transaction with delete keyed on verified row ids; ship the reporting surface first and rotation disabled for one release; and reuse the export/import id-remapping machinery rather than writing a third implementation.

## Proposed Changes

1. **Reporting first.** A Setup-panel surface showing per-table and per-workspace row counts and byte sizes, plus growth since last check. Ships before any rotation.
2. **`src/services/RetentionService.ts` (new).** One scheduled rotation job replacing `AutoArchiveService`'s independent schedule: copy-verify-delete of event/log rows past the window into the DuckDB archive, then `PRAGMA incremental_vacuum` when free space allows.
3. **Dormant-workspace archival** via the export/import machinery, reversible, with a stub row so the workspace is reactivatable.
4. **History queries** gain an explicit "retained window only" state and an opt-in archive join, so truncation is visible.
5. **Config keys** for the windows, defaulting to rotation disabled for one release.

### Migration

Non-destructive by construction. Existing per-repo DuckDB archives are left in place and read where found. Rotation ships disabled; enabling it is a separate release once the reporting surface has produced real numbers.

## Verification Plan

- **Rotation correctness:** seed `plan_events` with rows either side of the window; rotate; assert in-window rows remain in SQLite, out-of-window rows are present in DuckDB *and* absent from SQLite, and total row count across both is unchanged.
- **Crash safety:** kill the process between copy and delete, and between delete and commit. Assert no duplication and no loss in either case, and that re-running rotation converges.
- **Dormant round-trip:** archive a workspace with rows in all scoped tables; reactivate; assert every table's rows and every integer reference match the original.
- **History visibility:** with rotation applied, assert history views either show the full set via the archive join or explicitly report a retained window — never silently short.
- **Vacuum guard:** simulate low free space; assert `VACUUM` is skipped with a warning rather than attempted.
- **Concurrency:** rotation running while the board is being driven; assert no read errors and no lost writes.
- **Control-plane pruning:** seed three versions of a definition plus one carrying a local override; prune; assert current-plus-one-prior survive, the overridden row survives regardless of age, and the projection still regenerates byte-identically afterwards.
- **Default-off:** assert a fresh install performs no rotation until explicitly enabled.

### Goal Invariants

- After rotation, out-of-window rows in `plan_events`, `activity_log`, `job_runs`, and `board_move_requests` are absent from SQLite and present in DuckDB — the hot database has a bounded working set.
- Total row count across SQLite and DuckDB is unchanged by rotation — no data is lost.
- Archived data is queryable via the archive join, or the view explicitly reports a retained window — never silently short.
- A dormant workspace archived and reactivated has matching rows in every scoped table — archival is reversible.

## Outstanding Questions

- What are the actual row rates? Unknown until the reporting surface ships — every window number in this plan is provisional until then.
- Should the archive be per-workspace or global? Global is simpler and matches the hot DB; per-workspace makes "take my project elsewhere" include its history.
- Does anything query `plan_events` expecting completeness for correctness rather than display (for example, vector-clock or device-id reconciliation)? Those call sites must never see a truncated set.
