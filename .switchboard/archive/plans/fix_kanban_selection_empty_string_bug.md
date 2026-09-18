# Fix Kanban Selection Empty String Bug

## Goal
Prevent empty-string IDs from entering the `selectedCards` Set, which causes the "ASSIGN TO WORKSPACE" button to show an inflated count and leads to incorrect selection behavior.

## Problem
The 'assign to workspace' button always shows "ASSIGN TO WORKSPACE (1)" even when no plans are selected. Selection counts are also incorrect (e.g., user thought they selected 3 plans but 4 ended up in a prompt).

## Root Cause
In `src/webview/kanban.html` at line 3790, the card selection logic uses:
```javascript
const pid = el.dataset.planId || el.dataset.session || '';
```

If a card lacks both `data-plan-id` and `data-session` attributes (or both are empty strings — which happens when `card.planId` and `card.sessionId` are both falsy at render time, line 4038), the fallback produces an empty string `''`. This empty string gets added to the `selectedCards` Set, which counts as 1 selected item even though it's not a real plan ID.

The same issue exists at line 3806 where selection state is re-applied after re-render:
```javascript
if (selectedCards.has(el.dataset.planId || el.dataset.session || '')) {
    el.classList.add('selected');
}
```

Additionally, when `pid` is empty, line 3799 sends a `selectPlan` message with empty `sessionId` and `planId` to the backend, which could trigger unexpected behavior.

**Note**: The helper functions `getSelectedInColumn` (line 3170) and `getSelectedInRenderedContainer` (line 3181) already filter out empty strings via `.filter(Boolean)`, so column-level actions (move/prompt/complete selected) and drag-and-drop multi-select are already safe. However, `getAllInColumn` (line 3190) does NOT filter empty strings — a secondary hardening fix is included below.

## Metadata
- **Tags:** [bugfix, frontend, reliability]
- **Complexity:** 3

## User Review Required
- Verify that no legitimate cards exist in production that have neither `planId` nor `sessionId` (if such cards exist, the guard clause will make them unselectable, which may or may not be desired).

## Complexity Audit

### Routine
- Adding guard clause to card click handler (2-line change)
- Adding guard clause to re-apply selection state (1-line change)
- Adding `.filter(Boolean)` to `getAllInColumn` (1-line change)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None. `selectedCards` is only mutated in the main thread event handlers.
- **Security**: No security implications — this is a UI-only bug.
- **Side Effects**: The `if (!pid) return;` guard at Location 1 also prevents sending `selectPlan` messages with empty IDs to the backend (line 3799), which is a positive side effect.
- **Dependencies & Conflicts**: No dependencies on other plans or external changes.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Cards with neither `planId` nor `sessionId` become unselectable — acceptable since they represent invalid data. (2) `getAllInColumn` sends empty strings to backend on "all" actions — low risk since backend validates, but defensive filtering added. Mitigations: guard clauses prevent empty strings from entering `selectedCards`; `.filter(Boolean)` on `getAllInColumn` provides defense-in-depth.

## Solution
Add validation to ensure only non-empty IDs are added to `selectedCards`. Modify the code in three locations:

### Location 1: Card click handler (lines 3787-3803)
Add a guard clause to prevent adding empty strings to `selectedCards` and prevent sending empty-ID `selectPlan` messages:
```javascript
const pid = el.dataset.planId || el.dataset.session || '';
if (!pid) return; // Skip if no valid ID — also prevents empty selectPlan message
if (selectedCards.has(pid)) {
    selectedCards.delete(pid);
    el.classList.remove('selected');
} else {
    selectedCards.add(pid);
    el.classList.add('selected');
    // Sync sidebar dropdown on unmodified single clicks
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
        postKanbanMessage({ type: 'selectPlan', sessionId: el.dataset.session || '', planId: pid });
    }
}
updateReassignButtonVisibility();
```

### Location 2: Re-apply selection state (lines 3805-3808)
Add the same validation when checking if a card should be re-selected:
```javascript
const pid = el.dataset.planId || el.dataset.session || '';
if (pid && selectedCards.has(pid)) {
    el.classList.add('selected');
}
```

### Location 3: `getAllInColumn` hardening (lines 3190-3196)
Add `.filter(Boolean)` to prevent empty strings from being sent to the backend on "move all" / "prompt all" / "complete all" actions:
```javascript
function getAllInColumn(col) {
    if (col === 'CODED_AUTO') {
        const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
        return currentCards.filter(c => CODED_IDS.includes(c.column)).map(c => c.planId || c.sessionId || '').filter(Boolean);
    }
    return currentCards.filter(c => c.column === col).map(c => c.planId || c.sessionId || '').filter(Boolean);
}
```

## Proposed Changes

### src/webview/kanban.html
- **Context**: The `selectedCards` Set (line 2839) tracks which kanban cards the user has clicked. The click handler (line 3788) and re-apply logic (line 3805) both use `el.dataset.planId || el.dataset.session || ''` which can produce empty strings.
- **Logic**: Add `if (!pid) return;` guard in click handler; add `pid &&` check in re-apply logic; add `.filter(Boolean)` to `getAllInColumn`.
- **Implementation**: Three small edits — no structural changes.
- **Edge Cases**: Cards with no planId/sessionId become unselectable (correct behavior — they represent invalid data). The `selectPlan` message with empty IDs is also prevented.

## Verification Plan

### Automated Tests
- No automated test infrastructure detected for this webview component. Manual verification required.

### Manual Verification
1. Open kanban board with no selections
2. Verify the 'assign to workspace' button shows "ASSIGN TO WORKSPACE" (disabled), not "ASSIGN TO WORKSPACE (1)"
3. Select 3 plans and verify the button shows "ASSIGN TO WORKSPACE (3)"
4. Use a prompt action and verify exactly 3 plans are included
5. Trigger a board re-render (e.g., switch workspace and back) and verify selection state is preserved correctly with no phantom selections
6. Use "move all" on a column and verify no empty-string IDs are sent to backend

## Reviewer Pass (Grumpy Principal Engineer)

**Stage 1: Grumpy Analysis**
*   **[NIT]** A bug where empty strings snuck into a selection set? Rookie mistake using `|| ''` as a fallback without verifying truthiness later. 
*   You added a guard clause `if (!pid) return;`. It handles the symptoms correctly. 
*   You also caught the re-apply state missing the same guard, and added `filter(Boolean)` to `getAllInColumn` just in case. Good. It's solid defense-in-depth. 
*   But don't let me catch you using `|| ''` as a fallback when you actually need a valid identifier again. 

**Stage 2: Balanced Synthesis**
*   The implementation correctly applies all three modifications described in the plan:
    1.  Location 1 (`kanban.html` line 3798): `if (!pid) return;` properly short-circuits adding empty IDs to `selectedCards`.
    2.  Location 2 (`kanban.html` line 3818): `if (pid && selectedCards.has(pid))` properly prevents empty strings from matching the selection logic during re-render.
    3.  Location 3 (`kanban.html` line 3198): `.filter(Boolean)` is properly attached to the return values of `getAllInColumn`.
*   The fix handles the root cause. No material defects found.

**Stage 3: Verification & Execution**
*   **Code Changes:** Applied correctly as documented.
*   **Validation:** Verified the HTML JS snippet logically meets all criteria.
*   **Status:** **[COMPLETED]**

## Recommendation
**Send to Intern** — Complexity 3, single-file changes, all routine guard-clause additions.
