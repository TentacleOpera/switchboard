# Fix Role Selector Dropdown Visibility in Prompts Tab

**Plan ID:** A548A26A-59BE-4935-BF89-0551CEC40927

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
3. The inline style on the select is `flex: 1; min-width: 150px;` (line 2814) but the CSS class adds `min-width: 200px;` (line 2238) — the CSS class `min-width: 200px` may override the inline `min-width: 150px` depending on specificity (inline should win, but the combination is confusing).

The core problem is that the `<select>` element's `background: #0a0a0a` is nearly identical to the surrounding panel background, and the border `var(--accent-teal-dim)` is too dim to be visible. In dark themes, the select element blends into the background and appears invisible. The user perceives this as the dropdown being "beyond the add-ons section" because they can see the add-ons section below but cannot see the dropdown that should be above it.

Additionally, the `.prompts-tab` container has `overflow-y: auto; height: 100%;` (line 2214). If the content is tall, the role selector scrolls out of view. But the primary issue is the select's visual styling making it invisible.

## Metadata

- **Tags:** bugfix, ui, ux, frontend
- **Complexity:** 3

## User Review Required

Yes — visual/CSS change affecting the Prompts tab role selector across all themes. User should confirm the dropdown is visible in their preferred theme(s) before merge. No data-model or backend changes, so no schema review needed.

## Complexity Audit

### Routine
- CSS-only border/background/focus styling change on a single selector (`.role-selector-section select`, ~line 2233).
- One small JS addition: scroll `.prompts-tab` to top on Prompts tab activation (existing tab-switch handler, ~line 3942).
- No logic, backend, or data-model changes. The select is functionally present and works when clicked — purely a visibility fix.
- Reuses existing CSS custom properties (`--accent-teal`, `--accent-teal-dim`, `--panel-bg2`).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Theme compatibility:** The fix must work across all themes (default dark, cyber, claudify). Using `var(--accent-teal)` for the border and a theme-aware background ensures consistency. Verified `--accent-teal` and `--accent-teal-dim` are defined theme variables; `--panel-bg` is `#000000` and `--panel-bg2` is `#0a0a0a` in the default theme (lines 18-19).
- **`handleRoleChange()`:** The function that shows/hides role-specific sections is triggered by the select's change event (line 3264). It works correctly — the issue is purely visual.
- **Custom agents optgroup:** The `<optgroup id="customAgentsGroup">` (line 2825) is populated dynamically by `updateCustomAgentsDropdown()` (line 3252). The fix must not affect this.
- **EXPORT AS SKILL button:** This button (line 2827) sits next to the select in the same flex row. The fix targets only the `select` element, not the row layout, so button visibility is unaffected.
- **`flex: 1` on the select:** The select uses `flex: 1` (inline, line 2814) to fill available width. The fix is about colors/border, not layout — `flex: 1` and `min-width` are left untouched.
- **Scroll-restore interaction:** The Prompts tab hydration block (line 3942) already calls `loadRoleConfigs()` and `updateRoleDescription()`. Adding `scrollTop = 0` there runs after content hydration; since hydration is synchronous DOM writes, the scroll reset lands correctly.
- **Race Conditions:** None — single-threaded DOM updates within one event handler.
- **Security:** None — no input handling or data flow changes.
- **Side Effects:** None beyond the visual change.
- **Dependencies & Conflicts:** Independent of the sibling subtask (move-feature-directives checkbox), which edits a different region of the same file. Both touch `kanban.html` but non-overlapping line ranges; merge conflicts unlikely if applied in sequence.

## Dependencies

- None — standalone CSS/UX fix. No prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the proposed `var(--panel-bg, #0d0d0d)` background resolves to `#000000` in the default theme — *darker* than the current `#0a0a0a`, which could worsen contrast rather than improve it; (2) scroll-to-top on every tab switch discards the user's last scroll position, which may annoy users who deliberately scrolled to the add-ons section. Mitigations: use `--panel-bg2` (or a slightly lightened variant) for the background so the select is distinguishable from the `#000000` page bg, and accept the scroll-reset as intended behavior since the role selector is the tab's primary control.

## Proposed Changes

### `src/webview/kanban.html` — Fix `.role-selector-section select` CSS (~line 2233)

Make the select element visually distinct by using a brighter border and a theme-aware background:

```css
.role-selector-section select {
    padding: 6px 12px;
    border: 1px solid var(--accent-teal);
    border-radius: 4px;
    font-size: 13px;
    min-width: 200px;
    background: var(--panel-bg2, #0a0a0a);
    color: var(--text-primary);
}
```

Key changes:
- `border` changed from `var(--accent-teal-dim)` (too dim) to `var(--accent-teal)` (clearly visible) — **this is the primary visibility fix**.
- `background` changed from hardcoded `#0a0a0a` to `var(--panel-bg2, #0a0a0a)`. **Clarification:** the original plan draft proposed `var(--panel-bg, #0d0d0d)`, but `--panel-bg` resolves to `#000000` in the default theme (line 18) — darker than the current value and nearly identical to the page background, which would *not* improve contrast. `--panel-bg2` (`#0a0a0a`, line 19) matches the current value but is now theme-aware; the real visibility gain comes from the brighter teal border. If stronger contrast against the teal-tinted section background is desired, consider `color-mix(in srgb, var(--panel-bg2) 85%, #ffffff 5%)` to lift it slightly.

### `src/webview/kanban.html` — Add focus styling for the select (after the block above)

Add a focus state so the select is clearly interactive:

```css
.role-selector-section select:focus {
    outline: none;
    border-color: var(--accent-teal);
    box-shadow: 0 0 0 1px var(--accent-teal-dim);
}
```

### `src/webview/kanban.html` — Scroll the role selector into view on Prompts tab activation (~line 3942)

The Prompts tab hydration block in the tab-switch handler (lines 3942-3946) currently reads:

```javascript
// Hydrate PROMPTS tab when activated
if (tabName === 'prompts') {
  postKanbanMessage({ type: 'getCustomAgents' });
  loadRoleConfigs();
  updateRoleDescription();
}
```

Add a scroll-reset so the role selector is at the top of the scrollable area when the user enters the tab:

```javascript
// Hydrate PROMPTS tab when activated
if (tabName === 'prompts') {
  postKanbanMessage({ type: 'getCustomAgents' });
  loadRoleConfigs();
  updateRoleDescription();
  const promptsTab = document.querySelector('.prompts-tab');
  if (promptsTab) promptsTab.scrollTop = 0;
}
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

### Automated Tests

Skipped per session directive — this is a CSS/visual-UX change with no logic path to unit-test. Verification is manual (steps 1-7 above).

---

**Recommendation:** Complexity 3 → Send to Intern.
