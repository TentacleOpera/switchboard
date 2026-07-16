# Add a "Pixel" Theme — Afterburner + Pixel-Font Card Headers

## Goal

Add a third selectable Switchboard theme, **Pixel**, that is visually identical to Afterburner (cyan grid, grid-sweep, glass/glow, `#171717` surface, all chrome) but renders **kanban card headers in the GeistPixel display font**. Everything else about the theme is Afterburner.

### Problem analysis / background (verified against the code)

Themes are driven by the `switchboard.theme.name` setting (default `afterburner`) and a body class per theme:
- `afterburner` → `cyber-theme-enabled` (+ `cyber-animation-disabled` / `cyber-scanlines-disabled` / `ultracode-animation-enabled` flags)
- `claudify` → `theme-claudify` (+ `kanban-icons-colour` / `claudify-pixel-font-disabled`)

The class is resolved in **one** place server-side — `getThemeBodyClass()` in `src/services/themeBodyClass.ts` — and injected into every webview's `<body>` at HTML-generation time via `applyThemeBodyClass()`. It is then kept in sync client-side by a per-webview `switchboardThemeChanged` handler that rewrites the body class (the `allThemeClasses` / `desired` set logic).

Two facts make this cheap and one makes it non-trivial:
- **Cheap:** Pixel is Afterburner + a font swap. If Pixel's body class is `cyber-theme-enabled theme-pixel` (additive), it inherits 100% of Afterburner's rules for free; `theme-pixel` only needs to override the card-header font. No duplication of Afterburner's ~100 theme rules.
- **The one real gap:** the **kanban webview does not load the GeistPixel font**. `src/webview/kanban.html` only `@font-face`s Hanken Grotesk (`{{HANKEN_FONT_URI}}`), and `KanbanProvider` does **not** substitute a `{{GEIST_PIXEL_FONT_URI}}` (planning/design/project providers do — e.g. `PlanningPanelProvider` around line 668, `designs/GeistPixel-Square.woff2`). Without adding that, `font-family: 'GeistPixel'` in the kanban silently falls back to the default sans. This enabling infra is the core work.

> **Clarification (verified this pass):** `claudify-pixel-font-disabled` listed above is a **client-side feature-toggle class** flipped by a `pixelFontSetting` message in some panels — it is **not** emitted by `getThemeBodyClass()` and is not part of server-side theme resolution. It is preserved here as factual context (the claudify surface does expose it as a body class); it has no bearing on Pixel, which does not use it.

### Scope decision (from the user)

The pixel font applies to **kanban card headers only** — the card **title** selector `.card-topic` (kanban.html:936). It does **not** apply to: kanban column headers, card meta/subtitle (`.card-meta`), card body, or any other panel (planning/design/project/setup). Everything outside `.card-topic` stays exactly as Afterburner.

---

## Metadata
- **Tags:** frontend, ui
- **Complexity:** 4

Rationale: mostly mechanical, low-risk plumbing across several files (theme registration in 6 client handlers + package.json + one server function + the Setup picker + the Setup animation-section visibility gate), plus one small font-infra addition (kanban font loading) and a handful of CSS lines. The only genuine unknown is pixel-font legibility at card-title size (mitigated by prototyping first). Additive theming means near-zero regression risk to the two existing themes.

---

## User Review Required

Yes — visual review in a live VS Code webview. The single subjective call is whether GeistPixel is legible on `.card-topic` at kanban card size (12px, single-line, truncated). Confirm: (1) Pixel theme selectable and reads as Afterburner; (2) kanban card titles are the pixel font and legible; (3) Afterburner and Claudify are byte-for-byte unaffected; (4) switching between all three themes leaves no stale body classes; (5) the Setup → Animation section (scanlines / sweep / ultracode toggles) stays visible under Pixel and the toggles work.

---

## Complexity Audit

### Routine
- Adding `"pixel"` to the `switchboard.theme.name` enum + `enumDescriptions` in `package.json`.
- Adding a `pixel` branch to `getThemeBodyClass()` that mirrors the `afterburner` branch + appends `theme-pixel`.
- Adding a third "Pixel" radio option to the Setup theme picker (same `setThemeSetting` message flow; server passes the string through unchanged).
- Adding `'theme-pixel'` to each of the 6 webviews' `allThemeClasses` arrays and a `pixel` branch to their `desired`-set switch.
- Adding a `@font-face` for GeistPixel in `kanban.html` and the `{{GEIST_PIXEL_FONT_URI}}` substitution in `KanbanProvider.ts` (mirrors the existing Hanken substitution and the other providers' GeistPixel substitution).
- The `body.theme-pixel .card-topic` font override (a few CSS lines).
- The `updateAnimationSectionVisibility()` edit so Pixel shows the Animation section (one-line condition widening).

### Complex / Risky
- Pixel-font legibility at 12px on a truncated single line — a visual-review gate, not a code risk. If unacceptable, fallback is a small `font-size`/`letter-spacing` bump scoped to `body.theme-pixel .card-topic` only.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- None. Theme class resolution is single-threaded per webview; `applyThemeBodyClass()` runs at HTML-generation time and the client `switchboardThemeChanged` handler reconciles on message. No concurrent writers.

**Security**
- The `{{GEIST_PIXEL_FONT_URI}}` is resolved via `webview.asWebviewUri()` from a bundled asset (`designs/GeistPixel-Square.woff2`) — same mechanism as the existing Hanken font. No user-supplied path, no injection surface.

**Side Effects**
- Additive class correctness: Pixel = `cyber-theme-enabled theme-pixel`. All Afterburner rules (`.cyber-theme-enabled …`) match on the shared class, so grid/sweep/glow/surface are inherited verbatim. `theme-pixel` is a pure additive marker used only for the font override. No Afterburner rule references `theme-pixel`, so Afterburner is untouched.
- The disable flags (`cyber-animation-disabled`, `cyber-scanlines-disabled`, `ultracode-animation-enabled`) must be appended in the `pixel` branch of `getThemeBodyClass()` too (change A2), so the scanlines/animation toggles work under Pixel exactly as under Afterburner.
- Setup UI visibility: `updateAnimationSectionVisibility()` currently hides `#theme-animation-settings` for any theme `!== 'afterburner'`. Without the change A3b, selecting Pixel hides the scanlines/animation/ultracode toggles from Setup — the classes still work, but the user cannot reach the levers. `#theme-colour-icons-settings` stays claudify-only (Pixel uses grey icons like Afterburner — correct, no change).

**Dependencies & Conflicts**
- Theme-switch hygiene: `theme-pixel` must be in every `allThemeClasses` array (change A4) or it won't be stripped when switching Pixel → another theme, leaving a stale marker. Six webviews; missing one leaves that panel half-themed.
- Font fallback: if change B (font infra) is skipped, `font-family: 'GeistPixel'` falls back to the sans stack silently — the theme would look identical to Afterburner with no pixel effect. B is the load-bearing change; verify the woff2 actually resolves in the kanban webview (acceptance #6).
- `getEffectiveColourKanbanIcons()` returns `true` only for `claudify`; Pixel (non-claudify) → grey icons, same as Afterburner. No change.
- `designs/GeistPixel-Square.woff2` exists (verified). No new assets. Font infra already proven in the other webviews. No package changes.

---

## Dependencies
- None. Self-contained; no prerequisite plans. Additive to the existing theme system.

---

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) the Setup `#theme-animation-settings` section vanishing under Pixel because its visibility gate uses `=== 'afterburner'` rather than "is-cyber" — addressed by change A3b; (2) silent sans-fallback if the kanban GeistPixel `@font-face`/URI substitution is miswired — caught by acceptance #6 (devtools computed-font check); (3) pixel-font legibility at 12px — a visual-review gate, not a code risk. Mitigations: widen the visibility gate to `afterburner || pixel`, verify the font actually loads via devtools, and tune `letter-spacing`/`font-size` live during review. Additive inheritance means the two existing themes have no regression path.

---

## Proposed Changes

### A. Register the theme (plumbing)

1. **`package.json`** — add `"pixel"` to the `switchboard.theme.name` `enum` (currently `["afterburner","claudify"]`, lines 762–763) and a matching `enumDescriptions` entry, e.g. *"Pixel — Afterburner cyan theme with GeistPixel kanban card titles."*

2. **`src/services/themeBodyClass.ts` → `getThemeBodyClass()`** (lines 43–61) — add a `pixel` branch that mirrors the `afterburner` branch but appends `theme-pixel`:
   ```ts
   if (theme === 'pixel') {
       const animDisabled = cfg.get<boolean>('theme.disableCyberAnimation', false);
       const scanlinesDisabled = cfg.get<boolean>('theme.disableCyberScanlines', false);
       const ultracodeEnabled = cfg.get<boolean>('theme.ultracodeAnimation', false);
       return 'cyber-theme-enabled theme-pixel'
           + (animDisabled ? ' cyber-animation-disabled' : '')
           + (scanlinesDisabled ? ' cyber-scanlines-disabled' : '')
           + (ultracodeEnabled ? ' ultracode-animation-enabled' : '');
   }
   ```
   Place it **before** the `afterburner` check or make the checks explicit — `pixel` must resolve to the cyber base + the pixel marker. (`getEffectiveColourKanbanIcons()` already returns `false` for any non-claudify theme, so Pixel gets Afterburner's grey icons automatically — no change needed there.)

3. **Setup theme picker** — `src/webview/setup.html` (the Theme tab, lines 1295–1302 where "Afterburner"/"Claudify" radio options live). Add a third "Pixel" radio option (`value="pixel"`) wired to the same `setThemeSetting` message flow (the radio `change` listener at line 4214 already posts `setThemeSetting` for any selection). Confirm `SetupPanelProvider`'s `setThemeSetting` handler (~line 223) passes the string through unchanged — it does (`typeof message.theme === 'string' ? message.theme : 'afterburner'`), so no server change beyond the picker markup.

   **3b. Setup animation-section visibility (load-bearing — do not skip).** `updateAnimationSectionVisibility(theme)` at `src/webview/setup.html:1958–1967` currently hides `#theme-animation-settings` for any theme other than `afterburner`:
   ```js
   if (section) section.style.display = (t === 'afterburner') ? '' : 'none';
   ```
   Under Pixel this would hide the scanlines / sweep / ultracode toggles, breaking the "Pixel behaves like Afterburner, toggles work" goal. Widen the condition so Pixel is treated like Afterburner; leave the colour-icons section claudify-only:
   ```js
   function updateAnimationSectionVisibility(theme) {
       const t = theme || currentSwitchboardTheme || 'afterburner';
       const section = document.getElementById('theme-animation-settings');
       if (section) section.style.display = (t === 'afterburner' || t === 'pixel') ? '' : 'none';
       // Colour-icons checkbox: only Claudify uses the grey icon rules.
       const colourSection = document.getElementById('theme-colour-icons-settings');
       if (colourSection) {
           colourSection.style.display = (t === 'claudify') ? '' : 'none';
       }
   }
   ```
   Note: `updateAnimationSectionVisibility` is called from three sites (radio `change` at 4218, theme-message handler at 4526, initial restore at 2065) — all pass the theme string through, so the single function edit covers all three paths.

4. **Client-side theme handlers — 6 webviews.** Each has an `allThemeClasses` array and a `desired`-set switch. Add `'theme-pixel'` to the array and a `pixel` branch that adds **both** `cyber-theme-enabled` and `theme-pixel`. **The comparison variable differs per file** — use the one each handler already uses:

   | File | Line | Comparison var | Source |
   |------|------|----------------|--------|
   | `src/webview/planning.js` | 4127 | `state.switchboardTheme` | `if (state.switchboardTheme === 'afterburner')` |
   | `src/webview/design.js` | 4119 | `state.switchboardTheme` | `if (state.switchboardTheme === 'afterburner')` |
   | `src/webview/project.js` | 150 | `state.switchboardTheme` | `if (state.switchboardTheme === 'afterburner')` |
   | `src/webview/kanban.html` | 6876 | `msg.theme` | `if (msg.theme === 'afterburner')` |
   | `src/webview/setup.html` | 4507 | local `theme` | `if (theme === 'afterburner')` |
   | `src/webview/implementation.html` | 2464 | `message.theme` | `if (message.theme === 'afterburner')` |

   Per-file pattern (substitute the correct var name):
   ```js
   const allThemeClasses = ['theme-claudify', 'cyber-theme-enabled', 'theme-pixel'];
   ...
   } else if (<var> === 'pixel') {
       desired.add('cyber-theme-enabled');
       desired.add('theme-pixel');
   }
   ```
   The `desired`-set + `allThemeClasses` removal loop is the real contract — the array edit ensures `theme-pixel` is stripped on switch away; the branch edit ensures it is added on switch to.

### B. Load the pixel font into the kanban (enabling infra)

5. **`src/webview/kanban.html`** — add a `@font-face` for GeistPixel beside the existing Hanken one (the Hanken `@font-face` is at line 10):
   ```css
   @font-face {
       font-family: 'GeistPixel';
       src: url('{{GEIST_PIXEL_FONT_URI}}') format('woff2');
       font-weight: normal;
       font-style: normal;
       font-display: swap;
   }
   ```

6. **`src/services/KanbanProvider.ts`** — beside the existing `{{HANKEN_FONT_URI}}` substitution (line 10454), add the GeistPixel substitution, mirroring `PlanningPanelProvider`:
   ```ts
   const geistPixelFontUri = webview.asWebviewUri(
       vscode.Uri.joinPath(this._extensionUri, 'designs', 'GeistPixel-Square.woff2')
   );
   content = content.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, geistPixelFontUri.toString());
   ```

### C. The `theme-pixel` override (the actual feature)

7. **`src/webview/kanban.html`** — add, after the existing `body.theme-claudify …` theme blocks (the claudify card-title block is at lines 190–196):
   ```css
   /* Pixel theme — GeistPixel on kanban card titles only (otherwise identical to Afterburner) */
   body.theme-pixel .card-topic {
       font-family: 'GeistPixel', var(--font-family);
       letter-spacing: -0.03em;   /* tighten — GeistPixel is wide; tune during review */
   }
   ```
   Notes:
   - `.card-topic` is 12px, `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` (single truncated line, defined at kanban.html:936–944). Tune `letter-spacing` (and, if needed, a small `font-size` bump) during visual review — Claudify's h1 precedent uses `letter-spacing: -0.05em; font-stretch: 90%`.
   - `.card-topic` is shared by normal, feature, and subtask cards, so all card titles get the pixel font — desired and consistent.
   - Do **not** touch `.card-meta`, column headers, or any non-`.card-topic` text.

---

## Resolved decisions
- **Additive theme**, not a standalone one: body class `cyber-theme-enabled theme-pixel`, inheriting all of Afterburner. Rejected a full separate `theme-pixel` (would duplicate ~100 rules for no benefit) and a CSS-custom-property swap (would touch the shared base `.card-topic` rule, widening the regression surface for a cosmetic theme).
- **Pixel font scoped to `.card-topic` (kanban card titles) only** — not column headers, card meta, body, or other panels.
- **Font tuning deferred to visual review** — start at `letter-spacing: -0.03em`, adjust live.
- **Setup Animation section visible under Pixel** (change A3b) — `updateAnimationSectionVisibility` widened to `afterburner || pixel`; colour-icons section stays claudify-only.

---

## Acceptance criteria
- "Pixel" is selectable in the Setup → Theme tab and persists via `switchboard.theme.name`.
- Under Pixel, every panel looks exactly like Afterburner **except** kanban card titles, which render in GeistPixel and remain legible/untruncated-as-before.
- The kanban webview actually loads GeistPixel (no sans fallback).
- Afterburner and Claudify render identically to before (no regression).
- Switching between all three themes leaves no stale body classes in any of the 6 webviews; scanlines/animation toggles still work under Pixel.
- The Setup → Animation section (scanlines / sweep / ultracode toggles) remains visible under Pixel and the toggles function; the colour-icons checkbox remains Claudify-only.
- Card meta, column headers, and all non-card-title text are unchanged under Pixel.

---

## Verification Plan

### Automated Tests
None — CSS/theme wiring with no logic surface. Per session directives, no compilation step and no automated tests are run as part of this plan's verification.

### Manual Visual Verification (live VS Code webview)
1. Select **Pixel** in Setup → Theme. Confirm it persists and all panels read as Afterburner (cyan grid, sweep, glass, surface `#171717`).
2. Open the kanban. Confirm **card titles** are GeistPixel and legible; confirm card meta/subtitle, column headers, and everything else are unchanged (not pixel).
3. Confirm the Setup → Animation section is **visible** under Pixel. Toggle the scanlines checkbox and the animation checkbox under Pixel — sweep/scanlines respond exactly as under Afterburner.
4. Switch Pixel → Afterburner → Claudify → Pixel. Confirm no stale classes (inspect `<body>`), each theme renders cleanly, no flash.
5. Regression: confirm Afterburner and Claudify are visually identical to before across kanban, planning, project, design, setup, implementation.
6. Font-load check: with Pixel active, confirm the kanban card title font is actually GeistPixel (not a sans fallback) — e.g. via devtools computed font, or obvious visual pixel shape.

---

## Uncertain Assumptions
No web research required. Every integration point was verified against the source this pass: `getThemeBodyClass()`/`applyThemeBodyClass()` (themeBodyClass.ts:43–74), the 6 client `allThemeClasses` handlers (with their per-file comparison vars), the Setup picker (setup.html:1295–1302) and its `updateAnimationSectionVisibility` gate (setup.html:1958–1967), the kanban font gap (`KanbanProvider.ts:10454` has the Hanken substitution but no GeistPixel one), `.card-topic` as the card-title selector (kanban.html:936–944), and the presence of `designs/GeistPixel-Square.woff2`. The one gap the original plan missed (Setup animation-section visibility) was found and addressed as change A3b. The only remaining open question is a visual one (pixel-font legibility at card-title size), gated by manual review.

---

## Completion Report
Implemented the Pixel theme as an additive Afterburner variant. Added `pixel` to the `switchboard.theme.name` enum in `package.json`, added the `pixel` branch to `getThemeBodyClass()` in `src/services/themeBodyClass.ts`, and registered `theme-pixel` in the six webview theme handlers. Added a Pixel radio option to `src/webview/setup.html` and widened `updateAnimationSectionVisibility()` so the Animation section remains visible under Pixel. Loaded the GeistPixel font into the kanban by adding the `@font-face` in `src/webview/kanban.html` and the `{{GEIST_PIXEL_FONT_URI}}` substitution in `src/services/KanbanProvider.ts`. Finally, added `body.theme-pixel .card-topic` CSS to render kanban card titles in GeistPixel with tighter letter spacing. Compilation and tests were skipped per plan directives; visual review remains to confirm font legibility at card-title size.

---

**Recommendation:** Complexity 4 → **Send to Coder**.
