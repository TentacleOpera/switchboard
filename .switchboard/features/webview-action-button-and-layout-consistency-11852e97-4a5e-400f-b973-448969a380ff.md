# Webview Action-Button and Layout Consistency

**Complexity:** 3

## Goal

Bring Switchboard's two main webview surfaces (the Kanban board and the Project panel) to a single, consistent spatial model for action buttons: icon-sized shelve and edit actions grouped where the user's attention already is, destructive actions isolated to the far right, and primary actions grouped separately from minor icon actions. Two of these plans are pure UI layout and button-placement refactors that share the same underlying capability — making webview action-button placement consistent with a deliberate spatial model — across two different webview files. The third plan is a regression bugfix in the same Project-panel webview that supports the same consistency goal by ensuring the Edit action button is reliably visible wherever a subtask is previewed (the in-preview link-click path had diverged from the sidebar-list path, leaving the Edit button permanently hidden).

## How the Subtasks Achieve This

- **Shrink "→ Backlog" Card Button to a Down-Arrow Icon**: Converts the oversized text "→ Backlog" button on CREATED cards into a compact 20×20 down-arrow icon button matching the existing review/complete icons, and relocates it into the right action group. This makes the kanban card action row visually consistent.
- **Reorganize Edit and Delete Layouts in Project Webview**: Moves the Kanban-tab Edit button from the top nav bar into each sidebar list item's action row (next to Copy Prompt/Copy Link), and restructures the Features-tab meta bar so constructive actions cluster on the left and the destructive "Delete Feature" is isolated on the far right. This makes the Project panel's button placement match the user's spatial focus.
- **Fix: Subtask Edit Button Hidden When Subtask Opened via In-Preview Link Click**: Fixes a regression where clicking a `../plans/foo.md` link inside the previewed feature markdown (Path B) permanently hid the Edit button, because the link-click handler ran stale pre-editing-era code that never called `renderFeatureSubtaskMetaBar`. The fix makes Path B mirror the working sidebar-list path (Path A) — setting `_featureSubtaskPreview` and rendering the subtask meta bar so the Edit button is visible and wired to save the subtask file. This restores action-button consistency across both subtask-preview entry points in the Project panel.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Reorganize Edit and Delete Layouts in Project Webview](../plans/layout_fixes_project_webview.md) — **CODE REVIEWED**
- [ ] [Shrink "→ Backlog" Card Button to a Down-Arrow Icon](../plans/shrink-backlog-button-to-icon.md) — **CODE REVIEWED**
- [ ] [Fix: Subtask Edit Button Hidden When Subtask Opened via In-Preview Link Click](../plans/feature_plan_20260707131749_fix-subtask-edit-button-hidden-on-link-click.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Cross-feature dependencies:** None — no work from other features must land first.
- **Shipping order within this feature:**
  - "Shrink → Backlog Card Button to a Down-Arrow Icon" is fully independent (touches only `src/webview/kanban.html`) and can land in any order relative to the other two.
  - "Reorganize Edit and Delete Layouts in Project Webview" and "Fix: Subtask Edit Button Hidden on Link Click" both modify `src/webview/project.js`, but they touch **different functions** with no logical overlap: the layout plan restructures `renderFeatureMetaBar` (the feature-level meta bar, ~line 2295-2315) and the Kanban-tab sidebar action row; the bugfix plan patches the in-preview link-click handler (~line 303-313) and relies on `renderFeatureSubtaskMetaBar` (the subtask meta bar, line 2376+), which the layout plan explicitly leaves untouched. There is no code dependency between them.
  - **Recommended:** apply the two `project.js` plans sequentially (either order) to avoid a textual merge conflict on adjacent regions of the same file; the kanban.html plan can be applied in parallel with either.
- **Prerequisites / guards:** None beyond the standard installed-VSIX manual-UI verification (per `CLAUDE.md`, `dist/` is not the test source; `src/` is served directly in dev).

**Stage Complete:** INTERN CODED
