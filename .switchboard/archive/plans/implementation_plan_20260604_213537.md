# Cyberpunk Theme Default Enablement and Animated CRT Beam Controls

## Goal

Make the retro-futuristic Cyberpunk styling the default theme for `planning.html`. Consequently, remove the "Enable Cyber Panel Theme" toggle from `setup.html` and the corresponding VS Code configuration entry (deprecate rather than delete). In its place, add a new setting/checkbox: "Disable Cyber Theme Animation" (`switchboard.theme.disableCyberAnimation`), which lets users turn off the CPU/GPU-friendly rolling CRT sweep beam if they find it distracting.

**Background & Root Cause**: The existing `switchboard.theme.cyberPanel` setting was opt-in (default `false`). The aesthetic is now mature enough to be on by default. The toggle-removal also simplifies the setup UI, and the new animation-disable toggle gives users the only meaningful control that remains.

## Metadata

**Tags:** frontend, ui, ux
**Complexity:** 3

## User Review Required

> [!IMPORTANT]
> **Config deprecation vs. deletion**: Rather than deleting `switchboard.theme.cyberPanel` outright, this plan deprecates it via VS Code's `"deprecationMessage"` field. This prevents silent data loss for users who previously set the key. No migration code is required — the old key simply becomes advisory-only with a deprecation notice. Confirm this approach is acceptable.

## Complexity Audit

### Routine

- Replace checkbox element in `setup.html` (1 HTML element, 3 JS string changes, 1 incoming message case)
- Rename handler methods in `TaskViewerProvider.ts` and `SetupPanelProvider.ts`
- Update `package.json` configuration (deprecate old key, add new key)
- Update CSS selector in `planning.html`

### Complex / Risky

- **Multi-file message protocol rename**: The message flow `getCyberPanelThemeSetting → cyberPanelThemeSetting` must be atomically renamed to `getCyberAnimationDisabledSetting → cyberAnimationDisabledSetting` across `setup.html`, `SetupPanelProvider.ts`, `TaskViewerProvider.ts`, and `postSetupPanelState()`. Missing any one link causes the toggle to silently not hydrate on panel open.
- **Removing the `cyberThemeSetting` send without breaking anything**: `PlanningPanelProvider._handleFetchRoots()` currently sends `cyberThemeSetting` (line 2009–2010). This must be replaced with `cyberAnimationSetting`. If only `planning.js` is updated but not `PlanningPanelProvider`, the send is dangling.

## Edge-Case & Dependency Audit

**Race Conditions**
- `postSetupPanelState()` in `TaskViewerProvider.ts` is called after `setCyberPanelThemeSetting` changes; the new `postSetupPanelState` must send `cyberAnimationDisabledSetting` instead. No race condition risk here — it's synchronous broadcast.

**Security**
- No security implications. Config keys are simple booleans.

**Side Effects**
- Removing the `cyberThemeSetting` message handler from `planning.js` means that any code elsewhere that posts `{ type: 'cyberThemeSetting' }` will silently do nothing. Grep confirms only `PlanningPanelProvider._handleFetchRoots()` (line 2009–2010) and the `onDidChangeConfiguration` listener (lines 294–296) send this message — both must be updated.
- Users with `theme.cyberPanel: false` in their VS Code config will get the cyber theme on by default after upgrade. This is intentional.

**Dependencies & Conflicts**
- `setup.html` references `#cyber-panel-theme-toggle` in 3 places: the HTML element (line 978), the `addEventListener` (line 3320), and the incoming message case (lines 3722–3727). All 3 must change.
- `TaskViewerProvider.postSetupPanelState()` broadcasts at line 3533–3536 — **this was missing from the original plan** and must be updated.
- `PlanningPanelProvider._handleFetchRoots()` at lines 2009–2010 — **also missing from the original plan** and must be updated.

## Dependencies

- None — self-contained UI and config change with no kanban plan dependencies.

## Adversarial Synthesis

Key risks: The message protocol rename spans 6 touch-points across 5 files; missing any one causes the toggle to silently not hydrate. The reduced-motion CSS selector in the original plan was mismatched (would suppress animation even when the toggle is off). The original plan also omitted two send-sites in `PlanningPanelProvider._handleFetchRoots()` and `TaskViewerProvider.postSetupPanelState()`. Mitigations: all 6 touch-points are now enumerated with line numbers; reduced-motion selector corrected; config key deprecated rather than deleted.

## Proposed Changes

### Configuration settings

#### [MODIFY] [package.json](file:///Users/patrickvuleta/Documents/GitHub/switchboard/package.json)

**Context**: Lines 505–509. The `theme.cyberPanel` entry is currently `default: false`. Must be deprecated (not removed) and a new `theme.disableCyberAnimation` entry added.

**Logic**:
- Add `"deprecationMessage"` to `switchboard.theme.cyberPanel` so VS Code shows a deprecation hint to any user who still has it set. Keep `default: false` so old workspaces don't break.
- Add the new config key immediately after it.

**Implementation**:
```json
// Replace lines 505-509 (the existing theme.cyberPanel block) with:
"switchboard.theme.cyberPanel": {
  "type": "boolean",
  "default": false,
  "description": "Deprecated. The Cyber Panel theme is now always active.",
  "deprecationMessage": "switchboard.theme.cyberPanel is deprecated. The Cyber Panel theme is now always on. Use switchboard.theme.disableCyberAnimation to disable the animated sweep beam."
},
"switchboard.theme.disableCyberAnimation": {
  "type": "boolean",
  "default": false,
  "description": "Disable the animated rolling CRT sweep beam in the Cyber Panel theme."
}
```

**Edge Cases**: The deprecated entry must remain in `package.json` (not deleted) to avoid VS Code surfacing "unknown configuration" warnings for existing users.

---

### Setup Panel Webview

#### [MODIFY] [setup.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html)

**Context**:
1. HTML element at line 978 — the existing `#cyber-panel-theme-toggle` checkbox.
2. HTML label text at lines 980–981.
3. Status div at line 984.
4. JS `addEventListener` at lines 3320–3329.
5. Incoming message case at lines 3722–3727.

**Logic**: Replace the "Enable Cyber Panel Theme" toggle with a "Disable Cyber Theme Animation" toggle. Update all 5 touch-points atomically.

**Implementation**:

*Touch-point 1 & 2 — Replace the HTML element and labels (lines 977–983):*
```html
<!-- Replace existing <label> at lines 977-983 -->
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="cyber-animation-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Disable Cyber Theme Animation</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Turn off the animated rolling CRT sweep beam in the planning panel preview.</span>
    </div>
</label>
```

*Touch-point 3 — Update status div id (line 984):*
```html
<div id="cyber-animation-status" style="min-height:14px; margin-top:6px; font-size:10px; color:var(--accent-teal); font-family:var(--font-mono);"></div>
```

*Touch-point 4 — Update JS listener (lines 3320–3329):*
```javascript
document.getElementById('cyber-animation-toggle')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setCyberAnimationDisabledSetting', enabled: e.target.checked });
    const statusEl = document.getElementById('cyber-animation-status');
    if (statusEl) {
        statusEl.textContent = 'Saved';
        setTimeout(() => {
            statusEl.textContent = '';
        }, 2000);
    }
});
```

*Touch-point 5 — Update incoming message case (lines 3722–3727):*
```javascript
case 'cyberAnimationDisabledSetting': {
    runSetupHydration(() => {
        const toggle = document.getElementById('cyber-animation-toggle');
        if (toggle) toggle.checked = message.enabled === true;
    });
    break;
}
```

#### [MODIFY] [SetupPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts)

**Context**: Lines 584–594. The `getCyberPanelThemeSetting` and `setCyberPanelThemeSetting` cases.

**Implementation**:
```typescript
// Replace lines 584-594:
case 'getCyberAnimationDisabledSetting':
    this._panel.webview.postMessage({
        type: 'cyberAnimationDisabledSetting',
        enabled: this._taskViewerProvider.handleGetCyberAnimationDisabledSetting()
    });
    break;
case 'setCyberAnimationDisabledSetting':
    await this._taskViewerProvider.handleSetCyberAnimationDisabledSetting(message.enabled);
    await this._taskViewerProvider.postSetupPanelState();
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
```

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

**Context**:
1. `handleGetCyberPanelThemeSetting()` at line 3151–3153.
2. `handleSetCyberPanelThemeSetting()` at lines 3155–3158.
3. `postSetupPanelState()` broadcast at lines 3533–3536 — **this was missing from the original plan**.

**Logic**: Rename methods and update config key. Update the `postSetupPanelState` broadcast.

**Implementation**:

*Touch-point 1 & 2 — Rename methods and key (lines 3151–3158):*
```typescript
// Replace handleGetCyberPanelThemeSetting and handleSetCyberPanelThemeSetting:
public handleGetCyberAnimationDisabledSetting(): boolean {
    return vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
}

public async handleSetCyberAnimationDisabledSetting(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('theme.disableCyberAnimation', enabled, vscode.ConfigurationTarget.Workspace);
}
```

*Touch-point 3 — Update `postSetupPanelState` broadcast (lines 3533–3536):*
```typescript
// Replace the cyberPanelThemeSetting broadcast:
this._setupPanelProvider.postMessage({
    type: 'cyberAnimationDisabledSetting',
    enabled: this.handleGetCyberAnimationDisabledSetting()
});
```

---

### Planning Panel Webview

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html)

**Context**:
1. `<body>` tag at line 1901 — add default class.
2. Existing `.cyber-scanlines` CSS block starting at line 1438 — add new animated sweep beam `::before` pseudo-element CSS after the existing block.

**Logic**: The body always gets `cyber-theme-enabled`. The new `::before` rule under `.cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines` creates the rolling sweep beam. When a user enables "Disable Cyber Theme Animation", `planning.js` adds `cyber-animation-disabled` to body, which suppresses the `:not(.cyber-animation-disabled)` condition.

**Implementation**:

*Touch-point 1 — Add class to body (line 1901):*
```html
<body class="cyber-theme-enabled">
```

*Touch-point 2 — Add animated sweep beam CSS after the existing `.cyber-scanlines` block (after line ~1451, before `.cyber-theme-enabled .cyber-scanlines { display: block; }`):*
```css
/* Animated CRT rolling sweep beam — only active when animation is not disabled */
.cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before {
    content: " ";
    display: block;
    position: absolute;
    background: linear-gradient(
        to bottom,
        rgba(255, 255, 255, 0) 0%,
        rgba(61, 219, 217, 0.03) 10%,
        rgba(61, 219, 217, 0.07) 50%,
        rgba(61, 219, 217, 0.03) 90%,
        rgba(255, 255, 255, 0) 100%
    );
    width: 100%;
    height: 80px;
    pointer-events: none;
    z-index: 6;
    animation: scanline-sweep 8s linear infinite;
}

@keyframes scanline-sweep {
    0% { transform: translateY(-80px); }
    100% { transform: translateY(100vh); }
}

/* Respect reduced-motion preference — suppress ONLY the sweep animation,
   not the static scanline texture. Selector matches the animated rule precisely. */
@media (prefers-reduced-motion: reduce) {
    .cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before {
        animation: none;
        display: none;
    }
}
```

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js)

**Context**: Lines 2032–2038. The existing `cyberThemeSetting` message handler.

**Logic**: Remove the old `cyberThemeSetting` handler (body now always has the class). Replace with `cyberAnimationSetting` handler that toggles `cyber-animation-disabled` on body.

**Implementation**:
```javascript
// Replace the cyberThemeSetting case (lines 2032-2038):
case 'cyberAnimationSetting': {
    document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
    break;
}
```

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)

**Context**:
1. `onDidChangeConfiguration` listener at lines 292–298 — watching `switchboard.theme.cyberPanel` and sending `cyberThemeSetting`.
2. `_handleFetchRoots()` at lines 2009–2010 — **this send-site was missing from the original plan** and also sends `cyberThemeSetting`.

**Logic**: Update both sites to use the new config key and new message type. The message now sends `disabled` (not `enabled`) to match the new semantics.

**Implementation**:

*Touch-point 1 — Update `onDidChangeConfiguration` listener (lines 292–298):*
```typescript
// Replace the cyberPanel watcher block:
this._disposables.push(
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('switchboard.theme.disableCyberAnimation')) {
            const disabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
            this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled });
        }
    })
);
```

*Touch-point 2 — Update `_handleFetchRoots()` (lines 2009–2010):*
```typescript
// Replace the cyberEnabled lines:
const cyberAnimationDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
```

## Verification Plan

### Automated Tests

- No automated tests to run per session directive.

### Manual Verification

- Verify that the Cyber theme is active by default on the Planning panel (no setting needed).
- Open the Setup tab → Artifacts Panel:
  - Confirm the "Enable Cyber Panel Theme" option is gone.
  - Confirm "Disable Cyber Theme Animation" checkbox is visible and unchecked by default.
- Check "Disable Cyber Theme Animation" → verify the sweep beam stops immediately in the planning panel.
- Uncheck → verify the sweep beam animation resumes.
- Open VS Code Settings UI and confirm `switchboard.theme.cyberPanel` shows a deprecation warning.
- Close and reopen the Planning panel → confirm `cyber-animation-disabled` state is correctly restored from persisted config.

---

**Send to Coder** (Complexity 3 — routine multi-file rename with clear line-number guidance)

---

## Reviewer Pass — 2026-06-04

### Review Outcome: APPROVED with one minor fix applied

All 6 planned touch-points verified in code. The implementation is functionally correct across the full message-protocol chain:

#### Files Changed
- `src/webview/setup.html` — `#cyber-panel-theme-toggle` fully removed; `#cyber-animation-toggle` + `#cyber-animation-status` + event listener + incoming message case all correct.
- `src/services/SetupPanelProvider.ts` — `getCyberAnimationDisabledSetting` / `setCyberAnimationDisabledSetting` cases implemented correctly. `postSetupPanelState()` called after save.
- `src/services/TaskViewerProvider.ts` — `handleGetCyberAnimationDisabledSetting()` / `handleSetCyberAnimationDisabledSetting()` correctly target `theme.disableCyberAnimation`. `postSetupPanelState()` broadcast sends `cyberAnimationDisabledSetting` with `enabled` field.
- `src/services/PlanningPanelProvider.ts` — `onDidChangeConfiguration` listener updated to `theme.disableCyberAnimation` → `cyberAnimationSetting` with `disabled` field. `_handleFetchRoots()` updated identically.
- `src/webview/planning.js` — Old `cyberThemeSetting` handler removed. New `cyberAnimationSetting` handler toggles `cyber-animation-disabled` class on body.
- `src/webview/planning.html` — `<body class="cyber-theme-enabled">` hardcoded. CRT sweep beam `::before` CSS + `@keyframes scanline-sweep` added. `prefers-reduced-motion` guard added. `.cyber-theme-enabled:not(.cyber-animation-disabled)` selector correctly suppresses beam when class is present.
- `package.json` — `switchboard.theme.cyberPanel` deprecated with `deprecationMessage`. `switchboard.theme.disableCyberAnimation` added with `default: false`.

#### Fix Applied in This Pass
- **NIT → Fixed**: `TaskViewerProvider.handleSetCyberAnimationDisabledSetting` parameter renamed from `enabled: boolean` to `disabled: boolean` to match the actual semantics of `theme.disableCyberAnimation`. Call site (`SetupPanelProvider.ts:591`) unaffected — passes boolean positionally.

#### Validation Results
- Static trace of all 18 touch-points: ✅ All consistent
- Zero remnant `cyberThemeSetting`, `cyberPanel`, or `#cyber-panel-theme-toggle` references in `src/`: ✅ Confirmed via grep
- `position: absolute` on `::before` contained within `position: absolute; inset: 0` `.cyber-scanlines`: ✅ Valid containing block
- Channel isolation (setup panel vs. planning panel) correctly uses distinct message types: ✅ Intentional and documented

#### Remaining Risks
- `translateY(100vh)` in `@keyframes scanline-sweep` uses viewport height, not container height. If the planning panel is significantly shorter than the viewport, the beam may appear to decelerate near the bottom edge relative to the container. Cosmetic only — no functional impact.
- The `postSetupPanelState()` call in `setCyberAnimationDisabledSetting` broadcasts to the Setup Panel only. If a user has the Planning Panel open while toggling the setting, the Planning Panel will also update via the `onDidChangeConfiguration` listener — so both are covered. ✅
