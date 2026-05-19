# Fix Research Tab in planning.html

## Goal
Redesign the Research tab to replace the useless "Research Mode" segmented control with a text input field for specifying a research prompt. The prompt will be appended when copying. The "Send to Analyst" button will be renamed to "Send Analyst Request" and made a primary action alongside Copy Prompt, sending the full prompt to the analyst terminal.

## Metadata
- **Tags:** UI, UX, workflow
- **Complexity:** 4
- **Repo:** none

## User Review Required
No

## Complexity Audit
### Routine
HTML layout updates to replace a segmented control with a textarea. Updating string interpolation logic in JS to include the textarea value while preserving existing complexity logic.
### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None.
- **Security**: None.
- **Side Effects**: Removing the segmented control may leave orphaned persisted state in `state.json` (`researchMode`), but it is harmless. We must ensure the complexity radio buttons and their associated JS logic remain completely untouched.
- **Dependencies & Conflicts**: The `generateResearchPrompt()` function relies on complexity inputs, import toggles, and now the new text area. We must append the custom prompt string cleanly without breaking existing format.

## Dependencies
None

## Adversarial Synthesis
Key risks: Accidentally breaking the complexity level logic or the import toggle logic when refactoring the string builder; UI state mismatches if the analyst terminal status changes. Mitigations: Explicitly keep the complexity radio buttons and their JS data extraction intact. Use the new textarea value as a simple string addition. Manage the disabled state of the analyst button via DOM properties rather than inline styles.

## Proposed Changes

### `src/webview/planning.html`
- **Context/Implementation**: 
  - In the first `.planning-card` under `#research-content` (lines ~1251-1270), locate the `.segmented-control` (WEB RESEARCH button) and the `#research-mode-description` div.
  - Delete `.segmented-control` and `#research-mode-description`.
  - Replace them with a new `<textarea id="research-prompt-input" class="planning-input" rows="4" placeholder="Enter research prompt..."></textarea>`.
  - Find `#btn-send-to-analyst` and change its text to `SEND ANALYST REQUEST`.
  - Remove the inline `style="display: none;"` on `#btn-send-to-analyst`.
  - **CRITICAL**: Do NOT remove or alter the second `.planning-card` containing the complexity radio buttons.

### `src/webview/planning.js`
- **Context/Implementation**:
  - In `generateResearchPrompt()` (around line 1713), add logic to extract the value from `#research-prompt-input`.
  - Append this custom topic/prompt to the generated `prompt` string. Ensure the existing `complexity` and `importEnabled` logic is preserved exactly as is.
  - Find the `analystAvailabilityResult` message handler (around line 1541) and update it so it sets the `disabled` attribute on `#btn-send-to-analyst` instead of toggling its display style.
  - Remove the dead event listener code block that previously handled clicks on the `.segmented-btn` elements.

## Verification Plan

### Automated Tests
- N/A

### Manual Testing
- Open the Planning webview and navigate to the Research tab.
- Verify the "WEB RESEARCH" segmented control is replaced by a textarea, but the Complexity levels card below it remains visible and functional.
- Type a custom topic in the textarea and select a specific complexity level.
- Click "Copy Prompt". Paste into a text editor and verify BOTH the custom topic and the complexity instructions are present in the output.
- Verify "Send Analyst Request" is visible. If the analyst is unavailable, ensure the button is disabled and cannot be clicked.

**Recommendation:** Send to Coder

## Reviewer-Executor Verification

### Stage 1: Grumpy Review (Findings)
- **[NIT] "Primary Action" mismatch**: The plan explicitly says `"made a primary action alongside Copy Prompt"`. The previous AI agent left the `secondary` CSS class on the button `<button id="btn-send-to-analyst" class="planning-button secondary">`. This means it visually looks like a secondary action instead of a primary one.
- **[NIT] orphaned UI state logic**: The `state.researchMode` initialization logic was mostly removed, but `vscode.getState().researchMode` is still technically in memory although harmless as correctly identified in the Edge-Case audit.

### Stage 2: Balanced Synthesis
- The implementation overall correctly replaced the UI, properly implemented the `textarea`, correctly updated `generateResearchPrompt()`, and successfully managed the disable state using the `msg.available` boolean.
- The `secondary` CSS class should be stripped out to fully honor the "made a primary action" requirement in the plan.

### Fixes Applied
- Removed the `secondary` CSS class from the `#btn-send-to-analyst` button in `src/webview/planning.html`.

### Verification Results
- **Files Changed**: `src/webview/planning.html`, `src/webview/planning.js`
- **Compile/Typecheck**: Passed (`npm run compile`).
- **Tests**: N/A for these webview UI files.
- **Remaining Risks**: None. The changes meet all requirements of the plan.
