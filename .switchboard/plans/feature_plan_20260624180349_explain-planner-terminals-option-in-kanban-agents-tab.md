# Explain Planner Terminals Option in Kanban Agents Tab

## Goal

### Problem
In `kanban.html`, the Agents tab shows a one-line description for each agent role. The Planner role's description (line 2688) currently reads:

> Writes detailed step-by-step implementation plans and creates work checklists.

Directly below this description (lines 2689–2702) is a "Terminals" row with a `<select>` dropdown (1–5 terminals) and a "Limit dispatches to number of available terminals" checkbox. However, the description text gives the user **no indication** of what the Terminals option does or why they would increase it. The tooltip on the limit-dispatch label explains the dispatch-limiting behavior, but nothing explains the terminal-count dropdown itself or the benefit of using more than one planner terminal.

### Root Cause
The `.agent-description` div for the planner was written before (or without considering) the terminals pool feature. It was never updated to mention the terminals option, leaving users to guess its purpose.

### Desired Outcome
Add a second sentence to the planner agent description that explains the terminals option, matching the user's suggested wording:

> Increase the number of terminals to spread multiple plans among different planners for faster processing of plan batches.

## Metadata

- **Tags**: `kanban`, `agents-tab`, `ui-text`, `planner`, `documentation`
- **Complexity**: 2
- **Files touched**: 1 (`src/webview/kanban.html`)
- **Risk**: None — pure text change, no logic or data affected

## Complexity Audit

**Routine.** This is a single-string text edit in a static HTML description block. No JavaScript logic, no data flow, no state, no migrations, and no build artifacts are involved. The change is cosmetic/informational only.

## Edge-Case & Dependency Audit

- **No dependencies**: The `.agent-description` text is static HTML rendered directly in the webview. It is not read by any JavaScript, not stored in config, and not sent to any backend.
- **No edge cases**: The text is display-only; there are no conditional rendering paths or dynamic replacements for this specific description div.
- **No migration needed**: This is unreleased UI text; no user data or settings are affected.
- **Styling**: The existing `.agent-description` CSS class already handles font size, color, and spacing. Adding a second sentence in the same `<div>` will inherit the same styling automatically. No CSS changes needed.

## Proposed Changes

### `src/webview/kanban.html` — line 2688

**Before:**
```html
<div class="agent-description">Writes detailed step-by-step implementation plans and creates work checklists.</div>
```

**After:**
```html
<div class="agent-description">Writes detailed step-by-step implementation plans and creates work checklists. Increase the number of terminals to spread multiple plans among different planners for faster processing of plan batches.</div>
```

This is a single-line edit. The second sentence is appended within the same `<div>` so it inherits the existing `.agent-description` styling (small font, secondary color, padding).

## Verification Plan

1. **Visual check**: Open the Kanban board in VS Code, navigate to the Agents tab, and confirm the Planner row's description now shows two sentences, with the second sentence explaining the terminals option.
2. **Layout check**: Verify the description text wraps naturally and does not break the layout of the Terminals row below it.
3. **No regressions**: Confirm all other agent descriptions remain unchanged and the terminals dropdown / limit-dispatch checkbox still function as before.
