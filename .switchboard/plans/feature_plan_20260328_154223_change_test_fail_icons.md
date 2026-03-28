# Change Test Fail Icons

## Goal
Replace the current text-character "✗" test-failure icon in the Kanban board with the image icon at `icons/25-1-100 Sci-Fi Flat icons-85.png`. This icon appears in the PLAN REVIEWED, LEAD CODED, and CODER CODED column headers.

## Metadata
**Tags:** frontend, UI
**Complexity:** Low

## User Review Required

> [!NOTE]
> Visual change only. The "✗" text icon in column headers will be replaced with a 22×22 PNG image. Functionality is unchanged.

## Complexity Audit

### Routine
- Add a new icon placeholder `{{ICON_85}}` to the `iconMap` in `KanbanProvider.ts`.
- Add a new JS constant `ICON_TESTING_FAIL` in `kanban.html`.
- Replace `<span class="testing-fail-icon">✗</span>` with `<img src="${ICON_TESTING_FAIL}">` in two template locations.
- Update CSS to style the `<img>` element instead of the text span.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Static icon swap, no async paths.
- **Security:** The icon URI is generated server-side via `webview.asWebviewUri()` — no user input involved.
- **Side Effects:** None. Only visual appearance changes. Click handlers, modal behavior, and backend logic remain untouched.
- **Dependencies & Conflicts:** None. No other pending plans modify the testing-fail button area.

## Adversarial Synthesis

### Grumpy Critique
"A PNG icon to replace a unicode character. Riveting. The one thing I'll point out: you're swapping a resolution-independent text glyph for a 512×512 bitmap that'll be squeezed into 22×22 CSS pixels. On 4K displays, that's fine — the browser downscales. But on standard DPI, you might get aliasing artifacts from such an extreme downscale. Also, don't forget the existing hover effect uses `text-shadow` on the span — that won't work on an `<img>`. If you leave the old CSS in place, it's dead code. Clean it up."

### Balanced Response
Valid points addressed:
1. **Image quality at 22×22:** The existing icon pattern throughout the Kanban board uses the same 512×512 source PNGs at 22×22 display size (e.g., `ICON_JULES`, `ICON_MOVE_SELECTED`). This is the established convention and renders correctly across all tested displays.
2. **Hover effect:** The current `.testing-fail-btn:hover .testing-fail-icon { text-shadow: ... }` CSS will be updated to use `filter: drop-shadow(...)` for the `<img>` element, maintaining visual consistency with the hover effect. Old text-specific CSS will be removed.

## Proposed Changes

### Icon URI Registration

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `iconMap` object (around line 2128) maps template placeholders to webview-safe URIs. A new entry is needed for icon 85.
- **Logic:** Add `{{ICON_85}}` to the icon map, pointing to `25-1-100 Sci-Fi Flat icons-85.png`.
- **Implementation:**

Add to the `iconMap` object (after the existing entries, around line 2140):
```typescript
'{{ICON_85}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-85.png')).toString(),
```

### Icon Constant & Button Templates

#### [MODIFY] `src/webview/kanban.html`
- **Context:** Icon constants are declared around line 1103. The testing-fail button template appears at lines 1300-1302 (PLAN REVIEWED column) and lines 1315-1319 (LEAD CODED / CODER CODED conditional).
- **Logic:**
  1. Add a new `ICON_TESTING_FAIL` constant mapped to `{{ICON_85}}`.
  2. Replace both `<span class="testing-fail-icon">✗</span>` occurrences with `<img>` tags using the new constant.
- **Implementation:**

**Step 1 — Add icon constant** (after line 1112, with other icon constants):
```javascript
const ICON_TESTING_FAIL = '{{ICON_85}}';
```

**Step 2 — Replace PLAN REVIEWED column button** (lines 1300-1302):

Current:
```html
<button class="column-icon-btn testing-fail-btn" data-action="testingFailed" data-column="${escapeAttr(def.id)}" data-tooltip="Report testing failure for selected plans">
    <span class="testing-fail-icon">✗</span>
</button>
```

Replace with:
```html
<button class="column-icon-btn testing-fail-btn" data-action="testingFailed" data-column="${escapeAttr(def.id)}" data-tooltip="Report testing failure for selected plans">
    <img src="${ICON_TESTING_FAIL}" alt="Testing Failed" class="testing-fail-icon">
</button>
```

**Step 3 — Replace LEAD CODED / CODER CODED conditional button** (lines 1315-1319):

Current:
```javascript
const testingFailBtn = (def.id === 'LEAD CODED' || def.id === 'CODER CODED')
    ? `<button class="column-icon-btn testing-fail-btn" data-action="testingFailed" data-column="${escapeAttr(def.id)}" data-tooltip="Report testing failure for selected plans">
           <span class="testing-fail-icon">✗</span>
       </button>`
    : '';
```

Replace with:
```javascript
const testingFailBtn = (def.id === 'LEAD CODED' || def.id === 'CODER CODED')
    ? `<button class="column-icon-btn testing-fail-btn" data-action="testingFailed" data-column="${escapeAttr(def.id)}" data-tooltip="Report testing failure for selected plans">
           <img src="${ICON_TESTING_FAIL}" alt="Testing Failed" class="testing-fail-icon">
       </button>`
    : '';
```

### CSS Update

#### [MODIFY] `src/webview/kanban.html`
- **Context:** The `.testing-fail-icon` CSS (lines 631-645) currently styles a text span. It needs to style an `<img>` instead.
- **Logic:** Replace text-specific properties (`color`, `font-size`, `font-weight`) with image-specific properties (`width`, `height`). Update hover effect from `text-shadow` to `filter: drop-shadow()`.
- **Implementation:**

Current CSS (lines 631-645):
```css
.testing-fail-icon {
    color: var(--accent-red);
    font-size: 16px;
    font-weight: bold;
    line-height: 22px;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
}
.testing-fail-btn:hover .testing-fail-icon {
    text-shadow: 0 0 8px var(--accent-red);
}
```

Replace with:
```css
.testing-fail-icon {
    width: 22px;
    height: 22px;
    display: block;
}
.testing-fail-btn:hover .testing-fail-icon {
    filter: drop-shadow(0 0 8px var(--accent-red));
}
```

## Open Questions

None.

## Verification Plan

### Manual Verification
1. Open the Kanban board.
2. Verify the testing-failure icon in the PLAN REVIEWED column header renders as the new PNG image (not "✗").
3. Verify the testing-failure icon in LEAD CODED and CODER CODED column headers renders as the new PNG image.
4. Hover over each icon — verify the red glow/shadow hover effect is visible.
5. Click the icon — verify the Testing Failure modal still opens correctly.

### Build Verification
- Run `npm run compile` — no errors.
- Verify the icon file `icons/25-1-100 Sci-Fi Flat icons-85.png` is included in the extension bundle (check `webpack.config.js` if needed).

### Agent Recommendation
**Send to Coder** — Routine icon swap following established patterns across 2 files.
