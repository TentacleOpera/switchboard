# Plan: Fix Markdown Editor Internal Scrollbar

## Problem
The markdown editor in the tickets detail view shows an internal scrollbar with a fixed low height, rather than expanding naturally within its container.

## Root Cause
- `markdownEditor.js` creates an `md-editor-shell` with `height: 100%` and `overflow: hidden`.
- The `md-body` inside has `flex: 1`, `overflow: hidden`, `height: 100%`.
- The textarea gets inline style `min-height:480px;height:auto;resize:vertical` from `enterTicketsEditMode` (PlanningPanelProvider.ts ~line 10068).
- The shell's `height: 100%` constrains the editor to the container height, but the container (`tickets-detail-content`) may not have a proper height set, causing the shell to collapse to a small height with an internal scrollbar on the textarea/preview.

## Fix
Make the editor shell grow naturally with content rather than constraining to 100% height of an undefined-height container.

### Files to Change
1. **`src/webview/markdownEditor.js`** — `md-editor-shell` CSS
   - Change `height: 100%` to `min-height: 480px` or `flex: 1` with `overflow: visible`.
   - Or: set `height: auto` on the shell and let the textarea's `min-height` drive the size.
2. **`src/webview/planning.html`** — `#tickets-detail-content` container
   - Ensure the container has `overflow-y: auto` and a defined height (e.g., `flex: 1; min-height: 0`) so the editor can scroll naturally within the pane.

### Approach
1. In `markdownEditor.js`, change `md-editor-shell` from `height: 100%; overflow: hidden` to `min-height: 480px; flex: 1; overflow: hidden`.
2. In `planning.html`, ensure `#tickets-detail-content` has `overflow-y: auto; flex: 1; min-height: 0`.

## Verification
- Enter edit mode on a ticket → editor should fill the available space without a tiny internal scrollbar.
- Type enough text to exceed the viewport → the container should scroll, not a tiny inner area.
- Resize the panel → editor should adapt to the new size.
