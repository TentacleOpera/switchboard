# Add optional 'Add comments' option to airlock tab

## Notebook Plan

After the create plan step in the airlock tab, add the following:

Header - 'Optional: Enhance comments'

Text - 'Tell Analyst to add explanatory comments to the top of each file. These will be drawn into the manifest file to help NotebookLM understand the codebase.'

Button: 'Add Comments'

Button behaviour: sends a message to the Analyst terminal asking it to add short explanatory comments to the top of each file in the repo to explain what the file does. If there are already comments at the top of a file, the analyst shoul skip that file.

## Goal
- Add UI elements to the Airlock tab to trigger a repository-wide comment enhancement task executed by the Analyst agent.

## Proposed Changes

### Low Complexity Steps (UI & Basic Wiring)
- **Webview Update:** Modify the Airlock tab HTML/CSS (likely in `src/webview/switchboard.html` or similar) to add the new "Optional: Enhance comments" header, descriptive text, and "Add Comments" button.
- **Message Passing:** Implement the webview script logic to emit a specific message (e.g., `command: 'addComments'`) when the button is clicked.
- **Extension Handler:** Add a listener in the extension host (likely where webview messages are handled) to intercept the `addComments` command.

### High Complexity Steps (Prompting & Execution Safety)
- **Agent Dispatch Logic:** Implement the extension-side logic to formulate the prompt and dispatch it to the Analyst terminal via the existing terminal orchestration mechanism (e.g., `InteractiveOrchestrator`).
- **Clarification - Prompt Design:** The prompt sent to the Analyst *must* be carefully constructed to ensure safety and efficiency. It must explicitly instruct the Analyst to:
  1. Respect standard ignore patterns (e.g., `.gitignore`, `node_modules`, `dist`).
  2. Only target source code text files (avoid binaries, images, lockfiles).
  3. Verify the *absence* of a top-level explanatory comment before adding one.
  4. Use efficient tool usage (e.g., batching or searching before reading) to avoid context window exhaustion.

## Verification Plan
- **UI Check:** Open the Airlock tab and verify the new header, text, and button render correctly and match existing styling.
- **Action Check:** Click the "Add Comments" button and verify that a message is successfully sent to the Analyst terminal.
- **Execution Check:** Monitor the Analyst terminal to ensure it receives the correct prompt, understands the constraint to skip already-commented files, and correctly identifies files to modify without altering restricted directories (like `node_modules`).

## Open Questions
- What happens if the Analyst terminal is not currently running or is busy with another task? Should the message be queued, or should the user be alerted?
- Is there a specific format or standard we want the Analyst to follow for these top-level comments (e.g., JSDoc style vs. standard inline comments depending on the language)?

## Review Feedback
- **Grumpy Review:** "Optional add comments option?! Have you ever seen a repository with more than 10 files? You want a single button click to tell an LLM agent to blindly go through 'each file in the repo' and start injecting comments? It'll run out of context! It'll modify binaries! It'll rewrite `node_modules`! And where does this magical 'Analyst terminal' message come from? The webview? How is that message formatted and sent through our messaging protocol? The plan is a UI daydream completely disconnected from the reality of executing a repo-wide task."
- **Balanced Synthesis:** "Adding a button to the Airlock tab to request file-level comments is a simple UI change, but the underlying action—sending a message to the Analyst agent to traverse the entire repository—carries significant execution risk. The plan needs to clearly define the UI updates (HTML/CSS in the webview), the message passing (webview to extension host), and the specific prompt/command sent to the Analyst terminal. Crucially, the prompt sent to the Analyst *must* include instructions to use appropriate tools (like `grep_search` and `write_file` or `replace`), respect ignore files, and skip non-text or generated files to prevent catastrophic context blowouts."

#### Complexity Audit
- Band B (architectural). While the UI addition is Band A, orchestrating a repo-wide task that triggers an LLM to read and write to every file requires careful prompting, batching, and handling of context window limits, as well as skipping non-text files and respecting `.gitignore`.

#### Edge-Case Audit
- Race conditions: If the Analyst is already processing a task, sending a new repo-wide command might interrupt or corrupt its current state.
- Side effects: Modifying every file will rewrite Git history massively and could trigger hundreds of file-watcher events (e.g., test runners, linters) simultaneously, potentially crashing the IDE. Could also accidentally modify binary files or `node_modules`.
- Security holes: None identified directly, but careless automated file writing could corrupt the project.