# Fix Excessive Icon Spacing in Kanban Column Headers

## Goal

Fix visually excessive horizontal spacing between icon buttons in kanban column headers, restoring compact visual density.

**Problem & Root Cause:** In `kanban.html`, icon buttons inside column headers have excessive horizontal spacing in two cases: (1) the "New" column's `+` and import-clipboard buttons are 8px apart due to an oversized flex gap, and (2) reviewed columns' complexity-routing and mode-toggle buttons are ~12px apart due to redundant element margins compounding with the flex container's 4px gap (`margin-right: 4px` + `gap: 4px` + `margin-left: 4px` = 12px, triple the intended spacing). Both issues hurt visual density and make header controls look disconnected.

## Metadata

**Tags:** frontend, ui, bugfix
**Complexity:** 2

## User Review Required

- Confirm that 4px gap is the desired spacing for the created-column button pair (currently 8px). The value was chosen to match the non-created column gap for consistency.

## Complexity Audit

### Routine
- Change inline `gap: 8px` → `gap: 4px` on one flex container
- Remove `margin-left: 4px` from `.mode-toggle` CSS rule
- Remove `margin-right: 4px` from `.complexity-routing-btn` CSS rule

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — purely CSS/inline-style changes, no async logic.
- **Security:** No impact.
- **Side Effects:** Removing margins from `.mode-toggle` and `.complexity-routing-btn` assumes they are always rendered inside a flex container with `gap`. Verified: both classes are only used in the `rightSide` template within kanban column headers (lines 4309, 4315), always inside a flex container. The `implementation.html` `#btn-mode-toggle` uses different CSS classes (`icon-btn mode-active`), so no conflict.
- **Dependencies & Conflicts:** Existing regression test `test/kanban-coded-auto-prompt-mode-regression.test.js` references `.mode-toggle` querySelectorAll patterns — this test checks JS behavior, not CSS properties, so margin removal won't affect it.

## Dependencies

None

## Adversarial Synthesis

Key risks: margin removal assumes buttons always render inside flex-gap containers (no fallback spacing if used elsewhere); 4px gap value for created column not visually verified. Mitigations: both CSS classes are kanban-header-specific and always rendered in the `rightSide` flex container; 4px matches existing non-created column gap for visual consistency across all headers.

## Proposed Changes

### `src/webview/kanban.html`

#### Change 1: Tighten gap in created-column header (line 4326)

- **Context:** The `rightSide` template for `isCreated` columns uses an inline flex container with `gap: 8px` between the `+` button and import-clipboard button.
- **Logic:** Reduce the gap from 8px to 4px to match the non-created column spacing and restore compact density.
- **Implementation:**

  ```html
  <!-- Before (line 4326) -->
  <div style="display: flex; align-items: center; gap: 8px; line-height: 1;">

  <!-- After -->
  <div style="display: flex; align-items: center; gap: 4px; line-height: 1;">
  ```

- **Edge Cases:** The `+` and import-clipboard buttons are both 28×28px icon buttons — same visual weight as the toggle pair in non-created columns, so 4px gap is consistent.

#### Change 2: Remove `margin-left: 4px` from `.mode-toggle` (line 1155)

- **Context:** The `.mode-toggle` CSS rule declares `margin-left: 4px`, which compounds with the parent flex container's `gap: 4px` to create excessive spacing.
- **Logic:** The flex container's `gap` property already manages inter-element spacing. The element-level margin is redundant and causes the compounding bug.
- **Implementation:** Remove `margin-left: 4px;` from the `.mode-toggle` rule at line 1155.

  ```css
  /* Before */
  .mode-toggle {
      ...
      margin-left: 4px;
  }

  /* After */
  .mode-toggle {
      ...
      /* margin-left removed — flex gap handles spacing */
  }
  ```

- **Edge Cases:** `.mode-toggle` is only used inside the `rightSide` flex container in kanban column headers (line 4309). No other usage exists in the codebase under this CSS class.

#### Change 3: Remove `margin-right: 4px` from `.complexity-routing-btn` (line 1190)

- **Context:** The `.complexity-routing-btn` CSS rule declares `margin-right: 4px`, which compounds with the parent flex container's `gap: 4px`.
- **Logic:** Same as Change 2 — the flex gap already provides spacing; the margin is redundant.
- **Implementation:** Remove `margin-right: 4px;` from the `.complexity-routing-btn` rule at line 1190.

  ```css
  /* Before */
  .complexity-routing-btn {
      ...
      margin-right: 4px;
  }

  /* After */
  .complexity-routing-btn {
      ...
      /* margin-right removed — flex gap handles spacing */
  }
  ```

- **Edge Cases:** `.complexity-routing-btn` is only used inside the `rightSide` flex container (line 4315). No other usage exists.

## Verification Plan

### Automated Tests
- Existing test `test/kanban-coded-auto-prompt-mode-regression.test.js` should still pass (it checks JS querySelectorAll patterns, not CSS properties).
- No new automated tests needed — this is a purely visual CSS fix.

### Manual Verification
1. Open the Switchboard Kanban webview.
2. Verify the **New** column: the `+` and import-clipboard icons sit ~4px apart (reduced from 8px).
3. Verify the **Planned** (reviewed) column: the complexity-routing and mode-toggle icons sit ~4px apart (reduced from ~12px).
4. Spot-check other non-created columns (e.g., Coded, Testing) to confirm the mode-toggle still renders correctly without extra left margin.
5. Confirm no visual regression in the overall `.column-header` layout (left label and right controls still align to edges via `justify-content: space-between`).
6. Verify the mode-toggle click handler still works (toggles between prompt/CLI mode).

---

**Recommendation:** Complexity 2 → **Send to Intern**

## Reviewer Pass — Completed

**Date:** 2026-06-07
**Result:** ✅ PASS — All changes implemented correctly, no fixes needed.

### Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `gap: 8px` → `gap: 4px` on created-column flex container (line 4324) | — | ✅ Verified |
| 2 | `margin-left: 4px` removed from `.mode-toggle` (lines 1144-1155) | — | ✅ Verified |
| 3 | `margin-right: 4px` removed from `.complexity-routing-btn` (lines 1178-1189) | — | ✅ Verified |

### Files Changed
- `src/webview/kanban.html` — 3 CSS/inline-style edits (gap reduction, margin removals)

### Validation Results
- No CRITICAL or MAJOR findings.
- No code fixes applied — implementation matches plan exactly.
- Visual-only change; manual verification per plan checklist recommended.

### Remaining Risks
- None beyond those documented in the plan's Adversarial Synthesis (margin removal assumes flex-gap context, which holds for all known usages).
