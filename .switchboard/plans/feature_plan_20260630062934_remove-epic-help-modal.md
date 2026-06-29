# Remove Redundant "How to Run an Epic" Help Modal from Project Epics Tab

## Goal

### Problem
The Epics tab in `project.html` has a "?" help button (`#btn-epic-modes-help`) that opens a modal titled "How to Run an Epic (2 Ways)". The modal content simply describes normal kanban board operation (dragging epic cards column-to-column). The user considers this completely redundant — it describes the standard kanban workflow that is already self-evident from the board UI, not a special epic-specific process.

### Root Cause
The help button and modal were added as an explainer for epic execution modes, but the content is a restatement of basic kanban drag operation. It adds UI clutter without providing value. The button title even says "3 ways" while the modal says "2 Ways" — an existing inconsistency that further confirms this is not worth maintaining.

## Metadata
- **Tags**: `project`, `epics`, `ui-cleanup`, `redundant`, `modal`
- **Complexity**: 1/10

## Complexity Audit

**Routine** — Pure deletion of self-contained UI elements. No logic changes, no dependencies on other features. All CSS classes used by the modal (`.kanban-log-overlay`, `.kanban-log-modal`, `.kanban-log-close`, `.strip-btn`) are shared with other modals and must NOT be removed.

## Edge-Case & Dependency Audit

1. **Shared CSS classes**: The modal uses `.kanban-log-overlay`, `.kanban-log-modal`, `.kanban-log-close`, and `.strip-btn` — all shared with other modals/buttons in `project.html`. Only the HTML elements and JS event handlers specific to this modal should be removed. No CSS rules should be deleted.
2. **Cross-references**: The `#btn-epic-modes-help` button is referenced only in `project.html` (HTML) and `project.js` (JS event handlers). No other files reference these element IDs.
3. **Historical plan references**: Old plan files in `.switchboard/plans/` reference this modal, but those are historical artifacts and do not affect runtime behavior.
4. **No backend dependency**: The modal is purely client-side — no message types, no backend handlers, no settings.

## Proposed Changes

### 1. `src/webview/project.html` — Remove help button

**Delete line 1506** — the `?` help button in the Epics tab controls strip:

```html
<!-- DELETE THIS LINE -->
<button id="btn-epic-modes-help" class="strip-btn" title="How to run an epic (3 ways)" style="font-weight: bold; min-width: 28px; padding: 2px 8px;">?</button>
```

### 2. `src/webview/project.html` — Remove modal markup

**Delete lines 1663-1677** — the entire `#epic-modes-help-overlay` modal:

```html
<!-- DELETE THIS ENTIRE BLOCK -->
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

**Delete lines 2225-2236** — all three event listeners for the help modal:

```javascript
// DELETE THIS ENTIRE BLOCK
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

1. **Build**: `npm run compile` — confirm no errors.
2. **Manual test — Epics tab**:
   - Open Project panel, navigate to Epics tab.
   - Confirm the "?" button is gone from the epics controls strip.
   - Confirm the "+ New Epic" button and other controls remain and function normally.
3. **Manual test — no broken references**:
   - Open browser devtools console — confirm no errors about missing `#btn-epic-modes-help` or `#epic-modes-help-overlay` elements.
4. **Manual test — other modals intact**:
   - Confirm other modals using `.kanban-log-overlay` / `.kanban-log-modal` classes still work (e.g. log viewer, constitution paths modal).
5. **Grep verification**:
   - Search `project.html` and `project.js` for `epic-modes-help` — confirm zero matches remain.
