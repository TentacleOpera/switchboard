# Supercede Ticket View with Kanban Plans Tab

## Goal

Port the remaining useful features from the old dedicated "Review Plan" ticket viewer (`review.html` / `ReviewProvider.ts`) into the new Kanban Plans tab inside `planning.html`. Then redirect the kanban board's "Review Plan" button to the new tab, and delete the old ticket viewer entirely.

## Background & Root Cause

The old ticket viewer was a single-plan dedicated panel with metadata editing (complexity, dependencies, action log, complete, delete). The new Kanban Plans tab is a browsable list+preview interface that already handles markdown preview, editing, review mode, and column reassignment. Several features from the old view are still missing:
- Complexity display and editing
- Action log viewing
- Plan deletion
- Sidebar session sync

Meanwhile the old view (`review.html`, `ReviewProvider.ts`, and related command registrations) is now dead weight that should be removed to reduce maintenance surface.

## Tasks

### 1. Add Complexity to Kanban Plans Data Pipeline

**Problem:** `KanbanPlanSummary` in `PlanningPanelProvider.ts` does not include `complexity`, so the kanban plans list has no complexity data to display.

**Solution:**
- Add `complexity: string` to the `KanbanPlanSummary` interface.
- In `_getKanbanPlans()`, include `complexity: plan.complexity || 'Unknown'` when building the summary list.
- In `planning.js`, update `renderKanbanPlans()` to include the complexity value in the plan data (it's already available from the backend after this change).

### 2. Complexity Dot on Kanban Plan Cards

**Problem:** No visual indication of plan complexity in the Kanban Plans tab list.

**Solution:**
- In `planning.html` / `planning.js` `renderKanbanPlans()`:
  - Add a small coloured dot (e.g. 10px circle) to the top-right of each `.kanban-plan-item` card.
  - Colour mapping reuses the existing kanban board CSS classes:
    - `very-high` → `#ff00ff`
    - `high` → `var(--accent-red)`
    - `medium` → `var(--accent-orange)`
    - `low` → `#98c379`
    - `very-low` → `var(--accent-teal)`
    - `unknown` → `#7f848e`
  - Use the `scoreToCategory` / `categoryToCssClass` logic (or inline equivalent) to derive the colour from the complexity string.
- Clicking the dot opens a small modal (reuse existing modal pattern or a simple `<select>` dropdown) with complexity options: `Unknown`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`.
- On selection, post a new message type `setKanbanPlanComplexity` with `planFile`, `sessionId`, `workspaceRoot`, `complexity`.
- In `PlanningPanelProvider.ts`, add a handler for `setKanbanPlanComplexity` that:
  1. Updates the plan's complexity in the `KanbanDatabase`.
  2. Optionally updates the plan markdown file's complexity metadata section (reuse existing `planMetadataUtils` logic if available).
  3. Refreshes the kanban plans list (re-send `kanbanPlansReady`).

### 3. Add Log Button to Kanban Controls Strip

**Problem:** No way to view the action log from the Kanban Plans tab.

**Solution:**
- In `planning.html` kanban controls strip:
  - Rename button text `"Import Plans"` → `"Import"`.
  - Add a new `"Log"` button next to it.
- In `planning.js`, add click handler for the Log button.
  - When clicked, post a new message type `fetchKanbanPlanLog` with `sessionId` and `workspaceRoot`.
- In `PlanningPanelProvider.ts`, add a handler for `fetchKanbanPlanLog`:
  - Resolve the workspace root.
  - Get the run sheet for the session.
  - Call `_getReviewLogEntries(events)` (extract this from `TaskViewerProvider` into a shared utility, or inline the logic) to format the log.
  - Post back `kanbanPlanLogReady` with the log entries array.
- In `planning.js`, handle `kanbanPlanLogReady`:
  - Render a simple modal / overlay showing timestamp, workflow, and details for each log entry.
  - Include a close button.

### 4. Add Delete Plan to Column Dropdown

**Problem:** No delete action in the Kanban Plans tab.

**Solution:**
- In `planning.js` `renderKanbanPlans()`, when building the column `<select>` dropdown for each plan:
  - Add an `<optgroup label="Actions">` at the end containing one option: `<option value="__DELETE__">Delete Plan</option>`.
- In the `change` event handler for the dropdown:
  - If `value === '__DELETE__'`, confirm with `window.confirm('Delete this plan?')`.
  - On confirm, post a new message type `deleteKanbanPlan` with `planFile`, `sessionId`, `workspaceRoot`.
  - On cancel, reset the dropdown to the current column and hide it.
- In `PlanningPanelProvider.ts`, add a handler for `deleteKanbanPlan`:
  - Delete the plan record from `KanbanDatabase`.
  - Optionally delete the plan markdown file (or leave it — decide based on user preference; the kanban board delete likely leaves the file).
  - Refresh the kanban plans list.

### 5. Sidebar Sync on Plan Selection

**Problem:** Selecting a plan in the Kanban Plans tab does not sync the sidebar tree selection.

**Solution:**
- In `planning.js`, when a plan row is selected (inside the row click handler that already sets `_kanbanSelectedPlan` and fetches preview):
  - Add: `if (plan.sessionId) { vscode.postMessage({ type: 'planShown', sessionId: plan.sessionId }); }`
- In `PlanningPanelProvider.ts`, add a case for `planShown` in `_handleMessage()`:
  - Execute `vscode.commands.executeCommand('switchboard.selectSession', sessionId)` (same as `ReviewProvider.ts` currently does).

### 6. Redirect Kanban Board "Review Plan" Button

**Problem:** The kanban board's "Review Plan" button still opens the old `ReviewProvider` ticket viewer.

**Solution:**
- In `KanbanProvider.ts`, in the `reviewPlan` message handler (around line 5305):
  - Instead of calling `vscode.commands.executeCommand('switchboard.reviewPlanFromKanban', ...)`, call a new approach:
    1. Get or create the `PlanningPanelProvider` instance.
    2. Call `planningPanelProvider.open()` to reveal the panel.
    3. Post a message to the webview: `{ type: 'activateKanbanTabAndSelectPlan', sessionId, planFile, workspaceRoot }`.
- In `PlanningPanelProvider.ts`, ensure the class exposes a way for `KanbanProvider` to get the singleton instance (likely already available via a static `getInstance()` or stored reference).
- In `planning.js`, add a handler for `activateKanbanTabAndSelectPlan`:
  1. Activate the "KANBAN PLANS" tab (call the existing tab-switching logic).
  2. Trigger a refresh of the kanban plans list (`vscode.postMessage({ type: 'fetchKanbanPlans' })`).
  3. After the list loads, find the plan matching the given `sessionId` or `planFile`, select it, and fetch its preview.
  - *Note:* Because the list load is async, the webview may need to store a "pending selection" (e.g. `state.pendingKanbanSelection = { sessionId, planFile }`) and check it inside the existing `handleKanbanPlansReady` handler.

### 7. Delete Old Ticket View

**Problem:** `review.html`, `ReviewProvider.ts`, and related code are now dead weight.

**Solution:**
- **Delete files:**
  - `src/webview/review.html`
  - `src/services/ReviewProvider.ts`
- **Clean up `extension.ts`:**
  - Remove `import { ReviewProvider, ... } from './services/ReviewProvider'`.
  - Remove the `reviewPlan` command registration (`switchboard.reviewPlan`).
  - Remove the `reviewPlanFromKanban` command registration (`switchboard.reviewPlanFromKanban`).
  - Remove the `sendReviewComment` command registration (if comments are handled elsewhere, verify; the kanban plans tab already has its own `submitComment` flow).
  - Remove any other `ReviewProvider`-specific command registrations.
- **Clean up `TaskViewerProvider.ts`:**
  - Remove `handleKanbanReviewPlan` (now unused).
  - Remove `_handleReviewPlan` (now unused).
  - Remove `getReviewTicketData` (now unused).
  - Remove `getReviewOpenPlans` (now unused).
  - Remove `updateReviewTicket` (now unused).
  - Remove `sendReviewTicketToNextAgent` (now unused).
  - Remove any other review-specific private methods.
- **Clean up imports and references:**
  - Remove `ReviewProvider` import from any other files that reference it.
  - Update any type imports that reference `ReviewPlanContext`, `ReviewTicketData`, etc.
- **Clean up tests:**
  - Delete or update `test/review-send-agent-trigger-regression.test.js` (it specifically tests `ReviewProvider` code).
  - Remove any other test files referencing the old review panel.

## Files to Modify

- `src/services/PlanningPanelProvider.ts`
- `src/webview/planning.html`
- `src/webview/planning.js`
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/extension.ts`
- `src/services/complexityScale.ts` (potentially — for shared helper if not already)

## Files to Delete

- `src/webview/review.html`
- `src/services/ReviewProvider.ts`
- `test/review-send-agent-trigger-regression.test.js`

## Verification

1. Open the Kanban Plans tab. Each plan card should show a coloured complexity dot.
2. Click the dot — a modal appears. Change complexity. The dot colour updates on refresh.
3. Click the "Log" button with a plan selected — a modal shows the action log.
4. Click a plan's column badge dropdown — "Delete Plan" appears at the bottom. Selecting it prompts for confirmation and removes the plan.
5. Select a plan in the Kanban Plans tab — the sidebar tree highlights the corresponding session.
6. In the kanban board, click "Review Plan" on any card — `planning.html` opens with the Kanban Plans tab active and the correct plan selected and previewed.
7. Compile the extension (`npm run compile`) — no TypeScript errors.
8. Grep for `ReviewProvider` across the codebase — zero references remain.

## Risks & Notes

- **Delete Plan UX:** Adding "Delete Plan" inside the column `<select>` is slightly unconventional UX. An alternative is a separate small trash icon button, but the user specifically requested the dropdown approach. We should ensure the option is visually separated (e.g. via `<optgroup>` or `hr`-styled option) so users don't accidentally trigger it.
- **Action Log Data Format:** The old ticket viewer gets action logs via `TaskViewerProvider.getReviewTicketData()`. When deleting `TaskViewerProvider`'s review methods, the log formatting logic (`_getReviewLogEntries`) must either be moved to a shared utility or duplicated into `PlanningPanelProvider`.
- **Kanban Board → Planning Panel coupling:** `KanbanProvider` currently delegates review to `TaskViewerProvider`. We'll need to change this to call `PlanningPanelProvider` directly. Ensure `PlanningPanelProvider` is accessible from `KanbanProvider` (either via dependency injection or a static accessor).
- **Session ID vs Plan File for selection:** When redirecting from the kanban board, we may only have `sessionId`. The kanban plans list is keyed by `planId` (which equals `sessionId`). Ensure the selection logic handles both identifiers.
