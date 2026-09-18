# Add "Afterburner Professional" Theme (Claudify layout + Afterburner cyan accent)

## Goal

Add a third Switchboard theme, **Afterburner Professional**, that is the Claudify theme with every terracotta accent swapped for Afterburner's cyan/teal. It keeps Claudify's "professional" treatment (neutral grey chrome, gradient cards, no glow, accent only on active/selected/click) but recolours the accent from terracotta `#D97757` to Afterburner cyan `#00e5ff`. It must be selectable from the Setup → Theme tab alongside Afterburner and Claudify.

### Problem Analysis

The theme system has three coordinated layers, all of which must learn about the new theme:

1. **Config + enum** — `switchboard.theme.name` (package.json, line 668) is a string enum: currently `afterburner`, `claudify`. Default `afterburner`.
2. **First-paint body class** — `src/services/themeBodyClass.ts` `getThemeBodyClass()` (line 14) maps the config value → a `<body>` class string, injected at HTML-generation time to prevent the flash-of-afterburner. Today: `afterburner → cyber-theme-enabled (+ cyber-animation-disabled)`, `claudify → theme-claudify`, else `''`.
3. **Runtime body-class swap** — each panel re-themes live (no reload) when `switchboardThemeChanged` / `setThemeSetting` fires. The per-panel handlers add/remove body classes directly. There are **SIX** handlers, not five:
   - `planning.js` lines 2207–2223 (`handleThemeChanged`)
   - `design.js` lines 3146–3160 (inline `case 'switchboardThemeChanged'`)
   - `project.js` lines 105–116 (`handleThemeChanged`)
   - `kanban.html` inline handler lines 5867–5882
   - `setup.html` lines 4027–4040 (inline `case 'switchboardThemeChanged'`)
   - `implementation.html` lines 2440–2447 (inline `case 'switchboardThemeChanged'`) — **MISSED in original plan; see below**
   - `setup.html` lines 4027–4040 uses a **generic** `document.body.classList.add(\`theme-${theme}\`)` for any non-afterburner theme and only ever removes `theme-claudify` (it never touches `cyber-theme-enabled`). `implementation.html` lines 2440–2447 has the **same generic pattern** plus it never manages `cyber-theme-enabled` at all. These two generic patterns are the main wiring hazards — see Complex/Risky.
4. **Setup UI** — `setup.html` lines 1146–1153: two radio inputs `name="theme-selection"` (`afterburner`, `claudify`). Change → `postMessage({type:'setThemeSetting', theme})`.

The CSS lives as `body.theme-claudify …` rules across **six** webview files: `kanban.html`, `planning.html`, `design.html`, `project.html`, `implementation.html`, `setup.html`.

### implementation.html handler — the critical miss (added during plan review)

The original plan listed five runtime handlers but **implementation.html has a sixth** (lines 2440–2447):

```js
case 'switchboardThemeNameSetting':
case 'switchboardThemeChanged': {
    document.body.classList.remove('theme-claudify');
    if (message.theme && message.theme !== 'afterburner') {
        document.body.classList.add(`theme-${message.theme}`);
    }
    break;
}
```

This has **two bugs** that the new theme exposes:
1. Same generic `theme-${message.theme}` pattern as setup.html — for `afterburner-professional` it produces `theme-afterburner-professional`, a class no CSS targets. The panel would render unstyled.
2. It **never manages `cyber-theme-enabled`** — unlike the other four panel handlers. Switching from afterburner → afterburner-professional in the implementation panel would leave `cyber-theme-enabled` permanently stuck on, producing cyber scanlines + claudify layout + cyan accents simultaneously.

This handler MUST be fixed with the same mutually-exclusive base logic as the other five, AND `cyber-theme-enabled` management must be added (which also fixes the pre-existing bug for claudify).

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

### Per-file accent block notes (added during plan review)

The accent block above is a template. Different files have different Claudify var sets — the block should be placed after each file's `body.theme-claudify { … }` block, and the following per-file details apply:

- **All 6 files:** `--accent-primary`, `--accent-teal`, `--accent-teal-dim`, `--accent-teal-bright`, `--glow-teal` are overridden. These are the essential vars.
- **implementation.html only:** Also requires `--accent-cyan: #00e5ff` — Claudify sets `--accent-cyan: #D97757` (line 49) and it is consumed by **base** (non-cyber-scoped) rules: `.mini-action-btn.is-active` (line 719), `.secondary-btn.is-cyan` (line 880), `.markdown-body a` (line 1347). Without this override, these elements stay terracotta. The other 5 files don't define `--accent-cyan` in their Claudify block, so including it is harmless but unnecessary there.
- **implementation.html only:** Claudify sets warm-tinted borders `--border-color: #38332E`, `--border-bright: #5C544A` (lines 60-61), unlike the other files' neutral `#333333`/`#555555`. Afterburner-pro inherits these warm borders from Claudify. This is **intentional** — afterburner-pro is "Claudify layout + cyan accent", and the warm border is part of Claudify's layout. No override needed.
- **planning.html, design.html, project.html:** Claudify sets `--accent-neon: #D97757` (planning line 100, design line 101, project line 79). The afterburner-pro accent block does NOT override it. This is a **verified non-issue**: `--accent-neon` is only consumed by `body.cyber-theme-enabled`-scoped rules (planning.html lines 339-342, design.html lines 353-356 and 3519-3520), and afterburner-pro does not carry `cyber-theme-enabled`. The terracotta value is dead code under this theme. Documented here so the implementer does not waste time worrying about it.

### Hardcoded-terracotta literals that need an afterburner-pro override
Found by grepping the Claudify-scoped rules for `#D97757`, `#E2A188`, and the terracotta filter recipe. Known cases (verified against actual source):
- **kanban.html** — the icon **click-flash** filter (`body.theme-claudify .…flash img { filter: brightness(0) … hue-rotate(330deg) … }`, line 93, the terracotta recipe). Override: since the source PNGs are *already cyan*, afterburner-pro can skip the rebuild entirely — `filter: brightness(1.1) saturate(1.1);` shows the original cyan, brightened. No cyan filter-recipe guesswork needed.
- **kanban.html** — `.worktree-primary-btn` background `color-mix(in srgb, #D97757 12%/25%, transparent)` (lines 58-59). Override to `color-mix(in srgb, var(--accent-primary) 12%, transparent)` and `:hover` to `25%` — **preserve the 12%/25% opacity mix**, do NOT replace with full-opacity `#00e5ff` (would be visually jarring). The `--accent-primary` var is already cyan via the afterburner-pro var block.
- **planning.html** — markdown preview `h1 { color: #D97757; }` (line 2357). Override to `var(--accent-primary)`.
- **design.html** — markdown preview `h1 { color: #D97757; }` (line 2389). Override to `var(--accent-primary)`.
- **project.html** — markdown preview `h1 { color: #D97757; }` (line 822). Override to `var(--accent-primary)`.
- **Catch-all step (BLOCKING GATE):** before finishing, `grep -n "#D97757\|#E2A188" src/webview/*.html` and confirm every remaining hit is either inside a `theme-claudify` *var block* (fine — overridden) or has an afterburner-pro override. Anything else is a missed literal. **Do not ship until this grep is clean.**

The grey/neutral literals Claudify uses (`#8a8a8a`, `#8c8c8c`, `#b8b8b8`, `#e0e0e0`, the `#ffffff N%` card gradients, the `brightness(0) invert(55/72%)` grey icon filters, the `#1F1C1A` grid surface, `#333333/#555555` borders) are theme-independent and shared as-is.

## Files to Change

- **package.json** (line 668-677) — add `afterburner-professional` to the `switchboard.theme.name` enum + a matching `enumDescriptions` entry. (Keep default `afterburner`.)
- **src/services/themeBodyClass.ts** (line 14-25) — `getThemeBodyClass()`: add `if (theme === 'afterburner-professional') return 'theme-claudify theme-afterburner-pro';`. (Note: `applyThemeBodyClass` already preserves multi-class strings — it writes the whole string verbatim.)
- **6 webview CSS files** — add the `body.theme-afterburner-pro { …cyan accent… }` block immediately after each file's `body.theme-claudify { … }` var block; add the literal overrides listed above (kanban: 2; planning/design/project: 1 each). implementation.html and setup.html need no literal overrides (all their `#D97757` hits are inside the var block).
- **Font overrides (planning/design/project)** — add `body.theme-afterburner-pro #…h2…h6 { font-family: var(--display-font), var(--font-family); }` covering each file's preview-pane id variants, to replace Poppins with the Afterburner pixel font (see "Fonts").
- **setup.html UI** (lines 1146-1153) — add a third radio: `<input type="radio" name="theme-selection" value="afterburner-professional"> <span>Afterburner Professional</span>`.
- **Runtime class swap (the wiring hazard) — SIX handlers, not five** — replace the ad-hoc add/remove logic in **each** handler with explicit, mutually-exclusive base handling:
  - `setup.html` lines 4033-4037
  - `planning.js` lines 2210-2222
  - `design.js` lines 3151-3159
  - `project.js` lines 107-115
  - `kanban.html` inline lines 5870-5879
  - `implementation.html` lines 2442-2445 (**added during plan review — was missing from original plan**)
  
  Each handler must apply:
  - `afterburner` → add `cyber-theme-enabled` (+ `cyber-animation-disabled` if set), remove `theme-claudify`, `theme-afterburner-pro`.
  - `claudify` → add `theme-claudify`, remove `cyber-theme-enabled`, `theme-afterburner-pro`.
  - `afterburner-professional` → add `theme-claudify` **and** `theme-afterburner-pro`, remove `cyber-theme-enabled`.
  - The current `setup.html` generic `theme-${theme}` line (line 4036) MUST be removed — for this theme it would wrongly produce a single `theme-afterburner-professional` class that no CSS targets.
  - The current `implementation.html` generic `theme-${message.theme}` line (line 2444) MUST be removed for the same reason.
  - **implementation.html additionally needs `cyber-theme-enabled` management added** — it currently never adds or removes it, which is a pre-existing bug that the new theme makes visible. The fix brings it in line with the other four panel handlers.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, feature

## User Review Required

- [ ] Confirm the display name "Afterburner Professional" and config value `afterburner-professional`.
- [ ] Confirm that warm-tinted borders (`#38332E`/`#5C544A`) inherited from Claudify in implementation.html are acceptable for afterburner-pro (intentional per "Claudify layout" scope).
- [ ] Confirm that h2–h6 heading *colour* stays Claudify's warm cream `#F0EBE6` (out of scope for this plan; flag if it reads wrong against cyan).

## Complexity Audit

### Routine
- Adding the enum value + radio + `getThemeBodyClass` branch.
- Adding one cyan var block per file after the existing Claudify var block.
- The 5 literal overrides (kanban ×2, planning/design/project ×1).
- The font overrides (planning/design/project h2–h6 → GeistPixel).

### Complex / Risky
- **Runtime class management is the real risk.** **Six** separate handlers manage body classes inconsistently today (setup and implementation use a generic `theme-${theme}`; the other panels use explicit names; setup and implementation never remove `cyber-theme-enabled`). They must all be made to treat the three themes as a mutually-exclusive *base* and apply the dual class for afterburner-pro. Missing one handler = that panel renders the wrong theme until reload. A shared helper (e.g. extend `themeBodyClass.ts` with an exported `THEME_BODY_CLASSES` map the webviews can mirror) would prevent drift, but the webviews are plain inline JS with no shared import — so the map has to be duplicated carefully or the handlers kept in lockstep.
- **implementation.html handler was missing from the original plan.** It has the same generic `theme-${theme}` bug as setup.html AND lacks `cyber-theme-enabled` management entirely. Both must be fixed.
- **Specificity/order of the var block.** `body.theme-afterburner-pro` and `body.theme-claudify` are equal specificity `(0,1,1)`; the cyan block only wins if declared *after* the Claudify block in each file. Placing it immediately after is required.
- **Missed terracotta literals.** Any Claudify rule that hardcodes `#D97757`/`#E2A188` (rather than `var(--accent-*)`) stays terracotta under afterburner-pro unless explicitly overridden. The grep catch-all step is a **blocking gate**, not optional.
- **`applyThemeBodyClass` regex** already strips and rewrites the whole `class="…"`, so a two-class string is fine on first paint — but verify the `cyber-animation-disabled` composition still only attaches to plain afterburner.

## Edge-Case & Dependency Audit

- **First-paint vs runtime parity:** `getThemeBodyClass()` (first paint) and the per-panel runtime swap must produce the *same* class set for afterburner-professional, or the theme will visibly change on the first `switchboardThemeChanged` after load.
- **Setup panel self-theming:** `setup.html` both *hosts* the theme picker and *is* a themed panel; its own runtime swap must apply afterburner-pro to itself correctly (the generic-line removal covers this).
- **implementation.html `cyber-theme-enabled` leak:** pre-existing bug — implementation.html's handler never removes `cyber-theme-enabled` when switching away from afterburner. The new theme makes this visible. Fix is part of the handler rewrite.
- **Migration:** existing users on `afterburner`/`claudify` are unaffected (additive enum, default unchanged).
- **Security / side effects:** none — pure presentation; no new inputs, services, or persisted state beyond the existing `theme.name` value.
- **No dist concerns** — source-only change (per project convention, webviews are read from source).
- **`--accent-neon` non-issue:** Claudify sets `--accent-neon: #D97757` in planning/design/project, but it is only consumed by `cyber-theme-enabled`-scoped rules, which afterburner-pro does not carry. Verified harmless — no override needed.
- **`updateAnimationSectionVisibility` in setup.html:** already correct for the new theme — it hides the animation settings section for any theme !== `afterburner`, so afterburner-professional will correctly hide it. No change needed.

## Dependencies

- None — this is a self-contained additive feature.

## Adversarial Synthesis

Key risks: (1) the implementation.html runtime handler was missing from the original plan and has both the generic-class bug and a missing `cyber-theme-enabled` management; (2) runtime handler drift across six independent inline-JS handlers could leave a panel on the wrong theme; (3) missed terracotta literals produce visual inconsistency. Mitigations: exhaustive handler enumeration (six, verified against source), blocking grep gate for literals, and per-file accent block clarification noting which vars matter where.

## Proposed Changes

### package.json (lines 668-677)
- **Context:** The `switchboard.theme.name` setting is a string enum that drives `getThemeBodyClass()` and the setup radio buttons.
- **Logic:** Add `"afterburner-professional"` to the `enum` array and a matching `enumDescriptions` entry: `"Afterburner Professional — Claudify layout with Afterburner cyan accent and GeistPixel headings"`.
- **Implementation:** Insert after `"claudify"` in both arrays. Keep `"default": "afterburner"`.
- **Edge Cases:** Existing users with `afterburner` or `claudify` are unaffected — additive enum, no migration needed.

### src/services/themeBodyClass.ts (lines 14-25)
- **Context:** `getThemeBodyClass()` maps the config theme to a body class string for first-paint injection.
- **Logic:** Add a branch: `if (theme === 'afterburner-professional') return 'theme-claudify theme-afterburner-pro';`
- **Implementation:** Insert between the `claudify` branch (line 21-23) and the fallback `return ''` (line 24).
- **Edge Cases:** `applyThemeBodyClass` (line 32-38) writes the class string verbatim via regex replacement, so multi-class strings work. Verify `cyber-animation-disabled` is NOT attached (it should only compose with plain afterburner).

### setup.html — UI radio (lines 1146-1153)
- **Context:** The Theme Selection subsection has two radio buttons.
- **Logic:** Add a third radio: `<input type="radio" name="theme-selection" value="afterburner-professional"> <span>Afterburner Professional</span>`.
- **Implementation:** Insert after the Claudify label (line 1150-1152), before the closing `</div>` (line 1153).
- **Edge Cases:** The existing `document.querySelectorAll('input[name="theme-selection"]')` change listener (line 3751) automatically picks up the new radio. `updateAnimationSectionVisibility` (line 1625) already hides the animation section for non-afterburner themes.

### setup.html — runtime handler (lines 4027-4040)
- **Context:** The `switchboardThemeChanged` / `switchboardThemeNameSetting` handler currently uses a generic `theme-${theme}` pattern.
- **Logic:** Replace with explicit mutually-exclusive base handling.
- **Implementation:**
  ```js
  document.body.classList.remove('theme-claudify', 'theme-afterburner-pro', 'cyber-theme-enabled');
  if (theme === 'afterburner') {
      document.body.classList.add('cyber-theme-enabled');
      // cyber-animation-disabled is managed separately by the cyberAnimationSetting handler
  } else if (theme === 'claudify') {
      document.body.classList.add('theme-claudify');
  } else if (theme === 'afterburner-professional') {
      document.body.classList.add('theme-claudify', 'theme-afterburner-pro');
  }
  ```
- **Edge Cases:** Remove the generic `theme-${theme}` line (line 4036). The `cyber-animation-disabled` class is managed by the separate `cyberAnimationSetting` message handler, not here.

### planning.js — runtime handler (lines 2207-2223)
- **Context:** `handleThemeChanged(theme)` manages body classes for the planning panel.
- **Logic:** Add `theme-afterburner-pro` to the remove list; add the dual-class branch.
- **Implementation:**
  ```js
  function handleThemeChanged(theme) {
      if (theme) { state.switchboardTheme = theme; }
      document.body.classList.remove('theme-claudify', 'theme-afterburner-pro');
      if (state.switchboardTheme === 'afterburner') {
          document.body.classList.add('cyber-theme-enabled');
      } else {
          document.body.classList.remove('cyber-theme-enabled');
      }
      if (state.switchboardTheme === 'claudify') {
          document.body.classList.add('theme-claudify');
      } else if (state.switchboardTheme === 'afterburner-professional') {
          document.body.classList.add('theme-claudify', 'theme-afterburner-pro');
      }
  }
  ```
- **Edge Cases:** None beyond the standard parity requirement.

### design.js — runtime handler (lines 3146-3160)
- **Context:** Inline `case 'switchboardThemeChanged'` handler, mirrors planning.js.
- **Logic:** Same changes as planning.js `handleThemeChanged`.
- **Implementation:** Replace lines 3151-3159 with the same explicit logic (remove `theme-claudify` + `theme-afterburner-pro`, then add the correct set).
- **Edge Cases:** None.

### project.js — runtime handler (lines 105-116)
- **Context:** `handleThemeChanged(theme)` manages body classes for the project panel.
- **Logic:** Same changes as planning.js.
- **Implementation:** Replace lines 107-115 with the same explicit logic.
- **Edge Cases:** None.

### kanban.html — runtime handler (lines 5867-5882)
- **Context:** Inline `case 'switchboardThemeChanged'` handler.
- **Logic:** Same changes as the other panel handlers.
- **Implementation:** Replace lines 5870-5879 with the same explicit logic (remove `theme-claudify` + `theme-afterburner-pro` + `cyber-theme-enabled`, then add the correct set).
- **Edge Cases:** None.

### implementation.html — runtime handler (lines 2440-2447) — ADDED during plan review
- **Context:** Inline `case 'switchboardThemeChanged'` handler. Currently uses generic `theme-${message.theme}` AND never manages `cyber-theme-enabled`.
- **Logic:** Replace with the same explicit mutually-exclusive base handling as the other panels, AND add `cyber-theme-enabled` management (fixing the pre-existing bug).
- **Implementation:**
  ```js
  case 'switchboardThemeNameSetting':
  case 'switchboardThemeChanged': {
      if (message.theme) {
          document.body.classList.remove('theme-claudify', 'theme-afterburner-pro', 'cyber-theme-enabled');
          if (message.theme === 'afterburner') {
              document.body.classList.add('cyber-theme-enabled');
          } else if (message.theme === 'claudify') {
              document.body.classList.add('theme-claudify');
          } else if (message.theme === 'afterburner-professional') {
              document.body.classList.add('theme-claudify', 'theme-afterburner-pro');
          }
      }
      break;
  }
  ```
- **Edge Cases:** This also fixes the pre-existing bug where switching from afterburner to claudify in the implementation panel left `cyber-theme-enabled` stuck on.

### 6 webview CSS files — accent var block
- **Context:** Each file has a `body.theme-claudify { … }` var block. The afterburner-pro block overrides the accent family to cyan.
- **Logic:** Add `body.theme-afterburner-pro { … }` immediately after each file's Claudify var block. Equal specificity, later-declared wins.
- **Implementation:** Place the accent block (see "Accent values" above) immediately after the closing `}` of each file's `body.theme-claudify { … }` block. For implementation.html, ensure `--accent-cyan: #00e5ff` is included (it's in the template block already).
- **Edge Cases:** `--accent-neon` is NOT overridden — verified harmless (only used in `cyber-theme-enabled`-scoped rules). See Per-file accent block notes.

### kanban.html — literal overrides (2)
- **Context:** Two Claudify rules hardcode terracotta literals.
- **Logic:** Override with cyan equivalents, preserving opacity.
- **Implementation:**
  ```css
  body.theme-afterburner-pro .worktree-primary-btn { background: color-mix(in srgb, var(--accent-primary) 12%, transparent); }
  body.theme-afterburner-pro .worktree-primary-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-primary) 25%, transparent); }
  body.theme-afterburner-pro .strip-icon-btn.flash img,
  body.theme-afterburner-pro .kanban-sub-bar .strip-icon-btn.flash img,
  body.theme-afterburner-pro .controls-strip .strip-icon-btn.flash img,
  body.theme-afterburner-pro .column-icon-btn.flash img,
  body.theme-afterburner-pro .column-header-btn.flash img,
  body.theme-afterburner-pro .mode-toggle.flash img,
  body.theme-afterburner-pro .complexity-routing-btn.flash img,
  body.theme-afterburner-pro .btn-add-plan.flash img {
      filter: brightness(1.1) saturate(1.1);
  }
  ```
  Place these after the corresponding Claudify rules (after line 59 for worktree, after line 94 for flash).
- **Edge Cases:** The flash override shows the original cyan PNGs brightened, avoiding cyan filter-recipe guesswork.

### planning.html / design.html / project.html — h1 colour override (1 each)
- **Context:** Claudify's h1 rule hardcodes `color: #D97757`.
- **Logic:** Override to `var(--accent-primary)` (now cyan via the var block).
- **Implementation:**
  ```css
  body.theme-afterburner-pro #markdown-preview h1,
  body.theme-afterburner-pro #markdown-preview-tickets h1 {
      color: var(--accent-primary);
  }
  ```
  (Adapt selectors per file: planning uses `#markdown-preview` + `#markdown-preview-tickets`; design uses `#markdown-preview-briefs` + `#markdown-preview-design`; project uses `#epics-preview-content` + `#constitution-preview-content` + `#tuning-preview-content`.) Place after each file's Claudify h1 rule.
- **Edge Cases:** h1 font-family already resolves to GeistPixel via the Claudify rule — only colour changes.

### planning.html / design.html / project.html — h2–h6 font override
- **Context:** Claudify overrides h2–h6 to Poppins. Afterburner-pro should use GeistPixel (Afterburner's display font).
- **Logic:** Override the Claudify h2–h6 font-family back to `var(--display-font), var(--font-family)`.
- **Implementation:**
  ```css
  body.theme-afterburner-pro #markdown-preview h2, body.theme-afterburner-pro #markdown-preview h3, body.theme-afterburner-pro #markdown-preview h4, body.theme-afterburner-pro #markdown-preview h5, body.theme-afterburner-pro #markdown-preview h6,
  body.theme-afterburner-pro #markdown-preview-tickets h2, body.theme-afterburner-pro #markdown-preview-tickets h3, body.theme-afterburner-pro #markdown-preview-tickets h4, body.theme-afterburner-pro #markdown-preview-tickets h5, body.theme-afterburner-pro #markdown-preview-tickets h6 {
      font-family: var(--display-font), var(--font-family);
      letter-spacing: var(--display-letter-spacing);
      font-stretch: var(--display-font-stretch);
  }
  ```
  (Adapt selectors per file — same id variants as the h1 override. For project.html, also include `#kanban-preview-content`.) Place after each file's Claudify h2–h6 rule.
- **Edge Cases:** h2–h6 *colour* stays Claudify's warm cream `#F0EBE6` — out of scope for this plan (flagged in User Review Required). The Poppins `@import` can stay in the files (harmless); afterburner-pro simply stops referencing Poppins.

## Verification Plan

### Automated Tests
- No automated tests required (pure CSS/presentation change; test suite will be run separately by the user).

### Manual Verification
- Select each of the three themes in Setup → Theme; confirm live switch (no reload) on Kanban, Planning, Design, Project, Implementation, Setup.
- On afterburner-professional: chrome is neutral grey (like Claudify), but every terracotta accent (selected-card outline, active tab, count badges' would-be accent, grid lines, markdown h1, icon click-flash, worktree button) is **cyan**, with **no glow**.
- On afterburner-professional: markdown-preview headings h1–h6 render in the **GeistPixel pixel font** (matching Afterburner) — **no Poppins** anywhere. `grep` the rendered panel or confirm no h2–h6 falls back to Poppins.
- Reload each panel and confirm no flash-of-wrong-theme (first-paint class matches runtime).
- **BLOCKING GATE:** `grep -n "#D97757\|#E2A188" src/webview/*.html` → every hit is inside a `theme-claudify` var block or has an afterburner-pro override. Do not ship until clean.
- Toggle afterburner ↔ afterburner-professional repeatedly; confirm `cyber-theme-enabled` is fully removed/added and never coexists with `theme-afterburner-pro`.
- **Specifically test the implementation panel:** toggle afterburner → afterburner-professional → claudify → afterburner and confirm no `cyber-theme-enabled` leak (scanlines should only appear on afterburner).

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
- Override the Claudify **h2–h6** markdown-heading rule's `font-family` back to `var(--display-font), var(--font-family)` (GeistPixel) — i.e. remove Poppins — in `planning.html`, `design.html`, `project.html` (cover all the preview-pane id variants the Claudify rule lists: `#markdown-preview`, `#markdown-preview-tickets`, `#markdown-preview-briefs`, `#markdown-preview-design`, `#epics-preview-content`, `#constitution-preview-content`, `#tuning-preview-content`, `#kanban-preview-content`).
- **h1** font already resolves to GeistPixel via the Claudify h1 rule, so only its **colour** changes (→ cyan, see literal overrides). No font change needed for h1.
- h2–h6 **colour** (Claudify's warm cream `#F0EBE6`): out of scope of "fonts." Leave as-is for now unless it reads wrong against cyan — flag if so.
- The Poppins `@import` can stay in the files (harmless); Afterburner Pro simply stops referencing Poppins.

---

**Recommendation:** Complexity is 5 → **Send to Coder**.

## Code Review Results (Reviewer Pass — 2026-06-22)

### Stage 1 — Grumpy Adversarial Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| 1 | **CRITICAL** | `src/webview/kanban.html:54-66` (pre-fix) | Afterburner-pro literal overrides (worktree button + icon click-flash filter) placed **before** the Claudify rules they override (worktree at 80-81, flash at 107-115). Equal specificity `(0,2,1)` → later-declared wins → Claudify terracotta overrides the cyan overrides. Worktree button and all icon click-flashes stay terracotta under afterburner-professional. The plan explicitly required placement after the Claudify rules. |
| 2 | NIT | All 6 files | `--glow-teal: none` redeclared in every afterburner-pro var block despite being inherited from `theme-claudify`. Harmless redundancy — defensive and self-documenting. No action. |
| 3 | NIT | `src/webview/implementation.html:70` | Afterburner-pro var block overrides `--glow-teal` but not `--glow-cyan`. Inherited from Claudify block (line 54). No issue. |

### Stage 2 — Balanced Synthesis

- **Finding #1 (CRITICAL):** Valid and fixed. The kanban.html worktree and flash overrides were placed immediately after the afterburner-pro var block (lines 54-66), before the Claudify rules at lines 80-81 and 107-115. Since the body carries both `theme-claudify` and `theme-afterburner-pro`, both rule sets match with equal specificity. The Claudify rules, being later in source order, won the cascade. Fix: moved the worktree override to after the Claudify worktree rules (now lines 69-71) and the flash override to after the Claudify flash rule (now lines 107-117).
- **Findings #2-3 (NIT):** No action needed — both are harmless redundancies that serve as defensive self-documentation.

### Fixes Applied

1. **`src/webview/kanban.html`** — Moved `body.theme-afterburner-pro .worktree-primary-btn` override (2 rules) from lines 54-55 to lines 69-71 (after Claudify worktree rules at 66-67). Moved `body.theme-afterburner-pro …flash img` override (8-selector block) from lines 57-66 to lines 107-117 (after Claudify flash rule at 97-106). Added clarifying comments noting the ordering requirement.

### Verification Results

- **Blocking-gate grep (`#D97757\|#E2A188`):** CLEAN — all 33 hits across 6 files are either inside `theme-claudify` var blocks (overridden by afterburner-pro var blocks) or have afterburner-pro overrides placed after the Claudify rules.
- **Terracotta filter recipe (`hue-rotate(330deg)`):** 1 hit at `kanban.html:105` (Claudify flash rule). Overridden by afterburner-pro flash at lines 107-117, now correctly placed after.
- **CSS var block ordering:** All 6 files place the `body.theme-afterburner-pro { … }` var block immediately after the `body.theme-claudify { … }` var block. ✅
- **Literal override ordering:** kanban worktree (69-71 after 66-67) ✅, kanban flash (107-117 after 97-106) ✅, planning h1/h2-h6 (2384-2394 after 2367-2382) ✅, design h1/h2-h6 (2409-2419 after 2392-2407) ✅, project h1/h2-h6 (844-858 after 823-842) ✅.
- **Runtime handlers (6/6):** All six handlers (setup.html, planning.js, design.js, project.js, kanban.html, implementation.html) use explicit mutually-exclusive base handling with `theme-afterburner-pro` in the remove list and the dual-class add for `afterburner-professional`. implementation.html `cyber-theme-enabled` management added. Generic `theme-${theme}` lines removed from setup.html and implementation.html. ✅
- **First-paint/runtime parity:** `getThemeBodyClass()` returns `'theme-claudify theme-afterburner-pro'` — matches the runtime handler output. ✅
- **Setup UI:** Third radio at setup.html:1174-1177 with correct value and label. `updateAnimationSectionVisibility` hides animation section for non-afterburner. ✅
- **package.json:** `afterburner-professional` added to enum + enumDescriptions. Default unchanged. ✅
- **Compilation/tests:** Skipped per session instructions.

### Files Changed During Review

- `src/webview/kanban.html` — moved 2 literal override blocks to correct cascade position (CRITICAL fix)

### Remaining Risks

- **Manual visual verification not performed** — the CSS cascade ordering is now correct by source-order analysis, but live rendering in a webview should confirm: (1) worktree button is cyan under afterburner-pro, (2) icon click-flash shows brightened cyan (not terracotta), (3) no Poppins in markdown headings, (4) no `cyber-theme-enabled` leak when toggling themes in the implementation panel.
- **h2-h6 colour** stays Claudify's warm cream `#F0EBE6` against cyan h1 — flagged in User Review Required. May need a follow-up if it reads wrong.
- **Warm-tinted borders in implementation.html** (`#38332E`/`#5C544A`) inherited from Claudify — intentional per plan, flagged in User Review Required.
