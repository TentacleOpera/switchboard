# Fix ClickUp Task Description Word Wrapping in Sidebar

## Goal
Ensure long ClickUp task descriptions word-wrap correctly in the sidebar detail view, improving readability and preventing horizontal scroll clipping.

## Metadata
**Tags:** bugfix, ui, frontend
**Complexity:** 2

## User Review Required
No.

## Complexity Audit
### Routine
- Adding CSS word-wrapping rules to target the `<pre>` tag rendered by `renderSidebarClickUpTaskDetail()`.
### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None. CSS change only.
- **Security**: None.
- **Side Effects**: Might affect preformatted code blocks within ClickUp descriptions, breaking explicit visual formatting. 
- **Dependencies & Conflicts**: No active Kanban plans conflict.

## Dependencies
None

## Adversarial Synthesis
Key risks: Applying global wrapping properties to `<pre>` tags might ruin formatting for users who paste raw code snippets into ClickUp task descriptions. Mitigations: `white-space: pre-wrap` preserves line breaks and spaces while allowing text to wrap at boundaries, which is a safe compromise.

## Proposed Changes

### [src/webview/implementation.html]
Add the following CSS rule after the existing `.project-task-description` rule (around line 430):
```css
.project-task-description pre {
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    max-width: 100%;
}
```

## Verification Plan
### Automated Tests
- Simple CSS parsing and unit tests on the view are unlikely to catch this visually. We rely on manual UI verification. 

## Manual Testing
1. Open the Switchboard sidebar in VS Code
2. Navigate to the ClickUp tab
3. Click on a task with a long description (preferably with explicit spaces or code blocks)
4. Confirm that the description text wraps within the visible area
5. Confirm that preformatted text (code blocks) still preserves original line breaks
6. Confirm no regression in Linear task description display

## Review Results

### Stage 1 (Grumpy)
- **[NIT] Redundant Wrap Property**: The CSS rule `word-wrap: break-word;` is technically deprecated in favor of `overflow-wrap: break-word;` (though it was included in `.project-task-description`, not in the new `pre` block anyway). The new block applies `white-space: pre-wrap;`, `word-break: break-word;`, and `overflow-wrap: break-word;`, which is perfectly fine and covers all browser compatibility bases. Nothing to fix here.

### Stage 2 (Balanced)
- The implementation strictly adheres to the requested changes, correctly targeting the `.project-task-description pre` element rendered by `renderSidebarClickUpTaskDetail()`.
- Preformatted formatting is preserved thanks to `pre-wrap` while enabling boundaries wrapping to prevent horizontal scroll issues.
- **Actionable Fix**: None required. The UI fix is minimal, complete, and exactly aligns with the plan's proposed scope.

### Verification
- Confirmed visually via CSS rules definition in `src/webview/implementation.html`.
- No new code fixes were required. No tests broken.
