# Claudify Pixel-Font Toggle & Afterburner Ultracode-Animation Toggle

**Plan ID:** 7227540d-9707-4ddf-919a-ff6b47c2ee5a

## Metadata
**Complexity:** 6
**Tags:** frontend, ui, ux, feature

## Goal

Add two new theme options to the Theme tab in `setup.html`, each scoped to the theme it belongs to:

1. **Claudify → "Pixel font"** checkbox. **Default ON.** When ON, Claudify renders markdown **h1** headings in the `GeistPixel` pixel font (current behaviour). When OFF, h1 falls back to the same font used for **h2–h6** (Hanken Grotesk), exactly like the Afterburner theme renders headings.
2. **Afterburner → "Ultracode animation"** checkbox. **Default OFF.** Governs the giant animated "ULTRACODE" slam (the `#ultracode-blast`) that fires when the user toggles **Epic Ultracode** on in the kanban board.

### Problem / background / root-cause analysis

- **Pixel font is not user-controllable today.** Claudify hard-codes `GeistPixel` for markdown h1 across three webviews. Some users dislike the pixel aesthetic on h1 but otherwise want Claudify; there's no escape hatch.
  - **Key finding (scope):** the CSS var `--display-font: 'GeistPixel'` is declared on `:root` in `planning.html` (line 53), `design.html` (line 54), and `project.html` (line 42), and a comment in each Claudify block says it is "kept" — but `var(--display-font)` is **consumed zero times** anywhere in the webview source (grep confirmed). It is dead. Therefore the **only** place Claudify actually applies the pixel font is the markdown **h1** rules. The toggle does not need to touch panel chrome, labels, or anything else — only h1. (This confirms the user's instinct that "h1 is the only Claudify use of the font.")
  - The pixel-font h1 rules live in exactly three files (line numbers verified against current source):
    - `src/webview/planning.html:2382–2388` — `body.theme-claudify #markdown-preview h1, body.theme-claudify #markdown-preview-tickets h1` (2 selectors)
    - `src/webview/design.html:2340–2346` — `body.theme-claudify #markdown-preview-briefs h1, body.theme-claudify #markdown-preview-design h1` (2 selectors)
    - `src/webview/project.html:853–863` — **6 selectors**: `body.theme-claudify #kanban-preview-content h1, body.theme-claudify #epics-preview-content h1, body.theme-claudify #constitution-preview-content h1, body.theme-claudify #system-preview-content h1, body.theme-claudify #tuning-preview-content h1, body.theme-claudify #projects-preview-content h1`
  - In each file the matching **h2–h6** rule (the fallback target) sets: `font-family: var(--font-family); letter-spacing: normal; font-stretch: 100%; color: #D97757;`. "Pixel font OFF" means making h1 adopt those three typographic properties (keeping the terracotta `#D97757` colour, which it already has).
  - **⚠️ Critical:** the project.html h1 rule has **6 selectors**, not 3 as originally assumed. The CSS override MUST cover all 6 selectors, or kanban/epics/projects previews will keep the pixel font when the user toggles it off.

- **The ultracode blast currently fires by default, with no dedicated control.** `fireUltracodeBlast()` (`src/webview/kanban.html:4305–4317`) runs whenever Epic Ultracode is toggled on, gated only by `cyber-theme-enabled` (line 4306) AND NOT `cyber-animation-disabled` (line 4307). So on Afterburner with animations enabled (the default), the obnoxious full-screen slam fires every time — users have asked for it to be opt-in. Root cause: the blast was tied to the generic "cyber animation" flag instead of having its own switch. The fix decouples it into its own setting, defaulting OFF.

- **Persistence bug (in scope):** the existing theme toggles (`theme.disableCyberAnimation`, `theme.disableCyberScanlines`, `theme.colourKanbanIcons`) are written to `ConfigurationTarget.Workspace` (`src/services/TaskViewerProvider.ts:4144–4164`), so they do **not** persist globally across projects — contradicting the expectation that theme preferences are user-wide. The two new settings will be written to **Global**, and the three existing theme toggles will be migrated to Global as well (see Phase 6).

## User Review Required

No review gate required. These are additive theme settings with no data migration risk beyond the Workspace→Global toggle migration (which preserves user intent). The persistence bug fix is a behaviour change for existing installs but is handled by the workspace-value-clearing mitigation in Phase 6.

## Complexity Audit

### Routine
- Add two boolean settings to `package.json` (mirrors existing `theme.disableCyberAnimation` pattern).
- Add two CSS override rules (copy-paste of h2–h6 properties onto h1 selectors with a new body class).
- Add two checkboxes to `setup.html` Theme tab (mirror existing `#theme-colour-icons-settings` block).
- Add early-return guard to `fireUltracodeBlast()` (one line).
- Wire checkbox change handlers + load reflection (mirror existing cyber-animation handler).

### Complex / Risky
- **project.html selector coverage:** the h1 rule has 6 selectors, not 3. The override must cover all 6 or half the previews will ignore the toggle.
- **Multiple `affectsConfiguration` listener blocks:** PlanningPanelProvider has 3 separate listener blocks (lines 396, 581, 708); DesignPanelProvider has 2 (lines 170, 268). Each must receive the new `pixelFont` listener or some panels won't update live.
- **KanbanProvider has no animation listener:** only listens to `theme.name` (line 370). The `ultracodeAnimation` listener must be built from scratch, not extended from an existing pattern.
- **Workspace→Global migration:** changing write target for 3 existing settings on a published extension with ~4k installs. Stale workspace values must be cleared on write to avoid shadowing.

## Edge-Case & Dependency Audit

- **Race Conditions:** First-paint body classes are injected at HTML generation time by `getThemeBodyClass()`, so there is no flash-of-wrong-state race. Live toggling via `affectsConfiguration` is fire-and-forget — no ordering dependency between panels.
- **Security:** No security implications. Settings are local boolean preferences.
- **Side Effects:** The Workspace→Global migration changes where 3 existing settings are stored. Users who set these in one workspace will see their setting preserved (workspace value still readable) but future changes go Global. Clearing the workspace value on write ensures Global becomes authoritative without losing the user's current choice.
- **Dependencies & Conflicts:** The `--display-font` CSS var is dead (declared but never consumed). Leave it in place — removing it is out of scope. The new class names `claudify-pixel-font-disabled` and `ultracode-animation-enabled` are confirmed non-existent in the codebase (grep verified). No conflicts with existing theme classes.

## Dependencies

None. This plan is self-contained — it adds new settings and CSS overrides without depending on other plans or in-flight work.

## Proposed Settings

| Setting | Type | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `switchboard.theme.pixelFont` | boolean | `true` | Claudify renders markdown h1 in GeistPixel when true; Hanken (matching h2–h6) when false. |
| `switchboard.theme.ultracodeAnimation` | boolean | `false` | Afterburner fires the full-screen ULTRACODE blast on Epic Ultracode toggle-on when true. |

Naming note: the two existing animation flags use a negative `disable*` convention (default `false`). Because these two new options have *opposite* default polarities (pixel font default ON, ultracode default OFF), positive names (`pixelFont`, `ultracodeAnimation`) are clearer than forcing them into the `disable*` mould. The body-class layer absorbs the polarity difference.

## Body-class strategy (mirrors `cyber-animation-disabled`)

First-paint body classes are injected by `getThemeBodyClass()` in `src/services/themeBodyClass.ts` (line 43), so panels never flash the wrong state.

- **Pixel font** (default ON): add class **`claudify-pixel-font-disabled`** to the Claudify body **only when the setting is false**. Default state = no class = pixel font shows (zero change to existing default rendering).
- **Ultracode** (default OFF): add class **`ultracode-animation-enabled`** to the Afterburner body **only when the setting is true**. Default state = no class = blast suppressed.

## Implementation Plan

### Phase 1 — Register settings (`package.json`)
1. Add `switchboard.theme.pixelFont` (boolean, default `true`) with description: "Claudify only: render document H1 headings in the pixel display font. Turn off to render H1 in the body font like H2–H6."
2. Add `switchboard.theme.ultracodeAnimation` (boolean, default `false`) with description: "Afterburner only: play the full-screen ULTRACODE animation when Epic Ultracode is switched on in the kanban board."
   - Place both next to the existing `theme.disableCyberAnimation` (line 680) / `theme.colourKanbanIcons` (line 691) entries for discoverability.

### Phase 2 — First-paint body class (`src/services/themeBodyClass.ts`)
3. In `getThemeBodyClass()` (line 43):
   - Afterburner branch (lines 46–50): read `theme.ultracodeAnimation` (default `false`); append `' ultracode-animation-enabled'` when true.
   - Claudify branch (lines 53–55): read `theme.pixelFont` (default `true`); append `' claudify-pixel-font-disabled'` when false.
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

5. `src/webview/planning.html` — insert after line 2388 (after the h1 pixel rule). Selectors: `#markdown-preview h1, #markdown-preview-tickets h1` (2 selectors, matching the existing rule).
6. `src/webview/design.html` — insert after line 2346 (after the h1 pixel rule). Selectors: `#markdown-preview-briefs h1, #markdown-preview-design h1` (2 selectors, matching the existing rule).
7. `src/webview/project.html` — insert after line 863 (after the h1 pixel rule). **⚠️ All 6 selectors must be included:** `#kanban-preview-content h1, #epics-preview-content h1, #constitution-preview-content h1, #system-preview-content h1, #tuning-preview-content h1, #projects-preview-content h1`. Omitting any of the 6 will leave pixel font active on those previews when the user toggles it off.
   - Do NOT introduce pixel font on h1 selectors that don't currently have it (e.g. `#kanban-preview-pane h1`, `#markdown-preview-online h1`) — leave existing scope unchanged.

### Phase 4 — Ultracode gate (`src/webview/kanban.html`)
8. In `fireUltracodeBlast()` (line 4305), add an early-return guard after the existing two guards (lines 4306–4307): only fire when `document.body.classList.contains('ultracode-animation-enabled')`. Keep the existing `cyber-theme-enabled` and `cyber-animation-disabled` guards (Afterburner-only, respects the master animation kill-switch). Net effect: blast fires only on Afterburner, animations not globally disabled, AND ultracode animation explicitly enabled.

### Phase 5 — setup.html UI + persistence wiring
9. **Pixel font checkbox** — add a Claudify-only section (mirror the existing `#theme-colour-icons-settings` block at lines 1241–1253, which is the established Claudify-only pattern). New section id e.g. `#theme-pixel-font-settings`, checkbox id `pixel-font-toggle`, label "Pixel-font H1 headings" + helper text "Render document H1 headings in the pixel display font. Turn off to match H2–H6 (like Afterburner)."
10. **Ultracode checkbox** — add inside the existing Afterburner-only `#theme-animation-settings` block (`setup.html:1221–1240`), beneath the scanlines row. Checkbox id `ultracode-animation-toggle`, label "Ultracode animation" + helper "Play the full-screen ULTRACODE slam when Epic Ultracode is switched on."
11. **Visibility:** extend the `updateAnimationSectionVisibility(theme)` logic (`setup.html:1727–1736`) — add a line to show `#theme-pixel-font-settings` only for `claudify` (mirroring the colour-icons show/hide at line 1733). The `#theme-animation-settings` show/hide for `afterburner` is already done (line 1730).
12. **Change handlers + load:** wire each checkbox's `change` listener to `postMessage` a set-message, and immediately toggle the live body class on `document.body` (so the preview updates without reload, matching the cyber-animation handler at `setup.html:3908–3913`). On load, request current values and reflect them into the checkboxes (mirror the `cyberAnimationDisabledSetting` / `colourKanbanIconsSetting` request+reflect flow).

### Phase 6 — Provider message handlers + live broadcast
13. **Setter/getter handlers** — add to the provider that owns the Setup panel's `theme.*` toggles (`src/services/TaskViewerProvider.ts`, alongside lines 4144–4164). Add `get`/`set` for both new settings. **Write to `ConfigurationTarget.Global`.**
14. **Migrate existing toggles to Global (the persistence bug):** change `TaskViewerProvider.ts:4144/4153/4162` from `ConfigurationTarget.Workspace` to `Global`.
    - **Migration nuance (published extension, ~4k installs):** reads via `inspect()` prefer `workspaceValue` over `globalValue`. Users who already toggled these wrote a workspace value; if we only switch *writes* to Global, the stale workspace value will shadow the new global one and the toggle will appear stuck. To avoid this, when writing each of these settings, also **clear the workspace value** (`config.update(key, undefined, ConfigurationTarget.Workspace)`) in the same handler. This makes Global authoritative going forward without destroying the user's intended on/off choice (we write their new choice to Global first).
15. **Live propagation to open panels — primary: TaskViewerProvider broadcast.** `TaskViewerProvider` (line 493) already has an `onDidChangeConfiguration` listener that broadcasts to ALL webviews via `broadcastToWebviews()`. Add `affectsConfiguration` checks for `switchboard.theme.pixelFont` and `switchboard.theme.ultracodeAnimation` here, broadcasting a message (e.g. `{ type: 'pixelFontSetting', enabled: bool }` and `{ type: 'ultracodeAnimationSetting', enabled: bool }`) to all panels. This is the primary propagation mechanism — it covers every open panel in one shot.
16. **Live propagation — per-panel listeners (supplement the broadcast):** `TaskViewerProvider.broadcastToWebviews()` reaches all panels, but PlanningPanelProvider and DesignPanelProvider have their own `onDidChangeConfiguration` blocks for panels they manage directly. Add `pixelFont` listeners to:
    - **PlanningPanelProvider** — all 3 blocks: lines 396–407, 581–593, 708–720. Each posts to `this._panel` or `this._projectPanel`.
    - **DesignPanelProvider** — both blocks: lines 170–182, 268–278. Each posts to `this._panel`.
    - **KanbanProvider** — line 369–372: this block currently only listens to `theme.name`. Add `affectsConfiguration('switchboard.theme.ultracodeAnimation')` check from scratch (there is no existing animation listener to mirror — build new). Post `{ type: 'ultracodeAnimationSetting', enabled: bool }` to `this._panel`.
17. **Client-side message handlers:** in each webview's message handler, add cases for `pixelFontSetting` and `ultracodeAnimationSetting` that toggle the corresponding body class (`claudify-pixel-font-disabled` / `ultracode-animation-enabled`) on `document.body`. Reuse the existing theme-message handler pattern.

### Phase 7 — Verification
18. Build via `npm run compile` only if producing a VSIX; otherwise test from `src/` per CLAUDE.md (testing is via installed VSIX, `dist/` is not authoritative). **Skip compilation for this session** — the project is in a pre-compiled state.
19. Manual checks:
    - Claudify, pixel font ON (default): h1 is pixel font. Toggle OFF: h1 becomes Hanken, still terracotta, matches h2–h6; verify in planning, design, and project (**all 6 preview panes**: kanban, epics, constitution, system, tuning, projects). Toggle back ON live without reload.
    - Afterburner, ultracode OFF (default): toggling Epic Ultracode on in kanban does **not** fire the blast. Toggle the setting ON: blast fires on Epic Ultracode toggle-on. Confirm it still respects "disable cyber animation".
    - First-paint: set each option, reload the window — no flash of the wrong state (body class injected at HTML-gen time).
    - Persistence: set both in one workspace, open a different workspace — values carry over (Global). Confirm previously-set workspace values for the three migrated toggles don't shadow new changes.
    - Theme switch: pixel-font section hidden on Afterburner; ultracode/animation section hidden on Claudify.

## Adversarial Synthesis

Key risks: (1) project.html h1 rule has 6 selectors, not 3 — the CSS override must cover all 6 or half the previews will ignore the toggle; (2) KanbanProvider has no existing animation listener — the ultracode listener must be built from scratch; (3) PlanningPanelProvider has 3 separate listener blocks and DesignPanelProvider has 2 — all must receive the pixelFont listener or some panels won't update live. Mitigations: use TaskViewerProvider's `broadcastToWebviews()` as the primary propagation mechanism (covers all panels in one shot), supplement with per-provider listeners for completeness, and explicitly enumerate all 6 project.html selectors in the CSS override.

## Risks / Edge Cases
- **No confirmation dialogs** anywhere (CLAUDE.md hard rule) — these are plain checkboxes, fine.
- **Dead `--display-font` var:** leave it in place (out of scope); removing it is a separate cleanup. The toggle deliberately targets the real h1 rules, not the var.
- **Migration shadowing** for the three existing toggles — handled by clearing the workspace value on write (Phase 6, step 14). This is the only behaviour-changing piece for existing installs; a no-op for users who never touched the toggles.
- **Class-name collisions:** `claudify-pixel-font-disabled` and `ultracode-animation-enabled` are new; grep confirms no existing usage.
- Keep client-side theme-class handlers in sync with `themeBodyClass.ts` (the file's own NOTE warns about this) — Phase 6 steps 15–17 cover each open panel.

## Verification Plan

### Automated Tests
No automated tests required. These are visual/CSS-only changes with no logic branches that benefit from unit testing. The existing test suite (run separately by the user) should be consulted for regressions in provider message handling, but no new test files are needed for this plan.

### Manual Verification
See Phase 7, step 19 above for the full manual checklist.

## Files Touched
- `package.json` — two new settings (after line 691).
- `src/services/themeBodyClass.ts` — first-paint classes (lines 46–55).
- `src/services/TaskViewerProvider.ts` — get/set handlers (lines 4144–4164), Global persistence, migrate existing toggles, broadcast listener (line 493).
- `src/services/PlanningPanelProvider.ts` — live `affectsConfiguration` broadcast in all 3 listener blocks (lines 396, 581, 708).
- `src/services/DesignPanelProvider.ts` — live `affectsConfiguration` broadcast in both listener blocks (lines 170, 268).
- `src/services/KanbanProvider.ts` — new `ultracodeAnimation` listener (line 369, built from scratch).
- `src/webview/setup.html` — two checkboxes, visibility (line 1727), change handlers, load reflection.
- `src/webview/planning.html` — pixel-font-off CSS override (after line 2388).
- `src/webview/design.html` — pixel-font-off CSS override (after line 2346).
- `src/webview/project.html` — pixel-font-off CSS override covering all 6 selectors (after line 863).
- `src/webview/kanban.html` — `fireUltracodeBlast()` gate (line 4305).

## Recommendation
Complexity 6 → **Send to Coder**.
