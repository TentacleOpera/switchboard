# Afterburner Professional: Use Claudify's h2–h6 Font (not Afterburner's)

## Goal

The **Afterburner Professional** theme currently uses Afterburner's heading font (the pixel/GeistPixel display font) for `h2`–`h6`. It should instead use the **same h2–h6 font that the Claudify theme uses**, since Afterburner Professional is "Claudify layout + Afterburner cyan accent" and the heading font is part of Claudify's layout, not Afterburner's.

### Problem Analysis

Afterburner Professional was designed as Claudify's professional layout with Afterburner's cyan accent colour swapped in. The heading typography is a layout concern, not an accent concern, so it should follow Claudify. Today the afterburner-pro CSS overrides `h2`–`h6` to use Afterburner's display font, which breaks the "Claudify layout" contract and produces headings that clash with the otherwise Claudify-styled panels.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bug

## Complexity Audit

### Routine
- Locate the `body.theme-afterburner-pro` font override rules for `h2`–`h6` across the webview files (planning, design, project, kanban, setup, implementation).
- Remove or replace them so afterburner-pro inherits Claudify's `h2`–`h6` font-family.

### Complex / Risky
- Afterburner-pro carries both `theme-claudify` and `theme-afterburner-pro` body classes. Claudify's `h2`–`h6` font rule (`body.theme-claudify …h2…h6`) already applies. The afterburner-pro override is what currently wins (equal or higher specificity, declared later). Removing the afterburner-pro override lets Claudify's rule take effect.

## Edge-Case & Dependency Audit

- **Claudify theme:** Unaffected — its `h2`–`h6` font rule is unchanged.
- **Afterburner (plain):** Unaffected — does not carry `theme-claudify` or `theme-afterburner-pro`.
- **Specificity:** Verify the Claudify `h2`–`h6` rule is not itself overridden by a more-specific base rule once the afterburner-pro override is removed.

## Proposed Changes

### Webview CSS files — remove/neutralise afterburner-pro h2–h6 font overrides
- **Context:** Each webview file that has a `body.theme-afterburner-pro #…h2…h6 { font-family: … }` override (added when afterburner-pro was created) forces the Afterburner pixel font onto headings.
- **Logic:** Remove these afterburner-pro font override rules so that Claudify's `body.theme-claudify …h2…h6` font-family applies (afterburner-pro carries `theme-claudify`).
- **Implementation:** Grep for `theme-afterburner-pro` + `h2`/`h6`/`font-family`/`display-font` across `src/webview/*.html` and `src/webview/*.js`. Delete the afterburner-pro font override blocks. Confirm Claudify's heading font rule covers the same selectors.
- **Edge Cases:** If any afterburner-pro rule also sets non-font properties (colour, size), preserve those — only the `font-family` declaration should be removed.

## Verification Plan

- [ ] Activate Afterburner Professional → h2–h6 render in Claudify's heading font.
- [ ] Activate Claudify → h2–h6 unchanged (still Claudify font).
- [ ] Activate Afterburner (plain) → h2–h6 still use Afterburner's font.
- [ ] Grep confirms no remaining afterburner-pro `font-family` overrides on headings.
