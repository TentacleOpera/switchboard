# Fix Research Tab in planning.html

## Goal
Redesign the Research tab to replace the useless segmented control with a text input for specifying a research topic, and update the "Send to Analyst" button to be a primary action.

## Metadata
- **Tags:** UI, UX, workflow
- **Complexity:** 4
- **Repo:** none

## User Review Required
No

## Complexity Audit
### Routine
HTML layout updates, removing old DOM elements, and updating string interpolation logic in JS.
### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None.
- **Security**: None.
- **Side Effects**: Removing complexity levels and the segmented control may leave orphaned persisted state in `state.json` (`researchMode`), but it is harmless.
- **Dependencies & Conflicts**: The `generateResearchPrompt()` function is tied to other inputs like `#import-toggle`. Care must be taken not to break the import flag logic when refactoring the string builder.

## Dependencies
None

## Adversarial Synthesis
Key risks: Disruption to analyst prompt parsing due to removed complexity levels; UI state mismatches when toggling the analyst availability. Mitigations: Use a clear string template for the new prompt and strictly tie the analyst button's `disabled` state to the `analystAvailabilityResult` message.

## Proposed Changes

### `src/webview/planning.html`
- **Logic/Implementation**: 
  - Remove the "RESEARCH MODE" card (including the `.segmented-control` and `#research-mode-description`).
  - Remove the complexity radio buttons card entirely.
  - Insert a new "RESEARCH PROMPT" card featuring a `textarea` (`#research-prompt-input`).
  - Rename the `#btn-send-to-analyst` button text to `SEND ANALYST REQUEST`.
  - Remove the inline `style="display: none;"` on `#btn-send-to-analyst` so it remains in the document flow, relying on the `disabled` attribute for state.

### `src/webview/planning.js`
- **Logic/Implementation**:
  - Update `generateResearchPrompt()` to extract the value from `#research-prompt-input`. If the value exists, append it to the prompt; otherwise, use a placeholder.
  - Remove all event listeners and logic tied to the deleted segmented controls and complexity modes.
  - Update the `analystAvailabilityResult` message handler (around line 1541) to toggle the `disabled` property on the `#btn-send-to-analyst` button (and update its `title`) instead of toggling display styles.

## Verification Plan

### Automated Tests
- N/A

### Manual Testing
- Open the Planning webview and navigate to the Research tab.
- Verify the segmented "WEB RESEARCH" control and complexity options are gone.
- Verify the new `textarea` for the research topic is visible and accepts input.
- Type a topic and click "Copy Prompt". Verify the custom topic is included in the clipboard output.
- Clear the topic and click "Copy Prompt". Verify the fallback placeholder text is included.
- Verify "Send Analyst Request" is visible. If the analyst is unavailable, ensure it is visually disabled and unclickable.

**Recommendation:** Send to Coder