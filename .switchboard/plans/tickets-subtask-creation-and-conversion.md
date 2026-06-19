# Tickets Tab: Subtask Creation & Conversion

## Metadata
**Complexity:** 5
**Tags:** frontend, backend, api, ui, feature

## Goal

Add the ability to (a) create a subtask under an existing ticket and (b) convert an existing ticket into a subtask of another ticket, for both ClickUp and Linear providers in the Switchboard planning webview.

### Problem Analysis

The Tickets tab currently supports:
- Creating top-level tickets via the "New Ticket" modal
- Viewing existing subtasks in the `#tickets-subtasks-nav` panel when a parent ticket is selected
- Navigating between subtasks by clicking them in the nav panel

**Gap 1 — No subtask creation:** The "New Ticket" modal (`create-ticket-modal`) only creates top-level tickets. There is no way to create a subtask linked to an existing parent. The backend is partially ready: `ClickUpSyncService.createTask()` already accepts a `parent` param, but `PlanningPanelProvider`'s `clickupCreateTask` handler doesn't pass it. `LinearSyncService.createIssueSimple()` has no `parentId` support at all.

**Gap 2 — No convert-to-subtask:** There is no way to take an existing standalone ticket and assign it as a subtask of another ticket. ClickUp's `updateTask` API accepts `parent` on PUT, but the TypeScript type doesn't include it. Linear's `issueUpdate` mutation accepts `parentId`, but no method exposes this capability.

### Root Cause

The feature was never built. The subtask *display* infrastructure exists (nav panel, click-to-navigate, detail cache), but the *creation* and *conversion* flows were not implemented in the webview, PlanningPanelProvider, or (for Linear) the sync service.

## Scope

### In Scope
- "Add Subtask" button on the ticket detail meta-bar
- Reuse the existing `create-ticket-modal` with parent context (banner showing parent ticket name)
- "Convert to Subtask" button on the ticket detail meta-bar
- Parent picker modal for conversion (searchable dropdown of tickets in the same list/project)
- ClickUp: pass `parent` through `clickupCreateTask` handler + add `parent` to `updateTask` type
- Linear: add `parentId` to `createIssueSimple` + new `updateIssueParent` method
- Post-creation/conversion: refresh parent ticket detail view and subtask nav
- Cycle prevention: prevent making a ticket a subtask of its own descendant

### Out of Scope
- Sidebar tree hierarchy rendering (tickets remain flat in sidebar; subtasks still shown in detail nav panel)
- Bulk subtask creation
- Drag-and-drop re-parenting
- Removing a parent (un-nesting a subtask back to top-level)

## Implementation Plan

### 1. Backend: Linear — Add `parentId` to `createIssueSimple`

**File:** `src/services/LinearSyncService.ts` (~line 1740)

Add optional `parentId?: string` to `createIssueSimple` params. Pass it into the `issueCreate` mutation input:

```typescript
input: {
  teamId: config.teamId,
  title: params.title,
  description: params.description || '',
  labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
  ...(params.projectId ? { projectId: params.projectId } : {}),
  ...(params.stateId ? { stateId: params.stateId } : {}),
  ...(params.parentId ? { parentId: params.parentId } : {})  // NEW
}
```

### 2. Backend: Linear — Add `updateIssueParent` method

**File:** `src/services/LinearSyncService.ts` (new method, near other `updateIssue*` methods ~line 1010)

```typescript
public async updateIssueParent(issueId: string, parentId: string | null): Promise<void> {
  // Uses issueUpdate with parentId in input
  // parentId = null removes the parent (un-nests), but we're scoping to set only
}
```

GraphQL mutation:
```graphql
mutation($id: String!, $parentId: String) {
  issueUpdate(id: $id, input: { parentId: $parentId }) { success }
}
```

### 3. Backend: ClickUp — Add `parent` to `updateTask` type

**File:** `src/services/ClickUpSyncService.ts` (~line 1377)

Add `parent?: string` to the `updates` parameter type. The API already accepts `parent` on PUT `/task/{taskId}` — this is just a type-level change. No body construction change needed since the existing code passes `updates` straight through to `httpRequest`.

### 4. Backend: PlanningPanelProvider — Handle `parent` in create handlers

**File:** `src/services/PlanningPanelProvider.ts`

**4a. `clickupCreateTask` handler (~line 4407):** Pass `parent: msg.parentId` to `clickUp.createTask()`.

**4b. `linearCreateIssue` handler (~line 4460):** Pass `parentId: msg.parentId` to `linear.createIssueSimple()`.

**4c. New `convertToSubtask` handler:** New message case that:
- For ClickUp: calls `clickUp.updateTask(taskId, { parent: parentId })`
- For Linear: calls `linear.updateIssueParent(issueId, parentId)`
- Posts back `{ type: 'subtaskConverted', success, provider, taskId, parentId }`
- On success, re-fetches the parent ticket's detail to refresh subtask nav

### 5. Webview: Meta-bar buttons

**File:** `src/webview/planning.html` (~line 3266, in `#tickets-preview-meta-bar`)

Add two buttons:
```html
<button id="btn-add-subtask" class="strip-btn" title="Create a subtask under this ticket">+ Subtask</button>
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">Convert to Subtask</button>
```

### 6. Webview: Reuse create-ticket modal with parent context

**File:** `src/webview/planning.js`

When "Add Subtask" is clicked:
- Set a module-level variable `_subtaskParent = { id, title, provider }` 
- Open `create-ticket-modal`
- Update modal title to "Create Subtask under {parent title}"
- On submit: include `parentId: _subtaskParent.id` in the `vscode.postMessage` payload
- On success (`clickupTaskCreated`/`linearIssueCreated`): clear `_subtaskParent`, refresh parent ticket detail

When "New Ticket" (top-level) is clicked: clear `_subtaskParent` before opening modal, reset modal title to "Create New Ticket".

### 7. Webview: Parent picker modal for conversion

**File:** `src/webview/planning.html` (new modal, after `create-ticket-modal`)

A modal with:
- Title: "Convert to Subtask"
- Info text: "Select a parent ticket for **{current ticket title}**"
- Searchable `<select>` or filtered list of tickets from the current list/project (reuse `clickUpProjectIssues` / `linearProjectIssues` already in memory)
- Exclude the current ticket and its descendants from the list (cycle prevention)
- Confirm/Cancel buttons

**File:** `src/webview/planning.js`

When "Convert to Subtask" is clicked:
- Open the conversion modal
- Populate the parent picker from in-memory issues (filtering out self + descendants)
- On confirm: send `{ type: 'convertToSubtask', provider, taskId, parentId, workspaceRoot }`
- On `subtaskConverted` response: refresh the ticket list and re-select the converted ticket to show updated parent in detail view

### 8. Webview: Post-creation/conversion refresh

**File:** `src/webview/planning.js`

In the `clickupTaskCreated` / `linearIssueCreated` handlers:
- If `_subtaskParent` was set, re-fetch the parent ticket's detail (send `clickupLoadTaskDetail` / `linearLoadIssueDetail` for the parent ID) to refresh the subtask nav panel
- Then navigate to the newly created subtask

In the new `subtaskConverted` handler:
- Refresh the ticket list (`loadClickUpProject(true)` / `loadLinearProject(true)`)
- Re-select the converted ticket to show it now has a parent reference in detail view

### 9. Cycle prevention

**File:** `src/webview/planning.js`

Before allowing conversion, check if the candidate parent is a descendant of the current ticket. Use the in-memory subtask data: walk the subtask tree of the current ticket and collect all descendant IDs. Filter those out of the parent picker options.

For ClickUp: `clickUpProjectIssues` has `parentId` on each task — can build a child-to-parent map and walk upward to check if the current ticket is an ancestor of the candidate parent.

For Linear: `linearProjectIssues` has `parentId` — same approach.

## Edge Cases & Risks

- **Cycle creation:** Making ticket A a subtask of B, where B is already a subtask of A. Mitigated by descendant filtering in the parent picker.
- **Cross-list parenting (ClickUp):** ClickUp allows subtasks in different lists. The parent picker should show tickets from the current list only to keep it simple. If the user wants cross-list, that's a future enhancement.
- **Ticket with existing subtasks being converted:** This is fine — the ticket becomes a subtask but retains its own subtasks. ClickUp and Linear both support nested hierarchies.
- **Stale cache after conversion:** The `updateTask` / `updateIssueParent` calls invalidate caches, but the in-memory `clickUpProjectIssues` / `linearProjectIssues` arrays in the webview need a refetch. The `subtaskConverted` handler triggers a refetch.
- **Modal state leakage:** If user opens "Add Subtask" modal then cancels, `_subtaskParent` must be cleared. Handle in cancel/close button listeners.
- **Linear API rate limits:** Each conversion is one API call. No batching needed.

## Files Changed

| File | Change |
|------|--------|
| `src/services/LinearSyncService.ts` | Add `parentId` param to `createIssueSimple`; new `updateIssueParent` method |
| `src/services/ClickUpSyncService.ts` | Add `parent?: string` to `updateTask` type |
| `src/services/PlanningPanelProvider.ts` | Pass `parent`/`parentId` in create handlers; new `convertToSubtask` message handler |
| `src/webview/planning.html` | Two new meta-bar buttons; new parent-picker modal |
| `src/webview/planning.js` | Subtask creation flow with parent context; conversion flow with parent picker; cycle prevention; post-action refresh |

## Validation

1. **ClickUp subtask creation:** Select a ticket → click "+ Subtask" → modal shows parent name → create → subtask appears in nav panel → parent detail refreshes
2. **Linear subtask creation:** Same flow with Linear provider
3. **ClickUp conversion:** Select a ticket → click "Convert to Subtask" → pick parent → ticket's parent is set → list refreshes
4. **Linear conversion:** Same flow with Linear provider
5. **Cycle prevention:** Try to make ticket A a subtask of its own subtask B → B should not appear in the parent picker
6. **Modal state:** Open subtask modal → cancel → open normal "New Ticket" → modal title should be "Create New Ticket" (no parent context)
7. **Existing subtask display:** Verify existing subtask nav still works after changes
