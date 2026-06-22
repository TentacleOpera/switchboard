# Show an Expand Icon When the Tickets Tab Sidebar Is Collapsed

## Goal

In the Tickets tab of `planning.html`, collapsing the sidebar leaves no visible icon to expand it again. The expand toggle (»») must remain visible when the sidebar is collapsed, matching the other tabs.

### Problem Analysis

The collapse mechanism works by toggling `.collapsed` on the tab's `.content-row`, which hides all direct children of the list pane except `.sidebar-toggle-row` ([planning.html:295-300](src/webview/planning.html#L295)), then re-centers the toggle row ([357-362](src/webview/planning.html#L357)). The toggle button text flips `«` ⇄ `»` in `applySidebarState()` ([planning.js:626-636](src/webview/planning.js#L626)).

For most tabs the `.sidebar-toggle-row` contains only the collapse button (plus a `.sidebar-folders-btn` that is explicitly hidden when collapsed via [364-366](src/webview/planning.html#L364)). But the **Tickets** toggle row also contains two always-visible `.strip-btn` buttons — `#tickets-link-all` and `#tickets-import-all-kanban` ([planning.html:3358-3362](src/webview/planning.html#L3358)):

```html
<div class="sidebar-toggle-row">
  <button id="tickets-link-all" class="strip-btn" ...>Link all</button>
  <button id="tickets-import-all-kanban" class="strip-btn" ...>Import all to kanban</button>
  <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
</div>
```

When collapsed, `#tree-pane-tickets` gets `padding:4px; overflow:hidden` ([288-293](src/webview/planning.html#L288)) and shrinks to a narrow strip. The toggle row uses `justify-content: flex-end`, so the two `.strip-btn` buttons (which are NOT `.sidebar-folders-btn` and therefore are NOT hidden when collapsed) sit before the `»` button and push it past the narrow pane's right edge, where `overflow:hidden` clips it off-screen. Result: no visible expand icon.

### Root Cause

`#tickets-link-all` and `#tickets-import-all-kanban` stay visible inside the collapsed toggle row and shove the expand button out of the clipped, narrow collapsed pane. Other tabs avoid this because their extra control is a `.sidebar-folders-btn`, which IS hidden when collapsed.

## Metadata

**Complexity:** 2
**Tags:** frontend, css, tickets, ux

## Complexity Audit

### Routine
- Hiding the two extra strip buttons when the tickets sidebar is collapsed (CSS), so only the expand toggle remains — exactly how `.sidebar-folders-btn` is handled.

### Complex / Risky
- None. CSS-only; no JS state changes. Must ensure the `»` is centered/visible after the extras are hidden.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** "Link all" and "Import all to kanban" become unavailable while collapsed — acceptable and consistent with other tabs hiding their extra controls when collapsed. They reappear on expand.
- **Dependencies & Conflicts:** Coordinate with the Source-modal/one-line-controls plan if it relocates toolbar buttons, but this fix targets the list-pane toggle row specifically and is independent.

## Proposed Changes

### 1. `src/webview/planning.html` — hide the extra toggle-row buttons when collapsed
Add a rule alongside the existing collapsed-folders rule ([364-366](src/webview/planning.html#L364)):
```css
.content-row.collapsed #tickets-link-all,
.content-row.collapsed #tickets-import-all-kanban {
    display: none !important;
}
```
This leaves only the `.sidebar-toggle-btn` in the collapsed (centered) toggle row, so the `»` expand icon is visible and clickable.

> Alternative (more general): give `#tickets-link-all` and `#tickets-import-all-kanban` the `sidebar-folders-btn` class so they inherit the existing collapse-hide behavior — but that also changes their styling, so the targeted rule above is safer.

## Verification Plan

1. Build; open Planning → Tickets, load tickets so the list pane is populated.
2. Click the `«` toggle to collapse the sidebar → confirm a `»` expand icon is clearly visible (centered) and "Link all"/"Import all" are hidden.
3. Click `»` → confirm the sidebar expands and the extra buttons reappear.
4. Repeat after switching tabs and returning to Tickets (collapse state persists via `ticketsPreviewCollapsed`) → confirm the expand icon shows on load when starting collapsed.
5. Confirm the other tabs (Docs, Online, Kanban) are unaffected.
