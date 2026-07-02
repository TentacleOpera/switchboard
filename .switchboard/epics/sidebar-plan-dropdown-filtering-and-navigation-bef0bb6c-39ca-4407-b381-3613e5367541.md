# Sidebar Plan Dropdown Filtering and Navigation

**Complexity:** 5

## Goal

Fix the implementation.html plan-select dropdown so it correctly respects the active kanban project filter, differentiates epics from subtasks, filters out project plans in the base workspace, and reliably opens the project.html Kanban tab when a plan is selected. All four plans address the same runSheets to renderRunSheetDropdown pipeline and its relationship to the kanban project filter.

## How the Subtasks Achieve This

- **Plan Select Dropdown Must Respect Kanban Project Filter**: Ensures the sidebar dropdown filters plans by the active kanban board project filter, including the runSheets message and refresh chain.
- **Plan Select Dropdown Does Not Filter Out Project Plans in Base Workspace**: Fixes the dropdown showing project-assigned plans when the base workspace (unassigned) filter is active.
- **Plan Select Dropdown Does Not Differentiate Epics From Subtask Plans**: Adds visual differentiation in the dropdown so epics and subtasks are distinguishable from standalone plans.
- **Plan Select Dropdown Not Opening Project Kanban Tab**: Fixes the reviewPlan handler so selecting a plan from the dropdown always opens the project.html Kanban tab instead of falling back to a raw VS Code editor.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [implementation.html plan select dropdown not opening project.html kanban plans tab](../plans/feature_plan_20260702083640_plan-select-dropdown-not-opening-project-kanban-tab.md) — **CODER CODED**
- [ ] [implementation.html plan select dropdown must respect active kanban board project filter](../plans/feature_plan_20260702083643_plan-select-dropdown-respect-kanban-project-filter.md) — **CODER CODED**
- [ ] [Plan Select Dropdown Does Not Filter Out Project Plans in Base Workspace](../plans/feature_plan_20260702114251_plan-dropdown-filter-project-plans-in-base-workspace.md) — **CODER CODED**
- [ ] [Plan Select Dropdown Does Not Differentiate Epics From Subtask Plans](../plans/feature_plan_20260702114330_plan-dropdown-differentiate-epics-from-subtasks.md) — **CODER CODED**
<!-- END SUBTASKS -->
