# Panel Pushes Carry a Surface Tag

**Complexity:** 7

## Goal

Stop host-to-UI broadcasts being delivered to every panel in the browser cockpit. Three providers push untagged, so opening one panel after another delivers the first panel's pushes into the second and the wrong surface re-renders. This is one mechanism with three offenders, plus the dependency work that makes the fix safe rather than a one-liner.

## How the Subtasks Achieve This

- **Kanban and Setup broadcast untagged to every panel** — tags both providers' host-to-UI broadcasts with a surface, and lands the dependency work that makes the change safe rather than a one-liner.
- **Design panel pushes leak into the Planning panel** — applies the same surface tag to the Design panel's broadcasts, so opening the Planning panel after the Design panel stops delivering the wrong pushes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Design panel pushes leak into the Planning panel — tag DesignPanelProvider's broadcasts with a surface](../plans/feature_plan_20260817105257_design-panel-pushes-leak-into-the-planning-panel.md) — **PLAN REVIEWED**
- [ ] [Kanban and Setup broadcast untagged to every panel — tag them, and fix the dependencies that make the one-liner unsafe](../plans/feature_plan_20260817110713_kanban-and-setup-broadcast-untagged-to-every-panel.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The Kanban and Setup subtask lands first — it carries the prerequisite work, after which the Design fix reduces to applying the same tag.

**Known constraint to resolve during implementation:** the browser cockpit's transport layer currently ignores the surface field and fans every push out to all surfaces. Tagging the producer is necessary but not sufficient unless the consumer honours the tag. Confirm which of these two subtasks owns that consumer-side change before coding either.

