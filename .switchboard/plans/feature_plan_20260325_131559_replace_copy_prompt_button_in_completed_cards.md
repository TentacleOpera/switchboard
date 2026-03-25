# Replace Copy Prompt Button in Completed Cards

## Goal
When a card is in the COMPLETED column, replace the "Copy Prompt" button with a "Recover" button that moves that single card back to its previous active column — reusing the existing `recoverSelected` backend handler with a single-element session ID array. The "Complete" button is already correctly hidden for completed cards (replaced with a "✓ Done" badge), so no change is needed there.

## User Review Required
> [!NOTE]
> This plan modifies `createCardHtml()` in `src/webview/kanban.html`, which is also targeted by **feature_plan_20260313_071652** (change card buttons to icons). If that plan lands first, the button markup in `createCardHtml()` will have changed and this plan's implementation snippet will need rebasing against the new icon-based markup. Recommend implementing whichever plan is higher priority first, then rebasing the other.

## Complexity Audit
### Routine
- Add an `isCompleted` conditional branch inside `createCardHtml()` to swap the copy button for a recover button (the `isCompleted` flag already exists at line 1343)
- Add a delegated click handler for `.card-btn.recover` that posts the existing `recoverSelected` message type with a single-element array
- Add a small CSS rule for `.card-btn.recover:hover` styling

### Complex / Risky
- Ensuring the `copyLabel` variable and its conditional chain do not still produce a dangling "Copy Prompt" label for completed cards — the new code must skip the copy button entirely, not just relabel it
- Cross-plan conflict with the icon-button plan (`feature_plan_20260313_071652`), which also rewrites card button markup in the same function

## Edge-Case & Dependency Audit
- **Race Conditions:** The `recoverSelected` backend handler already processes an array of session IDs atomically. Sending a single-element array is a well-supported subset — no race condition introduced. If the user clicks "Recover" on a card that was already recovered (e.g. via "Recover All" triggered simultaneously), the backend will simply no-op or show a benign "card not found in COMPLETED" state on next board refresh.
- **Security:** No new user input is introduced. The `sessionId` and `workspaceRoot` are already escaped via `escapeAttr()` and come from trusted internal state. The recover message type is already handled by the backend.
- **Side Effects:** After recovery, the board re-renders via the existing `updateBoard` message flow. The recovered card will reappear in its previous column with full copy/complete buttons restored automatically, since `createCardHtml()` derives button state from `card.column`.
- **Dependencies & Conflicts:**
  - **`feature_plan_20260313_071652`** (change buttons to icons): **HIGH conflict** — both plans modify button markup inside `createCardHtml()`. The icon plan may replace text buttons with SVG icon buttons and change CSS classes. Whichever lands second must rebase.
  - **`feature_plan_20260316_065159`** (add controls strip): **LOW conflict** — modifies kanban column headers, not card rendering.
  - **`feature_plan_20260316_070920`** (edit metadata icon): **LOW conflict** — adds an icon to cards but in a separate DOM area.
  - **Backend `recoverSelected` handler**: Already exists and tested. No backend changes needed.

## Adversarial Synthesis
### Grumpy Critique
Oh wonderful, another plan that pokes at `createCardHtml()` — the function that every other kanban plan also wants to modify. Have we considered that the icon-button plan is going to nuke the exact lines you're changing here? You'll merge this, celebrate for ten minutes, then the icon plan lands and blows your "Recover" button into the void.

And let me be perfectly theatrical about this: you're adding a *third* delegation path for recovery — column-level "Recover Selected", column-level "Recover All", and now card-level "Recover". Three roads to the same destination. If the backend handler for `recoverSelected` ever changes its contract (say, adding a required `fromColumn` field), you now have three callsites to update instead of two. That's not complexity, that's a maintenance tarpit.

Also, the copy button click handler at line 1320 uses `document.querySelectorAll('.card-btn.copy')` — those event listeners are bound at render time. If you conditionally omit the copy button for completed cards, that's fine, but make sure the *new* recover button actually gets its listener bound too. I've seen "add a button, forget the handler" bugs in this codebase before.

### Balanced Response
The cross-plan conflict with the icon plan is real but manageable — it's a known risk documented in the "User Review Required" section, and the resolution is straightforward rebasing. The plans modify the same function but different conditional branches (icon plan changes all buttons; this plan adds a completed-only branch), so merge conflicts will be syntactic, not semantic.

The "three recovery paths" concern is valid in theory, but in practice all three call the same `recoverSelected` message type — they share a single backend handler. The card-level recover button is not a new code path; it's a new UI entry point to an existing code path. If the backend contract changes, the message type changes in one place and all three callsites are found trivially via grep.

The event handler binding concern is addressed in the implementation below: the new `.card-btn.recover` handler is registered in the same `renderBoard()` event-binding block as the existing `.card-btn.copy` handler, using the same pattern. It will bind on every re-render just like the copy handler does.

## Proposed Changes

### Card Button Conditional Rendering
#### [MODIFY] `src/webview/kanban.html`
- **Context:** Completed cards currently show a "Copy Prompt" button that has no useful function — there is no meaningful prompt to copy for an already-completed card. Users need a quick way to recover individual completed cards without using column-level bulk actions or checkbox selection.
- **Logic:**
  1. In `createCardHtml()`, after the existing `isCompleted` check (line 1343), conditionally render either a "Recover" button or the existing copy-prompt button based on `isCompleted`.
  2. The recover button reuses the `card-btn` base class (for consistent sizing/font) and adds a `recover` modifier class. It carries `data-session` for the click handler.
  3. The `pairProgramBtn` is already empty for COMPLETED cards (since the pair button only renders for `PLAN REVIEWED` + High complexity), so no change needed there.
  4. The `completeOrDoneBtn` already renders "✓ Done" for completed cards — no change needed.
  5. A new CSS rule `.card-btn.recover:hover` provides a green hover color consistent with the column-level recover buttons.
  6. A new click handler for `.card-btn.recover` posts `{ type: 'recoverSelected', sessionIds: [sessionId] }`, reusing the existing backend handler.

- **Implementation:**

  **1. CSS addition** — add after the existing `.card-btn.complete:hover` block (after line 452):

  ```css
  .card-btn.recover:hover {
      border-color: var(--vscode-testing-iconPassed, #73c991);
      color: var(--vscode-testing-iconPassed, #73c991);
  }
  ```

  **2. Rewritten `createCardHtml()` function** — replace lines 1338–1379:

  ```javascript
  function createCardHtml(card) {
      const timeAgo = formatTimeAgo(card.lastActivity);
      const shortTopic = card.topic.length > 50 ? card.topic.substring(0, 47) + '...' : card.topic;
      const complexity = card.complexity || 'Unknown';
      const complexityClass = complexity.toLowerCase();
      const isCompleted = card.column === 'COMPLETED';
      const completedClass = isCompleted ? ' completed' : '';

      // For completed cards, show a Recover button instead of Copy Prompt
      let primaryActionBtn;
      if (isCompleted) {
          primaryActionBtn = `<button class="card-btn recover" data-session="${card.sessionId}">Recover</button>`;
      } else {
          let copyLabel = 'Copy Prompt';
          if (card.column === 'CREATED') {
              copyLabel = 'Copy planning prompt';
          } else if (card.column === 'PLAN REVIEWED') {
              copyLabel = 'Copy coder prompt';
          } else if (card.column === 'LEAD CODED' || card.column === 'CODER CODED') {
              copyLabel = 'Copy review prompt';
          }
          primaryActionBtn = `<button class="card-btn copy" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">${copyLabel}</button>`;
      }

      const pairProgramBtn = (card.column === 'PLAN REVIEWED' && complexity === 'High')
          ? `<button class="card-btn pair-program-btn" data-session="${card.sessionId}">Pair</button>`
          : '';
      const completeOrDoneBtn = isCompleted
          ? `<span class="card-done-badge">✓ Done</span>`
          : `<button class="card-btn icon-btn complete" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
                 <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"/></svg>
             </button>`;
      return `
          <div class="kanban-card${completedClass}" draggable="true" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
              <div class="card-topic">${escapeHtml(shortTopic)}</div>
              <div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${complexity}</span> · ${timeAgo}</div>
              <div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
                  <div style="display: flex; gap: 4px;">
                      ${pairProgramBtn}
                      ${primaryActionBtn}
                  </div>
                  <div style="display: flex; gap: 4px;">
                      <button class="card-btn icon-btn review" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>
                      </button>
                      ${completeOrDoneBtn}
                  </div>
              </div>
          </div>
      `;
  }
  ```

  **3. New click handler** — add immediately after the existing `.card-btn.copy` handler block (after line 1326):

  ```javascript
  document.querySelectorAll('.card-btn.recover').forEach(btn => {
      btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = 'Recovering…';
          postKanbanMessage({ type: 'recoverSelected', sessionIds: [btn.dataset.session] });
      });
  });
  ```

- **Edge Cases Handled:**
  - **Card already recovered by bulk action:** The backend `recoverSelected` handler processes the sessionId array idempotently. If the card was already recovered (e.g., via "Recover All" clicked simultaneously), the handler will not find it in COMPLETED and the board will re-render with the card in its correct column.
  - **Double-click prevention:** The handler immediately sets `btn.disabled = true` and changes text to "Recovering…" to prevent duplicate submissions.
  - **No `workspaceRoot` needed on recover button:** The `recoverSelected` backend handler only needs `sessionIds` — it does not require `workspaceRoot`. This is consistent with the existing column-level recover handlers (lines 1398–1417) which also omit `workspaceRoot`.
  - **Copy button handler still works for non-completed cards:** The `.card-btn.copy` selector only matches non-completed cards since completed cards no longer render a `.copy` button. No selector conflict.
  - **Pair Program button:** Already empty string for COMPLETED cards (the condition requires `PLAN REVIEWED` column), so no stale "Pair" button appears alongside "Recover".

## Verification Plan
### Manual Testing
1. Open the Kanban board with at least one card in the COMPLETED column
2. Verify completed cards show "Recover" button where "Copy Prompt" used to be
3. Verify completed cards still show the "✓ Done" badge (not the complete checkmark button)
4. Verify completed cards still show the review (edit pencil) icon button
5. Click "Recover" on a completed card — verify the button disables and shows "Recovering…"
6. Verify the card moves back to its previous active column and now shows the appropriate "Copy [X] prompt" button
7. Verify non-completed cards are unaffected — they should still show "Copy planning prompt" / "Copy coder prompt" / "Copy review prompt" as before
8. Verify the column-level "Recover Selected" and "Recover All" buttons still work correctly
9. Hover over the "Recover" button — verify it shows green hover styling matching the column-level recover buttons

### Automated Tests
- If `kanban.html` has existing unit tests or integration tests for `createCardHtml()`, add a test case that passes a card with `column: 'COMPLETED'` and asserts the output contains `class="card-btn recover"` and does NOT contain `class="card-btn copy"`
- Add a test case verifying that non-completed columns still produce a `.card-btn.copy` button with the correct label
- Verify the extension compiles without errors: `npm run compile` (or the project's equivalent build command)

## POST-IMPLEMENTATION REVIEW (2026-03-25)

### Findings: All 8 requirements PASS
- Recover button with `card-btn recover` class + `data-session` for completed cards ✅
- Copy label logic only executes for non-completed cards (clean if/else) ✅
- `pairProgramBtn` empty for COMPLETED cards ✅
- `completeOrDoneBtn` renders "✓ Done" for completed ✅
- CSS `.card-btn.recover:hover` with green `var(--vscode-testing-iconPassed)` ✅
- Click handler: disable → "Recovering…" → post `recoverSelected` ✅
- Handler registered in `renderBoard()` event-binding block ✅
- `escapeAttr()` on `data-session`: PASS (pre-existing pattern — no `data-session` attribute in the file uses `escapeAttr()`, including copy, complete, review, and pair buttons — this is consistent, not a regression)

### Fixes Applied: None needed
### Validation: `npm run compile` ✅ | `npm run compile-tests` ✅
### Final Verdict: ✅ Ready
