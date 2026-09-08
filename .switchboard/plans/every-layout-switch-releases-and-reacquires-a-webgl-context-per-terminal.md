# Every Layout Switch Releases and Re-Acquires a WebGL Context Per Terminal

## Goal

Stop tearing down WebGL contexts for terminals that have not gone anywhere. A layout switch re-boxes
existing seats; it should cost a reflow, not a renderer teardown and rebuild per pane.

### Problem analysis

**Measured on the live standalone host, 2026-09-08**, with the terminals panel open and **one** live
terminal (`Coding`, WebGL renderer active). Six layout switches driven through the real
`.btn-layout` buttons, with `HTMLCanvasElement.getContext`, `getExtension('WEBGL_lose_context')` and
`ResizeObserver` instrumented:

```
switch times   2x2  91ms · 1  58ms · 3x3  66ms · 1  27ms · 2x3  70ms · 1  34ms
GL acquires    9
GL releases    9
ResizeObserver 33 callbacks
```

**Nine contexts acquired and nine released, for one terminal, across six switches.** The seat never
left the fleet — it stayed in `terminalsMap` with its socket open the whole time. What changed was
which box it was drawn in.

#### Why it happens

`renderPaneGrid` detaches pane DOM nodes (`paneGridEl.removeChild`) and rebuilds the grid. The xterm
instance survives, but the renderer does not: the addon is disposed on the way out and re-created on
the way in, and `forceReleaseWebglContext` (`terminalViewport.js:428`) hands the GL context back
immediately on each teardown.

That function is correct and was written for a real reason — its own docblock records that
`WebglAddon.dispose()` tears down the renderer and then *leaves the live WebGL2 context to the garbage
collector*, so a disposed-but-uncollected addon keeps occupying a slot against the browser's
per-process ceiling. The bug is not the release; it is that the release is being triggered by a
**re-box**, not by a terminal actually leaving.

The `MAX_WEBGL_CONTEXTS = 12` ceiling (`terminalViewport.js:62`) is a per-document budget. At one
terminal it is nowhere near binding, so none of this churn is buying anything.

#### Second cost

**33 ResizeObserver callbacks for six switches** — roughly five or six reflow notifications per
switch. The switch times track pane count (2x2 at 91ms, single-pane returns at 27–34ms), which is what
a per-pane reflow cost looks like.

#### The measurement understates it

One terminal was on screen. With a full grid the GL churn multiplies by pane count **and** the 12-slot
ceiling starts binding, at which point panes begin falling back to the canvas renderer as well. Real
lag will be worse than these figures.

### Rejected: opening grids as separate browser tabs

Considered because a tab is its own renderer process with its own GL budget, which would lift the
12-context ceiling. It does not address this defect and makes two things worse:

- **The churn is unchanged.** Release/re-acquire per switch is not caused by the ceiling, so a bigger
  budget does not remove it.
- **Background tabs are throttled.** `requestAnimationFrame` stops and timers are clamped in a hidden
  tab. The fit ladder runs on rAF, so a grid you switch away from stops settling and must catch up on
  return — moving the lag from switching to returning, with scrollback catch-up on top.
- **Each tab opens its own WebSocket set**, and `transport.js` already fans every push out 6× because
  it ignores `msg.surface`. More documents multiplies that.

## Metadata

**Complexity:** 5
**Tags:** performance, terminals, webgl, webview
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. A re-box must not release the renderer (`src/webview/terminalViewport.js`)

- **Logic:** Keep the WebGL addon alive while its terminal remains in `terminalsMap`. Release the
  context only when the terminal genuinely leaves the fleet, or when the ceiling is actually reached
  and a slot must be reclaimed. Re-parenting a live xterm into a new pane element should not touch the
  renderer at all.
- **Edge cases:** A terminal moved into a pane with **no box** (zero width/height) must not acquire a
  context — the existing `hasBox` guard at `:344` covers this and must survive. A terminal that is
  genuinely closed must still release immediately; `forceReleaseWebglContext` stays, with a narrower
  trigger.

### 2. Reclaim under pressure, not on every move

- **Logic:** When `liveWebglContexts` would exceed `MAX_WEBGL_CONTEXTS`, release the least-recently
  visible terminal's context rather than refusing the new one. Today the acquire is simply skipped
  (`:344`), so which panes get WebGL depends on creation order rather than on what the operator is
  looking at.

### 3. Do not reflow panes nobody can see

- **Logic:** 33 ResizeObserver callbacks for six switches is reflow work spread across panes including
  off-screen ones. Coalesce per switch and skip panes with no box.
- **Edge cases:** `fitLadderGen` already exists to collapse rapid minimize/restore cycles — extend that
  generation guard rather than adding a second mechanism.

### 4. Keep the measurement runnable

- **Logic:** The instrumentation used here (patching `getContext`, `getExtension('WEBGL_lose_context')`
  and `ResizeObserver`, then driving the real layout buttons) should land as a repeatable check, so a
  regression shows up as a number rather than as "feels laggy".

## Verification Plan

### Automated Tests
- Six layout switches with N terminals: **zero** GL acquires and zero releases, because no terminal
  left the fleet.
- Closing a terminal releases its context immediately (the existing behaviour must not regress).
- Exceeding the ceiling reclaims the least-recently-visible context rather than skipping the acquire.
- ResizeObserver callbacks per switch scale with *visible* panes, not with all panes.

### Goal Invariants
- A layout switch performs no renderer teardown for a terminal that stays in the fleet.
- A terminal that leaves the fleet always releases its context, without waiting for GC.
- No pane with no box ever holds a GL context.

### Manual
- With a full grid, switch layouts repeatedly and confirm the switch feels immediate and that
  `__sbTerminalStats()` still reports `isWebgl: true` for visible panes afterwards.

## Outstanding Questions

- None.
