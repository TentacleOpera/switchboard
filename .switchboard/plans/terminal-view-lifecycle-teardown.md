# Terminal View Lifecycle: Dispose Views That Leave a Pane

## Goal

Make an unassigned terminal stop costing anything. Today a terminal removed from a pane keeps its WebSocket, its xterm instance and its WebGL context alive forever, so the browser parses output for every terminal it has *ever* displayed while rendering only the handful currently visible.

### Problem

The Terminals panel gets progressively slower the longer the tab stays open, independently of how much output the visible terminals are producing. Swapping terminals in and out of panes — the normal way of watching a fleet larger than the layout — makes it worse permanently, and a reload is the only fix.

### Root cause

**1. Unassigning a terminal tears down nothing (`src/webview/terminals.js:809-813`).**

`renderPaneGrid` ends with:

```js
for (const [name, entry] of terminalsMap.entries()) {
    if (!paneAssignments.includes(name)) {
        entry.container.classList.remove('active');
    }
}
```

That is the entire cleanup. `destroyTerminalView` (`:1036-1064`) — which closes the socket, disposes the renderer addon and disposes the terminal — is reachable only from `closeTerminal` (`:1023`) and `renameTerminal` (`:966`). Removing a terminal from a pane calls neither.

So for every terminal ever assigned to a pane, indefinitely:

- the WebSocket stays open and keeps receiving every byte of output;
- `flushBatch` keeps calling `term.write()`, so xterm keeps **parsing** all of it;
- the WebGL context stays allocated.

**2. The container is detached, so the parsing is pure waste.** `renderPaneGrid` starts with `paneGridEl.innerHTML = ''` (`:719`), which removes the pane elements and with them the `contentEl` that owned `entry.container`. The terminal is no longer in the document at all — it is being fed and parsed for nothing.

**3. WebGL contexts are a capped, non-renewable resource.** Browsers allow roughly 16 live contexts per page and silently kill the oldest when the cap is exceeded. `attachRenderer` handles the loss correctly (`:84-106`) — `onContextLoss` drops that terminal to the canvas addon — but the fallback is **one-way**: nothing ever re-attempts WebGL. So exceeding the cap once permanently downgrades an *already-open* terminal that had done nothing wrong. The existing `destroyTerminalView` comment (`:1050-1052`) documents exactly this hazard for the close path; the unassign path leaks the same resource with no comment and no cleanup.

### Context

Disposal is safe here specifically because the server already owns the durable state. `TerminalWsGateway` keeps a per-terminal `MAX_SCROLLBACK_BYTES` (256 KB) ring (`terminalWsGateway.ts:5`, `:199-210`) and supports `lastSeq` resume (`:346-352`, `:386-395`), so a detached client re-attaches and receives exactly the tail it missed as a single frame. 256 KB is roughly 3 000 lines at 80 columns, against xterm's default scrollback of 1 000 lines — which `createTerminalView` (`:1076-1081`) never overrides. Disposing and re-attaching therefore loses **less** scrollback than the client was holding, not more.

## Scope

All changes are in `src/webview/terminals.js`.

## Metadata

- **Complexity:** 5
- **Tags:** performance, bugfix, frontend, terminals

## User Review Required

None.

## Complexity Audit

### Routine

- `destroyTerminalView` already exists, already handles every resource in the correct order (reconnect timer → socket → resize observer → renderer addon → terminal → DOM node), and is already called from two paths. This plan adds a third caller and a timer in front of it.
- The grace timer is a `Map<string, timeoutId>` with one arm point and two clear points.
- Setting `scrollback` is one constructor option.

### Complex / Risky

- **Reconnect must not fight disposal.** `ws.onclose` schedules a reconnect whenever the fleet list says the terminal is `active` (`:1232-1245`). Disposal closes the socket, so it fires `onclose` — and unless `entry.exited` is set first, the entry re-opens a socket for a view that is being torn down. `destroyTerminalView` already sets `entry.exited = true` before closing (`:1042-1046`), and that ordering is now load-bearing rather than incidental.
- **A grace timer that outlives its terminal.** If the terminal is closed (or renamed) while its grace timer is pending, the timer must be cancelled — `destroyTerminalView` is idempotent-ish but the timer would otherwise fire against a `terminalsMap` entry that a *new* terminal of the same name could occupy. `PtyFleetService.create` reuses freed names (`ptyFleetService.ts:74-79`), so name collision after close is a real path, not a hypothetical.
- **Renderer accounting is global, not per-terminal.** Avoiding the context cap means tracking live contexts across the whole module and deciding *before* construction, because by the time `onContextLoss` fires the damage has already landed on a different terminal.
- **Re-attach cost lands on the pane swap.** Disposal means re-assigning replays up to 256 KB in one frame. That is a real, visible cost placed exactly where the operator is looking, which is why the grace period exists rather than immediate disposal.

## Edge-Case & Dependency Audit

### Race Conditions

- **Unassign → re-assign inside the grace window.** Must cancel the timer and reuse the live entry with no socket churn. This is the common case (flipping between two terminals in one pane) and must cost nothing.
- **Unassign → terminal exits during the grace window.** `untrackTerminalData` sends `{t:'exit'}` and closes the socket (`terminalWsGateway.ts:243-250`), setting `entry.exited`. The grace timer then disposes a already-dead view — harmless, but must not throw.
- **Unassign → close button pressed during the grace window.** `closeTerminal` calls `destroyTerminalView` directly; the pending timer must be cleared there or it fires against a deleted map entry.
- **Rename during the grace window.** `renameTerminal` already calls `destroyTerminalView(name)` and re-keys the pane assignments (`:966-983`); the timer is keyed by the **old** name and must be cleared with it.
- **Layout floor drops a pane while a terminal is in it.** `applyLayoutFloor` (`:844-859`) re-renders with fewer slots, so a terminal can become unassigned without the operator touching it. That is the same path — arm the grace timer, do not special-case it.
- **Rapid cycling.** Cycling twenty terminals through one pane inside the grace window leaves twenty live views transiently. Bounded by the window (they all expire), but it is the reason the renderer cap check must exist independently of the timer.

### Security

- No new data sources, no new host messages, no new persisted state.

### Side Effects

- **Re-assigning a long-idle terminal now shows a replay rather than a continuously-maintained view.** Content is equivalent (see **Context**) but the render arrives as one write instead of having accumulated, so there is a brief blank frame on attach. Acceptable and already the behaviour on first assign.
- **Fewer live WebGL contexts across the page.** The other five panels share the same context budget, so this reduces a page-wide pressure, not just a terminals-panel one.
- **Explicit `scrollback` changes memory per terminal.** Setting it to a value matched to the server ring makes client memory predictable instead of implicit.

### Dependencies & Conflicts

- **`terminal-output-flow-control.md`** edits `flushBatch`, `scheduleBatchFlush` and `destroyTerminalView` in this same file (it removes the per-entry rAF fields and adds a page-level pending set). Whichever lands second must ensure the drain set drops disposed entries. No conflict in `renderPaneGrid`.
- **`terminal-input-paste-path.md`** edits `term.onData` in this file; no overlap with the lifecycle paths.
- No new libraries.

## Dependencies

None. Independently shippable in any order relative to its siblings.

**Migration:** none. All state introduced is in-memory and starts empty on load. The Terminals panel is unreleased (first commit 2026-07-31), and no persisted setting changes shape.

## Adversarial Synthesis

**Risk summary.** The naive version of this fix — dispose immediately on unassign — trades a slow leak for a stutter on every pane swap, which the operator notices far more. The grace period fixes that but introduces a timer that can outlive its terminal, and because `PtyFleetService` reuses freed names, a stale timer can dispose a *different* terminal that happens to have inherited the name. Mitigation is to clear the timer at every point that already calls `destroyTerminalView` and to key disposal on entry identity, not just name. The second trap is the reconnect loop: closing a socket fires `onclose`, which reconnects unless `entry.exited` is already set — so disposal ordering that looks incidental is actually the thing preventing an unkillable view. Residual accepted risk: rapid cycling can hold more live views than the layout for up to one grace window, which the renderer-cap check bounds to a canvas downgrade rather than a context loss.

## Proposed Changes

### `src/webview/terminals.js`

#### (a) Grace-period disposal on unassign

Add module state next to `terminalsMap` (`:17`):

- `DETACH_GRACE_MS = 15000` with a comment explaining the trade: immediate disposal makes every pane swap pay a reconnect and a 256 KB replay; the window makes swap-and-swap-back free.
- `detachTimers = new Map()` — terminal name → timeout id.

Rewrite the tail of `renderPaneGrid` (`:809-813`): for each entry not in `paneAssignments`, remove the `active` class as today **and** arm a disposal timer if one is not already armed. For each entry that *is* assigned, cancel any pending timer.

Factor the two operations into `armDetachTimer(name)` / `cancelDetachTimer(name)` so no call site can arm one without a matching clear.

The timer callback must re-check that the terminal is still unassigned before disposing — the assignment can change without a re-render in the `assignToFocusedPane` early-return path (`:651`).

#### (b) Clear the timer everywhere disposal already happens

Call `cancelDetachTimer(name)` at the top of `destroyTerminalView` (`:1036`), which covers `closeTerminal` and `renameTerminal` without touching either. Add it to `renameTerminal`'s re-keying block for the **new** name too, so an inherited name cannot carry a stale timer.

#### (c) Bound live WebGL contexts

Add `MAX_WEBGL_CONTEXTS = 12` and a module-level `liveWebglContexts` counter. In `attachRenderer` (`:84-106`), skip the WebGL branch entirely when the counter is at the cap and go straight to `attachCanvasRenderer`. Increment on successful attach; decrement in `onContextLoss` and wherever the holder is disposed in `destroyTerminalView` (`:1053-1056`).

The cap is 12 rather than 16 to leave headroom for the other five panels, which share the page's context budget. Comment that the point is to make the *new* terminal take the slower renderer rather than let the browser silently and permanently downgrade an existing one.

#### (d) Explicit scrollback

Add `scrollback` to the `Terminal` constructor (`:1076-1081`), sized to match the server ring's intent rather than left at xterm's implicit 1000. Comment the relationship to `MAX_SCROLLBACK_BYTES` so the two are changed together.

#### (e) Make the write path disposal-safe

`flushBatch` (`:1266-1275`) must return early when the entry has been disposed. Today it cannot be reached post-disposal because the rAF is cancelled, but with a grace timer and (per the sibling plan) a page-level drain set, the guard becomes necessary rather than defensive. Set an explicit `entry.disposed = true` in `destroyTerminalView` and check it — `entry.exited` means "the process exited", which is a different condition and must not be overloaded.

**Edge cases.** `destroyTerminalView` is already tolerant of a missing entry (`:1038`); keep that. The `ws.onclose` reconnect guard (`:1233`) keys on `entry.exited`, which `destroyTerminalView` sets at `:1042` **before** closing the socket — preserve that ordering and add a comment saying why, since it is the only thing preventing a disposed view from resurrecting itself.

## Verification Plan

### Automated Tests

Extend `src/test/terminal-flow-control-contract.test.js` if it exists by then, otherwise add `src/test/terminal-lifecycle-contract.test.js` on the same source-text convention, registered in `package.json` and the CI workflow.

1. **Unassign arms disposal.** Assert `renderPaneGrid`'s unassigned branch calls `armDetachTimer` and no longer *only* removes the `active` class.
2. **Assignment cancels it.** Assert `cancelDetachTimer` is called on the assigned branch.
3. **Disposal clears the timer.** Assert `destroyTerminalView` calls `cancelDetachTimer`.
4. **Context cap exists.** Assert `attachRenderer` references `MAX_WEBGL_CONTEXTS` before constructing `WebglAddon`, and that the counter is decremented in both the context-loss handler and `destroyTerminalView`.
5. **`exited` and `disposed` are distinct.** Assert both flags exist and that the `ws.onclose` reconnect guard still keys on `exited`.
6. **Scrollback is explicit.** Assert the `Terminal` constructor options include `scrollback`.

### Manual

1. **Reproduce first.** Assign eight different terminals to one pane in sequence, with agents producing output in all of them. Watch the tab's CPU in the browser task manager and confirm it climbs and stays climbed. Confirm in devtools that eight WebSockets remain open (`chrome://net-export` or the Network panel's WS tab).
2. **Post-fix:** after the grace window, only the assigned terminals' sockets remain open, and CPU returns to the level of the visible set.
3. **Swap-back is free.** Assign terminal A, swap to B, swap back to A within the grace window. Confirm no reconnect (Network panel shows no new WS) and no visible replay flash.
4. **Swap-back after the window.** Repeat with a 20 s gap. Confirm A reconnects, replays its tail, and the content matches what was on screen before, with no duplicated lines (the `lastSeq` path).
5. **Close during grace.** Unassign a terminal, then press its close button before the window expires. Confirm no error in the console and no stale timer firing 15 s later.
6. **Rename during grace.** Unassign, then rename before expiry. Confirm no error and that the renamed terminal can be re-assigned normally.
7. **Name reuse.** Unassign `coder-1`, close it, create a new terminal (which reclaims the name), assign it, and wait past the original grace window. Confirm the new terminal is **not** disposed by the old timer.
8. **Layout floor.** Shrink the window until the floor steps 3x3 down to 2x2 (`resolveFlooredLayout`, `:821-836`). Confirm the terminals that lost their panes are disposed after the grace window and that stepping back up re-attaches them.
9. **Context cap.** Open twelve terminals across the 3x3 layout plus swaps and confirm via the console that later terminals take the canvas renderer instead of any existing terminal going blank or losing its WebGL context.
10. **Regression suite.** Run the contract tests; stash-verify the five known-red tests at HEAD before attributing failures here.

## Resolved Assumptions

Confirmed by web research (2026-08-01); treat as settled — do not re-research.

- **WebGL context cap confirmed.** Chrome enforces 16 live WebGL contexts per domain/renderer process; the 17th request logs "Too many active WebGL contexts. Oldest context will be lost." and force-evicts the least-recently-used context, which receives `webglcontextlost`. WebKit/Safari enforces the same 16-context LRU policy (`WebGLRenderingContextBase.cpp`). Firefox defaults to 300 (`webgl.max-contexts-per-principal`) but destabilises well below that. `MAX_WEBGL_CONTEXTS = 12` (headroom for the five sibling panels on the same page) is correct for Chrome/Safari and conservative for Firefox.

## Recommendation

Complexity 5 → **Standard coder.**
