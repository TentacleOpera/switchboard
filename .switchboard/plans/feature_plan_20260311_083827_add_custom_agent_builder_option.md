# Add custom agent builder option

## Notebook Plan

In setup menu, below the agent cli command entry fields, add a 'Add custom agent' button. This opens a config modal with these options:

Agent name: defined the agent name, will populate its name in the sidebar, the buttons, the kanban etc. basically anywhere where something like 'lead coder' is used.
Startup command: the startup command this agent's terminal receives when the 'open agent terminals' button is pressed.
PRompt instructions: enter the prompt instrucitons this agent terminal will receive when the 'send to agent' button is pressed, or a card is dragged into the agent's kanban column. These instrucitons will always be in addition to the plan link and plan boilerplate that the other agents receive. So e.g. if a user sets up a frontend coder agent, they may want to specify instructions of 'implement all the frotnend parts of this plan only'. Then the prompt that is sent to the agent will include that, but will also include the standard boilerplate that is sent to the coder agents, such as the plan link and the insturctions to use it as the source of truth.
Add to kanban option and order: option to add it to the kanban, and the order it will appear relative to the other columns

After the user has saved, this custom agent should appear in the setup menu, with an option to reopen this setup to edit the agent, as well as delete it.

## Goal
- Allow users to dynamically define and configure custom agents, integrating them into the setup menu, terminal orchestration, and Kanban board.

## Proposed Changes
- Define a data schema for custom agents (e.g., `CustomAgentConfig` containing name, startup command, custom prompt, kanban inclusion/order).
- Determine storage mechanism for custom agent configurations (e.g., `workspaceState` or a `.switchboard/agents.json` file).
- Update the Setup Webview UI (`src/webview/switchboard/setup.html` or similar) to include the "Add custom agent" button, the configuration modal, and the list of saved custom agents (with edit/delete functionality).
- Update `InteractiveOrchestrator.ts` (or the relevant terminal manager) to dynamically spawn terminals for custom agents using their defined startup commands.
- Update `KanbanProvider.ts` to dynamically inject columns based on custom agent configuration.
- Update the prompt generation logic to merge the custom agent's instructions with standard boilerplate when delegating tasks.

## Verification Plan
- Create a custom agent, verifying it appears in the setup menu list.
- Edit and delete the custom agent, verifying state updates correctly.
- Ensure the custom agent appears as a column in the Kanban board (if configured).
- Open agent terminals and verify the custom agent's terminal starts with the correct command.
- Delegate a task to the custom agent and verify the prompt contains both the custom instructions and standard boilerplate.

## Open Questions
- Where exactly should the state for custom agents be stored to persist across sessions but remain project-specific?
- How do we handle name collisions with default agents (e.g., user names their custom agent "Lead Coder")?

## Review Feedback
- **Grumpy Review:** This is a major structural change! "Add custom agent builder option"? You're talking about dynamic UI generation, injecting custom commands into terminal startup scripts, altering the Kanban board columns on the fly, and dynamically constructing prompts with injected custom instructions! Where is the state for this stored? VS Code global state? `workspaceState`? A custom JSON file in `.switchboard`? What happens to the UI when someone adds 50 custom agents? How do we handle naming collisions? The "Proposed Changes" are empty, but this touches the Webview UI, the Kanban provider, the Terminal orchestration logic, and prompt building services! Stop dreaming up features without planning the data models!
- **Balanced Synthesis:** Adding a custom agent builder is a powerful feature but introduces significant complexity. It requires dynamically updating the Kanban columns, Webview setup UI, and terminal orchestration logic. We need a robust data model to store these custom agent configurations (likely in workspace state or a configuration file) and a clear mechanism to merge custom prompts with the standard boilerplate. The plan must detail the exact state management approach and how the Kanban and Terminal managers will dynamically ingest these new configurations.

#### Complexity Audit
- Band B (architectural). Requires dynamic UI generation, updating the Kanban provider to inject columns, updating Terminal orchestration logic to spawn terminals dynamically, and implementing a new storage mechanism for custom agent config.

#### Edge-Case Audit
- Race conditions: Possible race condition if multiple custom agents are added/edited simultaneously or if the Kanban provider refreshes before state is fully saved.
- Side effects: Modifying prompt generation could accidentally break standard boilerplate for default agents. Name collisions could overwrite or conflict with default agents.
- Security holes: The "Startup command" input allows arbitrary command execution. If a user inputs malicious commands, the extension will execute them.