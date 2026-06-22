# Integration Import Pipeline Overhaul — Fetched Data Loss, Orphaned Cards, Dead Config

## Goal

The ClickUp and Linear import pipelines fetch rich ticket data from their APIs but discard most of it before it reaches the Kanban board. This plan tracks the full set of issues discovered during investigation of the import flow so they can be addressed in a dedicated future effort. **This is NOT part of the current ticket (default unchecked kanban/automation toggles).**

### Problem Analysis

The import flow is: API fetch → write stub `.md` file → `GlobalPlanWatcherService` detects file → `parsePlanMetadata` extracts metadata → DB insert → card appears on board.

Multiple stages in this pipeline lose data or fail to wire it into the DB record:

**1. Fetched data discarded at the stub-write stage (Linear):**

The Linear GraphQL query (`LinearSyncService.ts:1940-1951`) fetches per issue: `title`, `description`, `url`, `priority`, `state`, `assignee`, `labels`, `dueDate`, `parent`, `children` (sub-issues), `project.name`, `cycle`, `comments` (all bodies, authors, timestamps), `attachments` (titles + URLs), `estimate`, `createdAt`.

Of these, `comments`, `attachments`, `estimate`, `createdAt`, `project.name`, `cycle`, and `children` are **never written to the stub file**. They are fetched from the API and thrown away. Comments and attachments are the most significant loss — they represent real API payload and real user content that the user would expect to see in the imported plan.

**2. Fetched data discarded at the stub-write stage (ClickUp):**

`ClickUpSyncService.importTasksFromClickUp` (`ClickUpSyncService.ts:2389`) fetches tasks from a single list via `listTasksFromClickUp(listId)`. The stub writes `name`, `description`, `url`, `priority`, `due_date`, `assignees`, `tags`, and `parent`. Sub-tasks, comments, and attachments are not fetched at all for ClickUp (the ClickUp API call is narrower than Linear's).

**3. Real-time watcher drops the provider task/issue ID:**

`GlobalPlanWatcherService._handlePlanFile` (`GlobalPlanWatcherService.ts:497-520`) hardcodes `clickupTaskId: ''` and `linearIssueId: ''` in the new DB record. The stub file contains `> Imported from Linear issue \`ENG-123\`` and `> **ClickUp Task ID:** abc123`, but the real-time watcher does not extract these. This means:

- The Kanban card has **no link back to the source ticket**.
- Sync-back (pushing plan changes to Linear/ClickUp) cannot work for imported tickets because the DB record doesn't know which issue/task it came from.
- The `sourceType` is hardcoded to `'local'` — imported tickets are indistinguishable from locally-created plans.

The batch importer (`PlanFileImporter.importPlanFiles`, `PlanFileImporter.ts:69-70`) DOES extract `clickupTaskId` and `linearIssueId` via `extractClickUpTaskId` / `extractLinearIssueId`, and sets `sourceType` to `'clickup-automation'` / `'linear-automation'` when an automation rule name is present. But this only runs on explicit "Reset Database" — not on the real-time import path.

**4. Tags/labels not parsed into DB:**

The stub writes `> **Labels:** bug, frontend` (Linear) or `> **Tags:** bug, frontend` (ClickUp). The metadata parser (`planMetadataUtils.ts:88`) looks for `**Tags:**` — so ClickUp tags might be parsed (if they pass `sanitizeTags` filtering), but Linear labels are written as `**Labels:**` and are never matched. Neither uses the `## Metadata` section format that the regex expects (`/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Tags(?:\*\*:\s*|:\*\*)\s*(.+)/im`). The result: imported tickets always have empty tags in the DB.

**5. Dead `kanbanColumn` variable (Linear):**

`LinearSyncService.ts:2021` computes `const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';` but never uses it. The stub file has no `kanbanColumn` directive, so the watcher always defaults to `'CREATED'`. If `excludeBacklog` is OFF and a backlog issue is imported, it lands in CREATED — not BACKLOG. The variable is dead code. The ClickUp side has a similar misleading comment at `ClickUpSyncService.ts:2485` ("Determine initial kanban column: backlog status → BACKLOG") but no variable or usage.

**6. `completeSyncEnabled` is a no-op config flag:**

`completeSyncEnabled` is persisted in both ClickUp and Linear configs, surfaced to the UI as a checkbox ("Sync completed status to Linear"), and shown in the summary text — but **no code path ever reads it to gate sync behavior**. `updateIssueState` / `changeTicketStatus` push status updates unconditionally without checking this flag. It's either future-intent that was never wired up or dead config. The UI implies "completed status will sync" but nothing reads the flag.

**7. `excludeBacklog` defaults are asymmetric and potentially confusing:**

- Linear: defaults ON (`!== false`) — import scope is team-wide, so this prevents backlog issues from flooding the board
- ClickUp: defaults OFF (`=== true`) — import scope is a single list, so backlog filtering is redundant with list selection

The Linear default is justified (team-wide scope), but the ClickUp default being OFF while having the checkbox present is confusing — it implies the filter does something useful when it's mostly redundant.

### Root Cause

The import pipeline was built file-first (a plan IS a markdown file, the board is a view over files), but the bridge between "rich API data" and "thin markdown stub" was never completed. The stub writer fetches more than it writes, the watcher extracts less than the stub contains, and the DB record ends up with just a title and "Unknown" complexity. The provider link — the most critical field for round-trip sync — is dropped on the real-time path entirely.

## Metadata

**Complexity:** 7
**Tags:** backend, integration, bugfix, linear, clickup

## User Review Required

Yes — this plan touches the import pipeline for both ClickUp and Linear. Changes to what gets fetched, what gets written to stubs, and what gets parsed into DB records will affect all users who use auto-pull or manual import. The `completeSyncEnabled` flag may need a product decision: wire it up or remove it.

## Proposed Changes

### 1. Write provider task/issue ID into stub files in a parseable format

Ensure both ClickUp and Linear stubs include the provider ID in a format the watcher can extract. The batch importer already has `extractClickUpTaskId` (`PlanFileImporter.ts:225-233`) and `extractLinearIssueId` (`PlanFileImporter.ts:235-237`). The real-time watcher should use the same extraction logic.

**Files:**
- `src/services/GlobalPlanWatcherService.ts` — replace hardcoded `clickupTaskId: ''` / `linearIssueId: ''` with extraction from file content (reuse `extractClickUpTaskId` / `extractLinearIssueId` from `PlanFileImporter.ts`).
- Set `sourceType` to `'clickup-automation'` / `'linear-automation'` (or a new `'clickup-import'` / `'linear-import'` source type) when a provider ID is detected, so imported tickets are distinguishable from local plans.

### 2. Write Linear comments and attachments into the stub file

The GraphQL query already fetches `comments { nodes { body user { name } createdAt } }` and `attachments { nodes { title url } }`. These should be appended to the stub file as structured content (e.g., a `## Comments` section and an `## Attachments` section).

**Files:**
- `src/services/LinearSyncService.ts` — in the stub assembly (`:2040-2046`), append comment and attachment sections after the description.

### 3. Fix tag/label parsing for imported tickets

Either:
- (a) Change the stub writer to use `**Tags:**` instead of `**Labels:**` for Linear (and ensure the value passes `sanitizeTags`), or
- (b) Extend `parsePlanMetadata` to also match `**Labels:**` as a fallback for tags.

Option (a) is cleaner — aligns the stub format with what the parser expects.

**Files:**
- `src/services/LinearSyncService.ts` — change `> **Labels:** ${labels}` to `> **Tags:** ${labels}` in the metaLines array (`:2036`).
- Consider whether Linear label names will pass `sanitizeTags` (they must be in `ALLOWED_TAGS` set — many Linear labels won't be). May need to relax the sanitizer for imported tickets or skip sanitization for imports.

### 4. Remove or wire up `completeSyncEnabled`

**Option A (wire up):** Gate the "move to completed state" sync-back behavior on `config.completeSyncEnabled === true` (Linear) / `config.completeSyncEnabled === true` (ClickUp) in the push-sync path. This requires identifying where plan-completion triggers a status update to the provider and adding the guard.

**Option B (remove):** Delete the config field, the UI checkbox, the state payload field, and all references. Simpler but breaks any user who has it set (migration needed per CLAUDE.md rules — it shipped in a released version).

**Recommendation:** Investigate whether the push-sync path for "plan moved to DONE column" exists and whether it currently pushes unconditionally. If it does, Option A is a small guard. If the push path doesn't exist yet either, Option B (remove) is cleaner.

**Files:**
- `src/services/LinearSyncService.ts` — config type (`:30`), defaults (`:187`, `:228`), apply (`:1569`)
- `src/services/ClickUpSyncService.ts` — config type (`:38`), defaults (`:265`, `:307-309`)
- `src/webview/setup.html` — checkbox (`:997`), state rendering (`:2510`), summary (`:2523`), collect options (`:2449`)
- `src/services/TaskViewerProvider.ts` — state payload (`:4082`)

### 5. Remove dead `kanbanColumn` variable in Linear import

`LinearSyncService.ts:2021` — `const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';` is computed but never used. Either:
- (a) Remove the variable (dead code cleanup), or
- (b) Write it into the stub as a `kanbanColumn: BACKLOG` / `kanbanColumn: CREATED` directive so the watcher picks it up (would make `excludeBacklog=OFF` actually route backlog issues to the BACKLOG column instead of CREATED).

Option (b) is the better fix — it makes `excludeBacklog=OFF` behave correctly (backlog issues go to BACKLOG, not CREATED).

**Files:**
- `src/services/LinearSyncService.ts:2021` — remove or wire up
- `src/services/ClickUpSyncService.ts:2485` — remove misleading comment or add equivalent variable + directive

### 6. Align `excludeBacklog` defaults (optional, lower priority)

Consider whether ClickUp's `excludeBacklog` default should remain OFF (redundant with list selection) or be removed entirely. If it stays, the UI should clarify that it only filters by status name within the selected list, not by a separate backlog pool.

## Verification Plan

### Automated Tests

> **SKIP COMPILATION:** Do NOT run `npm run compile` or any project compilation step.
>
> **SKIP TESTS:** Do NOT run automated tests. The test suite will be run separately by the user.

**Recommended tests to add (for the user to run later):**

1. Test that `GlobalPlanWatcherService._handlePlanFile` extracts `clickupTaskId` / `linearIssueId` from stub file content (not hardcoded to `''`).
2. Test that Linear stub files include comments and attachments sections when the API returns them.
3. Test that Linear stub files use `**Tags:**` (not `**Labels:**`) so `parsePlanMetadata` can extract them.
4. Test that `completeSyncEnabled` either gates sync-back behavior or is fully removed (depending on chosen option).
5. Test that `kanbanColumn` directive in stub files is respected by the watcher (if Option 5b is chosen).

### Manual Verification

1. Enable auto-pull on Linear with `excludeBacklog` OFF. Import issues that include backlog-state items. Confirm they appear on the board in the BACKLOG column (if Option 5b) or CREATED (if Option 5a).
2. Open an imported Linear issue's plan file. Confirm comments and attachments are present in the markdown.
3. Check the Kanban DB for an imported ticket. Confirm `clickupTaskId` / `linearIssueId` is populated (not empty string).
4. Check the Kanban DB for an imported ticket. Confirm `sourceType` is not `'local'` — it should indicate the provider.
5. Move an imported plan to DONE. Confirm the provider ticket status updates (if `completeSyncEnabled` is wired up) or confirm no change (if removed).

## Dependencies

- None blocking — this is a self-contained backend + frontend fix.
- The `completeSyncEnabled` decision (wire up vs. remove) should be made before implementation begins.

## Adversarial Synthesis

**Risk 1:** Reusing `extractClickUpTaskId` / `extractLinearIssueId` from `PlanFileImporter.ts` in the watcher creates a coupling between the batch and real-time import paths. If the stub format changes, both paths must stay in sync. Mitigation: extract the parsing functions into a shared utility module (e.g., `planMetadataUtils.ts`) rather than importing from `PlanFileImporter.ts` directly.

**Risk 2:** Writing comments into the stub file could produce very large markdown files for issues with extensive comment threads. Mitigation: cap comment count (e.g., 50 most recent) or truncate individual comments. Consider whether the user needs full comment history in the plan file or just a summary.

**Risk 3:** Changing `**Labels:**` to `**Tags:**` for Linear stubs will cause `sanitizeTags` to filter out any label not in the `ALLOWED_TAGS` set. Most Linear labels (e.g., "bug", "frontend") would pass, but custom labels (e.g., "Q3-initiative") would be dropped. This is a behavior change — previously labels were in the file but not parsed; now they'd be parsed but filtered. Mitigation: either relax `sanitizeTags` for imported tickets or accept the filtering as correct (the Kanban board's tag system is curated, not free-form).

**Risk 4:** Removing `completeSyncEnabled` (Option 4B) requires a migration since it shipped in a released version. Users who have it set in their config would have an orphaned key. Mitigation: preserve unknown keys in config loading (already done — both services use `raw.completeSyncEnabled !== false` / `=== true` patterns that gracefully handle undefined). The UI checkbox removal is safe. The config field can remain in the type as optional and simply be ignored.

---

**Recommendation:** Complexity 7 → **Send to Senior Engineer.** Multi-file changes across both integration services, the file watcher, and the metadata parser. The `completeSyncEnabled` decision requires product judgment. The provider-ID wiring is the highest-priority fix (it breaks round-trip sync for all imported tickets).
