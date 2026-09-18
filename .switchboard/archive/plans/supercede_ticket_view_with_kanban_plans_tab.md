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

**Root cause:** The Kanban Plans tab was built incrementally and never received the metadata editing features that the dedicated review panel had. Rather than maintaining two parallel UIs, consolidate into one.

## Metadata

- **Tags:** frontend, refactor, ui, ux
- **Complexity:** 6

## User Review Required

- Confirm that deleting a plan from the Kanban Plans tab should remove the DB record only (markdown file stays on disk). If file deletion is desired, the plan needs an update.
- Confirm the action log modal style (simple overlay vs. integrated panel section).

## Complexity Audit

### Routine
- Adding `complexity` field to `KanbanPlanSummary` interface and `_getKanbanPlans()` mapper
- Rendering a read-only complexity dot on plan list cards using existing `complexityScale.ts` functions
- Adding `planShown` message handler for sidebar sync (one-line command execution)
- Renaming "Import Plans" → "Import" button text
- Adding a "Log" button to the controls strip
- Deleting `review.html`, `ReviewProvider.ts`, and test file
- Removing ReviewProvider imports and command registrations from `extension.ts`

### Complex / Risky
- **Cross-provider wiring (Task 6):** `KanbanProvider` must call `PlanningPanelProvider.open()` and post a webview message. No singleton exists — requires passing the instance via constructor injection in `extension.ts`.
- **Type hostage (Task 7):** `PlanningPanelProvider` imports `ReviewCommentRequest` / `ReviewCommentResult` from `ReviewProvider`. These types must be relocated before the file can be deleted.
- **Async race condition (Task 6):** `activateKanbanTabAndSelectPlan` must handle both "list already loaded" and "list loading in progress" states.
- **7 command registrations to remove (Task 7):** Not just 3 — `getReviewTicketData`, `updateReviewTicket`, `getReviewOpenPlans`, `reviewSendToAgent` also delegate to TaskViewerProvider review methods.

## Edge-Case & Dependency Audit

- **Race Conditions:** When `activateKanbanTabAndSelectPlan` arrives, the kanban plans list may already be loaded (from a prior fetch). The pending-selection mechanism must also check the already-rendered list if `handleKanbanPlansReady` has already fired. Guard: in the `activateKanbanTabAndSelectPlan` handler, after triggering `fetchKanbanPlans`, also scan the current `_kanbanPlans` array for a match and select immediately if found.
- **Security:** `deleteKanbanPlan` is destructive. Must validate `planFile` path is within workspace root before any DB or file operation. Use existing `isPathWithinRoot()` utility.
- **Side Effects:** Deleting a plan from the DB removes it from the kanban board and plans list. If the markdown file remains, it could be re-imported via "Import Plans". This is acceptable — re-import creates a new DB record.
- **Dependencies & Conflicts:** `PlanningPanelProvider.line 20` imports `ReviewCommentRequest`, `ReviewCommentResult` from `ReviewProvider`. These types are used in the `submitComment` handler (lines 1068-1078). They must be moved to a shared types file (e.g. `src/services/reviewTypes.ts`) before `ReviewProvider.ts` is deleted. The `submitComment` flow itself stays — it uses `switchboard.sendReviewComment` which is independent of the review panel.

## Dependencies

- None (self-contained refactor)

## Adversarial Synthesis

Key risks: cross-provider wiring without singleton (build failure if not injected), type hostage situation with ReviewCommentRequest/ReviewCommentResult (compile error on deletion), async race on plan selection from kanban board. Mitigations: pass PlanningPanelProvider instance to KanbanProvider via constructor, relocate types to shared file first, add dual-path selection guard (pending + already-loaded).

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

- **Context:** Main provider for the planning panel webview. Contains `KanbanPlanSummary` interface (lines 33-44) and `_getKanbanPlans()` (lines 4606-4634). Imports `ReviewCommentRequest`, `ReviewCommentResult` from `ReviewProvider` (line 20).
- **Logic:**
  1. Add `complexity: string` to `KanbanPlanSummary` interface (after `planFile` field, line ~44).
  2. In `_getKanbanPlans()`, add `complexity: r.complexity || 'Unknown'` to the mapped object (after `planFile` field, line ~4633).
  3. Add `planShown` case to `_handleMessage()`: execute `vscode.commands.executeCommand('switchboard.selectSession', sessionId)`.
  4. Add `setKanbanPlanComplexity` case to `_handleMessage()`:
     - Validate complexity value with `isValidComplexityValue()` from `complexityScale.ts`.
     - Update `KanbanDatabase` record via `db.updatePlan(planId, { complexity })`.
     - Refresh plans list by posting `kanbanPlansReady` with updated data.
  5. Add `deleteKanbanPlan` case to `_handleMessage()`:
     - Validate `planFile` is within workspace root.
     - Delete from `KanbanDatabase` via `db.deletePlan(planId)`.
     - Do NOT delete the markdown file (safe default — file can be re-imported).
     - Refresh plans list and post `kanbanPlanDeleted` to clear preview pane.
  6. Add `fetchKanbanPlanLog` case to `_handleMessage()`:
     - Resolve workspace root from sessionId.
     - Get run sheet via session log `getRunSheet(sessionId)`.
     - Format events using `formatReviewLogEntries()` (new shared utility — see below).
     - Post `kanbanPlanLogReady` with formatted entries.
  7. Change import: `ReviewCommentRequest`, `ReviewCommentResult` → import from `./reviewTypes` instead of `./ReviewProvider`.
- **Edge Cases:** sessionId may be empty for orphaned plans — guard all handlers with early return. Complexity value may be legacy format ("Low"/"High") — use `legacyToScore()` from `complexityScale.ts` to normalize.

### `src/services/reviewTypes.ts` (NEW)

- **Context:** Shared type definitions extracted from `ReviewProvider.ts` before deletion.
- **Logic:** Move `ReviewCommentRequest`, `ReviewCommentResult`, `ReviewPlanContext`, `ReviewTicketData`, `ReviewTicketUpdateRequest`, `ReviewTicketUpdateResult`, `ReviewOpenPlanOption` type/interface definitions here. These are used by `PlanningPanelProvider` and `extension.ts` command handlers.
- **Edge Cases:** None — pure type relocation.

### `src/services/reviewLogUtils.ts` (NEW)

- **Context:** Shared utility extracted from `TaskViewerProvider._getReviewLogEntries()` (lines 12824-12864).
- **Logic:** Export `formatReviewLogEntries(events: any[]): { timestamp: string; workflow: string; details: string }[]`. Copy the exact logic from `_getReviewLogEntries` including the `columnRoleMap` and event formatting. Import from both `PlanningPanelProvider` and `TaskViewerProvider` (until TaskViewerProvider's review methods are removed).
- **Edge Cases:** None — pure extraction of existing logic.

### `src/webview/planning.html`

- **Context:** Main HTML for the planning panel. Kanban controls strip at lines 3044-3061. Preview pane at lines 3063-3076.
- **Logic:**
  1. Add `#kanban-preview-meta-bar` div inside `#kanban-preview-pane`, above `#kanban-preview-content` (line ~3068):
     ```html
     <div id="kanban-preview-meta-bar" style="display:none;">
       <!-- Rendered dynamically by JS -->
     </div>
     ```
  2. In kanban controls strip (line ~3059): Change `Import Plans` → `Import`.
  3. In kanban controls strip: Add `<button id="btn-kanban-log" class="strip-btn" disabled title="View action log for selected plan">Log</button>` after the Import button.
- **Edge Cases:** Meta bar must be hidden when no plan is selected (default state).

### `src/webview/planning.js`

- **Context:** Main JS for the planning panel. `renderKanbanPlans()` at lines 4107-4291. Row click handler sets `_kanbanSelectedPlan` and fetches preview.
- **Logic:**
  1. In `renderKanbanPlans()`, add complexity dot to each `.kanban-plan-item`:
     - Import `scoreToCategory` and `categoryToCssClass` logic: compute category from `plan.complexity`, then CSS class.
     - Add a `<span class="complexity-dot {cssClass}"></span>` to the top-right of each card.
     - CSS: `.complexity-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }` with colour per class.
  2. In the row click handler (inside `itemDiv.addEventListener('click', ...)`), add:
     - Show `#kanban-preview-meta-bar`, render with current plan's column, complexity, log button, delete button.
     - Post `planShown` message: `vscode.postMessage({ type: 'planShown', sessionId: plan.sessionId })`.
  3. Add meta bar interaction handlers:
     - **Column badge click:** Toggle a `<select>` dropdown with all columns + "COMPLETED". On change, post `moveKanbanPlanColumn`. Include "Delete Plan" option at bottom of dropdown.
     - **Complexity badge click:** Toggle a `<select>` dropdown with Unknown, 1-10. On change, post `setKanbanPlanComplexity`.
     - **Log button click:** Post `fetchKanbanPlanLog`.
     - **Delete button click:** `window.confirm('Delete this plan?')`, then post `deleteKanbanPlan`.
  4. Add `kanbanPlanLogReady` message handler: Render modal overlay with timestamp, workflow, details per entry. Close button dismisses.
  5. Add `kanbanPlanDeleted` message handler: Clear `_kanbanSelectedPlan`, hide meta bar, clear preview pane, re-render list.
  6. Add `activateKanbanTabAndSelectPlan` message handler:
     - Activate "KANBAN PLANS" tab via existing tab-switching logic.
     - Store pending selection: `state.pendingKanbanSelection = { sessionId, planFile }`.
     - Check if `_kanbanPlans` already has a match — if so, select immediately.
     - Otherwise, post `fetchKanbanPlans` to refresh.
  7. In `handleKanbanPlansReady`, add guard: if `state.pendingKanbanSelection` is set, find matching plan and select it, then clear pending state.
  8. Enable/disable `#btn-kanban-log` based on whether a plan is selected (same pattern as Edit/Review buttons).
- **Edge Cases:** Plan with empty `sessionId` — skip `planShown` post. Plan with empty `planFile` — skip preview fetch. Dropdown positioning must not overflow viewport.

### `src/services/KanbanProvider.ts`

- **Context:** Kanban board provider. `reviewPlan` handler at lines 5305-5311 currently calls `switchboard.reviewPlanFromKanban`.
- **Logic:**
  1. Accept `planningPanelProvider` instance via constructor parameter (added in `extension.ts`).
  2. In `reviewPlan` handler (line 5305), replace:
     ```typescript
     // OLD:
     await vscode.commands.executeCommand('switchboard.reviewPlanFromKanban', reviewSessionId, msg.workspaceRoot);
     // NEW:
     this._planningPanelProvider.reveal();
     this._planningPanelProvider.postMessageToWebview({
         type: 'activateKanbanTabAndSelectPlan',
         sessionId: reviewSessionId,
         planFile: msg.planFile || '',
         workspaceRoot: msg.workspaceRoot || ''
     });
     ```
  3. Add `postMessageToWebview()` public method to `PlanningPanelProvider` if not already exposed (thin wrapper around `this._panel?.webview.postMessage()`).
- **Edge Cases:** `reviewSessionId` may be undefined — guard with early return (existing behavior).

### `src/extension.ts`

- **Context:** Extension entry point. Creates all providers and registers commands.
- **Logic:**
  1. Pass `planningPanelProvider` instance to `KanbanProvider` constructor (after both are created).
  2. Remove `import { ReviewProvider, ReviewCommentRequest, ReviewCommentResult, ReviewOpenPlanOption, ReviewPlanContext, ReviewTicketData, ReviewTicketUpdateRequest, ReviewTicketUpdateResult } from './services/ReviewProvider'` (line 13).
  3. Add `import { ReviewCommentRequest, ReviewCommentResult, ... } from './services/reviewTypes'` for types still needed by remaining command handlers.
  4. Remove `const reviewProvider = new ReviewProvider(context.extensionUri)` (line 681).
  5. Remove ALL 7 command registrations:
     - `switchboard.reviewPlanFromKanban` (lines 1084-1087)
     - `switchboard.reviewPlan` (lines 2076-2128)
     - `switchboard.sendReviewComment` (lines 2130-2228) — **Clarification:** The `sendReviewComment` command is used by BOTH the old review panel AND the planning panel's `submitComment` flow. The planning panel calls it via `vscode.commands.executeCommand('switchboard.sendReviewComment', ...)`. This command must be KEPT but its type imports must come from `reviewTypes.ts` instead of `ReviewProvider.ts`. Do NOT remove this command.
     - `switchboard.getReviewTicketData` (lines 2230-2236)
     - `switchboard.updateReviewTicket` (lines 2238-2244)
     - `switchboard.getReviewOpenPlans` (lines 2246-2252)
     - `switchboard.reviewSendToAgent` (lines 2254-2260)
  6. Remove `reviewProvider` references from `context.subscriptions`.
- **Edge Cases:** `sendReviewComment` must NOT be removed — it's shared infrastructure. Only the review-panel-specific commands are removed.

### `src/services/TaskViewerProvider.ts`

- **Context:** Session tree provider with review-specific methods that will become dead code.
- **Logic:** Remove the following methods:
  - `handleKanbanReviewPlan` (line 3141-3143)
  - `_handleReviewPlan` (lines 13247-13254)
  - `getReviewTicketData` (lines 12866-12927)
  - `getReviewOpenPlans` (lines 12931-12983)
  - `updateReviewTicket` (lines 13053-13236)
  - `sendReviewTicketToNextAgent` (search for method definition)
  - `_getReviewLogEntries` (lines 12824-12864) — replaced by `reviewLogUtils.ts`
- **Edge Cases:** Check for any internal callers of these methods within TaskViewerProvider itself. If `_getReviewLogEntries` is called elsewhere in TaskViewerProvider (non-review context), update those call sites to use `reviewLogUtils.ts` instead.

### `src/webview/review.html` — DELETE

- No references to preserve. Pure deletion.

### `src/services/ReviewProvider.ts` — DELETE

- Type definitions moved to `reviewTypes.ts` first. Then delete.

### `test/review-send-agent-trigger-regression.test.js` — DELETE

- Tests ReviewProvider-specific behavior. No longer applicable.

## Verification Plan

### Automated Tests

- Skip compilation per session directive.
- Skip automated tests per session directive.
- Post-merge: run `npm run compile` and `npm test` to confirm zero TypeScript errors and no test regressions.

### Manual Verification

1. Open the Kanban Plans tab. Each plan card in the left list should show a coloured complexity dot (read-only).
2. Select a plan. The preview pane shows a metadata bar above the markdown: `[Column: CREATED ▼] [Complexity: ● 5 ▼] [Log] [Delete]`.
3. Click the Column badge — dropdown with columns + "Delete Plan" option. Changing column moves the plan. Selecting "Delete Plan" prompts and removes it.
4. Click the Complexity badge — dropdown with 1-10 + Unknown. Changing updates the dot colour on refresh.
5. Click the Log button — a modal shows timestamp/workflow/details for each action log entry.
6. Click the Delete button — confirmation dialog, then plan is removed from DB (markdown file stays on disk).
7. Select a plan — the sidebar tree highlights the corresponding session.
8. In the kanban board, click "Review Plan" on any card — `planning.html` opens with the Kanban Plans tab active and the correct plan selected and previewed.
9. Grep for `ReviewProvider` across the codebase — zero references remain (except `reviewTypes.ts` which contains the relocated type definitions).
10. Verify `switchboard.sendReviewComment` command still works from the planning panel's Review mode.

## Risks & Notes

- **Action Log Data Format:** The old ticket viewer gets action logs via `TaskViewerProvider.getReviewTicketData()`. The log formatting logic (`_getReviewLogEntries`) is extracted to `reviewLogUtils.ts` as a shared utility — not duplicated.
- **Kanban Board → Planning Panel coupling:** `KanbanProvider` receives `PlanningPanelProvider` instance via constructor injection in `extension.ts`. No singleton pattern needed.
- **Session ID vs Plan File for selection:** When redirecting from the kanban board, we may only have `sessionId`. The kanban plans list is keyed by `planId` (which equals `sessionId`). The selection logic matches on both `sessionId` and `planFile` for robustness.
- **Type hostage resolution:** `ReviewCommentRequest` / `ReviewCommentResult` are moved to `reviewTypes.ts` before `ReviewProvider.ts` deletion. The `sendReviewComment` command registration is KEPT (shared infrastructure) with imports updated to the new location.
- **Plan deletion safety:** `deleteKanbanPlan` removes the DB record only. The markdown file remains on disk and can be re-imported if needed. This avoids irreversible data loss.

## Recommendation

Complexity 6 → **Send to Coder**

## Review Findings

Implementation was largely complete but had five material issues. Two CRITICAL runtime bugs fixed: `deleteKanbanPlan` called `db.deletePlan(planId)` which expects a sessionId (not plan_id primary key) — silently failing; `setKanbanPlanComplexity` called non-existent `db.updatePlan()` — would throw at runtime. Added `deletePlanByPlanId` and `updateComplexityByPlanId` to KanbanDatabase and updated handlers. Two MAJOR UI bugs fixed: `.complexity-dot` and meta bar CSS were entirely missing from `planning.html` (invisible/unstyled elements); `kanbanPlanLogReady` used `window.alert()` instead of modal overlay per plan spec. One MAJOR logic gap fixed: `activateKanbanTabAndSelectPlan` didn't check already-loaded cache per plan's dual-path guard requirement. Files changed: `planning.html`, `planning.js`, `PlanningPanelProvider.ts`, `KanbanDatabase.ts`. Remaining risk: orphaned `plan_events` rows on plan deletion (pre-existing, no CASCADE FK).
