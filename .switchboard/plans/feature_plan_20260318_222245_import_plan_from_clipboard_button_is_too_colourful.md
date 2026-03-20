# import plan from clipboard button is too colourful

## Goal
The import plan from clipboard button in the kanban NEW column is way too colourful. It is just an emoji (📋), which clashes with the aesthetic. Replace it with a less colorful, text-based alternative that matches the minimalist design of the kanban board.

## Proposed Changes
Replace the 📋 emoji with a simple text-based icon or label that maintains the minimalist aesthetic while remaining functional.

## Implementation Steps

### Step 1: Replace emoji with text-based icon
**File**: `src/webview/kanban.html`, **Line 840**

**Current**:
```html
<button class="btn-add-plan" id="btn-import-clipboard" title="Import plan from clipboard">📋</button>
```

**Option A - Minimalist bracket notation (Recommended)**:
```html
<button class="btn-add-plan" id="btn-import-clipboard" title="Import plan from clipboard">[⋯]</button>
```

**Option B - Simple text label**:
```html
<button class="btn-add-plan" id="btn-import-clipboard" title="Import plan from clipboard">IMPORT</button>
```

**Option C - Arrow symbol**:
```html
<button class="btn-add-plan" id="btn-import-clipboard" title="Import plan from clipboard">[↓]</button>
```

**Recommendation**: Use **Option A** `[⋯]` (ellipsis in brackets) because:
- Matches the minimalist aesthetic of the '+' button next to it
- Ellipsis suggests "more content" or "paste/import"
- Brackets provide visual consistency with the monospace font style
- Less visually prominent than the colorful emoji

### Step 2: Verify button styling
The button uses the `btn-add-plan` class, which should handle the text content without layout issues. No CSS changes needed.

## Dependencies
- `src/webview/kanban.html` (Line 840)
- **Blocks**: None
- **Blocked by**: None
- **Related**: Plan 4 references this button in the Airlock sprint planning workflow

## Verification Plan
1. **Visual test**: Open Kanban view → Verify NEW column header shows `[⋯]` button instead of 📋
2. **Functionality test**: Click the button → Verify import from clipboard still works
3. **Aesthetic test**: Compare with '+' button → Verify consistent styling and minimal visual weight
4. **Tooltip test**: Hover over button → Verify tooltip still says "Import plan from clipboard"
5. **Layout test**: Verify button doesn't break column header layout or alignment

## Complexity Audit

### Band A (Routine)
- ✅ Single-file change (only `kanban.html`)
- ✅ Reuses existing pattern (same button class as '+' button)
- ✅ Low risk (simple text replacement, no logic changes)
- ✅ Small scope (1 line change)

**Complexity**: **Band A (Routine)**
**Recommended Agent**: **Coder**

## Adversarial Review

**Grumpy Critique**: 
"The plan says the emoji 'clashes with the aesthetic' but doesn't specify what to replace it with. A text label? A different icon? An SVG? The kanban uses SVG icons for other buttons (ICON_MOVE_SELECTED, ICON_MOVE_ALL, etc. at lines 857-864), so should this button use a similar SVG icon? Or should it be a text-based button like the '+' button next to it? The plan doesn't say. Also, the button uses the `btn-add-plan` class, which might have specific styling—will changing the content break the layout?"

**Balanced Synthesis**: 
Valid concern about the replacement choice. Analysis shows:
1. The '+' button (line 839) uses the same `btn-add-plan` class and displays a simple text character, so text-based replacement is consistent
2. The SVG icons (lines 857-864) are for the column action buttons below the header, not the header buttons—different context
3. The `btn-add-plan` class is designed for text content (handles the '+' button fine), so no layout breakage expected

The recommended replacement `[⋯]` (ellipsis in brackets) matches the minimalist aesthetic:
- Consistent with the '+' button's single-character approach
- Brackets provide visual structure without color
- Ellipsis is a universal symbol for "more" or "paste"
- Maintains the monospace, industrial design language of the kanban board

This is a trivial cosmetic change with zero functional impact.

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer

**[MAJOR]** *The plan said text, you shipped an image — without a CSS filter.* The plan explicitly recommended `[⋯]` text replacement (Option A). The implementation instead uses `<img src="${ICON_IMPORT_CLIPBOARD}" ...>` — a PNG icon (`25-101-150 Sci-Fi Flat icons-121.png`) injected via the `KanbanProvider.ts` icon map at line 1452. Here's the problem: the `btn-add-plan` CSS class (line 172) has **no `img` filter rule**. The column action buttons below use `column-icon-btn img` with a `sepia(1) saturate(3) hue-rotate(140deg) brightness(0.9)` filter to make icons monochromatic teal. But `btn-add-plan img`? Nothing. The sci-fi flat icon pack is **colorful by design**. So you've replaced a colorful emoji with a colorful PNG. The goal was "less colorful." *You had one job.*

**[NIT]** *The `+` button uses text, the import button uses an image.* Both share the `btn-add-plan` class and sit side by side in the column header. The `+` is a text character, the import is a 16x16 PNG. Visually inconsistent — one is rendered by the font engine, the other by the image renderer. Different anti-aliasing, different sizing behavior, different weight. Not catastrophic, but the plan's `[⋯]` recommendation would have maintained text-text consistency.

**Verdict**: One MAJOR (icon may render in full color without a CSS filter, potentially not solving the original "too colourful" complaint), one NIT (text/image inconsistency in header). The functional import behavior is unaffected.

### Stage 2: Balanced Synthesis

- **Keep**: The `ICON_IMPORT_CLIPBOARD` template variable injection in `KanbanProvider.ts` line 1452 — it's a clean pattern consistent with other icons.
- **Fix now**: Add a CSS filter rule for `.btn-add-plan img` to make the icon monochromatic teal, matching the column-icon-btn treatment. This is a one-line CSS addition that ensures the icon blends with the kanban aesthetic regardless of the source PNG's colors.
- **Defer**: Consider whether to revert to the plan's text-based `[⋯]` approach in a future iteration for perfect consistency with the `+` button. The CSS filter fix is sufficient for now.

### Code Fixes Applied
Added CSS filter rule for `.btn-add-plan img` to ensure the import clipboard icon renders in monochromatic teal, matching the overall kanban aesthetic. This addresses the MAJOR finding that the PNG icon could render in its original colors.

**Fix applied** in `src/webview/kanban.html` (after line 194):
```css
.btn-add-plan img {
    filter: sepia(1) saturate(3) hue-rotate(140deg) brightness(0.9);
    transition: filter 0.15s;
}

.btn-add-plan:hover img {
    filter: sepia(1) saturate(3) hue-rotate(140deg) brightness(1.2);
}
```

This reuses the exact same filter chain from `.column-icon-btn img` (lines 561-566), ensuring visual consistency across all icon buttons in the kanban board.

### Verification Results
- **TypeScript compile**: `npx tsc --noEmit` → **PASS** (exit code 0, zero errors) — both before and after CSS fix
- **CSS filter**: `.btn-add-plan img` now applies `sepia(1) saturate(3) hue-rotate(140deg) brightness(0.9)` — identical to `.column-icon-btn img` ✓
- **Hover state**: `.btn-add-plan:hover img` brightens to `brightness(1.2)` — matches `.column-icon-btn:hover img` pattern ✓
- **Functional**: Button still uses `id="btn-import-clipboard"` with `postKanbanMessage({ type: 'importFromClipboard' })` handler — unchanged ✓

### Files Changed
- `src/webview/kanban.html` (line 857: `<img>` tag replacing emoji — original implementation)
- `src/webview/kanban.html` (lines 196-203: new `.btn-add-plan img` and `.btn-add-plan:hover img` CSS rules — reviewer fix)
- `src/services/KanbanProvider.ts` (line 1452: `ICON_IMPORT_CLIPBOARD` template variable mapping — original implementation)

### Remaining Risks
- The `btn-add-plan` button is 18x18px; the `<img>` inside is 16x16px. This leaves 1px padding on each side, which is fine. But if a different icon with transparent edges is used in the future, it might appear smaller than the `+` text button. Minor cosmetic concern only.

### Status: ✅ APPROVED (with fix applied)
