# Fix: Reduce Sidebar Width for project.html Governance Tabs

## Goal

The sidebar width for the Projects, Constitution, System, and Tuning tabs in `project.html` is unnecessarily large (320px — the same as the Kanban Plans and Epics tabs). These governance tabs display simple document lists, not complex plan/epic cards, so they don't need as much horizontal space. Reduce their sidebar width to ~240px to give more room to the preview pane.

### Problem Analysis & Root Cause

**Current state:** In `src/webview/project.html` at lines 203-211, a single CSS rule sets the width for ALL six tab sidebars to 320px:

```css
#kanban-list-pane, #epics-list-pane, #constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel-bg);
}
```

**The problem:** The Kanban Plans and Epics tabs display rich cards with plan titles, descriptions, complexity scores, tags, and action buttons — they genuinely need 320px. But the Projects, Constitution, System, and Tuning tabs display simple document name lists (e.g., "CONSTITUTION.md", "CLAUDE.md", "prd.md") that fit comfortably in 240px. The excessive sidebar width steals horizontal space from the markdown preview pane, making documents harder to read.

**Root cause:** When the governance tabs were added, they were lumped into the same CSS rule as the kanban/epics sidebars for convenience, without considering that their content is fundamentally simpler and doesn't need the same width.

## Metadata
- **Tags:** frontend, css, ui, project-html, sidebar
- **Complexity:** 2

## Complexity Audit

### Routine
- Splitting a CSS selector into two groups with different widths
- Updating collapsed-state CSS rules to match
- Visual verification

### Complex / Risky
- None. This is a pure CSS width change with no logic impact.

## Edge-Case & Dependency Audit

- **Collapsed sidebar state:** Lines 509-514 and 519-524 have collapsed-state CSS rules that reference the same selectors. These need to be updated to match the split.
- **Responsive behavior:** The sidebar uses `flex-shrink: 0` so it won't shrink below its set width. Reducing to 240px is safe.
- **Sidebar toggle button:** The toggle button position is relative to the sidebar; it will automatically adjust.
- **No dependencies on other files** — this is entirely within `project.html`'s inline CSS.

## Proposed Changes

### 1. Split the sidebar width CSS rule

**File:** `src/webview/project.html` (lines 203-211)

Replace the single rule with two:

```css
/* Kanban & Epics — wider for complex plan/epic cards */
#kanban-list-pane, #epics-list-pane {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel-bg);
}

/* Projects, Constitution, System, Tuning — narrower for simple doc lists */
#constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel-bg);
}
```

### 2. Update collapsed-state CSS rules

**File:** `src/webview/project.html` (lines 509-514 and 519-524)

Find any collapsed-state rules that reference the same selectors and split them similarly. For example, if there is:

```css
#kanban-list-pane.collapsed, #epics-list-pane.collapsed, #constitution-list-pane.collapsed, #system-list-pane.collapsed, #tuning-list-pane.collapsed, #projects-list-pane.collapsed {
    width: 0px;
    /* ... */
}
```

This can remain as a single rule since the collapsed width is the same (0px) for all tabs. Verify that no collapsed rule sets a different non-zero width that needs splitting.

### 3. If architect tab is added

If the architect tab (from the architect agent plan) is implemented, add `#architect-list-pane` to the narrower sidebar group:

```css
#constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane, #architect-list-pane {
    width: 240px;
    /* ... */
}
```

## Verification Plan

1. **Visual check — Kanban Plans tab:** Open project.html → Kanban Plans tab → verify sidebar is still 320px (unchanged).
2. **Visual check — Epics tab:** Switch to Epics tab → verify sidebar is still 320px (unchanged).
3. **Visual check — Projects tab:** Switch to Projects tab → verify sidebar is 240px (narrower) and the preview pane has more room.
4. **Visual check — Constitution tab:** Switch to Constitution tab → verify sidebar is 240px.
5. **Visual check — System tab:** Switch to System tab → verify sidebar is 240px.
6. **Visual check — Tuning tab:** Switch to Tuning tab → verify sidebar is 240px.
7. **Sidebar toggle:** Click the sidebar toggle button on each tab → verify collapse/expand works correctly for both width groups.
8. **Document list fits:** Verify all document names in the governance tab sidebars are fully visible at 240px (no truncation).
