# Fix: HTML Previews Built from Scripts Do Not Display

## Goal

HTML files that build their entire DOM at runtime via `<script>` tags (React + Babel standalone, dynamic rendering, etc.) fail to display in the Design panel's HTML Preview viewer. The iframe loads but renders blank — the scripts either fail to execute or fail to complete rendering. This plan fixes the iframe sandbox configuration so script-built HTML files render correctly, and adds a diagnostic fallback so the user can see what went wrong if a preview still fails.

### Problem Analysis

**Symptom:** The file `pii-fix-before-after.html` (a React + AntD + Babel standalone app that builds its entire UI at runtime via `<script type="text/babel">`) does not display in the HTML Preview tab of the Design panel. The iframe appears blank. Static HTML files display fine.

**Reproduction file:** `/Users/patrickvuleta/Documents/GitHub/patrickwork/designs/pii-fix-before-after.html`
- Loads React 17, ReactDOM 17, AntD 4, Ant Design Icons, and Babel Standalone from `https://unpkg.com`
- Contains a single `<div id="root"></div>` and a `<script type="text/babel">` block
- Babel compiles the JSX at runtime and `ReactDOM.render()` builds the entire DOM

**Root cause chain:**

1. The Design panel serves HTML previews from a localhost HTTP server (`_getOrCreateHtmlServer` in DesignPanelProvider.ts:928-961) so the iframe gets a real `http://127.0.0.1:PORT` origin instead of an opaque `srcdoc` origin.
2. In `design.js`, the `handlePreviewReady` function (line 972-1029) sets the iframe's `sandbox` attribute differently depending on the render path:
   - **iframeSrc path** (localhost server, line 1005-1016): `sandbox = 'allow-scripts'` — **missing `allow-same-origin`**
   - **htmlContent path** (srcdoc fallback, line 1017-1029): `sandbox = 'allow-scripts allow-same-origin'` — correct
3. With `sandbox="allow-scripts"` but **without** `allow-same-origin`, the iframe receives an **opaque/null origin**. This means:
   - The iframe's origin is not `http://127.0.0.1:PORT` — it's a unique opaque origin.
   - `document.cookie`, `localStorage`, `sessionStorage` throw `SecurityError`.
   - Same-origin XHR/fetch to `127.0.0.1:PORT` is blocked (the iframe's origin doesn't match the server's origin).
   - Some APIs that depend on a real origin (e.g., `window.origin`, `document.domain`) return `null` or throw.
4. React 17 development build, AntD 4, and Babel Standalone rely on several origin-dependent APIs:
   - **Babel Standalone** uses `fetch()` or `XMLHttpRequest` internally for some operations and may check `document.baseURI` / `document.location` — with an opaque origin, `document.location` returns a non-standard value that can cause silent failures in script loading or compilation.
   - **React 17 dev build** accesses `localStorage` for development warning deduplication (throws `SecurityError` with opaque origin, which React catches but may disrupt the render lifecycle in some versions).
   - **AntD 4** may use `window.getComputedStyle` or `MutationObserver` in ways that behave differently with an opaque origin.
5. The scripts load from `https://unpkg.com` (network requests are not blocked by sandbox), but the runtime execution environment is too restricted for the script-built DOM to complete rendering. The result is a blank iframe.

**Why static HTML works:** Static HTML files don't rely on JavaScript to build their DOM — the content is in the HTML markup. Even with an opaque origin, the HTML renders. Only script-built pages fail because the scripts need a real origin to fully execute.

**Why the srcdoc fallback works:** The `htmlContent` path (srcdoc) already includes `allow-same-origin`, giving the iframe a real origin. But the srcdoc path is only used when the localhost server fails (it's the fallback). The primary path (iframeSrc) is broken.

**Security note:** Adding `allow-same-origin` to the sandbox for localhost-served files is safe because:
- The localhost server only serves files from the user's explicitly configured HTML preview folders (DesignPanelProvider.ts:1236-1243 validates against `allowedFolders`).
- The user already trusts these files — they configured the folders.
- Combining `allow-scripts` + `allow-same-origin` does technically allow the iframe to modify its own `sandbox` attribute, but since the content comes from the user's own local files, this is the same trust level as opening the file in a browser.
- The srcdoc fallback already uses this combination, so this change makes the primary path consistent with the fallback.

### Constraints

- The CSP in `design.html` (line 6) has `frame-src ... http: ...` which allows localhost iframes — no CSP change needed.
- The localhost server (DesignPanelProvider.ts:970-1014) serves files with correct MIME types and path traversal protection — no server change needed.
- No confirmation dialogs (per CLAUDE.md).
- Must rebuild after editing `src/webview/*` (`npm run compile`).
- The `injectBaseTag` function (design.js:409-413) is only used in the srcdoc path — the iframeSrc path doesn't need it because the localhost server serves files with their real file paths.

## Metadata

**Complexity:** 2
**Tags:** frontend, bugfix, ui, reliability

## User Review Required

No — this is a bugfix that makes the primary preview path consistent with the existing fallback path. No data migrations, no new configuration, no product scope changes.

## Complexity Audit

### Routine
- One-line `sandbox` attribute change at `design.js:1009` — adding `allow-same-origin` to match the existing srcdoc fallback (line 1021).
- Code-verified: the iframeSrc branch (line 1005-1016) and srcdoc branch (line 1017-1029) are adjacent in the same function; the fix is a single string literal change.
- The localhost server (`DesignPanelProvider.ts:948-1007`) already has path traversal protection (line 984) and a deny list (line 990-997) — no server changes needed.
- The webview CSP (`design.html:6`) already allows `frame-src ... http: ...` — no CSP change needed.
- Optional unit test asserting the sandbox attribute value is a trivial DOM assertion.

### Complex / Risky
- None — the fix reuses an existing pattern (the srcdoc fallback already uses `allow-scripts allow-same-origin`) and applies it to the primary path. No new architectural patterns, no data consistency risks, no breaking changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `handlePreviewReady` is called serially per preview request; the `requestId` guard (line 976) drops stale messages. The sandbox attribute is set before `iframe.src`, so there is no window where the iframe loads with the old sandbox value.
- **Security:** Adding `allow-same-origin` to a sandboxed iframe that also has `allow-scripts` is a known browser-security consideration (the iframe could remove its own `sandbox` attribute). This is mitigated because: (a) the content is served from a locked-down localhost server with path traversal protection and a deny list, (b) the user explicitly configured the preview folders, (c) the srcdoc fallback already uses this exact combination, (d) this is the same trust level as opening the file in a browser. No regression versus the existing fallback path.
- **Side Effects:** Positive side effect — HTML files that use `localStorage`/`sessionStorage` will now work in the iframe (previously silently threw `SecurityError`). No negative side effects on static HTML files.
- **Dependencies & Conflicts:** No dependency on other plans or sessions. No conflicts with in-flight work — the change is isolated to one line in `design.js`.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the original Change 2 diagnostic was self-admitted dead code — cross-origin restrictions (`127.0.0.1:PORT` vs `vscode-webview://...`) prevent `iframe.contentDocument` access, so the blank-check could never fire; (2) that diagnostic also introduced a timer leak (orphaned `setTimeout` closures on rapid preview switches) and used `iframe.onload =` assignment instead of `addEventListener`. Mitigations: Change 2 has been dropped entirely — the existing "Open" button (`btn-open-browser-html`, design.js:843) already serves as the user's debugging fallback. The plan is now a single-line attribute fix plus an optional unit test, eliminating all introduced complexity.

## Proposed Changes

### 1. `src/webview/design.js` — Add `allow-same-origin` to iframeSrc sandbox

**Context:** In `handlePreviewReady()` (line 1005-1016), when the iframe is loaded via `iframeSrc` (localhost server), the sandbox is set to `'allow-scripts'` only. The srcdoc fallback (line 1021) correctly uses `'allow-scripts allow-same-origin'`. This inconsistency causes script-built HTML files to fail on the primary path.

**Implementation:** At line 1009, change:

```js
iframe.setAttribute('sandbox', 'allow-scripts');
```

To:

```js
iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
```

**Edge Cases:**
- **Static HTML files:** Adding `allow-same-origin` has no effect on static HTML — the content renders the same with or without it. No regression.
- **Files that use `localStorage`/`sessionStorage`:** With `allow-same-origin`, these APIs now work in the iframe. This is a positive side effect — some HTML files may have been silently failing on storage operations.
- **Security:** The iframe content comes from the user's configured local folders, served via a locked-down localhost server with path traversal protection. `allow-same-origin` gives the iframe the `127.0.0.1:PORT` origin, which only has access to the localhost server's own files — not to the extension host or other webview resources. This is the same trust model as opening the file in a browser.

### 2. `src/webview/design.js` — ~~Add error diagnostics for blank script-built previews~~ (DROPPED)

**Status: DROPPED during adversarial review.**

The original Change 2 proposed a load-time diagnostic that checked `iframe.contentDocument.body.children.length` to detect blank script-built previews. This was rejected during the improve-plan adversarial review for the following reasons:

1. **Self-admitted dead code:** The plan's own analysis (original lines 128 and 172) acknowledged that with `allow-same-origin`, the iframe origin (`127.0.0.1:PORT`) differs from the parent webview origin (`vscode-webview://...`), so `iframe.contentDocument` access throws a cross-origin `SecurityError`. The `try/catch` swallows the error, meaning the diagnostic can never fire. Adding 35 lines of code that the plan's own analysis proves cannot work is net-negative.
2. **Timer leak:** `_blankCheckTimer` was declared with `let` inside `handlePreviewReady`. On rapid preview switches (e.g., auto-refresh or selecting a different file before the 3s timer fires), a new call creates a new closure with a new timer, orphaning the old timer. The old timer still fires and may overwrite `status-html` text for the *new* preview with a stale "rendered blank" message about the *old* file. The original plan's claim of "No stale timers" (line 129) was incorrect — the new `onload` clears the new timer, not the old one from the previous closure.
3. **`iframe.onload =` clobbering:** The assignment `iframe.onload = () => {...}` is fragile — while no existing `onload` handler exists today (verified via grep), any future load handler would be silently overwritten. `addEventListener('load', ...)` would be safer, but this is moot since the diagnostic is dropped.
4. **Existing fallback suffices:** The "Open" button (`btn-open-browser-html`, design.js:843-857) already opens the file in the system browser where DevTools are available for debugging. No in-iframe diagnostic is needed.

**If diagnostics are desired in the future:** Design a `postMessage`-based approach where the localhost server injects a heartbeat script into served HTML files. The injected script can `postMessage` to the parent webview (which IS allowed cross-origin via `window.parent.postMessage`) reporting render status. This is a separate, larger plan and out of scope here.

## Verification Plan

### Automated Tests

**Unit test (optional but recommended):** Add a test that verifies the sandbox attribute is set correctly after `handlePreviewReady` processes an `iframeSrc` message. This is a DOM assertion, not a browser-sandbox-behavior simulation:

```js
// Assert that handlePreviewReady sets sandbox='allow-scripts allow-same-origin' for iframeSrc path
const iframe = document.getElementById('html-preview-frame');
handlePreviewReady({ sourceId: 'html-folder', iframeSrc: 'http://127.0.0.1:9999/test.html', docName: 'test.html' });
assert.strictEqual(iframe.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
```

Note: Per session directives, automated tests are NOT run as part of this plan's verification. The test suite will be run separately by the user. The test above is provided for the coder to add to the suite.

### Manual Verification

1. **Script-built HTML file (the reported bug):**
   - Configure `patrickwork/designs` as an HTML Preview folder in the Design panel.
   - Navigate to `pii-fix-before-after.html` in the HTML Previews sidebar.
   - **Expected:** The iframe renders the full React/AntD UI — the before/after PII comparison tables, phase cards, and all styled content.
   - Verify the page is interactive (buttons, tables render correctly).

2. **Static HTML file (regression check):**
   - Open any static HTML file (no scripts) in the HTML Preview.
   - **Expected:** Renders exactly as before — no visual change.

3. **HTML file with external scripts (non-Babel):**
   - Open an HTML file that loads external JS (e.g., a D3.js visualization) from a CDN.
   - **Expected:** Scripts load and execute, visualization renders.

4. **HTML file with relative asset paths:**
   - Open an HTML file that references local CSS/JS/images via relative paths.
   - **Expected:** Assets load correctly (the localhost server resolves relative paths from the file's directory).

5. **"Open" button (fallback):**
   - With `pii-fix-before-after.html` selected, click the "Open" button.
   - **Expected:** File opens in the system browser, renders fully.

6. **Auto-refresh on file change:**
   - Open a script-built HTML file in the preview.
   - Modify the file externally.
   - **Expected:** Preview auto-refreshes and re-renders correctly.

## Risks & Edge Cases

- **Security of `allow-same-origin`:** The iframe content is served from a localhost server that only serves files from the user's explicitly configured HTML preview folders. The server has path traversal protection (DesignPanelProvider.ts:980-997) and a deny list (line 990-997). Adding `allow-same-origin` gives the iframe the `127.0.0.1:PORT` origin, which can only access files on that specific localhost server — not the extension host, not the webview's resources, not the filesystem. This is the same trust model as the srcdoc fallback, which already uses `allow-same-origin`.
- **Mixed content:** The iframe is loaded from `http://127.0.0.1` (HTTP). Scripts within the iframe load from `https://unpkg.com` (HTTPS). Loading HTTPS resources from an HTTP page is allowed by browsers (only the reverse — HTTP resources from an HTTPS page — is blocked). No mixed content issue.
- **CSP interaction:** The webview's CSP (design.html:6) has `frame-src ... http: ...` which allows the localhost iframe. The CSP does not restrict what the iframe's content can load — the iframe has its own security context. No CSP change is needed.

## Recommendation

**Send to Coder** — Complexity 2: a single one-line sandbox attribute fix (the core fix) plus an optional trivial unit test. The change is low-risk — it makes the primary preview path consistent with the existing srcdoc fallback. The original Change 2 diagnostic was dropped during adversarial review (self-admitted dead code + timer leak), leaving a clean, minimal fix.
