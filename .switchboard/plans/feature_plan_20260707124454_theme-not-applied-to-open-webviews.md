# Fix: Theme changes do not apply to already-open webviews (split theme on Design)

**Plan ID:** a1b2c3d4-0002-4a02-9f02-themeprop0002

## Goal

When the user switches themes (Afterburner ↔ Claudify) or toggles theme checkboxes (animation, scanlines, colour-icons, pixel-font, ultracode) in the Themes tab of `setup.html`, **all already-open webviews** must update immediately and consistently. Today the Design panel (and to a lesser extent other panels) ends up in a split state — e.g. afterburner sidebar colours with a claudify doc-preview area — because theme propagation is not broadcast uniformly to every panel. Eliminate the split-theme class of bugs by routing theme changes through a single broadcast that reaches every open panel directly, and make the per-panel handler defensively re-derive the full body class set from the canonical `getThemeBodyClass()` logic.

### Problem / background / root cause

There are two parallel, inconsistent theme-propagation mechanisms:

**Mechanism A — direct broadcast (covers only 3 panels).**
`SetupPanelProvider` handles `setThemeSetting` (`SetupPanelProvider.ts:125-142`) by calling `handleSetThemeSetting` (updates config) and then `this._taskViewerProvider.broadcastToWebviews({ type: 'switchboardThemeChanged', theme })`. `broadcastToWebviews` (`TaskViewerProvider.ts:4585-4588`) posts to exactly three targets:

```ts
public broadcastToWebviews(message: any): void {
    this._postSharedWebviewMessage(message);   // _view (sidebar) + _setupPanelProvider
    this._kanbanProvider?.postMessage(message);
}
```

It does **NOT** post to `PlanningPanelProvider` (project.html / planning panel) or `DesignPanelProvider` (design.html). The checkbox handlers (`setCyberAnimationDisabledSetting`, `setColourKanbanIconsSetting`, `setPixelFontSetting`, etc. in `SetupPanelProvider.ts:743-849`) similarly broadcast only through `broadcastToWebviews` + a `switchboard.refreshUI` call (which only refreshes the sidebar — `TaskViewerProvider.refreshUI` at `:2892-2922` posts nothing to design/planning).

**Mechanism B — `onDidChangeConfiguration` listener (covers design + planning, but async/indirect).**
`DesignPanelProvider` (`DesignPanelProvider.ts:169-198`) and `PlanningPanelProvider` (`PlanningPanelProvider.ts:405-426`) each register `vscode.workspace.onDidChangeConfiguration` listeners for `switchboard.theme.name`, `.disableCyberAnimation`, `.disableCyberScanlines`, `.pixelFont`, `.ultracodeAnimation`, and post the corresponding message to their own `_panel`. `TaskViewerProvider` also has its own listener (`:501-529`) that re-broadcasts.

**Why this produces a split theme.** Design and Planning depend on the async `onDidChangeConfiguration` event firing after `config.update` resolves. This is unreliable in several real cases:
- The config update in `handleSetThemeSetting` writes Global then clears Workspace (`TaskViewerProvider.ts:4576-4577`); the event fires once, and if the design panel's `_panel` is momentarily null (panel hidden / being restored via `deserializeWebviewPanel`) the `postMessage` is dropped silently (`this._panel?.webview.postMessage` — optional chaining swallows the no-op).
- The `_themeListenersRegistered` guard (`DesignPanelProvider.ts:162`) is set once in the constructor; a restored panel reuses the original listener, which posts to whatever `_panel` currently is — but if the listener's disposable was disposed with a prior panel instance, the event never arrives.
- When the message does NOT arrive, the body keeps its old theme class. If the panel is later re-rendered (e.g. tab switch, content refresh) with the new theme via `applyThemeBodyClass`, parts of the DOM that were styled by the old class persist while new content picks up the new class → the observed "afterburner sidebar + claudify doc preview" split.

The user's perception that "project.html gets a full refresh but design doesn't" reflects that Planning/project sometimes re-renders content on the message (visible refresh) while Design only toggles body classes (subtle) — and when the message is missed, Design stays stale/split.

**Root cause summary:** theme broadcast is not unified — it reaches some panels via direct postMessage and others via an indirect config event that can be silently dropped. There is no single source of truth that guarantees every open panel receives every theme change.

## Metadata

**Tags:** frontend, theme, bugfix, webview, design, setup
**Complexity:** 6

## User Review Required

Confirm visual theme-switch parity across all panels (Design, Project, Planning, Kanban, Setup, Sidebar) post-fix; no schema/data decisions. Specifically: verify that rapid theme switching (5+ switches) never produces a split-theme state on the Design panel's sidebar vs. doc-preview area, and that checkbox toggles (animation, scanlines, pixel-font, ultracode, colour-icons) apply uniformly to all open panels within the same frame.

## Complexity Audit

### Routine
- Adding `DesignPanelProvider` and `PlanningPanelProvider` references to `broadcastToWebviews` (or a new `broadcastThemeChange`) in `TaskViewerProvider` — one-line wiring each, mirroring the existing `_kanbanProvider?.postMessage` pattern.
- Ensuring each provider exposes a `postMessage(message)` public method (DesignPanelProvider already has one used by `onDidChangeConfiguration`; PlanningPanelProvider needs a thin wrapper around `_projectPanel?.webview.postMessage` + `_panel?.webview.postMessage`).
- The per-panel JS handlers (`design.js:3628-3668`, `project.js:141-165`, `planning.js:3330-3354`, `setup.html:4538-4567`, `kanban.html` theme handler) already do correct class-swap logic. No JS change required for the core fix.

### Complex / Risky
- **Reference wiring / lifecycle.** `TaskViewerProvider` must hold references to `DesignPanelProvider` and `PlanningPanelProvider`. These are singletons created in `extension.ts`; wire them the same way `_kanbanProvider` and `_setupPanelProvider` are injected (constructor / setter). Avoid circular-dependency / init-order hazards by using the same late-binding setter pattern already used for `_setupPanelProvider`.
- **Duplicate-message safety.** With both the direct broadcast AND the `onDidChangeConfiguration` listener firing for design/planning, each theme change will deliver the message twice. The handlers must be idempotent (they already are — `classList.remove`/`add` is a no-op if the class is already in the target state). Verify no handler treats a repeat message as a toggle.
- **`onDidChangeConfiguration` may still be needed** for the case where the config changes outside the setup UI (e.g. user edits settings.json directly). Keep the listeners; the direct broadcast is additive, not a replacement.
- **Restored panels.** `deserializeWebviewPanel` (`DesignPanelProvider.ts:202-229`, `PlanningPanelProvider`) reassigns `_panel`. The direct broadcast uses the provider's current `_panel` reference, so a restored panel receives the broadcast as long as the provider singleton is the same instance. Confirm the singleton invariant holds across restore.
- **Published extension (~4,000 installs).** Pure additive broadcast wiring; no settings migration, no DB change, no user-data risk.

## Edge-Case & Dependency Audit

- **Panel not open.** `postMessage` on a null `_panel` is a no-op (optional chaining). Safe.
- **Theme checkbox toggles (not just theme name).** The same split-broadcast gap affects `cyberAnimationSetting`, `cyberScanlinesSetting`, `pixelFontSetting`, `ultracodeAnimationSetting`, `colourKanbanIconsSetting`. The fix must route ALL of these through the unified broadcast, not just `switchboardThemeChanged`. Each checkbox handler in `SetupPanelProvider` currently calls `broadcastToWebviews` (3 panels) + `refreshUI` (sidebar only) — after the fix, `broadcastToWebviews` reaches all panels.
- **`colourKanbanIconsSetting`** is broadcast today but the design/planning JS handlers do not act on it (only kanban/setup do). That is fine — adding design/planning to the broadcast does not require them to handle messages they previously ignored; they simply no-op. No regression.
- **Sidebar (TaskViewer `_view`).** Already covered by `_postSharedWebviewMessage`. No change.
- **Kanban panel.** Already covered. No change.
- **Implementation panel.** Owned by `PlanningPanelProvider` (`_panel` — the implementation/planning webview). Ensure the `postMessage` wrapper hits both `_panel` and `_projectPanel`.
- **Dependencies** — none. No other plan edits `broadcastToWebviews` or the provider wiring. The claudify background plans (Issues 3 & 4) edit CSS only; this plan edits TS broadcast wiring. No conflict.

## Dependencies

None — no cross-session dependencies. Sibling plans B (setup panel opacity) and C (webview ground) are CSS-only and independent of this TS plan.

## Adversarial Synthesis

Key risks: duplicate-message delivery to design/planning panels (direct broadcast + onDidChangeConfiguration listener both firing), and potential init-order hazard if DesignPanelProvider/PlanningPanelProvider references are set before providers are fully constructed. Mitigations: handlers are already idempotent (classList operations are no-ops when repeated), and the late-binding setter pattern matches the existing `_setupPanelProvider`/`_kanbanProvider` wiring which has no init-order issues in production.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — extend `broadcastToWebviews` to all panels

Add late-bound references and include them in the broadcast:

```ts
// Near the existing _setupPanelProvider / _kanbanProvider fields
private _designPanelProvider?: { postMessage(message: any): void };
private _planningPanelProvider?: { postMessage(message: any): void };

public setDesignPanelProvider(p: { postMessage(message: any): void }): void {
    this._designPanelProvider = p;
}
public setPlanningPanelProvider(p: { postMessage(message: any): void }): void {
    this._planningPanelProvider = p;
}

public broadcastToWebviews(message: any): void {
    this._postSharedWebviewMessage(message);      // sidebar + setup
    this._kanbanProvider?.postMessage(message);
    this._designPanelProvider?.postMessage(message);     // NEW
    this._planningPanelProvider?.postMessage(message);   // NEW
}
```

### 2. `src/services/DesignPanelProvider.ts` — ensure `postMessage` is public and robust

`DesignPanelProvider` already has a `postMessage` method (used by its `onDidChangeConfiguration` listener). Confirm it is `public` and posts to `this._panel`:

```ts
public postMessage(message: any): void {
    this._panel?.webview.postMessage(message);
}
```

(If the existing method signature differs, adjust to match. No logic change.)

### 3. `src/services/PlanningPanelProvider.ts` — add a public `postMessage` covering both panels

```ts
public postMessage(message: any): void {
    this._panel?.webview.postMessage(message);          // implementation/planning panel
    this._projectPanel?.webview.postMessage(message);   // project panel
}
```

### 4. `src/extension.ts` — wire the new providers into TaskViewerProvider

At the same place `_kanbanProvider` and `_setupPanelProvider` are wired onto `TaskViewerProvider`, add:

```ts
taskViewerProvider.setDesignPanelProvider(designPanelProvider);
taskViewerProvider.setPlanningPanelProvider(planningPanelProvider);
```

Use the same late-binding / init-order pattern already used for the other providers.

### 5. (Defensive, optional) Per-panel JS — re-derive full class set on `switchboardThemeChanged`

The existing handlers (`design.js:3628-3654`, `project.js:141-164`, `planning.js:3330-3352`) compute `desired` from `state.switchboardTheme` and remove only the two base theme classes. To make split-theme structurally impossible, also strip any stale auxiliary classes that should not persist across a theme switch when the new theme is not afterburner (e.g. `cyber-animation-disabled`, `cyber-scanlines-disabled` are afterburner-scoped). This is optional hardening — the core fix is the broadcast wiring. Only add if split-theme recurs after Change 1-4.

## Verification Plan

1. **Manual (installed VSIX), theme switch:**
   - Open Design, Project, Kanban, Setup, and the sidebar simultaneously.
   - In Setup → Themes, switch Afterburner → Claudify.
   - Confirm EVERY panel updates to claudify (terracotta accent, flat surface) within the same frame — no panel retains afterburner cyan/glass.
   - Switch Claudify → Afterburner; confirm every panel returns to afterburner.
2. **Split-theme repro:** With Design open and focused on a doc preview, switch themes repeatedly (5+ times rapidly). Confirm the design sidebar and doc-preview area always share the same theme — never afterburner-sidebar + claudify-preview.
3. **Checkbox toggles:** In Setup → Themes, toggle Animation, Scanlines, Colour-icons, Pixel-font, Ultracode one at a time with Design + Project open. Confirm each toggle applies to all open panels (e.g. toggling animation off removes the CRT sweep in design + project + planning, not just the sidebar).
4. **Restored panel:** Close VS Code with Design open, reopen (panel restored via `deserializeWebviewPanel`). Switch theme. Confirm the restored Design panel updates.
5. **No duplicate-render regression:** Confirm kanban/setup/sidebar still update exactly once per switch (idempotent handlers do not double-apply).
6. **Direct settings.json edit:** Edit `switchboard.theme.name` in `settings.json` directly (bypassing the setup UI). Confirm the `onDidChangeConfiguration` listeners still fire for design/planning (the listeners are kept) — this is the path that does NOT go through `broadcastToWebviews` and must still work.

---

## Code-Claim Verification Notes

The following line-number references in the original plan were verified against source and found to be stale; the code logic described is correct, only the line numbers drifted:

| Plan Reference | Actual Location | Notes |
|---|---|---|
| `broadcastToWebviews` at `TaskViewerProvider.ts:4585-4588` | `:4596-4599` | Off by ~11 lines; method body matches plan snippet exactly |
| `refreshUI` at `TaskViewerProvider.ts:2892-2922` | `:2902+` | Off by ~10 lines; method starts at 2902 |
| `handleSetThemeSetting` Global/Workspace update at `:4576-4577` | `:4587-4588` | Off by ~11 lines; `config.update('theme.name', theme, Global)` then `config.update('theme.name', undefined, Workspace)` |
| `PlanningPanelProvider.ts:405-426` for `onDidChangeConfiguration` | `:431-460` (project panel via `_registerProjectPanelConfigListener`), `:594-616` (planning panel in `open()`), `:742-764` (planning panel in `_hydratePanel()`) | PlanningPanelProvider has THREE separate config listener registrations, not one; the plan's line range pointed at the project panel init code, not the listener itself |

**Correction on listener-disposal claim:** The original plan states "if the listener's disposable was disposed with a prior panel instance, the event never arrives." This is inaccurate — `DesignPanelProvider.dispose()` is only called on extension deactivation (it's in `context.subscriptions`), not on panel close. The `onDidDispose` handler (line 231) only nulls `_panel` and stops watchers/poll; `_disposables` (containing the config listeners) persist for the provider singleton's lifetime. The real risk is simpler: if `_panel` is null when the config event fires (panel closed or between restore steps), `postMessage` is silently dropped via optional chaining. The proposed direct broadcast fix correctly addresses this by routing through the provider's `postMessage` method which also uses optional chaining on `_panel` — but the broadcast arrives synchronously from the setup UI action, making the null-panel window much narrower than the async config-event path.

**Verified correct claims:**
- `SetupPanelProvider.ts:125-142` for `setThemeSetting` handler — ✓
- `SetupPanelProvider.ts:743-849` for checkbox handlers — ✓ (theme-related ones at 743-795)
- `DesignPanelProvider.ts:169-198` for `onDidChangeConfiguration` — ✓
- `DesignPanelProvider.ts:162` for `_themeListenersRegistered` guard — ✓
- `DesignPanelProvider.ts:202-229` for `deserializeWebviewPanel` — ✓
- `TaskViewerProvider.ts:501-529` for `onDidChangeConfiguration` — ✓
- `DesignPanelProvider` has public `postMessage` at line 309 — ✓
- `PlanningPanelProvider` does NOT have a public `postMessage` method — ✓ (needs to be added)
- `setKanbanProvider` / `setSetupPanelProvider` exist in `TaskViewerProvider` at lines 2202 / 2223 — ✓
- `extension.ts` wires providers at lines 790-791 — ✓
- No `setDesignPanelProvider` or `setPlanningPanelProvider` exists yet — ✓

**Recommendation:** Send to Coder

**Stage Complete:** PLAN REVIEWED
