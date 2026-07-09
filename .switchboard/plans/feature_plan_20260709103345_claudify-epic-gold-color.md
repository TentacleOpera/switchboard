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

### Chosen gold

- Terracotta accent: `#D97757` (warm orange-red, hue ≈ 16°).
- Recommended gold: **`#D4A017`** (goldenrod, hue ≈ 45°, mid-saturation). It is clearly yellower than the terracotta so the two read as distinct, stays warm so it belongs in the Claudify palette, and has enough luminance to show as a 4px border and a low-opacity background mix on Claudify's dark panels.
- Single hex to swap consistently across all four Claudify declarations; can be tuned in one place if the user wants it brighter/duller.

## Metadata

- **Tags:** kanban, theming, claudify, css, features
- **Complexity:** 2/10
- **Files touched:** `src/webview/kanban.html`

## Complexity Audit

**Routine.** Pure CSS: change one hex color in the existing Claudify override block and add one small Claudify override rule for the subtask label. No JS, no data, no migration, no message protocol. Scope is fully contained to `body.theme-claudify` selectors, so no other theme can regress.

## Edge-Case & Dependency Audit

- **Afterburner must not change.** The base rules at `:913-920` and `:1389-1393` are theme-agnostic and drive Afterburner. Do **not** edit them. Only the `body.theme-claudify …` selectors change. Verify Afterburner feature cards are still purple after the edit.
- **Subtask label leak.** `.feature-subtask-label` (`:917`) has no Claudify override today, so it currently shows base purple even under Claudify. Add a Claudify override for it, or the label stays purple and still clashes — a partial fix that would read as a bug.
- **Both card states covered.** Feature cards have a resting/hover rule (`:167-171`) and a selected rule (`:180-183`). Recolor both, or a selected feature card snaps back to purple on click.
- **`!important` specificity.** The Claudify overrides already carry `!important` to beat the base `.kanban-card` rules; keep `!important` on the recolored declarations so they still win. The new `.feature-subtask-label` override should mirror the base specificity (a plain `body.theme-claudify .feature-subtask-label` selector out-specifies the bare `.feature-subtask-label`, so `!important` is not required there — but harmless if added for consistency).
- **Contrast on dark panel.** `#D4A017` at 12% mixed into `--panel-bg2` is a subtle tint (matching the current purple's subtlety); the 4px solid border carries the identity. Confirm the border is legible and the tint is visible but not garish.
- **Green "completed" bar unaffected.** The completed bar (`:154-156`) uses a separate green and its own selector; recoloring the feature accent does not touch it. A card that is both a feature and completed keeps green on the left edge per existing precedence.

## Proposed Changes

### `src/webview/kanban.html` — recolor Claudify feature accents to gold

**1. Resting/hover feature card (`:167-171`)** — replace both `#7c3aed` occurrences with `#D4A017`:

```css
body.theme-claudify .kanban-card.feature-card,
body.theme-claudify .kanban-card.feature-card:hover {
    border-left: 4px solid #D4A017 !important;
    background: linear-gradient(180deg, color-mix(in srgb, #D4A017 12%, var(--panel-bg2)) 0%, var(--panel-bg2) 100%) !important;
}
```

**2. Selected feature card (`:180-183`)** — replace both `#7c3aed` occurrences with `#D4A017`:

```css
body.theme-claudify .kanban-card.feature-card.selected {
    border-color: #D4A017 !important;
    box-shadow: inset 0 0 0 1px #D4A017 !important;
}
```

**3. Add a Claudify subtask-label override** (new rule; place adjacent to the other Claudify feature rules, e.g. after `:183`) so the label matches the gold instead of leaking base purple:

```css
/* Claudify: feature subtask label in gold to match the recolored feature accent
   (base rule at .feature-subtask-label stays purple for Afterburner). */
body.theme-claudify .feature-subtask-label {
    color: #D4A017;
}
```

**Do not modify** the base rules at `:913-920` (`.feature-card`, `.feature-subtask-label`) or `:1389-1393` (`.kanban-card.feature-card.selected`) — those keep Afterburner purple.

## Verification Plan

1. Rebuild/reinstall the VSIX.
2. Switch the Kanban board to the **Claudify** theme. View a board with at least one feature (epic) card and a subtask label.
   - **Expect:** feature-card left border and background tint are **gold** (`#D4A017`), not purple; the gold sits comfortably next to the terracotta chrome with no clash.
3. Click a feature card to select it under Claudify.
   - **Expect:** selection border/box-shadow is gold, not purple.
4. Confirm the feature **subtask label** renders gold under Claudify (not purple).
5. Switch to the **Afterburner** theme.
   - **Expect:** feature cards, subtask labels, and the selected-feature highlight are all still **purple** (`#7c3aed`) — unchanged (regression check on the base rules).
6. Sanity-check a card that is both a feature and completed under Claudify: the green completed bar is intact; the feature accent is gold.
