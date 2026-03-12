# Add docs button to setup menu

## Notebook Plan

Add a button to open docs in the setup menu, underneath the save startup commands button. This button should open the project readme.

## Goal
- Clarify expected outcome and scope.

## Proposed Changes
- TODO: Identify the exact webview file (e.g., `src/webview/switchboard/setup.html` or similar) and update the HTML/CSS to include the button.
- TODO: Implement the message passing from the webview to the extension to handle the button click.
- TODO: Add the extension-side handler to open the `README.md` file using VS Code's native markdown preview or file open commands.

## Verification Plan
- TODO: Verify the button appears in the correct location with correct styling.
- TODO: Verify clicking the button successfully opens the `README.md` file.

## Open Questions
- Which specific webview file contains the setup menu?
- Should we use `vscode.open` or `markdown.showPreview` to display the README?

## Review Feedback
- **Grumpy Review:** The plan is completely devoid of technical details. "Setup menu" is ambiguous. Needs explicit file paths and VS Code command targets.
- **Balanced Synthesis:** The feature is simple and low-risk, but requires specifying the target UI file, the message passing mechanism, and the exact VS Code command to open the documentation. This is a routine Band A task once details are finalized.

#### Complexity Audit
- Band A (routine task). Adds a button to the UI that calls an existing VS Code native command (`markdown.showPreview`).

#### Edge-Case Audit
- Race conditions: None identified.
- Side effects: The `README.md` file might not exist in the root directory if moved or deleted, causing the command to fail silently or throw an error. A fallback or existence check might be needed before invoking the command.
- Security holes: None identified.
