# All Previews Broken in Project Panel

**Plan ID:** d00e4c1c-3a60-4528-81bd-4ba88f426657

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

`dispose()` disposes ALL entries in `_disposables` (line 8848):

```typescript
// dispose() — line 8848-8849
this._disposables.forEach(d => d.dispose());
this._disposables = [];
```

The Project panel's `onDidReceiveMessage` handler — which is the backend's ONLY way to receive messages from the Project panel webview — was registered into this same shared `_disposables` array (line 366-376):

```typescript
// openProject() — line 366-376
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

After `dispose()`, the code re-registers the Project panel's `onDidDispose` handler but **does NOT re-register `onDidReceiveMessage`** (line 8857-8863). The existing comment even acknowledges the problem:

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
    // ← onDidReceiveMessage is NOT re-registered here!
}
```

The Project panel becomes a **zombie**: still visible, webview JS still running, but the backend can no longer receive ANY messages from it. Every `fetchKanbanPlanPreview`, `readConstitutionFile`, `getProjectPrd`, `loadInsights` request goes into the void. All previews stay stuck on "Loading preview..." or blank.

**Why the backend can still PUSH to the Project panel**: `postMessage` is called on the webview object directly (e.g., `this._projectPanel?.webview.postMessage(...)`), which doesn't depend on `_disposables`. So backend-pushed messages like `kanbanPlansReady` (from periodic syncs) still reach the frontend, and the sidebar list may still update. This makes the failure look partial and confusing — the list works but previews don't — because the list is push-driven while previews are request-driven.

**Why the ready-queue theory was wrong**: The user confirmed the panel had been open for a long time, so `_projectPanelReady` was `true`. The ready-queue bypass is a real but minor issue that only affects cold-start. The persistent failure is caused by the disposed `onDidReceiveMessage` handler.

**Additional gap discovered during review**: The re-registered `onDidDispose` in `dispose()` (line 8859-8861) is a TRUNCATED copy of the original handler. The original `onDidDispose` (registered in `openProject()`, line 379-390) does three things: nulls `_projectPanel`, resets `_projectPanelReady = false`, and clears `_pendingProjectMessages` + kills the ready timer. The re-registered version only nulls `_projectPanel`. This leaves stale ready state and pending messages if the Project panel closes after the Planning panel was closed. The fix must mirror the original handler's full cleanup.

**Secondary issues** (should be fixed alongside the primary fix but are not the root cause):
1. **`path.resolve` for relative plan paths**: `_handleFetchKanbanPlanPreview` (line 1346) uses `path.resolve(filePath)` where `filePath` is a relative path like `.switchboard/plans/foo.md`. This resolves relative to `process.cwd()`, which may not match the workspace root in multi-root setups. The fix should resolve against workspace roots.
2. **Missing CSP `file:` scheme**: `project.html`'s CSP `img-src` lacks `file:` (present in `planning.html` line 6), blocking local image rendering in previews.
3. **Missing error display in kanban preview handler**: `project.js`'s `kanbanPlanPreviewReady` handler (line 586) doesn't check `msg.error` — unlike the epics branch (line 599) which already does. Errors silently produce blank previews in the kanban tab.
4. **Direct `postMessage` bypasses ready-queue**: Various preview response sends use `this._projectPanel?.webview.postMessage()` directly instead of `postMessageToProjectWebview()`, which could drop messages during cold-start.

## Metadata
- **Tags**: bugfix, ui
- **Complexity**: 5
- **Files**: `src/services/PlanningPanelProvider.ts`, `src/webview/project.html`, `src/webview/project.js`

## User Review Required

No — the root cause is fully diagnosed and the fixes are mechanical. Reviewer should confirm the `onDidDispose` cleanup upgrade is included (see Change #1) and that the `path.resolve` security gate runs on the final resolved path (see Change #2).

## Complexity Audit

### Routine
- Re-registering `onDidReceiveMessage` in `dispose()` — mirrors existing registration pattern at line 366-376
- Adding `file:` to CSP `img-src` — trivial string addition aligning with `planning.html`
- Adding `msg.error` check to the kanban branch of `kanbanPlanPreviewReady` — mirrors the existing epics branch at line 599
- Routing preview responses through `postMessageToProjectWebview` — direct substitution

### Complex / Risky
- The `dispose()` lifecycle is critical to extension stability. Re-registering handlers in the middle of a dispose call is unusual but safe — the Planning panel's `onDidDispose` has already fired, and the Project panel is still alive
- The `onDidDispose` cleanup upgrade touches ready-state management (`_projectPanelReady`, `_pendingProjectMessages`, timer) — must exactly mirror the original handler at line 379-390 to avoid stale-state bugs on panel reopen
- The `path.resolve` fix for multi-root workspaces must ensure the `isAllowed` security gate runs on the FINAL resolved path, not a CWD fallback that could slip a non-allowed path past the gate

## Edge-Case & Dependency Audit
- **Race Conditions**: Microsecond window between `this._disposables.forEach(d => d.dispose())` (line 8848) and the re-registration of `onDidReceiveMessage` where an in-flight Project panel message could be lost. Practically negligible — the user is not interacting with the Project panel during the Planning panel's close event. A true fix would use separate disposable arrays per panel (deferred as a larger refactor).
- **Security**: The `path.resolve` fix must not weaken the `isAllowed` workspace-root gate. The CSP `file:` addition is safe — `file:` images are already allowed in the Planning panel.
- **Side Effects**: Re-registering `onDidReceiveMessage` adds a new subscription to `_disposables`. On the next `dispose()` cycle (Planning panel closed again), this subscription is disposed and re-registered again. The cycle is stable because `dispose()` always checks `if (this._projectPanel)` before re-registering.
- **Dependencies & Conflicts**: This plan shares its primary fix (Change #1) with the "Kanban Copy Prompt Buttons Broken" plan. Both must apply the identical `dispose()` fix. No conflict — the fix is idempotent. The `onDidDispose` cleanup upgrade is also shared.
- **Multi-root workspace**: `path.resolve('.switchboard/plans/foo.md')` resolves against `process.cwd()`, which may not match the plan's actual workspace root. The fix iterates allowed roots and picks the first match.
- **Deserialized panels**: `deserializeProjectPanel` → `_hydratePanel` (line 663-674) registers `onDidReceiveMessage` into `_disposables`. Same bug, same fix — `dispose()` checks `if (this._projectPanel)` so the re-registration covers deserialized panels too. Note: the deserialize `onDidDispose` for the project panel (line 679-681) also only nulls `_projectPanel` — same truncation, but the `dispose()` re-registration fix supersedes it.
- **Extension deactivation**: `context.subscriptions` disposal calls `dispose()`. This is expected teardown — the re-registration is harmless (the panel will be disposed shortly after).

## Dependencies
- None — this plan is self-contained. The primary fix is shared with `feature_plan_20260702114114_kanban-copy-prompt-broken-project-panel.md` but neither blocks the other; they touch the same code site with identical changes.

## Adversarial Synthesis

Key risks: (1) the re-registered `onDidDispose` is a truncated copy of the original handler — missing ready-state and pending-message cleanup, causing stale state on panel reopen; (2) the `path.resolve` fix could weaken the `isAllowed` security gate if the CWD fallback path slips past the workspace-root check — the gate must run unconditionally on the final resolved path; (3) the kanban error-display fix is partially done (epics branch already checks `msg.error`) — narrow the change to the kanban branch only; (4) a microsecond dispose-to-reregister race window (negligible in practice). Mitigations: mirror the original `onDidDispose` handler's full cleanup; ensure `isAllowed` runs on the final `resolved` value; accept the race as negligible and defer separate-disposable-arrays to a future refactor.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Re-register Project panel message handler AND upgrade `onDidDispose` cleanup after dispose()

**This is the primary fix and is shared with the "Copy Prompt Broken" plan — both must apply this identical change.**

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

Resolve relative paths against workspace roots, not just `process.cwd()`. **The `isAllowed` security gate must run on the FINAL `resolved` path, unconditionally — do not let the CWD fallback slip a non-allowed path past the gate.**

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
            resolved = path.resolve(filePath); // fall back to CWD resolution (will fail isAllowed below)
        }
    }
    // SECURITY: isAllowed must run on the final resolved path, unconditionally
    const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
    const targetPanel = this._projectPanel || this._panel;
    if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
        targetPanel?.webview.postMessage({
            type: 'kanbanPlanPreviewReady', requestId, filePath,
            content: '', error: 'File not found or not in workspace'
        });
        return;
    }
    // ... rest of the method unchanged, use `resolved` for file reads
```

### 3. `src/webview/project.html` — Add `file:` to CSP `img-src`

Align the CSP with `planning.html` (line 6). Change `data:;` to `data: file:;` in `img-src`:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: 'nonce-{{NONCE}}' 'unsafe-inline' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: 'unsafe-inline'; img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data: file:; font-src {{WEBVIEW_CSP_SOURCE}} https:; connect-src https:; frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: http: about:srcdoc blob: data:;">
```

### 4. `src/webview/project.js` — Add error display in the KANBAN branch of `kanbanPlanPreviewReady`

The epics branch (line 599) already checks `!msg.error`. Only the kanban branch (line 586) is missing the error check. Narrow the fix to the kanban branch:

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
    // ... epics preview handling unchanged (already checks msg.error)
    break;
```

### 5. `src/services/PlanningPanelProvider.ts` — Route preview responses through the ready-queue

As defense-in-depth, replace direct `this._projectPanel?.webview.postMessage(...)` calls for preview responses with `this.postMessageToProjectWebview(...)`. Key cases:
- `_handleFetchKanbanPlanPreview` (line 1350, 1376, 1385) — change `targetPanel?.webview.postMessage(...)` to use `postMessageToProjectWebview` for the project panel path. Note: `targetPanel` can be either `_projectPanel` or `_panel` (fallback). Route to the project queue when `targetPanel === this._projectPanel`, otherwise use the planning panel's direct post.
- `_postToBothPanels` (line 1085-1088) — change to send to each panel through its respective queue helper: `this.postMessageToProjectWebview(msg)` for the project panel, and the planning panel equivalent for `_panel`.
- `constitutionFileRead` responses — same routing.
- `projectPrdContent` responses — same routing.

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user. The following test is recommended for separate execution:
- A test in `src/test/project-panel-dispose-survival.test.js` that reads `PlanningPanelProvider.ts` source and asserts that `dispose()` re-registers BOTH `onDidReceiveMessage` AND a full-cleanup `onDidDispose` for the project panel.
- A test that reads `project.html` source and asserts the CSP `img-src` includes `file:`.
- A test that reads `project.js` source and asserts the kanban branch of `kanbanPlanPreviewReady` checks `msg.error`.

### Manual Verification (via installed VSIX)
1. Open both the Planning (ARTIFACTS) panel and the Project panel.
2. In the Project panel → Kanban tab, click a plan card. Verify the preview renders.
3. **Close the Planning panel.**
4. In the Project panel → Kanban tab, click another plan card. **Verify the preview still renders** (this is the critical test — before the fix, this would fail).
5. Switch to the Constitution tab. Select a workspace. Verify the constitution preview renders.
6. Switch to the System tab. Verify CLAUDE.md/AGENTS.md preview renders.
7. Switch to the Projects tab. Select a project. Verify the PRD preview renders.
8. Switch to the Tuning tab. Select an insight. Verify the insight preview renders.
9. Reopen the Planning panel, then close it again. Verify the Project panel previews still work (tests repeated open/close cycles).
10. Open a plan file with a local image reference. Verify the image renders (tests CSP fix).
11. Close the Project panel (after the Planning panel was already closed). Reopen the Project panel. Verify previews work and no stale messages appear (tests the `onDidDispose` cleanup upgrade).

### Regression Check
- Verify the Planning panel's previews still work after being reopened.
- Verify extension deactivation does not error (re-registration during teardown is harmless).

## Recommendation

**Complexity: 5 → Send to Coder.**
