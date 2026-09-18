# Fix Attachment Download Path and UI Improvements

## Goal
Fix attachment download logic to mirror ticket folder structure and improve the attachment viewing experience in the planning.html tickets tab.

### Core Problems
1. **Wrong attachment download path**: Attachments download to a flat `/attachments/` subfolder instead of mirroring the ticket's provider hierarchy structure
2. **Wrong fallback path**: When no tickets folder is configured, attachments fall back to `.switchboard/plans/attachments/` instead of `.switchboard/tickets/provider/attachments/`
3. **Poor UX**: No way to view attachments without downloading them first, and downloads trigger an annoying VS Code toast message
4. **Inconsistent structure**: Tickets save to `<tickets-folder>/clickup/space/folder/list/` but attachments save to `<tickets-folder>/attachments/` (no hierarchy)

### Background Context
The ticket saving logic in `TaskViewerProvider.ts` correctly uses provider hierarchy:
- ClickUp: `<tickets-folder>/clickup/space-name/folder-name/list-name/`
- Linear: `<tickets-folder>/linear/team-name/project-name/`
- Fallback: `.switchboard/tickets/clickup/` or `.switchboard/tickets/linear/`

However, the `downloadAttachment` method (line 17822) ignores this structure and uses a flat `/attachments/` path with the wrong fallback (`.switchboard/plans/attachments/`).

## Metadata

**Tags:** ui, bugfix, refactor

**Complexity:** 6

## User Review Required
- [ ] **Fallback vs error behavior**: The original requirements mention fallback to `.switchboard/tickets/provider/attachments/` when no tickets folder is configured, but also say to return an error instead of using the wrong fallback. Confirm the final behavior is **return a clear error and do NOT fallback**.
- [ ] **`_findTicketDocument` duplication**: The plan extracts a path builder from `_saveTicketDocument` but `_findTicketDocument` (lines 17418–17470) duplicates the same hierarchy assembly. Confirm whether it should also be refactored to use the new helper.

## Complexity Audit

### Routine
- Remove single `vscode.window.showInformationMessage` toast line (`TaskViewerProvider.ts:17906`).
- Add HTML button and modal skeleton reusing existing `.folder-modal` CSS classes.
- Add three message handlers in `PlanningPanelProvider.ts` following existing `downloadAttachment` pattern.
- Add `getAttachmentList` method that maps URLs to local paths with `fs.existsSync`.

### Complex / Risky
- Extracting a shared hierarchy path builder that works for both `_saveTicketDocument` (cached UI state: `getSelectedHierarchy()`, `getTeamName()`) and `_findTicketDocument` (live API lookup: `httpRequest`, `getIssue`) without adding unwanted network calls or breaking document discovery.
- Ensuring `TaskViewerProvider` can resolve local attachment paths without relying on UI-stateful `getSelectedHierarchy()` when the user may have changed selections after loading the ticket.
- Providing a clean data path for `getAttachmentList`: `TaskViewerProvider` has no cached ticket attachment store, so the webview must send the attachment list in the message payload.

## Edge-Case & Dependency Audit

### Race Conditions
- Multiple rapid attachment downloads for the same ticket race on `fs.mkdirSync` (mitigated by `recursive: true`) and filename collision logic.

### Security
- Path traversal check at `TaskViewerProvider.ts:17841–17845` must be preserved and re-validated after `baseFolder` changes to the hierarchy path. The check must ensure `resolvedTargetDir` stays within `resolvedBaseFolder`.
- Attachment URLs from external providers must not be logged or rendered unsanitized in HTML.

### Side Effects
- Existing attachments in the old flat `/attachments/` path will be orphaned; no automatic migration.
- `getAttachmentList` performs synchronous `fs.existsSync` checks for every attachment; large lists could briefly block the event loop.

### Dependencies & Conflicts
- No conflicting plans identified.

## Dependencies
- None identified.

## Adversarial Synthesis
Key risks: (1) Extracting a unified hierarchy path helper is complicated by the fact that `_saveTicketDocument` uses cached UI selection while `_findTicketDocument` fetches live API data; a naive extraction will break document discovery or add unwanted API calls. (2) `TaskViewerProvider` has no cached ticket attachment store, so `getAttachmentList` either needs the webview to send the list or must re-fetch from the provider API. (3) The original plan's `_getTicketHierarchyPath` signature does not account for the differing data sources. Mitigations: expose a path builder that accepts pre-resolved hierarchy metadata; have the webview send the attachment payload to the extension; keep `_findTicketDocument`'s live lookup intact by passing metadata explicitly.

## Requirements

### 1. Fix Attachment Download Path
- **When tickets folder is configured**: Attachments must save to the same hierarchy as the ticket
  - ClickUp: `<tickets-folder>/clickup/space/folder/list/attachments/`
  - Linear: `<tickets-folder>/linear/team/project/attachments/`
- **When no tickets folder configured**: Return a clear error message instead of using any fallback
- **Error handling**: If no tickets folder is configured, return `{ success: false, error: 'No tickets folder configured. Please set a tickets folder in Switchboard settings.' }`

### 2. Add View Attachments Control
- Add a button in the ticket detail header (`tickets-preview-meta-bar`) next to the Comment button
- Use existing `.strip-btn` styling for consistency
- When clicked, show a modal with attachment list
- For each attachment, provide:
  - "Open" button (opens in default application)
  - "Reveal" button (shows in VS Code file explorer)
  - "Download" button (if not already downloaded)
  - File path indicator (if already downloaded)
- Only show the button when a ticket with attachments is selected

### 3. Remove Toast Message
- Remove the `vscode.window.showInformationMessage` toast that appears on every download
- Replace with a subtle status indicator in the preview pane footer
- Display: "Attachment downloaded to: /path/to/file" in small text

## Proposed Changes

### src/services/TaskViewerProvider.ts
**Context:** Contains `downloadAttachment`, `_saveTicketDocument`, `_findTicketDocument`, and `_slugify`.

**Logic:**
1. **Create a pure path-builder helper** (rather than a monolithic `_getTicketHierarchyPath`):
   - Add `private _buildTicketDir(resolvedRoot: string, provider: string, segments: string[]): string | null`
   - It reads `localFolderService.getTicketsFolderPaths()`, and if a tickets folder exists returns `path.join(ticketsFolders[0], provider, ...segments.map(s => this._slugify(s).slice(0, 60)))`.
   - If no tickets folder is configured, return `null` so callers can error out.
   - **Clarification:** This avoids forcing a single data source for hierarchy names; each caller gathers its own names and passes them as `segments`.

2. **Update `downloadAttachment` (line 17822–17911):**
   - Gather hierarchy metadata:
     - **ClickUp**: Use `clickUp.getSelectedHierarchy()` to get `spaceName`, `folderName`, `listName`.
     - **Linear**: Use `linear.getTeamName()` and fetch the issue via `linear.getIssue(ticketId)` to get `projectName`.
   - Build the base directory:
     ```ts
     const baseDir = this._buildTicketDir(resolvedRoot, provider, [spaceName, folderName, listName].filter(Boolean));
     // or for Linear: [teamName, projectName]
     ```
   - If `baseDir` is `null`, return the "No tickets folder configured" error.
   - Set `targetDir = path.join(baseDir, 'attachments')`.
   - Preserve existing path traversal check (lines 17841–17845) using `targetDir` and `baseDir`.
   - Remove toast at line 17906; return `{ success: true, filePath: targetFilePath }`.

3. **Update `_saveTicketDocument` (lines 17367–17406):**
   - Replace inline `path.join(...parts)` logic with a call to `_buildTicketDir` using the same cached hierarchy names.

4. **Update `_findTicketDocument` (lines 17418–17470):**
   - **Clarification:** This method fetches live API data (`clickUp.httpRequest`, `linear.getIssue`) to get accurate hierarchy names. After extracting `_buildTicketDir`, replace its inline `path.join(...parts)` logic with a call to `_buildTicketDir(resolvedRoot, provider, [spaceName, folderName, listName])` or `[teamName, projectName]`.

5. **Add `public async getAttachmentList(workspaceRoot, provider, ticketId, attachmentsArray)`:**
   - Compute `baseDir` via `_buildTicketDir` using the same hierarchy metadata as `downloadAttachment`.
   - If `baseDir` is `null`, return an empty array or error.
   - Map over `attachmentsArray`:
     - Derive `filename` from `attachment.title`, `attachment.filename`, or URL basename.
     - Compute `localPath = path.join(baseDir, 'attachments', filename)`.
     - Check `fs.existsSync(localPath)` to set `isDownloaded`.
   - Returns: `[{ filename, url, localPath, isDownloaded }]`.

**Edge Cases:**
- Filename collisions: append `-${Date.now()}` before extension if file exists.
- Missing hierarchy info: if `_buildTicketDir` returns `null`, return error rather than falling back to a flat path.
- Cross-platform paths: use `path.join` and `path.resolve` throughout.

### src/services/PlanningPanelProvider.ts
**Context:** Webview message router (`downloadAttachment` handler at lines 2842–2867).

**Logic:**
1. **Add `case 'viewAttachments'` after `downloadAttachment` (around line 2867):**
   - Expect `msg.attachments` array from the webview (avoids re-fetching from provider API).
   - Call `taskViewerProvider.getAttachmentList(workspaceRoot, provider, ticketId, msg.attachments)`.
   - Post `{ type: 'attachmentsListResult', attachments: [...] }` back to webview.

2. **Add `case 'openAttachment'`:**
   - Resolve `msg.localPath` to `vscode.Uri.file(msg.localPath)`.
   - Use `await vscode.env.openExternal(uri)` to open in the OS default application.
   - Post `{ type: 'attachmentOpened', success: true }`.

3. **Add `case 'revealAttachment'`:**
   - Resolve `msg.localPath` to `vscode.Uri.file(msg.localPath)`.
   - Use `await vscode.commands.executeCommand('revealInExplorer', uri)`.
   - Post `{ type: 'attachmentRevealed', success: true }`.

4. **Update `case 'downloadAttachment'` (line 2842):**
   - On success, include `filePath: result.filePath` in the `attachmentDownloaded` message so the webview can display the path.

**Edge Cases:**
- Guard against missing `localPath` in `openAttachment` / `revealAttachment`; return error if absent.

### src/webview/planning.html
**Context:** Tickets preview meta bar (line 3213) and modals (folder modal ends around line 3310).

**Logic:**
1. **Add button to `#tickets-preview-meta-bar` after line 3221 (`btn-comment-ticket`):**
   ```html
   <button id="btn-view-attachments" class="strip-btn" style="display:none;">Attachments</button>
   ```

2. **Add attachments modal after the last existing modal (after `#create-ticket-modal`, around line 3362):**
   ```html
   <div class="folder-modal" id="attachments-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="attachments-modal-title">
       <div class="modal-content">
           <div class="modal-header">
               <h3 id="attachments-modal-title">Attachments</h3>
               <button class="modal-close-btn" id="btn-close-attachments-modal" aria-label="Close">&times;</button>
           </div>
           <div class="modal-body">
               <div id="attachments-list"></div>
           </div>
       </div>
   </div>
   ```

3. **Add status footer element after `#markdown-preview-tickets` (after line 3250):**
   ```html
   <div id="tickets-status-footer" style="display:none; padding: 8px 16px; font-size: 10px; color: var(--text-secondary); border-top: 1px solid var(--border-color);"></div>
   ```

**Edge Cases:**
- Reuse existing `.folder-modal` and `.modal-content` styles; no new CSS needed.

### src/webview/planning.js
**Context:** Tickets tab UI state, message handling, and rendering functions.

**Logic:**
1. **In `getTicketsTabElements()` (around line 286), add:**
   ```js
   btnViewAttachments: document.getElementById('btn-view-attachments'),
   attachmentsModal: document.getElementById('attachments-modal'),
   attachmentsList: document.getElementById('attachments-list'),
   ticketsStatusFooter: document.getElementById('tickets-status-footer'),
   ```

2. **In `renderTicketsLinearPanel` (after meta bar setup, around line 5862):**
   - Show/hide `btnViewAttachments` based on `selectedLinearIssue.attachments?.length > 0`.

3. **In `renderTicketsClickUpPanel` / `renderTicketsClickUpTaskDetail` (around line 6300):**
   - Show/hide `btnViewAttachments` based on `selectedClickUpIssue.attachments?.length > 0`.

4. **Add click listener for `btn-view-attachments`:**
   - Toggle modal display (`attachmentsModal.style.display = modalOpen ? 'none' : 'flex'`).
   - If opening, collect current attachments from `selectedLinearIssue.attachments` or `selectedClickUpIssue.attachments` and post:
     ```js
     vscode.postMessage({ type: 'viewAttachments', workspaceRoot: ticketsWorkspaceRoot, provider, ticketId, ticketTitle, attachments });
     ```

5. **Add modal close handlers:**
   - `btn-close-attachments-modal` click → hide modal.
   - Backdrop click (`e.target.id === 'attachments-modal'`) → hide modal.
   - Escape key (in existing keydown handler around line 4955) → hide modal if open.

6. **Add message handlers:**
   - `attachmentsListResult`: Populate `#attachments-list` with rows. Each row shows filename, file path (if downloaded), and buttons: Open, Reveal, Download.
     - Open → `vscode.postMessage({ type: 'openAttachment', localPath })`.
     - Reveal → `vscode.postMessage({ type: 'revealAttachment', localPath })`.
     - Download → `vscode.postMessage({ type: 'downloadAttachment', workspaceRoot, provider, url, filename, ticketId, ticketTitle })`.
   - `attachmentOpened` / `attachmentRevealed`: Call `showTicketsStatus` with success or error text.

7. **Update `attachmentDownloaded` handler (line 3119):**
   - If `msg.success` and `msg.filePath`, set `#tickets-status-footer` text to `Downloaded to: ${msg.filePath}`, show it, and auto-hide after 5 seconds.
   - **Fallback:** If the footer element is not present, reuse `showTicketsStatus` to display the path.

**Edge Cases:**
- Hide `btn-view-attachments` when switching to a ticket with no attachments.
- Prevent duplicate modal open by toggling display instead of always setting to `'flex'`.

## Edge Cases

1. **Attachment already exists**: Check if file exists before downloading, skip if present (or offer to overwrite)
2. **Filename conflicts**: If attachment with same name exists, append timestamp or counter
3. **Missing hierarchy info**: If provider API fails to return hierarchy info, fall back to flat structure under provider folder
4. **Path traversal**: Keep existing security check (line 17843) to prevent path traversal attacks
5. **Large files**: Consider adding a size limit or progress indicator for large attachments
6. **Modal already open**: Close modal if button clicked while open
7. **No attachments**: Hide button when ticket has no attachments

## Risks

1. **Breaking change**: Users who have attachments in the old flat location will need to re-download them
2. **Provider API rate limits**: Fetching hierarchy info for every attachment download could hit rate limits (consider caching hierarchy info per ticket)
3. **Cross-platform paths**: Ensure path joining works correctly on Windows, macOS, and Linux
4. **Modal z-index**: Ensure attachments modal appears above other content
5. **File type handling**: Some file types may not open correctly with default app (e.g., .mov files)

## Verification Plan

### Automated Tests
- Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification
1. Select a ClickUp ticket with attachments. Click the new "Attachments" button. Verify modal opens listing each attachment.
2. Click "Download" for an un-downloaded attachment. Verify file is saved to `<tickets-folder>/clickup/<space>/<folder>/<list>/attachments/<filename>`.
3. Verify no VS Code toast appears; instead a status message shows the downloaded path.
4. Click "Open" on a downloaded attachment. Verify it opens in the OS default application.
5. Click "Reveal" on a downloaded attachment. Verify VS Code's file explorer focuses the file.
6. Select a Linear ticket with attachments and repeat steps 2-5, verifying path `<tickets-folder>/linear/<team>/<project>/attachments/`.
7. Disconnect tickets folder (clear in settings). Attempt download. Verify clear error message is returned and no fallback path is used.
8. Switch between tickets with and without attachments. Verify button visibility toggles correctly.
9. Test modal close behaviors: X button, backdrop click, Escape key.
10. Test attachment download with special characters in names (slugification).
11. Test on Windows, macOS, and Linux.

**Recommendation:** Send to Coder

## Review Findings

Reviewer-executor pass completed. Two fixes applied:

1. **`src/webview/planning.js`** — `selectedLinearIssue?.id` and `selectedClickUpIssue?.id` were used in three places (`:3153`, `:5363`, `:5750`) but the actual `id` lives under `.issue.id` / `.task.id`. This caused `ticketId` to be `undefined` for Linear, breaking `getAttachmentList` refresh. Corrected to `.issue?.id` / `.task?.id`.

2. **`src/services/TaskViewerProvider.ts`** — `downloadAttachment` and `getAttachmentList` were returning an error / empty array when no tickets folder was configured, contrary to user instruction that the default `.switchboard/tickets/provider/` path should be used. Fixed both methods to fallback to `path.join(resolvedRoot, '.switchboard', 'tickets', provider)` when `_buildTicketDir` returns null, matching the existing behavior of `_findTicketDocument` and `importTaskAsDocument`. Compilation passes.

Remaining risk: `importAllTasks` (`TaskViewerProvider.ts:~17614`) still builds paths inline instead of using `_buildTicketDir`.
