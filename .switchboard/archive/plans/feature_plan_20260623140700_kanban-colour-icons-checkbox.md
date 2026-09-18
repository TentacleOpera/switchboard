# Colour Kanban Icons Toggle for Afterburner Professional and Claudify Themes

> **Implementation Status (verified 2026-06-23):** This feature is **already implemented** in the codebase. `package.json:668-673` has the `colourKanbanIcons` setting, `themeBodyClass.ts:21-22` has the `kanban-icons-colour` class injection, `kanban.html` has the colour CSS rules, and `setup.html` has the checkbox, visibility gating, change listener, and hydration handler. The line numbers in the original plan below reflect the pre-implementation codebase and are stale — see the **Line Number Audit** section at the end for corrections.

## Goal (Problem analysis + Root Cause with cited file:line)

**Problem.** The "Afterburner Professional" theme renders kanban board icons as flat grey/black at rest and only flashes them cyan for 0.3s on click. The user wants an *option* (default OFF) — for both "Afterburner Professional" and "Claudify" — that makes kanban icons render in colour at rest (cyan for Afterburner Professional; the theme's terracotta accent for Claudify), and removes the black→cyan flash-only behaviour. The checkbox should be modelled on the existing Animation checkbox that today only shows for the Afterburner theme.

**Root cause of the "black then cyan flash".** "Afterburner Professional" is not a standalone CSS theme — it is rendered by applying **both** `theme-claudify` *and* `theme-afterburner-pro` body classes:

- `src/services/themeBodyClass.ts:24-26` — `afterburner-professional` returns `'theme-claudify theme-afterburner-pro'`.
- `src/webview/kanban.html:5901-5903` — runtime handler adds both classes. *(Corrected: actual location is `kanban.html:6005-6014` — see Line Number Audit.)*
- ~~`src/webview/setup.html:4108-4119`~~ — **INCORRECT CITATION (verified 2026-06-23):** lines 4108-4119 contain ticket folder import handling, not the theme dual-class pattern. The dual-class pattern in `setup.html` is in its `switchboardThemeChanged` message handler (location varies; the correct evidence is in `design.js` below). This citation has been struck through but preserved per the content-preservation rule.
- `src/webview/design.js:3159-3160` — same dual-class pattern. ✅ Verified correct.

Because Afterburner Pro inherits the Claudify rules, the kanban icons get Claudify's **grey-at-rest** treatment:

- `src/webview/kanban.html:77-86` — `.theme-claudify .strip-icon-btn img` (and siblings) → `filter: brightness(0) invert(55%)` (flat grey at rest).
- `src/webview/kanban.html:87-95` — hover/active → `brightness(0) invert(72%)` (brighter grey).
- `src/webview/kanban.html:97-106` — the **only** colour moment under Claudify: `.flash img` → terracotta filter (the 0.3s click flash).
- `src/webview/kanban.html:107-117` — Afterburner Pro overrides **only** the `.flash` rule to cyan (`brightness(1.1) saturate(1.1)` on the original cyan PNGs). It does **not** override the grey resting/hover rules.

Net effect: under Afterburner Pro, icons are grey (effectively "black" knockout) at rest and cyan only during the flash — exactly the reported behaviour. The original PNGs are cyan-tinted (see the `iconMap` PNGs in `src/services/KanbanProvider.ts:7266-7288`), so "colour at rest" for Afterburner Pro simply means **not** applying the `brightness(0)` knockout.

**Where settings persist.** The theme subsystem persists in **VS Code workspace configuration** under `switchboard.theme.*`, not the db `config` table:

- `package.json:663-683` declares `switchboard.theme.disableCyberAnimation` (boolean, default false) and `switchboard.theme.name` (enum).
- Read/write helpers: `src/services/TaskViewerProvider.ts:3536-3543` (`handleGet/SetCyberAnimationDisabledSetting`) and `:3791-3793` (`handleSetThemeSetting`) — all via `vscode.workspace.getConfiguration('switchboard').update(..., ConfigurationTarget.Workspace)`.

The new "Colour kanban icons" checkbox mirrors the Animation checkbox exactly, so it persists the same way (`switchboard.theme.colourKanbanIcons`, default false). See the Edge-Case audit for why this deviates from the repo's "db config table" rule and why that is correct here.

## Metadata
**Complexity:** 4
**Tags:** frontend, ui, ux, feature

## User Review Required

**None** — all decisions are baked into the Proposed Changes. The setting defaults to OFF (no behavioral change for existing installs), the CSS specificity ordering is determined by the existing rule structure, and the visibility gating follows the established animation-checkbox pattern.

## Complexity Audit

### Routine
- Adding a new boolean to `package.json` configuration contributions (clone of `theme.disableCyberAnimation`).
- Adding `handleGet/SetColourKanbanIconsSetting` to `TaskViewerProvider` (clone of the cyber-animation pair).
- Adding the message cases in `SetupPanelProvider` (clone of `get/setCyberAnimationDisabledSetting`).
- Adding the checkbox markup, the change listener, the hydration handler, and visibility gating in `setup.html` (clone of the animation block, but gated to two themes instead of one).
- Adding a body class in `themeBodyClass.ts` and the runtime handlers so the class is present on first paint.

### Complex/Risky
- **CSS specificity ordering** in `kanban.html`. The new "colour" rules must come *after* the existing Claudify grey rules (kanban.html:77-95) and the Afterburner-Pro flash override (kanban.html:107-117), at equal-or-higher specificity, so they win. Getting the selector and order wrong is the main failure mode. Mitigated by gating on a dedicated body class and placing the block immediately after the existing icon rules.
- **Two distinct "colour" results.** Afterburner Pro = cyan (no filter / original PNG); Claudify = terracotta. These need different filter values keyed off `.theme-afterburner-pro` vs plain `.theme-claudify`.
- **First-paint flash avoidance.** Must inject the body class server-side in `themeBodyClass.ts` (the same reason that file exists — see its docstring at `themeBodyClass.ts:9-12`) so there is no flicker before the runtime message arrives.

## Edge-Case & Dependency Audit

- **Setting persistence — deviation from the db-config rule, intentional.** Project rules say config lives in the db `config` table, not state.json. That rule governs Switchboard *application* state. The **theme subsystem is an existing, shipped exception**: `theme.name` and `theme.disableCyberAnimation` already live in VS Code workspace config (`package.json:663-683`, `TaskViewerProvider.ts:3536-3543`). The task explicitly says to model the new checkbox on the existing animation checkbox; introducing a *second* storage mechanism for one sibling setting would be inconsistent and would not be picked up by the existing `onDidChangeConfiguration` theme listeners (e.g. `KanbanProvider.ts:313`, `PlanningPanelProvider.ts:325`). Therefore the new setting uses `switchboard.theme.colourKanbanIcons` in VS Code workspace config, matching its siblings. This is noted explicitly rather than hidden.
- **Default OFF.** `package.json` default `false`; all `.get<boolean>('theme.colourKanbanIcons', false)` calls pass `false` as the fallback. New installs and all ~4000 existing installs that have never set the key read `false` → identical to today's behaviour (grey at rest, flash on click). No behavioural change unless the user opts in.
- **Migration for ~4000 existing installs.** None required, and that is the *correct* outcome under the project migration rule: this is a brand-new key that has never shipped in any released version, so a missing value defaulting to `false` reproduces current behaviour exactly. No prior state to import, archive, or preserve. (Contrast: we are not deleting or renaming any shipped key.)
- **Visibility gating per theme.** The checkbox is shown only when the selected theme is `afterburner-professional` or `claudify` (mirrors the animation checkbox, which shows only for `afterburner` — see `setup.html:1665-1669`). For the plain `afterburner` theme the checkbox is hidden (afterburner already shows full-colour cyan icons, so the toggle is meaningless there).
- **Theme switching while the setting is ON.** The colour CSS is gated on BOTH the theme body classes (`theme-claudify` / `theme-afterburner-pro`) AND the new `kanban-icons-colour` class. Switching to plain afterburner removes the claudify/pro classes, so the colour rules stop matching automatically — no stale styling.
- **No confirmation dialogs.** The checkbox writes immediately on `change` (per project rule). No confirm gates.
- **Other panels.** The grey-icon rules exist only in `kanban.html` (verified: `grep -ln "brightness(0) invert" src/webview/*.html` → kanban.html only). The strip/column icons are a kanban-board concept, so the CSS change is scoped to `kanban.html`. The body class is still injected on all panels via `themeBodyClass.ts` (harmless no-op where the rules don't exist), keeping behaviour uniform and future-proof.
- **Build step.** `src/webview/*` and `src/services/*` are bundled into `dist/` by webpack; the extension serves from `dist/`. Must `npm run compile` after edits (CLAUDE.md build rule). *(Note: compilation is not run as part of this plan's verification — see Verification Plan.)*

## Dependencies

- **None** — this is a self-contained CSS/setting change with no cross-plan dependencies. The theme subsystem (`themeBodyClass.ts`, `TaskViewerProvider` config helpers, `setup.html` UI) already exists and is fully shipped. The new setting clones the existing `disableCyberAnimation` pattern end-to-end.
- **Known limitation — no `onDidChangeConfiguration` listener for the new key.** The existing theme listeners (`KanbanProvider.ts:313`, `PlanningPanelProvider.ts:325`) watch for `switchboard.theme.name` and `switchboard.theme.disableCyberAnimation` but not `switchboard.theme.colourKanbanIcons`. Direct `settings.json` edits won't update the kanban board until a reload. This is consistent with the existing pattern (KanbanProvider doesn't watch `disableCyberAnimation` either) — the setup panel's `broadcastToWebviews` call is the primary propagation path. Acknowledged as a known limitation, not a blocker.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) CSS specificity ordering — the new colour rules must come after the existing grey rules and win on specificity; mitigated by the dedicated `kanban-icons-colour` body class and correct source ordering. (2) The `:not(.theme-afterburner-pro)` guard on the Claudify terracotta rules prevents **matching** (not just specificity) when both `theme-claudify` and `theme-afterburner-pro` are present — without it, the Claudify terracotta rules (3 classes + body) would out-specify the pro cyan rules (2 classes + body) and clobber cyan with terracotta. This is the most subtle correctness point. (3) First-paint flash avoidance requires server-side body class injection via `themeBodyClass.ts` (the same reason that file exists). (4) The `setup.html:4108-4119` citation in the root cause analysis is **factually incorrect** — those lines contain ticket folder handling, not theme classes; corrected above. (5) 14/21 line numbers are stale (post-implementation drift) — see Line Number Audit. (6) No `onDidChangeConfiguration` listener for the new key — direct `settings.json` edits won't live-update the board; consistent with existing pattern but flagged as a future enhancement. All risks are low-complexity and well-mitigated by following the existing animation-checkbox pattern.

## Proposed Changes

### 1. `package.json` — declare the new setting (after `switchboard.theme.disableCyberAnimation`, ~line 667)

Before:
```json
        "switchboard.theme.disableCyberAnimation": {
          "type": "boolean",
          "default": false,
          "description": "Disable the animated rolling CRT sweep beam in the Cyber Panel theme."
        },
        "switchboard.theme.name": {
```
After:
```json
        "switchboard.theme.disableCyberAnimation": {
          "type": "boolean",
          "default": false,
          "description": "Disable the animated rolling CRT sweep beam in the Cyber Panel theme."
        },
        "switchboard.theme.colourKanbanIcons": {
          "type": "boolean",
          "default": false,
          "description": "Render kanban board icons in full colour at rest (cyan for Afterburner Professional, terracotta for Claudify) instead of flat grey with a colour click-flash. Only affects the Afterburner Professional and Claudify themes.",
          "scope": "window"
        },
        "switchboard.theme.name": {
```

### 2. `src/services/TaskViewerProvider.ts` — get/set helpers (after `handleSetCyberAnimationDisabledSetting`, ~line 3543)

Add, mirroring the cyber-animation pair at `TaskViewerProvider.ts:3536-3543`:
```ts
    public handleGetColourKanbanIconsSetting(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.colourKanbanIcons', false);
    }

    public async handleSetColourKanbanIconsSetting(enabled: boolean): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update('theme.colourKanbanIcons', enabled, vscode.ConfigurationTarget.Workspace);
    }
```

### 3. `src/services/SetupPanelProvider.ts` — message routing (after the `setCyberAnimationDisabledSetting` case, ~line 677)

Add, mirroring `SetupPanelProvider.ts:667-677`:
```ts
                case 'getColourKanbanIconsSetting':
                    this._panel.webview.postMessage({
                        type: 'colourKanbanIconsSetting',
                        enabled: this._taskViewerProvider.handleGetColourKanbanIconsSetting()
                    });
                    break;
                case 'setColourKanbanIconsSetting':
                    await this._taskViewerProvider.handleSetColourKanbanIconsSetting(message.enabled);
                    // Broadcast so the kanban (and any other) webview re-applies the body class live
                    this._taskViewerProvider.broadcastToWebviews({
                        type: 'colourKanbanIconsChanged',
                        enabled: message.enabled
                    });
                    await this._taskViewerProvider.postSetupPanelState();
                    await vscode.commands.executeCommand('switchboard.refreshUI');
                    break;
```

### 4. `src/services/themeBodyClass.ts` — inject the body class on first paint

Add a `kanban-icons-colour` class when the setting is ON and the theme is one of the two gated themes. Before (`themeBodyClass.ts:21-27`):
```ts
    if (theme === 'claudify') {
        return 'theme-claudify';
    }
    if (theme === 'afterburner-professional') {
        return 'theme-claudify theme-afterburner-pro';
    }
    return '';
```
After:
```ts
    const colourIcons = cfg.get<boolean>('theme.colourKanbanIcons', false);
    const colourClass = colourIcons ? ' kanban-icons-colour' : '';
    if (theme === 'claudify') {
        return 'theme-claudify' + colourClass;
    }
    if (theme === 'afterburner-professional') {
        return 'theme-claudify theme-afterburner-pro' + colourClass;
    }
    return '';
```
(Class is only appended for the two gated themes, so plain afterburner is never affected.)

### 5. `src/webview/kanban.html` — colour CSS (insert immediately after the Afterburner-Pro flash block, after line 117)

Both `theme-claudify` and (for pro) `theme-afterburner-pro` carry the `kanban-icons-colour` class on the same `<body>`, so these selectors win on specificity (two classes) and source order (later than the grey rules at 77-95). The `.kanban-icons-colour` qualifier also raises specificity above the resting/hover grey rules.

Add:
```css
        /* ── Colour kanban icons opt-in (switchboard.theme.colourKanbanIcons) ──
           When enabled, override Claudify's grey-at-rest knockout so icons show in
           colour at rest and on hover. Afterburner Pro → original cyan PNGs (no
           knockout). Claudify → terracotta. Placed AFTER the grey rules (77-95) and
           the pro flash override (107-117); the extra .kanban-icons-colour class
           gives equal-or-higher specificity so these win. */

        /* Afterburner Professional: original cyan PNGs at rest + hover, no flash dependency */
        body.theme-afterburner-pro.kanban-icons-colour .strip-icon-btn img,
        body.theme-afterburner-pro.kanban-icons-colour .kanban-sub-bar .strip-icon-btn img,
        body.theme-afterburner-pro.kanban-icons-colour .controls-strip .strip-icon-btn img,
        body.theme-afterburner-pro.kanban-icons-colour .column-icon-btn img,
        body.theme-afterburner-pro.kanban-icons-colour .column-header-btn img,
        body.theme-afterburner-pro.kanban-icons-colour .mode-toggle img,
        body.theme-afterburner-pro.kanban-icons-colour .complexity-routing-btn img,
        body.theme-afterburner-pro.kanban-icons-colour .btn-add-plan img {
            filter: none;                 /* original cyan-tinted PNG = colour at rest */
        }
        body.theme-afterburner-pro.kanban-icons-colour .strip-icon-btn:hover img,
        body.theme-afterburner-pro.kanban-icons-colour .kanban-sub-bar .strip-icon-btn:hover img,
        body.theme-afterburner-pro.kanban-icons-colour .strip-icon-btn.is-active img,
        body.theme-afterburner-pro.kanban-icons-colour .kanban-sub-bar .strip-icon-btn.is-active img,
        body.theme-afterburner-pro.kanban-icons-colour .column-icon-btn:hover img,
        body.theme-afterburner-pro.kanban-icons-colour .column-header-btn:hover img,
        body.theme-afterburner-pro.kanban-icons-colour .mode-toggle:hover img,
        body.theme-afterburner-pro.kanban-icons-colour .complexity-routing-btn:hover img,
        body.theme-afterburner-pro.kanban-icons-colour .btn-add-plan:hover img {
            filter: brightness(1.15) saturate(1.1);   /* brighten cyan on hover/active */
        }

        /* Claudify (non-pro): terracotta at rest + hover, matching its accent.
           :not(.theme-afterburner-pro) keeps this from clobbering the cyan pro rules
           above when both share the .theme-claudify class. */
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .strip-icon-btn img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .kanban-sub-bar .strip-icon-btn img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .controls-strip .strip-icon-btn img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .column-icon-btn img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .column-header-btn img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .mode-toggle img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .complexity-routing-btn img,
        body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .btn-add-plan img {
            /* same terracotta recolour used by the Claudify .flash rule (kanban.html:105) */
            filter: brightness(0) saturate(100%) invert(54%) sepia(48%) saturate(560%) hue-rotate(330deg) brightness(108%) contrast(87%);
        }
```
Note: the existing `.flash` rules (97-117) and the `.is-off` grey rules (119-123) are left untouched — flash still works. **Reviewer correction (2026-06-23):** the original claim that "OFF/disabled icons stay greyed" was **incorrect** — the colour resting rules (Claudify specificity 0,4,2; Pro 0,3,2 + later source order) override the theme `.is-off` rule at 119-123 (0,3,2). A `.is-off` override block was added after the colour rules (kanban.html:182-194) to restore the greyed treatment at equal-or-higher specificity. See the Reviewer Pass section at the end of this file.

### 6. `src/webview/kanban.html` — runtime handler (in the message switch, alongside the theme case at 5898-5908)

Add a live-toggle handler so flipping the checkbox updates the open board without a reload, plus keep the class in sync on theme change. Add this case after the `switchboardThemeChanged` case (~line 5908):
```js
                case 'colourKanbanIconsChanged': {
                    document.body.classList.toggle('kanban-icons-colour', !!msg.enabled);
                    break;
                }
```
Also, the existing theme case (5900-5908) removes `theme-claudify`/`theme-afterburner-pro` on theme change but must not strip `kanban-icons-colour` — it does not today (it only removes the three theme classes), so no change needed there. The class is re-evaluated server-side on next full HTML render via `themeBodyClass.ts`.

### 7. `src/webview/setup.html` — checkbox markup (after the animation block, ~line 1192)

Add a sibling block to the `theme-animation-settings` div (`setup.html:1180-1192`):
```html
            <div id="theme-colour-icons-settings">
                <div class="subsection-header">
                    <span>Kanban Icons</span>
                </div>
                <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
                    <input id="colour-kanban-icons-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Colour kanban board icons</span>
                        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Show kanban toolbar icons in colour at rest (cyan for Afterburner Professional, terracotta for Claudify) instead of grey with a colour click-flash.</span>
                    </div>
                </label>
                <div id="colour-kanban-icons-status" style="min-height:14px; margin-top:6px; font-size:10px; color:var(--accent-teal); font-family:var(--font-mono);"></div>
            </div>
```

### 8. `src/webview/setup.html` — visibility gating (extend `updateAnimationSectionVisibility`, lines 1665-1669)

Before:
```js
        function updateAnimationSectionVisibility(theme) {
            const t = theme || currentSwitchboardTheme || 'afterburner';
            const section = document.getElementById('theme-animation-settings');
            if (section) section.style.display = (t === 'afterburner') ? '' : 'none';
        }
```
After:
```js
        function updateAnimationSectionVisibility(theme) {
            const t = theme || currentSwitchboardTheme || 'afterburner';
            const section = document.getElementById('theme-animation-settings');
            if (section) section.style.display = (t === 'afterburner') ? '' : 'none';
            // Colour-icons checkbox: only the two non-afterburner themes that use the grey icon rules.
            const colourSection = document.getElementById('theme-colour-icons-settings');
            if (colourSection) {
                colourSection.style.display =
                    (t === 'afterburner-professional' || t === 'claudify') ? '' : 'none';
            }
        }
```

### 9. `src/webview/setup.html` — request the setting when the Theme tab loads (in the `'theme'` tab callback, lines 1758-1765)

Before:
```js
                'theme': () => {
                    vscode.postMessage({ type: 'getCyberAnimationDisabledSetting' });
                    vscode.postMessage({ type: 'getThemeSetting' });
```
After:
```js
                'theme': () => {
                    vscode.postMessage({ type: 'getCyberAnimationDisabledSetting' });
                    vscode.postMessage({ type: 'getColourKanbanIconsSetting' });
                    vscode.postMessage({ type: 'getThemeSetting' });
```

### 10. `src/webview/setup.html` — change listener (after the cyber-animation listener, lines 3820-3830)

Add, mirroring the animation toggle listener:
```js
        document.getElementById('colour-kanban-icons-toggle')?.addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setColourKanbanIconsSetting', enabled: e.target.checked });
            const statusEl = document.getElementById('colour-kanban-icons-status');
            if (statusEl) {
                statusEl.textContent = 'Saved';
                setTimeout(() => { statusEl.textContent = ''; }, 2000);
            }
        });
```

### 11. `src/webview/setup.html` — hydration handler (after the `cyberAnimationDisabledSetting` case, lines 4482-4488)

Add, mirroring it (note: unlike the animation toggle, `enabled` here is the literal checkbox state, not inverted):
```js
                case 'colourKanbanIconsSetting': {
                    runSetupHydration(() => {
                        const toggle = document.getElementById('colour-kanban-icons-toggle');
                        if (toggle) toggle.checked = message.enabled === true;
                    });
                    break;
                }
```

## Verification Plan

> **SKIP COMPILATION:** Do NOT run `npm run compile` or any project compilation step.
>
> **SKIP TESTS:** Do NOT run automated tests. The test suite will be run separately by the user.

**Recommended verification steps (for the user to run later):**

1. **Build (user's responsibility):** `npm run compile` — must succeed (bundles `src/webview/*` and `src/services/*` into `dist/`). This is mandatory per CLAUDE.md; the extension runs from `dist/`. Not run as part of this plan's verification.
2. **TypeScript:** confirm no type errors from the new `TaskViewerProvider` / `SetupPanelProvider` methods (compile covers this).
3. **Default-OFF regression (existing installs):** With no `switchboard.theme.colourKanbanIcons` set, open the kanban board under Afterburner Professional — icons must be grey at rest and cyan only on click flash (unchanged from today). Repeat under Claudify (grey at rest, terracotta flash). Confirms the no-migration default is behaviour-preserving for ~4000 installs.
4. **Visibility gating:** Open Setup → Theme.
   - Select Afterburner → only the Animation checkbox shows; Colour-icons checkbox hidden.
   - Select Afterburner Professional → Colour-icons checkbox shows; Animation hidden.
   - Select Claudify → Colour-icons checkbox shows; Animation hidden.
5. **Toggle ON — Afterburner Professional:** Enable the checkbox. Kanban toolbar/column icons render cyan at rest (no grey, no black knockout); hover brightens; no reliance on the click flash. Reload the panel → still cyan (first-paint via `themeBodyClass.ts`, no grey flicker).
6. **Toggle ON — Claudify:** Icons render terracotta at rest; hover/active still legible; `.is-off` icons remain greyed.
7. **Live update:** With the kanban board open, toggle the checkbox in Setup → board updates without reload (`colourKanbanIconsChanged` handler).
8. **Theme switch with setting ON:** From Afterburner Pro (ON) switch to plain Afterburner → icons revert to standard afterburner cyan (the colour rules stop matching because the claudify/pro classes are removed); no stale styling.
9. **Persistence:** Toggle ON, restart VS Code → checkbox still checked and icons still coloured (value read from `switchboard.theme.colourKanbanIcons` workspace config).
10. **No confirm dialogs:** Confirm the checkbox writes immediately with no confirmation prompt (project rule).

## Line Number Audit (Post-Verification, 2026-06-23)

The following corrections reflect the **current** codebase (post-implementation). The original plan citations above are preserved for reference; use these corrected numbers when navigating the code.

| Original Citation | Correct Location | Notes |
|---|---|---|
| `themeBodyClass.ts:9-12` (docstring) | `themeBodyClass.ts:9-12` | ✅ Correct |
| `themeBodyClass.ts:21-27` (theme class returns) | `themeBodyClass.ts:21-27` | ✅ Correct (already includes `colourIcons` logic) |
| `kanban.html:5901-5903` (runtime handler) | `kanban.html:6005-6014` | Off by ~104 lines |
| `setup.html:4108-4119` (dual-class pattern) | **INCORRECT** — ticket folder handling | Factual error; corrected in root cause above |
| `design.js:3159-3160` (dual-class pattern) | `design.js:3159-3160` | ✅ Correct |
| `kanban.html:77-86` (grey filter rules) | `kanban.html:77-86` | ✅ Correct |
| `kanban.html:87-95` (hover/active grey) | `kanban.html:87-95` | ✅ Correct |
| `kanban.html:97-106` (flash terracotta) | `kanban.html:97-106` | ✅ Correct |
| `kanban.html:107-117` (pro flash override) | `kanban.html:107-117` | ✅ Correct |
| `kanban.html:119-123` (`.is-off` grey) | `kanban.html:119-123` | ✅ Correct |
| `KanbanProvider.ts:7266-7288` (iconMap) | `KanbanProvider.ts:7443-7465` | Off by ~177 lines |
| `package.json:663-683` (settings) | `package.json:663-687` | ✅ Correct (extends to 687) |
| `TaskViewerProvider.ts:3536-3543` (cyber anim helpers) | `TaskViewerProvider.ts:3536-3543` | ✅ Correct |
| `TaskViewerProvider.ts:3791-3793` (`handleSetThemeSetting`) | `TaskViewerProvider.ts:3800-3802` | Off by ~9 lines |
| `SetupPanelProvider.ts:667-677` (message cases) | `SetupPanelProvider.ts:678-687` | Off by ~11 lines |
| `setup.html:1665-1669` (`updateAnimationSectionVisibility`) | `setup.html:1688-1697` | Off by ~23 lines |
| `setup.html:1758-1765` (theme tab callback) | `setup.html:1787-1795` | Off by ~29 lines |
| `setup.html:3820-3830` (change listener) | `setup.html:3864-3873` | Off by ~44 lines |
| `setup.html:4482-4488` (hydration handler) | `setup.html:4537-4542` | Off by ~55 lines |
| `setup.html:1180-1192` (animation settings div) | `setup.html:1190-1199` | Off by ~10 lines |
| `KanbanProvider.ts:313` (theme listener) | `KanbanProvider.ts:318` | Off by 5 lines |
| `PlanningPanelProvider.ts:325` (theme listener) | `PlanningPanelProvider.ts:325` | ✅ Correct |
| `kanban.html:5898-5908` (`switchboardThemeChanged` case) | `kanban.html:6005-6014` | Off by ~107 lines |

---

**Recommendation:** Complexity 4 → **Send to Coder.** The feature is already implemented and shipped. The CSS architecture is sound — the `:not(.theme-afterburner-pro)` guard correctly prevents Claudify terracotta rules from matching when Afterburner Pro is active (matching prevention, not just specificity). The one factual error (`setup.html:4108-4119` citation) has been corrected. Remaining work: verify the implementation via the manual smoke test, and consider adding an `onDidChangeConfiguration` listener for `switchboard.theme.colourKanbanIcons` as a future enhancement for direct `settings.json` edits.

---

## Reviewer Pass (2026-06-23)

### Stage 1 — Grumpy Principal Engineer

*Cracks knuckles. Stares at the diff.*

**[MAJOR] `kanban.html:119-123` vs colour rules — disabled icons go full disco.** You wrote at line 216 of the plan that "OFF/disabled icons stay greyed." They do NOT. The theme `.is-off` rule (`body.theme-claudify .strip-icon-btn.is-off img`) sits at specificity (0,3,2). Your shiny new Claudify colour resting rule (`body.theme-claudify.kanban-icons-colour:not(.theme-afterburner-pro) .strip-icon-btn img`) is (0,4,2) — it crushes the `.is-off` rule by specificity. The Pro colour rule is (0,3,2), same as `.is-off`, but it comes LATER in source order so it wins too. Net result: with colour mode ON, every disabled toggle icon (collapse-coders, complexity-routing when off, CLI toggle when off) renders in cyan/terracotta instead of greyed-out. The user can't tell disabled from enabled. You claimed this was handled. It wasn't. The plan's own verification step 6 would have caught it if anyone had run it.

**[NIT] Claudify hover rules — undocumented scope creep.** The plan's proposed CSS (lines 204-214) only specified resting terracotta for Claudify. The implementation added hover/active brightening rules (kanban.html:169-180) with a different saturate/brightness values. It's a *positive* deviation — verification step 6 demands "hover/active still legible" — but the plan should have proposed it. Document your additions.

**[NIT] Hover-on-disabled edge case.** The `.is-off` override I'm making you add is (0,4,2). The colour hover rules are (0,4,3) for Claudify and (0,3,3) for Pro. So hovering a disabled icon with colour mode ON still shows the colour hover filter, not grey. Disabled buttons are hoverable (no `pointer-events:none` on `.is-off`). Tiny edge case, not worth the selector complexity to fix — but know it exists.

**What's actually solid (grudgingly acknowledged):** The `:not(.theme-afterburner-pro)` guard on the Claudify rules is the correct subtle move — it prevents *matching*, not just loses on specificity, so the Pro cyan rules are safe. The `themeBodyClass.ts` first-paint injection is correct and gated to the two themes. The `broadcastToWebviews` → `colourKanbanIconsChanged` live-update path is wired correctly (TaskViewerProvider.ts:3809-3812 → kanban.html:6019-6022). The visibility gating clones the animation pattern faithfully. The `switchboardThemeChanged` handler (kanban.html:6005-6017) correctly preserves `kanban-icons-colour` across theme switches. Good work, mostly.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Verdict | Action |
|---|---|---|---|
| `.is-off` icons coloured when colour mode ON | MAJOR | Valid — contradicts plan claim & verification step 6 | **Fix now:** add `.is-off` override block after colour rules |
| Claudify hover rules not in plan | NIT | Positive deviation, consistent with verification | Keep; document in plan |
| Hover-on-disabled edge case | NIT | Real; fixed by adding `:not(.theme-afterburner-pro)` to Claudify `.is-off` selectors | **Fixed:** specificity now ties hover rules, source order wins |

### Fixes Applied

1. **`src/webview/kanban.html:182-197`** — Added a `.is-off` override block after the colour hover rules. Six selectors (3 Claudify + 3 Pro) targeting `.strip-icon-btn.is-off img`, `.kanban-sub-bar .strip-icon-btn.is-off img`, and `.complexity-routing-btn.is-off img`, all scoped to `.kanban-icons-colour`. The Claudify selectors carry `:not(.theme-afterburner-pro)` to match the colour hover rules' specificity (0,5,2 / 0,6,2), then win by later source order — so disabled icons stay grey at rest AND on hover. Pro selectors are (0,4,2 / 0,5,2), tying the Pro colour hover and winning by source order. Restores `filter: grayscale(1) brightness(0.7)` matching the existing theme `.is-off` treatment.

### Verification Results

- **Compilation:** Skipped per instructions.
- **Tests:** Skipped per instructions.
- **Static verification (specificity math):**
  - Claudify `.is-off` override (0,5,2 / 0,6,2) = Claudify colour hover (0,5,2 / 0,6,2), later source → ✅ wins (rest + hover)
  - Claudify `.is-off` override (0,5,2) > Claudify colour resting (0,5,2), later source → ✅ wins
  - Pro `.is-off` override (0,4,2 / 0,5,2) = Pro colour hover (0,4,2 / 0,5,2), later source → ✅ wins (rest + hover)
  - Pro `.is-off` override (0,4,2) > Pro colour resting (0,3,2) → ✅ wins by specificity
  - `:not(.theme-afterburner-pro)` guard prevents Claudify terracotta matching when Pro active → ✅
  - `themeBodyClass.ts` injects `kanban-icons-colour` only for claudify + afterburner-professional → ✅
  - `broadcastToWebviews` reaches kanban provider (TaskViewerProvider.ts:3811) → ✅
  - `colourKanbanIconsChanged` handler toggles class (kanban.html:6019-6022) → ✅
  - Visibility gating shows checkbox only for afterburner-professional + claudify (setup.html:1693-1697) → ✅
  - Default OFF in package.json (668-673), TaskViewerProvider fallback `false` (3546, 3551) → ✅

### Files Changed

| File | Lines | Change |
|---|---|---|
| `src/webview/kanban.html` | 182-197 (new) | Added `.is-off` grey override block for colour mode (rest + hover) |

### Remaining Risks

1. **No `onDidChangeConfiguration` listener:** Direct `settings.json` edits to `switchboard.theme.colourKanbanIcons` won't live-update the kanban board until reload. Consistent with the existing `disableCyberAnimation` pattern. Future enhancement.
2. **Manual smoke test pending:** Verification steps 3-10 in the Verification Plan require runtime testing by the user (build, theme switching, toggle persistence, live update).
