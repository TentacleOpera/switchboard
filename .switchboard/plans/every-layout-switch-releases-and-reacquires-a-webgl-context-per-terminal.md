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

> **Superseded:** `renderPaneGrid` detaches pane DOM nodes (`paneGridEl.removeChild`) and rebuilds the grid. The xterm instance survives, but the renderer does not: the addon is disposed on the way out and re-created on the way in.
> **Reason:** This mechanism contradicts the `no move when already in place` invariant at `src/webview/terminals.js:6806` (in place since 2026-08-04, commit `30d82f81`): `updatePaneElement` re-parents `entry.container` ONLY when `entry.container.parentNode !== contentEl`, i.e. when the slot's *assignment* changed. `renderPaneGrid`'s surplus removal (`terminals.js:5747`) drops only *trailing* pane elements — slot 0 is never removed when shrinking — so a terminal that stays in its slot is never re-parented. No code path in the layout-switch flow (`setLayoutMode` → `sanitizePaneAssignments` → `renderPaneGrid` → `applyLayoutFloor`) calls `destroyTerminalView` or `swapRenderer`; `resyncPaneRenderer` repairs the renderer in place (`clearTextureAtlas`/`refresh`/`handleResize`) and never disposes it. For a single terminal held in slot 0 across six switches, the stated mechanism should produce **zero** acquires and zero releases, not nine. The empirical 9/9 is therefore either (a) measured against a build predating the invariant, or (b) produced by a release path the diagnosis does not name.
> **Replaced with:** The measurement (9 acquires / 9 releases) is preserved as an empirical observation, but the *cause* is **unresolved** — see `## Outstanding Questions`. The implementation must first re-run the instrumentation against current HEAD to confirm the churn still reproduces, and if it does, trace the actual acquire/release path (candidate paths that DO release on a re-box: the per-entry `ResizeObserver` at `terminalViewport.js:1139` firing `armRendererRelease` when a container transiently measures 0x0 during the grid reflow; or a slot re-seat that moves the terminal between pane indices). Do not implement Proposed Change #1 against the now-superseded mechanism — verify the real path first.

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

> **Note (review):** The instrumentation patched the *global* `ResizeObserver` constructor, so the 33 count includes every observer in the document (sidebar, kanban, shell), not only the terminal's per-entry observer (`terminalViewport.js:1139`). The "spread across panes including off-screen ones" attribution should be re-checked against a per-entry-filtered count before Proposed Change #3 is sized.

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

**Tags:** performance, frontend, bugfix
**Complexity:** 5
**Dependencies:** none

## User Review Required

The root-cause mechanism originally recorded in `### Problem analysis → Why it happens` is
superseded — see the callout there. Before any implementation of Proposed Change #1, re-run the
instrumentation against current HEAD and confirm the 9/9 churn still reproduces; if it does, trace
the actual acquire/release path. The plan proceeds on the assumption that the churn is real and the
diagnosis merely mis-named the path (see `## Outstanding Questions`).

## Complexity Audit

### Routine
- Re-running the existing `getContext` / `getExtension('WEBGL_lose_context')` / `ResizeObserver`
  instrumentation against current HEAD to confirm or refute the 9/9 churn.
- Landing that instrumentation as a repeatable dev-only check (Proposed Change #4) — pure
  measurement scaffolding, no behaviour change.
- Coalescing per-switch `ResizeObserver` work and skipping no-box panes (Proposed Change #3) —
  extends the existing `fitLadderGen` generation guard, a pattern already in the codebase.

### Complex / Risky
- **Identifying the real release path.** The originally-stated mechanism is contradicted by the
  `no move when already in place` invariant (`terminals.js:6806`). The actual cause of the 9/9 is
  unresolved; implementing a fix without knowing the path risks fixing nothing.
- **LRU reclamation under the 12-context ceiling** (Proposed Change #2) — a net-new eviction policy
  that decides which visible pane loses WebGL. A wrong eviction choice degrades the pane the
  operator is actively watching; the current "skip on ceiling" (`terminalViewport.js:344`) is
  order-determined but at least non-destructive.
- **Interaction with the 5 s `RENDERER_RELEASE_DELAY_MS` timer** (`terminalViewport.js:78`) and the
  per-entry `ResizeObserver` (`:1139`). Any change to *when* a context is released must not regress
  the existing hidden-pane reclaim that the dock document depends on (the per-document budget was
  hoisted to script scope precisely so two viewports on one page share it — `:51`–`:63`).

## Edge-Case & Dependency Audit

**Race Conditions**
- The per-entry `ResizeObserver` debounces at 100 ms (`terminalViewport.js:1141`); a grid reflow that
  transiently reports 0x0 then a real size fires the callback once with the final size, but a
  `0x0 → 0x0 → real` sequence arms `armRendererRelease` and the 5 s timer races the next switch. Any
  fix must not release on a *transient* 0x0 that recovers within the same switch.
- `swapRenderer` is release-then-dispose-then-attach (`terminalViewport.js:465`); the
  `webglcontextlost` handler re-enters via `forceReleaseWebglContext` and is guarded by the one-shot
  `released` flag. A new release trigger must not bypass that guard or double-decrement
  `liveWebglContexts`.

**Security**
- None. No untrusted input, no auth surface, no cross-origin path.

**Side Effects**
- Releasing a GL context the browser still counts against the per-process cap is the exact bug
  `forceReleaseWebglContext` exists to prevent; narrowing its trigger must keep the immediate-release
  guarantee for terminals that *genuinely* leave the fleet.
- `resyncPaneRenderer('stale-canvas')` is called after every renderer swap and after resize
  (`terminalViewport.js:255`, `:501`); the WebGL glyph-model corruption it repairs (overprinting on
  shrink) must still be repaired on any path that does re-parent.

**Dependencies & Conflicts**
- Depends on the `no move when already in place` invariant (`terminals.js:6806`) staying intact —
  Proposed Change #1 is largely *enforced* by that invariant already; the change is only the
  remaining gap (transient 0x0 / re-seat paths), which must be identified first.
- `liveWebglContexts` is script-scoped (`terminalViewport.js:63`) so the dock document's two
  viewports share one budget; any LRU policy (Proposed Change #2) must be page-global, not
  per-viewport, or the dock re-introduces the per-instance over-allocation fixed in `36e42cb9`.
- `reconcileRendererForVisibility` (`:444`) is the single authority that re-reads `isRendered`; any
  new release/retain decision should funnel through it rather than adding a second authority.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the plan's root-cause mechanism is contradicted by an invariant in the code for over a
month, so Proposed Change #1 may fix nothing; (2) the LRU eviction in Change #2 is net-new
destructive scope that can degrade the watched pane; (3) the 33-callback reflow count is inflated by
a global `ResizeObserver` patch and may over-size Change #3. Mitigations: re-verify the 9/9 against
current HEAD and trace the real release path before implementing; make LRU eviction visible-only and
page-global; re-measure reflow with a per-entry filter before sizing the coalescing change.

## Proposed Changes

### 1. A re-box must not release the renderer (`src/webview/terminalViewport.js`)

- **Context:** The `no move when already in place` invariant (`src/webview/terminals.js:6806`)
  already prevents re-parenting — and thus renderer teardown — for a terminal whose slot assignment
  is unchanged. The remaining gap (if the 9/9 churn is real) is a release path that fires *despite*
  the invariant. **Before implementing, trace the actual path** (see `## Outstanding Questions`).
- **Logic:** Keep the WebGL addon alive while its terminal remains in `terminalsMap`. Release the
  context only when the terminal genuinely leaves the fleet, or when the ceiling is actually reached
  and a slot must be reclaimed. Re-parenting a live xterm into a new pane element should not touch the
  renderer at all. Any release trigger must distinguish a *transient* 0x0 (grid reflow mid-switch)
  from a *real* loss of box; the existing 5 s `RENDERER_RELEASE_DELAY_MS` timer
  (`terminalViewport.js:78`) is the mechanism that already does this — confirm it is not being
  short-circuited.
- **Edge cases:** A terminal moved into a pane with **no box** (zero width/height) must not acquire a
  context — the existing `hasBox` guard at `:344` covers this and must survive. A terminal that is
  genuinely closed must still release immediately; `forceReleaseWebglContext` stays, with a narrower
  trigger. The dock document's two viewports share the script-scoped `liveWebglContexts` budget
  (`:63`); the retain decision must remain page-global.

### 2. Reclaim under pressure, not on every move

- **Logic:** When `liveWebglContexts` would exceed `MAX_WEBGL_CONTEXTS`, release the least-recently
  visible terminal's context rather than refusing the new one. Today the acquire is simply skipped
  (`:344`), so which panes get WebGL depends on creation order rather than on what the operator is
  looking at.
- **Edge cases:** Eviction must be page-global (the budget is script-scoped, shared by the dock's two
  viewports). The least-recently-visible choice must never evict a pane that is currently rendered
  and visible — evicting the watched pane is a regression the current skip-on-ceiling does not have.
  `reconcileRendererForVisibility` (`:444`) already retries `rendererDeferred` panes when budget
  frees; the eviction policy should integrate with that retry rather than racing it.

### 3. Do not reflow panes nobody can see

- **Logic:** 33 ResizeObserver callbacks for six switches is reflow work spread across panes
  including off-screen ones. Coalesce per switch and skip panes with no box.
- **Edge cases:** `fitLadderGen` already exists to collapse rapid minimize/restore cycles — extend
  that generation guard rather than adding a second mechanism. **Re-measure with a per-entry-filtered
  `ResizeObserver` count first** (the 33 figure was taken with a global patch and includes non-terminal
  observers); size the coalescing to the filtered number, not the global one.

### 4. Keep the measurement runnable

- **Logic:** The instrumentation used here (patching `getContext`, `getExtension('WEBGL_lose_context')`
  and `ResizeObserver`, then driving the real layout buttons) should land as a repeatable check, so a
  regression shows up as a number rather than as "feels laggy". Filter the `ResizeObserver` count to
  the terminal entries (`entry.resizeObserver`, `terminalViewport.js:1167`) so the number reflects
  terminal reflow only.

## Verification Plan

### Automated Tests
- Six layout switches with N terminals: **zero** GL acquires and zero releases, because no terminal
  left the fleet.
- Closing a terminal releases its context immediately (the existing behaviour must not regress).
- Exceeding the ceiling reclaims the least-recently-visible context rather than skipping the acquire.
- ResizeObserver callbacks per switch scale with *visible* panes, not with all panes.

### Goal Invariants
- A layout switch performs no renderer teardown for a terminal that stays in the fleet (assert
  `liveWebglContexts` is unchanged across six switches with one seated terminal; assert
  `entry.rendererAddon.current` is the same addon object before and after, at
  `src/webview/terminalViewport.js` `attachRenderer` return).
- A terminal that leaves the fleet always releases its context, without waiting for GC (assert
  `liveWebglContexts` decrements by exactly one on `destroyTerminalView`, and that
  `forceReleaseWebglContext` ran — i.e. the disposed addon's `_renderer._gl` is no longer reachable
  via the holder).
- No pane with no box ever holds a GL context (assert `entry.isWebgl === false` whenever
  `isRendered(entry.container)` is false, for every entry in `terminalsMap`).

### Manual
- With a full grid, switch layouts repeatedly and confirm the switch feels immediate and that
  `__sbTerminalStats()` still reports `isWebgl: true` for visible panes afterwards.

## Outstanding Questions

- **[user]** Does the 9/9 GL acquire/release churn still reproduce against current HEAD (post
  `36e42cb9`, 2026-09-08)? The originally-stated mechanism is contradicted by the `no move when
  already in place` invariant (`src/webview/terminals.js:6806`, in place since 2026-08-04). Re-run the
  instrumentation before implementing Proposed Change #1 — proceeding on the assumption that the
  churn is real and the diagnosis merely mis-named the release path (candidate paths: the per-entry
  `ResizeObserver` at `terminalViewport.js:1139` arming `armRendererRelease` on a transient 0x0
  during grid reflow; or a slot re-seat that moves the terminal between pane indices). If the churn
  does NOT reproduce, Proposed Change #1 is already satisfied by the invariant and should be dropped
  to "verify-only".
- **[user]** Is the 33 ResizeObserver-callback count inflated by the global `ResizeObserver` patch
  (which captures sidebar/kanban/shell observers too)? Re-measure with a per-entry filter before
  sizing Proposed Change #3 — proceeding on the assumption that a meaningful fraction is terminal
  reflow, but the coalescing should be sized to the filtered count.

---

## Implementation Summary (2026-09-09)

Implemented in `src/webview/terminalViewport.js` (the shared webview module served
identically to both the VS Code extension and the standalone host via
`headlessPanelHtml.ts`, so no composition-root divergence).

- **Proposed Change #2 (LRU eviction):** `attachRenderer` now reclaims a WebGL
  context from a HIDDEN pane when the per-document ceiling is full and a visible
  pane wants one, instead of the order-determined skip-on-ceiling. The acquire
  body was factored into a local `acquireWebgl()` closure so the budget-exhausted
  re-entry path does NOT add a second `liveWebglContexts++` (the contract test
  pins that at one). `evictLeastRecentlyVisibleHiddenWebgl` is page-global (walks
  `deps.terminalsMap`), NEVER evicts an `isRendered` pane, routes the drop
  through `swapRenderer(candidate, false)` → the one-shot `holder.release`, and
  leaves the evicted pane a `rendererDeferred` debt so
  `reconcileRendererForVisibility` retries it when it next becomes visible and
  budget has freed. A new `entry.lastVisibleAt` (stamped in `reconcile` and on
  acquire) orders hidden candidates by how long they have been hidden.
- **Proposed Change #4 (instrumentation):** a dev-only, opt-in
  `window.__sbWebglChurnProbe` (`enable`/`disable`/`reset`/`report`) counts WebGL
  acquires, releases, and per-entry ResizeObserver callbacks, filtered to
  terminal entries by construction (it counts our own `liveWebglContexts`
  acquire/release and our own per-entry observer, never the global
  `ResizeObserver` that inflated the original 33-callback figure). Off by
  default; changes no behaviour when disabled. This is the per-entry-filtered
  re-measurement the Outstanding Questions require.
- **Proposed Change #1 (re-box must not release):** IMPLEMENTED. The actual
  release path for the 9/9 churn was traced: `suspendTerminalStream`
  (`terminalViewport.js`) releases the renderer IMMEDIATELY (no 5s timer) when
  called, and the reconcile trailing loop (`terminals.js:6060`) calls it when
  `isTerminalRendered(name)` is false. During a grid reflow, a container can
  transiently measure 0x0, making `isTerminalRendered` false → immediate
  release. Box returns → `resumeTerminalStream` → acquire. Fix: a new
  `deps.isTerminalSeated(name)` predicate (true when the terminal is assigned
  to a rendered, non-status slot, regardless of box geometry) guards two sites:
  (a) `suspendTerminalStream` skips the renderer release when seated — the
  stream still suspends (socket closes, size vote withdrawn) but the renderer
  stays alive; `resumeTerminalStream`'s existing `!rendererAddon?.current`
  guard skips the re-attach, so no acquire fires on the way back either;
  (b) the per-entry ResizeObserver's unrendered branch skips `armRendererRelease`
  when seated — the `panelVisibility` hide path (which arms for ALL terminals
  regardless of seating) is the genuine-hide path and is unaffected. A
  terminal that genuinely left the fleet (unassigned, or in a status pane) is
  NOT seated, so both the immediate release and the 5s arm fire as before.
- **Proposed Change #3 (do not reflow panes nobody can see):** IMPLEMENTED.
  The per-entry ResizeObserver's rendered branch now skips `startFitLadder`
  when `fitLadderGen` has changed since the observer's last fire — meaning
  `batchFitVisiblePanes` (called after every `renderPaneGrid`) already started
  a ladder for this switch. This extends the existing `fitLadderGen` guard
  (which collapses rapid minimize/restore cycles per terminal) to also
  collapse the per-switch burst across panes, rather than adding a second
  mechanism. The `reconcileRendererForVisibility` and `ensureSizeVote` calls
  still run — only the redundant ladder is skipped. Tracked via a new
  `entry.lastObservedFitGen` field.

All `terminal-renderer-lifecycle-contract` and `status-pane-mode-contract`
source-text invariants (single increment/decrement site, release→dispose→attach
ordering, hasBox gate, canvas fallback count, onContextLoss guard, ResizeObserver
reconcile-before-ladder ordering, suspend does not dispose entry.term, single
suspend call site) were preserved; `node --check` passes on all three files.
