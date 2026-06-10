# Consolidate Themes: Afterburner Merge, Claudify Rework, Delete Slightly Darker Black, Fix Webview Fonts

## Goal
Reduce the theme system to exactly two themes built on one shared foundation:

1. **Afterburner** — the current `afterburner_updated` becomes the one and only Afterburner: delete the legacy `afterburner` styling, rename `afterburner_updated` → `afterburner`.
2. **Claudify** — rework and rename `claude-terracotta`. Claudify is **identical to Afterburner except for two things**: the Claude Code terracotta color (`#D97757`) replaces teal/cyan everywhere Afterburner uses it, and **Poppins** replaces GeistPixel as the display heading font. The current terracotta theme changes far too much (its own backgrounds, borders, text colors) — all of that is deleted.
3. **Slightly Darker Black** — deleted entirely.

Also fix the font pipeline so Hanken Grotesk actually loads and applies in **every** webview HTML file (`planning.html`, `kanban.html`, `implementation.html`, `setup.html`) — the original intent of the theme work, never achieved. The mono design language (`--font-mono` on labels/inputs/buttons/statuses) is **intentional and stays untouched**.

### Problem
Two near-identical Afterburner themes exist; the updated one is stable and should become the sole identity. The Hanken Grotesk font only ever worked in the Planning panel. The terracotta theme diverged into a full palette rewrite when it should be a thin accent-and-heading-font variant of Afterburner. Slightly Darker Black is no longer wanted.

### Root Cause (why the fonts never applied)
Three independent bugs stack up:

1. **CSP blocks Google Fonts in 3 of 4 webviews.** `kanban.html:9` and `implementation.html:9` contain `<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk...">`, but the CSPs injected by their providers only allow `style-src 'unsafe-inline' ${webview.cspSource}` and `font-src ${webview.cspSource}` — no `https:`. The stylesheet request (and the `fonts.gstatic.com` woff2 behind it) is silently blocked:
   - `src/services/KanbanProvider.ts:6693`
   - `src/services/TaskViewerProvider.ts:16881`
   - `src/services/SetupPanelProvider.ts:1383`
   Only `planning.html:6` ships its own CSP meta with `style-src ... https:` and `font-src ... https:`, which is why Planning is the only panel where the font ever rendered.

2. **CSS class name mismatch (underscore vs hyphen).** The theme message handlers in `kanban.html:5598-5600` and `implementation.html:3299-3301` apply the class via `` `theme-${msg.theme}` ``, producing `theme-afterburner_updated` — but the CSS selectors are `body.theme-afterburner-updated` (hyphenated) at `kanban.html:29` and `implementation.html:41`. The font override never matched even if the font had loaded. (`planning.js:3011-3013` adds the hyphenated class explicitly, so Planning was correct.)

3. **setup.html has no font support at all.** No Google Fonts link, no `theme-afterburner-updated` CSS block, and its handler (`setup.html:3817-3819`) would also add the broken underscore class. Its base `--font-family` (`setup.html:25`) is plain VS Code font.

## Metadata
- **Tags:** frontend, theming, refactor, bugfix
- **Complexity:** 4

## User Review Required
- **Font delivery — bundle vs. CDN:** Recommended approach is to **bundle both Hanken Grotesk and Poppins** (see Step 1) rather than widen CSP for Google Fonts. Bundling works offline, keeps CSPs tight, and follows the existing GeistPixel pattern (`PlanningPanelProvider.ts:829-832`). Both fonts are Google Fonts under the OFL license, so redistribution inside the .vsix is permitted.
- **Hanken Grotesk applies to both themes:** since Claudify is Afterburner with two substitutions, it inherits Hanken Grotesk for all proportional text. Mono elements (`--font-mono`) stay mono in both themes per explicit user decision.

## Files to Change
- `package.json` (theme enum, lines 616-633)
- `designs/` (new font files: Hanken Grotesk, Poppins)
- `src/webview/planning.html`
- `src/webview/planning.js`
- `src/webview/kanban.html`
- `src/webview/implementation.html`
- `src/webview/setup.html`
- `src/services/PlanningPanelProvider.ts`
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/SetupPanelProvider.ts`

## Implementation Steps

### Step 1 — Bundle fonts and serve them to all four webviews
1. Download the Hanken Grotesk variable font (`wght` 100–900) as woff2 from Google Fonts → `designs/HankenGrotesk-Variable.woff2`. Download Poppins as woff2 from Google Fonts — Poppins ships as static weights, not a variable font, so grab the weights the preview headings actually use: `designs/Poppins-SemiBold.woff2` (600, matching the base heading `font-weight: 600`) and `designs/Poppins-Bold.woff2` (700). (The `designs/` folder already ships with the extension and carries the GeistPixel woff2 files used at runtime.)
2. In each of the four HTML files, add `@font-face` blocks in `<head>` using placeholder URIs, mirroring the GeistPixel pattern in `planning.html:14-17`:
   ```css
   @font-face {
       font-family: 'Hanken Grotesk';
       src: url('{{HANKEN_FONT_URI}}') format('woff2');
       font-weight: 100 900;
       font-display: swap;
   }
   ```
   Poppins' `@font-face` blocks (`{{POPPINS_SEMIBOLD_FONT_URI}}`, `{{POPPINS_BOLD_FONT_URI}}` — one block per weight since these are static files) are only needed in `planning.html`, the only file using display heading fonts (GeistPixel appears nowhere else).
3. Replace the placeholders in each provider when the HTML is loaded, mirroring `PlanningPanelProvider.ts:829-832`:
   - `PlanningPanelProvider` (alongside the existing `{{GEIST_PIXEL_FONT_URI}}` replacement; add the Poppins URIs here too)
   - `KanbanProvider` (it already does string replacement for icons at ~`KanbanProvider.ts:6711`)
   - `TaskViewerProvider` (implementation.html)
   - `SetupPanelProvider` (setup.html)
4. Remove the now-dead Google Fonts `<link>` tags: `planning.html:8`, `kanban.html:9`, `implementation.html:9`.
5. **No CSP changes needed** — `font-src ${webview.cspSource}` already permits extension-bundled fonts in all four webviews. Verify each panel's `localResourceRoots` includes the extension root (or `designs/`).

### Step 2 — Promote the Afterburner Updated styles to be the base Afterburner theme
- **All four HTML files:** prepend `'Hanken Grotesk', ` to the base `--font-family` in `:root`:
  - `planning.html:44`, `kanban.html:25`, `implementation.html:37`, `setup.html:25`
- **planning.html:** fold the `body.theme-afterburner-updated` override blocks into the base rules they shadow, then delete the override blocks:
  - Lines 142-211 (`theme-afterburner-updated.cyber-theme-enabled` rules: body bg `#101414` + cyan grid, 7% scanlines, `#00e5ff` sweep beam, glass borders on tab bar / controls strip / tree panes, `#00e5ff` preview-pane grid lines, planning-card borders) → these values replace the corresponding legacy-afterburner values in the base `.cyber-theme-enabled` rules. **While folding, parameterize the accent** (Step 4 depends on this): replace hardcoded `#00e5ff` / `rgba(0, 229, 255, X)` with `var(--accent-primary)` / `color-mix(in srgb, var(--accent-primary) X%, transparent)`, and define `--accent-primary: #00e5ff;` in `:root`.
  - Lines 1133-1162 (doc preview rules): merge the Hanken font-family + 26px padding into the base `#markdown-preview*` / `#kanban-preview-pane` rules. For the display headings, replace the hardcoded `'GeistPixel'` with `var(--display-font)` and the `#00e5ff` h2-h6 color with `var(--accent-primary)`; define `--display-font: 'GeistPixel';` in `:root`. Keep these heading rules scoped to `body.cyber-theme-enabled` so they apply to the cyber aesthetic, which both remaining themes share.
- **kanban.html / implementation.html:** delete the now-redundant `body.theme-afterburner-updated` font blocks (`kanban.html:28-31`, `implementation.html:40-43`) — the font is now in `:root`. Introduce the same `--accent-primary` convention if practical; at minimum the existing `--accent-teal` (`kanban.html:20`, `implementation.html:22-23`) already serves as the swappable accent variable in these files.
- **setup.html:** nothing extra beyond the `:root` font change and the `@font-face` from Step 1 (it never had Afterburner palette overrides). The mono-heavy design language stays exactly as is.

### Step 3 — Delete Slightly Darker Black entirely
- Delete all `body.theme-slightly-darker-black` CSS blocks:
  - `planning.html:110-151` (palette block + action/secondary button overrides + hover effects)
  - `kanban.html:82-132`
  - `setup.html:78-128`
  - (implementation.html has none — only the classList reference below)
- Remove `'theme-slightly-darker-black'` from every `classList.remove()` list: `planning.js:3001` (now :3006), `kanban.html:5597`, `implementation.html:3298`, `setup.html:3816`.
- Remove the radio option at `setup.html:1174-1177`.
- Remove the enum value + enumDescription from `package.json`.

### Step 4 — Rework terracotta into Claudify (Afterburner + terracotta accent + Poppins headings)
- **Delete the existing full-palette terracotta blocks** — they change backgrounds, borders, and text colors that must now stay identical to Afterburner:
  - `planning.html:73-108` (palette block + button overrides)
  - `kanban.html:34-80` (palette block + button overrides)
  - `setup.html:30-76` (palette block + button overrides)
  - (implementation.html has none)
- **Add thin `body.theme-claudify` overrides** in each HTML file — variable swaps only, no structural rules:
  ```css
  body.theme-claudify {
      --accent-primary: #D97757;   /* planning.html — replaces #00e5ff everywhere it was parameterized in Step 2 */
      --accent-teal: #D97757;      /* kanban/implementation — cascades into --accent-teal-dim/--glow-teal via existing color-mix */
      --display-font: 'Poppins';   /* planning.html — replaces GeistPixel in doc preview headings */
  }
  ```
  Note on heading typography: the shared heading rule (`planning.html:1145-1154`) carries GeistPixel-specific tuning — `letter-spacing: -0.05em` and `font-stretch: 90%` (Poppins has no width axis, so `font-stretch` is a no-op for it, but the tight tracking is not). Move those two declarations into the Afterburner scope (or parameterize as `--display-letter-spacing`), and let Claudify reset to normal tracking so Poppins renders as designed.

  Audit each file for any remaining hardcoded teal/cyan literals (`#3ddbd9`, `#00e5ff`, `rgba(0,229,255,...)`, `rgba(61,219,217,...)`) outside variable definitions and convert them to the variables so the Claudify swap is complete — e.g. the sweep beam gradient and glassmorphism borders in planning.html, and any inline teal in kanban/implementation/setup.
- **Claudify gets the full cyber treatment** (scanlines, grid, sweep beam, glass borders) because it *is* Afterburner with substitutions:
  - `planning.js` `handleThemeChanged` (2997-3014): add `cyber-theme-enabled` for both `'afterburner'` and `'claudify'`; add `theme-claudify` class when active.
  - `kanban.html:5594-5602`, `implementation.html:3296-3303`, `setup.html:3805-3821`: same logic — remove `theme-claudify` on change, add it when `theme === 'claudify'`.
- **Rename everywhere:** setting value `claude-terracotta` → `claudify`, CSS class `theme-claude-terracotta` → `theme-claudify`, radio label at `setup.html:1170-1173` → "Claudify".
- **Animation settings visibility** (`setup.html:1672`, `:3571`, `:3813`): both remaining themes are cyber themes, so the animation section is now always shown — the conditions can be removed entirely.

### Step 5 — Remove the `afterburner_updated` identity
- **package.json:616-633:** enum becomes `["afterburner", "claudify"]` with descriptions: *"Afterburner — Cyberpunk theme, brighter cyan, Hanken Grotesk, scanline effects"* and *"Claudify — Afterburner with Claude terracotta accent and Poppins headings"*. Default stays `"afterburner"`.
- **setup.html:** delete the "Afterburner Updated" radio (lines 1166-1169).
- **planning.js:** simplify `handleThemeChanged` per Step 4; update the default-comment at line 10.
- **kanban.html:5597 / implementation.html:3298:** remove `'theme-afterburner-updated'` from the classList.remove() lists.

### Step 6 — No settings migration (dev-only extension)
No migration code. The extension is in development with a single user; a stale `switchboard.theme.name` value (`afterburner_updated`, `claude-terracotta`, `slightly-darker-black`) is harmless — it matches no CSS class, so the webviews render base Afterburner. After updating, re-pick the theme once in Setup (or hand-edit settings.json) on any machine/workspace that had an old value set. Writes go to the Workspace target (`TaskViewerProvider.ts:3604`), so check `.vscode/settings.json` in active workspaces.

### Step 7 — Build & package checks
- `npm run compile` (webpack) — confirm the webview HTML/JS copies into `dist/webview/` pick up the changes.
- Confirm `designs/HankenGrotesk-Variable.woff2` and the Poppins woff2 files are included by `vsce package` (`designs/` is not excluded by `.vscodeignore`; `src/**` is, which is why fonts must live outside `src/`).

## Verification Plan

### Automated Tests
- `npm run lint` and `npm run compile` must pass. No webview rendering test harness exists; manual verification below covers the visual behavior.

### Manual Verification (Acceptance Criteria)
- [ ] With no theme setting (fresh default = `afterburner`): Planning, Kanban, Implementation sidebar, and Setup panels all render Hanken Grotesk for proportional text. Confirm via *Developer: Open Webview Developer Tools* → computed `font-family` on `<body>` resolves to "Hanken Grotesk" (actually loaded, not a fallback — check the Network/Font tabs). Mono elements (labels, inputs, buttons, statuses) remain monospace.
- [ ] Fonts render with **network disconnected** (proves bundling works, no CDN dependency).
- [ ] Afterburner: Planning panel visuals match the former Afterburner Updated look — `#101414` body, cyan `#00e5ff` sweep beam/borders/grid, 7% scanlines, GeistPixel headings in doc previews with `#00e5ff` h2-h6.
- [ ] Claudify: pixel-identical to Afterburner **except** every teal/cyan accent renders terracotta `#D97757` (sweep beam, grid lines, glass borders, glows, active states, doc preview h2-h6) and doc preview headings render in Poppins instead of GeistPixel. Backgrounds, borders, text colors, scanlines, and layout are unchanged from Afterburner. Verify in all four panels.
- [ ] Setup → Theme tab shows exactly two options (Afterburner, Claudify); switching live-updates all open panels; the animation toggle is visible for both and the sweep beam toggle works in both themes.
- [ ] A workspace with a stale theme value (e.g. `"afterburner_updated"`) in `.vscode/settings.json` renders base Afterburner without errors; re-selecting a theme in Setup writes the new value.
- [ ] No remaining references: `grep -rn "afterburner_updated\|afterburner-updated\|terracotta\|slightly-darker-black\|slightly_darker" src package.json` returns nothing.

## Execution Status
- **Status:** Not started
