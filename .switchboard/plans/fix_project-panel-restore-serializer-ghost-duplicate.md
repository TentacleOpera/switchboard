# Fix: Project panel duplicate on window restore (serializer ghost)

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

- **Tags:** bugfix, ui, reliability
- **Complexity:** 4
- **Feature:** Project panel fixes (`6f30b8c5-74d4-4246-9c03-53469640eb8d`)

> Tags normalized to the allowed improve-plan tag set (dropped `restore`, which is not in the list).

## User Review Required

- **None.** The restore-race root cause and the flag-based mitigation are well-defined and testable; there is no product decision outstanding. The `_waitForRestore` polling vs. promise-rendezvous choice was evaluated during improve and resolved in favour of polling (see Adversarial Synthesis) — not a user call.

## Complexity Audit

### Routine
- One new boolean field (`_projectPanelRestoring`), one new public method (`markProjectPanelRestoring`), one new private helper (`_waitForRestore`), and guards inside two existing methods — all localized to `PlanningPanelProvider.ts`.
- One conditional call site in `extension.ts` behind the existing `persistPanels` branch.
- Zero behavioral change when `persistPanels` is `false` (the default) — no serializer, flag never set.

### Complex / Risky
- **Serializer-vs-`openProject()` timing race** is the core difficulty — the flag, the bounded wait, and the multiple clear-sites must all agree or `openProject()` either blocks needlessly or duplicates the panel. The flag MUST be cleared on **every** path that nulls `_projectPanel`/`_projectPanelOpening` — including the non-`onDidDispose` catch block at `PlanningPanelProvider.ts:7946-7947` (see Change 5, item 4), which the original plan missed.
- **Lazy restoration** (background tab, serializer fires arbitrarily later) is the hardest scenario; handled by the 8s flag timeout + ghost disposal in `deserializeProjectPanel`.
- **Shared surface with sibling subtask B** — both edit `openProject()`/`_doOpenProject()`; the reveal calls in this plan's code samples defer to B (see the Superseded callout in Change 4).

## Proposed Changes

### File: `src/services/PlanningPanelProvider.ts`

**Change 1: Add a `_projectPanelRestoring` flag to signal that a serializer call is expected**

Add a boolean field that is set to `true` when the serializer registration happens and the provider should expect a `deserializeProjectPanel` call. This flag tells `openProject()` to not create a new panel — instead, it should wait or bail.

```typescript
// Add near _projectPanelOpening (around line 306)
private _projectPanelRestoring = false;
```

**Change 2: Add `markProjectPanelRestoring()` — called from extension.ts only when a ghost tab exists**

The extension calls this after registering the `switchboard-project` serializer, but **only if a `switchboard-project` tab actually exists in the current editor layout.** VS Code's `TabGroups` API (stable since 1.77; engine minimum is `^1.93.0`) lets us check this precisely via `vscode.window.tabGroups.all` — each `Tab` has an `input` property that is a `TabInputWebview` with a `viewType` string for webview tabs. If no matching tab exists, the flag is never set and `openProject()` incurs zero delay.

```typescript
/**
 * Signal that a project-panel serializer restore may be in-flight.
 * Called from extension.ts ONLY after confirming a switchboard-project
 * tab exists in the editor layout (via TabGroups API). openProject()
 * will wait briefly for the serializer before creating a duplicate.
 */
public markProjectPanelRestoring(): void {
    this._projectPanelRestoring = true;
    // Safety net: if VS Code never calls the serializer (e.g., the tab was
    // closed externally after layout save, or lazy-restored in a background
    // group), clear the flag after a generous timeout so openProject()
    // isn't permanently blocked.
    setTimeout(() => {
        if (this._projectPanelRestoring) {
            console.warn('[ProjectPanel] Restore flag still set after 8s — clearing (serializer may not fire for this session).');
            this._projectPanelRestoring = false;
        }
    }, 8000);
}
```

The companion tab-detection helper lives in `extension.ts` (see Change 6).

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

> **Superseded:** the `openProject()` code sample below originally used `this._projectPanel.reveal(vscode.ViewColumn.One);` at its three reveal sites.
> **Reason:** the sibling subtask *"Review Plan opens a duplicate Project panel…"* (same feature) fixes a **separate** bug where `reveal(vscode.ViewColumn.One)` relocates a floated (auxiliary-window) Project panel back into the main window. That plan owns the reveal-target decision for the whole feature: every Project-panel reveal must be `reveal(undefined, true)` (reveal in place, preserve focus). Keeping `ViewColumn.One` here would re-introduce the steal-back bug this feature is meant to eliminate.
> **Replaced with:** `this._projectPanel.reveal(undefined, true);` at all three reveal sites in the sample below. **Sequencing:** land the reveal-target subtask first, then implement this restore guard on top of the already-corrected reveal sites (see the feature file's *Dependencies & sequencing*).

```typescript
public async openProject(): Promise<void> {
    if (this._projectPanelOpening) {
        await this._projectPanelOpening;
        if (this._projectPanel) {
            this._projectPanel.reveal(undefined, true);
        }
        return;
    }

    if (this._projectPanel) {
        this._projectPanel.reveal(undefined, true);
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
            this._projectPanel.reveal(undefined, true);
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
        const maxWait = 1500; // ms — tight; serializer fires within ~200-800ms
                               // in practice. 1.5s is generous enough to absorb
                               // slow extension hosts without noticeable delay.
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

**Change 5: Clear the restoring flag on EVERY path that nulls `_projectPanel`/`_projectPanelOpening`**

If the panel is disposed (user closes tab) while the restoring flag is set, clear it so future `openProject()` calls aren't blocked. Add `this._projectPanelRestoring = false;` to the **same sites that already clear `_projectPanelOpening`** — there are **four**, not three (the original plan listed only the three `onDidDispose` handlers and missed the catch-block clear at item 4):

1. `_doOpenProject` `onDidDispose` (line ~645-660, clears `_projectPanelOpening` at line 649).
2. `_hydratePanel(isProject=true)` `onDidDispose` (line ~970-981, clears at line 973).
3. `dispose()` re-registered `onDidDispose` (line ~9792-9801, clears at line 9795).
4. **`_updateWebviewRoots()` catch block (line ~7936-7948).** This is **not** an `onDidDispose` handler — it is an inline `catch` that fires when `this._projectPanel.webview.options = …` throws because the panel was already disposed but its reference wasn't cleared (e.g. the planning panel closed first, removing the dispose listener). Lines 7946-7947 null `_projectPanel` and `_projectPanelOpening`; add `this._projectPanelRestoring = false;` here too. Without it, if the panel dies via this path while restoring, the flag leaks and the next `openProject()` eats a needless ≤1.5s wait — the 8s timeout in `markProjectPanelRestoring` is the backstop, but this closes the gap directly.

> **Clarification (from improve pass):** the `setTimeout` in `markProjectPanelRestoring` is intentionally fire-and-forget and its handle is not retained — after the flag is cleared early (the common case), the orphaned timer wakes once, sees the flag already `false`, and no-ops. This is harmless but was noted; keeping a handle to `clearTimeout` on early-clear is an optional tidiness improvement, not a correctness requirement. Likewise, `_waitForRestore()` deliberately sets `_projectPanelRestoring = false` as it resolves — it is the terminal consumer of the flag, so this side effect is by design.

### File: `src/extension.ts`

**Change 6: Check TabGroups for a ghost tab, then conditionally call `markProjectPanelRestoring()`**

After registering the `switchboard-project` serializer, use the `TabGroups` API to check whether a `switchboard-project` tab actually exists in the restored editor layout. Only set the restoring flag if a ghost tab is found. This eliminates the wait penalty for sessions where no PROJECT panel was previously open.

```typescript
if (persistPanels) {
    // ... other serializer registrations ...
    vscode.window.registerWebviewPanelSerializer('switchboard-project', {
        deserializeWebviewPanel: async (panel, state) => {
            await planningPanelProvider.deserializeProjectPanel(panel, state);
        }
    });

    // Only set the restore guard if a switchboard-project tab is actually
    // present in the editor layout (ghost tab from previous session).
    // This avoids a 1.5s wait penalty on first openProject() in sessions
    // that never had a PROJECT panel open.
    const hasProjectGhost = vscode.window.tabGroups.all.some(group =>
        group.tabs.some(tab =>
            tab.input instanceof vscode.TabInputWebview &&
            tab.input.viewType === 'switchboard-project'
        )
    );
    if (hasProjectGhost) {
        planningPanelProvider.markProjectPanelRestoring();
    }
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
6. `extension.ts` contains the `TabInputWebview` / `viewType === 'switchboard-project'` ghost-tab check before `markProjectPanelRestoring()`.
7. All **four** sites that clear `_projectPanelOpening` also clear `_projectPanelRestoring` — the three `onDidDispose` handlers **and** the `_updateWebviewRoots()` catch block (line ~7946). A simple way to assert this without brittle line coupling: the count of `_projectPanelRestoring = false` occurrences is ≥ the count of `_projectPanelOpening = undefined` occurrences that are paired with a `_projectPanel = undefined` on the adjacent line.

## Edge-Case & Dependency Audit

1. **`persistPanels` is `false` (default):** No serializers are registered. `markProjectPanelRestoring()` is never called. `_projectPanelRestoring` stays `false`. `openProject()` behaves exactly as before — zero behavioral change for the default config. **No regression risk.**

2. **Serializer fires before any `openProject()` call:** `deserializeProjectPanel` sets `_projectPanel` synchronously and clears `_projectPanelRestoring`. The next `openProject()` sees `_projectPanel` truthy and reveals — correct, no wait.

3. **`openProject()` called during the wait, serializer fires mid-wait:** The `_waitForRestore` poll detects `_projectPanel` truthy and resolves early. `openProject()` reveals the restored panel — correct, no duplicate.

4. **Serializer never fires (ghost tab was closed externally, layout corrupted):** The 8s safety timeout in `markProjectPanelRestoring` clears the flag. If `openProject()` is called during the 8s window, `_waitForRestore` times out after 1.5s and falls through to create a fresh panel. The 1.5s wait is the worst-case user-visible delay — acceptable for this rare edge case and imperceptible in practice since the serializer almost always fires within ~500ms.

5. **Lazy restoration (background tab):** The serializer doesn't fire until the user focuses the ghost tab, which could be hours later. The 8s timeout clears `_projectPanelRestoring`, so `openProject()` creates a fresh panel after at most a 1.5s wait on first call. When the user eventually focuses the ghost tab, the serializer fires and overwrites `_projectPanel` with the ghost — but the ghost's `onDidDispose` isn't wired to our provider (the dispose handler was registered on the *new* panel). **Risk:** two panels coexist, one managed and one unmanaged ghost. **Mitigation:** in `deserializeProjectPanel`, if `_projectPanel` is already set (a new panel was created), dispose the incoming ghost panel instead of adopting it. Add:

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
- No external dependencies. The `TabGroups` API (`vscode.window.tabGroups`, `TabInputWebview.viewType`) is stable and well within the declared engine `^1.93.0`; the codebase does not currently use it, so Change 6 introduces the first use.
- **Sibling subtask coordination (feature `Project panel fixes`):** shares the `openProject()` / `_doOpenProject()` surface with *"Review Plan opens a duplicate Project panel…"*. That sibling **owns the reveal-target decision** (all reveals → `reveal(undefined, true)`); this plan's code samples defer to it (see the Superseded callout in Change 4). **Recommended coding order: reveal-target subtask first, then this restore guard** — so the guard is built around the already-corrected reveal sites and no reveal call regresses to `ViewColumn.One`.

## Adversarial Synthesis

Key risks: (1) the serializer-vs-`openProject()` timing race is the whole point — the flag, the bounded wait, and the clear-sites must stay in agreement; a missed clear-site (the original plan overlooked the `_updateWebviewRoots` catch block at 7946) leaks the flag and forces a needless wait. (2) Lazy restoration means the serializer can fire arbitrarily late; the 8s flag timeout plus ghost disposal in `deserializeProjectPanel` prevent a second live panel. (3) Reveal-target must stay reconciled with the sibling subtask (`reveal(undefined, true)`). Mitigations: conditional arming via the TabGroups ghost-tab check keeps the default (`persistPanels: false`) path at zero cost; all four clear-sites now covered; the 8s timeout backstops any unforeseen clear-path.

## Assumptions Verified (web research, 2026-07-09)

The flagged uncertainty was confirmed by web research (VS Code API docs + issues #182795, #73017, #195715; release notes 1.85/1.86/1.88). The design is validated:

1. **CONFIRMED: `vscode.window.tabGroups.all` enumerates auxiliary-window tab groups**, and their tabs expose `TabInputWebview` with the correct extension-registered `viewType`. Editor groups are indexed globally across main and auxiliary windows, so the Change 6 ghost-tab check detects a floated `switchboard-project` ghost correctly.
2. **CONFIRMED: the `WebviewPanelSerializer` fires for a webview that was floated into an auxiliary window**, restoring it directly into the aux-window group it previously inhabited (auxiliary window layouts are persisted since 1.86). So `markProjectPanelRestoring()` arms correctly for floated panels.
3. **CONFIRMED: lazy background restoration is real** — VS Code defers `deserializeWebviewPanel` for background tabs until the user focuses them, and running `createWebviewPanel` before that late deserialize is a documented duplicate-tab race (issues #182795, #73017). This is exactly this plan's root cause.
4. **Design validated:** the VS Code-recommended mitigation for the lazy-restore race is a singleton registry that **disposes the duplicate on late deserialization and focuses the existing panel** — precisely this plan's ghost-disposal in `deserializeProjectPanel` (Edge-Case #5). No redesign needed.

> **Note (not a blocker):** research surfaced a real upstream class of bug — orphaned `setTimeout` handles in aux-window/webview code (e.g. VS Code PR #311824 "aux window - fix setTimeout leak"). This reinforces the Change 5 clarification about the un-cancelled 8s timer in `markProjectPanelRestoring`; harmless here (flag-guarded), but retaining the handle to `clearTimeout` on early-clear is the tidier pattern.

## Verification Plan

> **Session directives:** Per current session policy, **skip compilation** and **skip automated tests**.

### Automated Tests

- `project-panel-restore-guard.test.js` — static-source-assertion test (see Change 7 above).

### Manual Verification

1. **Enable `persistPanels`:** Set `switchboard.persistPanels: true` in user settings.

2. **Repro — reload with PROJECT panel open:** Open the Project panel. Run `Developer: Reload Window`. **Before** the panel finishes loading, immediately click "Review plan" on a Kanban card (or trigger `switchboard.openProjectPanel`). **Expected:** At most a brief delay (~1-1.5s) while the restore guard waits for the serializer, then the restored panel is revealed — NO duplicate tab.

3. **Repro — lazy restoration:** Open the Project panel in a secondary tab group (not the active one). Close VS Code and reopen. The PROJECT tab should be visible but in the background. Click "Review plan" on a Kanban card. **Expected:** A single PROJECT panel appears (either the restored one or a fresh one); no duplicate. If a fresh one is created, focusing the background ghost tab should NOT produce a second live panel (the serializer should dispose the ghost if a fresh panel already exists).

4. **Regression — `persistPanels: false` (default):** With `persistPanels` disabled, verify all existing behavior is unchanged: rapid "Review plan" clicks, command palette open, dispose-then-reopen. No delays, no duplicates.

5. **Regression — normal open with `persistPanels: true` but no prior panel:** Enable `persistPanels`, ensure no PROJECT panel was open in the previous session. Open the Project panel. **Expected:** Opens immediately with zero delay — the `TabGroups` API ghost-tab check finds no `switchboard-project` tab in the layout, so `markProjectPanelRestoring()` is never called and `_projectPanelRestoring` stays `false`. This is the key UX improvement over a naive "always wait" approach.

---

**Recommendation:** Complexity 4 → **Send to Coder.** The changes are localized to `PlanningPanelProvider.ts` (one new field, one new method, guards in two existing methods) and a one-line call in `extension.ts`. The edge-case audit covers the lazy-restoration scenario which is the hardest to reason about. The `_projectPanelRestoring` flag is a simple, testable mechanism.
