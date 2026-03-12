# Rewrite airlock tab text

## Notebook Plan

Rewrite the tutorial text in the airlock tab to be more accurate.

Under bundle code:
'Package code into docx files for NotebookLM compatibility.'

Under Upload to NotebookLM:
'Create new Notebook and upload all files in the airlock folder as sources'

Under paste response:
'Ask Notebook to make a plan following the How to Plan guide and paste response to save to .switchboard/plans and the Antigravity brain (if using Antigravity).'

## Goal
- Update the descriptive text in the Airlock tab to provide clearer, more accurate instructions for users using NotebookLM.

## Proposed Changes
- Identify the webview file containing the airlock tab UI (e.g., `src/webview/switchboard.html` or similar).
- Update the text under "Bundle Code" to: 'Package code into docx files for NotebookLM compatibility.'
- Update the text under "Upload to NotebookLM" to: 'Create new Notebook and upload all files in the airlock folder as sources'
- Update the text under "Paste Response" to: 'Ask Notebook to make a plan following the How to Plan guide and paste response to save to .switchboard/plans and the Antigravity brain (if using Antigravity).'

## Verification Plan
- Open the extension webview and navigate to the Airlock tab.
- Visually inspect the text under the three sections to ensure it matches the new strings exactly.
- Verify no styling or layout was broken by the text length changes.

## Open Questions
- None. This is a direct copy update.

## Review Feedback
- **Grumpy Review:** Is this a joke? We are basically just doing a find-and-replace on some strings in a UI file. The plan completely ignores *where* these strings live. Are they hardcoded in some webview HTML? Or sprinkled across random `.ts` files? You 'planned' the exact strings but couldn't be bothered to grep for the file path? Don't make me guess! Fill in the `Proposed Changes` with the actual file paths instead of this 'TODO' nonsense.
- **Balanced Synthesis:** The proposed change is a straightforward copy update to improve clarity for users operating the airlock tab. There are no architectural shifts or complex logic involved. However, the plan was incomplete because it omitted the target file paths. Once the specific webview HTML/JS files are identified, this is a very simple string replacement task.

#### Complexity Audit
- Band A (routine task). String replacement in an HTML/UI file. No architectural logic changes.

#### Edge-Case Audit
- Race conditions: None identified.
- Side effects: Longer strings might cause the webview layout or flexbox to wrap unexpectedly or break the design. The verification plan accounts for this.
- Security holes: None identified.
