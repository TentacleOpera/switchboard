# ClickUp/Linear Ticket Tab Overhaul

## Goal

Overhaul the ClickUp/Linear tickets tab in Switchboard's planning view to resolve UX friction points: missing folder management, no bulk import, no preview action bar, non-functional attachments, and an unclear distinction between "Ask Agent" and "Refine." The tab should support two import modes (plan vs. document), in-place editing with write-back to remote, and full preview actions aligned with the Kanban tab pattern.

## Metadata

- **Complexity:** 6
- **Tags:** feature, ui, ux, api, backend

## Problem Analysis

1. **Folder Management Gap:** Users cannot configure where imported tickets are saved. Other tabs (local docs, design docs) expose a "manage folder" button backed by `LocalFolderService` and `local-folder-config.json`, but the tickets tab lacks this entirely.

2. **No Bulk Import:** The sidebar lists dozens of tickets, yet each must be imported one-by-one via the `IMPORT` card action. There is no mechanism to import the currently filtered sidebar set in one operation.

3. **No Preview Action Bar:** The Kanban plans tab exposes an inline meta bar (`renderKanbanMetaBar`) with edit, save, cancel, delete, and column-change controls. The tickets preview pane is read-only — no edit, push, delete, status change, or comment posting.

4. **Broken Attachments:** `renderTicketsLinearTaskDetail` and `renderTicketsClickUpTaskDetail` render attachments as `<button>` elements with `data-*-attachment-url`, but no click handler is wired. The buttons are dead UI.

5. **Ambiguous Agent Actions:** "ASK AGENT" and "REFINE" on ticket cards both dispatch to a planner agent. Users cannot tell the difference, and neither mode supports editing the ticket and pushing changes back.

6. **Editing Workflow Mismatch:** Users expect to edit an online ticket in place. The current flow forces manual import (creates a kanban plan, triggers sync, promotes to brain) before any editing is possible.

## User Review Required

- Confirm default fallback path for ticket imports when no `ticketsFolderPaths` is configured (current proposal: `.switchboard/plans/`).
- Confirm whether to fully consolidate "Ask Agent" / "Refine" into a single `REFINE` button, or preserve a dropdown with "Refine this ticket" and "Chat about this ticket".
- Confirm document markdown format (frontmatter + body) is acceptable for agent workflows.
- Confirm destructive action UX for delete: native dialog vs. webview confirmation banner requiring typed ticket name.

## Complexity Audit

### Routine
- Extending `LocalFolderPathsConfig` and `LocalFolderService` with `ticketsFolderPaths` getters, setters, and migration helpers.
- Adding `Manage Folders` and `Import All` buttons to `planning.html` and wiring clicks in `planning.js`.
- Adding attachment click handlers in `planning.js` that post `downloadAttachment` messages.
- Consolidating redundant "ASK AGENT" / "REFINE" buttons into a single action.
- Adding empty-state and loading-state UI overlays in the preview pane.

### Complex / Risky
- **Document-to-remote push lifecycle:** `pushTicketEdits` must reliably locate the persistent `.md` file, strip frontmatter, and push the body back to the remote ticket. File may be moved or deleted externally.
- **Bulk import rate limiting:** Iterating over filtered ticket IDs and calling `importLinearTask`/`importClickUpTask` sequentially without throttling risks 429s from Linear and ClickUp.
- **Webview destructive confirmation:** Webviews are not trusted UI surfaces. A delete confirmation banner inside the webview is vulnerable to clickjacking and script injection.
- **Modal scope refactor:** `openFoldersModal()` currently takes zero arguments. Adding a scope parameter requires ensuring Local Docs, HTML Docs, and Design Docs tabs continue to work unchanged.
- **Attachment auth detection:** Linear asset URLs may or may not require an `Authorization` header. No documented URL pattern guarantees safe detection logic.

## Edge-Case & Dependency Audit

### Race Conditions
- Two rapid "Import All" clicks could spawn overlapping batch operations. UI must disable the button and track an `isImportingAll` flag.
- Document Push race: user edits document, hits Ctrl+S, then clicks Push in the preview bar while the file watcher may also trigger sync. The push operation must be idempotent and not conflict with the existing sync pipeline.
- Concurrent `changeTicketStatus` calls on the same ticket from two VS Code windows (if workspace is shared) may cause last-write-wins conflicts on the remote.

### Security
- `downloadAttachment` resolves a target directory from `ticketsFolderPaths`. Must validate the resolved path is within the configured folder to prevent path traversal.
- Persistent documents in `ticketsFolderPaths` may contain ticket descriptions with PII. Ensure the folder location is not world-readable and documents are excluded from version control.
- Delete confirmation in webview: if the webview is compromised via XSS, an attacker could trigger `deleteTicketConfirmed`. The backend handler should re-validate that the ticket still exists and belongs to the expected provider before calling the sync service.

### Side Effects
- Adding `ticketsFolderPaths` to `local-folder-config.json` triggers migration from legacy global settings (see `_migratedLocal` pattern). Ensure `_migratedTickets` flag is added to avoid double-migration.
- `importTaskAsDocument` creates persistent `.md` files that are not tracked in kanban DB or brain. Users may accumulate stale documents. Consider a 30-day stale-cleanup on extension startup.
- `importAllTasks` may create dozens of kanban plan entries and brain promotions. This could flood the kanban DB and trigger sync storms if real-time sync is enabled.

### Dependencies & Conflicts
- **Blocked by:** `LinearSyncService.archiveIssue` and `ClickUpSyncService.archiveTask` must be verified callable for delete operations. True hard-delete is not supported by Linear's public API.
- **Conflicts with:** Any in-flight work on `PlanningPanelProvider.ts` message handler routing (e.g., new chat-panel integration) may collide with the new `editTicket`, `pushTicket`, `postTicketComment` handlers.
- **Requires:** Existing `renderKanbanMetaBar` pattern in `planning.js` must remain stable so the new `tickets-preview-meta-bar` can mirror it.

## Dependencies

- `sess_clickup_linear_api_throttling` — Bulk import and rapid status changes need a shared throttling / rate-limit utility to avoid provider 429s.
- `sess_webview_native_dialog_bridge` — If the team decides webview confirmation is insufficient, a bridge to invoke `vscode.window.showWarningMessage` from the webview must be built first.
- `sess_document_sync_bridge` — A lightweight bridge to re-use the existing kanban sync pipeline for document-only plans would reduce `pushTicketEdits` to a file-read + sync trigger rather than a separate API call path.

## Adversarial Synthesis

Key risks: (1) persistent document may diverge from remote ticket if the user edits it but never clicks Push; (2) webview-based delete confirmation lacks the security guarantees of a native VS Code dialog; (3) bulk import without throttling will hit provider rate limits. Mitigations: show a visual "unsynced changes" indicator when the document mtime is newer than the last push, implement a 200ms stagger between bulk imports with a concurrency cap of 3, and require typing the ticket name in the webview delete confirmation to raise the friction bar.

## Proposed Changes

### Phase 1: Sidebar Enhancements

#### 1.1 Add "Manage Ticket Folder" Button

**Files:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/LocalFolderService.ts`

**What:** Add a "Manage Folder" button to the tickets sidebar (next to Refresh). This button opens the existing folder-selection modal but scoped to a new config key: `ticketsFolderPaths` in `local-folder-config.json`.

**Why:** `LocalFolderService` already manages `localFolderPaths`, `htmlFolderPaths`, and `designFolderPaths`. Adding `ticketsFolderPaths` uses the proven pattern without new UI complexity.

**How:**
1. In `LocalFolderService.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalFolderService.ts:13`):
   - Extend `LocalFolderPathsConfig` interface to include `ticketsFolderPaths: string[]`.
   - Add `getTicketsFolderPaths(): string[]` method reading from config (mirror `getHtmlFolderPaths` at line 346).
   - Update `loadFolderPathsConfig` (line 88) and `saveFolderPathsConfig` (line 105) to handle the new field.
   - Add `_migratedTickets` migration flag (follow `_migratedHtml` / `_migratedDesign` pattern at lines 366 and 553).
2. In `planning.html` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html:3126`):
   - Add `<button id="btn-manage-ticket-folders" class="strip-btn">Manage Folders</button>` inside `#controls-strip-tickets`.
3. In `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`):
   - Add `btnManageTicketFolders` to `getTicketsTabElements()`.
   - Wire click to `openFoldersModal('tickets-folder')` (reusing `openFoldersModal` at line 4570 but passing a scope parameter to filter which folder paths are shown/editable).
   - When the modal saves, post a new message type `saveTicketsFolderPaths`.
4. In `PlanningPanelProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`):
   - Handle `saveTicketsFolderPaths` by delegating to `LocalFolderService.saveFolderPathsConfig`.
   - On subsequent `refreshSource` (line 1183), include `ticketsFolderPaths` in the `folderPathsByRoot` payload (line 3241) so the UI knows whether a folder is configured.

**Edge Cases:**
- If no ticket folder is configured, the default `.switchboard/plans/` should remain the fallback for "import as plan" operations.
- Multi-root workspaces: each root may have its own `ticketsFolderPaths`; the modal must scope to the currently selected workspace root.

---

#### 1.2 Add "Import All" Button to Sidebar

**Files:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts`

**What:** Add an "Import All" button to `#controls-strip-tickets` that imports every ticket currently visible in the sidebar (respecting active search + status/project filters) as plans.

**How:**
1. In `planning.html` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html:3126`):
   - Add `<button id="btn-import-all-tickets" class="strip-btn">Import All</button>` inside `#controls-strip-tickets`.
2. In `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`):
   - Add `importAllButton` to `getTicketsTabElements()`.
   - Compute the list of currently visible ticket IDs from `getFilteredLinearIssues()` (line 4907) or `getFilteredClickUpTasks()` (line 5329) depending on active provider.
   - On click, post `importAllTickets` message with `{ provider, issueIds[] / taskIds[], workspaceRoot, importMode: 'plan' }`.
   - Show a progress indicator (reuse existing skeleton/loading state at line ~3147) because bulk import may take 5–30 seconds for large lists.
   - Set an `isImportingAll` flag to prevent duplicate clicks.
3. In `PlanningPanelProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`):
   - Add `case 'importAllTickets':` that calls `TaskViewerProvider.importAllTasks()`.
4. In `TaskViewerProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`):
   - Add `public async importAllTasks(workspaceRoot, { provider, ids, importMode })`.
   - Iterate over `ids`, calling `importLinearTask` (line 4409) or `importClickUpTask` (line 4479) for each.
   - **Throttle:** wait 200ms between calls; cap concurrency at 3 in-flight to avoid provider rate limits.
   - Wrap each call in try/catch so one failure doesn't abort the whole batch.
   - Collect results and return `{ successCount, failCount, errors[] }`.
   - After completion, post `importAllTicketsComplete` to the webview so the sidebar can clear the loading state and show a summary toast.

**Edge Cases:**
- Clicking "Import All" when no tickets match the current filter should be a no-op with a visible "No tickets to import" toast.
- Partial failures: the summary toast must list which IDs failed and why.

---

### Phase 2: Preview Pane Inline Action Bar

#### 2.1 Add Action Bar to Tickets Preview

**Files:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`

**What:** Render an inline button strip at the top of `#preview-pane-tickets` (mirroring `kanban-preview-meta-bar` at line 3966) with these controls:
- **Edit** — opens the ticket as a persistent document for editing
- **Push** — pushes the saved document back to ClickUp/Linear
- **Delete** — archives the remote ticket (with confirmation banner)
- **Status** — dropdown to change the ticket's status/state
- **Comment** — opens a small inline textarea + "Post" button to add a comment

**How:**
1. In `planning.html` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html:3145`):
   - Add a new `<div id="tickets-preview-meta-bar" class="kanban-preview-meta-bar" style="display:none;">` inside `#preview-pane-tickets`.
   - Inside it, add buttons: `#btn-edit-ticket`, `#btn-push-ticket`, `#btn-delete-ticket`, `#btn-change-status-ticket`, `#btn-comment-ticket`.
2. In `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`):
   - In `renderTicketsLinearTaskDetail` (line 4996) and `renderTicketsClickUpTaskDetail` (line 5398), show the meta bar when an issue/task is selected.
   - Disable/enable buttons based on state:
     - If no document is open for this ticket: `Edit` enabled, `Push` enabled (if document exists), `Delete` enabled, `Status` enabled, `Comment` enabled.
     - If document is currently open in editor: `Edit` disabled, `Push` enabled.
   - Wire click handlers:
     - `Edit` → `handleTicketEdit(provider, id)`
     - `Push` → `handleTicketPush(provider, id)`
     - `Delete` → `handleTicketDelete(provider, id)` (shows confirmation banner)
     - `Status` → `handleTicketChangeStatus(provider, id, newStatus)`
     - `Comment` → toggles visibility of an inline comment input + post button
3. In `PlanningPanelProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`):
   - Add message handlers: `editTicket`, `pushTicket`, `deleteTicket`, `changeTicketStatus`, `postTicketComment`.
   - Each delegates to existing `TaskViewerProvider` methods (see Phase 3).

---

### Phase 3: Backend Commands for Write Operations

**Files:** `src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`

**What:** Register or wire VS Code commands for the new preview actions. Most underlying service methods already exist; this phase is about exposing them to the webview.

**How:**

1. **Edit (open as persistent document)** — `editTicketDocument`:
   - Accepts `{ provider, id, title, description }`.
   - Calls `TaskViewerProvider.importTaskAsDocument()` (Phase 5) to create or reuse a persistent `.md` file in the tickets folder.
   - Opens the file with `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument`.
   - The user edits the file normally with Ctrl+S; no special save handling required.

3. **Push (write document back to remote)** — `pushTicketEdits`:
   - Accepts `{ provider, id }`.
   - Reads the persistent `.md` file created by `importTaskAsDocument`.
   - Extracts the description from the document body (everything after frontmatter, or full body if no frontmatter present). Use a lightweight frontmatter stripper; do not use regex for section boundaries.
   - Calls existing service methods:
     - ClickUp: `ClickUpSyncService.updateTask(taskId, { name, description })` (line 1333)
     - Linear: `LinearSyncService.updateIssueDescription(issueId, description)` (line 1115) and `updateIssueState` (line 969) if status changed
   - On success, refreshes the ticket detail in the webview.

4. **Delete** — `deleteTicket`:
   - **Important:** Webviews cannot invoke `vscode.window.showWarningMessage`. The confirmation is rendered in the webview with elevated friction.
   - When the user clicks Delete in the preview meta bar, render an inline confirmation banner inside `#preview-pane-tickets`:
     ```html
     <div class="delete-confirm-banner">
       Type the ticket title to confirm deletion: <input id="delete-confirm-input" />
       <button id="confirm-delete-ticket" disabled>Delete</button>
       <button id="cancel-delete-ticket">Cancel</button>
     </div>
     ```
   - Enable the Delete button only when the typed text exactly matches the ticket title.
   - On Cancel: hide the banner, no-op.
   - On Confirm: post `deleteTicketConfirmed` with `{ provider, id }`.
   - In `PlanningPanelProvider.ts`, handle `deleteTicketConfirmed` by calling the sync service:
     - ClickUp: `ClickUpSyncService.archiveTask(taskId)` (line 1413 — performs a DELETE via HTTP)
     - Linear: `LinearSyncService.archiveIssue(issueId)` (line 1149 — sets `archivedAt` via GraphQL)
   - On success, post `ticketDeleted` to the webview; the webview removes the ticket from `linearProjectIssues` / `clickUpTasks`, clears the preview pane, and re-renders the sidebar list.

5. **Change Status** — `changeTicketStatus`:
   - Accepts `{ provider, id, statusId }`.
   - ClickUp: `ClickUpSyncService.updateTask(taskId, { status: statusId })` (line 1333)
   - Linear: `LinearSyncService.updateIssueState(issueId, stateId)` (line 969)
   - Refresh the ticket detail and sidebar to reflect the new state.

6. **Post Comment** — `postTicketComment`:
   - Accepts `{ provider, id, comment }`.
   - ClickUp: `ClickUpSyncService.addTaskComment(taskId, comment)` (line 1380)
   - Linear: `LinearSyncService.addIssueComment(issueId, comment)` (line 1003)
   - On success, append the new comment to the preview pane immediately (optimistic UI) and trigger a background refresh.

**Edge Cases:**
- If the document file was deleted externally, `pushTicketEdits` should show a clear error: "Document file not found. Re-open with Edit."
- Linear does not expose a hard-delete mutation via public API; `archiveIssue` is the correct operation.

---

### Phase 4: Attachment Download

**Files:** `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts`

**What:** Make attachment buttons clickable so they download to an auto-created subdirectory of the configured ticket folder (default: `.switchboard/plans/attachments/` or the user-configured `ticketsFolderPaths` + `/attachments/`).

**How:**
1. In `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`):
   - Wire click handlers for `.tickets-attachment-item` in `renderTicketsLinearTaskDetail` (line 4996) and `renderTicketsClickUpTaskDetail` (line 5398).
   - On click, post `downloadAttachment` with `{ provider, url, filename, ticketId, ticketTitle }`.
2. In `PlanningPanelProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`):
   - Add `case 'downloadAttachment':` that delegates to `TaskViewerProvider.downloadAttachment()`.
3. In `TaskViewerProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`):
   - Add `public async downloadAttachment(workspaceRoot, { provider, url, filename, ticketId, ticketTitle })`.
   - Resolve the target directory:
     - If `ticketsFolderPaths` is configured, use the first path + `/attachments/`.
     - Else fallback to `.switchboard/plans/attachments/`.
   - Validate the resolved path is within the configured folder (path traversal guard).
   - Create the directory with `fs.mkdirSync(..., { recursive: true })`.
   - If `filename` is missing, derive it from the URL path or use `attachment-<ticketId>-<timestamp>`.
   - Download the file using Node's `https.get` (or `axios` if already a dependency).
   - Save to the resolved path.
   - Show a VS Code info message: "Downloaded <filename> to <path>".
   - Post `attachmentDownloaded` to the webview so the UI can show a checkmark or "Downloaded" label.

**Edge Cases:**
- Some Linear attachment URLs may require authentication headers. The download must include the Linear API token in an `Authorization` header if the URL is a Linear asset URL. **Clarification:** URL detection logic should be conservative — only inject the token for URLs matching `*.linear.app` or `linear-asset-*` patterns; signed S3 URLs must not receive extra headers.
- ClickUp attachment URLs are typically public signed URLs; no extra auth needed.
- If the download fails (network, 404), show an error message and do not create empty files.

---

### Phase 5: Dual Import Mode (Plan vs. Document)

**Files:** `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts`

**What:** Split the single `IMPORT` card action into two distinct actions:
1. **Import as Plan** — current behavior: creates a kanban plan, syncs, promotes to brain.
2. **Import as Document** — creates a **persistent** markdown file in the tickets folder for agent work, without creating a kanban entry or promoting to brain.

**How:**
1. In `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`):
   - Replace the single `IMPORT` card button with two buttons:
     - `Import Plan` — `data-import-plan-id`
     - `Import Doc` — `data-import-doc-id`
   - Wire `data-import-plan-id` to the existing `handleTicketsImport(provider, id, includeSubtasks)` (mode: `plan`) at line 5537.
   - Wire `data-import-doc-id` to a new `handleTicketsImport(provider, id, includeSubtasks, mode: 'document')`.
2. In `PlanningPanelProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`):
   - The existing `linearImportTask` / `clickupImportTask` messages already support importing. Add an optional `mode` field to these messages.
   - If `mode === 'document'`, call `TaskViewerProvider.importTaskAsDocument()`.
3. In `TaskViewerProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`):
   - Add `public async importTaskAsDocument(workspaceRoot, { provider, id, includeSubtasks })`.
   - Fetch the ticket details (title, description, comments).
   - Format them into a markdown document (same frontmatter + body structure as the Edit document).
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
- Persistent documents may accumulate. Consider a 30-day stale-cleanup on extension startup.

---

### Phase 6: Remove / Refine "Ask Agent" vs "Refine" Ambiguity

**Files:** `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`

**What:** The current "ASK AGENT" and "REFINE" buttons are nearly identical. Consolidate them into a single "Ask Agent" action that supports two modes: **Refine** (suggest improvements) and **Agent Chat** (open a chat session about this ticket).

**How:**
1. In `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`):
   - Replace both buttons with a single `ASK AGENT` button.
   - On click, open a small inline dropdown or modal with two options:
     - "Refine this ticket" — sends the ticket title/description to the planner agent for suggestions.
     - "Chat about this ticket" — opens the existing agent chat panel scoped to this ticket.
   - If the agent chat panel is not yet implemented, keep only "Refine" as the single action and rename the button to `REFINE`.
2. In `PlanningPanelProvider.ts` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`):
   - The existing `ticketsAskAgent` (line 2539) and `linearRefineTask` (line 2471) / `clickupRefineTask` (line 2505) handlers can be consolidated or left as-is if they already call the same underlying agent.

**Alternative (simpler):** Just remove "ASK AGENT" and keep "REFINE" as the single agent-facing action, since both currently do the same thing. Add a tooltip or label clarifying that "Refine" sends the ticket to the planner agent.

**Decision:** Remove the redundant button. Keep only `REFINE` on each card. The preview action bar's `Edit` button handles the user's in-place editing need.

---

### Phase 7: UI Polish & State Consistency

**Files:** `src/webview/planning.js`, `src/webview/planning.html`

**What:** Ensure the tickets tab behaves consistently with the Kanban tab and other planning views.

**How:**
1. **Loading States:** When any async operation is in flight (import all, status change, delete, comment), show a spinner overlay on the preview pane and disable the action buttons. Reuse `#tickets-loading-state` spinner at line ~3147.
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
- `src/services/LinearSyncService.ts` — verify `archiveIssue` (line 1149) is callable for delete operations
- `src/services/ClickUpSyncService.ts` — verify `archiveTask` (line 1413) is callable for delete operations

## Verification Plan

### Automated Tests

- **Config round-trip:** Test `LocalFolderService.saveFolderPathsConfig` and `loadFolderPathsConfig` with `ticketsFolderPaths` to ensure persistence and migration flags work.
- **Message routing:** Unit-test `PlanningPanelProvider` message handler dispatch for `saveTicketsFolderPaths`, `importAllTickets`, `editTicket`, `pushTicket`, `deleteTicketConfirmed`, `changeTicketStatus`, `postTicketComment`, `downloadAttachment`.
- **Bulk import throttling:** Mock `importLinearTask`/`importClickUpTask` and assert that `importAllTasks` staggers calls with 200ms delay and concurrency cap of 3.
- **Path traversal guard:** Test `downloadAttachment` rejects resolved paths that escape the configured `ticketsFolderPaths`.
- **Delete confirmation friction:** Assert webview renders title-match input and only enables Confirm when text matches ticket title exactly.
- **Document push resilience:** Test `pushTicketEdits` when the persistent `.md` file is missing, has no frontmatter, or has empty body — verify graceful error messages rather than silent failure.

### Manual Verification

1. Open the planning view → Tickets tab.
2. Verify "Manage Folders" button opens the folder modal and persists `ticketsFolderPaths` to `local-folder-config.json`.
3. Verify "Import All" imports every ticket in the filtered sidebar and shows a progress + completion toast.
4. Select a ticket → verify the preview meta bar renders with Edit, Push, Delete, Status, Comment buttons.
5. Click Edit → verify a persistent markdown document opens in the editor.
6. Edit the document, click Push → verify the remote ticket description updates.
7. Click Delete → verify a confirmation banner requiring typed ticket title appears, and on confirm the remote ticket is archived and removed from the sidebar.
8. Click Status → verify a dropdown of available statuses appears, and selecting one updates the remote ticket.
9. Click Comment → verify an inline input appears, and posting adds a comment to the remote ticket.
10. Click an attachment → verify it downloads to `<ticketFolder>/attachments/`.
11. Verify "Import as Plan" creates a kanban entry; "Import as Document" opens a persistent markdown file without creating a kanban entry.
12. Verify only one agent action button (`REFINE`) remains on each sidebar card.

## Recommendation

**Send to Coder.**

Complexity is 6 — multi-file coordination across webview UI, VS Code extension host, and two third-party APIs. No new architectural patterns; the persistent document approach reuses existing file I/O and sync primitives. Bulk-import throttling and webview security for destructive actions are the primary remaining risks.
