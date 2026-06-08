# Add "Create New Ticket" Button to Tickets Tab

## Goal

Add a **"New Ticket"** button to the Tickets tab in `planning.html` that opens a modal form. Submitting the form creates a new ticket/task/issue in the currently selected ClickUp list or Linear project, then refreshes the list so the new ticket appears immediately.

**Root cause:** The Tickets tab is read-only. Users must switch to external tracker (ClickUp/Linear web app) to create tickets, breaking VS Code flow. The backend sync services already have creation APIs (`ClickUpSyncService.createTask` is general-purpose; `LinearSyncService.createIssue` is plan-coupled and needs a new general-purpose wrapper). The webview already has modal infrastructure and message-passing patterns.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, api, ui, feature

## User Review Required

Yes — the `createIssueSimple()` method on `LinearSyncService` introduces a new public API surface. The decision to NOT write to the sync map for standalone ticket creation should be confirmed (see Adversarial Synthesis).

## Complexity Audit

### Routine
- Adding button HTML to `#controls-strip-tickets`
- Adding modal HTML with `.folder-modal` pattern
- Wiring click listeners in `initTicketsTab()`
- Adding IPC handler cases in `PlanningPanelProvider.ts`
- Verifying `ClickUpSyncService.createTask()` handles missing `status` gracefully (it does — `status` is optional)

### Complex / Risky
- `createIssueSimple()` on `LinearSyncService` — new method that bypasses plan-file coupling, sync map, and kanban DB. Must decide sync map behavior.
- Button enabled/disabled state management across provider switches and hierarchy navigation — must update in `renderTicketsClickUpPanel()` and `renderTicketsLinearPanel()`
- Project name → ID resolution for Linear in extension host — async step that can fail if project list not loaded

## Problem Analysis

Currently, the Tickets tab is read-only. Users can browse, search, import, and refine existing tickets from ClickUp or Linear, but there is no way to create a new ticket directly from the Switchboard planning panel. This forces users to switch to their external tracker (ClickUp/Linear web app) to create tickets, breaking their flow within VS Code.

The backend sync services already have creation APIs:
- `ClickUpSyncService.createTask({ name, listId, description?, ... })` — general-purpose, ready to use.
- `LinearSyncService.createIssue(plan, stateId, priority, config)` — tightly coupled to plan records, sync maps, and plan-file-based description generation. A new general-purpose wrapper is required.

The webview already has modal infrastructure (`.folder-modal`, `.comment-popup`) and a well-established message-passing pattern between `planning.js` and `PlanningPanelProvider.ts`.

## Requirements

### Functional

1. **Button placement**: A `+ New Ticket` button appears in the `#controls-strip-tickets` controls strip, to the left of the Refresh button.
2. **Click target area**: The button is only enabled when the user has selected a valid target area:
   - **ClickUp**: a list is selected (`clickUpSelectedListId` is set).
   - **Linear**: a project is selected (`linearProjectPickerValue` is set) or the team is configured (fallback to team-wide).
3. **Modal form**: Clicking the button opens a modal with:
   - **Title** (required, text input)
   - **Description** (optional, textarea)
   - **Create** and **Cancel** buttons
4. **Creation flow**:
   - On submit, send a `vscode.postMessage` to the extension host.
   - The extension delegates to the appropriate sync service.
   - On success, show an `alert('Ticket created successfully!')` and trigger an automatic refresh of the tickets list.
   - On failure, show an `alert('Failed to create ticket: ' + error)`.
5. **Provider-specific behaviour**:
   - **ClickUp**: Creates a task in the currently selected list. Default status is used if none specified.
   - **Linear**: Creates an issue in the currently selected project (or team-wide if no project selected). Default state is used if none specified.

### Non-Functional

- Reuse existing CSS classes (`.folder-modal`, `.planning-input`, `.planning-button`) for consistency.
- Keep the form minimal (title + description only) to avoid scope creep.
- No changes to existing ticket import, refine, or sync logic.
- No self-editing of system files or workflow configs.

## Edge-Case & Dependency Audit

- **Race Conditions:** Double-click on Create button could fire two `postMessage` calls. **Mitigation:** Disable the Create button immediately on click; re-enable only after response.
- **Security:** Title and description are user-provided text passed through `vscode.postMessage`. No SQL/HTML injection risk since the extension host passes values directly to API calls (no DOM rendering of raw input in the extension host). The webview uses `escapeHtml` for any rendered feedback.
- **Side Effects:** `createIssueSimple()` does NOT write to the sync map or kanban DB. This means auto-pull may re-import the created issue as a plan file. This is acceptable — the ticket appears in the list naturally, and if auto-pull imports it, that's the existing auto-pull behavior.
- **Dependencies & Conflicts:** `ClickUpSyncService.createTask()` is general-purpose and ready. `LinearSyncService.createIssue()` is plan-coupled — the new `createIssueSimple()` method must NOT interfere with the existing `createIssue()` flow or its sync map markers.

### Additional Risks

| Risk | Mitigation |
|------|------------|
| ClickUp list not selected | Disable button with tooltip/hint; guard in extension handler |
| Linear project not selected | Allow creation in team-wide context (same as query behaviour) |
| API rate limit during create | Reuse existing `retry()` wrappers in sync services |
| Creation succeeds but refresh fails | Show success alert anyway; user can manually refresh |
| Empty title submitted | HTML `required` attribute + JS guard before posting message |
| Extension host throws during delegation | Wrap in try/catch; post error message back to webview |
| No integration configured (`lastIntegrationProvider` is null) | Disable button with tooltip 'Configure an integration in Setup first' |
| Button state stale after hierarchy navigation | Update enabled/disabled in `renderTicketsClickUpPanel()` and `renderTicketsLinearPanel()` |

## Implementation Plan

### Step 1: Webview UI — Add Button and Modal HTML

**File**: `src/webview/planning.html`

- Add `<button id="tickets-create" class="strip-btn">+ New Ticket</button>` to `#controls-strip-tickets`.
- Add a new modal `<div class="folder-modal" id="create-ticket-modal" style="display:none">` with:
  - Header: "Create New Ticket"
  - Body: Title input (`#create-ticket-title`) and Description textarea (`#create-ticket-description`)
  - Actions: Cancel button and Create button (primary)

### Step 2: Webview JS — Hook Up Modal, Message Passing, and Button State Management

**File**: `src/webview/planning.js`

- In `initTicketsTab()`, add:
  - Click listener on `#tickets-create` to show the modal.
  - Click listener on modal close/Cancel to hide the modal and clear fields.
  - Click listener on modal Create to validate title, disable Create button, then post:
    ```js
    vscode.postMessage({
      type: lastIntegrationProvider === 'clickup' ? 'clickupCreateTask' : 'linearCreateIssue',
      workspaceRoot: currentWorkspaceRoot || undefined,
      title: titleValue,
      description: descriptionValue || undefined,
      listId: clickUpSelectedListId || undefined,        // ClickUp only
      projectName: linearProjectPickerValue || undefined   // Linear only
    });
    ```
- Add IPC handler cases for `clickupTaskCreated` and `linearIssueCreated`:
  - On success: `alert('Ticket created successfully!')`, hide modal, clear form, re-enable Create button, trigger refresh (`loadClickUpProject(true)` or `loadLinearProject(true)`).
  - On failure: `alert('Failed to create ticket: ' + msg.error)`, re-enable Create button.
- **Button state management** — add to `renderTicketsClickUpPanel()` and `renderTicketsLinearPanel()`:
  - ClickUp: enable `#tickets-create` only when `clickUpSelectedListId` is set; disable otherwise with `title='Select a list first'`.
  - Linear: enable `#tickets-create` when `linearProjectPickerValue` is set OR when `lastIntegrationProvider === 'linear'` (team-wide fallback); disable when `lastIntegrationProvider` is null with `title='Configure an integration in Setup first'`.

### Step 3: Extension Host — Add Message Handlers

**File**: `src/services/PlanningPanelProvider.ts`

Add two new cases inside the existing `webview.onDidReceiveMessage` switch:

- **`clickupCreateTask`**:
  1. Resolve workspace root.
  2. Get `ClickUpSyncService` from `_adapterFactories`.
  3. Call `clickUp.createTask({ name: msg.title, listId: msg.listId, description: msg.description })`.
  4. Post `clickupTaskCreated` with `success: true` or `success: false` + error.

- **`linearCreateIssue`**:
  1. Resolve workspace root.
  2. Get `LinearSyncService` from `_adapterFactories`.
  3. Load config, verify `setupComplete`.
  4. Resolve project ID from `msg.projectName` (if provided) via `getAvailableProjects()`.
  5. Call a new `linear.createIssueSimple({ title, description, projectId })` method.
  6. Post `linearIssueCreated` with `success: true` or `success: false` + error.

### Step 4: Linear Sync Service — Add General-Purpose Creation Method

**File**: `src/services/LinearSyncService.ts`

Add `createIssueSimple(params: { title: string; description?: string; projectId?: string; stateId?: string }): Promise<{ id: string; identifier: string }>`:

- Load config, verify setup.
- GraphQL mutation using `IssueCreateInput` with:
  - `teamId: config.teamId`
  - `title: params.title`
  - `description: params.description || ''`
  - `projectId` if provided
  - `stateId` if provided, otherwise omit (Linear picks default)
  - Optional: `labelIds` with `switchboardLabelId` for consistency
- Return the created issue `{ id, identifier }`.
- Wrap in existing `retry()` for resilience.
- **Do NOT write to sync map or kanban DB.** This method creates standalone tickets, not plan-linked issues. Auto-pull may re-import the created issue — that is acceptable behavior.

### Step 5: ClickUp Sync Service — Verify Existing API

**File**: `src/services/ClickUpSyncService.ts`

No new code needed. The existing `createTask(params)` method already supports general-purpose creation. Only verify it handles missing `status` gracefully (it does — `status` is optional in the body).

### Step 6: Manual Verification

1. Open Planning Panel → Tickets tab.
2. Select ClickUp integration, pick a Space/Folder/List.
3. Click **+ New Ticket**, fill form, submit.
4. Verify task appears in ClickUp and the list refreshes.
5. Switch to Linear integration, pick a project.
6. Click **+ New Ticket**, fill form, submit.
7. Verify issue appears in Linear and the list refreshes.

## Dependencies

None — this plan is self-contained. Both `ClickUpSyncService` and `LinearSyncService` are already available via `_adapterFactories` in `PlanningPanelProvider`.

## Adversarial Synthesis

Key risks: `createIssueSimple()` bypassing sync map may cause auto-pull re-import of created issues; button state not updating on provider/hierarchy changes; and Linear project name→ID resolution failure if project list unloaded. Mitigations: auto-pull re-import is acceptable behavior (ticket appears naturally); add explicit button state updates in `renderTicketsClickUpPanel()` and `renderTicketsLinearPanel()`; and return clear error message if project ID resolution fails. The `alert()` UX is functional for MVP.

## Proposed Changes

### `src/webview/planning.html`
- **Context:** `#controls-strip-tickets` (line 2990) has search, pickers, and refresh button. No creation button exists.
- **Logic:** Add `<button id="tickets-create">` before refresh button. Add `#create-ticket-modal` with title/description form.
- **Implementation:** See Step 1 above.
- **Edge Cases:** Modal must be hidden on initial load and after Cancel/Create.

### `src/webview/planning.js`
- **Context:** `initTicketsTab()` (line 4651) wires search, pickers, refresh, and detail buttons. No creation flow exists.
- **Logic:** Add click listeners for create button, modal open/close, and form submit. Add IPC handlers for `clickupTaskCreated`/`linearIssueCreated`. Add button state management to `renderTicketsClickUpPanel()` and `renderTicketsLinearPanel()`.
- **Implementation:** See Step 2 above.
- **Edge Cases:** Double-click prevention via button disable on submit. No integration configured → button disabled with tooltip.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `webview.onDidReceiveMessage` switch handles ClickUp/Linear messages (lines 1867-2270).
- **Logic:** Add `clickupCreateTask` and `linearCreateIssue` cases. Delegate to sync services via `_adapterFactories`.
- **Implementation:** See Step 3 above. Insert near existing ClickUp/Linear handlers.
- **Edge Cases:** Workspace root must be resolved. Linear project name→ID resolution may fail → return error message.

### `src/services/LinearSyncService.ts`
- **Context:** `createIssue()` (line 1604) is plan-coupled with sync map and kanban DB writes.
- **Logic:** Add `createIssueSimple()` — standalone ticket creation without sync map or kanban DB. Uses same GraphQL mutation but simpler input.
- **Implementation:** See Step 4 above.
- **Edge Cases:** Auto-pull re-import of created issues is acceptable. Must not interfere with existing `createIssue()` flow.

## Verification Plan

### Automated Tests

- **Unit test: `createIssueSimple()`** — mock `graphqlRequest` to return successful creation, verify returned `{ id, identifier }`, verify sync map is NOT written to.
- **Unit test: `createIssueSimple()` failure** — mock `graphqlRequest` to throw, verify error propagates, verify no sync map side effects.

### Manual Verification

1. Open Planning Panel → Tickets tab.
2. Select ClickUp integration, pick a Space/Folder/List.
3. Click **+ New Ticket**, fill form, submit.
4. Verify task appears in ClickUp and the list refreshes.
5. Switch to Linear integration, pick a project.
6. Click **+ New Ticket**, fill form, submit.
7. Verify issue appears in Linear and the list refreshes.
8. Verify button is disabled when no integration is configured.
9. Verify button is disabled when no ClickUp list is selected.
10. Verify double-click prevention (button disables on submit).

## Acceptance Criteria

- [ ] Button is visible in tickets tab controls strip.
- [ ] Button is disabled when no valid target area is selected.
- [ ] Button is disabled when no integration is configured (`lastIntegrationProvider` is null).
- [ ] Modal opens on click, closes on Cancel or backdrop click.
- [ ] Empty title is blocked before sending the message.
- [ ] Double-click on Create button is prevented via disable-on-submit.
- [ ] ClickUp: task is created in the selected list.
- [ ] Linear: issue is created in the selected project (or team-wide).
- [ ] Success alert is shown after creation.
- [ ] Tickets list auto-refreshes after successful creation.
- [ ] Error alert is shown if creation fails.
- [ ] Create button is re-enabled after success or failure.

**Recommendation:** Complexity 5 → **Send to Coder**

## Review Findings

Two issues found and fixed: (1) CRITICAL — button was enabled when no integration configured (`lastIntegrationProvider` null), because HTML lacked `disabled` attribute and `renderTicketsTab()` had no null-provider guard; fixed by adding `disabled` to the button element and an else-branch that disables it with tooltip. (2) MAJOR — `createIssueSimple()` skipped `setupComplete` check; fixed by adding it to the guard clause. Files changed: `src/webview/planning.html:3043`, `src/webview/planning.js:4962-4976`, `src/services/LinearSyncService.ts:1683-1686`, plus dist sync. Remaining risk: Linear project name→ID fallback uses raw name as ID when no match found, which may produce confusing API errors (acceptable per plan's adversarial synthesis).
