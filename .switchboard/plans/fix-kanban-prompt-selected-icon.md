# Fix Kanban "Copy Prompt for Selected" Icon Bug

## Problem
The button for "Copy prompt for selected plans" in kanban column headers is displaying the wrong icon. It currently shows the automation/play icon (ICON_22) instead of the correct prompt/copy icon.

## Root Cause
In `src/webview/kanban.html` line 3214:
```javascript
const ICON_PROMPT_SELECTED = '{{ICON_22}}';
```

`{{ICON_22}}` is mapped to `25-101-150 Sci-Fi Flat icons-138.png` in `KanbanProvider.ts`, which is the same icon used for the automation/play button (ICON_AUTOBAN). This creates confusion as the "copy prompt" button shows the same icon as the automation toggle.

The correct icon should be `{{ICON_PROMPT}}` which maps to `25-1-100 Sci-Fi Flat icons-22.png` (a prompt/copy icon).

## Solution
Change line 3214 in `src/webview/kanban.html` from:
```javascript
const ICON_PROMPT_SELECTED = '{{ICON_22}}';
```
to:
```javascript
const ICON_PROMPT_SELECTED = '{{ICON_PROMPT}}';
```

## Files to Change
- `src/webview/kanban.html` (line 3214)

## Verification
After the fix, verify that:
1. The "Copy prompt for selected" button in column headers shows the correct prompt/copy icon (not the automation icon)
2. The icon visually distinguishes itself from the automation toggle button
3. The tooltip still reads "Copy prompt for selected plans and advance to next stage"
