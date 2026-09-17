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

**Key risks:** (1) Board-sync methods are exposed as public class methods instead of declared interface methods, making the capability gate decorative — the `createPageForPlan` precedent at `:262` shows this pattern already exists. (2) The method signatures are unspecified, so ClickUp/Linear plans invent incompatible contracts. (3) A regression in the only working board restore removes the capability while claiming to formalise it. **Mitigations:** Methods are declared on `RemoteProvider` with explicit signatures; the contract test calls the method (not just reads the flag); round-trip verification against a real Notion database created by the old code proves no regression.

The tempting version is a pure rename — file and class — leaving the setting keys and webview messages alone "for compatibility". That produces a third naming scheme rather than fewer, and the next reader is worse off than before. Either the user-facing vocabulary moves with a migration, or the rename is not worth doing.

The opposite temptation is to rename everything including the Notion property names, which is the one change that destroys user data.

## Proposed Changes

1. **Expose Notion's board push and restore through `RemoteProvider` as declared interface methods**, gated on the new capabilities, with `NotionRemoteProvider` declaring them. The methods must be ON the `RemoteProvider` interface (optional, gated on capability flags), not merely public methods on the class — `NotionRemoteProvider.createPageForPlan` (`:262`) is the cautionary precedent: a public method the interface doesn't declare, invisible to any capability gate. The board-sync methods are:
   - `boardSyncPush?(plans: KanbanPlanRecord[]): Promise<{ success: boolean; pushed: number; skipped: number; error?: string }>` — bulk push (delegates to the renamed service's backup method).
   - `boardSyncRestore?(workspaceRoot: string, progress?): Promise<{ success: boolean; restored: number; skipped: number; error?: string }>` — bulk restore (delegates to the renamed service's restore method).
   These signatures are the contract ClickUp and Linear will implement in their respective plans. Specifying them here means the three implementations match, not three guesses.
2. **Rename the service to name its capability**, not its original purpose, so it reads as a peer of the ClickUp and Linear equivalents.
3. **Migrate the shipped setting key** (`switchboard.notionBackup` at `package.json:706`), reading the legacy key and preserving unknown or legacy fields rather than dropping them.
4. **Update the webview message names in lockstep** with the Setup panel (`setup.html` — `notionBackupSetupComplete`, `notionBackupConfigResult`, `notionBackupResult`, `notion-backup-status`, `notion-backup-btn`, `notion-restore-btn`), both directions, in one change.
5. **Leave every Notion database property name exactly as-is** (`'Kanban Column'`, `'Plan ID'`, `'Feature'`, `'Status'`, `'Complexity'`, `'Tags'`, `'Is Feature'`, `'Repo Scope'`, etc. — `NotionBackupService.ts:557-575`), and add a test asserting they are unchanged.

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

## Implementation summary (2026-09-16)

`RemoteProvider` gained optional `boardSyncPush?(plans)` / `boardSyncRestore?(workspaceRoot, progress?)` methods plus `BoardSyncProgress`/`BoardSyncPushResult`/`BoardSyncRestoreResult` types (the progress type is structural, so the vscode-free provider seam stays vscode-free). `NotionRemoteProvider` implements both, delegating to the renamed service; the provider deps gained optional `boardSync` + `workspaceRoot`, wired in `KanbanProvider._buildRemoteProvider` via a new cached `_getNotionSyncService`. `NotionBackupService` → `NotionSyncService` (file, class, `NotionSyncConfig`, log prefix) with a new `KanbanProvider.getRemoteProvider(root, kind)` composition-root accessor, and the push/restore handlers (`handleNotionBoardPush`/`handleNotionBoardRestore`) now go through the provider seam, gated on `capabilities.boardPush`/`boardRestore` rather than a service reference.

Migration, per the plan's shipped-state rule: `switchboard.notionBackup` → `switchboard.notionSync` (copied forward on activation, legacy key left in settings.json because VS Code rejects `update()` on an unregistered key); the workspace config file moves to `notion-sync-config.json` with the legacy `notion-backup-config.json` read once, written forward, unknown keys preserved, and the legacy file never unlinked; the Setup panel result messages and element ids move in lockstep (`notionSyncConfigResult`/`notionSyncResult`/`notionSyncRestoreResult`/`notionSyncProgress`, `notion-sync-status`/`-error`/`-progress`, `.notion-sync-btn`/`.notion-sync-restore-btn`). The protocol command verbs (`backupToNotion`, `restoreFromNotion`, `configureNotionBackup`) and the service method names are deliberately unchanged — the plan preserves the method names and the verbs are generated protocol names that match them.

The Notion database schema is explicitly NOT migrated: two new tests pin the push-payload and database-creation property names byte-for-byte, and a third pins the legacy-config migration. The parity contract test now proves Notion's board sync through the interface method (probed with a mock sync service, not just declared) and drops the old `NotionBackupService` service-lookup evidence; `protocol-catalog.json` was regenerated. Compilation and test execution were skipped per this run's directives.

## Review Findings

Reviewed as part of the parent feature's single delivery unit, against the 2026-09-16 revision that supersedes this plan's body. The removal is verified complete: `boardSyncPush`, `boardSyncRestore`, `boardPush`, `boardRestore`, `backupToNotion`, `restoreFromNotion`, `restoreBoardFromClickUp`, `getListTasksWithCompleteness`, `restoreFromLinear`, `backfillPlanIdAnchors` and `ClickUpTask.customFields` are absent repo-wide (remaining hits are the two ratchet tests that name them deliberately, plus an unrelated `boardPushPolicy` local and one historical docblock line). Kept surfaces verified live and wired: the Notion plans-database projection behind `setupRemoteControl`, the shipped Notion property names, the `notion-backup-config.json` → `notion-sync-config.json` migration, and the Linear `[Switchboard] Plan:` anchor (written at `LinearSyncService.ts:737`/`:3187`, stripped at `LinearRemoteProvider.ts:131`, queried at `:3440`). One MAJOR regression was found and fixed — the anchor was appended after truncation, pushing `issueCreate` descriptions past the live-sync byte ceiling — along with a MAJOR gate-wiring hole on the Notion shipped-schema tests. Validation: `compile-tests` clean; the three contract gates and the Notion integration suite green; both ratchet halves mutation-tested red.

## Deferred Findings

- NIT `src/webview/setup.html:3658` — the `notionSyncProgress` message handler and the `notion-sync-progress` element are dead: nothing posts that message since the board push/restore handlers were removed. Removing them also means touching `src/test/setup-panel-element-ids.test.js:59`, which pins the id.
- NIT `docs/IPC_PROTOCOL.md` — still documents the removed `backupToNotion` and `restoreFromNotion` verbs. The generated `protocol-catalog.json` and `src/generated/verbAllowlist.ts` are both correct; only the prose doc is stale.
- MAJOR (pre-existing, out of scope) `src/test/integrations/linear/linear-sync-service.test.js:608` — `testNativeQueryAndMutationHelpers` fails with "No mocked HTTPS response". The queued matcher-less issues response is not matched despite being the only entry left, and three stray `{ viewer { id } }` requests arrive just before it, indicating https-mock cross-talk between test functions. None of the enclosing code is in this feature's diff; the failure was previously masked by the byte-ceiling assertion aborting the run first.
- MAJOR (pre-existing, out of scope) `src/test/integrations/clickup/clickup-automation-service.test.js:193` — `findPlanByClickUpTaskId` returns null although `getBoard` returns the plan, i.e. `clickup_task_id` is not persisted on import. `ClickUpAutomationService.ts`, `PlanFileImporter.ts`, `planMetadataUtils.ts` and `findPlanByClickUpTaskId` are all untouched by this feature's commits and untouched since.
