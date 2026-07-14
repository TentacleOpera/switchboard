# Create Ticket Modal: Add Status, Priority & Assignees Metadata

## Goal

In the Planning panel's **Tickets** tab, the "Create New Ticket" modal (which is also reused as the "Create Subtask" modal via the `+ Subtask` button) currently only collects a **Title** and **Description**. There is no way to set **status**, **priority**, or **assignees** at creation time. Users must create the ticket with defaults and then edit each field afterward — a multi-step workaround for metadata that both ClickUp and Linear already accept on their create endpoints.

### Problem Analysis & Root Cause

- **Symptom**: The modal at `#create-ticket-modal` exposes only `#create-ticket-title` and `#create-ticket-description`. The submit handler (`btn-submit-create-ticket` in `planning.js`) posts `clickupCreateTask` / `linearCreateIssue` with `title`, `description`, `listId`/`projectName`, and `parentId` (for subtasks) — nothing else.
- **Root cause (webview)**: The modal HTML (`planning.html` ~L4116–4137) and the submit handler (`planning.js` ~L9676–9709) were never extended to collect or send status/priority/assignees. The same modal is shared for subtask creation (`btn-add-subtask` handler ~L9712 sets `_subtaskParent` and reopens this modal), so the gap affects both flows identically.
- **Backend is partially ready**:
  - `ClickUpSyncService.createTask` (`ClickUpSyncService.ts` L1357) **already accepts** `status`, `priority` (number), and `assignees` (number[]) and writes them into the POST body (L1386–1389). The `PlanningPanelProvider` `clickupCreateTask` case (L6993) simply never forwards `msg.status/priority/assignees` to it.
  - `LinearSyncService.createIssueSimple` (`LinearSyncService.ts` L2355) accepts `stateId` (status) but **not** `priority` or `assigneeId`. Linear's `issueCreate` mutation input supports `priority` (0–4) and `assigneeId`, so the service can be extended. (Confirmed: existing `updateIssuePriority` L1166 validates 0–4 and `updateIssueAssignee` L1133 sends `assigneeId` via `issueUpdate` — the same `IssueCreateInput` fields are accepted on create.)
- **Reusable data sources already exist** in the webview for the same metadata on *existing* tickets:
  - Statuses: `availableLinearStates` / `availableClickUpStatuses` (populated via `linearStatesLoaded` / `clickupListStatusesLoaded` messages); `showTicketStatusModal` (L1244) shows how to build the option list with a derive-from-issues fallback.
  - Priorities: `_availableClickUpPriorities()` (L754) and the Linear fixed list in `openPriorityPopover` (L788–795) — value 0–4 with `0=No priority, 1=Urgent, 2=High, 3=Normal, 4=Low`. Both providers share the SAME 0–4 scale.
  - Members/assignees: `loadTicketAssignees` message → `ticketAssigneesLoaded` populates `_assignMembers`; the assign modal (`openAssignModal` L491, `renderAssignModalList` L545) renders the searchable checkbox (ClickUp, multi) / radio (Linear, single) list.

The fix is to surface these three existing capabilities inside the create modal and thread the values through the two create message handlers and the Linear service.

## Metadata

- **Tags:** frontend, backend, api, ui, ux, feature
- **Complexity:** 5

> **Superseded:** Tags: `tickets, planning-webview, clickup, linear, ux`; Complexity: 4
> **Reason:** The original tags are not in the allowed tag list (`frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library`). The original complexity 4 understated the work: the change touches 4 files and introduces a new backend→webview message round-trip (`loadTicketMembers` / `ticketMembersLoaded` / `ticketMembersError`), which is multi-file coordination with moderate logic — the 5–6 "Mixed" band.
> **Replaced with:** Tags: `frontend, backend, api, ui, ux, feature`; Complexity: 5

- **Files touched:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/LinearSyncService.ts`

## User Review Required

Yes. This plan adds a new webview↔extension message type (`loadTicketMembers` / `ticketMembersLoaded` / `ticketMembersError`) and extends the Linear create mutation input. A coder should confirm the Linear `issueCreate` input accepts `priority` and `assigneeId` against the team's configured Linear workspace before implementation (the existing `updateIssuePriority`/`updateIssueAssignee` paths strongly imply it does). No schema/DB migration, no kanban changes, no new dependencies.

## Complexity Audit

### Routine

- Adding three static form controls (two `<select>`s + one radio/checkbox container) to an existing modal — mirrors the styling of neighboring rows in `#create-ticket-modal` (`planning.html` L4122–4134).
- Populating the Status and Priority dropdowns from already-loaded webview state (`availableLinearStates`, `availableClickUpStatuses`, `_availableClickUpPriorities()`, fixed Linear 0–4 list) with a derive-from-issues fallback — same logic as `showTicketStatusModal` (L1244) and `openPriorityPopover` (L781).
- Forwarding three optional fields (`status`, `priority`, `assignees`/`assigneeId`) through the two existing create message handlers (`clickupCreateTask` L6993, `linearCreateIssue` L7064) — pure additive spreading, no control-flow change.
- Extending `LinearSyncService.createIssueSimple` (L2355) with two optional input fields, reusing the exact validation already proven by `updateIssuePriority` (0–4 guard, L1177) and `updateIssueAssignee` (L1133).
- Resetting the three new fields on open / success / cancel / close — extends the existing title/description reset calls already present in the `tickets-create` (L9576), `btn-add-subtask` (L9712), `btn-close`/`btn-cancel` (L9595–9608), and `clickupTaskCreated`/`linearIssueCreated` handlers.

### Complex / Risky

- **New backend message round-trip** (`loadTicketMembers` → `ticketMembersLoaded` / `ticketMembersError`): the create modal has no ticket id yet, so the existing ticket-scoped `loadTicketAssignees` handler (L5437, which requires `id` and calls `getTaskDetails(id)`) cannot be reused. A dedicated members-by-list/project load is required. This is a new message contract that must be wired on BOTH the extension side (new `case`) and the webview side (new `case 'ticketMembersLoaded'`).
- **Provider-specific value semantics**: ClickUp status value = status **name** string; Linear status value = **state id**. ClickUp assignees = `number[]` (multi); Linear assignee = single `string` id (UUID). The submit + backend forwarding must branch per provider and convert ClickUp member ids (strings from `getListMembers`) to numbers.
- **ClickUp `priority: 0` silent drop**: `createTask` guards `if (priority) body.priority = priority;` (L1389) — `0` is falsy and is NOT written. Explicitly selecting "No priority" (value 0) for ClickUp is therefore a no-op indistinguishable from "Default". Semantically harmless (both yield no priority set), but the coder should be aware. *Clarification, not a new requirement.*
- **Shared mutable state**: `_assignMembers` / `_assignMembersLoading` are shared between the create modal and the existing assign modal. Sequential modal use makes this safe in practice; flagged as a smell, not a blocker.

## Edge-Case & Dependency Audit

- **Race Conditions**: The create modal and the existing assign modal share `_assignMembers` / `_assignMembersLoading`. If a members load for one modal is in flight when the other opens, the second load overwrites the first's state. In practice the two modals are mutually exclusive (opening one hides the other), so this is a smell rather than a live race. The new `ticketMembersLoaded` webview handler must clear `_assignMembersLoading` and call `_renderCreateModalAssignees()`; it must NOT depend on the existing `ticketAssigneesLoaded` handler (see Dependencies & Conflicts).
- **Security**: No new credentials, no new network surfaces. Member lists are fetched via the existing authenticated `getListMembers` (ClickUp L1747) / `getTeamMembers` (Linear L1577) service methods. Assignee ids are passed through unchanged; ClickUp ids are coerced with `Number()` + `isNaN` filter (safe given ClickUp's numeric user ids).
- **Side Effects**: Creating a ticket with metadata triggers the existing remote-create + local-import flow (`switchboard.importTaskAsDocument`) unchanged. The only new side effect is the members fetch on modal open (one extra API call per open when `_assignMembers` is empty).
- **Dependencies & Conflicts**:
  - **Shared modal for ticket vs subtask**: Both the "Create New Ticket" open path (`tickets-create` L9576) and the `+ Subtask` path (`btn-add-subtask` L9712) must populate and reset the new fields. The subtask path sets `_subtaskParent`; the new-ticket path does not. Both must clear the fields on open and on successful create.
  - **ClickUp subtask list resolution**: `createTask` requires a `listId`. For subtasks the backend already resolves the parent's list (`getTaskListId`, L7008). Members for ClickUp are list-scoped, so the webview must load members using the parent's (or selected list's) `list.id` — available from `selectedClickUpIssue?.task?.list?.id` or `clickUpSelectedListId`.
  - **Linear assignee is single**: Linear supports one assignee (`assigneeId`); ClickUp supports many (`assignees: number[]`). The UI must render radio vs checkbox per provider, mirroring `renderAssignModalList` (L545).
  - **Status option value semantics differ by provider**: ClickUp `changeTicketStatus` uses the status **name** as the value; Linear uses the **state id**. The create path must match: ClickUp `createTask` `status` accepts a status name string; Linear `createIssueSimple` `stateId` accepts a state id. Reuse the exact option-building logic from `showTicketStatusModal` (L1272–1297).
  - **Empty/optional metadata**: All three fields are optional. "No selection" must map to `undefined` (omitted from the message), not `0`/`null`, so provider defaults apply. For priority, value `0` means "No priority" and should be sent as `0` only if explicitly chosen; default to omitted. (Note: ClickUp `createTask` silently drops `priority: 0` due to its truthy guard — see Complexity Audit.)
  - **Members not yet loaded when modal opens**: If `_assignMembers` is empty, trigger a `loadTicketMembers` load on modal open. `loadTicketAssignees` cannot be reused because it requires a ticket `id`. **Decision: add a `loadTicketMembers` message** (provider + listId/projectName, no ticket id).
  - **Linear `createIssueSimple` extension**: Add optional `priority?: number` and `assigneeId?: string` to the params and `IssueCreateInput`. Validate priority is 0–4 (Linear rejects out-of-range; mirror `updateIssuePriority` L1177). `assigneeId` null/empty → omit.
  - **Reset on cancel/close**: The close (`btn-close-create-ticket-modal` L9595) and cancel (`btn-cancel-create-ticket` L9602) handlers must also reset the three new fields, not just hide the modal.

## Dependencies

- None. Single self-contained plan; no prerequisite sessions.

## Adversarial Synthesis

Key risks: (1) the webview must add a dedicated `ticketMembersLoaded` case — the plan originally mis-wired the members response into the existing `ticketAssigneesLoaded` handler, which would never fire for the new `loadTicketMembers` round-trip and leave the create modal stuck on "Loading members…"; (2) provider-specific value semantics (ClickUp status-name vs Linear state-id; ClickUp `number[]` vs Linear single UUID) require per-provider branching in both submit and backend forwarding; (3) ClickUp `createTask` silently drops `priority: 0` via its truthy guard. Mitigations: add the `ticketMembersLoaded` webview case explicitly; reuse the exact option-building / render patterns from `showTicketStatusModal` and `renderAssignModalList`; document the ClickUp priority-0 no-op (optionally loosen the service guard to `priority != null`).

## Proposed Changes

### 1. `src/webview/planning.html` — add three controls to `#create-ticket-modal`

Insert Status, Priority, and Assignees rows between the Description block (L4130) and the footer buttons (L4131). Mirror the styling of existing modal rows.

```html
<!-- after the description block, before the footer button row -->
<div style="display: flex; flex-direction: column; gap: 4px;">
    <label for="create-ticket-status" style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); text-align: left;">Status</label>
    <select id="create-ticket-status" class="planning-input" style="width: 100%; box-sizing: border-box;">
        <option value="">Default</option>
    </select>
</div>
<div style="display: flex; flex-direction: column; gap: 4px;">
    <label for="create-ticket-priority" style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); text-align: left;">Priority</label>
    <select id="create-ticket-priority" class="planning-input" style="width: 100%; box-sizing: border-box;">
        <option value="">Default</option>
    </select>
</div>
<div style="display: flex; flex-direction: column; gap: 4px;">
    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); text-align: left;">Assignees</label>
    <div id="create-ticket-assignees" style="border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 6px; max-height: 140px; overflow-y: auto;">
        <div style="font-size: 12px; color: var(--text-secondary);">Loading members…</div>
    </div>
</div>
```

### 2. `src/webview/planning.js` — populate, submit, reset

**a) New helpers (place near `showTicketStatusModal` / `openAssignModal`, ~L490–650):**

```js
function _populateCreateModalStatus() {
    const select = document.getElementById('create-ticket-status');
    if (!select) return;
    const provider = lastIntegrationProvider;
    let options = [];
    if (provider === 'linear') {
        options = (availableLinearStates && availableLinearStates.length)
            ? availableLinearStates.map(s => ({ id: s.id, name: s.name }))
            : linearProjectIssues.reduce((m, i) => { if (i.state?.id && i.state?.name) m.set(i.state.name, i.state.id); return m; }, new Map());
        options = Array.isArray(options) ? options : Array.from(options.entries()).map(([name, id]) => ({ id, name }));
    } else {
        options = (availableClickUpStatuses && availableClickUpStatuses.length)
            ? availableClickUpStatuses.map(s => ({ id: s.status || s.name || s.id, name: s.status || s.name || s.id }))
            : Array.from(new Set(clickUpProjectIssues.map(t => t.status).filter(Boolean))).map(n => ({ id: n, name: n }));
    }
    select.innerHTML = '<option value="">Default</option>' +
        options.map(o => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}</option>`).join('');
}

function _populateCreateModalPriority() {
    const select = document.getElementById('create-ticket-priority');
    if (!select) return;
    const provider = lastIntegrationProvider;
    const opts = provider === 'linear'
        ? [{ value: 0, name: 'No priority' }, { value: 1, name: 'Urgent' }, { value: 2, name: 'High' }, { value: 3, name: 'Normal' }, { value: 4, name: 'Low' }]
        : _availableClickUpPriorities();
    select.innerHTML = '<option value="">Default</option>' +
        opts.map(o => `<option value="${o.value}">${escapeHtml(o.name)}</option>`).join('');
}

function _renderCreateModalAssignees() {
    const container = document.getElementById('create-ticket-assignees');
    if (!container) return;
    const provider = lastIntegrationProvider;
    if (_assignMembersLoading) {
        container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">Loading members…</div>';
        return;
    }
    if (!_assignMembers || _assignMembers.length === 0) {
        container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">No members available.</div>';
        return;
    }
    const inputType = provider === 'linear' ? 'radio' : 'checkbox';
    container.innerHTML = _assignMembers.map(m =>
        `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
            <input type="${inputType}" name="create-ticket-assignee" value="${escapeAttr(String(m.id))}" id="cta-${escapeAttr(String(m.id))}" />
            <label for="cta-${escapeAttr(String(m.id))}" style="font-size:12px;cursor:pointer;color:var(--text-primary);">${escapeHtml(m.name + (m.email ? ` (${m.email})` : ''))}</label>
        </div>`).join('');
}

function _loadCreateModalMembers() {
    const provider = lastIntegrationProvider;
    const container = document.getElementById('create-ticket-assignees');
    if (container) container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">Loading members…</div>';
    _assignMembersLoading = true;
    _assignMembers = [];
    // Brand-new ticket has no id; use the dedicated members-by-list/project load.
    vscode.postMessage({
        type: 'loadTicketMembers',
        provider,
        listId: clickUpSelectedListId || selectedClickUpIssue?.task?.list?.id || undefined,
        projectName: linearProjectPickerValue || undefined,
        workspaceRoot: ticketsWorkspaceRoot
    });
}

function _resetCreateModalMetadata() {
    const s = document.getElementById('create-ticket-status'); if (s) s.value = '';
    const p = document.getElementById('create-ticket-priority'); if (p) p.value = '';
    const a = document.getElementById('create-ticket-assignees');
    if (a) a.querySelectorAll('input').forEach(i => i.checked = false);
}

function _collectCreateModalAssignees() {
    const provider = lastIntegrationProvider;
    const container = document.getElementById('create-ticket-assignees');
    if (!container) return undefined;
    const checked = Array.from(container.querySelectorAll('input[name="create-ticket-assignee"]:checked')).map(i => i.value);
    if (checked.length === 0) return undefined;
    return provider === 'linear' ? checked[0] : checked; // Linear: single id string; ClickUp: string[]
}
```

**b) Populate on open.** In the `btn-add-subtask` handler (~L9722, after `modal.style.display = 'block'`) AND in the "Create New Ticket" open path (`tickets-create` handler ~L9582, after `modal.style.display = 'block'`). After showing the modal:

```js
_populateCreateModalStatus();
_populateCreateModalPriority();
_loadCreateModalMembers();
```

**c) Handle the members response — add a DEDICATED `ticketMembersLoaded` webview case.**

> **Superseded:** "The existing `ticketAssigneesLoaded` handler (~L6114) sets `_assignMembers` ... Add a call to `_renderCreateModalAssignees()` there so the create modal updates when its load completes."
> **Reason:** The new `loadTicketMembers` backend case (section 3c) posts `ticketMembersLoaded`, NOT `ticketAssigneesLoaded`. The existing `ticketAssigneesLoaded` handler (L6113) never fires for the create-modal members load, so the create modal would remain stuck on "Loading members…". This was the top finding of the adversarial review.
> **Replaced with:** Add a new `case 'ticketMembersLoaded':` in the webview message switch (near `ticketAssigneesLoaded` ~L6113) that sets `_assignMembers = msg.members || []`, clears `_assignMembersLoading = false`, and calls `_renderCreateModalAssignees()`. Also add `case 'ticketMembersError':` that clears `_assignMembersLoading`, shows "No members available." in the create modal container, and optionally surfaces `msg.error` via `showTicketsStatus`. Reuse the same `_assignMembers` state variable.

```js
case 'ticketMembersLoaded':
    _assignMembers = msg.members || [];
    _assignMembersLoading = false;
    _renderCreateModalAssignees();
    break;
case 'ticketMembersError':
    _assignMembersLoading = false;
    {
        const c = document.getElementById('create-ticket-assignees');
        if (c) c.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">No members available.</div>';
        if (msg.error) showTicketsStatus(msg.error, true);
    }
    break;
```

(The existing `ticketAssigneesLoaded` handler at L6113 is left unchanged — it continues to serve the assign modal for existing tickets.)

**d) Submit.** In the `btn-submit-create-ticket` handler (~L9700), extend the posted message:

```js
const statusSelect = document.getElementById('create-ticket-status');
const prioritySelect = document.getElementById('create-ticket-priority');
const status = statusSelect ? statusSelect.value.trim() : '';
const priorityVal = prioritySelect ? prioritySelect.value.trim() : '';
const assignees = _collectCreateModalAssignees();

vscode.postMessage({
    type: lastIntegrationProvider === 'clickup' ? 'clickupCreateTask' : 'linearCreateIssue',
    workspaceRoot: ticketsWorkspaceRoot || undefined,
    title,
    description: description || undefined,
    listId: clickUpSelectedListId || undefined,
    projectName: linearProjectPickerValue || undefined,
    ...(status ? { status } : {}),
    ...(priorityVal !== '' ? { priority: Number(priorityVal) } : {}),
    ...(assignees ? (lastIntegrationProvider === 'clickup' ? { assignees } : { assigneeId: assignees }) : {}),
    ...(_subtaskParent ? { parentId: _subtaskParent.id } : {})
});
```

**e) Reset on success and on close/cancel.** In `clickupTaskCreated` (~L6604) and `linearIssueCreated` (~L6632) success branches, add `_resetCreateModalMetadata();`. In the close (`btn-close-create-ticket-modal` L9595) and cancel (`btn-cancel-create-ticket` L9602) handlers, add `_resetCreateModalMetadata();`.

### 3. `src/services/PlanningPanelProvider.ts` — forward metadata + add `loadTicketMembers`

**a) `clickupCreateTask` case (~L7011):** forward the new optional fields into `createTask`:

```ts
const task = await clickUp.createTask({
    name: msg.title,
    listId,
    description: msg.description,
    ...(msg.parentId ? { parent: msg.parentId } : {}),
    ...(msg.status ? { status: String(msg.status) } : {}),
    ...(typeof msg.priority === 'number' && !isNaN(msg.priority) ? { priority: msg.priority } : {}),
    ...(Array.isArray(msg.assignees) ? { assignees: msg.assignees.map(Number).filter((n: number) => !isNaN(n)) } : {})
});
```

*Note:* ClickUp `createTask` writes priority via `if (priority) body.priority = priority;` (L1389), so `priority: 0` ("No priority") is silently dropped — harmless (outcome = unset). If explicit-zero support is desired later, loosen that guard to `priority != null`. Out of scope for this plan.

*Note:* `msg.assignees.map(Number)` is safe because ClickUp user ids returned by `getListMembers` (L1747) are numeric strings. Non-numeric ids would be filtered out silently — acceptable given the current ClickUp id contract.

**b) `linearCreateIssue` case (~L7087):** forward `stateId` (from `msg.status`, which is a Linear state id), `priority`, and `assigneeId`:

```ts
const result = await linear.createIssueSimple({
    title: msg.title,
    description: msg.description,
    projectId,
    ...(msg.parentId ? { parentId: msg.parentId } : {}),
    ...(msg.status ? { stateId: String(msg.status) } : {}),
    ...(typeof msg.priority === 'number' && !isNaN(msg.priority) ? { priority: msg.priority } : {}),
    ...(msg.assigneeId ? { assigneeId: String(msg.assigneeId) } : {})
});
```

**c) New `loadTicketMembers` case** (place near `loadTicketAssignees`, ~L5437): resolves members by `listId` (ClickUp) or team (Linear) without requiring a ticket id:

```ts
case 'loadTicketMembers': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    let listId = msg.listId ? String(msg.listId).trim() : '';
    if (!workspaceRoot || !provider) {
        this.postMessageToWebview({ type: 'ticketMembersError', provider, error: 'Invalid request.', workspaceRoot });
        break;
    }
    try {
        let members: any[] = [];
        if (provider === 'linear') {
            const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
            members = await linear.getTeamMembers();
        } else if (provider === 'clickup') {
            const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
            if (listId) {
                members = await clickup.getListMembers(listId);
            } else {
                // No list selected yet — return empty; webview shows "No members available."
                members = [];
            }
        }
        this.postMessageToWebview({ type: 'ticketMembersLoaded', provider, members, workspaceRoot });
    } catch (error) {
        this.postMessageToWebview({ type: 'ticketMembersError', provider, error: error instanceof Error ? error.message : String(error), workspaceRoot });
    }
    break;
}
```

The webview handles `ticketMembersLoaded` and `ticketMembersError` per section 2(c) above.

### 4. `src/services/LinearSyncService.ts` — extend `createIssueSimple`

Add `priority?` and `assigneeId?` to the params and the `IssueCreateInput` (~L2355–2386):

```ts
public async createIssueSimple(params: {
    title: string;
    description?: string;
    projectId?: string;
    stateId?: string;
    parentId?: string;
    priority?: number;
    assigneeId?: string;
}): Promise<{ id: string; identifier: string }> {
    // ... existing config check ...
    const input: any = {
        teamId: config.teamId,
        title: params.title,
        description: params.description || '',
        labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.stateId ? { stateId: params.stateId } : {}),
        ...(params.parentId ? { parentId: params.parentId } : {}),
        ...(typeof params.priority === 'number' && params.priority >= 0 && params.priority <= 4 ? { priority: params.priority } : {}),
        ...(params.assigneeId ? { assigneeId: params.assigneeId } : {})
    };
    const result = await this.retry(() => this.graphqlRequest(`...same mutation...`, { input }));
    // ... rest unchanged ...
}
```

The 0–4 guard mirrors `updateIssuePriority` (L1177). `assigneeId` is a Linear user UUID string (from `getTeamMembers` L1577).

## Verification Plan

> **Session directive:** Compilation and automated tests are SKIPPED per the session configuration. Verification below is manual only.

### Automated Tests

- Skipped per session directive (no `npm run compile`, no `npm test`). A coder may run the typecheck and the existing `clickup-sync-service` / Linear service regression suites locally before dispatch if desired, but it is not required by this plan.

### Manual Verification

1. **ClickUp — new ticket**: Open Tickets tab → ClickUp → select a list → "Create New Ticket". Confirm Status dropdown lists the list's statuses, Priority lists the 5 priorities (0–4), Assignees lists list members (checkboxes, multi). Set all three + title → Create. Verify the created task in ClickUp has the chosen status/priority/assignees.
2. **ClickUp — subtask**: Open a ticket → `+ Subtask`. Confirm the same three controls appear populated (members from the parent's list). Set metadata → Create. Verify the subtask inherits the chosen metadata.
3. **Linear — new ticket**: Repeat step 1 for Linear (assignees render as radios — single select; status uses state ids). Verify the created issue has the chosen state/priority/assignee.
4. **Linear — subtask**: Repeat step 2 for Linear.
5. **Defaults path**: Create a ticket/subtask leaving Status/Priority/Assignees on "Default" (empty). Confirm creation succeeds and the ticket uses provider defaults (no `0` priority forced, no unassigned override).
6. **Reset behavior**: Open the modal, set metadata, then Cancel (and separately the × close button). Reopen — confirm all three fields are reset to Default/unchecked.
7. **Members load failure**: With ClickUp and no list selected, open the create modal — confirm "No members available." shows (no crash, no stuck "Loading members…"), and creation still works without assignees.
8. **Members response wiring**: Open the create modal and confirm the assignees list populates after the `loadTicketMembers` round-trip completes (i.e. the dedicated `ticketMembersLoaded` webview case fires and `_renderCreateModalAssignees()` runs). This is the regression guard for the top adversarial finding.

---

**Recommendation:** Complexity 5 → **Send to Coder**.

---

## Completion Summary

Implemented Status, Priority, and Assignees metadata fields in the Create New Ticket / Create Subtask modal. **Files changed:** `src/webview/planning.html` (added 3 form controls between description and footer), `src/webview/planning.js` (added 6 helpers — `_populateCreateModalStatus`, `_populateCreateModalPriority`, `_renderCreateModalAssignees`, `_loadCreateModalMembers`, `_resetCreateModalMetadata`, `_collectCreateModalAssignees`; added `ticketMembersLoaded`/`ticketMembersError` webview cases; wired populate-on-open + reset into `tickets-create`, `btn-add-subtask`, close/cancel/backdrop, and both success handlers; extended submit to forward status/priority/assignees), `src/services/PlanningPanelProvider.ts` (forwarded `status`/`priority`/`assignees` into `clickupCreateTask`'s `createTask` call, `status`→`stateId`/`priority`/`assigneeId` into `linearCreateIssue`'s `createIssueSimple` call, and added a new `loadTicketMembers` case that resolves members by listId (ClickUp) or team (Linear) without requiring a ticket id), `src/services/LinearSyncService.ts` (extended `createIssueSimple` signature + `IssueCreateInput` with optional `priority` (0–4 guarded) and `assigneeId`). No issues encountered; all edits follow existing patterns (`showTicketStatusModal`, `renderAssignModalList`, `updateIssuePriority`). Compilation/tests skipped per session directive.

## Review Findings

**Reviewer pass:** inline adversarial review against plan requirements — no CRITICAL or MAJOR findings; implementation matches plan spec exactly across all 4 files. **Files reviewed:** `src/webview/planning.html` (L4128–4145: 3 controls added), `src/webview/planning.js` (L1334–1435: 6 helpers; L6229–6239: `ticketMembersLoaded`/`ticketMembersError` cases; L6730/6759: success resets; L9713–9716/9868–9871: populate-on-open; L9725/9733/9741: close/cancel/backdrop resets; L9829–9846: submit forwarding), `src/services/PlanningPanelProvider.ts` (L5486–5531: `loadTicketMembers` case; L7055–7061: ClickUp forwarding; L7134–7140: Linear forwarding), `src/services/LinearSyncService.ts` (L2361–2362: new params; L2387–2388: input spread with 0–4 guard). **Validation:** compilation and tests skipped per session directive; manual code-path trace confirms correct provider branching (ClickUp status-name vs Linear state-id; ClickUp `number[]` vs Linear single UUID), correct reset on all 5 exit paths (success×2, close, cancel, backdrop), no orphaned references, no double-trigger, no race beyond the documented `_assignMembers` shared-state smell. **NITs (no fix applied):** (1) `_loadCreateModalMembers` always fetches on open even when `_assignMembers` is populated — plan suggested conditional load; minor extra API call, ensures fresh data; (2) `projectName` sent in `loadTicketMembers` message but unused by backend (Linear members are team-scoped) — harmless redundancy; (3) ClickUp `priority: 0` silently dropped by `createTask` truthy guard (`if (priority)`) — acknowledged in plan as semantically harmless, out of scope to fix. **Remaining risks:** the `_assignMembers`/`_assignMembersLoading` shared-state smell between create and assign modals (safe in practice due to mutual exclusivity); ClickUp subtask member resolution depends on `selectedClickUpIssue?.task?.list?.id` being set when `+ Subtask` is clicked (verified: `btn-add-subtask` reads `selectedClickUpIssue` at L9852).
