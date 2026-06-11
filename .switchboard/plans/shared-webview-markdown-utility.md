# Extract `renderMarkdown()` and `renderJsonTree()` into a Shared Webview Utility

## Goal

Fix the design panel's unstyled markdown/text previews by making the `renderMarkdown()` function available to `design.js`, and simultaneously eliminate the `renderJsonTree()` duplication between `design.js` and `planning.js` by extracting both into a shared webview script.

`renderMarkdown()` lives only in `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:636`). It converts raw markdown into styled HTML (headers, tables, blockquotes, code fences, alert boxes). `design.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:814`) dumps raw file content directly into the DOM: `mdPrev.innerHTML = content || '';`. No conversion happens, so `# Heading` remains literal text. The CSS selectors for `#markdown-preview-design` are already present and identical to the planning panel's selectors — the styles are there, but the DOM elements they target don't exist because markdown was never parsed into HTML.

`renderJsonTree()` is also duplicated: it exists in both `design.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js:248`) and `planning.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:827`). The implementations differ slightly (default parameters vs manual fallback checks). Neither `design.html` nor `planning.html` currently loads any shared JS utility. Each loads a single monolithic script.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, refactor, ui, library

## User Review Required

- None. All requirements are derived from existing code deduplication and bug-fix scope.

## Complexity Audit

### Routine
- Extract four existing functions (`TABLE_SEPARATOR_REGEX`, `parseTableBlock`, `renderMarkdown`, `renderJsonTree`) from `planning.js` into a new shared file.
- Remove duplicate `renderJsonTree` from `design.js` and the four functions from `planning.js`.
- Add `<script>` tag placeholders to `design.html` and `planning.html`.
- Add URI substitution logic in `DesignPanelProvider.ts` and `PlanningPanelProvider.ts`.
- Webpack `CopyPlugin` already copies `src/webview/*.js` to `dist/webview/`, so no build configuration changes are needed.

### Complex / Risky
- None. The two `renderJsonTree` implementations differ only in default-parameter style (ES6 defaults in `design.js` vs manual fallback in `planning.js`). The planning.js version is canonical and handles edge cases identically.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Script loading is synchronous and ordered (`sharedUtils.js` before panel script).
- **Security:** The new `<script>` tag must carry `nonce="{{NONCE}}"` to satisfy VS Code webview CSP. `renderMarkdown` escapes HTML before processing, preventing XSS from raw file content.
- **Side Effects:** These are pure DOM/string helpers with no external state. Removing them from closures does not affect other logic.
- **Dependencies & Conflicts:** No other files depend on these local functions. No package dependencies change.

## Dependencies

- None — self-contained within the webview layer.

## Adversarial Synthesis

Key risks: build drift is mitigated because `webpack.config.js` already glob-copies `src/webview/*.js` to `dist/webview/`. CSP nonce omission would silently block the shared script; both HTML templates already use `{{NONCE}}` so the pattern is trivial to replicate. Silent global shadowing is the real danger — if any local copy of `renderMarkdown` or `renderJsonTree` survives extraction, the shared utility will be ignored without error. Mitigations: grep both `design.js` and `planning.js` post-edit to confirm zero occurrences of the extracted function names, and verify all 6+ call sites in `planning.js` still resolve.

## Proposed Changes

### `src/webview/sharedUtils.js` (new file)
- **Context:** Both `design.js` and `planning.js` need `renderMarkdown()` and `renderJsonTree()`. Currently only `planning.js` has `renderMarkdown()`, and both have slightly different `renderJsonTree()`.
- **Logic:** Use `planning.js` as canonical source. Extract `TABLE_SEPARATOR_REGEX`, `parseTableBlock(lines)`, `renderMarkdown(markdown)`, and `renderJsonTree(data, depth, maxDepth, seen)`. Keep `renderJsonTree` signature without ES6 defaults (matching planning.js internal call pattern) but maintain robust null/undefined handling.
- **Implementation:** Create new file. Export nothing — these are global functions for the webview runtime. Include the full implementations from `planning.js` lines 577-825 (renderMarkdown + helpers) and lines 827-900 (renderJsonTree).
- **Edge Cases:** Ensure `renderMarkdown`'s escaped-backtick restoration logic (`__ESCAPED_BACKTICK__`) remains intact. Ensure `renderJsonTree` `WeakSet` circular-reference guard is preserved.

### `src/webview/design.html`
- **Context:** Loads only `design.js`. Needs shared utilities before panel script.
- **Logic:** Insert `<script nonce="{{NONCE}}" src="{{SHARED_UTILS_URI}}"></script>` before the existing `{{DESIGN_JS_URI}}` script tag (bottom of `<body>`, currently line ~3388).
- **Edge Cases:** Nonce attribute required for CSP compliance.

### `src/webview/planning.html`
- **Context:** Loads only `planning.js`. Needs shared utilities before panel script.
- **Logic:** Insert identical script tag before `{{PLANNING_JS_URI}}` (bottom of `<body>`, currently line ~3287).
- **Edge Cases:** Nonce attribute required for CSP compliance.

### `src/services/DesignPanelProvider.ts`
- **Context:** `_getHtml()` substitutes asset URIs into the HTML template.
- **Logic:** After the `designJsUri` substitution (line 163), add:
  ```ts
  const sharedUtilsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedUtils.js')
  );
  htmlContent = htmlContent.replace(/\{\{SHARED_UTILS_URI\}\}/g, sharedUtilsUri.toString());
  ```
- **Edge Cases:** Must reference `dist/webview/sharedUtils.js` to match the runtime copy path.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `_getHtml()` substitutes asset URIs.
- **Logic:** After the `planningJsUri` substitution (line 741), add identical `sharedUtilsUri` creation and `{{SHARED_UTILS_URI}}` replacement.
- **Edge Cases:** Same path convention as DesignPanelProvider.

### `src/webview/design.js`
- **Context:** Contains a local `renderJsonTree()` (lines 248-311) and dumps raw markdown at line 814.
- **Logic:**
  1. Delete local `renderJsonTree()` definition (lines 248-311).
  2. In `handlePreviewReady()`, change line 814 from `mdPrev.innerHTML = content || '';` to `mdPrev.innerHTML = renderMarkdown(content) || '';`.
- **Edge Cases:** Confirm no other call sites reference the deleted local `renderJsonTree` (only lines 785 and 799 in `design.js` call it; they will resolve to global). The `renderMarkdown` global must be available before `design.js` runs, ensured by script tag order in HTML.

### `src/webview/planning.js`
- **Context:** Contains canonical versions of `TABLE_SEPARATOR_REGEX` (line 577), `parseTableBlock()` (lines 579-633), `renderMarkdown()` (lines 636-825), and `renderJsonTree()` (lines 827-900).
- **Logic:** Delete all four definitions. Verify existing call sites still resolve to global:
  - `renderMarkdown`: lines 1909, 1974, 3004, 3041, 3054, 4293.
  - `parseTableBlock` & `TABLE_SEPARATOR_REGEX`: used inside `renderMarkdown` (now global).
  - `renderJsonTree`: line 3022.
- **Edge Cases:** Because `planning.js` is an IIFE, removing these functions from its top-level scope does not break closure captures elsewhere.

### Build & packaging
- **Context:** `webpack.config.js` uses `CopyPlugin` with pattern `src/webview/*.js` → `dist/webview/[name][ext]`.
- **Logic:** No changes needed. `sharedUtils.js` will be copied automatically.
- **Edge Cases:** Confirm the pattern `from: 'src/webview/*.js'` is present in `webpack.config.js` (line 84).

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

## Verification Plan

### Automated Tests
- No new automated tests needed — this is a pure relocation refactor with no logic changes.
- Compilation and test suite execution are skipped per session directive.

### Manual Verification
1. Open a `.md` or `.txt` file in the **Design** panel → confirm headings, lists, code blocks, tables, and alert boxes render with correct styling.
2. Open a `.json` file in the **Design** panel → confirm the JSON tree renders correctly.
3. Open a plan file in the **Planning** panel → confirm the local markdown preview, online markdown preview, and kanban plan preview all still render correctly.
4. Open a `.json` or `.yaml` file in the **Planning** panel's design-folder tab → confirm JSON tree rendering still works.
5. Build verification: confirm `dist/webview/sharedUtils.js` exists after build.

## Risks & Edge Cases

- **Build drift**: If `webpack.config.js` or `package.json` build scripts only copy/selectively bundle known webview JS files, the new `sharedUtils.js` may be silently omitted from the `dist/` output, breaking both panels at runtime.
- **CSP blocking**: The new `<script>` tag must carry `nonce="{{NONCE}}"` to satisfy the VS Code webview CSP. Forgetting the nonce will cause the browser to refuse execution.
- **Silent global shadowing**: If `planning.js` or `design.js` accidentally retains a local function with the same name after extraction, the local copy will shadow the shared global and the deduplication will fail silently.
- **renderJsonTree divergence**: The two existing `renderJsonTree()` implementations are not identical (default parameters vs manual fallback). The planning version should be treated as canonical, but verify the design panel's JSON preview doesn't regress on edge cases like circular references or deeply nested objects.
- **Stale CSS**: The design panel already has the unified markdown CSS (it's copy-pasted identically in both HTML files). No CSS changes are needed, but confirm the `#markdown-preview-design` element is visible when a markdown file is selected (it is hidden for images and JSON).

---

**Recommendation:** Send to Coder
