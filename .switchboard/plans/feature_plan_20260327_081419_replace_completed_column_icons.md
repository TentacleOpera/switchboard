# Replace completed column icons

## Goal
Two changes:

1. Remove the "Recover All" button from the completed column header.
2. Replace the current text-based "Recover Selected" button with an image icon using `icons/25-1-100 Sci-Fi Flat icons-55.png`.

## Metadata
**Tags:** frontend, UI
**Complexity:** Low

## User Review Required
- Confirm the replacement icon (`icons/25-1-100 Sci-Fi Flat icons-55.png`) visually conveys "recover" at 22×22px with the teal sepia filter applied.
- Confirm the tooltip text "Recover selected plans back to active board" is still appropriate for the new icon.

## Complexity Audit

### Routine
- Removing the "Recover All" button HTML from the completed column `buttonArea` template literal (~1 line delete).
- Adding a new `ICON_RECOVER_SELECTED` constant in `kanban.html` referencing `{{ICON_55}}`.
- Replacing the text content `↩ Selected` with an `<img>` tag matching the pattern used by every other column button.
- Adding the `{{ICON_55}}` → URI mapping in the `iconMap` object in `KanbanProvider.ts`.

### Complex / Risky
- Nothing complex. All changes follow established patterns already used by other column buttons (e.g., `ICON_MOVE_SELECTED`, `ICON_MOVE_ALL`).

## Edge-Case & Dependency Audit
- **Dead handler**: The `recover-all-btn` click handler (kanban.html ~line 1503) will remain but never fire because no element with that class will exist. This is harmless dead code and can be cleaned up in a future pass.
- **CSS orphan**: The `.recover-all-btn` CSS rule (~line 577) becomes unused. Also harmless; no visual side-effects.
- **Cross-plan conflicts**: Three other plans modify `kanban.html` but target unrelated sections (header text, ticket view input, new accordion). No overlapping lines. No merge conflicts expected.
- **Icon file already in repo**: `icons/25-1-100 Sci-Fi Flat icons-55.png` (5,858 bytes) already exists; no new asset needed.
- **Content Security Policy**: The icon will be served via `webview.asWebviewUri()` just like all other icons, so the existing CSP img-src directive already permits it.

## Adversarial Synthesis

### Grumpy Critique
Removing "Recover All" without a replacement means users who want to bulk-recover completed plans lose a one-click shortcut. They'll have to manually select every card first—annoying if the completed column has 30+ items. Also, swapping a readable text label ("↩ Selected") for a mystery sci-fi PNG is a discoverability regression. Text buttons are self-documenting; icon buttons require the user to hover for a tooltip. Why not keep both the icon *and* a short label? Finally, leaving the dead `recover-all-btn` click handler and CSS rule is sloppy—if you're touching these lines already, clean up after yourself.

### Balanced Response
The critique about bulk recovery UX is valid but out-of-scope for this ticket—the user explicitly requested removal, and individual card recover buttons remain as a fallback. The discoverability concern is mitigated by the existing tooltip system that all other column buttons already rely on; users are already trained to hover icons. Adding a label alongside the icon would break visual consistency with every other column. The dead handler/CSS point is fair but low-risk; a follow-up cleanup task is appropriate to keep this change minimal and reviewable.

## Proposed Changes

### `src/webview/kanban.html`

#### [MODIFY] `src/webview/kanban.html`

**Context:** Icon constant definitions block (~line 930) where all `ICON_*` template variables are declared.

**Logic:** Add a new constant for the recover-selected icon so the completed column can reference it as an `<img>` source.

**Implementation:**
Add after the existing `ICON_PROMPT` constant:
```javascript
const ICON_RECOVER_SELECTED = '{{ICON_55}}';
```

**Edge Cases Handled:** None—straightforward constant declaration.

---

#### [MODIFY] `src/webview/kanban.html`

**Context:** Completed column `buttonArea` template literal (~lines 1083-1091) that currently renders two text-based buttons.

**Logic:** Remove the "Recover All" button entirely. Replace the "Recover Selected" button content from text (`↩ Selected`) to an `<img>` tag using the new `ICON_RECOVER_SELECTED` constant, matching the pattern used by all other column icon buttons.

**Implementation:**
Replace the existing completed-column `buttonArea` block:
```javascript
if (isCompleted) {
    buttonArea = `<div class="column-button-area">
        <button class="column-icon-btn recover-selected-btn" data-column="${escapeAttr(def.id)}" data-tooltip="Recover selected plans back to active board">
            <img src="${ICON_RECOVER_SELECTED}" alt="Recover Selected">
        </button>
    </div>`;
}
```

**Edge Cases Handled:**
- Retains `recover-selected-btn` class so the existing click handler continues to work.
- Retains `data-column` and `data-tooltip` attributes for functionality and discoverability.
- The `<img>` tag inherits existing `.column-icon-btn img` CSS (22×22px, teal sepia filter, hover brightness).

---

### `src/services/KanbanProvider.ts`

#### [MODIFY] `src/services/KanbanProvider.ts`

**Context:** The `iconMap` object inside `_getHtml()` (~line 2038) that maps template placeholders to vscode-resource URIs.

**Logic:** Add a new entry mapping `{{ICON_55}}` to the webview URI for `25-1-100 Sci-Fi Flat icons-55.png`.

**Implementation:**
Add to the `iconMap` object:
```typescript
'{{ICON_55}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-55.png')).toString(),
```

**Edge Cases Handled:** The icon file already exists in `icons/`; the regex replacement loop handles the new placeholder identically to existing ones.

## Verification Plan

### Automated Tests
- Run `npm run compile` (or the project's build command) to confirm no TypeScript or template errors.
- Grep for `ICON_55` in both `kanban.html` and `KanbanProvider.ts` to confirm the constant and mapping are present and consistent.
- Grep for `recover-all-btn` in `kanban.html` template literals to confirm the button is removed from the rendered HTML (should only appear in the CSS rule and the dead click handler).

### Manual Tests
- Open the Kanban board in VS Code. Navigate to the Completed column.
- Verify the "Recover All" button is no longer visible.
- Verify the "Recover Selected" button displays the sci-fi icon (not text), with the teal sepia filter applied.
- Hover the icon to confirm the tooltip reads "Recover selected plans back to active board".
- Select one or more completed cards and click the recover icon—confirm the `recoverSelected` action fires and plans are recovered.
- Confirm no visual regressions in other columns (their icons should be unchanged).

## Recommendation
Send to Coder
