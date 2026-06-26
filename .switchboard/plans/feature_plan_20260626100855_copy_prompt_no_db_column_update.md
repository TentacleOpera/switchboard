# Bug: Copy Prompt on Plan Does Not Update DB Column or Kanban Position

## Goal

### Problem
Clicking "Copy Prompt" on a plan in the Kanban Plans tab of `project.html` does
not update the plan's kanban DB column entry, does not advance the card's kanban
column position, and the plan stays in the wrong status in the Kanban Plans tab
UI after the copy.

### Background
The Kanban Plans tab in `project.html` renders each plan with a "Copy Prompt"
button (`.kanban-plan-copy-prompt`). On click, `project.js` (lines 1174-1185)
posts a `copyKanbanPlanPrompt` message to the extension:

```javascript
const copyPromptBtn = itemDiv.querySelector('.kanban-plan-copy-prompt');
if (copyPromptBtn) {
    copyPromptBtn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({
            type: 'copyKanbanPlanPrompt',
            sessionId: copyPromptBtn.dataset.sessionId,
            column: copyPromptBtn.dataset.column,
            workspaceRoot: copyPromptBtn.dataset.workspaceRoot
        });
    });
}
```

The backend handler in `PlanningPanelProvider.ts` (lines 2615-2631) calls the
`switchboard.copyPlanFromKanban` command, which delegates to
`TaskViewerProvider._handleCopyPlanLink` (line 13773).

`_handleCopyPlanLink` (lines 13773-13907) DOES attempt to auto-advance the
column after copying the prompt (lines 13846-13892), but only when a
`workflowName` is derived. The workflow name logic (lines 13850-13858):

```typescript
const workflowName = effectiveColumn === 'CREATED'
    ? 'improve-plan'
    : effectiveColumn === 'PLAN REVIEWED'
        ? undefined                          // <-- NO advance for PLAN REVIEWED
        : this._isCompletedCodingColumn(effectiveColumn)
            ? 'reviewer-pass'
            : isTesterEligible
                ? 'tester-pass'
                : undefined;
```

So for `PLAN REVIEWED`, `workflowName` is `undefined` and **no column advance
happens at all**. For other columns, the advance happens in the DB but the
project panel UI is never refreshed.

### Root Cause
Two compounding defects:

1. **No UI refresh after copy.** The `kanbanPlanPromptCopied` message handler in
   `project.js` (lines 565-578) ONLY updates the button text ("Copied!"/"Failed")
   — it does NOT trigger a re-fetch of the kanban plans list. So even when the
   backend advances the column, the project panel's Kanban Plans tab stays stale
   showing the old column/status.

2. **`_scheduleSidebarKanbanRefresh` targets the wrong panel.** When the backend
   does advance the column (line 13879), it calls
   `this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot)` which delegates to
   `this._kanbanProvider?._scheduleBoardRefresh(workspaceRoot)` (line 2216) —
   this refreshes the **Kanban board panel** (`kanban.html`), NOT the **project
   panel's** Kanban Plans tab. The project panel never receives a refresh signal.

3. **`PLAN REVIEWED` never advances.** For plans already in `PLAN REVIEWED`,
   `workflowName` is `undefined`, so no advance occurs. This is by design for
   some flows (the planner prompt is the terminal state before coding), but the
   user expects the card to at least reflect a "prompt copied" state. At minimum
   the UI must refresh to show the current DB state.

**Bug status: STILL PRESENT** (verified in source).

## Metadata
**Tags:** bug, project-panel, kanban-plans, copy-prompt, column-advance, refresh
**Complexity:** 5
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Add a kanban plans re-fetch to the `kanbanPlanPromptCopied` handler in
   `project.js`.
2. Have the backend post a refresh signal to the project panel webview after a
   successful column advance.

### Complex / Risky
1. **Which panel gets the refresh?** `_handleCopyPlanLink` lives in
   `TaskViewerProvider` and posts `copyPlanLinkResult` to `this._view` (the
   implementation/TaskViewer panel). But the copy was initiated from the
   **project panel** via `PlanningPanelProvider`. The success result is posted
   back to the project panel as `kanbanPlanPromptCopied` (PlanningPanelProvider
   line 2627). The project panel must trigger its own `fetchKanbanPlans` on
   receipt — this is the cleanest fix since the project panel owns the Kanban
   Plans tab.
2. **Avoiding double-advance.** If the user clicks Copy Prompt twice quickly,
   the dedupe lock (`_recentActionDispatches`) prevents a second dispatch, but
   the UI refresh must not cause a re-render that re-fires the copy. The refresh
   is a read-only `fetchKanbanPlans`, so this is safe.
3. **`PLAN REVIEWED` advance semantics.** Whether a copy-prompt from
   `PLAN REVIEWED` should advance to a coding column is a product decision. The
   minimal fix is to ensure the UI refreshes to show the true DB state regardless
   of whether an advance happened. If the product intent is that
   `PLAN REVIEWED` copy should advance to `LEAD CODED`/`CODER CODED` based on
   complexity, that's a separate `workflowName` change — flag it but don't
   assume.

## Edge-Case & Dependency Audit

- **Copy from kanban.html vs project.html:** The kanban.html Copy Prompt button
  uses a different handler (`promptSelected` message) that does optimistic UI
  movement. The project.html handler uses `copyKanbanPlanPrompt`. Both reach
  `_handleCopyPlanLink`. The fix must refresh whichever panel initiated the
  copy. The project panel fix (re-fetch on `kanbanPlanPromptCopied`) covers the
  project.html path; the kanban.html path already has optimistic movement.
- **Column advance failure:** When `_applyManualKanbanColumnChange` fails
  (line 13882), a warning is shown but the UI still won't refresh. The refresh
  must fire in both success and failure cases so the UI reflects the true DB
  state (which may be unchanged on failure).
- **`copyPlanLinkResult` to TaskViewer panel:** This message goes to the
  implementation panel, not the project panel. Don't rely on it for the project
  panel refresh.

## Proposed Changes

### File: `src/webview/project.js`

**Change 1 — Re-fetch kanban plans after a copy-prompt result (lines 565-578).**

Replace the `kanbanPlanPromptCopied` case with:
```javascript
case 'kanbanPlanPromptCopied': {
    const btn = msg.sessionId
        ? document.querySelector(`.kanban-plan-copy-prompt[data-session-id="${msg.sessionId}"]`)
        : null;
    if (btn) {
        const oldText = btn.textContent;
        btn.textContent = msg.success ? 'Copied!' : 'Failed';
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = oldText;
            btn.disabled = false;
        }, 2000);
    }
    // Refresh the kanban plans list so the card reflects any column advance
    // the backend performed after copying the prompt. Without this, the card
    // stays in its old column/status in the UI.
    if (msg.success && activeTab === 'kanban') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

### File: `src/services/PlanningPanelProvider.ts`

**Change 2 — Post a refresh hint to the project panel after copy (after line
2627).**

After the existing `kanbanPlanPromptCopied` post, also post a
`kanbanPlansRefreshNeeded` signal so the project panel re-fetches even if the
button-text handler raced:
```typescript
this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: !!success, sessionId });
// The project panel's Kanban Plans tab must re-fetch to reflect any column
// advance performed by _handleCopyPlanLink. The kanbanPlanPromptCopied handler
// in project.js fires the fetch; this explicit signal is a belt-and-suspenders
// for cases where the button selector misses.
if (success) {
    this._projectPanel?.webview.postMessage({ type: 'kanbanPlansRefreshNeeded' });
}
```

And in `project.js`, add a handler:
```javascript
case 'kanbanPlansRefreshNeeded':
    if (activeTab === 'kanban') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
```

### File: `src/services/TaskViewerProvider.ts` (optional hardening)

**Change 3 — Also refresh the project panel after a column advance (line 13879).**

The `_scheduleSidebarKanbanRefresh` only refreshes the kanban board panel. After
a successful advance, also message the project panel via the planning panel
provider. If `this._planningPanelProvider` is accessible from
`TaskViewerProvider`, add:
```typescript
if (advanced) {
    // ... existing board refresh ...
    this._planningPanelProvider?.postMessageToProjectWebview({ type: 'kanbanPlansRefreshNeeded' });
}
```
This is optional if Change 1+2 reliably cover the project panel refresh, but
makes the refresh robust against message-ordering races.

## Verification Plan

1. **Repro on current build:** In the project panel Kanban Plans tab, click
   "Copy Prompt" on a plan in the "Created" column. Confirm the prompt copies but
   the card stays in "Created" in the UI (bug). Check `kanban.db` — the column
   may have advanced but the UI didn't refresh.
2. **Apply the fix** and rebuild.
3. **Created → advance test:** Click Copy Prompt on a "Created" plan. Confirm
   the card moves to "Plan Reviewed" in the UI after the copy (re-fetch fires).
4. **Coded → advance test:** Click Copy Prompt on a "LEAD CODED" plan. Confirm
   the card advances to "Code Reviewed" and the UI refreshes.
5. **PLAN REVIEWED test:** Click Copy Prompt on a "PLAN REVIEWED" plan. Confirm
   the UI refreshes (shows true DB state). Document whether an advance is
   expected here — if not, the card stays in PLAN REVIEWED but the UI is
   consistent with the DB.
6. **Failure test:** Force a column-advance failure (e.g. corrupt the session).
   Confirm the UI refreshes to show the card unchanged (no stale "advanced"
   state).
7. **Kanban board panel regression test:** Confirm the kanban.html board still
   refreshes after a copy-prompt initiated from the project panel (no regression
   in `_scheduleSidebarKanbanRefresh`).
8. **DB consistency test:** After each copy-prompt, query `kanban.db`:
   `SELECT session_id, kanban_column FROM plans WHERE session_id = ?` and confirm
   the UI column matches the DB column.
