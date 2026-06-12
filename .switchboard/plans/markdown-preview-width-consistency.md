# Truly Unify Markdown Preview Styling Across All Tabs in Planning & Design Panels

## Goal

**Actually unify** the markdown preview styling across all tabs in the Planning and Design panels: one shared base CSS selector for all preview panes, no duplicated font properties, no special-case blocks, and consistent full-width expansion across every tab.

In `planning.html` and `design.html`, the CSS claims a "Unified Markdown Preview Styling" block, yet it is anything but unified. The base layout block (`#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`) enforces an 800px centered reading column via `padding: 26px max(26px, calc((100% - 800px) / 2))`, while a separate `#kanban-preview-pane` block duplicates the exact same `font-family`, `font-size`, `line-height`, `word-wrap`, and `color` declarations just to apply `padding: 8px 16px`. Heading blocks already include `#kanban-preview-pane`, meaning typography is unified but layout is not. This creates a jarring inconsistency when switching tabs — markdown content renders at different widths depending on which tab is active.

## Metadata

**Tags:** frontend, ui, bugfix, refactor
**Complexity:** 3

## User Review Required

- Confirm whether the removal of the 800px reading column is acceptable for all markdown preview tabs (Local, Online, Design System, Tickets, Kanban), or if any tab should retain a constrained width for readability.
- Confirm whether `padding: 16px` vertical spacing is preferred over the original `26px` for the non-Kanban tabs.

## Complexity Audit

### Routine
- Pure CSS selector consolidation in two static HTML files.
- No JavaScript logic changes; no state management.
- Existing heading/paragraph/list/cyber-theme selectors already include `#kanban-preview-pane`.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. Static CSS; no runtime state mutations.

### Security
- None. No user input processing or CSP changes.

### Side Effects
- Build artifacts (`dist/webview/planning.html` and `dist/webview/design.html`) must be regenerated via `npm run compile` or `npm run package` to reflect source changes at runtime, since the extension provider loads HTML from the `dist/webview/` fallback path first.

### Dependencies & Conflicts
- The `copy-webpack-plugin` in `webpack.config.js` copies `src/webview/*.html` to `dist/webview/` during build. Any concurrent work modifying the same CSS blocks in these files would conflict.
- No dependency on other plan files or services.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Removing the 800px constraint may reduce readability on ultra-wide monitors for users who relied on the centered column; (2) Build artifacts in `dist/webview/` may become stale if the implementer forgets to re-run webpack after editing `src/webview/`. Mitigations: (1) The 16px padding preserves comfortable edge breathing room and users can resize the VS Code panel; (2) The webpack `copy-webpack-plugin` pattern `src/webview/*.html` ensures HTML files are copied automatically during standard compilation.

## Proposed Changes

### `src/webview/planning.html`

**Context**
Lines 984–1002 contain the "Unified Markdown Preview Styling" block for four preview pane IDs. Lines 1004–1012 contain a separate `#kanban-preview-pane` block that duplicates font properties and overrides padding. Heading blocks (lines 1014+) already include `#kanban-preview-pane`.

**Logic**
Merge `#kanban-preview-pane` into the unified selector, replace the constrained padding with uniform `padding: 16px`, and remove the now-redundant standalone block.

**Implementation**

1. **Replace lines 984–1002** with the merged selector:
   ```css
   /* Unified Markdown Preview Styling (Local, Online, Design & Kanban) */
   #markdown-preview,
   #markdown-preview-online,
   #markdown-preview-design,
   #markdown-preview-tickets,
   #kanban-preview-pane {
       flex: 1;
       overflow-y: auto;
       padding: 16px;
       width: 100%;
       box-sizing: border-box;
       margin: 0;
       font-family: var(--font-family);
       font-size: 13px;
       line-height: 1.5;
       word-wrap: break-word;
       color: var(--vscode-editor-foreground, #cccccc);
   }
   ```

2. **Delete lines 1004–1012** (the redundant `#kanban-preview-pane` block):
   ```css
   /* Kanban preview pane: inherits font/text styling but keeps its own layout */
   #kanban-preview-pane {
       font-family: var(--font-family);
       font-size: 13px;
       line-height: 1.5;
       word-wrap: break-word;
       color: var(--vscode-editor-foreground, #cccccc);
       padding: 8px 16px;
   }
   ```

**Edge Cases**
- The `#kanban-preview-pane` already appears in every heading, paragraph, list, and cyber-theme selector downstream; no additional selector updates are required.

### `src/webview/design.html`

**Context**
Lines 1008–1026 contain the identical unified block. Lines 1028–1036 contain the identical redundant `#kanban-preview-pane` block.

**Logic**
Same consolidation as `planning.html`.

**Implementation**

1. **Replace lines 1008–1026** with the merged selector (same CSS as above, with the five-element selector including `#kanban-preview-pane` and `padding: 16px`).

2. **Delete lines 1028–1036** (the redundant standalone `#kanban-preview-pane` block).

**Edge Cases**
- The Design panel's "Design System" and "Tickets" tabs use `#markdown-preview-design` and `#markdown-preview-tickets`, which are already in the unified selector. No tab-specific breakage.

## Why `padding: 16px`

- **Horizontal:** `16px` matches the Kanban's right-edge padding (`8px 16px`) while removing the 800px constraint — content now expands to the full panel width.
- **Vertical:** `16px` is a middle ground between the previous unified block's `26px` and Kanban's `8px`, providing comfortable breathing room without being excessive.

## Verification Plan

### Automated Tests
- No automated test coverage required. The change is purely presentational CSS with no runtime logic to test.

### Manual Validation
1. Open the Planning panel → Kanban tab → confirm markdown content spans full preview pane width.
2. Switch to Local tab → confirm identical width and padding.
3. Switch to Online and Tickets tabs → confirm identical width and padding.
4. Repeat in the Design panel → all tabs (Local, Online, Design System, Tickets) should match.
5. Verify build artifacts: confirm `dist/webview/planning.html` and `dist/webview/design.html` reflect the source changes after running the build step.

**Recommendation:** Send to Intern
