---
description: 'Project Panel Tab Reliability & Styling'
---

# Project Panel Tab Reliability & Styling

## Goal

Fix the Project panel's tab state synchronization, filter navigation, and visual consistency. Today, the Project panel sometimes shows no projects (tab state desync), the Projects tab has inconsistent styling and uses the wrong UX pattern for project selection, the Review Plan button opens the widest filter instead of the narrowest (showing all plans instead of the specific plan being reviewed), and the Copy Prompt action doesn't update the DB column or kanban position (so the plan stays in CREATED after its prompt has been copied).

## How the Subtasks Achieve This

- **Bug: Project Panel Sometimes Shows No Projects**: The Project panel's tab state can desync from the actual workspace state, resulting in an empty project list. Root cause is a race between workspace initialization and tab rendering. This plan adds a re-sync on workspace focus changes and a fallback render path that queries the workspace directly when the cached state is empty.

- **Bug: Project Panel Projects Tab Missing Styling and Uses Wrong UX Pattern**: The Projects tab uses a plain list with no visual hierarchy and a click-to-select pattern that doesn't match the rest of the extension's card-based UI. This plan restyles the Projects tab to use card-based project entries with consistent spacing, borders, and hover states matching the kanban card pattern.

- **Bug: Review Plan Button Opens Widest Filter Instead of Narrowest**: When clicking "Review Plan" on a specific plan, the plan viewer opens with the widest filter (showing all plans) instead of filtering to just that plan. Root cause is the filter scope defaulting to "all" instead of using the plan ID from the click context. This plan fixes the filter initialization to use the narrowest scope (single plan) when a plan ID is provided.

- **Bug: Copy Prompt on Plan Does Not Update DB Column or Kanban Position**: When a user clicks "Copy Prompt" on a plan in the CREATED column, the prompt is copied to clipboard but the plan's DB column and kanban position don't update. The plan should move to PLAN REVIEWED (or at least IN PROGRESS) after its prompt has been copied, signaling that the plan has been handed off. This plan adds a column update call after the copy action.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Bug: Copy Prompt on Plan Does Not Update DB Column or Kanban Position](../plans/feature_plan_20260626100855_copy_prompt_no_db_column_update.md) — **CODER CODED**
- [ ] [Bug: Project Panel Sometimes Shows No Projects](../plans/feature_plan_20260626100857_project_panel_sometimes_no_projects.md) — **CODER CODED**
- [ ] [Bug: Project Panel Projects Tab Missing Styling and Uses Wrong UX Pattern](../plans/feature_plan_20260626100860_projects_tab_styling_ux_inconsistency.md) — **CODER CODED**
- [ ] [Bug: Review Plan Button Opens Widest Filter Instead of Narrowest](../plans/feature_plan_20260626100856_review_plan_widest_filter.md) — **CODER CODED**
<!-- END SUBTASKS -->
