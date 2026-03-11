# Allow user customisation of what agents appear

## Notebook Plan

In the setup menu, (both onboarding setup as well as the normal setup menu in the sidebar panel), add ticks beside each agent name (lead coder, reviewer etc) that allow the user to turn off the agent display. Each agent defaults to on. Unselecting it, then pressing the 'save startup commands' button, removes the agent from the 'agents' tab of the sidebar. A status message should display under the kanban column title saying 'No agent assigned' if the agent has been removed.

## Goal
- Allow users to toggle the visibility of specific agents in the UI (Agents tab).
- Persist agent visibility preferences.
- Ensure Kanban columns for hidden agents remain visible but display a "No agent assigned" state, retain existing tasks, and reject new task assignments.

## Proposed Changes
- (Pending Investigation) Determine the appropriate storage mechanism for agent visibility preferences (e.g., VS Code workspace settings, `switchboard.visibleAgents`).
- Add checkboxes to the onboarding and sidebar setup menus for each registered agent, defaulting to true.
- Decouple the saving of UI preferences from the "save startup commands" action, or clarify how these states are saved together if they share a configuration form (e.g., rename to "Save Configuration").
- Update the Agents tab rendering logic to filter out agents that are unselected in the preferences.
- Update the Kanban view rendering logic:
  - DO NOT hide the column when an agent is unassigned/disabled.
  - Display the "No agent assigned" message (coordinate with the separate pending plan that implements this field).
  - Show existing completed/assigned tasks in that column.
  - Implement logic to reject or "bounce back" new tasks dragged or assigned to a column whose agent is disabled.

## Verification Plan
- Uncheck an agent in the setup menu and save the preferences.
- Verify the unchecked agent no longer appears in the "Agents" tab of the sidebar.
- Verify the Kanban column for the unchecked agent is STILL visible, but displays the "No agent assigned" message.
- Verify existing tasks in the unassigned agent's column are still visible.
- Attempt to assign a new task to the unassigned agent's column and verify it is rejected/bounces back.
- Reload the extension/workspace and verify the preference is persisted and UI reflects the saved state.
- Check an agent back on, save, and verify it reappears in the Agents tab and the Kanban view accepts tasks again.

## Open Questions
- Should this setting be stored in VS Code `workspaceState`, `globalState`, or in standard `settings.json` configurations?
- Which specific unreviewed plan contains the "No agent assigned" status field implementation, and how do we coordinate merging these changes?

## Review Feedback
- **Grumpy Review:** Ticks?! You mean checkboxes?! And 'save startup commands' button to save UI state? That's coupling unrelated things! Why are we saving UI display preferences when saving 'startup commands'? These are workspace settings! We need a proper configuration object for agent visibility. Where is this state stored? `settings.json`? VS Code workspace state? This 'plan' is just a wish list. How does the Kanban view know an agent is unassigned? What happens if I unassign the 'coder' but leave a plan in the 'coder' column? This needs a proper data model update, not just UI 'ticks'!
- **Balanced Synthesis:** The core idea of allowing users to hide specific agents from the UI is a valid quality-of-life feature. However, the plan currently conflates saving UI preferences with saving startup commands. The proposed changes need to clearly define where this preference state is stored (e.g., in a workspace setting) and how changes to this state reactively update both the Agents sidebar view and the Kanban view.
- **User Clarification:** The Kanban column should absolutely *not* vanish when an agent is hidden. The column must remain visible, show any existing/completed tasks, display a 'No agent assigned' message, and actively reject ("bounce back") any new tasks. There is also a dependency on another unreviewed plan that implements the 'No agent assigned' message field.