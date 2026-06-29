---
description: 'Planning Panel HTML Tab Polish'
---

# Planning Panel HTML Tab Polish

## Goal

Bring the Planning panel HTML tab up to parity with the rest of the panel and the Design panel. The tab is currently mis-ordered, renders an unstyled flat document list, and shows CRT scanline distortion over previews. This epic repositions the tab to second place, gives its sidebar the shared card-based layout used by the Design panel, and removes the scanline overlay so HTML previews render cleanly while the Docs and Tickets tabs keep theirs.

## How the Subtasks Achieve This

- **Reposition HTML Tab to Second Position**: Moves the HTML tab button to slot two, immediately after DOCS, so the two most-used tabs sit adjacent.
- **HTML Tab Sidebar Formatting Parity with Design Panel**: Rewrites the HTML-docs renderer to use the shared folder-grouped, card-based layout (cards, folder headers, link and serve buttons) instead of bare unstyled divs.
- **Remove Afterburner CRT Scanline Effects from HTML Tab**: Removes the scanline overlay element from the HTML tab preview wrapper so previews render without distortion, while the Docs and Tickets tabs keep their scanlines.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Reposition HTML Tab to Second Position in Planning Panel](../plans/feature_plan_20260629091055_html-tab-second-position.md) — **CODE REVIEWED**
- [ ] [HTML Tab Sidebar Formatting Parity with Design Panel](../plans/feature_plan_20260629091056_html-tab-sidebar-formatting-parity.md) — **CODE REVIEWED**
- [ ] [Remove Afterburner CRT Scanline Effects from HTML Tab in Planning Panel](../plans/feature_plan_20260629091057_remove-crt-scanlines-from-html-tab.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
