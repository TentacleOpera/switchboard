# Kanban Column Header: Controls That Fit, Name What They Do, and Report Honestly

**Complexity:** 6

## Goal

Repair the board's column header action row on three axes at once. The Planned column renders six fixed 32px icon buttons needing 246px while the column floor is 220px, so the sixth wraps to a second line and misaligns every card body across the board. The Created column's only bespoke button creates a subtask-less ghost feature, while the planner fan-out that is already implemented and reviewed has no button at all and runs only as a hidden side effect of Move Selected. And Copy Dispatch Prompt flashes a green Copied label on every card's per-card coder-prompt button for a prompt that was never copied per card, teaching the user that a coder prompt is on the clipboard when a batch planner prompt is. All three edit the same column-button-area template and its surrounding render pass.

## How the Subtasks Achieve This

- **The Kanban Column Floor Is Narrower Than Its Own Icon Row**: publishes the icon geometry as CSS custom properties on `.kanban-board` and derives `min-width` from the icon count the render pass just counted in the HTML it built, so adding a button to a column header can never silently re-introduce the two-line wrap. It also makes the header row shrink-safe (ellipsised label, non-shrinking right group), removing the whole overflow class rather than one instance of it.
- **Replace the Created Column's Blank-Feature Button with "Send N plans to planner team"**: retires the button that creates a subtask-less ghost feature and adds an explicit, count-labelled verb that calls `_distributePlannerDispatch` directly — so a configured single-target dispatch on the Planned column can no longer silently preempt the fan-out. Critically, it resolves the planner pool the way the dispatcher does (`getRoleTerminalSet` with `allowPtyFleet: true`), not the way the coder count does, which would report zero while six planners are live.
- **Copy Dispatch Prompt must not flash "Copied!"**: deletes the per-card `copyPlanLinkResult` loop inherited from `promptSelected` into the `copyDispatchPromptSelected` arm, leaving the batch-shaped status message and the clicked column button's own flash — both of which are already wired — as the honest feedback.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Copy Dispatch Prompt must not flash "Copied!" on every card's coder-prompt button](../plans/feature_plan_20260810172334_copy-dispatch-prompt-must-not-flash-copied-on-every-card-coder-prompt-button.md) — **PLAN REVIEWED**
- [ ] [The Kanban Column Floor Is Narrower Than Its Own Icon Row](../plans/feature_plan_20260812190008_kanban-column-floor-fits-the-six-icon-header-row.md) — **PLAN REVIEWED**
- [ ] [Replace the Created Column's Blank-Feature Button with an Explicit "Send N plans to planner team"](../plans/feature_plan_20260812150700_kanban-created-send-plans-to-planner-team.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**⚠ The first two subtasks collide directly and must be ordered.** Both edit the Created column's entry in the `buttonArea` template literal in `src/webview/kanban.html`: the fan-out plan **deletes** `featureAddBtn` and interpolates a new text button in its place, while the column-floor plan rewrites that same template (dropping its inline style) and adds a pass that counts `class="column-icon-btn"` occurrences in the built HTML to set the floor.

1. **The Kanban Column Floor first.** It is a self-contained presentation change — four CSS declarations plus roughly five lines in `renderColumns()` — and it establishes the counting pass and the token block.
2. **Send N plans to planner team second**, written against the derived floor. Its new button is a `width:auto` text control, **not** a 32px `column-icon-btn`, so it must not be counted by the floor's regex; removing `featureAddBtn` correspondingly lowers the Created column's icon count. Neither effect changes the floor in practice (the clamp holds at 6, set by the Planned column), but the implementer must confirm rather than assume.
3. **Copy Dispatch Prompt flash** is independent — a four-line deletion in a `KanbanProvider.ts` switch arm plus one new source-reading regression test — and can land at any point.

**Before deleting `addBlankFeature`:** the fan-out plan requires confirming whether another surface offers blank-feature creation. If the Created column was the only entry point, an entry point must be added elsewhere in the same change, or `openFeatureCreateModal({ blankFeature: true })` and the zero-subtask branch of `createFeatureFromPlanIds` are orphaned.

**Scoped deletion, not a sweep:** five other `copyPlanLinkResult` emit sites in `promptSelected` / `promptAll` and the single-card `copyPlanLink` arm are all legitimate and must survive — those arms genuinely copy the per-card advance prompt and advance the cards. The regression test in that plan asserts both directions.

**Gate:** the fan-out plan adds `sendCreatedToPlannerTeam` to `KANBAN_VERBS`; regenerate `src/generated/verbAllowlist.ts` rather than hand-editing it, or the browser transport rejects the verb.

**Known baseline:** five regression tests are red at HEAD independently of this work. Stash-verify before attributing any red to these changes.
