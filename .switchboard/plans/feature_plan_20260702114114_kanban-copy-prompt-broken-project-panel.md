# Kanban Copy Prompt Buttons Broken in Project Panel

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

`dispose()` disposes ALL entries in `_disposables` (line 8837):

```typescript
// dispose() — line 8837-8838
this._disposables.forEach(d => d.dispose());
this._disposables = [];
```

The Project panel's `onDidReceiveMessage` handler was registered into this same `_disposables` array (line 365-376):

```typescript
// openProject() — line 365-376
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

After `dispose()`, the code at line 8843-8852 re-registers the Project panel's `onDidDispose` handler but **does NOT re-register `onDidReceiveMessage`**:

```typescript
// dispose() — line 8843-8852
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

## Metadata
- **Tags**: bug, project-panel, kanban, copy-prompt, dispose, message-handler, regression
- **Complexity**: 5
- **Files**: `src/services/PlanningPanelProvider.ts`, `src/webview/project.js`

## Complexity Audit
**Moderate risk.** The fix touches the `dispose()` lifecycle, which is critical to extension stability. The core fix is re-registering the Project panel's `onDidReceiveMessage` handler after `dispose()` clears `_disposables`. A more robust long-term fix would use separate disposable arrays for each panel, but that's a larger refactor. The proposed fix is minimal and safe.

## Edge-Case & Dependency Audit
- **Both panels open, Planning panel closed**: This is the primary trigger. The fix re-registers the message handler so the Project panel continues functioning.
- **Both panels open, Project panel closed**: The Project panel's `onDidDispose` handler (registered in `openProject()`) nulls `_projectPanel`. No issue — the Planning panel's handler is still in `_disposables`.
- **Both panels closed**: `dispose()` is called, both panels are disposed. No issue.
- **Planning panel reopened after dispose()**: `open()` creates a new `_panel` and registers new handlers into `_disposables`. If the Project panel was re-registered during `dispose()`, its handler is in `_disposables` alongside the new Planning panel handlers. When the Planning panel is closed again, `dispose()` will again dispose both. The fix must handle repeated open/close cycles.
- **Deserialized panels**: `deserializeProjectPanel` → `_hydratePanel` registers the message handler into `_disposables`. If the Planning panel was deserialized via `deserializeWebviewPanel` → `_hydratePanel`, it also registers into `_disposables`. Closing the deserialized Planning panel calls `dispose()` which kills the deserialized Project panel's handler. Same bug, same fix.
- **Extension deactivation**: `context.subscriptions` disposal calls `dispose()`. This is expected — everything should be torn down. The fix should not interfere with this.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Re-register Project panel message handler after dispose()

In `dispose()`, after re-registering the `onDidDispose` handler (line 8846-8852), also re-register the `onDidReceiveMessage` handler:

```typescript
// dispose() — after line 8852
if (this._projectPanel) {
    // Re-register the onDidDispose listener (existing code)
    this._disposables.push(
        this._projectPanel.onDidDispose(() => {
            this._projectPanel = undefined;
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
// copyKanbanPlanPrompt case (line ~3216)
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

Apply the same to the `copyEpicPlannerPrompt` case (lines ~3233–3268).

### 3. `src/webview/project.js` — Widen the list-refresh guard in `kanbanPlanPromptCopied`

The column advance happens in the backend regardless of which tab the user is on. Change the guard from `activeTab === 'kanban'` to also cover the epics tab:

```js
// Refresh the plan list so the card reflects any column advance.
// Must fire for both kanban and epics tabs — epic copy prompts use the
// same response type and also advance the plan in the backend.
if (activeTab === 'kanban' || activeTab === 'epics') {
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
```

## Verification Plan

1. **Unit test** — Add a test in `src/test/project-panel-dispose-survival.test.js` that:
   - Reads `PlanningPanelProvider.ts` source and asserts that `dispose()` re-registers `onDidReceiveMessage` for the project panel (not just `onDidDispose`).
   - Reads `project.js` source and asserts the `kanbanPlanPromptCopied` handler refreshes for both `kanban` and `epics` active tabs.

2. **Manual test** (via installed VSIX):
   - Open both the Planning (ARTIFACTS) panel and the Project panel.
   - In the Project panel → Kanban tab, click "Copy Prompt" on a plan card. Verify it works (button updates, clipboard populated, plan advances).
   - Close the Planning panel.
   - In the Project panel → Kanban tab, click "Copy Prompt" again. **Verify it still works** (this is the critical test — before the fix, this would fail).
   - Switch to the Epics tab, click "Copy Planning Prompt" on an epic card. Verify it works.
   - Reopen the Planning panel, then close it again. Verify the Project panel still works (tests repeated open/close cycles).

3. **Regression check** — Verify the Planning panel's copy prompt still works after being reopened.
