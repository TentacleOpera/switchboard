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

### 2. Read-Only Complexity Dot on Kanban Plan List Cards

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
- This dot is **read-only** — clicking it does nothing. Editing happens in the preview pane metadata bar (see Task 3).

### 3. Preview Pane Metadata Bar (Column, Complexity, Log, Delete)

**Problem:** No way to edit complexity, view the action log, or delete a plan from the Kanban Plans tab.

**Solution:**
Add a fixed metadata bar above the markdown preview in `#kanban-preview-pane` that only appears when a plan is selected.

**Layout (wordy badges, not dots):**
```
[Column: CREATED ▼]  [Complexity: ● 5 ▼]  [Log]  [Delete]
```

**Implementation:**
- In `planning.html`, add a `#kanban-preview-meta-bar` div inside `#kanban-preview-pane`, above `#kanban-preview-content`. Style it as a horizontal bar with gaps. Hidden by default; shown when a plan is selected.
- In `planning.js`:
  - On plan selection (inside the existing row click handler), render the meta bar with current values.
  - **Column badge:** Displays current column label (e.g. "CREATED"). Click opens a dropdown with all available columns + "COMPLETED" + a separator + "Delete Plan".
    - On column change (including "COMPLETED"), post `moveKanbanPlanColumn` (reuses existing handler).
    - On "Delete Plan", confirm with `window.confirm('Delete this plan?')`, then post `deleteKanbanPlan` with `planFile`, `sessionId`, `workspaceRoot`.
  - **Complexity badge:** Displays "Complexity: ● {value}". Click opens a dropdown with options `Unknown`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`.
    - On selection, post `setKanbanPlanComplexity` with `planFile`, `sessionId`, `workspaceRoot`, `complexity`.
  - **Log button:** Click posts `fetchKanbanPlanLog` with `sessionId`, `workspaceRoot`.
  - **Delete button:** Standalone button. Click confirms, then posts `deleteKanbanPlan`.
- In `PlanningPanelProvider.ts`, add handlers for:
  - `setKanbanPlanComplexity`: Update `KanbanDatabase` record, optionally update plan file metadata, refresh plans list.
  - `deleteKanbanPlan`: Delete from `KanbanDatabase`, optionally delete plan markdown file, refresh plans list, clear preview pane.
  - `fetchKanbanPlanLog`: Get run sheet, format events with `_getReviewLogEntries` (extract from `TaskViewerProvider` into shared utility or duplicate), post back `kanbanPlanLogReady`.
- In `planning.js`, handle `kanbanPlanLogReady`: Render a simple modal/overlay with timestamp, workflow, details per entry, plus a close button.

### 4. Add Log Button to Kanban Controls Strip

**Problem:** Controls strip is crowded and "Import Plans" is verbose.

**Solution:**
- In `planning.html` kanban controls strip:
  - Rename button text `"Import Plans"` → `"Import"`.
  - Add a new `"Log"` button next to it (also appears in the preview meta bar, but having it in the strip too is useful for quick access).
- Both Log buttons post `fetchKanbanPlanLog` with the currently selected plan's `sessionId` and `workspaceRoot`.

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

1. Open the Kanban Plans tab. Each plan card in the left list should show a coloured complexity dot (read-only).
2. Select a plan. The preview pane shows a metadata bar above the markdown: `[Column: CREATED ▼] [Complexity: ● 5 ▼] [Log] [Delete]`.
3. Click the Column badge — dropdown with columns + "Delete Plan" option. Changing column moves the plan. Selecting "Delete Plan" prompts and removes it.
4. Click the Complexity badge — dropdown with 1-10 + Unknown. Changing updates the dot colour on refresh.
5. Click the Log button — a modal shows timestamp/workflow/details for each action log entry.
6. Click the Delete button — confirmation dialog, then plan is removed.
7. Select a plan — the sidebar tree highlights the corresponding session.
8. In the kanban board, click "Review Plan" on any card — `planning.html` opens with the Kanban Plans tab active and the correct plan selected and previewed.
9. Compile the extension (`npm run compile`) — no TypeScript errors.
10. Grep for `ReviewProvider` across the codebase — zero references remain.

## Risks & Notes

- **Action Log Data Format:** The old ticket viewer gets action logs via `TaskViewerProvider.getReviewTicketData()`. When deleting `TaskViewerProvider`'s review methods, the log formatting logic (`_getReviewLogEntries`) must either be moved to a shared utility or duplicated into `PlanningPanelProvider`.
- **Kanban Board → Planning Panel coupling:** `KanbanProvider` currently delegates review to `TaskViewerProvider`. We'll need to change this to call `PlanningPanelProvider` directly. Ensure `PlanningPanelProvider` is accessible from `KanbanProvider` (either via dependency injection or a static accessor).
- **Session ID vs Plan File for selection:** When redirecting from the kanban board, we may only have `sessionId`. The kanban plans list is keyed by `planId` (which equals `sessionId`). Ensure the selection logic handles both identifiers.
