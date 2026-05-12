# Fix ClickUp Hierarchy Dropdown Selector Bug

## Goal
Fix the broken ClickUp hierarchy dropdown selector by resolving an undefined CSS variable reference, restoring visibility of space/folder/list navigation.

## Metadata
- **Tags:** bugfix, UI
- **Complexity:** 2

## Problem
The ClickUp tab in implementation.html has a broken space/team/list dropdown selector. Users cannot select a space, and cannot view any of the other dropdowns to change the current sprint.

## Root Cause
The CSS for the ClickUp hierarchy navigation uses an undefined CSS variable `--text-muted` in two places:
- Line 1579: `.hierarchy-label { color: var(--text-muted); }`
- Line 1611: `.hierarchy-separator { color: var(--text-muted); }`

This variable is not defined in the CSS variables section (lines 10-38). An undefined CSS custom property evaluates to the empty string; for `color:`, this means the property is treated as invalid and falls back to `initial` (typically black), which renders as invisible text on the dark `#0d0d0d` background — making the hierarchy labels and separators invisible and the dropdowns appear broken.

The existing `--text-secondary: #777777` (line 19) serves the same semantic purpose as `--text-muted` but was not referenced.

## Solution
Replace the two `var(--text-muted)` references with `var(--text-secondary)` to reuse the existing variable, avoiding a duplicate definition with the same hex value.

## User Review Required
No — trivial CSS fix with no functional or architectural impact.

## Complexity Audit
### Routine
- Replace two CSS variable references in `implementation.html` (lines 1579, 1611)

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None — CSS is static, no runtime state involved.
- **Security:** None — CSS-only change.
- **Side Effects:** None — `--text-secondary` is already used elsewhere in the file for the same purpose (muted/secondary text coloring).
- **Dependencies & Conflicts:** Dependency check skipped per user instruction. Other plans touch `implementation.html` (ClickUp word wrap, sidebar autoload, subtask display rework) but none modify the `:root` variables or `.hierarchy-label`/`.hierarchy-separator` rules.

## Dependencies
- Dependency check skipped per user instruction.

## Adversarial Synthesis
Key risk: using `var(--text-muted)` was likely intentional to allow future differentiation from `--text-secondary`. Replacing with `var(--text-secondary)` closes that door. Mitigation: if future differentiation is needed, `--text-muted` can be defined as an alias at that time. The fix is minimal, correct, and carries no regression risk.

## Proposed Changes

### [src/webview/implementation.html]

**Context:** The `:root` block (lines 10-38) defines CSS custom properties. `--text-secondary: #777777` exists at line 19. `--text-muted` is referenced but never defined, causing hierarchy labels/separators to render as invisible text on the dark background.

**Logic:** Replace `var(--text-muted)` with `var(--text-secondary)` at both usage sites. This reuses the existing variable with the same color value, avoiding a redundant duplicate definition.

**Implementation:**
1. Line 1579 — change `color: var(--text-muted);` → `color: var(--text-secondary);`
2. Line 1611 — change `color: var(--text-muted);` → `color: var(--text-secondary);`

**Edge Cases:** If `--text-muted` was intended as a future-distinct variable, it can be added to `:root` later as `--text-muted: var(--text-secondary);` to maintain a single source of truth.

## Verification Plan

### Automated Tests
No automated tests exist for CSS variable resolution in the webview. Manual verification:

1. Open the implementation panel in VS Code
2. Switch to the ClickUp tab
3. Confirm the space dropdown is visible and can be opened
4. Select a space and confirm the folder dropdown appears
5. Select a folder (or root) and confirm the list dropdown appears
6. Confirm all hierarchy labels and separators are visible with proper gray/muted styling (matching `#777777`)

---

**Recommendation:** Send to Coder
