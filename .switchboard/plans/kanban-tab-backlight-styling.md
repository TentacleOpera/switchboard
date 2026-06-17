# Add Cyber Theme Backlight Styling to Kanban Tab Navigation

## Metadata
**Complexity:** 2
**Tags:** ui, frontend

## Goal
Update `kanban.html` to match the tab navigation backlight styling present in `planning.html` and `design.html`. The kanban tab buttons are missing the cyber theme glow effect on hover. Inconsistent hover glow across webview panels breaks visual continuity.

## Problem
The `.strip-btn` elements in kanban.html lack the `.cyber-theme-enabled .strip-btn:hover:not(:disabled)` CSS rule that provides the teal backlight/glow effect when the cyber theme (afterburner/claudify) is active. This creates an inconsistent user experience across the three webview panels.

## Solution
Add the missing CSS rule to kanban.html's stylesheet section:

```css
.cyber-theme-enabled .strip-btn:hover:not(:disabled) {
    box-shadow: var(--glow-teal);
}
```

This rule should be placed near the existing `.strip-btn` styles and other cyber theme rules for consistency.

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

## Implementation Steps
1. Locate the `.strip-btn` CSS section in kanban.html (around line 227-275)
2. Add the cyber theme hover rule after the existing `.strip-btn:hover:not(:disabled)` rule
3. Ensure the rule is placed logically near other cyber theme styling (if present in the file)

## User Review Required
No

## Complexity Audit

### Routine
- Single CSS rule addition in one file
- Reuses existing `--glow-teal` custom property already defined in `:root`
- Follows established, verbatim pattern from `planning.html` and `design.html`

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None
- **Security:** None
- **Side Effects:** None. The rule is purely additive and qualified by `.cyber-theme-enabled`, so default theme behavior is unchanged.
- **Dependencies & Conflicts:** None. `--glow-teal` is defined in `:root` at line 28. No conflicting `.cyber-theme-enabled .strip-btn:hover` rule exists in kanban.html.

## Dependencies
None

## Adversarial Synthesis
Key risks: copy-paste drift across three monolithic HTML files and potential line-number staleness in maintenance. Mitigations: anchor insertion on the `.strip-btn:hover:not(:disabled)` selector rather than a hard line number, and place the new rule immediately adjacent to existing `.strip-btn` variants to keep the style block cohesive.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`
- **Context:** The `.strip-btn:hover:not(:disabled)` rule exists at lines 247-251. `planning.html` (line ~2092) and `design.html` (line ~2133) both include an additional `.cyber-theme-enabled .strip-btn:hover:not(:disabled)` rule that adds `box-shadow: var(--glow-teal)`.
- **Logic:** When the `cyber-theme-enabled` class is present on a parent element (triggered by afterburner/claudify theme), `.strip-btn` elements in the controls strip should emit the teal glow on hover.
- **Implementation:** Insert the following rule after line 251 (the closing brace of `.strip-btn:hover:not(:disabled)`):
  ```css
  .cyber-theme-enabled .strip-btn:hover:not(:disabled) {
      box-shadow: var(--glow-teal);
  }
  ```
- **Edge Cases:** Disabled buttons remain excluded via `:not(:disabled)`. The glow will not appear on non-cyber themes because the selector requires `.cyber-theme-enabled`.

## Verification Plan

### Automated Tests
- Not applicable. No automated test coverage exists for VS Code webview hover CSS effects. Verification is manual per the steps below.

## Verification
- Open kanban.html in a webview with afterburner or claudify theme enabled
- Hover over tab navigation buttons
- Confirm the teal backlight/glow effect appears on hover, matching planning.html and design.html behavior

---

**Recommendation:** Send to Intern
