# Add Review Button to Planning Kanban Plan Previews

## Goal
Add a Review button to the kanban plan preview pane in planning.html that mirrors the review/comment functionality from review.html, enabling users to select text in plan previews and submit contextual comments to the planner agent.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 5

## User Review Required
- Confirm that review comments from the kanban pane should use the same `switchboard.sendReviewComment` command as review.html (reusing the existing terminal dispatch pipeline).
- Confirm whether the Review button should appear disabled when no plan is selected (same as Edit button behavior) — assumed yes.

## Complexity Audit

### Routine
- Adding a `strip-btn` button to the existing kanban controls strip (HTML + 1 event listener)
- Adding comment popup HTML and CSS (copy/adapt from review.html)
- Adding `sessionId` to `_getKanbanPlans` mapping (1-line backend change)
- Adding `submitComment` case to PlanningPanelProvider (reuse existing `switchboard.sendReviewComment` command)
- Adding `commentResult` message handler to planning.js message switch
- Button enable/disable logic mirrors existing Edit button pattern

### Complex / Risky
- Mutual exclusion between edit mode and review mode requires extending `enterEditMode`/`exitEditMode` functions that are shared between local and kanban tabs — must not break local-doc edit flow
- `_kanbanSelectedPlan` currently lacks `sessionId`; adding it to the backend mapping changes the wire format of `kanbanPlansReady` messages — any downstream consumer must tolerate the new field

## Edge-Case & Dependency Audit

- **Race Conditions:** Submitting a comment while the plan file is being saved could send stale context. Mitigation: disable Review button while in edit mode (mutual exclusion), and exit review mode before entering edit mode.
- **Security:** `submitComment` sends `selectedText` and `comment` to the extension host, which dispatches to a terminal. The existing `switchboard.sendReviewComment` command already sanitizes via `sendRobustText`. No new attack surface.
- **Side Effects:** Adding `sessionId` to `_getKanbanPlans` return objects increases the payload of `kanbanPlansReady` messages. The field is small (UUID string) and the JS consumer ignores unknown fields — no breaking change.
- **Dependencies & Conflicts:** The `switchboard.sendReviewComment` command is defined in extension.ts (line 1988) and used by ReviewProvider.ts (line 268). PlanningPanelProvider will call the same command — no conflict, both providers can invoke it concurrently.

## Dependencies
- None (all required infrastructure — `switchboard.sendReviewComment`, `ReviewCommentRequest`/`ReviewCommentResult` types, comment popup pattern — already exists)

## Adversarial Synthesis
Key risks: (1) The original plan targeted the wrong JS file — all logic must go into `planning.js`, not inline in the HTML. (2) `_kanbanSelectedPlan` lacks `sessionId`, requiring a backend mapping change. (3) Mutual exclusion between edit and review modes must extend shared `enterEditMode`/`exitEditMode` without breaking the local-doc tab. Mitigations: JS file correction is straightforward; sessionId is a 1-line addition; mutual exclusion is handled by adding a `reviewMode.kanban` flag and calling `exitReviewMode` from `enterEditMode` and vice versa.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
- **Context:** The `_getKanbanPlans` method (line 2535) maps kanban DB records to plan summary objects sent to the webview. It currently omits `sessionId`.
- **Logic:** Add `sessionId: r.sessionId || ''` to the mapped object at line 2540 (inside the `records.map()` callback).
- **Implementation:**
  ```typescript
  // Line ~2540, inside records.map((r: any) => ({ ... }))
  return records.map((r: any) => ({
      planId: r.planId,
      sessionId: r.sessionId || '',   // <-- ADD THIS LINE
      topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
      // ... rest unchanged
  }));
  ```
- **Edge Cases:** If a legacy DB record lacks `sessionId`, the fallback `''` prevents undefined. The `submitComment` handler in ReviewProvider already tolerates missing sessionId (it's optional in `ReviewCommentRequest`).

### `src/services/PlanningPanelProvider.ts` (submitComment handler)
- **Context:** The `_handleMessage` switch statement (lines 537-1136) routes webview messages. There is no `submitComment` case. ReviewProvider.ts (line 241) has a working implementation that calls `switchboard.sendReviewComment`.
- **Logic:** Add a `case 'submitComment'` that mirrors ReviewProvider's handler, validating inputs and invoking the same command.
- **Implementation:**
  ```typescript
  case 'submitComment': {
      try {
          const selectedText = typeof msg?.selectedText === 'string' ? msg.selectedText.trim() : '';
          const comment = typeof msg?.comment === 'string' ? msg.comment.trim() : '';
          const planFileAbsolute = typeof msg?.planFileAbsolute === 'string' ? msg.planFileAbsolute.trim() : '';

          if (!selectedText) {
              throw new Error('Please select text before submitting a comment.');
          }
          if (!comment) {
              throw new Error('Please enter a comment before submitting.');
          }

          const { ReviewCommentRequest, ReviewCommentResult } = require('./ReviewProvider');
          const request: ReviewCommentRequest = {
              sessionId: msg.sessionId || '',
              topic: msg.topic || '',
              planFileAbsolute,
              selectedText,
              comment
          };

          const result = await vscode.commands.executeCommand<ReviewCommentResult>(
              'switchboard.sendReviewComment',
              request
          );

          const normalizedResult = result && typeof result.ok === 'boolean'
              ? result
              : { ok: false, message: 'Review comment dispatch failed (no response).' };

          this._panel?.webview.postMessage({ type: 'commentResult', ...normalizedResult });
      } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this._panel?.webview.postMessage({ type: 'commentResult', ok: false, message });
      }
      break;
  }
  ```
- **Edge Cases:** If `planFileAbsolute` is empty, the `sendReviewComment` command will fail gracefully. The try/catch ensures the webview always receives a `commentResult` response.

### `src/webview/planning.html` (Review button)
- **Context:** The kanban controls strip (lines 1651-1670) contains `btn-edit-kanban` at line 1667, followed by Save/Cancel buttons.
- **Logic:** Add a Review button after `btn-edit-kanban`, before Save/Cancel. It follows the same `strip-btn` pattern and is disabled by default.
- **Implementation:**
  ```html
  <!-- Line 1667: after btn-edit-kanban, before btn-save-kanban -->
  <button id="btn-review-kanban" class="strip-btn" disabled title="Review plan - select text and submit comment to planner">Review</button>
  ```
- **Edge Cases:** None — the button is inert until JS wires it up.

### `src/webview/planning.html` (Comment popup)
- **Context:** The closing `</body>` tag is at line 1686. Add the popup before it.
- **Logic:** Copy the popup structure from review.html (lines 628-636) with `kanban-` prefixed IDs to avoid collisions.
- **Implementation:**
  ```html
  <!-- Before </body> (line 1686) -->
  <div class="comment-popup" id="kanban-comment-popup">
      <div class="popup-label">Comment on selection</div>
      <div class="selected-preview" id="kanban-selected-preview"></div>
      <textarea id="kanban-comment-input" placeholder="Add your contextual feedback..."></textarea>
      <div class="popup-actions">
          <button id="kanban-cancel-comment">Cancel</button>
          <button class="primary" id="kanban-submit-comment">Submit Comment</button>
      </div>
  </div>
  ```

### `src/webview/planning.html` (Comment popup CSS)
- **Context:** The `<style>` section spans lines ~9-1600. Add popup styles near the existing kanban styles (after line ~1405). **CRITICAL:** Use planning.html's CSS variables (`--panel-bg`, `--text-primary`, `--border-color`), NOT review.html's variables (`--panel`, `--border`, `--muted`).
- **Logic:** Adapt review.html's comment popup CSS (lines 350-404) to use planning.html's variable names.
- **Implementation:**
  ```css
  .comment-popup {
      position: fixed;
      z-index: 999;
      width: min(420px, calc(100vw - 24px));
      background: var(--panel-bg, #1e1e2e);
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      border-radius: 6px;
      padding: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      display: none;
  }
  .comment-popup.visible {
      display: block;
  }
  .popup-label {
      font-size: 11px;
      color: var(--text-secondary, #888);
      margin-bottom: 6px;
      font-family: var(--font-mono, monospace);
  }
  .selected-preview {
      font-size: 12px;
      color: var(--text-primary, #ccc);
      background: rgba(61, 219, 217, 0.08);
      border: 1px solid rgba(61, 219, 217, 0.22);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      max-height: 80px;
      overflow: auto;
  }
  .comment-popup textarea {
      width: 100%;
      min-height: 76px;
      resize: vertical;
      background: var(--input-bg, rgba(255,255,255,0.06));
      color: var(--text-primary, #ccc);
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      border-radius: 4px;
      padding: 8px;
      font-family: var(--font-family, sans-serif);
      font-size: 13px;
      margin-bottom: 10px;
  }
  .popup-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
  }
  .popup-actions button {
      background: transparent;
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      color: var(--text-secondary, #888);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
  }
  .popup-actions button.primary {
      background: var(--accent-teal, #3ddbd9);
      color: #000;
      border-color: var(--accent-teal, #3ddbd9);
  }
  .popup-actions button.primary:hover {
      opacity: 0.85;
  }
  ```
- **Edge Cases:** Fallback values after each `var()` ensure the popup renders even if a variable is undefined.

### `src/webview/planning.js` (State and review mode)
- **Context:** The `state` object is defined at lines 8-27. It has `editMode` and `dirtyFlags` but no review mode tracking.
- **Logic:** Add `reviewMode: { kanban: false }` and `kanbanReviewSelectedText: ''` to the state object.
- **Implementation:**
  ```javascript
  // Line 24, inside state object:
  const state = {
      // ... existing fields ...
      editMode: { local: false, kanban: false },
      editOriginalContent: { local: null, kanban: null },
      dirtyFlags: { local: false, kanban: false },
      reviewMode: { kanban: false },           // <-- ADD
      kanbanReviewSelectedText: ''              // <-- ADD
  };
  ```

### `src/webview/planning.js` (Review mode functions)
- **Context:** The `enterEditMode` (line 2481) and `exitEditMode` (line 2510) functions manage button visibility and pane classes. Review mode needs analogous `enterReviewMode`/`exitReviewMode` functions.
- **Logic:** `enterReviewMode('kanban')` hides the Edit button, shows the Review button as "Exit Review", and sets the state flag. `exitReviewMode('kanban')` restores the Edit button and clears state. Both must handle mutual exclusion with edit mode.
- **Implementation:**
  ```javascript
  function enterReviewMode(tab) {
      if (tab !== 'kanban') return; // Review mode only applies to kanban for now
      if (state.editMode.kanban) {
          exitEditMode('kanban', true);
      }
      state.reviewMode.kanban = true;
      const btnEdit = document.getElementById('btn-edit-kanban');
      const btnReview = document.getElementById('btn-review-kanban');
      if (btnEdit) btnEdit.style.display = 'none';
      if (btnReview) {
          btnReview.textContent = 'EXIT REVIEW';
          btnReview.title = 'Exit review mode';
      }
  }

  function exitReviewMode(tab, clearPopup) {
      if (tab !== 'kanban') return;
      state.reviewMode.kanban = false;
      state.kanbanReviewSelectedText = '';
      if (clearPopup) {
          hideKanbanCommentPopup(true);
      }
      const btnEdit = document.getElementById('btn-edit-kanban');
      const btnReview = document.getElementById('btn-review-kanban');
      if (btnEdit) btnEdit.style.display = '';
      if (btnReview) {
          btnReview.textContent = 'REVIEW';
          btnReview.title = 'Review plan - select text and submit comment to planner';
      }
  }
  ```
- **Edge Cases:** If the user is in edit mode and clicks Review, `exitEditMode('kanban', true)` discards any unsaved edits. This matches the behavior when switching tabs (lines 77-81).

### `src/webview/planning.js` (Comment popup functions)
- **Context:** Review.html defines `showPopup` (line 747) and `hidePopup` (line 739) for the comment popup. Planning.js needs equivalent functions with `kanban-` prefixed element IDs.
- **Implementation:**
  ```javascript
  function hideKanbanCommentPopup(clear) {
      const popup = document.getElementById('kanban-comment-popup');
      if (popup) popup.classList.remove('visible');
      if (clear) {
          const input = document.getElementById('kanban-comment-input');
          if (input) input.value = '';
          state.kanbanReviewSelectedText = '';
      }
  }

  function showKanbanCommentPopup(rect, selectedText) {
      const popup = document.getElementById('kanban-comment-popup');
      if (!popup) return;
      const maxLeft = window.innerWidth - popup.offsetWidth - 12;
      const targetLeft = Math.max(12, Math.min(rect.left, maxLeft > 12 ? maxLeft : rect.left));
      const targetTop = Math.min(window.innerHeight - 12, rect.bottom + 10);
      popup.style.left = `${targetLeft}px`;
      popup.style.top = `${targetTop}px`;
      const preview = document.getElementById('kanban-selected-preview');
      if (preview) preview.textContent = selectedText;
      popup.classList.add('visible');
      const input = document.getElementById('kanban-comment-input');
      if (input) input.focus();
  }
  ```

### `src/webview/planning.js` (Selection and event handlers)
- **Context:** Review.html handles `mouseup` (line 1099) and `mousedown` (line 1103) on the document for text selection. In planning.js, these events should be scoped to `#kanban-preview-content` to avoid interfering with local-doc or other tabs.
- **Implementation:**
  ```javascript
  // After the kanban section variables (after line ~2185)
  const kanbanCommentPopup = document.getElementById('kanban-comment-popup');

  // Text selection in kanban preview — only when review mode is active
  if (kanbanPreviewContent) {
      kanbanPreviewContent.addEventListener('mouseup', () => {
          if (!state.reviewMode.kanban) return;
          setTimeout(() => {
              const selection = window.getSelection();
              if (!selection || selection.rangeCount === 0) {
                  hideKanbanCommentPopup(false);
                  return;
              }
              const text = selection.toString().trim();
              if (!text) {
                  hideKanbanCommentPopup(false);
                  return;
              }
              const range = selection.getRangeAt(0);
              const rect = range.getBoundingClientRect();
              state.kanbanReviewSelectedText = text;
              showKanbanCommentPopup(rect, text);
          }, 0);
      });

      kanbanPreviewContent.addEventListener('mousedown', (event) => {
          if (!state.reviewMode.kanban) return;
          if (kanbanCommentPopup && !kanbanCommentPopup.contains(event.target)) {
              const selection = window.getSelection();
              const selectedText = selection ? selection.toString().trim() : '';
              if (!selectedText) {
                  hideKanbanCommentPopup(false);
              }
          }
      });
  }

  // Cancel comment
  const kanbanCancelComment = document.getElementById('kanban-cancel-comment');
  if (kanbanCancelComment) {
      kanbanCancelComment.addEventListener('click', () => hideKanbanCommentPopup(true));
  }

  // Submit comment
  const kanbanSubmitComment = document.getElementById('kanban-submit-comment');
  if (kanbanSubmitComment) {
      kanbanSubmitComment.addEventListener('click', () => {
          const commentInput = document.getElementById('kanban-comment-input');
          const comment = commentInput ? commentInput.value.trim() : '';
          if (!state.kanbanReviewSelectedText) {
              // Show inline error in popup
              const preview = document.getElementById('kanban-selected-preview');
              if (preview) preview.style.borderColor = '#ff6b6b';
              setTimeout(() => { if (preview) preview.style.borderColor = ''; }, 2000);
              return;
          }
          if (!comment) {
              const commentInputEl = document.getElementById('kanban-comment-input');
              if (commentInputEl) {
                  commentInputEl.style.borderColor = '#ff6b6b';
                  setTimeout(() => { commentInputEl.style.borderColor = ''; }, 2000);
              }
              return;
          }
          vscode.postMessage({
              type: 'submitComment',
              sessionId: _kanbanSelectedPlan ? _kanbanSelectedPlan.sessionId : '',
              topic: _kanbanSelectedPlan ? _kanbanSelectedPlan.topic : '',
              planFileAbsolute: _kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : '',
              selectedText: state.kanbanReviewSelectedText,
              comment
          });
      });
  }
  ```

### `src/webview/planning.js` (Review button event handler)
- **Context:** The Edit button handler is at line 2576. Add the Review button handler nearby.
- **Implementation:**
  ```javascript
  const btnReviewKanban = document.getElementById('btn-review-kanban');
  if (btnReviewKanban) {
      btnReviewKanban.addEventListener('click', () => {
          if (state.reviewMode.kanban) {
              exitReviewMode('kanban', true);
          } else {
              enterReviewMode('kanban');
          }
      });
  }
  ```

### `src/webview/planning.js` (Mutual exclusion with edit mode)
- **Context:** `enterEditMode` (line 2481) currently doesn't know about review mode. It must exit review mode before entering edit mode.
- **Implementation:** Add at the start of `enterEditMode`, after line 2485:
  ```javascript
  function enterEditMode(tab) {
      // Exit review mode if active on this tab
      if (tab === 'kanban' && state.reviewMode.kanban) {
          exitReviewMode('kanban', true);
      }
      // ... rest of existing function unchanged
  }
  ```

### `src/webview/planning.js` (commentResult message handler)
- **Context:** The message switch in planning.js (around line 1640+) handles various message types from the extension. Add a `commentResult` case.
- **Implementation:**
  ```javascript
  case 'commentResult': {
      const { ok, message } = msg;
      if (ok) {
          hideKanbanCommentPopup(true);
          // Show success feedback in kanban controls strip
          const kanbanStrip = document.querySelector('.kanban-controls-strip');
          if (kanbanStrip) {
              const feedback = document.createElement('span');
              feedback.textContent = 'Comment sent';
              feedback.style.cssText = 'color: var(--accent-teal, #3ddbd9); font-size: 11px; margin-left: 8px;';
              kanbanStrip.appendChild(feedback);
              setTimeout(() => feedback.remove(), 2000);
          }
      } else {
          // Show error — flash the submit button
          const submitBtn = document.getElementById('kanban-submit-comment');
          if (submitBtn) {
              submitBtn.style.borderColor = '#ff6b6b';
              setTimeout(() => { submitBtn.style.borderColor = ''; }, 2000);
          }
      }
      break;
  }
  ```

### `src/webview/planning.js` (Button state management)
- **Context:** `handleKanbanPlanPreviewReady` (line 2364) enables/disables the Edit button based on plan selection. The Review button needs the same logic.
- **Implementation:** At line 2383, after the Edit button enable/disable logic:
  ```javascript
  const btnReviewKanban = document.getElementById('btn-review-kanban');
  if (btnReviewKanban) {
      btnReviewKanban.disabled = !_kanbanSelectedPlan || !_kanbanSelectedPlan.planFile;
  }
  ```
- **Edge Cases:** When a different plan is selected while in review mode, exit review mode first. Add this check at the top of the plan click handler (line 2260):
  ```javascript
  if (state.reviewMode.kanban) {
      exitReviewMode('kanban', true);
  }
  ```

### `src/webview/planning.js` (Tab switch cleanup)
- **Context:** When switching away from the kanban tab (lines 77-90), edit mode is auto-exited. Review mode needs the same cleanup.
- **Implementation:** After line 89 (`if (state.editMode.kanban && tabName !== 'kanban')`), add:
  ```javascript
  if (state.reviewMode.kanban && tabName !== 'kanban') {
      exitReviewMode('kanban', true);
  }
  ```

## Verification Plan

### Automated Tests
- No new automated tests required (SKIP TESTS directive). Manual verification checklist below.

### Manual Verification Checklist
- [ ] Review button appears next to Edit button in kanban plans tab
- [ ] Review button is disabled when no plan is selected
- [ ] Clicking Review button enables review mode (button text changes to "EXIT REVIEW")
- [ ] Selecting text in plan preview shows comment popup near the selection
- [ ] Comment popup uses planning.html's dark theme (not broken/invisible styling)
- [ ] Submitting comment sends `submitComment` message with correct `sessionId`, `topic`, `planFileAbsolute`, `selectedText`, `comment`
- [ ] Extension processes comment via `switchboard.sendReviewComment` and returns `commentResult`
- [ ] Success feedback ("Comment sent") appears briefly in the controls strip
- [ ] Error feedback flashes the submit button red
- [ ] Cancel button hides popup without submitting
- [ ] Clicking outside popup hides it
- [ ] Clicking "EXIT REVIEW" exits review mode and restores Edit button
- [ ] Clicking Edit while in review mode exits review mode and enters edit mode
- [ ] Clicking Review while in edit mode exits edit mode and enters review mode
- [ ] Switching tabs exits review mode cleanly
- [ ] Selecting a different plan exits review mode cleanly
- [ ] Local docs tab edit flow is unaffected by review mode changes

## Implementation Plan

### 1. Add Review Button to planning.html
**File**: `src/webview/planning.html`

**Location**: In the kanban controls strip, after `btn-edit-kanban` (line 1667)

**Changes**:
- Add `<button id="btn-review-kanban" class="strip-btn" disabled title="Review plan - select text and submit comment to planner">Review</button>` after `btn-edit-kanban`
- Style the button to match existing strip-btn styling
- Add tooltip attribute: `title="Review plan - select text and submit comment to planner"`

### 2. Add Comment Popup Modal to planning.html
**File**: `src/webview/planning.html`

**Location**: Add before the closing `</body>` tag (line 1686)

**Changes**:
- Copy the comment popup structure from review.html (lines 628-636):
  ```html
  <div class="comment-popup" id="kanban-comment-popup">
      <div class="popup-label">Comment on selection</div>
      <div class="selected-preview" id="kanban-selected-preview"></div>
      <textarea id="kanban-comment-input" placeholder="Add your contextual feedback..."></textarea>
      <div class="popup-actions">
          <button id="kanban-cancel-comment">Cancel</button>
          <button class="primary" id="kanban-submit-comment">Submit Comment</button>
      </div>
  </div>
  ```

### 3. Add CSS Styles for Comment Popup
**File**: `src/webview/planning.html`

**Location**: In the `<style>` section, after the kanban-related styles (after line ~1405)

**Changes**:
- Add styles adapted from review.html for comment popup, using planning.html's CSS variables:
  - `.comment-popup` - fixed position, z-index, width, background, border, padding, box-shadow
  - `.comment-popup.visible` - display block
  - `.popup-label` - font size, color, margin, font family
  - `.selected-preview` - font size, color, background, border, padding, max-height, overflow
  - `.comment-popup textarea` - width, min-height, resize, background, color, border, padding, font family, font size, margin
  - `.popup-actions` - flex, justify-content, gap
  - `.popup-actions button` / `.popup-actions button.primary` - button styling

### 4. Add JavaScript State and Functions
**File**: `src/webview/planning.js`

**Location**: In the state object (line 8) and after the kanban section (after line ~2185)

**Changes**:
- Add state variables for review functionality:
  ```javascript
  // Inside state object (line 24):
  reviewMode: { kanban: false },
  kanbanReviewSelectedText: ''
  ```

- Add helper functions:
  - `enterReviewMode(tab)` - enters review mode, exits edit mode if active, hides Edit button, changes Review button text
  - `exitReviewMode(tab, clearPopup)` - exits review mode, restores Edit button, optionally clears popup
  - `showKanbanCommentPopup(rect, selectedText)` - positions and shows popup
  - `hideKanbanCommentPopup(clear)` - hides popup and optionally clears input

- Add event listeners:
  - `mouseup` on kanban-preview-content to trigger selection handling (only in review mode)
  - `mousedown` on kanban-preview-content to hide popup when clicking outside (only in review mode)
  - `kanban-cancel-comment` button click handler
  - `kanban-submit-comment` button click handler
  - `btn-review-kanban` button click handler (toggle review mode)

### 5. Implement Review Mode Toggle
**File**: `src/webview/planning.js`

**Changes**:
- When Review button is clicked:
  - Enable review mode (show comment popup on text selection)
  - Disable edit mode if active
  - Change Review button to "EXIT REVIEW" when active

- When Edit button is clicked:
  - Disable review mode
  - Hide comment popup
  - Enable edit mode as usual

- Mutual exclusion wired into `enterEditMode`:
  - If review mode is active on kanban, call `exitReviewMode('kanban', true)` first

### 6. Wire Up submitComment Message
**File**: `src/webview/planning.js`

**Changes**:
- In the submit-comment click handler, send message to extension:
  ```javascript
  vscode.postMessage({
      type: 'submitComment',
      sessionId: _kanbanSelectedPlan ? _kanbanSelectedPlan.sessionId : '',
      topic: _kanbanSelectedPlan ? _kanbanSelectedPlan.topic : '',
      planFileAbsolute: _kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : '',
      selectedText: state.kanbanReviewSelectedText,
      comment: document.getElementById('kanban-comment-input').value.trim()
  });
  ```

### 7. Add submitComment Handler to PlanningPanelProvider
**File**: `src/services/PlanningPanelProvider.ts`

**Location**: In the `_handleMessage` switch statement (lines 537-1136)

**Changes**:
- Add `case 'submitComment'` that:
  - Validates `selectedText` and `comment` are non-empty
  - Constructs a `ReviewCommentRequest` with `sessionId`, `topic`, `planFileAbsolute`, `selectedText`, `comment`
  - Calls `vscode.commands.executeCommand('switchboard.sendReviewComment', request)`
  - Posts `commentResult` back to the webview with success/error status

### 8. Add sessionId to Kanban Plan Data
**File**: `src/services/PlanningPanelProvider.ts`

**Location**: `_getKanbanPlans` method (line 2540)

**Changes**:
- Add `sessionId: r.sessionId || ''` to the mapped object so the webview has access to the session ID for comment submission

### 9. Add commentResult Handler to planning.js
**File**: `src/webview/planning.js`

**Location**: In the message switch (around line 1640+)

**Changes**:
- Add `case 'commentResult'` that:
  - On success: hides popup, shows "Comment sent" feedback in controls strip
  - On error: flashes submit button red

### 10. Update Button State Management
**File**: `src/webview/planning.js`

**Changes**:
- Enable/disable Review button in `handleKanbanPlanPreviewReady` (same logic as Edit button)
- Exit review mode when selecting a different plan
- Exit review mode when switching tabs

## Testing Checklist
- [ ] Review button appears next to Edit button in kanban plans tab
- [ ] Review button is disabled when no plan is selected
- [ ] Clicking Review button enables review mode
- [ ] Selecting text in plan preview shows comment popup
- [ ] Comment popup appears at correct position near selection
- [ ] Submitting comment sends message to extension
- [ ] Extension successfully processes comment and returns result
- [ ] Cancel button hides popup without submitting
- [ ] Clicking outside popup hides it
- [ ] Review mode and edit mode are mutually exclusive
- [ ] Button states update correctly during operations
- [ ] Styling matches existing kanban dark theme
- [ ] Switching tabs exits review mode cleanly
- [ ] Selecting a different plan exits review mode cleanly
- [ ] Local docs tab edit flow is unaffected

## Files to Modify
1. `src/webview/planning.html` - Add button, popup, and CSS styles
2. `src/webview/planning.js` - Add state, review mode functions, event handlers, message handler
3. `src/services/PlanningPanelProvider.ts` - Add sessionId to plan data, add submitComment handler

## Notes
- The review functionality mirrors the implementation in review.html for consistency
- The comment popup uses planning.html's CSS variables (not review.html's) to match the existing dark theme
- The `submitComment` message reuses the same `switchboard.sendReviewComment` command that ReviewProvider uses
- `sessionId` is optional in `ReviewCommentRequest` — the comment will still be dispatched even if sessionId is empty
- All JavaScript changes go in `planning.js` (the external file), NOT inline in the HTML

## Recommendation
**Send to Coder** — Complexity 5: Multi-file changes across HTML, JS, and TypeScript, but all changes follow existing patterns (edit mode toggle, strip-btn buttons, message handlers). The mutual exclusion logic is the only moderately risky aspect, and it's well-scoped.
