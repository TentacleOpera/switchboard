# Auto-advance Kanban on copy prompt

## Goal
Improve Kanban state synchronization for cross-IDE workflows. When a user clicks "Copy Prompt" on a Kanban card, the Kanban board will immediately auto-advance the card to the next logical column. This provides immediate visual feedback and avoids relying on fragile cross-IDE file-writing logic ("read receipts"), allowing the user to simply move the card back manually if the external agent fails.

## User Review Required
> [!NOTE]
> Clicking "Copy Prompt" on a Kanban card will now automatically advance the card to the next phase (e.g., from CREATED to PLAN REVIEWED). You can always drag the card back if the external agent fails to execute the prompt.

## Complexity Audit
### Band A — Routine
- Updating the `copyPlanLink` message handler in `TaskViewerProvider.ts` to trigger a runsheet update after writing to the clipboard.

### Band B — Complex / Risky
- None. This is a significantly safer and more resilient approach than filesystem watching.

## Edge-Case Audit
- **Race Conditions:** If the user clicks multiple times quickly, `_updateSessionRunSheet`'s existing deduplication logic will prevent duplicate entries.
- **Side Effects:** Users who only intended to "peek" at the prompt without executing it will see their card move. They will need to manually drag it back. This is considered an acceptable trade-off for workflow fluidity.

## Proposed Changes

### 1. Auto-Advance on Copy
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The provider handles the `copyPlanLink` message from the webview.
- **Logic:** After `vscode.env.clipboard.writeText(textToCopy);`, map the current column to the next logical workflow state (e.g., `CREATED` -> `improve-plan`, `PLAN REVIEWED` -> `handoff`, `CODED` -> `reviewer-pass`).
- **Implementation:** Call `await this._updateSessionRunSheet(sessionId, workflowName);` immediately after writing to the clipboard and sending the success message to the webview.

## Verification Plan
### Manual Testing
1. Create a plan so it sits in the **Plan Created** column.
2. Click **Copy Prompt**.
3. Verify the prompt is copied to the clipboard.
4. Verify the Kanban card instantly moves to the **Plan Reviewed** column.
