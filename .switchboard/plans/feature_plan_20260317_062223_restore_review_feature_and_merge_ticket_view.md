# Refine ticket view.

## Goal
The ticket view is OK but still needs improvements.

1. Topic field is useless, remove it
2. The dependnecies field takes up way too much space and is hard to use because the user needs to match the topic names exactly from memory. The notion of allowing dependencies is good, but it should be more like a button to open a modal where you can add dependenies from a list of open plans. 
3. The action log needs to be in a modal that can be opened with a button at the top next to the reload and save buttons. 
4. The plan text field starts on the wrong side - it needs to start on the review side 
5. When on the edit side, the button to switch to review needs to say 'Review plan' not 'Preview'.
6. When on the review side, the header needs to not say 'plan text'. Instead it should say 'Review plan - select text and submit comment to send to planner agent
7. When on the edit side, the header needs to not say 'plan text'. Instead it should say 'Edit plan - use Ctrl/Cmd+S to save changes'
8. There should be no save instruction next to the switch mode button on the right, as that text will be moved into the panel header for the edit side, and is useless for the review side
9. there needs to be a copy plan link button at the top near the reload and save buttons

## Source Analysis

**Ticket view file:** `src/webview/review.html`

Current layout (from HTML structure, lines 393–461):
- **Header** (line 394–403): eyebrow "Ticket View", title, path, actions = [Reload, Save]
- **Meta grid** (line 406–427): Topic input, Column select, Complexity select, Dependencies input (span 4)
- **Editor shell** (line 429–438): toolbar with "Plan Text" title + "Use Ctrl/Cmd+S to save changes" hint + "Preview" button, textarea editor, markdown preview div
- **Log shell** (line 441–446): `<details open>` with "Action Log" summary and log list
- **Statusbar** (line 448–451): status message + mtime
- **Comment popup** (line 453–461): for review-mode text selection commenting

**State object** (line 485–498): `isPreview: false` — defaults to edit mode (textarea visible, markdown hidden).

**Toggle logic** (will be in JS below line 498): toggles `isPreview` state, swaps `.active` class between editor and markdown-body, updates button text.

**Backend ReviewProvider** in `src/services/ReviewProvider.ts` (referenced by `switchboard.reviewPlan` command): opens the ticket panel with session data.

## Proposed Changes

### Change 1: Remove Topic field (Routine)
**File:** `src/webview/review.html` (lines 407–410)
- Delete the `<div class="field">` containing `topic-input`.
- The title is already shown in the header `<h1>` element. Topic is redundant.
- Update `meta-grid` to `grid-template-columns: repeat(2, minmax(0, 1fr))` since one field is removed.
- Also remove the `topicInputEl` JS reference and any save logic that reads from it.

### Change 2: Replace dependencies input with modal button (Moderate)
**File:** `src/webview/review.html` (lines 423–426)
- Replace the `<input id="dependencies-input">` with a button: `<button id="open-deps-modal">Manage Dependencies</button>` and a count badge.
- Add a new dependencies modal (similar to comment-popup structure):
  - List all open plans (fetched from backend via `postMessage({ type: 'getOpenPlans' })`).
  - Checkboxes next to each plan topic.
  - "Save" closes modal and updates dependencies state.
- **File:** `src/services/ReviewProvider.ts` — add handler for `getOpenPlans` that returns active plan topics/sessionIds from the kanban DB or session logs.

### Change 3: Move action log to modal (Routine)
**File:** `src/webview/review.html` (lines 441–446)
- Remove the `<div class="log-shell">` section from the main body grid.
- Add a "Log" button to `header-actions` (next to Reload and Save).
- Add a modal overlay (similar to comment-popup) that shows the action log content when the Log button is clicked.
- Update `body` grid-template-rows to remove the log row: `grid-template-rows: auto auto minmax(0, 1fr) auto;`

### Change 4: Default to review/preview mode (Routine)
**File:** `src/webview/review.html` (line 497)
- Change `isPreview: false` to `isPreview: true` as the default.
- On initial load, ensure the markdown preview is shown and the editor is hidden.
- Note: Plan 7 (create new ticket) will override this to `isPreview: false` when opening a new empty ticket. This plan sets the default for existing tickets.

### Change 5: Rename "Preview" button to "Review Plan" / "Edit Plan" (Routine)
**File:** `src/webview/review.html` (line 434)
- When `isPreview === false` (edit mode): button text = `"Review Plan"`.
- When `isPreview === true` (review mode): button text = `"Edit Plan"`.
- Update the toggle handler to swap button text accordingly.

### Change 6: Update editor toolbar title based on mode (Routine)
**File:** `src/webview/review.html` (line 431)
- When in review mode: `.editor-title` = `"Review Plan — select text and submit comment to send to planner agent"`.
- When in edit mode: `.editor-title` = `"Edit Plan — use Ctrl/Cmd+S to save changes"`.
- Update the toggle handler to swap this text.

### Change 7: Remove save hint from toolbar right side (Routine)
**File:** `src/webview/review.html` (line 433)
- Remove `<div class="editor-hint">Use Ctrl/Cmd+S to save changes</div>`.
- The hint is now embedded in the `.editor-title` for edit mode and irrelevant for review mode.

### Change 8: Add "Copy Plan Link" button to header (Routine)
**File:** `src/webview/review.html` (lines 400–403)
- Add a button in `header-actions`: `<button id="copy-plan-link">Copy Link</button>`.
- On click, `postMessage({ type: 'copyPlanLink', sessionId: state.sessionId })`.
- **File:** `src/services/ReviewProvider.ts` — handle `copyPlanLink` by copying the plan file path to clipboard (reuse existing clipboard logic from kanban).

## Dependencies
- **Plan 7 (open plans should open ticket):** That plan needs the ticket view to accept an `initialMode: 'edit'` parameter. This plan sets the default to review mode — Plan 7 overrides it for new tickets. No conflict if both are aware.
- **Plan 11 (add move controls to ticket view):** Adds buttons to the ticket header. Coordinate header layout — both add buttons to `header-actions`.
- No blocking dependencies.

## Verification Plan
1. Open an existing ticket → confirm it starts in **review mode** (markdown rendered, not textarea).
2. Click "Edit Plan" → confirm switch to edit mode with textarea.
3. Confirm toolbar title says "Edit Plan — use Ctrl/Cmd+S to save changes".
4. Click "Review Plan" → confirm switch back. Title says "Review Plan — select text and submit comment...".
5. Confirm no "Use Ctrl/Cmd+S" hint appears next to the mode button.
6. Confirm Topic field is gone from meta grid.
7. Click "Manage Dependencies" → confirm modal shows list of open plans with checkboxes.
8. Click "Log" button → confirm action log appears in a modal overlay.
9. Click "Copy Link" → confirm plan path is copied to clipboard.
10. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- Remove Topic field (~5 lines HTML + ~3 lines JS).
- Move action log to modal (~20 lines HTML restructure).
- Default to preview mode (~1 line).
- Rename button and toolbar titles (~10 lines).
- Remove save hint (~1 line).
- Add copy link button (~5 lines HTML + ~5 lines JS).

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "9 changes in one plan. This is a UI overhaul, not a refinement." → Valid in scope, but each change is small and isolated to `review.html`. No architectural risk.
- "The dependencies modal needs to fetch open plans — what if there are 200 plans? Performance?" → Paginate or limit to 50 most recent. Show a search/filter input.
- "Removing the topic field — what if the backend save logic expects it?" → Check `ReviewProvider.ts` save handler; ensure it gracefully handles a missing topic (falls back to header title or plan filename).
- "Defaulting to review mode — what about the initial state message from the backend that might override this?" → The backend sends `ticketData` which may include the plan text. Verify the initial render respects `isPreview: true` after receiving data.

### Balanced Synthesis
- All 9 changes are safe to batch — they're all in `review.html` with minor backend touchpoints.
- The dependencies modal is the only moderate-complexity item. Keep it simple: flat list, no nesting, max 50 plans.
- Ensure the `save` handler doesn't break when topic input is removed. Use the header title text as the topic source.
- Test the initial render flow carefully: backend sends data → webview receives → render in correct mode.

## Agent Recommendation
Send it to the **Coder agent** — these are 9 small, well-scoped UI changes in a single file with one moderate backend addition (dependencies modal data source).

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The implementation successfully restored the review-mode workflow inside the merged ticket view: existing tickets now default to review mode, the toolbar copy is mode-aware, the action log lives in a modal, dependencies are managed through a modal populated from open plans, and the header includes the requested copy-link action.
- One material defect remained: the redundant metadata-grid title field had reappeared. That violated this plan’s explicit "Topic field is useless, remove it" requirement and duplicated the header title area, making the merged review/ticket UI regress back toward the clutter this plan was meant to remove.

### Fixed Items
- Removed the redundant metadata-grid title field from `review.html`.
- Moved editable title handling into the header area so the merged ticket view stays aligned with this plan while preserving later title-rename-on-save behavior.
- Updated the review ticket regression test to enforce the new header-title editing path and ensure the old `topic-input` field does not return.

### Files Changed During Reviewer Pass
- `src/webview/review.html`
- `src/test/review-ticket-title-regression.test.js`

### Validation Results
- `npm run compile` ✅ Passed.
- `node src\test\review-ticket-title-regression.test.js` ✅ Passed.
- `rg "topic-input" src` ✅ Only the regression test references the removed field.
- `npm run lint` was not rerun for this pass because repository linting remains blocked by the pre-existing ESLint 9 configuration issue (`eslint.config.*` missing).

### Remaining Risks
- There is still no browser-level end-to-end test that exercises the full merged panel behavior across review mode, edit mode, dependency modal, log modal, and copy-link actions in one flow.
- The header now owns title editing in edit mode. That is cleaner than the old metadata field, but future review-panel work should avoid reintroducing a second title control elsewhere in the layout.

### Final Reviewer Assessment
- Ready. The merged review/ticket view now satisfies the plan requirements again, and the redundant title-field regression has been corrected and verified.
