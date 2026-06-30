# Attachment Download Accessibility & Inline Image Display in Tickets Tab

## Goal

When a user clicks to download an attachment in the tickets tab of planning.html, the file is saved to a deeply nested folder (`.switchboard/tickets/<provider>/<segments>/attachments/`) that is not easily accessible. Additionally, image attachments should display inline once downloaded, so the user can see them without navigating to the file system.

### Problem Analysis & Root Cause

**Problem 1 — Inaccessible download location:** The `downloadAttachment` method in `TaskViewerProvider.ts` (line ~19914) saves files to `path.join(baseDir, 'attachments')` where `baseDir` is built from `.switchboard/tickets/<provider>/<spaceName>/<folderName>/<listName>/`. This is 5-6 levels deep inside the workspace, making it nearly impossible for users to find in Finder/Explorer. The only feedback the user gets is a transient footer message showing the path for 5 seconds (`attachmentDownloaded` handler at line ~4721 in planning.js).

**Problem 2 — No inline image preview:** The `renderAttachmentsList` function (line ~8305 in planning.js) renders attachment rows with Download/Open/Reveal buttons but never displays image content inline. Even after download, when the attachment row shows "Open" and "Reveal" buttons, the image itself is not shown. The user must click "Open" to launch an external viewer, breaking the workflow.

The attachment modal (`#attachments-modal` in planning.html, line ~3871) also only shows a flat list of buttons — no inline images.

### Scope Clarification (added during plan improvement)

**Problem 1 status:** The existing "Reveal" button (rendered in `renderAttachmentsList` for downloaded attachments, line ~8327; handled by the `revealAttachment` case in `PlanningPanelProvider.ts` line ~5783) already opens the OS file manager focused on the downloaded file. This mitigates the "inaccessible location" pain point without changing the download path. The inline image display (Problem 2) further reduces the need to navigate the filesystem. **No change to the download directory is proposed** — moving the directory would break existing users' downloaded attachments and require a migration. The "accessibility" in the title is therefore delivered via (a) the existing Reveal button and (b) the new inline preview, not by relocating files.

## Metadata
**Tags:** ui, frontend, ux, bugfix, feature
**Complexity:** 4

## User Review Required

- [ ] **Confirm Problem 1 scope:** The plan does NOT move the download directory. Accessibility is delivered via the existing "Reveal" button + new inline image preview. If you want the download path changed to a shallower/user-configurable location, that is a separate plan (and requires a migration for existing downloaded files). Confirm this is acceptable.
- [ ] **Confirm change #1 redundancy decision:** Change #1 (adding `webviewUri` to the `attachmentDownloaded` message) is redundant with change #2 (adding `webviewUri` to `attachmentsListResult`), because the `attachmentDownloaded` handler already triggers a `viewAttachments` re-fetch. The plan recommends DROPPING change #1 to avoid dead code. Confirm.

## Complexity Audit

### Routine
- Add image file extension detection (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`).
- Add `<img>` tag rendering in `renderAttachmentsList` for downloaded image attachments.
- Convert the local file path to a webview URI (`vscode-webview://` resource URI) for inline display.
- Add a click handler on inline images that reuses the existing `openAttachment` message to open the image in the system viewer.

### Complex / Risky
- **Webview URI conversion (verified low-risk):** VS Code webviews cannot directly reference `file://` paths. The conversion must use `webview.asWebviewUri()`. **Verified during planning:** the workspace folder is already registered as a `localResourceRoot` in `_updateWebviewRoots()` (`PlanningPanelProvider.ts` line ~6881: `...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri)`), and attachments live under `.switchboard/` inside the workspace, so `asWebviewUri()` works with NO additional root registration.
- **CSP (verified low-risk):** The webview CSP in `planning.html` (line ~6) already permits `img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data:`. `asWebviewUri()` produces `vscode-webview://` URIs, which are allowed. **No CSP change needed.**
- The attachments modal (`#attachments-modal`) also needs inline image rendering for consistency — this is the same `renderAttachmentsList` render path, so it is covered automatically.
- Non-image attachments (PDFs, docs) should show a file-type icon, not a broken image.

## Edge-Case & Dependency Audit

- **Race Conditions:** Download → re-fetch attachment list → render. The `attachmentDownloaded` handler (line ~4721) already triggers `viewAttachments` to re-fetch the list (line ~4741), so the inline image will appear after the re-fetch completes. No new race introduced.
- **Security:** `asWebviewUri()` only encodes the path; it does not grant new filesystem access beyond what `localResourceRoots` already permits. The attachments directory is inside the workspace, which is already an allowed root. SVG files loaded via `<img>` do not execute embedded scripts (browsers disable script execution for SVGs loaded through `<img>`), so inline SVG preview is safe. The existing `escapeAttr` (planning.js line ~536) is used on the URI and `localPath` attributes to prevent attribute injection.
- **Side Effects:** None. The only write action is the existing download (unchanged). The plan adds read-only rendering and a URI conversion that is computed on the extension host and passed to the webview.
- **Dependencies & Conflicts:** No new npm dependencies. Relies on `path` (already imported in `PlanningPanelProvider.ts` line ~3) and `vscode.Uri`/`webview.asWebviewUri` (already used throughout the file). No conflict with other in-flight work.
- **Webview URI conversion:** A new `webviewUri` field is added to the `attachmentsListResult` payload (computed in `PlanningPanelProvider.ts` after receiving the result from `switchboard.getAttachmentList`). The current `attachmentDownloaded` message only returns `filePath` (a plain filesystem path); change #1 would add `webviewUri` there too, but it is redundant (see User Review Required).
- **Large images:** Inline images should be constrained with `max-width: 100%` and `max-height` to avoid layout breakage. Very large images should be clickable to open externally.
- **Non-image files:** Must not attempt to render `<img>` for `.pdf`, `.docx`, `.zip`, etc. — show a file icon or filename-only row.
- **Deleted files:** If a downloaded file is later deleted from disk, the inline image will show a broken icon. The `getAttachmentList` backend method checks `fs.existsSync` for `isDownloaded` status (line ~20076), so this is handled at list-refresh time.
- **Multi-root workspaces (product scope, preserved):** `_updateWebviewRoots()` registers ALL workspace folders as resource roots, so attachments stored under any root's `.switchboard/` directory are accessible via `asWebviewUri()`. No per-root special-casing needed.

## Dependencies

- None. This plan is self-contained and touches only `PlanningPanelProvider.ts` and `planning.js`.

## Adversarial Synthesis

Key risks: (1) the plan's title promises "accessibility" but no Proposed Change actually relocates or shortens the download path — accessibility is delivered only via the existing Reveal button and the new inline preview, which the user must confirm is acceptable; (2) change #1 is dead code because the `attachmentDownloaded` handler already re-fetches the list via `viewAttachments`, so `webviewUri` on the download message is never read by the frontend; (3) the proposed `this._panel!.webview.asWebviewUri()` uses the non-null assertion on `_panel`, which is safe today only because the tickets tab exists solely in the planning panel, but is fragile. Mitigations: drop change #1, use a `targetPanel` selection matching the codebase pattern (`isProject ? this._projectPanel : this._panel`), and document the Problem 1 scope decision in User Review Required.

## Proposed Changes

### 1. Backend: Return webview-safe URI for downloaded images (REDUNDANT — recommended to DROP)
**File:** `src/services/PlanningPanelProvider.ts`

In the `downloadAttachment` case (line ~5703), after receiving the result from `switchboard.downloadAttachment`, also convert the file path to a webview URI if the file is an image:

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

> **Plan-improvement note:** This change is REDUNDANT. The `attachmentDownloaded` frontend handler (planning.js line ~4721) already triggers a `viewAttachments` re-fetch (line ~4741), and change #2 below adds `webviewUri` to the `attachmentsListResult` payload that the re-fetch produces. The frontend never reads `webviewUri` from the `attachmentDownloaded` message. **Recommendation: drop this change unless you want the download message to carry the URI for a future "show image immediately without waiting for re-fetch" optimization.** See User Review Required.

### 2. Backend: Return webview URIs in getAttachmentList result
**File:** `src/services/PlanningPanelProvider.ts`

In the `viewAttachments` case (line ~5730), after receiving the result from `switchboard.getAttachmentList`, convert local paths to webview URIs for image files before posting `attachmentsListResult`. Use the `targetPanel` pattern matching the codebase convention (lines ~2802/2809/2818) so the correct panel (planning vs project) is used, even though only the planning panel currently has a tickets tab:

```typescript
case 'viewAttachments': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const { provider, ticketId, attachments } = msg;
    try {
        let result: any = await vscode.commands.executeCommand(
            'switchboard.getAttachmentList',
            { workspaceRoot, provider, ticketId, attachmentsArray: attachments }
        );
        // Convert local paths to webview URIs for images
        const targetPanel = isProject ? this._projectPanel : this._panel;
        if (Array.isArray(result) && targetPanel) {
            const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
            result = result.map((att: any) => {
                if (att.isDownloaded && att.localPath) {
                    const ext = path.extname(att.localPath).toLowerCase();
                    if (imageExts.includes(ext)) {
                        const uri = vscode.Uri.file(att.localPath);
                        att.webviewUri = targetPanel.webview.asWebviewUri(uri).toString();
                    }
                }
                return att;
            });
        }
        targetPanel?.webview.postMessage({
            type: 'attachmentsListResult',
            success: true,
            ticketId,
            attachments: result,
            workspaceRoot
        });
    } catch (error) {
        const targetPanel = isProject ? this._projectPanel : this._panel;
        targetPanel?.webview.postMessage({
            type: 'attachmentsListResult',
            success: false,
            ticketId,
            attachments: [],
            error: error instanceof Error ? error.message : String(error),
            workspaceRoot
        });
    }
    break;
}
```

> **Note:** `isProject` is the second parameter of `_handleMessage(msg, isProject)` (line ~607). The existing code at line ~5738 uses `this._panel?.webview.postMessage(...)` without the `isProject` guard; the improved version above fixes this latent fragility while also adding the URI conversion. `path` is already imported (line ~3).

### 3. Frontend: Render inline images in attachment list
**File:** `src/webview/planning.js`

In `renderAttachmentsList` (line ~8305), after the existing path display block for downloaded attachments (line ~8340), add inline image rendering. Use the existing `escapeAttr` (line ~536) and `escapeHtml` (line ~330) helpers:

```javascript
if (isDownloaded) {
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

Add click handler for inline images (at the end of `renderAttachmentsList`, after the existing `.reveal-attachment-btn` listener block, ~line ~8376):

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

> **Note:** The `openAttachment` case already exists in `PlanningPanelProvider.ts` (line ~5757) and opens the file with the system default viewer. No new backend handler is needed.

### 4. Frontend: attachmentDownloaded handler (NO CHANGE NEEDED)
**File:** `src/webview/planning.js`

In the `attachmentDownloaded` case (line ~4721), the existing code already triggers `viewAttachments` to re-fetch the list (line ~4741). The re-fetched list will now include `webviewUri` for images (from change #2), so `renderAttachmentsList` will automatically show the inline image. No additional change needed beyond what's already there.

### 5. Frontend: Detail content view (NO CHANGE — decision preserved)
**File:** `src/webview/planning.js`

In `renderTicketsClickUpTaskDetail` and `renderTicketsLinearTaskDetail`, attachments are rendered as simple buttons. These should also show inline images for downloaded attachments. However, the detail view doesn't have `isDownloaded`/`webviewUri` info — it only has the raw attachment objects from the API.

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
9. Verify (multi-root): in a multi-root workspace, an image attachment downloaded for a ticket whose `.switchboard/` lives in a non-primary root still renders inline.

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host). Per session directives, automated tests are skipped and will be run separately by the user.

**Recommendation:** Send to Coder
