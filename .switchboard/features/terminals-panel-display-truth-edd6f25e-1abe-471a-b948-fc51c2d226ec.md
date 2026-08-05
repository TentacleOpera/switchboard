# Terminals Panel Display Truth

**Complexity:** 4

## Goal

Three defects where the Terminals panel's chrome disagrees with what it is actually doing: the 2h/2v layout labels are inverted relative to the grids they render, the layout picker highlights '1' while rendering the persisted layout because only a user click ever moves the active class, and the agent CLI name is demoted to a dim subline in the sidebar and absent from the pane header entirely while the generated 'planner-2' handle takes the prominent slot.

## How the Subtasks Achieve This

- **Terminals Layout Picker: 2h/2v Labels Are Inverted and Mis-Ordered**: Retexts the two two-pane picker buttons so the labels name what the operator counts on screen (`2V` = two vertical terminals side by side on `data-layout="2h"`, `2H` = two horizontal stacked on `data-layout="2v"`) and puts the side-by-side option first. Fixes the first lie — the control's words now match the geometry the CSS renders, without touching the persisted `2h`/`2v` identifiers.
- **Terminals Panel: The Layout Picker Lies — It Shows "1" While Rendering the Stored Layout**: Extracts the picker's active-class toggle into `syncLayoutPickerUI()` (keyed on `currentLayout`, never the floored `effectiveLayout`) and calls it once the persisted layout resolves at boot. Fixes the second lie — the highlight and the rendered grid agree from the first frame, on both the success and settings-failure paths.
- **Terminals Panel: Show the Agent CLI Name in the Sidebar Rows and on the Pane Header**: Adds one `agentLabelForRole()` resolver and uses it in both identity surfaces — sidebar rows lead with `CLAUDE CLI` (handle demoted to the subline but kept visible and stamped in `dataset` so inline rename still targets the real key), and pane headers read `CLAUDE CLI · planner-2` (agent-only in terse `2x3`/`3x3`, suffixes like `(exited)` stay on the handle). Fixes the third lie — the name a human recognises replaces the uniquifier the fleet service minted.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. All three subtasks touch only `src/webview/terminals.html` and `src/webview/terminals.js` and reuse existing plumbing (`getStartupCommands`' `agentNames` map, `terminals.layoutMode` persistence, the `.layout-picker` markup). No verb, schema, or API surface changes; PRD contracts (return-in-body, schema validation, capability gating) are untouched because no verb arm is modified.
- **Shipping order within this feature:** (1) 2h/2v labels → (2) picker sync → (3) agent CLI name. The order is merge-hygiene, not functional dependence — the three are logically independent and each ships on its own:
  - Labels and picker-sync both edit the same `.layout-picker` button block in `terminals.html` (labels rewrites it; picker-sync adds a comment on the `data-layout="1"` button). Landing labels first gives picker-sync a stable target; both edits key on `data-layout`, never label text, so neither breaks the other.
  - Picker-sync's UAT assumes truthful labels exist ("the highlight matches the grid" reads cleanly only once `2V`/`2H` say the right thing), another reason it lands second.
  - Agent-name lands last because it is the largest surface and shares only the `init()` region with picker-sync (event-binding block vs boot continuation — no actual line overlap).
- **Prerequisites / guards:** `src/webview/terminals.js` is under active concurrent edit (it recently gained `paneModes` / `kanbanPaneColumn`); every subtask anchors on named functions (`setLayoutMode`, `loadLayoutSettings`, `renderTerminalRow`, `updatePaneElement`), not line numbers. One agent stream per file per the PRD's orchestration discipline — the two terminals files serialise, so these three land sequentially in the order above.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminals Layout Picker: 2h/2v Labels Are Inverted and Mis-Ordered](../plans/feature_plan_20260805105300_terminals-2h-2v-layout-labels-inverted.md) — **CODE REVIEWED**
- [ ] [Terminals Panel: The Layout Picker Lies — It Shows "1" While Rendering the Stored Layout](../plans/feature_plan_20260805105311_terminals-layout-picker-lies-about-stored-layout.md) — **CODE REVIEWED**
- [ ] [Terminals Panel: Show the Agent CLI Name in the Sidebar Rows and on the Pane Header](../plans/feature_plan_20260805105313_terminals-show-agent-cli-name-in-sidebar-and-pane-header.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

