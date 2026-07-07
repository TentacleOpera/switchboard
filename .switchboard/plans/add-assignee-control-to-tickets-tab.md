# Add Assignee Control to Tickets Tab

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, ui, ux, feature
**Project:** _(unassigned — no active project filter set)_

## Goal

Add the ability to assign (and unassign) people to an issue from the **Tickets** tab in `planning.html`. Today the ticket detail meta bar exposes controls for Status (dropdown), Tags (modal), Comment, Attachments, Subtask, etc., but there is **no way to change who is assigned** — the assignee is read-only. The list view already renders "Unassigned" or the assignee name(s), and the data model already carries assignees (`task.assignees[]` for ClickUp, `issue.assignee` for Linear), so this is a wiring + UI feature, not a data-model change.

### Problem & Root Cause

- **Symptom:** A user viewing a ClickUp or Linear ticket in the Tickets tab cannot change the assignee without leaving Switchboard and opening the provider's web UI.
- **Root cause:** The meta bar (`#tickets-preview-meta-bar`) was built with a Status `<select>` and a Tags modal, but an assignee control was never added. The backend primitives needed to implement it already exist and are even used elsewhere in the same tab:
  - Member listing: `linear.getTeamMembers()` and `clickup.getListMembers(listId)` are already called by the comment-manager's @mention feature (`loadTicketComments` → `members`).
  - ClickUp updates: `clickup.updateTask(id, { assignees: number[] })` already accepts an `assignees` field (see `ClickUpSyncService.updateTask`, line ~1409).
  - Linear updates: `linear.updateIssueState(issueId, stateId)` is the template for a new `updateIssueAssignee(issueId, assigneeId)` using the same `issueUpdate` GraphQL mutation with an `assigneeId` argument.
- **Why now:** Assignment is a core ticket-management action; its absence is a glaring gap next to Status and Tags. All prerequisites are already in place, making this low-risk.

### Scope (confirmed with user)

- **Providers:** Both ClickUp **and** Linear.
- **UI:** A Tags-style **modal** (searchable member list with checkboxes), launched by an "Assign" button in the meta bar.
- **Unassignment:** Supported — a "Nobody / Unassigned" option clears the assignee.

### Out of scope

- Bulk assignment across multiple tickets.
- Assignee as a filter/sort option in the tickets list (separate feature).
- Changing the assignee display in the list row (already shows names / "Unassigned").
- Notifications/mentions behavior changes.

## Background & Context

### Files involved

- `src/webview/planning.html` — meta bar markup (around line 3757–3774) and a new modal (mirror of `#tags-modal` at line 4060–4079).
- `src/webview/planning.js` — modal open/save/close handlers, member-catalog fetch + cache, selected-ticket state (`selectedLinearIssue`, `selectedClickUpIssue`, `lastIntegrationProvider`).
- `src/services/PlanningPanelProvider.ts` — webview message switch (add `loadTicketAssignees`, `linearUpdateIssueAssignee`, `clickupUpdateTaskAssignees` cases; mirror `linearUpdateIssueLabels` at line 5092 and `clickupUpdateTaskTags` at line 5128).
- `src/services/TaskViewerProvider.ts` — command wrappers (mirror `changeTicketStatus` at line 20230) OR call services directly from PlanningPanelProvider (the tags path calls services directly via `_adapterFactories`; prefer that for consistency).
- `src/services/LinearSyncService.ts` — add `updateIssueAssignee(issueId, assigneeId | null)` mirroring `updateIssueState` (line 1095). `getTeamMembers()` already exists (line 1503).
- `src/services/ClickUpSyncService.ts` — `updateTask(id, { assignees })` already supports assignees (line 1409). `getListMembers(listId)` exists (line 1653); `getTaskDetails(taskId)` exists (line 1223) to resolve the `listId`.
- `src/extension.ts` — if command wrappers are used, register them (mirror `changeTicketStatus` registration at line 1646). Prefer the direct-call path to avoid this.

### Existing patterns to mirror

- **Tags modal** (`#tags-modal`, `openTagsModal`, `saveTags`, `renderTagsModalList`): the new Assign modal should follow this structure exactly — `Available Members` list with checkboxes, Cancel/Save footer, close on backdrop click, `_tagsModalOpen`-style guard.
- **Status dropdown** (`select-status-ticket` change → `changeTicketStatus` message → `changeTicketStatusResult`): the round-trip message pattern and post-update refetch behavior.
- **Member catalog**: the comment manager already receives `members` via `loadTicketComments`. The Assign modal should fetch members on demand via a dedicated message (see Design Decision below) rather than relying on `_cmMembers`, because comments may not have been opened.

## Design Decisions

1. **Modal, not a meta-bar dropdown.** ClickUp supports multiple assignees; a checkbox modal handles both cardinalities uniformly and matches the Tags pattern the user already knows. Linear's single-assignee constraint is enforced on Save (see below).
2. **Dedicated member fetch (`loadTicketAssignees`), not reuse of `_cmMembers`.** ClickUp list membership is per-list (depends on the task's `listId`), so the "catalog" is ticket-context-dependent for ClickUp. A dedicated message keeps the fetch correct and avoids a stale/empty cache when comments were never opened. Cache the result in-session keyed by `provider + ticketId` (ClickUp) or `provider` (Linear, team-scoped) to avoid refetches on repeated opens of the same ticket.
3. **Linear single-assignee enforcement.** Linear allows only one assignee. The modal will render checkboxes for both providers, but for Linear: (a) checkboxes behave as radio (selecting one clears others), or (b) Save validates `selectedIds.length <= 1` and shows an inline error. Recommended: radio-like behavior in the UI plus a "Nobody" option, so the UX matches Linear's model. ClickUp keeps multi-select checkboxes.
4. **"Nobody / Unassigned" option.** Rendered as a special entry at the top of the list (checkbox/radio with a sentinel value, e.g. `__unassigned__`). On Save: if selected, Linear sends `assigneeId: null`; ClickUp sends `assignees: []`.
5. **Post-save refetch.** Mirror the Tags/Status flow: on success result, update the in-memory `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees` optimistically from the selected member object(s), re-render the list row + detail, and issue the existing ticket-refetch so the canonical record updates. Reuse the existing `pushTicketResult`/refetch machinery where possible.
6. **Direct service calls from PlanningPanelProvider** (not new VS Code commands), matching how `linearUpdateIssueLabels` and `clickupUpdateTaskTags` are wired. This avoids touching `extension.ts` and `TaskViewerProvider.ts` command registration.

## Requirements

### Functional

1. An **"Assign"** button appears in `#tickets-preview-meta-bar` between Status and Tags (or adjacent to Tags), visible only when a ticket is selected.
2. Clicking "Assign" opens a modal titled "Assign Members" with:
   - A search input to filter the member list by name/email.
   - A scrollable list of members, each with a checkbox (ClickUp) or radio-like checkbox (Linear) showing name + email.
   - A "Nobody / Unassigned" option at the top.
   - Cancel and Save buttons.
3. The currently assigned member(s) are pre-checked when the modal opens.
4. Save sends the update to the provider and closes the modal; the detail view and list row reflect the new assignee(s) without a full reload.
5. Errors surface via the existing `showTicketsStatus` / `linearError` / `clickupError` channels.
6. The control works for both Linear and ClickUp providers and respects each provider's assignee cardinality.

### Non-functional

- Member list fetch must be cached per session (per `provider+ticketId` for ClickUp, per `provider` for Linear) to avoid repeated API calls on modal reopen.
- Loading state: disable Save + show a spinner while the member list is being fetched (mirror `_tagsCatalogLoading`).
- No change to the on-disk ticket markdown format required (assignees are already serialized by the existing import/sync path).

## Edge Cases & Risks

- **ClickUp listId resolution failure.** `getTaskDetails` may fail or the task may lack a `list.id`. Mitigation: show an inline error in the modal ("Could not load members for this task's list") and disable Save; do not crash.
- **Empty member list.** A Linear team or ClickUp list with no members. Mitigation: show an empty-state message in the modal; "Nobody" remains selectable.
- **Linear multi-select attempt.** If radio-like enforcement is buggy, a user could try to send multiple IDs. Mitigation: validate on Save (`length <= 1`) and surface an error; belt-and-suspenders with the UI radio behavior.
- **Stale member cache after team/list changes.** Out-of-band membership changes won't appear until cache TTL/refresh. Mitigation: add a small "Refresh" affordance (mirror the move-modal's refresh button at line 555) or clear cache on modal open if older than N minutes. Linear already has `MEMBERS_TTL_MS`; reuse that constant's spirit.
- **Unassign semantics.** Linear `assigneeId: null` is valid in `issueUpdate`. ClickUp `assignees: []` — verify the ClickUp API accepts an empty array to clear (if not, the ClickUp API may require omitting the field; verify in implementation and adjust to the documented "remove assignee" call). **This is the one assumption to verify during implementation.**
- **Permissions.** The configured Linear/ClickUp token must have write access to assignees. If it lacks permission, the provider returns an error — surface it via the existing error channel; no special handling needed.
- **Concurrent edits.** Two agents/users editing the same ticket's assignee simultaneously — last write wins, consistent with how Status/Tags already behave. No new conflict handling.
- **Theme compatibility.** The modal must respect `theme-claudify` and `cyber-theme-enabled` — reuse the existing `.folder-modal` / `.strip-btn` / `.planning-button` classes so theming is inherited for free.

## Implementation Plan

### 1. Backend — Linear assignee update

- In `LinearSyncService.ts`, add `public async updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void>` mirroring `updateIssueState` (line 1095): GraphQL `issueUpdate(id, input: { assigneeId })` where `assigneeId` is `null` for unassign. Invalidate the issue's project cache the same way `updateIssueState` does.
- Verify `issueUpdate` accepts `assigneeId: null` (Linear API docs confirm `assigneeId` is a nullable `String` on `IssueUpdateInput`).

### 2. Backend — PlanningPanelProvider message handlers

Add three cases in `PlanningPanelProvider.ts` (mirror the tags handlers at lines 5092–5163):

- `case 'loadTicketAssignees'`: resolve provider + id; for Linear call `linear.getTeamMembers()`; for ClickUp call `clickup.getTaskDetails(id)` to get `listId`, then `clickup.getListMembers(listId)`. Post back `{ type: 'ticketAssigneesLoaded', provider, id, members, currentAssigneeIds }` where `currentAssigneeIds` is derived from the selected issue/task. On error post `{ type: 'ticketAssigneesError', ... }`.
- `case 'linearUpdateIssueAssignee'`: validate `issueId` + `assigneeId` (string or null); call `linear.updateIssueAssignee(issueId, assigneeId)`; post `{ type: 'linearAssigneeUpdated', issueId, assigneeId, member }` (include the member object for optimistic UI) or `linearError`.
- `case 'clickupUpdateTaskAssignees'`: validate `taskId` + `assigneeIds: string[]` (may be empty for unassign); call `clickup.updateTask(taskId, { assignees: assigneeIds.map(Number) })`; post `{ type: 'clickupAssigneesUpdated', taskId, assigneeIds, members }` or `clickupError`. **Verify ClickUp accepts an empty array to clear assignees; if not, use the documented remove-assignee path.**

### 3. Frontend — modal markup (`planning.html`)

- Add an "Assign" button in `#tickets-preview-meta-bar` (after the Status group, before Tags): `<button id="btn-assign-ticket" class="strip-btn" title="Assign members">Assign</button>`.
- Add a new modal `#assign-modal` mirroring `#tags-modal` (line 4060): title "Assign Members", a search `<input id="assign-search">`, a list container `<div id="assign-available-list">`, and Cancel/Save buttons (`btn-cancel-assign`, `btn-save-assign`). Reuse `.folder-modal` / `.modal-content` / `.strip-btn` / `.planning-button` classes.

### 4. Frontend — modal logic (`planning.js`)

- Add state: `let _assignModalOpen = false; let _assignMembersCache = null; let _assignMembersLoading = false; let _assignMembers = []; let _currentAssigneeIds = [];` plus a per-ticket cache map.
- `openAssignModal()`: determine provider + ticket id from `selectedLinearIssue` / `selectedClickUpIssue`; compute current assignee id(s) from the selected record; if cache valid, render immediately, else send `loadTicketAssignees` and show loading state; set `_assignModalOpen = true`; show modal.
- `renderAssignModalList(filter)`: render "Nobody / Unassigned" entry first (sentinel `__unassigned__`), then members matching the search filter; for Linear use radio-like behavior (clicking one unchecks others + "Nobody"), for ClickUp use independent checkboxes; pre-check current assignees.
- `saveAssign()`: read selected ids; for Linear, map `__unassigned__` → `null` and enforce `length <= 1`; send `linearUpdateIssueAssignee` or `clickupUpdateTaskAssignees`; close modal; clear `_assignModalOpen`.
- Wire handlers (mirror tags wiring at lines 8606–8622): `btn-assign-ticket` click → `openAssignModal`; `btn-close-assign-modal` / `btn-cancel-assign` → close; `btn-save-assign` → `saveAssign`; backdrop click → close; `assign-search` input → `renderAssignModalList(value)`.
- Handle results: `case 'ticketAssigneesLoaded'` → populate `_assignMembers`, render list, hide loading. `case 'linearAssigneeUpdated'` / `case 'clickupAssigneesUpdated'` → optimistically update `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees` from the returned member object(s), re-render the list row + detail header, show a success status. `case 'ticketAssigneesError'` / error cases → `showTicketsStatus(msg.error, true)`.
- Disable the "Assign" button when no ticket is selected (mirror how `tickets-tags` is toggled at lines 9459–9461 / 10003–10013).

### 5. Verification

- Manual: select a Linear ticket → open Assign → pick a member → Save → confirm list row + detail update → reopen → confirm pre-check → choose "Nobody" → Save → confirm "Unassigned". Repeat for a ClickUp ticket (multi-select + unassign).
- Typecheck/build: run the project's build/typecheck (confirm command in repo) to ensure no TS errors from the new Linear method and message-handler cases.
- Error path: temporarily use an invalid token → confirm error surfaces in the status footer, not a crash.
- Theme: toggle `theme-claudify` and `cyber-theme-enabled` → confirm modal styling is consistent.

## Open Questions for Implementation

- Confirm the exact build/typecheck command for this repo (will check `package.json` scripts during implementation).
- Confirm ClickUp's behavior for clearing assignees via `updateTask({ assignees: [] })` vs. a dedicated remove call (verify against ClickUp API docs during step 2).

## Acceptance Criteria

- [ ] "Assign" button appears in the ticket meta bar for both providers when a ticket is selected.
- [ ] Assign modal lists team/list members with search, pre-checks current assignees, and offers a "Nobody" option.
- [ ] Saving updates the assignee on the provider and reflects locally without a full reload.
- [ ] Unassignment works for both providers.
- [ ] Linear enforces single assignee; ClickUp allows multiple.
- [ ] Errors surface in the existing status/error channels; no uncaught exceptions.
- [ ] Modal respects both themes; build/typecheck passes.

**Stage Complete:** Created
