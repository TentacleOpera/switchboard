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

***

## Final Review Results

### Implemented Well
- Added `<button id="btn-open-docs">` directly under the save startup configuration button in `src/webview/implementation.html`.
- Implemented message passing (`{ type: 'openDocs' }`) from the webview to the extension.
- Added the corresponding backend handler in `src/services/TaskViewerProvider.ts` that safely resolves `README.md` against the `extensionUri` instead of assuming current workspace.
- The handler correctly includes an explicit `fs.stat` check and uses `markdown.showPreview` rather than `vscode.open`, providing an elegant error fallback without throwing unhandled exceptions.

### Issues Found
- None. The implementation fulfills the goal completely and addresses the edge-case mentioned in the plan flawlessly.

### Fixes Applied
- None required.

### Validation Results
- Code analysis confirms the end-to-end integration is sound.
- Executed `npm run compile`. Webpack successfully bundled the frontend logic and TypeScript correctly verified `TaskViewerProvider.ts`. No syntax or build errors encountered.

### Remaining Risks
- The documentation relies entirely on the local `README.md`. If the documentation splits into multiple pages or remote links, this static handler will need to become more dynamic.

### Final Verdict: Ready
