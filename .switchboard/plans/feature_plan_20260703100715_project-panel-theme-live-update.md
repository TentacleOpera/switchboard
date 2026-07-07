# Project panel does not receive live theme/animation updates from Setup tab

## Goal

When a user changes the Switchboard theme (afterburner/claudify) or animation settings (cyber animation, scanlines, pixel font, ultracode animation) in the **Setup → Theme** tab, the **Planning** panel (`planning.html`) updates instantly but the **Project** panel (`project.html`) does not. The Project panel only picks up the new theme after being closed and reopened. This plan fixes the discrepancy so both panels stay in sync.

### Problem Analysis

The Switchboard extension has several webview panels (Sidebar, Setup, Kanban, Planning, Project, Design). When a theme setting is changed in `setup.html`, the flow is:

1. `setup.html` posts a message (e.g. `setThemeSetting`, `setCyberAnimationDisabledSetting`, `setPixelFontSetting`) to `SetupPanelProvider`.
2. `SetupPanelProvider` calls the corresponding `handleSet*` method on `TaskViewerProvider`, which writes the value to VS Code configuration at `ConfigurationTarget.Global`.
3. `SetupPanelProvider` directly calls `broadcastToWebviews(...)` only for `setThemeSetting` (line 129) and `setColourKanbanIconsSetting` (line 757). The animation/scanlines/pixelFont/ultracode handlers (lines 733-785) do NOT call `broadcastToWebviews` directly.
4. **However**, `TaskViewerProvider` has its OWN `onDidChangeConfiguration` listener (lines 496-527) that calls `broadcastToWebviews(...)` for ALL theme/animation settings — theme (500), cyberAnimation (506), scanlines (512), pixelFont (518), ultracode (524). So broadcasts ARE sent for every setting; they just don't reach Planning/Project (see Defect 1).
5. Writing to VS Code configuration fires `vscode.workspace.onDidChangeConfiguration` across all registered listeners.

### Root Cause

There are two compounding defects:

**Defect 1 — `broadcastToWebviews` does not reach the Project (or Planning) panel.**

`TaskViewerProvider.broadcastToWebviews()` (line 4389) only forwards to:
- `this._view` (the Sidebar webview) via `_postSharedWebviewMessage`
- `this._setupPanelProvider` (the Setup panel) via `_postSharedWebviewMessage`
- `this._kanbanProvider` (the Kanban panel)

It does **not** forward to `PlanningPanelProvider`'s `_panel` (Planning) or `_projectPanel` (Project). So the broadcast path for ALL theme/animation settings (sent via TaskViewerProvider's config listener at lines 496-527) never reaches the Project panel. The Planning panel happens to work anyway because of Defect 2's asymmetry.

**Defect 2 — The Project panel's `onDidChangeConfiguration` listener is not registered when the panel is restored.**

Both the Planning and Project panels rely on `vscode.workspace.onDidChangeConfiguration` listeners (registered in `PlanningPanelProvider`) to forward theme setting changes to their respective webviews. The listener registration is asymmetric:

- **Planning panel**: The listener is registered in `open()` (lines ~590-613) **and** in `_hydratePanel(panel, false)` (lines ~738-759, inside the `if (!isProject)` block). So a freshly opened OR a restored Planning panel both get live updates.
- **Project panel**: The listener is registered in `openProject()` (lines ~399-430) only. When the Project panel is **restored** after a VS Code reload via `deserializeProjectPanel()` → `_hydratePanel(panel, true)`, the `if (!isProject)` guard at line ~730 **skips** all live-update listener registration. Since `openProject()` early-returns when `this._projectPanel` already exists (line ~334-336), calling the Project command after restoration just reveals the panel — it never re-registers the listener.

Because `retainContextWhenHidden: true` is set on the Project panel, VS Code restores it on reload in the common case, so the listener is typically missing. This is why the Planning panel (which also gets restored but DOES register its listener in `_hydratePanel`) works while the Project panel does not.

The animation/scanlines/pixelFont/ultracode settings are affected for the SAME reason as theme — the restored Project panel's config listener is absent. They are NOT "especially affected" by a missing broadcast path (the earlier draft incorrectly claimed no broadcast was sent for them; TaskViewerProvider's config listener at lines 496-527 does broadcast them, but the broadcast doesn't reach Project per Defect 1).

## Metadata

**Complexity:** 4
**Tags:** ui, bugfix, webview
**Project:** Remote sync

## User Review Required

Yes — confirm the recommended scope (Change #1 only; Change #2 deferred; Change #3 dropped) before implementation. See Adversarial Synthesis for the rationale.

## Complexity Audit

### Routine
- Extracting the existing `openProject()` config listener (lines 399-430) into a shared `_registerProjectPanelConfigListener` method — mechanical refactor, mirrors existing code line-for-line.
- Calling the shared method from `_hydratePanel`'s project branch — one `else` block addition.
- Disposing the previous listener before re-registering — standard `Disposable?.dispose()` pattern.

### Complex / Risky
- Avoiding duplicate listeners: if `openProject()` registers a listener and the panel is later restored via `_hydratePanel(..., true)`, both paths could register. The `_projectPanelConfigDisposable?.dispose()` guard handles this — but note the existing `openProject()` listener is pushed directly into `this._disposables` (line 398) WITHOUT a disposable field, so the extraction must replace that inline push with the field-tracked disposable to make dedup work. This is the one non-trivial part of the refactor.

## Edge-Case & Dependency Audit

- **Race Conditions**: None significant. Config writes are synchronous to VS Code config; the listener fires asynchronously on the next tick. The `_projectPanelConfigDisposable?.dispose()` guard ensures only one listener is active even if both `openProject()` and `_hydratePanel(...,true)` run in the same session (e.g. user closes restored panel then reopens via command).
- **Security**: No security implications — theme settings are local UI config.
- **Side Effects**: The extracted listener posts directly via `this._projectPanel?.webview.postMessage()`, bypassing the `postMessageToProjectWebview` ready-handshake queue. This matches the EXISTING `openProject()` behavior (line 402) — not a regression. If the webview isn't ready, the message is dropped (acceptable: initial theme is injected at HTML generation time via `applyThemeBodyClass`, lines 718-723 in `_hydratePanel`).
- **Dependencies & Conflicts**:
  - **`colourKanbanIcons` setting**: Neither the Planning nor Project panel's `onDidChangeConfiguration` listener currently handles `switchboard.theme.colourKanbanIcons`. The `setColourKanbanIconsSetting` handler in `SetupPanelProvider` (line 757) calls `broadcastToWebviews({ type: 'colourKanbanIconsChanged', ... })`, but neither `planning.js` nor `project.js` handles that message (confirmed: zero matches in both files) — the class is only applied at HTML generation time via `applyThemeBodyClass()`. This is a pre-existing gap in both panels (not the reported discrepancy) and is out of scope for this plan, but should be noted.
  - **`switchboard.refreshUI`**: Called by the Setup handlers after setting changes, but `refreshUI` → `_refreshConfigurationState` only pushes to the Sidebar and Setup panel, not to Planning/Project. Not a delivery path for these panels.
  - **Panel dispose**: The Project panel's `onDidDispose` (line 382-394 in `openProject()`, 703-711 in `_hydratePanel`) nulls `this._projectPanel` but does NOT dispose the config listener. A stale listener posts to `this._projectPanel?.webview` which is `undefined` — safe no-op via optional chaining. The `_projectPanelConfigDisposable` field should also be cleared on dispose to avoid holding a dead disposable.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

**Key risks:** (1) The earlier draft's Root Cause incorrectly claimed animation settings have "no broadcast path at all" — `TaskViewerProvider` lines 496-527 DO broadcast them via its own config listener; they just don't reach Project (Defect 1). (2) The proposed Change #3 (SetupPanelProvider broadcasting animation settings) is redundant with that existing config-listener broadcast and would cause double-delivery to Sidebar/Setup/Kanban. (3) Change #2 (forwarding broadcastToWebviews to Planning+Project) would double-deliver to the Planning panel, which already has its own config listener at lines 592 and 738. **Mitigations:** Apply Change #1 ONLY — extract the listener, register it in `_hydratePanel`'s project branch. Drop Change #3. Defer Change #2 unless the team also removes PlanningPanelProvider's own config listeners to avoid duplicates. Complexity 4 → Send to Coder.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — Extract and register Project panel config listener

This is the **primary fix** for Defect 2 and is sufficient on its own.

**Add a field to track the Project panel's config listener disposable** (prevents duplicates on re-registration). Place near the other `_projectPanel*` fields (~line 74):

```typescript
private _projectPanelConfigDisposable: vscode.Disposable | undefined;
```

**Extract a shared method** that registers the `onDidChangeConfiguration` listener for the Project panel. This mirrors the existing inline listener in `openProject()` (lines 399-430) exactly, including the `planAutoFetch` handler:

```typescript
private _registerProjectPanelConfigListener(): void {
    // Dispose any previous listener to avoid duplicates on re-registration
    // (openProject() and _hydratePanel(...,true) can both run in one session).
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

**Replace the inline listener in `openProject()`** (lines 396-431) with a call to the shared method. The existing code pushes the listener directly into `this._disposables` without a field — the extraction replaces that with the field-tracked disposable so dedup works:

```typescript
// Hot-swap the theme on the Project panel when the setting changes (it previously
// only learned the theme on init, so it needed a reload to update).
this._registerProjectPanelConfigListener();
```

**Add the same call in `_hydratePanel` for the project case.** After the `if (!isProject) { ... }` block (after line ~786), add an `else` branch:

```typescript
} else {
    // Project panel: register the same config listener so a RESTORED panel
    // receives live theme/animation updates. Without this, a restored Project
    // panel misses onDidChangeConfiguration events (openProject() early-returns
    // when the panel already exists, so it never re-registers the listener).
    this._registerProjectPanelConfigListener();
}
```

**Clear the disposable on Project panel dispose.** In both `onDidDispose` handlers (`openProject()` line 382-394 and `_hydratePanel` line 703-711), add disposal to avoid holding a dead disposable:

```typescript
this._projectPanelConfigDisposable?.dispose();
this._projectPanelConfigDisposable = undefined;
```

### 2. `src/services/TaskViewerProvider.ts` — Include Planning + Project panels in `broadcastToWebviews` (OPTIONAL / DEFERRED)

> **Recommendation: DEFER this change.** Change #1 alone fixes the reported bug. This change adds a second delivery path (belt-and-suspenders) but introduces a **double-delivery risk**: the Planning panel already has its own `onDidChangeConfiguration` listener (registered at `open()` line 592 and `_hydratePanel` line 738), so forwarding `broadcastToWebviews` to it would deliver every theme/animation message twice. Body-class sets are idempotent so it's not catastrophic, but it violates the plan's own Verification step 5 ("only one log per toggle"). If applied, PlanningPanelProvider's own config listeners (lines 592, 738) should be removed to avoid duplicates. The coupling is also safe to add (extension.ts line 930 already wires the reverse ref), but adds a maintenance burden for no functional gain when Change #1 is sufficient.

If the team decides to apply it despite the recommendation:

Add a reference to `PlanningPanelProvider` and forward broadcast messages to both panels:

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

Add a `postMessageToPlanningPanel` method on `PlanningPanelProvider` (mirrors the existing `postMessageToProjectWebview` queue pattern at line 828):

```typescript
public postMessageToPlanningPanel(message: any): void {
    this._panel?.webview.postMessage(message);
}
```

Wire up `setPlanningPanelProvider` in `extension.ts` after line 930 (`planningPanelProvider.setTaskViewerProvider(taskViewerProvider)`):

```typescript
taskViewerProvider.setPlanningPanelProvider(planningPanelProvider);
```

Construction order is safe — both objects exist by line 930. No deadlock risk.

### 3. ~~`src/services/SetupPanelProvider.ts` — Broadcast animation/scanlines/pixelFont/ultracode changes~~ (DROPPED)

> **DROPPED.** The earlier draft proposed adding `broadcastToWebviews` calls in SetupPanelProvider's animation handlers (lines 733-785). This is **redundant**: `TaskViewerProvider` already has its own `onDidChangeConfiguration` listener (lines 496-527) that broadcasts ALL of these settings via `broadcastToWebviews`. Adding SetupPanelProvider broadcasts would cause **double-delivery** to Sidebar/Setup/Kanban on every animation toggle (one from SetupPanelProvider's direct call, one from TaskViewerProvider's config listener firing on the config write). The earlier draft's claim that animation settings have "no broadcast path at all" was incorrect — it missed TaskViewerProvider lines 496-527. Do not implement this change.

## Verification Plan

> Per session directives: SKIP compilation (`npm run compile`) and SKIP automated tests. Verification is manual only.

1. **Restored panel test (the core bug)**:
   - Open the Project panel via the Switchboard command.
   - Reload VS Code (Developer: Reload Window) so the Project panel is restored via `deserializeProjectPanel`.
   - Open Setup → Theme tab.
   - Toggle the theme between afterburner and claudify.
   - **Expected**: Project panel updates instantly (body class changes, scanlines/pixel font toggle).
   - Toggle cyber animation, scanlines, pixel font, ultracode animation individually.
   - **Expected**: Project panel reflects each change instantly.
2. **Fresh-open panel test (regression)**:
   - Close the Project panel.
   - Reopen via the Switchboard command (fresh `openProject()`).
   - Repeat the theme/animation toggles from Setup.
   - **Expected**: Project panel updates instantly (no regression from the extracted listener method).
3. **Planning panel regression test**:
   - With both Planning and Project panels open (one fresh, one restored), toggle theme settings.
   - **Expected**: Both panels update simultaneously.
4. **No duplicate messages**: Add a temporary `console.log` in the Project panel's `handleThemeChanged` (`project.js` ~line 456) and confirm only one log per toggle (not two), verifying the `_projectPanelConfigDisposable` dedup works. (Only applies if Change #2 is NOT applied — if Change #2 is applied, expect two logs and remove PlanningPanelProvider's own listener.)
5. **Kanban/Sidebar/Setup regression**: Confirm those panels still receive theme broadcasts as before (TaskViewerProvider's config listener at lines 496-527 is unchanged).

## Recommendation

Complexity 4 → **Send to Coder**. Apply Change #1 only. Defer Change #2. Drop Change #3.

**Stage Complete:** Coded
