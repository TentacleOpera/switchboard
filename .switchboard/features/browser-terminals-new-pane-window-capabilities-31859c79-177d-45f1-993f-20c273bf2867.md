# Browser Terminals — New Pane & Window Capabilities

**Complexity:** 7

## Goal

Three additive capabilities for the browser Terminals panel: repurpose an unused grid slot as a live kanban-column pane with copy-prompt links, accept pasted images into a terminal pane end-to-end (client, WS transport, PTY), and pop the full Terminals panel out into its own window.

## How the Subtasks Achieve This

- **Add "New Window" Button to Pop Out the Full Terminals Panel**: Adds a `window.open('/terminals')` button to the layout toolbar so the full panel (fleet sidebar, grid, toolbar) runs in its own browser window without the shell sidebar — solves the "duplicate the whole tab" workaround. Contributes the window-placement capability.
- **Paste Images into Browser Terminals**: Intercepts image paste in a terminal pane (capture-phase listener, text paste untouched), transports the image as raw binary to a new `ptyPasteImage` verb, writes it to a host temp file, and injects the path into the PTY — solves the "screenshots silently dropped" gap with VS Code's integrated terminal. Contributes the input-richness capability.
- **Kanban-Mode Pane in the Terminals Grid**: Lets an empty grid slot render a live kanban column (new read-only `getBoardCards` verb + 5s conditional polling) with "Copy & Advance" prompt buttons — solves the board↔terminals tab round-trip when feeding prompts to agent terminals. Contributes the pane-content capability.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. All three build on already-shipped infrastructure (standalone `/terminals` route, `terminalVerb` rail, `KanbanProvider` verb engine, `_buildBoardCards` pipeline). No work from other features must land first.
- **Shipping order within this feature:** no hard ordering — the subtasks touch `terminals.js`/`terminals.html` in disjoint regions (New Window: `init()` + `.toolbar-actions`; Paste Images: `materializeTerminalView` + server verb rail; Kanban Pane: `renderPaneGrid`/`updatePaneElement` + `KanbanProvider`/`verbSchemas`), so any order merges cleanly. Recommended risk-ascending sequence: New Window (cx 3) → Paste Images (cx 5) → Kanban Pane (cx 7).
- **Prerequisites/guards:** Paste Images' external assumption (CLI accepts image file paths as visual context) is CONFIRMED by web research — see that plan's `## Resolved Assumptions`; research also drove three design changes (4 MB ceiling under the API's 5 MB hard limit, PNG/JPEG/GIF/WebP allowlist against session poisoning, `@`-prefix + bracketed-paste injection). Kanban Pane requires `npm run catalog:generate` in the same change (codegen, not compilation) so `getBoardCards` reaches the verb allowlist. All three respect solo mode (toolbar hidden / terminal mode forced) and the no-confirm-dialog rule.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add "New Window" Button to Pop Out the Full Terminals Panel](../plans/feature_plan_20260804110138_terminals-new-window-popout.md) — **LEAD CODED**
- [ ] [Paste Images into Browser Terminals](../plans/feature_plan_20260804132725_paste_images_into_browser_terminals.md) — **LEAD CODED**
- [ ] [Kanban-Mode Pane in the Terminals Grid](../plans/feature_plan_20260804135951_kanban-mode-pane-in-terminals-grid.md) — **LEAD CODED**
<!-- END SUBTASKS -->

