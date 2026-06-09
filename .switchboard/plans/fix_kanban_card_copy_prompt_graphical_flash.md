# Fix Kanban Card Copy Prompt Graphical Flash

## Goal
Eliminate the graphical flash on kanban card "Copy Prompt" buttons by replacing inline style manipulation with CSS class-based animations that survive `renderBoard()` DOM rebuilds.

## Metadata
- **Tags:** [frontend, bugfix, UI, UX]
- **Complexity:** 3

## Problem
When clicking 'copy prompt' buttons on individual kanban cards, there is a noticeable graphical flash as the cards advance to the next column. This flash does not occur when using the column-level copy prompt buttons.

## Root Cause Analysis

### Card-Level Copy Prompt Buttons
- Location: `src/webview/kanban.html` lines 3812-3834
- Current implementation uses inline style changes for optimistic feedback:
  - `btn.disabled = true`
  - `btn.textContent = 'Copied!'`
  - `btn.style.backgroundColor = 'var(--vscode-testing-iconPassed, #73c991)'`
  - `btn.style.color = '#ffffff'`
- After successful copy, the card advances to the next column
- Card advancement triggers `renderBoard()` (line 3684) which completely rebuilds the DOM
- The inline style changes are lost when the button element is destroyed and recreated
- This causes a visual "flash" as the button briefly shows "Copied!" then reverts

### Column-Level Copy Prompt Buttons
- Location: `src/webview/kanban.html` lines 3485-3534
- Current implementation calls `flashIconBtn(btn)` (line 3141) which adds a `.flash` CSS class
- **CRITICAL FINDING**: No `.flash` CSS class or `@keyframes` animation is defined anywhere in the stylesheet — `flashIconBtn()` is currently a visual no-op
- Column buttons are in the column header area which does NOT get re-rendered when cards move
- The column buttons survive `renderBoard()` DOM rebuilds, so even the inline-style approach wouldn't flash — but they currently show no visual feedback at all

### `copyPlanLinkResult` Handler
- Location: `src/webview/kanban.html` lines 4782-4823
- After `renderBoard()` rebuilds the DOM, `document.querySelector` finds a **new** button element
- The new element lacks `dataset.originalText`, `dataset.originalBg`, `dataset.originalColor`, and `copyTimeoutId`
- On the new element, `originalText` falls back to `btn.textContent` (which is the default "Copy Prompt"), `originalBg` and `originalColor` fall back to empty strings
- This means the setTimeout revert at line 4808-4814 restores to empty inline styles, overriding the CSS defaults — another subtle visual artifact

### `copy-gather` Buttons (Related)
- Location: `src/webview/kanban.html` lines 3864-3879
- Uses simpler inline text change with setTimeout — same class of issue but less severe (no color changes)

## Solution

Replace inline style changes with CSS class-based animations for card copy prompt buttons. Also define the missing `.flash` CSS animation for `flashIconBtn()` so column buttons get proper visual feedback too.

### Implementation Steps

1. **Add CSS animation for card copy button feedback**
   - File: `src/webview/kanban.html` — `<style>` section (after line ~565, near other `.card-btn` styles)
   - Add `@keyframes copyFlash` animation: green background → fade back to default
   - Add `.card-btn.copy.copied` class with the animation and success state styles
   - Add `.flash` CSS class with a simple scale/opacity pulse animation (currently missing — `flashIconBtn()` is a no-op without it)

2. **Update card copy button click handler**
   - File: `src/webview/kanban.html` lines 3812-3834
   - Replace inline style changes with CSS class additions
   - Use `btn.classList.add('copied')` instead of `btn.style.backgroundColor` / `btn.style.color`
   - Remove `dataset.originalText/originalBg/originalColor` storage (no longer needed)
   - Keep `btn.disabled = true` and `btn.textContent = 'Copied!'` (text change is fine — it gets wiped by re-render anyway, which is expected)

3. **Update `copyPlanLinkResult` handler**
   - File: `src/webview/kanban.html` lines 4782-4823
   - Replace inline style reverts with CSS class removal
   - Use `btn.classList.remove('copied')` instead of restoring inline styles
   - Remove references to `dataset.originalBg/originalColor` — no longer needed
   - For the timeout revert: `btn.textContent = 'Copy Prompt'` (or derive from button default), `btn.classList.remove('copied')`, `btn.disabled = false`
   - Remove `copyTimeoutId` tracking (CSS animation handles its own lifecycle via `animationend`)

4. **Test the fix**
   - Verify no graphical flash when clicking card copy buttons
   - Verify visual feedback still works correctly
   - Verify card advancement still functions properly
   - Verify column icon buttons now show visible flash feedback (bonus fix)

### Files to Modify

- `src/webview/kanban.html`:
  - Add CSS animation and class styles (in `<style>` section, after line ~565)
  - Add `.flash` CSS class animation (currently missing — fixes `flashIconBtn()` no-op)
  - Update `.card-btn.copy` event handler (around line 3812)
  - Update `copyPlanLinkResult` message handler (around line 4782)

## Expected Outcome

After this fix:
- Card copy prompt buttons will show visual feedback without graphical flash
- The feedback will use CSS animations that survive DOM re-renders
- User experience will be consistent between card-level and column-level copy buttons
- Column icon buttons will also gain visible flash feedback (fixing the existing `flashIconBtn()` no-op)

## User Review Required
- Confirm that the CSS animation style (green flash → fade) matches desired UX
- Confirm whether `copy-gather` buttons (lines 3864-3879) should also be updated to use CSS classes for consistency

## Complexity Audit

### Routine
- Adding CSS `@keyframes` and class rules to the `<style>` section — follows existing patterns (see `@keyframes dropPulse` at line 596, `@keyframes cardComplete` at line 605)
- Replacing `btn.style.X = ...` with `btn.classList.add('copied')` — straightforward class swap
- Removing `dataset.originalText/originalBg/originalColor` storage — simple deletion
- Adding the missing `.flash` CSS class — trivial CSS addition

### Complex / Risky
- None — all changes are localized to a single file with well-understood patterns

## Edge-Case & Dependency Audit

- **Race Conditions**: If `renderBoard()` fires before `copyPlanLinkResult` arrives, the button DOM element is replaced. The current code uses `document.querySelector` to find the button by `data-plan-id`, which will find the NEW element. With CSS classes, the new element won't have the `.copied` class, so the handler will add it to the fresh button — this is correct behavior and eliminates the flash.
- **Security**: No security implications — purely visual feedback changes.
- **Side Effects**: The `.flash` CSS class addition will make ALL column icon buttons show visible feedback for the first time. This is a positive side effect but should be verified visually.
- **Dependencies & Conflicts**: The `copy-gather` buttons (lines 3864-3879) use a similar inline-style pattern. They don't cause a visible flash because they don't trigger card advancement, but they could be updated for consistency. No other dependencies.

## Dependencies
None

## Adversarial Synthesis
The plan's original root cause analysis contained a factual error: it claimed column-level buttons use "CSS animations defined in stylesheets," but no `.flash` CSS class exists — `flashIconBtn()` is a visual no-op. The real reason column buttons don't flash is that their DOM elements survive `renderBoard()` rebuilds. The core fix (CSS classes instead of inline styles) is still correct, but the missing `.flash` animation must also be added. The `copyPlanLinkResult` handler's fallback logic for missing `dataset.*` values on re-created elements is a secondary bug that CSS classes eliminate entirely.

## Proposed Changes

### `src/webview/kanban.html` — `<style>` section (after line ~565)

- **Context**: Existing `.card-btn` styles end at line 565. Existing `@keyframes` patterns at lines 596-614 show the convention.
- **Logic**: Add two new CSS constructs:
  1. `@keyframes copyFlash` — animates from green success state back to default
  2. `.card-btn.copy.copied` — applies the animation with green background, white text
  3. `.flash` — simple scale/opacity pulse for `flashIconBtn()` (currently undefined)
- **Implementation**:
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

  /* Column Icon Button Flash (was missing — flashIconBtn() was a no-op) */
  @keyframes iconFlash {
      0% { transform: scale(1); }
      50% { transform: scale(1.2); opacity: 0.7; }
      100% { transform: scale(1); opacity: 1; }
  }
  .column-icon-btn.flash {
      animation: iconFlash 0.3s ease-out forwards;
  }
  ```
- **Edge Cases**: The `pointer-events: none` on `.copied` prevents double-clicks during animation. The `forwards` fill mode ensures the animation ends at the default state.

### `src/webview/kanban.html` — Card copy button handler (lines 3812-3834)

- **Context**: Currently stores original styles in `dataset` and applies inline styles optimistically.
- **Logic**: Replace inline style manipulation with CSS class toggle. Remove `dataset` storage.
- **Implementation**:
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
- **Edge Cases**: If `renderBoard()` fires before the response, the button is destroyed and a fresh one created without `.copied` — the `copyPlanLinkResult` handler will add the class to the new element, providing clean feedback.

### `src/webview/kanban.html` — `copyPlanLinkResult` handler (lines 4782-4823)

- **Context**: Currently restores inline styles from `dataset.*` which may not exist on re-created elements.
- **Logic**: Replace inline style reverts with CSS class removal. Remove `dataset` references and `copyTimeoutId`.
- **Implementation**:
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

              // Revert after animation completes
              btn.addEventListener('animationend', function handler() {
                  btn.textContent = 'Copy Prompt';
                  btn.classList.remove('copied');
                  btn.disabled = false;
                  btn.removeEventListener('animationend', handler);
              });
          } else {
              // Instant revert on error
              btn.textContent = 'Copy Prompt';
              btn.classList.remove('copied');
              btn.disabled = false;
          }
      }
      break;
  }
  ```
- **Edge Cases**: If the animation was already applied optimistically and `renderBoard()` destroyed the element, the new element gets the class added here. The `animationend` listener ensures cleanup. Error path immediately resets to default state.

## Verification Plan

### Automated Tests
- No automated tests exist for this webview UI component. Manual verification required:
  1. Click "Copy Prompt" on a card → verify green flash animation plays, no visual flash/glitch
  2. Click "Copy Prompt" on a card → verify card advances to next column smoothly
  3. Click column icon button → verify visible flash feedback now appears (was previously invisible)
  4. Rapid double-click "Copy Prompt" → verify no double-action (pointer-events: none guard)
  5. Trigger copy failure scenario → verify button reverts to default state immediately

**Recommendation:** Send to Intern
