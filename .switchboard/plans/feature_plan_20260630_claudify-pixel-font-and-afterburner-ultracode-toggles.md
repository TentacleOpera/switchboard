# Claudify Pixel-Font Toggle & Afterburner Ultracode-Animation Toggle

## Metadata
**Complexity:** 6
**Tags:** frontend, ui, ux, feature

## Goal

Add two new theme options to the Theme tab in `setup.html`, each scoped to the theme it belongs to:

1. **Claudify → "Pixel font"** checkbox. **Default ON.** When ON, Claudify renders markdown **h1** headings in the `GeistPixel` pixel font (current behaviour). When OFF, h1 falls back to the same font used for **h2–h6** (Hanken Grotesk), exactly like the Afterburner theme renders headings.
2. **Afterburner → "Ultracode animation"** checkbox. **Default OFF.** Governs the giant animated "ULTRACODE" slam (the `#ultracode-blast`) that fires when the user toggles **Epic Ultracode** on in the kanban board.

### Problem / background / root-cause analysis

- **Pixel font is not user-controllable today.** Claudify hard-codes `GeistPixel` for markdown h1 across three webviews. Some users dislike the pixel aesthetic on h1 but otherwise want Claudify; there's no escape hatch.
  - **Key finding (scope):** the CSS var `--display-font: 'GeistPixel'` is declared on `:root` in `planning.html`, `design.html`, and `project.html`, and a comment in each Claudify block says it is "kept" — but `var(--display-font)` is **consumed zero times** anywhere in the webview source. It is dead. Therefore the **only** place Claudify actually applies the pixel font is the markdown **h1** rules. The toggle does not need to touch panel chrome, labels, or anything else — only h1. (This confirms the user's instinct that "h1 is the only Claudify use of the font.")
  - The pixel-font h1 rules live in exactly three files:
    - `src/webview/planning.html:2366` — `body.theme-claudify #markdown-preview h1, #markdown-preview-tickets h1`
    - `src/webview/design.html:2333` — `body.theme-claudify #markdown-preview-briefs h1, #markdown-preview-design h1`
    - `src/webview/project.html:827` — `body.theme-claudify #constitution-preview-content h1, #system-preview-content h1, #tuning-preview-content h1`
  - In each file the matching **h2–h6** rule (the fallback target) sets: `font-family: var(--font-family); letter-spacing: normal; font-stretch: 100%; color: #D97757;`. "Pixel font OFF" means making h1 adopt those three typographic properties (keeping the terracotta `#D97757` colour, which it already has).

- **The ultracode blast currently fires by default, with no dedicated control.** `fireUltracodeBlast()` (`src/webview/kanban.html:4293`) runs whenever Epic Ultracode is toggled on, gated only by `cyber-theme-enabled` AND NOT `cyber-animation-disabled`. So on Afterburner with animations enabled (the default), the obnoxious full-screen slam fires every time — users have asked for it to be opt-in. Root cause: the blast was tied to the generic "cyber animation" flag instead of having its own switch. The fix decouples it into its own setting, defaulting OFF.

- **Persistence bug (in scope):** the existing theme toggles (`theme.disableCyberAnimation`, `theme.disableCyberScanlines`, `theme.colourKanbanIcons`) are written to `ConfigurationTarget.Workspace` (`src/services/TaskViewerProvider.ts:4143/4152/4161`), so they do **not** persist globally across projects — contradicting the expectation that theme preferences are user-wide. The two new settings will be written to **Global**, and the three existing theme toggles will be migrated to Global as well (see Phase 5).

## Proposed Settings

| Setting | Type | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `switchboard.theme.pixelFont` | boolean | `true` | Claudify renders markdown h1 in GeistPixel when true; Hanken (matching h2–h6) when false. |
| `switchboard.theme.ultracodeAnimation` | boolean | `false` | Afterburner fires the full-screen ULTRACODE blast on Epic Ultracode toggle-on when true. |

Naming note: the two existing animation flags use a negative `disable*` convention (default `false`). Because these two new options have *opposite* default polarities (pixel font default ON, ultracode default OFF), positive names (`pixelFont`, `ultracodeAnimation`) are clearer than forcing them into the `disable*` mould. The body-class layer absorbs the polarity difference.

## Body-class strategy (mirrors `cyber-animation-disabled`)

First-paint body classes are injected by `getThemeBodyClass()` in `src/services/themeBodyClass.ts`, so panels never flash the wrong state.

- **Pixel font** (default ON): add class **`claudify-pixel-font-disabled`** to the Claudify body **only when the setting is false**. Default state = no class = pixel font shows (zero change to existing default rendering).
- **Ultracode** (default OFF): add class **`ultracode-animation-enabled`** to the Afterburner body **only when the setting is true**. Default state = no class = blast suppressed.

## Implementation Plan

### Phase 1 — Register settings (`package.json`)
1. Add `switchboard.theme.pixelFont` (boolean, default `true`) with description: "Claudify only: render document H1 headings in the pixel display font. Turn off to render H1 in the body font like H2–H6."
2. Add `switchboard.theme.ultracodeAnimation` (boolean, default `false`) with description: "Afterburner only: play the full-screen ULTRACODE animation when Epic Ultracode is switched on in the kanban board."
   - Place both next to the existing `theme.disableCyberAnimation` / `theme.colourKanbanIcons` entries for discoverability.

### Phase 2 — First-paint body class (`src/services/themeBodyClass.ts`)
3. In `getThemeBodyClass()`:
   - Afterburner branch: read `theme.ultracodeAnimation` (default `false`); append `' ultracode-animation-enabled'` when true.
   - Claudify branch: read `theme.pixelFont` (default `true`); append `' claudify-pixel-font-disabled'` when false.
4. Keep the resolution logic simple (`cfg.get(..., default)`); no per-theme-default helper like `getEffectiveColourKanbanIcons` is needed since these defaults are static booleans.

### Phase 3 — CSS overrides (the three webviews)
For each of the three files, add a Claudify "pixel font off" override immediately after the existing h1 pixel rule, neutralising the three typographic properties so h1 matches h2–h6 (colour stays terracotta):

```css
body.theme-claudify.claudify-pixel-font-disabled <h1 selectors for this file> {
    font-family: var(--font-family);
    letter-spacing: normal;
    font-stretch: 100%;
}
```
5. `src/webview/planning.html` (after line 2373) — selectors `#markdown-preview h1, #markdown-preview-tickets h1`.
6. `src/webview/design.html` (after line 2340) — selectors `#markdown-preview-briefs h1, #markdown-preview-design h1`.
7. `src/webview/project.html` (after line 830) — selectors `#constitution-preview-content h1, #system-preview-content h1, #tuning-preview-content h1`.
   - Do NOT introduce pixel font on h1 selectors that don't currently have it (e.g. `#kanban-preview-pane h1`, `#markdown-preview-online h1`) — leave existing scope unchanged.

### Phase 4 — Ultracode gate (`src/webview/kanban.html`)
8. In `fireUltracodeBlast()` (line 4293), add an early-return guard: only fire when `document.body.classList.contains('ultracode-animation-enabled')`. Keep the existing `cyber-theme-enabled` and `cyber-animation-disabled` guards (Afterburner-only, respects the master animation kill-switch). Net effect: blast fires only on Afterburner, animations not globally disabled, AND ultracode animation explicitly enabled.

### Phase 5 — setup.html UI + persistence wiring
9. **Pixel font checkbox** — add a Claudify-only section (mirror the existing `#theme-colour-icons-settings` block, which is the established Claudify-only pattern). New section id e.g. `#theme-pixel-font-settings`, checkbox id `pixel-font-toggle`, label "Pixel-font H1 headings" + helper text "Render document H1 headings in the pixel display font. Turn off to match H2–H6 (like Afterburner)."
10. **Ultracode checkbox** — add inside the existing Afterburner-only `#theme-animation-settings` block (`setup.html:1242`), beneath the scanlines row. Checkbox id `ultracode-animation-toggle`, label "Ultracode animation" + helper "Play the full-screen ULTRACODE slam when Epic Ultracode is switched on."
11. **Visibility:** extend the `updateAnimationSectionVisibility(theme)` logic (`setup.html:1755`) — or add a sibling helper — to show `#theme-pixel-font-settings` only for `claudify` and `#theme-animation-settings` only for `afterburner` (already done for the latter). Confirm the colour-icons section's show/hide is the template to copy.
12. **Change handlers + load:** wire each checkbox's `change` listener to `postMessage` a set-message, and immediately toggle the live body class on `document.body` (so the preview updates without reload, matching the cyber-animation handler at `setup.html:3937`). On load, request current values and reflect them into the checkboxes (mirror the `cyberAnimationDisabledSetting` / `colourKanbanIconsSetting` request+reflect flow).

### Phase 6 — Provider message handlers + live broadcast
13. **Setter/getter handlers** — add to the provider that owns the Setup panel's `theme.*` toggles (`src/services/TaskViewerProvider.ts`, alongside lines 4142–4161). Add `get`/`set` for both new settings. **Write to `ConfigurationTarget.Global`.**
14. **Migrate existing toggles to Global (the persistence bug):** change `TaskViewerProvider.ts:4143/4152/4161` from `ConfigurationTarget.Workspace` to `Global`.
    - **Migration nuance (published extension, ~4k installs):** reads via `inspect()` prefer `workspaceValue` over `globalValue`. Users who already toggled these wrote a workspace value; if we only switch *writes* to Global, the stale workspace value will shadow the new global one and the toggle will appear stuck. To avoid this, when writing each of these settings, also **clear the workspace value** (`config.update(key, undefined, ConfigurationTarget.Workspace)`) in the same handler. This makes Global authoritative going forward without destroying the user's intended on/off choice (we write their new choice to Global first).
15. **Live propagation to open panels:** add `affectsConfiguration` listeners (mirror `PlanningPanelProvider.ts:393–400` and `KanbanProvider.ts:358`) for `switchboard.theme.pixelFont` and `switchboard.theme.ultracodeAnimation`, posting a message that makes each open webview toggle the corresponding body class live. Kanban is the panel that matters for ultracode; planning/design/project (+ kanban preview) matter for pixel font. Reuse the existing per-panel theme-message handlers; add the new class-toggle cases there.

### Phase 7 — Verification
16. Build via `npm run compile` only if producing a VSIX; otherwise test from `src/` per CLAUDE.md (testing is via installed VSIX, `dist/` is not authoritative).
17. Manual checks:
    - Claudify, pixel font ON (default): h1 is pixel font. Toggle OFF: h1 becomes Hanken, still terracotta, matches h2–h6; verify in planning, design, and project (constitution/system/tuning) previews. Toggle back ON live without reload.
    - Afterburner, ultracode OFF (default): toggling Epic Ultracode on in kanban does **not** fire the blast. Toggle the setting ON: blast fires on Epic Ultracode toggle-on. Confirm it still respects "disable cyber animation".
    - First-paint: set each option, reload the window — no flash of the wrong state (body class injected at HTML-gen time).
    - Persistence: set both in one workspace, open a different workspace — values carry over (Global). Confirm previously-set workspace values for the three migrated toggles don't shadow new changes.
    - Theme switch: pixel-font section hidden on Afterburner; ultracode/animation section hidden on Claudify.

## Risks / Edge Cases
- **No confirmation dialogs** anywhere (CLAUDE.md hard rule) — these are plain checkboxes, fine.
- **Dead `--display-font` var:** leave it in place (out of scope); removing it is a separate cleanup. The toggle deliberately targets the real h1 rules, not the var.
- **Migration shadowing** for the three existing toggles — handled by clearing the workspace value on write (Phase 6, step 14). This is the only behaviour-changing piece for existing installs; a no-op for users who never touched the toggles.
- **Class-name collisions:** `claudify-pixel-font-disabled` and `ultracode-animation-enabled` are new; grep confirms no existing usage.
- Keep client-side theme-class handlers in sync with `themeBodyClass.ts` (the file's own NOTE warns about this) — Phase 6 step 15 covers each open panel.

## Files Touched
- `package.json` — two new settings.
- `src/services/themeBodyClass.ts` — first-paint classes.
- `src/services/TaskViewerProvider.ts` — get/set handlers, Global persistence, migrate existing toggles.
- `src/services/PlanningPanelProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/DesignPanelProvider.ts` — live `affectsConfiguration` broadcast + message handling (as applicable per panel).
- `src/webview/setup.html` — two checkboxes, visibility, change handlers, load reflection.
- `src/webview/planning.html`, `src/webview/design.html`, `src/webview/project.html` — pixel-font-off CSS overrides.
- `src/webview/kanban.html` — `fireUltracodeBlast()` gate.
