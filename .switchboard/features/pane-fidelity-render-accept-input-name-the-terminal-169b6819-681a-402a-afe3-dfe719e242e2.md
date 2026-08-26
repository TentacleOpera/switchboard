# Pane Fidelity — Render, Accept Input, Name the Terminal

**Complexity:** 7

## Goal

Make a terminal pane an honest view of its pty. Three independent defects break that today: seating a terminal into an empty slot corrupts the glyphs in unrelated neighbours (a per-document WebGL budget counted against a per-process limit), a pane that took one exit or error frame renders read-only over a live pty until the panel is reloaded, and the header shows the CLI brand and the handle but never the agent role, so nine panes in a fan-out all read the same brand label.

## How the Subtasks Achieve This

- **Seating a Terminal Corrupts Sibling Pane Glyphs**: replaces the per-document WebGL counter with a `BroadcastChannel`-coordinated process budget, routes renderer-loss recovery through the verifying fit ladder instead of one synchronous call, and stops consuming a glyph-model repair as a cheap repaint. This is what makes a pane render what its pty is actually sending.
- **`exited` Flag Is a One-Way Latch**: reconciles latched entries against the live fleet on each poll — keyed on `agentInstanceId` so a same-name replacement is caught, and gated on snapshot age so a correctly-dead pane is not torn down. Also stops reporting an operator kill as `[Process Exited with code 0]`. This is what makes a pane accept input while its pty is alive.
- **Pane Header No Longer Shows the Agent Role**: writes the role into the header, the tooltip and the `aria-label`, and makes terse layouts show the role rather than nine identical brand labels. This is what makes a pane say which agent it holds.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Terminal Pane's `exited` Flag Is A One-Way Latch — A Live PTY Renders Read-Only Until The Panel Is Reloaded](../plans/feature_plan_20260813084500_terminal-pane-exited-latch-never-clears.md) — **PLAN REVIEWED** — ID: 587776f2-44e1-4b3a-92a0-bceb14127657
- [ ] [The Terminal Pane Header Shows the CLI Brand and the Handle, But No Longer Shows the Agent Role](../plans/feature_plan_20260813100100_pane-header-no-longer-shows-the-agent-role.md) — **PLAN REVIEWED** — ID: fbd0ea84-9e14-4b27-a5c1-0e9fdf70faaa
- [ ] [Seating a Terminal Into an Empty Grid Slot Corrupts the Glyphs in Its Neighbours](../plans/feature_plan_20260813100200_seating-a-terminal-corrupts-sibling-pane-glyphs.md) — **PLAN REVIEWED** — ID: db17215d-d140-4c0e-8c45-6237cdcea939
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Land Seating Corrupts Glyphs before the `exited` latch fix.** Both touch renderer / WebGL context lifecycle: the latch fix heals by calling `destroyTerminalView`, which releases a context, and it does so on every 5s fleet poll. Get the budget accounting right first, or the heal path starts churning contexts against a ceiling that is still being counted per-document.
- **Honour the glyph subtask's diagnostic gate before coding it.** That plan requires the WebGL-loss hypothesis to be *confirmed* (via `__sbTerminalStats` and a console loss line) before the expensive cross-document coordination is built, and names the fallback path if it is wrong. It is not optional preamble.
- **Pane Header Role is behaviourally independent** of the other two and can run in parallel with them.
- **Cross-feature contention:** Pane Header Role rewrites `updatePaneElement`'s title row, and the *Completion Signalling* feature's **One Completion Paints Four DONE Surfaces** subtask deletes a block from that same row. Serialise those two across features; do not dispatch both features concurrently.
- All three subtasks edit `src/webview/terminals.js`. Under the one-stream-per-file rule they serialise against each other regardless of the ordering above.
