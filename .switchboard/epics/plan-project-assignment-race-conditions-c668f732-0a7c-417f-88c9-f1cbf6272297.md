# Plan Project Assignment Race Conditions

**Complexity:** 6

## Goal

Fix two race conditions in the plan project-assignment pipeline where stale kanban.activeProjectFilter config values and overly aggressive auto-assignment logic cause plans to be assigned to the wrong project or a project when none should be assigned.

## How the Subtasks Achieve This

- **Create Plan Always Assigns to Project Even With Base Workspace**: Fixes the fire-and-forget config write in setProjectFilter that races with GlobalPlanWatcherService, causing plans created in the base workspace to inherit a stale project filter.
- **Auto-Assign to Current Project Must Only Fire on First Import**: Ensures the auto-assign-to-project logic fires only on the first import of a plan, not on every save/update, preventing unintended project reassignment during edits.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Create plan always assigns to a project even with base workspace board selected](../plans/feature_plan_20260702083644_create-plan-always-assigns-to-project.md) — **PLAN REVIEWED**
- [ ] [Auto-Assign to Current Project Must Only Fire on First Import, Not on Save/Update](../plans/feature_plan_20260702114923_auto-assign-project-only-on-first-import.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
