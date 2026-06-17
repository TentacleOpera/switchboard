# Standardize setup.html Tab Navigation Styling

## Metadata
**Complexity:** 3
**Tags:** frontend, ui

## Goal
Update the tab navigation styling in `setup.html` to match the compact styling and teal backlight behavior used in `planning.html` and `design.html`, ensuring visual consistency across Switchboard webviews.

## Problem
The tab navigation in `setup.html` uses a different CSS pattern (`.shared-tab-bar`/`.shared-tab-btn`) that:
- Takes up more vertical space (padding: `8px 16px` vs `4px 10px`)
- Lacks the teal backlight on active state
- Uses border-based active state instead of background-based
- Has `top: 1px` positioning for tab overlap effect

This creates visual inconsistency with other webviews that use the `.strip-btn` pattern.

## Solution
Replace the tab styling in `setup.html` with the `.strip-btn` pattern used in `planning.html` and `design.html`.

## User Review Required
- Confirm intentional font-family change from `--font-mono` to `--font-family` for tab buttons.

## Complexity Audit

### Routine
- CSS class replacement in a single HTML file
- HTML class attribute rename
- JavaScript selector rename
- Cyber-theme rule swap

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** If JS selectors are not updated to match new class names, tab switching will fail completely. If `flex-shrink: 0` and `white-space: nowrap` are omitted from `.strip-btn`, tabs may wrap in narrow webviews.
- **Dependencies & Conflicts:** None.

## Dependencies
none

## Adversarial Synthesis
Key risks: JS selector desync causing dead tabs, tab wrapping in narrow viewports from missing nowrap/shrink rules, and missing cyber-theme glow/blur overrides. Mitigations: update all `.shared-tab-btn` selectors to `.strip-btn`, add `flex-shrink: 0; white-space: nowrap;` to `.strip-btn`, and port `.cyber-theme-enabled .controls-strip` and `.cyber-theme-enabled .strip-btn:hover` rules from planning.html.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`
- **Context:** Lines 407-463 contain `.shared-tab-bar`/`.shared-tab-btn` styles; lines 469-480 contain the tab navigation HTML; lines 1524 and 1553 query `.shared-tab-btn` in JavaScript.
- **Logic:** Replace the `.shared-tab-bar`/`.shared-tab-btn` CSS block with the `.controls-strip`/`.strip-btn` pattern; rename HTML classes; update JS selectors; add cyber-theme overrides matching planning.html.
- **Implementation:**
  1. Replace CSS block (lines 407-463): remove `.shared-tab-bar`, `.shared-tab-btn`, and `.cyber-theme-enabled` rules. Insert `.controls-strip` and `.strip-btn` styles. Ensure `.strip-btn` includes `flex-shrink: 0; white-space: nowrap;` to preserve tab layout. Retain `.shared-tab-content` and `.shared-tab-content.active` rules within the same block.
  2. Add cyber-theme overrides immediately after the new CSS block: `.cyber-theme-enabled .controls-strip` (blur/transparent background) and `.cyber-theme-enabled .strip-btn:hover:not(:disabled)` (`box-shadow: var(--glow-teal)`).
  3. Update HTML class names (lines 469-480): change `shared-tab-bar` → `controls-strip`, `shared-tab-btn` → `strip-btn`.
  4. Update JS selectors (lines 1524, 1553): change `document.querySelectorAll('.shared-tab-btn')` to `document.querySelectorAll('.strip-btn')`.
- **Edge Cases:** Narrow webview widths may cause tab wrapping if nowrap/shrink omitted; missing JS selector update bricks tab switching entirely.

## Verification Plan

### Automated Tests
- None. Manual verification required in VS Code webview.

### Manual Verification
- Open setup.html in the webview.
- Verify tabs have compact height matching planning.html/design.html.
- Verify active tab shows teal backlight (`background: var(--accent-teal-dim)`).
- Verify hover states and cyber-theme glow (when theme enabled).
- Verify tab switching functionality still works and persists.
- Resize webview narrow; confirm tabs do not wrap.

## Implementation Steps

### 1. Replace CSS in setup.html (lines 407-463)
Remove the existing `.shared-tab-bar` and `.shared-tab-btn` styles and replace with:

```css
.controls-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--panel-bg2);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.strip-btn {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-family: var(--font-family);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 4px 10px;
  cursor: pointer;
  border-radius: 2px;
  transition: all 0.15s;
  flex-shrink: 0;
  white-space: nowrap;
}

.strip-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
  border-color: var(--accent-teal-dim);
  color: var(--accent-teal);
}

.strip-btn.active {
  background: var(--accent-teal-dim);
  border-color: var(--accent-teal);
  color: var(--accent-teal);
  font-weight: 600;
}

.strip-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-color: var(--border-color);
  color: var(--text-secondary);
}
```

### 2. Add cyber-theme overrides
Add after the new CSS block:

```css
.cyber-theme-enabled .controls-strip {
  background: rgba(10, 10, 10, 0.65);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom-color: color-mix(in srgb, var(--accent-primary) 20%, transparent);
}

.cyber-theme-enabled .strip-btn:hover:not(:disabled) {
  box-shadow: var(--glow-teal);
}
```

### 3. Update HTML class names (lines 469-480)
Change the tab navigation HTML from:
```html
<div class="shared-tab-bar" role="tablist" aria-label="Setup sections">
    <button class="shared-tab-btn active" data-tab="setup" role="tab" aria-selected="true">Setup</button>
    <button class="shared-tab-btn" data-tab="kanban" role="tab" aria-selected="false">Kanban</button>
    ...
</div>
```

To:
```html
<div class="controls-strip" role="tablist" aria-label="Setup sections">
    <button class="strip-btn active" data-tab="setup" role="tab" aria-selected="true">Setup</button>
    <button class="strip-btn" data-tab="kanban" role="tab" aria-selected="false">Kanban</button>
    ...
</div>
```

### 4. Update JavaScript selectors (lines 1524, 1553)
Change `document.querySelectorAll('.shared-tab-btn')` to `document.querySelectorAll('.strip-btn')` in both `initTabs()` and `activateTab()`.

### 5. Verify tab content panel styling
Ensure `.shared-tab-content` styles (lines 112-117, 445-454) remain unchanged as they control the content panels, not the navigation.

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`

## Risks
- None - this is a pure CSS/HTML class name change with no functional logic impact, provided JS selectors are updated to match.

**Recommendation:** Send to Intern

## Review Findings
Files changed: `src/webview/setup.html` only. CSS block (407-474) replaced with `.controls-strip`/`.strip-btn` including `flex-shrink:0; white-space:nowrap;` and both cyber-theme overrides; HTML classes (481-493) and JS selectors (1588, 1617) all renamed to `.strip-btn`; `.shared-tab-content` panel rules correctly preserved. Grep confirms zero orphaned `.shared-tab-bar`/`.shared-tab-btn` references — no dead tab-switching risk. Validation: static review only (compile/tests skipped per directive); manual webview check still required. Remaining risk: none material; the `--font-mono`→`--font-family` change flagged in "User Review Required" is intentional and present.
