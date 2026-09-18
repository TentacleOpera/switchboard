# Creating Terminals From the Cockpit - Picker, Curtain, Seating

**Complexity:** 6

## Goal

Spawning terminals from the cockpit misbehaves at every step: the role picker opens at the top of the sidebar instead of under the workspace header that was clicked, and OPEN AGENT TERMINALS produces a staggered batch where the first terminal never wears a startup curtain and six requested terminals yield a grid of four. Both trace to the same design gap - the spawn surfaces were extended without moving the presentation or the seating with them.

## How the Subtasks Achieve This

- **New-Terminal Role Picker Opens at the Top of the Terminals Sidebar**: makes the picker state-driven and per-group so it renders under the header whose `+` was clicked, adds a one-shot scroll-into-view, and removes the misleading global `+ New`.
- **OPEN AGENT TERMINALS — seat every terminal, grow the grid, paint the first curtain**: unifies the two seating mechanisms, grows the layout to hold the batch, and arms the curtain for pane 0.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [OPEN AGENT TERMINALS — seat every terminal it creates, grow the grid to fit, and paint the first curtain](../plans/feature_plan_20260808142009_open-agent-terminals-seat-every-terminal-and-grow-the-grid.md) — **CODE REVIEWED** — ID: d4065eb2-1617-4138-b3aa-23cd1cb8658b
- [ ] [New-Terminal Role Picker Opens at the Top of the Terminals Sidebar Instead of Under the Workspace Header That Was Clicked](../plans/feature_plan_20260808212400_role-picker-opens-under-clicked-workspace-header.md) — **CODE REVIEWED** — ID: 18d0f914-5196-464a-9d99-983e0e50b345
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints between the two, but both edit `src/webview/terminals.js` and `terminals.html`, so they must be sequenced rather than parallelised.

**Merged history.** A third plan — *Fix: OPEN AGENT TERMINALS skips startup curtain* (`7dc3d22c`) — was **deleted on 2026-08-10** as redundant. It diagnosed a real second mechanism (the 4 s no-output cap expiring curtains 2..N before the loop seats them) but prescribed a fix that fails a CI-gated contract test: `src/test/multi-parent-terminals-contract.test.js:257` uses the *first* `await fetchTerminalList();` as a `block()` end marker, and that plan's Change 1 added an earlier one inside the loop. Its timeline analysis was salvaged into the surviving plan as **Root cause B2** before deletion — do not re-derive it, and do not re-introduce the rejected edit shape.

⚠ **File contention:** shares `terminals.js` with *Terminal Stream Fidelity*, *Multi-Window Cockpit Reliability*, *Shell Rail Terminal Buttons* and *Seat to Plan Attribution*.

## Review Findings

Both subtasks reviewed in one pass with tests executed independently — neither plan's "tests were skipped" note was treated as a directive. Two MAJOR findings fixed: the role picker did not close synchronously on role selection (state cleared, no re-render, so the menu lingered for the create round trip and until the 5 s poll on failure) — fixed in `src/webview/terminals.js` and pinned by a new assertion; and `src/test/terminal-open-all-seating-contract.test.js` was authored but invoked by no gate — now wired in `package.json` and `.github/workflows/integration-tests.yml`. No cross-subtask conflict: the seating work touches `armStartupCurtain` / `openAllTerminals` / `fillEmptyPanes` while the picker work touches `renderSidebarList` / `renderGroupSidebar` / `onNewTerminalClicked`, and the one shared surface (`renderSidebarList` being called per-create from the loop's `fillEmptyPanes`) re-renders an open picker rather than dropping it, because `pickerRendered` is set whenever its owning group still exists. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/test/terminal-sidebar-groupings-contract.test.js`, `src/test/terminal-open-all-seating-contract.test.js` (new), `package.json`, `.github/workflows/integration-tests.yml`. All named gates green (open-all 10/10, groupings 24/24, role-ordering 7/7, multi-parent 29/29, reconcile, pinning, strip, pty-route, shim-injection), `eslint` clean; the 2 `terminal-pane-fit-verification` reds are pre-existing at HEAD; remaining risk is UAT-only — the browser cockpit serves the installed VSIX's bundle, so neither fix is observable until a rebuild and reinstall.
