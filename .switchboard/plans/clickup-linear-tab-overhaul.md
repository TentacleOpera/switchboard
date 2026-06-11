# ClickUp/Linear Ticket Tab Overhaul

## Metadata

- **Complexity:** 7
- **Tags:** clickup, linear, planning-view, tickets-tab, import, attachments, editing, status-management, comments

## Goal

Overhaul the ClickUp/Linear tickets tab in Switchboard's planning view to resolve UX friction points: missing folder management, no bulk import, no preview action bar, non-functional attachments, and an unclear distinction between "Ask Agent" and "Refine." The tab should support two import modes (plan vs. document), in-place editing with write-back to remote, and full preview actions aligned with the Kanban tab pattern.

## Problem Analysis

1. **Folder Management Gap:** Users cannot configure where imported tickets are saved. Other tabs (local docs, design docs) expose a "manage folder" button backed by `LocalFolderService` and `local-folder-config.json`, but the tickets tab lacks this entirely.

2. **No Bulk Import:** The sidebar lists dozens of tickets, yet each must be imported one-by-one via the `IMPORT` card action. There is no mechanism to import the currently filtered sidebar set in one operation.

3. **No Preview Action Bar:** The Kanban plans tab exposes an inline meta bar (`renderKanbanMetaBar`) with edit, save, cancel, delete, and column-change controls. The tickets preview pane is read-only — no edit, push, delete, status change, or comment posting.

4. **Broken Attachments:** `renderTicketsLinearTaskDetail` and `renderTicketsClickUpTaskDetail` render attachments as `<button>` elements with `data-*-attachment-url`, but no click handler is wired. The buttons are dead UI.

5. **Ambiguous Agent Actions:** "ASK AGENT" and "REFINE" on ticket cards both dispatch to a planner agent. Users cannot tell the difference, and neither mode supports editing the ticket and pushing changes back.

6. **Editing Workflow Mismatch:** Users expect to edit an online ticket in place. The current flow forces manual import (creates a kanban plan, triggers sync, promotes to brain) before any editing is possible.

## Plan

### Phase 1: Sidebar Enhancements

#### 1.1 Add "Manage Ticket Folder" Button

**Files:** `planning.html`, `planning.js`, `PlanningPanelProvider.ts`, `LocalFolderService.ts`

**What:** Add a "Manage Folder" button to the tickets sidebar (next to Refresh). This button opens the existing folder-selection modal but scoped to a new config key: `ticketsFolderPaths` in `local-folder-config.json`.

**Why:** `LocalFolderService` already manages `localFolderPaths`, `htmlFolderPaths`, and `designFolderPaths`. Adding `ticketsFolderPaths` uses the proven pattern without new UI complexity.

**How:**
1. In `LocalFolderService.ts`:
   - Extend `LocalFolderPathsConfig` interface to include `ticketsFolderPaths: string[]`.
   - Add `getTicketsFolderPaths(): string[]` method reading from config.
   - Update `loadFolderPathsConfig` and `saveFolderPathsConfig` to handle the new field.
2. In `planning.html`:
   - Add `<button id="btn-manage-ticket-folders" class="strip-btn">Manage Folders</button>` inside `#controls-strip-tickets`.
3. In `planning.js`:
   - Add `btnManageTicketFolders` to `getTicketsTabElements()`.
   - Wire click to `openFoldersModal('tickets-folder')` (reusing the existing modal pattern but passing a scope parameter to filter which folder paths are shown/editable).
   - When the modal saves, post a new message type `saveTicketsFolderPaths`.
4. In `PlanningPanelProvider.ts`:
   - Handle `saveTicketsFolderPaths` by delegating to `LocalFolderService.saveFolderPathsConfig`.
   - On subsequent `refreshSource` for tickets, include `ticketsFolderPaths` in the `folderPathsByRoot` payload so the UI knows whether a folder is configured.

**Edge Cases:**
- If no ticket folder is configured, the default `.switchboard/plans/` should remain the fallback for "import as plan" operations.
- Multi-root workspaces: each root may have its own `ticketsFolderPaths`; the modal must scope to the currently selected workspace root.

---

#### 1.2 Add "Import All" Button to Sidebar

**Files:** `planning.html`, `planning.js`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`

**What:** Add an "Import All" button to `#controls-strip-tickets` that imports every ticket currently visible in the sidebar (respecting active search + status/project filters) as plans.

**How:**
1. In `planning.html`:
   - Add `<button id="btn-import-all-tickets" class="strip-btn">Import All</button>` inside `#controls-strip-tickets`.
2. In `planning.js`:
   - Add `importAllButton` to `getTicketsTabElements()`.
   - Compute the list of currently visible ticket IDs from `getFilteredLinearIssues()` or `getFilteredClickUpTasks()` (depending on active provider).
   - On click, post `importAllTickets` message with `{ provider, issueIds[] / taskIds[], workspaceRoot, importMode: 'plan' }`.
   - Show a progress indicator (reuse existing skeleton/loading state) because bulk import may take 5–30 seconds for large lists.
3. In `PlanningPanelProvider.ts`:
   - Add `case 'importAllTickets':` that calls `TaskViewerProvider.importAllTasks()`.
4. In `TaskViewerProvider.ts`:
   - Add `public async importAllTasks(workspaceRoot, { provider, ids, importMode })`.
   - Iterate over `ids`, calling `importLinearTask` or `importClickUpTask` for each.
   - Wrap each call in try/catch so one failure doesn't abort the whole batch.
   - Collect results and return `{ successCount, failCount, errors[] }`.
   - After completion, post `importAllTicketsComplete` to the webview so the sidebar can clear the loading state and show a summary toast.

**Edge Cases:**
- Clicking "Import All" when no tickets match the current filter should be a no-op with a visible "No tickets to import" toast.
- Partial failures: the summary toast must list which IDs failed and why.

---

### Phase 2: Preview Pane Inline Action Bar

#### 2.1 Add Action Bar to Tickets Preview

**Files:** `planning.html`, `planning.js`, `PlanningPanelProvider.ts`

**What:** Render an inline button strip at the top of `#preview-pane-tickets` (mirroring `kanban-preview-meta-bar`) with these controls:
- **Edit** — opens the ticket in a temp file for editing
- **Save / Push** — pushes the edited temp file back to ClickUp/Linear
- **Delete** — deletes the remote ticket (with confirmation modal)
- **Status** — dropdown to change the ticket's status/state
- **Comment** — opens a small inline textarea + "Post" button to add a comment

**How:**
1. In `planning.html`:
   - Add a new `<div id="tickets-preview-meta-bar" class="kanban-preview-meta-bar" style="display:none;">` inside `#preview-pane-tickets`.
   - Inside it, add buttons: `#btn-edit-ticket`, `#btn-save-ticket`, `#btn-delete-ticket`, `#btn-change-status-ticket`, `#btn-comment-ticket`.
2. In `planning.js`:
   - In `renderTicketsLinearTaskDetail` and `renderTicketsClickUpTaskDetail`, show the meta bar when an issue/task is selected.
   - Disable/enable buttons based on state:
     - If no temp-edit session is active: `Edit` enabled, `Save` disabled, `Delete` enabled, `Status` enabled, `Comment` enabled.
     - If temp-edit session is active: `Edit` disabled, `Save` enabled.
   - Wire click handlers:
     - `Edit` → `handleTicketEdit(provider, id)`
     - `Save` → `handleTicketSave(provider, id)`
     - `Delete` → `handleTicketDelete(provider, id)` (shows confirmation modal)
     - `Status` → `handleTicketChangeStatus(provider, id, newStatus)`
     - `Comment` → toggles visibility of an inline comment input + post button
3. In `PlanningPanelProvider.ts`:
   - Add message handlers: `editTicket`, `saveTicket`, `deleteTicket`, `changeTicketStatus`, `postTicketComment`.
   - Each delegates to existing `TaskViewerProvider` methods (see Phase 3).

---

### Phase 3: Backend Commands for Write Operations

**Files:** `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`

**What:** Register or wire VS Code commands for the new preview actions. Most underlying service methods already exist; this phase is about exposing them to the webview.

**How:**

1. **Edit (temp file for in-place editing)** — `editTicketDocument`:
   - Accepts `{ provider, id, title, description }`.
   - Creates a **temporary** `.md` file in the system temp directory (via `os.tmpdir()`).
   - The temp file format is a structured markdown document:
     ```markdown
     # [Ticket Title]
     Provider: clickup|linear
     ID: <taskId|issueId>
     Status: <current status>

     ## Description
     <description markdown>
     ```
   - Opens the temp file with `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument`.
   - Tracks the temp file path in an in-memory map `_ticketTempEdits: Map<string, { provider, id, tempPath }>`.
   - **When the user clicks Save in the preview action bar:**
     - Reads the temp file content.
     - Parses the markdown to extract the description section (everything under `## Description`).
     - Calls existing service methods:
       - ClickUp: `ClickUpSyncService.updateTask(taskId, { name, description })`
       - Linear: `LinearSyncService.updateIssueDescription(issueId, description)` (for description) and `updateIssueState` (if status changed)
     - On success, cleans up the temp file and refreshes the ticket detail in the webview.

3. **Delete** — `deleteTicket`:
   - **Important:** Webviews cannot invoke `vscode.window.showWarningMessage`. The confirmation must be rendered natively in the webview.
   - When the user clicks Delete in the preview meta bar, render an inline confirmation banner inside `#preview-pane-tickets`:
     ```html
     <div class="delete-confirm-banner">
       Delete remote [ClickUp task / Linear issue] "<title>"? This cannot be undone.
       <button id="confirm-delete-ticket">Delete</button>
       <button id="cancel-delete-ticket">Cancel</button>
     </div>
     ```
   - On Cancel: hide the banner, no-op.
   - On Confirm: post `deleteTicketConfirmed` with `{ provider, id }`.
   - In `PlanningPanelProvider.ts`, handle `deleteTicketConfirmed` by calling the sync service:
     - ClickUp: `ClickUpSyncService.deleteTask(taskId)` (verify this method exists; if not, add a simple DELETE request wrapper)
     - Linear: `LinearSyncService.deleteIssue(issueId)` (verify/add)
   - On success, post `ticketDeleted` to the webview; the webview removes the ticket from `linearProjectIssues` / `clickUpTasks`, clears the preview pane, and re-renders the sidebar list.

4. **Change Status** — `changeTicketStatus`:
   - Accepts `{ provider, id, statusId }`.
   - ClickUp: `ClickUpSyncService.updateTask(taskId, { status: statusId })`
   - Linear: `LinearSyncService.updateIssueState(issueId, stateId)`
   - Refresh the ticket detail and sidebar to reflect the new state.

5. **Post Comment** — `postTicketComment`:
   - Accepts `{ provider, id, comment }`.
   - ClickUp: `ClickUpSyncService.addTaskComment(taskId, comment)`
   - Linear: `LinearSyncService.addIssueComment(issueId, comment)`
   - On success, append the new comment to the preview pane immediately (optimistic UI) and trigger a background refresh.

**Edge Cases:**
- Temp files that are never saved should auto-cleanup on extension deactivation.
- If a user edits a temp file, closes it without clicking Save, and later clicks Save from the preview pane, the system should re-read the temp file if it still exists or prompt the user to re-open.
- For Linear, `deleteIssue` may not exist yet — check before planning. If absent, add a `deleteIssue` GraphQL mutation wrapper.

---

### Phase 4: Attachment Download

**Files:** `planning.js`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`

**What:** Make attachment buttons clickable so they download to an auto-created subdirectory of the configured ticket folder (default: `.switchboard/plans/attachments/` or the user-configured `ticketsFolderPaths` + `/attachments/`).

**How:**
1. In `planning.js`:
   - Wire click handlers for `.tickets-attachment-item` in `renderTicketsLinearTaskDetail` and `renderTicketsClickUpTaskDetail`.
   - On click, post `downloadAttachment` with `{ provider, url, filename, ticketId, ticketTitle }`.
2. In `PlanningPanelProvider.ts`:
   - Add `case 'downloadAttachment':` that delegates to `TaskViewerProvider.downloadAttachment()`.
3. In `TaskViewerProvider.ts`:
   - Add `public async downloadAttachment(workspaceRoot, { provider, url, filename, ticketId, ticketTitle })`.
   - Resolve the target directory:
     - If `ticketsFolderPaths` is configured, use the first path + `/attachments/`.
     - Else fallback to `.switchboard/plans/attachments/`.
   - Create the directory with `fs.mkdirSync(..., { recursive: true })`.
   - If `filename` is missing, derive it from the URL path or use `attachment-<ticketId>-<timestamp>`.
   - Download the file using Node's `https.get` (or `axios` if already a dependency).
   - Save to the resolved path.
   - Show a VS Code info message: "Downloaded <filename> to <path>".
   - Post `attachmentDownloaded` to the webview so the UI can show a checkmark or "Downloaded" label.

**Edge Cases:**
- Some Linear attachment URLs may require authentication headers. The download must include the Linear API token in an `Authorization` header if the URL is a Linear asset URL.
- ClickUp attachment URLs are typically public signed URLs; no extra auth needed.
- If the download fails (network, 404), show an error message and do not create empty files.

---

### Phase 5: Dual Import Mode (Plan vs. Document)

**Files:** `planning.js`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`

**What:** Split the single `IMPORT` card action into two distinct actions:
1. **Import as Plan** — current behavior: creates a kanban plan, syncs, promotes to brain.
2. **Import as Document** — creates a **persistent** markdown file in the tickets folder for agent work, without creating a kanban entry or promoting to brain.

**How:**
1. In `planning.js`:
   - Replace the single `IMPORT` card button with two buttons:
     - `Import Plan` — `data-import-plan-id`
     - `Import Doc` — `data-import-doc-id`
   - Wire `data-import-plan-id` to the existing `handleTicketsImport(provider, id, includeSubtasks)` (mode: `plan`).
   - Wire `data-import-doc-id` to a new `handleTicketsImport(provider, id, includeSubtasks, mode: 'document')`.
2. In `PlanningPanelProvider.ts`:
   - The existing `linearImportTask` / `clickupImportTask` messages already support importing. Add an optional `mode` field to these messages.
   - If `mode === 'document'`, call `TaskViewerProvider.importTaskAsDocument()`.
3. In `TaskViewerProvider.ts`:
   - Add `public async importTaskAsDocument(workspaceRoot, { provider, id, includeSubtasks })`.
   - Fetch the ticket details (title, description, comments).
   - Format them into a markdown document (same structure as the Edit temp file).
   - Resolve the save location:
     - If `ticketsFolderPaths` is configured, save to the first path + `/documents/`.
     - Else fallback to `.switchboard/plans/documents/`.
   - Create the `documents/` subdirectory with `fs.mkdirSync(..., { recursive: true })`.
   - Save as a persistent `.md` file with a stable filename: `<provider>_<ticketId>_<slug>.md`.
   - Open the file in the editor.
   - Do NOT call `_createInitiatedPlan`, do NOT register in kanban DB, do NOT promote to brain.

**Edge Cases:**
- "Import as Document" should still support `includeSubtasks` — subtask titles should be listed in the document under a `## Subtasks` section.
- If the user later decides they want the document as a plan, they can use the existing "Move to Kanban" or manual import flow.

---

### Phase 6: Remove / Refine "Ask Agent" vs "Refine" Ambiguity

**Files:** `planning.js`, `PlanningPanelProvider.ts`

**What:** The current "ASK AGENT" and "REFINE" buttons are nearly identical. Consolidate them into a single "Ask Agent" action that supports two modes: **Refine** (suggest improvements) and **Agent Chat** (open a chat session about this ticket).

**How:**
1. In `planning.js`:
   - Replace both buttons with a single `ASK AGENT` button.
   - On click, open a small inline dropdown or modal with two options:
     - "Refine this ticket" — sends the ticket title/description to the planner agent for suggestions.
     - "Chat about this ticket" — opens the existing agent chat panel scoped to this ticket.
   - If the agent chat panel is not yet implemented, keep only "Refine" as the single action and rename the button to `REFINE`.
2. In `PlanningPanelProvider.ts`:
   - The existing `ticketsAskAgent` and `linearRefineTask` / `clickupRefineTask` handlers can be consolidated or left as-is if they already call the same underlying agent.

**Alternative (simpler):** Just remove "ASK AGENT" and keep "REFINE" as the single agent-facing action, since both currently do the same thing. Add a tooltip or label clarifying that "Refine" sends the ticket to the planner agent.

**Decision:** Remove the redundant button. Keep only `REFINE` on each card. The preview action bar's `Edit` button handles the user's in-place editing need.

---

### Phase 7: UI Polish & State Consistency

**Files:** `planning.js`, `planning.html`

**What:** Ensure the tickets tab behaves consistently with the Kanban tab and other planning views.

**How:**
1. **Loading States:** When any async operation is in flight (import all, status change, delete, comment), show a spinner overlay on the preview pane and disable the action buttons.
2. **Empty States:** If no ticket is selected, the preview pane should show a helpful message: "Select a ticket from the sidebar to view details and take actions."
3. **Keyboard Shortcuts:** Consider adding a VS Code command palette command for "Import All Visible Tickets" so power users don't need to click.
4. **Error Handling:** All backend operations should return `{ success, error? }` and the webview should render inline error banners in the preview pane (not just console logs).

---

## Files to Modify

- `src/webview/planning.html` — add sidebar buttons, preview meta bar, comment input, confirmation modal markup
- `src/webview/planning.js` — wire all new UI elements, handle new message types, dual import mode, attachment clicks
- `src/services/PlanningPanelProvider.ts` — add message handler cases for all new operations
- `src/services/TaskViewerProvider.ts` — add `importAllTasks`, `importTaskAsDocument`, `editTicketDocument`, `pushTicketEdits`, `deleteTicket`, `changeTicketStatus`, `postTicketComment`, `downloadAttachment`
- `src/services/LocalFolderService.ts` — extend config interface and methods for `ticketsFolderPaths`
- `src/services/LinearSyncService.ts` — verify/add `deleteIssue` if missing
- `src/services/ClickUpSyncService.ts` — verify/add `deleteTask` if missing

## Verification

1. Open the planning view → Tickets tab.
2. Verify "Manage Folders" button opens the folder modal and persists `ticketsFolderPaths` to `local-folder-config.json`.
3. Verify "Import All" imports every ticket in the filtered sidebar and shows a progress + completion toast.
4. Select a ticket → verify the preview meta bar renders with Edit, Save, Delete, Status, Comment buttons.
5. Click Edit → verify a temp markdown file opens in the editor.
6. Edit the temp file, click Save → verify the remote ticket description updates.
7. Click Delete → verify a confirmation dialog appears, and on confirm the remote ticket is deleted and removed from the sidebar.
8. Click Status → verify a dropdown of available statuses appears, and selecting one updates the remote ticket.
9. Click Comment → verify an inline input appears, and posting adds a comment to the remote ticket.
10. Click an attachment → verify it downloads to `<ticketFolder>/attachments/`.
11. Verify "Import as Plan" creates a kanban entry; "Import as Document" opens a temp file without creating a kanban entry.
12. Verify only one agent action button (`REFINE`) remains on each sidebar card.
