# Replace Kanban Toast Notifications with Inline Status Messages

## Goal
Replace VS Code `withProgress` notification toasts (`_showTemporaryNotification` in KanbanProvider.ts) with unobtrusive inline text status messages that flash briefly above the kanban columns, eliminating disruptive popup notifications for routine operations.

## Metadata
- **Tags:** frontend, UX, UI
- **Complexity:** 4

## User Review Required
None. This is a pure UX-behavior improvement with no logic changes. The boundary between inline status messages and persistent VS Code notifications is well-defined below.

## Complexity Audit

### Routine
- Adding a single `<div>` element and CSS animation to an existing HTML file
- Adding a new `case` handler in an existing `window.addEventListener('message', ...)` switch block
- Replacing 13 mechanical `_showTemporaryNotification(...)` calls with `this._panel?.webview.postMessage(...)` calls — identical pattern at every site
- Removing the now-unused `_showTemporaryNotification` private method
- All changes are confined to 2 files

### Complex / Risky
- Messages sent via `postMessage` are invisible when the kanban webview panel is not the active VS Code tab (known limitation — acceptable tradeoff since operations still succeed)
- Rapid-fire operations (e.g., clicking two buttons in quick succession) will overwrite the previous status message mid-animation ("last message wins" behavior — acceptable for transient status)

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid-fire overwrite**: If two operations fire in quick succession, the second `showStatusMessage` resets the animation, cutting off the first message. This is acceptable — the messages are transient confirmations, not critical data. "Last message wins" is the intended behavior.
- **Post-animation display state**: After the CSS animation ends at `opacity: 0`, the element remains in the DOM with `display: ''`, taking up vertical space. An `animationend` event listener must set `display: none` to collapse the gap.

### Security
- None. Status message text is generated internally by KanbanProvider.ts from operation results (card counts, column names). No user-controlled input is injected into the DOM.

### Side Effects
- Removing `_showTemporaryNotification` eliminates the `withProgress` spinner icon that briefly appeared in the VS Code notification area. The inline message has no spinner — this is an intentional UX improvement.
- `_notifySkippedUnknownComplexity` (line 3910) uses `showInformationMessage` directly and is NOT affected by this change. It remains a persistent VS Code notification because its message includes a call to action ("Enable in setup to allow auto-moving").

### Dependencies & Conflicts
- **Predecessor plan**: `fix-kanban-toast-persistence.md` (completed) replaced `showInformationMessage` calls with `_showTemporaryNotification`. This plan replaces those `_showTemporaryNotification` calls with inline webview messages — the next evolution.
- **Related plan**: `fix-taskviewer-toast-persistence.md` applies the same `_showTemporaryNotification` pattern to TaskViewerProvider.ts. That plan is independent; changes here do not affect it.
- No dependency on external libraries. Uses standard webview `postMessage` API and CSS animations.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Status messages are invisible when the kanban panel is not the active VS Code tab — mitigated by documenting this as an accepted tradeoff (operations still succeed; only visual confirmation is lost). (2) Rapid-fire operations overwrite previous messages before they can be read — mitigated by "last message wins" semantics, which is acceptable for transient confirmations. (3) Post-animation gap if `display:none` is not restored — mitigated by adding an `animationend` listener.

## Problem
The kanban board uses VS Code's `withProgress` notification toasts (`_showTemporaryNotification` in KanbanProvider.ts) which are annoying and disruptive. These toasts appear as popup notifications in the VS Code UI, even though they auto-dismiss after 1 second (added by the previous `fix-kanban-toast-persistence` plan).

## Solution
Replace toast notifications with simple text status messages that flash in the grey space directly above the kanban columns, similar to the existing `db-warning-banner`. The inline messages will fade in, display for 3 seconds, then fade out and collapse.

## Implementation Steps

### 1. Add Status Message Area to Kanban Webview
**File**: `src/webview/kanban.html`

- Add a new status message container between the `db-warning-banner` and the `kanban-board` div (after line 2068, before line 2069)
- Include ARIA attributes for accessibility (`role="status"`, `aria-live="polite"`)
- Add CSS for flash animation (fade in, display for ~3 seconds, fade out)
- Style to match the existing warning banner but with neutral/success colors
- Add `animationend` event listener to collapse the element after animation completes

```html
<!-- Add after db-warning-banner (line 2068), before kanban-board (line 2069) -->
<div id="status-message" role="status" aria-live="polite" style="display:none; padding:6px 12px; font-size:12px; text-align:center; border-bottom:1px solid var(--border-color);"></div>
```

```css
/* Add flash animation — 3 seconds total: 0.3s fade-in, ~2.4s hold, 0.3s fade-out */
@keyframes statusFlash {
    0% { opacity: 0; }
    10% { opacity: 1; }
    90% { opacity: 1; }
    100% { opacity: 0; }
}

#status-message.flashing {
    animation: statusFlash 3s ease-in-out forwards;
}
```

### 2. Add Webview Message Handler for Status Messages
**File**: `src/webview/kanban.html`

- Add a new message type handler `showStatusMessage` in the `window.addEventListener('message', ...)` switch block (around line 5075)
- Update the status message element's text content and color based on message type
- Reset animation by removing and re-adding the CSS class
- Add `animationend` listener to set `display:none` after animation completes

```javascript
case 'showStatusMessage': {
    const statusEl = document.getElementById('status-message');
    if (statusEl) {
        statusEl.textContent = msg.message || '';
        statusEl.style.color = msg.isError
            ? 'var(--vscode-errorForeground, #ff6b6b)'
            : 'var(--text-secondary)';
        statusEl.style.display = '';
        // Reset animation by removing class, forcing reflow, re-adding class
        statusEl.classList.remove('flashing');
        void statusEl.offsetWidth; // Trigger reflow to restart animation
        statusEl.classList.add('flashing');
    }
    break;
}
```

Also add the `animationend` listener (place near the top-level initialization code, after the status-message element is in the DOM):

```javascript
const statusMsgEl = document.getElementById('status-message');
if (statusMsgEl) {
    statusMsgEl.addEventListener('animationend', () => {
        statusMsgEl.style.display = 'none';
        statusMsgEl.classList.remove('flashing');
    });
}
```

### 3. Replace `_showTemporaryNotification` with Webview Messages
**File**: `src/services/KanbanProvider.ts`

- Replace all 13 calls to `this._showTemporaryNotification(...)` with `this._panel?.webview.postMessage({ type: 'showStatusMessage', message: ..., isError: false })`
- Remove the `_showTemporaryNotification` method definition entirely (line 507-518) — it is private and has no callers outside this file

**Clarification**: The `isError` field is set to `false` for all current call sites since they are success/status messages. Error messages that should persist remain as VS Code notifications (see Step 4).

Locations to update (identified by message content for resilience against line drift):

| Message Pattern | Context |
|---|---|
| `Copied prompt for ${sourceCards.length} plan(s) to clipboard.` | promptOnDrop (2 occurrences) |
| `Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.` | batchPlannerPrompt |
| `Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.` | batchLowComplexity |
| `Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}` | moveAll (complexity-routing branch) |
| `Moved ${sourceCards.length} plans from ${column} to ${nextCol}.` | moveAll (simple branch) |
| `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.` | promptSelected / promptAll (3 occurrences) |
| `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}` | promptSelected / promptAll (2 occurrences) |
| `Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).` | promptSelected |
| `Copied prompt for ${sourceCards.length} plans and advanced to next stage.` | promptSelected / promptAll (2 occurrences) |
| `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.` | promptAll (complexity-routing branch) |
| `Copied prompt for ${sourceCards.length} plans. No plans advanced.` | promptAll (no-advance branch) |

Replacement pattern (identical for all 13 sites):
```typescript
// Before:
this._showTemporaryNotification(`Some message here`);

// After:
this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Some message here`, isError: false });
```

### 4. Keep Error Messages and Action-Required Warnings as VS Code Notifications
**File**: `src/services/KanbanProvider.ts`

- Keep `vscode.window.showInformationMessage`, `showWarningMessage`, and `showErrorMessage` for actual errors, warnings, and messages that require user action
- Keep `_notifySkippedUnknownComplexity` (line 3910) as a VS Code notification — its message includes a call to action ("Enable in setup to allow auto-moving")
- Only replace the temporary status notifications (`_showTemporaryNotification`) with inline messages

Examples to keep as-is:
- Line 2730-2736: Pair programming prompt copy confirmation
- Line 3910-3916: Unknown complexity skip notification (includes call to action)
- Line 3953: Plan file not found warning
- Line 3986-4014: Workspace reassignment warnings
- Line 4100-4110: Reassignment success/failure messages
- Line 4325: Lead prompt copied confirmation
- Line 4418-4425: Auto-pull settings errors

### 5. Test the Changes
- Test various kanban operations to ensure status messages appear correctly:
  - Drag-drop cards between columns
  - Batch prompt generation
  - Copy prompt buttons
  - Card movement operations
- Verify messages flash and disappear cleanly (3-second duration)
- Confirm the status-message area collapses after animation ends (no vertical gap)
- Ensure no overlapping or stuck messages
- Confirm error messages still show as proper VS Code notifications
- Test with kanban panel not active (verify operations still succeed; status message is simply not visible)

## Files to Modify
1. `src/webview/kanban.html` — Add status message element, CSS, animationend listener, and message handler
2. `src/services/KanbanProvider.ts` — Replace `_showTemporaryNotification` calls with `postMessage`, remove the method definition

## Expected Outcome
- No more VS Code notification toasts for routine kanban operations
- Simple, unobtrusive text status messages flash briefly (3s) above the kanban columns, then collapse
- Error messages and action-required warnings still use VS Code notifications where appropriate
- Cleaner, less disruptive user experience

## Verification Plan

### Automated Tests
*(Skipped per session directives.)*

### Manual Verification
1. Open the Kanban panel.
2. Use **"Prompt Selected"** on cards — confirm inline status message appears above columns and auto-dismisses after ~3 seconds.
3. Use **"Prompt All"** on a column — confirm same behavior.
4. Use **"Move All"** — confirm same behavior.
5. Use drag-and-drop advance — confirm same behavior.
6. Trigger a batch planner or batch low-complexity prompt — confirm the longer status message is readable within the 3-second window.
7. Verify the status-message area fully collapses after animation (no vertical gap between toolbar and board).
8. Trigger a **warning** (e.g., unknown complexity skip) — confirm it still appears as a persistent VS Code notification with the call-to-action message.
9. Switch to a different VS Code tab, then trigger a kanban operation — confirm the operation succeeds (clipboard copy, card movement) even though the inline message is not visible.
10. Rapidly click two different kanban operations — confirm "last message wins" behavior (second message overwrites first).

## Review Results

### Stage 1: Grumpy Review (Findings)
1. **NIT**: The plan stated there were 13 `_showTemporaryNotification` calls to replace, but there were actually 14 instances correctly identified and replaced by the implementation.
2. **NIT**: A `showInformationMessage` call in `moveSelected` for complexity-routing ("Moved N plans...") was not replaced in the implementation because it was originally missed in the predecessor plan (`fix-kanban-toast-persistence.md`), meaning it wasn't technically a `_showTemporaryNotification`. However, logically it belongs as an inline status message alongside its `moveAll` counterpart.

### Stage 2: Balanced Synthesis
- The implementation is excellent. The HTML DOM changes, CSS animations, and `postMessage` handlers were perfectly executed. 
- The "last message wins" reflow restart logic (`classList.remove`, `offsetWidth`, `classList.add`) was correctly applied.
- The `animationend` cleanup listener ensures the DOM element properly collapses.
- **Action**: Fix the single remaining `showInformationMessage` in the `moveSelected` branch of `KanbanProvider.ts` that should have been converted to an inline status message.

### Code Fixes Applied
- `src/services/KanbanProvider.ts`: Modified line 4842 in `moveSelected` to use `this._panel?.webview.postMessage({ type: 'showStatusMessage', ... })` instead of `vscode.window.showInformationMessage(...)` for consistency with `moveAll`.

### Final Status
- **Files Modified**: `src/webview/kanban.html`, `src/services/KanbanProvider.ts`
- **Verification**: Verified via manual inspection that all temporary success toasts are now routed to `showStatusMessage`, while error and non-advance notifications correctly retain their `showInformationMessage` persistence.
- **Ready for review/commit.**

---

**Recommendation: Send to Coder**
