# All Previews Broken in Project Panel

## Goal

### Problem
All preview panes in the Project panel (`project.html`) have stopped rendering. This affects every tab: Kanban plan previews, Epic previews, Constitution previews, System (CLAUDE.md/AGENTS.md) previews, Tuning insight previews, and Projects PRD previews. The preview area shows "Loading preview..." or remains blank indefinitely. The user reports this is a recurring regression.

### Background Context
The Project panel (`project.html` / `project.js`) and the Planning panel (`planning.html` / `planning.js`) are both webview panels managed by a single `PlanningPanelProvider` instance. They share:
- A single `_handleMessage` method (dispatched via a `switch` on `msg.type`)
- A single `_disposables` array (for lifecycle management)
- The same backend message handlers for `fetchKanbanPlanPreview`, `readConstitutionFile`, `getProjectPrd`, `loadInsights`, etc.

Each preview type follows the same request-response pattern:
1. **Frontend** (`project.js`): User selects an item → sends `fetchKanbanPlanPreview` (or `readConstitutionFile`, `getProjectPrd`, etc.) via `vscode.postMessage()`
2. **Backend** (`PlanningPanelProvider._handleMessage`): Reads the file, calls `markdown.api.render`, posts the rendered HTML back
3. **Frontend** (`project.js`): Receives the response message and sets `previewContent.innerHTML = msg.content`

If the backend never receives the request, the preview stays on "Loading preview..." forever. This affects ALL preview types because they all depend on the same `onDidReceiveMessage` pipeline.

### Root Cause Analysis

**Primary root cause: Closing the Planning panel (ARTIFACTS) silently kills the Project panel's message handler — the same root cause as the broken Copy Prompt buttons.**

When the Planning panel is closed, its `onDidDispose` callback calls `this.dispose()` (line 554):

```typescript
// open() — line 552-558
this._panel.onDidDispose(
    () => {
        this.dispose();   // ← disposes EVERYTHING in _disposables
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

The Project panel's `onDidReceiveMessage` handler — which is the backend's ONLY way to receive messages from the Project panel webview — was registered into this same shared `_disposables` array (line 365-376):

```typescript
// openProject() — line 365-376
this._projectPanel.webview.onDidReceiveMessage(
    async message => {
        try {
            await this._handleMessage(message, true);
        } catch (err) { ... }
    },
    null,
    this._disposables   // ← SHARED array — disposed when Planning panel closes
);
```

After `dispose()`, the code re-registers the Project panel's `onDidDispose` handler but **does NOT re-register `onDidReceiveMessage`** (line 8843-8852). The existing comment even acknowledges the problem:

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
    // ← onDidReceiveMessage is NOT re-registered here!
}
```

The Project panel becomes a **zombie**: still visible, webview JS still running, but the backend can no longer receive ANY messages from it. Every `fetchKanbanPlanPreview`, `readConstitutionFile`, `getProjectPrd`, `loadInsights` request goes into the void. All previews stay stuck on "Loading preview..." or blank.

**Why the backend can still PUSH to the Project panel**: `postMessage` is called on the webview object directly (e.g., `this._projectPanel?.webview.postMessage(...)`), which doesn't depend on `_disposables`. So backend-pushed messages like `kanbanPlansReady` (from periodic syncs) still reach the frontend, and the sidebar list may still update. This makes the failure look partial and confusing — the list works but previews don't — because the list is push-driven while previews are request-driven.

**Why the ready-queue theory was wrong**: The user confirmed the panel had been open for a long time, so `_projectPanelReady` was `true`. The ready-queue bypass is a real but minor issue that only affects cold-start. The persistent failure is caused by the disposed `onDidReceiveMessage` handler.

**Secondary issues** (should be fixed alongside the primary fix but are not the root cause):
1. **`path.resolve` for relative plan paths**: `_handleFetchKanbanPlanPreview` (line 1345) uses `path.resolve(filePath)` where `filePath` is a relative path like `.switchboard/plans/foo.md`. This resolves relative to `process.cwd()`, which may not match the workspace root in multi-root setups. The fix should resolve against workspace roots.
2. **Missing CSP `file:` scheme**: `project.html`'s CSP `img-src` lacks `file:` (present in `planning.html`), blocking local image rendering in previews.
3. **Missing error display in kanban preview handler**: `project.js`'s `kanbanPlanPreviewReady` handler (line 582) doesn't check `msg.error` — unlike `planning.js` which shows an error message. Errors silently produce blank previews.
4. **Direct `postMessage` bypasses ready-queue**: Various preview response sends use `this._projectPanel?.webview.postMessage()` directly instead of `postMessageToProjectWebview()`, which could drop messages during cold-start.

## Metadata
- **Tags**: bug, project-panel, preview, dispose, message-handler, regression, CSP
- **Complexity**: 5
- **Files**: `src/services/PlanningPanelProvider.ts`, `src/webview/project.html`, `src/webview/project.js`

## Complexity Audit
**Moderate risk.** The primary fix touches the `dispose()` lifecycle — re-registering the Project panel's `onDidReceiveMessage` handler after `_disposables` is cleared. This is the same fix as the Copy Prompt issue (both share the same root cause). The secondary fixes (CSP, path resolution, error display) are low-risk incremental improvements. The path resolution fix requires careful handling of multi-root workspaces.

## Edge-Case & Dependency Audit
- **Both panels open, Planning panel closed**: This is the primary trigger. The fix re-registers the message handler so the Project panel continues functioning. ALL previews and ALL copy prompts resume working.
- **Both panels open, Project panel closed**: The Project panel's `onDidDispose` handler nulls `_projectPanel`. No issue.
- **Planning panel reopened after dispose()**: `open()` creates a new `_panel` and registers new handlers. The re-registered Project panel handler from `dispose()` is in `_disposables` alongside the new Planning panel handlers. When the Planning panel is closed again, `dispose()` will again dispose both — the fix must re-register again. This cycle works because `dispose()` always checks `if (this._projectPanel)` before re-registering.
- **Deserialized panels**: `deserializeProjectPanel` → `_hydratePanel` registers into `_disposables`. Same bug, same fix.
- **Extension deactivation**: `context.subscriptions` disposal calls `dispose()`. This is expected teardown — the re-registration is harmless (the panel will be disposed shortly after).
- **Multi-root workspace**: `path.resolve('.switchboard/plans/foo.md')` resolves against `process.cwd()`, which may not match the plan's actual workspace root. The fix should try each allowed root.
- **CSP `file:` scheme**: Adding `file:` to `img-src` aligns `project.html` with `planning.html`. No security risk — `file:` images are already allowed in the Planning panel.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Re-register Project panel message handler after dispose()

**This is the primary fix and is shared with the Copy Prompt issue.**

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
    // This is the root cause of "all previews stopped working" and
    // "copy prompt buttons don't work" after the Planning panel is closed.
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

### 2. `src/services/PlanningPanelProvider.ts` — Fix `path.resolve` for relative plan paths in `_handleFetchKanbanPlanPreview`

Resolve relative paths against workspace roots, not just `process.cwd()`:

```typescript
private async _handleFetchKanbanPlanPreview(filePath: string, requestId: number): Promise<void> {
    const allRoots = Array.from(this._getAllowedRoots());
    // Resolve relative paths against workspace roots, not just CWD
    let resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : '';
    if (!resolved || !fs.existsSync(resolved)) {
        for (const root of allRoots) {
            const candidate = path.resolve(root, filePath);
            if (fs.existsSync(candidate)) {
                resolved = candidate;
                break;
            }
        }
        if (!resolved) {
            resolved = path.resolve(filePath); // fall back to CWD resolution for the error message
        }
    }
    const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
    // ... rest of the method unchanged, use `resolved` for file reads
```

### 3. `src/webview/project.html` — Add `file:` to CSP `img-src`

Align the CSP with `planning.html`:

```html
<!-- Change: data:; → data: file:; in img-src -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: 'nonce-{{NONCE}}' 'unsafe-inline' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: 'unsafe-inline'; img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data: file:; font-src {{WEBVIEW_CSP_SOURCE}} https:; connect-src https:; frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: http: about:srcdoc blob: data:;">
```

### 4. `src/webview/project.js` — Add error display in `kanbanPlanPreviewReady` handler

Mirror `planning.js`'s error handling so failed previews show a visible error instead of a blank pane:

```js
case 'kanbanPlanPreviewReady':
    if (kanbanPreviewContent && _kanbanSelectedPlan && _kanbanSelectedPlan.planFile === msg.filePath) {
        if (state.editMode.kanban) {
            state.externalChangePending.kanban = true;
        } else {
            if (msg.error) {
                kanbanPreviewContent.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error reading file: ${escapeHtml(msg.error)}</div>`;
            } else {
                kanbanPreviewContent.innerHTML = msg.content || '';
            }
            state.editOriginalContent.kanban = msg.rawContent || '';
            const dynamicEditBtn = document.getElementById('btn-edit-kanban');
            if (dynamicEditBtn) dynamicEditBtn.disabled = false;
            if (_pendingAutoEdit) {
                _pendingAutoEdit = false;
                enterEditMode('kanban');
            }
        }
    }
    // ... epics preview handling unchanged
    break;
```

### 5. `src/services/PlanningPanelProvider.ts` — Route preview responses through the ready-queue

As defense-in-depth, replace direct `this._projectPanel?.webview.postMessage(...)` calls for preview responses with `this.postMessageToProjectWebview(...)`. Key cases:
- `_handleFetchKanbanPlanPreview` — change `targetPanel?.webview.postMessage(...)` to use `postMessageToProjectWebview` for the project panel path
- `constitutionFileRead` responses — change `_postToBothPanels` to send to each panel through its respective queue helper
- `projectPrdContent` responses — same

## Verification Plan

1. **Unit test** — Add a test in `src/test/project-panel-dispose-survival.test.js` that:
   - Reads `PlanningPanelProvider.ts` source and asserts that `dispose()` re-registers `onDidReceiveMessage` for the project panel (not just `onDidDispose`).
   - Reads `project.html` source and asserts the CSP `img-src` includes `file:`.
   - Reads `project.js` source and asserts the `kanbanPlanPreviewReady` handler checks `msg.error`.

2. **Manual test** (via installed VSIX):
   - Open both the Planning (ARTIFACTS) panel and the Project panel.
   - In the Project panel → Kanban tab, click a plan card. Verify the preview renders.
   - **Close the Planning panel.**
   - In the Project panel → Kanban tab, click another plan card. **Verify the preview still renders** (this is the critical test — before the fix, this would fail).
   - Switch to the Constitution tab. Select a workspace. Verify the constitution preview renders.
   - Switch to the System tab. Verify CLAUDE.md/AGENTS.md preview renders.
   - Switch to the Projects tab. Select a project. Verify the PRD preview renders.
   - Switch to the Tuning tab. Select an insight. Verify the insight preview renders.
   - Reopen the Planning panel, then close it again. Verify the Project panel previews still work (tests repeated open/close cycles).
   - Open a plan file with a local image reference. Verify the image renders (tests CSP fix).

3. **Regression check** — Verify the Planning panel's previews still work after being reopened.
