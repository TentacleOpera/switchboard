# Switchboard Auto-Archive Rule (Time-in-Column → Completed + Archive)

**Plan ID:** e38b7126-9fca-410a-a0d1-5a43e76f711e

## Goal

Add an **extension-level auto-archive rule** configured in the **kanban.html setup tab**: after a configurable dwell time in a **designated column**, a plan is automatically **moved to Completed and archived**. Because Switchboard is the source of truth and the unified push mirrors state outward, **Linear and Notion follow automatically** — this is not a Linear-specific feature.

### Problem & background

The real, observed pain: ~900 plans pile up in a late column (e.g. Code Reviewed) because nobody marks them Completed, and **Linear's free tier caps active issues (~100–250 depending on plan)**. Two failures of the earlier "auto-archive on completion" design:

1. **Plans never reach Completed** — that's *why* they pile up — so a completion-triggered archive never fires.
2. **Provider-specific** — it was scoped as a Linear archive API call, when the correct model is: Switchboard completes + archives locally, and push propagates the archive to whichever providers are attached.

The fix automates the *move itself* (time-in-column → Completed + archive), so plans stop stalling, and the archive rides the push pipeline out to Linear/Notion. **No backfill** — manual bulk-archive buttons already exist in both Switchboard and Linear for the existing backlog.

### Why a *designated* column, not hardcoded

The archive-trigger column must be **configurable, not hardcoded to "Code Reviewed."** The board's late pipeline can branch and grow — e.g. a PRD-tester stage can legitimately sit *behind* Code Reviewed, between it and Completed. Hardcoding "Code Reviewed" would archive plans that still have agent stages ahead of them. The rule must target the **stage that actually precedes Completed** for a given board.

## What gets built

1. **Setup UI (kanban.html setup tab)** — no confirmation dialogs (house rule):
   - **Archive-trigger column** dropdown, defaulting to whatever column currently sits immediately before Completed. Populated from the live board columns so it tracks topology changes (Researcher, Lead/Coder/Intern Coded, Code Reviewed, Acceptance Tested, Ticket Updater, or a future PRD-tester stage).
   - **Dwell threshold** (default ~2 hours, configurable).
   - **Enable** toggle.
2. **The rule** — a plan resident in the designated column past the threshold is moved to **Completed** and **archived** locally. Uses the existing column-transition + archive machinery; runs on a timer / on board activity.
3. **Archive as a pushed state** — completion + archive propagates outward via the **unified push** (Remote Sync Refactor 1/3 declares `archive` as a capability). Linear and Notion reflect it; ClickUp (push-only mirror) reflects it too where configured.

## Linear push-side correctness (carried from prior analysis)

When archive is pushed to Linear, two shipped-code facts must be honored by the push layer (Remote Sync Refactor 2/3 / the Linear push capability):

- **Use the dedicated `issueArchive` mutation**, not `issueUpdate(input:{archivedAt})`. The existing `LinearSyncService.archiveIssue()` uses the wrong mutation and must be corrected. `issueArchive` is idempotent (safe on already-archived).
- **Archived Linear issues are read-only** — `issueUpdate` fails on them. If content must still sync to an archived issue (e.g. late edits), use **unarchive → push → re-archive**, which requires a new `unarchiveIssue()` method (`issueUnarchive` mutation). This keeps content in sync without leaving the issue active.

These are push-capability details; the auto-archive *rule* itself is provider-agnostic and lives in Switchboard.

## Edge cases

- **Nothing legitimately parks *before* the designated column is touched** — only the designated column is swept. Plans in earlier stages (including a PRD-tester stage placed before the designated column) are untouched.
- **Designated column changes** — re-selecting the column in setup re-targets the rule immediately; no code change.
- **Plan moved back for rework** after archive — a later status push may hit a read-only archived issue; the push layer handles via unarchive-or-recreate (see push-side correctness).
- **Published-extension migration** — the setting is a new config key; default the rule **off** on upgrade (auto-completing plans is a behavior change), and preserve unknown/legacy keys. Surface the free-tier limit note in the setup UI.

## Dependencies

- **Unified push** with declared `archive` capability (Remote Sync Refactor 1/3) and **Notion push** (2/3).
- Existing local column-transition + archive machinery in the kanban DB.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, reliability, feature, api
**Repo:** switchboard

## Review Findings

**Files changed:** `src/services/AutoArchiveService.ts` (new), `src/services/KanbanProvider.ts`, `src/services/LinearSyncService.ts`, `src/services/remote/RemoteProvider.ts`, `src/services/remote/LinearRemoteProvider.ts`, `src/services/remote/NotionRemoteProvider.ts`, `src/services/remote/GitStateProvider.ts`, `src/webview/kanban.html`, `src/extension.ts`. The `archiveCard` capability is declared on the `RemoteProvider` interface and implemented by all three providers (Linear uses `issueArchive`, Notion uses `PATCH /pages/{id}` archived:true, Git returns skipped). The Linear `archiveIssue` mutation was corrected from `issueUpdate(input:{archivedAt})` to the dedicated `issueArchive`, and `unarchiveIssue` was added. The setup UI (kanban.html setup tab) provides the dropdown, threshold, enable toggle, and autosave. Default is off on upgrade.

**Validation:** TypeScript compilation skipped per session directives. Static verification: all KanbanDatabase methods (`getPlansByColumn`, `archivePlan`, `getWorkspaceId`, `getDominantWorkspaceId`) confirmed present. Provider capability gating verified — sweep checks `provider?.capabilities.archive === true` before pushing. `_sweeping` guard prevents concurrent sweeps. `recordPushResult` is wired to RemoteControlService for health surfacing integration.

**Remaining risks:** (1) **MAJOR** — the dwell timer uses `plan.updatedAt` (last ANY DB update) as the proxy for "time in column." Any comment, priority change, or edit resets the dwell clock, so a frequently-updated plan may never archive. The DB schema has no `columnEnteredAt` field, so `updatedAt` is the only available proxy; fixing this requires a schema migration. (2) **NIT** — if the remote archive push fails, the next RemoteControlService poll could see the plan still in its old remote column and try to move it back (pre-existing issue with any archive, not specific to auto-archive). (3) **NIT** — `getActiveProviderKind` lazily builds a RemoteControlService via `_getRemoteControl` which has the side effect of registering git providers and caching the service (harmless but worth noting).
