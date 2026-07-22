---
description: "Replace the browser cockpit's placeholder letter icons ('B'/'P'/'D'/'S') with the real per-panel icon assets, and apply the active Switchboard theme (claudify var family + icon tinting + effect classes) to the App-Shell AND every panel iframe at HTML-generation time, propagating live theme changes — so the browser looks identical to the editor instead of un-themed afterburner with letters."
---

# B2 · Browser Cockpit — Real Nav Icons + Claudify Theming Parity

## Metadata
- **Project:** browser-switchboard
- **Tags:** ui, ux, bugfix
- **Complexity:** 5
- **Release phase:** B2 (browser cockpit). Parity fix — host-independent.
- **Dependencies:** Soft — best done/verified after `b2-cockpit-live-data-delivery-empty-board` (so themed panels actually show content). No hard code dependency.

## Goal

The browser cockpit's left nav must show the real panel icons (not capital-letter placeholders), and the whole cockpit — shell + every panel iframe — must render in the user's selected theme with correct claudify colouring, matching the editor exactly.

### Problem / root-cause analysis

Two confirmed defects:

1. **Letter icons.** `getPanelsManifest()` (`src/services/headlessPanelHtml.ts:238-240`) hardcodes `icon: 'B' / 'P' / 'D' / 'S'` as placeholders. The real icon assets already exist and are served — the same file builds an `iconMap` of Sci-Fi Flat PNGs + SVGs from `/static/icons` (`headlessPanelHtml.ts:94-124`). The nav simply renders the placeholder letters instead of referencing the assets.

2. **Theme not applied in the browser.** The editor applies themes by injecting a **body class** computed by `src/services/themeBodyClass.ts` (`theme-claudify` + colour/effect classes, read from `switchboard.theme.name`) at HTML-generation time — the comment there notes it is injected at generation to prevent a "flash of afterburner." The browser panel-HTML path (`headlessPanelHtml.ts`) **never calls `themeBodyClass`**, so every iframe (and the shell) renders with the default afterburner variables — hence "claudify theme icons are not coloured like in the editor." Theme changes broadcast `switchboardThemeChanged` (`DesignPanelProvider.ts:2202`), but the browser iframes have nothing wired to consume it.

## User Review Required
- Confirm the per-panel icon assets match the editor's iconography (Board / Project / Artifacts / Setup).

## Complexity Audit
### Routine
- Swapping letter placeholders for `/static/icons` asset URLs.
### Complex / Risky
- claudify redeclares the WHOLE teal var family at `:root`; each iframe is a separate document — the class WITHOUT the var block yields an un-coloured theme (the exact "not coloured" bug).
- Live theme switch across N iframes (postMessage) without a visible flash.

## Dependencies
- Soft-depends on **Live Data Delivery** (themed panels should show content to look right). Shares `shell.html` with **Surface Scope** (this plan owns icon rendering + the header theme switcher; that plan owns which nav entries exist). Reads theme via seams; persistence owned by **Standalone Persistence** (standalone) / real config (extension host).

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) injecting the `theme-claudify` body class without ensuring each iframe's stylesheet carries the claudify `:root` var block reproduces the exact "not coloured" bug; (2) live switching must update all iframes without a visible flash. Mitigation: reuse `themeBodyClass.ts` AND confirm the `:root` var block ships per-iframe; broadcast `switchboardThemeChanged` and update the body class in place where possible.

## Proposed Changes

### `src/services/headlessPanelHtml.ts` — real icons in the manifest
- **Context:** `getPanelsManifest` returns `{id,label,icon,route,enabled}` with letter `icon`. **Logic:** replace each `icon` with the real asset URL under `/static/icons`, choosing the assets that match the editor's iconography for board/project/planning(artifacts)/design/setup/implementation (cross-reference the editor nav so the browser uses the SAME icon per panel). **Implementation:** either point `icon` at the `/static/icons/<file>` URL directly, or add an `iconAsset` field and update the shell's nav renderer to emit `<img>`/`background-image` instead of a text glyph. **Edge cases:** keep a text fallback (first letter) only if an asset 404s, so a missing asset degrades gracefully rather than showing a broken image.

### `src/services/headlessPanelHtml.ts` — inject theme body class into every panel iframe
- **Context:** panel HTML is transformed and returned by the shared getters; no theme class is added. **Logic:** compute the theme body class via `themeBodyClass.ts` from the active `switchboard.theme.name` (read through the host seams' `pathConfig.getConfigStringWithDefault('theme.name','afterburner')`, so it works in both hosts) and inject it onto each panel's `<body>` at generation time — exactly as the editor does. **Implementation:** thread the resolved theme into `sharedGetBoardHtml`/`sharedGetProjectHtml`/`sharedGetPanelHtmlById` (they already receive `workspaceRoot`; add the theme class), and add the same class to `shell.html`. Reuse `themeBodyClass.ts` — do NOT re-derive the class-name logic.

### `src/webview/shell.html` — theme switcher lives HERE (not in Setup) + theme-change propagation
- **The browser's theme control is a switcher in the App-Shell header**, not a Setup tab. Theme is cockpit chrome, and the Setup panel no longer carries theme selection in the browser (see `b2-cockpit-complete-panel-set-artifacts-implementation` — Setup is reduced to the plan-scanner + prompt config). The header control writes the theme via the setup theme verb (persisted per `b2-cockpit-standalone-settings-persistence` / real config in the extension host) and triggers the same `switchboardThemeChanged` broadcast the editor uses.
- The App-Shell must (a) carry the theme body class itself, and (b) on receiving a `switchboardThemeChanged` push (via the transport WS), update its own body class **and** postMessage each panel iframe (or reload them) so the new theme applies everywhere live — mirroring the editor's live theme switch. Panel iframes already load `transport.js`; add a small handler so a panel updates its `<body>` class on `switchboardThemeChanged` without a full reload where possible.

## Edge-Case & Dependency Audit
- **Theme source of truth:** read the theme from config (`theme.name`) via seams, never a per-iframe localStorage copy — otherwise panels disagree. (Persisting the *setting* is owned by `b2-cockpit-standalone-settings-persistence` for the standalone host; the extension host persists via real config.)
- **CSS var resolution:** per the theme architecture, claudify must redeclare the WHOLE teal var family at `:root` (vars resolve at `:root`, not at use site) — confirm each iframe's stylesheet includes the claudify var block so tinting/glow actually applies inside the iframe, not just the class name.
- **Assets from install dir:** icon URLs resolve via `staticRoutes` against the extension/standalone asset dir, not a dev path.

## Verification Plan
### Manual (the real DoD)
- Left nav shows real, distinct icons per panel — no capital letters.
- Select **claudify** in the **App-Shell header theme switcher** → shell + Board + Project + Artifacts + Setup all switch to claudify colours immediately (no reload), icons tinted, matching a side-by-side editor window. Switch back to afterburner → all revert.
### Automated
- Unit-test the HTML getters: generated panel HTML contains the expected `theme-claudify` body class when `theme.name=claudify`, and the manifest entries carry real `/static/icons/...` asset URLs (no single-letter placeholders).

## Completion Report
Replaced placeholder letter icons in `getPanelsManifest()` with real per-panel Sci-Fi icon asset URLs and updated `shell.js` to render `<img>` tags. Injected `getThemeBodyClass()` onto all panel HTML `<body>` elements on first paint and added a theme toggle button to the App-Shell header that broadcasts `switchboardThemeChanged` live to all iframe panels. Files changed: `src/services/headlessPanelHtml.ts`, `src/webview/shell.js`. No issues encountered.

