# Plan: Kanban Tab Control Reorganization

## Goal
Reorganize the kanban.html tab control bars to improve layout and consistency by moving workspace controls to the project strip, reordering elements, applying consistent styling, and left-justifying automation controls.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 4

## User Review Required
- Confirm that workspace badges (`workspace-filter-badge`, `workspace-control-plane-badge`, `workspace-reset-control-plane`) should move to `.project-strip` alongside their parent controls.
- Confirm that `autoban-timers-inline` should follow `btn-autoban` in the left-justified layout (rather than being separated by a spacer).
- Confirm removal of the `controls-spacer` element.

## Complexity Audit

### Routine
- Moving HTML elements between two adjacent flex containers in the same file
- Adding `is-teal` CSS class to two buttons
- Removing "+" prefix from button text
- Removing redundant inline `margin-left:6px` style
- No JavaScript changes required — all JS references use `getElementById` which is DOM-position-agnostic

### Complex / Risky
- Workspace badges and reset button must move with their parent controls or the UX breaks (filter indicator separated from the dropdown that controls it)
- `controls-spacer` removal changes the visual layout model — without it, all controls left-justify; this is the intended effect but must be verified visually

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is static HTML restructuring with no async logic.
- **Security:** No impact — no data flows or auth boundaries affected.
- **Side Effects:** The `autoban-timers-inline` div is dynamically populated by JS at runtime. Moving it within `.controls-strip` is safe (same parent container), but its position relative to `btn-autoban` changes. The JS that populates it (`updateAutobanTimers` or similar) uses `innerHTML` on the element by ID, so DOM position is irrelevant.
- **Dependencies & Conflicts:** The `workspace-select` change handler (line ~5462) and `btn-reassign-workspace` click handler (line ~5430) both use `getElementById` — no breakage from DOM reordering. The `updateWorkspaceFilterBadge` function (line ~3301) references `workspace-filter-badge`, `workspace-control-plane-badge`, and `workspace-reset-control-plane` — all by ID, so moving them to `.project-strip` is safe.

## Dependencies
- None

## Adversarial Synthesis
Key risks: Orphaned workspace badges if moved without their parent controls; `controls-spacer` removal changes layout model. Mitigations: Move all workspace-related elements as a group; remove spacer explicitly and verify visual result.

## Proposed Changes

### `src/webview/kanban.html`

#### Context
The kanban tab content area has two control bars: `.controls-strip` (line 1926) and `.project-strip` (line 1951). Currently, workspace controls sit in `.controls-strip` alongside automation controls, creating a cluttered layout. The goal is to separate workspace/project controls into `.project-strip` and left-justify automation controls in `.controls-strip`.

#### Logic
1. Move all workspace-related elements from `.controls-strip` to `.project-strip`
2. Reorder `.project-strip` elements into a logical sequence
3. Apply consistent teal styling to project action buttons
4. Reorder `.controls-strip` to left-justify automation controls
5. Remove the `controls-spacer` that previously pushed controls right
6. Clean up redundant inline styles

#### Implementation

**Step 1: Restructure `.controls-strip` (lines 1926-1949)**

Current order:
```
1. btn-autoban                    (line 1927)
2. workspace-select               (line 1928)
3. btn-reassign-workspace         (line 1929)
4. workspace-filter-badge         (line 1930)
5. workspace-control-plane-badge  (line 1931)
6. workspace-reset-control-plane  (line 1932)
7. autoban-timers-inline          (line 1933)
8. controls-spacer                (line 1934)
9. cli-toggle                     (line 1935-1941)
10. pairProgrammingModeSelect     (line 1942-1948)
11. btn-collapse-coders           (line 1949)
```

New order (remove items 2-6 and 8; reorder remaining):
```
1. cli-toggle                     (CLI Triggers toggle)
2. pairProgrammingModeSelect      (Pair Programming dropdown)
3. btn-collapse-coders            (COLLAPSE CODERS button)
4. btn-autoban                    (START AUTOMATION button)
5. autoban-timers-inline          (automation timers)
```

- Remove the `<span class="controls-spacer"></span>` element (line 1934) entirely — it's no longer needed with left-justified layout.
- Move `autoban-timers-inline` to immediately after `btn-autoban` (it shows timers for the running automation, so it logically belongs next to the start button).

**Step 2: Restructure `.project-strip` (lines 1951-1958)**

Current order:
```
1. project-select                 (line 1952)
2. btn-add-project                (line 1955)
3. btn-assign-project             (line 1956)
4. btn-delete-project             (line 1957, hidden)
5. project-filter-badge           (line 1958, hidden)
```

New order (insert workspace elements at the beginning):
```
1. workspace-select               (moved from controls-strip)
2. btn-reassign-workspace         (moved from controls-strip; remove inline style="margin-left:6px")
3. workspace-filter-badge         (moved from controls-strip)
4. workspace-control-plane-badge  (moved from controls-strip)
5. workspace-reset-control-plane  (moved from controls-strip)
6. project-select
7. btn-add-project                (add is-teal class; change text from "+ ADD PROJECT" to "ADD PROJECT")
8. btn-assign-project             (add is-teal class)
9. btn-delete-project             (hidden by default)
10. project-filter-badge          (hidden by default)
```

**Step 3: Style changes**

- Add `is-teal` class to `btn-add-project` (currently `class="strip-btn"`)
- Add `is-teal` class to `btn-assign-project` (currently `class="strip-btn"`)
- Remove `style="margin-left:6px"` from `btn-reassign-workspace` — the `.project-strip` already has `gap:10px` which provides spacing
- Change `btn-add-project` text from `+ ADD PROJECT` to `ADD PROJECT`

#### Edge Cases
- `btn-delete-project` is hidden by default (`style="display:none;"`) — it must still be included in the reorder to avoid it being accidentally dropped
- `workspace-filter-badge`, `workspace-control-plane-badge`, and `workspace-reset-control-plane` are all conditionally shown/hidden by JS — their visibility logic is unaffected by DOM position
- `autoban-timers-inline` is dynamically populated — its position change within the same parent container is safe

## Changes Required

### 1. Move Workspace Controls to Project Strip
**File**: `src/webview/kanban.html`

Move the following elements from `.controls-strip` (lines 1928-1932) to `.project-strip` (line 1951):
- `workspace-select` dropdown (line 1928)
- `btn-reassign-workspace` button (line 1929) — also remove `style="margin-left:6px"`
- `workspace-filter-badge` span (line 1930)
- `workspace-control-plane-badge` span (line 1931)
- `workspace-reset-control-plane` button (line 1932)

### 2. Reorder Project Strip Elements
**File**: `src/webview/kanban.html`

Reorder elements in `.project-strip` to this sequence:
1. `workspace-select` dropdown
2. `btn-reassign-workspace` button
3. `workspace-filter-badge` span
4. `workspace-control-plane-badge` span
5. `workspace-reset-control-plane` button
6. `project-select` dropdown
7. `btn-add-project` button
8. `btn-assign-project` button
9. `btn-delete-project` button (hidden)
10. `project-filter-badge` span (hidden)

### 3. Apply Teal Styling to Project Buttons
**File**: `src/webview/kanban.html`

Add `is-teal` class to:
- `btn-add-project` button (line 1955)
- `btn-assign-project` button (line 1956)

### 4. Remove "+" from Add Project Button
**File**: `src/webview/kanban.html`

Change button text from `+ ADD PROJECT` to `ADD PROJECT` (line 1955)

### 5. Reorder Controls Strip — Left-Justify Automation Controls
**File**: `src/webview/kanban.html`

Remove these elements from `.controls-strip`:
- `workspace-select` (moved to project-strip)
- `btn-reassign-workspace` (moved to project-strip)
- `workspace-filter-badge` (moved to project-strip)
- `workspace-control-plane-badge` (moved to project-strip)
- `workspace-reset-control-plane` (moved to project-strip)
- `controls-spacer` (removed entirely — no longer needed)

New order in `.controls-strip`:
1. CLI Triggers toggle (lines 1935-1941)
2. Pair Programming dropdown (lines 1942-1948)
3. COLLAPSE CODERS button (line 1949)
4. START AUTOMATION button (line 1927)
5. `autoban-timers-inline` div (line 1933)

## Expected Result
- Top bar (`.controls-strip`): Left-justified automation controls (CLI triggers, pair programming, collapse coders, start automation, timers)
- Second bar (`.project-strip`): Workspace and project controls in logical order with consistent teal styling
- Improved visual hierarchy and button grouping
- No JavaScript changes required

## Verification Plan

### Automated Tests
- No automated tests needed — this is a pure HTML/CSS restructuring with no logic changes. All JS references use `getElementById` which is DOM-position-agnostic.

### Manual Verification
- Open the kanban webview and confirm:
  1. `.controls-strip` shows: CLI Triggers toggle, Pair Programming dropdown, COLLAPSE CODERS, START AUTOMATION, timers — all left-justified with no spacer
  2. `.project-strip` shows: workspace dropdown, ASSIGN TO WORKSPACE, workspace badges, project dropdown, ADD PROJECT (teal), ASSIGN TO PROJECT (teal) — in that order
  3. Workspace selection still filters the board correctly
  4. ASSIGN TO WORKSPACE button enables/disables based on card selection
  5. Workspace filter badge and control plane badge appear in the project strip when active
  6. RESET AUTO-DETECT button appears in the project strip when applicable
  7. START AUTOMATION toggles correctly and timers display next to it
  8. CLI Triggers toggle and Pair Programming dropdown function correctly
  9. COLLAPSE CODERS button toggles coder columns
  10. ADD PROJECT button is teal and shows "ADD PROJECT" (no "+" prefix)
  11. ASSIGN TO PROJECT button is teal

## Recommendation
Complexity 4 → **Send to Coder**
