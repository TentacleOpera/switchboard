# Attachment Download Accessibility & Inline Image Display in Tickets Tab

## Goal

When a user clicks to download an attachment in the tickets tab of planning.html, the file is saved to a deeply nested folder (`.switchboard/tickets/<provider>/<segments>/attachments/`) that is not easily accessible. Additionally, image attachments should display inline once downloaded, so the user can see them without navigating to the file system.

### Problem Analysis & Root Cause

**Problem 1 — Inaccessible download location:** The `downloadAttachment` method in `TaskViewerProvider.ts` (line ~19914) saves files to `path.join(baseDir, 'attachments')` where `baseDir` is built from `.switchboard/tickets/<provider>/<spaceName>/<folderName>/<listName>/`. This is 5-6 levels deep inside the workspace, making it nearly impossible for users to find in Finder/Explorer. The only feedback the user gets is a transient footer message showing the path for 5 seconds (`attachmentDownloaded` handler at line ~4667 in planning.js).

**Problem 2 — No inline image preview:** The `renderAttachmentsList` function (line ~8243 in planning.js) renders attachment rows with Download/Open/Reveal buttons but never displays image content inline. Even after download, when the attachment row shows "Open" and "Reveal" buttons, the image itself is not shown. The user must click "Open" to launch an external viewer, breaking the workflow.

The attachment modal (`#attachments-modal` in planning.html, line ~3871) also only shows a flat list of buttons — no inline images.

## Metadata
**Tags:** ui, frontend, attachments, tickets-tab, bugfix
**Complexity:** 4

## Complexity Audit

### Routine
- Add image file extension detection (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`).
- Add `<img>` tag rendering in `renderAttachmentsList` for downloaded image attachments.
- Convert the local file path to a webview URI (`vscode-webview://` resource URI) for inline display.

### Complex / Risky
- Webview security: images must be served via the webview's local resource root. The `localPath` is an absolute filesystem path that must be converted to a `vscode-file://` or `webview.asWebviewUri()` resource. This requires a backend round-trip to convert the path, OR the webview must already have the resource root configured.
- The attachments modal (`#attachments-modal`) also needs inline image rendering for consistency.
- Non-image attachments (PDFs, docs) should show a file-type icon, not a broken image.

## Edge-Case & Dependency Audit

- **Webview URI conversion:** VS Code webviews cannot directly reference `file://` paths. The extension must register the attachments directory as a webview resource root, or the backend must return a `asWebviewUri`-converted path. The current `attachmentDownloaded` message only returns `filePath` (a plain filesystem path). A new message type or additional field is needed to return the webview-safe URI.
- **Large images:** Inline images should be constrained with `max-width: 100%` and `max-height` to avoid layout breakage. Very large images should be clickable to open externally.
- **Non-image files:** Must not attempt to render `<img>` for `.pdf`, `.docx`, `.zip`, etc. — show a file icon or filename-only row.
- **Deleted files:** If a downloaded file is later deleted from disk, the inline image will show a broken icon. The `getAttachmentList` backend method checks `fs.existsSync` for `isDownloaded` status, so this is handled at list-refresh time.
- **Race conditions:** Download → re-fetch attachment list → render. The `attachmentDownloaded` handler already triggers `viewAttachments` to re-fetch the list (line ~4687), so the inline image will appear after the re-fetch completes.

## Proposed Changes

### 1. Backend: Return webview-safe URI for downloaded images
**File:** `src/services/PlanningPanelProvider.ts`

In the `downloadAttachment` case (line ~5702), after receiving the result from `switchboard.downloadAttachment`, also convert the file path to a webview URI if the file is an image:

```typescript
case 'downloadAttachment': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const { provider, url, filename, ticketId, ticketTitle } = msg;
    try {
        const result: any = await vscode.commands.executeCommand(
            'switchboard.downloadAttachment',
            { workspaceRoot, provider, url, filename, ticketId, ticketTitle }
        );
        // Convert to webview URI for inline image display
        let webviewUri: string | undefined;
        if (result.success && result.filePath) {
            const ext = path.extname(result.filePath).toLowerCase();
            const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
            if (imageExts.includes(ext) && this._panel) {
                const uri = vscode.Uri.file(result.filePath);
                webviewUri = this._panel.webview.asWebviewUri(uri).toString();
            }
        }
        this._panel?.webview.postMessage({
            type: 'attachmentDownloaded',
            success: result.success,
            url,
            filePath: result.filePath,
            webviewUri,  // NEW: webview-safe URI for inline display
            error: result.error,
            workspaceRoot
        });
    } catch (error) {
        // ... existing error handling
    }
    break;
}
```

### 2. Backend: Return webview URIs in getAttachmentList
**File:** `src/services/TaskViewerProvider.ts`

In `getAttachmentList` (line ~20027), when an attachment is already downloaded, also return a `webviewUri` field for image files. This requires passing the webview panel reference or doing the conversion in `PlanningPanelProvider.ts` after receiving the result.

**Alternative (simpler):** Do the conversion in `PlanningPanelProvider.ts` in the `attachmentsListResult` case (line ~5729):

```typescript
case 'viewAttachments': {
    // ... existing code that gets result from switchboard.getAttachmentList ...
    // Convert local paths to webview URIs for images
    if (result && this._panel) {
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
        result = result.map((att: any) => {
            if (att.isDownloaded && att.localPath) {
                const ext = path.extname(att.localPath).toLowerCase();
                if (imageExts.includes(ext)) {
                    const uri = vscode.Uri.file(att.localPath);
                    att.webviewUri = this._panel!.webview.asWebviewUri(uri).toString();
                }
            }
            return att;
        });
    }
    this._panel?.webview.postMessage({
        type: 'attachmentsListResult',
        success: true,
        ticketId,
        attachments: result,
        workspaceRoot
    });
    break;
}
```

### 3. Frontend: Render inline images in attachment list
**File:** `src/webview/planning.js`

In `renderAttachmentsList` (line ~8243), after the existing path display block for downloaded attachments, add inline image rendering:

```javascript
if (isDownloaded) {
    // Existing: show path
    html += `
        <div style="font-size: 10px; color: var(--text-secondary); word-break: break-all; margin-top: 2px;">
            Path: ${escapeHtml(localPath)}
        </div>
    `;
    // NEW: inline image preview for image files
    if (att.webviewUri) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
        if (imageExts.includes(ext)) {
            html += `
                <div style="margin-top: 6px; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; background: var(--panel-bg);">
                    <img src="${escapeAttr(att.webviewUri)}" 
                         style="display: block; max-width: 100%; max-height: 300px; object-fit: contain; cursor: pointer;" 
                         data-local-path="${escapeAttr(localPath)}"
                         class="inline-attachment-img" />
                </div>
            `;
        }
    }
}
```

Add click handler for inline images (at the end of `renderAttachmentsList`, after existing button listeners):

```javascript
attachmentsList.querySelectorAll('.inline-attachment-img').forEach(img => {
    img.addEventListener('click', () => {
        const localPath = img.dataset.localPath;
        vscode.postMessage({
            type: 'openAttachment',
            workspaceRoot: ticketsWorkspaceRoot,
            localPath
        });
    });
});
```

### 4. Frontend: Update attachmentDownloaded handler to re-render with webviewUri
**File:** `src/webview/planning.js`

In the `attachmentDownloaded` case (line ~4667), the existing code already triggers `viewAttachments` to re-fetch the list. The re-fetched list will now include `webviewUri` for images (from change #2), so `renderAttachmentsList` will automatically show the inline image. No additional change needed beyond what's already there.

### 5. Frontend: Also show inline images in the detail content view
**File:** `src/webview/planning.js`

In `renderTicketsClickUpTaskDetail` (line ~9130) and `renderTicketsLinearTaskDetail` (line ~8631), attachments are rendered as simple buttons. These should also show inline images for downloaded attachments. However, the detail view doesn't have `isDownloaded`/`webviewUri` info — it only has the raw attachment objects from the API. 

**Decision:** Keep the detail view as buttons (clicking opens the attachments modal). The inline image display is specifically for the attachments modal (`#attachments-modal` / `#attachments-list`), which is where the user manages downloads. This avoids needing to cross-reference download status in the detail view.

## Verification Plan

### Manual Testing
1. Open a ticket with image attachments in the tickets tab.
2. Click "Attachments" button to open the attachments modal.
3. Click "Download" on an image attachment.
4. Verify: after download completes, the attachment row shows "Open" and "Reveal" buttons AND the image is displayed inline below the path.
5. Verify: clicking the inline image opens it in the system's default image viewer.
6. Verify: non-image attachments (e.g., `.pdf`, `.zip`) do NOT show a broken image — only the filename and buttons.
7. Verify: large images are constrained to `max-height: 300px` and don't break the modal layout.
8. Verify: re-opening the attachments modal for an already-downloaded image shows the inline image immediately (from `getAttachmentList` with `isDownloaded: true` and `webviewUri`).

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

**Recommendation:** Send to Coder
