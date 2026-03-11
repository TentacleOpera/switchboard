# Add custom agent builder option

## Notebook Plan

In setup menu, below the agent cli command entry fields, add a 'Add custom agent' button. This opens a config modal with these options:

Agent name: defined the agent name, will populate its name in the sidebar, the buttons, the kanban etc. basically anywhere where something like 'lead coder' is used.
Startup command: the startup command this agent's terminal receives when the 'open agent terminals' button is pressed.
PRompt instructions: enter the prompt instrucitons this agent terminal will receive when the 'send to agent' button is pressed, or a card is dragged into the agent's kanban column. These instrucitons will always be in addition to the plan link and plan boilerplate that the other agents receive. So e.g. if a user sets up a frontend coder agent, they may want to specify instructions of 'implement all the frotnend parts of this plan only'. Then the prompt that is sent to the agent will include that, but will also include the standard boilerplate that is sent to the coder agents, such as the plan link and the insturctions to use it as the source of truth.
Add to kanban option and order: option to add it to the kanban, and the order it will appear relative to the other columns

After the user has saved, this custom agent should appear in the setup menu, with an option to reopen this setup to edit the agent, as well as delete it.

## Goal
- Clarify expected outcome and scope.

## Proposed Changes
- TODO

## Verification Plan
- TODO

## Open Questions
- TODO
