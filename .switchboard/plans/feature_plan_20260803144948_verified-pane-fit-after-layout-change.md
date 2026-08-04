# Verified Pane Fit After a Terminals-Panel Layout Change

## Goal

Make a layout change in the browser Terminals panel (e.g. `3x3` → `1`) **always** leave the surviving pane's terminal drawn at the pane's real size, instead of leaving it painted at its old grid-cell size with dead space around it.

### Observed problem

With several terminals open in a grid (3x3), switching the layout picker to the single-pane layout leaves the terminal rendered at its previous small size — a small block of output in the top-left of a large empty pane. The operator expects the terminal to expand immediately. **The failure is intermittent: some terminals expand correctly, some do not**, for the same action.

### Root cause

Four verified facts. The first three combine into a race whose loser never recovers; the fourth is a second, independent stranding path that no amount of DOM hygiene can close.

**1. The fit is fire-and-forget, unverified, and never retried.**

`src/webview/terminals.js:1339` — the entire post-layout-change resize path is a single `requestAnimationFrame`:

```js
function batchFitVisiblePanes() {
    requestAnimationFrame(() => {
        const slotCount = getSlotCount(effectiveLayout);
        for (let i = 0; i < slotCount; i++) {
            const name = paneAssignments[i];
            if (name) { fitAndReportSize(terminalsMap.get(name)); }
        }
    });
}
```

`fitAndReportSize` (`terminals.js:119`) wraps the work in `try { … } catch { /* ignore */ }`. Nothing checks whether the fit took effect, and nothing schedules a second attempt. `setLayoutMode` (`terminals.js:1013`) → `applyLayoutFloor` (`terminals.js:1322`) → this one frame is the only chance the layout change gets.

**2. `FitAddon.fit()` is a silent no-op, and — critically — self-disarming.**

From the vendored addon (`src/webview/vendor/xterm/addon-fit.js`, de-minified):

```js
fit() {
    const dims = this.proposeDimensions();
    if (!dims || !this._terminal || isNaN(dims.cols) || isNaN(dims.rows)) return;
    const core = this._terminal._core;
    if (this._terminal.rows === dims.rows && this._terminal.cols === dims.cols) return; // <-- short-circuit
    core._renderService.clear();
    this._terminal.resize(dims.cols, dims.rows);
}

proposeDimensions() {
    if (!this._terminal.element || !this._terminal.element.parentElement) return;   // detached -> undefined
    const d = core._renderService.dimensions;
    if (d.css.cell.width === 0 || d.css.cell.height === 0) return;                  // unmeasured -> undefined
    const parentStyle = getComputedStyle(this._terminal.element.parentElement);
    const h = parseInt(parentStyle.getPropertyValue('height'));                     // 'auto' -> NaN
    …
}
```

Once `term.cols`/`term.rows` have been updated to the new values, **every subsequent `fit()` returns at the short-circuit and can never repair anything**. The xterm *buffer* is the correct size while the *renderer* is still painting the old one, and no later fit — from the layout picker, from the per-container `ResizeObserver` at `terminals.js:1905`, from anywhere — will call `term.resize()` again. That is precisely why the bad state is sticky rather than self-healing on the next event.

(`this._terminal.element.parentElement` is `entry.container`, the `.terminal-view-host`: `materializeTerminalView` calls `term.open(container)` at `terminals.js:1898`.)

**3. xterm's `RenderService` pauses on non-intersection and parks both the renderer resize and the repaint.**

From `src/webview/vendor/xterm/xterm.js` (de-minified):

```js
handleResize(cols, rows) {
    if (!this._renderer.value) return;                                   // <-- see fact 4
    if (this._isPaused) { this._pausedResizeTask.set(() => this._renderer.value?.handleResize(cols, rows)); }
    else                { this._renderer.value.handleResize(cols, rows); }
    this._fullRefresh();
}
_fullRefresh()      { if (this._isPaused) { this._needsFullRefresh = true; } else { this.refreshRows(0, this._rowCount - 1); } }
refreshRows(s, e, r){ if (this._isPaused) { this._needsFullRefresh = true; } else { … this._renderDebouncer.refresh(…); } }

_handleIntersectionChange(entry) {                       // entry = entries[entries.length - 1] — LAST record only
    this._isPaused = entry.isIntersecting === undefined ? entry.intersectionRatio === 0 : !entry.isIntersecting;
    if (!this._isPaused && !this._charSizeService.hasValidSize) { this._charSizeService.measure(); }
    if (!this._isPaused && this._needsFullRefresh) {
        this._pausedResizeTask.flush();
        this.refreshRows(0, this._rowCount - 1);
        this._needsFullRefresh = false;
    }
}
```

`_isPaused` is written **only** from the `IntersectionObserver` callback, and the parked resize lives in a `DebouncedIdleTask` (a `requestIdleCallback`-backed queue). `renderPaneGrid` (`terminals.js:1162`) opens every render with `paneGridEl.innerHTML = ''`, which detaches every live xterm element before re-appending the surviving one — so every layout change churns the intersection state of every terminal in the grid. Whether `_isPaused` is `true` at the instant the rAF fit calls `term.resize()`, and whether a later intersection record with `isIntersecting: true` arrives to flush `_pausedResizeTask` + clear `_needsFullRefresh`, is a genuine timing race between IntersectionObserver batch delivery and `requestAnimationFrame`. `rAF` callbacks run **before** the frame's intersection computation, and coalesced records are read last-only, so the interleaving legitimately varies from pane to pane and run to run.

**Fact 2 is what turns fact 3's lost race into a permanent state.** A pane that loses the race has the right `cols`/`rows` and the wrong canvas, and `fit()` will never touch it again. Fact 1 means nothing notices.

**4. `RenderService.handleResize` drops the resize outright when no renderer is installed.**

Look again at the first line: `if (!this._renderer.value) return;`. Not paused — **dropped**. No `_pausedResizeTask` is set, `_fullRefresh()` is never reached, so `_needsFullRefresh` stays false and the next intersection change has nothing to flush. Meanwhile `term.resize()` has already committed the new `cols`/`rows` to the buffer, so `FitAddon.fit()` short-circuits from that moment on. That is a *permanent* strand reached without any DOM churn at all.

`_renderer` is a `MutableDisposable`; `hasRenderer()` reads `!!this._renderer.value`. The window where it is unset is narrow but real, and this panel deliberately creates it: `attachRenderer`'s WebGL `onContextLoss` handler (`terminals.js:182-188`) disposes the WebGL addon and attaches the canvas renderer in its place.

**This is the fact that justifies the present plan independent of its sibling.** Removing `renderPaneGrid`'s DOM churn (the sibling subtask) closes fact 3's race. It cannot close fact 4. Only a verify-and-repair pass at the fit layer can.

*Confidence note, stated plainly:* facts 1, 2 and 4 are read directly off the source and are certain. Fact 3 is the *class* of race, and the source supports it — but the exact interleaving that leaves a pane permanently stranded rather than recovering on the next intersection batch has not been pinned. The diagnostic added by change 4 below exists precisely to name it from a live failure, and the remedy is correct for every interleaving in the class either way.

### Scope of this plan

This plan fixes the symptom deterministically at the fit layer: a **settle → fit → verify → resync → bounded retry** path that cannot be beaten by the intersection race, plus a diagnostic that distinguishes a client-side render failure from a pty-side size failure. Removing the DOM churn that creates the race in the first place is a separate, independently shippable change (`renderPaneGrid` in-place reconciliation) and is deliberately **not** in scope here — this plan must stand alone and must keep working even if `renderPaneGrid` is never touched.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, bugfix, reliability

## User Review Required

**Yes — one decision.** This plan uses private xterm internals in two places, both on `term._core._renderService`: reading `.dimensions.css` to learn what grid the *renderer* last painted, and calling `.handleResize(cols, rows)` to repair it. There is no public substitute for either — see the Superseded callouts under *Proposed Changes §1* for why the public-API alternatives (a pixel-tolerance comparison of the `.xterm-screen` box, and a buffer-touching rows round-trip) were both rejected. Research confirms the surface is shape-stable from 5.1.0 through 6.0.0 and that upgrading the dependency would not remove the need for it. Mitigations: every access is wrapped, any failure degrades to "cannot tell → retry" rather than a false pass, the repair is unreachable whenever the detector is unreadable, and both are pinned by contract assertions. The rest of the plan is a bounded retry loop and a `console.warn`, with no user-visible behaviour change beyond the bug being fixed.

## Complexity Audit

### Routine
- Adding a bounded retry loop around an existing helper.
- Adding a `console.warn` diagnostic on give-up.
- Adding a contract test that asserts the source shape of the new helpers.

### Complex / Risky
- **Reaching for a renderer resync at all.** The clean public surface (`term.refresh`, `term.clearTextureAtlas`) is itself `_isPaused`-gated — `Terminal.refresh` → `_core.refresh` → `_renderService.refreshRows`, and `Terminal.clearTextureAtlas` → `_renderService.clearTextureAtlas` → `_fullRefresh()`, both verified in the vendored source — so the repaint half of the remedy can be swallowed by the same state it is meant to escape. The remedy therefore has to be ordered: non-destructive attempt first, buffer-touching nudge only as a last resort.
- **Detecting a stale canvas at all.** There is no public API that reports what grid the renderer last painted. The only precise signal is the renderer's own `dimensions` object. See *User Review Required*.
- **Driving `RenderService.handleResize` directly.** `FitAddon.fit()` refuses to resize when cols/rows already match, and research confirms no xterm release through 6.0.0 exposes a public force-resize. Calling `_renderService.handleResize(cols, rows)` is the repair; it re-runs `renderer._updateDimensions()` and only *reads* the buffer, so `ybase` cannot move. It is still gated behind a verified `stale-canvas` — a repair that runs on every layout change is a repair nobody can reason about. (Safe on one further axis: `terminals.js` registers no `term.onResize` handler, so nothing here emits to the pty.)
- **Retry budget vs the shared pty.** Each call to `fitAndReportSize` ends in a `{t:'resize', rendered:true}` frame — *unconditionally*, even when `fit()` short-circuited and changed nothing — and `terminalWsGateway.reconcileTerminalSize` (`src/standalone/terminalWsGateway.ts:738`) takes the **min** across attached clients. A retry loop that calls `fitAndReportSize` speculatively would flap the shared pty at a stale size. Only a verified buffer mismatch may reach it.
- **`requestAnimationFrame` starvation.** A backgrounded browser tab stops firing rAF entirely. The retry ladder must not be rAF-only, or a layout change made just before the tab is hidden never completes.
- **Contract-test span arithmetic.** These suites slice `terminals.js` between literal markers. Declaration order is therefore part of the change, not an afterthought — a helper declared on the wrong side of an anchor silently inverts a slice into an empty string, and an empty string satisfies every negative assertion.

## Edge-Case & Dependency Audit

### Race Conditions
- **Layout changed again while a ladder is in flight.** The in-flight ladder must be cancelled/superseded, not run to completion against a stale target. One ladder per terminal name at a time; a new request replaces the old, via a generation counter.
- **Floor demotion re-renders mid-ladder** (`applyLayoutFloor` → `renderPaneGrid`, `terminals.js:1331`). Same supersede rule. The ladder re-reads `paneAssignments`/`effectiveLayout` on each attempt rather than closing over them.
- **Terminal disposed mid-ladder** (`destroyTerminalView`, 15 s detach grace, `DETACH_GRACE_MS` at `terminals.js:135`). `entry.disposed` check at the top of every attempt; abort silently. The generation entry is deleted in `destroyTerminalView` so pending timers no-op immediately.
- **Renderer swap in flight** (WebGL context loss → canvas, `terminals.js:182-188`). `_renderer.value` is unset, so the renderer's `dimensions` are unreadable. Treat as "not settled yet" → retry; never as converged.

### Security
- None. No new input surface, no new network call. The only new outbound traffic is the *same* `{t:'resize'}` frame the panel already sends, and strictly fewer of them than a naive retry loop would produce.

### Side Effects
- **`console.warn` on give-up.** Deliberate and load-bearing: the verdict string is the only way to learn which half failed in the field.
- **The rows round-trip can shift `ybase`.** Gated behind a verified `stale-canvas`, which cannot occur on a healthy pane.

### Dependencies & Conflicts

| Case | Required behaviour |
| :--- | :--- |
| Pane's terminal not yet materialized (`entry.term === null`, deferred by `whenRendered`, `terminals.js:1857`) | Not a failure. Skip silently — `materializeTerminalView` fits on construction and `ws.onopen` reports the size. Must not count against the retry budget or emit a warning. |
| DOM renderer active (no WebGL, no canvas — `attachRenderer` returned a null addon, `terminals.js:174`) | Not special. The DOM renderer sets `screenElement.style.width/height` from `dimensions.css.canvas` exactly as the canvas and WebGL renderers do (verified in all three vendored bundles), so the same verification applies. |
| Renderer's `dimensions` unreadable (mid-swap, or the private path is gone after a dependency bump) | Return `unsettled` → retry, then warn on give-up. **Never** silently report `ok`; a false `ok` reintroduces the original bug with extra steps. |
| `proposeDimensions()` returns `undefined` (detached container, unmeasured cell size, `height: auto`) | Treat as "not settled yet" → retry. Do **not** call `fitAndReportSize`: a fit cannot help when the geometry is unmeasurable, and the report would push a stale size to the shared pty. |
| Container is `display: none` (`.terminal-view-host` without `.active`, `terminals.html:359`) | `isRendered()` already returns false. Abort the ladder for that entry with no warning; the pane is not on screen. |
| Whole panel iframe hidden (`shell.js` mounts every panel with `display:none`) | Same as above — the `isRendered()` gate must stay ahead of every fit, so a hidden panel never reports a size to the shared pty. This is the invariant the `rendered: true` flag exists to protect (`terminalWsGateway.ts:717-719`). |
| Terminal parked beyond the rendered slot count | `paneAssignments` is padded to `getMaxSlotCount()` — nine — regardless of layout (`sanitizePaneAssignments`, `terminals.js:643`), so `.includes(name)` is **not** a rendered-ness test. The ladder must gate on `paneAssignments.slice(0, getSlotCount(effectiveLayout))`. |
| Solo pop-out window (`?solo=`) | Uses the same fit path with a single pane. The ladder must work there too, and `saveSetting` is already a no-op in solo mode (`terminals.js:499`) so no persistence side effects. |
| Backgrounded tab (rAF paused) | The ladder's later attempts use `setTimeout`, not rAF, so it completes when the tab returns. |
| Two clients on one terminal (pop-out + grid pane) | Only a verified mismatch reports a size; the gateway's min rule then applies as designed. No change to that contract. |
| Converged on attempt 1 (the common case) | Exactly one `{t:'resize'}` frame, one `fit()`, no nudge, no warning. Must not regress the current happy path's cost. |

## Dependencies

- **Sibling subtask — *Reconcile the Terminals Pane Grid In Place Instead of Rebuilding It*.** Ships **after** this one. It rewrites `renderPaneGrid` and adds three helpers between `renderPaneGrid` and `resolveFlooredLayout`; this plan rewrites `batchFitVisiblePanes` and adds its helpers between `applyLayoutFloor` and `const DEFAULT_ROLES`. The edit regions are disjoint and neither plan's contract-test spans overlap the other's. Once the sibling lands, this plan's `stale-canvas` verdict should become rare — which is the point, and is exactly what the diagnostic will show.
- **In-flight feature — *Multi-Parent Workspace Terminals*** (`.switchboard/features/multi-parent-workspace-terminals-*.md`, subtasks at INTERN CODED). Its work is **uncommitted in the working tree right now**: 754 changed lines in `src/webview/terminals.js`. Every line number in this plan is anchored to that working tree, **not** to `HEAD` — the same functions sit roughly 110 lines earlier at `HEAD`. Rebase first; locate by function name, not by line.
- `src/webview/vendor/xterm/addon-fit.js` — `fit()` / `proposeDimensions()` semantics quoted above.
- `src/webview/vendor/xterm/xterm.js` — `RenderService` pause/park/drop semantics; `Terminal.refresh()` and `Terminal.clearTextureAtlas()` are public and both route through `_renderService`; `RenderService.get dimensions()` returns the live renderer's own `dimensions` object.
- `src/webview/vendor/xterm/addon-webgl.js`, `addon-canvas.js` — both set `screenElement.style.width/height` from `dimensions.css.canvas` inside `handleResize`, the call `RenderService` parks.
- **All five vendor files are generated and gitignored.** `scripts/sync-webview-vendor.js` copies them out of `node_modules` on every `npm run compile` / `npm run package`. `package.json` pins `@xterm/xterm ^5.5.0` (installed: 5.5.0). Read them there; never edit them; treat the caret range as a live risk to the private-API read.
- `src/standalone/terminalWsGateway.ts` — `applyResize` (`:726`) / `reconcileTerminalSize` (`:738`); the `rendered` flag contract.
- `src/webview/terminals.html` — `.terminal-view-host` (`:359`, `position:absolute; inset:0; padding:8px; display:none` / `.active { display:block }`) and the `.pane-grid.layout-*` grid templates.

## Adversarial Synthesis

**Risk summary.** Three risks dominate. (1) Detecting a stale canvas: the drafted pixel-tolerance heuristic (`hostRect.width - screenRect.width > cellW + 24`) is smaller than the real baseline gap (16 px of host padding plus a ~15 px scrollbar plus up to one cell of remainder), so it would have fired *false* stale verdicts on healthy panes and run the repair on every layout change — replaced with an exact rendered-grid comparison. (2) Reporting to the shared pty: `fitAndReportSize` sends a frame unconditionally, so calling it on an `unsettled` verdict pushes a stale size into the gateway's min rule — the ladder now calls it only on a verified buffer mismatch. (3) The contract test's own span arithmetic, which in the draft inverted two slices into empty strings and would have passed vacuously — fixed by pinning declaration order and asserting forward-only spans. The `ybase`-shift risk that previously ranked alongside these is **retired**: the buffer-touching rows round-trip has been replaced by a direct `_renderService.handleResize`, which only reads the buffer. What remains in its place is private-API exposure, bounded by the fact that the detector already requires the same path and every access degrades to "retry" rather than a false pass.

## Proposed Changes

> **Line numbers throughout are anchored to the current working tree**, not to `HEAD`. Locate by function name.

### 1. `src/webview/terminals.js` — replace `batchFitVisiblePanes` with a verified settle ladder

Keep the existing name and every call site (`applyLayoutFloor`, `assignToFocusedPane`, `undoLastAssignment`, `fillEmptyPanes`) so the change is contained to this one function plus its helpers.

**Declaration order is part of the contract.** Declare, in this order, in the gap between `applyLayoutFloor` (`terminals.js:1322`) and `const DEFAULT_ROLES` (`terminals.js:1351`):

`FIT_SETTLE_DELAYS_MS` → `fitLadderGen` → `readRenderedGrid` → `inspectPaneFit` → `resyncPaneRenderer` → `startFitLadder` → `batchFitVisiblePanes`

`batchFitVisiblePanes` goes **last**, immediately before `const DEFAULT_ROLES`, so every contract-test span is forward-only and non-overlapping.

```js
    /** Attempt schedule for the settle ladder, in ms after the layout mutation.
     *  Attempt 0 is a double rAF (style+layout flushed AND the frame's
     *  IntersectionObserver records delivered); the rest are timers so a
     *  backgrounded tab — where rAF never fires — still converges. */
    const FIT_SETTLE_DELAYS_MS = [0, 60, 180, 420];

    /** name -> generation counter. A newer ladder for the same terminal wins. */
    const fitLadderGen = new Map();

    /**
     * The grid the RENDERER last painted, as distinct from the grid the buffer holds.
     *
     * There is no public API for this, and the distinction is the entire bug: once
     * term.cols/rows are correct, FitAddon.fit() short-circuits forever (addon-fit.js)
     * and a renderer left painting the old grid can never be repaired by fitting.
     *
     * RenderService.dimensions returns the live renderer's own dimensions object, and
     * every renderer we ship — DOM, canvas and WebGL — computes
     * `device.canvas.width = device.cell.width * bufferService.cols` inside
     * _updateDimensions(), which runs from renderer.handleResize() — the exact call
     * RenderService PARKS while paused. So css.canvas / css.cell is the applied grid.
     *
     * Returns:
     *   { cols, rows }   the grid currently painted
     *   'swapping'       no renderer installed (WebGL context loss -> canvas, see
     *                    attachRenderer). RenderService.handleResize DROPS a resize
     *                    outright in this window — it does not even park it — so this
     *                    is a retry signal, never a pass.
     *   null             cannot tell (private shape changed, cell size unmeasured).
     *                    Also a retry signal. Never treat as converged.
     */
    function readRenderedGrid(term) {
        let svc = null;
        try { svc = term._core._renderService; } catch { /* ignore */ }
        if (!svc) { return null; }
        if (typeof svc.hasRenderer === 'function' && !svc.hasRenderer()) { return 'swapping'; }

        let css = null;
        try { css = svc.dimensions.css; } catch { /* ignore */ }
        if (!css || !css.cell || !css.canvas) { return null; }
        const cellW = css.cell.width;
        const cellH = css.cell.height;
        if (!(cellW > 0) || !(cellH > 0)) { return null; }
        return {
            cols: Math.round(css.canvas.width / cellW),
            rows: Math.round(css.canvas.height / cellH)
        };
    }

    /**
     * Verdict on whether `entry` is drawn at the size its host box implies.
     *
     * Two independent checks, because a pane can fail either half:
     *  - buffer:   term.cols/rows must equal what FitAddon would propose now.
     *  - renderer: the painted grid must equal the buffer grid. This is the half
     *              FitAddon cannot see and cannot repair.
     *
     * 'unsettled' means the geometry is not measurable yet — a retry signal, NOT a
     * failure, and NOT a reason to fit (see the fitAndReportSize note below).
     */
    function inspectPaneFit(entry) {
        if (!entry || entry.disposed || !entry.term || !entry.fitAddon) { return 'skip'; }
        if (!isRendered(entry.container)) { return 'skip'; }

        let proposed = null;
        try { proposed = entry.fitAddon.proposeDimensions(); } catch { /* ignore */ }
        if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
            return 'unsettled';
        }
        if (entry.term.cols !== proposed.cols || entry.term.rows !== proposed.rows) {
            return 'mismatch';
        }

        const painted = readRenderedGrid(entry.term);
        if (painted === null || painted === 'swapping') { return 'unsettled'; }
        if (painted.cols !== entry.term.cols || painted.rows !== entry.term.rows) {
            return 'stale-canvas';
        }
        return 'ok';
    }
```

> **Superseded:** Detect a stale canvas by measuring the `.xterm-screen` element against the host box and allowing a pixel tolerance — `slackW = cellW + 24`, flag stale when `hostRect.width - screenRect.width > slackW`.
> **Reason:** The tolerance is smaller than the *healthy* baseline gap, so it would fire on correctly-fitted panes. `.terminal-view-host` carries `padding: 8px` (16 px per axis, `terminals.html:359`); `proposeDimensions()` additionally subtracts `viewport.scrollBarWidth` (~15 px) before flooring; and flooring leaves up to one cell of remainder. Baseline gap is therefore ≈ `16 + 15 + remainder`, which routinely exceeds `cellW + 24` at a typical ~8 px cell width. Every layout change would have been judged `stale-canvas` and every one would have run the buffer-touching rows round-trip — the one operation the plan's own Complexity Audit says must never run speculatively.
> **Replaced with:** An exact comparison of the *painted* grid against the *buffer* grid, via `readRenderedGrid`. No pixel tolerance, no padding or scrollbar confound, and it measures the actual quantity in question. The cost is a scoped read of `term._core._renderService` — flagged for user review, wrapped so any failure degrades to "retry", and pinned by a contract assertion.

```js
    /**
     * Force the renderer back in sync WITHOUT touching the buffer and WITHOUT
     * reporting anything to the pty.
     *
     * Ordered least-invasive first:
     *  1. Read the host box. Cheap, but it forces a style/layout flush, which is
     *     what lets the next IntersectionObserver computation see real geometry
     *     and unpause RenderService (_isPaused is only ever written from that
     *     callback — see xterm.js _handleIntersectionChange).
     *  2. clearTextureAtlas() + refresh(). Non-destructive repaint request. Both
     *     route through _renderService and are no-ops while paused, which is
     *     exactly why step 3 exists.
     *  3. Drive RenderService.handleResize directly with the CURRENT cols/rows.
     *     This is the one call that re-runs renderer._updateDimensions() and so
     *     re-sizes the canvas and .xterm-screen; FitAddon.fit() refuses to reach
     *     it once cols/rows already match. It reads the buffer and never writes
     *     it, so ybase cannot move. While paused it parks the task instead — which
     *     is fine, because the ladder retries and an unpause flushes it.
     *     No new private surface: readRenderedGrid already had to reach
     *     _core._renderService to produce the 'stale-canvas' verdict that gates
     *     this, so the two stand or fall together.
     */
    function resyncPaneRenderer(entry, verdict) {
        try { void entry.container.getBoundingClientRect(); } catch { /* ignore */ }
        try { entry.term.clearTextureAtlas(); } catch { /* ignore */ }
        try { entry.term.refresh(0, Math.max(0, entry.term.rows - 1)); } catch { /* ignore */ }
        if (verdict !== 'stale-canvas') { return; }
        try {
            entry.term._core._renderService.handleResize(entry.term.cols, entry.term.rows);
        } catch { /* ignore */ }
    }

    function startFitLadder(name) {
        const gen = (fitLadderGen.get(name) || 0) + 1;
        fitLadderGen.set(name, gen);

        const attempt = (step) => {
            // Superseded by a newer layout change / assignment for this terminal.
            if (fitLadderGen.get(name) !== gen) { return; }
            const entry = terminalsMap.get(name);
            if (!entry || entry.disposed) { return; }
            // Re-read the assignment each attempt rather than closing over it: a floor
            // demotion or a reassignment may have moved this terminal out. The SLICE is
            // load-bearing — paneAssignments is padded to nine regardless of layout, so
            // a bare .includes() would also match a terminal parked off-screen.
            if (!paneAssignments.slice(0, getSlotCount(effectiveLayout)).includes(name)) { return; }

            const before = inspectPaneFit(entry);
            if (before === 'skip') { return; }
            // ONLY on a verified buffer mismatch. fitAndReportSize sends a resize frame
            // unconditionally — even when fit() short-circuits and changes nothing — and
            // reconcileTerminalSize takes the MIN across attached clients, so firing it
            // on an 'unsettled' verdict would push a stale size into the shared pty.
            if (before === 'mismatch') {
                fitAndReportSize(entry);
            }

            const after = inspectPaneFit(entry);
            if (after === 'ok' || after === 'skip') { return; }
            if (after === 'stale-canvas' || after === 'mismatch') {
                resyncPaneRenderer(entry, after);
            }

            const next = step + 1;
            if (next >= FIT_SETTLE_DELAYS_MS.length) {
                console.warn(
                    `[Terminals] Pane fit did not converge for ${name} after ` +
                    `${FIT_SETTLE_DELAYS_MS.length} attempts (verdict=${after}, ` +
                    `client=${entry.term.cols}x${entry.term.rows}) — ` +
                    `resize the window to force a re-fit.`
                );
                return;
            }
            schedule(next);
        };

        // Attempt 0 is a DOUBLE rAF: the first lands after the grid mutation, the
        // second one frame later — i.e. after the first frame's style/layout and
        // IntersectionObserver delivery. Later attempts are timers so a backgrounded
        // tab (rAF suspended) still converges when it is brought forward.
        const schedule = (step) => {
            const delay = FIT_SETTLE_DELAYS_MS[step];
            if (delay === 0) {
                requestAnimationFrame(() => requestAnimationFrame(() => attempt(step)));
            } else {
                setTimeout(() => attempt(step), delay);
            }
        };
        schedule(0);
    }

    /**
     * Fit the panes the current layout renders, then VERIFY and retry.
     *
     * The old body was a single requestAnimationFrame around fitAndReportSize.
     * One frame is not enough: renderPaneGrid detaches and re-appends every live
     * xterm, xterm's RenderService parks renderer resizes while its
     * IntersectionObserver says the screen element is not intersecting (and DROPS
     * them outright while no renderer is installed at all), and rAF runs BEFORE
     * that frame's intersection records are delivered. A pane that lost that race
     * kept the right cols/rows and the wrong canvas — and FitAddon.fit()
     * short-circuits on matching cols/rows, so no later fit from any call site
     * could ever repair it. Hence: verify, resync, retry.
     */
    function batchFitVisiblePanes() {
        const slotCount = getSlotCount(effectiveLayout);
        for (let i = 0; i < slotCount; i++) {
            const name = paneAssignments[i];
            if (name) { startFitLadder(name); }
        }
    }
```

> **Superseded:** The stale-canvas repair is a rows round-trip — `entry.term.resize(cols, rows - 1)` followed by `entry.term.resize(cols, rows)` — described as "the ONLY public call that reliably drives `RenderService.handleResize`", accepted as buffer-touching and gated behind a verified mismatch to contain the `ybase` risk.
> **Reason:** External research (see *Resolved Assumptions*) confirms there is no public force-resize API in any xterm release through 6.0.0 — but `RenderService.handleResize(cols, rows)` can simply be called directly, and it re-runs `renderer._updateDimensions()` (which re-sizes the canvas and `.xterm-screen`) while only *reading* `_bufferService.cols/rows`. The buffer is never written, so `ybase` cannot shift and no scrollback can be clipped. Crucially this adds **no new private surface**: `readRenderedGrid` already reaches `_core._renderService` to produce the `stale-canvas` verdict that gates this branch, so if that path is unavailable the branch is unreachable anyway. The round-trip's sole advantage was being public API, and that advantage does not exist once the detector is already private.
> **Replaced with:** `entry.term._core._renderService.handleResize(entry.term.cols, entry.term.rows)`. This removes the single riskiest operation in the plan — the one the Complexity Audit flagged hardest — at zero cost.

> **Superseded:** `if (before === 'mismatch' || before === 'unsettled') { fitAndReportSize(entry); }`
> **Reason:** On `unsettled`, `proposeDimensions()` returned `undefined` — the geometry is unmeasurable, so `fit()` provably cannot help. But `fitAndReportSize` sends its `{t:'resize', cols, rows, rendered:true}` frame regardless of whether `fit()` did anything (`terminals.js:122-131`), so this pushed the *stale* size into `reconcileTerminalSize`'s min across clients. With a pop-out attached, that is the shared-pty flap the plan's own Complexity Audit forbids.
> **Replaced with:** `if (before === 'mismatch') { fitAndReportSize(entry); }`. An `unsettled` verdict simply falls through to the retry. Nothing is lost: when the geometry becomes measurable the verdict resolves to `mismatch` or `ok`, and `mismatch` reports.

Notes on why this is contained:
- `fitAndReportSize` is unchanged, so the `isRendered` gate and the `rendered: true` contract with the gateway are untouched.
- The pty only ever hears about a size from `fitAndReportSize`, and the ladder calls it only when the buffer is actually wrong. `resyncPaneRenderer` deliberately sends nothing. So a 4-attempt ladder still produces at most one pty resize frame per layout change.
- Every existing call site keeps calling `batchFitVisiblePanes()`; no signature change.

### 2. `src/webview/terminals.js` — cancel a stale ladder when the view goes away

In `destroyTerminalView` (`terminals.js:1762`), alongside the existing observer/timer teardown:

```js
        // A ladder still stepping for this name would re-fit a disposed entry (it
        // guards on entry.disposed, but bumping the generation stops the timers
        // from doing anything at all).
        fitLadderGen.delete(name);
```

Note `destroyTerminalView` is also reached from `renameTerminal` (`terminals.js:1638`), which is the case that matters most: the old name's ladder must not keep stepping against a name that no longer exists.

### 3. `src/webview/terminals.js` — let the per-container ResizeObserver use the ladder

The observer installed in `materializeTerminalView` (`terminals.js:1904-1917`) currently calls `fitAndReportSize` directly, which inherits the same unverified, one-shot weakness. Route it through the ladder so a window drag that lands a pane in a new box also self-verifies:

```js
        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // `active` is pane ASSIGNMENT, not visibility — a hidden panel's panes
                // are still "active". inspectPaneFit/fitAndReportSize gate on actually
                // having a box.
                if (entry.container.classList.contains('active')) {
                    startFitLadder(entry.name);
                }
            }, 100);
        });
```

This also means the generation counter naturally coalesces an observer-driven fit with a picker-driven one — the newer request supersedes the older, instead of two independent ladders fighting.

### 4. `src/test/terminal-pane-fit-verification-contract.test.js` — new contract test

> **Superseded:** A Jest test file using `describe` / `it` / `expect`, verified with `npx jest … --forceExit`.
> **Reason:** **There is no Jest in this repository.** It is absent from `dependencies` and `devDependencies`, there is no `jest.config.*`, and `node_modules/.bin/jest` does not exist. Every contract suite here is a plain Node script that defines its own `test()` helper over `require('assert')`, is registered as a `test:contract:*` npm script, and is invoked from `.github/workflows/integration-tests.yml`. A Jest-syntax file would silently never run.
> **Reason (second defect, independent of the harness):** the drafted spans were arithmetically broken. `SRC.slice(indexOf('function startFitLadder'), indexOf('function batchFitVisiblePanes'))` inverts to an **empty string** whenever `startFitLadder` is declared after `batchFitVisiblePanes` — and an empty string satisfies every `not.toContain` assertion, so the test would have passed while checking nothing. The `batchFitVisiblePanes → const DEFAULT_ROLES` span had the mirror problem: it swallowed `startFitLadder`, so `expect(body).not.toContain('requestAnimationFrame')` would have failed against correct code.
> **Replaced with:** A plain-Node contract in the house style, with declaration order pinned (see §1) so every span is forward-only, plus the npm-script and CI wiring the convention requires.

```js
'use strict';

/**
 * Contract: the Terminals pane fit VERIFIES itself and retries.
 *
 * Source-text contract, not behavioural: the panel is a browser-only IIFE with no
 * export surface, and "the canvas is painting the old grid" is not observable from
 * Node. What CAN be pinned is the handful of decisions that are invisible on
 * inspection and each of which was wrong in a first pass.
 *
 * DECLARATION ORDER IS PART OF THE CONTRACT. The spans below are forward-only and
 * non-overlapping only if terminals.js declares, in this order:
 *   readRenderedGrid -> inspectPaneFit -> resyncPaneRenderer -> startFitLadder
 *   -> batchFitVisiblePanes -> const DEFAULT_ROLES
 * An inverted slice yields '' — which silently satisfies every negative assertion.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

function block(startMarker, endMarker) {
    const start = SRC.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = SRC.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found AFTER "${startMarker}": ${endMarker}`);
    assert.ok(end > start, `span is inverted — check declaration order: ${startMarker}`);
    return SRC.substring(start, end);
}

test('declaration order keeps every contract span forward-only', () => {
    const order = [
        'function readRenderedGrid(',
        'function inspectPaneFit(',
        'function resyncPaneRenderer(',
        'function startFitLadder(',
        'function batchFitVisiblePanes(',
        'const DEFAULT_ROLES'
    ].map(m => [m, SRC.indexOf(m)]);
    for (const [marker, at] of order) {
        assert.ok(at !== -1, `missing declaration: ${marker}`);
    }
    for (let i = 1; i < order.length; i++) {
        assert.ok(
            order[i][1] > order[i - 1][1],
            `${order[i][0]} must be declared after ${order[i - 1][0]}`
        );
    }
});

test('the fit is verified, not fired once and forgotten', () => {
    const batch = block('function batchFitVisiblePanes(', 'const DEFAULT_ROLES');
    assert.ok(batch.includes('startFitLadder'), 'batchFitVisiblePanes must drive the ladder');
    // The old body was a bare requestAnimationFrame around fitAndReportSize.
    assert.ok(!batch.includes('requestAnimationFrame'), 'the single-rAF body must be gone');
    assert.ok(!batch.includes('fitAndReportSize'), 'batchFitVisiblePanes must not fit directly');
});

test('a stale RENDERER is detected, not just a stale buffer', () => {
    assert.ok(SRC.includes('function readRenderedGrid('), 'the painted grid must be readable');
    assert.ok(SRC.includes("'stale-canvas'"), 'the stale-canvas verdict must exist');
    const inspect = block('function inspectPaneFit(', 'function resyncPaneRenderer(');
    assert.ok(inspect.includes('readRenderedGrid'), 'the verdict must consult the painted grid');
    assert.ok(inspect.includes('proposeDimensions'), 'the verdict must also check the buffer half');
});

test('an unreadable renderer is a retry, never a pass', () => {
    const inspect = block('function inspectPaneFit(', 'function resyncPaneRenderer(');
    // A null/'swapping' read means we could not tell. Returning 'ok' there would
    // reintroduce the original bug with extra steps.
    assert.ok(
        /painted === null[\s\S]{0,80}'unsettled'/.test(inspect),
        'an unreadable painted grid must resolve to unsettled'
    );
    const read = block('function readRenderedGrid(', 'function inspectPaneFit(');
    assert.ok(read.includes('hasRenderer'), 'a renderer swap must be distinguished from a bad read');
});

test('only a VERIFIED mismatch is reported to the shared pty', () => {
    const resync = block('function resyncPaneRenderer(', 'function startFitLadder(');
    // reconcileTerminalSize takes the MIN across clients, so an intermediate size
    // would flap the shared pty. The resync sends nothing at all.
    assert.ok(!resync.includes('fitAndReportSize'), 'resyncPaneRenderer must not report a size');
    assert.ok(!resync.includes("t: 'resize'"), 'resyncPaneRenderer must not send a resize frame');

    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    assert.ok(ladder.includes('fitAndReportSize'), 'the ladder is the only reporter');
    // fitAndReportSize sends unconditionally, even when fit() short-circuits, so an
    // 'unsettled' verdict must NOT reach it.
    assert.ok(
        /before === 'mismatch'\s*\)\s*\{\s*\n\s*fitAndReportSize/.test(ladder),
        'fitAndReportSize must be gated on a verified buffer mismatch alone'
    );
});

test('the renderer repair is gated on stale-canvas alone, and never resizes the buffer', () => {
    const resync = block('function resyncPaneRenderer(', 'function startFitLadder(');
    assert.ok(
        resync.includes("verdict !== 'stale-canvas'"),
        'a repair that runs on every layout change is a repair nobody can reason about'
    );
    assert.ok(
        resync.includes('_renderService.handleResize('),
        'the repair must drive the renderer directly — fit() cannot reach it once cols/rows match'
    );
    // A rows round-trip (resize(cols, rows - 1) then back) would also drive the
    // renderer, but it WRITES the buffer and can shift ybase when the viewport is
    // pinned to the bottom. handleResize only reads it.
    assert.ok(!resync.includes('term.resize('), 'the repair must not touch the buffer');
});

test('retries run off timers as well as rAF, so a hidden tab converges', () => {
    assert.ok(SRC.includes('FIT_SETTLE_DELAYS_MS'), 'the schedule must be named and reviewable');
    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    assert.ok(ladder.includes('setTimeout'), 'a backgrounded tab fires no rAF');
    assert.ok(ladder.includes('requestAnimationFrame'), 'attempt 0 must still land on a frame');
});

test('a newer request supersedes an in-flight ladder', () => {
    assert.ok(SRC.includes('fitLadderGen'), 'ladders must be generation-tracked');
    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    assert.ok(ladder.includes('fitLadderGen.get(name) !== gen'), 'each attempt must check its generation');
    assert.ok(SRC.includes('fitLadderGen.delete(name)'), 'destroyTerminalView must drop the generation');
});

test('the ladder gates on the RENDERED slots, not the padded assignment array', () => {
    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    // paneAssignments is padded to getMaxSlotCount() (nine) regardless of layout, so a
    // bare .includes() would also match a terminal parked off-screen.
    assert.ok(
        ladder.includes('paneAssignments.slice(0, getSlotCount(effectiveLayout))'),
        'a bare includes() would fit terminals that are not on screen'
    );
});

console.log(failed === 0 ? '\nAll pane-fit verification contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
```

### 5. `package.json` — register the contract

Alongside the existing `test:contract:shell-terminal-strip` entry:

```json
"test:contract:terminal-pane-fit": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/terminal-pane-fit-verification-contract.test.js"
```

### 6. `.github/workflows/integration-tests.yml` — wire it into CI

Add a step beside the existing terminal contracts (the `test:contract:shell-terminal-strip` step is at line 283):

```yaml
      - name: Terminal pane fit verification contract
        run: npm run test:contract:terminal-pane-fit
```

## Verification Plan

> This planning pass ran **no** builds and **no** tests (session directive). Every command below is for the implementer.

**Automated**
1. `npm run test:contract:terminal-pane-fit` — the new contract passes.
2. `npm run test:contract:terminal-flow-control`, `test:contract:terminal-input-path`, `test:contract:terminal-token-transport`, `test:contract:terminal-solo-popout`, `test:contract:shell-terminal-strip` — the existing terminal contracts still pass. `shell-terminal-strip` slices `terminals.js` between literal markers (`postFleetStateToShell` → `const LAYOUTS`, `handleAgentCompleted` → `showCompletionToast`, the `focusTerminal` arm, `locateTerminal` → `assignToFocusedPane`, `setFocusedPane` → `renderPaneGrid`, `renderPaneGrid` → `resolveFlooredLayout`). **None of those spans covers this edit region** — this plan's helpers all land after `applyLayoutFloor` — so a failure here means something genuinely moved.
3. `npm run compile` — webpack, preceded by `scripts/sync-webview-vendor.js` (which also refreshes the vendored xterm bundles this plan reads). Then **sync to the installed extension folder and reload the window**: the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, so a repo-only build is not live.

**Manual — the reported repro**
4. Open the browser Terminals panel. Create 9 terminals and assign them across a `3x3` layout. Let every pane paint real output (run something with a full-screen TUI, e.g. an agent CLI, so a wrong size is unmistakable).
5. Click the single-pane layout button. **Expect:** the pane's terminal fills the pane immediately — no small block with dead space — and its content reflows to the new width.
6. Repeat step 5 ten times, cycling which terminal sits in pane 0 between runs (click a different sidebar row each time). **Expect:** 10/10 expand. Previously this was intermittent, so a single pass is not evidence — the repeat count *is* the test.
7. Walk the full ladder of layouts in both directions: `1 → 2h → 2v → 2x2 → 2x3 → 3x3 → 1`. **Expect:** every rendered pane matches its box after each step, and no pane is left blank.
8. With the panel open at `3x3`, drag the window narrow enough to trip the floor (`3x3` needs 750×450 — see `LAYOUTS`, `terminals.js:462`) so the fallback banner appears and the layout demotes. **Expect:** the demoted panes are correctly sized and the banner's appearance (which changes available height) does not leave a stale pane.
9. Switch to another panel tab and back (the iframe goes `display:none` and returns). **Expect:** panes are correctly sized on return, and `console.warn` shows no "did not converge" line.
10. Pop a terminal out into its own window (`?solo=`) while the same terminal is also in a grid pane, then change the grid layout. **Expect:** both windows stay readable; the pty settles at the min of the two, which is the designed gateway behaviour (`terminalWsGateway.ts:738`) and not a regression.

**Instrumentation check — proves which half was failing**
11. In DevTools, before step 5, capture `cols/rows` for the pane's terminal, then after the switch compare the panel's client size against the pty's idea of the size. A converged pane must agree on both. If a "did not converge" warning ever fires in steps 5–10, capture the verdict string — `stale-canvas` vs `mismatch` vs `unsettled` names the remaining failure surface precisely, which is the point of logging it.
12. **Prove the detector is not crying wolf.** With a single terminal in the `1` layout and everything healthy, evaluate `inspectPaneFit(terminalsMap.get('<name>'))` in the console (or temporarily expose it). **Expect:** `'ok'`. Repeat at `2x2` and `3x3`. A healthy pane returning `'stale-canvas'` means the exact-grid comparison is wrong and the rows round-trip is firing on every layout change — the precise failure the pixel-tolerance draft would have shipped.

13. **Prove the repair repairs.** Force a stale canvas by hand: in the console, grab a healthy pane's terminal, note `.xterm-screen`'s `style.width`, then call `term._core._renderService.handleResize(term.cols - 10, term.rows)` to desynchronise the renderer from the buffer. **Expect:** `.xterm-screen` narrows and `inspectPaneFit` now returns `'stale-canvas'`. Then trigger a layout change. **Expect:** the ladder restores `.xterm-screen` to its correct width, `inspectPaneFit` returns `'ok'`, and — the point of the change from a rows round-trip — `term.buffer.active.viewportY` and the scrollback are untouched. Scroll up before the repair and confirm the viewport does not jump.

**Negative check**
14. Confirm the happy path did not get more expensive: with a single terminal in the `1` layout, switch to `2h` and back while watching the WebSocket frames in DevTools. **Expect:** at most one `{t:'resize', rendered:true}` frame per terminal per layout change — not one per ladder attempt, and none at all when the buffer was already correct.
15. **Cross-engine sanity.** Repeat step 6 in Firefox. Per *Resolved Assumptions*, Gecko may defer IntersectionObserver delivery a frame under load, so attempt 0 can legitimately miss there. **Expect:** panes still converge (via the 60 ms attempt) and no "did not converge" warning fires. An attempt-0 miss on Firefox is expected behaviour, not a defect.

## Resolved Assumptions

External research was run and closed all three open questions. **This section is authoritative — do not re-open these during implementation.**

- **A dependency upgrade does not fix this.** Every release through 6.0.0 keeps the `IntersectionObserver`-driven `RenderService` pause with its deferred resize task and last-record-only batch read; keeps `FitAddon.fit()`'s early return on matching cols/rows, with no `force` option and no `refit()`; keeps `handleResize`'s early return when no renderer is attached; and still exposes **no public API** for driving a renderer resize without a buffer resize. No changelog entry, commit or PR in 5.6.0 or 6.0.0 touched any of it — the pause is a deliberate performance feature, not a bug awaiting a fix. Application-side verify-and-repair is therefore required, not merely expedient. Bump the dependency on its own merits if you like; it will not make this plan unnecessary.
- **The private surface is shape-stable and is the only option.** `IRenderDimensions`' nested shape (`css.cell.width/height`, `css.canvas.width/height`, with matching `device` metrics) has held from 5.1.0 through 6.0.0, and `hasRenderer()` has kept its name and signature across 5.x and 6.x. Neither `_core`, `_renderService` nor `IRenderDimensions` appears in the public `xterm.d.ts` — this is untyped internal surface, and 5.1.0 set precedent by removing the flat `actualCellWidth`/`actualCellHeight` properties with no deprecation. So the defensive wrapping stays: it is insurance against a future bump, not against today's pinned 5.5.0. Upstream corroboration for the underlying defect: xterm.js issues #3118, #3029, #2643, #4338, #4841 and #5298 all describe fits against detached, hidden or re-parented terminals producing invalid dimensions or a stale canvas, and the maintainer-endorsed workarounds are exactly the two this plan implements — never fit a detached or zero-sized element, and nudge the renderer when the proposed dimensions already match.
- **rAF-before-IntersectionObserver is normative, but delivery can still slip a frame.** The HTML Living Standard's "update the rendering" steps order `requestAnimationFrame` callbacks *before* the intersection-observation step in every compliant engine, so the double-rAF in attempt 0 is sound in principle. However, under main-thread pressure Gecko and WebKit may defer IntersectionObserver *task delivery* to the next event-loop turn, where Chromium dispatches it in microtasks before frame presentation. Practical consequence: on Firefox and Safari under load, attempt 0 can legitimately observe the stale paused state and the 60 ms timer becomes the real first chance. That is a cost, not a correctness problem — it is precisely why the ladder is not rAF-only — but do not treat an attempt-0 miss on those engines as a defect.

No further research is needed for this plan.

## Recommendation

**Complexity 6 → Send to Coder.** One function replaced plus three helpers, all inside a single browser file, with no TypeScript surface and no protocol change. The two judgement calls a Coder must not quietly re-decide are already fixed by contract assertions: `fitAndReportSize` fires only on a verified buffer mismatch, and the rows round-trip fires only on a verified `stale-canvas`.

## Completion Report

- **What was implemented:** Implemented verified pane fit settle ladder (`startFitLadder`, `inspectPaneFit`, `readRenderedGrid`, `resyncPaneRenderer`) replacing the single-rAF fire-and-forget `batchFitVisiblePanes`. Updated `materializeTerminalView` ResizeObserver and `destroyTerminalView` to manage generation tracking and retry attempts. Added comprehensive contract tests for pane fit verification.
- **Files changed:** `src/webview/terminals.js`, `src/test/terminal-pane-fit-verification-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `src/test/terminal-solo-popout-contract.test.js`.
- **Issues encountered:** Adjusted end marker for `renderSidebarList` block in `terminal-solo-popout-contract.test.js` to match the newly added helpers and structure in `terminals.js`.
