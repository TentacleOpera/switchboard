# Remove Afterburner CRT Scanline Effects from HTML Tab in Planning Panel

## Goal

Remove the CRT scanline overlay element from the Planning panel's HTML tab preview wrapper so HTML previews render cleanly without distortion, while the Docs and Tickets tabs retain their scanline effects.

### Problem
The HTML tab in `planning.html` has Afterburner CRT scanline effects (`.cyber-scanlines`) applied on top of HTML previews. These effects distort the rendered HTML and should not be present. The user specifies that only the Docs and Tickets tabs should have CRT scanline effects — the HTML tab should display previews cleanly.

### Root Cause
The HTML tab's preview panel wrapper in `planning.html` (line 3484) contains a `<div class="cyber-scanlines"></div>` element at line 3510. When the Afterburner theme is active, the `body.cyber-theme-enabled` class causes all `.cyber-scanlines` elements to become visible (CSS rule at line 1999: `.cyber-theme-enabled .cyber-scanlines { display: block; }`). There is no per-tab suppression logic — every `preview-panel-wrapper` that contains a `.cyber-scanlines` div gets the effect.

The Docs tab (line 3420) and Tickets tab (line 3667) also have `.cyber-scanlines` divs, which is correct per the user's requirement. The HTML tab's div is the one that needs removal.

### Background
The CRT scanline effect consists of two visual layers:
1. **Static scanline texture** — a repeating linear gradient of dark horizontal lines (`.cyber-scanlines` itself, `z-index: 5`).
2. **Animated sweep beam** — a `::before` pseudo-element with a moving gradient (`z-index: 6`, `scanline-sweep` animation).

Both are controlled by the presence of the `.cyber-scanlines` div inside a `.preview-panel-wrapper`. There is also a JS-toggled `.scanlines-suppressed` class on `.preview-panel-wrapper` that hides scanlines via `display: none !important` (line 2060), but this is not used for per-tab control.

The cleanest fix is to simply remove the `<div class="cyber-scanlines"></div>` from the HTML tab's preview panel wrapper. This ensures the effect never appears on HTML previews regardless of theme state.

## Metadata
- **Tags**: ui, ux, bugfix
- **Complexity**: 1/10

## User Review Required
No user review required. This is a single-element deletion from static HTML with no logic, state, or migration implications. The change is fully reversible and has no user-data impact.

## Complexity Audit

### Routine
- Single-element deletion from static HTML — remove `<div class="cyber-scanlines"></div>` at line 3510
- No JS logic changes — the scanline effect is entirely driven by the presence of the `.cyber-scanlines` div and CSS rules
- No CSS changes — the existing CSS rules remain for the Docs and Tickets tabs
- No state management changes — no persisted state references scanline elements
- No migrations needed — this is a visual element in a webview, not persisted user data

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None. The scanline div is static HTML with no JS interaction. No concurrent access.
- **Security**: No security implications. Purely visual element removal.
- **Side Effects**: The `.scanlines-suppressed` JS-toggled class (line 2060) becomes dead code for the HTML tab — it toggles `display: none !important` on a `.cyber-scanlines` element that no longer exists. This is harmless (the selector simply matches nothing) but technically leaves dead JS code if any JS toggles this class on the HTML tab's wrapper. No functional impact.
- **Dependencies & Conflicts**: No dependencies on other plans. This plan touches `planning.html` at line 3510 only. The tab reposition plan (Plan 1) touches lines 3359-3365 — no overlap. The sidebar formatting plan (Plan 2) touches `planning.js` only — no overlap.
- **Theme switching**: When the user switches from Afterburner to Claudify, `body.cyber-theme-enabled` is removed and all scanlines hide via CSS. Removing the div from the HTML tab has no effect on this — it just ensures the HTML tab never shows scanlines even under Afterburner.
- **Other tabs**: The Docs tab (line 3420) and Tickets tab (line 3667) retain their `.cyber-scanlines` divs. No impact.
- **Design panel**: `design.html`'s HTML Previews tab also has a `.cyber-scanlines` div. This plan does not touch `design.html` — the user's issue is specifically about `planning.html`. If the user later wants the same fix in `design.html`, that would be a separate plan.
- **No JS count/index references**: No JS code queries `.cyber-scanlines` elements by count or index. The CSS is purely declarative. Removing one instance does not affect others.

## Dependencies
- None

## Adversarial Synthesis
Key risks: none of substance. The only consideration is that the `.scanlines-suppressed` class becomes dead code for the HTML tab, but this is harmless. Mitigations: the deletion is a single line with no downstream dependencies; the CSS rules remain for other tabs; no JS counts or indexes scanline elements.

## Proposed Changes

### File: `src/webview/planning.html` (line 3510)

Remove the `<div class="cyber-scanlines"></div>` element from the HTML tab's `preview-panel-wrapper`.

**Before (lines 3484–3511):**
```html
<div class="preview-panel-wrapper">
    <div id="preview-pane-planning-html" style="flex: 1; width: 100%; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 0;">
        <!-- ... initial state, loading state, preview wrapper ... -->
    </div>
    <div class="cyber-scanlines"></div>
</div>
```

**After:**
```html
<div class="preview-panel-wrapper">
    <div id="preview-pane-planning-html" style="flex: 1; width: 100%; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 0;">
        <!-- ... initial state, loading state, preview wrapper ... -->
    </div>
</div>
```

**Implementation detail**: Delete line 3510 (`<div class="cyber-scanlines"></div>`) — the one that sits between the closing `</div>` of `#preview-pane-planning-html` (line 3509) and the closing `</div>` of `.preview-panel-wrapper` (line 3511) inside the `#html-content` tab (line 3469).

No other files need changes.

## Verification Plan

### Automated Tests
No automated tests required. This is a single-element deletion from static HTML. The test suite will be run separately by the user.

### Manual Verification
1. Set the Switchboard theme to Afterburner (which enables CRT scanlines).
2. Open the Planning panel and switch to the Docs tab — verify scanline effects ARE visible on the doc preview.
3. Switch to the Tickets tab — verify scanline effects ARE visible on the ticket preview.
4. Switch to the HTML tab — verify scanline effects are NOT visible on the HTML preview. The preview should render cleanly with no horizontal lines or sweep beam.
5. Load an HTML file into the preview and confirm it renders without scanline distortion.
6. Switch to the Claudify theme and verify the HTML tab still renders cleanly (no scanlines expected under Claudify either).
7. Switch back to Afterburner and re-confirm the HTML tab is clean.

**Recommendation**: Complexity 1/10 → Send to Intern.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> *"You deleted a div. One div. A self-closing div with one class. And you didn't even need to count braces for this one. I'm almost disappointed it's correct."*

No CRITICAL, MAJOR, or NIT findings. The `<div class="cyber-scanlines"></div>` element has been removed from the HTML tab's `preview-panel-wrapper` (formerly line 3510). The Docs tab (line 3420) and Tickets tab (line 3666) retain their scanline divs. The CSS rules remain untouched.

### Stage 2 — Balanced Synthesis

**Keep**: Everything. The deletion is clean — the HTML tab's `preview-panel-wrapper` (lines 3484–3510) now contains only `#preview-pane-planning-html` and no scanline overlay. Docs and Tickets tabs confirmed unaffected.

**Fix now**: Nothing.

**Defer**: Nothing.

### Code Fixes Applied
None required.

### Verification Results
- **Syntax check**: N/A (static HTML element deletion).
- **HTML tab scanline removal confirmed**: `planning.html` lines 3484–3510 — `preview-panel-wrapper` contains only `#preview-pane-planning-html`, no `.cyber-scanlines` div. ✓
- **Docs tab scanlines preserved**: Line 3420 — `<div class="cyber-scanlines"></div>` present. ✓
- **Tickets tab scanlines preserved**: Line 3666 — `<div class="cyber-scanlines"></div>` present. ✓
- **CSS rules untouched**: `.cyber-scanlines` rules at lines 1985, 1999, 2002, 2060 remain for other tabs. ✓
- **No JS changes**: Scanline visibility is purely CSS-driven; no JS references the HTML tab's scanline element. ✓

### Files Changed
- `src/webview/planning.html` — removed `<div class="cyber-scanlines"></div>` from HTML tab's `preview-panel-wrapper` (formerly line 3510)

### Remaining Risks
None. The `.scanlines-suppressed` JS-toggled class (line 2060) is now dead code for the HTML tab specifically, but this is harmless — the selector simply matches nothing. No functional impact.
