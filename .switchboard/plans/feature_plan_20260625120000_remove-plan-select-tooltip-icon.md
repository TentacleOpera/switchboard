# Remove Tooltip Icon Next to PLAN SELECT Heading in implementation.html

## Goal

Remove the inline `ⓘ` tooltip icon (`<span class="tooltip-icon">`) from the `PLAN SELECT` section label in `src/webview/implementation.html`, and delete the now-orphaned `.tooltip-icon` CSS rule, so the heading is visually consistent with every other `section-label` in the implementation view.

### Problem
In `src/webview/implementation.html`, the `PLAN SELECT` section label includes an inline `ⓘ` tooltip icon (`<span class="tooltip-icon">`) that is out of step with every other section heading in the same view. No other `section-label` in the implementation view carries a tooltip icon, so this single instance creates a visual inconsistency — one heading has a faint `ⓘ` glyph hovering next to it, the rest do not.

### Root Cause
The tooltip was likely added as a one-off help hint ("If the plan select dropdown does not appear correct, use the Recover menu…") but was never propagated to the other headings, and the help text it carries is recoverable through the existing Recover menu / agent workflows it references. The `.tooltip-icon` CSS class (lines 171–182) exists solely to support this one element — it has no other consumers in the file.

### Desired Outcome
Remove the tooltip icon span from the `PLAN SELECT` label and delete the now-orphaned `.tooltip-icon` CSS rule, leaving the heading visually consistent with its siblings.

## Metadata
- **Tags:** ui, ux, refactor
- **Complexity:** 2

## User Review Required
No review required. This is a pure visual-cleanup deletion with no behavioral, state, or data impact. The only user-facing consequence is the disappearance of a faint `ⓘ` glyph and its hover-only `title` tooltip — both of which are already inaccessible to keyboard/touch users and redundant with the Recover menu.

## Complexity Audit

### Routine
- Single-file markup deletion (`src/webview/implementation.html`).
- Single CSS rule deletion in the same file's inline `<style>` block.
- No JavaScript reads or toggles `.tooltip-icon` or the span's `title` attribute (verified via grep across `src/**/*.js`).
- The `.tooltip-icon` class is defined in `implementation.html`'s inline `<style>` (lines 171–182), so it is scoped to this one file — zero chance of cross-file leakage or breakage in other webviews.
- No migration concerns — this is unreleased visual polish.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Static markup/CSS; no runtime state, no async, no event handlers attached.
- **Security:** None. Removing a decorative span and a CSS rule introduces no input handling, no injection surface, no privilege change.
- **Side Effects:** None. No JS references the element or class. The `title` attribute was hover-only and already inaccessible to keyboard/touch users, so removing it does not regress accessibility.
- **Dependencies & Conflicts:**
  - **Other consumers of `.tooltip-icon`:** Verified via grep — only the `PLAN SELECT` span uses it (2 matches total in `src/`, both in `implementation.html`: the CSS definition and the span). No other webview file references the class; it is scoped to this file's inline `<style>`.
  - **Other `section-label` usages:** 5 total in the file (lines 1391, 1443, 1527, 1541, 1613). Only the `PLAN SELECT` one at line 1541 carries a tooltip icon — confirming the consistency claim.
  - **Help text loss:** The hint text ("use the Recover menu or ask an agent to run the Fix Plans Dropdown skill") is assumed to remain discoverable via the Recover menu itself, which is a named, persistent UI affordance. No user-facing capability is lost; at worst a minor hover hint is removed.

## Dependencies
- None

## Adversarial Synthesis
Key risks: stale line-number citations in the original plan (span was cited as 1535–1537 but is actually at 1541–1543), non-compliant tags, and an unverified claim that the Recover menu surfaces equivalent guidance. Mitigations: line numbers corrected below to 1541–1543; tags corrected to the allowed vocabulary (`ui, ux, refactor`); the Recover-menu discoverability claim is softened to "assumed" since it is a named persistent affordance regardless. Net risk is negligible — this is a complexity-2 single-file deletion with no logic, state, or JS coupling.

## Proposed Changes

### File: `src/webview/implementation.html`

**1. Remove the tooltip icon span from the PLAN SELECT label (lines 1541–1543).**

Current (lines 1541–1543):
```html
<div class="section-label">PLAN SELECT <span class="tooltip-icon"
        title="If the plan select dropdown does not appear correct, use the Recover menu or ask an agent to run the Fix Plans Dropdown skill.">ⓘ</span>
</div>
```

Replace with:
```html
<div class="section-label">PLAN SELECT</div>
```

**2. Delete the orphaned `.tooltip-icon` CSS rule (lines 171–182).**

Remove:
```css
.tooltip-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 5px;
    font-size: 10px;
    color: var(--text-secondary);
    opacity: 0.5;
    cursor: default;
    vertical-align: middle;
    font-style: normal;
}
```

**Implementation notes:**
- Both edits are in the same file. Apply the markup edit first, then the CSS edit. Order does not matter functionally.
- After deletion, the surrounding blank line at line 183 (between the deleted rule and `.section-header`) should be preserved to avoid double-blank-line artifacts.

**Edge Cases:**
- If a future contributor re-adds a tooltip icon to any heading, they will need to re-introduce a `.tooltip-icon` (or equivalent) rule — this is expected and acceptable; the class is not part of a shared stylesheet.
- The `PLAN SELECT` label text itself is unchanged; only the trailing span is removed.

## Verification Plan

### Automated Tests
N/A — skipped per session directive. No unit/integration/e2e tests apply to a static markup/CSS deletion; the test suite will be run separately by the user.

### Manual Verification
- [ ] Open the Implementation view in the webview and confirm the `PLAN SELECT` heading matches the visual style of the other section labels (no `ⓘ` glyph, consistent spacing).
- [ ] Confirm no console errors related to missing `.tooltip-icon` styling.
- [ ] Grep `implementation.html` for `tooltip-icon` and confirm zero remaining matches.
- [ ] Spot-check the Recover menu still opens and functions (the help text's fallback path is intact).

## Recommendation
Complexity 2 → **Send to Intern**.
