# Hide the "Enable Animation" Toggle for Non-Afterburner Themes in Setup

## Goal

In `setup.html` the Theme selector shows the **Enable Artifacts panel animation** option for every theme. That animation (the CRT sweep beam) is Afterburner-only, so the checkbox must be hidden whenever the selected theme is not `afterburner`.

### Problem Analysis

The Theme tab contains an Animation section ([setup.html:1156-1168](src/webview/setup.html#L1156)):

```html
<div id="theme-animation-settings">
  <div class="subsection-header"><span>Animation</span></div>
  <label class="startup-row" ...>
    <input id="cyber-animation-toggle" type="checkbox" ...>
    <span ...>Enable Artifacts panel animation</span>
    <span ...>Show the animated rolling CRT sweep beam in the planning panel preview.</span>
  </label>
  <div id="cyber-animation-status" ...></div>
</div>
```

It is always visible. The animation only exists for the Afterburner theme; under Claudify (or any future theme) the toggle is meaningless but still shown.

The theme is known in the webview via `currentSwitchboardTheme` (declared at [setup.html:1623](src/webview/setup.html#L1623)) and the radio group `input[name="theme-selection"]`. Theme changes fire on radio `change` ([setup.html:3743-3748](src/webview/setup.html#L3743)) and inbound `switchboardThemeNameSetting` / `switchboardThemeChanged` ([setup.html:4018-4030](src/webview/setup.html#L4018)).

### Root Cause

The `#theme-animation-settings` block has no visibility binding to the selected theme; it is rendered unconditionally.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux

## User Review Required

No — this is a pure visibility toggle with no data-model, persistence, or migration impact. The persisted `disableCyberAnimation` setting is untouched; only the control's visibility changes.

## Complexity Audit

### Routine
- Toggling one container's `display` based on the resolved theme at three trigger points: initial tab open, radio change, and inbound theme message.
- Single-file change (`src/webview/setup.html`).
- Reuses the existing `currentSwitchboardTheme` variable and existing theme entry-point handlers — no new state, no new message types.

### Complex / Risky
- Must cover all entry points so the toggle can never get "stuck" visible/hidden — especially after the theme-persistence fix sends the real theme on load.
- None beyond the above entry-point coverage concern.

## Edge-Case & Dependency Audit

- **Race Conditions:** If the theme arrives after the Theme tab is first rendered, the visibility update must run inside the `switchboardThemeNameSetting` handler too — not only on tab open. The helper's `if (section)` guard makes early calls safe no-ops if the DOM isn't built yet; message handlers only fire after the webview's listener is registered (post-DOM), so this is safe in practice.
- **Security:** None.
- **Side Effects:** Hiding the section does not change the persisted `disableCyberAnimation` setting; it only hides the control. That is correct — the setting is irrelevant under non-Afterburner themes. If a user enabled animation under Afterburner, switched to Claudify (section hidden), then switched back, the checkbox reappears in its persisted state — correct round-trip behavior.
- **Dependencies & Conflicts:** Depends on `currentSwitchboardTheme` being accurate on load, which is guaranteed once the theme-persistence fix (see Dependencies below) is applied. Implement after (or together with) that change.

## Dependencies

- `feature_plan_20260622120005_setup-theme-selection-persistence.md` — Setup Theme Selection Persistence. Ensures `currentSwitchboardTheme` is hydrated from the real persisted theme on webview load via the inbound `switchboardThemeNameSetting` message, so the tab-open visibility call resolves the correct theme.

## Adversarial Synthesis

Key risks: (1) stale line citations could mislead the implementer — fixed to current file state; (2) the helper's `|| 'afterburner'` fallback could flash the section visible on Claudify loads if called before the theme is known — safe in practice because all three call sites have a concrete theme value by the time they fire, but documented as an assumption; (3) missing entry-point coverage would leave the toggle stuck. Mitigations: all three trigger points are wired, the `if (section)` guard handles early calls, and a round-trip verification step confirms persisted checkbox state survives a theme switch cycle.

## Proposed Changes

### 1. `src/webview/setup.html` — add a helper and call it at all theme entry points

Add a helper near the theme logic (e.g. just after the `currentSwitchboardTheme` declaration at [setup.html:1623](src/webview/setup.html#L1623)):
```js
// Fallback to 'afterburner' is safe: all call sites pass a concrete theme
// value, and currentSwitchboardTheme is hydrated from the inbound
// switchboardThemeNameSetting message before the Theme tab is opened.
function updateAnimationSectionVisibility(theme) {
    const t = theme || currentSwitchboardTheme || 'afterburner';
    const section = document.getElementById('theme-animation-settings');
    if (section) section.style.display = (t === 'afterburner') ? '' : 'none';
}
```

Call it at three trigger points:

- In the `'theme'` section open handler ([setup.html:1712-1717](src/webview/setup.html#L1712)) after setting the radio:
  ```js
  'theme': () => {
      vscode.postMessage({ type: 'getCyberAnimationDisabledSetting' });
      const savedTheme = currentSwitchboardTheme || 'afterburner';
      const themeRadio = document.querySelector(`input[name="theme-selection"][value="${savedTheme}"]`);
      if (themeRadio) themeRadio.checked = true;
      updateAnimationSectionVisibility(savedTheme);   // NEW
  },
  ```
- In the theme radio `change` listener ([setup.html:3743-3748](src/webview/setup.html#L3743)):
  ```js
  document.querySelectorAll('input[name="theme-selection"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
          currentSwitchboardTheme = e.target.value;
          vscode.postMessage({ type: 'setThemeSetting', theme: e.target.value });
          updateAnimationSectionVisibility(e.target.value);   // NEW
      });
  });
  ```
- In the `switchboardThemeNameSetting` / `switchboardThemeChanged` handler ([setup.html:4018-4030](src/webview/setup.html#L4018)) after `currentSwitchboardTheme = theme`:
  ```js
  case 'switchboardThemeNameSetting':
  case 'switchboardThemeChanged': {
      const theme = message.theme || 'afterburner';
      currentSwitchboardTheme = theme;
      const themeRadio = document.querySelector(`input[name="theme-selection"][value="${theme}"]`);
      if (themeRadio) themeRadio.checked = true;
      document.body.classList.remove('theme-claudify');
      if (theme !== 'afterburner') {
          document.body.classList.add(`theme-${theme}`);
      }
      updateAnimationSectionVisibility(theme);   // NEW
      break;
  }
  ```

## Verification Plan

### Automated Tests
None — this is a pure DOM visibility toggle with no unit-test harness coverage in the webview layer. Verification is manual.

### Manual Verification
1. With Claudify saved as the active theme, open Setup → Theme → confirm the Animation section is **hidden** on load (validates the inbound-message + tab-open path exercises the helper).
2. Select Afterburner → confirm the Animation section appears immediately (validates the radio-change path).
3. Select Claudify → confirm the Animation section hides immediately.
4. Enable the animation checkbox under Afterburner, switch to Claudify, switch back to Afterburner → confirm the checkbox reappears in its persisted (checked) state (validates round-trip persistence).
5. With Afterburner saved, close and reopen Setup → Theme → confirm the Animation section shows on load.

## Recommendation

Complexity 2 → **Send to Intern**.
