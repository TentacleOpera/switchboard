# Notion's board sync is misnamed as "backup" and sits outside the provider seam — move it behind the interface without breaking shipped Notion databases

## Goal

Make Notion's board sync a declared provider capability rather than a standalone service, and rename it to what it is, so the next agent reading the code sees three implementations of one capability instead of two unrelated concerns.

### Problem Analysis

`NotionBackupService` is a full two-way kanban board sync. It creates the Notion database schema itself (`:219`) and writes per plan (`:558-575`):

```
'Kanban Column': select        'Feature': self-relation
'Status': select               'Is Feature': checkbox
'Complexity': number           'Tags': multi_select
'Plan ID': rich_text           'Repo Scope', 'Workspace ID', 'Session ID'
'ClickUp Task ID', 'Linear Issue ID'
```

`restoreFromNotion()` (`:96`) reads it back, applies columns keyed on `planId` (`:155`, explicitly never `sessionId`), re-aligns all subtasks including completed and deleted ones so a restored feature leaves no orphans (`:165`), and resolves feature relations in a second pass (`:173`).

Two problems follow from where it lives:

1. **It is outside the provider seam.** `NotionRemoteProvider` declares `{ pull, push, archive }` and knows nothing about board sync, so no capability gate, no UI gating, and no contract test can see the most valuable thing Notion does.
2. **The name actively misleads.** Sitting beside `LinearSyncService` and `ClickUpSyncService`, `NotionBackupService` reads as a different concern. That is the mechanism by which this stayed hidden through repeated parity work — including, during the session that produced this plan, an initial wrong conclusion that Notion was *not* a board provider.

### Root Cause

The service was built for one job — back the board up — and named for that job. Its capability turned out to be general; its name and location did not follow.

### Non-goals

- No change to the Notion database schema as seen by users. Property names are shipped state.
- Not adding new Notion functionality. This is a move and a rename.
- Not implementing ClickUp or Linear restore.

## Metadata

**Complexity:** 5
**Tags:** architecture, notion, providers, refactor, migration

## User Review Required

None.

## Complexity Audit

### Routine
- Re-exporting existing methods behind the interface.

### Complex / Risky
- **This is working code with real users behind it.** The service is the only board restore path that exists; a regression here removes the capability while claiming to formalise it.
- **Shipped state must migrate, not break.** With roughly 4,000 installs, every name below is load-bearing and cannot simply be renamed.

## Edge-Case & Dependency Audit

Shipped surfaces that a rename must preserve or migrate:

- **The `switchboard.notionBackup` setting key** — present in `package.json` contributions and in users' settings. Preserve it, or migrate the value and keep reading the legacy key.
- **`notionBackupSetupComplete`** in `TaskViewerProvider` (`:8495`) and the Setup panel's `notion-backup-status` element and `notionBackupConfigResult` / `notionBackupResult` / `notionRestoreResult` / `notionBackupProgress` messages — the webview protocol is a contract between two files that must change in lockstep.
- **`~/.switchboard/integration-config.json`** — global, outside the workspace, and with a documented history of corruption. Any key change here needs the existing write guards, not a naive rewrite.
- **The Notion database property names themselves** — `'Kanban Column'`, `'Plan ID'`, `'Feature'` and the rest exist in real user Notion databases. Renaming a property orphans every page. These must not change, whatever the service is called.
- **`notionPageId` round-trip atomicity** — the inbound-delete sweep's race guard depends on it, per the provider-sync feature's review findings. Do not disturb the ordering.

## Dependencies

- **Depends on the capability + contract test plan.** The interface must exist before the implementation moves behind it, and this plan's proof of landing is Notion's board-restore capability declaring `true` through the seam rather than through a service reference.

## Adversarial Synthesis

The tempting version is a pure rename — file and class — leaving the setting keys and webview messages alone "for compatibility". That produces a third naming scheme rather than fewer, and the next reader is worse off than before. Either the user-facing vocabulary moves with a migration, or the rename is not worth doing.

The opposite temptation is to rename everything including the Notion property names, which is the one change that destroys user data.

## Proposed Changes

1. **Expose Notion's board push and restore through `RemoteProvider`**, gated on the new capabilities, with `NotionRemoteProvider` declaring them.
2. **Rename the service to name its capability**, not its original purpose, so it reads as a peer of the ClickUp and Linear equivalents.
3. **Migrate the shipped setting key**, reading the legacy key and preserving unknown or legacy fields rather than dropping them.
4. **Update the webview message names in lockstep** with the Setup panel, both directions, in one change.
5. **Leave every Notion database property name exactly as-is**, and add a test asserting they are unchanged.

### Migration

Required, because all of this shipped. Read the legacy `switchboard.notionBackup` key and migrate forward; preserve unrecognised fields in `integration-config.json`; never assume a prior migration ran. The Notion-side schema is explicitly not migrated — it stays byte-identical.

## Verification Plan

1. **Round trip against a real Notion database created by the old code.** Back up, restore, and confirm all columns and feature relations land — proving the property names still match.
2. **Legacy setting is honoured.** Start with only the old key present; confirm the feature works and the value migrates.
3. **`integration-config.json` keeps unknown keys.** Add an unrecognised field, run the migration, confirm it survives.
4. **The Setup panel still works end to end** — configure, back up, restore, and the Configured/Not configured indicator.
5. **Capability is declared through the seam.** Confirm the contract test sees Notion's board restore as `true` via `capabilities`, not via a service lookup.
6. **Notion property names unchanged.** The assertion test passes.
7. **Inbound-delete sweep unaffected.** Confirm the `notionPageId` round-trip ordering still holds.

## Outstanding Questions

None.
