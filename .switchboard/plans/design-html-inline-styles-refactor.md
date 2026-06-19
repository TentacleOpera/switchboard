# Move Inline Styles to CSS Classes in design.html

## Metadata
**Complexity:** 6
**Tags:** refactor, frontend, ui

## Goal

### Problem
The HTML body section of `design.html` (`:3504-3995`) is riddled with `style="..."` attributes on nearly every element. This makes maintenance extremely difficult, overrides the CSS cascade unpredictably, and makes it impossible to theme or refactor without touching the HTML structure.

### Root Cause
Elements were styled inline during rapid prototyping rather than using CSS classes. This pattern compounds — once some elements use inline styles, new elements follow the same pattern.

### Background
Examples of problematic inline styles:
- `:3536` — `#preview-pane-briefs` has `style="flex: 1; width: 100%; box-sizing: border-box; overflow: auto; height: 100%;"`
- `:3566` — `.sub-tab-switcher` has `style="display: flex; gap: 8px; padding: 6px 12px; ..."`
- `:3572` — `#design-local-panel` has `style="display: flex; flex-direction: column; flex: 1; ..."`
- `:3609` — `#design-systems-panel` has `style="display: none; flex-direction: column; flex: 1; ..."`
- `:3610-3618` — Multiple nested elements with inline styles for layout
- `:3656-3667` — `#preview-pane-html` and children with inline styles
- `:3707-3718` — `#preview-pane-images` and children with inline styles
- `:3737-3789` — Stitch controls strip with extensive inline styles
- `:3817-3872` — Stitch preview pane with inline styles
- `:3894-3908` — Stitch prompt modal with inline styles

## Approach
1. **Inventory** all inline styles in the HTML body, grouping by purpose (layout, visibility, sizing, theming)
2. **Create CSS classes** for each pattern, using the existing CSS naming conventions (e.g., `.stitch-controls-row`, `.design-sub-tab-switcher`)
3. **Replace inline styles** with class assignments, moving `display: none` toggles to JS classList operations
4. **Handle dynamic styles** — some inline styles are set/changed by JS (e.g., `display: none` → `display: flex`). These need to use CSS classes toggled via `classList.add/remove` instead
5. **Verify** each tab still renders correctly after changes

## Files Changed
- `src/webview/design.html` — CSS additions and HTML inline style removal
- Companion JS file — update any code that sets `element.style.display` to use classList instead

## Risks
- Some inline styles may be set dynamically by JS and not visible in the static HTML — need to grep the JS for `.style.` property assignments
- `display: none` → `display: flex` toggles are common — need a consistent pattern (e.g., `.hidden { display: none !important; }`)
- Large diff — should be done tab-by-tab to keep reviews manageable

## Verification
- Open each tab (Stitch, Briefs, HTML Previews, Images, Design System) and verify visual parity
- Test tab switching to verify show/hide behavior works
- Test modals (folder management, design system CRUD, prompt generator) open and close correctly
