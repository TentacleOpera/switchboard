# Add Assignee Control to Tickets Tab

## Goal

Add the ability to assign (and unassign) people to an issue from the **Tickets** tab in `planning.html`. Today the ticket detail meta bar exposes controls for Status (dropdown), Tags (modal), Comment, Attachments, Subtask, etc., but there is **no way to change who is assigned** — the assignee is read-only. The list view already renders "Unassigned" or the assignee name(s), and the data model already carries assignees (`task.assignees[]` for ClickUp, `issue.assignee` for Linear), so this is a wiring + UI feature, not a data-model change.

### Problem & Root Cause

- **Symptom:** A user viewing a ClickUp or Linear ticket in the Tickets tab cannot change the assignee without leaving Switchboard and opening the provider's web UI.
- **Root cause:** The meta bar (`#tickets-preview-meta-bar`) was built with a Status `<select>` and a Tags modal, but an assignee control was never added. The backend primitives needed to implement it already exist and are even used elsewhere in the same tab:
  - Member listing: `linear.getTeamMembers()` and `clickup.getListMembers(listId)` are already called by the comment-manager's @mention feature (`loadTicketComments` → `members`).
  - ClickUp updates: `clickup.updateTask(id, …)` is the existing task-update surface (line 1409), but its `assignees?: number[]` field is **dead code** — it is never called with `assignees` anywhere in the codebase (12 call sites use only `tags`, `parent`, `status`, `markdown_content`, `markdown_description`, `name`). Web research confirms a flat `assignees: number[]` array sent to `PUT /task/{id}` is **silently ignored** by ClickUp (returns 200, mutates `date_updated`, no assignee change). A dedicated delta-based method is required (see **Resolved API Assumptions**).
  - Linear updates: `linear.updateIssueState(issueId, stateId)` is the template for a new `updateIssueAssignee(issueId, assigneeId)` using the same `issueUpdate` GraphQL mutation with an `assigneeId` argument. `updateIssueLabels` (line 1129) and `updateIssueParent` (line 1161) follow the identical `issueUpdate(id, input: {...})` pattern, confirming the mutation shape is reusable for arbitrary `IssueUpdateInput` fields. Web research confirms `assigneeId: null` is accepted and unassigns the issue.
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
- Fixing the pre-existing latent bug in `LocalApiServer.ts` (line 843) where an external REST caller's flat `assignees` field is forwarded to `updateTask` and would silently fail. That is a separate, pre-existing condition not introduced by this plan; flagged here as an observation only.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, feature
**Project:** _(unassigned — no active project filter set)_

## User Review Required

No product-shaping decisions remain — scope is confirmed with the user (both providers, Tags-style modal, unassign supported). The two API-semantics uncertainties have been resolved via web research (see **Resolved API Assumptions**) and the ClickUp finding forced a design refinement (delta-object method) that is captured below; no UX change resulted. This may proceed to a Coder without further human sign-off.

## Complexity Audit

### Routine

- New Linear method `updateIssueAssignee` is a near-verbatim copy of `updateIssueState` (same `issueUpdate` mutation, same cache-invalidation tail) — single-file, pattern-mirrored. Research confirmed `assigneeId: null` unassigns cleanly.
- New `#assign-modal` markup is a structural clone of `#tags-modal` (`.folder-modal` / `.modal-content` / `.modal-header` / `.modal-body` / Cancel+Save footer) — reuses existing CSS classes, theming inherited for free.
- Three new `PlanningPanelProvider` message cases mirror the `linearUpdateIssueLabels` (line 5100) and `clickupUpdateTaskTags` (line 5136) handlers exactly: resolve workspace root → validate → call service via `_adapterFactories` → post result/error.
- Frontend modal open/save/close wiring mirrors the tags wiring at lines 8606–8625 — same event targets, same backdrop-close pattern.
- Optimistic UI patch mirrors the existing Tags/Status post-save refetch machinery.

### Complex / Risky

- **Provider assignee-cardinality split.** Linear is single-assignee (`LinearIssue.assignee: {id,name,email} | null`, line 59); ClickUp is multi-assignee (`ClickUpTask.assignees: Array<{id,username,email}>`, line 91). One modal must render radio-like behavior for Linear and independent checkboxes for ClickUp, plus a shared "Nobody" sentinel — moderate UX/state logic, well-scoped.
- **ClickUp delta-based assignee updates.** ClickUp's `PUT /task/{id}` does NOT accept a flat `assignees: number[]` array (silently ignored, confirmed by research). It requires a delta object `{assignees: {add: number[], rem: number[]}}`. A dedicated `updateTaskAssignees(taskId, addIds, remIds)` method is needed, and the "set assignee list to exactly X" intent must be translated into a delta (add = desired − current, rem = current − desired) computed from the client's known current assignees. This is moderate set-math logic with correctness edge cases (empty add, empty rem, full replace, unassign-all = rem all current).
- **Per-provider id coercion.** ClickUp member ids are strings (normalized at line 1671) but the delta `add`/`rem` arrays require integers; Linear ids stay strings. A single `saveAssign` must branch coercion by provider — easy to bug if lumped together.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two agents/users editing the same ticket's assignee simultaneously — last write wins, consistent with how Status/Tags already behave. No new conflict handling. The modal fetch → save window is short; a stale member list is bounded by the service TTL caches. Note: ClickUp delta is computed against the client's last-known current assignees; if another user changed assignees in between, the delta may over- or under-subtract — acceptable, matches existing last-write-wins behavior, and the post-save refetch reconciles.
- **Security:** The configured Linear/ClickUp token must have write access to assignees. If it lacks permission, the provider returns an error (ClickUp `403` with `ECODE` like `ACCESS_078`; Linear GraphQL `200` with an `errors[]` array and `FORBIDDEN` extension) — surface it via the existing `linearError` / `clickupError` channels; no special handling needed. No new secrets touched.
- **Side Effects:** On save, the in-memory `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees` is patched optimistically and the list row + detail header re-render. The existing ticket-refetch machinery keeps the canonical record in sync. Linear `updateIssueAssignee` invalidates the issue's project cache exactly like `updateIssueState`; the new ClickUp `updateTaskAssignees` invalidates the containing list's cache (mirror `updateTask`'s invalidation at lines 1448–1457). No on-disk ticket markdown format change (assignees already serialized by the existing import/sync path).
- **Dependencies & Conflicts:**
  - Depends on `LinearSyncService.getTeamMembers` (line 1503) and `ClickUpSyncService.getListMembers` (line 1653) — both already exist with TTL caches.
  - Depends on the Linear `issueUpdate` mutation accepting an `assigneeId` input field — pattern-confirmed via `stateId`/`labelIds`/`parentId` siblings AND research-confirmed (nullable `String`, `null` unassigns).
  - Depends on ClickUp `PUT /task/{id}` accepting the delta object `{assignees: {add, rem}}` — research-confirmed. The existing `updateTask` `assignees?: number[]` field is dead code and silently fails; NOT used by this plan.
  - No conflicts with other in-flight work — changes are additive (new button, new modal, new message cases, two new service methods).

## Dependencies

None — standalone feature. No prerequisite plans or prior sessions (`sess_…`) must complete first. All backend primitives already exist in the codebase (member fetch + task update surfaces); only the assignee-specific update method is new.

## Adversarial Synthesis

Key risks: (1) double caching — a frontend keyed-cache would shadow the existing service-level TTL caches (`MEMBERS_TTL_MS`, `LIST_MEMBERS_TTL_MS`) and create stale-data sandwiches; (2) a 2-HTTP-call tax to resolve a `listId` the webview already holds in `selectedClickUpIssue.task.list?.id`; (3) a type-coercion landmine where Linear string ids could be `Number()`'d to `NaN`; (4) **silent-fail unassign/assign on ClickUp** — the original flat-array `updateTask({assignees})` approach is confirmed by web research to return `200 OK` with NO assignee change, which would make the UI lie ("saved!" while nothing happened). Mitigations: rely on the single service-tier cache (no parallel frontend map), pass `listId` from the client, branch id coercion explicitly per provider in `saveAssign`, and use a **dedicated delta-based `updateTaskAssignees(taskId, addIds, remIds)` method** with `{assignees: {add, rem}}` payload (NOT the dead flat-array `updateTask` field), computing the delta from the client-known current assignees so no extra GET is needed for the common case.

## Background & Context

### Files involved

- `src/webview/planning.html` — meta bar markup (lines 3757–3774) and a new modal (mirror of `#tags-modal` at lines 4060–4079).
- `src/webview/planning.js` — modal open/save/close handlers, member-catalog fetch + cache, selected-ticket state (`selectedLinearIssue` line 242, `selectedClickUpIssue` line 256, `lastIntegrationProvider` line 151).
- `src/services/PlanningPanelProvider.ts` — webview message switch (add `loadTicketAssignees`, `linearUpdateIssueAssignee`, `clickupUpdateTaskAssignees` cases; mirror `linearUpdateIssueLabels` at line 5100 and `clickupUpdateTaskTags` at line 5136).
- `src/services/LinearSyncService.ts` — add `updateIssueAssignee(issueId, assigneeId | null)` mirroring `updateIssueState` (line 1095). `getTeamMembers()` already exists (line 1503, returns `{id,name,email}[]`, 5-min TTL cache).
- `src/services/ClickUpSyncService.ts` — add a **dedicated** `updateTaskAssignees(taskId, addIds: number[], remIds: number[])` method that sends `{assignees: {add, rem}}` to `PUT /task/{id}` (delta form, research-confirmed). `updateTask`'s existing `assignees?: number[]` field (line 1417) is dead code that silently fails and is NOT used by this plan. `getListMembers(listId)` exists (line 1653, returns `{id,username,email,name}[]` with string ids, per-`listId` TTL cache). `getTaskDetails(taskId)` exists (line 1223) as a fallback to resolve `listId` only when the client lacks it.
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
4. **"Nobody / Unassigned" option.** Rendered as a special entry at the top of the list (checkbox/radio with a sentinel value `__unassigned__`). On Save:
   - **Linear:** sentinel → `assigneeId: null` (research-confirmed: `null` unassigns the issue).
   - **ClickUp:** sentinel → desired set is empty `[]`; the backend computes `rem = currentAssigneeIds, add = []` and calls `updateTaskAssignees(taskId, [], currentIds.map(Number))` (delta form, research-confirmed). A flat `assignees: []` would silently no-op and is NOT used.
5. **Post-save refetch.** Mirror the Tags/Status flow: on success result, update the in-memory `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees` optimistically, re-render the list row + detail, and issue the existing ticket-refetch so the canonical record updates. Reuse the existing `pushTicketResult`/refetch machinery where possible.
   - *Clarification (id-only backend round-trip):* The backend handlers post back the **accepted ids only** (`assigneeId` / final `assigneeIds`), not member objects. The webview maps those ids → member objects from its own `_assignMembers` list for the optimistic UI patch. The backend must not re-fetch the member list to fabricate member objects.
6. **Direct service calls from PlanningPanelProvider** (not new VS Code commands), matching how `linearUpdateIssueLabels` and `clickupUpdateTaskTags` are wired. This avoids touching `extension.ts` and `TaskViewerProvider.ts` command registration. This is the committed path; the command-wrapper alternative is listed in **Files involved** for context only and is not implemented.
   - *Clarification (per-provider id coercion in `saveAssign`):* Branch explicitly by provider. **Linear:** ids stay strings; sentinel `__unassigned__` → `null`; enforce `length <= 1`. **ClickUp:** the client sends `currentAssigneeIds` + `desiredAssigneeIds` as strings; the backend computes the delta and `.map(Number)` for the `add`/`rem` arrays. Never `Number()` a Linear id (would yield `NaN` and a GraphQL rejection).
7. **ClickUp delta-based updates via a dedicated method (research-driven).** ClickUp's `PUT /task/{id}` does NOT accept a flat `assignees: number[]` array (silently ignored, confirmed by web research). Add a dedicated `ClickUpSyncService.updateTaskAssignees(taskId, addIds: number[], remIds: number[])` method that sends `{assignees: {add, rem}}`. Do NOT extend or use `updateTask`'s dead `assignees?: number[]` field. The backend computes the delta from `currentAssigneeIds` + `desiredAssigneeIds` (sent by the client, which already holds the current assignees in `selectedClickUpIssue.task.assignees`) so no extra GET round-trip is needed for the common case — `add = desired − current`, `rem = current − desired` (as integer arrays).

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
- ClickUp updates use the delta `{add, rem}` form via a dedicated method; the flat-array `updateTask({assignees})` path is NOT used (silently fails per research).

## Proposed Changes

### src/services/LinearSyncService.ts

- **Context:** A new public method is needed to update a Linear issue's assignee. The `issueUpdate` GraphQL mutation already accepts multiple input fields (`stateId`, `labelIds`, `parentId`); `assigneeId` is the field for assignment. Research confirmed `assigneeId` is a nullable `String` on `IssueUpdateInput` and `null` unassigns.
- **Logic:** Add `public async updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void>` mirroring `updateIssueState` (line 1095) and `updateIssueParent` (line 1161, which already demonstrates a nullable string input). GraphQL:
  ```graphql
  mutation($id: String!, $assigneeId: String) {
    issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
  }
  ```
  Pass `assigneeId: null` for unassign (confirmed working by research). Throw if `!result.data?.issueUpdate?.success`. Invalidate the issue's project cache the same way `updateIssueState` does (via `_issueProjectIndex` → `_cacheService.invalidateTaskCache('linear', 'project:<id>')`, fallback invalidate all Linear cache).
- **Implementation:** Copy `updateIssueState` (lines 1095–1127), swap the mutation + variable name + validation message. `assigneeId` may be `null` (unassign), so do **not** require it to be non-empty — only validate `issueId`.
- **Edge Cases:** None remaining — `assigneeId: null` acceptance is research-confirmed. Omitting `assigneeId` from the input is a no-op (Linear treats absent fields as "no change"), so always send the field explicitly (string id or `null`).

### src/services/ClickUpSyncService.ts

- **Context:** ClickUp's `PUT /task/{id}` does NOT accept a flat `assignees: number[]` array — it is silently ignored (research-confirmed). A delta object `{assignees: {add: number[], rem: number[]}}` is required. The existing `updateTask` method (line 1409) declares `assignees?: number[]` but is never called with it (dead code) and would silently fail; this plan does NOT use that field. A dedicated method is added instead.
- **Logic:** Add `public async updateTaskAssignees(taskId: string, addIds: number[], remIds: number[]): Promise<ClickUpTask | null>`:
  - Validate `taskId` non-empty; `addIds`/`remIds` are integer arrays (may be empty).
  - Build body `{ assignees: { add: addIds, rem: remIds } }`.
  - `PUT /task/{normalizedTaskId}` via `this.retry(() => this.httpRequest('PUT', '/task/${normalizedTaskId}', body))` (mirror `updateTask`'s HTTP + retry pattern, lines 1438–1446).
  - On non-200, throw with status + detail (mirror `updateTask`'s error formatting, lines 1441–1445).
  - Invalidate the containing list's cache (mirror `updateTask` lines 1448–1457: resolve `listId` via `_taskListIndex`, fallback invalidate all ClickUp cache).
  - Return `this._normalizeClickUpTask(updateResult.data)` (mirror `updateTask` line 1459).
- **Implementation:** Insert near `updateTask` (after line 1460). Reuse `loadConfig`, `retry`, `httpRequest`, `_normalizeClickUpTask`, `_cacheService`, `_taskListIndex`.
- **Edge Cases:** Empty `addIds` + empty `remIds` → the body still has one key (`assignees`), so ClickUp accepts the PUT (no-op assignee change, updates `date_updated`). If the caller sends both empty, the backend handler should short-circuit and skip the API call (nothing to do) — the `PlanningPanelProvider` case guards this. `rem` with an id not currently assigned — ClickUp tolerates per research (idempotent removal); no error. Deactivated user ids in `rem` can cause errors per research — mitigated by computing `rem` from the client's known-current assignees (not a cached workspace-wide list).

### src/services/PlanningPanelProvider.ts

- **Context:** The webview message switch needs three new cases to load the member catalog and apply updates for both providers, mirroring the existing tags handlers.
- **Logic:** Add three cases (mirror `linearUpdateIssueLabels` at line 5100 and `clickupUpdateTaskTags` at line 5136 — same resolve → validate → `_adapterFactories.getXxxSyncService(workspaceRoot)` → call → post result/error shape):
  - `case 'loadTicketAssignees'`: resolve provider + id (+ `listId` for ClickUp, supplied by the client). For Linear call `linear.getTeamMembers()`. For ClickUp: if `listId` present, call `clickup.getListMembers(listId)`; else call `clickup.getTaskDetails(id)` to obtain `task.list.id`, then `getListMembers`. Post back `{ type: 'ticketAssigneesLoaded', provider, id, members, currentAssigneeIds }` where `currentAssigneeIds` is derived from the selected issue/task. On error post `{ type: 'ticketAssigneesError', error, ... }`.
  - `case 'linearUpdateIssueAssignee'`: validate `issueId` + `assigneeId` (string or null); call `linear.updateIssueAssignee(issueId, assigneeId)`; post `{ type: 'linearAssigneeUpdated', issueId, assigneeId, workspaceRoot }` (ids only — no member object) or `linearError`.
  - `case 'clickupUpdateTaskAssignees'`: validate `taskId` + `currentAssigneeIds: string[]` + `desiredAssigneeIds: string[]` (all may be empty). Compute the delta: `addIds = desired.filter(id => !current.includes(id)).map(Number)`; `remIds = current.filter(id => !desired.includes(id)).map(Number)`. If both `addIds` and `remIds` are empty (no change), short-circuit and post `{ type: 'clickupAssigneesUpdated', taskId, assigneeIds: desired, workspaceRoot, noChange: true }`. Otherwise call `clickup.updateTaskAssignees(taskId, addIds, remIds)`; post `{ type: 'clickupAssigneesUpdated', taskId, assigneeIds: desired, workspaceRoot }` (the final desired id list, ids only) or `clickupError`.
- **Implementation:** Insert after the `clickupUpdateTaskTags` case (line 5172). Reuse the `_resolveWorkspaceRoot` + `_adapterFactories` helpers exactly as the tags handlers do.
- **Edge Cases:** Empty `desiredAssigneeIds` for ClickUp unassign-all → `addIds = []`, `remIds = current.map(Number)`; the dedicated method sends `{assignees: {add: [], rem: [...]}}` (research-confirmed clear path). Deactivated user in `rem` — research warns this can error; mitigated by computing `rem` from the client's known-current ids (which came from a live task fetch, not a stale workspace cache).

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
  - `openAssignModal()`: determine provider + ticket id from `selectedLinearIssue` / `selectedClickUpIssue`; compute current assignee id(s) — Linear: `selectedLinearIssue.issue.assignee?.id || null`; ClickUp: `(selectedClickUpIssue.task.assignees || []).map(a => String(a.id))`. For ClickUp, pass `listId = selectedClickUpIssue.task.list?.id || null` in the `loadTicketAssignees` message. If a thin same-selection guard permits, skip refetch; else send `loadTicketAssignees` and show loading state. Set `_assignModalOpen = true`; show modal.
  - `renderAssignModalList(filter)`: render "Nobody / Unassigned" entry first (sentinel `__unassigned__`), then members matching the search filter by name/email. For Linear use radio-like behavior (clicking one unchecks others + "Nobody"); for ClickUp use independent checkboxes. Pre-check current assignees (or "Nobody" if `_currentAssigneeIds` is empty/null).
  - `saveAssign()`: read selected ids. **Branch by provider** (Design Decision #6):
    - **Linear:** map `__unassigned__` → `null`, enforce `length <= 1`, ids stay strings; send `linearUpdateIssueAssignee`.
    - **ClickUp:** collect desired ids (strings; `__unassigned__` → `[]`); send `clickupUpdateTaskAssignees` with `currentAssigneeIds = _currentAssigneeIds` (strings) + `desiredAssigneeIds` (strings). The backend computes the delta + `.map(Number)`. Do NOT `Number()` ids client-side for ClickUp — keep them as strings over the wire to preserve precision; the backend coerces.
    Close modal; clear `_assignModalOpen`.
  - Wire handlers (mirror tags wiring at lines 8606–8625): `btn-assign-ticket` click → `openAssignModal`; `btn-close-assign-modal` / `btn-cancel-assign` → close; `btn-save-assign` → `saveAssign`; backdrop click → close; `assign-search` input → `renderAssignModalList(value)`.
  - Handle results: `case 'ticketAssigneesLoaded'` → populate `_assignMembers`, render list, hide loading. `case 'linearAssigneeUpdated'` / `case 'clickupAssigneesUpdated'` → map the returned ids (`assigneeId` / `assigneeIds`) to member objects from `_assignMembers`, optimistically patch `selectedLinearIssue.issue.assignee` / `selectedClickUpIssue.task.assignees`, re-render the list row + detail header, show a success status. `case 'ticketAssigneesError'` / error cases → `showTicketsStatus(msg.error, true)`.
  - *Clarification (disable note):* `#tickets-preview-meta-bar` is `display:none` until a ticket is selected (set to `flex` around lines 9458 / 9990), so the "Assign" button is implicitly gated. No separate disable logic is required; mirror how `tickets-tags` is shown alongside the meta bar.
- **Implementation:** Add the state vars near line 310; add the functions near the tags functions (around line 445–540); add the wiring near line 8606; add the result handlers in the message switch alongside the tags result handlers (around lines 5345–5355).
- **Edge Cases:** Empty member list → show an empty-state message; "Nobody" remains selectable. ClickUp `listId` missing → backend falls back to `getTaskDetails`; if that fails, surface `ticketAssigneesError` and disable Save. Post-save, if the ClickUp delta was a no-op (`noChange: true`), still close the modal and re-render (the desired set already equals current).

## Resolved API Assumptions (via Web Research)

The following API-behavior questions were flagged as uncertain during planning and have since been resolved via web research (findings fed back by the user). Both verdicts are reflected in the design above:

1. **ClickUp unassign via flat array — CONFIRMED FAILS.** `PUT /api/v2/task/{task_id}` with `{"assignees": []}` (or any flat `number[]`) is silently ignored by ClickUp: it returns `200 OK`, bumps `date_updated`, and makes NO assignee change. ClickUp requires a delta object `{"assignees": {"add": [ids], "rem": [ids]}}` (integers). Unassign-all requires `rem` to contain every currently-assigned user id. **Plan impact:** a dedicated `updateTaskAssignees(taskId, addIds, remIds)` method is added; the dead `updateTask({assignees})` flat-array field is NOT used; the backend computes the delta from client-supplied current+desired ids so no extra GET is needed.
2. **Linear `assigneeId: null` clear — CONFIRMED WORKS.** The Linear `issueUpdate` mutation's `IssueUpdateInput` types `assigneeId` as a nullable `String`; sending `null` severs the assignment and unassigns the issue. Omitting the field is a no-op (no change), so the field must always be sent explicitly. **Plan impact:** the Linear path proceeds as originally designed — `updateIssueAssignee(issueId, null)` for unassign.

All other claims (service method signatures, return shapes, message-handler patterns, modal markup structure, state-variable locations, cache TTLs, `getTeamMembers`/`getListMembers` response shapes) have been verified against the current source and are not uncertain.

> **Research quality note:** the supplied research report's glossary contained several irrelevant entries (CFL condition, Manufactured Solutions, Exception Hooking — numerical-PDE terms unrelated to ClickUp/Linear APIs). Those were disregarded; the two API findings that this plan depends on are internally consistent, mutually corroborated across the report's Required + Recommended source tiers, and consistent with the codebase's observed dead-code state of `updateTask({assignees})`.

## Verification Plan

### Automated Tests

Per the session directive, automated tests are **skipped** and project compilation is **skipped**. Verification is manual only. (The standard typecheck/build command is `npm run compile` per `CLAUDE.md`, but it is not run as part of this plan's verification.)

### Manual Verification

- **Linear happy path:** Select a Linear ticket → open Assign → pick a member → Save → confirm list row + detail header update → reopen → confirm the chosen member is pre-checked → choose "Nobody" → Save → confirm "Unassigned" renders (research confirms `null` unassigns).
- **ClickUp happy path:** Repeat for a ClickUp ticket — exercise multi-select (check 2 members) → Save → confirm both names render → reopen → confirm both pre-checked → choose "Nobody" → Save → confirm "Unassigned" (delta `rem` path; research confirms flat-array would silently fail, so this is the critical regression check).
- **ClickUp silent-fail guard:** After a ClickUp assign/unassign Save, perform a fresh ticket refetch (or reopen the ticket) and confirm the assignee change actually persisted on the ClickUp side — this catches any regression where the flat-array path is accidentally reintroduced (the symptom would be a 200 response + UI "saved" but the assignee unchanged server-side).
- **Linear cardinality enforcement:** In a Linear ticket, attempt to check two members — confirm radio-like behavior prevents it (or Save blocks with an inline error).
- **ClickUp delta no-op:** Open Assign on a ClickUp ticket, change nothing, click Save — confirm the modal closes cleanly with no spurious API call (backend short-circuits when `add` and `rem` are both empty).
- **Error path:** Temporarily use an invalid/expired token → open Assign → Save → confirm the error surfaces in the status footer (`showTicketsStatus` / `linearError` / `clickupError`), not a crash. ClickUp permission errors return `403` + `ECODE`; Linear returns a GraphQL `errors[]` array with `FORBIDDEN` — both must surface via the existing channels.
- **ClickUp listId fallback:** Select a ClickUp ticket whose `task.list.id` is missing client-side → open Assign → confirm the backend falls back to `getTaskDetails` and the member list still loads.
- **Theme:** Toggle `theme-claudify` and `cyber-theme-enabled` → confirm the `#assign-modal` styling is consistent with `#tags-modal`.
- **Cache behavior:** Reopen the Assign modal for the same ticket without navigating away → confirm no redundant `loadTicketAssignees` round trip (thin same-selection guard) and the list is intact.

## Open Questions for Implementation

Both original API-semantics questions are resolved via web research (see **Resolved API Assumptions**). No open questions remain. Implementation may proceed using the delta-based ClickUp method and the `null`-based Linear unassign as specified.

## Acceptance Criteria

- [ ] "Assign" button appears in the ticket meta bar for both providers when a ticket is selected.
- [ ] Assign modal lists team/list members with search, pre-checks current assignees, and offers a "Nobody" option.
- [ ] Saving updates the assignee on the provider and reflects locally without a full reload.
- [ ] Unassignment works for both providers (Linear via `assigneeId: null`; ClickUp via delta `rem` of all current ids).
- [ ] Linear enforces single assignee; ClickUp allows multiple.
- [ ] Errors surface in the existing status/error channels; no uncaught exceptions.
- [ ] Modal respects both themes; typecheck/build passes (when run).
- [ ] No parallel frontend member cache — service-level TTL caches are the single caching tier.
- [ ] ClickUp `loadTicketAssignees` uses the client-supplied `listId` (falls back to `getTaskDetails` only when absent).
- [ ] ClickUp updates use the dedicated `updateTaskAssignees(taskId, addIds, remIds)` method with `{assignees: {add, rem}}` delta payload; the flat-array `updateTask({assignees})` path is NOT used (silently fails per research).
- [ ] ClickUp delta is computed server-side from client-supplied `currentAssigneeIds` + `desiredAssigneeIds` (no extra GET for the common case).
- [ ] `saveAssign` branches id coercion per provider (Linear string/null, ClickUp ids stay strings over the wire; backend `.map(Number)`).
- [ ] ClickUp no-change case (empty `add` + empty `rem`) short-circuits without an API call.

## Review Findings

Reviewed against commit `c09cba8`. **Fixed (MAJOR):** `saveAssign` in `src/webview/planning.js` could silently unassign a ticket when Save was clicked before the member list rendered (still loading, or after a load error) — an empty selection fell into the unassign branch; added a guard that blocks Save until the real list (incl. the "Nobody" row) exists. Service (`updateTaskAssignees` delta form), provider handlers (3 cases), modal markup, Linear single-assignee enforcement, and per-provider id coercion all match the plan. Validation: `node --check src/webview/planning.js` passes; compilation/tests skipped per session directive; live-API assignee round-trip not exercised. **Remaining risks:** last-write-wins on the ClickUp delta if another actor edits assignees mid-modal (accepted, matches Status/Tags); a task-scoped assignee error can surface the shared "comments/attachments" message text when a local copy exists (pre-existing, inherited from the tags flow).

**Stage Complete:** PLAN REVIEWED
