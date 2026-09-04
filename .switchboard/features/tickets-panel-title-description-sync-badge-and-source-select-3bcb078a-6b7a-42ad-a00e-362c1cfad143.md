# Tickets Panel: Title, Description, Sync Badge and Source Selection

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-04 (Board Collapse audit). Three subtasks, not four, and the title over-promises.**
> 
> *Tickets Tab Source Selection Not Sticky Across Restarts* was **merged into `tickets-panel-8-single-source-for-tickets-root.md` and deleted**: both fixed the same broken `restoredTabState` push and the same `persistTabState` arm from two different features. The merge target carries its embedded-in-`rootsFetched` browser path and its three-entry-point warning.
> 
> The "Source Selection" half of this feature's title is therefore delivered elsewhere. The file-level contention on `TicketsPanelProvider.ts` still stands, now against the merge target.


**Complexity:** 7

## Goal

Fix four independent defects that all make the Tickets panel show something other than what is on disk or on the remote. A remote rename never reaches the detail pane's H1, because that heading renders from a detail cache whose freshness rule is correct for comments and attachments and wrong for a title that changes remotely. An explicitly emptied description bounces back after Save, because empty rendered HTML is treated as not-yet-loaded and falls back to the stale provider description. The sync badge reads last_synced_at from a different workspace's kanban.db than the refetch stamps, so a refetched ticket shows modified forever. And the source selection is never restored across restarts, because the restoredTabState handler in the webview is dead code that no provider ever triggers.

## How the Subtasks Achieve This

- **Ticket detail H1: source the title from the sidebar row**: adds one `resolveTicketTitle` resolver that reads the file-backed list row first (the sidebar is rebuilt on every list load and is therefore always current) and routes both providers' H1s and the drill-down heading through it. The fix is a deletion of the divergence rather than invalidation logic that would have to be kept correct. Two of its four original changes turned out to be **already live at HEAD** (the file-H1→cache write-back, and the `renderTicketsTab()` call on list reload) and are now recorded as regression guards rather than work.
- **Deleted ticket description bounces back after Save**: makes both renderers trust an explicit `descriptionMarkdown` — empty string means the user deliberately cleared the body, not "not yet loaded" — and adds a `localTicketFileSaved` acknowledgement so exiting edit mode and refreshing are sequenced after the write actually lands, closing the race that let Push send the pre-edit content. Its renderer line is pinned character-for-character by `src/test/tickets-description-markdown-fallback.test.js`, which must be updated in the same change.
- **Tickets sync badge reads a different workspace's DB row**: replaces the first-wins memoized `_cacheService` with a per-root map across all **ten** binding sites, so the badge and the delta cursor read the same `kanban.db` the refetch stamps. It also makes the 24-hour heal repair drifted `file_path` rows instead of only inserting missing ones — via a new `file_path`-only UPDATE, because the obvious primitive (`registerImportedTicket` → `upsertImportedTicket`) restamps `last_synced_at` and would mark every locally-edited file as synced.
- **Tickets Tab Source Selection Not Sticky Across Restarts**: makes `persistTabState` honour `workspaceRoot` (per-root vs panel-level, matching the planning panel) and makes `fetchRoots` actually send — and embed in its HTTP response body — the `restoredTabState` payload, activating a webview handler that has been dead code since the panel extraction.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Tickets sync badge reads a different workspace's DB row than the refetch stamps](../plans/feature_plan_20260810144300_tickets-sync-badge-reads-a-different-workspace-db-row-than-the-refetch-stamps.md) — **PLAN REVIEWED** — ID: a8355fbe-3003-4803-aa31-bf0d5e8d8b06
- [ ] [Deleted ticket description bounces back after Save in tickets.html](../plans/feature_plan_20260811144522_tickets-empty-delete-save-bounce.md) — **PLAN REVIEWED** — ID: 99caa9d7-5eab-44e9-b1fd-cb485af5aa3f
- [ ] [Ticket detail H1: source the title from the sidebar row, not the detail cache](../plans/feature_plan_20260811161841_ticket-detail-h1-from-sidebar-row-not-detail-cache.md) — **PLAN REVIEWED** — ID: ea3cd1e5-c075-46fc-b984-488a1b319d71
<!-- END SUBTASKS -->

## Dependencies & sequencing

**⚠ Two subtasks rewrite the same two blocks.** The H1 plan and the empty-description plan both edit `renderTicketsClickUpTaskDetail` (`tickets.js:3484`) and `renderTicketsLinearTaskDetail` (`:3374`) — the H1 plan changes the title expression, the description plan changes the body branch immediately below it, and both quote the same "before" block. Land them **together or back-to-back on one stream**, so the final block contains both the `resolveTicketTitle(...)` call and the `hasLocalDesc` branch. Splitting them across streams produces a merge where one silently reverts the other.

*(Both plans previously named these sites `renderTicketsClickUpPanel` / `renderTicketsLinearPanel`. Those functions exist at `:1258` / `:1223` and contain no `<h1>` — they are toolbar/dispatch wrappers. Patching them would have edited the wrong bodies.)*

Suggested order within that pair: **H1 first** (it establishes the resolver and the "no `<h1>` render site reads `task.title` directly" grep guard), then the description fix layered onto the same rewritten block.

The other two are provider-side and independent of the render pair and of each other:
- **Sync badge** — `TicketsPanelProvider.ts` only, eight binding sites plus the heal loop. No webview change.
- **Source stickiness** — `TicketsPanelProvider.ts` (two handlers) plus one `tickets.js` message arm (`rootsFetched`), which does not touch the render sites.

Both provider-side plans edit `TicketsPanelProvider.ts`, so they serialise with each other under the one-stream-per-file rule, but neither blocks the other functionally.

**Shipped-state notes:** the sync-badge plan touches `imported_docs`, which ships in released versions across roughly 4,000 installs — it must never drop or wholesale-rewrite rows, only re-point drifted `file_path` values, and it introduces no schema change. Its one behavioural consequence to call out rather than discover: the first post-fix refresh in a previously-mispinned workspace has no delta cursor in the correct DB and falls back to a full import, which is the right outcome (a full pull re-stamps everything). The stickiness plan needs no migration — old panel-level state is orphaned but harmless and is rebuilt on the next save.

**Regression guards:**
- `src/test/tickets-refetch-full-pull-regression.test.js` must pass unchanged for both render-pair subtasks. Neither changes import-path behaviour; a failure there means the fix drifted into the wrong half of the system, which is exactly how four previous attempts at the title bug missed.
- `src/test/tickets-description-markdown-fallback.test.js` pins the renderers' `descSrc` expression with a literal regex. The **H1 plan must leave it green untouched** (its edit is above the test's 700-char window); the **description plan must update the two `sourceChain` regexes in the same change** and keep every other assertion — `renderMarkdown` on branch 2, no `escapeHtml(...).replace(/\n/g,'<br>')` limb, the whole ingestion-normalisation block — exactly as-is. A green suite achieved by weakening that test is a regression, not a pass.
- `npm run verb-returns:check`: the description plan converts five `break`s in `saveLocalTicketFile` to returns, so `scripts/verb-return-contract-baseline.json` must drop `"Tickets"` from `55` to the post-conversion residual **in the same change**. The other three subtasks move no `break`s and leave the ceiling alone.

## Reconciled end-state

One design per contended surface, so a coder never has to choose:

| Surface | Single owner | End state |
| --- | --- | --- |
| `<h1>` expression in both detail renderers | H1 plan | `escapeHtml(resolveTicketTitle(provider, id, taskOrIssue))` |
| Description branch immediately below it | Description plan | three-branch: `renderedDescriptionHtml` → explicit `descriptionMarkdown` (incl. `''`) → raw payload, all rendered with `renderMarkdown` |
| `_applyTicketFilePayloadToSelected` / `localTicketFileRead` title write-back | Nobody — already correct at HEAD | unchanged; asserted by the H1 plan's grep guard |
| `saveLocalTicketFile` host arm | Description plan | pushes `localTicketFileSaved`, returns in body on every path |
| `_cacheService` field | Sync-badge plan | deleted; replaced by `_cacheServices: Map` + `_getCacheServiceFor()` |
| `imported_docs` `file_path` repair | Sync-badge plan | new `repointImportedTicketFilePath` (one column); never `registerImportedTicket` |
| `persistTabState` / `fetchRoots` arms | Stickiness plan | per-root storage; restore payload both pushed (root-stamped) and returned in body |
| Restore-application logic in `tickets.js` | Stickiness plan | one `_applyRestoredTabState` helper, called by both message arms |
