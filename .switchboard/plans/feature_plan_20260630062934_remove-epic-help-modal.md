# Remove Redundant "How to Run an Epic" Help Modal from Project Epics Tab

## Goal

Remove the "?" help button (`#btn-epic-modes-help`) and its associated modal ("How to Run an Epic (2 Ways)") from the Epics tab in `project.html`, along with the JS event handlers in `project.js`. The modal content merely restates standard kanban drag operation and adds UI clutter without value.

### Problem
The Epics tab in `project.html` has a "?" help button (`#btn-epic-modes-help`) that opens a modal titled "How to Run an Epic (2 Ways)". The modal content simply describes normal kanban board operation (dragging epic cards column-to-column). The user considers this completely redundant — it describes the standard kanban workflow that is already self-evident from the board UI, not a special epic-specific process.

### Root Cause
The help button and modal were added as an explainer for epic execution modes, but the content is a restatement of basic kanban drag operation. It adds UI clutter without providing value. The button title even says "3 ways" while the modal says "2 Ways" — an existing inconsistency that further confirms this is not worth maintaining.

## Metadata
- **Tags:** [ui, refactor]
- **Complexity:** 1

## User Review Required
No — this is a pure deletion of redundant UI elements with no behavioral or backend impact. The user explicitly requested removal.

## Complexity Audit

### Routine
- Delete a single `<button>` element from `project.html` (line 1507)
- Delete a single modal `<div>` block from `project.html` (lines 1664-1678, including comment)
- Delete three `addEventListener` blocks + comment from `project.js` (lines 2259-2270)
- All CSS classes used by the modal (`.kanban-log-overlay`, `.kanban-log-modal`, `.kanban-log-close`, `.strip-btn`) are shared with other modals/buttons and must NOT be removed
- No backend changes, no settings, no message types

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the modal is purely client-side with no async operations or shared state.
- **Security:** None — no credentials, no data exposure, no input handling.
- **Side Effects:** None — the optional chaining (`?.`) on the event listeners means any missed line would silently no-op rather than crash. However, completeness is still required for clean code.
- **Dependencies & Conflicts:**
  1. **Shared CSS classes**: The modal uses `.kanban-log-overlay`, `.kanban-log-modal`, `.kanban-log-close`, and `.strip-btn` — all shared with other modals/buttons in `project.html`. Only the HTML elements and JS event handlers specific to this modal should be removed. No CSS rules should be deleted.
  2. **Cross-references**: The `#btn-epic-modes-help` button is referenced only in `project.html` (HTML) and `project.js` (JS event handlers). No other files reference these element IDs. Verified via grep — 8 total matches across 2 files, all to be removed.
  3. **Historical plan references**: Old plan files in `.switchboard/plans/` may reference this modal, but those are historical artifacts and do not affect runtime behavior.
  4. **No backend dependency**: The modal is purely client-side — no message types, no backend handlers, no settings.

## Dependencies
- None — this plan is fully self-contained.

## Adversarial Synthesis

Key risks: incorrect line numbers could cause deletion of the wrong elements (the New Epic button or Add Subtask overlay). Mitigations: line numbers have been corrected to match the actual source (button at line 1507, modal at lines 1664-1678, JS at lines 2259-2270). The optional chaining on event listeners provides a safety net — any missed line silently no-ops rather than crashing. Post-deletion grep verification confirms zero remaining references.

## Proposed Changes

### 1. `src/webview/project.html` — Remove help button

**Delete line 1507** — the `?` help button in the Epics tab controls strip:

```html
<!-- DELETE THIS LINE -->
<button id="btn-epic-modes-help" class="strip-btn" title="How to run an epic (3 ways)" style="font-weight: bold; min-width: 28px; padding: 2px 8px;">?</button>
```

### 2. `src/webview/project.html` — Remove modal markup

**Delete lines 1664-1678** — the comment line and the entire `#epic-modes-help-overlay` modal:

```html
<!-- DELETE THIS ENTIRE BLOCK (lines 1664-1678) -->
    <!-- Epic Modes Help Modal -->
    <div id="epic-modes-help-overlay" class="kanban-log-overlay" style="display: none;">
        <div class="kanban-log-modal" style="width: 480px; max-width: 90vw;">
            <div style="padding: 12px 16px; font-weight: bold; border-bottom: 1px solid var(--border-color);">
                How to Run an Epic (2 Ways)
            </div>
            <div style="padding: 16px; line-height: 1.6; font-size: 12px;">
                <div style="margin-bottom: 10px;"><b>Step</b> — drag the epic column-to-column on the board; each column's agent batch-processes every subtask.</div>
                <div><b>Split (recommended)</b> — drag the epic to the <b>Planner</b> column to improve every subtask plan, <i>then</i> dispatch the improved epic to a coder column to implement.</div>
            </div>
            <div class="kanban-log-close" style="display: flex; justify-content: flex-end; padding: 12px 16px;">
                <button id="btn-epic-modes-help-close" class="strip-btn">Close</button>
            </div>
        </div>
    </div>
```

### 3. `src/webview/project.js` — Remove event handlers

**Delete lines 2259-2270** — the comment and all three event listeners for the help modal:

```javascript
// DELETE THIS ENTIRE BLOCK (lines 2259-2270)
    // ---- Epic modes help modal ----
    document.getElementById('btn-epic-modes-help')?.addEventListener('click', () => {
        const ov = document.getElementById('epic-modes-help-overlay');
        if (ov) ov.style.display = 'flex';
    });
    document.getElementById('btn-epic-modes-help-close')?.addEventListener('click', () => {
        const ov = document.getElementById('epic-modes-help-overlay');
        if (ov) ov.style.display = 'none';
    });
    document.getElementById('epic-modes-help-overlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
```

## Verification Plan

### Automated Tests
- None — this is a pure UI element deletion with no testable logic. No unit/integration/e2e tests apply.

### Manual Verification
1. **Manual test — Epics tab**:
   - Open Project panel, navigate to Epics tab.
   - Confirm the "?" button is gone from the epics controls strip.
   - Confirm the "+ New Epic" button and other controls remain and function normally.
2. **Manual test — no broken references**:
   - Open browser devtools console — confirm no errors about missing `#btn-epic-modes-help` or `#epic-modes-help-overlay` elements.
3. **Manual test — other modals intact**:
   - Confirm other modals using `.kanban-log-overlay` / `.kanban-log-modal` classes still work (e.g. log viewer, constitution paths modal, New Epic modal, Add Subtask overlay).
4. **Grep verification**:
   - Search `project.html` and `project.js` for `epic-modes-help` — confirm zero matches remain.

## Recommendation

Complexity 1/10 → **Send to Intern**
