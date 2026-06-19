# Extract Shared Markdown Preview CSS Class in design.html

## Metadata
**Complexity:** 4
**Tags:** refactor, frontend

## Goal

### Problem
The markdown preview CSS in `design.html` (`:960-1316`) repeats the same properties across 6+ selector groups (`#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#kanban-preview-pane`, `#markdown-preview-tickets`, `#markdown-preview-briefs`). This results in ~300 lines of duplicated CSS. Any change to markdown styling requires updating all 6 groups in sync.

### Root Cause
Each markdown preview container was given its own ID, and styles were copy-pasted across all of them instead of using a shared class.

### Background
The duplication covers headings (h1-h6), paragraphs, lists, code blocks, inline code, blockquotes, tables, links, images, hr, and empty states — each repeated for every preview container ID. Some of these IDs (`#markdown-preview`, `#markdown-preview-online`, `#kanban-preview-pane`, `#markdown-preview-tickets`) may not even exist in the current HTML (see dead CSS plan).

## Approach
1. **Remove dead selectors first** (dependent on the dead CSS cleanup plan) — this alone may reduce 6 groups to 2-3
2. **Create a shared class** (e.g., `.markdown-preview-base`) with all common markdown styling properties
3. **Apply the class** to each remaining markdown preview container in the HTML
4. **Keep ID-specific overrides** only where a particular preview container needs different behavior
5. **Remove the duplicated group selectors**

## Files Changed
- `src/webview/design.html` — CSS consolidation and HTML class additions

## Risks
- Should be done after dead CSS cleanup to avoid consolidating selectors that will be deleted
- ID selectors have higher specificity than class selectors — need to verify no overrides break when switching from ID to class
- The cyber-theme overrides (`:993-1012`) also duplicate across all 6 IDs — these need the same treatment

## Verification
- Open Briefs tab, Design System tab — verify markdown rendering matches current appearance
- Check heading sizes, code blocks, tables, blockquotes, links all render correctly
- Verify cyber-theme overrides still apply (neon glow on headings, code, etc.)
