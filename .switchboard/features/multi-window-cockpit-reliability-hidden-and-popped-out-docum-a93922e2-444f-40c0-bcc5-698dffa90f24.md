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
- [ ] [Fix Terminal Renderer Desync on Window Minimize/Restore](../plans/feature_plan_20260807120001_fix-terminal-renderer-desync-on-window-restore.md) — **CODE REVIEWED**
- [ ] [Diagnose and fix the New Window WebSocket freeze root cause](../plans/feature_plan_20260807140000_diagnose-new-window-ws-freeze-root-cause.md) — **CODE REVIEWED**
- [ ] [A Never-Opened Terminals Panel Holds a WebGL Context Per Terminal, Starving Every Other Window](../plans/feature_plan_20260807140000_defer-webgl-context-until-pane-has-a-box.md) — **CODE REVIEWED**
- [ ] [Solo Terminal Pop-Out Renders at the Cockpit Grid Cell's Size Because the Shared PTY Takes the Minimum of Every Attached Viewport](../plans/feature_plan_20260808212300_solo-popout-pty-clamped-to-cockpit-grid-cell.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered pair.** The WebGL-context subtasks are two faces of the same accounting: the desync fix's leading candidate trigger is an LRU context eviction caused by the very contexts the release subtask gives back. **Land "A Never-Opened Terminals Panel Holds a WebGL Context" first**, then "Fix Terminal Renderer Desync", so the repair is verified against a tree where evictions are rarer.

The WS-freeze and solo-pop-out subtasks are independent of that pair and of each other.

⚠ All four edit `src/webview/terminals.js` — one agent stream per file, so none of them may run in parallel despite the logical independence.

⚠ **Cross-feature:** the solo pop-out subtask shares `?solo=` behaviour with the right-hand agent dock in *Reaching an Agent From Where You Are*. **Land the sizing fix before or with the dock**, or the dock ships hosting a seat clamped to the cockpit grid cell.

## Completion Report

Implemented all four subtasks in `src/webview/terminals.js`: a one-shot WebGL context release guarded by `isRendered`, a visibility-regain renderer resync latched through `startFitLadder`, gated transport logging with a client-side handshake deadline and reconnect triggers, and a primary-voter pty sizing rule with `panelVisibility` messages. Also touched `src/services/wsHub.ts` to bound the resync and pre-upgrade auth awaits, `src/services/LocalApiServer.ts` for the `/ws/connections` diagnostic, `src/webview/transport.js` for the handshake/reconnect logic, `src/standalone/terminalWsGateway.ts` for the `?solo=1` primary sizing, and `src/webview/shell.js` to broadcast panel visibility. All changes are in source; no compilation or automated tests were run per the session directives.

## Review Findings

Reviewer pass (2026-08-11) ran compilation and the full contract suite — the coding pass's "no tests run" note was a record, not a directive, and this dispatch carried no skip line. Three CI-red gates were found and fixed: `terminal-flow-control-contract` (still asserting the three-decrement accounting the WebGL subtask deliberately replaced), `terminal-solo-popout-contract` (the merged `visibilitychange` listener put a `fetchTerminalList()` above the solo `checkSoloNotFound()` paint — the two listeners are now split), and `catalog:check` (the new `panelVisibility` push site and `/ws/connections` endpoint had not been regenerated into `protocol-catalog.json`). One MAJOR behavioural gap fixed: the two subtasks carry **contradictory platform research** about whether an in-iframe `ResizeObserver` sees the parent's `display:none`, and the implementation followed each one in its own lane — so the WebGL release was left betting its headline case ("a panel switched away from keeps every context it took") on the optimistic reading, failing silently if wrong; it now rides the `panelVisibility` carrier the solo subtask already built. Both plans' named automated gates were missing entirely and are now authored and CI-wired: `terminal-renderer-lifecycle-contract.test.js` and `ws-popout-broadcast-contract.test.js` — the latter verified to fail against HEAD's unbounded resync and pass with the fix, which selects **decision-table row 1** (Hypothesis E) for the WS-freeze subtask. Final state: `tsc` at the HEAD baseline of 5 pre-existing errors, all four ratchets green, every terminal contract green except `terminal-pane-fit` (2) and `ws-surface-scoping` (1), both of which are red at HEAD and unrelated. Remaining risk is entirely browser-side: no UAT was run, so the process-level proof that `loseContext()` actually returns a GPU slot, the pty disenfranchisement check, and the visibility-regain repaint are all verified structurally but not behaviourally.
