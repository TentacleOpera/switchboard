# Sidebar Plan Select Panel UX

**Complexity:** 3

## Goal

Streamline the implementation.html plan-select panel button layout and create-plan flow. Remove the VS Code showInputBox dialogue, rename labels for clarity, remove redundant buttons, and reorder the remaining actions to match the natural workflow.

## How the Subtasks Achieve This

- **Implementation Plan Select Panel Layout Improvements**: Renames PLAN SELECT to PLANS, removes COMPLETE/RECOVER buttons, renames COPY to COPY PROMPT and CREATE to NEW, and repositions NEW to the left of COPY PROMPT.
- **Create Plan Button Should Not Open VS Code Dialogue**: Removes the showInputBox call from createDraftPlanTicket so clicking any Create button directly creates a plan with a default title and opens the project panel in edit mode for immediate renaming.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [implementation.html plan select panel layout improvements](../plans/feature_plan_20260702083641_implementation-plan-select-panel-layout-improvements.md) — **INTERN CODED**
- [ ] [Create plan button should not open VS Code dialogue — open project.html Kanban tab instead](../plans/feature_plan_20260702083642_create-plan-button-no-vscode-dialogue.md) — **INTERN CODED**
<!-- END SUBTASKS -->
