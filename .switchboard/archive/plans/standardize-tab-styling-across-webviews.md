# Standardize Tab Styling Across Switchboard Webviews

## Goal
Unify tab navigation styling across kanban.html, planning.html, design.html, and setup.html to eliminate visual inconsistencies caused by different agents choosing different designs. Use kanban.html styling as the canonical reference (black background, less busy appearance) and create a shared CSS file for maintainability.

## Metadata
**Complexity:** 3
**Tags:** ui, frontend, refactor

## User Review Required
- Confirm canonical tab style: kanban black background (`--panel-bg`), 10px uppercase, no bottom-border indicator.
- Confirm dropping setup.html `position: sticky` tab-bar behavior (or preserving it as a local override).
- Confirm webpack CSS copy addition is acceptable build change.

## Complexity Audit

### Routine
- Extract existing CSS into shared file.
- Mechanical find-and-replace class names in HTML and JS.
- Add one CopyPlugin pattern to `webpack.config.js`.

### Complex / Risky
- Setup.html uses `.open` for active tab content while other files use `.active`; requires JS logic change to align with shared CSS.
- Missing the build-step update would silently break runtime styling.

## Edge-Case & Dependency Audit

### Race Conditions
- None. UI-only CSS/JS changes with no asynchronous state coordination.

### Security
- None.

### Side Effects
- Renaming `kanban-tab-content` breaks `src/test/prompts-tab-move-regression.test.js` regex (line 27).
- Setup.html generic `.tab-content` is used only for tab panels, but a grep audit should confirm no other consumers exist in that file.
- Moving cyber-theme glow rules from planning/design inline CSS to the shared file means kanban.html will inherit dormant selectors; harmless because kanban `body` lacks `cyber-theme-enabled`.

### Dependencies & Conflicts
- External scripts `src/webview/planning.js` and `src/webview/design.js` must be updated alongside their HTML files.
- `webpack.config.js` must be updated before any packaged build.

## Dependencies
`sess_20260614_012211 — Tab styling unification across webviews`

## Adversarial Synthesis
Key risks: setup.html’s `.open`-vs-`.active` mismatch and its generic `.tab-content` collision potential; missing webpack CSS copy pattern would ship broken tabs at runtime; cyber-theme glow extraction from planning/design must remain scoped to avoid phantom styling on kanban. Mitigations: align setup JS to use `.active`, add `*.css` to CopyPlugin, keep glow selectors under `.cyber-theme-enabled`.

## Problem Analysis
The four webview HTML files have completely different tab styling implementations:
- **kanban.html**: Uses `.kanban-tab-bar` / `.kanban-tab-btn` with black background (`--panel-bg`), 10px font, 1px letter-spacing, border-radius 3px 3px 0 0, top positioning
- **planning.html**: Uses `.research-tab-bar` / `.research-tab-btn` with darker background (`--panel-bg2`), 11px font, 0.5px letter-spacing, similar border-radius
- **design.html**: Same as planning.html (`.research-tab-bar` / `.research-tab-btn`)
- **setup.html**: Uses `.tab-nav` / `.tab-btn` with no border-radius, border-bottom indicator (2px solid), different padding approach

Additionally, the tab containers have `overflow-x: auto` which can cause unwanted vertical scrollbars to appear.

## Root Cause
Different agents independently implemented tab navigation for each webview without a shared design system or CSS reference, leading to inconsistent styling patterns.

## Proposed Changes

### `src/webview/shared-tabs.css` (new)
- **Context:** New shared stylesheet to be linked by all four webviews.
- **Logic:** Extract canonical kanban tab styling plus cyber-theme glow overrides from planning/design.
- **Implementation:**
  - `.shared-tab-bar`: `display:flex`, `align-items:center`, `gap:2px`, `padding:8px 16px 0`, `background:var(--panel-bg)`, `border-bottom:1px solid var(--border-color)`, `overflow-x:auto`, `overflow-y:hidden`.
  - `.shared-tab-btn`: `flex-shrink:0`, `white-space:nowrap`, transparent bg, `border:1px solid transparent`, `border-bottom:none`, `color:var(--text-secondary)`, `font-family:var(--font-mono)`, `font-size:10px`, `letter-spacing:1px`, `text-transform:uppercase`, `padding:8px 16px`, `cursor:pointer`, `border-radius:3px 3px 0 0`, `transition:all 0.15s`, `position:relative`, `top:1px`.
  - `.shared-tab-btn:hover`: `color:var(--text-primary)`, `background:color-mix(in srgb, var(--accent-teal) 5%, transparent)`.
  - `.shared-tab-btn.active`: `color:var(--accent-teal)`, `background:var(--panel-bg2)`, `border-color:var(--border-color)`, `border-bottom-color:var(--panel-bg2)`.
  - `.shared-tab-content`: `display:none`, `flex:1`, `flex-direction:column`, `overflow:hidden`.
  - `.shared-tab-content.active`: `display:flex`.
  - `.cyber-theme-enabled .shared-tab-btn.active`: `box-shadow: 0 -2px 8px color-mix(in srgb, var(--accent-teal) 30%, transparent)`.
  - `.cyber-theme-enabled .shared-tab-bar`: `background: rgba(10, 10, 10, 0.65)`, `backdrop-filter: blur(10px)`, `-webkit-backdrop-filter: blur(10px)`.
- **Edge Cases:** Ensure `overflow-y:hidden` prevents vertical scrollbar. Keep `display:flex` for `.active` to match kanban/setup expectations.

### `src/webview/kanban.html`
- **Context:** Canonical source; currently defines inline tab CSS lines 981-1031.
- **Logic:** Replace classes, remove duplicated inline CSS, update JS selectors.
- **Implementation:**
  - Insert `<link rel="stylesheet" href="shared-tabs.css">` before `</head>` at line ~2190.
  - Replace `.kanban-tab-bar` → `.shared-tab-bar` in HTML at line ~2193.
  - Replace `.kanban-tab-btn` → `.shared-tab-btn` in HTML lines ~2194-2201.
  - Replace `.kanban-tab-content` → `.shared-tab-content` in HTML lines ~2205, ~2268, ~2275, ~2290, ~2360, ~2427, ~2811.
  - Remove inline CSS block lines 980-1031.
  - Update JS selectors lines ~3468-3475 and ~5512 from `.kanban-tab-btn`/`.kanban-tab-content` to shared names.
- **Edge Cases:** Update `src/test/prompts-tab-move-regression.test.js` line 27 regex from `kanban-tab-content` to `shared-tab-content`.

### `src/webview/planning.html`
- **Context:** Uses `.research-tab-*` classes.
- **Logic:** Same mechanical rename; move cyber glow rules to shared CSS.
- **Implementation:**
  - Insert `<link rel="stylesheet" href="shared-tabs.css">` before `</head>` at line ~2908.
  - Replace `.research-tab-bar` → `.shared-tab-bar` in HTML line ~2910.
  - Replace `.research-tab-btn` → `.shared-tab-btn` in HTML lines ~2911-2916.
  - Replace `.research-tab-content` → `.shared-tab-content` in HTML lines ~2920, ~2971, ~3010, ~3118, ~3159.
  - Remove inline CSS block lines 121-171.
  - Remove cyber-theme glow rules for tabs (lines ~2110, ~2132) since they move to shared CSS.
  - Update `src/webview/planning.js` selectors lines ~294, ~370, ~424-443 from `.research-tab-btn`/`.research-tab-content` to shared names.
- **Edge Cases:** Ensure `id="research-tab-bar"` remains unchanged; only class names change.

### `src/webview/design.html`
- **Context:** Mirrors planning.html structure.
- **Logic:** Same mechanical rename.
- **Implementation:**
  - Insert `<link rel="stylesheet" href="shared-tabs.css">` before `</head>` at line ~3488.
  - Replace `.research-tab-bar` → `.shared-tab-bar` in HTML line ~3490.
  - Replace `.research-tab-btn` → `.shared-tab-btn` in HTML lines ~3491-3495.
  - Replace `.research-tab-content` → `.shared-tab-content` in HTML lines ~3499, ~3535, ~3585, ~3637, ~3685.
  - Remove inline CSS block lines 122-172.
  - Remove cyber-theme glow rules for tabs (lines ~2157, ~2179) since they move to shared CSS.
  - Update `src/webview/design.js` selectors lines ~129-130 from `.research-tab-btn`/`.research-tab-content` to shared names.
- **Edge Cases:** `id="research-tab-bar"` remains unchanged.

### `src/webview/setup.html`
- **Context:** Uses `.tab-nav`, `.tab-btn`, `.tab-content`, and `.tab-content.open` for active state.
- **Logic:** Rename classes and align active state to `.active` to match shared CSS.
- **Implementation:**
  - Insert `<link rel="stylesheet" href="shared-tabs.css">` before `</head>` at line ~465.
  - Replace `.tab-nav` → `.shared-tab-bar` in HTML line ~470.
  - Replace `.tab-btn` → `.shared-tab-btn` in HTML lines ~471-480.
  - Replace `.tab-content` → `.shared-tab-content` in HTML lines ~483, ~560, ~567, ~589, ~602, ~628, ~923, ~1003, ~1062, ~1095.
  - Replace `.tab-content.open` → `.shared-tab-content.active` in HTML (initial state on line ~483, then JS toggles `.active`).
  - Remove inline CSS block lines 405-463.
  - Update JS `initTabs()` and `activateTab()` lines ~1492-1536 to query `.shared-tab-btn` and `.shared-tab-content`, and to toggle `.active` instead of `.open` on content panels.
- **Edge Cases:** Verify no other `.tab-content` consumers exist in setup.html (grep shows only tab panels). Preserve `role="tablist"` and ARIA attributes on the bar.

### `webpack.config.js`
- **Context:** Build currently copies `src/webview/*.html` and `*.js`, but not CSS.
- **Logic:** Add CSS files to CopyPlugin patterns.
- **Implementation:**
  - Add pattern `{ from: 'src/webview/*.css', to: 'webview/[name][ext]' }` inside `CopyPlugin.patterns` array after the JS pattern (around line 87).
- **Edge Cases:** Verify `dist/webview/shared-tabs.css` is emitted after build.

### `src/test/prompts-tab-move-regression.test.js`
- **Context:** Hardcoded regex expects `kanban-tab-content`.
- **Logic:** Update regex to match new shared class.
- **Implementation:**
  - Change line 27 regex from `class="kanban-tab-content"` to `class="shared-tab-content"`.
- **Edge Cases:** None.

## Verification Plan

### Automated Tests
- SKIP per session directive. Regression test suite will be run separately by user.
- Post-change, `src/test/prompts-tab-move-regression.test.js` must pass after its regex is updated.

### Manual Verification
1. Open each webview in VS Code to verify tabs render correctly.
2. Test tab switching functionality in all four files.
3. Verify no vertical scrollbar appears on tab containers.
4. Confirm consistent visual appearance across all files.
5. Test with both default and claudify themes.

## Risks
- **Breaking tab functionality**: If JavaScript selectors aren't updated correctly, tab switching will fail.
- **CSS variable mismatch**: If any file has different CSS variable names, styling will break.
- **Build system**: The shared CSS file may not be automatically copied to dist/ by the build process.
- **Setup active-state mismatch**: setup.html toggles `.open` on content panels instead of `.active`; misalignment with shared CSS will leave all panels hidden.
- **Test regression**: `prompts-tab-move-regression.test.js` regex will fail unless updated.

## Success Criteria
- All four webviews have identical tab styling.
- No vertical scrollbar appears on tab containers.
- Tab switching works correctly in all files.
- Single source of truth for tab styling (`shared-tabs.css`).
- Future tab changes only require editing one file.

**Recommendation:** Send to Intern (complexity 3).

## Review Findings

Implementation is solid and meets all plan requirements. All four webviews link to `shared-tabs.css`, use the new `.shared-tab-*` classes, old inline CSS was removed, JS selectors were updated, webpack config includes the CSS copy pattern, and the regression test regex was updated. During review, redundant `#*-content.active { display: flex; }` CSS overrides were found in `planning.html` and `design.html` — leftovers from the old `.research-tab-content.active { display: block }` era that now defeat the shared CSS single-source-of-truth. These were removed. A stale comment in `design.html` justifying a Stitch tab override was also removed. Files changed: `planning.html`, `design.html`. No functional regressions introduced. Remaining risk: the `#research-tab-bar` and `#research-content` IDs in planning/design retain old naming but are harmless and were explicitly preserved per plan instructions.
