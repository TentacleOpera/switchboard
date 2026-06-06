# Unify Planning Panel Sidebar Widths with Flex 1:3 Layout

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui

## Goal

Convert all five tab layouts to a unified **flexbox 1:3 ratio** (sidebar : content). This gives every sidebar the *same proportional width* — wider than the old 280px on most screens, narrower than the old Kanban 33% — a consistent "happy medium" across all tabs.

### Problem

The planning panel (`planning.html`) uses two different sidebar layout models:

- **Local Docs, Online Docs, Design System, HTML Previews**: Use `display: grid` with a fixed `280px` sidebar (`grid-template-columns: 280px 1fr`). On modern screens this feels cramped.
- **Kanban Plans**: Uses `display: flex` with `flex: 1` / `flex: 2`, giving the sidebar roughly 33% of the viewport. On large monitors this is unnecessarily wide.

This inconsistency means sidebars are never the same width and the user experience jumps between tabs.

### Root Cause Analysis

- `.content-row` is hard-coded to `grid-template-columns: 280px 1fr`.
- `#kanban-content-row` independently uses `display: flex` with `flex: 1` / `flex: 2`.
- There is no shared layout primitive; each tab grew its own rules.

## User Review Required

None. Pure CSS/layout change with no behavioural modifications.

## Complexity Audit

### Routine
- Convert `.content-row` from `display: grid` to `display: flex` with child flex ratios.
- Update `.content-row.collapsed` to use flex-basis child selectors.
- Change `.preview-panel-wrapper` base rule from `flex: 2` to `flex: 3`.
- Remove redundant inline `style="flex: 2;"` attributes from all four `.preview-panel-wrapper` divs.
- Add flex-compatible transition to preserve collapse animation.

### Complex / Risky
- None (single file, localized CSS; all layout changes are well-scoped).

## Edge-Case & Dependency Audit

**Race Conditions:** None — CSS only.

**Security:** No security implications.

**Side Effects:**
- Visual width of sidebars will change on all five tabs.
- The Kanban tab's `.kanban-preview-pane { flex: 2 }` rule at line 1687 is dead code (overridden by inline `style="flex: 1;"` on the same element). The original plan incorrectly targeted this selector; the improved plan corrects the ratio by updating the `.preview-panel-wrapper` base rule instead.
- The collapse transition animation will change from a grid-column animation to a flex animation; `transition: flex 0.2s ease` on children preserves smooth behaviour.

**Dependencies & Conflicts:**
- No active plans touching `src/webview/planning.html` layout CSS.
- Complements any plan that adds new tabs using `.content-row`, which will automatically inherit the unified ratio.

## Dependencies

None.

## Adversarial Synthesis

Key risks: The original plan missed that `.kanban-preview-pane { flex: 2 }` is dead CSS (overridden by inline `flex: 1`), and that ALL four inline `style="flex: 2;"` attributes must be removed — not just the Design System one — or the new `.content-row > :last-child { flex: 3 }` rule will be overridden. Mitigations: Target the `.preview-panel-wrapper` base rule for the Kanban ratio change, strip inline styles from all four tabs, and use `!important` on collapsed child selectors to guarantee collapse behaviour across all tabs including Kanban.

## Proposed Changes

### `src/webview/planning.html`

- **Context:** Embedded CSS and HTML for the Planning Panel webview. `.content-row` is the shared layout container for Local Docs, Online Docs, Design System, HTML Previews, and Kanban tabs.
- **Logic:** Unify all sidebar layouts under a single flexbox primitive with 1:3 ratio. Replace the grid model with flex on `.content-row`, adjust the Kanban ratio by updating the `.preview-panel-wrapper` base rule, strip redundant inline styles, and preserve the collapse transition.
- **Implementation:**

  1. **Convert `.content-row` from Grid to Flexbox** (around line 284)
     - Replace:
       ```css
       .content-row {
           display: grid;
           grid-template-columns: 280px 1fr;
           flex: 1;
           overflow: hidden;
           transition: grid-template-columns 0.2s ease;
       }
       ```
       with:
       ```css
       .content-row {
           display: flex;
           flex: 1;
           overflow: hidden;
       }
       .content-row > * {
           transition: flex 0.2s ease;
       }
       .content-row > :first-child {
           flex: 1;
           overflow-y: auto;
       }
       .content-row > :last-child {
           flex: 3;
           overflow-y: auto;
       }
       ```
     - Replace `.content-row.collapsed` (around line 292):
       ```css
       .content-row.collapsed {
           grid-template-columns: 40px 1fr;
       }
       ```
       with:
       ```css
       .content-row.collapsed > :first-child {
           flex: 0 0 40px !important;
       }
       .content-row.collapsed > :last-child {
           flex: 1 !important;
       }
       ```

  2. **Update Kanban ratio via `.preview-panel-wrapper`** (around line 2056)
     - Change `.preview-panel-wrapper` base rule from:
       ```css
       .preview-panel-wrapper {
           position: relative;
           flex: 2;
           height: 100%;
           overflow: hidden;
           display: flex;
           flex-direction: column;
       }
       ```
       to:
       ```css
       .preview-panel-wrapper {
           position: relative;
           flex: 3;
           height: 100%;
           overflow: hidden;
           display: flex;
           flex-direction: column;
       }
       ```
     - **Clarification:** The original Step 2 targeted `.kanban-preview-pane { flex: 2 }` at line 1687, but this rule is dead code — the element has an inline `style="flex: 1;"` that overrides it. The actual flex item in `#kanban-content-row` is `.preview-panel-wrapper`, so updating the base rule is the correct fix.

  3. **Remove ALL conflicting inline `style="flex: 2;"` attributes**
     - Local Docs tab (around line 2304):
       `<div class="preview-panel-wrapper" style="flex: 2;">` → `<div class="preview-panel-wrapper">`
     - Online Docs tab (around line 2347):
       `<div class="preview-panel-wrapper" style="flex: 2;">` → `<div class="preview-panel-wrapper">`
     - Kanban Plans tab (around line 2476):
       `<div class="preview-panel-wrapper" style="flex: 2;">` → `<div class="preview-panel-wrapper">`
     - Design System tab (around line 2514):
       `<div class="preview-panel-wrapper" style="flex: 2;">` → `<div class="preview-panel-wrapper">`

  4. **Preserve Collapse Behaviour**
     - No JavaScript changes are required. The existing `applySidebarState` in `planning.js` (lines 87-134) toggles the `collapsed` class on `.content-row`, which is now handled by the flex-based child selectors above.

  5. **Verify No JS Width Dependencies**
     - Confirmed: `planning.js` does not read or write `element.style.width`, `getComputedStyle` for widths, or hard-coded pixel values for layout math. The sidebar state is purely class-based.

- **Edge Cases:**
  - **Collapsed sidebar**: The `!important` on collapsed child selectors ensures collapse works even for the Kanban tab, where `#kanban-list-pane { flex: 1 }` has higher ID specificity.
  - **Very narrow viewports**: Flexbox with `overflow-y: auto` on both children prevents overflow. Sidebar may become ~200px on small screens; acceptable given it's scrollable.
  - **Cyber theme**: Theme CSS uses selectors like `.cyber-theme-enabled #tree-pane` which only change `background`/`backdrop-filter` and do not affect flex ratios. No changes needed.
  - **Future tabs**: Any new tab using `.content-row` will automatically inherit the unified ratio.
  - **Dynamic DOM rebuilds**: JS functions in `planning.js` (e.g., `renderHtmlDocs` ~line 1086, `renderDesignDocs` ~line 1253, `renderLocalDocs` ~line 1381, `renderOnlineDocs` ~line 1647) clear and rebuild the contents of tree panes but never modify `.content-row` or reorder its children. `:first-child` / `:last-child` selectors remain valid.

## Files Changed

- `src/webview/planning.html` — CSS and four inline HTML style attributes.

## Verification Plan

### Automated Tests
- None required. Pure CSS/layout change with no functional logic.

### Manual Verification Steps
1. Open the planning panel in VS Code.
2. Click through **Local Docs**, **Online Docs**, **Design System**, **HTML Previews**, and **Kanban Plans** tabs.
3. Confirm that in each tab the left sidebar occupies roughly 25% of the panel width (1:3 ratio).
4. Toggle the sidebar collapse button («) in each applicable tab; confirm it collapses to a narrow icon strip and expands back to the 1:3 ratio.
5. Resize the VS Code panel narrower and wider; confirm the ratio stays consistent across tabs.

## Risks

- **Low**: Pure CSS/layout change with no functional logic. Risk is limited to visual regression.
- **Mitigation**: The verification steps above cover all five tabs and both expanded/collapsed states.

## Reviewer Pass

### Stage 1 — Grumpy Findings

**[NIT] Dead CSS at line 1699:** `.kanban-preview-pane { flex: 2; ... }` is dead code — the element carries an inline `style="flex: 1;"` that overrides it. Noted and fixed during review.

**[NIT] `#tree-pane-design` absent from base tree-pane styling rule (line 668):** Pre-existing visual inconsistency — the Design System sidebar does not inherit `background`, `border-right`, or `padding` from the base rule shared by the other three tree panes. Out of scope for this width-unification plan; no functional impact on the 1:3 ratio or collapse behavior.

**[NIT] `#kanban-content-row` retains its own `display: flex` (line 1697):** Harmless redundancy since it also carries class `.content-row`; same computed value, no visual difference.

### Stage 2 — Balanced Synthesis

- **Kept:** The flexbox 1:3 ratio, `!important` on collapsed child selectors, `transition: flex` on children, and all four removed inline `style="flex: 2;"` attributes are correct and complete.
- **Fixed:** Removed dead `flex: 2;` from `.kanban-preview-pane` CSS rule (`src/webview/planning.html:1699`).
- **Deferred:** `#tree-pane-design` missing from base tree-pane rule is a pre-existing visual inconsistency, not introduced by this plan.

### Fixed Items

- `src/webview/planning.html:1699` — Removed dead `flex: 2;` from `.kanban-preview-pane` rule.

### Files Changed (Review)

- `src/webview/planning.html` — CSS only (`line 1699`).

### Validation Results

- No remaining `grid-template-columns` or `280px` references in `planning.html`.
- No inline `style="flex: 2;"` attributes remain on any `.preview-panel-wrapper`.
- All five tabs (`#local-content`, `#online-content`, `#design-content`, `#html-preview-content`, `#kanban-content`) use `.content-row` as the layout container.
- No JavaScript in `planning.js` references `element.style.width`, `getComputedStyle` for widths, or hard-coded pixel values for layout math.
- Compilation skipped per session instructions; tests skipped per session instructions.

### Remaining Risks

- **Low / Pre-existing:** `#tree-pane-design` missing from the base `#tree-pane` styling rule may render the Design System sidebar without the `background`, `border-right`, and `padding` that other tabs have. Does not affect the 1:3 ratio or collapse behavior.
- **None:** The core width-unification change is complete, correct, and low-risk.

**Recommendation:** Send to Coder.
