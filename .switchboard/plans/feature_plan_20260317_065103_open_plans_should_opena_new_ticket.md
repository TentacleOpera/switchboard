# Open plans should open a new ticket

When the user creates a new plan (not from airlock), it should automatically create and open a ticket in the kanban 'new' field. Don't go to the send to planner button first, jsut open the ticket in the kanban. It should open the ticket in the edit mode. The send to planner button should be replaced by a open ticket button when the plan is not from the airlock. 

Also - new tickets should default into edit mode. 
Also - when the ticket is saved, the title of the plan file should update to the title in the ticket view.

## Goal
Three changes to the plan creation flow:
1. **Non-airlock plan creation** → skip "Send to Planner", directly create a ticket in the CREATED column and open it in the ticket view (edit mode).
2. **New tickets default to edit mode** — the ticket view opens with the textarea active, not the markdown preview.
3. **File rename on save** — when the user saves a ticket with a new title, rename the plan file on disk to match.

## Source Analysis

**Plan creation modal** in `src/webview/implementation.html` (lines 1386–1398):
```html
<div class="modal-title">Create Plan</div>
<input id="init-plan-title" ...>
<textarea id="init-plan-idea" ...>
<button id="btn-send-planner">SEND TO PLANNER</button>
<button id="btn-save-plan">SAVE PLAN</button>
```

**Modal behavior** (lines 1516–1535):
- `_planModalFromAirlock` flag controls button text.
- When from airlock: "REVIEW PLAN" button.
- When not from airlock: "SEND TO PLANNER" button.

**Plan save logic** (lines 1678–1693):
```js
let mode = action;
if (_planModalFromAirlock) {
    mode = action === 'send' ? 'review' : 'local';
}
postMessage({ type: 'initiatePlan', title, idea, mode, isAirlock: _planModalFromAirlock });
```
Modes: `'send'` (planner dispatch), `'local'` (save only), `'review'` (airlock review).

**Backend handler** in `src/services/TaskViewerProvider.ts`:
- `initiatePlan` message handler (~search for `initiatePlan`) creates the plan file, creates a session, and optionally dispatches to planner.
- The `reviewPlan` command opens the ticket view panel (`ReviewProvider`).

**Ticket view** (`src/webview/review.html`):
- State `isPreview: false` → edit mode (textarea visible). Currently defaults to `false` but Plan 5 changes default to `true` for existing tickets. New tickets need to override back to edit mode.

**Plan file naming** — currently based on timestamp + sanitized title at creation time. No rename-on-save logic exists.

## Proposed Changes

### Step 1: Replace "Send to Planner" with "Open Ticket" for non-airlock plans (Routine)
**File:** `src/webview/implementation.html` (lines 1521–1526)
- When `_planModalFromAirlock === false`:
  - Change `btn-send-planner` text from `"SEND TO PLANNER"` to `"OPEN TICKET"`.
  - On click with mode `'send'`, change to mode `'ticket'` (new mode).
- Keep `btn-save-plan` as-is for local save without opening.

### Step 2: Handle new 'ticket' mode in backend (Moderate)
**File:** `src/services/TaskViewerProvider.ts`
- In the `initiatePlan` handler, add a case for `mode === 'ticket'`:
  1. Create the plan file (same as `'local'`).
  2. Create a session and place card in CREATED column.
  3. Immediately open the ticket view via `switchboard.reviewPlan` command.
  4. Pass `initialMode: 'edit'` to the ticket view.

### Step 3: Accept initialMode parameter in ticket view (Routine)
**File:** `src/webview/review.html`
- When the backend sends `ticketData`, include an optional `initialMode: 'edit' | 'review'` field.
- If `initialMode === 'edit'`, set `state.isPreview = false` on load (textarea mode).
- If `initialMode === 'review'` or undefined, use the default (which Plan 5 sets to `true`).

### Step 4: Implement file rename on save (Moderate)
**File:** `src/services/ReviewProvider.ts` (or wherever the ticket save handler lives)
- When the ticket save message arrives with a title that differs from the current filename stem:
  1. Compute new filename: `feature_plan_{timestamp}_{sanitized_title}.md`.
  2. `fs.renameSync(oldPath, newPath)`.
  3. Update the session's `planFile` reference in the runsheet and DB.
  4. Update the ticket view's `header-path` with the new path.
  5. Refresh the kanban board to reflect the renamed file.

### Step 5: Update modal close behavior (Routine)
**File:** `src/webview/implementation.html`
- After `initiatePlan` with mode `'ticket'`, close the modal and clear inputs (already happens).
- No additional change needed — the backend opens the ticket view asynchronously.

## Dependencies
- **Plan 5 (refine ticket view):** Plan 5 sets default to review mode; this plan overrides for new tickets with `initialMode: 'edit'`. Compatible if both implement the `initialMode` parameter.
- **Plan 8 (remove airlock text inputs):** Plan 8 modifies the airlock tab. This plan modifies the non-airlock flow. No overlap.
- **Plan 11 (move controls in ticket view):** Both add functionality to the ticket view. No file-level conflict.

## Verification Plan
1. Open Create Plan modal (not from airlock) → confirm button says "OPEN TICKET".
2. Enter title and description → click "OPEN TICKET".
3. Confirm: plan file created, card appears in CREATED column, ticket view opens in **edit mode**.
4. Edit the title in ticket view → save → confirm the plan file is renamed on disk.
5. Confirm the kanban card reflects the new filename.
6. Test airlock flow separately → confirm "REVIEW PLAN" button still works as before.
7. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- Button text change in implementation.html (~3 lines).
- New mode string in postMessage (~1 line).
- `initialMode` parameter in review.html (~5 lines).

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "File rename is dangerous. What if two plans have the same title? You'll overwrite." → Valid. The timestamp prefix prevents collisions, but verify the sanitized title doesn't create duplicates. Add a uniqueness check.
- "The 'ticket' mode duplicates logic from 'local' mode with extra steps. DRY violation." → Valid. Refactor: have `'ticket'` mode call the `'local'` save path first, then chain the ticket open.
- "What if the user cancels the modal after the plan file is created but before the ticket opens? Orphaned file." → The file is created on button click, not on modal open. If the backend fails to open the ticket, the plan file still exists in CREATED — acceptable.
- "File rename must update `KanbanDatabase` too." → Yes. Add `db.updatePlanFile(sessionId, newPath)` after rename.

### Balanced Synthesis
- The file rename is the riskiest part. Implement it carefully with: uniqueness check, atomic rename, and multi-reference update (runsheet + DB + ticket state).
- The `'ticket'` mode should compose with `'local'` to avoid code duplication.
- Add a small delay (or await) between session creation and ticket open to avoid race conditions.

## Agent Recommendation
Send it to the **Coder agent** — the button/mode changes are routine. The file rename is moderate but well-scoped to one save handler.

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The implementation correctly changed the non-airlock modal button to `OPEN TICKET`, routed that flow through the new `ticket` mode, opened the review panel with `initialMode: 'edit'`, and included a safe rename helper that updates the run sheet, plan registry, and Kanban database when the backing file name changes.
- One material defect remained: the ticket view did not expose an editable title field, so the plan’s required workflow of changing the ticket title and saving to rename the file was only partially implemented. Rename-on-save worked if the markdown `#` heading changed manually in the body, but not through an explicit ticket-title edit in the UI.

### Fixed Items
- Added an editable `Title` field to the review ticket metadata area.
- Updated the save flow to submit the edited ticket title with the `savePlanText` request.
- Updated the backend save path to stamp the requested ticket title into the markdown heading before writing and before triggering rename-on-save, keeping file content and filename aligned.
- Added a focused regression test covering the ticket-title edit/save wiring.

### Files Changed During Reviewer Pass
- `src/webview/review.html`
- `src/services/TaskViewerProvider.ts`
- `src/test/review-ticket-title-regression.test.js`

### Validation Results
- `npm run compile` ✅ Passed.
- `node src\test\review-ticket-title-regression.test.js` ✅ Passed.
- `npm run lint` was not rerun for this pass because repository linting remains blocked by the pre-existing ESLint 9 configuration issue (`eslint.config.*` missing).

### Remaining Risks
- The focused regression test validates the source wiring for title edits and save behavior, but there is still no browser-level end-to-end test covering: open new ticket → edit title → save → confirm renamed file in the live UI.
- The ticket title and markdown H1 are now kept aligned on save, which is correct for this workflow, but it means users cannot intentionally keep a different visible ticket title from the document H1.

### Final Reviewer Assessment
- Ready. The open-ticket flow now satisfies the plan requirements, including editable new-ticket entry in edit mode and title-driven rename-on-save behavior.
