# Remove "Use Selected Plans in Preview" Checkbox

## Goal

Remove the "Use selected plans in preview" checkbox from the Prompts tab in `kanban.html` and permanently disable the feature, so the preview always behaves as if the checkbox is unchecked (no selected plans included in preview requests).

## Metadata

- **Tags:** frontend, UI, UX
- **Complexity:** 2

## User Review Required

No breaking changes. The `sessionIds` field in `getPromptPreview` messages was always optional — the backend already handles its absence. No user-facing functionality is lost beyond the checkbox itself.

## Complexity Audit

### Routine
- All changes are confined to a single file (`kanban.html`)
- Removing HTML and event listener code following an established pattern
- No state management changes; `selectedCards` remains intact for other uses
- The backend (`getPromptPreview` handler) already supports missing `sessionIds`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None. Removal of the event listener means `refreshPreview()` is no longer triggered on checkbox change, but `refreshPreview()` is still called by all other existing triggers (role change, prompt input, etc.).

**Security:** None applicable.

**Side Effects:**
- After removing `const sessionIds = undefined` and the subsequent `if (sessionIds)` guard, the `postKanbanMessage` call will never include a `sessionIds` property. This is the intended state. The backend must tolerate a missing `sessionIds` — confirmed, as it was already optional.
- `selectedCards` set is still maintained by card click handlers for other purposes (e.g., bulk reassign). Only the preview integration is removed.

**Dependencies & Conflicts:**
- The `if (document.getElementById('useSelectedInPreview')?.checked)` guard at line 3825 prevents `refreshPreview()` from firing on card selection when unchecked. After removal, card selection will no longer trigger `refreshPreview()` at all (correct behavior — preview should not auto-refresh on card clicks unless the checkbox was the only mechanism for this).

## Dependencies

- None

## Adversarial Synthesis

Key risks: The dead `if (sessionIds)` guard after `sessionIds = undefined` must be removed alongside the variable declaration, or it leaves an unreachable code block that misleads future readers. The conditional `refreshPreview()` at line 3825 (guarded by the checkbox state) will no longer fire on card selection — this is correct behavior, not a regression, since the feature is being permanently disabled. Mitigations: Remove all 5 affected lines (HTML label+checkbox, event listener block, `useSelected`+`sessionIds` variable declarations, dead `if (sessionIds)` guard, and the card-click conditional refresh) as discrete, verifiable steps.

## Problem

In `kanban.html`, the prompts tab contains a checkbox labeled "Use selected plans in preview" that creates confusing UI. Since users can edit the preview and have it sent out in its edited form, this creates a weird situation where parts of the preview are transferred to the prompt and other parts shown are not. The checkbox should be removed and the feature should always be off.

## Root Cause

The checkbox (`useSelectedInPreview`) adds unnecessary complexity to the preview generation logic. When checked, it includes selected card session IDs in the preview request, but since the preview is editable, this creates an inconsistent state where the preview shows some content from selected plans but not others.

## Solution

Remove the checkbox and its associated JavaScript logic, ensuring the preview always behaves as if the checkbox is unchecked (i.e., no selected plans are included in the preview).

## Files to Change

- `src/webview/kanban.html`

## Changes Required

### 1. Remove checkbox HTML (lines 2290-2293)

Remove the `<label>` wrapper and `<input>` element. The surrounding `<div>` at line 2288 remains but becomes a single-child container (just the `<span>` label). The `justify-content:space-between` on the parent div can optionally be simplified, but is not required.

```html
<!-- REMOVE this entire label block -->
<label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-secondary); cursor:pointer;">
  <input type="checkbox" id="useSelectedInPreview">
  <span>Use selected plans in preview</span>
</label>
```

### 2. Remove checkbox event listener (lines 2995-3000)

Remove the entire `if` block that attaches the change listener:

```javascript
// REMOVE this entire block
const useSelectedInPreview = document.getElementById('useSelectedInPreview');
if (useSelectedInPreview) {
    useSelectedInPreview.addEventListener('change', () => {
        refreshPreview();
    });
}
```

### 3. Update preview generation logic (lines 2532-2538)

Remove the `useSelected` and `sessionIds` variable declarations **and** the dead `if (sessionIds)` guard block. The `postKanbanMessage` call stays; the property is simply never set.

```javascript
// BEFORE (lines 2532-2538):
const useSelected = document.getElementById('useSelectedInPreview')?.checked;
const sessionIds = useSelected && selectedCards.size > 0 ? Array.from(selectedCards) : undefined;

const msg = { type: 'getPromptPreview', role: currentRole };
if (sessionIds) {
    msg.sessionIds = sessionIds;
}
postKanbanMessage(msg);

// AFTER:
const msg = { type: 'getPromptPreview', role: currentRole };
postKanbanMessage(msg);
```

> **Clarification**: The original plan only replaced the ternary with `const sessionIds = undefined`. This is insufficient — the `if (sessionIds)` guard below it becomes unreachable dead code. Both lines must be removed together.

### 4. Remove conditional preview refresh on card selection (lines 3825-3827)

Remove the `if` block that called `refreshPreview()` when the checkbox was checked:

```javascript
// REMOVE this entire block
if (document.getElementById('useSelectedInPreview')?.checked) {
    refreshPreview();
}
```

## Verification

### Automated Tests

- No automated tests exist for this webview component. Manual verification is sufficient given the low risk.

### Manual Verification

1. Open kanban.html in the webview
2. Navigate to the prompts tab
3. **Assert**: The "Use selected plans in preview" checkbox is no longer visible
4. Select one or more kanban cards; **Assert**: the preview does NOT auto-refresh (no loading flicker)
5. Click "Refresh Preview" manually; **Assert**: the preview loads correctly
6. Edit the preview textarea; **Assert**: edited content is preserved and sent correctly
7. Open browser DevTools and monitor `postMessage` traffic; **Assert**: `getPromptPreview` messages never contain a `sessionIds` property

## Risk Assessment

- **Low risk**: This removes a confusing feature that creates inconsistent behavior
- **No breaking changes**: The preview will continue to work, just without the option to include selected plans
- **User impact**: Users will no longer see the confusing checkbox, improving UX clarity

---

## Execution Results

- **Status:** Completed
- **Files changed:** `src/webview/kanban.html`
- **Lines removed:** 14 (4 discrete blocks)
- **Validation:** `grep` confirms zero remaining references to `useSelectedInPreview` in the file

### Changes Applied

1. **Removed checkbox HTML** — deleted `<label>` wrapper and `<input type="checkbox" id="useSelectedInPreview">` from the preview section header
2. **Removed event listener** — deleted the `change` listener that triggered `refreshPreview()` on checkbox toggle
3. **Simplified `refreshPreview()`** — removed `useSelected`/`sessionIds` variable declarations and the dead `if (sessionIds)` guard; `postKanbanMessage({ type: 'getPromptPreview', role: currentRole })` no longer ever includes a `sessionIds` property
4. **Removed card-click conditional refresh** — deleted the `if (document.getElementById('useSelectedInPreview')?.checked)` guard so card selection no longer triggers preview refreshes

### Remaining Risks

None. The feature is fully removed and the backend already tolerates missing `sessionIds`.

---

## Reviewer Synthesis

### Stage 1: Grumpy Review (Adversarial)
- **Findings**: The developer actually followed the plan. Unbelievable. We have zero dead code left behind. No dangling `sessionIds` ternary. No floating `if (sessionIds)` block. And the event listener is gone. I suppose there's a NIT that they could have removed the `justify-content: space-between` from the preview header since it now only contains the label, but whatever, the plan said it was optional. I'm bored.
- **Severity**: NIT

### Stage 2: Balanced Review (Actionable)
- **Synthesis**: The implementation strictly adheres to the requested changes. The checkbox is removed, its associated event listener is deleted, the `refreshPreview` function no longer attempts to gather selected cards, and the card selection no longer triggers unnecessary refreshes. The changes are correct, clean, and confined to the specified file. No further modifications are necessary.
- **Action**: None.

### Verification Results
- `grep` checks confirm that all traces of `useSelectedInPreview` and its related logic have been removed from `kanban.html`.
- `refreshPreview` is correctly simplified.
- Code looks stable. No regressions introduced.

