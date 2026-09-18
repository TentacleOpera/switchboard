# Plan Select Dropdown in Implementation Tab Opens Markdown Preview Instead of Project Panel

**Plan ID:** 7f3c1a92-4d8e-4b2a-9c6f-1e5d8a7b2046

## Goal

The Implementation tab's plan-select dropdown opens the chosen plan as a VS Code markdown preview tab. It must instead open the plan inside the Switchboard Project panel (the Kanban tab), exactly like the Kanban board's "Review Plan" button.

### Problem
The plan select dropdown in `implementation.html` auto-opens the selected plan as a VS Code markdown preview tab. It should instead open the plan in `project.html` (the Project panel), the same way the "Review Plan" button in `kanban.html` works.

### Background
The Implementation tab has a `<select id="run-sheet-select">` dropdown that lists all plans. When the user selects a plan, the `change` event handler sends a `viewPlan` message to the backend (`TaskViewerProvider`). The backend's `viewPlan` handler calls `_handleViewPlan()`, which executes the `switchboard.openPlan` VS Code command. That command opens the plan file in VS Code's built-in markdown preview (or text editor), depending on the `plans.defaultOpenMode` setting.

Meanwhile, the Kanban board's "Review Plan" button sends a `reviewPlan` message to `KanbanProvider`, which:
1. Opens/reveals the Project panel (`project.html`)
2. Sends an `activateKanbanTabAndSelectPlan` message to the Project panel's webview
3. The Project panel activates the Kanban tab, selects the plan in the sidebar, and renders the plan as HTML in the preview pane

This is the desired behavior — the plan should open inside the Switchboard UI, not in a separate VS Code editor tab.

### Root Cause
**Wrong message type.** The implementation.html dropdown sends `viewPlan` (which opens a VS Code editor tab) instead of `reviewPlan` (which opens the Project panel). The `viewPlan` handler in `TaskViewerProvider.ts:9700-9709` calls `_handleViewPlan()` at line 14215, which calls `vscode.commands.executeCommand('switchboard.openPlan', ...)` — this is the VS Code built-in markdown preview command, not the Switchboard Project panel.

The fix requires:
1. Changing the message sent by implementation.html from `viewPlan` to `reviewPlan`
2. Including the `planFile` field that the Project panel's plan-selection logic matches on
3. Adding a `reviewPlan` handler in `TaskViewerProvider` that delegates to `KanbanProvider.activatePlanInProjectPanel()`

## Metadata
- **Tags:** ui, ux, bugfix
- **Complexity:** 4

## User Review Required
Yes — confirm that opening the plan in the Project panel (Kanban tab) is the desired UX for the Implementation dropdown, and that the loss of kanban column-filter auto-narrowing (see Adversarial Synthesis) is acceptable. No destructive action; review is a UX-confirm gate only.

## Complexity Audit

### Routine
- Swap one message type (`viewPlan` → `reviewPlan`) in a single `change` handler (`implementation.html:2145`).
- Look up the selected sheet in the already-populated `currentActiveSheets` / `currentCompletedSheets` arrays to obtain `planFile`.
- Add one new `case 'reviewPlan'` in `TaskViewerProvider`'s message switch that delegates to the existing public method `KanbanProvider.activatePlanInProjectPanel()` (KanbanProvider.ts:208).
- The existing `planLoading` message handler (`implementation.html:2439-2451`) already toggles the dropdown spinner; the new handler reuses the same `planLoading` posts.

### Complex / Risky
- None. No data writes, no migrations, no new architectural patterns. The delegation target is an already-public method used by `createDraftPlanTicket` (TaskViewerProvider.ts:16703).

## Edge-Case & Dependency Audit
- **Race Conditions:** None. The dropdown selection is a synchronous user action; `activatePlanInProjectPanel` is async but the handler `await`s it. The `planLoading` spinner is cleared in a `finally` block.
- **Security:** None. No user input is passed to a shell or eval; `planFile` is a relative path sourced from the kanban DB.
- **Side Effects:** Selecting a plan will now reveal/focus the Project panel (possibly stealing focus from the sidebar). This is the intended behavior and matches the Kanban "Review Plan" button.
- **Dependencies & Conflicts:**
  - **`KanbanProvider.activatePlanInProjectPanel`** (KanbanProvider.ts:208-229): public method, already used by `createDraftPlanTicket` at TaskViewerProvider.ts:16703. Takes `planFile`, `workspaceRoot`, optional `autoEdit`. It opens/reveals the Project panel and posts `activateKanbanTabAndSelectPlan` with `planFile` to the project webview. It does **NOT** forward `column` or `project` (see Adversarial Synthesis).
  - **Sheet data format:** `toSheet` (TaskViewerProvider.ts:15376-15382) includes `sessionId`, `topic`, `planFile`, `createdAt`, `kanbanColumn`. The dropdown options use `sessionId` as the `value`. The frontend must look up the sheet by `sessionId` to obtain `planFile`.
  - **Project panel selection match:** `project.js:1564-1568` (`tryResolvePendingKanbanSelection`) matches by `planFile` OR `planId` OR `sessionId`. Since `activatePlanInProjectPanel` sends `planFile` (and empty `planId`/`sessionId`), selection resolves by `planFile`.
  - **`viewPlan` handler retention:** `type: 'viewPlan'` is sent from exactly one place — `implementation.html:2145` (verified by grep). No other webview uses it. The existing `viewPlan` handler (TaskViewerProvider.ts:9700-9709) is retained as dead code with an honest comment, not for "backward compatibility."
  - **No migration needed.** This is unreleased dev behavior.

## Dependencies
- None. This plan is self-contained and does not depend on any other in-flight plan (`sess_…`).

## Adversarial Synthesis
Key risks: (1) the `column` field is dead under the `activatePlanInProjectPanel` delegation path — that method drops `column`/`project`, so kanban column-filter auto-narrowing is lost (acceptable: `toSheet` lacks `project` anyway, so full parity was never achievable); (2) the empty-`planFile` fallback calls `_handleViewPlan` which re-opens the markdown preview — reachable only for ghost/malformed rows, kept as a last resort. Mitigations: drop `column` from the payload; keep the fallback but reframe it as a ghost-row last resort, not a "degraded experience."

## Proposed Changes

### 1. `src/webview/implementation.html` — Change `viewPlan` to `reviewPlan` with `planFile`

**File:** `src/webview/implementation.html`, lines 2137-2148

The current change handler (line 2145) only sends `sessionId`. It must also send `planFile` by looking up the selected sheet in the `currentActiveSheets` / `currentCompletedSheets` arrays. Per the Adversarial Synthesis, `column` is **dropped** — `activatePlanInProjectPanel` cannot consume it, so sending it would be dead data.

```javascript
if (runSheetSelect) {
    runSheetSelect.addEventListener('change', () => {
        renderAgentList();
        updatePlanActionStates();
        const sessionId = runSheetSelect.value;
        if (userInitiatedChange && sessionId) {
            runSheetSelect.classList.add('loading');
            if (selectArrow) selectArrow.classList.add('loading');
            // Look up the sheet to get planFile (column is intentionally omitted —
            // activatePlanInProjectPanel does not forward it, so it would be dead data).
            const sheets = currentPlanMode === 'active' ? currentActiveSheets : currentCompletedSheets;
            const sheet = sheets.find(s => s.sessionId === sessionId);
            vscode.postMessage({
                type: 'reviewPlan',
                sessionId,
                planFile: sheet?.planFile || '',
            });
        }
        userInitiatedChange = false;
    });
    // ... existing mousedown, keydown, blur handlers unchanged ...
}
```

### 2. `src/services/TaskViewerProvider.ts` — Add `reviewPlan` message handler

**File:** `src/services/TaskViewerProvider.ts`, around line 9700 (where `viewPlan` is handled)

Add a new `reviewPlan` case that delegates to `KanbanProvider.activatePlanInProjectPanel()`. Keep the existing `viewPlan` handler as dead code (no other caller found via grep) with an honest comment:

```typescript
case 'reviewPlan': {
    if (data.sessionId) {
        this._view?.webview.postMessage({ type: 'planLoading', value: true, sessionId: data.sessionId });
        try {
            const workspaceRoot = this._resolveWorkspaceRoot();
            const planFile = data.planFile || '';
            if (workspaceRoot && planFile && this._kanbanProvider) {
                // Open the plan in the Project panel, same as kanban.html's Review Plan button.
                await this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false);
            } else {
                // Last-resort fallback for ghost/malformed rows with no planFile:
                // opens the raw file in VS Code's editor. This re-introduces the old
                // markdown-preview behavior ONLY for rows that cannot be matched in
                // the Project panel.
                await this._handleViewPlan(data.sessionId);
            }
        } finally {
            this._view?.webview.postMessage({ type: 'planLoading', value: false, sessionId: data.sessionId });
        }
    }
    break;
}
```

The existing `viewPlan` case (lines 9700-9709) is retained unchanged. Add a clarifying comment that it has no remaining caller and is kept only as a safety net:

```typescript
case 'viewPlan':
    // No webview currently sends viewPlan (grep confirms implementation.html:2145
    // was the only sender and now sends reviewPlan). Retained as dead code in case
    // a future caller needs the raw VS Code editor open path.
    if (data.sessionId) { ... }  // unchanged
    break;
```

### 3. `src/webview/implementation.html` — Handle `planLoading` message (already exists, no change)

**File:** `src/webview/implementation.html`, lines 2439-2451

The existing `planLoading` message handler already toggles the loading class on the dropdown. No change needed — the new `reviewPlan` handler sends the same `planLoading` messages:

```javascript
case 'planLoading': {
    if (message.value) {
        runSheetSelect.classList.add('loading');
        if (selectArrow) selectArrow.classList.add('loading');
    } else {
        if (!message.sessionId || message.sessionId === runSheetSelect.value) {
            runSheetSelect.classList.remove('loading');
            if (selectArrow) selectArrow.classList.remove('loading');
        }
    }
    break;
}
```

**Note (cosmetic, non-blocking):** `activatePlanInProjectPanel` resolves when the panel is opened/revealed and the message posted, which may be before the Project panel's webview has finished selecting the plan. The dropdown spinner may therefore clear slightly before the plan preview is visible. This is cosmetic and matches the existing `viewPlan` timing characteristics.

## Verification Plan

### Automated Tests
No automated tests required for this change (per session directive, the test suite is run separately by the user). The change is a message-type swap plus a delegation call to an already-tested public method.

### Manual Verification
1. **Primary test:** In the Implementation tab, select a plan from the dropdown. Verify the Project panel opens (or is revealed) and the Kanban tab activates with the selected plan highlighted and its preview rendered.
2. **No VS Code tab:** Verify that no VS Code markdown preview tab or editor tab opens when selecting a plan from the dropdown.
3. **Loading indicator:** Verify the dropdown shows a loading state (spinner/loading class) while the Project panel is opening.
4. **Project panel already open:** With the Project panel already open, select a different plan from the dropdown. Verify the Project panel's Kanban tab updates to show the newly selected plan.
5. **Project panel in another window:** If the Project panel is open in another VS Code window, selecting a plan should message that panel (not steal it back to the current window) — `activatePlanInProjectPanel` only calls `revealProject()` when the panel is in the current window (KanbanProvider.ts:212-213).
6. **Ghost-row fallback:** Select a plan whose sheet has an empty `planFile` (malformed/ghost row). Verify the fallback to `_handleViewPlan` opens the plan in VS Code's editor as a last resort.
7. **Compile check:** `npm run compile` — verify no TypeScript errors (run only when producing a VSIX; not required for dev testing per project build rules).

## Review Findings

Implementation matches plan exactly: `implementation.html:2145-2153` sends `reviewPlan` with `planFile` lookup; `TaskViewerProvider.ts:9709-9730` adds the `reviewPlan` handler delegating to `activatePlanInProjectPanel`; `viewPlan` retained as dead code with comment. One CRITICAL fix applied: `src/test/kanban-view-plan-removal-regression.test.js:52-55` asserted the old `viewPlan` string in implementation.html — updated to assert `reviewPlan` and verify `viewPlan` is absent. No compile/test run per session directives. Remaining risk: `_overwriteExistingPlan` (line 17161) still uses a 2s `_pendingPlanCreations` timeout, but that is a separate overwrite path out of this plan's scope.

## Recommendation
Complexity 4 → **Send to Coder**.
