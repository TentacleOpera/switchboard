# Epic Cards: Purple Border When Selected on Kanban Board

## Goal

When an epic card is selected on the kanban board, it receives the same border color as every other selected card — the theme's accent color (teal `var(--accent-teal)` for default/Afterburner, terracotta `var(--accent-primary)` for Claudify). This makes it impossible to visually distinguish a selected epic from a selected regular plan. The purple identity that epic cards carry in their unselected state (left border `#7c3aed`) is completely overridden by the generic `.kanban-card.selected` rule. The fix: add `.epic-card.selected` override rules so selected epic cards retain their purple identity on all borders.

### Problem
When an epic card is selected on the kanban board, it receives the same border color as every other selected card — the theme's accent color (teal `var(--accent-teal)` for default/Afterburner, terracotta `var(--accent-primary)` for Claudify). This makes it impossible to visually distinguish a selected epic from a selected regular plan. The purple identity that epic cards carry in their unselected state (left border `#7c3aed`) is completely overridden by the generic `.kanban-card.selected` rule.

### Root Cause
There is **no CSS rule for `.kanban-card.epic-card.selected`** in any theme. The CSS cascade order is:

1. `.epic-card` (line 912) — sets purple left border + faint purple background
2. `.kanban-card.selected` (line 1339) — overrides **all** border colors to teal, plus teal glow
3. `body.theme-claudify .kanban-card.selected` (line 173) — overrides **all** border colors to terracotta with `!important`

The comment at lines 164-166 explicitly states: *"Declared after :hover so the purple survives hover, but before .selected so selection still wins."* — selection was intentionally designed to override the epic purple. The user now wants the purple to survive selection instead.

### Desired Behavior
When an epic card is selected, its border (all sides) and glow should be **purple (`#7c3aed`)**, not the theme accent color. Regular (non-epic) cards should continue to use the theme accent color when selected.

## Metadata

- **Tags:** frontend, ui, ux, feature
- **Complexity:** 2
- **Files touched:** 1 (`src/webview/kanban.html`)
- **Risk:** Low — pure CSS addition, no logic changes

## User Review Required

No — this is a pure CSS visual change with no logic, data model, or backend impact. The change is additive (new selector rules) and does not modify any existing behavior for non-epic cards. Manual visual verification is sufficient.

## Complexity Audit

### Routine
- Adding two new CSS selector rules to a single HTML file
- Both rules use existing color values (`#7c3aed`) already present in the codebase
- The `.epic-card` class already exists on epic cards in the DOM (conditionally added at line 5277 based on `card.isEpic`)
- No JavaScript, no data model, no backend changes
- `color-mix()` is already used extensively in this file (e.g., lines 1341-1342, 170, 174)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

| Edge Case | Analysis |
|-----------|----------|
| **Race Conditions** | None — pure CSS, no asynchronous operations |
| **Security** | None — no user input handling, no data changes |
| **Side Effects** | None — additive CSS rules only; non-epic selected cards are unaffected (the new selectors require `.epic-card` class) |
| **Dependencies & Conflicts** | See below |

**Claudify theme `!important` cascade:** The Claudify selected rule at line 173 uses `!important` on `border-color`. There is also a comma-separated `box-shadow: none` group at line 48 that includes `body.theme-claudify .kanban-card.selected`. The new epic-selected rule must use `!important` on both `border-color` and `box-shadow`, and be declared **after** line 178 to win on source order (specificity is equal: `body.theme-claudify .kanban-card.epic-card.selected` = 0,3,1 vs `body.theme-claudify .kanban-card.selected` = 0,2,1 — actually the epic rule has higher specificity, so `!important` + higher specificity both favor the new rule).

**Default/Afterburner theme:** No `!important` used on the `.kanban-card.selected` rule (line 1339). Higher specificity alone is sufficient: `.kanban-card.epic-card.selected` (0,3,0) vs `.kanban-card.selected` (0,2,0). Afterburner adds `cyber-theme-enabled` class but has no separate `.kanban-card.selected` override — it shares the base rule.

**Completed epic cards:** In the default theme, `.kanban-card.completed` (line 897) sets `border-left: 3px solid green` and `.kanban-card.selected` (line 1339) sets `border-color: teal`. Both are (0,2,0) specificity; `.selected` wins by source order (line 1339 > line 897). In Claudify, `.kanban-card.completed` (line 155) sets `border-left: 3px solid green !important` and `.kanban-card.selected` (line 173) sets `border-color: terracotta !important`. Both are (0,2,1) specificity with `!important`; `.selected` wins by source order (line 173 > line 155). So the green completed bar is **already overridden** by selection in both themes. The new `.epic-card.selected` rule (higher specificity) will override the terracotta/teal with purple on all sides. This is consistent: selection is the strongest visual state.

**Hover state on selected epic:** The `.kanban-card.selected` rule already wins over `:hover`. The new `.epic-card.selected` rule will also win over `.epic-card:hover`. No conflict.

**Epic cards in all columns:** The `.epic-card` class is applied regardless of column (line 5277). The new rule applies universally to selected epics in any column.

## Dependencies

None — this is a standalone CSS change with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) all line numbers in the original plan were wrong (off by ~500-700 lines), which would have caused insertion into unrelated CSS rules; (2) the Claudify `box-shadow: none` group at line 48 was not acknowledged, though the `!important` in the new rule happens to override it correctly; (3) the redundant `border-left-color` declaration in Change 1 is harmless but unnecessary since `border-color` already sets all four sides. Mitigations: line numbers have been corrected to actual file positions, the Claudify cascade is now fully documented, and the redundant declaration has been removed.

## Proposed Changes

### File: `src/webview/kanban.html`

#### Change 1: Add epic-selected override for default/Afterburner theme

Insert **after** the `.kanban-card.selected` rule (after line 1343):

```css
/* Selected epic cards: purple border instead of theme accent */
.kanban-card.epic-card.selected {
    border-color: #7c3aed;
    box-shadow: 0 0 8px color-mix(in srgb, #7c3aed 35%, transparent),
                inset 0 0 4px color-mix(in srgb, #7c3aed 10%, transparent);
}
```

**Specificity note:** `.kanban-card.epic-card.selected` (0,3,0) > `.kanban-card.selected` (0,2,0) — wins without `!important`. The `border-color` shorthand sets all four border sides. No need for a separate `border-left-color` declaration.

#### Change 2: Add epic-selected override for Claudify theme

Insert **after** the `body.theme-claudify .kanban-card.selected` rule (after line 178):

```css
/* Selected epic cards in Claudify: purple border instead of terracotta */
body.theme-claudify .kanban-card.epic-card.selected {
    border-color: #7c3aed !important;
    box-shadow: inset 0 0 0 1px #7c3aed !important;
}
```

**Cascade note:** `body.theme-claudify .kanban-card.epic-card.selected` (0,3,1) > `body.theme-claudify .kanban-card.selected` (0,2,1) — higher specificity wins. The `!important` is also needed to override the `box-shadow: none` from the comma-separated group at line 48 (`body.theme-claudify .kanban-card.selected { box-shadow: none; }`), which has equal specificity (0,2,1) but no `!important`. With `!important` on the new rule, it wins regardless.

#### Change 3: Update the comment at lines 164-166

The comment currently says *"Declared after :hover so the purple survives hover, but before .selected so selection still wins."* — this is no longer accurate for epic cards. Update to:

```css
/* Epic cards: restore the purple identity that the !important .kanban-card rules above
   otherwise flatten (mirrors the green .completed bar). Declared after :hover so the
   purple survives hover. Selection still wins for non-epic cards; epic cards have their
   own .epic-card.selected override below that keeps the purple border. */
```

## Verification Plan

### Automated Tests

No automated tests required — this is a pure CSS visual change. Per session directives, compilation and test suite execution are skipped.

### Manual Verification

1. **Manual test — default theme**:
   - Open the kanban board with at least one epic card and one regular card in the same column.
   - Click the regular card → verify teal border + teal glow.
   - Click the epic card → verify **purple** border (`#7c3aed`) + purple glow.
   - Select both → verify regular card is teal, epic card is purple.
2. **Manual test — Claudify theme**:
   - Switch to Claudify theme.
   - Click a regular card → verify terracotta border.
   - Click an epic card → verify **purple** border (`#7c3aed`).
3. **Manual test — completed epic**:
   - Select a completed epic card → verify purple border on all sides (selection overrides the green completed bar, consistent with existing behavior for completed+selected cards).
4. **Manual test — hover**:
   - Hover over a selected epic card → verify purple border persists (no flicker to theme color).

## Recommendation

Complexity 2 → **Send to Intern**
