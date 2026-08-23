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
- Splitting into two *files*. The hot/cold plan (`split_kanban_hot_cold_dbs.md`) splits on age; this splits on ownership. They are orthogonal and should not be conflated — a single database can carry a tier column.
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
2. **Local-tier tables** keyed by `plan_id` + `device_id`, holding the `dispatched_*` family, `last_liveness_at`, `blocked_at`, and `worktrees`. Never remote, never migrated, re-derivable from the live fleet.
3. **Rebuild `plans`** without the local columns, in the same pass as the workspace-scoping rebuild. Drop `plan_events.vector_clock`; add `user_id` beside `device_id`.
4. **Convert the cross-tier reads to joins**, after the N+1 batching audit, starting with `getBoardFilteredByProject` and the board projection.
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

## Outstanding Questions

- Does the plan scanner's sweep write on every tick or only on content change? Unresolved by reading, and it decides whether the scanner is a shared-tier write source at all. Must be measured before the remote-store plans quote a write budget.
- Should the local tier be a separate database file rather than separate tables, so a corrupt local tier can be discarded without touching shared state?
- `projects` is shared, but project *filters* are per-operator UI state. Are they local-tier, or not board state at all?
