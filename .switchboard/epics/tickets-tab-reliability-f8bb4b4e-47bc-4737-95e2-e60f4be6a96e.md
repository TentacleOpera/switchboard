# Tickets Tab Reliability

**Complexity:** 6

## Goal

Fix three reliability issues in the planning.html Tickets tab. Stale doc previews when switching lists, comments manager losing replies after refetch, and Linear per-project import parity with ClickUp. All three plans touch planning.js and the Tickets tab data flow.

## How the Subtasks Achieve This

- **Tickets: Stale Doc Preview on List Change**: Fixes the doc preview pane not updating when the user switches between ClickUp lists or Linear projects in the Tickets tab.
- **Comments Manager Replies Not Showing After Refetch**: Fixes optimistic reply inserts being discarded when the backend refetch replaces all comment threads, by merging optimistic entries into refetched data and adding a propagation delay.
- **Linear Tickets Tab: Picker-Driven Per-Project Import**: Makes the Linear project picker drive a per-project import with full pagination (parity with ClickUp), including name-to-id resolution, prune safety, and sidebar scoping.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Linear Tickets Tab: Picker-Driven Per-Project Import (parity with ClickUp)](../plans/feature_plan_20260629151803_linear-tickets-per-project-import.md) — **PLAN REVIEWED**
- [ ] [Comments Manager in Tickets Tab Does Not Show Replies After Refetch](../plans/feature_plan_20260701152252_comments-manager-replies-not-showing-after-refetch.md) — **PLAN REVIEWED**
- [ ] [Tickets: stale doc preview when switching list/project](../plans/feature_plan_20260702105126_tickets-stale-doc-preview-on-list-change.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
