# Multi-Window Cockpit Reliability - Hidden and Popped-Out Documents

**Complexity:** 7

## Goal

The browser cockpit was built for one visible document and breaks in four distinct ways the moment a second window exists or a panel is hidden. A popped-out window never receives WebSocket pushes; a restored window paints from a stale WebGL glyph model; WebGL contexts are held behind zero pixels until the origin passes its per-process ceiling and evicts contexts from windows nobody touched; and a solo pop-out is clamped to the grid cell size because the still-attached cockpit pane keeps voting on the shared pty. One cause class: hidden and multiple documents are not modelled anywhere.

## How the Subtasks Achieve This

- **Diagnose and fix the New Window WebSocket freeze root cause**: closes the `wsHub` resync path where a connection is upgraded on the wire but never added to `_connections`, so every broadcast skips it forever with no close event and therefore no reconnect.
- **Fix Terminal Renderer Desync on Window Minimize/Restore**: issues an unconditional atlas rebuild on visibility regain, repairing the stale glyph model that no repaint can fix and that `inspectPaneFit` reports as `ok`.
- **A Never-Opened Terminals Panel Holds a WebGL Context Per Terminal**: releases contexts held behind zero pixels, so one window's hidden panes stop starving every other window in the origin.
- **Solo Terminal Pop-Out Renders at the Cockpit Grid Cell's Size**: stops a hidden or background client's sticky `reportedSize` from vetoing the shared pty size, paired with an explicit re-cast so the release is not a net regression.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix Terminal Renderer Desync on Window Minimize/Restore](../plans/feature_plan_20260807120001_fix-terminal-renderer-desync-on-window-restore.md) — **PLAN REVIEWED**
- [ ] [Diagnose and fix the New Window WebSocket freeze root cause](../plans/feature_plan_20260807140000_diagnose-new-window-ws-freeze-root-cause.md) — **PLAN REVIEWED**
- [ ] [A Never-Opened Terminals Panel Holds a WebGL Context Per Terminal, Starving Every Other Window](../plans/feature_plan_20260807140000_defer-webgl-context-until-pane-has-a-box.md) — **PLAN REVIEWED**
- [ ] [Solo Terminal Pop-Out Renders at the Cockpit Grid Cell's Size Because the Shared PTY Takes the Minimum of Every Attached Viewport](../plans/feature_plan_20260808212300_solo-popout-pty-clamped-to-cockpit-grid-cell.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered pair.** The WebGL-context subtasks are two faces of the same accounting: the desync fix's leading candidate trigger is an LRU context eviction caused by the very contexts the release subtask gives back. **Land "A Never-Opened Terminals Panel Holds a WebGL Context" first**, then "Fix Terminal Renderer Desync", so the repair is verified against a tree where evictions are rarer.

The WS-freeze and solo-pop-out subtasks are independent of that pair and of each other.

⚠ All four edit `src/webview/terminals.js` — one agent stream per file, so none of them may run in parallel despite the logical independence.

⚠ **Cross-feature:** the solo pop-out subtask shares `?solo=` behaviour with the right-hand agent dock in *Reaching an Agent From Where You Are*. **Land the sizing fix before or with the dock**, or the dock ships hosting a seat clamped to the cockpit grid cell.
