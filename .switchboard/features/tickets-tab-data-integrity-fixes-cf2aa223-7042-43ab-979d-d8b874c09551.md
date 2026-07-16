# Tickets Tab Data Integrity Fixes

**Complexity:** 4

## Goal

Fix two bugs where the planning.html Tickets tab silently loses or fails to clean up local data — ticket priority reverting to No priority after list reload, and local .md files surviving on disk after remote deletion. Both stem from the backend mapper/lookup paths dropping or missing data that the webview already knows how to render, and both are low-complexity fixes to existing data-flow boundaries.

## How the Subtasks Achieve This

- **ClickUp Priority Lost on List Reload**: Adds the `priority` field to `_mapClickUpTaskToSidebar` so the normalized priority survives the list-reload re-fetch. One-line mapper fix.
- **Ticket Delete: Local File Not Removed When Remote Is Archived**: Ports the DB-first file lookup from `PlanningPanelProvider._findTicketFilePath` into `TaskViewerProvider._findTicketDocument`, and adds a `loadLocalTicketFiles()` refresh call in the webview's delete handler. Ensures the local file is deleted alongside the remote.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [ClickUp Priority Lost on List Reload in Planning Tickets Tab](../plans/feature_plan_20260714102047_clickup-priority-lost-on-list-reload.md) — **CODE REVIEWED**
- [ ] [Ticket Delete: Local File Not Removed When Remote Is Archived](../plans/feature_plan_20260714102523_ticket-delete-local-file-not-removed.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. They touch different methods in different files (`_mapClickUpTaskToSidebar` in PlanningPanelProvider vs `_findTicketDocument` in TaskViewerProvider).

## Completion Summary

Implemented both subtasks. Subtask 1 (ClickUp priority lost on list reload): added `priority: task.priority || null` to `_mapClickUpTaskToSidebar` in `src/services/PlanningPanelProvider.ts` (line 2468) so the normalized priority survives the list-reload re-fetch — one-line additive mapper fix, null pass-through preserved. Subtask 2 (ticket delete local file not removed): ported the DB-first lookup pattern into `TaskViewerProvider._findTicketDocument` (`src/services/TaskViewerProvider.ts`, lines 20930–20969) — now consults `cacheService.getImportBySlugPrefix` before scanning, with the filesystem fallback expanded to cover all `_getAllowedRoots()` instead of just the resolved root; and added `loadLocalTicketFiles()` to the `ticketDeleted` success branch in `src/webview/planning.js` (line 5529) so the local files sidebar refreshes after delete. Files changed: `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/planning.js`. No issues encountered; all changes match the plan specs exactly and were verified present in the working tree. Red-team review passed — null/falsy edge cases, ENOENT guards, and the `if (res.success)` unlink gate all hold.

## UAT Failure & Correct Fix (priority still missing)

The original subtask-1 fix was **incomplete** — it patched the wrong path. `_mapClickUpTaskToSidebar` only feeds the transient API path (`clickupProjectLoaded`). The Tickets tab sidebar is **file-backed** ("the sidebar is always file-backed" — planning.js:5540): after any import/delete/initial-load, `loadLocalTicketFiles()` → `localTicketFilesListed` overwrites `clickUpProjectIssues` from the ticket `.md` files, discarding the API-mapped priority. So priority flashed on list-select then vanished — hence UAT "priority still missing".

Priority was dropped at four points along the file-backed path, none touched by the mapper fix. Fixed all four:

1. **`TaskViewerProvider._buildClickUpImportPlanContent`** — now writes `priority`, `priorityColor`, `priorityOrderIndex` to the ticket-file YAML frontmatter at import time (omitted when the task has no priority set).
2. **`PlanningPanelProvider` `listLocalTicketFiles` (DB path)** — parses those three keys and emits `priority: { priority, color, orderindex }` on each sidebar ticket.
3. **`PlanningPanelProvider._scanLocalTicketFiles` (fallback live scan)** — same parse + emit, so the DB-cold path also carries priority.
4. **`planning.js` `localTicketFilesListed` handler** — passes `priority` through into the rebuilt `clickUpProjectIssues` objects (was dropping it).

The webview render helpers (`_clickUpPriorityColor` / `_clickUpPriorityName` / `_renderClickUpTicketCard`) already consume `task.priority.{color,orderindex,priority}`, so no render change was needed.

**Re-test note:** already-imported ticket files predate the frontmatter change and won't show priority until rewritten. Selecting the list re-imports and rewrites its files WITH the new keys (same mechanism `listId`/`status` frontmatter relies on), so the dots appear after the next list select. Files changed: `src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`, `src/webview/planning.js`. `npm run compile` clean.

## Review Findings

Direct reviewer pass completed for both subtasks. No CRITICAL or MAJOR findings — both implementations match their plans exactly and pass the advanced regression audit (caller/consumer tracing, double-trigger check, race-condition check, orphaned-reference grep, full execution-path audit). Only NIT-level findings, all pre-existing or edge-case:

- **Subtask 1 (priority mapper):** `PlanningPanelProvider.ts:2468` — additive `priority: task.priority || null`. All 3 callers (list load, detail, subtasks) post to webview; webview consumes via optional-chaining. No backend consumer. No race (stateless synchronous mapper). NITs: `any` return type is pre-existing debt; `|| null` vs `!== undefined` is style.
- **Subtask 2 (delete file cleanup):** `TaskViewerProvider.ts:20930–20969` — DB-first lookup + expanded all-roots scan, matching the reference `PlanningPanelProvider._findTicketFilePath`. `planning.js:5630` — `loadLocalTicketFiles()` in `ticketDeleted` success branch. All 3 `_findTicketDocument` callers (`deleteTicket`, `pushTicketEdits`, `_resolveCommentsJsonDir`) get strictly-more-reliable resolution. No double-trigger (separate message from remote-list render). No race (delete commits before response). NITs: cross-workspace orphan DB row (pre-existing in reference); stale sidebar if DB delete fails (edge case); async `loadConfig` vs reference's sync (consistent with existing method code).

No code fixes applied — no valid CRITICAL/MAJOR findings to fix. Validation: compilation/tests skipped per directive; code inspection confirms type-safety, null-safety, guard clauses, and helper-method existence. Remaining risks: orphan DB row in cross-workspace delete (NIT, pre-existing), stale sidebar on DB-delete failure (NIT, edge case).
