# Kanban Tab (project.html) Document & Navigation UX

**Complexity:** 3

## Goal

Improve the experience of working with a selected plan in the project.html Kanban tab — both reaching the plan's actions without scrolling the sidebar, and having Review-Plan navigation actually land on the right card. Today the Copy Link and Copy Prompt actions exist only on sidebar rows (forcing a scroll hunt), and the Review Plan button scrolls the sidebar to a stale position due to a scrollIntoView-after-innerHTML race. These two plans make the document preview pane and sidebar navigation feel correct and frictionless.

## How the Subtasks Achieve This

- **Add Copy Link & Copy Prompt buttons to the Kanban document top bar**: Promotes the Copy Link and Copy Prompt actions from per-sidebar-item buttons into the `#kanban-preview-meta-bar` top bar, next to the complexity score, so the user can copy without locating the plan in the sidebar.
- **Fix: Review Plan navigation does not scroll sidebar to the actual card position**: Defers `scrollIntoView` past the post-`innerHTML` layout settle using a double-`requestAnimationFrame` with instant (non-smooth) scrolling and element re-query, so the target card is actually centered after a re-render.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: Review Plan navigation does not scroll sidebar to the actual card position](../plans/feature_plan_20260703064910_review_plan_sidebar_scroll_to_card.md) — **CODE REVIEWED**
- [ ] [Add Copy Link & Copy Prompt buttons to the Kanban document top bar](../plans/feature_plan_20260703064911_kanban_topbar_copy_link_copy_prompt.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. Both are confined to `src/webview/project.js` and touch different functions (`renderKanbanMetaBar` vs `tryResolvePendingKanbanSelection`).
