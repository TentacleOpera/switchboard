---
description: 'Tickets Tab & Link-All Functionality'
---

# Tickets Tab & Link-All Functionality

**Complexity:** 5

## Goal

Make the "Link All" copy-paths feature reliable and move filter controls to their correct location in the Tickets and Kanban Plans tabs. Today, "Link All" on the Tickets tab doesn't fetch all sidebar tickets (it silently truncates), the Kanban Plans tab lacks a Link All button and complexity filter, and the Status/State filter is buried inside the Tickets Source modal where users can't find it.

## How the Subtasks Achieve This

- **Feature: Link All Button + Complexity Filter in Project Panel Kanban Plans Tab**: The Kanban Plans tab in the Project Panel has no Link All button and no complexity filter, making it impossible to bulk-link plans or filter by complexity. This plan adds a Link All button (matching the Tickets tab pattern) and a complexity filter dropdown so users can bulk-link plans filtered by complexity.

- **Move Status/State Filter Out of the Tickets Source Modal**: The Status/State filter is currently inside the Tickets Source modal, which users only open when configuring ticket sources. The filter should be a persistent inline control on the Tickets tab itself, visible and accessible without opening the modal. This plan extracts the filter from the modal and places it as an inline dropdown on the tab.

- **Fix "Link All" on Tickets Tab Not Fetching All Sidebar Tickets**: The Link All button on the Tickets tab only fetches the first page of sidebar tickets, silently truncating if there are more. This plan fixes the fetch logic to paginate through all available tickets before generating the link text, ensuring no tickets are missed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature: Link All Button + Complexity Filter in Project Panel Kanban Plans Tab](../plans/feature_plan_20260626100854_link_all_complexity_filter_kanban_plans.md) — **CODE REVIEWED**
- [ ] [Move Status/State Filter Out of the Tickets Source Modal](../plans/feature_plan_20260626152607_move-status-filter-out-of-source-modal.md) — **CODE REVIEWED**
- [ ] [Fix "Link All" on Tickets Tab Not Fetching All Sidebar Tickets](../plans/feature_plan_20260626152608_fix-link-all-not-fetching-all-tickets.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

