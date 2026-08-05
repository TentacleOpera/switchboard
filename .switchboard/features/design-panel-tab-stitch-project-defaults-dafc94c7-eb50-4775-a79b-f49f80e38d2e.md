# Design Panel Tab & Stitch Project Defaults

**Complexity:** 4

## Goal

Design panel opens on the wrong surface with nothing selected: PREVIEWS is a container name hiding an unrelated Images browser, its source defaults to Stitch HTML (a remote API call that shows an empty pane), and both Stitch project pickers open on 'Select Project...' because the persisted selection is write-only. Renames PREVIEWS to HTML, promotes Images to a top-level tab, defaults the source to the local HTML previews, seeds the Stitch HTML picker from the Stitch tab, and restores the last active Stitch project.

## How the Subtasks Achieve This

- **Design Panel: Rename PREVIEWS to HTML and Promote Images to Its Own Top-Level Tab**: Restructures the tab bar — PREVIEWS becomes HTML, Images leaves the source dropdown and becomes a first-class tab with its own `switchTab` arm, CSS rules, and legacy persisted-state remap. The structural change the other three subtasks hang their wording on.
- **Design Panel: Previews Tab Must Default Its Source Dropdown to "HTML Previews"**: Flips the default previews source from Stitch HTML (an unconditional Stitch API call that renders "No project selected") to HTML Previews (a local `readdir`), so the tab shows useful local content on first open with no network round-trip.
- **Design Panel: Stitch HTML Source Must Default to the Project Showing in the Stitch Tab**: Seeds the Stitch HTML project picker from the STITCH tab's selection when the user switches to that source — conditional, validated against the loaded list, never clobbering an explicit choice — removing the re-pick-the-same-project step.
- **Design Panel: Stitch Project Picker Must Restore the Last Active Project Instead of Opening Empty**: Fixes the write-only persisted Stitch project selection (provider never shipped the key in `tabKeys`; the webview restore was commented out) and adds a validated tiered resolver (in-memory → persisted → configured default → most-recent), so the STITCH tab reopens on the last project with its cached screens.

## Dependencies & sequencing

- No cross-feature dependencies; all four subtasks touch only `src/webview/design.html`, `src/webview/design.js`, and (subtask 4) a two-key additive change in `src/services/DesignPanelProvider.ts`. PRD contracts unaffected: no verbs, schemas, or seams touched; the provider edit is in-place and behaviour-preserving.
- Shared surfaces inside the set: subtasks 1+2 both edit the `selectPreviewsSource` assignment (reconciled end-state recorded in both plans: whitelist guard with `'html-preview'` fallback — subtask 1's original `'stitch-html'` fallback was superseded during review). Subtasks 3+4 both edit the `stitchProjectsReady` arm and the `#stitch-workspace-filter` reset (additive; merged end-state recorded in both plans).
- Recommended order: **1 → 2 → 4 → 3**. Subtask 1 lands the tab structure and state remap; subtask 2's default flip builds on the same function. Subtask 4's restore plumbing makes the STITCH tab almost always carry a selection, which subtask 3's seed then leverages — landing 4 before 3 avoids seeding against an empty selection in the common case. The 1/2 pair is independent of the 3/4 pair; either pair can land first.
- Guards: legacy persisted `previews.source === 'images'` must remap to the new IMAGES tab (subtask 1); restored project ids must be validated against the loaded list before any fetch (subtask 4); the Stitch HTML seed must never clobber an explicit choice and must not add a second Stitch API call (subtask 3); the persisted previews source must always win over the new default (subtask 2).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Design Panel: Rename PREVIEWS to HTML and Promote Images to Its Own Top-Level Tab](../plans/feature_plan_20260805105301_design-previews-tab-becomes-html-images-own-tab.md) — **PLAN REVIEWED**
- [ ] [Design Panel: Previews Tab Must Default Its Source Dropdown to "HTML Previews"](../plans/feature_plan_20260805105302_design-previews-default-source-html-previews.md) — **PLAN REVIEWED**
- [ ] [Design Panel: Stitch HTML Source Must Default to the Project Showing in the Stitch Tab](../plans/feature_plan_20260805105303_stitch-html-source-inherits-stitch-tab-project.md) — **PLAN REVIEWED**
- [ ] [Design Panel: Stitch Project Picker Must Restore the Last Active Project Instead of Opening Empty](../plans/feature_plan_20260805105304_stitch-project-picker-restores-last-active-project.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

