# Fix Local HTML Previews JavaScript and Rendering Issues

## Metadata
**Complexity:** 3
**Tags:** frontend, bugfix, security, ui

## Goal

Resolve the issue where local HTML previews (like `pii-fix-before-after.html` and `index.html`) fail to render or execute JavaScript, resulting in a blank screen or unresponsive interactive elements.

### Problem Analysis & Root Cause
1. **Inherited CSP Nonce Blocking Inline Scripts:** The parent webview's CSP contains a dynamic `nonce` value to secure scripts. If the iframe has `allow-same-origin`, it inherits the parent CSP. This disables any inline scripts (like `<script type="text/babel">` in `pii-fix-before-after.html`) that lack the dynamic nonce, causing them to be blocked by the browser.
2. **Access to localStorage/sessionStorage Throwing Security Errors:** To bypass the CSP inheritance, a previous plan removed `allow-same-origin` from the iframe sandbox. However, running the iframe in a `null` origin context causes any access to `window.localStorage` or `window.sessionStorage` (such as the initialization code in `index.html`) to throw a `SecurityError`. This halts JavaScript execution immediately, rendering the page unresponsive.
3. **CORS/Service Worker Blocks on Null Origin:** In a `null` origin context, absolute scripts loaded via CORS (with `crossorigin` attribute) or requests intercepted by VS Code's webview service worker may be blocked or fail to load.

### Proposed Solution
1. **Restore `allow-same-origin`:** Add `allow-same-origin` back to the iframe's `sandbox` attribute in `planning.html`. This runs the preview in the webview's origin, allowing access to `localStorage`/`sessionStorage` and ensuring CDN scripts and relative assets resolve correctly without CORS issues.
2. **Store and Inject Parent Nonce:**
   - In `PlanningPanelProvider.ts`, store the generated dynamic `nonce` on the provider instance.
   - When serving HTML content in `_handleFetchPreview` / `_injectLocalCsp`, dynamically inject the stored `nonce` attribute into all `<script>` tags (e.g., `<script nonce="THE_NONCE" ...>`).
   - This satisfies the parent CSP's nonce requirement, allowing inline and external scripts to execute successfully.

---

## User Review Required

> [!IMPORTANT]
> Restoring `allow-same-origin` allows the previewed HTML document to run in the same origin as the parent webview. This means it can access the parent document (`window.parent`). However, since `acquireVsCodeApi()` can only be called once per webview, the previewed HTML cannot invoke VS Code APIs directly. This is a secure and standard way to preview user workspace designs.

---

## Open Questions

None.

---

## Complexity Audit

### Routine
- Adding `allow-same-origin` to iframe sandbox attribute (single attribute change in `planning.html` line 2260)
- Adding `_nonce` private property to `PlanningPanelProvider` class (line 64)
- Capturing nonce value in `_getHtml` method (line 640)
- Injecting nonce into `<script>` tags via regex in `_injectLocalCsp` (line 678)

### Complex / Risky
- CSP nonce inheritance behavior in VS Code webview srcdoc iframes — the plan assumes parent CSP is inherited by srcdoc iframes with `allow-same-origin`, which depends on VS Code's webview implementation (may differ from standard Chromium where `<meta>` CSP does not cascade into srcdoc)
- Regex-based nonce injection (`/<script\b/gi`) could double-nonce script tags that already carry a `nonce` attribute, producing invalid markup like `<script nonce="X" nonce="Y">`

---

## Edge-Case & Dependency Audit

- **Race Conditions:** `_nonce` is set in `_getHtml` (called once at panel open, line 640) and read in `_injectLocalCsp` (called per preview fetch, line 2116). Since `_getHtml` completes synchronously before any preview can be fetched, no race exists. If the panel is disposed and reopened, `_getHtml` generates a fresh nonce, which is correct.
- **Security:** Restoring `allow-same-origin` gives the previewed HTML access to `window.parent`. However, `acquireVsCodeApi()` can only be called once per webview, so the preview cannot invoke VS Code APIs. The preview content is user workspace files, not untrusted network content. The nonce injection ensures scripts satisfy the parent CSP rather than bypassing it.
- **Side Effects:** The `_injectLocalCsp` function injects a permissive CSP (`script-src 'unsafe-inline' 'unsafe-eval' ...`) into the preview HTML. If the parent CSP IS inherited, two CSPs apply simultaneously and each must be independently satisfied. The nonce on script tags satisfies the parent CSP; `'unsafe-inline'` in the iframe's own CSP is satisfied by any inline script. No conflict.
- **Dependencies & Conflicts:** The `injectBaseTag` function in `planning.js` (line 350) adds a `<base>` tag to the srcdoc content for relative asset resolution. This runs client-side after `_injectLocalCsp` runs server-side. No conflict — the base tag is added to `<head>`, the nonce is added to `<script>` tags.

---

## Dependencies

None.

---

## Adversarial Synthesis

Key risks: (1) The parent CSP inheritance assumption may not hold in standard Chromium `<meta>` CSP delivery — VS Code's webview layer may or may not enforce it. (2) The naive regex `/<script\b/gi` will double-nonce any script tag that already has a `nonce` attribute. Mitigations: The nonce injection is a low-cost safety measure that works regardless of inheritance; the regex should be hardened to skip tags already carrying a nonce attribute.

---

## Proposed Changes

### Webview HTML & Services

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html)

Add `allow-same-origin` back to the preview iframe `sandbox` attribute.

**Line 2260:**

```diff
-                     <iframe id="html-preview-frame" sandbox="allow-scripts" style="flex: 1; border: none; background: white; width: 100%; height: 100%;"></iframe>
+                     <iframe id="html-preview-frame" sandbox="allow-scripts allow-same-origin" style="flex: 1; border: none; background: white; width: 100%; height: 100%;"></iframe>
```

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)

1. Add a private property `_nonce` to store the dynamically generated nonce.
2. Capture the nonce in `_getHtml`.
3. Update `_injectLocalCsp` to inject the stored nonce into all `<script>` tags in the HTML preview content, skipping tags that already have a nonce attribute.

**Line 64 — add `_nonce` property:**

```diff
     private _isAutoRefreshing: boolean = false;
+    private _nonce: string = '';
     private _activePreviewPath: string | null = null;
```

**Line 640 — capture nonce in `_getHtml`:**

```diff
     private _getHtml(webview: vscode.Webview): string {
         const nonce = crypto.randomBytes(16).toString('base64');
+        this._nonce = nonce;
         const cspSource = webview.cspSource;
```

**Lines 678–691 — update `_injectLocalCsp` to inject nonce into script tags:**

```diff
     private _injectLocalCsp(html: string): string {
         const cspTag = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: vscode-webview: vscode-webview-resource: vscode-resource:; style-src 'unsafe-inline' https: vscode-webview: vscode-webview-resource: vscode-resource:; img-src data: blob: https: vscode-webview: vscode-webview-resource: vscode-resource:; font-src data: https: vscode-webview: vscode-webview-resource: vscode-resource:; connect-src https: data:;">`;
-        const headMatch = html.match(/<head\b[^>]*>/i);
-        if (headMatch && headMatch.index !== undefined) {
-            const index = headMatch.index + headMatch[0].length;
-            return html.slice(0, index) + '\n  ' + cspTag + html.slice(index);
-        }
-        const htmlMatch = html.match(/<html\b[^>]*>/i);
-        if (htmlMatch && htmlMatch.index !== undefined) {
-            const index = htmlMatch.index + htmlMatch[0].length;
-            return html.slice(0, index) + '\n<head>' + cspTag + '</head>' + html.slice(index);
-        }
-        return cspTag + '\n' + html;
+        let processedHtml = html;
+        const headMatch = html.match(/<head\b[^>]*>/i);
+        if (headMatch && headMatch.index !== undefined) {
+            const index = headMatch.index + headMatch[0].length;
+            processedHtml = html.slice(0, index) + '\n  ' + cspTag + html.slice(index);
+        } else {
+            const htmlMatch = html.match(/<html\b[^>]*>/i);
+            if (htmlMatch && htmlMatch.index !== undefined) {
+                const index = htmlMatch.index + htmlMatch[0].length;
+                processedHtml = html.slice(0, index) + '\n<head>' + cspTag + '</head>' + html.slice(index);
+            } else {
+                processedHtml = cspTag + '\n' + html;
+            }
+        }
+
+        if (this._nonce) {
+            // Inject nonce into <script> tags that don't already have one,
+            // avoiding double-nonce on tags that already carry a nonce attribute.
+            processedHtml = processedHtml.replace(/<script(?![^>]*\bnonce=)(\s[^>]*)?>/gi, `<script nonce="${this._nonce}"$1>`);
+        }
+        return processedHtml;
     }
```

**Clarification on regex:** The pattern `/<script(?![^>]*\bnonce=)(\s[^>]*)?>/gi` uses a negative lookahead to skip any `<script>` tag that already contains a `nonce=` attribute, preventing double-nonce markup. The capture group `(\s[^>]*)` preserves existing attributes (e.g., `type="text/babel"`, `src="..."`).

---

## Verification Plan

### Automated Tests
None.

### Manual Verification
1. Open the HTML Previews tab in the Switchboard planning panel.
2. Select `pii-fix-before-after.html` and verify that the page renders correctly (showing the "Portal PII Fix — Coach Experience..." title and tables) instead of a blank white screen.
3. Select `index.html` and verify that the interactive navigation and features work, and that clicking links or buttons executes JavaScript normally.
4. Inspect the VS Code Developer Tools (`Help -> Toggle Developer Tools`) to confirm no new CSP violations or `localStorage` `SecurityError` exceptions are thrown.
5. Verify that HTML files with `<script>` tags that already have a `nonce` attribute do not produce double-nonce markup (check via DevTools Elements panel).

---

## Review Pass — 2026-06-05

### Stage 1: Grumpy Principal Engineer Adversarial Review

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | Regex `(\s[^>]*)` on `<script>` with no attributes — JS replace with non-participating group produces empty string, output is correct | ~~CRITICAL~~ → OK | Empirically verified: `<script>` → `<script nonce="ABC">` |
| 2 | Base64 nonce chars (`+`, `/`, `=`) in HTML attribute context | NIT | Safe inside double quotes; consistent with existing `{{NONCE}}` pattern |
| 3 | Dual CSP conflict: parent nonce-required + iframe `'unsafe-inline'` | ~~MAJOR~~ → OK | Both CSPs independently satisfied; nonce passes parent, `'unsafe-inline'` passes iframe |
| 4 | Self-closing `<script/>` tags | NIT | Pre-existing in source HTML, not introduced by plan |
| 5 | Multi-line `<script>` tags — `[^>]` matches newlines | ~~MAJOR~~ → OK | `[^>]` is negated char class, matches `\n`; empirically verified |
| 6 | `<scripting>` / `<scripture>` false match | NIT | Theoretically possible, practically impossible |
| 7 | `allow-same-origin` security trade-off | OK | Already documented in User Review Required section |
| 8 | No HTML-escaping of nonce value in attribute interpolation | NIT | Base64 output is safe; consistent with existing codebase pattern at line 669 |
| 9 | `_nonce` never cleared/reset between panel recreations | NIT | `_getHtml` runs synchronously before any preview fetch; no race possible |

### Stage 2: Balanced Synthesis

**What to Keep (No Changes Needed):**
- `allow-same-origin` in iframe sandbox (line 2260 of `planning.html`) — correctly implemented
- `_nonce` property (line 65) — correctly initialized and set
- Nonce capture in `_getHtml` (line 642) — synchronous, no race
- Nonce injection regex (line 700) — works correctly for all practical cases; negative lookahead prevents double-nonce
- CSP injection refactor (lines 682–695) — clean `processedHtml` variable usage
- Dual-CSP approach — scripts with nonce pass both policies

**What to Fix Now:** Nothing — no CRITICAL or MAJOR findings survived scrutiny.

**Deferred NITs:**
- `data-nonce` false negative: regex skips `<script data-nonce="x">` because `\bnonce=` matches inside `data-nonce=`. Extremely unlikely in practice; iframe's own CSP allows `'unsafe-inline'` so no functional impact.
- HTML-escaping nonce: defense-in-depth suggestion, but Base64 is safe and consistent with existing pattern.

### Code Fixes Applied

None required. Implementation matches plan exactly.

### Verification Results

- **TypeScript (`tsc --noEmit`):** No errors in `PlanningPanelProvider.ts`. Two pre-existing errors in unrelated files (`ClickUpSyncService.ts:2310`, `KanbanProvider.ts:4788`) — relative import path extension issues, not related to this plan.
- **ESLint:** No config file present in project; not applicable.
- **Regex empirical testing:** All 8 test cases pass correctly (no-attr script, type attr, existing nonce skip, src attr, data-nonce skip, multiple scripts, multiline, closing tag non-match).

### Remaining Risks

1. **CSP inheritance assumption:** If parent CSP is NOT inherited by srcdoc iframe, nonce injection is harmless (iframe's own CSP allows `'unsafe-inline'`). If inherited, nonce is required and correctly provided. Implementation is safe in both scenarios.
2. **Future nonce generation changes:** If encoding changes from Base64, unescaped interpolation on line 700 could become injection risk. Low probability.

---

## Review Pass 2 — 2026-06-05 (Post-Implementation Fix)

### Root Cause Analysis

The initial implementation injected BOTH a permissive CSP `<meta>` tag AND the parent nonce into the preview HTML. This created a **dual-CSP enforcement** scenario in the srcdoc iframe:

1. **Inherited parent CSP** (from the extension's webview HTML): `script-src ... 'nonce-ABC123' 'unsafe-inline' 'unsafe-eval'`
2. **Injected iframe CSP** (from `_injectLocalCsp`): `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: ...`

Per the CSP spec, when multiple policies apply to a document, **each must be independently satisfied**. The injected CSP's `default-src 'none'` was MORE restrictive than the inherited parent CSP in several ways:
- Missing `frame-src` → nested iframes in preview HTML blocked
- Missing `media-src` → `<video>`/`<audio>` blocked
- Missing `child-src` → web workers blocked
- Missing `object-src` → `<object>`/`<embed>` blocked

More critically, the dual-CSP interaction could produce unexpected blocking in certain browser/VS Code versions. The injected CSP added restrictions on top of the inherited parent CSP, rather than relaxing them (which is impossible per the CSP spec — you cannot relax an inherited CSP).

**Additionally**, preview HTML files that had their own CSP `<meta>` tags would end up with THREE simultaneously enforced CSPs, further increasing the chance of unexpected blocking.

### Architecture Finding

On desktop VS Code (Electron), the webview uses an iframe-based architecture:
1. Main VS Code window
2. Webview wrapper iframe (loaded from `vscode-webview://.../index.html`) — has its own CSP
3. Extension content iframe (loaded from `vscode-webview://.../fake.html`) — has the extension's CSP
4. Our preview srcdoc iframe — inherits the extension's CSP from #3

The wrapper's CSP (`script-src 'sha256-...' 'self'`) does NOT cascade into the extension's iframe or our srcdoc iframe, because the extension's HTML is in a separate iframe document, not a child of the wrapper. CSP inheritance only applies within the same document tree (parent→child for srcdoc/about:blank).

### Fix Applied

**Removed the injected CSP `<meta>` tag entirely.** The inherited parent CSP already covers all necessary resource types. The nonce injection is the only addition needed to satisfy the parent CSP's `script-src` requirement. Key changes:

1. **`PlanningPanelProvider.ts` — `_injectLocalCsp` simplified:**
   - Removed the CSP `<meta>` tag injection (the `cspTag` variable and all related head/html matching logic)
   - Added removal of any existing CSP `<meta>` tags in the preview HTML to prevent triple-CSP conflicts
   - Kept the nonce injection into `<script>` tags
   - Added diagnostic `console.log` for server-side verification

2. **`planning.js` — `handlePreviewReady` enhanced:**
   - Added diagnostic `console.log` showing srcdoc length and nonce presence
   - Added `iframe.onload`/`iframe.onerror` event handlers for debugging

### Files Changed

- `src/services/PlanningPanelProvider.ts` — `_injectLocalCsp` method simplified (removed CSP meta injection, added CSP meta removal, kept nonce injection, added logging)
- `src/webview/planning.js` — `handlePreviewReady` function (added diagnostic logging for iframe load/error events)

### Verification Results

- **TypeScript (`tsc --noEmit`):** No errors in `PlanningPanelProvider.ts`. Pre-existing errors in unrelated files unchanged.
- **Regex testing:** CSP removal regex correctly handles double-quoted, single-quoted, case-insensitive, and multi-attribute `<meta>` tags.
- **Nonce injection regex:** Unchanged from previous review; all 8 test cases still pass.

### Remaining Risks

1. **CSP inheritance may still block in edge cases:** If the inherited parent CSP's `'unsafe-inline'` being ignored (due to nonce presence) causes issues with inline event handlers (`onclick="..."`), those handlers will be blocked. This is by design per CSP Level 3 — inline event handlers are considered unsafe. Preview HTML files that rely on inline event handlers would need to be refactored to use `addEventListener()` instead.
2. **The `allow-same-origin` flag** gives the preview access to `window.parent`. This is documented and accepted.
3. **Diagnostic logging** should be removed once the preview is confirmed working in production.

---

**Recommendation:** Complexity 3 → Send to Coder
