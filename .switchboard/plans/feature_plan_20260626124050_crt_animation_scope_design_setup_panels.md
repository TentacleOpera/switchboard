# Remove CRT Scanline Animation from the Design and Setup Panels

## Goal

The afterburner theme's CRT scanline/sweep animation is intended to appear **only** on the Artifacts panel (`planning.html`) and the Project panel (`project.html`). It is currently also rendering on the **Design** panel (`design.html`) and the **Setup** panel (`setup.html`). This plan removes the animation from those two panels while leaving the two intended ones untouched.

### Problem Analysis & Root Cause

The CRT effect is a `<div class="cyber-scanlines">` element plus CSS where `.cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before` runs `animation: scanline-sweep …`, with a static texture from `.cyber-theme-enabled .cyber-scanlines { display:block }`.

Both offending panels simply **ship the full CRT markup and CSS** (it was copied in), so under the afterburner theme they animate exactly like the intended panels. There is no per-panel suppression flag — the animation is present purely because the elements + CSS exist in these two files:

- **`setup.html`** — one top-level `.cyber-scanlines` div at `setup.html:577` (just after `<body>`), CSS at `setup.html:442-485` using `position: fixed; inset: 0`, so it animates the **entire viewport**.
- **`design.html`** — five `.cyber-scanlines` divs (one per preview tab) at `design.html:3636, 3694, 3774, 3833, 3879`, CSS at `design.html:1971-2019` using `position: absolute; inset: 0` inside each `position: relative` preview wrapper, animating **each preview pane**.

The intended panels use the same pattern and must NOT be touched: `project.html` (CSS `659-704`; divs `1425, 1485, 1530, 1562, 1597`; `scanlines-suppressed` rule at `706-708`) and `planning.html` (CSS `1973-2019`; divs `3399, 3595`; `scanlines-suppressed` rule at `2047-2050`). `kanban.html` and `implementation.html` have no `.cyber-scanlines` at all (intentionally plain).

`themeBodyClass.ts` is **not** involved — the body class is correct; the bug is the presence of the CRT markup/CSS in these two files. The `cyber-animation-disabled` body class (toggled in `design.js:3458` and `setup.html:4289` area) is a **separate** theme feature that freezes the sweep animation globally; it must NOT be removed — only the scanline elements and their dedicated CSS/JS are removed.

**`@keyframes scanline-sweep` scope note:** Each HTML file defines its own `@keyframes scanline-sweep` inside its own `<style>` block. Removing the copy from `setup.html` (lines 476-479) and `design.html` (lines 2007-2010) will NOT affect `project.html` or `planning.html` — they have their own independent copies.

## Metadata

- **Tags:** `bugfix`, `ui`, `frontend`
- **Complexity:** 3/10
- **Primary files:** `src/webview/setup.html`, `src/webview/design.html`, `src/webview/design.js`

## User Review Required

No user review required. This is a purely visual bugfix with no state, migration, or data implications. The change is scoped to removing dead markup/CSS/JS from two panels. Proceed directly to implementation.

## Complexity Audit

### Routine
- Deleting a single `<div class="cyber-scanlines"></div>` element + comment from `setup.html` (2 lines).
- Deleting one dead CSS block (`.cyber-scanlines` rules + `@keyframes` + `@media reduced-motion`) from `setup.html` (lines 442-485).
- Deleting five `<div class="cyber-scanlines"></div>` elements from `design.html` (one per preview tab).
- Deleting one dead CSS block from `design.html` (lines 1971-2019) plus the `scanlines-suppressed` rule (lines 2064-2067).
- Updating one stale CSS comment at `design.html:1355` that references `.cyber-scanlines`.
- Removing 12 dead `classList.add/remove('scanlines-suppressed')` calls from `design.js`.
- Removing 5 now-dead wrapper variable declarations from `design.js`.

### Complex / Risky
- None. All changes are dead-code removal. No state, no migration, no provider changes, no new patterns.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The scanline elements are static markup rendered at page load; there is no async lifecycle or shared mutable state. The `scanlines-suppressed` class toggling in `design.js` happens synchronously in message handlers.
- **Security:** None. No credentials, no API changes, no input handling affected.
- **Side Effects:**
  - **Do NOT touch `project.html` / `planning.html`** — they are the intended animators. The change must be scoped to `design.html` and `setup.html` only. Each file has its own independent `@keyframes scanline-sweep` and `scanlines-suppressed` CSS, so removing copies from design/setup cannot affect the intended panels.
  - **`cyber-animation-disabled` must stay:** This body class (toggled at `design.js:3458` and in setup's theme code) is a separate user-facing feature that freezes the sweep animation. It is NOT part of the scanline removal.
  - **`design.js` wrapper variables become dead:** The five variables (`clWrapper`, `htmlWrapper`, `wrapper`, `designWrapper`, `briefsWrapper`) are used exclusively for `scanlines-suppressed` toggling. Once the class toggling is removed, the declarations are dead and must also be removed to avoid orphaned DOM queries.
  - **Stale CSS comment at `design.html:1355`:** The image z-index rule has a comment referencing `.cyber-scanlines`. The `z-index: 7` value itself is harmless (images will just have an unnecessary z-index), but the comment must be updated so it doesn't reference a deleted element.
  - **First paint:** `applyThemeBodyClass`/`getThemeBodyClass` still set `cyber-theme-enabled` on these panels for the rest of the afterburner styling (borders, colors) — that is correct and must stay. Only the scanline elements are removed.
- **Dependencies & Conflicts:** No dependencies on other plans or sessions. No conflicting changes expected — this is isolated dead-code removal.

## Dependencies

None. This plan is self-contained and has no dependencies on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) incomplete JS cleanup — the original plan missed 2 of 12 `scanlines-suppressed` calls and all 5 dead variable declarations, which would leave orphaned DOM queries; (2) a stale CSS comment at `design.html:1355` referencing a deleted element. Mitigations: enumerate all 12 class-toggling lines and all 5 variable declarations explicitly in the execution steps; update the stale comment to remove the `.cyber-scanlines` reference. No race, security, or migration risks exist.

## Proposed Changes

### `src/webview/setup.html`

Remove the scanline overlay element and its now-dead CSS.

- **Context:** `setup.html` ships a viewport-wide CRT scanline overlay that should not be present. The CSS block at lines 442-485 and the div at lines 576-577 are entirely local to this file.
- **Logic:** Delete the markup element and the dedicated CSS block. The `@keyframes scanline-sweep` at lines 476-479 is local to setup.html and safe to remove.
- **Implementation:**
  - Delete the element + comment at `setup.html:576-577`:
    ```html
    <!-- CRT scanline overlay (Afterburner only; non-interactive, viewport-fixed) -->
    <div class="cyber-scanlines"></div>
    ```
  - Delete the dead CSS block at `setup.html:442-485` (`.cyber-scanlines`, `.cyber-theme-enabled .cyber-scanlines`, the animated `::before`, `@keyframes scanline-sweep`, and the `@media (prefers-reduced-motion)` block). Line 486 (blank separator) can optionally be removed too.
- **Edge Cases:** Do NOT remove the `cyber-animation-disabled` references at `setup.html:458, 481` — those are part of the CSS block being deleted, so they go with it. The `cyber-animation-disabled` toggle in the JS portion (around line 4289) must stay.

### `src/webview/design.html`

Remove the five scanline overlay divs, their dead CSS, the `scanlines-suppressed` rule, and update a stale comment.

- **Context:** `design.html` ships five `.cyber-scanlines` divs (one per preview tab: Briefs, Design, HTML, Claude, Images) plus the full CRT CSS block and a JS-toggled suppression rule. All of this is local to this file.
- **Logic:** Delete all scanline markup and CSS. Update the stale z-index comment that references `.cyber-scanlines`.
- **Implementation:**
  - Delete the five `.cyber-scanlines` divs at `design.html:3636, 3694, 3774, 3833, 3879` (Briefs, Design, HTML, Claude, Images preview tabs).
  - Delete the dead CSS block at `design.html:1971-2019` (`.cyber-scanlines`, `.cyber-theme-enabled .cyber-scanlines`, the `::before` sweep, `@keyframes scanline-sweep`, and the `@media (prefers-reduced-motion)` block).
  - Delete the `scanlines-suppressed` rule at `design.html:2064-2067`:
    ```css
    /* Class-based scanline suppression — toggled by JS */
    .preview-panel-wrapper.scanlines-suppressed > .cyber-scanlines {
        display: none !important;
    }
    ```
  - **Update the stale comment** at `design.html:1355`. The current comment reads:
    ```css
    z-index: 7; /* Above .cyber-scanlines (z-index: 5) and sweep animation to prevent overlay distortion */
    ```
    Change it to remove the `.cyber-scanlines` reference (the `z-index: 7` and `box-shadow` values are harmless and can stay):
    ```css
    z-index: 7; /* Elevated so images pop above overlay layers */
    ```
- **Edge Cases:** Do NOT touch the `.zoomable-container` CSS at line 2021 (immediately after the scanline CSS block). Do NOT remove the `cyber-animation-disabled` references at lines 1988, 2015 — they are part of the CSS block being deleted and go with it.

### `src/webview/design.js`

Remove all `scanlines-suppressed` class toggling (12 lines) and the 5 now-dead wrapper variable declarations.

- **Context:** `design.js` toggles a `scanlines-suppressed` class on `.preview-panel-wrapper` elements to hide scanlines when showing images/HTML/iframes (so they don't distort), and re-enables them for markdown content. Once the `.cyber-scanlines` divs are gone from `design.html`, all of this is dead code.
- **Logic:** Remove every `classList.add('scanlines-suppressed')` and `classList.remove('scanlines-suppressed')` call, plus the 5 wrapper variable declarations that exist solely for this purpose.
- **Implementation:**
  - **Remove 5 dead variable declarations:**
    - `const clWrapper = document.querySelector('#claude-content .preview-panel-wrapper');` — line 1147
    - `const htmlWrapper = document.querySelector('#html-preview-content .preview-panel-wrapper');` — line 1206
    - `const wrapper = document.querySelector('#images-content .preview-panel-wrapper');` — line 1266
    - `const designWrapper = document.querySelector('#design-content .preview-panel-wrapper');` — line 1302
    - `const briefsWrapper = document.querySelector('#briefs-content .preview-panel-wrapper');` — line 1374
  - **Remove 12 class-toggling lines:**
    - `if (clWrapper) clWrapper.classList.add('scanlines-suppressed');` — lines 1153, 1168, 1180
    - `if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');` — lines 1212, 1225, 1237
    - `if (wrapper) wrapper.classList.add('scanlines-suppressed');` — line 1270
    - `if (designWrapper) designWrapper.classList.add('scanlines-suppressed');` — lines 1309, 1331, 1348
    - `if (designWrapper) designWrapper.classList.remove('scanlines-suppressed');` — line 1357
    - `if (briefsWrapper) briefsWrapper.classList.remove('scanlines-suppressed');` — line 1380
  - **Do NOT remove** the `cyber-animation-disabled` toggle at `design.js:3458` — that is a separate theme animation feature.
- **Edge Cases:** The `wrapper` variable at line 1266 (Images tab) is a common name but in that scope is used only for the scanlines-suppressed toggle at line 1270 — safe to remove both. Verify no other code in the same scope references these wrapper variables after removal (confirmed: each is used exclusively for the class toggle).

## Verification Plan

### Automated Tests

No automated tests apply (per session directive, the test suite is run separately by the user). This is a purely visual/CSS change with no logic branches that unit tests would cover. Verification is manual visual inspection as described below.

### Manual Verification

1. Build/install the VSIX. Select the **afterburner** theme.
2. Open the **Design** panel — confirm there is no scanline texture and no moving sweep on any of the five preview tabs (Briefs, Design, HTML, Claude, Images). Confirm the rest of the afterburner styling (borders/colors) is intact.
3. Open the **Setup** panel — confirm no viewport-wide scanline texture or sweep, with afterburner styling otherwise intact.
4. Open the **Artifacts** (planning) panel and the **Project** panel — confirm the CRT animation is **still present** (regression guard).
5. Switch to the **claudify** theme and confirm none of the panels show scanlines (unchanged).
6. Grep the repo to confirm no orphaned `scanlines-suppressed` references remain in `design.js` or `design.html`:
   ```
   grep -rn "scanlines-suppressed" src/webview/design.js src/webview/design.html
   ```
   (Expected: zero matches. `project.html` and `planning.html` should still have their own copies — those are intended.)
7. Grep to confirm no orphaned `cyber-scanlines` references remain in `setup.html` or `design.html`:
   ```
   grep -rn "cyber-scanlines" src/webview/setup.html src/webview/design.html
   ```
   (Expected: zero matches in setup.html; zero in design.html except possibly the updated comment at line 1355 if the word "scanlines" was retained — if so, that's fine as long as it no longer references `.cyber-scanlines` as an element.)

---

**Recommendation:** Complexity is 3/10 → **Send to Intern**. This is a routine dead-code removal (markup + CSS + JS class toggling) confined to three files with no state, migration, or architectural risk. The only care needed is completeness — ensure all 12 JS class-toggling lines and all 5 variable declarations are removed, not just the 10 `add` calls.
