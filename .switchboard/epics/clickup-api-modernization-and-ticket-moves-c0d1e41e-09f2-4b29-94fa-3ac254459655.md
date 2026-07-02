# ClickUp API Modernization and Ticket Moves

**Complexity:** 5

## Goal

Migrate the ClickUp API integration from v2 to v3 with version-aware plumbing, and implement cross-provider ticket moves between lists and projects. The ticket-move plan depends on the v3 migration httpRequestV3 helper, making these tightly coupled.

## How the Subtasks Achieve This

- **ClickUp API v2 to v3 Migration**: Introduces version-aware HTTP plumbing (httpRequestV2/httpRequestV3), migrates the getTask and updateTask endpoints to v3, and adds a fallback safety net for the installed user base.
- **Move Tickets Between Lists/Projects (ClickUp and Linear)**: Implements the ability to move tickets between ClickUp lists and between Linear projects, using the v3 httpRequestV3 helper for ClickUp moves and the Linear API for project moves.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move Tickets Between Lists/Projects (ClickUp and Linear)](../plans/feature_plan_20260702112125_ticket-move-between-lists-projects.md) — **PLAN REVIEWED**
- [ ] [ClickUp API v2 → v3 Migration (Version-Aware Plumbing + Selective Endpoint Migration)](../plans/feature_plan_20260702120053_clickup-api-v2-to-v3-migration.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
