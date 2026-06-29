# Add CRT Scanlines Toggle to Afterburner Theme Selection in Setup

## Goal

Add a second checkbox in the Setup > Theme > Animation section that allows independently toggling the static CRT scanline texture overlay in Afterburner preview panels. This mirrors the existing "Enable Artifacts panel animation" (rolling sweep beam) toggle, using the same setting + body class + message broadcast pattern.

### Problem
The Afterburner theme applies CRT scanlines (static horizontal line overlay) to preview panels in `planning.html` and `project.html`. Currently, the only toggle in the Setup > Theme > Animation section controls the **rolling sweep beam** animation (`cyber-animation-disabled` body class). There is **no way to turn off the static CRT scanlines** independently — they are always on when the Afterburner theme is active.

The user wants a second checkbox in the Afterburner theme selection area of `setup.html` that allows turning off the CRT scanline effects, in addition to the existing rolling sweep toggle.

### Root Cause
The CSS rule `.cyber-theme-enabled .cyber-scanlines { display: block; }` unconditionally shows scanlines whenever the Afterburner theme is active. There is no body class or setting to suppress them independently of the sweep animation. The `cyber-animation-disabled` class only suppresses the `::before` sweep animation, not the static scanline texture.

## Metadata
- **Tags:** [ui, feature]
- **Complexity:** 4

## User Review Required
No — this follows an established pattern already in the codebase (`disableCyberAnimation`). The user explicitly requested an independent scanlines toggle.

## Complexity Audit

### Routine
- Add a new VS Code setting (`switchboard.theme.disableCyberScanlines`) to `package.json` — mirrors existing `disableCyberAnimation` setting
- Extend `themeBodyClass.ts` `getThemeBodyClass()` to inject `cyber-scanlines-disabled` body class on first paint — one-line extension of existing return statement
- Add backend handler methods to `TaskViewerProvider.ts` — copy/paste of existing animation handlers with renamed setting key
- Add config-change listener to `TaskViewerProvider.ts` — copy/paste of existing animation listener
- Add setup panel state post to `TaskViewerProvider.ts` — copy/paste of existing animation post
- Add message handler cases to `SetupPanelProvider.ts` — copy/paste of existing animation cases
- Add config-change listeners to `PlanningPanelProvider.ts` (3 locations) and `DesignPanelProvider.ts` (2 locations) — copy/paste of existing animation listeners
- Add initial-state posts to `PlanningPanelProvider.ts` (3 locations) and `DesignPanelProvider.ts` (1 location) — copy/paste of existing animation posts
- Add checkbox HTML to `setup.html` — copy of existing animation toggle with new IDs/labels
- Add JS change handler, hydration post, and message handlers to `setup.html` — copy of existing animation handlers
- Add CSS suppression rule to `planning.html` and `project.html` — new rule using `!important` to override the display:block rule
- Add JS message handlers to `planning.js`, `project.js`, and `design.js` — one-line case additions

### Complex / Risky
- **First-paint flash prevention**: `themeBodyClass.ts` must inject `cyber-scanlines-disabled` at HTML generation time, or scanlines will flash on load before the JS message arrives. This is the same risk as the existing animation flash prevention, and the mitigation is identical.
- **Multi-file coordination**: 12 files must be touched, but each change is small and follows the existing pattern exactly. The risk is missing a location, not getting an individual change wrong.

## Edge-Case & Dependency Audit

- **Race Conditions:** The config-change listener in `TaskViewerProvider.ts` broadcasts to sidebar/setup/kanban panels. `PlanningPanelProvider` and `DesignPanelProvider` have their own independent config-change listeners. There is no race — all listeners fire on the same `onDidChangeConfiguration` event and each panel updates its own body class independently.
- **Security:** None — no credentials, no data exposure, no input handling. The setting is a boolean stored in VS Code workspace config.
- **Side Effects:** Toggling the setting calls `vscode.commands.executeCommand('switchboard.refreshUI')` (mirroring the animation toggle), which refreshes all webviews. This is the existing behavior for theme-related setting changes.
- **Dependencies & Conflicts:**
  1. **First-paint flash**: `themeBodyClass.ts` must inject `cyber-scanlines-disabled` alongside `cyber-animation-disabled` when the setting is true, or scanlines will flash on load before the JS message arrives. Mitigated by extending `getThemeBodyClass()`.
  2. **Claudify theme**: Scanlines don't exist under Claudify, so the toggle should only be visible when Afterburner is selected. The entire `#theme-animation-settings` div is hidden by `updateAnimationSectionVisibility()` when theme is not afterburner (line 1748-1751), so the new checkbox is automatically hidden. No change needed to `updateAnimationSectionVisibility()`.
  3. **`prefers-reduced-motion`**: The existing reduced-motion media query (planning.html line 2028-2032, project.html line 704-709) only suppresses the sweep, not the scanlines. The new toggle is independent — a user may want scanlines off but not have reduced-motion enabled. No conflict.
  4. **`scanlines-suppressed` class**: There is already a per-panel `scanlines-suppressed` class (planning.html line 2060, project.html line 711) used in specific contexts: `.preview-panel-wrapper.scanlines-suppressed > .cyber-scanlines { display: none !important; }`. The new global body class must coexist with this — both should be able to suppress scanlines independently. The new rule `.cyber-theme-enabled.cyber-scanlines-disabled .cyber-scanlines { display: none !important; }` has higher specificity (0,3,0) than the show rule (0,2,0) and uses `!important`, so it will override. Both suppression rules can be active simultaneously without conflict.
  5. **Kanban.html**: Does not have scanlines or a `cyberAnimationSetting` JS handler (verified via grep — zero matches). It does not need a `cyberScanlinesSetting` handler either, but it does receive the body class at HTML generation time via `applyThemeBodyClass()`. No change needed in kanban.html.
  6. **Design.html**: Does not have scanlines (no `.cyber-scanlines` elements). No CSS change needed, but it does need the JS message handler to toggle the body class (for consistency, since the backend will broadcast to all panels). The body class is harmless when no `.cyber-scanlines` elements exist.
  7. **`broadcastToWebviews` scope**: `TaskViewerProvider.broadcastToWebviews()` (line 4401) sends to sidebar, setup, and kanban panels only — NOT to planning or design panels. This is why `PlanningPanelProvider` and `DesignPanelProvider` have their own independent config-change listeners. The plan correctly adds listeners to both providers.

## Dependencies
- None — this plan is fully self-contained and follows the existing `disableCyberAnimation` pattern exactly.

## Adversarial Synthesis

Key risks: (1) missing one of the 12 file locations — mitigated by explicit line numbers for every change and a complete file list. (2) first-paint flash if `themeBodyClass.ts` is not updated — mitigated by extending `getThemeBodyClass()` with the scanlines check. (3) CSS specificity — the new rule uses `!important` and higher specificity than the show rule, confirmed to override correctly. (4) the `themeBodyClass.ts` change must preserve the existing one-liner style rather than refactoring. No research needed — the VS Code extension API, CSS specificity, and the existing codebase pattern are all well-understood.

## Proposed Changes

### 1. `package.json` — Add new VS Code setting

Add after the existing `switchboard.theme.disableCyberAnimation` setting (after line 682):

```json
"switchboard.theme.disableCyberScanlines": {
  "type": "boolean",
  "default": false,
  "description": "Disable the static CRT scanline texture in the Afterburner theme. The rolling sweep animation is controlled separately.",
  "scope": "window"
},
```

### 2. `src/services/themeBodyClass.ts` — Inject body class on first paint

Update `getThemeBodyClass()` (line 43-56) to also check for scanlines disabled. **Preserve the existing one-liner return style** — do not refactor into multi-line:

```typescript
export function getThemeBodyClass(): string {
    const cfg = vscode.workspace.getConfiguration('switchboard');
    const theme = cfg.get<string>('theme.name', 'afterburner');
    if (theme === 'afterburner') {
        const animDisabled = cfg.get<boolean>('theme.disableCyberAnimation', false);
        const scanlinesDisabled = cfg.get<boolean>('theme.disableCyberScanlines', false);
        return 'cyber-theme-enabled' + (animDisabled ? ' cyber-animation-disabled' : '') + (scanlinesDisabled ? ' cyber-scanlines-disabled' : '');
    }
    const colourIcons = getEffectiveColourKanbanIcons();
    const colourClass = colourIcons ? ' kanban-icons-colour' : '';
    if (theme === 'claudify') {
        return 'theme-claudify' + colourClass;
    }
    return '';
}
```

### 3. `src/services/TaskViewerProvider.ts` — Add backend handlers

Add new handler methods after the existing animation handlers (after line 4074):

```typescript
public handleGetCyberScanlinesDisabledSetting(): boolean {
    return vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
}

public async handleSetCyberScanlinesDisabledSetting(disabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('theme.disableCyberScanlines', disabled, vscode.ConfigurationTarget.Workspace);
}
```

Add config-change listener (after line 492, inside the `onDidChangeConfiguration` block):

```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const scanlinesDisabled = vscode.workspace
        .getConfiguration('switchboard')
        .get<boolean>('theme.disableCyberScanlines', false);
    this.broadcastToWebviews({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
}
```

Add to `postSetupPanelState()` (after line 4486, after the existing `cyberAnimationDisabledSetting` post):

```typescript
this._setupPanelProvider.postMessage({
    type: 'cyberScanlinesDisabledSetting',
    enabled: this.handleGetCyberScanlinesDisabledSetting()
});
```

### 4. `src/services/SetupPanelProvider.ts` — Add message handlers

Add cases (after line 711, mirroring the animation pattern):

```typescript
case 'getCyberScanlinesDisabledSetting':
    this._panel.webview.postMessage({
        type: 'cyberScanlinesDisabledSetting',
        enabled: this._taskViewerProvider.handleGetCyberScanlinesDisabledSetting()
    });
    break;
case 'setCyberScanlinesDisabledSetting':
    await this._taskViewerProvider.handleSetCyberScanlinesDisabledSetting(message.enabled);
    await this._taskViewerProvider.postSetupPanelState();
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
```

### 5. `src/services/PlanningPanelProvider.ts` — Broadcast setting changes

Add config-change listeners and initial-state posts mirroring the `disableCyberAnimation` pattern. There are 3 listener locations and 3 initial-state posts:

**Listener 1** (after line 370, after the `disableCyberAnimation` listener):
```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._projectPanel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
}
```

**Initial-state post 1** (after line 377, after the `cyberAnimationSetting` post):
```typescript
const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
this._projectPanel.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
```

**Listener 2** (after line 519, after the `disableCyberAnimation` listener):
```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
}
```

**Initial-state post 2** (after line 621, after the `cyberAnimationSetting` post):
```typescript
const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
panel.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
```

**Listener 3** (after line 640, after the `disableCyberAnimation` listener):
```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
}
```

**Initial-state post 3** (after line 7129, after the `cyberAnimationSetting` post):
```typescript
const cyberScanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: cyberScanlinesDisabled });
```

### 6. `src/services/DesignPanelProvider.ts` — Broadcast setting changes

**Listener 1** (after line 174, after the `disableCyberAnimation` listener):
```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled });
}
```

**Listener 2** (after line 269, after the `disableCyberAnimation` listener):
```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled });
}
```

**Initial-state post** (after line 1411, after the `cyberAnimationSetting` post):
```typescript
this.postMessage({ type: 'cyberScanlinesSetting', disabled: themeConfig.get<boolean>('theme.disableCyberScanlines', false) });
```

### 7. `src/webview/setup.html` — Add checkbox UI + JS handler

**HTML** — Add a new checkbox inside `#theme-animation-settings` (after line 1252, before the status div at line 1253). Place it after the existing rolling sweep toggle:

```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="cyber-scanlines-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Enable CRT scanlines</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Show the static CRT scanline texture overlay in Afterburner preview panels.</span>
    </div>
</label>
```

> **Note**: The new checkbox reuses the existing `#cyber-animation-status` div (line 1253) for the "Saved" confirmation message. Both toggles share the same status area since they are in the same Animation section.

**JS handler** — Add after the existing `cyber-animation-toggle` handler (after line 3941):

```javascript
document.getElementById('cyber-scanlines-toggle')?.addEventListener('change', (e) => {
    const isDisabled = !e.target.checked;
    vscode.postMessage({ type: 'setCyberScanlinesDisabledSetting', enabled: isDisabled });
    document.body.classList.toggle('cyber-scanlines-disabled', isDisabled);
    const statusEl = document.getElementById('cyber-animation-status');
    if (statusEl) {
        statusEl.textContent = 'Saved';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
});
```

**Hydration** — Add to the `theme` tab hydration function (after line 1848, after the existing `getCyberAnimationDisabledSetting` post):

```javascript
vscode.postMessage({ type: 'getCyberScanlinesDisabledSetting' });
```

**Message handlers** — Add after the `cyberAnimationDisabledSetting` handler (after line 4643). Note: setup.html already has both `cyberAnimationSetting` (line 4630) and `cyberAnimationDisabledSetting` (line 4636) handlers. The new handlers mirror both:

```javascript
case 'cyberScanlinesSetting': {
    runSetupHydration(() => {
        document.body.classList.toggle('cyber-scanlines-disabled', message.disabled);
    });
    break;
}
case 'cyberScanlinesDisabledSetting': {
    runSetupHydration(() => {
        const toggle = document.getElementById('cyber-scanlines-toggle');
        if (toggle) toggle.checked = message.enabled !== true;
        document.body.classList.toggle('cyber-scanlines-disabled', message.enabled === true);
    });
    break;
}
```

### 8. `src/webview/planning.html` — Add CSS suppression rule

Add after the existing scanlines-suppressed rule (after line 2062):

```css
/* Global scanline suppression — toggled by the Setup panel checkbox */
.cyber-theme-enabled.cyber-scanlines-disabled .cyber-scanlines {
    display: none !important;
}
```

### 9. `src/webview/planning.js` — Add message handler

Add after the `cyberAnimationSetting` handler (after line 3832):

```javascript
case 'cyberScanlinesSetting':
    document.body.classList.toggle('cyber-scanlines-disabled', msg.disabled);
    break;
```

### 10. `src/webview/project.html` — Add CSS suppression rule

Add after the existing scanlines-suppressed rule (after line 713):

```css
/* Global scanline suppression — toggled by the Setup panel checkbox */
.cyber-theme-enabled.cyber-scanlines-disabled .cyber-scanlines {
    display: none !important;
}
```

### 11. `src/webview/project.js` — Add message handler

Add after the `cyberAnimationSetting` handler (after line 394):

```javascript
case 'cyberScanlinesSetting':
    document.body.classList.toggle('cyber-scanlines-disabled', msg.disabled);
    break;
```

### 12. `src/webview/design.js` — Add message handler

Add after the `cyberAnimationSetting` handler (after line 3503):

```javascript
case 'cyberScanlinesSetting':
    document.body.classList.toggle('cyber-scanlines-disabled', msg.disabled);
    break;
```

> **Note**: `design.html` has no scanline elements, so no CSS change is needed there. The body class is harmless when no `.cyber-scanlines` elements exist.

## Verification Plan

### Automated Tests
- None — this feature follows an existing UI toggle pattern with no testable business logic. No unit/integration/e2e tests apply.

### Manual Verification
1. **Manual test — toggle OFF**:
   - Open Setup panel, select Afterburner theme.
   - Uncheck "Enable CRT scanlines" checkbox.
   - Open Planning panel — confirm scanline texture is gone from preview panels.
   - Open Project panel — confirm scanline texture is gone from all preview panels.
   - Confirm the rolling sweep animation is still visible (if its toggle is on).
2. **Manual test — toggle ON**:
   - Check "Enable CRT scanlines" checkbox.
   - Confirm scanlines reappear in Planning and Project panels.
3. **Manual test — persistence**:
   - Toggle scanlines off, reload VS Code window.
   - Confirm scanlines are still off on first paint (no flash of scanlines before JS loads).
4. **Manual test — Claudify**:
   - Switch to Claudify theme — confirm the entire Animation section (including the new checkbox) is hidden.
5. **Manual test — sweep independence**:
   - Disable scanlines, enable sweep — confirm sweep beam is visible but no static scanline texture.
   - Enable scanlines, disable sweep — confirm scanline texture is visible but no sweep beam.
6. **Manual test — reduced motion**:
   - Enable scanlines, enable reduced-motion in OS settings — confirm scanlines still show (only the sweep is suppressed by reduced-motion).
7. **Grep verification**:
   - Search all `src/` files for `cyberScanlinesSetting` — confirm handlers exist in setup.html, planning.js, project.js, design.js.
   - Search all `src/` files for `cyber-scanlines-disabled` — confirm CSS rules exist in planning.html and project.html, and body class toggling exists in all JS files.
   - Search `package.json` for `disableCyberScanlines` — confirm the setting exists.

## Recommendation

Complexity 4/10 → **Send to Coder**
