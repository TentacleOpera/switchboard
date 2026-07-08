# Fix: Project panel duplicate on window restore (serializer ghost)

**Plan ID:** d3c42b71-a9f8-4e5c-b7f0-69e8f8c54a12

## Goal

**Problem:** When `switchboard.persistPanels` is enabled and a VS Code window is reloaded (Developer: Reload Window, crash recovery, extension host restart), a duplicate PROJECT panel tab can appear if a `reviewPlan` click, `switchboard.openProjectPanel` command, or `activatePlanInProjectPanel` call arrives before VS Code's serializer has called `deserializeProjectPanel`.

**Background:** VS Code persists webview tabs in the editor layout and restores them on reload. When `persistPanels` is `true`, the extension registers a `WebviewPanelSerializer` for `switchboard-project` (extension.ts:2953). On reload, VS Code recreates the tab's wrapper (the tab is visible, showing its last-rendered HTML or a loading state) but defers the call to `deserializeWebviewPanel` — the serializer fires asynchronously after the extension's `activate()` function completes. During this gap:

1. `PlanningPanelProvider._projectPanel` is `undefined` (the provider was freshly constructed).
2. The ghost tab is visible in the editor but not yet associated with the provider.
3. Any code path that checks `hasProjectPanel()` → `false` → calls `openProject()` creates a **second** live PROJECT panel.
4. When the serializer eventually fires, `deserializeProjectPanel` sets `_projectPanel = panel` — but this is the *ghost* panel, overwriting the reference to the newly-created one (or vice versa, depending on timing).

This is the documented real-world cause of webview duplicate tabs (VS Code Issue #182795). The `_projectPanelOpening` promise lock from the predecessor plan does not address this because the serializer and `openProject()` use separate code paths that don't consult each other.

**Root Cause (precise):** `deserializeProjectPanel` and `openProject()` both write to `_projectPanel` but neither checks whether the other is in-flight or has already completed. The serializer is the only code path that *receives* a panel from VS Code (it doesn't create one), so it cannot be gated by the creation lock. The gap is between extension activation and the serializer call — during that window, `_projectPanel` is a false negative.

### Sub-mechanism: Lazy restoration amplifies the window

VS Code may **lazily restore** background (non-visible) tabs — the serializer is not called until the user focuses the tab. If the PROJECT panel was in a non-active tab group when the window was closed, `_projectPanel` stays `undefined` indefinitely until the user clicks on the ghost tab. Any `openProject()` call during this (potentially infinite) window creates a duplicate.

## Metadata

- **Tags:** bugfix, ui, reliability, restore
- **Complexity:** 4

## Proposed Changes

### File: `src/services/PlanningPanelProvider.ts`

**Change 1: Add a `_projectPanelRestoring` flag to signal that a serializer call is expected**

Add a boolean field that is set to `true` when the serializer registration happens and the provider should expect a `deserializeProjectPanel` call. This flag tells `openProject()` to not create a new panel — instead, it should wait or bail.

```typescript
// Add near _projectPanelOpening (around line 306)
private _projectPanelRestoring = false;
```

**Change 2: Add `markProjectPanelRestoring()` — called from extension.ts after serializer registration**

The extension knows whether `persistPanels` is enabled and whether the PROJECT panel was in the previous layout. VS Code does not expose a "tabs pending deserialization" API, but we can use a pragmatic heuristic: if serializers are registered, set the flag, and clear it either when `deserializeProjectPanel` fires or after a timeout (VS Code must call the serializer within a bounded window — typically within the first few seconds of activation; the lazy restoration case is handled by checking the editor layout).

```typescript
public markProjectPanelRestoring(): void {
    this._projectPanelRestoring = true;
    // Safety net: if VS Code never calls the serializer (e.g., the panel was
    // closed externally, or the layout was corrupted), clear the flag after
    // a generous timeout so openProject() isn't permanently blocked.
    setTimeout(() => {
        if (this._projectPanelRestoring) {
            console.warn('[ProjectPanel] Restore flag still set after 10s — clearing (serializer may not fire for this session).');
            this._projectPanelRestoring = false;
        }
    }, 10000);
}
```

**Change 3: `deserializeProjectPanel` clears the restoring flag**

When the serializer fires, clear the flag before hydration so concurrent callers see `_projectPanel` as truthy (it's set synchronously at line 926).

```typescript
public async deserializeProjectPanel(
    panel: vscode.WebviewPanel,
    state: any
): Promise<void> {
    this._projectPanelRestoring = false;
    this._projectPanel = panel;
    await this._hydratePanel(this._projectPanel, true);
}
```

**Change 4: Guard `openProject()` against the restoring window**

In `openProject()`, after the existing `_projectPanelOpening` check and before the creation branch, add a check for the restoring flag. If the flag is set, the serializer hasn't fired yet — a ghost tab exists in the editor. Instead of creating a new panel, clear the flag (the ghost is inaccessible to us without the serializer) and log a warning. This is the pragmatic choice: we can't `reveal()` a panel we don't have a reference to, and blocking indefinitely is worse than creating a fresh panel and letting the serializer dispose/overwrite the ghost.

However, the better approach: if the restoring flag is set, we should **wait briefly** for the serializer and then fall through if it doesn't arrive. This gives the serializer a chance to fire (it usually fires within 1-2 seconds of activate).

```typescript
public async openProject(): Promise<void> {
    if (this._projectPanelOpening) {
        await this._projectPanelOpening;
        if (this._projectPanel) {
            this._projectPanel.reveal(vscode.ViewColumn.One);
        }
        return;
    }

    if (this._projectPanel) {
        this._projectPanel.reveal(vscode.ViewColumn.One);
        if (this._projectPanelReady) {
            this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
        }
        return;
    }

    // If a serializer restore is pending, wait briefly for it before creating
    // a new panel. This closes the gap between activation and the serializer
    // call that would otherwise produce a duplicate tab.
    if (this._projectPanelRestoring) {
        await this._waitForRestore();
        // Re-check: the serializer may have set _projectPanel while we waited.
        if (this._projectPanel) {
            this._projectPanel.reveal(vscode.ViewColumn.One);
            if (this._projectPanelReady) {
                this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
            }
            return;
        }
        // Serializer didn't fire in time — fall through to create a fresh panel.
        // The ghost tab (if any) will be overwritten when the serializer
        // eventually fires, or it was already disposed by VS Code.
        console.warn('[ProjectPanel] Restore wait expired — creating fresh panel.');
    }

    this._projectPanelOpening = this._doOpenProject();
    try {
        await this._projectPanelOpening;
    } finally {
        this._projectPanelOpening = undefined;
    }
}

private _waitForRestore(): Promise<void> {
    return new Promise<void>(resolve => {
        const checkInterval = 50; // ms
        const maxWait = 3000; // ms — generous; serializer usually fires < 1s
        let elapsed = 0;
        const timer = setInterval(() => {
            elapsed += checkInterval;
            if (this._projectPanel || !this._projectPanelRestoring || elapsed >= maxWait) {
                clearInterval(timer);
                this._projectPanelRestoring = false;
                resolve();
            }
        }, checkInterval);
    });
}
```

**Change 5: Clear the restoring flag in all `onDidDispose` handlers**

If the panel is disposed (user closes tab) while the restoring flag is set, clear it so future `openProject()` calls aren't blocked. Add `this._projectPanelRestoring = false;` to the same three `onDidDispose` handlers that already clear `_projectPanelOpening`:

1. `_doOpenProject` onDidDispose (~line 645-660)
2. `_hydratePanel(isProject=true)` onDidDispose (~line 970-981)
3. `dispose()` re-registered onDidDispose (~line 9780-9790)

### File: `src/extension.ts`

**Change 6: Call `markProjectPanelRestoring()` after serializer registration**

After registering the `switchboard-project` serializer, immediately tell the provider that a restore might be incoming. This must happen before any command or message handler could call `openProject()`.

```typescript
if (persistPanels) {
    // ... other serializer registrations ...
    vscode.window.registerWebviewPanelSerializer('switchboard-project', {
        deserializeWebviewPanel: async (panel, state) => {
            await planningPanelProvider.deserializeProjectPanel(panel, state);
        }
    });
    // Signal that a project panel restore may be in-flight. openProject()
    // will wait briefly for the serializer before creating a duplicate.
    planningPanelProvider.markProjectPanelRestoring();
    // ... other serializer registrations ...
}
```

### File: `src/test/project-panel-restore-guard.test.js`

**Change 7: Static-source-assertion test for the restore guard**

A new test file (matching the existing suite idiom) that asserts:
1. `_projectPanelRestoring` field is declared in `PlanningPanelProvider.ts`.
2. `markProjectPanelRestoring` method exists.
3. `_waitForRestore` method exists.
4. `deserializeProjectPanel` contains `this._projectPanelRestoring = false`.
5. `openProject` contains `if (this._projectPanelRestoring)`.
6. `extension.ts` contains `markProjectPanelRestoring()` after the `switchboard-project` serializer registration.
7. All three `onDidDispose` handlers that clear `_projectPanelOpening` also clear `_projectPanelRestoring`.

## Edge-Case & Dependency Audit

1. **`persistPanels` is `false` (default):** No serializers are registered. `markProjectPanelRestoring()` is never called. `_projectPanelRestoring` stays `false`. `openProject()` behaves exactly as before — zero behavioral change for the default config. **No regression risk.**

2. **Serializer fires before any `openProject()` call:** `deserializeProjectPanel` sets `_projectPanel` synchronously and clears `_projectPanelRestoring`. The next `openProject()` sees `_projectPanel` truthy and reveals — correct, no wait.

3. **`openProject()` called during the wait, serializer fires mid-wait:** The `_waitForRestore` poll detects `_projectPanel` truthy and resolves early. `openProject()` reveals the restored panel — correct, no duplicate.

4. **Serializer never fires (ghost tab was closed externally, layout corrupted):** The 10s safety timeout in `markProjectPanelRestoring` clears the flag. If `openProject()` is called during the 10s window, `_waitForRestore` times out after 3s and falls through to create a fresh panel. The 3s wait is the user-visible delay — acceptable for a rare edge case.

5. **Lazy restoration (background tab):** The serializer doesn't fire until the user focuses the ghost tab, which could be hours later. The 10s timeout clears `_projectPanelRestoring`, so `openProject()` creates a fresh panel after at most a 3s wait on first call. When the user eventually focuses the ghost tab, the serializer fires and overwrites `_projectPanel` with the ghost — but the ghost's `onDidDispose` isn't wired to our provider (the dispose handler was registered on the *new* panel). **Risk:** two panels coexist, one managed and one unmanaged ghost. **Mitigation:** in `deserializeProjectPanel`, if `_projectPanel` is already set (a new panel was created), dispose the incoming ghost panel instead of adopting it. Add:

    ```typescript
    public async deserializeProjectPanel(
        panel: vscode.WebviewPanel,
        state: any
    ): Promise<void> {
        this._projectPanelRestoring = false;
        // If openProject() already created a panel while we waited for the
        // serializer, dispose the ghost — we can't have two.
        if (this._projectPanel) {
            panel.dispose();
            return;
        }
        this._projectPanel = panel;
        await this._hydratePanel(this._projectPanel, true);
    }
    ```

6. **Multiple rapid `openProject()` calls during the restore wait:** The first caller enters `_waitForRestore` and eventually falls through to `_doOpenProject` (which sets `_projectPanelOpening`). The second caller hits the `_projectPanelOpening` guard and awaits — correct, serialized by the existing lock.

7. **`revealProject()` fire-and-forget during restore:** `revealProject()` checks `_projectPanel` first. If `_projectPanel` is `undefined` (restore pending), it calls `void this.openProject()`. This enters the restore wait — correct.

## Dependencies

- Predecessor plan: `feature_plan_20260708095648_review-plan-tab-pileup-race-condition.md` (the `_projectPanelOpening` lock). This plan builds on that lock and does not modify it.
- No external dependencies.

## Verification Plan

> **Session directives:** Per current session policy, **skip compilation** and **skip automated tests**.

### Automated Tests

- `project-panel-restore-guard.test.js` — static-source-assertion test (see Change 7 above).

### Manual Verification

1. **Enable `persistPanels`:** Set `switchboard.persistPanels: true` in user settings.

2. **Repro — reload with PROJECT panel open:** Open the Project panel. Run `Developer: Reload Window`. **Before** the panel finishes loading, immediately click "Review plan" on a Kanban card (or trigger `switchboard.openProjectPanel`). **Expected:** At most a brief delay (~1-3s) while the restore guard waits, then the restored panel is revealed — NO duplicate tab.

3. **Repro — lazy restoration:** Open the Project panel in a secondary tab group (not the active one). Close VS Code and reopen. The PROJECT tab should be visible but in the background. Click "Review plan" on a Kanban card. **Expected:** A single PROJECT panel appears (either the restored one or a fresh one); no duplicate. If a fresh one is created, focusing the background ghost tab should NOT produce a second live panel (the serializer should dispose the ghost if a fresh panel already exists).

4. **Regression — `persistPanels: false` (default):** With `persistPanels` disabled, verify all existing behavior is unchanged: rapid "Review plan" clicks, command palette open, dispose-then-reopen. No delays, no duplicates.

5. **Regression — normal open with `persistPanels: true` but no prior panel:** Enable `persistPanels`, ensure no PROJECT panel was open in the previous session. Open the Project panel. **Expected:** Opens immediately (no 3s delay — `_projectPanelRestoring` is only set if serializers are registered AND the extension calls `markProjectPanelRestoring()`; if no panel was in the previous layout, the serializer is registered but never called, and the 10s timeout clears the flag).

    > **Note on edge case 5:** The current design calls `markProjectPanelRestoring()` unconditionally when `persistPanels` is true. This means the first `openProject()` after a reload will always wait up to 3s even if no PROJECT panel was in the previous layout. To avoid this UX penalty, consider gating the `markProjectPanelRestoring()` call on VS Code's `getState()` or a lightweight "was the project panel open last session" flag persisted in `workspaceState`. This is a refinement — the 3s delay on first open is acceptable for v1 but should be improved if users report it.

---

**Recommendation:** Complexity 4 → **Send to Coder.** The changes are localized to `PlanningPanelProvider.ts` (one new field, one new method, guards in two existing methods) and a one-line call in `extension.ts`. The edge-case audit covers the lazy-restoration scenario which is the hardest to reason about. The `_projectPanelRestoring` flag is a simple, testable mechanism.
