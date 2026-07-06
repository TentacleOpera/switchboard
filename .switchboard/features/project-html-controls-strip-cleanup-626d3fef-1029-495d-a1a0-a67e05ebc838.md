# project.html Controls Strip Cleanup

**Complexity:** 2

## Goal

Clean up the project.html controls strip across all three tabs (Projects, Constitution, System): standardize the project-context button active styling to match the extension outline-button design system, and remove the redundant Architect terminal-launch button while renaming the retained copy-prompt button to Architect Prompt. Both plans target the same file and the same controls strip, addressing button-styling inconsistency and button redundancy as one coherent UI cleanup.

## How the Subtasks Achieve This

- **Fix Project Context Button Active Styling in project.html**: Replaces inline solid-fill styles with the standard `.strip-btn.is-active` CSS class pattern (teal outline + teal text + subtle tint), matching the active-button aesthetic used elsewhere in the extension.
- **Remove Duplicate Architect Button and Rename "Copy Architect Prompt" in project.html**: Deletes the redundant "Architect" terminal-launch button from all three tabs and renames "Copy Architect Prompt" to "Architect Prompt," halving the architect-button count and removing the confusing dual-button pattern.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove Duplicate Architect Button and Rename "Copy Architect Prompt" in project.html](../plans/feature_plan_20260706085732_remove-duplicate-architect-button-rename-copy.md) — **PLAN REVIEWED**
- [ ] [Fix Project Context Button Active Styling in project.html](../plans/feature_plan_20260706085731_fix-project-context-button-active-styling.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks touch different buttons in the same file and can be executed in parallel.
