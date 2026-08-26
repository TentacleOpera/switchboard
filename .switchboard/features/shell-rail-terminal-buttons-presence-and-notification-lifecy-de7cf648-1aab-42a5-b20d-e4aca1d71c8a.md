# Shell Rail Terminal Buttons - Presence and Notification Lifecycle

**Complexity:** 5

## Goal

The shell left rail renders one button per fleet terminal, and both halves of that are broken. The list itself can vanish permanently, because the only thing that populates it is a one-directional postMessage from the terminals iframe with no failure path and no shell-side fallback. And the green completion ring on those buttons is a sticky flag with no expiry and no animation, so a finished agent lights the rail forever until the user guesses which gesture dismisses it. Both are defects in the same rail rendering path.

## How the Subtasks Achieve This

- **Restore Disappeared Terminals List in Shell.html Sidebar**: pushes fleet state on every `fetchTerminalList` exit path including failures, and adds a shell-side request path so the rail can recover without waiting for the terminals iframe.
- **Completion Ring on Shell Rail Terminal Icons Burns Forever**: turns the DONE ring into a real notification — pulse once, then fade — instead of a permanent border that tracks acknowledgement rather than having been seen.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Restore Disappeared Terminals List in Shell.html Sidebar](../plans/feature_plan_20260806143802_terminal-list-disappeared-from-shell-sidebar.md) — **CODE REVIEWED** — ID: 4abe4a87-422d-444f-8425-b374bb92911d
- [ ] [Completion Ring on Shell Rail Terminal Icons Burns Forever — the DONE Light Is a Sticky Flag With No Expiry and No Animation](../plans/feature_plan_20260808212500_completion-ring-pulses-once-then-fades.md) — **CODE REVIEWED** — ID: 02778084-4d89-4862-ac65-10c1728ee60d
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered.** Both edit `shell.js`'s `renderTerminalSection` and the `postFleetStateToShell` producer in `terminals.js`, so they cannot run concurrently. **Land the presence fix first** — there is no point tuning the ring's lifecycle on a rail that can disappear entirely.

⚠ **File contention:** shares `terminals.js` with *Terminal Stream Fidelity*, *Multi-Window Cockpit Reliability*, *Creating Terminals From the Cockpit* and *Seat to Plan Attribution*.

## Review Findings

Reviewer pass over both subtasks against `src/webview/terminals.js`, `src/webview/shell.js`, `src/webview/shell.html` and `src/test/shell-terminal-strip.test.js`. Three MAJOR findings fixed: `Math.round(pulseElapsed)` could produce an `animation-delay` whose magnitude equals the animation duration (the exact expired-completion green flash the plan's strict `<` guard exists to prevent) — now `Math.floor`, pinned by a new assertion verified against the pre-fix source; the new `requestFleetState` message arm had no `event.origin` guard while its two `postMessage`-driven neighbours do — guard added; and the presence subtask shipped with no automated coverage at all — two contract assertions added pinning the failure-path relay and the shell↔iframe request round trip. Files changed by the review: `src/webview/shell.js`, `src/webview/terminals.js`, `src/test/shell-terminal-strip.test.js`. Validation: `shell-terminal-strip` 34 passed / 0 failed (was 32), `terminal-solo-popout` 11/0, six adjacent terminal suites green, eslint + `tsc --noEmit` clean, and parity / push-routing / verb-returns / standalone-parity / mirror gates all pass. Remaining accepted risks are cosmetic and documented per-subtask: a rename re-pulses a done-badged terminal once, and the per-frame `badgeStampSeq` could collide with a stale shell ledger only if the terminals iframe reloaded alone (unreachable — `frame.src` is set once).
