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

---

## Reviewer Pass (2026-06-22)

### Stage 1 — Grumpy Principal Engineer

> *Cracks knuckles.* Right, let's see who's been playing fast and loose with my Theme tab.
>
> **[NIT — stale plan, not stale code]** The plan swears up and down there are exactly two themes — Afterburner and the dreaded Claudify — and that hiding "whenever theme is not `afterburner`" is the whole job. Cute. Except the actual radio group at `setup.html:1167-1177` ships **three** themes: `afterburner`, `claudify`, AND `afterburner-professional`. The plan author never laid eyes on the third option. If the implementer had blindly copy-pasted the plan's `theme === 'afterburner'` early-return logic *without* checking the real markup, I'd still be fine — but only by dumb luck. Show me you understood *why* it's fine, not that you guessed.
>
> **[CRITICAL — prove the third theme doesn't have the beam]** "Afterburner *Professional*." The name screams "I am an Afterburner, I have the glorious CRT sweep beam." If that's true, your `t === 'afterburner'` check just *hid a meaningful toggle* from Professional users — a regression dressed up as a feature. Where is the proof the sweep beam doesn't render under Professional? Don't wave your hands.
>
> **[NIT — flash of unhidden content]** Default `currentSwitchboardTheme = 'afterburner'` (`:1663`) plus a section with no inline `display:none` means on a Claudify load the Animation block is *visible* until the inbound message lands. The plan calls this "safe in practice." I call it a flicker. Document it or eat it.
>
> **[NIT — double-fire]** The `'theme'` tab handler calls the helper with `savedTheme` AND fires `getThemeSetting`, which round-trips and calls the helper *again* via `switchboardThemeNameSetting`. Two calls. Harmless, idempotent — but say it out loud so the next person doesn't "optimize" one away and break the cold-open path.

### Stage 2 — Balanced Synthesis

**Keep:**
- The helper `updateAnimationSectionVisibility` (`setup.html:1665-1669`) with its `if (section)` guard — clean, idempotent, early-call-safe. Matches the plan exactly.
- All three trigger points are wired and verified: tab-open handler (`:1764`), radio `change` (`:3836`), and `switchboardThemeNameSetting`/`switchboardThemeChanged` (`:4123`).
- The strict `t === 'afterburner'` equality (not a `!== 'claudify'` denylist). This is the *correct* shape and is what makes the third theme work for free.

**Resolved during review (the CRITICAL):**
- The CRT sweep beam is gated entirely on the `cyber-theme-enabled` body class. That class is added **only** for `afterburner` (`implementation.html:2454`, `setup.html:4117`). `afterburner-professional` applies `theme-claudify` + `theme-afterburner-pro` and **never** adds `cyber-theme-enabled` (`setup.html:4120-4121`, `implementation.html:2457-2458`). Therefore Professional has no sweep beam, and hiding its toggle is correct, not a regression. The strict-equality implementation handles all three themes correctly. **No code change required.**

**Defer / accept as documented:**
- The brief flash-of-visible on Claudify cold loads is pre-existing, cosmetic, and already acknowledged in the plan's Adversarial Synthesis. Not worth a synchronous render-blocking fix.
- The intentional double-call on tab open is benign (idempotent helper). No change.

### Fixes Applied
None. The implementation is complete and correct as written; the only CRITICAL surfaced (Professional regression) was disproven by tracing the `cyber-theme-enabled` gating, not by a code defect.

### Files Changed (by implementation, verified this pass)
- `src/webview/setup.html`
  - `:1665-1669` — `updateAnimationSectionVisibility` helper added.
  - `:1764` — called in `'theme'` tab-open handler.
  - `:3836` — called in theme radio `change` listener.
  - `:4123` — called in `switchboardThemeNameSetting` / `switchboardThemeChanged` handler.

### Validation Results
- Compilation: **skipped** per session directive.
- Automated tests: **skipped** per session directive (and none exist for this DOM-only path, per plan).
- Static verification (this pass): all three entry points confirmed present and calling the helper; helper logic confirmed correct against the three-theme radio set; sweep-beam gating traced to `cyber-theme-enabled`, confirmed exclusive to `afterburner`. Manual verification steps 1-5 in the plan remain the acceptance gate.

### Remaining Risks
- **Future theme additions:** any new theme that *does* ship the CRT sweep beam must add `cyber-theme-enabled` (so the toggle re-appears) — the visibility helper keys on the theme name `=== 'afterburner'`, so a new sweep-bearing theme would need the helper's condition widened too. Low likelihood, easy to spot.
- **Flash-of-visible** on non-Afterburner cold loads — cosmetic only, pre-existing, accepted.
