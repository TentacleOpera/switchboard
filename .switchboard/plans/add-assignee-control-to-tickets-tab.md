# Add Assignee Control to Tickets Tab

## Goal

Add the ability to assign (and unassign) people to an issue from the **Tickets** tab in `planning.html`. Today the ticket detail meta bar exposes controls for Status (dropdown), Tags (modal), Comment, Attachments, Subtask, etc., but there is **no way to change who is assigned** — the assignee is read-only. The list view already renders "Unassigned" or the assignee name(s), and the data model already carries assignees (`task.assignees[]` for ClickUp, `issue.assignee` for Linear), so this is a wiring + UI feature, not a data-model change.

### Problem & Root Cause

- **Symptom:** A user viewing a ClickUp or Linear ticket in the Tickets tab cannot change the assignee without leaving Switchboard and opening the provider's web UI.
- **Root cause:** The meta bar (`#tickets-preview-meta-bar`) was built with a Status `<select>` and a Tags modal, but an assignee control was never added. The backend primitives needed to implement it already exist and are even used elsewhere in the same tab:
  - Member listing: `linear.getTeamMembers()` and `clickup.getListMembers(listId)` are already called by the comment-manager's @mention feature (`loadTicketComments` → `members`).
  - ClickUp updates: `clickup.updateTask(id, { assignees: number[] })` already accepts an `assignees` field (see `ClickUpSyncService.updateTask`, line ~1409; the `updates.assignees?: number[]` field is declared at line 1313 and 1417).
  - Linear updates: `linear.updateIssueState(issueId, stateId)` is the template for a new `updateIssueAssignee(issueId, assigneeId)` using the same `issueUpdate` GraphQL mutation with an `assigneeId` argument. `updateIssueLabels` (line 1129) and `updateIssueParent` (line 1161) follow the identical `issueUpdate(id, input: {...})` pattern, confirming the mutation shape is reusable for arbitrary `IssueUpdateInput` fields.
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

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, feature
**Project:** _(unassigned — no active project filter set)_

## User Review Required

No product-shaping decisions remain — scope is confirmed with the user (both providers, Tags-style modal, unassign supported). Review is only needed if the two API-semantics uncertainties in **Uncertain Assumptions** resolve unfavorably and force a UX change (e.g. ClickUp unassign requiring a different call surface). Otherwise this may proceed to a Coder without further human sign-off.

## Complexity Audit

### Routine

- New Linear method `updateIssueAssignee` is a near-verbatim copy of `updateIssueState` (same `issueUpdate` mutation, same cache-invalidation tail) — single-file, pattern-mirrored.
- New `#assign-modal` markup is a structural clone of `#tags-modal` (`.folder-modal` / `.modal-content` / `.modal-header` / `.modal-body` / Cancel+Save footer) — reuses existing CSS classes, theming inherited for free.
- Three new `PlanningPanelProvider` message cases mirror the `linearUpdateIssueLabels` (line 5100) and `clickupUpdateTaskTags` (line 5136) handlers exactly: resolve workspace root → validate → call service via `_adapterFactories` → post result/error.
- Frontend modal open/save/close wiring mirrors the tags wiring at lines 8606–8625 — same event targets, same backdrop-close pattern.
- Optimistic UI patch mirrors the existing Tags/Status post-save refetch machinery.

### Complex / Risky

- **Provider assignee-cardinality split.** Linear is single-assignee (`LinearIssue.assignee: {id,name,email} | null`, line 59); ClickUp is multi-assignee (`ClickUpTask.assignees: Array<{id,username,email}>`, line 91). One modal must render radio-like behavior for Linear and independent checkboxes for ClickUp, plus a shared "Nobody" sentinel — moderate UX/state logic, well-scoped.
- **Unassign API semantics (unverified).** ClickUp `updateTask({ assignees: [] })` and Linear `issueUpdate(input: { assigneeId: null })` are the planned clear paths but their exact API behavior must be confirmed before coding (see **Uncertain Assumptions**). Silent-fail risk on the unassign path if assumptions are wrong; documented fallbacks exist.
- **Per-provider id coercion.** ClickUp member ids are strings but `updateTask` requires `number[]`; Linear ids stay strings. A single `saveAssign` must branch coercion by provider — easy to bug if lumped together.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two agents/users editing the same ticket's assignee simultaneously — last write wins, consistent with how Status/Tags already behave. No new conflict handling. The modal fetch → save window is short; a stale member list is bounded by the service TTL caches.
- **Security:** The configured Linear/ClickUp token must have write access to assignees. If it lacks permission, the provider returns an error — surface it via the existing `linearError` / `clickupError` channels; no special handling needed. No new secrets touched.
- **Side Effects:** On save, the in-memory `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees` is patched optimistically and the list row + detail header re-render. The existing ticket-refetch machinery keeps the canonical record in sync. Linear `updateIssueAssignee` invalidates the issue's project cache exactly like `updateIssueState`; ClickUp `updateTask` already invalidates the containing list's cache. No on-disk ticket markdown format change (assignees already serialized by the existing import/sync path).
- **Dependencies & Conflicts:**
  - Depends on `LinearSyncService.getTeamMembers` (line 1503) and `ClickUpSyncService.getListMembers` (line 1653) — both already exist with TTL caches.
  - Depends on `ClickUpSyncService.updateTask` accepting `assignees: number[]` (line 1417) — confirmed in source.
  - Depends on the Linear `issueUpdate` mutation accepting an `assigneeId` input field — pattern-confirmed via `stateId`/`labelIds`/`parentId` siblings; nullability of `assigneeId` to be confirmed (see **Uncertain Assumptions**).
  - No conflicts with other in-flight work — changes are additive (new button, new modal, new message cases, one new service method).

## Dependencies

None — standalone feature. No prerequisite plans or prior sessions (`sess_…`) must complete first. All backend primitives already exist in the codebase.

## Adversarial Synthesis

Key risks: (1) double caching — a frontend keyed-cache would shadow the existing service-level TTL caches (`MEMBERS_TTL_MS`, `LIST_MEMBERS_TTL_MS`) and create stale-data sandwiches; (2) a 2-HTTP-call tax to resolve a `listId` the webview already holds in `selectedClickUpIssue.task.list?.id`; (3) a type-coercion landmine where Linear string ids could be `Number()`'d to `NaN`; (4) silent-fail unassign if ClickUp/Linear clear-semantics assumptions are wrong. Mitigations: rely on the single service-tier cache (no parallel frontend map), pass `listId` from the client, branch id coercion explicitly per provider in `saveAssign`, and resolve the two API-semantics uncertainties via web research before coding (with documented fallbacks: ClickUp → use the documented remove-assignee call; Linear → omit `assigneeId` from the input if `null` is rejected).

## Background & Context

### Files involved

- `src/webview/planning.html` — meta bar markup (lines 3757–3774) and a new modal (mirror of `#tags-modal` at lines 4060–4079).
- `src/webview/planning.js` — modal open/save/close handlers, member-catalog fetch + cache, selected-ticket state (`selectedLinearIssue` line 242, `selectedClickUpIssue` line 256, `lastIntegrationProvider` line 151).
- `src/services/PlanningPanelProvider.ts` — webview message switch (add `loadTicketAssignees`, `linearUpdateIssueAssignee`, `clickupUpdateTaskAssignees` cases; mirror `linearUpdateIssueLabels` at line 5100 and `clickupUpdateTaskTags` at line 5136).
- `src/services/LinearSyncService.ts` — add `updateIssueAssignee(issueId, assigneeId | null)` mirroring `updateIssueState` (line 1095). `getTeamMembers()` already exists (line 1503, returns `{id,name,email}[]`, 5-min TTL cache).
- `src/services/ClickUpSyncService.ts` — `updateTask(id, { assignees })` already supports assignees (line 1409; `assignees?: number[]` at line 1417). `getListMembers(listId)` exists (line 1653, returns `{id,username,email,name}[]` with string ids, per-`listId` TTL cache). `getTaskDetails(taskId)` exists (line 1223) as a fallback to resolve `listId` only when the client lacks it.
- `src/services/TaskViewerProvider.ts` and `src/extension.ts` — **not modified** under the chosen direct-call path (Design Decision #6); listed only for context. The tags path calls services directly via `_adapterFactories`, and this plan follows that same path to avoid touching command registration.

### Existing patterns to mirror

- **Tags modal** (`#tags-modal`, `openTagsModal` line 481, `saveTags` line 502, `renderTagsModalList` line 445, `_tagsModalOpen` line 310, `_tagsCatalogLoading` line 311): the new Assign modal follows this structure — `Available Members` list with checkboxes, Cancel/Save footer, close on backdrop click, `_tagsModalOpen`-style guard.
- **Status dropdown** (`select-status-ticket` change → `changeTicketStatus` message → `changeTicketStatusResult`): the round-trip message pattern and post-update refetch behavior.
- **Member catalog**: the comment manager already receives `members` via `loadTicketComments`. The Assign modal fetches members on demand via a dedicated `loadTicketAssignees` message (see Design Decision #2) rather than relying on `_cmMembers`, because comments may not have been opened and ClickUp list membership is per-list (ticket-context-dependent).

## Design Decisions

1. **Modal, not a meta-bar dropdown.** ClickUp supports multiple assignees; a checkbox modal handles both cardinalities uniformly and matches the Tags pattern the user already knows. Linear's single-assignee constraint is enforced on Save (see below).
2. **Dedicated member fetch (`loadTicketAssignees`), not reuse of `_cmMembers`.** ClickUp list membership is per-list (depends on the task's `listId`), so the "catalog" is ticket-context-dependent for ClickUp. A dedicated message keeps the fetch correct and avoids a stale/empty cache when comments were never opened.
   - *Clarification (single cache tier):* Do **not** build a parallel frontend keyed-cache map. Rely on the existing service-level TTL caches — `LinearSyncService.MEMBERS_TTL_MS` (line 1504) and `ClickUpSyncService.LIST_MEMBERS_TTL_MS` (line 1658) — which are already correct, per-scope, and invalidated on update. A thin frontend guard ("don't refetch if the modal is reopened for the same ticket selection within the same render cycle") is acceptable; a second keyed cache is not.
   - *Clarification (client-supplied `listId`):* For ClickUp, pass `listId` from the webview's `selectedClickUpIssue.task.list?.id` in the `loadTicketAssignees` message and call `clickup.getListMembers(listId)` directly. Fall back to `clickup.getTaskDetails(id)` to resolve `listId` **only** when the client's `list.id` is absent. This avoids 2 redundant HTTP calls (subtasks + comments) on every modal open.
3. **Linear single-assignee enforcement.** Linear allows only one assignee. The modal renders checkboxes for both providers, but for Linear: (a) checkboxes behave as radio (selecting one clears others), or (b) Save validates `selectedIds.length <= 1` and shows an inline error. Recommended: radio-like behavior in the UI plus a "Nobody" option, so the UX matches Linear's model. ClickUp keeps multi-select checkboxes.
4. **"Nobody / Unassigned" option.** Rendered as a special entry at the top of the list (checkbox/radio with a sentinel value `__unassigned__`). On Save: if selected, Linear sends `assigneeId: null`; ClickUp sends `assignees: []`.
5. **Post-save refetch.** Mirror the Tags/Status flow: on success result, update the in-memory `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees` optimistically, re-render the list row + detail, and issue the existing ticket-refetch so the canonical record updates. Reuse the existing `pushTicketResult`/refetch machinery where possible.
   - *Clarification (id-only backend round-trip):* The backend handlers post back the **accepted ids only** (`assigneeId` / `assigneeIds`), not member objects. The webview maps those ids → member objects from its own `_assignMembers` list for the optimistic UI patch. The backend must not re-fetch the member list to fabricate member objects.
6. **Direct service calls from PlanningPanelProvider** (not new VS Code commands), matching how `linearUpdateIssueLabels` and `clickupUpdateTaskTags` are wired. This avoids touching `extension.ts` and `TaskViewerProvider.ts` command registration. This is the committed path; the command-wrapper alternative is listed in **Files involved** for context only and is not implemented.
   - *Clarification (per-provider id coercion in `saveAssign`):* Branch explicitly by provider. **Linear:** ids stay strings; sentinel `__unassigned__` → `null`; enforce `length <= 1`. **ClickUp:** ids → `Number(id)`; the handler calls `updateTask(taskId, { assignees: ids.map(Number) })`. Never `Number()` a Linear id (would yield `NaN` and a GraphQL rejection).

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

- Member list fetch relies on the existing service-level TTL caches (`MEMBERS_TTL_MS` / `LIST_MEMBERS_TTL_MS`); no parallel frontend keyed-cache (see Design Decision #2).
- Loading state: disable Save + show a spinner while the member list is being fetched (mirror `_tagsCatalogLoading`).
- No change to the on-disk ticket markdown format required (assignees are already serialized by the existing import/sync path).

## Proposed Changes

### src/services/LinearSyncService.ts

- **Context:** A new public method is needed to update a Linear issue's assignee. The `issueUpdate` GraphQL mutation already accepts multiple input fields (`stateId`, `labelIds`, `parentId`); `assigneeId` is the field for assignment.
- **Logic:** Add `public async updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void>` mirroring `updateIssueState` (line 1095) and `updateIssueParent` (line 1161, which already demonstrates a nullable string input). GraphQL:
  ```graphql
  mutation($id: String!, $assigneeId: String) {
    issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
  }
  ```
  Pass `assigneeId: null` for unassign. Throw if `!result.data?.issueUpdate?.success`. Invalidate the issue's project cache the same way `updateIssueState` does (via `_issueProjectIndex` → `_cacheService.invalidateTaskCache('linear', 'project:<id>')`, fallback invalidate all Linear cache).
- **Implementation:** Copy `updateIssueState` (lines 1095–1127), swap the mutation + variable name + validation message. `assigneeId` may be `null` (unassign), so do **not** require it to be non-empty — only validate `issueId`.
- **Edge Cases:** `assigneeId: null` acceptance is an API-semantics uncertainty (see **Uncertain Assumptions**); fallback if `null` is rejected is to omit `assigneeId` from the `input` object entirely (Linear treats an absent field as "no change", so a dedicated clear may require a separate path — confirm during research).

### src/services/PlanningPanelProvider.ts

- **Context:** The webview message switch needs three new cases to load the member catalog and apply updates for both providers, mirroring the existing tags handlers.
- **Logic:** Add three cases (mirror `linearUpdateIssueLabels` at line 5100 and `clickupUpdateTaskTags` at line 5136 — same resolve → validate → `_adapterFactories.getXxxSyncService(workspaceRoot)` → call → post result/error shape):
  - `case 'loadTicketAssignees'`: resolve provider + id (+ `listId` for ClickUp, supplied by the client). For Linear call `linear.getTeamMembers()`. For ClickUp: if `listId` present, call `clickup.getListMembers(listId)`; else call `clickup.getTaskDetails(id)` to obtain `task.list.id`, then `getListMembers`. Post back `{ type: 'ticketAssigneesLoaded', provider, id, members, currentAssigneeIds }` where `currentAssigneeIds` is derived from the selected issue/task. On error post `{ type: 'ticketAssigneesError', error, ... }`.
  - `case 'linearUpdateIssueAssignee'`: validate `issueId` + `assigneeId` (string or null); call `linear.updateIssueAssignee(issueId, assigneeId)`; post `{ type: 'linearAssigneeUpdated', issueId, assigneeId, workspaceRoot }` (ids only — no member object) or `linearError`.
  - `case 'clickupUpdateTaskAssignees'`: validate `taskId` + `assigneeIds: string[]` (may be empty for unassign); call `clickup.updateTask(taskId, { assignees: assigneeIds.map(Number) })`; post `{ type: 'clickupAssigneesUpdated', taskId, assigneeIds, workspaceRoot }` (ids only) or `clickupError`.
- **Implementation:** Insert after the `clickupUpdateTaskTags` case (line 5172). Reuse the `_resolveWorkspaceRoot` + `_adapterFactories` helpers exactly as the tags handlers do.
- **Edge Cases:** Empty `assigneeIds` for ClickUp unassign — confirm `updateTask({ assignees: [] })` clears (see **Uncertain Assumptions**); if not, use the documented ClickUp remove-assignee path. `Object.keys(updates).length === 0` guard in `updateTask` (line 1434) is satisfied because `{ assignees: [] }` has one key.

### src/webview/planning.html

- **Context:** The meta bar needs an "Assign" button and the page needs a new modal mirroring `#tags-modal`.
- **Logic:**
  - Add an "Assign" button in `#tickets-preview-meta-bar` after the Status `.kanban-meta-group` (after line 3766) and before `tickets-tags` (line 3767): `<button id="btn-assign-ticket" class="strip-btn" title="Assign members">Assign</button>`.
  - Add a new modal `#assign-modal` mirroring `#tags-modal` (line 4060): title "Assign Members", a search `<input id="assign-search">`, a list container `<div id="assign-available-list">`, and Cancel/Save buttons (`btn-cancel-assign`, `btn-save-assign`). Reuse `.folder-modal` / `.modal-content` / `.strip-btn` / `.planning-button` classes so theming is inherited.
- **Implementation:** Insert the button into the meta bar and append the modal after `#tags-modal` (after line 4079).
- **Edge Cases:** Theme compatibility — reusing existing classes means `theme-claudify` and `cyber-theme-enabled` apply for free; no new CSS required.

### src/webview/planning.js

- **Context:** Frontend state, modal open/render/save logic, event wiring, and result handling for both providers.
- **Logic:**
  - Add state near the tags state (line 310–311): `let _assignModalOpen = false; let _assignMembersLoading = false; let _assignMembers = []; let _currentAssigneeIds = [];` (no parallel keyed cache — rely on service TTLs per Design Decision #2).
  - `openAssignModal()`: determine provider + ticket id from `selectedLinearIssue` / `selectedClickUpIssue`; compute current assignee id(s) — Linear: `selectedLinearIssue.issue.assignee?.id || null`; ClickUp: `(selectedClickUpIssue.task.assignees || []).map(a => a.id)`. For ClickUp, pass `listId = selectedClickUpIssue.task.list?.id || null` in the `loadTicketAssignees` message. If a thin same-selection guard permits, skip refetch; else send `loadTicketAssignees` and show loading state. Set `_assignModalOpen = true`; show modal.
  - `renderAssignModalList(filter)`: render "Nobody / Unassigned" entry first (sentinel `__unassigned__`), then members matching the search filter by name/email. For Linear use radio-like behavior (clicking one unchecks others + "Nobody"); for ClickUp use independent checkboxes. Pre-check current assignees (or "Nobody" if `_currentAssigneeIds` is empty/null).
  - `saveAssign()`: read selected ids. **Branch by provider for id coercion** (Design Decision #6 clarification): Linear — map `__unassigned__` → `null`, enforce `length <= 1`, ids stay strings; send `linearUpdateIssueAssignee`. ClickUp — `ids.map(Number)`, `__unassigned__` → `[]`; send `clickupUpdateTaskAssignees`. Close modal; clear `_assignModalOpen`.
  - Wire handlers (mirror tags wiring at lines 8606–8625): `btn-assign-ticket` click → `openAssignModal`; `btn-close-assign-modal` / `btn-cancel-assign` → close; `btn-save-assign` → `saveAssign`; backdrop click → close; `assign-search` input → `renderAssignModalList(value)`.
  - Handle results: `case 'ticketAssigneesLoaded'` → populate `_assignMembers`, render list, hide loading. `case 'linearAssigneeUpdated'` / `case 'clickupAssigneesUpdated'` → map the returned ids to member objects from `_assignMembers`, optimistically patch `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees`, re-render the list row + detail header, show a success status. `case 'ticketAssigneesError'` / error cases → `showTicketsStatus(msg.error, true)`.
  - *Clarification (disable note):* `#tickets-preview-meta-bar` is `display:none` until a ticket is selected (set to `flex` around lines 9458 / 9990), so the "Assign" button is implicitly gated. No separate disable logic is required; mirror how `tickets-tags` is shown alongside the meta bar.
- **Implementation:** Add the state vars near line 310; add the functions near the tags functions (around line 445–540); add the wiring near line 8606; add the result handlers in the message switch alongside the tags result handlers (around lines 5345–5355).
- **Edge Cases:** Empty member list → show an empty-state message; "Nobody" remains selectable. ClickUp `listId` missing → backend falls back to `getTaskDetails`; if that fails, surface `ticketAssigneesError` and disable Save.

## Uncertain Assumptions

The following API-behavior claims are not 100% confirmed against current provider docs and **must be verified via web research before implementation** (the user was advised to run the research prompt supplied at the end of the chat summary):

1. **ClickUp unassign via empty array.** Whether `PUT /task/{task_id}` with body `{"assignees": []}` removes all assignees (replace semantics) or is a no-op / additive (merge semantics) is unverified across ClickUp API versions. If empty-array does not clear, the documented ClickUp remove-assignee call must be used instead. This blocks the unassign path.
2. **Linear `assigneeId: null` clear.** Whether the Linear `issueUpdate` mutation's `IssueUpdateInput` types `assigneeId` as a nullable `String` and accepts `null` to unassign is asserted from docs but unverified against the current schema. Fallback if `null` is rejected: omit `assigneeId` from the input (Linear treats absent fields as "no change", so a dedicated clear path may be required — confirm during research).

All other claims (service method signatures, return shapes, message-handler patterns, modal markup structure, state-variable locations, cache TTLs) have been verified against the current source and are not uncertain.

## Verification Plan

### Automated Tests

Per the session directive, automated tests are **skipped** and project compilation is **skipped**. Verification is manual only. (The standard typecheck/build command is `npm run compile` per `CLAUDE.md`, but it is not run as part of this plan's verification.)

### Manual Verification

- **Linear happy path:** Select a Linear ticket → open Assign → pick a member → Save → confirm list row + detail header update → reopen → confirm the chosen member is pre-checked → choose "Nobody" → Save → confirm "Unassigned" renders.
- **ClickUp happy path:** Repeat for a ClickUp ticket — exercise multi-select (check 2 members) → Save → confirm both names render → reopen → confirm both pre-checked → choose "Nobody" → Save → confirm "Unassigned".
- **Linear cardinality enforcement:** In a Linear ticket, attempt to check two members — confirm radio-like behavior prevents it (or Save blocks with an inline error).
- **Error path:** Temporarily use an invalid/expired token → open Assign → Save → confirm the error surfaces in the status footer (`showTicketsStatus` / `linearError` / `clickupError`), not a crash.
- **ClickUp listId fallback:** Select a ClickUp ticket whose `task.list.id` is missing client-side → open Assign → confirm the backend falls back to `getTaskDetails` and the member list still loads.
- **Theme:** Toggle `theme-claudify` and `cyber-theme-enabled` → confirm the `#assign-modal` styling is consistent with `#tags-modal`.
- **Cache behavior:** Reopen the Assign modal for the same ticket without navigating away → confirm no redundant `loadTicketAssignees` round trip (thin same-selection guard) and the list is intact.

## Open Questions for Implementation

- Confirm ClickUp's behavior for clearing assignees via `updateTask({ assignees: [] })` vs. a dedicated remove call (verify against ClickUp API docs — see **Uncertain Assumptions**; resolve via web research before coding).
- Confirm Linear `issueUpdate` accepts `assigneeId: null` to clear (see **Uncertain Assumptions**; resolve via web research before coding).

## Acceptance Criteria

- [ ] "Assign" button appears in the ticket meta bar for both providers when a ticket is selected.
- [ ] Assign modal lists team/list members with search, pre-checks current assignees, and offers a "Nobody" option.
- [ ] Saving updates the assignee on the provider and reflects locally without a full reload.
- [ ] Unassignment works for both providers.
- [ ] Linear enforces single assignee; ClickUp allows multiple.
- [ ] Errors surface in the existing status/error channels; no uncaught exceptions.
- [ ] Modal respects both themes; typecheck/build passes (when run).
- [ ] No parallel frontend member cache — service-level TTL caches are the single caching tier.
- [ ] ClickUp `loadTicketAssignees` uses the client-supplied `listId` (falls back to `getTaskDetails` only when absent).
- [ ] `saveAssign` branches id coercion per provider (Linear string/null, ClickUp `Number`).

**Stage Complete:** PLAN REVIEWED
