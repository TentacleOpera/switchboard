# Kanban Controls Strip: Reorder Toggle Icons to Right Group

## Goal
Reorganize the icon row in the Kanban view (`controls-strip`) so that the two toggle buttons — **CLI Triggers** and **Collapsed Coders** — are visually separated from the other action icons and placed on the right, immediately to the left of the **Pair Programming** dropdown.

## Background / Problem
In `src/webview/kanban.html:2319-2358`, the `.controls-strip` currently lays out all icons in a single left group, followed by a flex spacer, then the Pair Programming dropdown on the far right:

1. `workspace-project-select`
2. `btn-assign-workspace-project` (ASSIGN)
3. `btn-add-project` (+)
4. `btn-delete-project`
5. `btn-import-plans`
6. `btn-chat-copy-prompt`
7. **`btn-cli-triggers`** ← toggle
8. **`btn-collapse-coders`** ← toggle
9. `btn-autoban`
10. `<div style="flex: 1;">` (spacer)
11. `pairProgrammingModeSelect` (dropdown)

The two toggles are visually indistinguishable from action buttons and are lost in the middle of the strip. Grouping them with the Pair Programming dropdown on the right makes their purpose (view/automation state) clearer.

## Metadata

**Tags:** ui, ux, frontend
**Complexity:** 2

---

## User Review Required

None. This is a pure visual reorder with no functional changes.

---

## Complexity Audit

### Routine
- Moving two `<button>` elements within a flexbox container (pure HTML reorder)
- No CSS, JS, ID, class, or event handler changes

### Complex / Risky
- None

---

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static HTML change.
- **Security:** None.
- **Side Effects:** None. All JavaScript references to these buttons use `getElementById` or `querySelector` with unique IDs (`btn-cli-triggers`, `btn-collapse-coders`), not positional DOM indexing. The reorder is safe.
- **Dependencies & Conflicts:** None. This change is independent of all other plans.

---

## Dependencies

None.

---

## Adversarial Synthesis

Key risks: None. This is a trivial HTML reorder within a flex container. All button references use unique IDs, not positional indexing. The flex spacer already handles the right-alignment. No functional, security, or state concerns.

---

## Requirements
- Move `btn-cli-triggers` and `btn-collapse-coders` so they sit **after** the flex spacer and **before** the `pairProgrammingModeSelect` dropdown.
- Do not change any button IDs, classes, tooltips, or event handlers.
- No CSS changes are required; the existing flexbox layout handles the new ordering.

## Desired Layout
1. `workspace-project-select`
2. `btn-assign-workspace-project`
3. `btn-add-project`
4. `btn-delete-project`
5. `btn-import-plans`
6. `btn-chat-copy-prompt`
7. `btn-autoban`
8. `<div style="flex: 1;">` (spacer)
9. **`btn-cli-triggers`**
10. **`btn-collapse-coders`**
11. `pairProgrammingModeSelect`

## Proposed Changes

### `src/webview/kanban.html`
- **Context:** Lines 2333–2347 (controls-strip button area)
- **Logic:**
  1. Cut the `<button>` element for `btn-cli-triggers` (lines 2333–2335)
  2. Cut the `<button>` element for `btn-collapse-coders` (lines 2336–2338)
  3. Paste both buttons after the spacer `<div style="flex: 1;"></div>` (line 2344) and before the `pairProgrammingModeSelect` dropdown (line 2347)
- **Implementation:** The resulting HTML order should be:
  ```html
  <button class="strip-icon-btn" id="btn-autoban" data-tooltip="Start or stop the automation engine">
      <img src="{{ICON_22}}" alt="Start Automation">
  </button>

  <!-- Spacer to push right-side controls to the right -->
  <div style="flex: 1;"></div>

  <!-- Right Side: Automation and view controls -->
  <button class="strip-icon-btn" id="btn-cli-triggers" data-tooltip="Toggle CLI triggers on/off">
      <img src="{{ICON_CLI}}" alt="CLI Triggers">
  </button>
  <button class="strip-icon-btn is-off" id="btn-collapse-coders" data-tooltip="Toggle collapsed coder columns view">
      <img src="{{ICON_COLLAPSE_CODERS}}" alt="Collapse Coders">
  </button>
  <select id="pairProgrammingModeSelect" ...>
  ```
- **Edge Cases:** The `is-off` class on `btn-collapse-coders` must be preserved. No other attributes change.

---

## Verification Plan

### Automated Tests
- No automated tests needed for a pure HTML reorder.

### Manual Verification
1. Open the Kanban view in the VS Code extension webview.
2. Confirm the icon order matches the Desired Layout above.
3. Confirm the Pair Programming dropdown remains right-aligned.
4. Confirm both toggles still function correctly (state toggles, tooltips appear).
5. Confirm the CLI Triggers toggle still reflects the correct on/off state.
6. Confirm the Collapse Coders toggle still collapses/expands coder columns.

---

## Risks
- **Negligible.** Pure HTML reordering within an existing flex container. No IDs, classes, or JS references change.

---

## Review Findings

**Reviewer:** In-place review pass (2026-06-07)

### Stage 1 Findings (Grumpy)

| # | Severity | Finding |
|---|----------|---------|
| 1 | PASS | Button reorder matches plan exactly: `btn-autoban` → spacer → `btn-cli-triggers` → `btn-collapse-coders` → `pairProgrammingModeSelect` |
| 2 | PASS | `is-off` class preserved on `btn-collapse-coders` (line 2344) |
| 3 | PASS | No IDs, classes, tooltips, or event handlers changed. All JS references use `getElementById` |
| 4 | NIT | "Right Side: Automation and view controls" comment slightly misleading — `btn-autoban` is also automation but sits left of spacer |
| 5 | NIT | Plan line numbers reference pre-implementation state — stale but not a code issue |

### Stage 2 Synthesis

No code fixes needed. All NITs are cosmetic/structural and not worth the churn.

### Files Changed

None.

### Validation Results

- No typecheck needed (pure HTML change, no TS files touched).
- No automated tests run (per SKIP TESTS directive).

### Remaining Risks

None beyond the negligible risk already documented in the plan.

---

**Recommendation:** Complexity 2 → Send to Intern
