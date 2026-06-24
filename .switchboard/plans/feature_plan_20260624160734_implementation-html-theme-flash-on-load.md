# Fix: implementation.html Theme Flash (Teal -> Orange) on Load

## Goal

Eliminate the FOUC where `implementation.html` (the Switchboard sidebar) briefly paints the default Afterburner teal before correcting to the selected theme's colour, by making the client-side theme-class handler idempotent and non-destructive so it never strips a correct class that was already injected server-side.

### Problem
When the Claudify theme is selected, `implementation.html` (the Switchboard sidebar) briefly flashes the default Afterburner teal colour (`#00e5ff`) for ~1 second before switching to the Claudify terracotta orange (`#D97757`). This is a visual FOUC (Flash of Unstyled Content) — the panel paints with the wrong theme and then corrects itself.

### Root Cause Analysis
The theme is applied to the `<body>` element via a CSS class (`theme-claudify`, `theme-afterburner-pro`, `cyber-theme-enabled`). There are two mechanisms that set this class:

1. **Server-side injection (`applyThemeBodyClass`)** — `TaskViewerProvider._getHtmlForWebview()` calls `applyThemeBodyClass(content)` at <ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts" /> line 17766, which rewrites the `<body>` tag to include the correct theme class before the HTML is sent to the webview. This should prevent any flash because the class is present on first paint. (Note: the original plan cited line 17692; the call is now at line 17766 — the mechanism is unchanged.)

2. **Client-side message handler (`switchboardThemeNameSetting`)** — After the webview loads, `_sendInitialState()` posts a `switchboardThemeNameSetting` message (`TaskViewerProvider.ts` lines 4111-4114). The handler in `implementation.html` (lines 2489-2502) **removes ALL theme classes** and then re-adds the correct one:
   ```js
   document.body.classList.remove('theme-claudify', 'theme-afterburner-pro', 'cyber-theme-enabled');
   if (message.theme === 'claudify') {
       document.body.classList.add('theme-claudify');
   }
   ```

The flash occurs because of a **timing gap between first paint and the `switchboardThemeNameSetting` message arriving**. The `_sendInitialState()` call happens inside a `setTimeout` after `setImmediate(_runDeferredConstructorInit())` — the deferred constructor init (DB/registry/brain-watcher bootstrap) can burn hundreds of milliseconds on the event loop, delaying the theme message. During this window, if the server-side `applyThemeBodyClass` injection is not effective, the panel renders with the default `:root` teal variables.

**Why `applyThemeBodyClass` may not be effective:** The function uses `html.replace(/<body\b([^>]*)>/i, ...)` — a single-replace regex without the `g` flag. While there is only one `<body>` tag in the source file (confirmed at `implementation.html:1401`, a bare `<body>` with no attributes), the function is only as reliable as the compiled output in the installed VSIX. If the VSIX was built from a commit before `applyThemeBodyClass` was wired in, or if the `dist/` build is stale, the body tag arrives without a class and the panel defaults to `:root` (teal) until the postMessage handler fires.

**The core fix:** Make the client-side message handler **idempotent and non-destructive** — it should only add the correct class and remove classes that are wrong, without stripping the correct class that may already be present from server-side injection. This eliminates the flash regardless of whether `applyThemeBodyClass` ran, because the class is never removed if it's already correct.

## Metadata
- **Tags:** bugfix, ui, frontend
- **Complexity:** 3/10

## User Review Required
- None. This is a self-contained bug fix with a clear correct behaviour. The "optional hardening" (visibility-gating `<body>`) is explicitly deferred and only applies if the handler fix proves insufficient during verification — it is not part of the committed scope.

## Complexity Audit
**Routine.** The fix is a small, localized change to the `switchboardThemeNameSetting` / `switchboardThemeChanged` message handler in `implementation.html`. The logic is straightforward: compute the desired class set, remove only theme classes that should NOT be present, and add only theme classes that should be present. No new dependencies, no architectural changes, single file.

### Routine
- Single-file edit to one message-handler `case` block in `src/webview/implementation.html`.
- Reuses the existing theme→class mapping already encoded in both the old handler and `getThemeBodyClass()`.
- No new state, no new messages, no server-side logic change (the `themeBodyClass.ts` touch is a comment-only clarification).
- Pure DOM `classList` manipulation; no async, no timing dependencies introduced.

### Complex / Risky
- None. The only subtlety is preserving non-theme classes (`kanban-icons-colour`, `cyber-animation-disabled`) injected server-side, which the diff-based approach handles by construction (those classes are not in the remove-list).

## Edge-Case & Dependency Audit

### Race Conditions
- **First-paint vs. message arrival** — This is the entire point of the fix. Server-side injection (`applyThemeBodyClass`) and the later `switchboardThemeNameSetting` postMessage can land in either order relative to paint. The idempotent handler is order-independent: whether it runs before or after the class is already present, the final class set is identical and the correct class is never momentarily removed.
- **No new races introduced** — The handler remains synchronous DOM manipulation on the webview thread.

### Security
- None. No user input, no HTML injection, no `innerHTML`. Operates only on a fixed allow-list of class-name string literals via `classList`.

### Side Effects
- **Preserves `kanban-icons-colour`** — `getThemeBodyClass()` (`themeBodyClass.ts:48-55`) injects `kanban-icons-colour` for `claudify` / `afterburner-professional` when colour icons are enabled. The current handler ignores it; the fix must NOT strip it. Because it is absent from `allThemeClasses`, the diff-based remove loop never touches it. ✅
- **Preserves `cyber-animation-disabled`** — Injected for `afterburner` when `theme.disableCyberAnimation` is set (`themeBodyClass.ts:45-46`). Same protection: not in `allThemeClasses`, never removed. ✅
- **Runtime theme switching (`switchboardThemeChanged`)** — Same handler. Switching themes still removes the now-wrong theme classes (they ARE in `allThemeClasses`) and adds the new ones. Clarification on a known, acceptable behaviour: `cyber-animation-disabled` and `kanban-icons-colour` are intentionally NOT reconciled by this handler (they were not before either). `cyber-animation-disabled` lingering on a non-afterburner body is inert (its CSS selectors are afterburner-scoped). `kanban-icons-colour` is desired by `claudify`/`afterburner-professional` anyway, and is governed by its own colour-icons message path — out of scope for this flash fix.

### Dependencies & Conflicts
- **`themeBodyClass.ts` ↔ handler sync** — The client handler's theme→class mapping must stay consistent with `getThemeBodyClass()`. Verified consistent today: `afterburner → cyber-theme-enabled`, `claudify → theme-claudify`, `afterburner-professional → theme-claudify theme-afterburner-pro`. A clarifying comment in `themeBodyClass.ts` will document this coupling.
- **Other panels** — `planning.html`, `kanban.html`, `setup.html`, `design.html` carry near-identical handlers. This plan addresses ONLY `implementation.html` per the issue. The same idempotent pattern could later be applied to them if they exhibit the same flash, but that is explicitly out of scope here.

## Dependencies
- None. This change does not depend on any other in-flight plan/session.

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) accidentally stripping non-theme classes (`kanban-icons-colour`, `cyber-animation-disabled`) injected server-side, and (2) the handler's theme→class map drifting out of sync with `getThemeBodyClass()`. Both are mitigated structurally — the diff-based remove loop only iterates a fixed theme-class allow-list, so non-theme classes are untouched by construction, and a clarifying comment ties the two maps together. The fix is order-independent, so it cannot itself cause a flash regardless of whether server-side injection ran.

## Proposed Changes

### File: `src/webview/implementation.html` (lines 2489-2502)

**Context:** This is the `message` event handler `case` for `switchboardThemeNameSetting` / `switchboardThemeChanged`. It currently does a destructive remove-all-then-add, which momentarily clears a correct class injected server-side and is the proximate cause of the flash.

**Logic:** Compute the *desired* theme-class set for the incoming theme. Remove from the body only those theme classes (from a fixed allow-list) that are NOT desired. Add only the desired classes. Never touch classes outside the theme allow-list, so server-injected `kanban-icons-colour` / `cyber-animation-disabled` survive.

**Edge Cases:** `afterburner-professional` requires BOTH `theme-claudify` and `theme-afterburner-pro`; the desired-set handles this. Unknown/empty `message.theme` falls through to an empty desired set → all theme classes removed (matches prior default-theme behaviour of no theme class).

Replace the destructive remove-all-then-add pattern with an idempotent diff-based approach:

**Before:**
```js
case 'switchboardThemeNameSetting':
case 'switchboardThemeChanged': {
    if (message.theme) {
        document.body.classList.remove('theme-claudify', 'theme-afterburner-pro', 'cyber-theme-enabled');
        if (message.theme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        } else if (message.theme === 'claudify') {
            document.body.classList.add('theme-claudify');
        } else if (message.theme === 'afterburner-professional') {
            document.body.classList.add('theme-claudify', 'theme-afterburner-pro');
        }
    }
    break;
}
```

**After:**
```js
case 'switchboardThemeNameSetting':
case 'switchboardThemeChanged': {
    if (message.theme) {
        // Compute the desired theme class set without touching unrelated classes
        // (e.g. kanban-icons-colour, cyber-animation-disabled) that may have been
        // injected server-side by applyThemeBodyClass().
        const allThemeClasses = ['theme-claudify', 'theme-afterburner-pro', 'cyber-theme-enabled'];
        const desired = new Set();
        if (message.theme === 'afterburner') {
            desired.add('cyber-theme-enabled');
        } else if (message.theme === 'claudify') {
            desired.add('theme-claudify');
        } else if (message.theme === 'afterburner-professional') {
            desired.add('theme-claudify');
            desired.add('theme-afterburner-pro');
        }
        // Remove only theme classes that should NOT be present — leave the
        // correct ones in place so there is no flash if they were already
        // injected by applyThemeBodyClass at HTML generation time.
        for (const cls of allThemeClasses) {
            if (!desired.has(cls)) {
                document.body.classList.remove(cls);
            }
        }
        // Add any desired classes that are not yet present.
        for (const cls of desired) {
            document.body.classList.add(cls);
        }
    }
    break;
}
```

### File: `src/services/themeBodyClass.ts` — Verify `applyThemeBodyClass` regex robustness

**Context:** `applyThemeBodyClass` (`themeBodyClass.ts:64-70`) rewrites the `<body>` tag class server-side via `html.replace(/<body\b([^>]*)>/i, ...)`.

**Logic / Verification:** The existing function is correct and needs no behavioural change — confirmed: the single bare `<body>` at `implementation.html:1401` matches `/<body\b([^>]*)>/i`, and the function strips any prior `class="..."` before re-adding `getThemeBodyClass()`. 

**Implementation:** Add a defensive comment (Clarification, not a behaviour change) documenting that the client-side handler in each webview must keep its theme→class mapping in sync with the classes produced by `getThemeBodyClass()` here.

**Optional hardening** (deferred — only if the flash persists after the handler fix): Add an inline `<style>` block in `<head>` that sets `visibility: hidden` on `body` until the theme class is present, then a tiny inline `<script>` that sets `visibility: visible` once the class is confirmed. This is a heavier approach and should only be used if the handler fix alone is insufficient.

## Verification Plan

> Per session directives: SKIP COMPILATION and SKIP TESTS are in effect — do not run `tsc`/build or the automated suite as part of verification this session. Manual webview verification below stands; the user will run the suite separately.

1. **Reproduce the original flash** — Set theme to Claudify, reload the Switchboard sidebar (close and reopen the panel). Observe the teal-to-orange flash.
2. **Apply the fix** — Edit the message handler in `src/webview/implementation.html`.
3. **Test Claudify theme** — Reload the sidebar. The panel should paint orange from the first frame with no teal flash.
4. **Test Afterburner theme** — Switch to Afterburner, reload. Should paint teal with no flash.
5. **Test Afterburner Professional theme** — Switch to Afterburner Professional, reload. Should paint with the correct combined theme, no flash.
6. **Test runtime theme switching** — While the panel is open, switch themes in Settings. The panel should transition correctly without leftover theme classes from the previous theme.
7. **Test `kanban-icons-colour` preservation** — Enable colour kanban icons, reload. Confirm the `kanban-icons-colour` class is NOT stripped by the theme handler.

### Automated Tests
- No automated tests exist for webview message handlers (these are inline `<script>` in HTML, not unit-tested), and the session directive skips the suite. If the user later wants regression coverage, the smallest viable unit test would extract the desired-class computation into a pure helper and assert the class set for each of the four theme values (`afterburner`, `claudify`, `afterburner-professional`, unknown/empty). This is optional and out of scope for the fix itself.

## Uncertain Assumptions
None — every claim in this plan (handler location and code, server-side injection call site, theme→class mappings, message-send path, the single bare `<body>` tag) was verified directly against the current source. No web research is required before implementation.

---

**Recommendation:** Complexity 3/10 → **Send to Intern.**
