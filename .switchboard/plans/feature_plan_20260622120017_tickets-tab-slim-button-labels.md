# Slim Down "Convert to Subtask" and "Diagram Prompt" Button Labels in Tickets Tab

## Goal

In the Tickets tab of `planning.html`, the action-bar buttons **Convert to Subtask** and **Diagram Prompt** have verbose labels that crowd the row. Rename them to **To subtask** and **Diagram** respectively.

### Problem Analysis

The tickets preview action bar (`#tickets-preview-meta-bar`) packs many buttons onto one row ([planning.html:3370-3387](src/webview/planning.html#L3370)). Two have long labels:
- `<button id="btn-diagram-prompt" ...>Diagram Prompt</button>` ([planning.html:3384](src/webview/planning.html#L3384)).
- `<button id="btn-convert-subtask" ... title="Convert this ticket to a subtask of another ticket">Convert to Subtask</button>` ([planning.html:3386](src/webview/planning.html#L3386)).

The long text widens the action bar unnecessarily. Shorter labels reduce crowding while the existing `title` tooltips preserve the full meaning.

### Root Cause

The button labels are longer than needed for a dense toolbar.

## Metadata

**Complexity:** 1
**Tags:** frontend, ux, copywriting, tickets

## Complexity Audit

### Routine
- Editing two button label texts in one HTML file.

### Complex / Risky
- None. The element ids (`btn-diagram-prompt`, `btn-convert-subtask`) and their JS handlers are unchanged, so behavior is unaffected.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** None — labels only. Verify no code looks up these buttons by their text content (handlers bind by id, so this is safe).
- **Dependencies & Conflicts:** The Convert modal title ("Convert to Subtask", [planning.html:3541](src/webview/planning.html#L3541)) can remain the full phrase for clarity; only the toolbar button is slimmed. Coordinate with the tickets-tab Source-modal / one-line layout plan, which also tightens this toolbar.

## Proposed Changes

### 1. `src/webview/planning.html` — Diagram button
At [3384](src/webview/planning.html#L3384):
```html
<button id="btn-diagram-prompt" class="strip-btn" style="display:none;" title="Copy a diagram prompt for this ticket">Diagram</button>
```

### 2. `src/webview/planning.html` — Convert-to-subtask button
At [3386](src/webview/planning.html#L3386):
```html
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">To subtask</button>
```

(The `title` attributes retain the full description for discoverability.)

## Verification Plan

1. Build; open Planning → Tickets → select a ticket so the action bar shows.
2. Confirm the buttons read **Diagram** and **To subtask**.
3. Hover each → confirm the tooltip still explains the full action.
4. Click each → confirm behavior is unchanged (Diagram prompt copy; Convert-to-subtask modal opens).
