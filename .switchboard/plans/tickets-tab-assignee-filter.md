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

> **Superseded:** **Complexity:** 3
> **Reason:** Under-scored. The change replicates an existing pattern, but it coordinates 8+ sites across two files (markup, accessor, two state vars, two option builders, two predicates, change handler, persist/restore, panel-state blob, six ClickUp reset sites + two Linear reset/clamp sites, two show/hide sites) with a silent-empty-sidebar failure mode if any single site is missed. That is multi-site coordination with one well-scoped moderate risk, not trivial single-file work.
> **Replaced with:** **Complexity:** 4

**Complexity:** 4
**Tags:** frontend, ui, feature

## User Review Required

- ~~The new select is placed in the top controls strip next to the existing `tickets-state-filter` / `tickets-status-filter` selects (`src/webview/planning.html:3952-3954`), not literally inside the sidebar next to the search box.~~ **CONFIRMED by user:** the filter goes in the controls strip, immediately after the status dropdown (`planning.html:3955`). This is now a decision, not a question.
- Filter options are derived only from currently-loaded tickets (consistent with search/status filters); people with unloaded tickets do not appear until "Load more" is clicked.
- No "Me" shortcut option in v1 (deliberate scope cut — see Edge Cases and Decisions).

## Approach

Follow the **search** precedent, not the status precedent. The status filters use two separate `<select>` elements (`tickets-state-filter` for Linear, `tickets-status-filter` for ClickUp, `src/webview/planning.html:3953-3954`) because their option vocabularies are provider-specific. Assignee options are computed from loaded data and are conceptually identical across providers, and only one provider is active at a time (`lastIntegrationProvider`). So use **one control backed by two per-provider state variables**, which is exactly how `tickets-search` already works (`src/webview/planning.js:2584`).

Filter on assignee **id**, display username/name. Ids are stable; display names change and can collide.

## Complexity Audit

### Routine
- One new `<select>` in `src/webview/planning.html`, cloned from two existing siblings.
- One new element accessor in `getTicketsTabElements()`.
- Two module-scope state variables, empty-string-means-all convention.
- Two filter predicates (`any`-match for ClickUp's multi-assignee array, equality for Linear's single assignee) inserted into existing funnels.
- One `change` handler mirroring the existing search/status wiring.
- Persist/restore additions following the exact status-filter pattern.

### Complex / Risky
- Reset-site completeness: the assignee state must be reset at every site where the status-filter state is reset (6 ClickUp sites + clamp, 1 Linear site + clamp). A single missed site produces a silently empty sidebar after a space/folder/list switch — no error, no visible cause.
- Option-builder must use the HTML-cache guard pattern (`_lastTickets...Html`) or the dropdown collapses mid-interaction on every re-render.

## Edge-Case & Dependency Audit

- **Race Conditions:** Options are rebuilt on every list render from the same pre-filter array the funnel reads, so options and predicate can never disagree. The clamp runs immediately after option rebuild and writes the reset back to the state variable, so a stale restored id from a previous session is corrected on first render rather than hiding all tickets. No async boundary is crossed — filtering is synchronous over an in-memory array.
- **Security:** All option labels and values must pass through `escapeHtml` / `escapeAttr` (`src/webview/planning.js:605` / `:1693`) — assignee names and emails are remote-controlled strings rendered into innerHTML. No new network surface, no credentials, no API calls.
- **Side Effects:** The `change` handler calls `_resetSidebarDrillDown()` (same as search/status) — applying the filter while drilled into subtasks exits the drill-down view. Deliberate and consistent with existing filters. The dead `options.assignee` path in `ClickUpSyncService` is explicitly untouched. Sort blocks untouched. Search haystacks untouched (name search keeps working).
- **Dependencies & Conflicts:** No new dependencies. Conflicts: none with the status/project filters — predicates compose multiplicatively in the same funnel. The `__unassigned__` sentinel cannot collide with real ids (ClickUp ids are numeric strings; Linear ids are UUIDs) and must be defined as a single module-scope constant referenced everywhere.

## Dependencies

None — no prior sessions or external work required.

## Adversarial Synthesis

Key risks: a missed reset site leaving a stale assignee id applied after a list switch (silently empty sidebar — the worst failure mode); rebuilding the select's innerHTML without the HTML-cache guard, collapsing an open dropdown; and the `__unassigned__` magic string drifting via typo across its four use sites. Mitigations: enumerated reset-site checklist plus a regression test asserting 1:1 parity with every status-filter reset site; mirror the `_lastTickets...Html` cache-guard pattern per provider; define one module-scope `TICKETS_ASSIGNEE_UNASSIGNED` constant referenced everywhere. The chosen architecture (one shared control, id-keyed, derived options) survives review unchanged.

## Proposed Changes

### src/webview/planning.html

- **Context:** The Tickets tab filter controls live in the top controls strip next to `tickets-source-summary`. The existing selects are `tickets-project-picker` (:3952), `tickets-state-filter` (:3953), and `tickets-status-filter` (:3954), all `class="planning-select" style="display:none"`.

> **Superseded:** "In `src/webview/planning.html`, add next to the existing filter selects at `:3967-3968`."
> **Reason:** Wrong line cite. `:3967-3968` is the `tree-pane-tickets` container and sidebar toggle row; the actual filter selects are at `:3952-3954` in the controls strip. (Note: the Goal says "alongside the existing search box and status/state filters" — the search box is in the sidebar at `:3975` but the selects are in the controls strip; the new select belongs with its sibling selects.)
> **Replaced with:** Add the new select at `src/webview/planning.html:3955`, immediately after `tickets-status-filter`.

- **Logic:** One new control, hidden by default, shown/hidden by the provider renderers.
- **Implementation:**
  ```html
  <select id="tickets-assignee-filter" class="planning-select" style="display:none" title="Filter by assignee"></select>
  ```
- **Edge Cases:** None — markup is inert until wired.

### src/webview/planning.js

- **Context:** All Tickets-tab filter state, funnels, renderers, persistence, and reset logic live in this file. The plan touches nine coordinated areas, each mirroring an existing status-filter or search pattern.

- **Logic & Implementation:**

  1. **Element accessor.** In `getTicketsTabElements()` (`:2425-2444`), add `assigneeFilter: document.getElementById('tickets-assignee-filter')` alongside `stateFilter` (:2432) and `clickUpStatusFilter` (:2433).

  2. **State variables + sentinel constant.** Declare next to their status-filter counterparts:
     - `linearProjectAssigneeFilterValue = ''` (near `:509`, beside `linearProjectStateFilterValue`)
     - `clickUpProjectAssigneeFilterValue = ''` (near `:555`, beside `clickUpProjectStatusFilterValue`)
     - **Clarification:** also declare `const TICKETS_ASSIGNEE_UNASSIGNED = '__unassigned__';` once at module scope and reference it in the option builder, both predicates, and the clamp — never inline the literal. ClickUp ids are numeric strings and Linear ids are UUIDs, so the sentinel cannot collide; a single constant removes typo drift across its four use sites.
     - Empty string means "all", matching the existing filter convention.

  3. **Option builders (one per provider), with HTML-cache guards.** Mirror the two existing patterns exactly:
     - Linear precedent: `renderTicketsLinearStateFilterOptions()` (`:10865-10886`) — builds a distinct sorted set, diffs against `_lastTicketsStateFilterHtml` before touching `innerHTML`, then clamps the value (`:10884-10885`) and writes the clamp back.
     - ClickUp precedent: the status-option sync at `:11900-11931` — same shape with `_lastTicketsClickUpStateFilterHtml` (:11925-11930).
     - **Clarification:** create `renderTicketsLinearAssigneeFilterOptions()` and `renderTicketsClickUpAssigneeFilterOptions()` as dedicated functions with their own `_lastTicketsLinearAssigneeFilterHtml` / `_lastTicketsClickUpAssigneeFilterHtml` cache vars, called from the same renderer sites that call the state/status option builders (:10845 area and the ClickUp equivalent). Without the cache guard, rewriting `innerHTML` on every render collapses the dropdown while the user has it open.
     - Build the distinct assignee set from the same pre-filter array the funnel reads (`clickUpProjectIssues` / `linearProjectIssues`), keyed by id, labelled by `username || email` (ClickUp) or `name || email` (Linear). ClickUp: fold all entries of each task's `assignees` array into the set. Sort labels alphabetically with `localeCompare`.
     - Options are: `All assignees` (value `''`), `Unassigned` (value `TICKETS_ASSIGNEE_UNASSIGNED`), then one option per distinct assignee. All labels/values pass through `escapeHtml`/`escapeAttr`.
     - Clamp the current value: if the stored id is not `''`, not the sentinel, and no longer present in the option set, reset it to `''` and write the reset back to the state variable — the same clamp the state filter performs, and what stops a stale filter from silently hiding every ticket after the list changes.

  4. **Show/hide wiring.** Add the assignee select at both sites where the sibling selects are shown/hidden:
     - Linear renderer: `stateFilter.style.display = ''` / `clickUpStatusFilter.style.display = 'none'` at `:10840-10841` → also `assigneeFilter.style.display = ''`.
     - ClickUp renderer: `:11575-11577` (`stateFilter` hidden, `clickUpStatusFilter` shown when a list is active) → mirror the `clickUpStatusFilter` condition for `assigneeFilter`.

  5. **Predicates in both funnels**, inserted **before** the `if (!search) return true` early return so assignee and search compose rather than short-circuit:
     - `getFilteredClickUpTasks()` (`:11933`) — add after the status check at `:11938`:
       - If the filter is `TICKETS_ASSIGNEE_UNASSIGNED`, keep the task only when `task.assignees` is empty or absent.
       - Otherwise keep the task when **any** entry in `task.assignees` has a matching id (`task.assignees?.some(a => String(a?.id) === assigneeFilter)`). ClickUp supports multiple assignees — `any` match, not equality.
     - `getFilteredLinearIssues()` (`:11032`) — add after the project check at `:11039`:
       - If the filter is `TICKETS_ASSIGNEE_UNASSIGNED`, keep the issue only when `issue.assignee` is null/absent.
       - Otherwise keep the issue when `String(issue.assignee?.id)` matches. Linear is single-assignee.
     - Leave the assignee fields in the search haystacks (:11945, :11045-11046) alone — searching by name keeps working. Do not alter the sort blocks.

  6. **Change handler.** Add a `change` listener for `tickets-assignee-filter` next to the existing filter listeners (`:10064-10074`), mirroring the search wiring at `:2584-2597`:
     - Call `_resetSidebarDrillDown()` first. The search handler does this because a filter applied while drilled into subtasks is invisibly ignored and then unexpectedly applied on "Back to all tickets". The assignee filter has the identical hazard.
     - Branch on `lastIntegrationProvider`, set the matching state variable, call the matching renderer (`renderTicketsLinearList()` / `renderTicketsClickUpList()`), then `saveTicketsState()`.

  7. **Persist and restore.**
     - Add both values to the `saveTicketsState()` payload (`:12484-12490`, beside `linearProjectStateFilterValue` at :12484 and `clickUpProjectStatusFilterValue` at :12490) and to the restore path (`:12500-12506`), defaulting to `''`.
     - Add `clickUpProjectAssigneeFilterValue` to the panel-state blob written at `:1309` and read at `:1478`, alongside `clickUpProjectStatusFilterValue`.

  8. **Reset alongside every existing status-filter reset — the highest-risk step.** `clickUpProjectStatusFilterValue` is reset to `''` at **six** sites: `:1329`, `:11696`, `:11761`, `:11856`, `:12444`, and via the clamp at `:11928`. `linearProjectStateFilterValue` is reset at `:12420` and clamped at `:10884-10885`. Add the corresponding assignee reset at every one of those sites (the two clamps are covered by step 3's clamp logic; the other seven need explicit lines). Missing a single site leaves a stale assignee id applied after a space/folder/list switch, and because the new list contains none of that person's tickets the sidebar renders empty with no visible cause — the worst failure mode in this change. Grep for both status-filter variable names and confirm each occurrence has a matching assignee line before considering this step done.

- **Edge Cases:** See "Edge Cases and Decisions" below — all preserved from the original analysis and confirmed against the code.

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
7. Open the assignee dropdown, then trigger a re-render (e.g. Refresh). Confirm the select is not rebuilt under the user's mouse (HTML-cache guard working).

Manual, Linear: repeat steps 1-6 against a Linear project, confirming single-assignee matching and that the Linear state filter and project picker still compose with the new filter.

### Automated Tests

Per session directive, automated tests are **not run** as part of this verification plan. The following test addition remains part of the implementation scope (to be executed in a later session that is permitted to run tests):

Add a regression test following the pattern in `src/test/kanban-linear-project-tab-regression.test.js`, asserting that (a) `tickets-assignee-filter` exists in the markup, (b) both filter funnels contain an assignee predicate positioned before the search early-return, and (c) every reset site for the status-filter variables has a matching assignee-filter reset. Point (c) is the one worth encoding in a test, since it is the step most likely to regress. When tests are next run, use `--forceExit` and confirm no Tickets-tab tests break.

## Recommendation

**Send to Coder** (complexity 4). The change is disciplined pattern-replication against well-cited precedents, but it coordinates 8+ sites across two files with a silent-failure mode — it needs the reset-site checklist executed carefully and verified by grep, not an intern's first pass.
