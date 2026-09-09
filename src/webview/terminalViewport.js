// terminalViewport.js — Terminal viewport module: xterm setup, sizing, theme,
// view materialisation, WebSocket stream, write batching and replay.
//
// Extracted from terminals.js so any embedder (the Terminals panel, a future dock
// document, a popout) can render ONE terminal without loading the whole panel.
// The module is the inner box — xterm and its WebSocket. Whoever embeds it draws
// its own frame (title bar, action buttons, drop targets, input-state chips).
//
// No panel globals: every dependency is a constructor argument (the deps bag) or
// a method parameter. The module reads no document.getElementById and no panel
// state name directly — the gate that stops a hidden dependency surviving the move
// and working by accident until a second embedder exists.
//
// Loaded as a classic <script> (CSP: script-src 'nonce-...' 'self'). Exposes
// window.SwitchboardTerminalViewport.create(deps) → a viewport controller.
(function() {
    'use strict';

    window.SwitchboardTerminalViewport = { create: createTerminalViewport };

    /**
     * Build a terminal viewport controller.
     *
     * @param {object} deps — every panel-side dependency the module needs:
     *   {Map}    terminalsMap         — shared name→entry map; the module adds/removes
     *   {Map}    fitLadderGen         — shared name→gen map; the module deletes on destroy
     *   {Set}    workingSilenceShown  — shared name set; the module reads, the panel writes
     *   {function} getFleetList       — () => fleetList (reassigned by the panel)
     *   {function} getPaneAssignments — () => paneAssignments (reassigned by the panel)
     *   {function} getFocusedPaneIndex — () => focusedPaneIndex (reassigned by the panel)
     *   {function} isTerminalSeated    — (name) => bool: assigned to a rendered,
     *                                    non-status slot (box-independent; see #1)
     *   {boolean} isDockFrame         — whether this document is a dock iframe
     *   {string}  ptyHostOrigin       — WebSocket origin for the pty host
     *   {function} resyncPaneRenderer — (entry, verdict, options) => void
     *   {function} startFitLadder     — (name) => void
     *   {function} refreshInputState  — (name) => void
     *   {function} notifyInputDropped — (entry) => void
     *   {function} showPaneToast      — (text) => void
     *   {function} clearCaretRing     — () => void
     *   {function} focusPaneTerminal  — (index) => void
     *   {function} clearWorkingSilence — (name) => void
     *   {function} bumpStartupCurtain — (name) => void
     *   {function} dismissStartupCurtain — (name) => void
     *   {function} showTerminalErrorToast — (name, message) => void
     *   {function} markReplayGap      — (name) => void
     *   {function} cancelDetachTimer  — (name) => void
     * @returns {object} — public surface: create, dispose, connect, suspend, resume,
     *   fitAndReportSize, releaseSizeVote, ensureSizeVote, reconcileRendererForVisibility,
     *   armRendererRelease, cancelRendererRelease, isRendered, encodeInputFrame,
     *   buildTerminalTheme, resolveMonoFont
     */
    // MUST stay outside createTerminalViewport. Declared inside the factory it
    // silently became per-INSTANCE: a page holding two viewports — which is exactly
    // the dock document, Agent and CLI side by side — would allow 24 and blow the
    // browser's cap, and the symptom is force-lost contexts and garbled cells, never
    // an error. Per-instance renderer state (the holder, the release closure) still
    // lives inside the factory; only the shared budget is out here.
    //
    // Our own per-document ceiling. It is NOT the process cap: liveWebglContexts is a
    // `let` in this script's closure, and a second same-origin document (a pop-out)
    // loads its own copy and starts its own counter at zero. The real cap is ~16 live
    // contexts per renderer process, shared across every same-origin document in it.
    const MAX_WEBGL_CONTEXTS = 12;
    let liveWebglContexts = 0;

    // ─── Dev-only WebGL churn probe (Proposed Change #4) ───────────────────
    //
    // The plan's root-cause mechanism for the 9/9 acquire/release churn is
    // SUPERSEDED — see the plan's "Why it happens" callout. Before implementing
    // Proposed Change #1 (a re-box must not release the renderer) or sizing
    // Proposed Change #3 (coalesce per-switch reflow), the plan requires
    // re-running the instrumentation against current HEAD and, for #3,
    // re-measuring the ResizeObserver count with a PER-ENTRY filter (the 33
    // figure was taken with a global ResizeObserver patch that also captured
    // sidebar/kanban/shell observers).
    //
    // This probe is that instrumentation, landed as a repeatable dev-only check
    // so a regression shows up as a number rather than as "feels laggy". It is
    // OFF by default and changes NO behaviour when disabled: the counters are
    // touched only behind the `churnProbe` guard at the acquire/release sites
    // and the per-entry ResizeObserver callback. Filtered to terminal entries
    // by construction — it counts our own liveWebglContexts acquire/release
    // and our own per-entry observer, never the global ResizeObserver.
    let churnProbe = null;
    function recordChurnAcquire(entry) {
        if (!churnProbe) { return; }
        churnProbe.acquires++;
        bumpChurnEntry(entry).acquires++;
    }
    function recordChurnRelease(entry) {
        if (!churnProbe) { return; }
        churnProbe.releases++;
        bumpChurnEntry(entry).releases++;
    }
    function recordChurnResize(entry) {
        if (!churnProbe) { return; }
        churnProbe.resizeCallbacks++;
        bumpChurnEntry(entry).resizeCallbacks++;
    }
    function bumpChurnEntry(entry) {
        const name = (entry && entry.name) || '<unknown>';
        let per = churnProbe.perEntry.get(name);
        if (!per) { per = { acquires: 0, releases: 0, resizeCallbacks: 0 }; churnProbe.perEntry.set(name, per); }
        return per;
    }

    // The dev console surface. Enable from devtools:
    //   __sbWebglChurnProbe.enable();   // begin counting
    //   <drive layout switches>
    //   __sbWebglChurnProbe.report();   // { acquires, releases, resizeCallbacks, perEntry }
    //   __sbWebglChurnProbe.reset();    // zero counters without disabling
    //   __sbWebglChurnProbe.disable();  // stop counting
    // A layout switch that re-boxes a seated terminal WITHOUT it leaving the fleet
    // should report ZERO acquires and ZERO releases for that terminal (the goal
    // invariant in the plan's Verification Plan). The perEntry map is keyed by
    // terminal name, so the count is the per-entry filter the plan's Outstanding
    // Questions ask for — not the global ResizeObserver patch that inflated the
    // original 33-callback figure with sidebar/kanban/shell observers.
    if (typeof window !== 'undefined') {
        window.__sbWebglChurnProbe = {
            enable() {
                if (!churnProbe) {
                    churnProbe = { acquires: 0, releases: 0, resizeCallbacks: 0, perEntry: new Map() };
                }
                return churnProbe;
            },
            disable() { churnProbe = null; },
            reset() {
                if (!churnProbe) { this.enable(); }
                churnProbe.acquires = 0;
                churnProbe.releases = 0;
                churnProbe.resizeCallbacks = 0;
                churnProbe.perEntry.clear();
            },
            report() {
                if (!churnProbe) { return { enabled: false, acquires: 0, releases: 0, resizeCallbacks: 0, perEntry: {} }; }
                const perEntry = {};
                for (const [name, per] of churnProbe.perEntry.entries()) {
                    perEntry[name] = { ...per };
                }
                return {
                    enabled: true,
                    liveWebglContexts,
                    acquires: churnProbe.acquires,
                    releases: churnProbe.releases,
                    resizeCallbacks: churnProbe.resizeCallbacks,
                    perEntry
                };
            }
        };
    }

    function createTerminalViewport(deps) {

    // ─── Module-level state ──────────────────────────────────────────────

    /** One decoder for every terminal — constructing one per frame is not free. */
    const outputDecoder = new TextDecoder('utf-8');

    /** Backstop flush interval for when requestAnimationFrame is not running. */
    const BATCH_FALLBACK_MS = 200;

    /** Hidden long enough to be worth reclaiming. Short flips between shell panels
     *  must not thrash the GPU: a switch out and back inside this window keeps its
     *  context and costs nothing. */
    const RENDERER_RELEASE_DELAY_MS = 5000;

    const ACK_CHUNK_CHARS = 5000;

    /**
     * DEC private modes the gateway reports, in application order.
     *
     * A fresh xterm has all of these at their defaults while the pty app's belief
     * persists, and the app never re-announces a settled mode — so without this the
     * pane can come back with mouse reporting on and nothing left to turn it off:
     * the wheel goes to the app instead of the viewport (1000/1002/1003 all set the
     * WHEEL bit — event masks 19/23/31) and xterm disables its own SelectionService,
     * so a click can neither start nor clear a selection. That is the "stuck, can't
     * scroll, can't deselect" report.
     *
     * 9 (X10) is here even though it does NOT claim the wheel: areMouseEventsActive
     * only tests that the active protocol's event mask is non-zero, and X10's is 1,
     * so a stale mode 9 still kills selection.
     *
     * 1049 is NOT in this list — it is handled separately and conditionally below.
     */
    const REARMABLE_DEC_MODES = [9, 1000, 1002, 1003, 1004, 1006, 2004];

    // ─── Frame analysis (working-silence signal) ─────────────────────────

    // Minimum gap between printable scans on the live-frame hot path. frameHasPrintable
    // is O(frame length) with a regex allocation, and the hot path runs once per flush
    // frame (up to ~166/s at the gateway's 6 ms window, frames up to MAX_FLUSH_BYTES) —
    // an unconditional scan there is real main-thread work on the busiest terminals,
    // which are precisely the ones that will never show this signal. Re-scanning at most
    // every 250 ms leaves lastPrintableAt at most 250 ms stale against a 90 s threshold
    // swept every 5 s, so the signal's behaviour is unchanged.
    const PRINTABLE_SCAN_THROTTLE_MS = 250;

    /**
     * True when `text` paints a glyph OR mutates the screen — the exact inverse
     * of `isContentFree` in terminalWsGateway.ts, and deliberately kept
     * character-for-character equivalent to it: the two answer the same question
     * ("did anything visible happen") for the ring collapse and for this signal.
     * Used to stamp `lastPrintableAt` only on frames that actually change the
     * pane, so a 12 fps heartbeat (cursor wiggles, no glyph) never resets the
     * silence timer.
     *
     * A frame counts as visible when it carries a printable glyph (code point
     * >= 0x20 other than DEL) after escape stripping, OR carries a
     * screen-mutating sequence (erase/insert/delete/scroll/REP, IND/NEL/RI,
     * RIS/DECSTR/DECALN) or a non-inert C0 control (anything but NUL and CR —
     * LF/VT/FF scroll, BS/HT move relative to where the cursor already is).
     */
    const PRINTABLE_ESCAPES_RE =
        /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/][@-~]|\x1b[@-Z\\-_]|\x1b/g;
    const SCREEN_MUTATING_RE = /\x1b\[[0-9;?<=>]*[ -/]*[@JKLMPSTXb]|\x1b[DEMc]|\x1b#8|\x1b\[!p/;
    function frameHasPrintable(text) {
        if (!text) { return false; }
        if (SCREEN_MUTATING_RE.test(text)) { return true; }
        const stripped = text.replace(PRINTABLE_ESCAPES_RE, '');
        for (let i = 0; i < stripped.length; i++) {
            const ch = stripped.charCodeAt(i);
            if (ch >= 0x20 && ch !== 0x7f) { return true; }
            // Everything reaching here is < 0x20 or DEL. NUL, CR and DEL are
            // inert (gateway isInertControl); every other control is visible.
            if (ch !== 0x00 && ch !== 0x0d && ch !== 0x7f) { return true; }
        }
        return false;
    }

    // ─── Write batching state (page-level) ───────────────────────────────

    const pendingBatchEntries = new Set();
    let sharedBatchRafId = null;
    let sharedBatchFallbackTimer = null;

    // ─── Input frame encode / base64 decode ──────────────────────────────

    function encodeInputFrame(str) {
        const body = new TextEncoder().encode(str);
        const frame = new Uint8Array(1 + body.length);
        frame[0] = 0x01; // input opcode
        frame.set(body, 1);
        return frame.buffer;
    }

    function base64ToUtf8(b64) {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    // ─── Font / box helpers ──────────────────────────────────────────────

    /**
     * Resolve the mono font stack to a concrete value.
     *
     * `fontFamily: 'var(--font-code)'` survives the DOM renderer (an inline style
     * resolves the var against :root) but is meaningless to a canvas/WebGL
     * renderer, which passes the string straight to `ctx.font` where `var()` is
     * invalid — yielding a silent fallback and wrong glyph metrics. Resolve it here
     * so the GPU renderers measure the same font the DOM one drew.
     */
    function resolveMonoFont() {
        try {
            const resolved = getComputedStyle(document.documentElement)
                .getPropertyValue('--font-code')
                .trim();
            if (resolved) { return resolved; }
        } catch { /* fall through */ }
        return 'Menlo, Monaco, "Courier New", monospace';
    }

    /**
     * True when `el` occupies a real box in a rendered document.
     *
     * This panel routinely runs with no layout at all: the browser shell mounts every
     * panel iframe up front and toggles them with display:none (see shell.js), so the
     * Terminals document exists — and its terminals connect — while measuring 0x0.
     * In that state xterm cannot measure a character cell, FitAddon's
     * proposeDimensions divides by a zero cell size, and fit() bails on NaN. The
     * terminal is then left at its 80x24 construction default.
     *
     * That default is not harmless. The pty is SHARED between every attached client
     * and the gateway applies each resize frame as it arrives, so a hidden tab
     * reporting 80x24 squashed the operator's visible terminal to 24 rows, and every
     * shell load or tab switch made it flap. Every fit-and-report path is gated on
     * this, and construction itself is deferred until it returns true.
     */
    function isRendered(el) {
        if (!el) { return false; }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // ─── Sizing: fit, size votes ─────────────────────────────────────────

    /**
     * Fit to the container and tell the pty the new size — but only ever from a
     * rendered box. `rendered: true` lets the gateway discount any client that gets
     * this wrong; see the resize arm of terminalWsGateway.
     */
    function fitAndReportSize(entry) {
        if (!entry || entry.disposed || !entry.term || !entry.fitAddon) { return; }
        if (!isRendered(entry.container)) { return; }
        let resized = false;
        try {
            const colsBefore = entry.term.cols;
            const rowsBefore = entry.term.rows;
            entry.fitAddon.fit();
            resized = entry.term.cols !== colsBefore || entry.term.rows !== rowsBefore;
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({
                    t: 'resize',
                    cols: entry.term.cols,
                    rows: entry.term.rows,
                    rendered: true
                }));
                entry.sizeVoteActive = true;
            }
        } catch { /* ignore */ }
        // A grid resize invalidates the WebGL glyph model, and xterm does not
        // repair it. GlyphRenderer sizes and indexes its vertex array by
        // cols*rows (see GlyphRenderer.clear in vendor/xterm/addon-webgl.js),
        // but WebglRenderer.handleResize only forwards the new dimensions —
        // GlyphRenderer.setDimensions is a bare `this._dimensions = e`, with no
        // reallocation and no re-index. So every row the terminal does not go on
        // to mark dirty keeps glyph quads positioned for the OLD column stride:
        // on a shrink they bunch up and overprint, word shapes intact and
        // characters overlapping.
        //
        // Rows the pty app rewrites re-rasterise and self-heal, which is why the
        // damage is only ever visible on a region nothing rewrites — a CLI's
        // static status strip — and why scrolling does not repair it: a repaint
        // reads the same stale model. clearTextureAtlas() is the only call that
        // reaches _clearModel(true) -> GlyphRenderer.clear() and rebuilds the
        // vertex array at the new size, and resyncPaneRenderer's 'stale-canvas'
        // arm is what pairs it with the full refresh that repopulates it.
        //
        // AFTER the send, not before: the resize frame is what sizes the shared
        // pty, and no renderer repair is worth delaying or risking it.
        if (resized) { deps.resyncPaneRenderer(entry, 'stale-canvas'); }
    }

    /**
     * Tell the gateway this client no longer has a viewport, so its last reported
     * size stops constraining the shared pty.
     *
     * `client.reportedSize` is sticky server-side: fitAndReportSize returns early
     * when the box is 0x0, so a client that goes hidden simply stops sending and
     * its final size clamps the pty until the socket closes. That is why switching
     * the shell to another panel did not release the cockpit's hold on a
     * popped-out terminal.
     *
     * Sent once per transition, not per ResizeObserver tick — a hidden panel must
     * not become a chatty client.
     */
    function releaseSizeVote(entry) {
        if (!entry || !entry.sizeVoteActive) { return; }
        if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) { return; }
        try {
            entry.ws.send(JSON.stringify({ t: 'resize', cols: 0, rows: 0, rendered: false }));
            entry.sizeVoteActive = false;
        } catch { /* ignore */ }
    }

    /**
     * Re-cast a withdrawn vote. The counterpart to releaseSizeVote, and NOT optional:
     * a client that withdraws and never re-votes is permanently removed from the pty
     * sizing calculation, which is a worse bug than the clamp this all exists to fix.
     *
     * Deliberately NOT routed through startFitLadder. The ladder reports only on a
     * verified 'mismatch' verdict, and a pane that comes back at exactly the size it
     * left at inspects as 'ok' — so the ladder alone would leave the vote withdrawn
     * forever. fitAndReportSize sends unconditionally from a rendered box, which is
     * precisely what is needed here.
     */
    function ensureSizeVote(entry) {
        if (!entry || entry.disposed || entry.sizeVoteActive) { return; }
        if (!isRendered(entry.container)) { return; }
        fitAndReportSize(entry);
    }

    // ─── Renderer: WebGL / canvas / DOM swap ─────────────────────────────

    /** Is a WebGL renderer even possible in this document? */
    function webglAvailable() {
        return !!(window.WebglAddon && window.WebglAddon.WebglAddon);
    }

    function attachCanvasRenderer(term) {
        if (window.CanvasAddon && window.CanvasAddon.CanvasAddon) {
            try {
                const canvas = new window.CanvasAddon.CanvasAddon();
                term.loadAddon(canvas);
                return canvas;
            } catch (err) {
                console.warn('[Terminals] Canvas renderer unavailable, using DOM renderer:', err);
            }
        }
        return null;
    }

    /**
     * Attach the fastest renderer this browser will give us.
     *
     * xterm's default is the DOM renderer — a span per cell, relaid out by the
     * browser every frame. That is the single largest reason browser terminals
     * trailed VS Code's, which runs WebGL by default. Order is WebGL → canvas →
     * DOM, each step a strictly slower but strictly more compatible fallback.
     *
     * MUST be called after `term.open()`: both addons need the terminal's element
     * to exist before they can create a drawing surface.
     *
     * Returns a holder rather than the addon itself because a context loss swaps
     * the live addon out underneath us — teardown has to dispose whichever one is
     * current, not the one that happened to be attached at creation.
     */
    function attachRenderer(term, entry) {
        // `release` is a no-op on every non-WebGL path, so callers never branch.
        const holder = { current: null, release: () => {} };
        // A container with no box cannot be painted, and a WebGL context is a
        // PROCESS-wide resource. createTerminalView already defers materialization
        // until the container has a box (see whenRendered), so this is a belt on top
        // of braces for the ORIGINAL acquisition — but swapRenderer re-enters here on
        // the upgrade path, and this is what keeps that path honest without the caller
        // having to re-check. MAX_WEBGL_CONTEXTS cannot catch a boxless acquisition:
        // it counts THIS document's contexts, and the pop-out is a second document in
        // the same process with its own counter starting at zero.
        const hasBox = entry ? isRendered(entry.container) : true;

        // The single WebGL acquire site, factored out so the budget-exhausted
        // eviction path below can re-enter it WITHOUT a second increment of the
        // live counter. Two increment sites is exactly the hand-paired accounting
        // this design replaced (see terminal-renderer-lifecycle-contract: "exactly
        // one increment site"); the contract test pins that count at one, so the
        // re-entry MUST go through this closure rather than duplicating the body.
        // Returns true on a successful WebGL attach, false on a constructor throw
        // (in which case the canvas fallback is already loaded into the holder).
        function acquireWebgl() {
            try {
                const webgl = new window.WebglAddon.WebglAddon();
                // EXACTLY ONE decrement per acquisition, from any path, in any order.
                // Before this there were three independent decrement sites keyed on
                // entry.isWebgl; a renderer swap makes that a fourth, and hand-pairing
                // four sites is how a counter drifts low and over-allocates (or drifts
                // high and pins every pane to canvas for the life of the page).
                let released = false;
                holder.release = () => {
                    if (released) { return; }
                    released = true;
                    liveWebglContexts = Math.max(0, liveWebglContexts - 1);
                    if (entry) { entry.isWebgl = false; }
                    // The ONLY call site. Folding the real release into the accounting
                    // release is what makes it impossible for the counter to say
                    // "freed" while the process still holds the context.
                    forceReleaseWebglContext(webgl);
                    if (churnProbe) { recordChurnRelease(entry); }
                };
                webgl.onContextLoss(() => {
                    // A release WE initiated. forceReleaseWebglContext calls
                    // loseContext(), which fires webglcontextlost right back into this
                    // handler — and swapRenderer/destroyTerminalView are mid-teardown
                    // and will attach the replacement themselves. Recovering here would
                    // double-attach and race them. `released` is already true by the
                    // time loseContext() runs, so this guard is exact.
                    if (released) { return; }
                    console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
                    holder.release();
                    try { webgl.dispose(); } catch { /* ignore */ }
                    holder.current = attachCanvasRenderer(term);
                    if (entry) {
                        // Debt, not defeat: the context was taken away, not declined.
                        // The next visibility tick retries once the budget allows.
                        entry.rendererDeferred = webglAvailable();
                        // A renderer swap does NOT repaint what is already on screen. The
                        // incoming canvas renderer starts with an empty surface and then
                        // paints only rows the terminal subsequently marks dirty, so every
                        // row nothing rewrites keeps whatever the dead WebGL canvas left
                        // behind. On an idle CLI that is the entire visible screen.
                        deps.resyncPaneRenderer(entry, 'stale-canvas');
                    }
                });
                term.loadAddon(webgl);
                holder.current = webgl;
                if (entry) {
                    entry.isWebgl = true;
                    entry.rendererDeferred = false;
                    // LRU basis: a pane acquiring WebGL against a real box is visible
                    // now. Stamped here too (not only in reconcile) so the very first
                    // acquire — which goes through materializeTerminalView, not
                    // reconcile — still seeds the ordering.
                    entry.lastVisibleAt = Date.now();
                }
                liveWebglContexts++;
                if (churnProbe) { recordChurnAcquire(entry); }
                return true;
            } catch (err) {
                console.warn('[Terminals] WebGL renderer unavailable, falling back:', err);
                // No debt recorded. A constructor that threw will throw again on the
                // next tick, and retrying it per tick is exactly the churn this
                // machinery exists to avoid. This pane stays on canvas for the life
                // of the page; every other pane is unaffected.
                if (entry) { entry.rendererDeferred = false; }
                holder.current = attachCanvasRenderer(term);
                return false;
            }
        }

        if (webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
            acquireWebgl();
            return holder;
        }
        // Budget exhausted but this pane HAS a box and WebGL is possible: reclaim
        // the least-recently-visible HIDDEN pane's context rather than leaving this
        // visible pane on canvas. The skip-on-ceiling this replaces was
        // order-determined — which panes got WebGL depended on creation order, not
        // on what the operator was looking at. NEVER evicts a pane that is currently
        // rendered: evicting the watched pane is the regression the skip-on-ceiling
        // did not have, and the candidate scan refuses any isRendered entry. The
        // eviction is page-global by necessity — liveWebglContexts is script-scoped
        // so the dock's two viewports share one budget (see the note at :51), and a
        // per-viewport policy would re-introduce the per-instance over-allocation
        // fixed in 36e42cb9. swapRenderer(candidate, false) routes the drop through
        // the same holder.release the genuine-leave path uses, so the accounting and
        // the forceReleaseWebglContext guarantee are unchanged.
        if (webglAvailable() && hasBox && evictLeastRecentlyVisibleHiddenWebgl(entry)
            && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
            acquireWebgl();
            return holder;
        }
        // Boxless, budget-exhausted (with no evictable candidate), or no addon at
        // all — one expression covers all three: a debt is owed exactly when WebGL
        // is possible but not held.
        if (entry) { entry.rendererDeferred = webglAvailable(); }
        holder.current = attachCanvasRenderer(term);
        return holder;
    }

    /**
     * Hand the GL context back to the browser NOW, rather than whenever GC runs.
     *
     * The vendored addon-webgl.js contains ZERO references to WEBGL_lose_context.
     * WebglAddon.dispose() tears down its renderer, listeners and atlas page canvases
     * and then leaves the live WebGL2 context to the garbage collector. The browser's
     * per-process ceiling is charged against the LIVE context, not against our intent
     * to drop it, so a disposed-but-uncollected addon still occupies a slot for an
     * unbounded time. Without this call the entire release half of this change is
     * cosmetic: liveWebglContexts and __sbTerminalStats would both report a freed
     * budget that the process has not freed.
     *
     * Private surface, same precedent and same defensive shape as
     * term._core._renderService in readRenderedGrid/resyncPaneRenderer: every hop
     * guarded, whole thing inside a try, silent no-op if a vendored xterm upgrade
     * changes the shape. MUST run BEFORE dispose() — dispose() drops the renderer
     * reference, and with it the only path to the context.
     */
    function forceReleaseWebglContext(addon) {
        try {
            const gl = addon && addon._renderer && addon._renderer._gl;
            if (!gl || typeof gl.getExtension !== 'function') { return; }
            const ext = gl.getExtension('WEBGL_lose_context');
            if (ext && typeof ext.loseContext === 'function') { ext.loseContext(); }
        } catch { /* vendored shape changed — dispose() below still runs */ }
    }

    /**
     * Bring `entry`'s renderer in line with whether it currently has a box.
     *
     * This function is the AUTHORITY — every trigger (the ResizeObserver and the release
     * timer) funnels here, and here alone re-reads isRendered. Triggers may be cheap
     * and approximate; this is not.
     */
    function reconcileRendererForVisibility(entry) {
        if (!entry || entry.disposed || !entry.term || !entry.rendererAddon) { return; }
        const hasBox = isRendered(entry.container);

        if (hasBox) {
            // LRU basis: a pane that currently has a box is the most-recently-visible.
            // Stamped here (the single authority for isRendered re-reads) so a hidden
            // pane's stamp freezes at the moment it left, and the eviction policy
            // orders hidden panes by how long they have been hidden — not by creation
            // order, which is the order-determined skip-on-ceiling this replaces.
            entry.lastVisibleAt = Date.now();
            // Budget still exhausted -> keep the debt and return; the next tick retries,
            // and a released context (a closed terminal, another pane hidden) is what
            // lets it through.
            if (!entry.isWebgl && entry.rendererDeferred
                && webglAvailable() && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
                swapRenderer(entry, /* wantWebgl */ true);
            }
            return;
        }
        // Released, not merely idle. Without this a panel switched away from — or a
        // terminal unassigned from the grid but retained for its scrollback — keeps its
        // context for the life of the page, which is the exact budget a popped-out
        // window then cannot get.
        if (entry.isWebgl) { swapRenderer(entry, /* wantWebgl */ false); }
    }

    function swapRenderer(entry, wantWebgl) {
        const outgoing = entry.rendererAddon;
        // RELEASE, then DISPOSE, then attach. All three orderings are load-bearing:
        //  - release BEFORE dispose, because release() reaches addon._renderer._gl and
        //    dispose() drops _renderer — after it, the context is unreachable and can
        //    only be reclaimed by a GC we do not control.
        //  - release BEFORE the try, so a dispose() that throws still gives the budget
        //    back. Otherwise the counter is short by one for the life of the page and
        //    after enough of them every terminal is pinned to the DOM/canvas renderer
        //    for the life of the page with no diagnostic.
        //  - dispose BEFORE attach, because two renderers loaded on one Terminal is not
        //    a supported xterm state and the outgoing one owns the surface the incoming
        //    one needs.
        // release() is one-shot, so the webglcontextlost it provokes cannot re-enter
        // this swap through the addon's own onContextLoss handler.
        outgoing.release();
        try { if (outgoing.current) { outgoing.current.dispose(); } } catch { /* ignore */ }
        outgoing.current = null;

        // A NEW holder, deliberately. The outgoing addon's onContextLoss closure captured
        // the OLD holder, and the incoming WebGL addon's closure must write to the new
        // one — which attachRenderer returning a fresh holder gives for free. Do not
        // "optimise" this into mutating the holder in place.
        entry.rendererAddon = wantWebgl
            ? attachRenderer(entry.term, entry)          // sets isWebgl + rendererDeferred
            : { current: attachCanvasRenderer(entry.term), release: () => {} };
        if (!wantWebgl) { entry.rendererDeferred = webglAvailable(); }

        // ONLY when there is something on screen to repair. A renderer swap does not
        // repaint what is already drawn — the incoming renderer starts empty and paints
        // only rows the terminal later marks dirty, which is the same defect the
        // onContextLoss handler had. But on the RELEASE direction there are no pixels to
        // strand, and driving _renderService.handleResize against a zero-size box makes
        // the canvas renderer measure a zero cell and size itself to nothing. The pane
        // would self-heal on its next fit ladder, but there is no reason to break it in
        // the first place.
        if (isRendered(entry.container)) { deps.resyncPaneRenderer(entry, 'stale-canvas'); }
    }

    /**
     * Reclaim one WebGL context from a HIDDEN pane so a visible pane can acquire
     * one under the per-document ceiling. The skip-on-ceiling this replaces left
     * the visible pane on canvas whenever the budget was full — so which panes
     * got WebGL depended on creation order, not on what the operator was looking
     * at. This makes the choice instead on visibility history.
     *
     * Contract guarantees:
     *  - NEVER evicts a pane that is currently rendered (isRendered). Evicting
     *    the watched pane is the regression the skip-on-ceiling did not have; the
     *    candidate scan refuses any isRendered entry, so a visible pane is safe
     *    even when it is the oldest by stamp.
     *  - Page-global. liveWebglContexts is script-scoped (the dock's two viewports
     *    share it), so the scan walks deps.terminalsMap — every entry in this
     *    document — not a per-viewport subset. A per-viewport policy would
     *    re-introduce the per-instance over-allocation fixed in 36e42cb9.
     *  - Routes through swapRenderer(candidate, false), which routes through the
     *    one-shot holder.release — the same path the genuine-leave teardown uses —
     *    so the liveWebglContexts decrement and the forceReleaseWebglContext
     *    guarantee are unchanged. The evicted pane keeps a rendererDeferred debt,
     *    so reconcileRendererForVisibility retries it the next time it becomes
     *    visible AND budget has freed (the existing retry at :452).
     *  - Never evicts the requesting entry, a disposed entry, or an entry not
     *    actually holding WebGL (isWebgl). A pane already on canvas owes a debt,
     *    not a context.
     *
     * Returns true when a context was reclaimed, false when no evictable candidate
     * exists (in which case attachRenderer falls through to the canvas path, the
     * same behaviour as before this function existed).
     */
    function evictLeastRecentlyVisibleHiddenWebgl(requestingEntry) {
        let candidate = null;
        let candidateStamp = Infinity;
        for (const e of deps.terminalsMap.values()) {
            if (e === requestingEntry || !e || e.disposed) { continue; }
            // Only a pane actually holding a WebGL context is worth evicting. A
            // canvas pane (isWebgl false) owes a debt, not a context — swapping it
            // to canvas again frees nothing.
            if (!e.isWebgl || !e.rendererAddon) { continue; }
            // The load-bearing guard: a pane that is currently visible is never a
            // candidate. isRendered is the same authority reconcileRendererForVisibility
            // re-reads, so this cannot drift from the visibility the rest of the
            // module already agrees on.
            if (isRendered(e.container)) { continue; }
            const stamp = e.lastVisibleAt || 0;
            if (stamp < candidateStamp) {
                candidate = e;
                candidateStamp = stamp;
            }
        }
        if (!candidate) { return false; }
        // wantWebgl false: releases the GL context (through the holder), disposes
        // the addon, attaches canvas. The candidate is hidden, so the
        // `if (isRendered(...))` resync guard in swapRenderer skips the repaint —
        // no wasted work against a surface nobody can see.
        swapRenderer(candidate, /* wantWebgl */ false);
        return true;
    }

    function cancelRendererRelease(entry) {
        if (entry.releaseTimer) {
            clearTimeout(entry.releaseTimer);
            entry.releaseTimer = null;
        }
    }

    function armRendererRelease(entry) {
        if (entry.releaseTimer || entry.disposed) { return; }   // idempotent
        entry.releaseTimer = setTimeout(() => {
            entry.releaseTimer = null;
            reconcileRendererForVisibility(entry);
        }, RENDERER_RELEASE_DELAY_MS);
    }

    // ─── Theme ───────────────────────────────────────────────────────────

    /**
     * Build xterm's theme from the panel's own CSS variables.
     *
     * terminals.html is the single source of truth for the palette, including the
     * per-theme overrides on body.theme-claudify / body.cyber-theme-enabled. Three
     * copies of these colours used to exist — the Terminal constructor, the
     * theme-change handler, and the CSS — so a fresh load rendered the terminal in
     * whatever the constructor hardcoded regardless of the active theme, and only a
     * manual theme toggle brought it into line.
     *
     * Read off <body>, not documentElement: the theme class lives there, and custom
     * properties inherit, so this picks up both the :root defaults and the
     * body-level overrides in one pass.
     */
    function buildTerminalTheme() {
        const cs = getComputedStyle(document.body);
        const pick = (name, fallback) => {
            const value = (cs.getPropertyValue(name) || '').trim();
            return value || fallback;
        };
        return {
            // Must stay opaque — see the .terminals-main note in terminals.html.
            background: pick('--term-surface', '#171717'),
            foreground: pick('--text-primary', '#e0e0e0'),
            cursor: pick('--accent-teal', '#00e5ff'),
            // The character UNDER a block cursor. xterm defaults this to #000000,
            // which is not this panel's surface — the inverted glyph read as a hole
            // punched in the pane. Track the surface so the caret reads as a filled
            // cell, not a gap. Verified present in all three renderers (DOM blink
            // CSS, addon-canvas cursorAccent.css, addon-webgl cursorAccent.rgba).
            cursorAccent: pick('--term-surface', '#171717'),
            selectionBackground: pick('--term-selection', 'rgba(0, 229, 255, 0.3)'),
        };
    }

    // ─── Server modes / paste identity ───────────────────────────────────

    /**
     * Force the terminal's DEC private modes to the gateway's recorded state.
     * Returns true when something was actually written.
     *
     * Written DIRECTLY to the parser, not via the rAF-batched write queue: that path
     * is billed to pendingAckChars via onWriteParsed, and synthetic characters the
     * server never credited would corrupt the backpressure ledger. DECSET/DECRST
     * sequences are short (7–8 bytes per mode), so the batching win is negligible.
     *
     * Owned by feature_plan_20260804173903_restore-terminal-dec-modes-on-reattach.md.
     * This module preserves the invariant; it does not re-derive it.
     */
    function applyServerModes(entry, modes) {
        if (!entry || entry.disposed || !entry.term || !modes) { return false; }
        let seq = '';
        for (const mode of REARMABLE_DEC_MODES) {
            const on = modes[mode];
            if (typeof on !== 'boolean') { continue; }
            seq += `\x1b[?${mode}${on ? 'h' : 'l'}`;
        }
        // Alt screen: NEITHER direction is written blind. `?1049h` into a freshly
        // built xterm switches it to an EMPTY alt buffer and hides the scrollback the
        // replay just wrote — a blank pane, worse than the bug.
        //
        // And `?1049l` is NOT inert. This is NOT an xterm.js quirk: XTerm's ctlseqs
        // defines `?1049l` as the composite of 1047 (buffer switch) + 1048 (cursor
        // restore), so DECRC is part of the sequence's DEFINITION — and real xterm,
        // iTerm2, Windows Terminal, Alacritty and VS Code all perform it too. In the
        // vendored bundle the arm is
        //   case 1049: … activateNormalBuffer(), 1049===param && this.restoreCursor()
        // where restoreCursor() sits OUTSIDE activateNormalBuffer's own
        // `_activeBuffer!==this._normal` guard, and on a fresh instance savedX/savedY
        // are 0 — so an unguarded write teleports the cursor to viewport row 0 col 0
        // and resets SGR, after which the next live chunk overwrites the top of the
        // scrollback this very replay just wrote.
        //
        // So the gate is a DELIBERATE DEVIATION from spec, justified because our write
        // is synthetic: a real app sending `?1049l` knows it saved a cursor, whereas we
        // are asserting a mode the app already believes is settled and have no saved
        // cursor worth restoring. Written ONLY when xterm is genuinely in the alt
        // buffer, where DECRC is both correct and expected. `term.buffer.active.type`
        // is documented public API since 4.0 (BufferApiView is constructed with the
        // literal "alternate").
        //
        // Do not "complete" this to a symmetric write, and do not drop the gate — the
        // unconditional form was evaluated against gate-and-omit and lost on both.
        let inAlt = false;
        try { inAlt = entry.term.buffer.active.type === 'alternate'; } catch { /* pre-open */ }
        if (modes[1049] === false && inAlt) { seq += '\x1b[?1049l'; }
        if (!seq) { return false; }
        try { entry.term.write(seq); } catch { return false; /* disposed between guard and write */ }
        return true;
    }

    /**
     * Terminal REPLIES (answerback), as distinct from operator keystrokes.
     *
     * xterm hands both to onData through the same channel with no provenance, so
     * during a scrollback replay — where the parser re-answers queries that were
     * live minutes ago — content is the only thing left to discriminate on.
     *
     * Derived from the `triggerDataEvent` call sites in @xterm/xterm 5.5 that do
     * NOT pass wasUserInput=true, not from guesswork:
     *
     *   \x1b]…         OSC replies: 10/11 colour, 4 palette, 52 clipboard
     *   \x1bP…         DCS replies: XTGETTCAP (P1+r/P0+r), DECRQSS (P1$r/P0$r)
     *                  and XTVERSION (P>|). Those three are the ONLY families
     *                  reaching xterm 5.5's DCS reply emitter, and its payload
     *                  always starts with `P`, so this bare anchor is complete.
     *   \x1b[?…c       DA1
     *   \x1b[>…c       DA2
     *   \x1b[…R        CPR / DECXCPR (cursor position report)
     *   \x1b[…n        DSR
     *   \x1b[…$y       DECRQM — mode 2026 (synchronized update) and 2004
     *                  (bracketed paste) are probed constantly by modern TUIs
     *
     * Deliberately NOT matched:
     *   \x1b[A-D, \x1b[H/F, \x1bO…, \x1b<char>, \x1b[3~   things a human presses
     *   \x1b[200~…\x1b[201~                               bracketed paste
     *   \x1b[<code>u                                      CSI u keystrokes
     *   \x1b[I / \x1b[O                                   focus reports — fired
     *       from the focus/blur handler, never from a parse, so replay cannot
     *       provoke them and suppressing them would break focus reporting
     *   \x1b[…t                                           XTWINOPS size reports
     *       are gated behind the `windowOptions` option, bundled default `{}`,
     *       never set here. Revisit this grammar if that changes.
     *   <n>c with no introducer                           only reachable on the
     *       termName==='linux' branch; termName is never set, so it is 'xterm'
     *   \x1b_… / \x1b^… / \x1bX…                          APC/PM/SOS: PM and SOS
     *       produce no output at all, and APC only fires for an addon-registered
     *       handler (addon-image); neither uses the DCS reply emitter
     *
     * Eating one keystroke would be a worse bug than the one this exists to fix,
     * which is why finals are enumerated instead of using a class like [a-zA-Z].
     *
     * KNOWN COLLISION, accepted deliberately: modified F1–F4. xterm emits
     * `ESC [ 1 ; <mod+1> P|Q|R|S` for those (Keyboard.ts `case 112`–`115`), so
     * Shift/Ctrl/Alt-F3 IS the byte-for-byte string `ESC [ 1 ; 2 R` — which is
     * also a perfectly legal CPR reply (cursor at row 1, column 2). Content
     * cannot separate them; the protocol overloads the shape. Excluding
     * `ESC [ 1 ; <n> R` would let a genuine row-1 CPR reply through and put
     * `1;2R` back at the operator's prompt, i.e. reintroduce the reported bug for
     * a real reply shape. Dropping the keystroke instead is the smaller harm: it
     * costs one press of one rare key, only inside the sub-frame replay parse.
     * The zero-keystroke-risk alternative is the parser-handler fallback
     * documented in this plan — reach for it if this ever bites in practice.
     */
    const ANSWERBACK_RE = /^(?:\x1b\][\s\S]*|\x1bP[\s\S]*|\x1b\[[?>]?[0-9;]*(?:[cnR]|\$y))$/;

    function isAnswerback(data) {
        return ANSWERBACK_RE.test(data);
    }

    const PASTE_SCAN_MIN_CHARS = 200;
    const PASTE_CARRY_MAX_CHARS = 2048;

    function extractPastedDispatchIdentity(text) {
        if (text.length < PASTE_SCAN_MIN_CHARS) { return null; }
        // Strip bracketed-paste wrappers so the pasted body can be scanned cleanly.
        const stripped = text
            .replace(/\x1b\[200~|\x1b\[201~/g, '')
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (!stripped.includes('PLANS TO PROCESS:')) { return null; }
        if (stripped.includes('PLANS TO DISCUSS:')) { return null; } // consultation prompt, not dispatch

        const planIds = [];
        let m;
        const idRe = /\bPLAN_ID=([0-9a-fA-F-]{8,})/g;   // UUIDs, not \d+
        while ((m = idRe.exec(stripped)) !== null) { planIds.push(m[1]); }

        const planFiles = [];
        const fileRe = /Plan File:\s+(\S+)/g;
        while ((m = fileRe.exec(stripped)) !== null) { planFiles.push(m[1]); }

        if (planIds.length === 0 && planFiles.length === 0) { return null; }
        return { planIds, planFiles };
    }

    // ─── Write batching / replay ─────────────────────────────────────────

    function scheduleBatchFlush(entry) {
        if (!entry) return;
        deps.bumpStartupCurtain(entry.name);
        pendingBatchEntries.add(entry);
        if (!sharedBatchRafId) {
            sharedBatchRafId = requestAnimationFrame(() => {
                sharedBatchRafId = null;
                drainAllBatches();
            });
        }
        if (!sharedBatchFallbackTimer) {
            sharedBatchFallbackTimer = setTimeout(() => {
                sharedBatchFallbackTimer = null;
                drainAllBatches();
            }, BATCH_FALLBACK_MS);
        }
    }

    function drainAllBatches() {
        if (sharedBatchFallbackTimer) {
            clearTimeout(sharedBatchFallbackTimer);
            sharedBatchFallbackTimer = null;
        }
        if (pendingBatchEntries.size === 0) return;
        const entries = Array.from(pendingBatchEntries);
        pendingBatchEntries.clear();
        for (const entry of entries) {
            flushBatch(entry);
        }
    }

    function flushBatch(entry) {
        // `disposed`, NOT `exited`. They are different conditions and conflating them
        // loses data: `exited` means the PROCESS ended, and the gateway deliberately
        // drains its coalescing window before announcing the exit — so the exit frame
        // routinely lands while that final output is still queued here, waiting on the
        // shared rAF. Guarding on `exited` threw those last lines away, which is
        // exactly the output an operator opens a dead terminal to read. `disposed`
        // means the VIEW is gone (term.dispose() called), which is the only state in
        // which writing is actually unsafe.
        // `suspended` — a status pane's socket is closed; any batch queued before the
        // suspend landed is stale (the replay on resume supersedes it).
        if (!entry || entry.disposed || entry.suspended || !entry.term) { return; }
        if (entry.batchQueue.length === 0) { return; }
        const combined = entry.batchQueue.join('');
        entry.batchQueue = [];
        try {
            entry.term.write(combined, () => onWriteParsed(entry, combined.length));
        } catch (err) {
            entry.writeThrowCount = (entry.writeThrowCount || 0) + 1;
            console.error(`[Terminals] term.write failed for terminal ${entry.name}:`, err);
        }
    }

    /**
     * Write the gateway's scrollback replay with answerback muted.
     *
     * The flag is cleared in the write callback rather than on the next line
     * because WriteBuffer._innerWrite parses each queued item in a single action
     * and fires that item's callback before parsing the next one. So the callback
     * is exactly the boundary at which the replay has been fully consumed and no
     * live chunk has been parsed yet — clear it earlier and the tail of the replay
     * still answers; clear it later and a live query goes unanswered.
     *
     * Cleared on the throw path too — a stuck flag would mute the terminal's live
     * replies for the rest of the session.
     */
    function writeReplay(entry, text) {
        if (!entry || entry.disposed || !entry.term) { return; }
        entry.suppressAnswerback = true;
        try {
            entry.term.write(text, () => {
                entry.suppressAnswerback = false;
                // The replay has been fully parsed and no live chunk has been parsed
                // yet (WriteBuffer._innerWrite fires each item's callback before
                // starting the next), so this is the exact boundary at which the
                // recorded mode state must overwrite whatever the replay left set.
                if (entry.pendingModes) {
                    applyServerModes(entry, entry.pendingModes);
                    entry.pendingModes = null;
                }
                onWriteParsed(entry, text.length);
            });
        } catch (err) {
            entry.suppressAnswerback = false;
            entry.pendingModes = null;
            entry.writeThrowCount = (entry.writeThrowCount || 0) + 1;
            console.error(`[Terminals] replay write failed for terminal ${entry.name}:`, err);
        }
    }

    function onWriteParsed(entry, length) {
        if (!entry || entry.disposed) return;
        entry.bytesWritten = (entry.bytesWritten || 0) + length;

        // Replay is not on the server's credit ledger for this connection (see
        // setupClient in terminalWsGateway.ts), so acking it would pay down credit
        // we never consumed and switch backpressure off for the first stretch of
        // live output after every reconnect. The server tells us how much to skip
        // in the hello frame; burn that budget before acking anything.
        if (entry.ackSuppressChars > 0) {
            const skipped = Math.min(entry.ackSuppressChars, length);
            entry.ackSuppressChars -= skipped;
            length -= skipped;
            if (length === 0) { return; }
        }

        entry.pendingAckChars = (entry.pendingAckChars || 0) + length;
        if (entry.pendingAckChars >= ACK_CHUNK_CHARS) {
            const toAck = entry.pendingAckChars;
            entry.pendingAckChars = 0;
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                try {
                    entry.ws.send(JSON.stringify({ t: 'ack', chars: toAck }));
                } catch { /* ignore */ }
            }
        }
    }

    // ─── View lifecycle: create / materialize / destroy ─────────────────

    function destroyTerminalView(name) {
        deps.cancelDetachTimer(name);
        deps.fitLadderGen.delete(name);
        deps.clearWorkingSilence(name);
        const entry = deps.terminalsMap.get(name);
        if (!entry) { return; }
        entry.disposed = true;
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        cancelRendererRelease(entry);
        pendingBatchEntries.delete(entry);
        entry.exited = true;
        entry.pendingAttribution = null;
        if (entry.ws) {
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }
        if (entry.resizeObserver) {
            try { entry.resizeObserver.disconnect(); } catch { /* ignore */ }
        }
        // A view unassigned before it was ever rendered still has its deferred-build
        // observer attached; without this it keeps the entry (and its container) alive.
        if (entry.pendingObserver) {
            try { entry.pendingObserver.disconnect(); } catch { /* ignore */ }
            entry.pendingObserver = null;
        }
        // Before term.dispose(): the GPU renderers hold a WebGL context / canvas
        // that browsers cap per RENDERER PROCESS (~16 contexts), shared with every
        // same-origin document in it, including a popped-out second panel — so
        // leaking one per closed terminal eventually forces every terminal back
        // to the DOM renderer.
        if (entry.rendererAddon) {
            entry.rendererAddon.release();   // BEFORE the try and BEFORE dispose — see swapRenderer
            try {
                if (entry.rendererAddon.current) { entry.rendererAddon.current.dispose(); }
            } catch { /* ignore */ }
            entry.rendererAddon.current = null;
        }
        if (entry.term) {
            try { entry.term.dispose(); } catch { /* ignore */ }
        }
        // Not an xterm disposable — term.dispose() will not remove it, and the
        // viewport element outlives this call only through these two fields.
        if (entry.jumpViewport && entry.jumpScrollHandler) {
            try { entry.jumpViewport.removeEventListener('scroll', entry.jumpScrollHandler); } catch { /* ignore */ }
        }
        entry.jumpViewport = null;
        entry.jumpScrollHandler = null;
        if (entry.scrollDisposable) {
            try { entry.scrollDisposable.dispose(); } catch { /* ignore */ }
            entry.scrollDisposable = null;
        }
        entry.jumpBtn = null;
        if (entry.container && entry.container.parentNode) {
            try { entry.container.parentNode.removeChild(entry.container); } catch { /* ignore */ }
        }
        deps.terminalsMap.delete(name);
    }

    function createTerminalView(name, targetContainer) {
        const container = document.createElement('div');
        container.className = 'terminal-view-host active';
        targetContainer.appendChild(container);

        if (typeof window.Terminal === 'undefined') {
            console.warn('[Terminals] xterm.js library not loaded');
            return;
        }

        // Claim the name now so renderPaneGrid does not build a second view for it,
        // but build nothing else until the pane has a real box. A terminal
        // constructed into a zero-size document is stuck at 80x24 (see isRendered)
        // and its socket would report that size to the shared pty. Deferring also
        // keeps hidden panels from parsing pty output nobody is looking at — the
        // gateway's replay ring is what covers the gap, which is the same mechanism
        // an unassign/re-assign cycle already relies on.
        const entry = {
            name,
            container,
            term: null,
            fitAddon: null,
            rendererAddon: null,
            rendererDeferred: false,
            releaseTimer: null,
            isWebgl: false,
            sizeVoteActive: false,
            ws: null,
            lastSeq: 0,
            batchQueue: [],
            pendingAckChars: 0,
            ackSuppressChars: 0,
            bytesWritten: 0,
            writeThrowCount: 0,
            largestInputDataLen: 0,
            totalInputChars: 0,
            reconnectTimer: null,
            reconnectDelay: 500,
            resizeObserver: null,
            pendingObserver: null,
            scrollDisposable: null,
            jumpBtn: null,
            jumpViewport: null,
            jumpScrollHandler: null,
            exited: false,
            disposed: false,
            suspended: false,
            suppressAnswerback: false,
            awaitingReplayFrame: false,
            pendingModes: null,
            inputThrottled: false,
            queuedBytes: 0,
            replayGap: false,
            // "Working, no output" signal — see updateWorkingSilence / renderWorkingSilence.
            // lastPrintableAt: wall-clock of the last LIVE frame carrying a printable glyph.
            // lastFrameAt: wall-clock of the last LIVE frame of ANY kind (heartbeat included).
            // Both are stamped only on live (non-replay) frames, so a reattach's replay burst
            // firstFrameAt: wall-clock of the FIRST live frame — the silence clock's origin
            // for a seat that has never printed a glyph, which is exactly the measured devin
            // lead. lastFrameAt cannot serve as that origin: the heartbeat restamps it 12x a
            // second, so `now - lastFrameAt` is always ~0 and the signal could never fire for
            // the one seat it exists to describe.
            // Both are stamped only on live (non-replay) frames, so a reattach's replay burst
            // cannot arm the signal. 0 means "no live frame yet" — the signal cannot fire
            // until a live frame has established the pane is actually streaming.
            lastPrintableAt: 0,
            lastFrameAt: 0,
            firstFrameAt: 0,
            // LRU basis for the WebGL budget eviction (see evictLeastRecentlyVisibleHiddenWebgl).
            // Stamped on every observed hasBox transition in reconcileRendererForVisibility
            // and on a successful acquire in attachRenderer; a pane that is currently
            // visible is NEVER an eviction candidate, so this only orders HIDDEN panes.
            lastVisibleAt: 0,
            // #3 (do not reflow panes nobody can see): the fitLadderGen value this
            // entry's ResizeObserver last saw. When batchFitVisiblePanes bumps the
            // gen (per switch), the observer skips its own startFitLadder call —
            // the switch already started one.
            lastObservedFitGen: 0
        };
        deps.terminalsMap.set(name, entry);
        whenRendered(entry, () => materializeTerminalView(entry));
    }

    /**
     * Invoke `cb` once the entry's container has a non-zero box.
     *
     * Two separate reasons it may not have one yet, and a ResizeObserver covers both:
     * renderPaneGrid builds each pane bottom-up and only appends it to the grid
     * afterwards, so the container is still detached at createTerminalView time; and
     * the whole panel may sit in a display:none iframe for the entire session until
     * the operator clicks the Terminals icon.
     */
    function whenRendered(entry, cb) {
        if (entry.disposed) { return; }
        if (isRendered(entry.container)) { cb(); return; }
        const observer = new ResizeObserver(() => {
            if (entry.disposed || !isRendered(entry.container)) { return; }
            observer.disconnect();
            entry.pendingObserver = null;
            cb();
        });
        observer.observe(entry.container);
        entry.pendingObserver = observer;
    }

    /** Build the xterm instance, renderer and socket. Only ever called on a rendered
     *  container — see createTerminalView. */
    function materializeTerminalView(entry) {
        if (entry.disposed || entry.term) { return; }
        const container = entry.container;

        const term = new window.Terminal({
            cursorBlink: true,
            // The caret is the only PER-CELL signal for "this pane has focus", and
            // xterm's default here is 'outline' — a hairline weight change that is
            // invisible at fontSize 13 in a 9-pane grid. 'none' turns it into a
            // real state change: exactly one pane in the grid shows a caret at all,
            // and that pane is the one taking keystrokes.
            //
            // Honoured by all three renderers: the DOM renderer's style switch has
            // no 'none' case so it emits no cursor class; addon-canvas guards with
            // `"none" !== t`; addon-webgl matches the style string against the four
            // drawn styles and falls through. Do not "tidy" this back to the
            // default value — it IS the fix, not documentation of the default.
            cursorInactiveStyle: 'none',
            fontSize: 13,
            fontFamily: resolveMonoFont(),
            theme: buildTerminalTheme(),
            // Explicit, not xterm's implicit default, because it is now load-bearing:
            // a view disposed on unassign re-attaches by replaying the gateway's
            // MAX_SCROLLBACK_BYTES ring (256 KB ≈ 3000 lines at 80 cols). Keeping the
            // client below that means disposal can never lose scrollback the operator
            // could still have scrolled to. Change the two together.
            scrollback: 1000,
            // Option-drag selects even while an app is capturing the mouse. xterm's
            // shouldForceSelection() has a Mac branch gated entirely on this option,
            // and the bundled default is FALSE — so without it there is no modifier
            // that can select text in a mouse-reporting app on macOS, which is the
            // platform this panel runs on. Matches iTerm and VS Code.
            macOptionClickForcesSelection: true,
        });

        let fitAddon = null;
        if (window.FitAddon && window.FitAddon.FitAddon) {
            fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);
        }

        entry.term = term;
        entry.fitAddon = fitAddon;

        term.open(container);
        // Intercept image paste: if the clipboard has an image, upload it to the
        // server as raw binary, which writes it to a temp file and injects the
        // file path into the PTY. Text paste falls through to xterm's native
        // handler. capture: true — intercept before xterm's own paste handler.
        // Only the four formats the Anthropic API accepts — intercepting
        // image/bmp or image/svg+xml would inject a file the API rejects, and a
        // rejected image poisons the Claude Code session.
        const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        container.addEventListener('paste', async (e) => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) { return; }
            let imageItem = null;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type && SUPPORTED_IMAGE_TYPES.includes(items[i].type)) {
                    imageItem = items[i];
                    break;
                }
            }
            if (!imageItem) { return; } // no supported image — let xterm handle text paste

            e.preventDefault();
            e.stopPropagation();

            const file = imageItem.getAsFile();
            if (!file) { return; }

            // Size guard (4 MB raw — server enforces the same ceiling; the
            // Anthropic API hard-rejects images over 5 MB and Claude Code does
            // not strip the failed payload, bricking the session until /clear).
            if (file.size > 4 * 1024 * 1024) {
                deps.showPaneToast('Image too large (max 4 MB)');
                return;
            }

            deps.showPaneToast('Pasting image...');
            try {
                const arrayBuffer = await file.arrayBuffer();
                const params = new URLSearchParams({
                    name: entry.name,
                    mimeType: file.type || 'image/png'
                });
                const res = await fetch('/terminals/verb/ptyPasteImage?' + params.toString(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: arrayBuffer
                });
                const data = await res.json();
                if (!data.success) {
                    deps.showPaneToast('Image paste failed: ' + (data.error || 'unknown error'));
                }
                // On success, the file path is already injected into the PTY by
                // the server. The path appears on the terminal input line; user
                // presses Enter to submit.
            } catch (err) {
                deps.showPaneToast('Image paste failed: ' + (err.message || String(err)));
            }
        }, true);
        entry.rendererAddon = attachRenderer(term, entry);
        attachJumpToLatest(entry, term, container);
        if (fitAddon) {
            try { fitAddon.fit(); } catch { /* ignore */ }
        }
        // Shift-wheel always scrolls the viewport, even while an app is capturing the
        // wheel (1000/1002/1003 all set the WHEEL bit, so a plain wheel is reported to
        // the app instead of scrolling).
        //
        // Returning false is NOT sufficient on its own, and that difference is why this
        // is not a one-liner. xterm installs TWO wheel listeners and both consult
        // _customWheelEventHandler first, but they differ in what runs AFTER it:
        //
        //   mouse reporting OFF — the viewport listener is
        //     `e => { if (custom(e) === false) return false; … viewport.handleWheel(e) … }`
        //   so a false return leaves before any cancel() and the browser's own scroll on
        //   .xterm-viewport proceeds untouched.
        //
        //   mouse reporting ON — the mouse-report listener is
        //     `e => (report(e), this.cancel(e, true))`
        //   registered `{passive: false}`, and `cancel(e, t)` is
        //     `if (this.options.cancelEvents || t) return e.preventDefault(), e.stopPropagation(), false`
        //   with t hard-coded true. So cancel runs UNCONDITIONALLY: a false return
        //   suppresses the mouse REPORT but NOT the preventDefault, and native scroll is
        //   dead in exactly the state this bypass exists for.
        //
        // So in the mouse-reporting state we scroll the viewport ourselves. The state
        // read is xterm's own public `enable-mouse-events` class on term.element —
        // written on the same statement as the SelectionService toggle, so it cannot
        // drift from which listener is actually installed. Do NOT scroll in both
        // branches: with mouse reporting off nothing prevents the default, so a manual
        // scroll would land on top of the browser's and double the distance.
        if (typeof term.attachCustomWheelEventHandler === 'function') {
            term.attachCustomWheelEventHandler((ev) => {
                if (!ev.shiftKey) { return true; }
                // deltaX because the OS/browser rewrites shift+vertical-wheel to a
                // horizontal delta on several platforms; xterm's own getLinesScrolled
                // reads deltaY only, which is part of why that path is not reusable here.
                const delta = ev.deltaY || ev.deltaX;
                if (!delta || !term.element || !term.element.classList.contains('enable-mouse-events')) {
                    return false;
                }
                try {
                    if (ev.deltaMode === 0) {
                        // DOM_DELTA_PIXEL — the common case. .xterm-viewport is the element
                        // the browser and xterm's own scrollbar both drive, and its scroll
                        // listener syncs the buffer, so a pixel delta needs no row-height
                        // guess.
                        const viewport = term.element.querySelector('.xterm-viewport');
                        if (viewport) { viewport.scrollTop += delta; }
                    } else {
                        // DOM_DELTA_LINE (1) / DOM_DELTA_PAGE (2). Both public calls run
                        // xterm's _verifyIntegers, so the amount must be a whole number,
                        // and it must never round to 0 or the gesture is swallowed.
                        const amount = delta > 0 ? Math.max(1, Math.round(delta)) : Math.min(-1, Math.round(delta));
                        if (ev.deltaMode === 2) { term.scrollPages(amount); } else { term.scrollLines(amount); }
                    }
                } catch { /* disposed mid-gesture, or a vendor bundle without scrollLines */ }
                return false;
            });
        }

        // Keyboard clipboard bindings (Ctrl+Shift+C/V, Ctrl+Insert/Shift+Insert) for
        // platforms with no free modifier (Linux, Windows). macOS uses Cmd+C / Cmd+V
        // natively via the browser and must NEVER be intercepted (metaKey chords
        // return true untouched). Ctrl+C strictly sends SIGINT and is never intercepted here.
        if (typeof term.attachCustomKeyEventHandler === 'function') {
            term.attachCustomKeyEventHandler((ev) => {
                // macOS keeps working natively through Cmd+C / Cmd+V: never intercept metaKey.
                if (ev.metaKey) { return true; }

                const isCopy = (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') ||
                    (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.code === 'Insert' || ev.key === 'Insert'));

                const isPaste = (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') ||
                    (!ev.ctrlKey && ev.shiftKey && !ev.altKey && (ev.code === 'Insert' || ev.key === 'Insert'));

                if (!isCopy && !isPaste) {
                    return true;
                }

                // Handle on keydown only to avoid double-firing with keyup/keypress.
                if (ev.type === 'keydown') {
                    if (isCopy) {
                        const selection = term.getSelection();
                        // Guard against destroying existing clipboard content with an empty selection.
                        if (selection && selection.length > 0) {
                            if (typeof window !== 'undefined' && typeof window.sbCopyToClipboard === 'function') {
                                window.sbCopyToClipboard(selection);
                            } else if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(selection).catch(() => {});
                            }
                            if (deps.showPaneToast) {
                                deps.showPaneToast('Copied to clipboard');
                            }
                        }
                    } else if (isPaste) {
                        // Context-dependent paste: instant paste in secure contexts via Clipboard API,
                        // or open the visible paste control in insecure contexts (where script cannot read clipboard).
                        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                            navigator.clipboard.readText().then((text) => {
                                if (text && !entry.disposed && entry.term) {
                                    entry.term.paste(text);
                                }
                            }).catch(() => {
                                delegateToPasteControl();
                            });
                        } else {
                            delegateToPasteControl();
                        }
                    }
                }

                function delegateToPasteControl() {
                    const paneIndex = deps.getPaneAssignments ? deps.getPaneAssignments().indexOf(entry.name) : -1;
                    if (typeof window !== 'undefined' && typeof window.sbOpenTerminalPaste === 'function' && paneIndex !== -1) {
                        window.sbOpenTerminalPaste(paneIndex);
                    } else if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('sb:open-paste', {
                            detail: { paneId: paneIndex !== -1 ? paneIndex : entry.name, paneIndex }
                        }));
                    } else {
                        // Fallback status message in buffer if paste control is unreachable
                        try {
                            entry.term.write('\r\n[Paste: use the Paste button — clipboard API unavailable]\r\n');
                        } catch { /* ignore */ }
                    }
                }

                // Suppress browser and xterm default handling for the intercepted chord.
                if (typeof ev.preventDefault === 'function') {
                    ev.preventDefault();
                }
                return false;
            });
        }

        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            // Per-entry churn probe (Proposed Change #4): counts ONLY this
            // terminal's observer, never the global ResizeObserver the plan's
            // original 33-callback figure was taken with. The 100 ms debounce
            // collapses a burst into one callback, so this counts SETTLED
            // reflow decisions, not raw ResizeObserver firings — which is the
            // unit the plan's coalescing (Proposed Change #3) should be sized to.
            recordChurnResize(entry);
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // The box collapsed — Peek hiding a sibling pane, or the pane losing
                // its assignment. Withdraw before returning, or the gateway keeps
                // clamping the shared pty to a viewport nobody can see.
                if (!isRendered(entry.container)) {
                    releaseSizeVote(entry);
                    // #1 (re-box must not release): a terminal still SEATED
                    // (assigned to a rendered, non-status slot) whose container
                    // transiently measures 0x0 during a grid reflow must NOT arm
                    // a renderer release. The box will return; arming here races
                    // the next switch and is the 9/9 churn this plan stops. The
                    // panelVisibility hide path (terminals.js) arms releases for
                    // ALL terminals regardless of seating — that is the genuine-
                    // hide path and is unaffected by this guard, which only
                    // short-circuits the per-pane observer's transient-0x0 arm.
                    // A terminal that genuinely left the fleet (unassigned, or
                    // assigned to a status pane) is NOT seated, so the arm fires
                    // as before.
                    const seated = deps.isTerminalSeated ? deps.isTerminalSeated(entry.name) : false;
                    if (!seated) { armRendererRelease(entry); }
                    return;
                }
                // Re-cast BEFORE the ladder: a pane restored at its previous size
                // inspects as 'ok' and the ladder reports nothing.
                cancelRendererRelease(entry);
                ensureSizeVote(entry);
                // BEFORE the fit ladder: the ladder inspects the PAINTED grid via
                // readRenderedGrid, and running it across a renderer swap would have
                // it measure a surface that is about to be replaced.
                reconcileRendererForVisibility(entry);
                // #3 (do not reflow panes nobody can see): coalesce per switch.
                // batchFitVisiblePanes (called after every renderPaneGrid) already
                // started a fit ladder for this terminal, bumping fitLadderGen.
                // If the gen changed since this observer last fired, the switch
                // already handled the reflow and this observer's ladder is
                // redundant — skip it. This extends the existing fitLadderGen
                // guard (which collapses rapid minimize/restore cycles per
                // terminal) to also collapse the per-switch burst across panes,
                // rather than adding a second mechanism. The reconcile and size
                // vote above still run — only the ladder is skipped.
                const fitGen = deps.fitLadderGen ? (deps.fitLadderGen.get(entry.name) || 0) : 0;
                if (fitGen !== entry.lastObservedFitGen) {
                    entry.lastObservedFitGen = fitGen;
                    if (entry.container.classList.contains('active')) {
                        deps.startFitLadder(entry.name);
                    }
                }
            }, 100);
        });
        resizeObserver.observe(container);
        entry.resizeObserver = resizeObserver;

        // The caret ring is driven from xterm's OWN focus state, not from
        // `focusedPaneIndex`. `.focused` is pane SELECTION — it is set on pane 0
        // at first paint and is never cleared when the document loses focus, so
        // it cannot answer "will my keystrokes land here?".
        //
        // Resolve the pane element inside the handler, never at wire-up time:
        // updatePaneElement reparents this container whenever the slot's
        // assignment changes, so a captured reference goes stale on the first
        // reassignment. closest() reads the live tree.
        //
        // `term.textarea`, NOT `term.onFocus`/`term.onBlur`. Those two emitters exist only
        // on the INTERNAL CoreTerminal subclass in the vendored bundle — the public
        // `Terminal` this file constructs has no focus pair, so the call threw
        // `TypeError: term.onFocus is not a function` from the middle of this builder, and
        // connectTerminalSocket() is BELOW here, so the throw took the WebSocket with it:
        // every pane rendered a blank xterm and read `connecting` forever. The helper
        // textarea is the node that actually holds the caret; `term.open()` above created
        // it. `test:contract:panel-runtime-surface` fails the build if this file ever
        // subscribes to an event the vendored public class does not expose, which is why
        // there is no guard here — a guard would only turn that build failure into a
        // silent one.
        term.textarea.addEventListener('focus', () => {
            deps.clearCaretRing();
            const paneEl = entry.container.closest('.terminal-pane');
            if (paneEl) { paneEl.classList.add('has-caret'); }
        });
        // Clear ALL panes, not the one that blurred. For the blurs that DO fire —
        // sidebar click, pane-header button, sibling iframe, window blur —
        // closest() may resolve to an outgoing node, so a sweep is the only form
        // correct in every case. Idempotent and O(panes); a grid is nine elements.
        //
        // These two handlers are NOT sufficient on their own. Chromium fires no
        // blur when a focused node is detached, and renderPaneGrid reconciles the
        // grid IN PLACE — pane elements are reused, so a class stranded by a
        // detached container survives on a live element instead of dying with a
        // discarded one. renderPaneGrid's tail carries the matching sweep; see the
        // note there.
        term.textarea.addEventListener('blur', () => deps.clearCaretRing());

        term.onData((data) => {
            // Scrollback replay re-parses queries the CLI emitted while this view
            // did not exist, and xterm answers them as if they were live. Those
            // replies land at the CLI's prompt as typed text — the
            // `10;rgb:e0e0/e0e0/e0e011;rgb:1717/1717/1717` an operator sees on
            // every pane swap. Muted for the replay parse only; live queries are
            // still answered, because the CLI needs the colour reply to pick its
            // palette. Content-filtered so a keystroke racing the socket open is
            // never swallowed.
            if (entry.suppressAnswerback && isAnswerback(data)) {
                return;
            }

            // Paste attribution: a copied dispatch prompt carries its own identity.
            // Arm on the paste body, then commit on a later chunk that contains the
            // submit Enter (the arming chunk's own newlines are never the commit).
            let armingThisChunk = false;
            if (data.length >= PASTE_SCAN_MIN_CHARS) {
                const identity = extractPastedDispatchIdentity(data);
                if (identity) {
                    const role = deps.getFleetList().find(t => t.friendlyName === entry.name)?.role || '';
                    entry.pendingAttribution = { ...identity, terminalName: entry.name, role, skipCommit: true };
                    armingThisChunk = true;
                }
            }

            if (entry.pendingAttribution) {
                if (!entry.pendingAttribution.skipCommit && /[\r\n]/.test(data)) {
                    const { terminalName, role, planIds, planFiles } = entry.pendingAttribution;
                    entry.pendingAttribution = null;
                    fetch('/kanban/verb/attributePastedPrompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ terminalName, role, planIds, planFiles })
                    }).catch(err => {
                        console.warn('[Terminals] attributePastedPrompt failed:', err);
                    });
                } else {
                    entry.pendingAttribution.skipCommit = false;
                    if (!armingThisChunk) {
                        entry.pendingAttribution.carry = (entry.pendingAttribution.carry || '') + data;
                        if (entry.pendingAttribution.carry.length > PASTE_CARRY_MAX_CHARS) {
                            entry.pendingAttribution.carry = entry.pendingAttribution.carry.slice(-PASTE_CARRY_MAX_CHARS);
                        }
                        if (entry.pendingAttribution.carry.length >= PASTE_SCAN_MIN_CHARS) {
                            const carried = entry.pendingAttribution.carry;
                            const identity = extractPastedDispatchIdentity(carried);
                            if (identity) {
                                const role = deps.getFleetList().find(t => t.friendlyName === entry.name)?.role || '';
                                entry.pendingAttribution = { ...identity, terminalName: entry.name, role, carry: '', skipCommit: true };
                            }
                        }
                    }
                }
            }

            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                if (!entry.largestInputDataLen) entry.largestInputDataLen = 0;
                if (data.length > entry.largestInputDataLen) entry.largestInputDataLen = data.length;
                entry.totalInputChars = (entry.totalInputChars || 0) + data.length;
                entry.ws.send(encodeInputFrame(data));
            } else {
                // The socket is CONNECTING, in reconnect backoff, or CLOSED. This
                // branch used to be an implicit no-op: the keystroke evaporated
                // with no echo, no log and no chrome change, which is the whole
                // "is input even possible?" complaint.
                //
                // Deliberately NOT queued. Replaying stale keystrokes into a shell
                // after a reconnect can complete a half-typed command with a stray
                // \r. Report, discard, move on.
                deps.notifyInputDropped(entry);
            }
        });

        connectTerminalSocket(entry);

        // A view is built lazily (whenRendered), so a locate/assign that triggered
        // this construction has already run its focus attempt against a null term.
        // Pick the caret up here if this terminal landed in the focused pane.
        if (deps.getPaneAssignments()[deps.getFocusedPaneIndex()] === entry.name) {
            deps.focusPaneTerminal(deps.getFocusedPaneIndex());
        }
    }

    /**
     * A pinned "jump to latest" pill for a pane that is scrolled off the bottom.
     *
     * xterm only auto-follows new output while the viewport is already at the
     * bottom, so an operator who scrolled up inside a long agent conversation
     * stays parked there with no signal that output is still arriving. The
     * scrollbar is the only other way back, and even widened it is a 12px bar
     * inset 8px from the pane edge — a poor primary control at 2x2 and denser.
     *
     * TWO event sources, and BOTH are required:
     *  - The viewport's native `scroll` event covers the OPERATOR scrolling
     *    (wheel, thumb drag, keyboard). term.onScroll does NOT fire for these:
     *    Viewport._handleScroll emits onRequestScrollLines with
     *    suppressScrollEvent:true, and Terminal.scrollLines handles source
     *    VIEWPORT by calling refresh(0, rows-1) itself, so
     *    BufferService.scrollLines skips _onScroll.fire entirely.
     *  - term.onScroll covers NEW OUTPUT advancing baseY while the operator stays
     *    parked. BufferService.scroll() fires it unconditionally, and that path
     *    mutates no scrollTop, so it never produces a DOM scroll event.
     * Drop either one and the pill is silently wrong in a case the operator hits
     * on first use: onScroll-only never appears in an idle terminal, DOM-only
     * never updates its count as output arrives.
     */
    function attachJumpToLatest(entry, term, container) {
        const btn = document.createElement('button');
        btn.className = 'jump-to-latest';
        btn.type = 'button';
        // The terminal owns the keyboard. A tabbable button inside the pane would
        // put a stop between the operator and the pty for a control they reach by
        // pointer anyway.
        btn.tabIndex = -1;
        btn.title = 'Scroll to the latest output';
        btn.setAttribute('aria-label', 'Scroll to the latest output');
        btn.textContent = '↓ latest';
        container.appendChild(btn);
        entry.jumpBtn = btn;

        // Cached so a firehose does not rewrite textContent on every flush. Starts
        // at -1 so the first call always paints.
        let lastBehind = -1;
        const update = () => {
            if (entry.disposed || !entry.term) { return; }
            let behind = 0;
            try {
                const buf = term.buffer.active;
                behind = Math.max(0, buf.baseY - buf.viewportY);
            } catch { return; }
            if (behind === lastBehind) { return; }
            lastBehind = behind;
            btn.classList.toggle('visible', behind > 0);
            btn.textContent = behind > 0 ? `↓ latest (${behind})` : '↓ latest';
        };

        // click, NOT mousedown: the pane's own mousedown handler must run first so
        // the press also selects the pane (see renderPaneGrid). stopPropagation
        // keeps the click from being read a second time as a click into the
        // terminal body.
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                term.scrollToBottom();
                term.focus();
            } catch { /* term disposed mid-click */ }
            update();
        });

        // term.element exists: this runs after term.open(container).
        const viewport = term.element && term.element.querySelector('.xterm-viewport');
        if (viewport) {
            viewport.addEventListener('scroll', update, { passive: true });
            // Retained for teardown — a DOM listener is not an xterm disposable and
            // term.dispose() will not remove it.
            entry.jumpViewport = viewport;
            entry.jumpScrollHandler = update;
        }
        entry.scrollDisposable = term.onScroll(update);
        update();
    }

    // ─── WebSocket stream ────────────────────────────────────────────────

    /**
     * Suspend a terminal's live socket while keeping its xterm buffer intact.
     *
     * Called exclusively from the reconcile's trailing loop when
     * `isTerminalRendered(name)` is false — the terminal is not on a rendered
     * pane (narrowed out, parked off-screen, or toggled to status). The
     * WebSocket is closed (keeping lastSeq for a clean resume), the renderer is
     * released (freeing a WebGL context slot), and batch processing stops.
     * entry.term and its scrollback survive so a 3x3 -> 1 -> 3x3 round trip is
     * instant — the replay ring fills any gap.
     */
    function suspendTerminalStream(entry) {
        if (!entry || entry.disposed) { return; }
        if (entry.suspended) { return; }
        entry.suspended = true;
        // Stop accepting new batches — the rAF drainer skips suspended entries.
        // The QUEUE itself is dropped, not merely left unflushed: flushBatch's
        // suspended guard returns without clearing, so anything still queued would
        // survive the suspension and be written AFTER the resume's replay — which
        // already contains those same bytes. Skipping is not discarding.
        pendingBatchEntries.delete(entry);
        entry.batchQueue = [];
        // Withdraw the size vote BEFORE closing the socket: releaseSizeVote sends
        // a resize frame on the OPEN socket, and closing first would make it a
        // no-op. The gateway's client.reportedSize is sticky, so a vote left
        // standing clamps the shared pty until the socket closes on its own.
        releaseSizeVote(entry);
        // Close the socket but keep lastSeq — the resume reconnects with
        // ?lastSeq=<entry.lastSeq> and the replay ring fills the gap.
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        if (entry.ws) {
            try { entry.ws.onclose = null; } catch { /* ignore */ }
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }
        // Release the renderer — a status pane paints no terminal pixels, and a
        // WebGL context held by an invisible surface is one the visible panes
        // cannot get. entry.term is NOT disposed; its buffer survives.
        //
        // #1 (re-box must not release): SKIP the renderer release when the
        // terminal is still SEATED (assigned to a rendered, non-status slot).
        // The reconcile trailing loop calls suspend when isTerminalRendered is
        // false, and during a grid reflow a container can transiently measure
        // 0x0 — making isTerminalRendered false even though the terminal has
        // not left the fleet. Releasing the renderer on that transient 0x0 and
        // re-acquiring it when the box returns is the 9/9 acquire/release churn
        // this plan exists to stop. The stream still suspends (socket closes,
        // size vote withdrawn) — the gateway should not clamp the shared pty to
        // a 0x0 viewport — but the renderer is kept alive; resumeTerminalStream's
        // `!entry.rendererAddon?.current` guard skips the re-attach when the
        // renderer survived, so no acquire fires on the way back either.
        // A terminal that genuinely left the fleet (unassigned, or assigned to
        // a status pane) is NOT seated, so the release fires as before.
        cancelRendererRelease(entry);
        const seated = deps.isTerminalSeated ? deps.isTerminalSeated(entry.name) : false;
        if (seated) {
            // Keep the renderer; only the stream suspends. The box will return
            // (it is a re-box, not a leave), and resumeTerminalStream will skip
            // the re-attach. rendererDeferred stays as-is: a seated pane that
            // already holds WebGL keeps it; one on canvas keeps its debt.
        } else if (entry.rendererAddon) {
            entry.rendererAddon.release();
            try {
                if (entry.rendererAddon.current) { entry.rendererAddon.current.dispose(); }
            } catch { /* ignore */ }
            entry.rendererAddon.current = null;
            entry.rendererDeferred = false;
        }
        deps.refreshInputState(entry.name);
    }

    /**
     * Resume a suspended terminal's live socket and renderer.
     *
     * Called exclusively from the reconcile's trailing loop when
     * `isTerminalRendered(name)` is true. Reattaches a renderer, reconnects
     * with ?lastSeq=, and lets the existing replay/gap machinery handle
     * whatever the ring still holds.
     */
    function resumeTerminalStream(entry) {
        if (!entry || entry.disposed) { return; }
        if (!entry.suspended) { return; }
        entry.suspended = false;
        // Reattach a renderer — the suspend disposed the old one. The container
        // is display:block again (active class added by updatePaneElement), so
        // isRendered will pass and WebGL can be acquired if budget allows.
        if (entry.term && !entry.rendererAddon?.current) {
            entry.rendererAddon = attachRenderer(entry.term, entry);
        }
        // Reconnect with lastSeq — the gateway replays the tail of its ring.
        // If the ring evicted data while suspended, the hello frame carries
        // replayGap=true and the existing handler at :10593 calls markReplayGap.
        connectTerminalSocket(entry);
        // Re-cast the size vote: the suspend withdrew it, and a pane restored
        // at its previous size inspects as 'ok' so the ladder alone would not
        // re-vote (same reasoning as ensureSizeVote).
        ensureSizeVote(entry);
        if (entry.container.classList.contains('active')) {
            deps.startFitLadder(entry.name);
        }
    }

    function connectTerminalSocket(entry) {
        // A pending backoff timer is obsolete the moment we connect for real. This
        // used to be covered by destroyTerminalView (which clears it) standing
        // between every rename and the reconnect; renameTerminal now re-keys instead,
        // so a rename landing inside a backoff window leaves the old timer armed —
        // it fires ~500ms later, sees terminalsMap holding the NEW name, and tears
        // down the socket this call just opened. Same defect class as the stale
        // onclose below, same reasoning: the caller that WANTS this timer is the
        // timer itself, and clearing an id that has already fired is a no-op.
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        if (entry.ws) {
            // Detach first. The browser dispatches `close` in a later task, and by
            // then entry.name / fleetList may have moved on (rename) — a stale
            // handler would arm a reconnect timer that tears down the socket this
            // call is about to open. Callers that WANT the reconnect are the ones
            // whose socket closed on its own, and their handler has already run.
            entry.pendingAttribution = null;
            try { entry.ws.onclose = null; } catch { /* ignore */ }
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }
        // Both counters belong to the socket that just went away: the server issues a
        // fresh zeroed credit ledger with the new ClientState, so carrying either one
        // forward would ack characters the new counter never issued.
        entry.pendingAckChars = 0;
        entry.ackSuppressChars = 0;
        // Both windows belong to the socket that just went away. A flag left true
        // by a socket that died mid-replay would mute this connection's live
        // replies until something else cleared it.
        entry.suppressAnswerback = false;
        entry.awaitingReplayFrame = false;
        // A gap flag left armed by a socket that died mid-handshake would mark the next
        // connection's screen for a reset it does not need. Cleared here alongside the
        // other per-socket windows.
        entry.replayGap = false;
        // Belongs to the socket that just went away. A set left armed by a socket that
        // died mid-replay describes a stream this connection will not receive.
        entry.pendingModes = null;
        // The server issues a fresh ClientState with no reportedSize, so a stale true
        // here would make ensureSizeVote suppress the first report on the new socket.
        entry.sizeVoteActive = false;

        let wsUrl = `${deps.ptyHostOrigin}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
        // Connection-scoped, not per-frame: this document is a single-terminal pop-out
        // for its whole life, and the gateway lets a primary viewer outrank the grid
        // cells showing the same terminal. Read from the body class rather than
        // `window.parent === window` — the NEW WINDOW cockpit is also top-level and must
        // NOT claim primacy (it is a second grid, not a single-terminal viewer).
        if (document.body.classList.contains('is-solo')) {
            wsUrl += '&solo=1';
        }
        const terminalToken = (document.body && document.body.dataset && document.body.dataset.terminalToken)
            || window.__SB_TERMINAL_TOKEN__;
        if (terminalToken) {
            wsUrl += `&token=${encodeURIComponent(terminalToken)}`;
        }
        // Tell the server how far we already rendered so it replays only the tail.
        // On a first connect this is 0 and we get the whole ring.
        if (entry.lastSeq > 0) {
            wsUrl += `&lastSeq=${encodeURIComponent(entry.lastSeq)}`;
        }
        const ws = new WebSocket(wsUrl);
        // Output arrives as binary frames; without this they'd surface as Blobs and
        // force an async read on the hot path.
        ws.binaryType = 'arraybuffer';
        entry.ws = ws;
        // The canonical nudge: a reconnect swaps in a CONNECTING socket here
        // without re-rendering the grid, so without this the chip only self-
        // corrects because the OLD socket's onclose happens to fire later —
        // correct by accident. Every other nudge site below is a refinement of
        // this one.
        deps.refreshInputState(entry.name);

        ws.onopen = () => {
            entry.reconnectDelay = 500;
            // A throttle flag left stranded by a socket that died mid-paste would
            // keep the chip reading "paste queued" forever — the gateway's
            // throttled:false frame for that queue will never arrive. Cleared here
            // and in ws.onclose.
            entry.inputThrottled = false;
            entry.queuedBytes = 0;
            deps.refreshInputState(entry.name);
            // Unconditionally reporting term.cols/rows here is what pinned the shared
            // pty to 80x24: on a connection opened before the terminal had a box, that
            // is the xterm construction default rather than anything the operator can
            // see. fitAndReportSize sends nothing unless there is a real box to measure.
            fitAndReportSize(entry);
        };

        ws.onmessage = (event) => {
            try {
                // Binary = pty output (4-byte BE seq + UTF-8 payload). String =
                // JSON control frame. See encodeOutputFrame in terminalWsGateway.ts.
                if (typeof event.data !== 'string') {
                    const view = new DataView(event.data);
                    if (view.byteLength < 4) { return; }
                    const seq = view.getUint32(0, false);
                    if (seq && seq <= entry.lastSeq) {
                        return;
                    }
                    if (seq) {
                        entry.lastSeq = seq;
                    }
                    const text = outputDecoder.decode(new Uint8Array(event.data, 4));
                    if (entry.awaitingReplayFrame) {
                        entry.awaitingReplayFrame = false;
                        // Any tail still queued from the previous socket must reach
                        // xterm BEFORE the replay, or the pane renders out of order.
                        // In practice the queue is empty (BATCH_FALLBACK_MS = 200 vs a
                        // >=500ms reconnect delay); draining removes the dependency on
                        // that timer relationship holding forever.
                        flushBatch(entry);
                        // Its OWN write, not the batch queue: coalescing it with a live
                        // frame would put live queries inside the suppression window and
                        // cost the CLI a legitimate answer.
                        writeReplay(entry, text);
                        return;
                    }
                    entry.batchQueue.push(text);
                    // Live frame (not a replay — the awaitingReplayFrame branch
                    // returned above). Stamp the silence-signal timers: lastFrameAt
                    // on every live frame (heartbeats keep it fresh, proving the
                    // pty is alive); lastPrintableAt only when a glyph is painted,
                    // so a 12 fps no-op heartbeat never resets it. A printable
                    // frame also clears any standing "working, no output"
                    // affordance immediately.
                    const now = Date.now();
                    if (!entry.firstFrameAt) { entry.firstFrameAt = now; }
                    entry.lastFrameAt = now;
                    if (now - entry.lastPrintableAt >= PRINTABLE_SCAN_THROTTLE_MS) {
                        if (frameHasPrintable(text)) {
                            entry.lastPrintableAt = now;
                            if (deps.workingSilenceShown.has(entry.name)) { deps.clearWorkingSilence(entry.name); }
                        }
                    }
                    scheduleBatchFlush(entry);
                    return;
                }

                const frame = JSON.parse(event.data);
                if (frame.t === 'out' && typeof frame.data === 'string') {
                    // Legacy text framing — retained so a browser tab left open
                    // across a server downgrade still renders instead of going mute.
                    if (frame.seq && frame.seq <= entry.lastSeq) {
                        return;
                    }
                    if (frame.seq) {
                        entry.lastSeq = frame.seq;
                    }
                    const rawData = base64ToUtf8(frame.data);
                    entry.batchQueue.push(rawData);
                    // Same live-frame stamping as the binary path above.
                    const now = Date.now();
                    if (!entry.firstFrameAt) { entry.firstFrameAt = now; }
                    entry.lastFrameAt = now;
                    if (now - entry.lastPrintableAt >= PRINTABLE_SCAN_THROTTLE_MS) {
                        if (frameHasPrintable(rawData)) {
                            entry.lastPrintableAt = now;
                            if (deps.workingSilenceShown.has(entry.name)) { deps.clearWorkingSilence(entry.name); }
                        }
                    }
                    scheduleBatchFlush(entry);
                } else if (frame.t === 'hello') {
                    // Chars the server replayed but did NOT bill to this connection's
                    // credit ledger. See onWriteParsed.
                    entry.ackSuppressChars = typeof frame.replayChars === 'number' && frame.replayChars > 0
                        ? frame.replayChars
                        : 0;
                    // The gateway sends hello, then the replay frame, synchronously and
                    // in that order (setupClient in terminalWsGateway.ts) — and a
                    // WebSocket preserves order across text and binary. So the NEXT
                    // binary frame is the replay, and nothing else can be. Assigned
                    // unconditionally, so a window armed by a socket that died before
                    // its replay arrived cannot leak into this connection.
                    entry.awaitingReplayFrame = entry.ackSuppressChars > 0;
                    // Per-socket, assigned unconditionally so a flag armed by a socket
                    // that died before its replay arrived cannot leak into the next
                    // connection (cleared in the connectWs teardown).
                    entry.replayGap = frame.replayGap === true;
                    // The ring evicted output this connection never saw, so what is
                    // already on screen is not contiguous with what is about to be
                    // written. Splicing the two produces a transcript that READS
                    // continuous and is not, and leaves the parser holding state from
                    // before the hole.
                    //
                    // RIS rather than term.reset(): term.reset() does NOT reset the
                    // escape-sequence parser (only fullReset() calls _parser.reset(),
                    // and Terminal.reset() never reaches it), so it cannot guarantee the
                    // clean parse start this whole change exists to provide. RIS also
                    // travels through WriteBuffer, so it is ORDERED before the replay
                    // write instead of racing it, and an ESC aborts whatever the parser
                    // was mid-way through.
                    //
                    // No write callback, deliberately: these two characters were never
                    // credited by the server, and billing them to pendingAckChars would
                    // corrupt the backpressure ledger — the same rule applyServerModes
                    // follows for its synthetic writes.
                    //
                    // Safe against the mode-restore path: RIS restores DEC defaults, and
                    // writeReplay's callback applies the gateway's recorded `modes` AFTER
                    // the replay parses — so the authoritative state still wins, in the
                    // right order. When there is no replay to wait for, the inline
                    // applyServerModes below does the same job.
                    if (entry.replayGap) {
                        // Pre-gap output from the dead socket. Superseded by definition —
                        // dropped rather than flushed, so it cannot be parsed after RIS.
                        entry.batchQueue = [];
                        try { entry.term.write('\x1bc'); } catch { /* disposed */ }
                        deps.markReplayGap(entry.name);
                    }
                    // Applied AFTER the replay, not here: a stale enable inside the
                    // replayed ring would otherwise overwrite the authoritative state
                    // and the pane would come back stuck. Held on the entry and
                    // flushed by writeReplay's callback; applied inline below when
                    // there is no replay to wait for.
                    //
                    // `bracketedPaste` is the legacy single-mode field from a server
                    // that predates `modes`. Folded in rather than handled separately
                    // so there is one application path.
                    entry.pendingModes = frame.modes && typeof frame.modes === 'object'
                        ? frame.modes
                        : (typeof frame.bracketedPaste === 'boolean' ? { 2004: frame.bracketedPaste } : null);
                    // Cleared only when the write actually landed. A hello that arrives
                    // before the view materialised (no entry.term) keeps the set armed
                    // rather than dropping it on the floor.
                    if (!entry.awaitingReplayFrame && applyServerModes(entry, entry.pendingModes)) {
                        entry.pendingModes = null;
                    }
                } else if (frame.t === 'inputThrottled') {
                    // Informational only — stdin stays enabled and input is queued,
                    // never dropped. The signal is the header chip, NOT a line in the
                    // buffer: see the prohibition on notifyInputDropped. A dispatch
                    // prompt clears INPUT_HIGH_WATER_BYTES routinely, and the old
                    // writes injected six rows of shift per paste into whatever
                    // full-screen CLI was running in the pane.
                    entry.inputThrottled = frame.throttled !== false;
                    entry.queuedBytes = frame.queued || 0;
                    deps.refreshInputState(entry.name);
                } else if (frame.t === 'error') {
                    // State first, notification second. A throw inside the toast path
                    // must not be able to leave a dead terminal accepting input — the
                    // onmessage catch swallows it into a console.warn.
                    deps.dismissStartupCurtain(entry.name);
                    deps.clearWorkingSilence(entry.name);
                    entry.exited = true;
                    if (entry.term) { entry.term.options.disableStdin = true; }
                    deps.refreshInputState(entry.name);
                    deps.showTerminalErrorToast(entry.name, frame.message || 'Terminal unavailable');
                } else if (frame.t === 'exit') {
                    // 'Lagging client evicted' is deliberately unhandled. The gateway
                    // calls ws.close() immediately after sending it
                    // (terminalWsGateway.ts), so ws.onclose fires, calls
                    // refreshInputState, and resolveInputState reports `connecting`
                    // off the non-OPEN socket. The old buffer line was a second
                    // notification stacked on one the operator already had — and a
                    // permanent one, still reading "reconnecting" long after the
                    // socket came back.
                    if (frame.reason !== 'Lagging client evicted') {
                        deps.dismissStartupCurtain(entry.name);
                        deps.clearWorkingSilence(entry.name);
                        const exitCode = typeof frame.code === 'number' ? frame.code : 0;
                        entry.exited = true;
                        // A stale startup-command death (code 0, no output, inside
                        // the first-readiness window) is named for what it is —
                        // the seat launched a command that exited cleanly without
                        // producing anything — rather than the bare
                        // "Process Exited with code 0" that is indistinguishable
                        // from a real session ending. The command and its source
                        // are forwarded by the gateway from the fleet's exit event.
                        if (frame.staleCommandDeath) {
                            const cmd = frame.startupCommand || '<none>';
                            const src = frame.startupCommandSource || 'none';
                            entry.term.write(`\r\n\x1b[31m[Stale startup command exited with code ${exitCode}: '${cmd}' (source=${src})]\x1b[0m\r\n`);
                        } else {
                            entry.term.write(`\r\n\x1b[31m[Process Exited with code ${exitCode}]\x1b[0m\r\n`);
                        }
                        entry.term.options.disableStdin = true;
                        deps.refreshInputState(entry.name);
                        if (deps.isDockFrame && window.parent && window.parent !== window) {
                            try {
                                window.parent.postMessage({ type: 'dockTerminalExited', name: entry.name }, '*');
                            } catch { /* ignore */ }
                        }
                    }
                }
            } catch (err) {
                console.warn('[Terminals] Bad message:', err);
            }
        };

        ws.onclose = () => {
            entry.pendingAttribution = null;
            if (entry.exited) { return; }
            // Same strand as ws.onopen: a socket that died mid-paste will never get
            // its throttled:false frame, so the flag would strand the chip on
            // "paste queued". readonly outranks queued in the resolver, so an
            // exited terminal's stranded flag is unreachable — but a reconnecting
            // one is not exited.
            entry.inputThrottled = false;
            entry.queuedBytes = 0;
            deps.refreshInputState(entry.name);
            const item = deps.getFleetList().find(i => i.friendlyName === entry.name);
            if (item && item.status === 'active') {
                if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
                const delay = entry.reconnectDelay || 500;
                entry.reconnectDelay = Math.min(30000, Math.round(delay * 1.5));
                entry.reconnectTimer = setTimeout(() => {
                    if (deps.terminalsMap.has(entry.name)) {
                        connectTerminalSocket(entry);
                    }
                }, delay);
            }
        };
    }

    // ─── Public surface ──────────────────────────────────────────────────

    return {
        // Utility
        isRendered,
        encodeInputFrame,
        base64ToUtf8,
        buildTerminalTheme,
        resolveMonoFont,

        // Renderer
        reconcileRendererForVisibility,
        armRendererRelease,
        cancelRendererRelease,

        // Sizing
        fitAndReportSize,
        releaseSizeVote,
        ensureSizeVote,

        // Lifecycle
        createTerminalView,
        destroyTerminalView,
        connectTerminalSocket,
        suspendTerminalStream,
        resumeTerminalStream,
    };

    } // end createTerminalViewport
})();
