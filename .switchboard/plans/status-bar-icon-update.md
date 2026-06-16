# Update Status Bar Icons for Design and Clear

## Metadata
**Complexity:** 1
**Tags:** ui, refactor

## Goal
Update the status bar icons in Switchboard to resolve the conflict where both "Design" and "Clear" actions use the same `$(paintcan)` icon.

## Problem
The status bar has two buttons that currently use identical icons:
- **Design** (line 1795): `$(paintcan) Design` - opens design panel with Google Stitch integration
- **Clear** (line 1765): `$(paintcan) Clear` - clears agent terminals and resets context

This creates user confusion as the visual indicators are identical.

## Solution
Change the icons to semantically appropriate alternatives:
- **Design**: Change from `$(paintcan)` to `$(symbol-color)` - represents visual design/color work
- **Clear**: Change from `$(paintcan)` to `$(eraser)` - represents wiping/resetting action

## Implementation Steps

1. **Update Clear icon** (line 1765 in `src/extension.ts`)
   - Change: `terminalClearStatusBarItem.text = '$(paintcan) Clear';`
   - To: `terminalClearStatusBarItem.text = '$(eraser) Clear';`

2. **Update Design icon** (line 1795 in `src/extension.ts`)
   - Change: `designStatusBarItem.text = '$(paintcan) Design';`
   - To: `designStatusBarItem.text = '$(symbol-color) Design';`

## Files Changed
- `src/extension.ts` (2 lines)

## Verification
- Reload the extension
- Verify status bar shows distinct icons for Design and Clear buttons
- Confirm tooltips remain unchanged
- Confirm button functionality remains unchanged

## Risks
None - this is a purely cosmetic change with no functional impact.

## Review Findings
Implementation matches plan exactly. Both icon changes verified in `src/extension.ts` (lines 1765 and 1795). Icons `$(eraser)` and `$(symbol-color)` confirmed as valid codicons in `@vscode/codicons@0.0.44`. No `paintcan` references remain in `src/`. Full caller/consumer trace shows `.text` is only set at initialization; commands, tooltips, and visibility logic are untouched. No tests reference these icon strings. No code fixes applied. Verification skipped per prompt directives (SKIP COMPILATION / SKIP TESTS). Remaining risk: `dist/extension.js` contains stale `paintcan` references until next webpack build, but file is untracked.
