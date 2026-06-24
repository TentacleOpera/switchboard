# Afterburner Professional: Use Claudify's h2–h6 Font (not Afterburner's)

## Goal

The **Afterburner Professional** theme currently uses Afterburner's heading font (the pixel/GeistPixel display font) for `h2`–`h6`. It should instead use the **same h2–h6 font that the Claudify theme uses** (Poppins), since Afterburner Professional is "Claudify layout + Afterburner cyan accent" and the heading font is part of Claudify's layout, not Afterburner's.

### Problem Analysis

Afterburner Professional was designed as Claudify's professional layout with Afterburner's cyan accent colour swapped in. The heading typography is a layout concern, not an accent concern, so it should follow Claudify. Today the afterburner-pro CSS overrides `h2`–`h6` to use Afterburner's display font (`--display-font: 'GeistPixel'`), which breaks the "Claudify layout" contract and produces headings that clash with the otherwise Claudify-styled panels.

### Root Cause

Each of the three affected files has a `body.theme-afterburner-pro … h2…h6 { font-family: var(--display-font) … }` block declared **after** the Claudify `body.theme-claudify … h2…h6 { font-family: 'Poppins' … }` block. Both selectors have identical specificity (0,1,1,1 — one class, one ID, one element). Since the afterburner-pro block is declared later in source order, it wins. Removing the afterburner-pro block lets Claudify's rule take effect automatically — no specificity changes needed.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bugfix

## User Review Required

No — this is a straightforward CSS deletion with no behavioural or data implications. The change is purely visual (heading font in one theme).

## Complexity Audit

### Routine
- Delete the afterburner-pro h2–h6 CSS rule block (selector + all declarations) in 3 files.
- Each block sets only typography properties: `font-family`, `letter-spacing`, `font-stretch`. No non-font properties to preserve.
- Claudify's h2–h6 rule (already present in each file, declared earlier) takes effect automatically once the afterburner-pro override is removed.
- The afterburner-pro h1 color rules (immediately above each h2–h6 block) are preserved — they handle the cyan accent, which is correct.

### Complex / Risky
- None. All three blocks are self-contained CSS rule deletions with no side effects on other themes or selectors.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — pure static CSS, no runtime logic.
- **Security:** N/A — CSS only.
- **Side Effects:** None. Removing the afterburner-pro h2–h6 block does not affect any other selector, theme, or property. The h1 afterburner-pro color rule remains untouched.
- **Dependencies & Conflicts:**
  - **Claudify theme:** Unaffected — its `h2`–`h6` font rule is unchanged and will now also apply when afterburner-pro is active (afterburner-pro carries `theme-claudify`).
  - **Afterburner (plain):** Unaffected — does not carry `theme-claudify` or `theme-afterburner-pro`. Its heading font comes from `body.cyber-theme-enabled` rules, which are not touched.
  - **Specificity verification (conclusion):** The Claudify h2–h6 selectors (`body.theme-claudify #markdown-preview h2`, etc.) have specificity (0,1,1,1). The base heading rules (`#markdown-preview h2`, etc.) are (0,1,0,1) — lower, and they don't set `font-family` anyway. The cyber-theme heading rules (`body.cyber-theme-enabled #markdown-preview h2`, etc.) are also (0,1,1,1) but only active for plain Afterburner, not afterburner-pro. Therefore Claudify's rule wins cleanly once the afterburner-pro block is removed.
  - **kanban.html, implementation.html, setup.html:** These files were listed in the original plan but do NOT contain any afterburner-pro (or claudify) h2–h6 font override blocks. No changes needed in these files.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the original plan overestimated scope (6 files vs actual 3), (2) the plan's edge-case guidance about "only remove font-family" contradicted its "delete the block" instruction — the entire block (font-family + letter-spacing + font-stretch) must be removed together to avoid Poppins rendering with GeistPixel's cramped letter-spacing and condensed stretch, and (3) the afterburner-pro h1 color rules must be explicitly preserved. Mitigations: scope corrected to 3 files with exact line numbers; full-block deletion specified; h1 preservation called out explicitly.

## Proposed Changes

### `src/webview/planning.html` — delete afterburner-pro h2–h6 font override block (lines 2389–2394)

- **Context:** The block at lines 2389–2394 overrides h2–h6 font-family, letter-spacing, and font-stretch for afterburner-pro, forcing GeistPixel onto headings. The Claudify h2–h6 rule at lines 2376–2382 (Poppins, normal spacing, 100% stretch, warm cream color) is declared just above but loses because the afterburner-pro block is later at equal specificity.
- **Logic:** Delete the entire afterburner-pro h2–h6 rule block (selector lines 2389–2390 + declaration block lines 2391–2394). Claudify's rule at 2376–2382 then takes effect.
- **Implementation:** Remove these exact lines:
  ```css
  body.theme-afterburner-pro #markdown-preview h2, body.theme-afterburner-pro #markdown-preview h3, body.theme-afterburner-pro #markdown-preview h4, body.theme-afterburner-pro #markdown-preview h5, body.theme-afterburner-pro #markdown-preview h6,
  body.theme-afterburner-pro #markdown-preview-tickets h2, body.theme-afterburner-pro #markdown-preview-tickets h3, body.theme-afterburner-pro #markdown-preview-tickets h4, body.theme-afterburner-pro #markdown-preview-tickets h5, body.theme-afterburner-pro #markdown-preview-tickets h6 {
      font-family: var(--display-font), var(--font-family);
      letter-spacing: var(--display-letter-spacing);
      font-stretch: var(--display-font-stretch);
  }
  ```
- **Edge Cases:** The afterburner-pro h1 color rule at lines 2384–2387 (`color: var(--accent-primary)`) must be PRESERVED — it sets the cyan accent on h1, which is correct. Do not remove it.

### `src/webview/design.html` — delete afterburner-pro h2–h6 font override block (lines 2414–2419)

- **Context:** Same pattern as planning.html. The block at lines 2414–2419 overrides h2–h6 for `#markdown-preview-briefs` and `#markdown-preview-design`. The Claudify h2–h6 rule at lines 2401–2407 (Poppins) is declared just above.
- **Logic:** Delete the entire afterburner-pro h2–h6 rule block. Claudify's rule at 2401–2407 takes effect.
- **Implementation:** Remove these exact lines:
  ```css
  body.theme-afterburner-pro #markdown-preview-briefs h2, body.theme-afterburner-pro #markdown-preview-briefs h3, body.theme-afterburner-pro #markdown-preview-briefs h4, body.theme-afterburner-pro #markdown-preview-briefs h5, body.theme-afterburner-pro #markdown-preview-briefs h6,
  body.theme-afterburner-pro #markdown-preview-design h2, body.theme-afterburner-pro #markdown-preview-design h3, body.theme-afterburner-pro #markdown-preview-design h4, body.theme-afterburner-pro #markdown-preview-design h5, body.theme-afterburner-pro #markdown-preview-design h6 {
      font-family: var(--display-font), var(--font-family);
      letter-spacing: var(--display-letter-spacing);
      font-stretch: var(--display-font-stretch);
  }
  ```
- **Edge Cases:** The afterburner-pro h1 color rule at lines 2409–2412 (`color: var(--accent-primary)`) must be PRESERVED.

### `src/webview/project.html` — delete afterburner-pro h2–h6 font override block (lines 894–901)

- **Context:** Same pattern. The block at lines 894–901 overrides h2–h6 for `#kanban-preview-content`, `#epics-preview-content`, `#constitution-preview-content`, and `#tuning-preview-content`. The Claudify h2–h6 rule at lines 877–885 (Poppins) is declared just above.
- **Logic:** Delete the entire afterburner-pro h2–h6 rule block. Claudify's rule at 877–885 takes effect.
- **Implementation:** Remove these exact lines:
  ```css
  body.theme-afterburner-pro #kanban-preview-content h2, body.theme-afterburner-pro #kanban-preview-content h3, body.theme-afterburner-pro #kanban-preview-content h4, body.theme-afterburner-pro #kanban-preview-content h5, body.theme-afterburner-pro #kanban-preview-content h6,
  body.theme-afterburner-pro #epics-preview-content h2, body.theme-afterburner-pro #epics-preview-content h3, body.theme-afterburner-pro #epics-preview-content h4, body.theme-afterburner-pro #epics-preview-content h5, body.theme-afterburner-pro #epics-preview-content h6,
  body.theme-afterburner-pro #constitution-preview-content h2, body.theme-afterburner-pro #constitution-preview-content h3, body.theme-afterburner-pro #constitution-preview-content h4, body.theme-afterburner-pro #constitution-preview-content h5, body.theme-afterburner-pro #constitution-preview-content h6,
  body.theme-afterburner-pro #tuning-preview-content h2, body.theme-afterburner-pro #tuning-preview-content h3, body.theme-afterburner-pro #tuning-preview-content h4, body.theme-afterburner-pro #tuning-preview-content h5, body.theme-afterburner-pro #tuning-preview-content h6 {
      font-family: var(--display-font), var(--font-family);
      letter-spacing: var(--display-letter-spacing);
      font-stretch: var(--display-font-stretch);
  }
  ```
- **Edge Cases:** The afterburner-pro h1 color rule at lines 887–892 (`color: var(--accent-primary)`) must be PRESERVED.

## Verification Plan

### Automated Tests

No automated tests — this is a pure CSS visual change. Verification is manual.

### Manual Verification

- [ ] Activate Afterburner Professional → h2–h6 render in Poppins (Claudify's heading font), not GeistPixel.
- [ ] Activate Afterburner Professional → h1 still renders in GeistPixel with cyan color (h1 rule preserved).
- [ ] Activate Claudify → h2–h6 unchanged (still Poppins, warm cream).
- [ ] Activate Afterburner (plain) → h2–h6 still use GeistPixel (cyber-theme-enabled rules, not touched).
- [ ] Grep confirms no remaining `theme-afterburner-pro` + `h2`/`h6` + `font-family` override blocks in `src/webview/`.

## Recommendation

**Send to Intern** — Complexity 2: three identical CSS block deletions with exact line numbers provided. No logic, no dependencies, no edge cases beyond "don't touch the h1 rule above each block."
