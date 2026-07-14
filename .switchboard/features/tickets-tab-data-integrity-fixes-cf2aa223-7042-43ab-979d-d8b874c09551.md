# Tickets Tab Data Integrity Fixes

**Complexity:** 4

## Goal

Fix two bugs where the planning.html Tickets tab silently loses or fails to clean up local data — ticket priority reverting to No priority after list reload, and local .md files surviving on disk after remote deletion. Both stem from the backend mapper/lookup paths dropping or missing data that the webview already knows how to render, and both are low-complexity fixes to existing data-flow boundaries.

## How the Subtasks Achieve This

- **ClickUp Priority Lost on List Reload**: Adds the `priority` field to `_mapClickUpTaskToSidebar` so the normalized priority survives the list-reload re-fetch. One-line mapper fix.
- **Ticket Delete: Local File Not Removed When Remote Is Archived**: Ports the DB-first file lookup from `PlanningPanelProvider._findTicketFilePath` into `TaskViewerProvider._findTicketDocument`, and adds a `loadLocalTicketFiles()` refresh call in the webview's delete handler. Ensures the local file is deleted alongside the remote.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [ClickUp Priority Lost on List Reload in Planning Tickets Tab](../plans/feature_plan_20260714102047_clickup-priority-lost-on-list-reload.md) — **INTERN CODED**
- [ ] [Ticket Delete: Local File Not Removed When Remote Is Archived](../plans/feature_plan_20260714102523_ticket-delete-local-file-not-removed.md) — **INTERN CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. They touch different methods in different files (`_mapClickUpTaskToSidebar` in PlanningPanelProvider vs `_findTicketDocument` in TaskViewerProvider).

## Completion Summary

Implemented both subtasks. Subtask 1 (ClickUp priority lost on list reload): added `priority: task.priority || null` to `_mapClickUpTaskToSidebar` in `src/services/PlanningPanelProvider.ts` (line 2468) so the normalized priority survives the list-reload re-fetch — one-line additive mapper fix, null pass-through preserved. Subtask 2 (ticket delete local file not removed): ported the DB-first lookup pattern into `TaskViewerProvider._findTicketDocument` (`src/services/TaskViewerProvider.ts`, lines 20930–20969) — now consults `cacheService.getImportBySlugPrefix` before scanning, with the filesystem fallback expanded to cover all `_getAllowedRoots()` instead of just the resolved root; and added `loadLocalTicketFiles()` to the `ticketDeleted` success branch in `src/webview/planning.js` (line 5529) so the local files sidebar refreshes after delete. Files changed: `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/planning.js`. No issues encountered; all changes match the plan specs exactly and were verified present in the working tree. Red-team review passed — null/falsy edge cases, ENOENT guards, and the `if (res.success)` unlink gate all hold.
