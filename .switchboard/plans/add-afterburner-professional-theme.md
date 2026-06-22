# Add "Afterburner Professional" Theme (Claudify layout + Afterburner cyan accent)

## Goal

Add a third Switchboard theme, **Afterburner Professional**, that is the Claudify theme with every terracotta accent swapped for Afterburner's cyan/teal. It keeps Claudify's "professional" treatment (neutral grey chrome, gradient cards, no glow, accent only on active/selected/click) but recolours the accent from terracotta `#D97757` to Afterburner cyan `#00e5ff`. It must be selectable from the Setup → Theme tab alongside Afterburner and Claudify.

### Problem Analysis

The theme system has three coordinated layers, all of which must learn about the new theme:

1. **Config + enum** — `switchboard.theme.name` (package.json) is a string enum: currently `afterburner`, `claudify`. Default `afterburner`.
2. **First-paint body class** — `src/services/themeBodyClass.ts` `getThemeBodyClass()` maps the config value → a `<body>` class string, injected at HTML-generation time to prevent the flash-of-afterburner. Today: `afterburner → cyber-theme-enabled (+ cyber-animation-disabled)`, `claudify → theme-claudify`, else `''`.
3. **Runtime body-class swap** — each panel re-themes live (no reload) when `switchboardThemeChanged` / `setThemeSetting` fires. The per-panel handlers add/remove body classes directly:
   - `planning.js` ~2210–2220, `design.js` ~3117–3124, `project.js` ~107+, and the `kanban.html` inline handler.
   - `setup.html` ~4019–4029 uses a **generic** `document.body.classList.add(\`theme-${theme}\`)` for any non-afterburner theme and only ever removes `theme-claudify` (it never touches `cyber-theme-enabled`). This generic pattern is the main wiring hazard — see Complex/Risky.
4. **Setup UI** — `setup.html` ~1147–1153: two radio inputs `name="theme-selection"` (`afterburner`, `claudify`). Change → `postMessage({type:'setThemeSetting', theme})`.

The CSS lives as `body.theme-claudify …` rules across **six** webview files: `kanban.html`, `planning.html`, `design.html`, `project.html`, `implementation.html`, `setup.html`.

## Approach — dual-class (recommended): `theme-claudify theme-afterburner-pro`

Rather than duplicating the entire Claudify rule set with the colour swapped (heavy, drift-prone) or appending `, body.theme-afterburner-pro .X` to every Claudify selector (touches every rule), give the body **both** classes for this theme: `theme-claudify theme-afterburner-pro`.

- Every existing `body.theme-claudify …` rule applies as-is → the full Claudify layout comes for free.
- A small `body.theme-afterburner-pro { … }` accent var block, declared **after** the Claudify var block, overrides only the accent family to cyan. Equal specificity (`(0,1,1)`), later-declared wins.
- A handful of Claudify rules hardcode terracotta **literals** (not the `--accent-*` vars) and need explicit `body.theme-afterburner-pro .X` overrides (also later-declared, equal specificity `(0,2,1)`, wins).

This means: **no existing Claudify rule is edited** — afterburner-pro is purely additive (one var block + a few literal overrides per file).

### Accent values (cyan, from Afterburner's `:root`)
```
body.theme-afterburner-pro {
    --accent-primary: #00e5ff;
    --accent-teal: #00e5ff;
    --accent-cyan: #00e5ff;
    --accent-teal-dim: color-mix(in srgb, #00e5ff 40%, transparent);
    --accent-teal-bright: #5ce8e6;
    --glow-teal: none;           /* professional = no glow, like claudify */
}
```
`--text-*`, `--border-*`, and the grid surface are inherited from `theme-claudify` (body still carries that class), so they need NOT be redeclared.

### Hardcoded-terracotta literals that need an afterburner-pro override
Found by grepping the Claudify-scoped rules for `#D97757`, `#E2A188`, and the terracotta filter recipe. Known cases:
- **kanban.html** — the icon **click-flash** filter (`body.theme-claudify .…flash img { filter: brightness(0) … hue-rotate(330deg) … }`, the terracotta recipe). Override: since the source PNGs are *already cyan*, afterburner-pro can skip the rebuild entirely — `filter: brightness(1.1) saturate(1.1);` shows the original cyan, brightened. No cyan filter-recipe guesswork needed.
- **kanban.html** — `.worktree-primary-btn` background `color-mix(in srgb, #D97757 12%/25%, transparent)`. Override to `var(--accent-primary)` (now cyan) or `#00e5ff`.
- **planning.html / design.html / project.html** — markdown preview `h1 { color: #D97757; }`. Override to `var(--accent-primary)`.
- **Catch-all step:** before finishing, `grep -n "#D97757\|#E2A188" src/webview/*.html` and confirm every remaining hit is either inside a `theme-claudify` *var block* (fine — overridden) or has an afterburner-pro override. Anything else is a missed literal.

The grey/neutral literals Claudify uses (`#8a8a8a`, `#8c8c8c`, `#b8b8b8`, `#e0e0e0`, the `#ffffff N%` card gradients, the `brightness(0) invert(55/72%)` grey icon filters, the `#1F1C1A` grid surface, `#333333/#555555` borders) are theme-independent and shared as-is.

## Files to Change

- **package.json** — add `afterburner-professional` to the `switchboard.theme.name` enum + a matching `enumDescriptions` entry. (Keep default `afterburner`.)
- **src/services/themeBodyClass.ts** — `getThemeBodyClass()`: add `if (theme === 'afterburner-professional') return 'theme-claudify theme-afterburner-pro';`. (Note: `applyThemeBodyClass` already preserves multi-class strings — it writes the whole string verbatim.)
- **6 webview CSS files** — add the `body.theme-afterburner-pro { …cyan accent… }` block immediately after each file's `body.theme-claudify { … }` var block; add the literal overrides listed above (kanban: 2; planning/design/project: 1 each).
- **Font overrides (planning/design/project)** — add `body.theme-afterburner-pro #…h2…h6 { font-family: var(--display-font), var(--font-family); }` covering each file's preview-pane id variants, to replace Poppins with the Afterburner pixel font (see "Fonts").
- **setup.html UI** — add a third radio: `<input type="radio" name="theme-selection" value="afterburner-professional"> <span>Afterburner Professional</span>`.
- **Runtime class swap (the wiring hazard)** — replace the ad-hoc add/remove logic in **each** handler (`setup.html` ~4025, `planning.js` ~2210, `design.js` ~3117, `project.js` ~107, `kanban.html` inline) with explicit, mutually-exclusive base handling:
  - `afterburner` → add `cyber-theme-enabled` (+ `cyber-animation-disabled` if set), remove `theme-claudify`, `theme-afterburner-pro`.
  - `claudify` → add `theme-claudify`, remove `cyber-theme-enabled`, `theme-afterburner-pro`.
  - `afterburner-professional` → add `theme-claudify` **and** `theme-afterburner-pro`, remove `cyber-theme-enabled`.
  - The current `setup.html` generic `theme-${theme}` line MUST be removed — for this theme it would wrongly produce a single `theme-afterburner-professional` class that no CSS targets.

## Metadata

**Complexity:** 5
**Tags:** frontend, theme, css, webview, setup

## Resolved Decisions (confirmed)

1. ✅ Config value **`afterburner-professional`** (kebab), display name **"Afterburner Professional"**.
2. ✅ Accent is plain Afterburner cyan `#00e5ff` / bright `#5ce8e6`. **Glow stays OFF** — this is Claudify's flat layout, not the cyber overlay.
3. ✅ Icon click-flash shows the original cyan PNG (brightened), not a recomputed tint.
4. ✅ **Use the Afterburner fonts, not the Claude fonts** — see "Fonts" below.

## Fonts (use Afterburner's, drop Poppins)

Font architecture as it stands:
- **Afterburner** renders markdown-preview headings h1–h6 in `var(--display-font)` (**GeistPixel**, the pixel font) — set by the `body.cyber-theme-enabled #markdown-preview h1…h6 { font-family: var(--display-font), var(--font-family); }` rule. Body text is `--font-family` (**Hanken Grotesk**).
- **Claudify** keeps GeistPixel for **h1** but overrides **h2–h6** to **Poppins** (+ warm cream), and pulls Poppins from a Google Fonts `@import`.

So **Poppins is the only Claude-specific font.** GeistPixel is Afterburner's own display font, and Hanken Grotesk is Afterburner's body font — both stay.

Because Afterburner Pro carries `theme-claudify` (dual-class) but **not** `cyber-theme-enabled`, it inherits Claudify's Poppins h2–h6 rule and does **not** get Afterburner's `var(--display-font)` heading rule. Therefore Afterburner Pro must:
- Override the Claudify **h2–h6** markdown-heading rule's `font-family` back to `var(--display-font), var(--font-family)` (GeistPixel) — i.e. remove Poppins — in `planning.html`, `design.html`, `project.html` (cover all the preview-pane id variants the Claudify rule lists: `#markdown-preview`, `#markdown-preview-tickets`, `#markdown-preview-briefs`, `#markdown-preview-design`, `#epics-preview-content`, `#constitution-preview-content`, `#tuning-preview-content`).
- **h1** font already resolves to GeistPixel via the Claudify h1 rule, so only its **colour** changes (→ cyan, see literal overrides). No font change needed for h1.
- h2–h6 **colour** (Claudify's warm cream `#F0EBE6`): out of scope of "fonts." Leave as-is for now unless it reads wrong against cyan — flag if so.
- The Poppins `@import` can stay in the files (harmless); Afterburner Pro simply stops referencing Poppins.

## Complexity Audit

### Routine
- Adding the enum value + radio + `getThemeBodyClass` branch.
- Adding one cyan var block per file after the existing Claudify var block.
- The 5 literal overrides (kanban ×2, planning/design/project ×1).

### Complex / Risky
- **Runtime class management is the real risk.** Five separate handlers manage body classes inconsistently today (setup uses a generic `theme-${theme}`; the panels use explicit names; setup never removes `cyber-theme-enabled`). They must all be made to treat the three themes as a mutually-exclusive *base* and apply the dual class for afterburner-pro. Missing one handler = that panel renders the wrong theme until reload. A shared helper (e.g. extend `themeBodyClass.ts` with an exported `THEME_BODY_CLASSES` map the webviews can mirror) would prevent drift, but the webviews are plain inline JS with no shared import — so the map has to be duplicated carefully or the handlers kept in lockstep.
- **Specificity/order of the var block.** `body.theme-afterburner-pro` and `body.theme-claudify` are equal specificity `(0,1,1)`; the cyan block only wins if declared *after* the Claudify block in each file. Placing it immediately after is required.
- **Missed terracotta literals.** Any Claudify rule that hardcodes `#D97757`/`#E2A188` (rather than `var(--accent-*)`) stays terracotta under afterburner-pro unless explicitly overridden. The grep catch-all step is mandatory, not optional.
- **`applyThemeBodyClass` regex** already strips and rewrites the whole `class="…"`, so a two-class string is fine on first paint — but verify the `cyber-animation-disabled` composition still only attaches to plain afterburner.

## Edge-Case & Dependency Audit

- **First-paint vs runtime parity:** `getThemeBodyClass()` (first paint) and the per-panel runtime swap must produce the *same* class set for afterburner-professional, or the theme will visibly change on the first `switchboardThemeChanged` after load.
- **Setup panel self-theming:** `setup.html` both *hosts* the theme picker and *is* a themed panel; its own runtime swap must apply afterburner-pro to itself correctly (the generic-line removal covers this).
- **Migration:** existing users on `afterburner`/`claudify` are unaffected (additive enum, default unchanged).
- **Security / side effects:** none — pure presentation; no new inputs, services, or persisted state beyond the existing `theme.name` value.
- **No dist concerns** — source-only change (per project convention, webviews are read from source).

## Verification

- Select each of the three themes in Setup → Theme; confirm live switch (no reload) on Kanban, Planning, Design, Project, Implementation, Setup.
- On afterburner-professional: chrome is neutral grey (like Claudify), but every terracotta accent (selected-card outline, active tab, count badges' would-be accent, grid lines, markdown h1, icon click-flash, worktree button) is **cyan**, with **no glow**.
- On afterburner-professional: markdown-preview headings h1–h6 render in the **GeistPixel pixel font** (matching Afterburner) — **no Poppins** anywhere. `grep` the rendered panel or confirm no h2–h6 falls back to Poppins.
- Reload each panel and confirm no flash-of-wrong-theme (first-paint class matches runtime).
- `grep -n "#D97757\|#E2A188" src/webview/*.html` → every hit is inside a `theme-claudify` var block or has an afterburner-pro override.
- Toggle afterburner ↔ afterburner-professional repeatedly; confirm `cyber-theme-enabled` is fully removed/added and never coexists with `theme-afterburner-pro`.
