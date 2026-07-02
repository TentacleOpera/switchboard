# Kanban Copy Prompt Buttons Broken in Project Panel

**Plan ID:** 6e438479-62fc-4593-9aba-7333ab3576a

## Goal

### Problem
The "Copy Prompt" buttons on kanban plan cards in the Project panel (`project.html` → Kanban tab) do not work. Clicking them neither copies a prompt to the clipboard nor advances the plan to the next workflow column. The buttons appear to do nothing.

### Background Context
The Project panel (`project.html` / `project.js`) and the Planning panel (`planning.html` / `planning.js`) are both webview panels managed by `PlanningPanelProvider`. They share a single `_handleMessage` method and a single `_disposables` array. The Kanban board (`kanban.html` / `KanbanProvider.ts`) is a separate webview with its own message handler.

The "Copy Prompt" button in `project.js` sends a `copyKanbanPlanPrompt` message to the backend via `vscode.postMessage()`. The backend's `onDidReceiveMessage` handler receives this and processes it through `_handleMessage`. If the backend never receives the message, the button does nothing.

### Root Cause Analysis

**Primary root cause: Closing the Planning panel (ARTIFACTS) silently kills the Project panel's message handler.**

When the Planning panel is closed, its `onDidDispose` callback calls `this.dispose()` (line 554):

```typescript
// open() — line 552-558
this._panel.onDidDispose(
    () => {
        this.dispose();   // ← disposes EVERYTHING
    },
    null,
    this._disposables
);
```

`dispose()` disposes ALL entries in `_disposables` (line 8848):

```typescript
// dispose() — line 8848-8849
this._disposables.forEach(d => d.dispose());
this._disposables = [];
```

The Project panel's `onDidReceiveMessage` handler was registered into this same `_disposables` array (line 366-376):

```typescript
// openProject() — line 366-376
this._projectPanel.webview.onDidReceiveMessage(
    async message => {
        try {
            await this._handleMessage(message, true);
        } catch (err) { ... }
    },
    null,
    this._disposables   // ← shared array, disposed when Planning panel closes
);
```

After `dispose()`, the code at line 8857-8863 re-registers the Project panel's `onDidDispose` handler but **does NOT re-register `onDidReceiveMessage`**:

```typescript
// dispose() — line 8854-8863
// If the project panel is still open, its onDidDispose listener was just
// removed by clearing _disposables above. Re-register it so _projectPanel
// is cleared when that panel is eventually closed.
if (this._projectPanel) {
    this._disposables.push(
        this._projectPanel.onDidDispose(() => {
            this._projectPanel = undefined;
        })
    );
}
```

The comment acknowledges the problem but only fixes half of it. The `onDidReceiveMessage` handler is NOT re-registered. The Project panel becomes a **zombie** — still visible, webview JS still running, but the backend can no longer receive any messages from it.

**Result**: After the Planning panel is closed:
- `copyKanbanPlanPrompt` messages from the Project panel go nowhere → button never updates, no clipboard copy, no column advance
- `fetchKanbanPlanPreview` messages go nowhere → previews stay on "Loading preview..." (this is the root cause of Issue 2 as well)
- The backend can still PUSH messages TO the Project panel (via `postMessage`), so the sidebar list may still update from periodic syncs — making the failure look partial and confusing

**Why the ready-queue theory was wrong**: The user confirmed the panel had been open for a long time, so `_projectPanelReady` was `true`. The ready-queue bypass is a real but minor issue that only affects cold-start. The persistent failure is caused by the disposed message handler.

**Secondary issue**: The `kanbanPlanPromptCopied` handler in `project.js` (line ~795) only refreshes the plan list when `activeTab === 'kanban'`. Epic copy prompts (which use the same response type) don't trigger a UI refresh. This is a minor issue that should be fixed alongside the primary fix.

**Additional gap discovered during review**: The re-registered `onDidDispose` in `dispose()` (line 8859-8861) is a TRUNCATED copy of the original handler. The original `onDidDispose` (registered in `openProject()`, line 379-390) does three things: nulls `_projectPanel`, resets `_projectPanelReady = false`, and clears `_pendingProjectMessages` + kills the ready timer. The re-registered version only nulls `_projectPanel`. This leaves stale ready state and pending messages if the Project panel closes after the Planning panel was closed. The fix must mirror the original handler's full cleanup.

## Metadata
- **Tags**: bugfix, ui
- **Complexity**: 5
- **Files**: `src/services/PlanningPanelProvider.ts`, `src/webview/project.js`

## User Review Required

No — the root cause is fully diagnosed and the fix is mechanical. The plan is ready for implementation. Reviewer should confirm the `onDidDispose` cleanup upgrade is included (see Change #1).

## Complexity Audit

### Routine
- Re-registering `onDidReceiveMessage` in `dispose()` — mirrors existing registration pattern at line 366-376
- Routing `kanbanPlanPromptCopied` responses through `postMessageToProjectWebview` — direct substitution of `this._projectPanel?.webview.postMessage` with the queue helper
- The list-refresh guard widening (Change #3) is already done — no work needed

### Complex / Risky
- The `dispose()` lifecycle is critical to extension stability. Re-registering handlers in the middle of a dispose call is unusual but safe — the Planning panel's `onDidDispose` has already fired, and the Project panel is still alive
- The `onDidDispose` cleanup upgrade touches ready-state management (`_projectPanelReady`, `_pendingProjectMessages`, timer) — must exactly mirror the original handler at line 379-390 to avoid stale-state bugs on panel reopen

## Edge-Case & Dependency Audit
- **Race Conditions**: Microsecond window between `this._disposables.forEach(d => d.dispose())` (line 8848) and the re-registration of `onDidReceiveMessage` where an in-flight Project panel message could be lost. Practically negligible — the user is not interacting with the Project panel during the Planning panel's close event. A true fix would use separate disposable arrays per panel (deferred as a larger refactor).
- **Security**: No security implications. The fix re-registers an existing message handler with identical logic.
- **Side Effects**: Re-registering `onDidReceiveMessage` adds a new subscription to `_disposables`. On the next `dispose()` cycle (Planning panel closed again), this subscription is disposed and re-registered again. The cycle is stable because `dispose()` always checks `if (this._projectPanel)` before re-registering.
- **Dependencies & Conflicts**: This plan shares its primary fix (Change #1) with the "All Previews Broken in Project Panel" plan. Both must apply the identical `dispose()` fix. No conflict — the fix is idempotent. The `onDidDispose` cleanup upgrade is also shared.

## Dependencies
- None — this plan is self-contained. The primary fix is shared with `feature_plan_20260702114115_all-previews-broken-project-panel.md` but neither blocks the other; they touch the same code site with identical changes.

## Adversarial Synthesis

Key risks: (1) the re-registered `onDidDispose` is a truncated copy of the original handler — missing ready-state and pending-message cleanup, causing stale state on panel reopen; (2) a microsecond dispose-to-reregister race window where an in-flight message could be lost (negligible in practice); (3) Change #3 was already shipped and must be marked complete, not re-implemented. Mitigations: mirror the original `onDidDispose` handler's full cleanup in the re-registration; accept the race as negligible and defer separate-disposable-arrays to a future refactor; strike Change #3 from proposed changes.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Re-register Project panel message handler AND upgrade `onDidDispose` cleanup after dispose()

**This is the primary fix and is shared with the "All Previews Broken" plan — both must apply this identical change.**

In `dispose()`, replace the existing re-registration block (line 8857-8863) with a version that re-registers BOTH `onDidDispose` (with full cleanup) AND `onDidReceiveMessage`:

```typescript
// dispose() — replace line 8857-8863
if (this._projectPanel) {
    // Re-register the onDidDispose listener with FULL cleanup — mirror the
    // original handler registered in openProject() (line 379-390). The previous
    // re-registration only nulled _projectPanel, leaving _projectPanelReady
    // and _pendingProjectMessages stale. If the Project panel reopens later,
    // stale pending messages could flush into the fresh panel.
    this._disposables.push(
        this._projectPanel.onDidDispose(() => {
            this._projectPanel = undefined;
            this._projectPanelReady = false;
            this._pendingProjectMessages = [];
            if (this._projectPanelReadyTimer) {
                clearTimeout(this._projectPanelReadyTimer);
                this._projectPanelReadyTimer = undefined;
            }
        })
    );
    // CRITICAL: Also re-register the message handler. dispose() cleared
    // _disposables above, which disposed the original onDidReceiveMessage
    // subscription. Without this, the Project panel becomes a zombie —
    // still visible but the backend can no longer receive messages from it.
    // This is the root cause of "copy prompt buttons don't work" and
    // "all previews stopped working" after the Planning panel is closed.
    this._disposables.push(
        this._projectPanel.webview.onDidReceiveMessage(
            async (message: any) => {
                try {
                    await this._handleMessage(message, true);
                } catch (err) {
                    console.error('[ProjectPanel] Message handler error (re-registered):', err);
                    this._projectPanel?.webview.postMessage({ type: 'error', message: String(err) });
                }
            }
        )
    );
}
```

### 2. `src/services/PlanningPanelProvider.ts` — Route `kanbanPlanPromptCopied` through the ready-queue

As a defense-in-depth measure, replace direct `this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', ... })` calls in the `copyKanbanPlanPrompt` and `copyEpicPlannerPrompt` cases with `this.postMessageToProjectWebview(...)`. This ensures responses are queued if the panel is in a readiness transition:

```typescript
// copyKanbanPlanPrompt case (line ~3212-3228)
if (!sessionId) {
    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId' });
    break;
}
try {
    const success = await vscode.commands.executeCommand<boolean>(
        'switchboard.copyPlanFromKanban', sessionId, column, wsRoot
    );
    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: !!success, sessionId });
} catch (err) {
    console.error('[ProjectPanel] copyKanbanPlanPrompt failed:', err);
    this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
}
```

Apply the same substitution to the `copyEpicPlannerPrompt` case (lines ~3230–3281) — replace all 6 `this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', ... })` calls with `this.postMessageToProjectWebview(...)`.

### 3. `src/webview/project.js` — List-refresh guard widening (ALREADY DONE)

**Status: COMPLETE — no code change needed.**

Line 795 already reads:
```js
if (activeTab === 'kanban' || activeTab === 'epics') {
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
```

This was verified against the current source during plan review. No action required.

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user. The following test is recommended for separate execution:
- A test in `src/test/project-panel-dispose-survival.test.js` that reads `PlanningPanelProvider.ts` source and asserts that `dispose()` re-registers BOTH `onDidReceiveMessage` AND a full-cleanup `onDidDispose` for the project panel.

### Manual Verification (via installed VSIX)
1. Open both the Planning (ARTIFACTS) panel and the Project panel.
2. In the Project panel → Kanban tab, click "Copy Prompt" on a plan card. Verify it works (button updates, clipboard populated, plan advances).
3. **Close the Planning panel.**
4. In the Project panel → Kanban tab, click "Copy Prompt" again. **Verify it still works** (this is the critical test — before the fix, this would fail).
5. Switch to the Epics tab, click "Copy Planning Prompt" on an epic card. Verify it works.
6. Reopen the Planning panel, then close it again. Verify the Project panel still works (tests repeated open/close cycles).
7. Close the Project panel (after the Planning panel was already closed). Reopen the Project panel. Verify copy prompt works and no stale messages appear (tests the `onDidDispose` cleanup upgrade).

### Regression Check
- Verify the Planning panel's copy prompt still works after being reopened.
- Verify extension deactivation does not error (re-registration during teardown is harmless).

## Recommendation

**Complexity: 5 → Send to Coder.**
