# Bug: Copy Prompt on Plan Does Not Update DB Column or Kanban Position

## Goal

Fix the Kanban Plans tab in the project panel so that clicking "Copy Prompt" on a
plan triggers a UI refresh that reflects any column advance the backend performed,
and ensures the card's displayed column/status matches the true `kanban.db` state
after the copy.

### Problem
Clicking "Copy Prompt" on a plan in the Kanban Plans tab of `project.html` does
not update the plan's kanban DB column entry, does not advance the card's kanban
column position, and the plan stays in the wrong status in the Kanban Plans tab
UI after the copy.

### Background
The Kanban Plans tab in `project.html` renders each plan with a "Copy Prompt"
button (`.kanban-plan-copy-prompt`). On click, `project.js` (lines 1188-1199)
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
   `project.js` (lines 567-581) ONLY updates the button text ("Copied!"/"Failed")
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

4. **No file watcher on `kanban.db`.** The existing auto-refresh mechanism in
   `PlanningPanelProvider` (lines 849-883) watches `.switchboard/plans/**/*.md`
   files — NOT `kanban.db`. Column advances write to `kanban.db` via
   `_applyManualKanbanColumnChange` (line 3188:
   `this._updateKanbanColumnForSession`), which does NOT modify the plan `.md`
   file. Therefore the file watcher never fires, and the project panel never
   gets an auto-refresh signal from a column advance. This is why the bug is
   specific to copy-prompt (which advances the column in the DB) and not to
   plan-file edits (which trigger the watcher).

**Bug status: STILL PRESENT** (verified in source).

## Metadata
**Tags:** bugfix, frontend, ui, database
**Complexity:** 4

## User Review Required
Yes — the `PLAN REVIEWED` advance semantics are a product decision. The minimal
fix (UI refresh only) does NOT change advance behavior. If the product intent is
that `PLAN REVIEWED` copy-prompt should advance to `LEAD CODED`/`CODER CODED`
based on complexity, that is a separate change and must be explicitly requested.
This plan does NOT implement that advance.

## Complexity Audit

### Routine
- Add a `fetchKanbanPlans` re-fetch call to the `kanbanPlanPromptCopied` handler
  in `project.js` (lines 567-581). This follows the exact same pattern already
  used by the `kanbanPlanColumnChanged` handler (line 462) and the
  `kanbanPlanDeleted` handler (line 473).
- The `fetchKanbanPlans` message type is already handled by
  `PlanningPanelProvider` (line 2493), which posts `kanbanPlansReady` back to
  the project panel (line 2553). The `kanbanPlansReady` handler in `project.js`
  (line 304) already re-renders the kanban plans list. So the re-fetch flow is
  fully wired end-to-end — only the trigger is missing.

### Complex / Risky
- **Which panel gets the refresh?** `_handleCopyPlanLink` lives in
  `TaskViewerProvider` and posts `copyPlanLinkResult` to `this._view` (the
  implementation/TaskViewer panel). But the copy was initiated from the
  **project panel** via `PlanningPanelProvider`. The success result is posted
  back to the project panel as `kanbanPlanPromptCopied` (PlanningPanelProvider
  line 2627). The project panel must trigger its own `fetchKanbanPlans` on
  receipt — this is the cleanest fix since the project panel owns the Kanban
  Plans tab.
- **Avoiding double-advance.** If the user clicks Copy Prompt twice quickly,
  the dedupe lock (`_recentActionDispatches`) prevents a second dispatch, but
  the UI refresh must not cause a re-render that re-fires the copy. The refresh
  is a read-only `fetchKanbanPlans`, so this is safe.
- **`PLAN REVIEWED` advance semantics.** Whether a copy-prompt from
  `PLAN REVIEWED` should advance to a coding column is a product decision. The
  minimal fix is to ensure the UI refreshes to show the true DB state regardless
  of whether an advance happened. If the product intent is that
  `PLAN REVIEWED` copy should advance to `LEAD CODED`/`CODER CODED` based on
  complexity, that's a separate `workflowName` change — flag it but don't
  assume.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `fetchKanbanPlans` handler in PlanningPanelProvider
  (line 2496) has a request-ID dedup guard
  (`if (requestId <= (this._latestRequestIds.get(guardKey) || 0)) { break; }`).
  Multiple rapid re-fetch requests (e.g. from a double-click) are safely
  deduplicated — only the latest request's response is posted to the webview.
- **Security:** No security implications — this is a UI refresh trigger, not a
  data mutation. The `fetchKanbanPlans` handler is read-only.
- **Side Effects:** The re-fetch triggers a full `kanbanPlansReady` message,
  which re-renders the entire kanban plans list. This is the same behavior as
  column-change and delete operations — no new side effects.
- **Dependencies & Conflicts:**
  - **Copy from kanban.html vs project.html:** The kanban.html Copy Prompt
    button uses a different handler (`promptSelected` message) that does
    optimistic UI movement. The project.html handler uses `copyKanbanPlanPrompt`.
    Both reach `_handleCopyPlanLink`. The fix must refresh whichever panel
    initiated the copy. The project panel fix (re-fetch on
    `kanbanPlanPromptCopied`) covers the project.html path; the kanban.html path
    already has optimistic movement.
  - **Column advance failure:** When `_applyManualKanbanColumnChange` fails
    (line 13882), a warning is shown but the UI still won't refresh. The refresh
    must fire in both success and failure cases so the UI reflects the true DB
    state (which may be unchanged on failure).
  - **`copyPlanLinkResult` to TaskViewer panel:** This message goes to the
    implementation panel, not the project panel. Don't rely on it for the
    project panel refresh.

## Dependencies
- None — this is a standalone bugfix.

## Adversarial Synthesis
Key risks: (1) Change 3 as originally written references `this._planningPanelProvider`
which does not exist on `TaskViewerProvider` — it must route through
`this._kanbanProvider` instead; (2) the re-fetch must fire on both success AND
failure, not just success, to avoid stale UI on advance failure; (3) the
`PLAN REVIEWED` non-advance is a design decision, not a bug — adding advance
logic would be net-new product scope. Mitigations: drop the redundant
`kanbanPlansRefreshNeeded` message (Change 1 alone is sufficient since
`kanbanPlanPromptCopied` already fires on both success and failure); fix Change 3
to use `this._kanbanProvider` or drop it as optional; re-fetch unconditionally
in the `kanbanPlanPromptCopied` handler.

## Proposed Changes

### File: `src/webview/project.js`

**Change 1 — Re-fetch kanban plans after a copy-prompt result (lines 567-581).**

The `kanbanPlanPromptCopied` message is posted by `PlanningPanelProvider` on
BOTH success and failure (lines 2627-2629). The current handler only updates
button text. Add a `fetchKanbanPlans` re-fetch that fires unconditionally
(regardless of success/failure) so the UI always reflects the true DB state.

Replace the `kanbanPlanPromptCopied` case (lines 567-581) with:
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
    // stays in its old column/status in the UI. Fire on both success AND
    // failure — on failure the DB state is unchanged, but the UI must still
    // be consistent with the DB (no stale "advanced" state from a prior
    // action). The fetchKanbanPlans handler in PlanningPanelProvider has a
    // request-ID dedup guard (line 2496) so duplicate requests are safe.
    if (activeTab === 'kanban') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

**Context:** `activeTab` is a module-level variable in `project.js` (line 7:
`let activeTab = 'kanban'`), updated on tab switch (line 18). It is accessible
inside the message handler closure. The `fetchKanbanPlans` message is already
handled by `PlanningPanelProvider` (line 2493), which posts `kanbanPlansReady`
back to the project panel (line 2553). The `kanbanPlansReady` handler in
`project.js` (line 304) re-renders the kanban plans list. This is the same
pattern used by `kanbanPlanColumnChanged` (line 462) and `kanbanPlanDeleted`
(line 473).

**Edge Cases:**
- If the user is not on the Kanban tab when the copy completes, the re-fetch is
  skipped (the `activeTab === 'kanban'` guard). When they switch back to Kanban,
  the tab-switch handler (line 34) fires `fetchKanbanPlans` anyway, so the data
  will be fresh.
- If the button selector misses (e.g. the plan was re-rendered between click and
  response), the button text update is skipped but the re-fetch still fires,
  ensuring the list is refreshed.

### File: `src/services/PlanningPanelProvider.ts`

**Change 2 — (DROPPED — not needed)**

The original plan proposed posting a separate `kanbanPlansRefreshNeeded`
message as belt-and-suspenders. This is unnecessary because
`kanbanPlanPromptCopied` is already posted on both success and failure
(PlanningPanelProvider lines 2627-2629), and Change 1 now re-fetches
unconditionally on receipt. Adding a second message type would create
redundant code paths and potential message-ordering races with no benefit.

No changes to `PlanningPanelProvider.ts` are needed.

### File: `src/services/TaskViewerProvider.ts` (optional hardening)

**Change 3 — Also refresh the project panel after a column advance (line 13879).**

The `_scheduleSidebarKanbanRefresh` (line 2215-2216) only refreshes the kanban
board panel (`kanban.html`), NOT the project panel. After a successful advance,
the project panel relies on Change 1's `kanbanPlanPromptCopied` →
`fetchKanbanPlans` flow for its refresh.

**IMPORTANT CORRECTION:** The original plan referenced
`this._planningPanelProvider?.postMessageToProjectWebview(...)` — this property
does NOT exist on `TaskViewerProvider`. `TaskViewerProvider` has
`this._kanbanProvider`, and `KanbanProvider` has a PRIVATE
`_planningPanelProvider` (KanbanProvider line 168) with a public
`postMessageToProjectWebview` method on `PlanningPanelProvider` (line 696).

To add a direct project-panel refresh from `TaskViewerProvider`, you would need
to add a new public method on `KanbanProvider`:

```typescript
// In KanbanProvider.ts — new public method
public refreshProjectPanel(): void {
    this._planningPanelProvider?.postMessageToProjectWebview({
        type: 'kanbanPlansRefreshNeeded'
    });
}
```

And in `TaskViewerProvider._handleCopyPlanLink` (after line 13879):
```typescript
if (advanced) {
    // ... existing board refresh ...
    this._kanbanProvider?.refreshProjectPanel();
}
```

Plus a handler in `project.js`:
```javascript
case 'kanbanPlansRefreshNeeded':
    if (activeTab === 'kanban') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
```

**This change is OPTIONAL.** Change 1 alone is sufficient because
`kanbanPlanPromptCopied` already flows back to the project panel and triggers
the re-fetch. Change 3 adds robustness against message-ordering races (e.g. if
the `kanbanPlanPromptCopied` message arrives before the DB write completes),
but in practice the `await` on `_applyManualKanbanColumnChange` (line 13863)
ensures the DB is updated before `handleKanbanCopyPlan` returns `true`, which
is before `PlanningPanelProvider` posts `kanbanPlanPromptCopied` (line 2627).

**Recommendation:** Skip Change 3 unless message-ordering issues are observed
in testing. It adds a new public method and a new message type for marginal
benefit.

## Verification Plan

### Automated Tests
- SKIP: No automated tests will be run as part of this plan. The test suite
  will be run separately by the user.

### Manual Verification
1. **Repro on current build:** In the project panel Kanban Plans tab, click
   "Copy Prompt" on a plan in the "Created" column. Confirm the prompt copies but
   the card stays in "Created" in the UI (bug). Check `kanban.db` — the column
   may have advanced but the UI didn't refresh.
2. **Apply the fix** (Change 1 only).
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
   state). This verifies the unconditional re-fetch (not just `msg.success`).
7. **Kanban board panel regression test:** Confirm the kanban.html board still
   refreshes after a copy-prompt initiated from the project panel (no regression
   in `_scheduleSidebarKanbanRefresh`).
8. **DB consistency test:** After each copy-prompt, query `kanban.db`:
   `SELECT session_id, kanban_column FROM plans WHERE session_id = ?` and confirm
   the UI column matches the DB column.
9. **Non-Kanban tab test:** Switch to a different tab (e.g. "Epics"), then click
   Copy Prompt on a plan (if accessible). Confirm no error occurs — the
   `activeTab === 'kanban'` guard prevents the re-fetch, and switching back to
   Kanban triggers a fresh fetch via the tab-switch handler.

## Uncertain Assumptions
None — all claims have been verified against the source code. No web research is
needed.

---

**Recommendation:** Complexity is 4 → **Send to Coder**
