# Show an Expand Icon When the Tickets Tab Sidebar Is Collapsed

## Goal

In the Tickets tab of `planning.html`, collapsing the sidebar leaves no visible icon to expand it again. The expand toggle (»») must remain visible when the sidebar is collapsed, matching the other tabs.

### Problem Analysis

The collapse mechanism works by toggling `.collapsed` on the tab's `.content-row`, which hides all direct children of the list pane except `.sidebar-toggle-row` ([planning.html:295-300](src/webview/planning.html#L295)), then re-centers the toggle row ([357-362](src/webview/planning.html#L357)). The toggle button text flips `«` ⇄ `»` in `applySidebarState()` ([planning.js:626-636](src/webview/planning.js#L626)).

For most tabs the `.sidebar-toggle-row` contains only the collapse button (plus a `.sidebar-folders-btn` that is explicitly hidden when collapsed via [364-366](src/webview/planning.html#L364)). The Docs tab's "Manage Folders" button and the Kanban tab's "Epics/Plans" toggle are both created dynamically with the `.sidebar-folders-btn` class (planning.js:1434, 4750), so they inherit the existing collapse-hide behavior. But the **Tickets** toggle row also contains two always-visible `.strip-btn` buttons — `#tickets-link-all` and `#tickets-import-all-kanban` ([planning.html:3358-3362](src/webview/planning.html#L3358)):

```html
<div class="sidebar-toggle-row">
  <button id="tickets-link-all" class="strip-btn" ...>Link all</button>
  <button id="tickets-import-all-kanban" class="strip-btn" ...>Import all to kanban</button>
  <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
</div>
```

When collapsed, `#tree-pane-tickets` gets `padding:4px; overflow:hidden` ([288-293](src/webview/planning.html#L288)) and shrinks to a narrow 40px strip ([280-281](src/webview/planning.html#L280)). The toggle row uses `justify-content: flex-end`, so the two `.strip-btn` buttons (which are NOT `.sidebar-folders-btn` and therefore are NOT hidden when collapsed) sit before the `»` button and push it past the narrow pane's right edge, where `overflow:hidden` clips it off-screen. Result: no visible expand icon.

### Root Cause

`#tickets-link-all` and `#tickets-import-all-kanban` stay visible inside the collapsed toggle row and shove the expand button out of the clipped, narrow collapsed pane. Other tabs avoid this because their extra controls use the `.sidebar-folders-btn` class (created dynamically in planning.js:1434 and 4750), which IS hidden when collapsed by the rule at [364-366](src/webview/planning.html#L364).

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bugfix

## User Review Required

No. This is a CSS-only fix with no behavioral, data, or backend impact. No JS state changes, no new event listeners, no DOM restructuring. The two `.strip-btn` buttons are hidden only while collapsed and reappear on expand — consistent with how `.sidebar-folders-btn` controls behave in other tabs. The user should visually confirm the `»` expand icon is visible when collapsed, but no architectural review is needed.

## Complexity Audit

### Routine
- Hiding the extra `.strip-btn` buttons when the tickets sidebar is collapsed (CSS-only), so only the expand toggle remains — exactly how `.sidebar-folders-btn` is handled at [364-366](src/webview/planning.html#L364).
- Adding a single CSS rule to `src/webview/planning.html` in the existing collapsed-state CSS block.

### Complex / Risky
- None. CSS-only; no JS state changes. Must ensure the `»` is centered/visible after the extras are hidden.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The CSS rule is static; collapse state is toggled synchronously in `applySidebarState()` ([planning.js:627-637](src/webview/planning.js#L627)).
- **Security:** None.
- **Side Effects:** "Link all" and "Import all to kanban" become unavailable while collapsed — acceptable and consistent with other tabs hiding their extra controls (`.sidebar-folders-btn`) when collapsed. They reappear on expand. Note: `#tickets-import-all-kanban` is conditionally visible (shown only when a ClickUp list or Linear project is selected — planning.js:6821, 7078). The `display: none !important` rule correctly overrides both the default hidden state and the JS-set visible state when collapsed; on expand, the inline style takes over again and the button returns to its correct visibility.
- **Dependencies & Conflicts:** None. The Source-modal consolidation plan (`feature_plan_20260622120018`) restructures the `controls-strip-row` (top filter area), which is a separate DOM region from the `sidebar-toggle-row` inside `#tree-pane-tickets`. No overlap.

## Dependencies

None. This plan is self-contained and has no dependency on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) The `!important` flag is required because JS sets `style.display` inline on `#tickets-import-all-kanban` — without `!important` the CSS rule would be overridden and the bug would silently return when a ClickUp/Linear project is loaded. (2) ID-based selectors are brittle — a future third `.strip-btn` in the toggle row would reintroduce the bug. Mitigations: Use a general `.strip-btn` class selector scoped to the collapsed tickets toggle row (future-proof, same specificity, zero styling impact). Document the `!important` rationale in a CSS comment. Add a verification step that preconditions `Import all to kanban` as visible before collapsing.

## Proposed Changes

### 1. `src/webview/planning.html` — hide the extra toggle-row buttons when collapsed

Add a rule alongside the existing collapsed-folders rule ([364-366](src/webview/planning.html#L364)):

```css
/* Hide tickets strip-btns when collapsed — !important needed because JS sets
   inline style.display on #tickets-import-all-kanban (planning.js:6821,7078) */
.content-row.collapsed #tree-pane-tickets .sidebar-toggle-row .strip-btn {
    display: none !important;
}
```

This general selector hides ALL `.strip-btn` elements in the tickets toggle row when collapsed, future-proofing against additional buttons. It leaves only the `.sidebar-toggle-btn` in the collapsed (centered) toggle row, so the `»` expand icon is visible and clickable.

> **Why not ID-based?** Targeting `#tickets-link-all` and `#tickets-import-all-kanban` individually works today but is brittle — any future `.strip-btn` added to the toggle row would reintroduce the same bug. The class-based selector is strictly better: same specificity, zero styling impact on non-collapsed state, and self-documenting.
>
> **Why `!important`?** `#tickets-import-all-kanban` has its visibility toggled by JS via `element.style.display = ''` (planning.js:6821, 7078). Inline styles override normal CSS declarations. Without `!important`, the rule would fail to hide the button when a ClickUp list or Linear project is selected. The existing `.sidebar-folders-btn` rule at [364-366](src/webview/planning.html#L364) uses the same pattern.

## Verification Plan

### Automated Tests

No automated tests required. This is a CSS-only visual fix with no logic change. The test suite will be run separately by the user.

### Manual Verification

1. Open Planning → Tickets, load tickets so the list pane is populated.
2. Click the `«` toggle to collapse the sidebar → confirm a `»` expand icon is clearly visible (centered) and "Link all" is hidden.
3. Click `»` → confirm the sidebar expands and the extra buttons reappear.
4. **Precondition: `Import all to kanban` visible.** Select a ClickUp list or Linear project so that `#tickets-import-all-kanban` is shown (JS sets `style.display = ''`). Click `«` to collapse → confirm `»` is visible and "Import all to kanban" is hidden (the `!important` overrides the inline style). Click `»` → confirm "Import all to kanban" reappears.
5. Repeat after switching tabs and returning to Tickets (collapse state persists via `ticketsPreviewCollapsed`) → confirm the expand icon shows on load when starting collapsed.
6. Confirm the other tabs (Docs, Kanban) are unaffected — their `.sidebar-folders-btn` controls hide/show as before.

## Recommendation

Complexity is 2 → **Send to Intern**.
