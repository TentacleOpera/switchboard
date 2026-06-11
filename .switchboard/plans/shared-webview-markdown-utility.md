# Extract `renderMarkdown()` and `renderJsonTree()` into a Shared Webview Utility

## Metadata

- **Complexity:** 4
- **Tags:** frontend, refactor, ui, bugfix

## Goal

Fix the design panel's unstyled markdown/text previews by making the `renderMarkdown()` function available to `design.js`, and simultaneously eliminate the `renderJsonTree()` duplication between `design.js` and `planning.js` by extracting both into a shared webview script.

## Problem Analysis

- `renderMarkdown()` lives only in `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:636`). It converts raw markdown into styled HTML (headers, tables, blockquotes, code fences, alert boxes).
- `design.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:814`) dumps raw file content directly into the DOM: `mdPrev.innerHTML = content || '';`. No conversion happens, so `# Heading` remains literal text.
- The CSS selectors for `#markdown-preview-design` are already present and identical to the planning panel's selectors — the styles are there, but the DOM elements they target don't exist because markdown was never parsed into HTML.
- `renderJsonTree()` is also duplicated: it exists in both `design.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:248`) and `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:827`). The implementations differ slightly (default parameters vs manual fallback checks).
- Neither `design.html` nor `planning.html` currently loads any shared JS utility. Each loads a single monolithic script.

## Implementation Steps

1. **Create `src/webview/sharedUtils.js`**
   - Extract `TABLE_SEPARATOR_REGEX`, `parseTableBlock(lines)`, `renderMarkdown(markdown)`, and `renderJsonTree(data, depth, maxDepth, seen)`.
   - Use the `planning.js` implementation as the canonical source for all four, since it is the more mature version (it handles edge cases like escaped backticks, header deduplication, and blockquote grouping).
   - For `renderJsonTree`, adopt the `planning.js` signature `(data, depth, maxDepth, seen)` without defaults (matches its internal call pattern) but keep it robust.
   - Export nothing — these are global functions for the webview runtime.

2. **Update `design.html`**
   - Add a `<script nonce="{{NONCE}}" src="{{SHARED_UTILS_URI}}"></script>` line **before** the existing `{{DESIGN_JS_URI}}` script tag.

3. **Update `planning.html`**
   - Add the same `<script nonce="{{NONCE}}" src="{{SHARED_UTILS_URI}}"></script>` line **before** the existing `{{PLANNING_JS_URI}}` script tag.

4. **Update `DesignPanelProvider.ts`**
   - In `_getHtml()`, create a `sharedUtilsUri` via `webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedUtils.js'))`.
   - Substitute `{{SHARED_UTILS_URI}}` in the HTML string.

5. **Update `PlanningPanelProvider.ts`**
   - Apply the identical URI substitution logic in its `_getHtml()` method.

6. **Deduplicate `design.js`**
   - Remove its local `renderJsonTree()` definition.
   - Update the markdown/text branch in `handlePreviewReady()` (around line 814) from `mdPrev.innerHTML = content || ''` to `mdPrev.innerHTML = renderMarkdown(content) || ''`.

7. **Deduplicate `planning.js`**
   - Remove its local definitions of `TABLE_SEPARATOR_REGEX`, `parseTableBlock()`, `renderMarkdown()`, and `renderJsonTree()`.
   - Verify all 6 existing call sites still resolve to the global functions loaded from `sharedUtils.js`.

8. **Build & packaging**
   - Ensure `sharedUtils.js` is copied to `dist/webview/` during the build. The extension providers reference `dist/webview/` for their JS assets, so the file must end up there.
   - If the project uses `webpack.config.js` to bundle webview files, verify the new file is included. If it uses a simple copy step, add `sharedUtils.js` to it.

9. **Verification**
   - Open a `.md` or `.txt` file in the **Design** panel → confirm headings, lists, code blocks, tables, and alert boxes render with correct styling.
   - Open a `.json` file in the **Design** panel → confirm the JSON tree renders correctly.
   - Open a plan file in the **Planning** panel → confirm the local markdown preview, online markdown preview, and kanban plan preview all still render correctly.
   - Open a `.json` or `.yaml` file in the **Planning** panel's design-folder tab → confirm JSON tree rendering still works.

## Risks & Edge Cases

- **Build drift**: If `webpack.config.js` or `package.json` build scripts only copy/selectively bundle known webview JS files, the new `sharedUtils.js` may be silently omitted from the `dist/` output, breaking both panels at runtime.
- **CSP blocking**: The new `<script>` tag must carry `nonce="{{NONCE}}"` to satisfy the VS Code webview CSP. Forgetting the nonce will cause the browser to refuse execution.
- **Silent global shadowing**: If `planning.js` or `design.js` accidentally retains a local function with the same name after extraction, the local copy will shadow the shared global and the deduplication will fail silently.
- **renderJsonTree divergence**: The two existing `renderJsonTree()` implementations are not identical (default parameters vs manual fallback). The planning version should be treated as canonical, but verify the design panel's JSON preview doesn't regress on edge cases like circular references or deeply nested objects.
- **Stale CSS**: The design panel already has the unified markdown CSS (it's copy-pasted identically in both HTML files). No CSS changes are needed, but confirm the `#markdown-preview-design` element is visible when a markdown file is selected (it is hidden for images and JSON).
