# Board state backup works and nobody knows it exists — document it, and stop telling only git that the state is unrecoverable

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** The Database panel **shipped** in commit `7d71ac56` and the Setup tab's DB section is retired. Delete "the Setup-panel copy is interim pending the Database panel plan": the corrected copy belongs in the Database panel now. Do not edit `setup.html`'s retired DB section.


## Goal

Switchboard already protects board state automatically and has done for some time. A user cannot find out. Close the documentation and discoverability gap without adding a nag, and state honestly which failure modes the existing mechanisms do and do not cover.

### Problem Analysis

Four mechanisms exist, three of them automatic:

| Mechanism | Trigger | Covers |
|---|---|---|
| `.switchboard/dbbackup/` | extension start (max 1/30 min) and before any bulk plan change; 2 of each kind kept | full DB |
| `.switchboard/kanban-state-backup.json` | written automatically by `KanbanDatabase._writeKanbanStateBackup()` | 2,096 plan rows with `kanban_column`, `feature_id`, `is_feature`, `project`, `complexity`, `tags`, tracker ids |
| Notion backup / restore | manual buttons in Setup | columns, feature structure, subtask re-alignment |
| Board state export to the `switchboard/board` orphan branch | `switchboard.boardStateExport` setting, default `none` | read-only; **not** a restore path |

None of this is discoverable:

- **`README.md` contains zero occurrences** of "backup", "restore", "kanban.db", or "board state". A user learns none of it exists unless they open the Setup panel and scroll to the database section.
- **No command palette entry** exists for any board backup or restore operation. The only backup-adjacent command in `package.json` is `switchboard.restoreIntegrationConfig`, which is integration config — a different thing that a user searching for "restore" will find first and misread.
- **`WorkspaceExcludeService.ts:23`** writes `# kanban.db is machine-local state that differs per developer — never commit it.` into an exclude file. The system tells **git** that this state is machine-local and unrecoverable and never tells the **user**.
- **The Setup panel copy is accurate but incomplete.** It describes the rolling backups and offers a cron snippet, but does not say that both `dbbackup/` and `kanban-state-backup.json` live *inside the project* and are gitignored — so they cover corruption and bad migrations, which is what they were built for, and do **not** survive a reformat, a dead drive, or a fresh clone on another machine.
- **The cron snippet is POSIX-only**, so a Windows user has no documented off-project copy path at all.

With roughly 4,000 installs, the most exposed group is users who have never opened that section of Setup and do not use Notion. For them the automatic backups are doing real work silently, and there is nothing they could restore *from* if the machine died.

### Root Cause

The backup work was built as infrastructure and documented where the implementer was standing — in the panel that configures it. Nothing propagated to the README, the command palette, or the moment a user would need it. The exclude-file comment shows the constraint was well understood; it was simply never written down for a human.

### Non-goals

- **No nag, toast, or first-run prompt.** A modal or a startup warning about backups is exactly the kind of UI that gets added once and resented forever. Documentation and a command palette entry are discoverable on demand; an interruption is not.
- Not changing any backup behaviour, trigger, or retention. This plan is documentation and command surface only.
- Not adding the portable export/import itself — that is a separate plan, and this one documents what exists today.

## Metadata

**Complexity:** 2
**Tags:** documentation, discoverability, backup, onboarding

## User Review Required

None.

## Complexity Audit

### Routine
- A README section.
- Command palette entries for operations that already exist and already have handlers.
- ~~Correcting the Setup panel copy.~~ **RETARGET 2026-09-04 (Board Collapse audit): the Setup tab's DB section is retired**, shipped in `7d71ac56`. The corrected copy, and the cross-platform replacement for the POSIX-only cron snippet, belong in the **Database panel** (or the README). Do not edit `setup.html`'s retired section.

### Complex / Risky
- **Getting the honesty right.** The copy must not overstate coverage. A user who reads "Switchboard backs up your board automatically" and concludes their state survives a new laptop has been actively misled by the fix. The in-project limitation is the single most important sentence in this plan.

## Edge-Case & Dependency Audit

- `switchboard.restoreIntegrationConfig` already exists and is unrelated. New entries must be titled so the two are not confused — the existing one restores API credentials, not the board.
- `switchboard.boardStateExport` defaults to `none` and is read-only in both directions that matter. Documentation must not present it as a backup; it is a visibility feature for remote and web agents.
- **Notion is the only tracker with a restore path *today*, and that is changing.** `LinearSyncService` and `ClickUpSyncService` have rich read APIs but no `restoreFrom*` method and never write `kanban_column` back to the DB. The feature *Board sync is a capability all three providers implement, enforced by a contract test* closes both gaps — ClickUp's restore is cheap (its `switchboard:{planId}` tag, description footer, custom field, and `_findTaskByPlanId()` all already exist), Linear's needs a remote-side anchor added first. **So this documentation must not hardcode "Notion only".** Write it against the declared provider capabilities rather than a fixed list, so the doc stays true as each exemption is removed. If this plan lands first, state the current truth and say it is being closed; do not present it as permanent.
- `kanban-state-backup.json` is `version: 1`. Because it has shipped, any future reader must keep handling v1 — worth stating in the doc so the format is treated as a contract, not an implementation detail.

## Dependencies

- The portable export/import plan adds its own palette entries when it lands; this plan covers only the operations that exist today.
- **Related, not blocking: the provider board-sync capability feature.** It makes "Notion is the only restorable remote" false. This plan can land first provided it phrases restorability against declared capabilities rather than a fixed list — see the audit item above. If it lands after, the phrasing is simply already correct.
- **Interim surface: the Setup panel copy correction (Proposed Change #3) is interim.** The Database panel plan (same feature) retires the Setup panel's database section and moves the surviving copy to the new panel. This plan should land first; the corrected copy then moves with the section when the Database panel retires it. If the Database panel lands first, target the copy correction at the Database panel directly and skip the Setup edit.

## Adversarial Synthesis

Key risks: (1) the copy overstates coverage — a user who reads "Switchboard backs up your board automatically" and concludes their state survives a new laptop has been actively misled; the in-project, gitignored limitation is the single most important sentence. (2) The cron snippet at `setup.html:1302` recommends copying `kanban.db` — which carries absolute paths across five tables and does not move cleanly between machines. The snippet is fine for same-machine corruption recovery but must not be presented as a migration path; the portable export (`kanban-state-backup.json`) is the cross-machine artefact. (3) A declared provider-capabilities mechanism does not yet exist in the codebase (no `canRestore`/`boardRestoreCapability` field found), so the restorable-remote list must state the current truth (Notion only) and note it is changing, rather than reading from a mechanism that is not there. Mitigations: the plan already calls out the honesty concern as its top Complex/Risky item; the cron guidance should distinguish same-machine backup from cross-machine migration; the restorable-remote phrasing is already conditional on the capabilities feature landing.

## Proposed Changes

1. **Add a README section** covering what board state is, that `kanban.db` is machine-local and gitignored, which mechanisms run automatically, and — stated plainly — which failure modes are and are not covered.
2. **Add command palette entries** for the existing Notion backup and restore operations, titled so they cannot be confused with `switchboard.restoreIntegrationConfig`.
3. **Correct the Setup panel copy** (interim — the Database panel plan retires this section; see Dependencies) to say that `dbbackup/` and `kanban-state-backup.json` are in-project and gitignored, and therefore cover corruption but not machine loss. The corrected copy moves to the Database panel when it lands.
4. **Replace the POSIX-only cron snippet** (`setup.html:1302`) with guidance that works on all three platforms, or state its platform explicitly and name the Windows equivalent (`schtasks`). The guidance must distinguish same-machine corruption backup (copying `kanban.db` is fine for this) from cross-machine migration (use the portable `kanban-state-backup.json` export, not `kanban.db`, which carries absolute paths).
5. **State which remotes are restorable, sourced from the declared provider capabilities rather than a hardcoded list**, so a user choosing an integration for durability rather than for workflow picks one that can actually rebuild a board — and so the doc does not go stale as ClickUp and Linear restore land.

### Migration

None. Documentation and command registration only.

## Verification Plan

1. **A new user can find it.** Search the README for "backup" and reach a section that names every mechanism and its limits.
2. **Command palette.** Both new entries appear, invoke the correct handler, and are visually distinct from the integration-config restore.
3. **The honesty check.** Have someone unfamiliar with the codebase read the new copy and state, unprompted, whether their board survives a new laptop. If they get it wrong, the copy is wrong.
3a. **The restorable-remote list is not hardcoded.** Flip a provider's declared board-restore capability and confirm the documented list or the UI that renders it follows, rather than needing a doc edit.
4. **Windows guidance runs.** Execute the off-project copy instructions on Windows and confirm they work as written.
5. **No new interruptions.** Confirm a fresh install shows no backup-related toast, modal, or startup message.

### Goal Invariants

- **assert** `README.md` contains at least one match for the string "backup" that names `dbbackup/`, `kanban-state-backup.json`, and the Notion backup.
- **assert** `package.json` contributes.commands contains entries for Notion backup and restore whose titles do not contain "Restore Integration Config".
- **assert** no backup-related `showInformationMessage`, `showWarningMessage`, or `showErrorMessage` call is triggered on extension startup or workspace open (the no-nag invariant).
- **assert** the cron/copy guidance in the Setup panel (or Database panel, whichever is current) distinguishes same-machine backup from cross-machine migration and does not recommend `kanban.db` as the cross-machine artefact.

## Outstanding Questions

None.
