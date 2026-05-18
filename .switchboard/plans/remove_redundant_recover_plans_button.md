# Remove Redundant Webview Recover Plans Button

## Goal
Remove the redundant `#btn-recover-plans` button from the `implementation.html` header, remove its dead JavaScript event listener, and clean up the associated stale regression test.

## Metadata
- **Tags:** UI, bugfix
- **Complexity:** 2
- **Repo:** none

## User Review Required
No

## Complexity Audit
### Routine
Single-file HTML and JS cleanup. Removing a button and its listener is low risk.
### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None.
- **Security**: None.
- **Side Effects**: We must ensure the singular `#btn-recover-plan` (bottom button) remains completely untouched and active in `COMPLETED` mode.
- **Dependencies & Conflicts**: None.

## Dependencies
None

## Adversarial Synthesis
Key risks: Leaving dead code or accidentally affecting the bottom RECOVER button. Mitigations: Completely remove the `#btn-recover-plans` event listener instead of just guarding it, and strictly ensure `#btn-recover-plan` logic remains isolated.

## Proposed Changes

### `src/webview/implementation.html` (and associated script)
- **Context/Implementation**: Locate and remove the `#btn-recover-plans` HTML element from the header toolbar (around line 1785).
- **Context/Implementation**: Locate the JavaScript event listener registration for `#btn-recover-plans`. Instead of guarding it with a null check, completely remove the event listener block to eliminate dead code.

### `src/test/plan-recovery-regression.test.js`
- **Context/Implementation**: Find and remove the UI test assertion that expects the `RECOVER` button to appear before the `DELETE` button in the HTML (lines 97-104).

## Verification Plan

### Automated Tests
- Run the test suite containing `src/test/plan-recovery-regression.test.js` to ensure it passes cleanly without the stale UI assertion.

### Manual Testing
- Open the extension webview (Implementation mode).
- Verify the RECOVER button is no longer present in the top header area.
- Open Developer Tools and verify there are no `TypeError` or reference errors logged during initialization.
- Toggle the plan mode to `COMPLETED` and verify the singular `RECOVER` (`#btn-recover-plan`) button appears at the bottom and functions correctly.

**Recommendation:** Send to Coder