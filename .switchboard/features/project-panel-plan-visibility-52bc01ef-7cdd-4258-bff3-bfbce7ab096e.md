# Project Panel Plan Visibility

**Complexity:** 6

## Goal

Make the Project panel reliably show the correct, current plans without requiring the user to close and reopen it. Today the panel shows stale or empty plan data after being hidden and re-shown (no re-fetch on visibility change), and the Review Plan button shows wrong plans after a workspace switch (the kanbanPlansReady handler fights with the Review Plan flow filter-clearing logic). Both plans address the same capability — the Project panel plan cache and filter state going stale or wrong — and both touch the same project.js and PlanningPanelProvider.ts code paths.

## How the Subtasks Achieve This

- **Fix: Project panel not refreshing — stale/empty plans until close-and-reopen**: Registers onDidChangeViewState handlers so the panel re-fetches plans when it becomes visible again, triggers a refresh when openProject() is called on an existing panel, and fixes the request-ID guard race that can discard the initial full fetch response when a proactive push arrives during the async window.
- **Fix: Review Plan button shows wrong plans after switching workspace**: Adds a guard to the kanbanPlansReady handler at project.js:484-491 to skip the auto-set of kanbanFilters.workspaceRoot when a pending Review Plan selection is active, preventing the filter from narrowing to the wrong workspace and hiding the target plan during and after the selection flow.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: Project panel not refreshing — stale/empty plans until close-and-reopen](../plans/feature_plan_20260707100624_autism360-plans-not-showing-in-project-panel.md) — **PLAN REVIEWED**
- [ ] [Fix: Review Plan button shows wrong plans after switching workspace in kanban.html](../plans/feature_plan_20260707100604_review-plan-button-wrong-plans-after-workspace-switch.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraint — both touch project.js and PlanningPanelProvider.ts but in different code paths (refresh-on-visible vs filter-intent guard). They can be executed in parallel, but coordinate the merge so both edits to project.js land cleanly. The Review Plan fix is most impactful when the panel refresh fix is also present (a refreshed panel is useless if the filter then hides the target plan).
