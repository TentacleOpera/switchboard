# Add move controls to ticket view

Add controls to move the ticket inside the ticket view so you can manage the plan from here. There needs to be send to agent, mark as completed, delete plan.

## Goal
Add three action controls to the ticket view header so the user can manage the plan lifecycle without switching back to the kanban board:
1. **Send to Agent** — move the ticket forward to the next column and dispatch to the appropriate agent.
2. **Mark as Completed** — mark the plan as done and remove it from active kanban columns.
3. **Delete Plan** — permanently delete the plan file and remove the session/card from the board.

## Source Analysis

**Ticket view** (`src/webview/review.html`):
- Header actions (lines 400–403): currently contains `[Reload, Save]` buttons.
- Plan 5 adds `[Copy Link, Log]` buttons to the same header.
- State object (line 485–498) includes `sessionId`, `planFileAbsolute`, `column`.

**Existing kanban card actions** in `src/webview/kanban.html`:
- Card buttons include "View" and "Review" (lines 748–758).
- Complete button exists: `.card-btn.complete` (line 375–378 CSS).
- Complete action: `postKanbanMessage({ type: 'completePlan', sessionId, workspaceRoot })` — handled by `switchboard.completePlanFromKanban` command.

**Backend handlers** in `src/services/TaskViewerProvider.ts`:
- `handleKanbanCompletePlan(sessionId, workspaceRoot)` — marks session as completed, removes from active board.
- `handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot)` — dispatches to agent by role.

**Backend handlers** in `src/services/KanbanProvider.ts`:
- `triggerAction` message (line ~810): dispatches a single card to agent based on column role.
- No existing `deletePlan` handler — this is new functionality.

**Column-to-role mapping** for "Send to Agent":
- The ticket view knows the current `column` from state. The next column and its role can be derived from `agentConfig.ts` column definitions and `NEXT_COLUMN` map in KanbanProvider.ts (line 15).

## Proposed Changes

### Step 1: Add action buttons to ticket view header (Routine)
**File:** `src/webview/review.html` (lines 400–403)
- Add three buttons to `header-actions`:
  ```html
  <button id="btn-send-agent" title="Send to next agent">▶ Send to Agent</button>
  <button id="btn-complete" title="Mark plan as completed">✓ Complete</button>
  <button id="btn-delete" class="danger" title="Delete this plan permanently">✕ Delete</button>
  ```
- Style the delete button with `color: var(--danger)` and a confirmation prompt.

### Step 2: Implement "Send to Agent" click handler (Moderate)
**File:** `src/webview/review.html` (JS section)
- On click:
  ```js
  document.getElementById('btn-send-agent').addEventListener('click', () => {
      vscode.postMessage({ type: 'sendToAgent', sessionId: state.sessionId });
  });
  ```
- **File:** `src/services/ReviewProvider.ts` (or wherever ticket messages are handled)
  - Handle `sendToAgent`: determine the next column from the current column, resolve the target role, dispatch via `handleKanbanBatchTrigger(role, [sessionId], instruction, workspaceRoot)`.
  - After dispatch, update the ticket view's column display and show a success status message.
  - If the current column is the last column (CODE REVIEWED), show a warning: "Plan is already in the final column."

### Step 3: Implement "Complete" click handler (Routine)
**File:** `src/webview/review.html` (JS section)
- On click:
  ```js
  document.getElementById('btn-complete').addEventListener('click', () => {
      vscode.postMessage({ type: 'completePlan', sessionId: state.sessionId });
  });
  ```
- **File:** `src/services/ReviewProvider.ts`
  - Handle `completePlan`: call `taskViewerProvider.handleKanbanCompletePlan(sessionId, workspaceRoot)`.
  - After completion, update ticket status bar to "✓ Plan completed" and disable further actions.
  - Optionally close the ticket panel after a short delay.

### Step 4: Implement "Delete" click handler (Moderate)
**File:** `src/webview/review.html` (JS section)
- On click: show a confirmation dialog first:
  ```js
  document.getElementById('btn-delete').addEventListener('click', () => {
      if (confirm('Permanently delete this plan? This cannot be undone.')) {
          vscode.postMessage({ type: 'deletePlan', sessionId: state.sessionId });
      }
  });
  ```
- **File:** `src/services/ReviewProvider.ts` (or TaskViewerProvider.ts)
  - **New handler** `deletePlan`:
    1. Delete the plan file from disk: `fs.unlinkSync(planFileAbsolute)`.
    2. Mark session as completed/deleted in runsheet.
    3. Remove row from kanban DB if present: `db.deletePlan(sessionId)`.
    4. Close the ticket panel.
    5. Refresh the kanban board.

### Step 5: Add danger button CSS (Routine)
**File:** `src/webview/review.html` (CSS section)
- Add styles:
  ```css
  button.danger {
      border-color: rgba(248, 81, 73, 0.35);
      color: var(--danger);
  }
  button.danger:hover:not(:disabled) {
      border-color: var(--danger);
      background: rgba(248, 81, 73, 0.14);
  }
  ```

### Step 6: Disable actions based on state (Routine)
**File:** `src/webview/review.html` (JS section)
- After loading ticket data:
  - If plan is already completed: disable all three buttons.
  - If column is the final column: change "Send to Agent" text to "Already Reviewed" and disable it.
  - Update button states when column changes (e.g., after a successful send).

## Dependencies
- **Plan 5 (refine ticket view):** Both add buttons to `header-actions`. Coordinate the button order. Proposed order: `[Copy Link] [Log] [Send to Agent] [Complete] [Delete] [Reload] [Save]`.
- **Plan 7 (open plans as ticket):** New tickets open in edit mode. The action buttons should be available immediately (Send to Agent sends to planner for CREATED plans).
- No blocking dependencies.

## Verification Plan
1. Open a ticket in CREATED column → click "Send to Agent" → confirm card moves to PLAN REVIEWED and dispatches to planner agent.
2. Open a ticket in CODE REVIEWED → confirm "Send to Agent" is disabled (final column).
3. Click "Complete" → confirm plan is marked as completed, card removed from kanban board.
4. Click "Delete" → confirm confirmation dialog appears → confirm → plan file deleted, card removed, ticket panel closes.
5. Cancel the delete confirmation → confirm nothing happens.
6. Open a completed ticket → confirm all action buttons are disabled.
7. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- HTML buttons in header (~5 lines).
- CSS for danger button style (~6 lines).
- Complete handler (reuses existing `handleKanbanCompletePlan`) (~5 lines).
- State-based button disabling (~10 lines).

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "Delete is dangerous. What if autoban just dispatched this plan and a terminal is actively working on it?" → Valid. Before deleting, check `_activeDispatchSessions` for this sessionId. If in-flight, show a warning: "This plan is currently being processed. Delete anyway?"
- "Send to Agent from the ticket view bypasses the CLI triggers toggle. Is that intentional?" → Should check `_cliTriggersEnabled` state. If triggers are off, the send should just move the card without dispatching to a terminal.
- "Three new buttons in the header — it's getting crowded with Plan 5's additions." → Consider grouping action buttons in a dropdown menu: `⋮ Actions → [Send to Agent, Complete, Delete]`.
- "No undo for delete." → Acceptable for now. The confirmation dialog is sufficient. A trash/archive system would be a future enhancement.

### Balanced Synthesis
- Implement all three actions. The delete confirmation dialog is adequate for safety.
- Check `_activeDispatchSessions` before delete — warn if in-flight.
- Respect `_cliTriggersEnabled` for "Send to Agent" — move card but skip terminal dispatch if triggers are off.
- Consider the dropdown approach if header space is too cramped after Plan 5's additions. Can decide during implementation.

## Agent Recommendation
Send it to the **Coder agent** — the Complete handler reuses existing code. Send to Agent and Delete are moderate but well-scoped with clear backend patterns to follow.

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The implementation successfully added the ticket-view header controls and wired the core send, complete, and delete actions through the review panel and backend commands.
- Three material gaps were found during review:
  1. The ticket view did not receive completion state, so it could not disable lifecycle controls for completed plans as required.
  2. The delete flow did not surface the required extra warning when a session was currently in `_activeDispatchSessions`.
  3. The delete flow removed files and runsheets but did not explicitly remove the corresponding Kanban DB row, leaving stale DB state behind.

### Fixed Items
- Added `isCompleted` to review ticket data so the ticket view can disable lifecycle actions for completed plans.
- Updated the review webview action-state logic so completed tickets disable `Send to Agent`, `Complete`, and `Delete`, and show completed-safe button labels.
- Hardened plan deletion with an in-flight processing warning when the session is currently active in `_activeDispatchSessions`.
- Added an explicit `deletePlan(sessionId)` operation to `KanbanDatabase` and invoked it from the review delete flow so deleted plans are removed from the Kanban DB instead of lingering as stale records.
- Added a focused regression test covering Kanban DB deletion semantics.

### Files Changed During Reviewer Pass
- `src/services/ReviewProvider.ts`
- `src/webview/review.html`
- `src/services/KanbanDatabase.ts`
- `src/services/TaskViewerProvider.ts`
- `src/test/kanban-database-delete.test.js`

### Validation Results
- `npm run compile` ✅ Passed.
- `npm run compile-tests` ✅ Passed.
- `node src\test\delete-plan.test.js` ✅ Passed.
- `node src\test\kanban-database-delete.test.js` ✅ Passed.
- `npm run lint` was not rerun for this pass because repository linting is currently blocked by the pre-existing ESLint 9 config issue identified in the previous reviewer pass (`eslint.config.*` missing).

### Remaining Risks
- The review UI action disabling for completed plans is now covered in code, but there is still no dedicated automated UI test around the review webview button state transitions.
- Repository linting remains unavailable until the ESLint configuration is migrated or restored for ESLint 9.

### Final Reviewer Assessment
- Ready. The material gaps found during review have been fixed, and the reviewed implementation now satisfies the plan requirements for ticket-view lifecycle controls.
