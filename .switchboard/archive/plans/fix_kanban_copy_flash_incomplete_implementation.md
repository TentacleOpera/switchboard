# Fix Kanban Copy Flash - Incomplete Implementation

## Goal
Complete the fix for the kanban card copy prompt button graphical flash by removing dataset dependencies that prevent the CSS class-based solution from working correctly.

## Metadata
- **Tags:** [frontend, bugfix, UI, UX]
- **Complexity:** 2

## User Review Required
- [ ] Confirm that reverting button text to `data-copy-label` value (rather than hardcoded `'Copy Prompt'`) is the desired behavior after animation completes.

## Problem
The original plan (fix_kanban_card_copy_prompt_graphical_flash.md) was partially implemented but incorrectly. The CSS animations were added, but the JavaScript handlers still use `dataset.originalText` storage and conditional logic that depends on it. When `renderBoard()` rebuilds the DOM after card advancement, the new button element lacks `dataset.originalText`, so the conditional check in `copyPlanLinkResult` fails and never adds the `.copied` class, causing the visual flash.

## Root Cause Analysis

### Current Implementation Issues
- **Line 3837-3838**: Still stores `btn.dataset.originalText` (plan said to remove this)
- **Line 3846-3853**: Still adds manual `animationend` listeners with `btn._onCopyAnimationEnd` tracking (plan said to remove this)
- **Line 4824**: Has conditional `if (btn.dataset.originalText && !btn.classList.contains('copied'))` - this is the bug

### Why It Fails
1. User clicks copy button → optimistic UI adds `.copied` class and stores `dataset.originalText`
2. Copy succeeds → card advances to next column
3. `renderBoard()` rebuilds DOM → button element is destroyed and recreated
4. New button element does NOT have `dataset.originalText` (it was lost in rebuild)
5. `copyPlanLinkResult` handler finds the new button via `document.querySelector`
6. Conditional check `if (btn.dataset.originalText && !btn.classList.contains('copied'))` fails because `dataset.originalText` is missing
7. `.copied` class is never added to the new button
8. Button shows default state → visual flash

## Solution
Remove all `dataset.originalText` storage and conditional logic. The `copyPlanLinkResult` handler should unconditionally add the `.copied` class on success, regardless of whether the button was rebuilt. Use `data-copy-label` (which IS set in the HTML template and survives DOM rebuilds) for text restoration instead of `dataset.originalText`.

### Implementation Steps

1. **Remove dataset storage from card copy button handler**
   - File: `src/webview/kanban.html` lines 3835-3864
   - Remove lines 3837-3838: `if (!btn.dataset.originalText) { btn.dataset.originalText = btn.textContent; }`
   - Remove lines 3846-3853: the manual `animationend` listener and `btn._onCopyAnimationEnd` tracking
   - Simplify to just: disable button, set text, add class, post message

2. **Simplify copyPlanLinkResult handler**
   - File: `src/webview/kanban.html` lines 4812-4850
   - Remove conditional check at line 4824: `if (btn.dataset.originalText && !btn.classList.contains('copied'))`
   - On success: always add `.copied` class, set text, disable button, add animationend listener
   - Remove references to `btn.dataset.originalText` (lines 4830, 4844)
   - Remove `btn._onCopyAnimationEnd` cleanup logic (lines 4840-4842)
   - **Clarification**: Use `btn.dataset.copyLabel || 'Copy Prompt'` for text restoration (not hardcoded `'Copy Prompt'`), since `data-copy-label` is templated in the HTML (line 4007) and varies per column

### Files to Modify

- `src/webview/kanban.html`:
  - Update card copy button click handler (lines 3835-3864)
  - Update `copyPlanLinkResult` message handler (lines 4812-4850)

## Expected Outcome

After this fix:
- The `.copied` class will be added unconditionally on success, even if the button was rebuilt
- No dependency on `dataset.originalText` which doesn't survive DOM rebuilds
- Button text will correctly revert to its column-specific label (e.g., "Copy coder prompt") after animation
- Visual flash will be eliminated

## Complexity Audit

### Routine
- Removing `dataset.originalText` storage lines
- Removing manual animationend listener management
- Simplifying conditional logic to unconditional class addition
- Using `data-copy-label` (already in HTML template) for text restoration
- All changes are localized to a single file

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The optimistic click handler sets `.copied` immediately; if the DOM rebuilds before `copyPlanLinkResult` arrives, the new button starts clean and the result handler correctly applies `.copied` once. If the DOM does NOT rebuild, the optimistic state is already set and the result handler's `.copied` class is already present — no double-animation. Sound.
- **Security**: No security implications — purely UI state management.
- **Side Effects**: Removing `btn._onCopyAnimationEnd` tracking means error handler can no longer detach a pending animationend listener. However, the error handler now directly resets the button state (removes `.copied`, re-enables), which effectively cancels the visual regardless of whether the listener fires. The listener may still fire after error reset, but it will just set the same default state again — idempotent and harmless.
- **Dependencies & Conflicts**: The `data-copy-label` attribute is set in the HTML template at line 4007 and survives DOM rebuilds. No other code depends on `dataset.originalText` or `btn._onCopyAnimationEnd`.

## Dependencies
None

## Adversarial Synthesis
Key risks: The original plan hardcoded `'Copy Prompt'` as the fallback text, which would regress button labels for non-default columns (e.g., "Copy coder prompt" would revert to "Copy Prompt"). Mitigation: use `btn.dataset.copyLabel || 'Copy Prompt'` instead, since `data-copy-label` is templated in the HTML and survives DOM rebuilds. The `prefers-reduced-motion` edge case (animationend never firing, button stays disabled) is pre-existing and not a regression.

## Proposed Changes

### `src/webview/kanban.html` — Card copy button handler (lines 3835-3864)

**Current code:**
```javascript
document.querySelectorAll('.card-btn.copy').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!btn.dataset.originalText) {
            btn.dataset.originalText = btn.textContent;
        }

        // Optimistic UI state updates using CSS class
        btn.disabled = true;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');

        const onAnimationEnd = () => {
            btn.textContent = btn.dataset.copyLabel || btn.dataset.originalText || 'Copy Prompt';
            btn.classList.remove('copied');
            btn.disabled = false;
            btn.removeEventListener('animationend', onAnimationEnd);
        };
        btn.addEventListener('animationend', onAnimationEnd);
        btn._onCopyAnimationEnd = onAnimationEnd;

        const column = btn.dataset.column || btn.closest('.kanban-column')?.dataset?.column;
        postKanbanMessage({
            type: 'copyPlanLink',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            column,
            workspaceRoot: btn.dataset.workspaceRoot
        });
    });
});
```

**New code:**
```javascript
document.querySelectorAll('.card-btn.copy').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');

        const column = btn.dataset.column || btn.closest('.kanban-column')?.dataset?.column;
        postKanbanMessage({
            type: 'copyPlanLink',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            column,
            workspaceRoot: btn.dataset.workspaceRoot
        });
    });
});
```

### `src/webview/kanban.html` — `copyPlanLinkResult` handler (lines 4812-4850)

**Current code:**
```javascript
case 'copyPlanLinkResult': {
    let btn = null;
    if (msg.planId) {
        btn = document.querySelector(`.card-btn.copy[data-plan-id="${msg.planId}"]`);
    }
    if (!btn && msg.sessionId) {
        btn = document.querySelector(`.card-btn.copy[data-session="${msg.sessionId}"]`);
    }
    if (btn) {
        if (msg.success) {
            // Only apply styles on success if the element wasn't rebuilt
            // (If rebuilt, it starts in default state and doesn't need to animate again)
            if (btn.dataset.originalText && !btn.classList.contains('copied')) {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                btn.disabled = true;

                const onAnimationEnd = () => {
                    btn.textContent = btn.dataset.copyLabel || btn.dataset.originalText || 'Copy Prompt';
                    btn.classList.remove('copied');
                    btn.disabled = false;
                    btn.removeEventListener('animationend', onAnimationEnd);
                };
                btn.addEventListener('animationend', onAnimationEnd);
                btn._onCopyAnimationEnd = onAnimationEnd;
            }
        } else {
            // Instant revert on error
            if (btn._onCopyAnimationEnd) {
                btn.removeEventListener('animationend', btn._onCopyAnimationEnd);
                btn._onCopyAnimationEnd = null;
            }
            btn.textContent = btn.dataset.copyLabel || btn.dataset.originalText || 'Copy Prompt';
            btn.classList.remove('copied');
            btn.disabled = false;
        }
    }
    break;
}
```

**New code:**
```javascript
case 'copyPlanLinkResult': {
    let btn = null;
    if (msg.planId) {
        btn = document.querySelector(`.card-btn.copy[data-plan-id="${msg.planId}"]`);
    }
    if (!btn && msg.sessionId) {
        btn = document.querySelector(`.card-btn.copy[data-session="${msg.sessionId}"]`);
    }
    if (btn) {
        if (msg.success) {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            btn.disabled = true;

            const onAnimationEnd = () => {
                btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
                btn.classList.remove('copied');
                btn.disabled = false;
                btn.removeEventListener('animationend', onAnimationEnd);
            };
            btn.addEventListener('animationend', onAnimationEnd);
        } else {
            btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
            btn.classList.remove('copied');
            btn.disabled = false;
        }
    }
    break;
}
```

## Verification Plan

### Automated Tests
- No automated tests exist for this UI interaction. Manual verification required.

Manual verification steps:
1. Click "Copy Prompt" on a card → verify green flash animation plays, no visual flash/glitch
2. Click "Copy Prompt" on a card → verify card advances to next column smoothly
3. Verify the button shows "Copied!" state after card moves (this was broken before)
4. Verify button text reverts to the correct column-specific label after animation (e.g., "Copy coder prompt" not "Copy Prompt")
5. Test on a card in a non-default column (e.g., CODER CODED) to confirm label preservation

## Reviewer Pass Results

### Stage 1: Adversarial Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | **MAJOR** | Animationend orphan: if `copyPlanLinkResult` arrives after the 1.5s CSS animation completes, the `animationend` listener is attached to a button whose animation is already done — it never fires, button stays disabled forever. Regression from old code which had a safety-net animationend listener in the optimistic click handler. | **Fixed** |
| 2 | NIT | `prefers-reduced-motion: reduce` prevents animation from playing, `animationend` never fires, button stays disabled. Pre-existing but trivially fixed alongside #1. | **Fixed** (free with #1) |
| 3 | **MAJOR** | KanbanProvider `copyPlanLinkResult` message (line 5300) missing `planId` — primary `data-plan-id` lookup always fails, falls back to `sessionId`. If `data-session` is removed (sessionId phase-out), the fallback breaks entirely and the flash bug returns. | **Fixed** |
| 4 | POSITIVE | Implementation matches plan's "New code" sections exactly. All `dataset.originalText` and `_onCopyAnimationEnd` references removed. `data-copy-label` fallback correct. Unconditional `.copied` addition correct. | Kept |

### Stage 2: Balanced Synthesis

- **Keep**: Core fix (unconditional `.copied`, `data-copy-label` fallback, removal of `dataset.originalText`/`_onCopyAnimationEnd`)
- **Fix Now**: Add `setTimeout` fallback (2s) in `copyPlanLinkResult` success path to prevent stuck button when `animationend` never fires
- **Fix Now**: Add `planId: msg.planId || ''` to KanbanProvider `copyPlanLinkResult` message so `data-plan-id` lookup works (critical for sessionId phase-out)

### Code Fix Applied

**File**: `src/webview/kanban.html` — `copyPlanLinkResult` handler (lines ~4843-4881)

Added a `setTimeout(resetBtn, 2000)` fallback alongside the `animationend` listener. If `animationend` fires first, it clears the timeout. If the timeout fires first (animation already done, or `prefers-reduced-motion`), it resets the button and removes the orphaned listener. The `resetBtn` function is idempotent — safe to call from either path.

### Verification Results

- **Webpack compile**: ✅ Success (no errors)
- **TypeScript check**: Pre-existing errors only (import path extensions, unrelated to this change)
- **kanban-card-prompt-labels-regression.test.js**: ✅ Passed
- **kanban-batch-prompt-regression.test.js**: ✅ Passed
- **kanban-default-prompt-previews.test.js**: ✅ Passed
- **No automated tests exist for the copy button animation flow** — manual verification still required per original plan

### Files Changed by Review

- `src/webview/kanban.html`: Added `setTimeout` fallback in `copyPlanLinkResult` success path (lines ~4857-4873)
- `src/services/KanbanProvider.ts`: Added `planId: msg.planId || ''` to `copyPlanLinkResult` message (line 5300) so `data-plan-id` lookup works without relying on `data-session` fallback

### Remaining Risks

1. **No automated test coverage** for the copy button animation lifecycle — the fix is defensive but untested by CI. Manual verification per the original plan's steps is still required.

## Recommendation
Complexity 2 → **Send to Intern**
