# ClickUp/Linear Tab: Bulk Import, Selection, View Task, and Refine

## Problem
In `implementation.html`, the ClickUp and Linear project tabs only support per-task import. There is no way to quickly import all tasks for a sprint or import a selection. Additionally, clicking a task card immediately opens it, which is not always desired. Finally, there is no way to ask the planner to improve a ticket directly from the task card.

## Goal
Add bulk import capabilities (Import All, Import Selected), improve task card UX by separating navigation from selection, and introduce a "Refine" action to ask the planner terminal to improve a task directly from the project tab.

## Metadata
- **Tags:** frontend, UI, workflow, integration
- **Complexity:** 5

## User Review Required
- No.

## Complexity Audit
### Routine
- Adding buttons to the toolbar and task cards.
- Managing in-memory selection state (Set of IDs).
- Sending VS Code messages.

### Complex / Risky
- Bulk import operations: Calling `importLinearTask` or `importClickUpTask` in a tight loop could thrash the file system and Kanban DB if `_syncFilesAndRefreshRunSheets` is called after every single task. We need to aggregate the calls and sync once at the end.

## Edge-Case & Dependency Audit
- **Race Conditions**: Bulk imports updating the Kanban DB simultaneously. Mitigated by importing sequentially and syncing the file system once at the end.
- **Security**: Refine prompt must cleanly encapsulate the task description to avoid breaking the prompt structure.
- **Side Effects**: Selection state is lost on tab switch. This is acceptable for this feature.
- **Dependencies & Conflicts**: None.

## Dependencies
- sess_0000000000000 — <none>

## Adversarial Synthesis
Key risks: Bulk import loops triggering repeated file system syncs (`_syncFilesAndRefreshRunSheets`), causing UI lockups and race conditions. Mitigations: Update backend handlers to process bulk imports sequentially, aggregating results, and performing a single file system/Kanban refresh after all imports complete.

## Proposed Changes
### `src/webview/implementation.html`
- **Context:** ClickUp and Linear project tabs rendering and event listeners.
- **Logic:**
  - Add global sets `selectedLinearIssueIds = new Set()` and `selectedClickUpTaskIds = new Set()`.
  - In `renderSidebarLinearProjectPanel` (around L3521) and corresponding ClickUp panel, add `IMPORT ALL` and `IMPORT SELECTED` buttons next to the `REFRESH` button.
  - In `renderSidebarLinearProjectList` (around L3400) and ClickUp equivalent, modify the card template to remove `cursor: pointer` on the `.project-issue-card`.
  - Add `.selected` class if the issue ID is in the selection set.
  - Add `VIEW TASK` and `REFINE` buttons next to `IMPORT`.
  - In the click listeners for `projectTabs` (around L4349), if clicking `.project-issue-card` (but not a button), toggle the ID in the selection set and re-render the list.
  - Add button listeners for `IMPORT ALL`, `IMPORT SELECTED`, `VIEW TASK`, and `REFINE`.
  - `REFINE` builds a message containing the ticket title and description and posts it to the backend.

### `src/services/TaskViewerProvider.ts`
- **Context:** Webview message handler (`webviewView.webview.onDidReceiveMessage`).
- **Logic:**
  - Add cases `linearImportAllTasks`, `linearImportSelectedTasks`, `clickupImportAllTasks`, `clickupImportSelectedTasks`.
  - Await `importLinearTask` sequentially for each ID. Do *not* call `_syncFilesAndRefreshRunSheets` or `this.refresh()` in the loop.
  - After the loop, call `await this._syncFilesAndRefreshRunSheets(workspaceRoot);`, `this.refresh();`, and `await this._kanbanProvider?.refresh();`.
  - Add cases `linearRefineTask` and `clickupRefineTask`.
  - Retrieve the planner agent via `_getAgentNameForRole('planner', workspaceRoot)`.
  - Formulate the prompt using the task title and description.
  - Dispatch via `dispatchCustomPromptToRole`.

## Verification Plan
### Automated Tests
- No new automated tests are required for these UI-heavy changes; manual verification of bulk import and Refine dispatch is sufficient.

---
## Original Plan Details

### Affected Files
- `src/webview/implementation.html`
- `src/services/TaskViewerProvider.ts`

### Plan

#### 1. UI: Toolbar Buttons (`implementation.html`)
- Add **IMPORT ALL** and **IMPORT SELECTED** buttons beside the existing **REFRESH** button in the project toolbar (around the `sidebar-linear-project-refresh` area).
- Add CSS for disabled/loading states on these buttons.

#### 2. UI: Task Card Restructure (`implementation.html`)
- Remove `cursor: pointer` from `.project-issue-card` and `.project-card`.
- Remove the card-level click handler that navigates to task details.
- On each card, add:
  - **VIEW TASK** button — calls existing `loadLinearTaskDetails` / `loadClickUpTaskDetails`.
  - **REFINE** button — new action.
- Keep the existing **IMPORT** button.

#### 3. State: Selection Tracking (`implementation.html`)
- Add `selectedClickUpTaskIds` and `selectedLinearIssueIds` arrays (or Sets).
- Add checkboxes to each task card (or make cards toggle-select on click without opening).
- Update selection state on card click (with `event.stopPropagation()` to avoid conflict with button clicks).
- Re-render cards to show `.selected` styling when selected.

#### 4. Frontend Events: New Message Types (`implementation.html`)
Add `vscode.postMessage` calls for:
- `linearImportAllTasks` — sends array of issue IDs.
- `clickupImportAllTasks` — sends array of task IDs.
- `linearImportSelectedTasks` — sends selected issue IDs.
- `clickupImportSelectedTasks` — sends selected task IDs.
- `linearRefineTask` — sends issue ID, title, description.
- `clickupRefineTask` — sends task ID, title, description.

#### 5. Backend Handlers (`TaskViewerProvider.ts`)
In the webview message handler, add cases for:
- **`linearImportAllTasks`** / **`clickupImportAllTasks`**
  - Iterate over all provided IDs.
  - Call existing `importLinearTask` / `importClickUpTask` for each.
  - Report aggregated result back to webview.
- **`linearImportSelectedTasks`** / **`clickupImportSelectedTasks`**
  - Same as above, but only for the selected IDs.
- **`linearRefineTask`** / **`clickupRefineTask`**
  - Find the planner terminal via `_getAgentNameForRole('planner', workspaceRoot)`.
  - Build a prompt: ticket title, description, and instructions to improve the ticket logic and insert/fix necessary code references if the user has code access.
  - Use `dispatchCustomPromptToRole('planner', prompt, workspaceRoot)` to send it.
  - Post success/error message back to webview.

#### 6. Detail View: Ask Agent / Import Buttons
- Ensure the **ASK AGENT** button in the detail view still works.
- The detail view import button remains as-is.

### Risks & Notes
- Bulk import may be rate-limited by ClickUp/Linear APIs. Consider adding a small delay between calls or batching.
- The planner terminal must be registered for Refine to work. If no planner terminal is found, show a warning.
- Selection state is in-memory only; it will reset on refresh or tab switch. This is acceptable for a quick import workflow.
- ClickUp IMPORT ALL does not respect the active status/search filter in the webview — it fetches all non-closed tasks. Linear IMPORT ALL does respect active search/project/state filters. This is a known design gap acceptable for v1.

---

## Reviewer Pass

### Reviewer: Inline (Antigravity)
### Date: 2026-05-16

### Stage 1 — Adversarial Findings

| ID | Severity | Finding |
|---|---|---|
| C-1 | CRITICAL | `clickUpImportPending` set on IMPORT ALL/SELECTED click but never cleared — bulk methods returned `void` with no webview postMessage, permanently disabling detail buttons. |
| C-2 | CRITICAL | `importAllButton` NOT disabled during in-flight bulk op — user could hammer it, queuing concurrent imports and creating duplicate-plan errors for all already-imported tasks. |
| M-1 | MAJOR | No user feedback on bulk import success (no toast, no reload trigger from webview side) for either Linear or ClickUp paths. |
| M-2 | MAJOR | ClickUp IMPORT ALL ignores active UI filters (fetches all non-closed tasks regardless of search/status filter). |
| N-1 | NIT | `refineTask` prompt is thin (title + description only; no state, assignee, subtask, comment context). |
| N-2 | NIT | `data-issue-description` attr on ClickUp cards stores potentially large markdown; prompt-injection risk if description contains backticks. |

### Stage 2 — Balanced Synthesis

- **Fix now (C-1, C-2, M-1):** Backend bulk methods must emit a `bulkImportResult` webview message. Frontend must handle it to clear flags and show feedback. IMPORT ALL/SELECTED must be disabled while in-flight.
- **Defer (M-2):** ClickUp filter inconsistency is a design gap; documented as known risk above.
- **Defer (N-1, N-2):** Functional; not blocking for v1.

### Stage 3 — Fixes Applied

**Files changed:**
- `src/services/TaskViewerProvider.ts` — All four bulk methods (`linearImportAllTasks`, `linearImportSelectedTasks`, `clickupImportAllTasks`, `clickupImportSelectedTasks`) now track `imported`/`skipped` counts and post a `bulkImportResult` message on both success and failure. Error path no longer uses `vscode.window.showErrorMessage` (which wouldn't reach the webview); uses postMessage instead.
- `src/webview/implementation.html` — Added `bulkImportInFlight` flag. Set to `true` on IMPORT ALL/SELECTED click (both providers). Cleared in new `case 'bulkImportResult'` handler. Buttons disabled and relabelled to `IMPORTING...` while in-flight. Success path shows info toast and reloads the project list. Error path shows warning toast.

### Stage 4 — Verification

```
TypeScript: npx tsc --noEmit
Result: 2 pre-existing unrelated errors only (ClickUpSyncService.ts:2309, KanbanProvider.ts:4107 — module resolution file extensions). Zero new errors introduced.

Integration check (grep):
- bulkImportResult: emitted in 8 locations in TaskViewerProvider.ts (2 per method × 4 methods), handled in 1 case in implementation.html ✅
- bulkImportInFlight: declared, set in 4 click paths, read in 4 button disable checks, cleared in handler ✅
```

### Remaining Risks

- **Rate limiting**: Bulk import of 50+ tasks may hit ClickUp/Linear API rate limits. No backoff/delay implemented. Acceptable for v1; user will see individual import errors in skipped count.
- **ClickUp filter gap**: IMPORT ALL fetches all non-closed tasks, ignoring active UI filter. User may import more than expected.
- **Thin refine prompt**: `refineTask` prompt only passes title/description; planner agent receives minimal context vs. the richer detail available in the full `buildLinearAskAgentText` format.