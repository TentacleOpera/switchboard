# Claudify theme: recolor feature (epic) cards from purple to gold

## Goal

In the Kanban board's **Claudify** theme, feature/epic cards are drawn with a purple accent (`#7c3aed`) — border, background tint, subtask label, and selection highlight. Against Claudify's Claude-terracotta accent (`#D97757`), that purple clashes badly. The same purple looks good in the **Afterburner** theme, so the fix must be **Claudify-only**: swap the purple for a warm **gold** that sits harmoniously beside the terracotta without competing with it, and leave Afterburner's purple untouched.

### Problem analysis & root cause

Feature cards get their identity color from two layers in `src/webview/kanban.html`:

**1. Base (theme-agnostic) rules — used by Afterburner, must stay purple:**

```css
/* src/webview/kanban.html:913-920 */
.feature-card {
    border-left: 4px solid #7c3aed;
    background: rgba(124, 58, 237, 0.06);
}
.feature-subtask-label {
    color: #7c3aed;
    font-weight: 700;
}
```
```css
/* src/webview/kanban.html:1389-1393 */
.kanban-card.feature-card.selected {
    border-color: #7c3aed;
    box-shadow: 0 0 8px color-mix(in srgb, #7c3aed 35%, transparent),
                inset 0 0 4px color-mix(in srgb, #7c3aed 10%, transparent);
}
```

**2. Claudify overrides (`!important`) — the clashing purple, must become gold:**

```css
/* src/webview/kanban.html:167-171 */
body.theme-claudify .kanban-card.feature-card,
body.theme-claudify .kanban-card.feature-card:hover {
    border-left: 4px solid #7c3aed !important;
    background: linear-gradient(180deg, color-mix(in srgb, #7c3aed 12%, var(--panel-bg2)) 0%, var(--panel-bg2) 100%) !important;
}
```
```css
/* src/webview/kanban.html:180-183 */
body.theme-claudify .kanban-card.feature-card.selected {
    border-color: #7c3aed !important;
    box-shadow: inset 0 0 0 1px #7c3aed !important;
}
```

**Root cause:** the Claudify overrides reuse the base purple (`#7c3aed`) verbatim. They already override the card border/background and the selection highlight — but they do **not** override `.feature-subtask-label` (`:917-920`), so under Claudify the subtask label still renders in raw purple. So there are two problems: (a) the Claudify overrides are purple and clash, and (b) the subtask label has no Claudify override at all and leaks the base purple.

**Fix shape:** change the three purple values in the existing Claudify overrides to gold, and **add** a Claudify override for `.feature-subtask-label` so the label is gold too. Do not touch the base rules — Afterburner keeps purple.

> **Clarification (theme model — added during review, no scope change):** "Afterburner" is **not** a CSS class. Afterburner is the *default* Switchboard theme; when it is active the board `<body>` carries `cyber-theme-enabled` (see the theme switch at `src/webview/kanban.html:6603-6604`, `if (msg.theme === 'afterburner') desired.add('cyber-theme-enabled')`). There is no `theme-afterburner` selector anywhere. The base `.feature-card` / `.feature-subtask-label` / `.kanban-card.feature-card.selected` rules are simply Afterburner's appearance *because nothing overrides them* — Claudify layers its `!important` overrides on top via `body.theme-claudify …`. Editing only the `body.theme-claudify …` selectors therefore leaves Afterburner (= the base rules) untouched. Do not go looking for a `theme-afterburner` class; it does not exist.

### Chosen gold

- Terracotta accent: `#D97757` (warm orange-red, hue ≈ 16°).
- Recommended gold: **`#D4A017`** (goldenrod, hue ≈ 45°, mid-saturation). It is clearly yellower than the terracotta so the two read as distinct, stays warm so it belongs in the Claudify palette, and has enough luminance to show as a 4px border and a low-opacity background mix on Claudify's dark panels. As *text* (the subtask label) it is higher-luminance than the old `#7c3aed`, so label legibility on the dark panel improves rather than regresses.
- The gold is stored **once** as a Claudify-scoped CSS variable (see Proposed Changes) and referenced from every Claudify feature declaration, so it can be tuned brighter/duller from a single line.

> **Superseded:** "Single hex to swap consistently across all four Claudify declarations; can be tuned in one place if the user wants it brighter/duller."
> **Reason:** Swapping the literal `#D4A017` into four declarations is not "one place" — it is four places, and the single-knob-tuning benefit the plan advertised does not actually exist that way. Claudify already expresses its whole palette as theme-scoped CSS custom properties in the same file (`body.theme-claudify { --accent-primary: …; --accent-teal: …; }` at `kanban.html:34-43`), so a raw literal is the *less* idiomatic choice here.
> **Replaced with:** Define one Claudify-scoped variable `--feature-accent: #D4A017;` in the existing `body.theme-claudify { … }` block and reference `var(--feature-accent)` in all four Claudify feature declarations. One edit point delivers the promised tunability and matches the block's existing convention. The base rules keep the literal `#7c3aed` (they define no such variable and must stay purple for Afterburner).

## Metadata

- **Tags:** ui, frontend

> **Superseded:** **Tags:** kanban, theming, claudify, css, features
> **Reason:** None of those tags are in the `improve-plan` allowed tag list — the importer only recognises the closed set (frontend, backend, ui, ux, bugfix, feature, refactor, …). Invented tags are dropped.
> **Replaced with:** `ui, frontend` — a webview CSS theming change.

- **Complexity:** 2/10
- **Files touched:** `src/webview/kanban.html`

## User Review Required

- **Gold color value — a taste call, not a blocker.** `#D4A017` is chosen with sound hue/luminance rationale (see Chosen gold), but color-on-dark-panel harmony is only truly judged by eye. It is now a single variable (`--feature-accent`), so after the build you can nudge it brighter/duller from one line without re-reading the plan. No decision is blocked on this — implement with `#D4A017` and tune if desired.
- Otherwise: **None.**

## Complexity Audit

### Routine
- Pure CSS in a single webview file (`src/webview/kanban.html`).
- Add one CSS variable to the existing Claudify variable block; change three purple literals to `var(--feature-accent)` in two existing Claudify rules; add one small new Claudify rule for the subtask label.
- No JS, no data model, no settings/state, no migration, no message-protocol change.
- Scope fully contained to `body.theme-claudify …` selectors, so no other theme (Afterburner / default) can regress.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is static CSS applied by theme class; there is no async state, no ordering dependency, and no runtime write.
- **Security:** None. No user input, no injection surface, no data flow — purely presentational color values.
- **Side Effects:**
  - **Afterburner must not change.** The base rules at `:913-920` and `:1389-1393` are theme-agnostic and are Afterburner's appearance (Afterburner is the default theme; body class `cyber-theme-enabled`, not a `theme-afterburner` selector — see the Clarification in Goal). Do **not** edit them. Only the `body.theme-claudify …` selectors change. Verify Afterburner feature cards are still purple after the edit.
  - **Green "completed" bar unaffected.** The completed bar (`:154-156`, `border-left: 3px solid var(--vscode-testing-iconPassed, #73c991)`) uses a separate green and its own selector; recoloring the feature accent does not touch it. A card that is both a feature and completed keeps green on the left edge per existing precedence.
  - **ULTRACODE glitch purple is intentionally out of scope.** `src/webview/kanban.html:1483-1484` (`@keyframes ucGlitch`) also contains `#7c3aed`, but it is a decorative text-shadow for the Afterburner-only ULTRACODE blast animation — not a feature-card color. It is deliberately **not** recolored. (Noted so the omission reads as intentional, not missed.)
- **Dependencies & Conflicts:**
  - **Subtask label leak.** `.feature-subtask-label` (`:917`) has no Claudify override today, so it currently shows base purple even under Claudify. Add a Claudify override for it, or the label stays purple and still clashes — a partial fix that would read as a bug. The label is rendered at `src/webview/kanban.html:5978` as `<span class="feature-subtask-label">FEATURE: N SUBTASKS</span>`, so it is always present on feature cards.
  - **Both card states covered.** Feature cards have a resting/hover rule (`:167-171`) and a selected rule (`:180-183`). Recolor both, or a selected feature card snaps back to purple on click. (When a card is both selected and hovered the two rules tie on specificity and set mostly different properties; with both recolored to the same gold there is no conflict.)
  - **`!important` specificity.** The Claudify overrides already carry `!important` to beat the base `.kanban-card` rules; keep `!important` on the recolored declarations so they still win. The new `.feature-subtask-label` override does **not** need `!important`: `body.theme-claudify .feature-subtask-label` (specificity 0,2,1) out-specifies the bare base `.feature-subtask-label` (0,1,0). The card-level `color: … !important` at `:151` does not win over the span's own direct rule either — an inherited `!important` value loses to a directly-matching declaration on the child. `!important` is harmless if added for consistency but is unnecessary.
  - **`color-mix()` with a variable is supported here.** Referencing `var(--feature-accent)` inside `color-mix(in srgb, var(--feature-accent) 12%, var(--panel-bg2))` is proven safe in this file — the base rule at `:1385` already uses `color-mix(in srgb, var(--accent-teal) 10%, transparent)`.
  - **Contrast on dark panel.** `#D4A017` at 12% mixed into `--panel-bg2` is a subtle tint (matching the current purple's subtlety); the 4px solid border carries the identity. Confirm the border is legible and the tint is visible but not garish.

## Dependencies

None — no upstream session work is required before this can be coded.

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) accidentally editing the base rules and regressing Afterburner's purple, (2) recoloring only the card and leaving the subtask label purple (a fix that *looks* done but isn't), and (3) missing the selected-card rule so selection snaps back to purple. Mitigations: change **only** `body.theme-claudify …` selectors; recolor the card rule, the selected rule, **and** add the label override; store the gold as one Claudify-scoped `--feature-accent` variable so all references stay consistent. Residual risk is purely aesthetic (is `#D4A017` the right gold), settled by a visual check and tunable from one line.

## Proposed Changes

### `src/webview/kanban.html` — recolor Claudify feature accents to gold

**Context:** Claudify's feature-card identity color lives in three `body.theme-claudify` declarations (resting/hover `:167-171`, selected `:180-183`) plus a missing label override; all reuse the base purple `#7c3aed`. Claudify's palette variables live in `body.theme-claudify { … }` at `:34-43`.

**Logic:** Introduce one Claudify-scoped variable holding the gold, point the existing purple declarations at it, and add the previously-missing label override so nothing under Claudify leaks base purple. Base rules are left alone so Afterburner stays purple.

**Implementation:**

**0. Add the gold variable** to the existing Claudify variable block (`:34-43`), e.g. after `--accent-teal-bright`:

```css
body.theme-claudify {
    /* …existing --accent-* vars… */
    --feature-accent: #D4A017;   /* gold: replaces base purple #7c3aed for feature/epic cards (Claudify only) */
}
```

**1. Resting/hover feature card (`:167-171`)** — replace both `#7c3aed` occurrences with `var(--feature-accent)`:

```css
body.theme-claudify .kanban-card.feature-card,
body.theme-claudify .kanban-card.feature-card:hover {
    border-left: 4px solid var(--feature-accent) !important;
    background: linear-gradient(180deg, color-mix(in srgb, var(--feature-accent) 12%, var(--panel-bg2)) 0%, var(--panel-bg2) 100%) !important;
}
```

**2. Selected feature card (`:180-183`)** — replace both `#7c3aed` occurrences with `var(--feature-accent)`:

```css
body.theme-claudify .kanban-card.feature-card.selected {
    border-color: var(--feature-accent) !important;
    box-shadow: inset 0 0 0 1px var(--feature-accent) !important;
}
```

**3. Add a Claudify subtask-label override** (new rule; place adjacent to the other Claudify feature rules, e.g. after `:183`) so the label matches the gold instead of leaking base purple:

```css
/* Claudify: feature subtask label in gold to match the recolored feature accent
   (base rule at .feature-subtask-label stays purple for Afterburner). */
body.theme-claudify .feature-subtask-label {
    color: var(--feature-accent);
}
```

**Edge Cases:** see the Edge-Case & Dependency Audit — do **not** modify the base rules at `:913-920` (`.feature-card`, `.feature-subtask-label`) or `:1389-1393` (`.kanban-card.feature-card.selected`), and do **not** touch the ULTRACODE keyframe purple at `:1483-1484`. Those keep Afterburner purple / are out of scope.

> **Note on approach:** the plan originally swapped a raw `#D4A017` literal into each of the four declarations. That was superseded (see Chosen gold) in favor of the single `--feature-accent` variable above. If you would rather keep zero new variables and match the base rules' literal style, substituting `#D4A017` for every `var(--feature-accent)` above is a valid, trivial fallback — the recolor result is identical.

## Verification Plan

> Session directives: **SKIP COMPILATION** and **SKIP TESTS** — no compile step or automated test is prescribed here. Building/reinstalling the VSIX is the user's normal manual test loop (webview changes are only observable from an installed VSIX per CLAUDE.md), not a plan-mandated compilation step.

### Automated Tests
- None. This is a pure presentational CSS change with no runtime logic to assert; it is verified by visual inspection.

### Manual visual QA
1. Switch the Kanban board to the **Claudify** theme. View a board with at least one feature (epic) card and a subtask label.
   - **Expect:** feature-card left border and background tint are **gold** (`#D4A017`), not purple; the gold sits comfortably next to the terracotta chrome with no clash.
2. Click a feature card to select it under Claudify.
   - **Expect:** selection border/box-shadow is gold, not purple.
3. Confirm the feature **subtask label** (`FEATURE: N SUBTASKS`) renders gold under Claudify (not purple).
4. Switch to the **Afterburner** theme (the default).
   - **Expect:** feature cards, subtask labels, and the selected-feature highlight are all still **purple** (`#7c3aed`) — unchanged (regression check on the untouched base rules).
5. Sanity-check a card that is both a feature and completed under Claudify: the green completed bar is intact; the feature accent is gold.
6. (Optional) If the gold reads too bright/dull next to the terracotta, tune the single `--feature-accent` value and re-check step 1.

---

**Recommendation:** Complexity 2/10 → **Send to Intern.** A tightly-scoped, single-file CSS recolor with a clear, verified fix shape and no logic risk.

## Completion Summary

Implemented the Claudify-only recolor of feature/epic cards from purple to gold. Added `--feature-accent: #D4A017;` to the `body.theme-claudify` variable block in `src/webview/kanban.html` and updated the three existing Claudify feature-card declarations to use `var(--feature-accent)`. Added a new `body.theme-claudify .feature-subtask-label` rule so the subtask label renders gold instead of leaking the base purple. Left the base `.feature-card`, `.feature-subtask-label`, and `.kanban-card.feature-card.selected` rules untouched so Afterburner stays purple. Updated the nearby comments to reference gold instead of purple. No compilation or tests were run per the plan directives; verification was done by reading the diff and confirming only the intended `body.theme-claudify` selectors changed.
