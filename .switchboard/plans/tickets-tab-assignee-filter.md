# Add an Assignee Filter to the Tickets Tab Sidebar

## Goal

Add an assignee dropdown to the Tickets tab sidebar, alongside the existing search box and status/state filters, so the user can narrow the currently-loaded ticket list to a single person (or to unassigned tickets). Scope is deliberately confined to the list already selected in the Tickets tab — no cross-space queries, no new API calls, no persisted "who am I" identity.

### Problem

The Tickets tab can only be narrowed by free-text search and by status. On a shared ClickUp list or Linear project, most of what is displayed belongs to someone else, so finding your own work means either scrolling or typing a name into the search box.

Typing a name into search *does* currently work by accident — `getFilteredClickUpTasks` (`src/webview/planning.js:11945`) and `getFilteredLinearIssues` (`src/webview/planning.js:11045`) both fold assignee names into the search haystack. But it is a poor affordance:

- It is undiscoverable. Nothing tells the user assignee names are searchable.
- It is imprecise. A name substring also matches titles and descriptions, so searching `sam` surfaces every ticket mentioning "sample".
- It cannot express "unassigned", which is the other half of triaging a shared list.
- It collides with real search. You cannot search for a term *within* one person's tickets, because there is only one text input.

### Root cause

There is no assignee dimension in the two client-side filter funnels. Both funnels already handle `status`/`state` and (for Linear) `project` as first-class structured predicates, and both already receive fully-normalised assignee data on every ticket — `assignees: Array<{id, username, email}>` for ClickUp (`src/services/ClickUpSyncService.ts:796`) and `assignee: {id, name, email} | null` for Linear (`src/services/LinearSyncService.ts:386`). The data is present and shaped correctly; only the predicate and its control are missing.

### Why this is client-side only

No service, API, or import-path change is required. The distinct assignee set is derivable from the already-loaded ticket array, exactly as the status dropdown derives its options from loaded statuses. Two related back-end paths exist but must **not** be used here:

- `ClickUpSyncService._fetchListTasksInternal` accepts an `options.assignee` (`src/services/ClickUpSyncService.ts:1194`) that is folded into the cache-key fingerprint and then never applied — it is not sent as an API parameter and not filtered locally. It is a dead option. Do not wire the new filter to it, and do not "fix" it as part of this change.
- `loadTicketMembers` / `loadTicketAssignees` (`src/services/PlanningPanelProvider.ts:5557` / `:5501`) fetch the full workspace member roster for the assignee *editing* UI. Using them here would add a round-trip and would list people who have no tickets in this list.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature

## Approach

Follow the **search** precedent, not the status precedent. The status filters use two separate `<select>` elements (`tickets-state-filter` for Linear, `tickets-status-filter` for ClickUp, `src/webview/planning.html:3967-3968`) because their option vocabularies are provider-specific. Assignee options are computed from loaded data and are conceptually identical across providers, and only one provider is active at a time (`lastIntegrationProvider`). So use **one control backed by two per-provider state variables**, which is exactly how `tickets-search` already works (`src/webview/planning.js:2584`).

Filter on assignee **id**, display username/name. Ids are stable; display names change and can collide.

## Implementation Steps

### 1. Markup — one new select

In `src/webview/planning.html`, add next to the existing filter selects at `:3967-3968`:

```
<select id="tickets-assignee-filter" class="planning-select" style="display:none" title="Filter by assignee"></select>
```

Match the existing selects' class and hidden-by-default pattern.

### 2. Element accessor

In `getTicketsTabElements()` (`src/webview/planning.js:2430-2433`), add `assigneeFilter: document.getElementById('tickets-assignee-filter')` alongside `stateFilter` and `clickUpStatusFilter`.

### 3. State variables

Declare two module-scope values next to their status-filter counterparts:

- `linearProjectAssigneeFilterValue = ''` (near `src/webview/planning.js:509`)
- `clickUpProjectAssigneeFilterValue = ''` (near `src/webview/planning.js:555`)

Empty string means "all", matching the existing filter convention.

### 4. Populate + sync the control on render

In both list renderers, populate the select from the loaded ticket set before rendering cards, mirroring how the Linear state filter is populated and value-clamped at `src/webview/planning.js:10884-10885`:

- Build the distinct assignee set from the same pre-filter array the funnel reads (`clickUpProjectIssues` / `linearProjectIssues`), keyed by id, labelled by `username || email` (ClickUp) or `name || email` (Linear). Sort labels alphabetically.
- Options are: `All assignees` (value `''`), `Unassigned` (a reserved sentinel value — use `__unassigned__`, which cannot collide with a real id), then one option per distinct assignee.
- Clamp the current value: if the stored id is no longer present in the option set, reset it to `''` and write the reset back to the state variable. This is the same clamp the state filter performs, and it is what stops a stale filter from silently hiding every ticket after the list changes.
- Show the select when a provider list is active and hide it otherwise, consistent with the sibling status selects.

### 5. Apply the predicate in both funnels

`getFilteredClickUpTasks` (`src/webview/planning.js:11933`) — add after the existing status check at `:11938`:

- If the filter is `__unassigned__`, keep the task only when `assignees` is empty or absent.
- Otherwise keep the task when **any** entry in `task.assignees` has a matching id. ClickUp supports multiple assignees, so this is an `any` match, not an equality check.

`getFilteredLinearIssues` (`src/webview/planning.js:11032`) — add after the project check at `:11039`:

- If the filter is `__unassigned__`, keep the issue only when `issue.assignee` is null/absent.
- Otherwise keep the issue when `issue.assignee?.id` matches. Linear is single-assignee.

Insert the predicate **before** the `if (!search) return true` early return in both funnels, so assignee and search compose rather than short-circuit. Leave the assignee fields in the search haystacks alone — searching by name should keep working.

Do not alter the sort blocks.

### 6. Wire the change handler

Add a `change` listener for `tickets-assignee-filter` that mirrors the search wiring at `src/webview/planning.js:2584-2597`:

- Call `_resetSidebarDrillDown()` first. The search handler does this because a filter applied while drilled into subtasks is invisibly ignored and then unexpectedly applied on "Back to all tickets". The assignee filter has the identical hazard.
- Branch on `lastIntegrationProvider`, set the matching state variable, call the matching renderer, then `saveTicketsState()`.

### 7. Persist and restore

- Add both values to the `saveTicketsState()` payload (`src/webview/planning.js:12484-12490`) and to the restore path (`:12500-12506`), defaulting to `''`.
- Add `clickUpProjectAssigneeFilterValue` to the panel-state blob written at `src/webview/planning.js:1309` and read at `:1478`, alongside `clickUpProjectStatusFilterValue`.

### 8. Reset alongside every existing status-filter reset — the highest-risk step

`clickUpProjectStatusFilterValue` is reset to `''` at **six** sites: `src/webview/planning.js:1329`, `:11696`, `:11761`, `:11856`, `:12444`, and via the clamp at `:11928`. `linearProjectStateFilterValue` is reset at `:12420` and clamped at `:10884-10885`.

Add the corresponding assignee reset at every one of those sites. Missing a single site leaves a stale assignee id applied after a space/folder/list switch, and because the new list contains none of that person's tickets the sidebar renders empty with no visible cause — the worst failure mode in this change. Grep for both status-filter variable names and confirm each occurrence has a matching assignee line before considering this step done.

## Edge Cases and Decisions

- **Partially-loaded lists.** The Tickets tab has a "Load more" affordance, so the filter applies only to loaded tickets. This matches the existing search and status filters exactly, so behaviour is consistent — but if the resulting list is empty while more pages remain unloaded, the empty state should still show the Load more button rather than reading as a definitive "no tickets".
- **Parent/subtask rows.** Both funnels already drop `parentId` rows at the top of the predicate chain. Keep the assignee check after that, so a subtask's assignee never affects top-level visibility.
- **No "Me" option in v1.** Deliberately out of scope. It requires resolving the token's own identity — free on Linear (`{ viewer { id } }`, already called for the connection test at `src/services/LinearSyncService.ts:1998`) but a new `GET /user` call on ClickUp. Once the filter exists, picking your own name from the dropdown is one click, and the choice persists. Revisit only if that proves annoying.
- **Multiple simultaneous assignees.** ClickUp tickets can have several. Selecting one person shows every ticket they are on, including ones shared with others. That is the correct reading of "their tickets".
- **Deactivated members.** A person with tickets in the list appears in the dropdown even if deactivated upstream, because options come from the ticket data and not the member roster. Acceptable — their tickets are still real.

## Verification Plan

Manual, ClickUp:

1. Open the Tickets tab on a ClickUp list with tickets across at least two assignees plus one unassigned ticket. Confirm the assignee dropdown appears next to the status filter and lists `All assignees`, `Unassigned`, and each distinct name once.
2. Select a person. Only their tickets remain, including any co-assigned ones. Select `Unassigned`. Only the unassigned ticket remains.
3. With an assignee selected, type a term in the search box. Both filters apply together. Confirm the same for assignee plus status.
4. Reload the panel. The assignee selection is still applied and the dropdown reflects it.
5. Switch to a different list where that person has no tickets. The filter resets to `All assignees` and tickets are visible — it does **not** render an empty sidebar.
6. Select an assignee, drill into a ticket's subtasks, then click back. No tickets vanish unexpectedly.

Manual, Linear: repeat steps 1-6 against a Linear project, confirming single-assignee matching and that the Linear state filter and project picker still compose with the new filter.

Automated: add a regression test following the pattern in `src/test/kanban-linear-project-tab-regression.test.js`, asserting that (a) `tickets-assignee-filter` exists in the markup, (b) both filter funnels contain an assignee predicate positioned before the search early-return, and (c) every reset site for the status-filter variables has a matching assignee-filter reset. Point (c) is the one worth encoding in a test, since it is the step most likely to regress.

Run the existing suite with `--forceExit` and confirm no Tickets-tab tests break.
