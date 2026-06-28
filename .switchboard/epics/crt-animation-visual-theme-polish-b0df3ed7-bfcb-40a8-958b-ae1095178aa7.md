---
description: 'CRT Animation & Visual Theme Polish'
---

# CRT Animation & Visual Theme Polish

## Goal

Fix visual consistency issues in the Afterburner/claudify themes — CRT scanline animation appears in panels where it shouldn't, the "Disable CRT Animation" toggle doesn't take effect until a full reload, and kanban card meta text (complexity + timestamp) renders in teal instead of grey, breaking visual hierarchy. Together these make the themed UI feel unfinished and inconsistent.

## How the Subtasks Achieve This

- **Remove CRT Scanline Animation from the Design and Setup Panels**: The CRT scanline animation currently renders on all panels, including the Design and Setup panels where it's distracting and inappropriate. The animation should only appear on the main kanban board. This plan scopes the CRT animation CSS to the kanban board container only, removing it from the Design and Setup panels.

- **Make the "Disable CRT Animation" Toggle Take Effect Live**: The "Disable CRT Animation" toggle in settings requires a full webview reload to take effect. Users expect the animation to stop immediately when they toggle it off. This plan adds a CSS class toggle on the webview root element that's bound to the setting, so the animation stops (or starts) instantly without a reload.

- **Unify Kanban Card Meta (Complexity + Timestamp) to Grey Across Themes**: In the Afterburner theme, kanban card meta text (complexity badge and timestamp) renders in teal, which clashes with the theme's accent color and creates visual noise. The meta text should be a neutral grey across all themes so the card title and status badges remain the visual focus. This plan overrides the meta text color to grey in the Afterburner/claudify theme CSS.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove CRT Scanline Animation from the Design and Setup Panels](../plans/feature_plan_20260626124050_crt_animation_scope_design_setup_panels.md)
- [ ] [Make the "Disable CRT Animation" Toggle Take Effect Live](../plans/feature_plan_20260626124051_crt_animation_disable_not_live.md)
- [ ] [Unify Kanban Card Meta (Complexity + Timestamp) to Grey Across Themes](../plans/feature_plan_20260626124052_kanban_card_meta_teal_afterburner.md)
<!-- END SUBTASKS -->
