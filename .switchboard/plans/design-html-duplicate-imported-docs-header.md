# Remove Duplicate .imported-docs-header Definition in design.html

## Metadata
**Complexity:** 1
**Tags:** bugfix, frontend

## Goal

### Problem
`.imported-docs-header` is defined twice in `design.html`:
- `:950-957` — with a comment "Subdued from accent-teal", sets `color: var(--text-secondary)`
- `:1436-1443` — identical properties, same `color: var(--text-secondary)`

Both are in the same `<style>` block with equal specificity. The second silently overrides the first. While the values are currently identical, the duplication creates a maintenance trap — someone may update one and not the other.

### Root Cause
The class was likely defined in two different sections of the CSS as the file grew, and the duplication was never noticed.

## Approach
1. Delete the second definition at `:1436-1443`
2. Keep the first at `:950-957` which has the explanatory comment

## Files Changed
- `src/webview/design.html` — remove 8 lines

## Risks
- None — both definitions are identical, so removing one changes nothing visually

## Verification
- Open the design panel and verify no visual change
