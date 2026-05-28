# Fix Kanban Copy Link Button Always Visible

## Goal
The "Copy Link" button in the kanban plans tab currently only appears on hover. It should always be visible to improve discoverability and usability.

## Metadata
- **Tags:** [frontend, UI, CSS]
- **Complexity:** 1

## Current State
The `.kanban-plan-copy-link` button in `src/webview/planning.html` has:
- `opacity: 0` by default (line 1404)
- Only becomes visible on parent hover or focus-visible (lines 1409-1411)

This makes the button hidden until the user hovers over the plan card, which reduces discoverability.

## Proposed Changes

### `src/webview/planning.html` — CSS modification

**Context:** The copy link button styles are at lines 1395-1412.

**Logic:**
- Remove `opacity: 0` from the base `.kanban-plan-copy-link` rule
- Remove the hover-based visibility rule entirely

**Implementation:**

At line 1404, remove `opacity: 0;` from the `.kanban-plan-copy-link` rule:

```css
.kanban-plan-copy-link {
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: var(--font-family);
    padding: 2px 7px;
    cursor: pointer;
    border-radius: 10px;
    /* opacity: 0;  REMOVE THIS LINE */
    transition: all 0.15s;
    margin-left: auto;
    white-space: nowrap;
}
```

Remove lines 1409-1411 entirely:
```css
/* REMOVE THIS BLOCK */
.kanban-plan-item:hover .kanban-plan-copy-link,
.kanban-plan-copy-link:focus-visible {
    opacity: 1;
}
```

**Result:** The button will always be visible with its default styling, and the hover state (line 1413) will still provide visual feedback when the user hovers over the button itself.

## Verification Plan

### Manual Verification
1. Open the planning panel and navigate to the Kanban Plans tab
2. Verify that plan cards display in the left sidebar
3. Verify the "Copy Link" button is visible on plan cards WITHOUT hovering
4. Hover over the button — verify it shows the hover state (background color change)
5. Click the button — verify it still copies the plan file path correctly
6. Verify the button styling remains consistent with the rest of the UI

---

**Recommendation:** Complexity 1 → Send to Intern
