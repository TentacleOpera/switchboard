# Fix Role Selector Dropdown Visibility in Prompts Tab

## Goal

In the Prompts tab of `kanban.html`, the role selector dropdown (`<select id="roleSelect">`) is not visible to the user. It appears to be hidden or pushed beyond the add-ons section, making it impossible to switch between roles. The dropdown should be clearly visible at the top of the Prompts tab.

### Problem Analysis & Root Cause

The Prompts tab structure (lines 2805-3031 of `src/webview/kanban.html`) is:
1. Role Selector `.db-subsection` (contains the `<select id="roleSelect">`)
2. Planner Config (Workflow File, Add-ons)
3. Research Complexity Config
4. Prompt Customization (non-planner Add-ons)
5. Edit Prompt Template (preview textarea)

The Role Selector section is at the top of the DOM, so the issue is CSS-related, not DOM order. Investigation reveals:

1. The `.role-selector-section` CSS (line 2218) sets `background: color-mix(in srgb, var(--accent-teal) 10%, transparent)` — a subtle teal-tinted background.
2. The `<select>` inside it has CSS (line 2233): `background: #0a0a0a; color: var(--text-primary); border: 1px solid var(--accent-teal-dim);`
3. The inline style on the select is `flex: 1; min-width: 150px;` but the CSS class adds `min-width: 200px;` — the CSS class `min-width: 200px` may override the inline `min-width: 150px` depending on specificity (inline should win, but the combination is confusing).

The core problem is that the `<select>` element's `background: #0a0a0a` is nearly identical to the surrounding panel background, and the border `var(--accent-teal-dim)` is too dim to be visible. In dark themes, the select element blends into the background and appears invisible. The user perceives this as the dropdown being "beyond the add-ons section" because they can see the add-ons section below but cannot see the dropdown that should be above it.

Additionally, the `.prompts-tab` container has `overflow-y: auto; height: 100%;` (line 2214). If the content is tall, the role selector scrolls out of view. But the primary issue is the select's visual styling making it invisible.

## Metadata

- **Tags:** bug, prompts-tab, role-selector, css, kanban-html
- **Complexity:** 3

## Complexity Audit

**Routine.** CSS-only fix to make the select element visually distinct. No logic changes, no backend changes. The select is functionally present in the DOM and works when clicked — it's just not visible.

## Edge-Case & Dependency Audit

- **Theme compatibility:** The fix must work across all themes (default dark, cyber, claudify). Using `var(--accent-teal)` for the border and a slightly lighter background ensures theme consistency.
- **`handleRoleChange()`:** The function that shows/hides role-specific sections is triggered by the select's change event. It works correctly — the issue is purely visual.
- **Custom agents optgroup:** The `<optgroup id="customAgentsGroup">` is populated dynamically. The fix should not affect this.
- **EXPORT AS SKILL button:** This button sits next to the select in the same flex row. The fix should not affect its visibility.
- **`flex: 1` on the select:** The select uses `flex: 1` to fill available width. This is fine — the fix is about colors/border, not layout.

## Proposed Changes

### `src/webview/kanban.html` — Fix `.role-selector-section select` CSS (~line 2233)

Make the select element visually distinct by using a brighter border and a slightly different background:

```css
.role-selector-section select {
    padding: 6px 12px;
    border: 1px solid var(--accent-teal);
    border-radius: 4px;
    font-size: 13px;
    min-width: 200px;
    background: var(--panel-bg, #0d0d0d);
    color: var(--text-primary);
}
```

Key changes:
- `border` changed from `var(--accent-teal-dim)` (too dim) to `var(--accent-teal)` (clearly visible).
- `background` changed from hardcoded `#0a0a0a` to `var(--panel-bg, #0d0d0d)` — uses the theme's panel background variable, which is slightly different from the surrounding `.role-selector-section` background, creating visual contrast.

### `src/webview/kanban.html` — Add focus styling for the select

Add a focus state so the select is clearly interactive:

```css
.role-selector-section select:focus {
    outline: none;
    border-color: var(--accent-teal);
    box-shadow: 0 0 0 1px var(--accent-teal-dim);
}
```

### `src/webview/kanban.html` — Ensure the role selector section is always scrolled into view on tab switch

When the Prompts tab is activated, ensure the role selector is visible by scrolling the `.prompts-tab` container to the top. Find the tab-switch handler for the Prompts tab and add:

```javascript
const promptsTab = document.querySelector('.prompts-tab');
if (promptsTab) promptsTab.scrollTop = 0;
```

This ensures the role selector is at the top of the scrollable area when the user switches to the Prompts tab, rather than being scrolled down to wherever the user last left it (which could be the add-ons or preview section).

## Verification Plan

1. Open the Kanban board and switch to the Prompts tab.
2. Verify the role selector dropdown is immediately visible at the top of the tab.
3. Verify the dropdown has a visible teal border and is distinguishable from the background.
4. Click the dropdown — verify all roles are listed (Planner, Lead Coder, Coder, etc.).
5. Select a different role — verify the tab content updates (add-ons change, preview refreshes).
6. Switch away from the Prompts tab and back — verify the role selector is scrolled to the top and visible.
7. Test in multiple themes (default, cyber, claudify) — verify the select is visible in all themes.
