# Add agent names to kanban

## Notebook Plan

In the current agents tab of the side panel, the agent names are disalyed based on which startup commands are saved. these names should also be displayed in the kanban under the column headers. e.g. if gemini cli is assigned to planner, then under plan reviewed it should say 'Gemini CLI'. If no agent is assigned, the status name should be 'No agent assigned'.

## Goal
- Display the assigned agent's name (or a default status message) under each Kanban column header.
- Ensure the name displayed in the Kanban view matches the name displayed in the Agents side panel.

## Proposed Changes
- (Pending Investigation) Identify where the Kanban view's HTML/UI is generated or updated (likely `kanban.html` or the KanbanProvider).
- Locate the existing logic used by the Agents side panel that parses the startup commands to determine the friendly agent name (e.g., extracting "Gemini CLI" from the command string).
- Refactor or reuse this existing parsing logic so it can be called by the Kanban rendering system.
- Update the Kanban view rendering logic to display the corresponding parsed agent name under each column header.
- If an agent is not assigned or disabled, render the text 'No agent assigned' instead of an empty space or missing element.

## Verification Plan
- Assign an agent to a specific role in the settings.
- Open the Kanban view and verify that the agent's name appears under the corresponding column header and matches the sidebar exactly.
- Clear the assignment for the role and save.
- Open the Kanban view and verify that "No agent assigned" appears under the column header.
- Ensure this visual update works dynamically if settings are changed during the session.

## Open Questions
- Is the Kanban view updated reactively via webview messages when settings change, or does it only pull this data upon initial render?
- Where exactly does the sidebar currently perform the string-parsing to get the agent name, and can we easily abstract it into a shared utility function?

## Review Feedback
- **Grumpy Review:** 'Displayed based on which startup commands are saved'?! Since when do startup commands dictate the name of the agent? Are we just parsing random CLI strings now?! The name should come from the agent registration, not by string-matching some bash script! And where does this 'plan reviewed' column come from? That's just one column. What about the others? This plan completely ignores *how* the Kanban view gets this data. Are we sending a new IPC message to the webview? Are we injecting it on load? Just saying 'it should display' isn't a technical plan, it's a mock-up!
- **Balanced Synthesis:** The UI request is straightforward: show the assigned agent's name (or a fallback message) under the column headers in the Kanban board. The initial technical implementation was under-specified regarding data flow. The plan has been updated to focus on securely passing the active agent mapping from the backend Extension/KanbanProvider to the webview UI.
- **User Clarification:** The Grumpy critique regarding parsing startup commands was off-base. The system *already* successfully derives the agent name from the startup command for the Agents side panel (e.g., identifying "Gemini CLI"). We should absolutely reuse this existing, proven logic for the Kanban view rather than over-engineering a new registry. The plan has been updated to reflect reusing this specific parsing logic.