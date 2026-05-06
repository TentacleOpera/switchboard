---
description: Fix drag-and-drop "copy prompt" mode that doesn't copy prompts to clipboard
---

# Fix Copy Prompt Drag-and-Drop Mode

## Goal
Fix the bug where setting a column's drag-and-drop mode to "Copy Prompt" and dragging cards into it doesn't copy the prompts to the clipboard — specifically because prompt mode is incorrectly gated behind `cliTriggersEnabled`.

## Metadata
**Tags:** bugfix, UX, workflow
**Complexity:** 3

## User Review Required
None — this is a straightforward conditional logic fix with no design decisions.

## Complexity Audit

### Routine
- Restructure the `cliTriggersEnabled` conditional in `handleDrop()` regular path (`kanban.html:3618`)
- Fix the dispatch type resolution in `handleDrop()` CODED_AUTO path (`kanban.html:3397`)
- Verify `promptOnDrop` handler in `KanbanProvider.ts:3884-3963` works correctly (clipboard write, card advance)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the drop handler is single-threaded in the webview. The `promptOnDrop` message is processed sequentially by the extension.
- **Security:** Clipboard write via `vscode.env.clipboard.writeText` is safe; no user-controlled content injection risk beyond what already exists.
- **Side Effects:** Restructuring the conditional must preserve existing CLI dispatch behaviour when `dropMode === 'cli'` and `cliTriggersEnabled === true`. The `moveCardForward` fallback must still fire when both prompt and CLI are inapplicable.
- **Dependencies & Conflicts:** None. Kanban NEW and PLANNED columns are empty. No active plans touch `handleDrop()` or drag-drop logic.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) The CODED_AUTO path has the same `cliTriggersEnabled` gate — fixing only the regular path would leave a partial bug. (2) Restructuring the conditional could accidentally change CLI dispatch behaviour if the `else` chain isn't carefully ordered. Mitigations: Fix both paths; test with CLI triggers both on and off.

## Problem Analysis

### Current Behavior
1. User clicks the mode toggle button on a kanban column
2. Selects "Copy Prompt" mode (sets `dragDropMode` to `'prompt'`)
3. Drags cards into that column
4. Nothing happens — no prompt is copied to clipboard

### Root Cause Analysis

The mode persistence flow is **working correctly**:
- Mode toggle (`kanban.html:2650-2663`) sends `setColumnDragDropMode` message → extension persists to workspaceState
- Board refresh (`KanbanProvider.ts:1180-1188, 1902-1910, 2026-2034`) correctly merges built-in defaults with user overrides via `updateColumnDragDropModes`
- Webview (`kanban.html:3829-3847`) correctly receives and applies modes to `columnDragDropModes` variable
- `setColumnDragDropMode` handler (`KanbanProvider.ts:3749-3755`) correctly persists to workspaceState

**The actual bug is the `cliTriggersEnabled` gate in two locations:**

**Bug Location 1 — Regular drop path** (`kanban.html:3618`):
```javascript
if (cliTriggersEnabled && forwardIds.length > 0) {
    if (dropMode === 'prompt') {
        postKanbanMessage({ type: 'promptOnDrop', ... });
    } else {
        // CLI dispatch
    }
} else if (forwardIds.length > 0) {
    postKanbanMessage({ type: 'moveCardForward', ... });  // ← prompt mode falls through here
}
```
When `cliTriggersEnabled` is `false`, the `else if` just moves the card forward without copying the prompt, regardless of `dropMode`.

**Bug Location 2 — CODED_AUTO drop path** (`kanban.html:3397`):
```javascript
const dispatchType = tgtIdx < srcIdx
    ? 'backward'
    : (!cliTriggersEnabled ? 'move' : (dropMode === 'prompt' ? 'prompt' : 'cli'));
```
When `cliTriggersEnabled` is `false`, `dispatchType` is always `'move'`, even when `dropMode === 'prompt'`.

**The `promptOnDrop` handler** (`KanbanProvider.ts:3884-3963`) works correctly — it generates the prompt, writes to clipboard, and advances cards. The issue is that it's never reached when CLI triggers are disabled.

## Proposed Changes

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Fix the `cliTriggersEnabled` gate in the regular drop path**
   - **File:** `src/webview/kanban.html`
   - **Line:** 3618
   - **Context:** The `if (cliTriggersEnabled && forwardIds.length > 0)` block gates both CLI dispatch and prompt mode behind CLI triggers. Prompt mode should work independently.
   - **Current code (lines 3618-3633):**
     ```javascript
     if (cliTriggersEnabled && forwardIds.length > 0) {
         if (dropMode === 'prompt') {
             postKanbanMessage({ type: 'promptOnDrop', sessionIds: forwardIds, sourceColumn: sourceColumnForPrompt, targetColumn: effectiveTargetColumn, workspaceRoot });
         } else {
             if (forwardIds.length === 1) {
                 postKanbanMessage({ type: 'triggerAction', sessionId: forwardIds[0], targetColumn: effectiveTargetColumn, workspaceRoot });
             } else {
                 postKanbanMessage({ type: 'triggerBatchAction', sessionIds: forwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
             }
         }
     } else if (forwardIds.length > 0) {
         postKanbanMessage({ type: 'moveCardForward', sessionIds: forwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
     }
     ```
   - **Fixed code:**
     ```javascript
     if (forwardIds.length > 0) {
         if (dropMode === 'prompt') {
             // Prompt mode: copy prompt to clipboard + visual advance (no CLI dispatch needed)
             postKanbanMessage({ type: 'promptOnDrop', sessionIds: forwardIds, sourceColumn: sourceColumnForPrompt, targetColumn: effectiveTargetColumn, workspaceRoot });
         } else if (cliTriggersEnabled) {
             // CLI mode: dispatch to CLI agent (existing behaviour)
             if (forwardIds.length === 1) {
                 postKanbanMessage({ type: 'triggerAction', sessionId: forwardIds[0], targetColumn: effectiveTargetColumn, workspaceRoot });
             } else {
                 postKanbanMessage({ type: 'triggerBatchAction', sessionIds: forwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
             }
         } else {
             // No CLI triggers and not prompt mode — just move the card forward
             postKanbanMessage({ type: 'moveCardForward', sessionIds: forwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
         }
     }
     ```
   - **Logic:** Check `dropMode` first (prompt is independent of CLI triggers), then check `cliTriggersEnabled` for CLI dispatch, then fall through to simple move.

2. **Fix the `cliTriggersEnabled` gate in the CODED_AUTO drop path**
   - **File:** `src/webview/kanban.html`
   - **Line:** 3397
   - **Context:** The dispatch type resolution for CODED_AUTO drops also gates prompt mode behind `cliTriggersEnabled`.
   - **Current code (line 3395-3397):**
     ```javascript
     const dispatchType = tgtIdx < srcIdx
         ? 'backward'
         : (!cliTriggersEnabled ? 'move' : (dropMode === 'prompt' ? 'prompt' : 'cli'));
     ```
   - **Fixed code:**
     ```javascript
     const dispatchType = tgtIdx < srcIdx
         ? 'backward'
         : (dropMode === 'prompt' ? 'prompt' : (!cliTriggersEnabled ? 'move' : 'cli'));
     ```
   - **Logic:** Check `dropMode === 'prompt'` first (independent of CLI triggers), then fall through to the `cliTriggersEnabled` check for CLI vs. move.

3. **Verify `promptOnDrop` handler handles the CLI-triggers-off case correctly**
   - **File:** `src/services/KanbanProvider.ts`
   - **Lines:** 3884-3963
   - **Verification:** The `promptOnDrop` handler already works correctly — it generates the prompt via `_generatePromptForColumn`, writes to clipboard via `vscode.env.clipboard.writeText`, and advances cards. No changes needed here.
   - **Clarification:** The handler does NOT depend on `cliTriggersEnabled` — it's purely a clipboard copy + card advance operation. Confirmed by reading lines 3928-3962.

## Verification Plan

### Automated Tests
- No existing automated tests for drag-drop behaviour. Adding tests is out of scope for this bugfix.

### Manual Testing
1. Open Kanban view
2. Click the mode toggle on a column (e.g., "CODER CODED") — verify it switches to "Copy Prompt" icon
3. Drag a card from PLAN REVIEWED to that column
4. **Expected:** Prompt is copied to clipboard, notification shows "Copied prompt for X plan(s) to clipboard", count badge flashes green
5. **Disable CLI triggers** (toggle in Kanban header)
6. Drag another card to the same "Copy Prompt" column
7. **Expected:** Prompt is STILL copied to clipboard (this is the bug fix — previously it would just move the card)
8. **Test CODED_AUTO path:** Drag a card to the CODED_AUTO column with prompt mode set on a coded sub-column
9. **Expected:** Prompt is copied even with CLI triggers disabled
10. Reload VS Code window and verify the mode setting persists
11. Test with `dropMode === 'cli'` and `cliTriggersEnabled === false` — should just move the card (no regression)

## Files to Modify
- `src/webview/kanban.html` (lines 3397 and 3618-3633 — conditional restructuring in two locations)

## Edge Cases to Handle
1. Column is a built-in column with `dragDropMode: 'disabled'` — user override is already ignored by the `effectiveModes` merge logic in `KanbanProvider.ts:1184-1186`. No change needed.
2. Multiple cards dragged at once — all prompts are batched in the `promptOnDrop` message. Already handled.
3. User switches modes while drag is in progress — `dropMode` is read at drop time from `columnDragDropModes`, which is the latest state. No race condition.
4. Clipboard write fails — `vscode.env.clipboard.writeText` doesn't throw on failure in VS Code; it silently fails. The card still advances visually. Acceptable behaviour.

## Recommendation
**Send to Coder** — Complexity 3. Two targeted conditional restructuring changes in a single file. No architectural changes, no new patterns, no data consistency risks.

---
## Review & Verification

### Grumpy Principal Engineer Review
- **NIT:** No material defects. The logic is fine, though relying on `typeof` or structured objects instead of nested ternaries `(!cliTriggersEnabled ? 'move' : 'cli')` is generally more readable. However, it matches the existing file's style. 

### Balanced Synthesis
- **Action:** LGTM. No further code fixes required.
- The conditional restructuring exactly mirrors the plan. Both the regular path and the CODED_AUTO path accurately prioritize `prompt` mode independently of `cliTriggersEnabled`.

### Update
- **Files Modified:** `src/webview/kanban.html`
- **Validation:** Code compiled successfully (`npm run compile`). The drag-and-drop conditions are structurally sound. No remaining risks for this UX fix.
