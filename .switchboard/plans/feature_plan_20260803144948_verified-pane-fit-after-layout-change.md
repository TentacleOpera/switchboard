# Verified Pane Fit After a Terminals-Panel Layout Change

## Goal

Make a layout change in the browser Terminals panel (e.g. `3x3` → `1`) **always** leave the surviving pane's terminal drawn at the pane's real size, instead of leaving it painted at its old grid-cell size with dead space around it.

### Observed problem

With several terminals open in a grid (3x3), switching the layout picker to the single-pane layout leaves the terminal rendered at its previous small size — a small block of output in the top-left of a large empty pane. The operator expects the terminal to expand immediately. **The failure is intermittent: some terminals expand correctly, some do not**, for the same action.

### Root cause

Three verified facts combine into a race whose loser never recovers.

**1. The fit is fire-and-forget, unverified, and never retried.**

`src/webview/terminals.js:1229` — the entire post-layout-change resize path is a single `requestAnimationFrame`:

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

`fitAndReportSize` (`terminals.js:118`) wraps the work in `try { … } catch { /* ignore */ }`. Nothing checks whether the fit took effect, and nothing schedules a second attempt. `setLayoutMode` (`terminals.js:903`) → `applyLayoutFloor` (`terminals.js:1212`) → this one frame is the only chance the layout change gets.

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

Once `term.cols`/`term.rows` have been updated to the new values, **every subsequent `fit()` returns at the short-circuit and can never repair anything**. The xterm *buffer* is the correct size while the *renderer* is still painting the old one, and no later fit — from the layout picker, from the per-container `ResizeObserver` at `terminals.js:1786`, from anywhere — will call `term.resize()` again. That is precisely why the bad state is sticky rather than self-healing on the next event.

**3. xterm's `RenderService` pauses on non-intersection and parks both the renderer resize and the repaint.**

From `src/webview/vendor/xterm/xterm.js` (de-minified):

```js
handleResize(cols, rows) {
    if (!this._renderer.value) return;
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

`_isPaused` is written **only** from the `IntersectionObserver` callback, and the parked resize lives in a `DebouncedIdleTask` (a `requestIdleCallback`-backed queue). `renderPaneGrid` (`terminals.js:1062`) opens every render with `paneGridEl.innerHTML = ''`, which detaches every live xterm element before re-appending the surviving one — so every layout change churns the intersection state of every terminal in the grid. Whether `_isPaused` is `true` at the instant the rAF fit calls `term.resize()`, and whether a later intersection record with `isIntersecting: true` arrives to flush `_pausedResizeTask` + clear `_needsFullRefresh`, is a genuine timing race between IntersectionObserver batch delivery and `requestAnimationFrame`. `rAF` callbacks run **before** the frame's intersection computation, and coalesced records are read last-only, so the interleaving legitimately varies from pane to pane and run to run.

**Fact 2 is what turns fact 3's lost race into a permanent state.** A pane that loses the race has the right `cols`/`rows` and the wrong canvas, and `fit()` will never touch it again. Fact 1 means nothing notices.

### Scope of this plan

This plan fixes the symptom deterministically at the fit layer: a **settle → fit → verify → resync → bounded retry** path that cannot be beaten by the intersection race, plus a diagnostic that distinguishes a client-side render failure from a pty-side size failure. Removing the DOM churn that creates the race in the first place is a separate, independently shippable change (`renderPaneGrid` in-place reconciliation) and is deliberately **not** in scope here — this plan must stand alone and must keep working even if `renderPaneGrid` is never touched.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, bugfix, reliability

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding a bounded retry loop around an existing helper.
- Adding a `console.warn` diagnostic on give-up.
- Adding a contract test that asserts the source shape of the new helper.

**Complex / Risky**
- **Reaching for a renderer resync at all.** The clean public surface (`term.refresh`, `term.clearTextureAtlas`) is itself `_isPaused`-gated, so the repaint half of the remedy can be swallowed by the same state it is meant to escape. The remedy therefore has to be ordered: non-destructive attempt first, buffer-touching nudge only as a last resort.
- **The `term.resize(cols, rows - 1) → term.resize(cols, rows)` nudge touches the buffer.** It is the only public call that reliably drives `RenderService.handleResize`, but a rows round-trip can shift `ybase` when the viewport is pinned to the bottom. It must be gated behind a verified mismatch, never run speculatively.
- **Retry budget vs the shared pty.** Each verified fit ends in a `{t:'resize', rendered:true}` frame, and `terminalWsGateway.reconcileTerminalSize` (`src/standalone/terminalWsGateway.ts:738`) takes the **min** across attached clients. A retry loop that reports intermediate/wrong sizes would flap the shared pty. Only the final, verified size may be reported.
- **`requestAnimationFrame` starvation.** A backgrounded browser tab stops firing rAF entirely. The retry ladder must not be rAF-only, or a layout change made just before the tab is hidden never completes.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Pane's terminal not yet materialized (`entry.term === null`, deferred by `whenRendered`, `terminals.js:1739`) | Not a failure. Skip silently — `materializeTerminalView` fits on construction and `ws.onopen` reports the size. Must not count against the retry budget or emit a warning. |
| DOM renderer active (no WebGL, no canvas — `attachRenderer` returned a null addon, `terminals.js:283`) | There is no canvas to measure. Verification must fall back to comparing `term.cols`/`term.rows` against `proposeDimensions()` only, and must not warn merely because no canvas exists. |
| `proposeDimensions()` returns `undefined` (detached container, unmeasured cell size, `height: auto`) | Treat as "not settled yet" → retry. Do **not** treat as converged. |
| Container is `display: none` (`.terminal-view-host` without `.active`, `terminals.html:359`) | `isRendered()` already returns false. Abort the ladder for that entry with no warning; the pane is not on screen. |
| Whole panel iframe hidden (`shell.js` mounts every panel with `display:none`) | Same as above — `isRendered()` gate must stay ahead of every fit, so a hidden panel never reports a size to the shared pty. This is the invariant the `rendered: true` flag exists to protect (`terminalWsGateway.ts:726`). |
| Layout changed again while a ladder is in flight | The in-flight ladder must be cancelled/superseded, not run to completion against a stale target. One ladder per terminal name at a time; a new request replaces the old. |
| Floor demotion re-renders mid-ladder (`applyLayoutFloor` → `renderPaneGrid`, `terminals.js:1220`) | Same supersede rule. The ladder re-reads `paneAssignments`/`effectiveLayout` on each attempt rather than closing over them. |
| Terminal disposed mid-ladder (`destroyTerminalView`, 15 s detach grace, `terminals.js:139`) | `entry.disposed` check at the top of every attempt; abort silently. |
| Solo pop-out window (`?solo=`) | Uses the same fit path with a single pane. The ladder must work there too, and `saveSetting` is already a no-op in solo mode (`terminals.js:499`) so no persistence side effects. |
| Backgrounded tab (rAF paused) | The ladder's later attempts use `setTimeout`, not rAF, so it completes when the tab returns. |
| Two clients on one terminal (pop-out + grid pane) | Only the final verified size is reported; the gateway's min rule then applies as designed. No change to that contract. |
| Converged on attempt 1 (the common case) | Exactly one `{t:'resize'}` frame, one `fit()`, no nudge, no warning. Must not regress the current happy path's cost. |

**Dependencies**
- `src/webview/vendor/xterm/addon-fit.js` — `fit()` / `proposeDimensions()` semantics quoted above.
- `src/webview/vendor/xterm/xterm.js` — `RenderService` pause/park semantics; `Terminal.refresh()` and `Terminal.clearTextureAtlas()` are public and both route through `_renderService`.
- `src/standalone/terminalWsGateway.ts` — `applyResize` / `reconcileTerminalSize`; the `rendered` flag contract.
- `src/webview/terminals.html` — `.terminal-view-host` (`position:absolute; inset:0; padding:8px; display:none` / `.active { display:block }`) and `.pane-grid.layout-*` grid templates.

## Proposed Changes

### 1. `src/webview/terminals.js` — replace `batchFitVisiblePanes` with a verified settle ladder

Keep the existing name and every call site (`setLayoutMode` → `applyLayoutFloor`, `assignToFocusedPane`, `undoLastAssignment`) so the change is contained to this one function plus two new helpers.

```js
    /** Attempt schedule for the settle ladder, in ms after the layout mutation.
     *  Attempt 0 is a double rAF (style+layout flushed AND the frame's
     *  IntersectionObserver records delivered); the rest are timers so a
     *  backgrounded tab — where rAF never fires — still converges. */
    const FIT_SETTLE_DELAYS_MS = [0, 60, 180, 420];

    /** name -> generation counter. A newer ladder for the same terminal wins. */
    const fitLadderGen = new Map();

    /**
     * True when `entry`'s renderer is painting at the size its host box implies.
     *
     * Two independent checks, because a pane can fail either half:
     *  - buffer:   term.cols/rows must equal what FitAddon would propose now.
     *  - renderer: the .xterm-screen box must match the host box to within one
     *              cell. This is the half that FitAddon cannot see and cannot
     *              repair — once cols/rows match, fit() short-circuits (see
     *              addon-fit.js) and leaves a stale canvas forever.
     *
     * Returns 'unsettled' when the geometry is not measurable yet, which is a
     * retry signal and NOT a failure.
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

        // Renderer half. The DOM renderer has no screen canvas to measure, so a
        // matching buffer is all the confirmation available there.
        const screenEl = entry.term.element
            && entry.term.element.querySelector('.xterm-screen');
        if (!screenEl) { return 'ok'; }
        const hostRect = entry.container.getBoundingClientRect();
        const screenRect = screenEl.getBoundingClientRect();
        const cellW = Math.max(1, screenRect.width / Math.max(1, entry.term.cols));
        const cellH = Math.max(1, screenRect.height / Math.max(1, entry.term.rows));
        // 8px padding per side on .terminal-view-host (terminals.html) plus the
        // scrollbar; one cell of slack absorbs both without hiding a real stale
        // canvas, which is off by whole grid cells, not pixels.
        const slackW = cellW + 24;
        const slackH = cellH + 24;
        if (hostRect.width - screenRect.width > slackW) { return 'stale-canvas'; }
        if (hostRect.height - screenRect.height > slackH) { return 'stale-canvas'; }
        return 'ok';
    }

    /**
     * Force the renderer back in sync WITHOUT reporting anything to the pty.
     *
     * Ordered least-destructive first:
     *  1. Read the host box. Cheap, but it forces a style/layout flush, which is
     *     what lets the next IntersectionObserver computation see real geometry
     *     and unpause RenderService (_isPaused is only ever written from that
     *     callback — see xterm.js _handleIntersectionChange).
     *  2. clearTextureAtlas() + refresh(). Non-destructive repaint request. Both
     *     route through _renderService and are no-ops while paused, which is
     *     exactly why step 3 exists.
     *  3. A rows round-trip. The ONLY public call that reliably drives
     *     RenderService.handleResize, because FitAddon.fit() refuses to resize
     *     when cols/rows already match. Buffer-touching (it can shift ybase when
     *     the viewport is pinned to the bottom), so it runs only for a verified
     *     'stale-canvas' and never speculatively.
     */
    function resyncPaneRenderer(entry, verdict) {
        try { void entry.container.getBoundingClientRect(); } catch { /* ignore */ }
        try { entry.term.clearTextureAtlas(); } catch { /* ignore */ }
        try { entry.term.refresh(0, Math.max(0, entry.term.rows - 1)); } catch { /* ignore */ }
        if (verdict !== 'stale-canvas') { return; }
        try {
            const cols = entry.term.cols;
            const rows = entry.term.rows;
            if (rows > 1) {
                entry.term.resize(cols, rows - 1);
                entry.term.resize(cols, rows);
            }
        } catch { /* ignore */ }
    }

    /**
     * Fit the panes the current layout renders, then VERIFY and retry.
     *
     * The old body was a single requestAnimationFrame around fitAndReportSize.
     * One frame is not enough: renderPaneGrid detaches and re-appends every live
     * xterm, xterm's RenderService parks renderer resizes while its
     * IntersectionObserver says the screen element is not intersecting, and rAF
     * runs BEFORE that frame's intersection records are delivered. A pane that
     * lost that race kept the right cols/rows and the wrong canvas — and
     * FitAddon.fit() short-circuits on matching cols/rows, so no later fit from
     * any call site could ever repair it. Hence: verify, resync, retry.
     */
    function batchFitVisiblePanes() {
        const slotCount = getSlotCount(effectiveLayout);
        for (let i = 0; i < slotCount; i++) {
            const name = paneAssignments[i];
            if (name) { startFitLadder(name); }
        }
    }

    function startFitLadder(name) {
        const gen = (fitLadderGen.get(name) || 0) + 1;
        fitLadderGen.set(name, gen);

        const attempt = (step) => {
            // Superseded by a newer layout change / assignment for this terminal.
            if (fitLadderGen.get(name) !== gen) { return; }
            const entry = terminalsMap.get(name);
            if (!entry || entry.disposed) { return; }
            // Re-read assignment each attempt rather than closing over it: a floor
            // demotion or a reassignment may have moved this terminal out.
            if (!paneAssignments.slice(0, getSlotCount(effectiveLayout)).includes(name)) { return; }

            const before = inspectPaneFit(entry);
            if (before === 'skip') { return; }
            if (before === 'mismatch' || before === 'unsettled') {
                fitAndReportSize(entry);
            }

            const after = inspectPaneFit(entry);
            if (after === 'ok') { return; }
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
        // second after that frame's style/layout and IntersectionObserver delivery.
        // Later attempts are timers so a backgrounded tab (rAF suspended) still
        // converges when it is brought forward.
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
```

Notes on why this is contained:
- `fitAndReportSize` is unchanged, so the `isRendered` gate and the `rendered: true` contract with the gateway are untouched.
- The pty only ever hears about a size from `fitAndReportSize`, and the ladder calls it only when the buffer is actually wrong. `resyncPaneRenderer` deliberately sends nothing. So a 4-attempt ladder still produces exactly one pty resize frame in the common case.
- Every existing call site keeps calling `batchFitVisiblePanes()`; no signature change.

### 2. `src/webview/terminals.js` — cancel a stale ladder when the view goes away

In `destroyTerminalView` (`terminals.js:1644`), alongside the existing observer/timer teardown:

```js
        // A ladder still stepping for this name would re-fit a disposed entry (it
        // guards on entry.disposed, but bumping the generation stops the timers
        // from firing at all).
        fitLadderGen.delete(name);
```

### 3. `src/webview/terminals.js` — let the per-container ResizeObserver use the ladder

The observer installed in `materializeTerminalView` (`terminals.js:1786`) currently calls `fitAndReportSize` directly, which inherits the same unverified, one-shot weakness. Route it through the ladder so a window drag that lands a pane in a new box also self-verifies:

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

Source-shape contract in the style of the existing `terminal-*-contract.test.js` files (they assert on `terminals.js` source, since the panel is a plain browser script with no module boundary):

```js
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

describe('terminals panel pane-fit verification', () => {
    it('verifies the fit instead of firing one unchecked rAF', () => {
        expect(SRC).toContain('function inspectPaneFit');
        expect(SRC).toContain('function startFitLadder');
        // The old single-rAF body must be gone: batchFitVisiblePanes may no longer
        // call fitAndReportSize directly from inside a bare requestAnimationFrame.
        const body = SRC.slice(
            SRC.indexOf('function batchFitVisiblePanes'),
            SRC.indexOf('const DEFAULT_ROLES'));
        expect(body).toContain('startFitLadder');
        expect(body).not.toContain('requestAnimationFrame');
    });

    it('detects a stale renderer canvas, not just a stale buffer', () => {
        expect(SRC).toContain("'stale-canvas'");
        expect(SRC).toContain('.xterm-screen');
    });

    it('only the verified size is reported to the shared pty', () => {
        // resyncPaneRenderer must never send a resize frame — the gateway takes the
        // MIN across clients, so an intermediate size would flap the shared pty.
        const resync = SRC.slice(
            SRC.indexOf('function resyncPaneRenderer'),
            SRC.indexOf('function batchFitVisiblePanes'));
        expect(resync).not.toContain('fitAndReportSize');
        expect(resync).not.toContain("t: 'resize'");
    });

    it('retries off timers as well as rAF so a hidden tab converges', () => {
        expect(SRC).toContain('FIT_SETTLE_DELAYS_MS');
        const ladder = SRC.slice(
            SRC.indexOf('function startFitLadder'),
            SRC.indexOf('function batchFitVisiblePanes'));
        expect(ladder).toContain('setTimeout');
        expect(ladder).toContain('requestAnimationFrame');
    });

    it('a newer request supersedes an in-flight ladder', () => {
        expect(SRC).toContain('fitLadderGen');
        expect(SRC).toContain('fitLadderGen.delete(name)');
    });
});
```

## Verification Plan

**Automated**
1. `npx jest src/test/terminal-pane-fit-verification-contract.test.js --forceExit` — new contract passes.
2. `npx jest src/test/terminal-flow-control-contract.test.js src/test/terminal-input-path-contract.test.js src/test/terminal-token-transport-contract.test.js src/test/terminal-solo-popout-contract.test.js src/test/shell-terminal-strip.test.js --forceExit` — the existing terminal contracts still pass (`shell-terminal-strip` scans a specific span of this file, so it is the regression canary for the edit's placement).
3. `npx tsc -p tsconfig.json --noEmit` — no TS surface changed, but confirm the build is clean.
4. `npm run build` (webpack), then sync to the **installed** extension folder and reload the window — the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, so a repo-only build is not live.

**Manual — the reported repro**
5. Open the browser Terminals panel. Create 9 terminals and assign them across a `3x3` layout. Let every pane paint real output (run something with a full-screen TUI, e.g. an agent CLI, so a wrong size is unmistakable).
6. Click the single-pane layout button. **Expect:** the pane's terminal fills the pane immediately — no small block with dead space — and its content reflows to the new width.
7. Repeat step 6 ten times, cycling which terminal sits in pane 0 between runs (click a different sidebar row each time). **Expect:** 10/10 expand. Previously this was intermittent, so a single pass is not evidence — the repeat count *is* the test.
8. Walk the full ladder of layouts in both directions: `1 → 2h → 2v → 2x2 → 2x3 → 3x3 → 1`. **Expect:** every rendered pane matches its box after each step, and no pane is left blank.
9. With the panel open at `3x3`, drag the window narrow enough to trip the floor (`3x3` needs 750×450 — see `LAYOUTS`, `terminals.js:461`) so the fallback banner appears and the layout demotes. **Expect:** the demoted panes are correctly sized and the banner's appearance (which changes available height) does not leave a stale pane.
10. Switch to another panel tab and back (the iframe goes `display:none` and returns). **Expect:** panes are correctly sized on return, and `console.warn` shows no "did not converge" line.
11. Pop a terminal out into its own window (`?solo=`) while the same terminal is also in a grid pane, then change the grid layout. **Expect:** both windows stay readable; the pty settles at the min of the two, which is the designed gateway behaviour (`terminalWsGateway.ts:738`) and not a regression.

**Instrumentation check — proves which half was failing**
12. In DevTools, before step 6, capture `cols/rows` for the pane's terminal, then after the switch compare: the panel's client size (from the warn line or a manual `inspectPaneFit`) against the pty's idea of the size. A converged pane must agree on both. If a "did not converge" warning ever fires in steps 6–11, capture the verdict string — `stale-canvas` vs `mismatch` vs `unsettled` names the remaining failure surface precisely, which is the point of logging it.

**Negative check**
13. Confirm the happy path did not get more expensive: with a single terminal in the `1` layout, switch to `2h` and back while watching the WebSocket frames in DevTools. **Expect:** one `{t:'resize', rendered:true}` frame per terminal per layout change — not one per ladder attempt.
