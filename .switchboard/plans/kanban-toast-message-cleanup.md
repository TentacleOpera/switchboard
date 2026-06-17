# Kanban Toast Message Cleanup

## Metadata
**Complexity:** 4
**Tags:** ui, ux, refactor

## User Review Required
- Confirm status bar auto-hide duration preference (5s vs 3s).
- Confirm fallback behavior when kanban panel is closed: this plan enforces **silent skip** everywhere (no toast fallback) to avoid spam.

## Goal
Reduce toast message spam by routing kanban-related status messages to the kanban status bar, adding auto-dismissal timers to remaining toasts, and removing unnecessary messages.

## Problem
The Switchboard extension currently shows 211 unique toast messages across the codebase. During normal kanban operations, users are bombarded with repetitive toasts such as:
- "Dispatched X plans to Jules"
- "Completed X of Y plans"
- "Agent terminals already open. Focused: X"
- "Agent Grid initialized: X, Y, Z"

These messages clutter the screen and distract from the workflow. A custom status bar already exists at the top of `kanban.html` (element `#status-message`) with a `showStatusMessage` message handler that supports flashing animations, but it's underutilized.

## Solution Overview
1. **Route kanban operation messages to status bar**: Messages about dispatching, completing, and agent terminal operations that originate from kanban interactions should use the existing status bar instead of VS Code toasts.
2. **Add auto-dismissal to remaining toasts**: For toasts that must remain (e.g., errors, warnings), add a 2-3 second auto-dismiss timer.
3. **Remove redundant toasts**: Eliminate messages that provide no actionable value or duplicate information already visible in the UI.

## Complexity Audit

### Routine
- Replacing `vscode.window.showInformationMessage` with `this._panel?.webview.postMessage` in KanbanProvider.ts (7 locations).
- Adding null-safe helper in `extension.ts` to route through `kanbanProvider?.postMessage()`.
- CSS/JS auto-hide timer in kanban.html `showStatusMessage` handler.

### Complex / Risky
- Phase 3 auto-dismiss exists in `TaskViewerProvider._showTemporaryNotification` (line 9091) but is private; extracting to a shared utility adds a new file and import graph.
- Extension.ts relies on a global `kanbanProvider` reference that may be null during early activation.
- Status bar message queue behavior must be reduced to "latest wins" to keep scope contained.

## Implementation Plan

### Phase 1: Route Kanban Dispatch Messages to Status Bar

**Files to modify:**
- `src/services/KanbanProvider.ts`

**Changes:**
1. Replace `vscode.window.showInformationMessage()` calls with `this._panel?.webview.postMessage({ type: 'showStatusMessage', message: ..., isError: false })` for:
   - Line 4991: `Dispatched ${dispatchedCount} LOW-complexity plans to Jules.`
   - Line 5390: `Dispatched ${dispatchedCount} plans to Jules.`
   - Line 5417: `Dispatched ${eligibleSessionIds.length} plan(s) to Splitter.`
   - Line 5744: `Code map dispatched for ${succeeded}/${msg.sessionIds.length} plan(s).${failMsg}`
   - Line 5458: `Completed ${successCount} of ${msg.sessionIds.length} plans.`
   - Line 5488: `Completed ${successCount} of ${reviewedCards.length} plans.`
   - Line 5682: `Complex prompt copied to clipboard. Dispatching Routine tasks to Coder terminal...`

2. Ensure null checks for `this._panel` before posting messages.

### Phase 2: Route Agent Terminal Messages to Status Bar

**Files to modify:**
- `src/extension.ts`

**Changes:**
1. Replace `vscode.window.showInformationMessage()` with status bar routing for:
   - Line 2477: `Agent terminals already open. Focused: ${firstAgent.name}`
   - Line 2537: `Agent Grid initialized: ${agents.map(a => a.name).join(', ')}`

2. Add a helper method in `extension.ts` that calls `kanbanProvider?.postMessage({ type: 'showStatusMessage', message, isError: false })`. If `kanbanProvider` is null or panel is closed, **silently skip** — do not fallback to toast.

### Phase 3: Auto-Dismissal for Remaining Toasts

**Clarification:** The codebase already has a working auto-dismiss pattern. `TaskViewerProvider._showTemporaryNotification` (`src/services/TaskViewerProvider.ts:9091`) uses `vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: message, cancellable: false }, async () => { await new Promise(resolve => setTimeout(resolve, durationMs)); })`.

**Files to modify:**
- `src/extension.ts`

**Changes:**
1. Extract the existing `_showTemporaryNotification` pattern into a shared utility (e.g., `src/utils/showTemporaryNotification.ts`) or import/reuse it from `TaskViewerProvider`.
2. Apply the utility to remaining non-critical information toasts that don't need persistent visibility.
3. For toasts that must stay as `showInformationMessage` (user-action prompts, confirmations), keep manual dismissal.

### Phase 4: Remove Redundant Toasts

**Files to review:**
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/SetupPanelProvider.ts`

**Criteria for removal:**
- Messages that duplicate information visible in the UI (e.g., plan status changes visible on cards)
- Messages that provide no actionable information
- Messages that are purely informational with no user action required

**Specific candidates for removal:**
- Line 4934: Already uses status bar, verify no duplicate toast
- Line 4963: Already uses status bar, verify no duplicate toast
- Review all 54 information messages in `docs/TOAST_MESSAGES.md` for redundancy

### Phase 5: Update Status Bar Behavior

**Files to modify:**
- `src/webview/kanban.html`

**Changes:**
1. Enhance the `showStatusMessage` handler (line ~5594) to:
   - Store a timeout ID on the element; reset it each time a new message arrives ("latest wins").
   - Auto-hide the status message after 5 seconds by clearing `textContent`.
   - Keep the existing flashing animation (3s) but ensure the text is cleared 2s after animation ends.
   - *(Clarification)* A clear button and message queue are **future enhancements**; out of scope for this pass.

2. Update CSS if needed to ensure the status bar is noticeable but not distracting.

## Proposed Changes

### src/services/KanbanProvider.ts
- **Context:** `onDidReceiveMessage` handler contains dispatch/completion toasts.
- **Logic:** Replace 7 `vscode.window.showInformationMessage` calls with `this._panel?.webview.postMessage({ type: 'showStatusMessage', message: ..., isError: false })`.
- **Lines:** 4991, 5390, 5417, 5744, 5458, 5488, 5682.
- **Edge Cases:** If `_panel` is undefined, message is silently skipped (no fallback toast).

### src/extension.ts
- **Context:** `createAgentGrid` shows agent terminal focus/init toasts.
- **Logic:** Add helper `postKanbanStatus(message: string, isError = false)` that calls `kanbanProvider?.postMessage({ type: 'showStatusMessage', message, isError })`. Replace lines 2477 and 2537 with this helper.
- **Edge Cases:** If `kanbanProvider` is null, silently skip per edge-case policy. Do NOT fallback to toast.
- **Phase 3 addition:** Extract `TaskViewerProvider._showTemporaryNotification` (line 9091) into a shared utility (`src/utils/showTemporaryNotification.ts`) using `vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: message, cancellable: false }, async () => { await new Promise(resolve => setTimeout(resolve, durationMs)); })`. Apply to non-critical transient toasts.

### src/webview/kanban.html
- **Context:** `showStatusMessage` handler (line ~5594) sets text and flashes but never clears.
- **Logic:** Add `setTimeout` to clear `#status-message.textContent` after 5000ms. Store timeout ID and reset on each new message ("latest wins").
- **Edge Cases:** Rapid messages reset timer; long messages may not be fully read — duration kept fixed for this pass.

### src/services/KanbanProvider.ts (Phase 4 cleanup)
- **Context:** Redundant toasts.
- **Logic:** Verify lines 4934 and 4963 already use status bar only; no duplicate toast exists. No code change required beyond verification.

## Edge-Case & Dependency Audit

### Race Conditions
- Batch dispatch loops send one summary message per batch. If multiple batches run concurrently, last status wins. Acceptable.
- `kanbanProvider` global in `extension.ts` may be null if `createAgentGrid` is called before the panel is ever opened. `kanbanProvider?.postMessage()` handles this safely.

### Security
- No auth tokens or sensitive data in these messages. Safe.

### Side Effects
- Removing toasts may hide progress feedback for users who keep the kanban panel closed. Mitigated by keeping errors as toasts and enforcing the silent-skip policy.

### Dependencies & Conflicts
- `KanbanProvider.postMessage()` public method (line 1228) is the preferred routing API. No new dependencies.
- No conflicts with other active features.

## Dependencies
- none

## Adversarial Synthesis
Key risks: (1) The existing `_showTemporaryNotification` pattern (`TaskViewerProvider.ts:9091`) works but is currently private and duplicated nowhere; extracting it to a shared utility adds a new file and import graph. (2) Ambiguous fallback strategy in extension.ts (silent skip vs toast fallback) could leave users without feedback during agent grid initialization. This plan resolves by enforcing **silent skip** everywhere. (3) Status bar queue implementation is unspecified and risks message loss under rapid dispatch. Mitigations: Extract shared `withProgress` utility; enforce silent-skip consistency; implement a 5s `setTimeout` auto-hide in `kanban.html` with "latest wins" behavior.

## Testing Checklist

- [ ] Batch dispatch operations show status bar messages instead of toasts (when kanban panel is open)
- [ ] Agent terminal initialization shows status bar message (when kanban panel is open)
- [ ] Plan completion shows status bar message (when kanban panel is open)
- [ ] Status bar messages auto-hide after 5 seconds
- [ ] When kanban panel is closed, dispatch/completion/terminal messages are silently skipped (no toast, no panel open)
- [ ] Error messages still appear as toasts regardless of kanban panel state
- [ ] No regression in existing functionality (dispatch, complete, terminal focus)

## Verification Plan

### Automated Tests
- Skipped per session directive. Test suite run separately by user.

### Manual Verification
- [ ] Batch dispatch operations show status bar messages instead of toasts (when kanban panel is open)
- [ ] Agent terminal initialization shows status bar message (when kanban panel is open)
- [ ] Plan completion shows status bar message (when kanban panel is open)
- [ ] Status bar messages auto-hide after 5 seconds
- [ ] When kanban panel is closed, dispatch/completion/terminal messages are silently skipped (no toast, no panel open)
- [ ] Error messages still appear as toasts regardless of kanban panel state
- [ ] No regression in existing functionality (dispatch, complete, terminal focus)

## Risks

- **Risk**: Users may miss status bar messages if they're not looking at the kanban panel.
  - **Mitigation**: Keep critical errors as toasts; use status bar only for informational updates.
- **Risk**: Status bar message queue could become complex.
  - **Mitigation**: Start with simple "show latest only" behavior, enhance later if needed.
- **Risk**: Auto-dismissal timing may be too short/long.
  - **Mitigation**: Make duration configurable in settings.

## Files Changed

- `src/services/KanbanProvider.ts` (~7 message routing changes)
- `src/extension.ts` (~2 message routing changes + helper method)
- `src/webview/kanban.html` (status bar auto-hide enhancement)

## Recommendation

**Send to Coder**
