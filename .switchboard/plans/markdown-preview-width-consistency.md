# Unify Markdown Preview Width Across All Tabs in Planning & Design Panels

## Metadata
**Complexity:** 2
**Tags:** frontend, ui, bugfix

## Problem

In `planning.html` and `design.html`, the markdown preview content is constrained to an ~800px centered reading column in every tab **except** Kanban Plans. The Kanban preview (`#kanban-preview-pane`) correctly expands to the full panel width via `padding: 8px 16px`, while all other previews use:

```css
padding: 26px max(26px, calc((100% - 800px) / 2));
```

This creates a jarring inconsistency when switching between tabs — the same content type (markdown) renders at different effective widths depending on which tab is active.

### Affected Elements
- `planning.html`: `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`
- `design.html`: `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`

### Unaffected (Correct) Element
- `planning.html`: `#kanban-preview-pane` (uses `padding: 8px 16px`)

## Goal

Make **all** markdown preview panes use the same full-width expand behavior as the Kanban preview, eliminating the 800px artificial constraint.

## Changes

### File 1: `src/webview/planning.html`
Locate the "Unified Markdown Preview Styling" block (~line 984) and change:

```css
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets {
    flex: 1;
    overflow-y: auto;
    padding: 26px max(26px, calc((100% - 800px) / 2));
    width: 100%;
    box-sizing: border-box;
    margin: 0;
}
```

To:

```css
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets {
    flex: 1;
    overflow-y: auto;
    padding: 26px 16px;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
}
```

### File 2: `src/webview/design.html`
Apply the identical padding change to the corresponding "Unified Markdown Preview Styling" block (~line 1008).

## Risks & Considerations

- **Readability on ultrawide monitors:** Removing the 800px column means lines can become very long on wide screens. However, the user explicitly requested the expand format, and VS Code webview panels are typically not maximized to fullscreen widths.
- **No JS changes needed:** The `planning.js` file does not dynamically set widths on these elements.
- **Build artifact:** `dist/webview/planning.html` and `dist/webview/design.html` will need to be regenerated (standard build step).

## Validation

1. Open the Planning panel → Local tab → select a markdown file → confirm content spans full preview pane width.
2. Switch to Online tab → confirm same width.
3. Switch to Kanban tab → confirm width matches the other tabs.
4. Repeat in the Design panel's Design System tab.
