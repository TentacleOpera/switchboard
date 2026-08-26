# Split the schema into shared board state and machine-local runtime, so a remote store carries only what is actually shared

## Goal

Divide the board's tables along the line of who they belong to: **shared board state** (what a card is and where it sits) versus **machine-local runtime** (which of my terminals is alive right now). Only the shared tier is eligible for a remote authoritative store. This is the prerequisite that makes any remote store viable, and it is the difference between a remote option that works and one that is rate-limited and conflict-ridden a month in.

### Problem Analysis

**Almost all of the board's write volume is machine-local, and almost none of it is shared.** Measured against the current code:

- `recordLiveness()` (`KanbanDatabase.ts:10394`) issues one `UPDATE plans SET last_liveness_at = ?, blocked_at = NULL` per sweep tick. Its own comment states the rate: "~1 write per live card per 10s". Twenty live cards running continuously is ~172,800 row writes a day.
- The plan scanner runs every 10 seconds by default (`switchboard.planScanner.intervalSeconds`, default `10`, `enabled` default `true`) and `_planScannerSweep()` calls into the rescan path that the code itself labels "the write step".
- Against that, the genuinely shared facts — a card's column, its feature link, its project, its complexity — change at human pace. Tens to hundreds of writes a day.

So the tables are not equally shared, and treating them as one unit means a remote store absorbs six orders of magnitude more traffic than the shared data justifies.

**The shared subset is already enumerated, twice, by code that shipped.** `BoardSnapshotPublisher`'s `BoardCardEntry` is `{ plan_id, topic, column, feature, project, complexity, planFile }` — someone already decided what a shared board card is when they built the read-only snapshot. `_writeKanbanStateBackup()` names nearly the same set, and `portable-board-state-export-import.md` reports it holding 2,096 records of `kanban_column, feature_id, is_feature, project, complexity, tags, repo_scope, routed_to, dispatched_agent, dispatched_ide, status, last_action, linear_issue_id, clickup_task_id, plan_file, plan_id`. Two independent serialisers converged on the same answer.

**The local subset is equally identifiable, and sharing it would be actively wrong.** `dispatched_terminal` names a terminal on one machine. `last_liveness_at` asserts that a process on one machine is alive. `worktrees` rows describe directories on one filesystem. Replicating those to a shared store does not merely waste writes — it means two machines fight over fields that were never about each other, and machine A's board claims a card is dispatched to a terminal that exists only on machine B.

**The vestigial evidence that this was foreseen.** `plan_events` declares `device_id` and `vector_clock` (`KanbanDatabase.ts:329-330`), but both INSERT sites (`:9578`, `:9745`) write only `device_id`, as `os.hostname()`. Someone anticipated multi-device writes, added the columns, and the write path never followed.

### Root Cause

One database per repository, opened by one machine, made the distinction invisible. Every row was equally local because everything was local. Nothing in the schema had to record who a fact belonged to, so nothing did.

### Non-goals

- Implementing a remote store. This plan defines the tiers; the libSQL and git-carried plans consume them.
- Splitting on age. That axis belongs to `storage-topology-one-choice-three-stores.md`, which supersedes the hot/cold file split; this plan splits on *ownership*. The two are orthogonal: ownership decides what may travel to a shared store, temperature decides what stays in the working set.
- Reviving `vector_clock`. Under a serialising store the server orders writes; a vector clock is the wrong mechanism and should be deleted, not populated.

## Metadata

**Complexity:** 9
**Tags:** database, backend, refactor, infrastructure, reliability, performance

## User Review Required

Yes — three decisions.

1. **Tier boundary for the ambiguous columns.** `status`, `routed_to`, `dispatched_agent`, `dispatched_ide`, `last_action` sit between the tiers: they describe work, but the work happened on one machine. Recommendation: `status` and `routed_to` are shared (they are decisions about the plan); `dispatched_agent`, `dispatched_ide`, `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` are local (they are facts about a process).
2. **Mechanism.** A `tier` marking on existing tables, versus physically separate tables for local runtime state. Recommendation: separate tables for the local tier, keyed by `plan_id` + `device_id`. A tier column on `plans` leaves shared and local fields in one row, so a shared-store write has to carry local columns or partially update — the failure mode this plan exists to prevent.
3. **Does the local tier survive a store switch?** Recommendation: yes, and it never migrates — it is machine-truth, re-derived from the live fleet on startup. Migrating it would import another machine's liveness claims.

## Complexity Audit

### Routine

- Enumerating the columns per tier and writing the mapping down as a single exported constant, so no future reader has to re-derive it.
- Deleting the unwritten `vector_clock` column.
- Adding `user_id` alongside `device_id` where attribution is written (the attribution plan owns the value; this plan owns the column).

### Complex / Risky

- **`plans` is one wide table holding both tiers.** The split means either new local-tier tables with a foreign key, or a rebuild of `plans`. Every read that currently selects both — `getBoardFilteredByProject` (`:3152`), the board projection at `:917`, `getWorktrees()` — becomes a join. That is the bulk of the work and it touches the hottest read paths in the product.
- **The board's activity light spans the tiers.** `MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at))` (`:6552`, `:10355`) is a local-tier predicate feeding a shared-tier card's rendering. Correct, but it means the board view is a join across tiers by design, and the local side may be absent for cards dispatched elsewhere. The UI has to distinguish "not dispatched" from "dispatched on a machine that is not this one".
- **N+1 read patterns get worse before they get better.** The storage feature already warns that "the ~780 existing sql.js touchpoints assume microsecond in-memory reads, so the per-card N+1 patterns need auditing and batching". Introducing a join multiplies that; the batching audit is a hard prerequisite, not a follow-up.
- **Deciding tier for `projects`, `config`, `project_config`, `job_instructions`, `imported_docs`, `activity_log`, `plan_events`.** Each needs an explicit call. `plan_events` is the subtle one: it is append-only history of shared decisions, but each row records the machine that made them — so it is shared with a local attribution column, not local.

## Edge-Case & Dependency Audit

**Race conditions**
- A card dispatched on machine A and moved on machine B: the shared move must land without touching A's local dispatch row, and A must notice its card moved under it. This is the case that proves the split — under one merged row it is a lost write.
- Local-tier rows outliving their shared row (a plan deleted elsewhere while dispatched here) need an orphan sweep, not a foreign-key failure.

**Security**
- The local tier holds filesystem paths and terminal names. Keeping it off the shared store is a privacy improvement worth stating: a teammate's shared board should not learn your directory layout.

**Side effects**
- `BoardSnapshotPublisher`'s `BoardCardEntry` becomes the canonical shared-tier projection rather than one of two serialisers that agree by coincidence. Worth making that explicit in code.
- `_writeKanbanStateBackup` and the export format should be regenerated from the same tier constant, so the three serialisers cannot drift again.
- `AutoArchiveService`, `ArchiveManager` and the retention plan all need to know which tier they are pruning.

**Migration**
- Published extension, ~4,000 installs. Every column being split shipped. Local-tier values must be *copied* into the new local tables before being dropped from `plans`, in one transaction, preserving unknown/legacy columns enumerated from `PRAGMA table_info`. A no-op for a single-machine user, which is most of them — and that is the test: after migration a solo install's board must render byte-identically.

## Dependencies

- **Hard prerequisite:** the sidecar/real-binding plan. These table rebuilds under whole-file `export()` are the clobber scenario that plan exists to end.
- **Pairs with** the unscoped-tables plan (`scope-unscoped-tables-by-workspace-id.md`) — both rebuild tables, and doing them in one pass is cheaper and safer than two rebuilds of `worktrees`.
- **Blocks** the libSQL and git-carried store plans. Neither is safe to build before the tier boundary exists.

## Adversarial Synthesis

Key risks: `plans` is one wide table holding both tiers, so the split turns the hottest read paths into joins on top of an already-flagged N+1 problem; the activity light is a cross-tier predicate, so the UI must distinguish "not dispatched" from "dispatched elsewhere"; and the ambiguous columns (`status`, `routed_to`, the `dispatched_*` family) have no obviously correct tier. Mitigations: the batching audit is a prerequisite rather than a follow-up; a single exported tier constant that all three serialisers derive from; explicit per-column decisions recorded in the plan rather than left to the implementer; and a solo-install byte-identical board as the migration's acceptance test.

## Proposed Changes

1. **`src/services/storageTiers.ts` (new)** — one exported constant naming every table and column's tier, and the projection helpers. The single source the board view, the snapshot publisher, the state backup and the export format all derive from.
2. **Local-tier tables** keyed by `plan_id` + `device_id`, holding the `dispatched_*` family, `last_liveness_at`, `blocked_at`, and `worktrees`. Never remote, never migrated, re-derivable from the live fleet. **Must live in a separate database file (the Runtime store defined by `storage-topology-one-choice-three-stores.md`), not in the Board database** — libSQL embedded replica sync is whole-database (confirmed by research), so local-tier tables inside the Board DB would be replicated to every teammate, which is exactly the failure mode this plan exists to prevent.
3. **Rebuild `plans`** without the local columns, in the same pass as the workspace-scoping rebuild. Drop `plan_events.vector_clock`; add `user_id` beside `device_id`.
3b. **Register imported ticket metadata as shared tier.** `plan_tickets` (`ticket-metadata-as-first-class-board-state.md`) is shared board state and travels with the Board store — a plan imported from Linear must carry its ticket context to every machine and teammate. Today the board holds only `plans.linear_issue_id` / `clickup_task_id` as bare strings while the metadata sits in gitignored files under `.switchboard/tickets/`, so it is neither shared nor durable. The tier constant must name it, or the shared store carries plans whose ticket context is blank for everyone but the importer.
4. **Convert the cross-tier reads to joins**, after the N+1 batching audit, starting with `getBoardFilteredByProject` and the board projection. **Research constraint (ATTACH):** because the local tier lives in a separate database (Runtime store) and libSQL does not support `ATTACH DATABASE` in embedded replica mode, cross-tier joins cannot use SQL-level `ATTACH` when Board is a remote target. The join must be an application-level merge in TypeScript — open separate connections to Board and Runtime, fetch by `plan_id`, and merge in-process. When Board is a local file (default target), `ATTACH` may work, but the code path must not depend on it.
5. **Make the shared-tier projection explicit** in `BoardSnapshotPublisher` and the state-backup writer by deriving both from `storageTiers.ts`.
6. **Orphan sweep** for local-tier rows whose shared row is gone.

### Migration

One transaction per install: create local tables, copy the local columns out of `plans`, verify row counts, rebuild `plans` without them, preserve unknown columns from `PRAGMA table_info`. Resumable; a crash leaves the pre-migration database readable. Never unlink anything.

## Verification Plan

- **Solo-install invariance:** a real board with 2,000 cards, migrated. Assert the rendered board is identical before and after, including activity lights.
- **Cross-machine move:** simulate two `device_id`s. Card dispatched under A, moved under B. Assert B's move lands, A's dispatch row is untouched, and A observes the column change.
- **Dispatched-elsewhere rendering:** a shared card whose only local row belongs to another `device_id`. Assert the UI shows it as dispatched elsewhere, not as undispatched and not as locally dispatched.
- **Write-volume measurement:** instrument a representative session and count writes per tier. Assert the shared tier is human-paced (hundreds/day) and that the local tier holds the liveness traffic. This is the number the remote-store plans budget against, so it must be measured, not asserted.
- **Legacy columns:** a source with an unknown extra column on `plans`; assert it survives the rebuild.
- **Orphans:** delete a shared row with a live local row; assert the sweep clears it and nothing throws.
- **No revival:** grep-level regression asserting `vector_clock` is gone.

### Goal Invariants

- **Local columns absent from `plans`:** assert `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` are absent from the `plans` DDL in `src/services/KanbanDatabase.ts` after migration.
- **Local columns resolvable in local tier:** assert a local-tier table keyed by `plan_id` + `device_id` exists and holds those four columns (paired positive — absent *here*, present *there*).
- **`vector_clock` gone:** assert `plan_events.vector_clock` is absent from the schema and from every INSERT site.
- **Single tier source:** assert `BoardSnapshotPublisher.BoardCardEntry` and `_writeKanbanStateBackup` contain no hardcoded shared-field list — both derive from the exported tier constant in `src/services/storageTiers.ts`.
- **No shared-store write touches a local column:** assert no write path that targets the shared tier inserts or updates a local-tier column (the failure mode this plan exists to prevent — a read-volume measurement does not catch a stray local-column write).
- **`device_id` stability:** assert `device_id` is a stable machine identifier across reboots (not `os.hostname()` if hostname can drift), or that the local-tier key uses a persisted stable id — the orphan sweep and "re-derived from the live fleet" claim both depend on this.
- **Solo-install byte-identical board:** assert a single-machine install's rendered board is identical before and after migration, including activity lights.

## Outstanding Questions

- **Resolved: the scanner is change-gated, so it is not a meaningful shared-tier write source.** `_rescanAntigravityPlanSourcesImpl` skips before writing when a candidate is already known and unmodified: `if ((existingEntry || hasDbRow) && !isRecent) { continue; }`, with `isRecent` computed from `birthtimeMs`/`mtimeMs` against a cutoff of the previous rescan. Steady state with no file changes produces zero row writes from the sweep. It does perform a `db.hasPlan()` **read** per candidate per 10s tick, which is free locally or against an embedded replica and a per-candidate round trip against a remote-only connection — recorded in the libSQL plan as a further argument for replica-only.
- **Resolved: the local tier must be a separate database file, not separate tables in the Board DB.** Research confirmed libSQL embedded replica sync is whole-database with no partial replication. Local-tier tables inside the Board database would be replicated to every teammate — the exact failure mode this plan exists to prevent. The separate file is the Runtime store defined by the topology plan. This also means cross-tier joins are cross-database and must be application-level when Board is an embedded replica (ATTACH DATABASE is unsupported in replica mode).
- `projects` is shared, but project *filters* are per-operator UI state. Are they local-tier, or not board state at all?
