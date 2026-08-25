# The Shared Markdown Editor Stops Fighting the Operator

**Complexity:** 5

## Goal

Make the shared markdown editor usable on long documents in every panel that embeds it. The toolbar scrolls out of reach so Bold, headings, lists and view-mode controls vanish partway down a document, and the preview pane is locked to the editor's scroll position with images that overflow their container. Both are layout changes to the one shared editor, so they land together rather than as two conflicting CSS passes.

## How the Subtasks Achieve This

- **Markdown editor toolbar scrolls out of reach on long docs and tickets** — pins the shared toolbar to the top of the visible editing area so the formatting controls stay reachable on a long document.
- **Markdown editor independent preview scrolling and inline image sizing** — decouples the preview pane's scroll from the editor's and constrains preview images so the pane stays fluid.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Markdown editor toolbar scrolls out of reach on long docs and tickets](../plans/feature_plan_20260817161200_markdown-toolbar-scrolls-away-on-long-docs.md) — **PLAN REVIEWED**
- [ ] [Markdown Editor Independent Preview Scrolling and Inline Image Sizing](../plans/feature_plan_20260818093003_markdown-editor-independent-preview-scroll-and-image-sizing.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No functional ordering constraint, but both change the layout of the one shared markdown editor used across the Docs, Design, Project and Tickets panels. Land them together as a single layout pass rather than two conflicting CSS changes to the same component.

