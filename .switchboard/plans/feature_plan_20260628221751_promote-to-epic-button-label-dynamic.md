# Dynamic "Promote to Epic" Button Label Based on Selection Count

## Goal

### Problem
The "PROMOTE TO EPIC" button in the kanban controls strip has confusing behavior: its label never changes even though the underlying action differs fundamentally depending on how many cards are selected. When 1 non-epic card is selected, clicking the button **promotes that plan in-place** (marks it `is_epic=1`, moves its file to `epics/`). When 2+ non-epic cards are selected, clicking the button **creates a brand-new epic and groups all selected cards as its subtasks**. Both states show the identical label "PROMOTE TO EPIC", giving the user no indication that the operation is completely different.

### Background Context
The button lives in the kanban controls strip (`<button id="btn-epic-action">`). Its label is managed by `updateEpicActionButton()` in `kanban.html`, and its click handler branches on the selection composition. The modal (`openEpicCreateModal`) already adapts its title and submit-button text based on a `singlePlanPromote` flag, but the strip button that *opens* the modal does not reflect this distinction.

### Root Cause
In `updateEpicActionButton()` (kanban.html lines 6826–6852), the branch for `epics.length === 0 && nonEpics.length > 1` sets the label to `'PROMOTE TO EPIC'` — identical to the `nonEpics.length === 1` branch. This is the root cause: the multi-card branch should use a label that communicates "group these plans into a new epic," not "promote." The label "GROUP INTO EPIC" matches the user's mental model and the existing column-level "Group Into Epic" button terminology already used elsewhere in the UI (the column button's `alt` text is "Group Into Epic" at line 4602).

## Metadata
- **Tags:** ui, ux
- **Complexity:** 3/10

## User Review Required
- [ ] None — this is a trivial label change with no ambiguity.

## Complexity Audit

### Routine
- Changing a string literal in a single JavaScript function (`updateEpicActionButton`).
- No backend changes, no DB schema changes, no new message types.
- The click handler and modal already branch correctly on count — only the label is wrong.

### Complex / Risky
- None. The label is purely cosmetic; the action dispatch logic is already correct.

## Edge-Case & Dependency Audit
1. **0 cards selected**: Button is disabled with label "PROMOTE TO EPIC" — no change needed.
2. **1 epic + 0 non-epics**: Button is disabled with label "PROMOTE TO EPIC" — no change needed (epic management moved to Epics tab).
3. **1 epic + N non-epics**: Label is "ADD N TO EPIC" — no change needed (this is the "add subtasks to existing epic" path).
4. **0 epics + 1 non-epic**: Label is "PROMOTE TO EPIC" — correct, this is in-place promotion.
5. **0 epics + 2+ non-epics**: Label is currently "PROMOTE TO EPIC" — **this is the bug**. Should read "GROUP INTO EPIC" to communicate that the selected cards will be grouped under a new epic. This matches the terminology already used by the column-level "Group Into Epic" button.
6. **Mixed epic + non-epic with multiple epics**: Falls to the `else` branch — disabled, label "PROMOTE TO EPIC". No change needed.
7. **Tooltip**: The button's `data-tooltip` is static ("Convert selected plans to epic or manage existing epic"). This is acceptable for all states and does not need per-state updates, though it could be improved in a follow-up.
- **Race Conditions:** None — purely synchronous UI label update.
- **Security:** None.
- **Side Effects:** None — label change only, no behavioral change.
- **Dependencies:** None — the click handler (lines 9608–9611) already dispatches correctly regardless of label.

## Dependencies
- None — standalone UI label change.

## Adversarial Synthesis

Key risks: None. This is a single-string-literal change in one branch of a UI function. The action dispatch logic is already correct — only the label is misleading. Mitigation: verify all 6 selection states after the change to confirm no branch was accidentally affected.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1: Update `updateEpicActionButton()` — multi-card label**

Location: lines 6845–6847

Current:
```javascript
} else if (epics.length === 0 && nonEpics.length > 1) {
    btn.disabled = false;
    btn.textContent = 'PROMOTE TO EPIC';
}
```

Proposed:
```javascript
} else if (epics.length === 0 && nonEpics.length > 1) {
    btn.disabled = false;
    btn.textContent = 'GROUP INTO EPIC';
}
```

This communicates the actual behavior (grouping selected cards under a new epic) and aligns with the existing column-level "Group Into Epic" button terminology. The modal that opens will still show "Create Epic" as its title (set by `openEpicCreateModal` when `singlePlanPromote` is `false`), which is accurate — the user is creating a new epic to group the selected plans.

**No other changes required.** The click handler (lines 9608–9611) already dispatches correctly:
- `nonEpics.length === 1` → `openEpicCreateModal({ singlePlanPromote: true })` → submit sends `promoteToEpic`
- `nonEpics.length > 1` → `openEpicCreateModal({ singlePlanPromote: false })` → submit sends `createEpic`

## Verification Plan

### Automated Tests
- No automated tests required (skip per session directive). The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard kanban board in VS Code.
2. Select exactly 1 non-epic plan card → verify the strip button reads "PROMOTE TO EPIC".
3. Click it → verify the modal title is "Promote to Epic" and the description field is hidden.
4. Select exactly 2 non-epic plan cards → verify the strip button now reads "GROUP INTO EPIC".
5. Click it → verify the modal title is "Create Epic", the description field is visible, and the submit button reads "Create Epic".
6. Select 1 epic + 1 non-epic → verify the strip button reads "ADD 1 TO EPIC".
7. Select 0 cards → verify the strip button is disabled and reads "PROMOTE TO EPIC".

---

**Recommendation:** Complexity 3/10 → Send to Intern.

## Code Review Results (2026-06-29)

### Files Changed
- `src/webview/kanban.html` — `updateEpicActionButton()` (line 6769): changed multi-card branch label from `'PROMOTE TO EPIC'` to `'GROUP INTO EPIC'`.

### Findings
None — all 6 branches of `updateEpicActionButton` verified correct. Click handler dispatch logic unchanged.

### Fixes Applied
None — implementation is correct and complete.

### Validation
- No compilation step run (per session directive).
- No tests run (per session directive).
- Code verification: all 6 selection-state branches confirmed. Multi-card branch (line 6769) reads `'GROUP INTO EPIC'`. Click handler (lines 9553-9556) dispatches correctly regardless of label.

### Remaining Risks
None — purely cosmetic label change with no behavioral impact.
