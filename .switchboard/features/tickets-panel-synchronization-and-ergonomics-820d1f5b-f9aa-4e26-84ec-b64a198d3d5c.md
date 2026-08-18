---
description: 'Tickets Panel Synchronization and Ergonomics'
---

# Tickets Panel Synchronization and Ergonomics

**Complexity:** 5

## Goal

Improve the reliability, synchronization, and user experience of the Tickets panel in Switchboard across both the VS Code extension and browser cockpits. This ensures that local ticket representations remain strictly faithful to remote trackers, hierarchy actions are accessible from any view, and comment updates are fetched proactively.

## How the Subtasks Achieve This

- **Reconcile and Delete Stale Local Ticket Markdown Files on Fetch**: Purges orphaned and stale local `.md` ticket files during Refetch and Refresh passes so the local ticket repository is an exact mirror of the remote list, preventing agents from acting on outdated ticket files.
- **Relabel and Enable 'Push All Subtasks' Button from Subtask Views**: Renames the action button to "Push all subtasks" and enables it within subtask views by resolving the parent ticket ID, enabling operators to push entire ticket families from any level.
- **Proactive Ticket Comment Fetching on Selection, Refresh, and Refetch**: Automatically pre-warms and retrieves comment threads whenever a ticket is selected or refreshed, eliminating comment modal loading delays and keeping remote discussion threads up to date.

## Dependencies & sequencing
- **Logical ordering**: Subtasks are independent — no subtask's correctness depends on another landing first. Each targets a distinct surface (local-file reconciliation, push-button UX, comment prefetch) with no shared-symbol conflicts.
- **Same-file serialization (parallel-coding guard)**: Plan 1 and Plan 2 both modify `src/services/TaskViewerProvider.ts` (different functions: `importAllTasks`/`_collectDeletionCandidates` vs `pushTicketEditsWithSubtasks`). Plan 2 and Plan 3 both modify `src/webview/tickets.js` (non-overlapping line ranges). Per the project's orchestration discipline ("one agent stream per provider file; same-file parallel edits collide"), these same-file pairs must serialise if coded in parallel — but either order is valid, there is no logical prerequisite between them.
- **Prerequisites / guards**: None. All three reuse shipped, stable code paths (`importAllTasks` sweep, `pushTicketWithSubtasks` verb, `loadTicketComments` verb) with no new backend verbs or schema changes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Reconcile and Delete Stale Local Ticket Markdown Files on Fetch](../plans/feature_plan_20260818093001_tickets-reconcile-stale-local-files-on-fetch.md) — **PLAN REVIEWED**
- [ ] [Relabel and Enable 'Push All Subtasks' Button from Subtask Views](../plans/feature_plan_20260818093002_tickets-push-all-subtasks-button-relabel-and-subtask-enable.md) — **PLAN REVIEWED**
- [ ] [Proactive Ticket Comment Fetching on Selection, Refresh, and Refetch](../plans/feature_plan_20260818093005_tickets-proactive-comment-fetching-on-select-and-refresh.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

