# Tickets Panel: Title, Description, Sync Badge and Source Selection

**Complexity:** 6

## Goal

Fix four independent defects that all make the Tickets panel show something other than what is on disk or on the remote. A remote rename never reaches the detail pane's H1, because that heading renders from a detail cache whose freshness rule is correct for comments and attachments and wrong for a title that changes remotely. An explicitly emptied description bounces back after Save, because empty rendered HTML is treated as not-yet-loaded and falls back to the stale provider description. The sync badge reads last_synced_at from a different workspace's kanban.db than the refetch stamps, so a refetched ticket shows modified forever. And the source selection is never restored across restarts, because the restoredTabState handler in the webview is dead code that no provider ever triggers.

## How the Subtasks Achieve This

- **Ticket detail H1: source the title from the sidebar row**: adds one `resolveTicketTitle` resolver that reads the file-backed list row first (the sidebar is rebuilt on every list load and is therefore always current), routes both providers' H1s and the drill-down heading through it, and re-renders an open pane when the list reloads. The fix is a deletion of the divergence rather than invalidation logic that would have to be kept correct.
- **Deleted ticket description bounces back after Save**: makes both renderers trust an explicit `descriptionMarkdown` — empty string means the user deliberately cleared the body, not "not yet loaded" — and adds a `localTicketFileSaved` acknowledgement so exiting edit mode and refreshing are sequenced after the write actually lands, closing the race that let Push send the pre-edit content.
- **Tickets sync badge reads a different workspace's DB row**: replaces the first-wins memoized `_cacheService` with a per-root map across all eight binding sites, so the badge and the delta cursor read the same `kanban.db` the refetch stamps. It also makes the 24-hour heal repair drifted `file_path` rows instead of only inserting missing ones.
- **Tickets Tab Source Selection Not Sticky Across Restarts**: makes `persistTabState` honour `workspaceRoot` (per-root vs panel-level, matching the planning panel) and makes `fetchRoots` actually send — and embed in its HTTP response body — the `restoredTabState` payload, activating a webview handler that has been dead code since the panel extraction.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Tickets Tab Source Selection Not Sticky Across Restarts in Browser/Standalone](../plans/feature_plan_20260810144131_tickets-source-not-sticky-across-restarts.md) — **PLAN REVIEWED**
- [ ] [Tickets sync badge reads a different workspace's DB row than the refetch stamps](../plans/feature_plan_20260810144300_tickets-sync-badge-reads-a-different-workspace-db-row-than-the-refetch-stamps.md) — **PLAN REVIEWED**
- [ ] [Deleted ticket description bounces back after Save in tickets.html](../plans/feature_plan_20260811144522_tickets-empty-delete-save-bounce.md) — **PLAN REVIEWED**
- [ ] [Ticket detail H1: source the title from the sidebar row, not the detail cache](../plans/feature_plan_20260811161841_ticket-detail-h1-from-sidebar-row-not-detail-cache.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**⚠ Two subtasks rewrite the same two lines.** The H1 plan and the empty-description plan both edit `renderTicketsClickUpPanel` (`tickets.js:3442`) and `renderTicketsLinearPanel` (`:3337`) — the H1 plan changes the title expression, the description plan changes the body branch immediately below it, and both quote the same "before" block. Land them **together or back-to-back on one stream**, so the final block contains both the `resolveTicketTitle(...)` call and the `hasLocalDesc` branch. Splitting them across streams produces a merge where one silently reverts the other.

Suggested order within that pair: **H1 first** (it establishes the resolver and the "no `<h1>` render site reads `task.title` directly" grep guard), then the description fix layered onto the same rewritten block.

The other two are provider-side and independent of the render pair and of each other:
- **Sync badge** — `TicketsPanelProvider.ts` only, eight binding sites plus the heal loop. No webview change.
- **Source stickiness** — `TicketsPanelProvider.ts` (two handlers) plus one `tickets.js` message arm (`rootsFetched`), which does not touch the render sites.

Both provider-side plans edit `TicketsPanelProvider.ts`, so they serialise with each other under the one-stream-per-file rule, but neither blocks the other functionally.

**Shipped-state notes:** the sync-badge plan touches `imported_docs`, which ships in released versions across roughly 4,000 installs — it must never drop or wholesale-rewrite rows, only re-point drifted `file_path` values, and it introduces no schema change. Its one behavioural consequence to call out rather than discover: the first post-fix refresh in a previously-mispinned workspace has no delta cursor in the correct DB and falls back to a full import, which is the right outcome (a full pull re-stamps everything). The stickiness plan needs no migration — old panel-level state is orphaned but harmless and is rebuilt on the next save.

**Regression guard:** `src/test/tickets-refetch-full-pull-regression.test.js` must pass unchanged. The H1 plan changes no import-path behaviour; a failure there means the fix drifted into the wrong half of the system, which is exactly how four previous attempts at the title bug missed.
