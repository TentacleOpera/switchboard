# Remove Dead CSS from design.html

## Metadata
**Complexity:** 3
**Tags:** refactor, frontend, performance

## Goal

### Problem
`design.html` contains ~1500 lines of CSS for elements that no longer exist in the file. These were left behind when tabs (local docs, online docs, kanban, tickets, planning, notebook, research) were removed or moved to other panels. The dead CSS bloats the file, slows parsing, confuses maintainers, and makes it harder to find active rules.

### Root Cause
Tabs were removed from the HTML body but their associated CSS was never cleaned up. No audit was performed after the removals.

### Background
The dead selectors include (non-exhaustive):
- `#local-content`, `#online-content`, `#kanban-content` — content containers not in HTML
- `#tree-pane`, `#tree-pane-online` — sidebar panes not in HTML
- `#preview-pane` (bare), `#preview-pane-online` — preview panes not in HTML
- `#markdown-preview`, `#markdown-preview-online` — markdown containers not in HTML
- `#kanban-preview-pane`, `#kanban-list-pane`, `#kanban-content-row` — kanban elements not in HTML
- `#notebook-content`, `#research-content` — content areas not in HTML
- `#tickets-subtasks-nav`, `.ticket-node`, `.tickets-*` — ticket elements not in HTML
- `#controls-strip-tickets` — controls strip not in HTML
- `.planning-card`, `.planning-*` — planning card styles not in HTML
- `.duplicate-modal` — modal not in HTML
- `.comment-popup` — popup not in HTML

## Approach
1. Cross-reference every CSS selector in `design.html` against the HTML body elements
2. Identify all selectors that match zero elements in the current HTML
3. Remove dead selectors in groups (by feature area) to keep diffs reviewable
4. Verify the webview still renders correctly after each removal group

## Files Changed
- `src/webview/design.html` — remove ~1500 lines of dead CSS

## Risks
- Some selectors may be used by JS that dynamically creates elements matching them. Need to grep the companion JS file (`design.js` or equivalent) for class/ID usage before removing
- Some selectors may be shared with other webview HTML files via import or copy — need to verify they're not referenced elsewhere

## Verification
- Open the Switchboard design panel in VS Code and verify all 5 tabs (Stitch, Briefs, HTML Previews, Images, Design System) render correctly
- Check browser devtools console for any CSS parse errors
- Compare file size before/after — expect ~35-40% reduction
