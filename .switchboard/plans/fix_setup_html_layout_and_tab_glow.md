# Fix setup.html layout, top gap, and missing teal tab glow

## Goal

Bring `setup.html` in line with `kanban.html` and `planning.html` by fixing three visual inconsistencies: a centred fixed-width shell, a top gap above the tab bar, and a missing teal backlight glow on the active tab.

## Metadata

- **Tags:** frontend, UI, bugfix
- **Complexity:** 2

## User Review Required

- **Confirm full-bleed is intended.** Removing `max-width: 980px; margin: 0 auto` makes Setup content span the entire panel width. This is correct *only if* the goal is parity with Kanban/Planning. If a designer deliberately constrained Setup for readability of its long forms, this "fix" undoes that. Sibling parity is the stated requirement, so proceeding — flagging for sign-off.
- **Confirm the residual `.setup-shell { gap: 12px }` is acceptable.** Setup wraps its tab bar inside `.setup-shell` (a flex column with `gap: 12px`), whereas the siblings make `.shared-tab-bar` a direct child of `<body>`. After the fix, a 12px gap will remain between the tab bar's bottom border and the first content panel — a difference the siblings do not have. This is out of scope for the three stated issues and is **not** being changed to avoid over-engineering. Confirm this minor delta is acceptable.

## Root Cause Analysis

| Issue | setup.html | kanban.html / planning.html |
|---|---|---|
| **Fixed width** | `.setup-shell { max-width: 980px; margin: 0 auto; }` | No max-width wrapper; `body` fills viewport |
| **Top gap** | `body { padding: 16px; }` | `body { margin: 0; padding: 0; }` |
| **Missing glow** | `<body>` (no class) | `<body class="cyber-theme-enabled">` |

**Confirmed during audit:** In both siblings the `cyber-theme-enabled` class is applied **statically in the HTML markup** (`kanban.html:2201`, `planning.html:3061`), not injected by JavaScript at runtime. The theme-switch message handler in all three files (`setup.html:3870-3882`, `kanban.html:5597-5605`) only ever removes `theme-claudify` and adds `theme-<name>`; it never touches `cyber-theme-enabled`. Therefore adding the class statically to `setup.html`'s `<body>` matches the sibling pattern exactly and cannot be clobbered by theme switching.

## Complexity Audit

### Routine
- Delete two CSS declarations from the `.setup-shell` rule (`setup.html:104-110`).
- Change one CSS value: `body { padding: 16px → 0 }` (`setup.html:47`).
- Add one class attribute to the `<body>` tag (`setup.html:467`).
- All three are single-file, CSS/markup-only edits that reuse the exact pattern already shipped in the two sibling webviews. No JS, no state, no data.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. No async logic, no DOM-ready ordering, no message handlers touched. The static `cyber-theme-enabled` class is present at parse time, so the glow applies on first paint regardless of when the theme message arrives.
- **Security:** None. No user input, no `innerHTML`, no postMessage payloads, no token handling involved in these edits.
- **Side Effects:**
  - Removing `body { padding: 16px }` makes the `.shared-tab-bar` sit flush against all four panel edges. The tab bar's own `padding: 8px 16px 0` (`setup.html:413`) preserves the horizontal inset of the tab buttons, matching siblings.
  - Content panels are **not** left flush against the edge: `.shared-tab-content` retains `padding: 14px` (`setup.html:113`), so form content keeps its breathing room.
  - There are **two** `.setup-shell` rule blocks — line 104 (the target, with `max-width`/`margin`) and line 403 (`padding-top: 0`, a harmless leftover). Only the line-104 block needs editing; the line-403 block can be left as-is.
- **Dependencies & Conflicts:**
  - `theme-claudify` toggling is unaffected — it is added/removed independently of `cyber-theme-enabled` by the theme handler, so the two classes coexist exactly as they do in the siblings.
  - The glow rule `.cyber-theme-enabled .shared-tab-btn.active` (`setup.html:456`) and the tab-bar backdrop-blur rule (`setup.html:459`) are already present in setup.html's `<style>`; the only thing missing was the gating class on `<body>`. Adding the class also activates the `backdrop-filter: blur(10px)` on the tab bar — this is the intended sibling-matching behaviour, not a regression.

## Dependencies

- None. This plan is self-contained and does not depend on any other in-flight session.

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) full-bleed may have been a deliberate readability choice rather than a bug, and (2) adding `cyber-theme-enabled` also enables the tab-bar backdrop-blur, slightly more than "just a glow." Both are mitigated by the fact that the change is a verbatim copy of the shipped, working sibling pattern (`kanban.html`/`planning.html`) and is CSS/markup-only with zero logic touched, making regressions visually obvious and trivially revertible. Net risk: low.

## Proposed Changes

### `src/webview/setup.html`

**Context:** Setup is the only one of the three tabbed webviews that wraps its content in a centred fixed-width `.setup-shell`, applies body padding, and omits the `cyber-theme-enabled` body class. The fix aligns it with the established sibling pattern. All target rules and the glow CSS already exist in the file; the edits remove constraints and add the gating class.

**Logic:** Three independent edits, each removing a divergence from the sibling baseline. No ordering dependency between them.

**Implementation:**

1. **Remove centred constraints from `.setup-shell`** (`setup.html:104-110`, the block containing `max-width`):
   - Delete `max-width: 980px;`
   - Delete `margin: 0 auto;`
   - Keep `display: flex; flex-direction: column; gap: 12px;` (these stack the tab bar above the content and must remain).
   - Result: content fills the full viewport/panel width.

2. **Remove body padding** (`setup.html:47`):
   - Change `padding: 16px;` to `padding: 0;`
   - Result: tab bar sits flush against the top edge (matching `body { margin: 0; padding: 0; }` in siblings).

3. **Add `cyber-theme-enabled` to `<body>`** (`setup.html:467`):
   - Change `<body>` to `<body class="cyber-theme-enabled">`
   - Result: `.cyber-theme-enabled .shared-tab-btn.active` matches and applies the teal `box-shadow: 0 -2px 8px ...` glow; `.cyber-theme-enabled .shared-tab-bar` applies the matching backdrop-blur, both identical to the siblings.

**Edge Cases:**
- The second `.setup-shell` block (`setup.html:403`, `padding-top: 0`) is left untouched — it does not carry the width/margin constraints and is harmless.
- `theme-claudify` continues to toggle correctly alongside `cyber-theme-enabled`; the theme handler only manipulates `theme-*` classes.
- Content panels retain their own `padding: 14px`, so removing body padding does not push form fields against the panel edge.

## Verification Plan

### Automated Tests
- None required. This is a CSS/markup-only visual change with no testable logic; per session directive, the test suite is run separately by the user. No new unit/integration tests are warranted for static style declarations.

### Manual Verification
- Open the Setup webview.
- Confirm content spans the full panel width at all sizes (no centred 980px column).
- Confirm no visible gap between the tab bar and the panel top edge.
- Confirm the active tab shows a teal backlight glow matching Kanban / Planning, and the tab bar has the same translucent backdrop-blur.
- Switch theme to Claudify and back; confirm the glow recolours to the Claudify accent and the layout is unaffected.

## Risks

- **Low.** No JS logic changes. Only layout and class changes; no risk of regressions in functionality.
- The `theme-claudify` class will still toggle correctly alongside `cyber-theme-enabled`, as it does in the other webviews.

---

**Recommendation:** Complexity 2 (≤ 6) — **Send to Coder.**
