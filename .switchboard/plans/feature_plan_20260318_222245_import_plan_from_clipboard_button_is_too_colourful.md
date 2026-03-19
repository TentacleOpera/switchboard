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
