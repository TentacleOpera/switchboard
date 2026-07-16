# Fix Non-Responsive Inspect Buttons on Images and Design System Tabs

## Goal

Make the `Inspect` buttons on the **Images** and **Design System** tabs of `design.html` open the canvas-based pixel inspector overlay and respond to eyedrop / measure / auto-detect interactions when an image is selected.

### Problem Analysis & Root Cause

**Background:** The Images and Design System tabs each have an `Inspect` button (`btn-inspect-images`, `btn-inspect-design`) and a shared `#inspect-overlay` panel. The intended flow is:

1. User selects an image file in the sidebar.
2. `design.js` sets the `<img>` `src`, and on `load` removes the `disabled` attribute from the button.
3. User clicks the button.
4. `inspect.js` listener calls `toggleInspector()`, which positions `#inspect-overlay` over the image container, loads the image into an offscreen canvas, and enables eyedrop / measure / auto-detect tools.

**Current failure:** With a PNG selected and the button enabled, clicking produces no visible overlay or readout. The feature is effectively dead in runtime.

**Likely root causes (to verify with diagnostics):**

1. **`inspect.js` not loaded.** The buttons' click handlers live in `inspect.js:36-37`, but the script is loaded as a separate file via `{{INSPECT_JS_URI}}` (`design.html:4266`, `DesignPanelProvider.ts:725-728`). If the installed VSIX is stale or the file is missing from `dist/webview/`, the script 404s, the listeners never attach, and the buttons do nothing. This is the strongest hypothesis because `design.js` enable/disable logic is independent of `inspect.js` loading.

2. **Silent runtime error before overlay shown.** `toggleInspector()` checks `if (!img || !img.src) return;` and then creates a CORS `Image()`. If `probe` fails to load and the `inspectRequestDataUrl` fallback also fails, the overlay may never reach a visible state or may show and immediately appear broken.

3. **Overlay CSS positioning.** `#inspect-overlay` is `position: absolute; inset: 0; z-index: 100` inside `.container`, which has no `position: relative`. `toggleInspector()` sets explicit `top/left/width/height` from the container's `getBoundingClientRect()`, which should align it, but without diagnostics it is possible the overlay is clipped, hidden behind another stacking context, or sized to zero.

4. **`state.ctx` not ready on first click.** `toggleInspector()` shows the overlay immediately and starts loading the image into a canvas. The `interactionLayer` `mousedown` handler returns early if `!state.ctx`. A user who clicks before the canvas is ready sees no response and no loading feedback.

5. **Tainted-canvas `SecurityError` in `performEyedrop` / `performMeasure` (added during improve pass — strongest candidate for the *real* "non-responsive" symptom).** `toggleInspector` sets `probe.crossOrigin = "anonymous"` (`inspect.js:119`) and assigns `probe.src = img.src` where `img.src` is a `vscode-webview://` URI. If the webview asset server does not emit `Access-Control-Allow-Origin`, the primary load errors and the code falls back to `inspectRequestDataUrl`. Even if `probe.onload` fires and `setupCanvas` sets `state.ctx` (readout shows "Ready to inspect."), the canvas can still be **tainted** if `crossOrigin` was ignored or the resource is treated as cross-origin. The first click then calls `getImageData`, which throws `SecurityError`. Critically, in `performEyedrop` (`inspect.js:314-318`) the try/catch wraps ONLY the `{colorSpace:'srgb'}`-option call; the fallback `getImageData(sx,sy,N,N)` (no options) is **outside** the catch and its `SecurityError` is **uncaught** → silent failure, no readout update. The same pattern exists in `performMeasure` (`inspect.js:325-330`). This produces exactly the reported symptom — button enabled, overlay visible, clicks do nothing — and is absent from the original root-cause list.

**Evidence:**

- `src/webview/design.html:3671` and `:3933` — buttons exist.
- `src/webview/design.html:4225` — `#inspect-overlay` exists.
- `src/webview/inspect.js:36-37` — click listeners for both buttons.
- `src/webview/inspect.js:84-137` — `toggleInspector()` positions overlay and loads `probe`.
- `src/webview/design.js:1501-1518` and `:1540-1565` — enable/disable logic (independent of `inspect.js`).
- `src/services/DesignPanelProvider.ts:725-728` and `:2077-2099` — `inspect.js` URI injection and `inspectRequestDataUrl` fallback handler.
- `dist/webview/inspect.js` exists in the repo, so a fresh build packages it; the failure is likely an older packaged VSIX or a runtime load failure.
- `src/webview/inspect.js:114` — `readout.innerHTML = 'Loading pixel context...'` is **already set** before `probe.src` is assigned; the original Proposed Change #4 first bullet describes work that already exists.
- `src/webview/inspect.js:314-318` (`performEyedrop`) and `:325-330` (`performMeasure`) — the no-option `getImageData` fallback sits outside the try/catch; a tainted canvas throws an uncaught `SecurityError` and the click silently does nothing.
- `src/webview/design.html:169` (`.container`) — no `position` and no `overflow` rule, so `#inspect-overlay` (`position: absolute`) resolves against the initial containing block; explicit `top/left` from `getBoundingClientRect()` aligns to the viewport. Positioning is unlikely to be the root cause (demote hypothesis #3).

## Metadata

- **Tags:** frontend, ui, bugfix
- **Complexity:** 4

## User Review Required

- Confirm whether the fix should keep the separate `inspect.js` file or inline it into `design.js` to avoid file-load failures.
- Confirm desired loading/error UX while the image is being prepared for inspection.

## Complexity Audit

### Routine
- Add logging and load-verification to `inspect.js`.
- Add explicit loading/error states to the overlay UI.
- Harden `DesignPanelProvider` / webpack to guarantee `inspect.js` ships.

### Complex / Risky
- Inlining `inspect.js` into `design.js` would be a larger change and may affect the existing `dist` build assumptions and CSP. Needs careful verification.
- Changing overlay positioning from `position: absolute` to `position: fixed` or relative-to-parent may affect alignment across tabs and zoom states.
- Any change to `inspectRequestDataUrl` fallback must preserve path security checks.

## Edge-Case & Dependency Audit

- **Race conditions:** User may click Inspect before the image finishes loading; overlay should either disable interaction until ready or show a spinner.
- **Security:** `inspectRequestDataUrl` fallback must continue to validate file paths against workspace roots.
- **Side effects:** Do not break the two working HTML-preview Inspect buttons (`stitch-html-btn-inspect`, `html-btn-inspect`), which use a different `sbInspectToggle` message path.
- **Dependencies:** None new.
- **VSIX rebuild required:** If the installed extension is stale, a rebuild and reinstall is part of the fix.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) chasing a packaging 404 while ignoring the cross-origin canvas taint — web research confirmed `asWebviewUri` images are cross-origin to the webview document, so the current `crossOrigin`+`probe.src` primary path always errors and the `data:`-URL relay is the only spec-correct untainted path; (2) the uncaught `getImageData` `SecurityError` in `performEyedrop`/`performMeasure` silently swallows the first click if the canvas is ever tainted; (3) proposing already-implemented UX (`Loading pixel context...` at `inspect.js:114`) as new work. Mitigations: make the `data:`-URL relay the primary canvas-load path for local images (item 7), wrap all `getImageData` calls in a single try/catch that surfaces a user-visible error, diagnose `inspect.js` load separately, and pick inline-vs-harden only if a VSIX packaging failure is actually observed.

## Proposed Changes

### Diagnostic phase (do first)

1. **Add console logging to `src/webview/inspect.js`.**
   - Log on IIFE start: `console.log('[inspect.js] loaded', document.getElementById('btn-inspect-images'));`
   - Log inside `toggleInspector()` at entry and before `overlay.style.display = 'flex'`.
   - Log `probe.onload`, `probe.onerror`, and fallback request/response.
   - Wrap `setupCanvas`, `getImgCoordinates`, and `performEyedrop` in try/catch with `console.error`.

2. **Add a load beacon in `src/webview/design.js`.**
   - Have `inspect.js` set `window.__sbInspectLoaded = true` at the top of its IIFE.
   - After the design panel initializes, check `window.__sbInspectLoaded` and log a warning if it is not `true`.

### Fix phase

3. **Guarantee `inspect.js` ships and loads.**
   - **Option A (preferred for reliability):** Inline the contents of `src/webview/inspect.js` into `src/webview/design.js` at the bottom of the design.js IIFE, then remove the separate `{{INSPECT_JS_URI}}` script tag and the `DesignPanelProvider.ts` `inspectJsUri` wiring. This eliminates the separate-file 404 risk.
   - **Option B (minimal):** Keep separate file but add a runtime check in `DesignPanelProvider._getHtml` that verifies `dist/webview/inspect.js` exists before generating HTML, and add `onerror` handling to the script tag to fall back to an inline error message.

4. **Improve overlay visibility and feedback.**

   > **Superseded:** "In `toggleInspector()`, set `readout.innerHTML = 'Loading pixel context...'` before `probe.src` is assigned and keep it until `setupCanvas` succeeds or fails."
   > **Reason:** This is already implemented at `src/webview/inspect.js:114` (`readout.innerHTML = 'Loading pixel context...';` runs before `probe.src` is assigned). Proposing it as new work indicates the original plan did not read the current code.
   > **Replaced with:** Keep the existing line 114 readout. The remaining valid work is: (a) disable pointer interactions on `#inspect-interaction-layer` until `state.ctx` is set (show a "Preparing canvas…" cursor/state instead of silently ignoring clicks via the `!state.ctx` early return at `inspect.js:224`); (b) on `probe.onerror` or fallback failure, display a clear error in `readout` (the fallback error path is partly present in `requestDataUrlFallback`/`loadCanvasFromUrl` — consolidate so every failure mode surfaces a user-visible message, including the tainted-canvas case below).

5. **Harden overlay positioning (demoted — verify only if diagnostics point here).**
   - `.container` (`design.html:169`) is `position: static` with no `overflow`, so `#inspect-overlay` (`position: absolute`) already resolves against the initial containing block and the explicit `top/left/width/height` from `container.getBoundingClientRect()` aligns to the viewport. Do NOT switch to `position: fixed` as a default — `fixed` breaks under webview scroll/transform and is riskier than the current scheme.
   - Only if diagnostics show actual clipping: add `position: relative` to the appropriate ancestor and recompute offsets relative to that container. Treat as conditional, not mandatory.

6. **Verify `DesignPanelProvider` backend fallback.**
   - Ensure `inspectRequestDataUrl` handler logs errors and returns actionable messages.
   - Confirm `img-src` CSP allows `data:` for the fallback data URL (it does: `img-src ... data:`).

7. **Surface tainted-canvas `SecurityError` AND make the `data:`-URL relay the primary canvas-load path (research-confirmed fix — highest-value).**

   > **Superseded:** "Investigate whether `probe.crossOrigin = "anonymous"` is necessary for same-origin `vscode-webview://` resources... Consider dropping `crossOrigin` for webview-same-origin URIs (canvas is not tainted for same-origin) and keeping the fallback only for genuinely remote `https:` images."
   > **Reason:** Web research confirmed `asWebviewUri` resources are **cross-origin** to the webview document (different authority: `...vscode-resource.vscode-webview.net` vs `...vscode-webview.net`). They are NOT same-origin. Dropping `crossOrigin` would make the image *load* but **taint the canvas** (WHATWG `origin-clean` flag → `false`), causing `getImageData` to throw `SecurityError` — exactly the silent failure in root cause #5. The original guidance was based on an unverified same-origin assumption that the research disproved.
   > **Replaced with:** The existing `inspectRequestDataUrl` → `data:`-URL relay (`DesignPanelProvider.ts:2077-2099`) is the **structurally correct, spec-guaranteed-untainted** path: `data:` URLs are not cross-origin and cannot taint a canvas. Make this the PRIMARY canvas-load mechanism, not just an `onerror` fallback:

   - **In `toggleInspector` (`inspect.js:84-137`):** For local images (where `img.dataset.filePath` is set), skip the `probe.crossOrigin` + `probe.src = img.src` primary attempt entirely — it will always error per research. Instead, call `requestDataUrlFallback(img.dataset.filePath)` directly to request the `data:` URL from the extension host. Keep the `probe` path ONLY for genuinely remote `https:` images (where `filePath` is empty), and for those, expect `onerror` → show "Remote image inspection not supported" (already handled at `inspect.js:141`).
   - **In `performEyedrop` (`inspect.js:304-322`) and `performMeasure` (`:324-333`):** Wrap the **entire** `getImageData` operation (both the colorSpace-option call AND the no-option fallback) in a single try/catch. On `SecurityError`, set `readout.innerHTML` to a clear user-visible message (e.g., "Canvas tainted — cannot read pixels. Reopen Inspect to retry.") and `console.error('[inspect.js] getImageData failed', e)`. Do NOT let the second `getImageData` throw uncaught. This is defense-in-depth: if the relay path ever regresses, the user sees an error instead of a silent dead click.
   - **In `loadCanvasFromUrl` (`inspect.js:152-161`):** The new `Image()` here does NOT set `crossOrigin` (correct — `data:` URLs don't need it and shouldn't have it). Confirm this stays unset. Add `probe.onerror` logging per item 1.

## Uncertain Assumptions

> **Research completed.** All three assumptions below were confirmed via web research (50+ sources: VS Code official docs, WHATWG HTML canvas spec, MDN, `microsoft/vscode` issue tracker, `@vscode/vsce` docs). Findings are incorporated into the Proposed Changes and Recommendation. The "drop `crossOrigin` for same-origin webview URIs" idea in the original item 7 was **wrong** and has been superseded — see below.

1. **Webview asset CORS headers — CONFIRMED.** `asWebviewUri(...)` resources resolve to a **different origin/authority** than the webview document itself (e.g. document at `https://<id>.vscode-webview.net/...`, assets at `https://<path>.vscode-resource.vscode-webview.net/...`). VS Code's internal webview asset loader does **not** emit `Access-Control-Allow-Origin`; its access control is enforced via `localResourceRoots`, a custom protocol/service-worker handler, and CSP — not standard CORS headers. Therefore setting `probe.crossOrigin = "anonymous"` (as `inspect.js:119` does) switches the fetch to `cors` mode, the CORS check fails, and `probe.onerror` fires (not `load`). This means the primary `probe.src = img.src` path **always errors** for `asWebviewUri` images, and the code always falls through to `requestDataUrlFallback`.
2. **Tainted-canvas rules for webview-sourced images — CONFIRMED.** Per the WHATWG HTML canvas spec, drawing a `no-cors`-loaded cross-origin image onto a canvas sets the `origin-clean` flag to `false` (tainted); any subsequent `getImageData()`/`toDataURL()`/`toBlob()` throws `SecurityError`. Because `asWebviewUri` resources ARE cross-origin to the document (see #1), loading such an image **without** `crossOrigin` would make it load successfully BUT taint the canvas — producing exactly the silent `getImageData` failure described in root cause #5. `data:` URLs are NOT cross-origin and do NOT taint (opaque origin, no server-controlled "other" origin), so the existing `inspectRequestDataUrl` → `data:`-URL relay is the structurally correct, spec-guaranteed-untainted path.
3. **VSIX packaging of `dist/webview/inspect.js` — CONFIRMED as a real risk class.** `@vscode/vsce` has well-documented `.vscodeignore` / `package.json#files` misconfiguration modes that silently omit `dist/`/`out/` build output from the packaged VSIX (stray `**/*.js` ignore rules, `files` allow-lists not exercised against negation patterns). The file existing in-repo does NOT guarantee it is in the VSIX; verify with `vsce ls --tree` or by unzipping the VSIX. This keeps the "inspect.js not loaded" hypothesis (#1) live as a real candidate, especially for the "no overlay appears AT ALL" symptom variant.

## Verification Plan

> Per session directives: **no project compilation step** and **no automated tests** are part of this verification plan. Verification is manual runtime checks against a built/installed VSIX (the build itself is the developer's existing local step, not a plan-mandated compile gate).

### Automated Tests
- None. (Session directive: skip automated tests.) The existing repo has no webview-level automated test harness for `inspect.js`; adding one is out of scope for this bugfix.

### Manual Runtime Checks
1. Build the extension (`npm run package` or `vsce package`) and install the resulting VSIX in a clean VS Code window.
2. Open the Images tab, configure a folder with PNG/JPG files, and select an image.
3. Open the webview dev tools console.
4. Click the `Inspect` button.
   - Expected: console shows `[inspect.js] loaded` and `toggleInspector images` messages; overlay appears with toolbar; readout shows "Loading pixel context..." then "Ready to inspect."
   - Click on the image: readout updates with hex/RGB. **If a tainted-canvas error is thrown, readout must show the new "Canvas tainted" message instead of silently doing nothing.**
   - Switch to Measure, drag: shows dimensions.
   - Switch to Auto-Detect: shows bounding box and ratio.
5. Repeat on the Design System tab's Local Docs sub-tab with an image.
6. Confirm the two HTML-preview Inspect buttons still toggle DOM hover-select mode.
7. Test with a PNG that is not in the workspace (should be impossible via UI, but verify fallback path remains secure).
8. Test with a remote `https:` image (if applicable) and confirm it either works or shows a clear "remote image inspection not supported" message.
9. **Tainted-canvas path:** if the primary `probe` path errors (CORS), confirm the data-URL fallback completes AND that a subsequent eyedrop click either samples correctly or surfaces the "Canvas tainted" error — never silent.

## Recommendation

Complexity 4 → **Send to Coder**.

> **Superseded:** "If the cause is a missing/stale `inspect.js`, prefer inlining into `design.js` to make the feature self-contained and eliminate the separate-file packaging risk."
> > **Reason:** The plan's own evidence shows `dist/webview/inspect.js` exists and a fresh build packages it, so the packaging-404 hypothesis is the *weakest* of the five, not the strongest. Committing to a 19 KB inline refactor pre-diagnosis is premature and would not fix a CORS/canvas-taint failure — the most likely real cause of the "non-responsive" symptom.
> **Replaced with:** Start with the diagnostic logging pass (item 1) and the load beacon (item 2, temporary). **In parallel, implement item 7 (make `data:`-URL relay primary + surface tainted-canvas errors) regardless of root cause** — web research confirmed `asWebviewUri` images are cross-origin to the webview document, so the current `crossOrigin`+`probe.src` primary path always errors and the `data:`-URL relay is the spec-correct untainted path. This is the highest-value fix. Only after diagnostics confirm an actual `inspect.js` load failure (verify VSIX contents with `vsce ls --tree` per research finding C7), choose between Option A (inline) and Option B (harden packaging); if diagnostics point to CORS/canvas-taint, the item 7 relay-primary change IS the fix. Apply the overlay/feedback hardening (item 4 remaining parts) and the demoted positioning check (item 5) as conditional follow-ups.

## Completion Summary

Implemented the inspect-button fix in `src/webview/inspect.js`, `src/webview/design.js`, `src/webview/design.html`, and `src/services/DesignPanelProvider.ts`.

- `inspect.js`: local images now use the `inspectRequestDataUrl` data-URL relay as the primary canvas load path instead of the CORS `Image()` probe, eliminating the tainted-canvas `SecurityError` that caused silent dead clicks. Added console logging, load beacon (`window.__sbInspectLoaded`), user-visible loading/error states, cursor feedback, and hardened `getImageData` calls in `performEyedrop`, `performMeasure`, and `runAutoDetect` so any future taint surfaces the "Canvas tainted" message instead of failing silently.
- `design.js`: adds a `load` event check for `window.__sbInspectLoaded` that warns in the console if `inspect.js` fails to load.
- `design.html`: adds `onerror` to the `inspect.js` script tag to log and set a load-error flag when the separate file fails.
- `DesignPanelProvider.ts`: verifies `dist/webview/inspect.js` exists before generating the webview HTML and logs an extension-host error if missing; also logs `inspectRequestDataUrl` errors.

Files changed: `src/webview/inspect.js`, `src/webview/design.js`, `src/webview/design.html`, `src/services/DesignPanelProvider.ts`.

No issues encountered. JS syntax verified with `node --check` for `inspect.js` and `design.js`. Per session directives, no compilation or automated tests were run.
