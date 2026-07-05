# Worktrees Tab Overhaul

**Complexity:** 4

## Goal

Clean up and reorganize the kanban.html Worktrees tab so users can quickly find epic-vs-project worktree controls, understand what the suppress-main-terminals toggle and routing order actually do, and shed the no-longer-needed batch create-all button. These three plans all rewrite the same createWorktreesPanel() function and collectively transform the tab from a flat, jumbled layout into a clearly sectioned Epics/Projects/Unbound structure with helpful descriptive text and no dead batch UI.

## How the Subtasks Achieve This

- **Remove "Create Worktrees for All Epics" Button from Worktrees Tab**: Removes the batch button from the Worktrees tab UI and its backend handler in `KanbanProvider.ts`, eliminating UI clutter and dead code. The per-epic dropdown and auto-provisioning modes cover all use cases.
- **Worktrees Tab: Reorganize UI into Epics and Projects Subsections**: Restructures `createWorktreesPanel()` into clear EPICS (Auto / Manual Creation / Active Worktrees), PROJECTS (Manual Creation / Active Worktrees), and UNBOUND sections, separating epic and project controls that were previously interleaved.
- **Worktrees Tab: Add Descriptive Text for Suppress Main Terminals & Routing Order**: Expands the routing-order description to mention automatic terminal opening inside worktrees, and adds a description under the "Suppress main repo agent terminals" checkbox explaining its real behavior.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Worktrees Tab: Add Descriptive Text for Suppress Main Terminals & Routing Order](../plans/feature_plan_20260703063947_worktrees-tab-descriptive-text.md) — **CODE REVIEWED**
- [ ] [Worktrees Tab: Reorganize UI into Epics and Projects Subsections](../plans/feature_plan_20260703063948_worktrees-tab-epics-projects-subsections.md) — **CODE REVIEWED**
- [ ] [Remove "Create Worktrees for All Epics" Button from Worktrees Tab](../plans/feature_plan_20260703063946_remove-create-worktrees-for-all-epics-button.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Plan `77844254` (remove batch button) should land **before or alongside** `7b858061` (reorganize) — the reorganization's target structure already omits the batch button, so removing it first avoids a transient dead button in the new layout. Plan `3a59baf3` (descriptive text) should land **after** the reorganization so the text lands in the final section layout. Recommended order: `77844254` → `7b858061` → `3a59baf3`.
