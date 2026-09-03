# Board state cannot survive machine loss without a third-party account — surface the state file as an explicit export/import

<!-- board-collapse-07 -->
> **THIS IS THE INTERIM RESTORE PATH (2026-09-04, Board Collapse 07).** Say so in the Goal. Until the storage programme's sidecar and backup steps land, the v1 `kanban-state-backup.json` export and import is the **only** way board state moves between machines, which is why it is worth building now even though a stronger mechanism is planned.
> 
> Two sibling paths exist and this plan does not supersede either: *Durable board backups and per-project export/import* (verified backup sets, after the sidecar) and the *Board sync is a capability all three providers implement* feature (rebuilding a board from a tracker, a different operation). None of the three is the only restore.


<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** The Database panel **shipped** in commit `7d71ac56` ("add Database panel to the shell rail, retire Setup tab's DB section"). Delete the framing that command-palette entries are the user-facing path "until the Database panel lands": Export and Import land in the Database panel's "This machine" section directly. Palette entries remain only as an additional route.


## Goal

Give every user an account-free way to carry board state to another machine. The serialiser already exists, runs automatically, and covers the state that matters; it is simply written to a gitignored path inside the project, where a reformat takes it with everything else.

### Problem Analysis

`KanbanDatabase._writeKanbanStateBackup()` already writes `.switchboard/kanban-state-backup.json` automatically. Inspected on a live workspace it holds **2,096 plan records**, each carrying exactly the state that exists nowhere else:

```
kanban_column, feature_id, is_feature, project, complexity, tags,
repo_scope, routed_to, dispatched_agent, dispatched_ide, status,
last_action, linear_issue_id, clickup_task_id, plan_file, plan_id
```

It is `version: 1` and already consumed on a DB recreate — the Setup panel's rebuild path restores plan columns and metadata from it before re-importing plan files. The machinery works.

The gap is where it lives. Both it and `.switchboard/dbbackup/` sit **inside the project and are gitignored** (`.gitignore:52`, `.switchboard/*`). They cover DB corruption and bad migrations, which is what they were built for. They do not survive a reformat, a failed drive, or a fresh clone on a new machine — the case where a user most needs them.

The only machine-independent restore path today is `NotionBackupService.restoreFromNotion()`, which requires a Notion account and integration token. Linear and ClickUp cannot substitute *yet*: both are push-only for board state, with no `restoreFrom*` method and no writes of `kanban_column` back into the DB. The feature *Board sync is a capability all three providers implement, enforced by a contract test* closes that, so in time all three trackers will be restorable.

**That does not retire this plan — it sharpens why it exists.** Every tracker restore requires a third-party account, an integration token, and a configured board. The users least protected against machine loss are precisely those who have configured no integration at all, and no amount of provider parity reaches them. An account-free export is the only path that does, and it is also the only one that works with no network, no vendor, and no token.

Board state is also the state a user cannot reconstruct by hand. Plan and feature markdown is tracked in git and comes back with a clone; 2,096 cards' column positions, feature links, and project assignments do not.

### Root Cause

The state serialiser was built for an internal consumer — the DB rebuild path — and its output was placed accordingly. Nothing wrong with that decision; it simply was never promoted to a user-facing artefact, so its location inherited the constraints of an internal temp file.

### Non-goals

- **Not a new file format.** `kanban-state-backup.json` v1 has shipped and already carries the right fields. Inventing a second format would create two things to keep in sync.
- **Not a sync engine, and not scheduled off-project copies.** Export and import are explicit, user-initiated operations. Automation of the copy is the existing cron/scheduler guidance, covered by the discoverability plan.
- Not changing the automatic write, its trigger, or the DB-rebuild consumer.
- Not extending coverage to the audit trail or ticket registry — see the scope note below.

## Metadata

**Complexity:** 3
**Tags:** backup, portability, migration, board-state

## User Review Required

None.

## Complexity Audit

### Routine
- Export: serialise via the existing writer to a user-chosen path.

### Complex / Risky
- **Import must be additive, never pruning.** A plan present locally but absent from the imported file must be left alone. The opposite behaviour — treating the file as authoritative and deleting the difference — turns a partial or older export into silent data loss. This codebase has already shipped that exact bug class once, where a short fetch destructively pruned local ticket files.
- **Project names must resolve, never create.** Restoring a `project` value has to follow the existing importer rule: an unknown project name leaves the plan unassigned rather than auto-creating a `projects` row. Only the user creates projects, on the board.
- **v1 is a shipped contract.** Because the file already exists on install bases, the reader must keep handling `version: 1` regardless of what later versions add.
- **Cross-machine path assumptions.** `plan_file` is workspace-relative and portable. Other tables in the DB do hold absolute paths, which is precisely why exporting *this file* is the right primitive and copying `kanban.db` is not.

## Edge-Case & Dependency Audit

- **Plans in the file with no local markdown.** The plan was deleted since the export. Restore the row or skip it, but decide explicitly and report the count — do not fail the whole import.
- **Local plans absent from the file.** Leave untouched. See the pruning risk above.
- **Mismatched `workspaceId`.** The file records the workspace it came from. Importing into a different workspace is the actual migration case and must be allowed, but the id mismatch should be surfaced rather than silently rewritten.
- **Feature relations.** `feature_id` and `is_feature` must be applied so features and subtasks reconnect. The existing `restoreFromBackup` (KanbanDatabase.ts:9146) already writes both fields directly in its UPSERT SQL — no second pass is needed.

  > **Superseded:** "following the ordering `restoreFromNotion` already uses — plans first, then a second pass for feature structure, keyed on `planId` and never on `sessionId`."
  > **Reason:** The Notion restore's two-pass pattern exists because it must resolve Notion *page IDs* to local `planId` values. The file backup stores `feature_id` as a local `plan_id` string already — there is no indirection to resolve. `restoreFromBackup` writes `is_feature` and `feature_id` directly in `UPSERT_PLAN_SQL` (line 9271). A second pass would be dead code imitating a pattern from a different restore path whose rationale does not apply here.
  > **Replaced with:** Write `is_feature` and `feature_id` directly in the UPSERT, as `restoreFromBackup` already does. No second pass.
- **Scope honesty.** The file's top level is `workspaceId`, `exportedAt`, `version`, `plans` — so it covers plans and their board state, and **not** `plan_events`, `worktrees`, `imported_docs`, `config`, or `activity_log`. The audit trail and ticket registry are not carried. Say so in the UI rather than implying a full backup.
- **`.switchboard/kanban.db` must never be the recommended migration artefact.** It carries absolute paths across five tables and does not move cleanly between platforms.

## Dependencies

- Independent of the discoverability plan, though they are complementary: that one documents what exists, this one adds the missing capability. This plan owns the command palette entries for its own two operations.
- **Independent of the provider board-sync capability feature**, and not superseded by it. That feature makes all three trackers restorable; this one covers the user with no tracker configured. Do not fold this into it, and do not cut it on the grounds that "Notion/ClickUp/Linear can restore now" — the two serve disjoint populations.
- **Ordering dependency on the Database panel plan** (same feature). The export/import *logic* and *command palette entries* are independent and can land first. The *UI surface* for export/import belongs in the Database panel's "This machine" section, not the Setup panel — see the Superseded callout on Proposed Change #5. If the Database panel has not landed yet, the command palette entries are the user-facing path; the panel section is wired when the panel arrives.

## Adversarial Synthesis

Key risks: (1) the import path could silently prune local plans absent from the imported file — the existing `restoreFromBackup` is additive by design (it iterates the file's plans and UPSERTs, never deletes), but the plan must assert this invariant; (2) the existing method conflates "skipped because plan_file not found on disk" with "skipped because of UPSERT error" into one `skipped` counter — the user cannot tell whether 50 skipped means 50 deleted-since-export or 50 corrupted rows; (3) workspace-id mismatch is silently swallowed — `restoreFromBackup` uses the local `workspaceId` without comparing it to the file's `workspaceId` field, so a cross-workspace import succeeds but the user is never told it happened. Mitigations: extend `restoreFromBackup`'s return type to `{ restored, skipped, notFoundLocally }` and surface the workspace-id mismatch in the result; the additive-only invariant is already enforced by the method's structure (no DELETE statement in the restore path).

## Proposed Changes

1. **Add an explicit Export** that writes the existing v1 state file to a user-chosen location outside the project, via a save dialog. The writer is the existing `_writeKanbanStateBackup` serialiser (KanbanDatabase.ts:9104) — call it with a user-chosen path instead of the fixed `.switchboard/kanban-state-backup.json` path.
2. **Add an explicit Import** by extending the existing `restoreFromBackup` method (KanbanDatabase.ts:9146), which already reads the v1 file, is additive (no DELETE in the restore path), preserves machine-local fields, and writes `is_feature`/`feature_id` directly in the UPSERT. The extensions are: (a) enrich the return type from `{ restored, skipped }` to `{ restored, skipped, notFoundLocally, workspaceMismatch?: string }` — separating plans skipped because their `plan_file` doesn't exist on disk (line 9200) from plans skipped due to UPSERT errors (line 9278); (b) compare the file's top-level `workspaceId` to the local workspace's id and include it in the result rather than silently using the local one; (c) keep project-name resolution-only (an unknown project leaves the plan unassigned — the existing UPSERT already handles this via the `project` column, not a `projects` row lookup).
3. **Report the outcome honestly**: counts for restored, skipped (UPSERT error), not-found-locally (plan_file absent), and a workspace-mismatch notice if applicable, plus a plain statement of what the format does not carry.
4. **Register both as command palette entries**, titled so they are distinct from the integration-config restore (`switchboard.restoreIntegrationConfig`) and from the Notion operations. Suggested titles: "Switchboard: Export Board State" and "Switchboard: Import Board State".
5. **Surface both in the Database panel's "This machine" section** (see the Database panel plan), so the account-free path sits next to the account-based projections. The command palette entries are the user-facing path until the Database panel lands.

   > **Superseded:** "Surface both in the Setup panel beside the existing Notion buttons, so the account-free path sits next to the account-based one."
   > **Reason:** The Database panel plan (same feature) retires the Setup panel's database section and moves all storage operations to a new panel. Placing export/import in the Setup panel recreates the half-ownership this feature exists to fix — two surfaces owning storage.
   > **Replaced with:** Surface export/import in the Database panel's "This machine" section. The command palette entries are independent and can land before the panel exists.

### Migration

No schema or format change. `version: 1` stays the format, and the automatic writer and DB-rebuild consumer are untouched. Because v1 files already exist on install bases, the reader must accept them indefinitely.

## Verification Plan

1. **The machine-loss case, end to end.** Export, clone the repo to a different machine with no Notion account configured, import, and confirm all 2,096 cards return to their correct columns with feature links intact.
2. **Import is not destructive.** Import a file that omits several plans present locally; confirm those plans are untouched and the omission is reported, not applied.
3. **Unknown project names resolve only.** Import a file referencing a project that does not exist locally; confirm the plan lands unassigned and no `projects` row is created.
4. **Feature structure reconnects.** Export a workspace containing features with subtasks, import into an empty board, and confirm `is_feature` and every `feature_id` relation is restored.
5. **v1 compatibility is permanent.** Import a v1 file produced by the current automatic writer, unmodified, and confirm it is accepted.
6. **Workspace-id mismatch is surfaced.** Import a file exported from a different workspace; confirm the migration succeeds and the mismatch is reported.
7. **Scope is stated.** Confirm the UI tells the user the export does not carry the audit trail, worktrees, ticket registry, or config.

### Goal Invariants

- **assert** a command palette entry containing "Export Board State" exists in `package.json` contributes.commands.
- **assert** a command palette entry containing "Import Board State" exists in `package.json` contributes.commands.
- **assert** neither new command palette entry title contains "Restore Integration Config" (collision with `switchboard.restoreIntegrationConfig`).
- **assert** `restoreFromBackup` in `KanbanDatabase.ts` returns a result object with `notFoundLocally` as a numeric field (separated from `skipped`).
- **assert** no `DELETE` SQL statement exists in the `restoreFromBackup` method body (additive-only invariant).
- **assert** the export path writes to a user-chosen location outside `.switchboard/` (the automatic writer's path is unchanged).

## Outstanding Questions

None.
