# Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints

## Goal

Bring every table in `kanban.db` under the `workspace_id` scoping convention the schema already half-follows, and remove the three UNIQUE/PRIMARY KEY constraints that would collide the moment two workspaces share one database. This is additive schema work, shippable and useful on its own, and it is a hard prerequisite for consolidating to a single global database.

### Problem Analysis

The schema is roughly half multi-tenant. `workspace_id` appears 260 times in `src/services/KanbanDatabase.ts`, and these tables carry it: `plans`, `projects`, `worktrees` (added by a later migration on some paths — see below), `config`, `project_config`, `imported_docs`, `import_sync_meta`, `migration_meta`, `skips`. `projects` is already `UNIQUE(name, workspace_id)`, so two workspaces can each own a project called "Backend" today.

Ten tables are not scoped, and three of them carry constraints that will actively fail:

| Table | Constraint | Failure in a shared DB |
| :--- | :--- | :--- |
| `worktrees` | `branch TEXT NOT NULL UNIQUE` | **Hard failure.** Two projects each with a `main`, `develop`, or `feature/login` branch violate UNIQUE on insert |
| `job_instructions` | `file TEXT NOT NULL UNIQUE` | Two repos with the same relative instruction path collide |
| `kanban_meta` | `key TEXT PRIMARY KEY` | Per-workspace meta silently overwrites across projects |
| `activity_log` | `id` only | Becomes one mixed stream, unfilterable by project |
| `board_move_requests` | `id` only | Same |
| `job_runs` | `id` only | Same |
| `plan_events` / `plan_events_v20` | `event_id` only | The audit trail loses project attribution |
| `stitch_projects` | `id TEXT PRIMARY KEY` | Design-system rows unattributable |
| `stitch_screens` | `id TEXT PRIMARY KEY` | Same |

`linear_issue_links.issue_id TEXT PRIMARY KEY` is the one exception that is genuinely fine — Linear issue ids are globally unique, so no scoping is required.

Note `worktrees`: the CREATE TABLE has no `workspace_id`, and `SCHEMA_WORKTREE_COLUMN_DEFS` (`:953`) reconciles only the additive V34/V42 columns (`project`, `agents_open_with_grid`, `subtask_plan_id`, `base_branch`, `tier`). The `branch` UNIQUE is on the base table and has never been scoped.

### Root Cause

The schema grew per-workspace-database-first. Because each database served exactly one workspace, `workspace_id` was added only where cross-workspace mapping features needed it (`plans`, `projects`, `config`) and skipped everywhere the implicit "one DB = one workspace" invariant already made it redundant. That invariant is about to be removed.

### Non-goals

- Consolidating databases (separate plan — this one only makes the schema able to survive it).
- Changing the storage engine (separate plan, lands first).
- Backfilling data from other databases. This plan backfills each existing DB's own rows with its own `workspace_id`.

## Metadata

**Complexity:** 6
**Tags:** database, backend, refactor, reliability

## User Review Required

Yes — one decision. For `worktrees`, the fix could be `UNIQUE(branch, workspace_id)` or dropping UNIQUE and enforcing uniqueness in application code. Recommendation: `UNIQUE(branch, workspace_id)`, because branch uniqueness within a repo is a real invariant worth keeping at the DB layer. Confirm no code relies on looking a worktree up by branch alone without a workspace — `getWorktreeByBranch()` is the call site to check.

## Complexity Audit

### Routine

- `ALTER TABLE ... ADD COLUMN workspace_id TEXT` on the nine tables that need it (all nullable-then-backfilled; `NOT NULL` cannot be ALTER-ADDed onto a populated table — the same constraint documented at `:953`).
- Backfill `UPDATE <table> SET workspace_id = <the DB's own workspace id> WHERE workspace_id IS NULL` for each.
- Adding `(workspace_id, ...)` composite indexes matching the existing convention (`idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)` is the pattern).
- Adding `workspace_id` to the SELECT lists and WHERE clauses of the reader methods for those tables.

### Complex / Risky

- **Changing a UNIQUE constraint requires a table rebuild.** SQLite cannot `ALTER TABLE ... DROP CONSTRAINT`. `worktrees`, `job_instructions`, and `kanban_meta` each need the 12-step rebuild: create new table with the new constraint, copy rows, drop old, rename, recreate indexes. Under a migration that must be idempotent and interruption-safe, this is the riskiest part of the plan — an interrupted rebuild that leaves `worktrees_new` behind must be recoverable.
- **`kanban_meta.key TEXT PRIMARY KEY` -> `PRIMARY KEY (key, workspace_id)`** changes row identity. Every reader currently written as "get meta by key" becomes "by key and workspace". Missing one gives a cross-project read that silently returns another project's value.
- **`plan_events` vs `plan_events_v20`.** There are two event tables and a V20 migration that copies between them (`:715-716`). Both need scoping, and the copy statement's column list must be updated in lockstep.
- **Writers must all supply `workspace_id`.** Any INSERT that omits it after this change writes an unattributable row that no scoped reader will ever see again — a silent data-loss shape. Mitigation: make the column `NOT NULL` on the rebuilt tables, so an omission throws at insert rather than disappearing.

## Edge-Case & Dependency Audit

**Race conditions**
- The migration runs at open. With the sidecar plan landed there is exactly one opener, so no concurrent-migration race. If this ships *before* the sidecar plan, two hosts could attempt the table rebuilds simultaneously — so either ship after, or wrap each rebuild in a transaction and make it idempotent.

**Security**
- None directly. But note that after this change a missing `workspace_id` predicate in a reader is a cross-project data leak within one user's own machine — low severity, but it is the class of bug to grep for in review.

**Side effects**
- `getWorktreeByBranch()` and any `worktrees` lookup keyed on branch alone changes signature.
- `WorkspaceIdentityService.buildMappingIndexFromDbs()` reads across DBs and derives mappings; adding `workspace_id` to more tables may make some of its inference unnecessary, but do not remove that here — the mapping subsystem is retired in the global-DB plan.
- The V20 backfill at `:715-716` and the `workspace_name` backfill that reads `json_extract(m.value, '$.id') = plans.workspace_id` both touch this area; re-run them after the new columns land if they are version-gated below the new migration number.

**Migration**
- Published extension, ~4,000 installs, many on much older versions: every one of these tables shipped, so all of this is additive-plus-backfill, never drop-and-recreate-empty. The three table rebuilds must copy every row, including columns this codebase does not know about (a user on a newer dev build could have extra columns) — enumerate columns from `PRAGMA table_info` at runtime rather than from a hardcoded list.
- Assume no prior migration ran. The version gate must be a new sequential version, and the reconciliation must be safe to re-run against a DB that already has the columns.

## Dependencies

- **Should land after** the sidecar/real-binding plan, so the table rebuilds run under a single writer with real transactions.
- **Blocks** the single-global-database plan absolutely — `worktrees.branch UNIQUE` makes consolidation impossible.

## Adversarial Synthesis

Key risks: three UNIQUE/PRIMARY KEY constraint changes require table rebuilds (SQLite cannot DROP CONSTRAINT) — an interrupted rebuild must be recoverable; `kanban_meta.key PRIMARY KEY` → `PRIMARY KEY (key, workspace_id)` changes row identity, so every "get meta by key" reader becomes "by key and workspace" (missing one gives a cross-project read); and any INSERT omitting `workspace_id` after the change writes an unattributable row no scoped reader will ever see. Mitigations: wrap each rebuild in a transaction, enumerate columns from `PRAGMA table_info` at runtime to preserve unknown/legacy columns; make `workspace_id` NOT NULL on rebuilt tables so omission throws at insert; and a schema-invariant test asserting every table except `linear_issue_links` carries `workspace_id`.

## Proposed Changes

1. **`src/services/KanbanDatabase.ts` migration list.** One new sequential version adding: `workspace_id TEXT` to `activity_log`, `board_move_requests`, `job_runs`, `plan_events`, `plan_events_v20`, `stitch_projects`, `stitch_screens`, plus backfills.
2. **Three table rebuilds** in the same version: `worktrees` (`UNIQUE(branch, workspace_id)`), `job_instructions` (`UNIQUE(file, workspace_id)`), `kanban_meta` (`PRIMARY KEY (key, workspace_id)`), each column-enumerated from `PRAGMA table_info` and wrapped in a transaction.
3. **Composite indexes** on `(workspace_id, ...)` for the new columns, matching the existing naming convention.
4. **Reader/writer updates** for every method touching those ten tables — add the `workspace_id` predicate and the insert value.
5. **A schema-invariant test** asserting every table except `linear_issue_links` carries `workspace_id`, so a future table cannot be added unscoped.

### Migration

Additive columns plus three transactional rebuilds, all under one new version gate, all idempotent. No file is deleted and no data is dropped. Because the rebuilds copy by runtime-enumerated columns, a DB carrying unknown/legacy columns preserves them rather than losing them.

## Verification Plan

- **Schema invariant test:** enumerate tables via `PRAGMA table_info`; assert `workspace_id` present on all but `linear_issue_links`. This is the regression guard that keeps the invariant true.
- **Collision test:** insert two worktrees with branch `main` under different `workspace_id` values; assert both succeed. Repeat for `job_instructions.file` and `kanban_meta.key`.
- **Migration idempotency:** run the migration twice against the same DB; assert no error and no duplicated rows.
- **Interrupted rebuild:** kill the process mid-rebuild (after CREATE, before RENAME); reopen; assert the DB is intact and the migration completes.
- **Legacy-column preservation:** seed a DB with an extra unknown column on `worktrees`; run the rebuild; assert the column and its values survive.
- **Old-version DB:** run against a DB stamped at several older schema versions, including pre-V20, pre-V34, and pre-V42; assert each reaches head.
- **Unattributable-write guard:** assert an INSERT omitting `workspace_id` throws rather than writing a NULL-scoped row.

### Goal Invariants

- `PRAGMA table_info` on all ten previously-unscoped tables shows `workspace_id` — every table is multi-tenant.
- `worktrees.branch UNIQUE` is scoped to `(branch, workspace_id)` — two projects with a `main` branch coexist.
- `job_instructions.file UNIQUE` is scoped to `(file, workspace_id)` — two repos with the same instruction path coexist.
- `kanban_meta.key PRIMARY KEY` is scoped to `(key, workspace_id)` — per-workspace meta does not overwrite across projects.
- An INSERT omitting `workspace_id` throws — no NULL-scoped row can be written.

## Outstanding Questions

- Does anything outside `KanbanDatabase` write to these ten tables directly (agent scripts under `scripts/`, `move-card.js`, `create-feature.js`)? Those writers need the new column too.
- `plan_events` and `plan_events_v20` both exist — is the older one still read anywhere, or can this plan drop it after confirming the V20 copy completed on all install paths?

## Implementation Summary

Scoped all ten previously unscoped tables (`worktrees`, `job_instructions`, `kanban_meta`, `activity_log`, `board_move_requests`, `job_runs`, `plan_events`, `plan_events_v20`, `stitch_projects`, `stitch_screens`) to `workspace_id`. Executed migration V70 which safely rebuilds `worktrees`, `job_instructions`, and `kanban_meta` using `PRAGMA table_info` runtime column enumeration to preserve unknown/legacy columns and heal interrupted rebuilds while enforcing `NOT NULL` on rebuilt tables and compound uniqueness constraints (`(branch, workspace_id)`, `(file, workspace_id)`, and `PRIMARY KEY (key, workspace_id)`). Updated all reader and writer queries in `KanbanDatabase` to consistently filter and insert `workspace_id`. Created `src/test/schema-workspace-id-invariant.test.js` validating schema multi-tenancy invariants, collision handling, `NOT NULL` rejection of unattributable writes, and migration rebuild safety.
