# the add ticket button in kanban view is off

## Goal

The `+` glyph inside the "Add Plan" button in the CREATED column header of the Kanban webview is not vertically centered — it sits too low within the button.

## Root Cause

**File:** `src/webview/kanban.html`

The `.btn-add-plan` CSS rule (lines 172-189) sets `line-height: 1` (line 179) on a monospace font at 14px inside an 18×18px flex container. While the button correctly uses `display: flex; align-items: center; justify-content: center;`, the tight `line-height: 1` collapses the anonymous flex item's line box to exactly the font-size. Monospace font metrics (ascender/descender distribution) cause the `+` glyph to render below optical center within that collapsed line box. Flex centers the line box, but the glyph is off-center *within* it.

The parent `<div>` (line 839) also carries an inline `line-height: 1` which reinforces the inherited value, though the button's own declaration is the direct cause.

### Relevant Code

**Button HTML** (line 839-842):
```html
<div style="display: flex; align-items: center; gap: 8px; line-height: 1;">
    <button class="btn-add-plan" id="btn-add-plan" title="Add Plan">+</button>
    <span class="column-count" id="count-${escapeAttr(def.id)}">0</span>
</div>
```

**Button CSS** (lines 172-189):
```css
.btn-add-plan {
    background: color-mix(in srgb, var(--accent-teal) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-teal) 30%, transparent);
    color: var(--accent-teal);
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: bold;
    line-height: 1;          /* ← PROBLEM: collapses line box */
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.15s;
    box-shadow: var(--glow-teal);
}
```

## Proposed Changes

**Single-file change:** `src/webview/kanban.html`

### Change 1 — Remove `line-height: 1` from `.btn-add-plan` (line 179)

Delete or replace the `line-height: 1;` declaration. With `display: flex` + `align-items: center` already in place, removing the tight line-height lets the browser use `line-height: normal` (~1.2), which gives the `+` glyph balanced ascender/descender space so flex centering actually optically centers the character.

**Before:**
```css
font-weight: bold;
line-height: 1;
width: 18px;
```

**After:**
```css
font-weight: bold;
width: 18px;
```

That's it — one line removed.

## Complexity Audit

| Dimension         | Rating             | Notes                                          |
|-------------------|--------------------|-------------------------------------------------|
| **Band**          | **A — Routine**    | Single CSS property removal in one file          |
| Files touched     | 1                  | `src/webview/kanban.html`                        |
| Lines changed     | 1 removed          | Line 179                                         |
| Risk of regression| Negligible         | CSS-only; no JS logic, no build output affected  |
| Cross-cutting     | None               | No other component references `.btn-add-plan`    |

## Edge-Case & Dependency Audit

- **Other `.btn-*` classes**: `.btn-batch`, `.btn-add-plan:hover` — neither inherits or depends on the removed `line-height`. No collateral impact.
- **Parent inline `line-height: 1`** (line 839): Affects the sibling `.column-count` span, not the button (button has its own flex context). No change needed.
- **Universal reset** (`* { padding: 0; margin: 0; }` at line 28-32): Already in place — no hidden browser padding on the button.
- **Font fallback**: `var(--font-mono)` resolves to a monospace stack. The fix is font-agnostic since it relies on flex centering rather than font metrics.

## Verification Plan

1. Open the Kanban view in VS Code (`Switchboard: Show Kanban Board`).
2. Inspect the `+` button in the CREATED column header.
3. Confirm the `+` glyph is vertically centered within its teal-bordered 18×18px box.
4. Hover the button — confirm the hover style (`background: var(--accent-teal)`) still applies correctly.
5. Click the button — confirm the "Add Plan" action still fires.

## Recommended Route

**`/accuracy`** — Single CSS property removal in one file. No delegation or multi-agent coordination needed.

## Open Questions

None — the fix is deterministic and self-contained.
