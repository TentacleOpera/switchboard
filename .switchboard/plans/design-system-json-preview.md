# Add JSON & YAML Explorer & Design Token File Support to Design System Tab

## Goal

Extend the **Design System** tab in `planning.html` so it can browse and preview JSON and YAML files (and other design-system assets) in addition to markdown and images. Both JSON and YAML files must render in a collapsible tree explorer with syntax highlighting and remain editable inline.

## Problem Analysis

The Design System tab currently only surfaces files that pass `_isDesignOrImageFile` in `LocalFolderService.ts` — namely `.md`, `.txt`, `.rst`, `.adoc`, and image formats (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`). **JSON is excluded**, so token files, component manifests, theme configs, and `package.json`-style design metadata are invisible.

For files that *are* visible, the preview pipeline bifurcates into two hardcoded paths:

1. **Image preview** — renders in a bare `<img>` tag (`image-preview-container-design`).
2. **Markdown preview** — pipes raw text through `renderMarkdown()` and dumps it into `markdown-preview-design`.

There is no third path for structured data. If JSON were forced through the markdown renderer, it would appear as an unstyled code block at best, and a broken mess at worst. There is also no mechanism for the frontend to know *what kind* of file it received, so it cannot choose an appropriate renderer.

Finally, the edit/save cycle is wired exclusively for markdown: clicking **Edit** swaps the preview div for a `<textarea>`, and **Save** writes the textarea value back to disk with no validation. JSON needs the same edit capability, but with parse-time validation before write.

**Root cause:** The backend `previewReady` message carries no file-type metadata, and the frontend `handlePreviewReady` has no branching logic beyond `isImage`. The save handler (`saveFileContent` at `PlanningPanelProvider.ts:1648`) has no validation step and no `fileType` field. The frontend `saveFileContentResult` handler at `planning.js:2947` always calls `renderMarkdown()` on save success, which is wrong for JSON/YAML.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, feature, ui

## User Review Required

- **Whitelist scope:** Should `.js`/`.ts`/`.tsx`/`.jsx` be included in v1, or deferred to an opt-in config flag? (Current plan: **deferred** — these flood the sidebar in typical workspaces.)
- **Tree depth default:** Should nested objects be fully expanded, or collapsed beyond depth 2? (Current plan: expand depth 2, collapse deeper.)
- **YAML save format:** When editing a YAML file, should the backend preserve YAML formatting on write (no conversion to JSON), or is it acceptable to re-serialize as YAML? (Current plan: write raw text as-is, validate only.)

## Complexity Audit

### Routine

- Expanding `_isDesignOrImageFile` whitelist in `LocalFolderService.ts:596-599`
- Adding `fileType` field to `previewReady` message in `PlanningPanelProvider.ts:2573-2582`
- Adding `#json-preview-container-design` HTML markup in `planning.html:2520-2528`
- Adding JSON tree CSS styles in `planning.html` CSS block
- Updating empty-state copy text
- Updating edit-button disable logic in `planning.js:850-855`

### Complex / Risky

- **Save validation without `fileType` in message:** The `saveFileContent` message (line 1648) doesn't carry `fileType`. Must infer from `path.extname(filePath)` on the backend. Requires adding validation logic between conflict detection (line 1678) and `writeFile` (line 1683).
- **Save-result re-render routing:** `saveFileContentResult` handler at line 2947 always calls `renderMarkdown()`. Must branch on `state.activeFileType` to call `renderJsonTree()` for JSON/YAML files.
- **YAML parsing architecture:** `js-yaml` is a Node.js CommonJS module — cannot run in VS Code webview sandbox. Must parse YAML on the **backend** and send `parsedJson` in `previewReady`, not in the frontend.
- **Edit/exit mode for JSON/YAML:** `enterEditMode('design')` and `exitEditMode('design')` don't account for `json-preview-container-design`. Must add hide/show logic and add the container to the `edit-mode` CSS rule at `planning.html:2108-2115`.
- **Frontend `state.activeFileType` tracking:** No existing state field tracks the current file type. Must add one so edit/exit/save handlers can route correctly.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `saveFileContent` handler already has conflict detection (comparing `originalContent` with disk content). JSON/YAML validation must happen **before** conflict detection so invalid content is rejected early. No new race condition introduced.
- **Security:** Path traversal is already guarded (line 2528-2531). No new attack surface. `js-yaml` `load()` is safe for well-formedness validation (no `unsafe` option used).
- **Side Effects:** Adding extensions to `_isDesignOrImageFile` increases the number of files scanned during `_scanDesignFolder`. The existing `_TITLE_EXTRACTION_FILE_LIMIT` guard (line 573) prevents title extraction from blowing up. No new side effects beyond sidebar population.
- **Dependencies & Conflicts:** `js-yaml` is already a transitive dependency (via `cosmiconfig`, `mocha`, `eslint`, etc.) but is **not** a direct dependency in `package.json`. Must add it explicitly. The `yaml` package (v2.9.0) also exists in `node_modules` but is a different library — use `js-yaml` for backend compatibility with existing require patterns.

## Dependencies

- `js-yaml` — YAML parsing and validation on the backend (must be added to `package.json` dependencies)

## Adversarial Synthesis

Key risks: (1) Save validation is architecturally incomplete — `saveFileContent` lacks `fileType`, so the backend must infer it from the file extension; (2) YAML cannot be parsed in the webview — must be parsed on the backend and sent as `parsedJson`; (3) Edit/exit mode and save-result re-render always assume markdown, requiring branching on `state.activeFileType`. Mitigations: infer `fileType` from `path.extname()` on save, add `parsedJson` field to `previewReady`, branch all render paths on `state.activeFileType`.

## Scope

### In Scope

- Sidebar visibility for JSON, YAML, and other common design-system file types
- Backend file-type detection and routing
- Frontend JSON tree explorer (collapsible, syntax-highlighted)
- Frontend YAML tree explorer (parsed to JSON on backend, then rendered with same tree component)
- Inline editing of JSON and YAML files (raw textarea, validated on save)
- Basic text preview for CSS/SCSS/XML (monospace formatted, no tree)

### Out of Scope

- In-place tree editing (click key → edit value inline). Raw-text editing only.
- Schema validation or JSON/YAML linting beyond well-formedness.
- XML tree explorer (v1: formatted text only).
- Monaco or CodeMirror integration. Reuses existing `<textarea>` pattern.
- `.js`/`.ts`/`.tsx`/`.jsx` sidebar visibility (deferred: floods sidebar in typical workspaces; can be added via opt-in config flag later).

## Implementation Details

### Phase 1 — Backend: Sidebar Visibility & File-Type Routing

#### 1.1 Expand the Design System file whitelist

**File:** `src/services/LocalFolderService.ts` (line 596-599)

Update `_isDesignOrImageFile` to include JSON and other design-token file types. **v1 excludes `.js`/`.ts`/`.tsx`/`.jsx`** to avoid sidebar flooding:

```typescript
private _isDesignOrImageFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return [
        // Documents
        '.md', '.txt', '.markdown', '.rst', '.adoc',
        // Images
        '.png', '.jpg', '.jpeg', '.gif', '.svg',
        // Structured data & design tokens
        '.json',
        // Stylesheets
        '.css', '.scss', '.less', '.sass',
        // Config / markup
        '.yaml', '.yml', '.xml'
    ].includes(ext);
}
```

> **Clarification:** `.js`/`.ts`/`.tsx`/`.jsx` are intentionally excluded from v1. They can be added later via an opt-in config flag (`switchboard.designSystem.showSourceFiles`). The `fileTypeMap` below does not include them; they would fall through to `'text'` if ever added.

#### 1.2 Add file-type classification and YAML pre-parsing to the preview payload

**File:** `src/services/PlanningPanelProvider.ts` (design-folder branch, lines 2546-2582)

In `_handleFetchPreview` (design-folder branch), after reading the file, determine a `fileType` string. For YAML files, parse on the backend and include the result as `parsedJson`:

```typescript
const fileExt = path.extname(resolvedPath).toLowerCase();
const isImage = PlanningPanelProvider.IMAGE_EXTENSIONS.has(fileExt);

// Map extension to a preview category
// Unmapped extensions default to 'text'
const fileTypeMap: Record<string, string> = {
    '.json': 'json',
    '.css': 'css', '.scss': 'css', '.less': 'css', '.sass': 'css',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.xml': 'xml',
    '.md': 'markdown', '.txt': 'markdown', '.markdown': 'markdown',
    '.rst': 'markdown', '.adoc': 'markdown',
};
const fileType = isImage ? 'image' : (fileTypeMap[fileExt] || 'text');

// For YAML: parse on backend and send parsed result to frontend
let parsedJson: any = undefined;
if (fileType === 'yaml') {
    try {
        const yaml = require('js-yaml');
        parsedJson = yaml.load(docContent);
    } catch (e: any) {
        // Will be handled as error on frontend — send raw content only
    }
}
```

Append `fileType` and `parsedJson` to the `previewReady` message:

```typescript
this._panel?.webview.postMessage({
    type: 'previewReady',
    sourceId,
    requestId,
    webviewUri,
    content: docContent,
    docName: path.basename(resolvedPath),
    fileType,           // NEW
    parsedJson,         // NEW — undefined for non-YAML files
    isAutoRefreshed: this._isAutoRefreshing,
    filePath: resolvedPath
});
```

> **Architectural decision:** YAML is parsed on the **backend**, not the frontend. `js-yaml` is a CommonJS Node module that cannot run in the VS Code webview sandbox. The frontend receives the pre-parsed JSON object and renders it with the same `renderJsonTree()` used for `.json` files. This eliminates the need to bundle `js-yaml` via webpack for the webview.

#### 1.3 Add JSON/YAML validation to the save path

**File:** `src/services/PlanningPanelProvider.ts` (saveFileContent handler, lines 1648-1689)

The `saveFileContent` message does **not** carry `fileType`. Infer it from the file extension on the backend. Insert validation **between** the conflict detection (line 1678) and `writeFile` (line 1683):

```typescript
// After conflict detection, before writeFile:
const saveExt = path.extname(resolved).toLowerCase();
if (saveExt === '.json') {
    try { JSON.parse(content); }
    catch (e: any) {
        this._panel?.webview.postMessage({
            type: 'saveFileContentResult',
            success: false,
            error: `Invalid JSON: ${e.message}`,
            tab
        });
        break;
    }
}
if (saveExt === '.yaml' || saveExt === '.yml') {
    const yaml = require('js-yaml');
    try { yaml.load(content); }
    catch (e: any) {
        this._panel?.webview.postMessage({
            type: 'saveFileContentResult',
            success: false,
            error: `Invalid YAML: ${e.message}`,
            tab
        });
        break;
    }
}
```

> **Key fix:** Uses `saveFileContentResult` (the existing message type) with `success: false` instead of inventing a new `saveError` message type. The frontend already handles `success: false` at line 2991. No new message type needed.

> **Dependency:** Add `js-yaml` to `package.json` dependencies: `npm install js-yaml && npm install @types/js-yaml --save-dev`.

### Phase 2 — Frontend: Preview Containers & JSON Tree Explorer

#### 2.1 Add a JSON preview container to the markup

**File:** `src/webview/planning.html` (inside `preview-pane-design`, after `image-preview-container-design`, ~line 2528)

```html
<div id="json-preview-container-design"
     style="display: none; flex: 1; overflow: auto; padding: 16px; font-family: var(--font-mono);">
    <!-- Tree rendered here by renderJsonTree() -->
</div>
```

#### 2.2 Add `state.activeFileType` tracking

**File:** `src/webview/planning.js`

Add `activeFileType` to the `state` object initialization (near the top of the IIFE):

```javascript
const state = {
    // ... existing fields ...
    activeFileType: null,  // 'json' | 'yaml' | 'markdown' | 'css' | 'xml' | 'text' | 'image' | null
};
```

In `handlePreviewReady` (design-folder branch, ~line 1849), store the file type:

```javascript
state.activeFileType = msg.fileType || null;
```

#### 2.3 Implement JSON tree renderer

**File:** `src/webview/planning.js`

Add a `renderJsonTree(data, depth, maxDepth)` function that:

1. Accepts a **parsed** JavaScript object/array/value (not a string).
2. Recursively walks the object/array graph.
3. Emits DOM nodes using `<div>` rows with CSS classes for syntax coloring:
   - `.json-key` — object keys
   - `.json-string` — string values
   - `.json-number` — numbers
   - `.json-boolean` — `true`/`false`
   - `.json-null` — `null`
4. Wraps objects and arrays in collapsible `<details>` / `<summary>` pairs.
5. **Depth limit:** `maxDepth` defaults to 2. Nodes at `depth < maxDepth` get `open` attribute; deeper nodes start collapsed. This prevents large JSON from creating a massive DOM on first render.
6. **Circular-reference safety:** Track only objects/arrays in a `WeakSet` (primitives cannot be added to `WeakSet` — only `typeof x === 'object' && x !== null`). On revisit, render `"[Circular]"` instead of recursing.

```javascript
function renderJsonTree(data, depth, maxDepth, seen) {
    depth = depth || 0;
    maxDepth = maxDepth || 2;
    seen = seen || new WeakSet();

    // Primitives
    if (data === null) {
        const span = document.createElement('span');
        span.className = 'json-null';
        span.textContent = 'null';
        return span;
    }
    if (typeof data !== 'object') {
        const span = document.createElement('span');
        span.className = 'json-' + typeof data;
        span.textContent = typeof data === 'string' ? '"' + data + '"' : String(data);
        return span;
    }

    // Circular reference guard — only track objects/arrays
    if (seen.has(data)) {
        const span = document.createElement('span');
        span.className = 'json-null';
        span.textContent = '[Circular]';
        return span;
    }
    seen.add(data);

    const isArray = Array.isArray(data);
    const entries = isArray ? data : Object.entries(data);
    const isOpen = depth < maxDepth;

    const details = document.createElement('details');
    details.className = 'json-node';
    if (isOpen) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'json-bracket';
    const countLabel = isArray
        ? `${data.length} items`
        : `${Object.keys(data).length} keys`;
    summary.textContent = isArray ? `[ ${countLabel} ]` : `{ ${countLabel} }`;
    details.appendChild(summary);

    const children = document.createElement('div');
    children.className = 'json-children';

    if (isArray) {
        data.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'json-row';
            const idx = document.createElement('span');
            idx.className = 'json-number';
            idx.textContent = String(i) + ':';
            row.appendChild(idx);
            row.appendChild(renderJsonTree(item, depth + 1, maxDepth, seen));
            children.appendChild(row);
        });
    } else {
        for (const [key, val] of Object.entries(data)) {
            const row = document.createElement('div');
            row.className = 'json-row';
            const keySpan = document.createElement('span');
            keySpan.className = 'json-key';
            keySpan.textContent = '"' + key + '"';
            row.appendChild(keySpan);
            row.appendChild(document.createTextNode(': '));
            row.appendChild(renderJsonTree(val, depth + 1, maxDepth, seen));
            children.appendChild(row);
        }
    }

    details.appendChild(children);
    return details;
}
```

#### 2.4 Wire `handlePreviewReady` to route by `fileType`

**File:** `src/webview/planning.js` (design-folder branch, lines 1846-1912)

In `handlePreviewReady`, when `sourceId === 'design-folder'`, branch on `msg.fileType`:

```javascript
// Store file type in state
state.activeFileType = msg.fileType || null;

const jsonCont = document.getElementById('json-preview-container-design');

if (isImage && webviewUri) {
    // ... existing image path (unchanged) ...
    if (jsonCont) jsonCont.style.display = 'none';
} else if (msg.fileType === 'json') {
    // JSON preview
    if (imgCont) imgCont.style.display = 'none';
    if (mdPrev) mdPrev.style.display = 'none';
    if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
    if (jsonCont && !state.editMode.design) {
        jsonCont.style.display = 'block';
        jsonCont.innerHTML = '';
        try {
            jsonCont.appendChild(renderJsonTree(JSON.parse(content)));
        } catch (e) {
            jsonCont.innerHTML = `<div class="json-error">Failed to parse JSON: ${e.message}<br><button onclick="viewRawJson()">View Raw</button></div>`;
        }
    }
    if (btnEditDesign) btnEditDesign.disabled = false;
} else if (msg.fileType === 'yaml') {
    // YAML preview — use pre-parsed JSON from backend
    if (imgCont) imgCont.style.display = 'none';
    if (mdPrev) mdPrev.style.display = 'none';
    if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
    if (jsonCont && !state.editMode.design) {
        jsonCont.style.display = 'block';
        jsonCont.innerHTML = '';
        if (msg.parsedJson !== undefined) {
            try {
                jsonCont.appendChild(renderJsonTree(msg.parsedJson));
            } catch (e) {
                jsonCont.innerHTML = `<div class="json-error">Failed to render YAML tree: ${e.message}<br><button onclick="viewRawJson()">View Raw</button></div>`;
            }
        } else {
            // Backend parse failed — show raw
            jsonCont.innerHTML = `<div class="json-error">Invalid YAML on disk — cannot render tree.<br><button onclick="viewRawJson()">View Raw</button></div>`;
        }
    }
    if (btnEditDesign) btnEditDesign.disabled = false;
} else if (msg.fileType === 'css' || msg.fileType === 'xml' || msg.fileType === 'text') {
    // Plain text / code preview in markdown container
    if (imgCont) imgCont.style.display = 'none';
    if (jsonCont) jsonCont.style.display = 'none';
    if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
    if (mdPrev && !state.editMode.design) {
        mdPrev.style.display = 'block';
        const langClass = msg.fileType === 'css' ? 'language-css' : (msg.fileType === 'xml' ? 'language-xml' : '');
        mdPrev.innerHTML = `<pre><code class="${langClass}">${escapeHtml(content)}</code></pre>`;
    }
    if (btnEditDesign) btnEditDesign.disabled = false;
} else {
    // Markdown (default) — existing path
    if (imgCont) imgCont.style.display = 'none';
    if (jsonCont) jsonCont.style.display = 'none';
    // ... existing markdown render logic ...
    if (mdPrev && !state.editMode.design) {
        mdPrev.innerHTML = renderMarkdown(content || '');
    }
    if (btnEditDesign) btnEditDesign.disabled = false;
}
```

> **Note:** Also add a `viewRawJson()` helper that hides `json-preview-container-design`, shows `markdown-preview-design`, and renders the raw content in a `<pre><code>` block.

#### 2.5 Edit mode for JSON/YAML

**File:** `src/webview/planning.js`

**`enterEditMode('design')`** — add hide for `json-preview-container-design`:

In the `enterEditMode` function (~line 3840), when `tab === 'design'`, add:

```javascript
const jsonCont = document.getElementById('json-preview-container-design');
if (jsonCont) jsonCont.style.display = 'none';
```

**`exitEditMode('design', saved)`** — add show logic for JSON/YAML:

In the `exitEditMode` function (~line 3875), when `tab === 'design'` and `saved === true`, after the existing markdown re-render, add branching:

```javascript
if (state.activeFileType === 'json' || state.activeFileType === 'yaml') {
    // Show JSON tree instead of markdown preview
    if (mdPrev) mdPrev.style.display = 'none';
    const jsonCont = document.getElementById('json-preview-container-design');
    if (jsonCont) {
        jsonCont.style.display = 'block';
        jsonCont.innerHTML = '';
        try {
            if (state.activeFileType === 'json') {
                jsonCont.appendChild(renderJsonTree(JSON.parse(state.activeDocContent)));
            }
            // For YAML: the tree was already rendered from parsedJson in handlePreviewReady;
            // after save, re-fetch triggers handlePreviewReady which will re-render
        } catch (e) {
            jsonCont.innerHTML = `<div class="json-error">Parse error: ${e.message}</div>`;
        }
    }
}
```

**`saveFileContentResult` handler** — branch re-render on `state.activeFileType`:

In the `saveFileContentResult` handler (lines 2947-2959), after `exitEditMode('design', true)`, replace the unconditional `renderMarkdown()` call:

```javascript
// Existing: state.activeDocContent = textarea.value;
// Existing: exitEditMode('design', true);
const mdPrevDesign = document.getElementById('markdown-preview-design');
if (state.activeFileType === 'json' || state.activeFileType === 'yaml') {
    // Tree will be re-rendered by handlePreviewReady after auto-refresh
    // or by exitEditMode branching above
} else {
    if (mdPrevDesign) {
        mdPrevDesign.innerHTML = renderMarkdown(state.activeDocContent);
    }
}
```

#### 2.6 Disable Edit button appropriately

**File:** `src/webview/planning.js` (selectFile handler, lines 850-855)

Update the edit-button disable logic:

```javascript
const btnEditDesign = document.getElementById('btn-edit-design');
if (btnEditDesign) {
    const ext = docId.substring(docId.lastIndexOf('.')).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
    btnEditDesign.disabled = imageExts.includes(ext);
}
```

> **Simplification:** Since all new extensions are text-based and editable, the only non-editable types are images. The old logic only checked for images; the new whitelist doesn't add any binary types, so the check remains the same.

#### 2.7 Styling

**File:** `src/webview/planning.html` (CSS block)

Add dark-theme JSON tree styles:

```css
#json-preview-container-design {
    font-size: 12px;
    line-height: 1.6;
}
.json-node { margin-left: 16px; }
.json-row { display: flex; gap: 4px; padding: 1px 0; }
.json-key { color: #9cdcfe; }
.json-string { color: #ce9178; }
.json-number { color: #b5cea8; }
.json-boolean { color: #569cd6; }
.json-null { color: #569cd6; font-style: italic; }
.json-bracket { color: #d4d4d4; cursor: pointer; }
.json-error { color: var(--vscode-errorForeground, #ff6b6b); padding: 12px; }
.json-error button { margin-top: 8px; padding: 4px 12px; cursor: pointer; }
```

**Also add `json-preview-container-design` to the edit-mode CSS rule** (line 2113):

```css
.edit-mode #image-preview-container-design,
.edit-mode #json-preview-container-design {
    display: none !important;
}
```

### Phase 3 — Integration & Polish

#### 3.1 Auto-refresh behavior

When a watched JSON or YAML file changes on disk:

1. Backend re-fetches content.
2. Sends `previewReady` with `isAutoRefreshed: true`, `fileType`, and `parsedJson` (for YAML).
3. Frontend `handlePreviewReady` re-parses and re-renders the tree if not in edit mode.
4. If in edit mode, show the existing external-change warning banner (already works for markdown at line 1893-1900).

#### 3.2 Error handling

- **Malformed JSON in preview mode:** catch `JSON.parse` error in `handlePreviewReady`, render an error message inside `json-preview-container-design` with error details, and offer a **"View Raw"** button that falls back to plain text in a `<pre><code>` block.
- **Malformed YAML in preview mode:** backend `yaml.load()` fails, `parsedJson` is `undefined`. Frontend detects this and renders an error message with a **"View Raw"** button. Raw YAML text is still available in `msg.content`.
- **Malformed JSON/YAML in save mode:** backend rejects with `saveFileContentResult { success: false, error: '...' }`; frontend shows error in status bar (existing handler at line 2991).

#### 3.3 Empty state copy update

Update the empty-state message in `markdown-preview-design` (line 2523):

```html
<div class="empty-state">Select a design document, image, JSON, or YAML file from the sidebar to preview</div>
```

#### 3.4 Add `escapeHtml` helper

**File:** `src/webview/planning.js`

Add a small utility for safe HTML rendering of code content:

```javascript
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

## Proposed Changes

### `package.json`
- **Context:** Direct dependency list
- **Logic:** Add `js-yaml` as a direct dependency (already present as transitive dep via cosmiconfig, mocha, etc.)
- **Implementation:** Run `npm install js-yaml && npm install @types/js-yaml --save-dev`
- **Edge Cases:** None — `js-yaml` v4.1.1 is already in `node_modules` via transitive deps

### `src/services/LocalFolderService.ts` (line 596-599)
- **Context:** `_isDesignOrImageFile` whitelist filter
- **Logic:** Add `.json`, `.css`, `.scss`, `.less`, `.sass`, `.yaml`, `.yml`, `.xml` to the extension array
- **Implementation:** Replace the return array with the expanded list (see Phase 1.1)
- **Edge Cases:** `.js`/`.ts`/`.tsx`/`.jsx` intentionally excluded from v1 to avoid sidebar flooding

### `src/services/PlanningPanelProvider.ts` (lines 2546-2582)
- **Context:** `_handleFetchPreview` design-folder branch
- **Logic:** Add `fileType` classification, YAML backend parsing, and `parsedJson` field to `previewReady` message
- **Implementation:** Insert `fileTypeMap` lookup and `yaml.load()` after line 2564, add `fileType` and `parsedJson` to `postMessage` at line 2573
- **Edge Cases:** YAML parse failure — set `parsedJson = undefined`, frontend handles gracefully

### `src/services/PlanningPanelProvider.ts` (lines 1648-1689)
- **Context:** `saveFileContent` message handler
- **Logic:** Infer `fileType` from `path.extname(resolved)`, validate JSON/YAML before `writeFile`
- **Implementation:** Insert validation block between conflict detection (line 1678) and `writeFile` (line 1683)
- **Edge Cases:** Uses existing `saveFileContentResult` message type with `success: false` — no new message type needed

### `src/webview/planning.html` (~line 2528)
- **Context:** Design tab preview pane markup
- **Logic:** Add `#json-preview-container-design` div after `image-preview-container-design`
- **Implementation:** Insert HTML element (see Phase 2.1)
- **Edge Cases:** Must be inside `preview-content-wrapper` for flex layout

### `src/webview/planning.html` (CSS block, ~line 2113)
- **Context:** Edit-mode CSS rules
- **Logic:** Add `#json-preview-container-design` to the `display: none !important` rule
- **Implementation:** Add selector to existing rule (see Phase 2.7)
- **Edge Cases:** Must use `!important` to override inline `display: block` set by JS

### `src/webview/planning.js` (state object)
- **Context:** Global state initialization
- **Logic:** Add `activeFileType: null` field
- **Implementation:** Add field to state object (see Phase 2.2)
- **Edge Cases:** Must be reset to `null` when switching to a different file or tab

### `src/webview/planning.js` (handlePreviewReady, lines 1846-1912)
- **Context:** Design-folder preview rendering
- **Logic:** Branch on `msg.fileType` to route to JSON tree, YAML tree, code block, or markdown renderer
- **Implementation:** Add branching logic with hide/show for all containers (see Phase 2.4)
- **Edge Cases:** Must handle `parsedJson === undefined` for malformed YAML; must handle `JSON.parse` failure for malformed JSON

### `src/webview/planning.js` (enterEditMode / exitEditMode)
- **Context:** Edit mode toggle for design tab
- **Logic:** Hide `json-preview-container-design` on enter; show it (instead of markdown) on exit for JSON/YAML files
- **Implementation:** Add container references and branching (see Phase 2.5)
- **Edge Cases:** After save, YAML files need a re-fetch to get fresh `parsedJson` — the auto-refresh watcher handles this

### `src/webview/planning.js` (saveFileContentResult handler, lines 2947-2959)
- **Context:** Save success callback for design tab
- **Logic:** Skip `renderMarkdown()` for JSON/YAML files; tree re-render happens via `exitEditMode` branching or `handlePreviewReady` auto-refresh
- **Implementation:** Add `state.activeFileType` check before `renderMarkdown()` call (see Phase 2.5)
- **Edge Cases:** For YAML, the tree needs `parsedJson` which is only available from `handlePreviewReady` — the file watcher will trigger a re-fetch

### `src/webview/planning.js` (new functions)
- **Context:** JSON tree rendering and HTML escaping
- **Logic:** Add `renderJsonTree()`, `escapeHtml()`, and `viewRawJson()` helper functions
- **Implementation:** Add functions in the utility section (see Phase 2.3 and 3.4)
- **Edge Cases:** `WeakSet` only tracks objects/arrays; depth limit prevents DOM explosion on large files

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `js-yaml` dependency; add `@types/js-yaml` dev dependency |
| `src/services/LocalFolderService.ts` | Expand `_isDesignOrImageFile` whitelist (line 596-599) |
| `src/services/PlanningPanelProvider.ts` | Add `fileType` + `parsedJson` to `previewReady` (line 2573); add JSON/YAML validation in `saveFileContent` handler (line 1678-1683) |
| `src/webview/planning.html` | Add `#json-preview-container-design` markup (line ~2528); add JSON tree CSS styles; add `#json-preview-container-design` to edit-mode CSS rule (line ~2113) |
| `src/webview/planning.js` | Add `state.activeFileType`; add `renderJsonTree()`; add `escapeHtml()`; add `viewRawJson()`; wire `fileType` routing in `handlePreviewReady`; update `enterEditMode`/`exitEditMode` for JSON/YAML; update `saveFileContentResult` re-render; update edit-button logic |

## Verification Plan

### Automated Tests

- **No compilation step** (session directive: skip compilation)
- **No automated test run** (session directive: skip tests)

### Manual Verification Checklist

1. **Sidebar visibility:** Configure a design-system folder containing `.json`, `.yaml`, `.css`, `.xml` files. Verify all appear in the sidebar tree.
2. **JSON preview:** Select a valid JSON file. Verify collapsible tree renders with correct syntax colors and depth-2 auto-expand.
3. **YAML preview:** Select a valid YAML file. Verify it parses into the same tree component with correct structure.
4. **JSON edit:** Click Edit, modify a value, click Save. Verify file updates and tree re-renders.
5. **YAML edit:** Click Edit on a YAML file, modify a value, click Save. Verify file updates and tree re-renders.
6. **JSON save validation:** Introduce a JSON syntax error, click Save. Verify error appears in status bar and file is NOT written.
7. **YAML save validation:** Introduce a YAML syntax error (e.g. bad indentation), click Save. Verify error appears in status bar.
8. **Malformed JSON preview:** Select a file with invalid JSON. Verify friendly error message appears with "View Raw" button.
9. **Malformed YAML preview:** Select a file with invalid YAML. Verify friendly error message appears with "View Raw" button.
10. **Auto-refresh:** Edit a JSON or YAML file externally. Verify tree updates automatically (when not in edit mode).
11. **Other file types:** Select `.css`, `.xml`. Verify they render as formatted text in the preview pane.
12. **Regression:** Existing markdown and image previews in the Design System tab continue to work.
13. **Edit-mode CSS:** Enter edit mode on a JSON file. Verify `json-preview-container-design` is hidden and textarea is visible.
14. **Circular JSON:** Preview a JSON file with circular references. Verify `[Circular]` placeholder renders instead of infinite recursion.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Large JSON files (>1 MB) cause UI lag during tree render | Medium | Medium | Depth limit (default 2 levels open) prevents massive DOM on first render. Virtual-scrolling can be deferred to follow-up. |
| `.js`/`.ts` files accidentally routed as JSON | Low | Low | **Excluded from v1 whitelist.** `fileTypeMap` is extension-based; JS/TS would fall through to `'text'` if added later. |
| Existing `renderMarkdown()` is bypassed for CSS/YAML/XML, losing custom block styling | Low | Low | Wrap in `<pre><code>` with language class so CSS theme can target it. |
| Adding extensions to `_isDesignOrImageFile` increases sidebar scan time | Low | Low | The existing `_MAX_DEPTH` and `_TITLE_EXTRACTION_FILE_LIMIT` guards prevent runaway scans. |
| YAML save writes raw text — no round-trip normalization | Low | Low | By design: raw text is written as-is. Only well-formedness is validated, not formatting. |

## Open Questions (for discussion)

1. **`.js`/`.ts`/`.tsx`/`.jsx` sidebar visibility:** Should these be added via an opt-in config flag in v1, or deferred entirely? (Current plan: deferred.)
2. **Search/filter inside JSON/YAML tree:** Is a find-in-tree search box needed for v1? (Recommendation: defer. Browser Ctrl+F works on rendered DOM.)

---

**Recommendation:** Complexity 6 → **Send to Coder**
