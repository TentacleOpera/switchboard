# Add CRT Scanlines Toggle to Afterburner Theme Selection in Setup

## Goal

### Problem
The Afterburner theme applies CRT scanlines (static horizontal line overlay) to preview panels in `planning.html` and `project.html`. Currently, the only toggle in the Setup > Theme > Animation section controls the **rolling sweep beam** animation (`cyber-animation-disabled` body class). There is **no way to turn off the static CRT scanlines** independently — they are always on when the Afterburner theme is active.

The user wants a second checkbox in the Afterburner theme selection area of `setup.html` that allows turning off the CRT scanline effects, in addition to the existing rolling sweep toggle.

### Root Cause
The CSS rule `.cyber-theme-enabled .cyber-scanlines { display: block; }` unconditionally shows scanlines whenever the Afterburner theme is active. There is no body class or setting to suppress them independently of the sweep animation. The `cyber-animation-disabled` class only suppresses the `::before` sweep animation, not the static scanline texture.

## Metadata
- **Tags**: `setup`, `theme`, `afterburner`, `crt`, `scanlines`, `ui-toggle`
- **Complexity**: 4/10

## Complexity Audit

**Routine** — The change follows an established pattern already in the codebase:
- The `switchboard.theme.disableCyberAnimation` setting + `cyber-animation-disabled` body class + `cyberAnimationSetting` message is the exact blueprint for adding a parallel `switchboard.theme.disableCyberScanlines` setting + `cyber-scanlines-disabled` body class + `cyberScanlinesSetting` message.
- All webview files already have the message-handler infrastructure for theme-related settings.
- The setup.html UI already has a checkbox pattern (the rolling sweep toggle) to copy.

**Mild risk** — touches multiple files (package.json, 4 TypeScript providers, themeBodyClass.ts, 5 HTML/JS webview files) but each change is small and follows the existing pattern exactly.

## Edge-Case & Dependency Audit

1. **First-paint flash**: `themeBodyClass.ts` must inject `cyber-scanlines-disabled` alongside `cyber-animation-disabled` when the setting is true, or scanlines will flash on load before the JS message arrives.
2. **Claudify theme**: Scanlines don't exist under Claudify, so the toggle should only be visible when Afterburner is selected (same as the existing animation toggle — controlled by `updateAnimationSectionVisibility()`).
3. **`prefers-reduced-motion`**: The existing reduced-motion media query only suppresses the sweep, not the scanlines. The new toggle is independent — a user may want scanlines off but not have reduced-motion enabled.
4. **`scanlines-suppressed` class**: There is already a per-panel `scanlines-suppressed` class used in specific contexts (`.preview-panel-wrapper.scanlines-suppressed > .cyber-scanlines { display: none !important; }`). The new global body class must coexist with this — both should be able to suppress scanlines independently.
5. **Kanban.html**: Does not have scanlines or a `cyberAnimationSetting` JS handler. It does not need a `cyberScanlinesSetting` handler either, but it does receive the body class at HTML generation time via `applyThemeBodyClass()`. No change needed in kanban.html.
6. **Design.html**: Does not have scanlines. No CSS change needed, but it does need the JS message handler to toggle the body class (for consistency, since the backend will broadcast to all panels).

## Proposed Changes

### 1. `package.json` — Add new VS Code setting

Add after the existing `switchboard.theme.disableCyberAnimation` setting (around line 685):

```json
"switchboard.theme.disableCyberScanlines": {
  "type": "boolean",
  "default": false,
  "description": "Disable the static CRT scanline texture in the Afterburner theme. The rolling sweep animation is controlled separately.",
  "scope": "window"
},
```

### 2. `src/services/themeBodyClass.ts` — Inject body class on first paint

Update `getThemeBodyClass()` (line 43-56) to also check for scanlines disabled:

```typescript
export function getThemeBodyClass(): string {
    const cfg = vscode.workspace.getConfiguration('switchboard');
    const theme = cfg.get<string>('theme.name', 'afterburner');
    if (theme === 'afterburner') {
        const animDisabled = cfg.get<boolean>('theme.disableCyberAnimation', false);
        const scanlinesDisabled = cfg.get<boolean>('theme.disableCyberScanlines', false);
        let classes = 'cyber-theme-enabled';
        if (animDisabled) classes += ' cyber-animation-disabled';
        if (scanlinesDisabled) classes += ' cyber-scanlines-disabled';
        return classes;
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

Add new handlers mirroring the animation pattern (after line 4053):

```typescript
public handleGetCyberScanlinesDisabledSetting(): boolean {
    return vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
}

public async handleSetCyberScanlinesDisabledSetting(disabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('theme.disableCyberScanlines', disabled, vscode.ConfigurationTarget.Workspace);
}
```

Add config-change listener (after line 471, inside the `onDidChangeConfiguration` block):

```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const scanlinesDisabled = vscode.workspace
        .getConfiguration('switchboard')
        .get<boolean>('theme.disableCyberScanlines', false);
    this.broadcastToWebviews({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
}
```

Add to `postSetupPanelState()` (after line 4465):

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

Add config-change listeners and initial-state posts mirroring the `disableCyberAnimation` pattern. There are 3 listener locations (lines 367, 516, 637) and 2 initial-state posts (lines 376-377, 620-621, 7128-7129). Add after each `disableCyberAnimation` block:

```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._projectPanel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
    // Also post to this._panel where applicable
}
```

And for initial state posts:

```typescript
const scanlinesDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled: scanlinesDisabled });
```

### 6. `src/services/DesignPanelProvider.ts` — Broadcast setting changes

Add config-change listeners (lines 171, 266) and initial-state posts mirroring the `disableCyberAnimation` pattern:

```typescript
if (e.affectsConfiguration('switchboard.theme.disableCyberScanlines')) {
    const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberScanlines', false);
    this._panel?.webview.postMessage({ type: 'cyberScanlinesSetting', disabled });
}
```

### 7. `src/webview/setup.html` — Add checkbox UI + JS handler

**HTML** — Add a new checkbox inside `#theme-animation-settings` (after line 1253, before the status div). Place it after the existing rolling sweep toggle:

```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="cyber-scanlines-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Enable CRT scanlines</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Show the static CRT scanline texture overlay in Afterburner preview panels.</span>
    </div>
</label>
```

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

**Hydration** — Add to the `theme` tab hydration function (after line 1848):

```javascript
vscode.postMessage({ type: 'getCyberScanlinesDisabledSetting' });
```

**Message handler** — Add after the `cyberAnimationDisabledSetting` handler (after line 4643):

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

### 8. `src/webview/planning.html` — Add CSS suppression rule + JS handler

**CSS** — Add after the existing scanlines-suppressed rule (after line 2062):

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

**CSS** — Add after the existing scanlines-suppressed rule (after line 713):

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

1. **Build**: `npm run compile` — confirm no TypeScript errors.
2. **Manual test — toggle OFF**:
   - Open Setup panel, select Afterburner theme.
   - Uncheck "Enable CRT scanlines" checkbox.
   - Open Planning panel — confirm scanline texture is gone from preview panels.
   - Open Project panel — confirm scanline texture is gone from all preview panels.
   - Confirm the rolling sweep animation is still visible (if its toggle is on).
3. **Manual test — toggle ON**:
   - Check "Enable CRT scanlines" checkbox.
   - Confirm scanlines reappear in Planning and Project panels.
4. **Manual test — persistence**:
   - Toggle scanlines off, reload VS Code window.
   - Confirm scanlines are still off on first paint (no flash of scanlines before JS loads).
5. **Manual test — Claudify**:
   - Switch to Claudify theme — confirm the entire Animation section (including the new checkbox) is hidden.
6. **Manual test — sweep independence**:
   - Disable scanlines, enable sweep — confirm sweep beam is visible but no static scanline texture.
   - Enable scanlines, disable sweep — confirm scanline texture is visible but no sweep beam.
7. **Manual test — reduced motion**:
   - Enable scanlines, enable reduced-motion in OS settings — confirm scanlines still show (only the sweep is suppressed by reduced-motion).
