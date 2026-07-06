# Comms Monitor Tab Visual Polish

**Complexity:** 2

## Goal

De-clutter and standardize the Comms Monitor tab visual presentation in kanban.html: remove the unnecessary Haiku model callout box, restyle the primary action buttons (Start Terminal, Start Polling) to match the extension outline-button aesthetic instead of solid-fill, and make the startup command always visible without the (resolved) jargon or accordion toggle. All three plans target the renderCommsMonitorSection area of kanban.html and share the capability theme of Comms tab visual cleanup.

## How the Subtasks Achieve This

- **Remove Haiku Model Callout Box in Comms Tab**: Deletes the self-contained model-detection callout box (`detectModel` helper + `modelRow` div) that cluttered the tab without providing actionable value.
- **Fix Start Terminal Button Styling in Comms Tab**: Restyles the Start Terminal and Start Polling buttons from solid teal fill to the extension's standard outline style (teal text, teal border, subtle tint), matching the design system.
- **Fix Startup Command Entry in Comms Tab — Remove "(resolved)" Text and Accordion**: Replaces the collapsible `<details>`/`<summary>` accordion with an always-visible label + `<pre>` box, and drops the "(resolved)" parenthetical from the label.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix Startup Command Entry in Comms Tab — Remove "(resolved)" Text and Accordion](../plans/feature_plan_20260706085725_startup-command-non-accordion-remove-resolved.md) — **CREATED**
- [ ] [Fix Start Terminal Button Styling in Comms Tab](../plans/feature_plan_20260706085726_start-terminal-button-styling.md) — **CREATED**
- [ ] [Remove Haiku Model Callout Box in Comms Tab](../plans/feature_plan_20260706085724_remove-haiku-callout-box-comms-tab.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks edit different blocks within the same render function and can be executed in parallel.
