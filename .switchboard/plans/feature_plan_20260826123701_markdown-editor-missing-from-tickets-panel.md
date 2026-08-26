# Markdown editor missing from the Tickets panel — recover the rich editor instead of silently degrading to a bare textarea

## Goal

### Problem
The user reports that the markdown editor (toolbar, live split preview, formatting buttons) has been "removed" from the Tickets panel. When they click **Edit** on a ticket, they see a plain `<textarea>` instead of the rich `SwitchboardMarkdownEditor` shell (toolbar with bold/italic/list/table buttons, split-view live preview, view-mode toggle).

### Background
The Tickets panel was extracted from the Planning panel's TICKETS tab into a standalone panel (`TicketsPanelProvider.ts` + `src/webview/tickets.html` + `src/webview/tickets.js`). The shared markdown editor (`src/webview/markdownEditor.js`, exposing `window.SwitchboardMarkdownEditor.attach()`) is used by four panels: planning, design, project, and tickets.

### Root Cause Analysis
The source code is fully wired — the script tag, provider URI substitution, `attach()` call, and CSS are all present in `src/`, and `dist/` is identical to source. The script tag is present at `tickets.html:4758` (`<script nonce="{{NONCE}}" src="{{MARKDOWN_EDITOR_URI}}"></script>`), and both hosts substitute the URI (extension: `TicketsPanelProvider.ts:1248`, standalone: `headlessPanelHtml.ts:466`). The HTML comment at tickets.html:4752-4757 documents that the tag was added to fix the panel extraction bug where it was originally missing.

However, `tickets.js:3123` guards the attach call with:

```js
if (descTextarea && window.SwitchboardMarkdownEditor) {
    window.SwitchboardMarkdownEditor.attach(descTextarea, { ... });
}
```

When `window.SwitchboardMarkdownEditor` is `undefined` (the script failed to load — stale VSIX predating the tag fix, CSP block, packaging omission, Windsurf webview quirk), this guard **silently skips** the attach and the user gets a bare `<textarea>` with no error, no toolbar, no live preview. The user perceives this as "the markdown editor was removed."

The fix is NOT to add a console error — the user already knows it's broken. The fix is to **actively recover**: if the markdown editor script hasn't loaded when the user clicks Edit, dynamically re-inject the script from the existing `<script>` tag's `src`, wait for it to load, then call `attach()`. This makes the editor work regardless of why the initial load failed. When recovery is impossible (script tag absent — stale VSIX), a visible user-facing error message replaces the silent degradation.

**Scope limitation:** If the `<script>` tag is entirely absent (stale VSIX predating the tag-fix commit), client-side JavaScript cannot re-inject what it cannot find. In that case the helper shows a visible error banner and falls back to a plain textarea — an improvement over the current silent degradation, but not a full recovery. The primary fix (adding the script tag) is already in the source; this plan adds a resilience layer on top.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, bugfix
- **Project:** Browser Switchboard

## User Review Required

This plan introduces asynchronous behavior into `enterTicketsEditMode()` (previously synchronous). The race-condition guard mitigates the risk, but the reviewer should verify the guard logic covers all exit paths (Cancel button, Save button, panel disposal). The visible error banner approach (injecting a DOM element via JavaScript) should be reviewed for visual consistency with the panel's existing error/display patterns.

## Complexity Audit

### Routine
- Adding a single helper function (`ensureMarkdownEditorLoaded()`) to `tickets.js` — standard dynamic script injection pattern
- Modifying the guard around the existing `attach()` call to use the helper
- Moving the `focus()` call inside the async callback (already noted in the original plan)
- No API changes, no migrations, no multi-file coordination beyond the single file

### Complex / Risky
- **Async race condition:** Making `enterTicketsEditMode()` asynchronous introduces a window where the user can click Cancel (or Save) before the Promise resolves. `exitTicketsEditMode()` replaces `detailContent.innerHTML`, detaching the textarea. If the async callback then fires and calls `attach()`, `textarea.parentNode.insertBefore()` throws a TypeError (parentNode is null on a detached node). The guard `document.body.contains(descTextarea) && ticketsEditMode` in the async callback is mandatory.
- **Nonce copying reliability:** The `nonce` IDL property can return an empty string in browsers that implement nonce-hiding. Using `getAttribute('nonce')` instead of the `.nonce` property is required for reliable CSP compliance on the re-injected script.
- **Re-injection effectiveness:** Re-injecting the same URL with the same nonce will fail the same way if the original failure was a 404 or CSP block. The recovery only helps for transient/timing failures. This is a known limitation, not a bug — the plan is defense-in-depth, not a guaranteed fix for all failure modes.

## Edge-Case & Dependency Audit

- **Race Conditions:** The async `ensureMarkdownEditorLoaded().then()` callback can fire after `exitTicketsEditMode()` has destroyed the textarea (user clicks Cancel/Save quickly, or panel is disposed). The callback MUST guard with `document.body.contains(descTextarea) && ticketsEditMode` before calling `attach()` or `focus()`. Without this guard, `attach()` throws TypeError on `textarea.parentNode.insertBefore()` (parentNode is null for detached nodes).
- **Script tag present but script failed to load**: The helper finds the existing `<script>` tag, extracts its `src` and `nonce` (via `getAttribute('nonce')`), creates a new `<script>` element with the same attributes, and appends it to `<head>`. The browser loads it fresh. This handles transient load failures and timing issues.
- **Script tag completely absent (stale VSIX)**: The helper cannot find a tag to re-inject from. It shows a visible error banner in the edit panel ("Rich editor unavailable — using plain text mode") and resolves `false`. The edit mode still works with a bare textarea — same as current behavior, but now with a visible user-facing message instead of silent degradation.
- **Script already loaded**: The helper resolves immediately. No overhead, no async delay.
- **Re-entry into edit mode**: `enterTicketsEditMode()` creates a fresh textarea via `innerHTML` each time, so `attach()` always gets a clean element (no stale `dataset.mdEditorAttached` flag). The async loading helper is idempotent — if the script is already loaded, it resolves instantly.
- **Focus timing**: Currently `descTextarea?.focus()` is called at line 3180, after the `attach()` block. With the async change, focus must be called inside the async callback (after `attach()` completes), because `attach()` moves the textarea in the DOM which drops focus. The focus call is also guarded by the race-condition check.
- **Standalone/browser host**: The standalone host (`headlessPanelHtml.ts:466`) substitutes `{{MARKDOWN_EDITOR_URI}}` with `/static/webview/markdownEditor.js`. The dynamic re-injection uses the existing tag's `src`, which is already the correct URL for either host. No host-specific logic needed. The `vscode` shim (tickets.js:13-23) works in both hosts via the transport shim's `acquireVsCodeApi` polyfill (transport.js:430).
- **markdownEditor.js re-injection safety**: The IIFE in markdownEditor.js is idempotent for styles (`if (!document.getElementById('md-editor-styles'))` guard at line 3). Re-running the IIFE replaces `window.SwitchboardMarkdownEditor` with a fresh object and resets the local `globalViewMode` variable to `'split'`. This is acceptable — the view mode preference is per-session and not persisted across re-injections.
- **Other panels**: Planning, design, and project panels have the same `if (window.SwitchboardMarkdownEditor)` guard (planning.js:6311, planning.js:7644, design.js:1896, project.js:3177). This plan only fixes the tickets panel (the user's reported issue). The same fix could be applied to other panels later if needed.
- **CSP compliance**: The re-injected script copies the nonce from the existing tag via `getAttribute('nonce')`. The CSP (`script-src 'nonce-{{NONCE}}'`) allows any script with a valid nonce regardless of whether it was in the original HTML or dynamically inserted. If the original nonce was invalid (CSP misconfiguration), the re-injected script would be blocked too — but this would also block sharedUtils.js and tickets.js, so the panel wouldn't load at all.

## Dependencies

None. This plan is self-contained within `src/webview/tickets.js`.

## Adversarial Synthesis

Key risks: (1) async race condition — callback fires after textarea is destroyed by Cancel/Save, causing TypeError in `attach()`; (2) nonce property unreliable — `.nonce` IDL property can return empty string, must use `getAttribute('nonce')`; (3) re-injection ineffective for stale VSIX (tag absent) — visible error banner is the fallback, not full recovery. Mitigations: race-condition guard (`document.body.contains()` + `ticketsEditMode`), `getAttribute('nonce')` for nonce copying, visible user-facing error message when recovery fails.

## Proposed Changes

### 1. `src/webview/tickets.js` — add `ensureMarkdownEditorLoaded()` helper and make `attach()` call resilient

Add this helper function before `enterTicketsEditMode()` (around line 3073):

```js
/**
 * Ensure the shared markdown editor script has loaded. If
 * window.SwitchboardMarkdownEditor is already defined, resolve immediately.
 * Otherwise, find the existing <script> tag for markdownEditor.js in the
 * document, re-inject it as a fresh <script> element, and resolve once it
 * loads. This recovers from transient load failures instead of silently
 * degrading to a bare textarea.
 *
 * If the script tag is absent (stale VSIX predating the tag-fix commit),
 * recovery is impossible — the caller shows a visible error banner and
 * falls back to a plain textarea.
 *
 * @returns {Promise<boolean>} true if the editor is available, false if it
 *   could not be loaded (the caller falls back to a plain textarea).
 */
function ensureMarkdownEditorLoaded() {
    return new Promise((resolve) => {
        if (window.SwitchboardMarkdownEditor) {
            resolve(true);
            return;
        }
        const existingTag = document.querySelector('script[src*="markdownEditor"]');
        if (!existingTag || !existingTag.src) {
            console.error('[Tickets] markdownEditor.js script tag not found — cannot recover rich editor');
            resolve(false);
            return;
        }
        const script = document.createElement('script');
        script.src = existingTag.src;
        // Use getAttribute('nonce') instead of the .nonce IDL property — the
        // IDL property can return an empty string in browsers that implement
        // nonce-hiding, which would cause CSP to block the re-injected script.
        const nonceVal = existingTag.getAttribute('nonce');
        if (nonceVal) script.setAttribute('nonce', nonceVal);
        script.onload = () => {
            if (window.SwitchboardMarkdownEditor) {
                resolve(true);
            } else {
                console.error('[Tickets] markdownEditor.js loaded but window.SwitchboardMarkdownEditor is still undefined');
                resolve(false);
            }
        };
        script.onerror = () => {
            console.error('[Tickets] markdownEditor.js failed to load from', existingTag.src);
            resolve(false);
        };
        document.head.appendChild(script);
    });
}
```

Then modify the `attach()` block in `enterTicketsEditMode()` (lines 3122-3181). Replace:

```js
const descTextarea = document.getElementById('ticket-edit-description');
if (descTextarea && window.SwitchboardMarkdownEditor) {
    window.SwitchboardMarkdownEditor.attach(descTextarea, {
        renderPreview: (markdown) => new Promise((resolve) => {
            // ... existing renderPreview callback ...
        }),
        onAttachImage: () => new Promise((resolve) => {
            // ... existing onAttachImage callback ...
        })
    });
}
// Focus AFTER attach() — the shell insertion moves the textarea in the DOM,
// which drops any focus applied before the move.
descTextarea?.focus();
```

With:

```js
const descTextarea = document.getElementById('ticket-edit-description');
if (descTextarea) {
    ensureMarkdownEditorLoaded().then((loaded) => {
        // Race-condition guard: the user may have clicked Cancel or Save
        // while the Promise was pending, which calls exitTicketsEditMode()
        // and replaces detailContent.innerHTML — detaching the textarea.
        // attach() calls textarea.parentNode.insertBefore(), which throws
        // TypeError if parentNode is null (detached node). Guard with both
        // a DOM-contains check and the edit-mode flag.
        if (!document.body.contains(descTextarea) || !ticketsEditMode) return;

        if (loaded && window.SwitchboardMarkdownEditor) {
            window.SwitchboardMarkdownEditor.attach(descTextarea, {
                renderPreview: (markdown) => new Promise((resolve) => {
                    // ... existing renderPreview callback unchanged ...
                }),
                onAttachImage: () => new Promise((resolve) => {
                    // ... existing onAttachImage callback unchanged ...
                })
            });
        } else {
            // Recovery failed — show a visible error banner so the user
            // knows the rich editor is unavailable, not silently removed.
            const banner = document.createElement('div');
            banner.style.cssText = 'padding:8px 12px;margin-bottom:8px;background:var(--panel-bg2,#0a0a0a);border:1px solid var(--accent-orange,#d18616);border-radius:4px;color:var(--accent-orange,#d18616);font-size:12px;';
            banner.textContent = 'Rich editor unavailable — using plain text mode. Reloading the panel may restore it.';
            descTextarea.parentNode.insertBefore(banner, descTextarea);
        }
        // Focus AFTER attach() — the shell insertion moves the textarea in
        // the DOM, which drops any focus applied before the move. This must
        // be inside the async callback so it runs after attach() completes.
        // The race-condition guard above ensures we only focus if the
        // textarea is still in the DOM.
        descTextarea.focus();
    });
}
```

The `renderPreview` and `onAttachImage` callbacks are unchanged — only the guard around `attach()`, the race-condition check, the error banner, and the focus call change. The focus moves inside the `.then()` callback because `attach()` is now asynchronous (it may wait for the script to load first).

> **Superseded:** `if (existingTag.nonce) script.nonce = existingTag.nonce;`
> **Reason:** The `nonce` IDL property can return an empty string in browsers that implement the nonce-hiding feature (per HTML spec §8.13.5), causing CSP to silently block the re-injected script — the exact silent failure this fix aims to eliminate.
> **Replaced with:** `const nonceVal = existingTag.getAttribute('nonce'); if (nonceVal) script.setAttribute('nonce', nonceVal);` — `getAttribute` always returns the attribute's literal value, bypassing the nonce-hiding behavior.

> **Superseded:** The async callback directly calls `attach()` and `focus()` without checking whether the textarea is still in the DOM.
> **Reason:** `enterTicketsEditMode()` is now asynchronous. If the user clicks Cancel or Save before the Promise resolves, `exitTicketsEditMode()` replaces `detailContent.innerHTML`, detaching the textarea. `attach()` calls `textarea.parentNode.insertBefore()` — `parentNode` is null on a detached node, throwing an uncaught TypeError. This introduces a new crash that didn't exist in the synchronous version.
> **Replaced with:** A race-condition guard at the top of the `.then()` callback: `if (!document.body.contains(descTextarea) || !ticketsEditMode) return;` — exits silently if the textarea was destroyed or edit mode was exited while waiting for the script to load.

> **Superseded:** When recovery fails (script tag absent or re-injection fails), the helper logs `console.error` and resolves `false` — the user sees a bare textarea with no explanation.
> **Reason:** The user doesn't read the developer console. Silent degradation (or console-only errors) is the exact user experience this plan aims to fix — the user perceives the missing editor as "removed." Replacing one silent failure with another (just louder in the console) doesn't improve the user experience.
> **Replaced with:** A visible error banner injected above the textarea: "Rich editor unavailable — using plain text mode. Reloading the panel may restore it." This informs the user that the plain textarea is a fallback, not the intended experience, and suggests a recovery action.

### 2. No changes to `tickets.html`, `TicketsPanelProvider.ts`, or `headlessPanelHtml.ts`

The script tag and URI substitution are already correct in both hosts (extension: `TicketsPanelProvider.ts:1248`, standalone: `headlessPanelHtml.ts:466`). The fix is entirely in `tickets.js` — it recovers from any failure in the existing wiring rather than requiring changes to the wiring itself. Both hosts serve the same `tickets.js` file, so the fix lands in both hosts by construction. No divergence risk.

## Verification Plan

### Automated Tests

No automated test framework is configured for the webview JavaScript files. Verification is manual via the VS Code extension and standalone browser host.

### Goal Invariants

1. **Assert `ensureMarkdownEditorLoaded` is a function** — `typeof ensureMarkdownEditorLoaded === 'function'` in `src/webview/tickets.js`.
2. **Assert the race-condition guard is present** — the `.then()` callback in `enterTicketsEditMode()` contains `document.body.contains(descTextarea)` before the `attach()` call.
3. **Assert `getAttribute('nonce')` is used** — `ensureMarkdownEditorLoaded()` uses `getAttribute('nonce')`, not the `.nonce` IDL property.
4. **Assert the visible error banner is present** — the `else` branch of the `loaded && window.SwitchboardMarkdownEditor` check creates a DOM element with a user-facing message.
5. **Assert the original `renderPreview` and `onAttachImage` callbacks are unchanged** — the callback bodies in the `attach()` call are identical to the pre-change version (lines 3125-3175 of the original file).
6. **Assert no `window.confirm()` or confirmation dialog was added** — per the project's hard rule, no confirmation gates exist in the changed code.

### Manual Verification Steps

1. **Reproduce the failure**: Temporarily add a `type="text/broken"` attribute to the `MARKDOWN_EDITOR_URI` script tag in a local copy of `dist/webview/tickets.html` (so the browser doesn't execute it), launch the extension in development mode, open the Tickets panel, select a ticket, and click **Edit**. Confirm you see a bare textarea (reproducing the user's issue).

2. **Verify the fix**: Restore the script tag, then apply the code change to `tickets.js`. Rebuild with `npm run compile`. Launch the extension, open the Tickets panel, select a ticket, and click **Edit**. The rich markdown editor (toolbar, split preview, formatting buttons) should appear immediately (helper resolves synchronously when script is already loaded).

3. **Verify dynamic recovery**: Keep the script tag but add `type="text/broken"` to it so the browser doesn't execute it on initial load. With the fix, `ensureMarkdownEditorLoaded()` should find the tag's `src`, re-inject it as a proper `<script>`, and the editor should appear after a brief delay.

4. **Verify visible error when tag is absent**: Remove the `MARKDOWN_EDITOR_URI` script tag entirely from a local copy of `dist/webview/tickets.html`. With the fix, clicking **Edit** should show the visible error banner ("Rich editor unavailable — using plain text mode...") above a plain textarea — not a silent bare textarea.

5. **Verify race-condition guard**: Click **Edit**, then immediately click **Cancel** before the editor loads (simulate by adding `type="text/broken"` to force async recovery). Confirm no TypeError appears in the console and the panel returns to view mode cleanly.

6. **Verify no regression when script loads normally**: With everything in its default state (script tag present, file present), click **Edit** — the editor should appear immediately with no delay (the helper resolves synchronously).

7. **Verify focus works**: After clicking **Edit**, the textarea should be focused and ready to type in. Type some text and confirm the live preview updates (if in split mode).

8. **Verify save still works**: Edit the ticket content, click **Save** — the markdown should be saved correctly (the save handler at tickets.js:5219 reads `editDiv.value` which is the textarea's value, unchanged by the editor shell).

9. **Verify other panels unaffected**: Open the Planning panel's docs tab, click **Edit** — the markdown editor should still work there (no changes to planning.js).

10. **Verify standalone host**: Launch the standalone host, open the Tickets panel in the browser, select a ticket, and click **Edit**. The rich markdown editor should appear (same `tickets.js` served via `headlessPanelHtml.ts`).

## Uncertain Assumptions

- **Windsurf webview script-loading behavior**: The plan assumes that dynamically re-injecting a `<script>` element with a valid nonce and `src` will be executed by the webview's rendering engine. This is standard browser behavior and holds in VS Code's Electron-based webviews. Windsurf is a VS Code fork and likely shares the same webview implementation, but Windsurf-specific quirks that prevent dynamic script execution cannot be ruled out from the code alone. The user was advised to run web research to confirm Windsurf's webview script-loading behavior before implementation.
