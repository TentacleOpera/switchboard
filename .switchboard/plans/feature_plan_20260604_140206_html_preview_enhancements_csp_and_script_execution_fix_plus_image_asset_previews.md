# HTML Preview Enhancements: CSP and Script Execution Fix plus Image Asset Previews

## Goal

Fix script execution issues in the Switchboard HTML preview panel (e.g., rendering blank white screens for prototypes like pii-fix-before-after.html that use external React/Babel or inline scripts) and add native support for listing and previewing image assets (.png, .jpg, .jpeg, .gif, .svg) within configured HTML folders (e.g., the designs/insights screenshots).

## Core Problems & Root Cause Analysis

1. **JavaScript and Script Execution Blocking (White Screen in pii-fix-before-after.html):**

Root Cause: The HTML preview panel currently sets the srcdoc property of the html-preview-frame iframe (iframe.srcdoc = htmlContent).
When using srcdoc inside a same-origin sandboxed iframe (allow-same-origin), it inherits the Content Security Policy (CSP) of the parent webview.
The parent webview's CSP contains a strict script-src directive with a unique nonce- key and does not allow external domains (https:) for scripts.
Consequently, inline scripts (like `<script type="text/babel">`) fail because they lack the nonce, and CDN scripts (like React, ReactDOM, Antd, Babel from https://unpkg.com) are blocked because https: is not in script-src. This breaks React compilation/hydration and leaves the prototype page blank.

2. **Missing Image Files and Nested Folders (e.g., designs/insights):**

Root Cause: LocalFolderService.ts uses the _isHtmlFile method to filter files in HTML folders. This method only accepts .html and .htm extensions, ignoring images.
Furthermore, the frontend planning.js hides any folder inside the list if it contains no HTML files directly, hiding directories like designs/insights which only contain screenshots (PNGs).

3. **Binary Image File Read (Clarification — discovered during plan review):**

Root Cause: PlanningPanelProvider.ts line 2070 unconditionally reads every previewed file as UTF-8 (`fs.promises.readFile(resolvedPath, 'utf8')`). When a user clicks an image file (.png, .jpg, etc.), this produces garbled Unicode replacement characters instead of meaningful content. The frontend then injects this garbled data into `iframe.srcdoc`, rendering nothing useful. The backend must detect image extensions and skip the UTF-8 content read, sending only the `webviewUri` with an `isImage` flag.

## Metadata

**Tags:** [frontend, backend, bugfix, security, UI]
**Complexity:** 5

## User Review Required

IMPORTANT

Security Implication: Switching from srcdoc to iframe.src = webviewUri allows previewed HTML files to execute their own JavaScript in a separate document context. This is required for interactive mockups (like React/Babel prototypes) to work as expected, but it means scripts in workspace HTML files will run in the sandbox. This matches typical IDE preview behavior.

Open Questions
None. The issues and required fixes have been fully mapped out and verified.

## Complexity Audit

### Routine
- Rename `_isHtmlFile` to `_isHtmlOrImageFile` and add image extensions (single method, LocalFolderService.ts line 394)
- Update `_scanHtmlFolder` call site to use renamed method (line 379)
- Add `#image-preview-container` div with `<img>` tag in planning.html (line 1885-1886)
- Update `renderNode` icon logic for image vs HTML files (planning.js line 474)
- Frontend image detection and preview toggle in `handlePreviewReady` (planning.js lines 1268-1291)

### Complex / Risky
- Switching from `iframe.srcdoc` to `iframe.src = webviewUri` for HTML files — CSP implications, cache-busting, and ensuring relative asset resolution works without `injectBaseTag`
- Backend image-detection guard in `_handleFetchPreview` (PlanningPanelProvider.ts lines 2069-2090) — must skip UTF-8 read for binary files and send `isImage` flag; also affects auto-refresh path

## Edge-Case & Dependency Audit

- **Race Conditions**: Auto-refresh watcher (`_setupActiveDocWatcher`) fires on file change and re-reads content. For image files, the re-read path must also detect image extensions and skip UTF-8 read, sending only `webviewUri` + `isImage: true`. Without this guard, auto-refresh of an image will send garbled `htmlContent`.
- **Security**: The iframe `sandbox="allow-scripts allow-same-origin"` attribute is unchanged. With `allow-same-origin`, an HTML file loaded via `iframe.src` retains its webview origin and could theoretically access the parent webview's DOM. This matches existing behavior and typical IDE preview patterns. No change needed.
- **Side Effects**: The `injectBaseTag()` function (planning.js line 350) becomes unnecessary for HTML files loaded via `iframe.src` (relative paths resolve naturally against the file's own URI). It remains useful as a fallback if `srcdoc` is ever used again. No removal required.
- **Dependencies & Conflicts**: The `frame-src` CSP directive already allows `vscode-webview:` scheme, so `iframe.src = webviewUri` is permitted. The `img-src` directive includes `{{WEBVIEW_CSP_SOURCE}} vscode-webview:`, so the new `<img>` tag with a webview URI src will load correctly. No CSP changes needed.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Backend binary-file read will garble image content if image-detection guard is missing — this is a showstopper that must be implemented in both initial-preview and auto-refresh paths. (2) Cache-buster query string on webviewUri must be appended on the frontend (not backend) to avoid breaking `asWebviewUri()` resolution. Mitigations: Add `isImage` flag to backend response; frontend appends `?t=Date.now()` after receiving `webviewUri`; auto-refresh path reuses same image-detection logic.

## Proposed Changes

### LocalFolderService.ts
- **Context**: Backend service that scans configured HTML folders and returns file listings. Currently only includes `.html`/`.htm` files.
- **Logic**:
  - Rename `_isHtmlFile` (line 394) to `_isHtmlOrImageFile` and extend the extension check to include `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`.
  - Update the call site in `_scanHtmlFolder` (line 379) from `this._isHtmlFile(entry.name)` to `this._isHtmlOrImageFile(entry.name)`.
- **Implementation**:
  ```typescript
  // Line 394-397: Rename and extend
  private _isHtmlOrImageFile(filename: string): boolean {
      const ext = path.extname(filename).toLowerCase();
      return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);
  }

  // Line 379: Update call site
  } else if (entry.isFile() && this._isHtmlOrImageFile(entry.name)) {
  ```
- **Edge Cases**: Image files will now appear as `kind === 'document'` nodes in the listing, which automatically makes image-only folders visible in `renderHtmlDocs` (the `folderDocsInSource.length === 0` check at line 883 becomes false). No separate frontend folder-visibility change is needed.

### PlanningPanelProvider.ts
- **Context**: Extension host that handles preview requests. Currently reads every file as UTF-8 text, which fails for binary images.
- **Logic**: In `_handleFetchPreview` (lines 2032-2091), add an image-extension detection check before attempting `fs.promises.readFile(resolvedPath, 'utf8')`. If the file is an image, skip the content read and send only `webviewUri` with `isImage: true`.
- **Implementation**:
  ```typescript
  // After line 2062 (webviewUri construction), before line 2069 (try block):
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
  const fileExt = path.extname(resolvedPath).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(fileExt);

  if (isImage) {
      // Skip UTF-8 read for binary image files
      this._panel?.webview.postMessage({
          type: 'previewReady',
          sourceId,
          requestId,
          webviewUri,
          docName: path.basename(resolvedPath),
          isImage: true,
          isAutoRefreshed: this._isAutoRefreshing
      });
      return;
  }

  // Existing try/catch for HTML file read (lines 2069-2090) continues unchanged
  ```
- **Edge Cases**: The auto-refresh path (triggered by `_setupActiveDocWatcher`) re-enters `_handleFetchPreview` with `this._isAutoRefreshing = true`, so the same image-detection guard applies automatically. No separate auto-refresh fix is needed.

### planning.html
- **Context**: Webview HTML template. Currently `#preview-pane-html` (line 1885) contains only the iframe.
- **Logic**: Add a dedicated `#image-preview-container` div containing an `<img>` tag next to `#html-preview-frame`. The image container is hidden by default; the iframe is shown by default.
- **Implementation**:
  ```html
  <!-- Line 1885-1887: Replace existing preview pane content -->
  <div id="preview-pane-html" style="display: flex; flex-direction: column; background: var(--panel-bg); overflow: hidden; height: 100%;">
      <iframe id="html-preview-frame" sandbox="allow-scripts allow-same-origin" style="flex: 1; border: none; background: white; width: 100%; height: 100%;"></iframe>
      <div id="image-preview-container" style="display: none; flex: 1; overflow: auto; background: var(--panel-bg); padding: 16px; text-align: center;">
          <img id="image-preview-img" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Image preview" />
      </div>
  </div>
  ```
- **Edge Cases**: The `img-src` CSP directive already allows `vscode-webview:` URIs, so the `<img>` tag with a webview URI src will load without CSP violations.

### planning.js
- **Context**: Webview JavaScript. Handles preview rendering, tree node rendering, and HTML docs folder display.
- **Logic**: Four changes needed:

  **1. Script/Iframe Fix (handlePreviewReady, lines 1268-1291):**
  For `sourceId === 'html-folder'`, switch from `iframe.srcdoc = htmlWithBase` to `iframe.src = webviewUri` (with cache-buster). This allows scripts to run in the iframe's own document context, free from the parent's CSP restrictions. When `isImage` is true, hide the iframe and show the image preview container instead.

  ```javascript
  // Lines 1268-1291: Replace html-folder handling
  if (sourceId === 'html-folder') {
      const iframe = document.getElementById('html-preview-frame');
      const imageContainer = document.getElementById('image-preview-container');
      const imageImg = document.getElementById('image-preview-img');

      if (msg.isImage && webviewUri) {
          // Image preview: hide iframe, show image container
          if (iframe) { iframe.style.display = 'none'; iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); }
          if (imageContainer) { imageContainer.style.display = 'flex'; }
          if (imageImg) { imageImg.src = webviewUri; }
      } else if (webviewUri) {
          // HTML preview: show iframe, hide image container, use iframe.src instead of srcdoc
          if (iframe) {
              iframe.style.display = '';
              iframe.removeAttribute('srcdoc');
              iframe.src = webviewUri + '?t=' + Date.now(); // cache-buster for refresh
          }
          if (imageContainer) { imageContainer.style.display = 'none'; }
          if (imageImg) { imageImg.removeAttribute('src'); }
      } else if (htmlContent) {
          // Fallback: srcdoc if webviewUri not provided (backward compat)
          if (iframe) {
              iframe.style.display = '';
              iframe.removeAttribute('src');
              const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
              iframe.srcdoc = htmlWithBase;
          }
          if (imageContainer) { imageContainer.style.display = 'none'; }
      }
      // Status update (unchanged)
      const statusHtml = document.getElementById('status-html');
      if (statusHtml) {
          if (isAutoRefreshed) {
              statusHtml.textContent = (docName || 'Loaded') + ' — auto-refreshed';
              statusHtml.style.color = 'var(--accent-teal)';
          } else {
              statusHtml.textContent = docName || 'Loaded';
              statusHtml.style.color = 'var(--accent-teal)';
          }
      }
      return;
  }
  ```

  **2. Icon determination (renderNode, line 474):**
  Update the icon logic to show 🖼️ for image files and 🌐 for HTML files when `sourceId === 'html-folder'`.

  ```javascript
  // Line 474: Replace icon determination
  let fileIcon = '📄';
  if (sourceId === 'html-folder') {
      const name = (node.name || '').toLowerCase();
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
      fileIcon = imageExts.some(ext => name.endsWith(ext)) ? '🖼️' : '🌐';
  }
  icon.textContent = (node.kind === 'folder' || node.isDirectory) ? '📁' : fileIcon;
  ```

  **3. Folder visibility in renderHtmlDocs (line 883):**
  Clarification: The backend change to `_isHtmlOrImageFile` already ensures image files appear as document nodes, so `folderDocsInSource.length === 0` naturally becomes false for image-only folders. No frontend code change is strictly required here. However, if desired as a belt-and-suspenders check, the condition could be relaxed to also count child folders — but this is optional.

  **4. Image preview reset on tab switch / folder change:**
  When the user navigates away from an image preview (e.g., switches to a different tab or selects a different folder), the image container should be hidden and the iframe should be cleared. This is already handled by the existing tab-switch logic since `handlePreviewReady` is only called on explicit preview requests, but the image container's `display` state should be reset when the HTML preview tab is re-entered with no active selection.

## Verification Plan

### Automated Tests
- N/A — changes span webview UI and extension host IPC; verification is manual.

### Manual Verification

1. **Validate JavaScript Execution / Prototype Rendering:**
   - Open the Switchboard planning panel, select the HTML Preview tab, and configure/open the designs folder.
   - Click pii-fix-before-after.html.
   - Verify that the React and Ant Design widgets render correctly and interactive elements function (no blank white screen).
   - Edit pii-fix-before-after.html slightly and verify that the preview automatically refreshes.

2. **Validate Image Support & Navigation:**
   - Verify that the /designs/insights folder is now visible in the folder explorer sidebar.
   - Expand /designs/insights and verify that the .png screenshot files show up with picture (🖼️) icons.
   - Click any .png file and verify it renders nicely, centered, and scaled in the preview pane.
   - Verify that HTML files still show 🌐 icons.

3. **Validate Image/HTML Toggle:**
   - Click an HTML file, verify the iframe is shown and image container is hidden.
   - Click an image file, verify the image container is shown and iframe is hidden.
   - Click back to an HTML file, verify the iframe reappears correctly.

4. **Validate Auto-Refresh for Images:**
   - Preview an image file.
   - Modify the image file on disk (e.g., replace with a different image of the same name).
   - Verify the preview auto-refreshes to show the updated image.

## Recommendation

Complexity 5 → **Send to Coder**
