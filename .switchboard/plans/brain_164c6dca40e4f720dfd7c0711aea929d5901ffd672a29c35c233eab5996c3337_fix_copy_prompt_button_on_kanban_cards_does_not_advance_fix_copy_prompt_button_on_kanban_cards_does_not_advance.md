# Fix: Copy Prompt Button on Kanban Cards Does Not Advance

The "Copy Prompt" button on individual Kanban cards currently only copies the prompt text to the clipboard and updates the session runsheet, but it fails to update the Kanban SQL database (`kanban.db`) and does not trigger a visual refresh of the Kanban board. This results in the card staying in its current column until a manual refresh or another action moves it.

## Proposed Changes

### TaskViewerProvider (Backend)

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)
Update [_handleCopyPlanLink](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts#6069-6147) to advance the card in the Kanban database and trigger a board refresh after a successful copy.

- Calculate the [targetColumn](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts#692-707) based on the current `effectiveColumn` and [role](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts#454-470).
- Call [_applyManualKanbanColumnChange](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts#1093-1121) (which updates both runsheet and SQL DB) or [_updateKanbanColumnForSession](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts#765-771).
- Trigger `switchboard.refreshUI` (or notify the webview) to ensure the board updates visually.

### KanbanProvider (Backend)

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)
Verify and ensure `pairProgramCard` correctly triggers a full refresh after advancing the card. While it currently calls `switchboard.kanbanForwardMove`, we should ensure the UI reflects this change immediately.

## Verification Plan

### Automated Tests
- None currently target this specific webview-to-backend interaction for the copy button. I will rely on manual verification.

### Manual Verification
1. Open the Kanban board.
2. Click the "Copy planning prompt" button on a card in the **CREATED** column.
   - Verify the prompt is copied.
   - Verify the card moves to **PLAN REVIEWED** immediately.
3. Click the "Copy coder prompt" button on a card in the **PLAN REVIEWED** column.
   - Verify the card moves to **LEAD CODED** or **CODER CODED** (based on complexity).
4. Click the "Copy review prompt" button on a card in the **LEAD CODED** or **CODER CODED** column.
   - Verify the card moves to **CODE REVIEWED**.
5. Test the **Pair** button on a High complexity card in **PLAN REVIEWED**.
   - Verify the card moves to **LEAD CODED**.

## Complexity Audit
**Manual Complexity Override:** Low

### Complex / Risky
- None.

---

## Reviewer Pass Results
**Date:** 2026-03-27 | **Verdict:** ✅ PASS — No issues found

### Adversarial Critique
- `_handleCopyPlanLink` (L6075) resolves column, computes role, copies prompt, then calls `_applyManualKanbanColumnChange` to advance the card in DB, followed by `switchboard.refreshUI` for visual refresh.
- `handleKanbanCopyPlan` public method correctly delegates to `_handleCopyPlanLink`.
- Extension command `switchboard.copyPlanFromKanban` registered at L1092 and wired correctly.
- Kanban webview sends `copyPlanLink` message with `column` param from `btn.closest('.kanban-column')`.

### Changes Applied
None required — implementation matches plan exactly.

### Verification
- `npx tsc --noEmit` — clean (0 errors)
- Code path traced: webview → KanbanProvider → command → TaskViewerProvider → DB update + UI refresh
