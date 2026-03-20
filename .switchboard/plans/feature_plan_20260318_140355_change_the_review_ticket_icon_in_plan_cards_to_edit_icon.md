# Change the Review Ticket Icon in Plan Cards to Edit Icon

## Goal

The existing "clipboard" style icon on Kanban card review buttons doesn't convey its purpose. Replace it with a universally recognisable pencil/edit icon so users immediately understand the button opens the plan for editing/review.

## Complexity Audit

**Band A — Routine.** Single inline SVG swap in one file. No logic changes, no new dependencies, no API surface change.

## Proposed Changes

### File: `src/webview/kanban.html` — Line 1118

Replace the current clipboard SVG inside the `.card-btn.icon-btn.review` button:

**Current icon (clipboard — rectangle with grid lines):**
```html
<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2v12h12V2H2zM2 5h12M5 2v12"/></svg>
```

**New icon (pencil/edit):**
```html
<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>
```

The new SVG draws a pencil shape: a diagonal body from bottom-left to top-right with a triangular tip pointing down-left, matching the same `viewBox`, `width`, `height`, `stroke`, and styling attributes as the existing icon for visual consistency.

**No other files are affected.** A codebase-wide search for the old SVG path (`M2 2v12h12V2H2z`) confirms it appears only on line 1118 of `kanban.html`.

## Edge-Case & Dependency Audit

| Concern | Status |
|:---|:---|
| Icon reused elsewhere? | ✅ No — grep confirms single occurrence in `kanban.html:1118` |
| Button class/title change needed? | ✅ No — `title="Review Plan Ticket"` remains accurate |
| CSS changes needed? | ✅ No — `.card-btn.icon-btn` sizing (20×20 px) and flex centering are icon-agnostic |
| Event listener affected? | ✅ No — click handler targets `.card-btn.review` class, not the SVG |
| Accessibility impact? | ✅ None — button `title` attribute provides the accessible label |
| Other icon buttons on cards? | ✅ Unaffected — checkmark (complete) and copy button are separate elements |

## Verification Plan

1. Open the Kanban panel in the Switchboard extension.
2. Confirm cards display the new pencil/edit icon in place of the old clipboard icon.
3. Click the icon — verify it still opens the plan ticket (fires `reviewPlan` message).
4. Check visual alignment: icon should be centred in its 20×20 px button and match the adjacent checkmark icon in weight/size.
5. Test in both light and dark VS Code themes — icon uses `stroke="currentColor"` so it inherits the theme colour.

## Open Questions

- None. This is a self-contained icon swap with no ambiguity.

## Recommended Route

`/accuracy` — Single-file, single-line icon replacement. No cross-file coordination needed.
