# Prompts and Agents Tab Configuration UX

**Complexity:** 4

## Goal

Consolidate custom-agent add-on configuration in the Prompts tab and fix the role selector visibility so users can actually find and configure role-specific settings. Both plans target the Prompts/Agents tab area of kanban.html: one moves the Apply Feature Directives checkbox out of the agent-creation form into the Prompts tab add-on section (where all other add-ons live), and the other fixes the role-selector dropdown CSS so it is visible against the dark background instead of blending in invisibly.

## How the Subtasks Achieve This

- **Remove "Apply Feature Ultracode/Goal Directives" Checkbox from Custom Agent Form**: Removes the checkbox from the creation form and adds it as a third role-specific add-on in the Prompts tab's `renderRoleAddons` function, consolidating all custom-agent add-on configuration in one place.
- **Fix Role Selector Dropdown Visibility in Prompts Tab**: Fixes the `<select>` CSS (brighter border, theme-aware background, focus styling) and scrolls the role selector to the top on tab switch, so the dropdown is actually visible and reachable.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix Role Selector Dropdown Visibility in Prompts Tab](../plans/feature_plan_20260706085729_fix-role-selector-dropdown-visibility-prompts-tab.md) — **CODE REVIEWED**
- [ ] [Remove "Apply Feature Ultracode/Goal Directives" Checkbox from Custom Agent Form](../plans/feature_plan_20260706085728_move-feature-directives-to-prompts-tab.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks edit different parts of the Prompts tab. Soft sequencing: testing the moved-checkbox subtask benefits from the role selector being visible first.
