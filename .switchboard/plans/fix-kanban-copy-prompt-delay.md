# Fix Kanban Copy Prompt Button Delay

## Goal
Remove the 1.5-second animation delay from the card-level "copy prompt" button so it is equally snappy as the column-level button, without introducing double-send race conditions or leaving orphaned animation code behind.

## Metadata
- **Tags:** frontend, bugfix, UX
- **Complexity:** 3

## User Review Required
None — the fix is fully self-contained and low-risk.

## Complexity Audit

### Routine
- Single-file change (kanban.html)
- Removing lines of JS and CSS; no new logic introduced
- No state management changes, no new data flow
- The `copyPlanLinkResult` handler already handles success/failure feedback cleanly

### Complex / Risky
- **Double-send risk (mitigated):** If `btn.disabled = true` is removed from the click handler without a substitute guard, double-sends become possible during the async round-trip. Mitigation: keep `btn.disabled = true` at click time; remove it only in the `copyPlanLinkResult` handler on success/failure.
- **Two-location bug:** The `copied` class is applied in *both* the click handler (eager) *and* the `copyPlanLinkResult` success branch. Fixing only one location leaves the other in place and the delay persists. Both must be fixed.

## Edge-Case & Dependency Audit

### Race Conditions
- The click handler fires immediately; the backend `handleKanbanCopyPlan` is async and may take 200–800ms. Removing `btn.disabled = true` from the click handler without a guard creates a window where the user can click again and send a second `copyPlanLink` message before the first result arrives. **Fix:** keep `disabled = true` in the click handler, remove it in `copyPlanLinkResult` (already done in the result handler).

### Security
- None. No sensitive data; clipboard write is already gated in the backend.

### Side Effects
- `@keyframes copyFlash` and `.card-btn.copy.copied` CSS will become dead code once the `copied` class is no longer applied anywhere. Safe to remove.
- The 2-second fallback `setTimeout(resetBtn, 2000)` in `copyPlanLinkResult` becomes unnecessary once `copied` is no longer applied; removing it eliminates the fallback delay path.

### Dependencies & Conflicts
- No other code in `kanban.html` or any other webview applies the `copied` class to `.card-btn.copy`. Confirmed via grep: only lines 3863 (click handler) and 4867 (`copyPlanLinkResult`) apply it.
- `copy-gather` button (line 3904+) has its own handler and is unaffected.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The plan originally misdiagnosed the bug as a single-location issue, but the `copied` class is applied in *both* the click handler and the `copyPlanLinkResult` success branch — fixing only the click handler would leave the 1.5s animation intact via the result handler. A secondary risk is double-send if `btn.disabled` is removed from the click handler; keeping `disabled = true` at click time (without the animation class) eliminates that race. Mitigation: remove `copied` from both locations and remove the now-redundant CSS and 2s fallback timer.

## Proposed Changes

### `src/webview/kanban.html`

#### Click handler — remove eager animation, keep disabled guard
**Context:** Lines 3859–3874. The click handler eagerly applies `copied` class and sets `textContent = 'Copied!'` before the backend has responded. This starts a 1.5s animation and disables `pointer-events`, causing the perceived delay.

**Logic:** Remove the animation-triggering lines; keep `btn.disabled = true` to prevent double-sends during the async round-trip. The button label will be managed by the result handler.

**Implementation:**

File: `src/webview/kanban.html`

Before (lines 3859–3874):
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

After:
```javascript
document.querySelectorAll('.card-btn.copy').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.disabled = true;  // Keep: prevents double-send during async round-trip

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

**Edge Cases:** None beyond double-send (mitigated by keeping `disabled`).

---

#### `copyPlanLinkResult` handler — remove animation, simplify reset
**Context:** Lines 4856–4894. On success, this handler applies `copied` class (triggering the 1.5s animation), wires an `animationend` listener, and has a 2s `setTimeout` fallback. This is the *primary* source of the delay for users with `prefers-reduced-motion` or systems where `animationend` doesn't fire.

**Logic:** Remove `btn.classList.add('copied')` from the success branch. Remove the `animationend` listener and 2s fallback timer (they only exist to clean up the animation). Re-enable the button immediately after confirming success/failure (or omit `disabled` re-enable entirely since the board will redraw and destroy the button).

**Implementation:**

Before (lines 4864–4891):
```javascript
if (btn) {
    if (msg.success) {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        btn.disabled = true;

        let fallbackTimer = null;
        const resetBtn = () => {
            btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
            btn.classList.remove('copied');
            btn.disabled = false;
            btn.removeEventListener('animationend', onAnimationEnd);
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
        };
        const onAnimationEnd = () => {
            fallbackTimer = null;
            resetBtn();
        };
        btn.addEventListener('animationend', onAnimationEnd);
        fallbackTimer = setTimeout(resetBtn, 2000);
    } else {
        btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
        btn.classList.remove('copied');
        btn.disabled = false;
    }
}
```

After:
```javascript
if (btn) {
    if (msg.success) {
        // No animation — board will redraw and remove the card/button shortly.
        // Button stays disabled (set at click time) until redraw.
        btn.textContent = 'Copied!';
    } else {
        btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
        btn.classList.remove('copied');
        btn.disabled = false;
    }
}
```

**Edge Cases:** If the backend fails and returns `success: false`, the button is re-enabled with its original label (preserved behaviour). If the board does not redraw (e.g. card is already in a terminal column), the button stays in "Copied!" + disabled state permanently — this is acceptable since the action already succeeded and the board state is valid. If this edge case needs addressing, a brief `setTimeout(resetBtn, 500)` in the success branch is sufficient.

---

#### CSS — remove now-dead animation rules
**Context:** Lines 566–575. The `@keyframes copyFlash` and `.card-btn.copy.copied` rule become dead code once the `copied` class is no longer applied by any JS code path.

**Implementation:**

Remove lines 566–575:
```css
/* Card Copy Button Success Animation */
@keyframes copyFlash {
    0% { background-color: var(--vscode-testing-iconPassed, #73c991); color: #ffffff; }
    70% { background-color: var(--vscode-testing-iconPassed, #73c991); color: #ffffff; }
    100% { background-color: transparent; color: var(--text-secondary); }
}
.card-btn.copy.copied {
    animation: copyFlash 1.5s ease-out forwards;
    pointer-events: none;
}
```

**Edge Cases:** If any other code path relies on `.card-btn.copy.copied` (e.g. injected by an extension or test harness), removing the CSS would silently break it. Grep confirms no other references — safe to delete.

## Verification Plan

### Automated Tests
- No automated tests for webview JS. Verified by manual inspection.

### Manual Verification
1. Open the Kanban board with at least one plan in a non-terminal column.
2. Click the card-level "copy prompt" button.
3. Verify the action completes immediately (no green flash, no 1.5s delay).
4. Verify the clipboard contains the expected prompt text.
5. Verify the card advances to the next column (board redraw confirms backend success).
6. Click the column-level "copy prompt for selected" button and confirm behaviour is unchanged.
7. With DevTools open, confirm no JS errors are thrown.
8. Test on a plan where the backend returns failure (e.g. orphaned session) — confirm button re-enables with original label.

---

**Recommendation:** Send to Intern
