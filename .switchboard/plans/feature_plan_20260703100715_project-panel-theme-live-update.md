# Project panel does not receive live theme/animation updates from Setup tab

## Goal

When a user changes the Switchboard theme (afterburner/claudify) or animation settings (cyber animation, scanlines, pixel font, ultracode animation) in the **Setup → Theme** tab, the **Planning** panel (`planning.html`) updates instantly but the **Project** panel (`project.html`) does not. The Project panel only picks up the new theme after being closed and reopened. This plan fixes the discrepancy so both panels stay in sync.

### Problem Analysis

The Switchboard extension has several webview panels (Sidebar, Setup, Kanban, Planning, Project, Design). When a theme setting is changed in `setup.html`, the flow is:

1. `setup.html` posts a message (e.g. `setThemeSetting`, `setCyberAnimationDisabledSetting`, `setPixelFontSetting`) to `SetupPanelProvider`.
2. `SetupPanelProvider` calls the corresponding `handleSet*` method on `TaskViewerProvider`, which writes the value to VS Code configuration at `ConfigurationTarget.Global`.
3. For `setThemeSetting` only, `SetupPanelProvider` also calls `broadcastToWebviews({ type: 'switchboardThemeChanged', theme })`. For animation/scanlines/pixelFont/ultracode settings, **no broadcast is sent** — they rely entirely on the `onDidChangeConfiguration` event.
4. Writing to VS Code configuration fires `vscode.workspace.onDidChangeConfiguration` across all registered listeners.

### Root Cause

There are two compounding defects:

**Defect 1 — `broadcastToWebviews` does not reach the Project (or Planning) panel.**

`TaskViewerProvider.broadcastToWebviews()` (line ~4465) only forwards to:
- `this._view` (the Sidebar webview)
- `this._setupPanelProvider` (the Setup panel)
- `this._kanbanProvider` (the Kanban panel)

It does **not** forward to `PlanningPanelProvider`'s `_panel` (Planning) or `_projectPanel` (Project). So the explicit broadcast path for `switchboardThemeChanged` never reaches the Project panel. The Planning panel happens to work anyway because of Defect 2's asymmetry.

**Defect 2 — The Project panel's `onDidChangeConfiguration` listener is not registered when the panel is restored.**

Both the Planning and Project panels rely on `vscode.workspace.onDidChangeConfiguration` listeners (registered in `PlanningPanelProvider`) to forward theme setting changes to their respective webviews. The listener registration is asymmetric:

- **Planning panel**: The listener is registered in `open()` (lines ~590-613) **and** in `_hydratePanel(panel, false)` (lines ~725-748, inside the `if (!isProject)` block). So a freshly opened OR a restored Planning panel both get live updates.
- **Project panel**: The listener is registered in `openProject()` (lines ~397-430) only. When the Project panel is **restored** after a VS Code reload via `deserializeProjectPanel()` → `_hydratePanel(panel, true)`, the `if (!isProject)` guard at line ~718 **skips** all live-update listener registration. Since `openProject()` early-returns when `this._projectPanel` already exists (line ~333-336), calling the Project command after restoration just reveals the panel — it never re-registers the listener.

Because `retainContextWhenHidden: true` is set on the Project panel, VS Code restores it on reload in the common case, so the listener is typically missing. This is why the Planning panel (which also gets restored but DOES register its listener in `_hydratePanel`) works while the Project panel does not.

The animation/scanlines/pixelFont/ultracode settings are especially affected because they have **no broadcast path at all** — they depend entirely on the `onDidChangeConfiguration` listener, which is absent for a restored Project panel.

## Metadata

**Complexity:** 4
**Tags:** theme, project-panel, planning-panel, webview, bug, live-update, configuration
**Project:** Remote sync

## Complexity Audit

**Routine:**
- Adding a configuration-change listener for the Project panel in `_hydratePanel` mirrors the existing Planning panel listener almost line-for-line.
- Extracting the listener into a shared method is a mechanical refactor.

**Complex/Risky:**
- Avoiding duplicate listeners: if `openProject()` registers a listener and the panel is later restored, both the old and new listener would post to `this._projectPanel` (since it's a shared field). Duplicate theme messages are idempotent (they set the same body class), but it's cleaner to track and dispose the previous Project-panel config listener before registering a new one.
- The `broadcastToWebviews` fix touches `TaskViewerProvider`, which doesn't currently hold a reference to `PlanningPanelProvider`. Adding one introduces a new coupling point — need to verify no circular dependency (PlanningPanelProvider already receives TaskViewerProvider, so the reverse reference must be set carefully to avoid a construction-order deadlock).

## Edge-Case & Dependency Audit

- **Restored vs freshly opened**: The fix must cover both paths. `openProject()` (fresh) and `_hydratePanel(..., true)` (restored) must both end up with exactly one active config listener.
- **`colourKanbanIcons` setting**: Neither the Planning nor Project panel's `onDidChangeConfiguration` listener currently handles `switchboard.theme.colourKanbanIcons`. The `setColourKanbanIconsSetting` handler in `SetupPanelProvider` does call `broadcastToWebviews({ type: 'colourKanbanIconsChanged', ... })`, but neither `planning.js` nor `project.js` handles that message — the class is only applied at HTML generation time via `applyThemeBodyClass()`. This is a pre-existing gap in both panels (not the reported discrepancy) and is out of scope for this plan, but should be noted.
- **`webviewReady` handshake**: The Project panel uses a ready-handshake (`_projectPanelReady` / `_pendingProjectMessages`). The config listener posts directly via `this._projectPanel?.webview.postMessage()`, bypassing the queue. If a config change fires before the webview is ready, the message is dropped. This is acceptable for live updates (the initial state is injected via `applyThemeBodyClass` at HTML generation time), but the initial theme push in `openProject()` (lines ~432-437) and `_hydratePanel` (lines ~706-711) has the same issue. Not making this worse.
- **Panel dispose**: The Project panel's `onDidDispose` (line ~381) nulls `this._projectPanel` but does NOT dispose the config listener (it's in `this._disposables`). A stale listener would post to `this._projectPanel?.webview` which is `undefined` — safe no-op via optional chaining.
- **`switchboard.refreshUI`**: Called by the Setup handlers after setting changes, but `refreshUI` → `_refreshConfigurationState` only pushes to the Sidebar and Setup panel, not to Planning/Project. Not a delivery path for these panels.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Extract and register Project panel config listener

**Add a field to track the Project panel's config listener disposable** (prevents duplicates on re-registration):

```typescript
private _projectPanelConfigDisposable: vscode.Disposable | undefined;
```

**Extract a shared method** that registers the `onDidChangeConfiguration` listener for the Project panel:

```typescript
private _registerProjectPanelConfigListener(): void {
    // Dispose any previous listener to avoid duplicates on re-registration
    this._projectPanelConfigDisposable?.dispose();
    this._projectPanelConfigDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('switchboard.theme.name')) {
            const t = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
            this._projectPanel?.webview.postMessage({ type: 'switchboardThemeChanged', theme: t });
        }
        if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
            const d = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
            this._projectPanel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: d });
        }
        if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
            const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
            this._projectPanel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
        }
        if (e.affectsConfiguration('switchboard.theme.pixelFont')) {
            const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.pixelFont', true);
            this._projectPanel?.webview.postMessage({ type: 'pixelFontSetting', enabled });
        }
        if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
            const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.ultracodeAnimation', false);
            this._projectPanel?.webview.postMessage({ type: 'ultracodeAnimationSetting', enabled });
        }
        if (e.affectsConfiguration('switchboard.planAutoFetch') && this._planAutoFetchService && this._projectPanel) {
            const wsRoot = this._getWorkspaceRoot() || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
            if (wsRoot) {
                const status = this._planAutoFetchService.getStatus(wsRoot);
                this._projectPanel.webview.postMessage({ type: 'planAutoFetchState', ...status });
            }
        }
    });
    this._disposables.push(this._projectPanelConfigDisposable);
}
```

**Replace the inline listener in `openProject()`** (lines ~397-430) with a call to the shared method:

```typescript
// Hot-swap the theme on the Project panel when the setting changes.
this._registerProjectPanelConfigListener();
```

**Add the same call in `_hydratePanel` for the project case.** After the `if (!isProject) { ... }` block (after line ~748), add:

```typescript
} else {
    // Project panel: register the same config listener so a RESTORED panel
    // receives live theme/animation updates. Without this, a restored Project
    // panel misses onDidChangeConfiguration events (openProject() early-returns
    // when the panel already exists, so it never re-registers the listener).
    this._registerProjectPanelConfigListener();
}
```

Alternatively, restructure the `if (!isProject)` block to extract just the config listener and call it unconditionally, while keeping the file watchers and workspace-folder listener Planning-only.

### 2. `src/services/TaskViewerProvider.ts` — Include Planning + Project panels in `broadcastToWebviews`

Add a reference to `PlanningPanelProvider` and forward broadcast messages to both panels. This provides a second delivery path (belt-and-suspenders) so theme changes reach the Project panel even if a config event is missed.

```typescript
private _planningPanelProvider?: PlanningPanelProvider;

public setPlanningPanelProvider(provider: PlanningPanelProvider): void {
    this._planningPanelProvider = provider;
}

public broadcastToWebviews(message: any): void {
    this._postSharedWebviewMessage(message);
    this._kanbanProvider?.postMessage(message);
    this._planningPanelProvider?.postMessageToPlanningPanel(message);
    this._planningPanelProvider?.postMessageToProjectWebview(message);
}
```

Add a `postMessageToPlanningPanel` method on `PlanningPanelProvider` (mirrors the existing `postMessageToProjectWebview` queue pattern):

```typescript
public postMessageToPlanningPanel(message: any): void {
    this._panel?.webview.postMessage(message);
}
```

Wire up `setPlanningPanelProvider` in `extension.ts` at the point where `setKanbanProvider` / `setSetupPanelProvider` are called.

> **Note**: This change is optional if Defect 2 is fixed — the `onDidChangeConfiguration` listener alone is sufficient for live updates. But adding the broadcast path makes the system more robust and brings the Project/Planning panels in line with how Kanban and Setup receive broadcasts. If the coupling risk is a concern, this change can be deferred and only Defect 2 fixed.

### 3. `src/services/SetupPanelProvider.ts` — Broadcast animation/scanlines/pixelFont/ultracode changes

Currently only `setThemeSetting` and `setColourKanbanIconsSetting` call `broadcastToWebviews`. The animation/scanlines/pixelFont/ultracode handlers only write config + call `refreshUI`. If Change #2 is applied, add explicit broadcasts so these settings reach all panels without relying solely on `onDidChangeConfiguration`:

```typescript
case 'setCyberAnimationDisabledSetting':
    await this._taskViewerProvider.handleSetCyberAnimationDisabledSetting(message.enabled);
    this._taskViewerProvider.broadcastToWebviews({
        type: 'cyberAnimationSetting',
        disabled: message.enabled
    });
    await this._taskViewerProvider.postSetupPanelState();
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
```

Repeat for `setCyberScanlinesDisabledSetting` (`cyberScanlinesSetting`), `setPixelFontSetting` (`pixelFontSetting`), `setUltracodeAnimationSetting` (`ultracodeAnimationSetting`).

> If Change #2 is not applied, these broadcasts would only reach Sidebar/Setup/Kanban (no change from today for Planning/Project). So this change is only useful in combination with Change #2.

## Verification Plan

1. **Build**: `npm run compile` — confirm no TypeScript errors.
2. **Restored panel test (the core bug)**:
   - Open the Project panel via the Switchboard command.
   - Reload VS Code (Developer: Reload Window) so the Project panel is restored via `deserializeProjectPanel`.
   - Open Setup → Theme tab.
   - Toggle the theme between afterburner and claudify.
   - **Expected**: Project panel updates instantly (body class changes, scanlines/pixel font toggle).
   - Toggle cyber animation, scanlines, pixel font, ultracode animation individually.
   - **Expected**: Project panel reflects each change instantly.
3. **Fresh-open panel test (regression)**:
   - Close the Project panel.
   - Reopen via the Switchboard command (fresh `openProject()`).
   - Repeat the theme/animation toggles from Setup.
   - **Expected**: Project panel updates instantly (no regression from the extracted listener method).
4. **Planning panel regression test**:
   - With both Planning and Project panels open (one fresh, one restored), toggle theme settings.
   - **Expected**: Both panels update simultaneously.
5. **No duplicate messages**: Add a temporary `console.log` in the Project panel's `handleThemeChanged` and confirm only one log per toggle (not two), verifying the `_projectPanelConfigDisposable` dedup works.
6. **Kanban/Sidebar/Setup regression**: Confirm those panels still receive theme broadcasts as before.
