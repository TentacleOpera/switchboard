(function() {
    'use strict';

    let activeTerminalName = null;
    let currentLayout = '1'; // '1', '2h', '2v', '2x2' — what the USER picked (persisted)
    // What is actually RENDERED. Diverges from currentLayout only when the pane-size floor
    // trips. Every render path reads this, never currentLayout, so a floored layout cannot
    // silently revert on the next re-render (which would leave the banner lying).
    let effectiveLayout = '1';
    let initialAssignmentDone = false;
    let focusedPaneIndex = 0;
    let paneAssignments = []; // [terminalName or null, ...] length based on currentLayout
    // Per-SLOT pin flags, index-aligned with paneAssignments. Index-keyed, not name-keyed:
    // that is what lets renameTerminal leave pins alone, and it matches the operator's
    // mental model ("the left pane stays put"), which is about the seat, not the occupant.
    // Invariant: pinnedPanes[i] is never true while paneAssignments[i] is null. A pin on an
    // empty seat reserves a slot nothing can fill, and it is persisted, so the soft-lock
    // survives reload. sanitizePaneAssignments enforces this on every list refresh.
    let pinnedPanes = [];
    // Per-slot pane content mode, index-aligned with paneAssignments. 'terminal'
    // renders a terminal viewport (the existing behavior); 'kanban' renders a
    // live kanban column viewer in an otherwise-empty slot. Padded to
    // getMaxSlotCount() and NEVER trimmed on layout shrink — mirrors
    // paneAssignments' documented no-trim design so a kanban-mode slot's mode
    // and chosen column survive a shrink-grow round trip.
    let paneModes = [];
    // Structural fingerprint of the last renderPaneGrid() pass — layout, the rendered
    // slice of paneAssignments/paneModes, and the peek target. renderPaneGrid runs on
    // every 5 s fleet poll and on every badge change, and the overwhelming majority of
    // those reconciles change NOTHING structural. The renderer-resync latch must arm
    // only on a real transition; arming it on every reconcile turns the poll into a
    // permanent full-repaint-per-visible-pane heartbeat (the poll's own
    // applyLayoutFloor() -> batchFitVisiblePanes() consumes the flag ~2 frames later).
    let lastGridStructureKey = null;
    // Per-slot chosen kanban column id (only meaningful when paneModes[i]==='kanban').
    let kanbanPaneColumn = [];
    // Per-slot chosen workspace root for the kanban pane. Defaults to the first
    // parent's parentFolder when entering kanban mode. Without this, getBoardCards
    // falls back to the backend's _currentWorkspaceRoot (whatever the Kanban board
    // tab last selected) or auto-selects the first allowed root — which is the
    // wrong workspace when multiple parent projects are open.
    let kanbanPaneWorkspace = [];
    let buttonPressRowEl = null; // drag-disarm: set when a button inside a kanban-pane-row is pressed
    // Per-slot chosen project filter for the kanban pane. Empty string = all
    // projects (no filter). Only meaningful when paneModes[i]==='kanban'.
    let kanbanPaneProject = [];
    // index -> projects[] cache (from the getBoardCards response).
    let kanbanPaneProjectsCache = {};
    // index -> cards[] cache populated by the poll loop.
    let kanbanPaneCards = {};
    // index -> Set of selected plan ids for that pane's kanban list.
    // Per-pane, not global: two panes can render different columns/workspaces at
    // once, and a shared set would let a drag in pane A carry pane B's ids.
    // Deliberately NOT persisted via saveLayoutSettings — transient UI state, and
    // persisting it would need a migration for the shipped install base.
    let kanbanPaneSelection = {};
    function paneSelection(index) {
        if (!kanbanPaneSelection[index]) { kanbanPaneSelection[index] = new Set(); }
        return kanbanPaneSelection[index];
    }
    function clearPaneSelection(index) {
        // Cleared IN PLACE, never reassigned. Every row's click handler closes over the
        // Set the row was rendered with, while dragstart re-reads paneSelection(index).
        // Swapping the object leaves those two looking at DIFFERENT Sets for as long as
        // the clear is not followed by a row rebuild — and that window is real: the
        // clear-on-drop runs before the async fetchBoardCardsForPane lands, and when
        // promptSelected advances nothing (its "no next column" arm returns success with
        // advanced: 0) the card list never changes, so the pane's body signature matches
        // and renderKanbanPane early-returns forever. Clicks would then mutate an orphaned
        // Set while the drag carried the empty live one — selection looks fine and
        // dispatches one plan.
        paneSelection(index).clear();
        // The class is not the source of truth, but a clear with no rebuild behind it
        // would leave rows painted selected over an empty Set, and the next click on
        // such a row would re-select it instead of toggling it off.
        document.querySelectorAll(`.terminal-pane[data-pane-index="${index}"] .kanban-pane-row.selected`)
            .forEach(el => el.classList.remove('selected'));
    }
    // Cached flat ordered column list from getKanbanStructure.
    let kanbanColumnsCache = [];
    // The board's "collapse coder columns" toggle, carried on the same
    // getKanbanStructure response. Mirrors kanban.html's own default (true) so the
    // pre-structure paint offers the same column set the board would.
    let kanbanCollapseCoders = true;
    // role -> column order for sidebar terminal sorting. Empty cache means first
    // paint: fall back to a static mirror of DEFAULT_KANBAN_COLUMNS. The live
    // structure replaces this wholesale when it lands (never merged).
    let roleOrderMap = {};
    let kanbanPollTimer = null;
    let fleetPollTimer = null;
    // Timestamp of the last getKanbanStructure fetch. Column structure changes
    // rarely, so it is refreshed on a 30s cadence rather than every 5s poll tick.
    let kanbanStructureTimer = 0;
    // Pane indices with a getBoardCards request in flight — see fetchBoardCardsForPane.
    const kanbanFetchInFlight = new Set();
    const collapsedGroups = new Set();
    // Workspace the kanban board had selected when this panel was built. The
    // host injects it via data-initial-workspace-root and it matches what
    // kanban.html reads at startup.
    let initialWorkspaceRoot = undefined;

    // Named, switchable logical groups. Manual groups keep an explicit member list;
    // derived groups (role / worktree) compute membership live from fleetList. A group
    // carries an optional desired layout and a member order used to choose what renders
    // when the pane-size floor leaves fewer slots than members.
    let terminalGroups = []; // [{ id, name, source, value?, layout, members, order }]
    let lastReadGroupIds = []; // ids of terminal groups as last read from backend
    let activeGroupId = null; // which group is currently locked, or null for "composing"
    let activeGroupPage = 0; // transient: which page of the active group is showing
    let selectedTerminalNames = new Set(); // multi-select in the sidebar
    let restoredLockOnLoad = false; // one-shot: re-seat the locked group after first fleet fetch

    // Display preferences for derived groups: threshold, hidden ids, pinned ids,
    // per-group member order, per-group stored layouts, and per-group extras
    // (terminals added to a derived group via the locked-group empty-pane fill).
    // One object under one key to avoid a spray of saveSetting calls.
    let groupPrefs = { threshold: 2, hidden: [], pinned: [], orders: {}, layouts: {}, extras: {}, autoRoleGroups: false };

    // ┌─ Section Map (approx, ±20 lines) ──────────────────────────────────
    // │ IIFE / state & constants (layout, panes, pins,
    // │   modes, groups, prefs) ...................... lines 1–251
    // │ Input frame encode / base64 decode ........... lines 252–280
    // │ xterm renderer: fit, size votes, WebGL swap .. lines 281–671
    // │ Theme resolve / terminal theme build ......... lines 672–756
    // │ init() — DOM wiring, listeners, boot ......... lines 757–1377
    // │ Fleet state push to shell .................... lines 1378–1434
    // │ Layout slot math / layout-for-fleet .......... lines 1435–1505
    // │ Settings + layout persistence ................ lines 1506–1689
    // │ Terminal list / group reload / pane toast .... lines 1690–1873
    // │ Startup curtain .............................. lines 1874–2025
    // │ Pane assignment sanitize / brand icons ....... lines 2026–2198
    // │ renderTerminalRow (sidebar row) .............. lines 2199–2443
    // │ Group CRUD / selection / switch .............. lines 2444–2695
    // │ Derived groups / members / ordering .......... lines 2696–3048
    // │ renderGroupTabStrip .......................... lines 3049–3296
    // │ Terminal comparator / team bucketing ......... lines 3297–3458
    // │ renderSidebarList ............................ lines 3459–3823
    // │ Layout mode / assign-to-pane / focus ......... lines 3824–4077
    // │ Input + dispatch state chips ................. lines 4078–4282
    // │ renderPaneGrid / peek ........................ lines 4283–4491
    // │ Pane element create / update / drop target ... lines 4492–5255
    // │ Kanban column + workspace helpers ............ lines 5256–5425
    // │ renderKanbanPane / kanban toggle ............. lines 5426–5978
    // │ Fleet + kanban polls / board card fetch ...... lines 5979–6101
    // │ Layout floor / fit ladder / scrollbar ........ lines 6102–6501
    // │ Agent names / roles / groups fetch ........... lines 6502–6780
    // │ Terminal + team creation / grid fill ......... lines 6781–7275
    // │ Rename / close / clear terminal .............. lines 7276–7547
    // │ Server modes / paste identity / view teardown . lines 7548–7815
    // │ materializeTerminalView / jump-to-latest ..... lines 7816–8212
    // │ connectTerminalSocket (WebSocket stream) ..... lines 8213–8481
    // │ Write batching / replay / completion toasts .. lines 8482–8751
    // │ debounce / link presets / select wiring ...... lines 8752–9103
    // │ Standing orders / link modal / send .......... lines 9104–9661
    // └──────────────────────────────────────────────────────────────────────

    /**
     * Which group header the role picker is currently open under.
     *   { key: string, targetSpec: object|undefined }   — open
     *   null                                            — closed
     *
     * State, not DOM: renderSidebarList() does `listEl.innerHTML = ''` on every
     * fleet poll (5s), every terminalsChanged push and every collapse toggle, so a
     * picker inserted imperatively on click would be destroyed mid-choice. The
     * renderer rebuilds it from this.
     */
    let pickerState = null;
    /**
     * Group key whose roles fetch is in flight. Synchronous, so a second click that
     * lands DURING the await is still seen: without it the toggle-closed check reads
     * a pickerState the first click has not assigned yet, so double-clicking one `+`
     * opens twice instead of closing, and two different `+` clicks race on whichever
     * fetch resolves last rather than on whichever was clicked last.
     */
    let pickerOpening = null;
    /** Cached { visibleAgents, hasCommand } so a re-render rebuilds the picker
     *  without a round trip and without flashing an empty menu. */
    let rolePickerData = null;
    /**
     * One-shot: scroll the picker into view on the render that OPENED it, and only
     * that render. .terminals-list is overflow-y:auto, so a `+` on a header at the
     * bottom of the scrollport renders the picker below the fold — the same
     * "click did nothing" symptom this change exists to remove. Not applied on poll
     * re-renders, which would yank the operator's scroll position every 5 seconds.
     */
    let pickerNeedsScroll = false;

    let soloTerminalName = null;
    let peekTerminalName = null;
    let hasFetchedList = false;
    // The right-hand dock iframe carries &dock=1 alongside its solo name. Solo
    // mode skips fetchAgentNames, so the dock's fleet snapshot would repaint
    // the rail with default brand icons — postFleetStateToShell returns early
    // when this flag is set (edge case 2). Everything else in solo mode is
    // unchanged; the dock is an ordinary solo page.
    let isDockFrame = false;
    // Mode precedence: solo > kanban > team (narrower scope wins).
    let isKanbanDock = false;
    /** Team-scoped mode: when set, the sidebar and grid show only this team's
     *  members. Parsed from `?team=<groupId>`. Solo wins over team if both are
     *  present (solo is the narrower scope). */
    let teamScopeId = null;
    try {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.has('solo')) {
            soloTerminalName = urlParams.get('solo');
        }
        if (urlParams.has('kanban') && !soloTerminalName) {
            isKanbanDock = urlParams.get('kanban') === '1';
        }
        if (urlParams.has('team') && !soloTerminalName && !isKanbanDock) {
            teamScopeId = urlParams.get('team');
        }
        isDockFrame = urlParams.get('dock') === '1';
    } catch { /* ignore */ }

    const PTY_HOST_ORIGIN = (document.body && document.body.dataset && document.body.dataset.ptyHostOrigin)
        || window.__SB_PTY_HOST_ORIGIN__
        || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

    // role -> agent CLI label ('CLAUDE CLI'), exactly as the kanban column sublines
    // show it. Supplied pre-derived by getStartupCommands; never computed here, so the
    // two surfaces cannot disagree about what a role is running.
    let agentNames = {};

    // name -> { label: string, stamp: number }
    //
    // The stamp is a monotonic completion sequence, relayed to the shell so its rail
    // can pulse the completion ring ONCE per completion. It lives on the badge value
    // rather than in a parallel Map so it cannot outlive the badge: there are seven
    // badge-delete sites and a rename re-key, and a second Map would eventually drift
    // out of sync with all of them.
    const terminalBadges = new Map();
    let badgeStampSeq = 0;
    /** Terminals whose last reattach spliced over evicted output. Deliberately NOT
     *  terminalBadges: that map is the agent-completed signal and feeds the shell rail's
     *  `done` light (postFleetStateToShell), so a gap recorded there would report a
     *  finished agent. */
    const terminalReplayGaps = new Set();
    // terminalName -> count of ptySendPrompt requests currently in flight.
    // A COUNT, not a boolean: withTerminalLock (ptyPromptDelivery.ts withTerminalLock)
    // serialises concurrent sends to one terminal, so the first response can land
    // while a second is still queued — a boolean would clear the chip early.
    const dispatchInFlight = new Map();
    // name -> { quietTimer, noOutputTimer, hardTimer, sawLiveOutput }. Module-level,
    // NOT on the terminalsMap entry: a curtain is armed at ptyCreateTerminal time, and
    // the entry does not exist until the pane has a rendered box (see whenRendered).
    const startupCurtains = new Map();
    const dispatchCurtains = new Map(); // name -> Map<operationId, opState>
    const CURTAIN_QUIET_MS = 1200;      // LIVE output stopped this long => CLI has settled
    const CURTAIN_NO_OUTPUT_MS = 4000;  // no live output at all => nothing to cover (late-seated
                                        // pane got its whole boot as replay, or no CLI booted)
    const CURTAIN_MAX_MS = 15000;       // hard cap: never strand a pane behind it
    const MIN_DISPATCH_CURTAIN_MS = 350;
    const MAX_DISPATCH_CURTAIN_MS = 16000;

    // "Working, no output" signal. A dispatched seat that is pty-live (frames
    // still arriving) but has produced no PRINTABLE glyph for this long shows a
    // small affordance so a silent-but-working pane is not indistinguishable
    // from a dead one. N mirrors the server-side `activityLight.turnEndSilenceMs`
    // (default 90s) — injected as data-working-silence-ms by both hosts so the
    // threshold stays a single knob, not a second one. The liveness window is
    // how recently ANY frame must have arrived for the seat to count as
    // pty-live: the devin heartbeat is ~12 fps, so 5s is generous jitter cover
    // and short enough that a genuinely stopped pty drops the signal.
    const WORKING_SILENCE_MS = (() => {
        const ds = (document.body && document.body.dataset) || {};
        const n = parseInt(ds.workingSilenceMs, 10);
        return Number.isFinite(n) && n > 0 ? n : 90000;
    })();
    const WORKING_LIVE_WINDOW_MS = 5000;
    // Minimum gap between printable scans on the live-frame hot path. frameHasPrintable
    // is O(frame length) with a regex allocation, and the hot path runs once per flush
    // frame (up to ~166/s at the gateway's 6 ms window, frames up to MAX_FLUSH_BYTES) —
    // an unconditional scan there is real main-thread work on the busiest terminals,
    // which are precisely the ones that will never show this signal. Re-scanning at most
    // every 250 ms leaves lastPrintableAt at most 250 ms stale against a 90 s threshold
    // swept every 5 s, so the signal's behaviour is unchanged.
    const PRINTABLE_SCAN_THROTTLE_MS = 250;
    // Names whose "working, no output" affordance is currently in the DOM. The hot path
    // consults this instead of running a querySelectorAll per printable frame; render and
    // clear are its only writers.
    const workingSilenceShown = new Set();

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

    // name -> { container, term, fitAddon, rendererAddon, isWebgl, ws, lastSeq, batchQueue,
    //           pendingAckChars, ackSuppressChars, reconnectTimer, reconnectDelay,
    //           resizeObserver, exited, disposed }
    // Batching is page-level (pendingBatchEntries + one shared rAF), so entries hold no
    // timer or frame id of their own.
    const terminalsMap = new Map();
    let fleetList = [];
    let parentsList = [];
    let heldUnposted = {};

    const listEl = document.getElementById('terminals-list');
    const mainEl = document.getElementById('terminals-main');
    const emptyStateEl = document.getElementById('empty-state');
    // `btnNew` is gone with #btn-new-terminal — spawning is per-group now.
    const paneGridEl = document.getElementById('pane-grid');
    const groupTabStripEl = document.getElementById('group-tab-strip');
    const toastContainerEl = document.getElementById('toast-container');
    const fallbackBannerEl = document.getElementById('layout-fallback-banner');

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

    /** One decoder for every terminal — constructing one per frame is not free. */
    const outputDecoder = new TextDecoder('utf-8');

    /** Backstop flush interval for when requestAnimationFrame is not running. */
    const BATCH_FALLBACK_MS = 200;

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
        if (resized) { resyncPaneRenderer(entry, 'stale-canvas'); }
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

    const DETACH_GRACE_MS = 300000; // 5 min — exited-terminal cleanup grace
                                      // (live terminals are retained by the isExited
                                      // guard in armDetachTimer, not by this timer)
    const detachTimers = new Map();
    // Our own per-document ceiling. It is NOT the process cap: liveWebglContexts
    // is a `let` inside this IIFE, and a second same-origin document (a pop-out)
    // starts its own counter at zero. The real cap is ~16 live contexts per
    // renderer process, shared across every same-origin document in it.
    const MAX_WEBGL_CONTEXTS = 12;
    let liveWebglContexts = 0;

    function armDetachTimer(name) {
        if (detachTimers.has(name)) return;
        const timerId = setTimeout(() => {
            detachTimers.delete(name);
            if (!paneAssignments.includes(name)) {
                // Keep the view alive for running terminals — destroying it loses
                // the xterm scrollback, which is the whole point of a view switcher.
                // Only tear down terminals that are actually dead. Consult BOTH
                // death signals the codebase maintains (see resolveInputState, line
                // 1683): fleetList.status (refreshed on `terminals` messages) AND
                // entry.exited (set immediately on exit/error frames, before the
                // next fleet refresh). Gate `!fleetItem` on hasFetchedList so a
                // stale/empty fleet poll never destroys a live terminal.
                const entry = terminalsMap.get(name);
                const fleetItem = fleetList.find(t => t.friendlyName === name);
                const isExited = (fleetItem && fleetItem.status === 'exited')
                    || (entry && entry.exited)
                    || (!fleetItem && hasFetchedList);
                if (isExited) {
                    destroyTerminalView(name);
                }
            }
        }, DETACH_GRACE_MS);
        detachTimers.set(name, timerId);
    }

    function cancelDetachTimer(name) {
        const timerId = detachTimers.get(name);
        if (timerId) {
            clearTimeout(timerId);
            detachTimers.delete(name);
        }
    }

    /** Is a WebGL renderer even possible in this document? */
    function webglAvailable() {
        return !!(window.WebglAddon && window.WebglAddon.WebglAddon);
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
        if (webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
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
                        resyncPaneRenderer(entry, 'stale-canvas');
                    }
                });
                term.loadAddon(webgl);
                holder.current = webgl;
                if (entry) { entry.isWebgl = true; entry.rendererDeferred = false; }
                liveWebglContexts++;
                return holder;
            } catch (err) {
                console.warn('[Terminals] WebGL renderer unavailable, falling back:', err);
                // No debt recorded. A constructor that threw will throw again on the
                // next tick, and retrying it per tick is exactly the churn this
                // machinery exists to avoid. This pane stays on canvas for the life
                // of the page; every other pane is unaffected.
                if (entry) { entry.rendererDeferred = false; }
                holder.current = attachCanvasRenderer(term);
                return holder;
            }
        }
        // Boxless, budget-exhausted, or no addon at all — one expression covers all
        // three: a debt is owed exactly when WebGL is possible but not held.
        if (entry) { entry.rendererDeferred = webglAvailable(); }
        holder.current = attachCanvasRenderer(term);
        return holder;
    }

    /** Hidden long enough to be worth reclaiming. Short flips between shell panels
     *  must not thrash the GPU: a switch out and back inside this window keeps its
     *  context and costs nothing. */
    const RENDERER_RELEASE_DELAY_MS = 5000;

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
        if (isRendered(entry.container)) { resyncPaneRenderer(entry, 'stale-canvas'); }
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

    /** Theme classes the host swaps between; mirrors planning.js's set. */
    const ALL_THEME_CLASSES = ['theme-claudify', 'cyber-theme-enabled'];

    /**
     * Settle on a theme class before the first terminal is built.
     *
     * Three ways this panel gets loaded, and only one of them carries a theme:
     *  - Extension host: applyThemeClass() stamps the class server-side. Respect it.
     *  - Browser shell: the standalone host passes no themeClass at all, and the
     *    shell only posts `switchboardThemeChanged` when the toggle is CLICKED —
     *    never to a newly built iframe. So inherit from the parent's body, which is
     *    same-origin and already carries the shell's own class.
     *  - Direct navigation to /terminals: no parent, no injection — fall back to
     *    afterburner, the same default the shell and handleGetThemeSetting use.
     * Without this the panel renders unthemed until someone toggles the theme.
     */
    function resolveInitialTheme() {
        if (ALL_THEME_CLASSES.some(cls => document.body.classList.contains(cls))) {
            return;
        }
        try {
            const parentBody = (window.parent && window.parent !== window)
                ? window.parent.document.body
                : (window.opener ? window.opener.document.body : null);
            if (parentBody) {
                const inherited = ALL_THEME_CLASSES.find(cls => parentBody.classList.contains(cls));
                if (inherited) {
                    document.body.classList.add(inherited);
                    return;
                }
            }
        } catch { /* cross-origin parent/opener — fall through to the default */ }
        document.body.classList.add('cyber-theme-enabled');
    }

    /**
     * Reflect a theme name onto <body> so the CSS variables follow.
     *
     * The host sends only a name in `switchboardThemeChanged`; the panel used to
     * act on it by recolouring xterm alone, so the surrounding chrome kept the
     * theme it was served with and the two disagreed until a reload. Removes only
     * the classes that should not be present, leaving unrelated ones
     * (cyber-animation-disabled, etc.) alone.
     */
    function setThemeBodyClass(theme) {
        if (!theme) { return; }
        const desired = theme === 'claudify' ? 'theme-claudify' : 'cyber-theme-enabled';
        for (const cls of ALL_THEME_CLASSES) {
            if (cls !== desired) { document.body.classList.remove(cls); }
        }
        document.body.classList.add(desired);
    }

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

    function init() {
        if (soloTerminalName) {
            document.body.classList.add('is-solo');
            document.title = soloTerminalName;
            currentLayout = '1';
            effectiveLayout = '1';
            paneAssignments = [soloTerminalName];
            initialAssignmentDone = true;
        } else if (isKanbanDock) {
            document.body.classList.add('is-kanban');
            document.title = 'Kanban';
            currentLayout = '1';
            effectiveLayout = '1';
            paneModes[0] = 'kanban';
            paneAssignments = [null];
            initialAssignmentDone = true;
        } else if (teamScopeId) {
            // Team-scoped mode: the sidebar and grid show only this team's
            // members. Unlike solo, the sidebar stays visible and the layout
            // picker remains — the operator chooses a grid among members.
            // The activeGroupId is set to the team's group id so seating
            // passes (seatActiveGroupPage) already work without modification.
            document.body.classList.add('is-team-scoped');
            // The title is set from the group record once it resolves in
            // loadLayoutSettings; set a placeholder so the tab is not blank.
            document.title = 'Team';
        }

        // Mark standalone (top-level window, not inside the shell iframe) so CSS
        // can hide the New Window button — popping out an already-popped-out panel
        // is redundant. Solo mode hides the whole toolbar, so this is additive.
        if (window.parent === window) {
            document.body.classList.add('is-standalone');
        }

        // Before any terminal is constructed — buildTerminalTheme() reads the CSS
        // variables this class selects.
        resolveInitialTheme();

        // Capture the workspace the kanban board had selected. This mirrors
        // kanban.html's startup read of data-initial-workspace-root.
        try {
            const attr = document.body?.dataset?.initialWorkspaceRoot;
            if (attr) { initialWorkspaceRoot = decodeURIComponent(attr); }
        } catch { /* ignore */ }

        // Drag-disarm: pressing a button inside a kanban-pane-row must not start a drag.
        document.addEventListener('pointerdown', (e) => {
            const btn = e.target instanceof Element ? e.target.closest('button') : null;
            if (!btn) return;
            const row = btn.closest('.kanban-pane-row');
            if (!row) return;
            row.draggable = false;
            buttonPressRowEl = row;
            const rearm = () => {
                row.draggable = true;
                buttonPressRowEl = null;
                document.removeEventListener('pointerup', rearm, true);
                document.removeEventListener('pointercancel', rearm, true);
                document.removeEventListener('dragend', rearm, true);
            };
            document.addEventListener('pointerup', rearm, true);
            document.addEventListener('pointercancel', rearm, true);
            document.addEventListener('dragend', rearm, true);
        }, true);

        // #btn-new-terminal and the static #role-picker-cancel are gone: the picker
        // is built per group by buildRolePicker(), and its Cancel carries its own
        // listener. Nothing global to bind.
        //
        // The .sidebar-title click handler that silently called clearGroupLock()
        // is gone too: it was a third, unlabelled way to drop the lock, and with
        // updateLockIndicator removed the title no longer changes on lock/unlock
        // so there was nothing suggesting it was clickable. The "Unassigned" tab
        // in the group tab strip is the single, visible way to drop the lock now.

        const btnNewWindow = document.getElementById('btn-new-window');
        if (btnNewWindow) {
            btnNewWindow.addEventListener('click', () => {
                const url = '/terminals';
                const features = 'width=1200,height=800';
                let popout = null;
                try {
                    popout = window.open(url, 'sb-terminals-panel', features);
                } catch { /* ignore */ }
                if (!popout || popout.closed) {
                    // Popup blocked — no in-cockpit fallback sheds the shell sidebar,
                    // so tell the user instead of silently doing nothing. A console
                    // warning is invisible to users who never open devtools.
                    showPaneToast('Popup blocked — allow popups for this site to pop out the terminals panel.');
                    btnNewWindow.disabled = true;
                    setTimeout(() => { btnNewWindow.disabled = false; }, 2000);
                }
            });
        }

        if (listEl) {
            listEl.addEventListener('dblclick', (e) => {
                const nameEl = e.target && e.target.closest ? e.target.closest('.item-name') : null;
                // dataset, NOT textContent: .item-name now shows the agent CLI label, and
                // renameTerminal(currentName, next) needs the real friendlyName key.
                const current = nameEl && nameEl.dataset ? nameEl.dataset.friendlyName : '';
                if (nameEl && current) { beginInlineRename(nameEl, current); }
            });
        }

        // Stays scoped to the picker. #btn-clear-all used to sit in this toolbar
        // wearing .btn-layout and an unscoped query bound this handler to it too;
        // it now lives in the sidebar ops block, but the scope is still the right
        // thing to assert.
        const layoutBtns = document.querySelectorAll('.layout-picker .btn-layout');
        layoutBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const requested = btn.getAttribute('data-layout');
                if (requested) {
                    // A layout-picker click while a group is locked stores the
                    // new layout against that group and keeps the lock, rather
                    // than silently unlocking. This is the only way the operator
                    // can author "planners are 2×2". The keepLock + storeForActiveGroup
                    // options are on THIS call site only — the other three
                    // setLayoutMode callers (growLayoutForFleet, switchToGroup,
                    // create-grid-for-role) are unchanged and still drop the lock
                    // or keep it via their own paths.
                    const keepLock = !!activeGroupId;
                    if (keepLock) {
                        const group = getAllGroups().find(g => g.id === activeGroupId);
                        if (group && group.source !== 'manual') {
                            // Derived groups store their layout in groupPrefs.layouts;
                            // manual groups carry it on the group object, which
                            // setLayoutMode does not touch. Persist it here so the
                            // choice survives a switch away and back.
                            if (!groupPrefs.layouts) { groupPrefs.layouts = {}; }
                            groupPrefs.layouts[group.id] = requested;
                        } else if (group && group.source === 'manual') {
                            group.layout = requested;
                        }
                    }
                    setLayoutMode(requested, { keepLock });
                    if (keepLock) {
                        // Re-page the locked group against the NEW slot count.
                        // setLayoutMode adopts the pick optimistically, so
                        // applyLayoutFloor's `changed` test is false and its
                        // seatActiveGroupPage() call does not fire — growing
                        // 2h → 2x2 for a 4-member group would otherwise reveal
                        // two empty panes the group already has members to fill.
                        // Same ordering as switchToGroup: layout first, then seat.
                        seatActiveGroupPage();
                    }
                    saveLayoutSettings();
                }
            });
        });

        const btnClearAll = document.getElementById('btn-clear-all');
        if (btnClearAll) {
            btnClearAll.addEventListener('click', () => withClearingFeedback(btnClearAll, clearAllTerminals));
        }

        const btnOpenAll = document.getElementById('btn-open-all');
        if (btnOpenAll) {
            btnOpenAll.addEventListener('click', async () => {
                if (btnOpenAll.disabled) { return; }
                btnOpenAll.disabled = true;
                const label = btnOpenAll.textContent;
                btnOpenAll.textContent = 'OPENING…';
                try {
                    await openAllTerminals();
                } finally {
                    btnOpenAll.disabled = false;
                    btnOpenAll.textContent = label;
                }
            });
        }

        const btnStartAllTeams = document.getElementById('btn-start-all-teams');
        if (btnStartAllTeams) {
            btnStartAllTeams.addEventListener('click', async () => {
                if (btnStartAllTeams.disabled) { return; }
                const teams = await fetchAgentGroups();
                if (!Array.isArray(teams) || teams.length === 0) {
                    showPaneToast('No teams defined — add one in the TEAMS tab.');
                    return;
                }
                const liveHeadRoles = new Set(
                    (Array.isArray(fleetList) ? fleetList : [])
                        .filter(t => t && t.status === 'active' && !t.parentInstanceId && t.role)
                        .map(t => t.role)
                );
                const toStart = teams.filter(team => {
                    if (!team || !team.id) { return false; }
                    // Mirror startTeamById's guard EXACTLY (teamWiring.ts): it compares
                    // `t.role === team.headRole` with no default, so a team carrying no
                    // headRole is never refused. Defaulting to 'lead' here would skip
                    // such a team whenever any unparented lead is live — a start the
                    // backend would have allowed.
                    if (!team.headRole) { return true; }
                    return !liveHeadRoles.has(team.headRole);
                });
                const skippedCount = teams.length - toStart.length;
                if (toStart.length === 0) {
                    showPaneToast('All teams already running.');
                    return;
                }
                btnStartAllTeams.disabled = true;
                const label = btnStartAllTeams.textContent;
                btnStartAllTeams.textContent = 'STARTING…';
                let startedCount = 0;
                let finalSkippedCount = skippedCount;
                try {
                    const targetSpec = initialWorkspaceRoot ? { parentRoot: initialWorkspaceRoot } : undefined;
                    for (const team of toStart) {
                        const data = await startTeam({ id: team.id }, targetSpec, { silent: true });
                        if (data && data.success) {
                            startedCount++;
                        } else if (data && typeof data.error === 'string' && data.error.includes('already live')) {
                            // The team started between the pre-filter read (up to one
                            // poll stale) and this call — a benign skip, not an error.
                            finalSkippedCount++;
                        } else if (data) {
                            showPaneToast(`Could not start team '${team.name || team.id}': ${data.error || 'request failed'}`);
                        } else {
                            showPaneToast(`Could not start team '${team.name || team.id}' — network error.`);
                        }
                    }
                    if (finalSkippedCount > 0) {
                        showPaneToast(`Started ${startedCount} team${startedCount === 1 ? '' : 's'}, skipped ${finalSkippedCount} running.`);
                    } else {
                        showPaneToast(`Started ${startedCount} team${startedCount === 1 ? '' : 's'}.`);
                    }
                } finally {
                    btnStartAllTeams.disabled = false;
                    btnStartAllTeams.textContent = label;
                }
            });
        }

        const btnFillGrid = document.getElementById('btn-fill-grid');
        const fillGridForm = document.getElementById('fill-grid-form');
        const fillGridRole = document.getElementById('fill-grid-role');
        const fillGridMode = document.getElementById('fill-grid-mode');
        const fillGridCancel = document.getElementById('fill-grid-cancel');
        const fillGridConfirm = document.getElementById('fill-grid-confirm');
        if (btnFillGrid && fillGridForm && fillGridRole && fillGridMode) {
            btnFillGrid.addEventListener('click', async () => {
                const data = await fetchPtyVisibleRoles();
                const visible = data.visibleAgents;
                const hasCommand = data.hasCommand;
                const SYSTEM_ROLES = new Set(['mission-control', 'mcp_monitor']);
                const roles = Object.keys(visible)
                    .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))
                    .sort((a, b) => {
                        const aOrder = roleOrderMap[a];
                        const bOrder = roleOrderMap[b];
                        if (aOrder !== undefined && bOrder !== undefined) { return aOrder - bOrder; }
                        if (aOrder !== undefined) { return -1; }
                        if (bOrder !== undefined) { return 1; }
                        return (a || '\uFFFF').localeCompare(b || '\uFFFF');
                    });

                fillGridRole.innerHTML = '';
                for (const role of roles) {
                    const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === role);
                    const label = meta ? meta.label : role;
                    const opt = document.createElement('option');
                    opt.value = role;
                    opt.textContent = label + (hasCommand[role] ? '' : ' (plain shell)');
                    fillGridRole.appendChild(opt);
                }

                fillGridMode.innerHTML = '';
                for (const mode of LAYOUT_MODES) {
                    const opt = document.createElement('option');
                    opt.value = mode;
                    opt.textContent = `${mode} — ${LAYOUTS[mode].slots} agent${LAYOUTS[mode].slots === 1 ? '' : 's'}`;
                    fillGridMode.appendChild(opt);
                }
                fillGridMode.value = currentLayout;

                btnFillGrid.hidden = true;
                fillGridForm.hidden = false;
            });

            if (fillGridCancel) {
                fillGridCancel.addEventListener('click', () => {
                    fillGridForm.hidden = true;
                    btnFillGrid.hidden = false;
                });
            }

            fillGridForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const role = fillGridRole.value;
                const mode = fillGridMode.value;
                fillGridConfirm.disabled = true;
                fillGridConfirm.textContent = 'FILLING…';
                try {
                    await fillGrid(role, mode);
                } finally {
                    fillGridConfirm.disabled = false;
                    fillGridConfirm.textContent = 'FILL';
                    fillGridForm.hidden = true;
                    btnFillGrid.hidden = false;
                }
            });
        }

        const btnStartTeam = document.getElementById('btn-start-team');
        const startTeamForm = document.getElementById('start-team-form');
        const startTeamName = document.getElementById('start-team-name');
        const startTeamTarget = document.getElementById('start-team-target');
        const startTeamCancel = document.getElementById('start-team-cancel');
        const startTeamConfirm = document.getElementById('start-team-confirm');
        if (btnStartTeam && startTeamForm && startTeamName && startTeamTarget) {
            // Teams are fetched on open, not polled — same as FILL GRID's roles.
            btnStartTeam.addEventListener('click', async () => {
                const teams = await fetchAgentGroups();
                if (!Array.isArray(teams) || teams.length === 0) {
                    // Honest empty state. An empty <select> would read as broken.
                    showPaneToast('No teams defined — add one in the TEAMS tab.');
                    return;
                }
                startTeamName.innerHTML = '';
                for (const team of teams) {
                    if (!team || !team.id) { continue; }
                    const opt = document.createElement('option');
                    opt.value = team.id;
                    // Same summary the picker showed, so the operator sees what spawns
                    // before committing: "Coding — 3× coder, 1× reviewer (shared)".
                    opt.textContent = `${team.name || team.id} — ${teamSpawnSummary(team)}`;
                    startTeamName.appendChild(opt);
                }

                // Workspace target. The picker inherited this from whichever header's
                // `+` was clicked; a standing control has no such context, so offer it —
                // but only when there is more than one, otherwise it is a dropdown with
                // one answer.
                const roots = (Array.isArray(parentsList) ? parentsList : [])
                    .map(p => ({ path: p.parentFolder || '', name: p.name || 'Workspace Root' }))
                    .filter(r => r.path);
                startTeamTarget.innerHTML = '';
                for (const r of roots) {
                    const opt = document.createElement('option');
                    opt.value = r.path;
                    opt.textContent = r.name;
                    startTeamTarget.appendChild(opt);
                }
                if (initialWorkspaceRoot) {
                    startTeamTarget.value = initialWorkspaceRoot;
                }
                startTeamTarget.hidden = roots.length < 2;

                btnStartTeam.hidden = true;
                startTeamForm.hidden = false;
            });

            if (startTeamCancel) {
                startTeamCancel.addEventListener('click', () => {
                    startTeamForm.hidden = true;
                    btnStartTeam.hidden = false;
                });
            }

            startTeamForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const teamId = startTeamName.value;
                // Only pass a target when the operator actually chose one; otherwise the
                // host resolves the spawn cwd itself, as it does for an unqualified start.
                const targetSpec = (!startTeamTarget.hidden && startTeamTarget.value)
                    ? { parentRoot: startTeamTarget.value }
                    : undefined;
                startTeamConfirm.disabled = true;
                startTeamConfirm.textContent = 'STARTING…';
                try {
                    await startTeam({ id: teamId }, targetSpec);
                } finally {
                    startTeamConfirm.disabled = false;
                    startTeamConfirm.textContent = 'START';
                    startTeamForm.hidden = true;
                    btnStartTeam.hidden = false;
                }
            });
        }

        const btnSaveGroup = document.getElementById('btn-save-group');
        if (btnSaveGroup) {
            btnSaveGroup.addEventListener('click', () => {
                const input = document.createElement('input');
                input.className = 'item-name-input';
                input.placeholder = 'Group name';
                input.style.width = '100%';
                input.style.marginTop = '8px';
                btnSaveGroup.replaceWith(input);
                input.focus();

                // One-shot: Enter fires finish AND then blurs the (now detached) input,
                // which would run finish a second time and save a duplicate group.
                let done = false;
                const finish = (save) => {
                    if (done) { return; }
                    done = true;
                    const name = input.value.trim();
                    input.replaceWith(btnSaveGroup);
                    if (save && name) {
                        saveCurrentAsGroup(name);
                    }
                };

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { finish(true); }
                    if (e.key === 'Escape') { finish(false); }
                });
                input.addEventListener('blur', () => finish(true));
            });
        }

        const btnLinkUp = document.getElementById('btn-link-up');
        if (btnLinkUp) { btnLinkUp.addEventListener('click', openLinkModal); }

        const btnKanbanToolbar = document.getElementById('btn-kanban-toolbar');
        if (btnKanbanToolbar) {
            btnKanbanToolbar.addEventListener('click', () => toggleFocusedPaneKanban());
        }

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            if (message.type === 'terminalsChanged') {
                fetchTerminalList();
            } else if (message.type === 'requestFleetState') {
                // Shell-side fallback: the shell asked for our current fleet state.
                // Push it immediately (stale is better than dark) and trigger a fresh fetch.
                // Origin-guarded like the other two arms driven by a REAL postMessage
                // (focusTerminal, clearTerminalBadge). Unlike terminalsChanged /
                // switchboardThemeChanged / agentCompleted, this one never arrives from
                // transport.js's synthetic dispatch (origin ''), so the check is safe here
                // — and it keeps a foreign framer from driving ptyListTerminals traffic.
                if (event.origin !== location.origin) { return; }
                postFleetStateToShell();
                fetchTerminalList();
            } else if (message.type === 'switchboardThemeChanged') {
                applyThemeToAllTerminals(message.theme);
            } else if (message.type === 'agentCompleted') {
                handleAgentCompleted(message);
            } else if (message.type === 'focusTerminal' && typeof message.name === 'string') {
                if (event.origin !== location.origin) { return; }
                if (terminalBadges.has(message.name)) {
                    terminalBadges.delete(message.name);
                }
                terminalReplayGaps.delete(message.name);
                // locateTerminal, not assignToFocusedPane: an inbound focus request
                // from the board means "let me type in this one", which needs the
                // caret and not just the pane slot.
                locateTerminal(message.name);
                renderSidebarList();
                renderPaneGrid();
                postFleetStateToShell();
                focusPaneTerminal(paneAssignments.indexOf(message.name));
            } else if (message.type === 'clearTerminalBadge' && typeof message.name === 'string') {
                // Acknowledge-only sibling of `focusTerminal`. The strip's click now
                // pops the terminal out into its own window, so the user HAS seen the
                // completion — but the cockpit's pane layout must not be rearranged
                // behind their back, which is exactly what `focusTerminal` would do.
                // Without this arm the DONE light burns forever on the happy path,
                // because assignToFocusedPane is never reached.
                if (event.origin !== location.origin) { return; }
                if (terminalBadges.has(message.name)) {
                    terminalBadges.delete(message.name);
                    renderSidebarList();
                    renderPaneGrid();
                    postFleetStateToShell();
                }
                terminalReplayGaps.delete(message.name);
            } else if (message.type === 'switchToTeam' && typeof message.groupId === 'string') {
                // In-place team navigation: the shell rail's team button click
                // posts this to switch the main panel into team-scoped mode
                // without opening a pop-out window. Origin-guarded like every
                // other shell-driven arm.
                if (event.origin !== location.origin) { return; }
                enterTeamScope(message.groupId);
            } else if (message.type === 'switchToController') {
                // In-place controller navigation: the shell rail's lit UFO
                // click posts this to reveal the controller terminal. The rail
                // button is navigational (like every other rail icon), so it
                // switches the panel to controller scope rather than posting
                // /mission-control/stop. The end-session control lives in the
                // scoped .sidebar-ops block (#btn-controller-stop), where it
                // can carry a label. Origin-guarded.
                if (event.origin !== location.origin) { return; }
                enterControllerScope();
            } else if (message.type === 'peekTerminal' && typeof message.name === 'string') {
                if (event.origin !== location.origin) { return; }
                if (peekTerminalName === message.name) {
                    dismissPeek();
                } else {
                    peekTerminal(message.name);
                }
            } else if (message.type === 'popoutBlocked' && typeof message.name === 'string') {
                if (event.origin !== location.origin) { return; }
                showPaneToast(`Popup blocked — could not open ${message.name} in a new window.`);
            } else if (message.type === 'startupCommandsChanged') {
                // The startup commands were saved (possibly from another panel
                // or surface — setup.html, implementation.html, or the Agents
                // tab). Refetch the agentNames cache so labels and brand icons
                // update without a panel reload. Debounced against the
                // cockpit's 6× fan-out. No origin guard: this arrives via the
                // wsHub broadcast rail (like terminalsChanged), not from a
                // foreign frame.
                debouncedRefreshAgentNames();
            } else if (message.type === 'terminalsGroupsChanged') {
                // The backend registered a new terminals group (teamWiring.ts).
                // Re-read terminals.groups and merge by id — a reload that
                // arrives mid-drag must not discard an in-flight local edit, so
                // new groups are added but existing ones keep their local
                // (possibly unsaved) state. Without this, the next pane drag
                // writes a stale whole-array save and the backend-registered
                // group vanishes with no error anywhere. No origin guard: this
                // arrives via the wsHub broadcast rail (like terminalsChanged).
                reloadTerminalGroups();
            } else if (message.type === 'terminalDispatchPreparing') {
                if (message.terminalName && message.operationId) {
                    armDispatchCurtain(message.terminalName, message.operationId, {
                        cliFamily: message.cliFamily,
                        phase: message.phase || 'clearing',
                        teamName: message.teamName
                    });
                }
            } else if (message.type === 'terminalDispatchFinished') {
                if (message.terminalName && message.operationId) {
                    disarmDispatchCurtain(message.terminalName, message.operationId, message.reason, message.elapsedMs);
                }
            } else if ((message.type === 'autobanStateSync' || message.type === 'updateAutobanConfig') && message.state) {
                const seat = message.state.missionControlSeat || null;
                lastMissionControlSeatName = (seat && seat.terminalName) || null;
            } else if (message.type === 'panelVisibility' && typeof message.visible === 'boolean') {
                if (event.origin !== location.origin) { return; }
                // The shell hides a panel by setting display:none on its IFRAME. This
                // document then stops being rendered, so its ResizeObservers no longer
                // run — the container observer above cannot see this transition in
                // either direction, and on the way back the box is unchanged so there
                // is nothing for it to observe anyway. The shell is the only thing that
                // knows, so the shell has to say so.
                //
                // The GPU renderer rides the SAME carrier, and must: the release
                // machinery's headline case is "a panel switched away from keeps every
                // context it took", and its only other trigger is that same container
                // ResizeObserver. Two of this feature's plans reached OPPOSITE research
                // conclusions about whether an in-iframe ResizeObserver sees the parent's
                // display:none — so leaving the release on the observer alone bets the
                // whole reclaim on the optimistic reading, and loses silently if it is
                // wrong (a hidden panel's __sbTerminalStats is never the one anybody
                // reads). Arming here costs nothing if the observer does fire:
                // armRendererRelease early-returns on an already-armed timer, and
                // reconcileRendererForVisibility re-reads isRendered and no-ops when the
                // state already matches. Both directions are idempotent by construction.
                if (!message.visible) {
                    for (const entry of terminalsMap.values()) {
                        releaseSizeVote(entry);
                        armRendererRelease(entry);
                    }
                } else {
                    // Cancel synchronously, BEFORE the rAF: the release timer is a plain
                    // setTimeout and keeps running in a hidden iframe, so a reveal that
                    // waited for a frame could be beaten by a release that fires first
                    // and drops a now-visible pane to canvas.
                    for (const entry of terminalsMap.values()) { cancelRendererRelease(entry); }
                    // Cockpit-only backstop: refetch agentNames on reveal so a
                    // command edit made in another window or a missed push is
                    // caught on return. Coalesces with any pending push-driven
                    // refetch via the same debounce. No-op in the VS Code panel
                    // — panelVisibility is not emitted there; the save-push is
                    // what covers that host.
                    debouncedRefreshAgentNames();
                    // rAF, not a direct call: the display flip and this message can land
                    // in the same task, and a frame callback is by definition only
                    // delivered once the document is actually being rendered.
                    requestAnimationFrame(() => {
                        for (const entry of terminalsMap.values()) {
                            ensureSizeVote(entry);
                            reconcileRendererForVisibility(entry);
                        }
                    });
                }
            }
        });

        // Window resize re-evaluates the floor ONLY. It deliberately does not fit/resize
        // the panes: each terminal container carries its own debounced ResizeObserver
        // (createTerminalView), which fires for exactly the panes whose box actually
        // changed. Fitting here as well sent two fit() passes and two {t:'resize'} frames
        // per terminal for every window drag.
        window.addEventListener('resize', debounce(() => {
            applyLayoutFloor({ fit: false });
        }, 150));

        // Reordering columns in Setup never reaches this panel directly. Focus is the
        // moment the operator comes back, so refetch the structure then (throttle bypassed).
        window.addEventListener('focus', () => {
            fetchKanbanColumnStructure(true);
            // Mirror the visibilitychange repair (the `document.addEventListener
            // ('visibilitychange', ...)` listener further down this function): arm the
            // latch on every live entry, then let the fit ladder schedule the actual
            // repaint. `visibilitychange` does NOT fire on same-browser window
            // blur/focus (the document stays 'visible'), so without this arm the
            // corruption class goes unrepaired until a manual pane click. rebuildAtlas
            // stays false: the atlas is intact on this path — see the latch consumer in
            // startFitLadder's attempt(), and resyncPaneRenderer's own doc block.
            // Line numbers deliberately omitted; the previous revision of this comment
            // cited two that were already stale when it was written.
            for (const entry of terminalsMap.values()) {
                if (!entry || entry.disposed || !entry.term) { continue; }
                entry.needsRendererResync = true;
            }
            const slotCount = getSlotCount(effectiveLayout);
            for (let i = 0; i < slotCount; i++) {
                const name = paneAssignments[i];
                if (name) { startFitLadder(name); }
            }
        });

        // Esc dismisses a peek, unless the caret is inside the peeked terminal —
        // then the key belongs to the program running there.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !peekTerminalName) { return; }
            const peekedPane = paneGridEl.querySelector('.terminal-pane.is-peeked');
            if (peekedPane && peekedPane.contains(document.activeElement)) { return; }
            e.preventDefault();
            dismissPeek();
        });

        // Renderer repair on visibility regain. While the document is hidden rAF is
        // fully suspended (0 Hz on every desktop engine) but the BATCH_FALLBACK_MS
        // timer is only clamped to ~1 Hz, so drainAllBatches -> term.write keeps
        // advancing the buffer with nothing painting. On restore the parked
        // RenderDebouncer rAF fires and repaints the merged dirty-row range — and
        // that is ALL that fires. RenderService is never paused by a minimize
        // (IntersectionObserver is computed from layout geometry, which a minimize
        // does not change), so there is no _handleIntersectionChange full refresh to
        // ride on. Restore has no full-repaint step.
        //
        // So rows that changed while hidden but fell outside that merged range keep
        // their stale pixels indefinitely over a CORRECT buffer. That is the whole
        // bug: the damage sits on regions nothing rewrites (a CLI's static status
        // strip), and ANY later repaint of those rows clears it — which is why both
        // typing and simply SCROLLING the pane fix it. Scrolling is the proof: it
        // changes no buffer content at all, it only marks viewport rows dirty, and
        // WebglRenderer.renderRows -> _updateModel rewrites those rows' vertex data
        // from the buffer. The atlas and the vertex array are therefore intact —
        // do NOT reintroduce clearTextureAtlas() here (see plan Root Cause).
        //
        // handleResize IS still needed: a DPR change or a resize-while-hidden leaves
        // the canvas backing store at the wrong scale, and no repaint fixes that.
        // Both it and the unpainted rows are invisible to inspectPaneFit (which only
        // ever compares grid geometry, never pixel content), which is why this repair
        // is unconditional rather than verdict-gated.
        //
        // NOTE ON FREQUENCY: Chromium (Win/macOS) and Safari also report 'hidden' for
        // a fully OCCLUDED window, so this fires on an alt-tab, not just a dock
        // minimize. With the atlas rebuild dropped the per-regain cost is one
        // full-range repaint per visible pane — cheap enough to pay on every app
        // switch. See the plan's Side Effects note before adding any gate here.
        //
        // The repair is LATCHED, not run inline here. In the shell an inactive panel
        // is display:none, and a nested document still receives the top-level
        // visibilitychange — so repairing only what is currently rendered would miss
        // every terminal in a hidden Terminals iframe, and the later reveal goes
        // through ResizeObserver -> startFitLadder, whose verdict is 'ok' (cols/rows
        // and the painted grid all agree; a corrupt glyph model is invisible to
        // inspectPaneFit) and therefore repairs nothing. The flag survives until the
        // pane actually has a box.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') { return; }
            for (const entry of terminalsMap.values()) {
                if (!entry || entry.disposed || !entry.term) { continue; }
                entry.needsRendererResync = true;
            }
            // The ladder owns the schedule: attempt 0 is a double rAF, later attempts
            // are timers, and fitLadderGen collapses rapid minimize/restore cycles into
            // one live ladder per terminal.
            const slotCount = getSlotCount(effectiveLayout);
            for (let i = 0; i < slotCount; i++) {
                const name = paneAssignments[i];
                if (name) { startFitLadder(name); }
            }
        });

        // Pane focus change (pane click, tab, sidebar) can also leave the canvas
        // stale. Use DOM focusin/focusout on the grid, not xterm's term.onFocus,
        // which the vendored public class does not expose. The affected pane is
        // found by its host container, because the actual target is xterm's hidden
        // textarea.
        if (paneGridEl) {
            const flagPaneForResync = (e) => {
                const host = e.target instanceof Element
                    ? e.target.closest('.terminal-view-host')
                    : null;
                if (!host) { return; }
                // Focus moved WITHIN this pane (xterm's own textarea <-> screen, or a
                // link handler stealing and returning it). The pane never lost focus,
                // so there is nothing to repair — and without this the pair of
                // focusout+focusin restarts the same terminal's ladder twice.
                const other = e.relatedTarget;
                if (other instanceof Element && host.contains(other)) { return; }
                for (const [name, entry] of terminalsMap) {
                    if (entry.container !== host) { continue; }
                    if (entry.disposed || !entry.term) { return; }
                    entry.needsRendererResync = true;
                    startFitLadder(name);
                    return;
                }
            };
            paneGridEl.addEventListener('focusin', flagPaneForResync);
            paneGridEl.addEventListener('focusout', flagPaneForResync);
        }

        fetchKanbanColumnStructure(true);

        if (soloTerminalName) {
            // Paint the transient state BEFORE the first fetch. checkSoloNotFound is
            // otherwise only reached from a fetch that SUCCEEDED, so a slow or failed
            // first fetch would leave the window blank instead of "Connecting…".
            checkSoloNotFound();
            fetchTerminalList();
        } else if (teamScopeId) {
            // Team mode: load namespaced layout settings + agent names, then
            // paint the transient "Connecting…" state before the first fetch.
            // The group record (for the title and header) resolves from
            // loadLayoutSettings' read of terminals.groups.
            Promise.all([loadLayoutSettings(), fetchAgentNames()]).then(() => {
                const group = getScopedTeamGroup();
                if (group) {
                    document.title = group.shortName || group.name || 'Team';
                    // Lock to the team's group so seatActiveGroupPage works.
                    activeGroupId = group.id;
                    _queueMode = group.queueMode === 'auto' ? 'auto' : 'manual';
                } else {
                    _queueMode = 'manual';
                }
                syncLayoutPickerUI();
                checkTeamNotFound();
                fetchTerminalList();
            });
        } else {
            // Labels before the first paint, so rows do not visibly gain their CLI
            // name a beat after appearing.
            Promise.all([loadLayoutSettings(), fetchAgentNames()]).then(() => {
                // The picker’s `active` class is hardcoded on the "1" button in the HTML
                // as the pre-JS default (loadLayoutSettings is an async verb call). Nothing
                // else moved it: only setLayoutMode does, and only a user click calls that.
                // Without this the picker showed "1" while the grid rendered the stored
                // layout — the control and the panel disagreed from the first frame.
                syncLayoutPickerUI();
                fetchTerminalList();
            });
        }

        // Fleet-list catch-up on visibility regain. Registered AFTER the first-fetch
        // dispatch above, and deliberately NOT folded into the renderer-repair
        // visibilitychange listener earlier in init(): terminal-solo-popout-contract
        // asserts that init paints the transient "Connecting…" state before the first
        // `fetchTerminalList()` appears, and it reads init as source text — a deferred
        // fetch inside an earlier listener body reads as an earlier first fetch and
        // breaks a contract that is otherwise still true.
        //
        // Why it is needed at all: startFleetPoll skips its tick on
        // `visibilityState === 'hidden'`, and Chromium reports a FULLY OCCLUDED popup
        // as hidden — not just a background tab. A popped-out panel sitting behind the
        // main browser window therefore stops polling entirely and is frozen rather
        // than 5s-stale. Catch up on the way back rather than removing the skip:
        // polling a covered window is still wasted work.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') { fetchTerminalList(); }
        });

        startFleetPoll();
        updateTeamStartButtons();
        // "Working, no output" signal sweep — see updateWorkingSilence. Started
        // once here; the interval self-guards against double-start.
        startWorkingSilenceSweep();
    }

    function postFleetStateToShell() {
        if (window.parent === window) { return; }
        // The right-hand dock is a SECOND /terminals page inside the same shell.
        // The guard above covers pop-outs (no parent) but NOT the dock, which has
        // one. Its snapshot comes from the same ptyListTerminals, so relaying it
        // only adds a racing writer for the rail's fleet strip — and a WORSE one:
        // solo mode skips fetchAgentNames, so agentLabelForRole returns '' for
        // every role and the dock's snapshot would repaint the whole rail with
        // default brand icons. The panel is the single relay; the dock is mute.
        if (isDockFrame) { return; }
        const terminals = fleetList.map(t => {
            let light = 'active';
            let doneStamp = 0;
            if (t.status === 'exited') {
                light = 'exited';
            } else if (terminalBadges.has(t.friendlyName)) {
                light = 'done';
                // Monotonic per completion. The shell rebuilds every rail button on
                // every push (5s poll + terminalsChanged), so `light === 'done'` twice
                // running cannot tell a fresh completion from a stale one. The stamp
                // can — and it also distinguishes a SECOND completion of a terminal
                // whose badge never cleared, which a plain edge detector would miss.
                doneStamp = terminalBadges.get(t.friendlyName).stamp;
            }
            // Resolve the coloured brand icon URI panel-side so the shell needs no
            // brand-icon table or data-brand-icon-* body attributes of its own.
            // agentLabelForRole returns '' for NO_ROLE / 'No agent assigned';
            // brandIconForCliLabel('') returns null, so fall back to the default icon
            // rather than sending an empty src (a broken-image glyph in the rail).
            const agentLabel = agentLabelForRole(t.role);
            const iconKey = brandIconForCliLabel(agentLabel) || 'default';
            const iconUri = brandIconUri(iconKey) || brandIconUri('default');
            return {
                name: t.friendlyName,
                role: t.role,
                worktreePath: t.worktreePath,
                light,
                doneStamp,
                iconUri
            };
        });

        // Build a `teams` array beside `terminals` so the shell rail can render
        // one button per team (wearing the team's icon) instead of one per
        // terminal. Only spawned team groups (team_ prefix + teamGroup flag OR
        // teamKind: 'spawned') become team buttons — derived role/worktree
        // groups and hand-saved selections do not. The shell decides what to
        // draw; a shell that has not been updated must keep working against a
        // new panel, and vice versa, so `terminals` stays unchanged + complete.
        //
        // Sort by definition order (the order the operator authored teams in
        // the TEAMS tab), then name — never fleet-poll order, which would make
        // icons jump between polls. The shell cannot sort by definition order
        // it does not have, so this MUST be panel-side.
        //
        // Aggregate light per team: 'done' if ANY member has an unacknowledged
        // completion badge, else 'active' if any member is active, else
        // 'exited'. doneStamp = max over member stamps — a second member
        // finishing raises the stamp and re-pulses exactly once.
        const teams = buildTeamsForShell();

        window.parent.postMessage({
            type: 'terminalFleetState',
            terminals,
            teams
        }, location.origin);
    }

    /**
     * Resolve a stored icon value to a URL, mirroring `resolveArt` in
     * kanban.html. Three accepted forms:
     *   art:<name>  → /static/icons/<name>.png
     *   pack:<file> → /static/icons/<url-encoded file>
     *   data:...    → the data URI itself
     * Empty/absent → null. Never throws.
     */
    function resolveArtForShell(value) {
        const v = String(value || '').trim();
        if (!v) { return null; }
        if (v.startsWith('data:')) { return v; }
        if (v.startsWith('art:')) {
            const name = v.slice('art:'.length).trim();
            if (!name) { return null; }
            return '/static/icons/' + encodeURIComponent(name) + '.png';
        }
        if (v.startsWith('pack:')) {
            const file = v.slice('pack:'.length).trim();
            if (!file) { return null; }
            return '/static/icons/' + encodeURIComponent(file);
        }
        return null;
    }

    /** Whether a terminals.groups row is a spawned team (not a hand-saved
     *  selection). Mirrors isSpawnedTeamGroup in teamWiring.ts: teamKind
     *  'spawned' OR legacy team_-prefixed + teamGroup flag.
     *
     *  THE single seam for "is this a real team?" on this panel — the sole
     *  declaration in this IIFE (a second one further down was deleted; it
     *  hoisted over this body and won). Every consumer, guards included, must
     *  call this rather than testing `g.teamGroup` alone: a row carrying
     *  `teamKind: 'spawned'` without the legacy flag is still a team, and a
     *  bare-flag test would wave it straight past the sidebar guards.
     *
     *  Requiring the flag on the legacy arm is safe here because BOTH client
     *  load paths (loadLayoutSettings, reloadTerminalGroups) stamp
     *  `teamGroup: true` onto every team_-prefixed row as it lands, and
     *  derived groups are `dg_`-prefixed so they can never match. */
    function isSpawnedTeamGroup(g) {
        if (!g || typeof g !== 'object') { return false; }
        if (g.teamKind === 'spawned') { return true; }
        return g.teamGroup === true
            && typeof g.id === 'string'
            && g.id.startsWith('team_');
    }

    /** Cached agent group definitions (team templates with icon, headRole,
     *  members). Refreshed async by refreshAgentGroupsForShell — the first
     *  fleet push may carry no team icons, but the cache converges by the
     *  next poll (5s). Without this the rail would block on every push. */
    let _agentGroupsCache = [];
    let _agentGroupsFetchInFlight = false;

    function updateTeamStartButtons() {
        const hasTeams = (_agentGroupsCache && _agentGroupsCache.length > 0);
        const btnAllTeams = document.getElementById('btn-start-all-teams');
        const btnOpenAll = document.getElementById('btn-open-all');
        if (btnAllTeams) { btnAllTeams.hidden = !hasTeams; }
        if (btnOpenAll)  { btnOpenAll.hidden  =  hasTeams; }
    }

    /** Refresh the cached agent group definitions in the background. Called
     *  from postFleetStateToShell so the cache stays current without blocking
     *  the relay. The definitions carry the `icon` field the team icon picker
     *  wrote — the shell rail's team buttons read it through resolveArtForShell. */
    function refreshAgentGroupsForShell() {
        if (_agentGroupsFetchInFlight || isKanbanDock) { return; }
        _agentGroupsFetchInFlight = true;
        fetchAgentGroups().then(groups => {
            _agentGroupsCache = Array.isArray(groups) ? groups : [];
            updateTeamStartButtons();
        }).catch(() => { /* keep stale cache */ }).finally(() => {
            _agentGroupsFetchInFlight = false;
        });
    }

    /** Refresh queue depths for all spawned teams in the background. Called
     *  from buildTeamsForShell so the rail badge stays current without
     *  blocking the relay. Fetches each team's queue list and stores the
     *  count in _teamQueueDepths. Non-blocking — stale depth beats no depth. */
    function refreshTeamQueueDepths() {
        if (_queueDepthFetchInFlight || isKanbanDock) { return; }
        // Only fetch for spawned team groups.
        const teamIds = terminalGroups
            .filter(g => isSpawnedTeamGroup(g))
            .map(g => g.id);
        if (teamIds.length === 0) { return; }
        _queueDepthFetchInFlight = true;
        Promise.all(teamIds.map(async (id) => {
            try {
                const res = await fetch(`/terminals/teams/${encodeURIComponent(id)}/queue`, {
                    method: 'GET',
                    credentials: 'same-origin'
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.success && Array.isArray(data.items)) {
                        _teamQueueDepths.set(id, data.items.length);
                    }
                    if (data && typeof data.inFlight === 'boolean') {
                        _teamInFlight.set(id, data.inFlight);
                    }
                }
            } catch { /* keep stale */ }
        })).catch(() => { /* ignore */ }).finally(() => {
            _queueDepthFetchInFlight = false;
        });
    }

    const DEFAULT_TEAM_DEFINITIONS = [
        {
            id: 'planning-team',
            name: 'Planning team',
            headRole: 'planner',
            members: [],
        },
        {
            id: 'feature-implementation',
            name: 'Lead team',
            headRole: 'lead',
            members: [],
        },
        {
            id: 'review-team',
            name: 'Review team',
            headRole: 'reviewer',
            members: [],
        },
    ];

    /** Build the `teams` array for the shell rail. Always emits exactly three
     *  fixed slots, one per default team definition, in fixed array order.
     *  Running slots carry groupId and live member info; dormant slots carry
     *  running: false. Operator-created fourth+ teams do not appear in the
     *  rail — they live in the Agent Control and Terminals panels. */
    function buildTeamsForShell() {
        // Kick off a background refresh of the definition cache so the next
        // push carries current icons. Non-blocking — the current push uses
        // whatever the cache holds right now.
        refreshAgentGroupsForShell();
        // Kick off a background refresh of queue depths for the rail badge.
        refreshTeamQueueDepths();

        const fleetByFriendly = new Map(fleetList.map(t => [t.friendlyName, t]));
        const defMap = new Map((_agentGroupsCache || []).map(g => [g.id, g]));

        const teamEntries = [];
        for (const def of DEFAULT_TEAM_DEFINITIONS) {
            const cachedDef = defMap.get(def.id) || null;
            const name = (cachedDef && cachedDef.name) || def.name;
            const headRole = (cachedDef && cachedDef.headRole) || def.headRole;
            const iconValue = cachedDef && cachedDef.icon ? cachedDef.icon : null;
            const iconUri = iconValue ? resolveArtForShell(iconValue) : '';

            // Find matching live spawned group by definitionId, or fallback to head role matching.
            // If two live groups claim the same definition id, bind to the first by stable order.
            const liveGroup = terminalGroups.find(g =>
                isSpawnedTeamGroup(g) && (g.definitionId === def.id || (!g.definitionId && (g.headRole === headRole || (fleetByFriendly.get(g.head)?.role === headRole))))
            ) || null;

            let running = false;
            let liveMembers = [];
            let activeCount = 0;
            let exitedCount = 0;
            let headName = '';

            if (liveGroup) {
                const members = Array.isArray(liveGroup.members) ? liveGroup.members : [];
                liveMembers = members.filter(name => fleetByFriendly.has(name));
                for (const memberName of liveMembers) {
                    const t = fleetByFriendly.get(memberName);
                    if (t) {
                        if (t.status === 'exited') {
                            exitedCount++;
                        } else {
                            activeCount++;
                        }
                    }
                }
                headName = (typeof liveGroup.head === 'string' && liveGroup.head) ? liveGroup.head
                    : (members.length > 0 ? members[0] : '');
                running = activeCount > 0;
            }

            teamEntries.push({
                definitionId: def.id,
                name,
                head: headName,
                headRole,
                iconUri: iconUri || '',
                running,
                dispatched: (running && liveGroup) ? Boolean(_teamInFlight.get(liveGroup.id)) : false,
                groupId: (running && liveGroup) ? liveGroup.id : null,
                memberNames: running ? liveMembers : [],
                activeCount,
                exitedCount,
                queueDepth: (running && liveGroup) ? (_teamQueueDepths.get(liveGroup.id) || 0) : 0,
            });
        }

        return teamEntries;
    }

    const LAYOUTS = {
        '1':   { slots: 1, minW: 0,   minH: 0   },
        '2h':  { slots: 2, minW: 400, minH: 0   },
        '2v':  { slots: 2, minW: 0,   minH: 250 },
        // ROWS x COLUMNS, like 2x3/3x3: one row of three columns. Three columns need the
        // same width as 2x3 (750); one row needs no height floor, same as 2h.
        '1x3': { slots: 3, minW: 750, minH: 0   },
        '2x2': { slots: 4, minW: 500, minH: 300 },
        '2x3': { slots: 6, minW: 750, minH: 300 },
        '3x3': { slots: 9, minW: 750, minH: 450 },
    };

    // Descent chain for resolveFlooredLayout(): ordered by demand, not by slot count, so
    // every rung can actually be reached. 1x3 sits under 2x3 (same width, no height
    // floor) — a wide-but-short window lands there instead of skipping to 2h.
    const LAYOUT_FLOOR_ORDER = ['3x3', '2x3', '1x3', '2x2', '2h', '2v', '1'];
    const LAYOUT_MODES = Object.keys(LAYOUTS);

    function getSlotCount(layout) {
        return (LAYOUTS[layout] || LAYOUTS['1']).slots;
    }

    function getMaxSlotCount() {
        return Math.max(...LAYOUT_MODES.map(m => LAYOUTS[m].slots));
    }

    // Grow ladder for open-all. Slot-ordered, unlike LAYOUT_FLOOR_ORDER (which is
    // demand-ordered for the DOWNWARD floor walk). '2v' is deliberately absent: it
    // holds the same two panes as '2h' but stacks them, and auto-picking a stacked
    // pair over a side-by-side one is a taste call that belongs to the operator.
    const LAYOUT_GROW_ORDER = ['1', '2h', '1x3', '2x2', '2x3', '3x3'];

    /**
     * Smallest layout that seats `count` terminals, never smaller than what the
     * operator already picked. Returns currentLayout when nothing needs to change.
     *
     * Monotonic by construction: the early return covers count <= currentSlots, and
     * LAYOUT_GROW_ORDER is slot-ascending, so the first rung that fits can never have
     * fewer slots than currentLayout.
     *
     * This is the ONLY upward layout movement in the panel. applyLayoutFloor() still
     * owns effectiveLayout and can demote this pick on a small window — that is the
     * fallback banner's job to explain, not this function's to pre-empt.
     */
    function layoutForFleetCount(count) {
        const currentSlots = getSlotCount(currentLayout);
        if (count <= currentSlots) { return currentLayout; }
        for (const mode of LAYOUT_GROW_ORDER) {
            if (LAYOUTS[mode].slots >= count) { return mode; }
        }
        return '3x3';
    }

    /**
     * Smallest layout that seats `count` terminals, with NO currentLayout floor.
     *
     * The non-ratcheting sibling of layoutForFleetCount: a group switch is a
     * restore, and a restore must be able to go down. Walks LAYOUT_GROW_ORDER
     * (slot-ascending) and returns the first rung whose slot count is >= count.
     * '2v' is deliberately absent from LAYOUT_GROW_ORDER (see its comment) so a
     * stacked pair is never auto-picked — a stored '2v' is honoured by the
     * stored-layout branch of layoutForGroupSwitch, not by this fallback.
     */
    function smallestLayoutFitting(count) {
        for (const mode of LAYOUT_GROW_ORDER) {
            if (LAYOUTS[mode].slots >= count) { return mode; }
        }
        return '3x3';
    }

    /**
     * Widen the grid so a just-created fleet has somewhere to sit.
     *
     * setLayoutMode() does NOT persist (the picker's click handler calls
     * saveLayoutSettings() itself), so the caller owns persistence — see the tail of
     * openAllTerminals().
     *
     * No-op in solo mode. Solo hides .terminals-sidebar, which is where the open-all
     * button lives, so this is unreachable today; the guard keeps the helper safe if a
     * future caller is not so lucky (saveSetting is already suppressed under solo).
     */
    function growLayoutForFleet(count) {
        if (document.body.classList.contains('is-solo')) { return false; }
        const target = layoutForFleetCount(count);
        if (target === currentLayout) { return false; }
        setLayoutMode(target);   // syncs the picker, re-renders, re-applies the floor
        return true;
    }

    /** Keys whose stored value is per-window layout state, not fleet-wide
     *  truth. In team-scoped mode these are namespaced under
     *  `terminals.team.<groupId>.<key>` so a team window's layout does not
     *  overwrite the main cockpit's. Fleet-wide keys (groups, groupPrefs,
     *  standingOrders, agentGroups) are deliberately NOT listed here. */
    const TEAM_NAMESPACED_KEYS = new Set([
        'terminals.layoutMode',
        'terminals.paneAssignments',
        'terminals.pinnedPanes',
        'terminals.paneModes',
        'terminals.collapsedGroups',
        'terminals.kanbanPaneColumn',
        'terminals.kanbanPaneWorkspace',
        'terminals.kanbanPaneProject',
        'terminals.activeGroupId'
    ]);

    /** Map a setting key to its effective storage key. In team-scoped mode,
     *  layout-family keys are prefixed with `terminals.team.<groupId>.` so
     *  each team window persists its layout independently. Fleet-wide keys
     *  pass through unchanged. Outside team mode, all keys pass through. */
    function mapSettingKey(key) {
        if (!teamScopeId) { return key; }
        if (!TEAM_NAMESPACED_KEYS.has(key)) { return key; }
        return `terminals.team.${teamScopeId}.${key.replace(/^terminals\./, '')}`;
    }

    async function loadSetting(key, defaultVal) {
        const storageKey = mapSettingKey(key);
        try {
            const res = await fetch('/kanban/verb/getSetting', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: storageKey })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.value !== undefined) {
                    return data.value;
                }
            }
        } catch { /* ignore */ }
        return defaultVal;
    }

    async function saveSetting(key, value, baseIds) {
        if (soloTerminalName) { return; }
        const storageKey = mapSettingKey(key);
        try {
            const body = { key: storageKey, value };
            const effectiveBaseIds = baseIds !== undefined ? baseIds : (key === 'terminals.groups' ? lastReadGroupIds : undefined);
            if (Array.isArray(effectiveBaseIds)) {
                body.baseIds = effectiveBaseIds;
            }
            const res = await fetch('/kanban/verb/saveSetting', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok) {
                const data = await res.json();
                if (key === 'terminals.groups' && data && data.success !== false && Array.isArray(data.value)) {
                    // Adopt ONLY the ids this panel actually holds. The host
                    // returns the merged array — client rows PLUS any stored
                    // group the client never read — and those merged-in rows are
                    // not in `terminalGroups`. Claiming to have seen one makes it
                    // "seen and deleted" on the next whole-array save, which is
                    // the clobber this guard exists to prevent. They stay unseen
                    // until a real read (loadLayoutSettings / reloadTerminalGroups)
                    // puts them in the in-memory array.
                    const held = new Set((Array.isArray(value) ? value : [])
                        .map(g => g && g.id).filter(Boolean));
                    lastReadGroupIds = data.value.map(g => g && g.id).filter(id => id && held.has(id));
                    if (data.value.length > held.size) {
                        // The host merged rows we have never loaded — pull them in
                        // so the panel (and its next baseIds) catches up. Cheap:
                        // only fires when a stale save actually met unseen groups.
                        reloadTerminalGroups();
                    }
                }
            }
        } catch { /* ignore */ }
    }

    /** Clean up namespaced layout keys for a deleted team group. Called from
     *  `deleteGroup` when a manual group is removed. Without this, the
     *  `terminals.team.<groupId>.*` keys accumulate as storage orphans. No
     *  delete verb exists, so each key is overwritten with null — the host
     *  treats a null value as unset for these layout-family keys. */
    function deleteNamespacedTeamKeys(groupId) {
        if (!groupId) { return; }
        for (const baseKey of TEAM_NAMESPACED_KEYS) {
            const shortKey = baseKey.replace(/^terminals\./, '');
            const namespacedKey = `terminals.team.${groupId}.${shortKey}`;
            try {
                fetch('/kanban/verb/saveSetting', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: namespacedKey, value: null })
                });
            } catch { /* ignore — best-effort cleanup */ }
        }
    }

    async function loadLayoutSettings() {
        const savedMode = await loadSetting('terminals.layoutMode', '1');
        const savedPanes = await loadSetting('terminals.paneAssignments', []);
        const savedCollapsed = await loadSetting('terminals.collapsedGroups', []);
        const savedPins = await loadSetting('terminals.pinnedPanes', []);
        const savedModes = await loadSetting('terminals.paneModes', []);
        const savedKanbanCols = await loadSetting('terminals.kanbanPaneColumn', []);
        const savedKanbanWs = await loadSetting('terminals.kanbanPaneWorkspace', []);
        const savedKanbanProj = await loadSetting('terminals.kanbanPaneProject', []);

        // LINK_PRESETS is declared ~6000 lines below, but this function is only
        // called from init() after the whole IIFE body has run top to bottom.
        // Validated against the WHOLE list because buildPresetOptions() builds an
        // <option> for every entry. The two must stay in step: an id that survives
        // validation but is never built makes `presetSel.value = linkPreset` a
        // silent no-op, leaving a blank dropdown above an empty box and a dead
        // SEND with nothing on screen to explain it.
        const savedPreset = await loadSetting('terminals.linkPreset', LINK_PRESETS[0].id);
        linkPreset = LINK_PRESETS.some(p => p.id === savedPreset) ? savedPreset : LINK_PRESETS[0].id;

        const savedLinkMode = await loadSetting('terminals.linkMode', 'instant');
        linkMode = ['instant', 'standing'].includes(savedLinkMode) ? savedLinkMode : 'instant';

        const savedGroups = await loadSetting('terminals.groups', []);
        if (Array.isArray(savedGroups)) {
            terminalGroups = savedGroups.filter(g =>
                g && typeof g.id === 'string' && typeof g.name === 'string' &&
                LAYOUT_MODES.includes(g.layout)
            ).map(g => {
                if (g.source === 'manual' || g.source === 'role' || g.source === 'worktree') {
                    return g;
                }
                // Legacy dev-build snapshot: a (layout, assignments) row becomes a manual
                // group whose members/order are the saved assignments with holes removed.
                if (Array.isArray(g.assignments)) {
                    const members = g.assignments.filter(Boolean);
                    return { id: g.id, name: g.name, source: 'manual', layout: g.layout, members, order: members };
                }
                return null;
            }).filter(Boolean).map(g => {
                if (g && typeof g.id === 'string' && g.id.startsWith('team_') && !g.teamGroup) {
                    return { ...g, teamGroup: true };
                }
                return g;
            });
            lastReadGroupIds = terminalGroups.map(g => g.id);
        }
        const savedActive = await loadSetting('terminals.activeGroupId', null);
        activeGroupId = (typeof savedActive === 'string' || savedActive === null) ? savedActive : null;

        const savedGroupPrefs = await loadSetting('terminals.groupPrefs', null);
        if (savedGroupPrefs && typeof savedGroupPrefs === 'object') {
            // Validate stored layouts against LAYOUT_MODES so a hand-edited or
            // stale setting cannot inject an unknown layout id.
            const savedLayouts = (savedGroupPrefs.layouts && typeof savedGroupPrefs.layouts === 'object')
                ? Object.fromEntries(
                    Object.entries(savedGroupPrefs.layouts)
                        .filter(([_, v]) => typeof v === 'string' && LAYOUT_MODES.includes(v))
                )
                : {};
            // Coerce each extras value to an array of strings — an install with
            // no stored extras must load to {} and behave exactly as today.
            const savedExtras = (savedGroupPrefs.extras && typeof savedGroupPrefs.extras === 'object')
                ? Object.fromEntries(
                    Object.entries(savedGroupPrefs.extras)
                        .filter(([_, v]) => Array.isArray(v))
                        .map(([k, v]) => [k, v.filter(name => typeof name === 'string')])
                )
                : {};
            groupPrefs = {
                threshold: Number(savedGroupPrefs.threshold) > 1 ? Math.floor(savedGroupPrefs.threshold) : 2,
                hidden: Array.isArray(savedGroupPrefs.hidden) ? savedGroupPrefs.hidden.filter(id => typeof id === 'string') : [],
                pinned: Array.isArray(savedGroupPrefs.pinned) ? savedGroupPrefs.pinned.filter(id => typeof id === 'string') : [],
                orders: (savedGroupPrefs.orders && typeof savedGroupPrefs.orders === 'object') ? savedGroupPrefs.orders : {},
                layouts: savedLayouts,
                extras: savedExtras,
                // Opt-in and stays opt-in: absent or non-true reads as false.
                autoRoleGroups: savedGroupPrefs.autoRoleGroups === true
            };
        }

        if (LAYOUT_MODES.includes(savedMode)) {
            currentLayout = savedMode;
        }
        effectiveLayout = currentLayout;
        if (Array.isArray(savedPanes)) {
            paneAssignments = savedPanes;
        }
        if (Array.isArray(savedPins)) {
            pinnedPanes = savedPins.map(Boolean);
        }
        if (Array.isArray(savedModes)) {
            paneModes = savedModes.map(m => m === 'kanban' ? 'kanban' : 'terminal');
        }
        if (Array.isArray(savedKanbanCols)) {
            kanbanPaneColumn = savedKanbanCols;
        }
        if (Array.isArray(savedKanbanWs)) {
            kanbanPaneWorkspace = savedKanbanWs;
        }
        if (Array.isArray(savedKanbanProj)) {
            kanbanPaneProject = savedKanbanProj;
        }
        if (Array.isArray(savedCollapsed)) {
            savedCollapsed.forEach(c => collapsedGroups.add(c));
        }

        if (soloTerminalName) {
            currentLayout = '1';
            effectiveLayout = '1';
            paneAssignments = [soloTerminalName];
            paneModes = ['terminal'];
        } else if (isKanbanDock) {
            currentLayout = '1';
            effectiveLayout = '1';
            paneAssignments = [null];
            paneModes = ['kanban'];
        }
    }

    function saveLayoutSettings() {
        if (soloTerminalName || isKanbanDock) { return; }
        saveSetting('terminals.layoutMode', currentLayout);
        saveSetting('terminals.paneAssignments', paneAssignments);
        saveSetting('terminals.pinnedPanes', pinnedPanes);
        saveSetting('terminals.collapsedGroups', Array.from(collapsedGroups));
        saveSetting('terminals.paneModes', paneModes);
        saveSetting('terminals.kanbanPaneColumn', kanbanPaneColumn);
        saveSetting('terminals.kanbanPaneWorkspace', kanbanPaneWorkspace);
        saveSetting('terminals.kanbanPaneProject', kanbanPaneProject);
        saveSetting('terminals.groups', terminalGroups);
        saveSetting('terminals.activeGroupId', activeGroupId);
        saveSetting('terminals.groupPrefs', groupPrefs);
    }

    /** Save ONLY the team-namespaced layout keys (TEAM_NAMESPACED_KEYS).
     *  Used on a direct team-to-team switch. saveLayoutSettings() would also
     *  write the two FLEET-WIDE keys — `terminals.groups` and
     *  `terminals.groupPrefs` — and that whole-array groups POST races the
     *  `loadLayoutSettings()` read two statements later, the same race
     *  exitTeamScope snapshots terminalGroups to survive. The groups roster
     *  does not change when the scope does, so there is nothing to save there.
     */
    function saveTeamScopedLayoutSettings() {
        saveSetting('terminals.layoutMode', currentLayout);
        saveSetting('terminals.paneAssignments', paneAssignments);
        saveSetting('terminals.pinnedPanes', pinnedPanes);
        saveSetting('terminals.collapsedGroups', Array.from(collapsedGroups));
        saveSetting('terminals.paneModes', paneModes);
        saveSetting('terminals.kanbanPaneColumn', kanbanPaneColumn);
        saveSetting('terminals.kanbanPaneWorkspace', kanbanPaneWorkspace);
        saveSetting('terminals.kanbanPaneProject', kanbanPaneProject);
        saveSetting('terminals.activeGroupId', activeGroupId);
    }

    /**
     * Re-read `terminals.groups` from the DB and merge by id into the in-memory
     * `terminalGroups`. Called on the `terminalsGroupsChanged` push from
     * teamWiring.ts, so a backend-registered group appears in an open panel
     * before the panel's next whole-array save can clobber it.
     *
     * Merge, not replace: a reload that arrives mid-drag must not discard an
     * in-flight local edit. New groups (ids not yet in memory) are added.
     * For existing groups, the backend owns `members` and `order` for rows
     * it registers (team spawns/restarts); `layout` and every other local
     * UI field remain the panel's.
     */
    async function reloadTerminalGroups() {
        try {
            const savedGroups = await loadSetting('terminals.groups', []);
            if (!Array.isArray(savedGroups)) { return; }
            const validated = savedGroups.filter(g =>
                g && typeof g.id === 'string' && typeof g.name === 'string' &&
                LAYOUT_MODES.includes(g.layout) &&
                (g.source === 'manual' || g.source === 'role' || g.source === 'worktree')
            ).map(g => {
                if (g.id.startsWith('team_') && !g.teamGroup) {
                    return { ...g, teamGroup: true };
                }
                return g;
            });
            const existingMap = new Map(terminalGroups.map(g => [g.id, g]));
            let changed = false;
            for (const g of validated) {
                const existing = existingMap.get(g.id);
                if (!existing) {
                    terminalGroups.push(g);
                    // Register it so the same id arriving twice in one read
                    // refreshes the row just pushed rather than pushing a
                    // second copy — a duplicate would survive into the next
                    // whole-array save.
                    existingMap.set(g.id, g);
                    changed = true;
                } else {
                    if (Array.isArray(g.members)) {
                        const membersChanged = JSON.stringify(existing.members) !== JSON.stringify(g.members);
                        if (membersChanged) {
                            existing.members = [...g.members];
                            changed = true;
                        }
                    }
                    if (Array.isArray(g.order)) {
                        const orderChanged = JSON.stringify(existing.order) !== JSON.stringify(g.order);
                        if (orderChanged) {
                            existing.order = [...g.order];
                            changed = true;
                        }
                    }
                }
            }
            lastReadGroupIds = validated.map(g => g.id);
            if (changed) {
                renderSidebarList();
                // Fleet mode only. renderSidebarList() renders the strip
                // itself; this explicit redraw is the one that refreshes the
                // tabs' live member counts when the backend rewrites a roster.
                // In team-scoped mode it is destructive: renderTeamHeader()
                // has already APPENDED the team context bar into
                // groupTabStripEl, and a bare renderGroupTabStrip() re-wipes
                // that element — taking the header, and any live `team:*` role
                // picker mounted beside it, with it on every team spawn or
                // restart push.
                if (!teamScopeId) { renderGroupTabStrip(); }
            }
        } catch { /* ignore — the next fleet poll will pick it up */ }
    }

    async function fetchTerminalList() {
        await fetchKanbanColumnStructure();
        try {
            const res = await fetch('/terminals/verb/ptyListTerminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.terminals)) {
                    hasFetchedList = true;
                    fleetList = data.terminals;
                    parentsList = data.parents || [];
                    heldUnposted = (data.heldUnposted && typeof data.heldUnposted === 'object') ? data.heldUnposted : {};
                    // Self-heal for a custom agent added mid-session: only re-reads when
                    // a role turns up that the cached label map has never seen, so the
                    // common terminalsChanged refresh costs nothing extra.
                    if (fleetList.some(t => t.role && !(t.role in agentNames))) {
                        await fetchAgentNames();
                    }
                    if (!restoredLockOnLoad && activeGroupId) {
                        restoredLockOnLoad = true;
                        const savedId = String(activeGroupId);
                        if (getAllGroups().some(g => g.id === savedId)) {
                            switchToGroup(savedId, { noSave: true });
                        } else if (!groupPrefs.autoRoleGroups && savedId.startsWith('dg_role_')) {
                            // Role grouping is off, so getDerivedGroups emits no role tab at all and
                            // this id can never resolve. switchToGroup would early-return and leave
                            // the panel soft-dead: no active tab, an inert seatActiveGroupPage, and
                            // a dead empty-pane fill. clearGroupLock re-seats from the UNASSIGNED
                            // live fleet honouring pins, and saves.
                            //
                            // Deliberately NOT "any unresolved dg_role_ id": with role grouping ON,
                            // an absent group means the location is merely below threshold, and
                            // clearing there would persist activeGroupId = null and discard a lock
                            // that the next spawn would have restored.
                            clearGroupLock();
                        }
                    }
                    sanitizePaneAssignments();
                    renderSidebarList();
                    renderPaneGrid();
                    // First paint is also the first chance to measure the grid, so the
                    // floor is evaluated here rather than only on a later resize.
                    applyLayoutFloor();
                    await fetchStandingOrders();
                    postFleetStateToShell();
                    checkSoloNotFound();
                    checkTeamNotFound();
                    return;
                }
            }
        } catch (err) {
            console.warn('[Terminals] Failed to fetch terminal list:', err);
        }
        // Reached on a network error, a non-OK response, or an unusable payload. This
        // function deliberately swallows all three and leaves fleetList untouched, so
        // for solo mode the state is "not loaded yet" — NOT "terminal missing". Repaint
        // the transient state and let the next terminalsChanged refetch resolve it.
        // Push the stale fleet list to the shell so the sidebar doesn't go dark during
        // a transient fetch failure — the next successful poll will correct it.
        postFleetStateToShell();
        checkSoloNotFound();
        checkTeamNotFound();
    }

    function checkSoloNotFound() {
        if (!soloTerminalName) return;
        const soloStatusEl = document.getElementById('solo-status');
        if (!soloStatusEl || !paneGridEl) return;

        if (!hasFetchedList) {
            soloStatusEl.style.display = 'flex';
            soloStatusEl.textContent = 'Connecting…';
            paneGridEl.style.display = 'none';
            return;
        }

        const isLive = fleetList.some(t => t.friendlyName === soloTerminalName);
        if (!isLive) {
            const entry = terminalsMap.get(soloTerminalName);
            if (!entry) {
                soloStatusEl.style.display = 'flex';
                soloStatusEl.textContent = `Terminal "${soloTerminalName}" not found`;
                paneGridEl.style.display = 'none';
                return;
            }
        }
        soloStatusEl.style.display = 'none';
        paneGridEl.style.display = 'grid';
        // The initial fit may have measured a just-transitioned box; the ladder
        // re-fits but never re-syncs the scroll area.
        requestAnimationFrame(() => {
            const entry = terminalsMap.get(soloTerminalName);
            if (entry) { refreshTerminalScrollbar(entry); }
        });
    }

    /** Team-scoped not-found / connecting state, modelled on checkSoloNotFound.
     *  Three states: "Connecting…" before the first fetch resolves, "Team not
     *  found" when the group record is absent (stale bookmark, deleted team),
     *  and the normal state (group exists, grid visible). Reuses #solo-status
     *  so no new DOM element is needed. */
    function checkTeamNotFound() {
        if (!teamScopeId) return;
        const statusEl = document.getElementById('solo-status');
        if (!statusEl || !paneGridEl) return;

        if (!hasFetchedList) {
            statusEl.style.display = 'flex';
            statusEl.textContent = 'Connecting…';
            paneGridEl.style.display = 'none';
            return;
        }

        const group = getScopedTeamGroup();
        if (!group) {
            statusEl.style.display = 'flex';
            statusEl.innerHTML = `Team "${teamScopeId}" is no longer registered. ` +
                `<a href="/terminals" style="color: var(--accent-teal, #4ec9b0);">Open full cockpit</a>`;
            paneGridEl.style.display = 'none';
            return;
        }

        statusEl.style.display = 'none';
        paneGridEl.style.display = 'grid';
    }

    /** Single-level undo of the last assignment mutation. Cleared when the terminal it
     *  would restore stops being live (see sanitizePaneAssignments). */
    let undoSnapshot = null; // { slots: [...paneAssignments], pins: [...pinnedPanes], name, displaced, paneIndex }
    let toastTimer = null;

    function showPaneToast(text, onUndo) {
        const toastEl = document.getElementById('pane-toast');
        const toastTextEl = document.getElementById('pane-toast-text');
        const toastUndoBtn = document.getElementById('pane-toast-undo');
        if (!toastEl || !toastTextEl || !toastUndoBtn) { return; }

        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

        toastTextEl.textContent = text;
        toastUndoBtn.onclick = () => {
            if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
            toastEl.classList.remove('visible');
            if (onUndo) { onUndo(); }
        };
        // Hide the Undo button when there is nothing to undo (e.g. the all-pinned
        // toast). Setting display on the button, not on #pane-toast, so it does not
        // fight `.pane-toast.visible { display: flex; }`.
        toastUndoBtn.style.display = onUndo ? '' : 'none';

        toastEl.classList.add('visible');
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
            toastTimer = null;
        }, 6000);
    }

    /**
     * Arm the startup curtain for a terminal THIS TAB just created.
     *
     * Deliberately not armed on "output arrived": a reattach replays up to 256 KB of
     * ring buffer (see the awaitingReplayFrame branch in the socket handler), which is
     * indistinguishable from a boot burst — arming on output would curtain every pane
     * on every reload.
     *
     * `hasStartupCommand` gates it: a plain shell has no banner to hide, so a curtain
     * there is pure added latency with nothing behind it.
     */
    function armStartupCurtain(name, hasStartupCommand) {
        if (!name || !hasStartupCommand || startupCurtains.has(name)) { return; }
        const state = { quietTimer: null, noOutputTimer: null, hardTimer: null, sawLiveOutput: false };
        // Two independent caps, not one. The hard cap covers a CLI that never stops
        // talking; the no-output cap covers the opposite failure — a pane seated so
        // late (open-all creates sequentially, ~750ms each) that its entire boot
        // arrived as replay and no live frame is ever coming.
        state.hardTimer = setTimeout(() => dismissStartupCurtain(name), CURTAIN_MAX_MS);
        state.noOutputTimer = setTimeout(() => {
            const s = startupCurtains.get(name);
            if (s && !s.sawLiveOutput) { dismissStartupCurtain(name); }
        }, CURTAIN_NO_OUTPUT_MS);
        startupCurtains.set(name, state);

        // Paint NOW rather than waiting for the next pane render. The gateway
        // broadcasts terminalsChanged from inside fleetService.create() — and for any
        // role with a startup command the create response is then withheld for
        // SHELL_READINESS_DELAY_MS (750ms) — so a terminal can already be seated and
        // rendered by the time this runs. Without this, its curtain is armed into a
        // rendered pane that nothing repaints, and it expires invisibly.
        //
        // A no-op on the open-all path by design: there the arm precedes the seat, so
        // indexOf() is -1 and the immediately following renderPaneGrid() paints via
        // updatePaneElement's existing branch. This covers the single-create (+) path,
        // where the seed branch can seat pane 0 before the arm.
        //
        // Direct node addressing, NOT renderPaneGrid(): a full reconcile would risk
        // re-parenting live xterm DOM for a purely visual change, which is exactly
        // what updatePaneElement's "no move when already in place" invariant forbids.
        // renderStartupCurtain() is idempotent, so a later reconcile cannot double it.
        if (paneGridEl) {
            const paneIndex = paneAssignments.indexOf(name);
            if (paneIndex >= 0 && paneIndex < paneGridEl.children.length) {
                const contentEl = paneGridEl.children[paneIndex].querySelector('.pane-content');
                if (contentEl) { renderStartupCurtain(contentEl, name); }
            }
        }
        // Class add, NOT renderSidebarList() — the exact mirror of the class strip in
        // dismissStartupCurtain().
        if (listEl) {
            const sel = `.item-role-icon[data-terminal="${cssAttrEscape(name)}"]`;
            listEl.querySelectorAll(sel).forEach(el => el.classList.add('is-starting'));
        }
    }

    /**
     * LIVE output arrived — restart the quiescence countdown.
     *
     * Called from scheduleBatchFlush, which every live path funnels through (binary
     * frames and the legacy t:'out' framing). Replay is deliberately EXCLUDED: the
     * awaitingReplayFrame branch returns before scheduleBatchFlush and writes via
     * writeReplay instead. That exclusion is the point — replay is output the operator
     * already missed, so treating it as "the CLI is talking" would hold the
     * curtain over a terminal that settled minutes ago.
     *
     * The quiet timer is armed HERE and nowhere else, so it can never fire during the
     * 1-4s silent gap between the command echo and the CLI's first paint.
     */
    function bumpStartupCurtain(name) {
        const state = startupCurtains.get(name);
        if (!state) { return; }
        state.sawLiveOutput = true;
        if (state.quietTimer) { clearTimeout(state.quietTimer); }
        state.quietTimer = setTimeout(() => dismissStartupCurtain(name), CURTAIN_QUIET_MS);
    }

    /** Remove the curtain and its timers. Idempotent — every dismissal path
     *  (quiescence, no-output cap, hard cap, click, exit, error, unassign, close)
     *  lands here. */
    function dismissStartupCurtain(name) {
        const state = startupCurtains.get(name);
        if (!state) { return; }
        if (state.quietTimer) { clearTimeout(state.quietTimer); }
        if (state.noOutputTimer) { clearTimeout(state.noOutputTimer); }
        if (state.hardTimer) { clearTimeout(state.hardTimer); }
        startupCurtains.delete(name);
        // Address the node directly rather than re-rendering. A renderPaneGrid() here
        // would risk moving terminal DOM for a purely visual change, which is exactly
        // what updatePaneElement's invariant forbids; and the curtain is addressed by
        // its own data-terminal stamp rather than via paneAssignments, so a curtain
        // left in a pane that has since been reassigned is still found and removed.
        if (paneGridEl) {
            const sel = `.startup-curtain[data-terminal="${cssAttrEscape(name)}"]`;
            paneGridEl.querySelectorAll(sel).forEach(el => el.remove());
        }
        // Class strip, NOT renderSidebarList(): see the callout below.
        if (listEl) {
            const sel = `.item-role-icon[data-terminal="${cssAttrEscape(name)}"]`;
            listEl.querySelectorAll(sel).forEach(el => el.classList.remove('is-starting'));
        }
    }

    /** Escape a terminal name for use inside a CSS attribute selector. friendlyName
     *  is normally `${role}-${n}`, but rename accepts arbitrary operator text, and an
     *  unescaped quote would throw out of querySelectorAll and abort the dismissal. */
    function cssAttrEscape(value) {
        return String(value).replace(/["\\]/g, '\\$&');
    }

    /**
     * "Working, no output" affordance — the operator-facing signal that a
     * silent-but-alive seat is still working. Distinct from the startup curtain:
     * that covers boot output; this names a state the product can detect but
     * today reads as a dead pane. Modeled on the bumpStartupCurtain /
     * sawLiveOutput timer pattern but on a printable-aware predicate, not a
     * any-bytes predicate (the 12 fps heartbeat keeps the latter fresh forever).
     *
     * Fires only when ALL hold: the seat holds a dispatched card (fleet item
     * planTitle/planId non-null), the pty is live (a frame arrived within
     * WORKING_LIVE_WINDOW_MS), and no printable glyph has arrived for
     * WORKING_SILENCE_MS. A genuine-idle seat nobody dispatched to never lights
     * (no card); a heartbeating seat that IS producing printables never lights
     * (lastPrintableAt resets on every glyph); a dead pty never lights (no
     * recent frame). Clears the instant a printable arrives.
     */
    function seatHoldsCard(name) {
        const item = fleetList.find(t => t.friendlyName === name);
        return !!(item && (item.planTitle || item.planId));
    }

    function renderWorkingSilence(contentEl, name) {
        if (contentEl.querySelector('.working-silence')) { workingSilenceShown.add(name); return; }
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);
        const overlay = document.createElement('div');
        overlay.className = 'working-silence';
        overlay.dataset.terminal = name;
        const label = document.createElement('div');
        label.className = 'working-silence-label';
        label.textContent = agentLabel ? `${agentLabel} is working — no output yet` : 'Working — no output yet';
        overlay.appendChild(label);
        const sub = document.createElement('div');
        sub.className = 'working-silence-sub';
        sub.textContent = 'the pane is live; output will appear when the agent prints';
        overlay.appendChild(sub);
        contentEl.appendChild(overlay);
        workingSilenceShown.add(name);
    }

    function clearWorkingSilence(name) {
        workingSilenceShown.delete(name);
        if (!paneGridEl) { return; }
        const sel = `.working-silence[data-terminal="${cssAttrEscape(name)}"]`;
        paneGridEl.querySelectorAll(sel).forEach(el => el.remove());
    }

    /** Evaluate the signal for one pane and show/clear the affordance. Called
     *  from the periodic sweep and after dispatch-state changes. Idempotent. */
    function updateWorkingSilence(name) {
        if (!paneGridEl) { return; }
        const paneIndex = paneAssignments.indexOf(name);
        if (paneIndex < 0 || paneIndex >= paneGridEl.children.length) {
            clearWorkingSilence(name);
            return;
        }
        // A pane flipped to kanban mode is showing a board column, not the
        // terminal's output — the signal is meaningless there and would render
        // over the card list.
        if (paneModes[paneIndex] === 'kanban') {
            clearWorkingSilence(name);
            return;
        }
        const entry = terminalsMap.get(name);
        if (!entry || entry.exited || entry.disposed) {
            clearWorkingSilence(name);
            return;
        }
        // Gate 1: the seat must hold a dispatched card. A plain shell that nobody
        // dispatched to can be silent for legitimate reasons (waiting for input),
        // and lighting it would cry wolf.
        if (!seatHoldsCard(name)) {
            clearWorkingSilence(name);
            return;
        }
        // Gate 2: a live frame must have established the pane is streaming, and a
        // frame must have arrived recently enough to call the pty live. Before the
        // first live frame the signal cannot fire (nothing to distinguish from a
        // pane that has not started); after the pty stops, lastFrameAt goes stale
        // and the signal drops — a dead pty is a different problem.
        const now = Date.now();
        if (!entry.lastFrameAt || (now - entry.lastFrameAt) > WORKING_LIVE_WINDOW_MS) {
            clearWorkingSilence(name);
            return;
        }
        // Gate 3: no printable glyph for the silence threshold. lastPrintableAt
        // resets on every printable frame, so a seat interleaving real output
        // with heartbeats never trips this.
        //
        // The fallback for a seat that has NEVER printed is firstFrameAt, NOT
        // lastFrameAt. lastFrameAt is restamped by every heartbeat, so it would
        // hold `now - since` at ~0 forever and the affordance could never appear
        // for the measured seat (183 frames, 0 printable characters in 15s) —
        // the exact case this signal exists to name.
        const since = entry.lastPrintableAt || entry.firstFrameAt;
        if ((now - since) < WORKING_SILENCE_MS) {
            clearWorkingSilence(name);
            return;
        }
        const contentEl = paneGridEl.children[paneIndex].querySelector('.pane-content');
        if (contentEl) { renderWorkingSilence(contentEl, name); }
    }

    /** Periodic sweep: re-evaluate every seated pane. Cheap (one Date.now + a
     *  fleet lookup per pane) and the affordance clears immediately on a
     *  printable frame via clearWorkingSilence, so the sweep only governs when
     *  the signal APPEARS. 5s cadence means it surfaces within ~5s of the
     *  threshold crossing — well under the 90s floor. */
    let workingSilenceInterval = null;
    function startWorkingSilenceSweep() {
        if (workingSilenceInterval) { return; }
        workingSilenceInterval = setInterval(() => {
            if (!paneGridEl) { return; }
            for (const name of Array.from(terminalsMap.keys())) {
                updateWorkingSilence(name);
            }
        }, 5000);
    }

    /** Create (once) the curtain inside a pane's content. Called from
     *  updatePaneElement's assigned branch; no listeners attached here — the
     *  dismiss click is delegated from createPaneElement. */
    function renderStartupCurtain(contentEl, name) {
        if (contentEl.querySelector('.startup-curtain')) { return; }
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);
        const curtain = document.createElement('div');
        curtain.className = 'startup-curtain';
        // The handle dismissStartupCurtain addresses this node by. Not derived from
        // paneAssignments at teardown time, which can have moved on.
        curtain.dataset.terminal = name;

        const iconKey = brandIconForCliLabel(agentLabel) || 'default';
        const uri = brandIconUri(iconKey) || brandIconUri('default');
        if (uri) {
            const badge = document.createElement('div');
            badge.className = 'startup-curtain-badge';
            const icon = document.createElement('img');
            icon.className = 'startup-curtain-icon';
            icon.src = uri;
            icon.alt = '';
            icon.dataset.brand = iconKey;
            badge.appendChild(icon);
            curtain.appendChild(badge);
        }

        const label = document.createElement('div');
        label.className = 'startup-curtain-label';
        label.textContent = agentLabel ? `Starting ${agentLabel}…` : 'Starting…';
        curtain.appendChild(label);

        const dismiss = document.createElement('button');
        dismiss.className = 'startup-curtain-dismiss';
        dismiss.type = 'button';
        dismiss.textContent = 'show output';
        curtain.appendChild(dismiss);

        contentEl.appendChild(curtain);
    }

    function getUfoIconUri() {
        const ds = document.body.dataset || {};
        const isClaudify = document.body.classList.contains('theme-claudify');
        const isMotionDisabled = document.body.classList.contains('cyber-animation-disabled');
        if (isClaudify) {
            return isMotionDisabled
                ? (ds.ufoClaudifyStatic || '/static/icons/switchboard-ufo-claudify-static.svg')
                : (ds.ufoClaudifyAnimated || '/static/icons/switchboard-ufo-claudify.svg');
        }
        return isMotionDisabled
            ? (ds.ufoStatic || '/static/icons/switchboard-ufo-static.svg')
            : (ds.ufoAnimated || '/static/icons/switchboard-ufo.svg');
    }

    function armDispatchCurtain(name, operationId, options = {}) {
        if (!name || !operationId) { return; }
        let opMap = dispatchCurtains.get(name);
        if (!opMap) {
            opMap = new Map();
            dispatchCurtains.set(name, opMap);
        }
        const existing = opMap.get(operationId);
        if (existing) {
            if (options.phase) existing.phase = options.phase;
            if (options.cliFamily) existing.cliFamily = options.cliFamily;
            if (options.teamName) existing.teamName = options.teamName;
        } else {
            const op = {
                operationId,
                phase: options.phase || 'clearing',
                cliFamily: options.cliFamily || '',
                teamName: options.teamName || '',
                armedAt: Date.now(),
                dismissed: false,
                hardTimer: null,
            };
            op.hardTimer = setTimeout(() => {
                op.dismissed = true;
                updatePaneCurtains(name);
            }, MAX_DISPATCH_CURTAIN_MS);
            opMap.set(operationId, op);
        }

        updatePaneCurtains(name);
        if (listEl) {
            const sel = `.item-role-icon[data-terminal="${cssAttrEscape(name)}"]`;
            listEl.querySelectorAll(sel).forEach(el => el.classList.add('is-preparing'));
        }
    }

    function disarmDispatchCurtain(name, operationId, reason, elapsedMs) {
        if (!name || !operationId) { return; }
        const opMap = dispatchCurtains.get(name);
        if (!opMap || !opMap.has(operationId)) { return; }
        const op = opMap.get(operationId);
        if (op.hardTimer) {
            clearTimeout(op.hardTimer);
            op.hardTimer = null;
        }
        const age = Date.now() - op.armedAt;
        const remaining = Math.max(0, MIN_DISPATCH_CURTAIN_MS - age);
        setTimeout(() => {
            opMap.delete(operationId);
            if (opMap.size === 0) {
                dispatchCurtains.delete(name);
                if (listEl) {
                    const sel = `.item-role-icon[data-terminal="${cssAttrEscape(name)}"]`;
                    listEl.querySelectorAll(sel).forEach(el => el.classList.remove('is-preparing'));
                }
            }
            updatePaneCurtains(name);
        }, remaining);
    }

    function updatePaneCurtains(name) {
        if (paneGridEl) {
            const paneIndex = paneAssignments.indexOf(name);
            if (paneIndex >= 0 && paneIndex < paneGridEl.children.length) {
                const contentEl = paneGridEl.children[paneIndex].querySelector('.pane-content');
                if (contentEl) {
                    renderDispatchCurtain(contentEl, name);
                }
            }
        }
    }

    function renderDispatchCurtain(contentEl, name) {
        const opMap = dispatchCurtains.get(name);
        const activeOps = opMap ? Array.from(opMap.values()).filter(op => !op.dismissed) : [];
        const existingCurtain = contentEl.querySelector(`.terminal-curtain.dispatch-curtain[data-terminal="${cssAttrEscape(name)}"]`);

        if (activeOps.length === 0) {
            if (existingCurtain) { existingCurtain.remove(); }
            return;
        }

        const latestOp = activeOps[activeOps.length - 1];
        let curtain = existingCurtain;
        if (!curtain) {
            curtain = document.createElement('div');
            curtain.className = 'terminal-curtain dispatch-curtain';
            curtain.dataset.terminal = name;

            const badge = document.createElement('div');
            badge.className = 'terminal-curtain-badge';
            const icon = document.createElement('img');
            icon.className = 'terminal-curtain-icon is-ufo dispatch-curtain-icon';
            icon.src = getUfoIconUri();
            icon.alt = '';
            badge.appendChild(icon);
            curtain.appendChild(badge);

            const label = document.createElement('div');
            label.className = 'terminal-curtain-label';
            label.textContent = 'Preparing for dispatch…';
            curtain.appendChild(label);

            const sublabel = document.createElement('div');
            sublabel.className = 'terminal-curtain-sublabel';
            curtain.appendChild(sublabel);

            const dismiss = document.createElement('button');
            dismiss.className = 'terminal-curtain-dismiss';
            dismiss.type = 'button';
            dismiss.textContent = 'show output';
            curtain.appendChild(dismiss);

            contentEl.appendChild(curtain);
        }

        const iconImg = curtain.querySelector('.dispatch-curtain-icon');
        if (iconImg) {
            const expectedSrc = getUfoIconUri();
            if (iconImg.getAttribute('src') !== expectedSrc && !iconImg.src.endsWith(expectedSrc)) {
                iconImg.src = expectedSrc;
            }
        }

        const sublabel = curtain.querySelector('.terminal-curtain-sublabel');
        if (sublabel) {
            if (latestOp.teamName) {
                sublabel.textContent = 'Preparing team for new feature run.';
            } else {
                let cliName = 'CLI';
                if (latestOp.cliFamily === 'devin') cliName = 'Devin';
                else if (latestOp.cliFamily === 'claude') cliName = 'Claude';
                else if (latestOp.cliFamily === 'antigravity') cliName = 'Antigravity';
                else {
                    const fleetItem = fleetList.find(t => t.friendlyName === name);
                    if (fleetItem && fleetItem.cliFamily === 'devin') cliName = 'Devin';
                    else if (fleetItem && fleetItem.cliFamily === 'claude') cliName = 'Claude';
                    else if (fleetItem && fleetItem.cliFamily === 'antigravity') cliName = 'Antigravity';
                }
                // Boot phase: a cold-booting CLI is starting up, not resetting
                // context. The first-readiness gate is waiting for the CLI to
                // produce output before the prompt is delivered.
                if (latestOp.phase === 'booting') {
                    sublabel.textContent = `${cliName} is starting up.`;
                } else {
                    sublabel.textContent = `${cliName} is resetting context.`;
                }
            }
        }
    }

    function updateCurtainVisuals() {
        if (!paneGridEl) return;
        const ufoUri = getUfoIconUri();
        paneGridEl.querySelectorAll('.dispatch-curtain-icon').forEach(img => {
            img.src = ufoUri;
        });
    }

    /**
     * The toast's Undo button reads the CURRENT undoSnapshot, not the one that was live
     * when the toast was shown. So any mutation that replaces or clears the snapshot
     * without announcing itself must also retract the toast — otherwise the visible
     * message describes one action while its Undo reverts a different one.
     */
    function hidePaneToast() {
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        const toastEl = document.getElementById('pane-toast');
        if (toastEl) { toastEl.classList.remove('visible'); }
    }

    function sanitizePaneAssignments() {
        const liveNames = new Set(fleetList.map(t => t.friendlyName));
        const maxSlots = getMaxSlotCount();

        while (paneAssignments.length < maxSlots) {
            paneAssignments.push(null);
        }
        if (paneAssignments.length > maxSlots) {
            paneAssignments.length = maxSlots;
        }
        while (pinnedPanes.length < maxSlots) { pinnedPanes.push(false); }
        if (pinnedPanes.length > maxSlots) { pinnedPanes.length = maxSlots; }

        // Stale-slot drop: a persisted layout may name terminals that died while the page
        // was closed. Drop those slots individually — never discard the whole layout.
        for (let i = 0; i < paneAssignments.length; i++) {
            if (paneAssignments[i] && !liveNames.has(paneAssignments[i])) {
                if (soloTerminalName && paneAssignments[i] === soloTerminalName) {
                    continue;
                }
                paneAssignments[i] = null;
            }
        }

        // Drop stale dispatch-in-flight entries: a terminal that died mid-dispatch
        // will never send its completion response, so its refcount would strand
        // and the chip would never clear.
        for (const name of Array.from(dispatchInFlight.keys())) {
            if (!liveNames.has(name)) { dispatchInFlight.delete(name); }
        }

        // Pin expiry. Deliberately NOT folded into the drop loop above: closeTerminal()
        // nulls its own slots BEFORE this refresh lands (the same reason the undo
        // invalidation below cannot rely on the drop loop either), so a pin whose terminal
        // was explicitly closed would never be reached by a dead-name check. Keying off the
        // slot being empty instead of the occupant being dead covers every path — close,
        // death-while-closed, hide, and a torn two-key persistence write where
        // terminals.paneAssignments saved and terminals.pinnedPanes did not.
        for (let i = 0; i < pinnedPanes.length; i++) {
            if (pinnedPanes[i] && !paneAssignments[i]) { pinnedPanes[i] = false; }
        }

        // Undo invalidation. The snapshot restores a WHOLE arrangement, so it is only
        // safe while every name it would put back is still live. Checking names against
        // the drop loop above is not enough: closeTerminal() nulls its own slots BEFORE
        // this refresh lands, so the loop never sees the dead name and the snapshot
        // outlived the terminal — Undo then restored a name with no session, and the
        // pane opened a WebSocket to a terminal that no longer exists.
        if (undoSnapshot) {
            const wouldRestore = undoSnapshot.slots.filter(Boolean);
            if (undoSnapshot.name) { wouldRestore.push(undoSnapshot.name); }
            if (wouldRestore.some(n => !liveNames.has(n))) {
                undoSnapshot = null;
                hidePaneToast();
            }
        }

        if (activeTerminalName && !liveNames.has(activeTerminalName)) {
            activeTerminalName = null;
        }
        if (peekTerminalName && !liveNames.has(peekTerminalName)) {
            peekTerminalName = null;
        }

        // Seed pane 0 on FIRST load only. Re-seeding on every list refresh would undo a
        // deliberate pane clear the moment any terminalsChanged broadcast arrived.
        // The gate stays exactly `!initialAssignmentDone && fleetList.length > 0` —
        // solo pre-sets initialAssignmentDone to true and terminal-solo-popout-contract
        // asserts that literal shape. The lock guard nests INSIDE it: a locked group
        // owns the pane assignments, so seeding pane 0 would fight the lock.
        if (!initialAssignmentDone && fleetList.length > 0) {
            initialAssignmentDone = true;
            if (!activeGroupId && !paneAssignments.some(name => name !== null)) {
                paneAssignments[0] = fleetList[0].friendlyName;
                activeTerminalName = fleetList[0].friendlyName;
            }
        }
    }

    // Binary name → icon key. Maps the CLI binary basename to a brand icon.
    // The display label (e.g. 'CLAUDE CLI', 'Antigravity CLI') is matched
    // case-insensitively against these keys.
    const CLI_BRAND_ICON_KEYS = {
        claude: 'claude',
        agy: 'antigravity',
        antigravity: 'antigravity',
        devin: 'devin',
        jules: 'jules',
        gemini: 'gemini',
        codex: 'openai',
        openai: 'openai',
        cursor: 'cursor',
        copilot: 'copilot',
        windsurf: 'windsurf',
        qwen: 'qwen',
        amp: 'amp',
        cline: 'cline',
        kiro: 'kiro',
        kilo: 'kilo',
        trae: 'trae',
        opencode: 'opencode',
        zed: 'zed',
    };

    function brandIconForCliLabel(cliLabel) {
        if (!cliLabel || cliLabel === 'No agent assigned') { return null; }
        // cliLabel is the display name, e.g. 'Antigravity CLI', 'CLAUDE CLI',
        // 'DEVIN CLI', 'JULES CLI', 'GEMINI CLI', etc. Match case-insensitively
        // against the known brand prefixes; fall back to the default icon.
        const key = cliLabel.toLowerCase();
        if (key.startsWith('antigravity')) { return 'antigravity'; }
        if (key.startsWith('claude')) { return 'claude'; }
        if (key.startsWith('devin')) { return 'devin'; }
        if (key.startsWith('jules')) { return 'jules'; }
        if (key.startsWith('gemini')) { return 'gemini'; }
        if (key.startsWith('codex')) { return 'openai'; }
        if (key.startsWith('openai')) { return 'openai'; }
        if (key.startsWith('cursor')) { return 'cursor'; }
        if (key.startsWith('copilot')) { return 'copilot'; }
        if (key.startsWith('windsurf')) { return 'windsurf'; }
        if (key.startsWith('qwen')) { return 'qwen'; }
        if (key.startsWith('amp')) { return 'amp'; }
        if (key.startsWith('cline')) { return 'cline'; }
        if (key.startsWith('kiro')) { return 'kiro'; }
        if (key.startsWith('kilo')) { return 'kilo'; }
        if (key.startsWith('trae')) { return 'trae'; }
        if (key.startsWith('opencode')) { return 'opencode'; }
        if (key.startsWith('zed')) { return 'zed'; }
        return 'default';
    }

    function brandIconUri(key) {
        const ds = document.body.dataset || {};
        const map = {
            claude: ds.brandIconClaude,
            antigravity: ds.brandIconAntigravity,
            devin: ds.brandIconDevin,
            jules: ds.brandIconJules,
            gemini: ds.brandIconGemini,
            openai: ds.brandIconOpenai,
            cursor: ds.brandIconCursor,
            copilot: ds.brandIconCopilot,
            windsurf: ds.brandIconWindsurf,
            qwen: ds.brandIconQwen,
            amp: ds.brandIconAmp,
            cline: ds.brandIconCline,
            kiro: ds.brandIconKiro,
            kilo: ds.brandIconKilo,
            trae: ds.brandIconTrae,
            opencode: ds.brandIconOpencode,
            zed: ds.brandIconZed,
            default: ds.brandIconDefault,
        };
        return map[key] || '';
    }

    /** Codicon-shaped pencil, built as inline SVG DOM so it inherits currentColor
     *  and follows the theme. No asset fetch, so no img-src dependency (the panel
     *  CSP is `img-src 'self' data:`, terminals.html:5). */
    function buildEditGlyph() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '11');
        svg.setAttribute('height', '11');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('d', 'M13.23 1a1.2 1.2 0 0 1 .85.35l.57.57a1.2 1.2 0 0 1 0 1.7l-8.4 8.4-3.4 1.13a.4.4 0 0 1-.5-.5l1.13-3.4 8.4-8.4A1.2 1.2 0 0 1 13.23 1Zm0 1.2-.7.7 1.07 1.07.7-.7-1.07-1.07ZM4.3 11.02l.68.68-1.2.4.52-1.08Zm.44-.86 6.9-6.9 1.07 1.07-6.9 6.9-1.07-1.07Z');
        svg.appendChild(path);
        return svg;
    }

    function renderTerminalRow(item, opts) {
        const itemDiv = document.createElement('div');
        const paneIndex = paneAssignments.indexOf(item.friendlyName);
        const isFocused = activeTerminalName === item.friendlyName;
        const isPeeked = peekTerminalName === item.friendlyName;
        const isSelected = selectedTerminalNames.has(item.friendlyName);
        itemDiv.className = 'terminal-item'
            + (isFocused ? ' active' : '')
            + (paneIndex !== -1 ? ' assigned' : '')
            + (item.status === 'exited' ? ' is-exited' : '')
            + (isPeeked ? ' is-peeked' : '')
            + (isSelected ? ' is-selected' : '');

        const info = document.createElement('div');
        info.className = 'item-info';

        const agentLabel = agentLabelForRole(item.role);

        // "(exited)" qualifies the HANDLE, matching the pane header
        // (terminals.js:2755-2759). WHERE the handle renders depends on the row:
        // with an agent label the name line shows the CLI label and the handle
        // moves to the subline; without one the name line IS the handle. The
        // suffix follows the handle rather than living in a fixed slot.
        const exitedSuffix = item.status === 'exited' ? ' (exited)' : '';

        const termNameEl = document.createElement('div');
        termNameEl.className = 'item-name';
        // Lead with the agent CLI name. friendlyName is a uniquifier minted by
        // ptyFleetService (`${role}-${n}`), not a name anyone chose, so it belongs on the
        // subline. It stays VISIBLE because it is the only thing separating two terminals
        // running the same agent — and it stays available to the rename path via the
        // dataset stamp below, which the dblclick handler now reads instead of textContent.
        termNameEl.textContent = agentLabel || `${item.friendlyName}${exitedSuffix}`;
        termNameEl.dataset.friendlyName = item.friendlyName;
        // Suffix on the hover title too: the pane header's title carries it
        // (updatePaneElement, terminals.js:2775), and a tooltip that says the row
        // is fine while the row itself says "(exited)" is the two-sources-of-truth
        // split this suffix exists to close.
        termNameEl.title = `${agentLabel ? agentLabel + ' — ' : ''}${item.friendlyName}${exitedSuffix} (${item.role})`;

        const roleRow = document.createElement('div');
        roleRow.className = 'item-role-row';

        const iconKey = brandIconForCliLabel(agentLabel);
        if (iconKey) {
            const uri = brandIconUri(iconKey);
            if (uri) {
                // <img> renders the SVG with its embedded brand colours.
                const icon = document.createElement('img');
                icon.className = 'item-role-icon';
                icon.src = uri;
                icon.alt = '';
                icon.dataset.brand = iconKey;
                // The handle dismissStartupCurtain strips .is-starting by. Without it, teardown
                // would have to re-render the whole sidebar to clear one class.
                icon.dataset.terminal = item.friendlyName;
                if (startupCurtains.has(item.friendlyName)) { icon.classList.add('is-starting'); }
                roleRow.appendChild(icon);
            }
        }

        if (isTeamHead(item.friendlyName)) {
            const crown = document.createElement('span');
            crown.className = 'item-crown-icon';
            crown.setAttribute('aria-hidden', 'true');
            crown.title = 'Team lead';
            crown.innerHTML = CROWN_SVG;
            if (item.status === 'exited') {
                crown.classList.add('is-exited');
            }
            roleRow.appendChild(crown);
        }

        const roleEl = document.createElement('div');
        roleEl.className = 'item-role';
        // Handle first on the subline: it is what the user needs to tell siblings apart.
        roleEl.textContent = agentLabel
            ? `${item.friendlyName}${exitedSuffix} · ${item.role}`
            : item.role;
        roleRow.appendChild(roleEl);

        // Group membership chip — for a seat NOT rendered under a team subheader.
        // Under a tier the chip is the tier's own name repeated on every row, so it is
        // suppressed there. A seat claimed only by a derived role/worktree group has no
        // tier, and the chip is still the only thing that names its claimant.
        const claimingGroup = opts?.inTeamTier ? null : findGroupForTerminalName(item.friendlyName);
        if (claimingGroup) {
            const groupChip = document.createElement('span');
            groupChip.className = 'item-group-chip';
            // .item-group-chip is max-width:80px / ellipsis at 9px (terminals.html).
            // A location-scoped role group's full name ("Planners · switchboard")
            // truncates to "Planners · s…", so two DIFFERENT groups render identical
            // chips — the operator reads that as the bug still being present. The chip
            // names the group; the title names the location.
            groupChip.textContent = claimingGroup.shortName || claimingGroup.name;
            groupChip.title = `Member of ${claimingGroup.name}`;
            roleRow.appendChild(groupChip);
        }

        // Rename now lives NEXT TO the thing it renames. It was a `rename` word in a
        // strip of lookalike 10px links below the row, displaced from its object; the
        // only other entry point was a double-click gesture with no affordance. Both
        // still work — the delegated dblclick on .item-name (terminals.js:540) is
        // untouched.
        const nameRow = document.createElement('div');
        nameRow.className = 'item-name-row';
        nameRow.appendChild(termNameEl);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'item-edit-btn';
        editBtn.title = 'Rename terminal';
        editBtn.setAttribute('aria-label', `Rename ${item.friendlyName}`);
        editBtn.appendChild(buildEditGlyph());
        editBtn.addEventListener('click', (e) => {
            // The row seats the terminal on click (itemDiv handler below).
            e.stopPropagation();
            // Re-read the LIVE node: beginInlineRename swaps .item-name out for an
            // input and back, and that input commits on blur — which fires on this
            // button's mousedown, before this click. Closing over the render-time
            // node would act on one that has just been detached.
            const liveNameEl = nameRow.querySelector('.item-name');
            if (!liveNameEl) { return; }
            beginInlineRename(liveNameEl, liveNameEl.dataset.friendlyName || item.friendlyName);
        });
        nameRow.appendChild(editBtn);

        info.appendChild(nameRow);
        info.appendChild(roleRow);

        if (paneIndex !== -1) {
            const isPinned = Boolean(pinnedPanes[paneIndex]);
            const paneChip = document.createElement('span');
            paneChip.className = 'pane-index-chip' + (isPinned ? ' is-pinned' : '');
            paneChip.textContent = isPinned ? `📌P${paneIndex + 1}` : `P${paneIndex + 1}`;
            paneChip.title = isPinned
                ? `Pinned to pane ${paneIndex + 1}`
                : `Showing in pane ${paneIndex + 1}`;
            info.appendChild(paneChip);
        }

        if (terminalBadges.has(item.friendlyName)) {
            const badge = document.createElement('span');
            badge.className = 'pane-badge';
            badge.textContent = terminalBadges.get(item.friendlyName).label;
            info.appendChild(badge);
        }
        if (terminalReplayGaps.has(item.friendlyName)) {
            const gapBadge = document.createElement('span');
            gapBadge.className = 'pane-badge is-gap';
            gapBadge.textContent = 'GAP';
            gapBadge.title = 'Output was evicted while this pane was disconnected — the screen was reset rather than spliced';
            info.appendChild(gapBadge);
        }

        // Was a .status-dot: a non-interactive 7px pip in the row's most reachable
        // slot, encoding a bit that is "active" on virtually every row. The exited
        // state it carried now lives in the subline/name text and the row's
        // is-exited class (§1-2), which is strictly more legible than a red circle.
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'item-close-btn';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close terminal (ends the process)';
        closeBtn.setAttribute('aria-label', `Close ${item.friendlyName}`);
        closeBtn.addEventListener('click', (e) => {
            // The whole row seats the terminal on click (listener below). Without
            // this, closing also seats it a frame before it dies.
            e.stopPropagation();
            closeTerminal(item.friendlyName);
        });

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        // No "locate" button: clicking the row already seats the terminal in the
        // focused pane and hands it the caret (itemDiv click handler below). The
        // locate button duplicated that exactly, which is why it read as pointless.
        // `close` moved OUT of this strip to the × at the row's right edge and
        // `rename` moved to the pencil beside the name, leaving `clear` — which is
        // the strip's highest-frequency action and now wears a weight to match.

        const peekBtn = document.createElement('button');
        peekBtn.type = 'button';
        peekBtn.className = 'item-peek-btn';
        peekBtn.textContent = isPeeked ? 'restore' : 'peek';
        peekBtn.title = isPeeked ? 'Restore the grid' : 'Full-pane view this terminal';
        peekBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (peekTerminalName === item.friendlyName) {
                dismissPeek();
            } else {
                peekTerminal(item.friendlyName);
            }
        });
        actions.appendChild(peekBtn);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        // NOT .locate-btn: that style is borderless, 10px, opacity 0.7 — near
        // invisible on this panel. `clear` is the highest-frequency per-terminal
        // action in a session and now wears the panel's existing
        // small-visible-button treatment (same language as .btn-unassign-pane).
        clearBtn.className = 'item-clear-btn';
        clearBtn.textContent = 'clear';
        clearBtn.title = 'Send /clear to this terminal (resets its context)';
        clearBtn.disabled = item.status === 'exited';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Third arg is the label to restore after the transient 'clearing'
            // feedback — it must stay byte-identical to the textContent set above
            // (withClearingFeedback, terminals.js:4468).
            withClearingFeedback(clearBtn, () => clearTerminal(item.friendlyName), 'clear');
        });
        actions.appendChild(clearBtn);

        const topRow = document.createElement('div');
        topRow.className = 'terminal-item-top';
        topRow.appendChild(info);
        topRow.appendChild(closeBtn);

        itemDiv.appendChild(topRow);
        itemDiv.appendChild(actions);

        itemDiv.addEventListener('click', (e) => {
            const name = item.friendlyName;
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
                e.stopPropagation();
                toggleTerminalSelection(name);
                return;
            }
            if (selectedTerminalNames.size > 0) {
                selectedTerminalNames.clear();
                renderSidebarList();
            }
            if (activeGroupId) {
                handleLockedTerminalClick(name);
            } else {
                locateTerminal(name);
            }
        });

        // Drag-to-reorder in team-scoped mode. Every row in a team-scoped
        // sidebar is a team member (scopedFleet filters to members only),
        // so the guard is simply `teamScopeId`. On drop, compute the new
        // order by permuting the existing array — never rebuild from the
        // DOM, so a stale row cannot inject a dead name.
        if (teamScopeId) {
            itemDiv.classList.add('is-draggable');
            itemDiv.draggable = true;
            itemDiv.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.friendlyName);
                itemDiv.classList.add('is-dragging');
            });
            itemDiv.addEventListener('dragend', () => {
                itemDiv.classList.remove('is-dragging');
                document.querySelectorAll('.terminal-item.is-drag-over').forEach(el => {
                    el.classList.remove('is-drag-over');
                });
            });
            itemDiv.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                itemDiv.classList.add('is-drag-over');
            });
            itemDiv.addEventListener('dragleave', () => {
                itemDiv.classList.remove('is-drag-over');
            });
            itemDiv.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                itemDiv.classList.remove('is-drag-over');
                const draggedName = e.dataTransfer.getData('text/plain');
                const targetName = item.friendlyName;
                if (draggedName === targetName) { return; }
                const group = getScopedTeamGroup();
                if (!group || !Array.isArray(group.order)) { return; }
                const order = group.order;
                const fromIdx = order.indexOf(draggedName);
                const toIdx = order.indexOf(targetName);
                if (fromIdx === -1 || toIdx === -1) { return; }
                // Permute: move the dragged name to the target's position.
                const newOrder = [...order];
                newOrder.splice(fromIdx, 1);
                newOrder.splice(toIdx, 0, draggedName);
                reorderTeamRoster(newOrder);
            });
        }

        return itemDiv;
    }

    function saveCurrentAsGroup(name) {
        const id = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const visible = paneAssignments.slice(0, getSlotCount(effectiveLayout)).filter(Boolean);
        const group = {
            id,
            name: (name || '').trim() || `Group ${terminalGroups.length + 1}`,
            source: 'manual',
            layout: currentLayout,
            members: visible,
            order: visible
        };
        terminalGroups.push(group);
        saveLayoutSettings();
        switchToGroup(id);
    }

    /**
     * Delete a group, whatever its source. One verb, one meaning from the
     * operator's perspective; what it stores differs by source:
     *
     *   manual    → remove from terminalGroups; prune groupPrefs.orders[id]
     *               and groupPrefs.pinned (the record is gone, so its ordering
     *               and pin are dead state).
     *   derived   → suppress via groupPrefs.hidden (the shipped key — no new
     *               groupPrefs field). Orders/pinned are left intact so a
     *               restore returns the operator's member ordering.
     *
     * If the deleted group is the locked one, route through clearGroupLock()
     * so the grid re-seats from the live fleet rather than stranding the
     * departed group's terminals in their panes. clearGroupLock() drops the
     * lock, re-seats, and re-renders — so no separate renderSidebarList() is
     * needed on that path.
     */
    function deleteGroup(id) {
        const group = getAllGroups().find(g => g.id === id);
        const wasLocked = activeGroupId === id;

        if (group && group.source === 'manual') {
            terminalGroups = terminalGroups.filter(g => g.id !== id);
            // Prune dead state for a manual group: its ordering and pin are
            // meaningless once the record is gone.
            if (groupPrefs.orders && groupPrefs.orders[id]) {
                delete groupPrefs.orders[id];
            }
            if (Array.isArray(groupPrefs.pinned)) {
                groupPrefs.pinned = groupPrefs.pinned.filter(pid => pid !== id);
            }
            // Clean up namespaced layout keys (terminals.team.<id>.*) so they
            // do not accumulate as storage orphans when a team group is deleted.
            deleteNamespacedTeamKeys(id);
        } else if (group) {
            // Derived group (role/worktree): suppress, don't destroy.
            // groupPrefs.hidden is the shipped key — no new groupPrefs field.
            if (!groupPrefs.hidden.includes(id)) {
                groupPrefs.hidden.push(id);
            }
        } else {
            return;
        }

        if (wasLocked) {
            // clearGroupLock drops the lock, re-seats from the unassigned live fleet
            // honouring pins, and re-renders. It also calls saveLayoutSettings.
            clearGroupLock();
        } else {
            saveLayoutSettings();
            renderSidebarList();
        }
    }

    /**
     * Drop the group lock and re-seat the grid from the unassigned live fleet.
     *
     * Formerly this only dropped the lock and repainted the sidebar, leaving
     * paneAssignments exactly as the departed group left them — the "All
     * terminals" affordance read as dead because, on screen, it was. Now it
     * performs a real seating pass from the unassigned subset (terminals not
     * claimed by any manual or derived group): pinned slots keep their occupant
     * if it is still unassigned, remaining slots fill in compareTerminals order,
     * and the layout resolves via smallestLayoutFitting (non-monotonic, so it
     * can shrink).
     *
     * The early return on `!activeGroupId` is removed: clicking "Unassigned"
     * from an already-unlocked state is a legitimate "reset my composition"
     * gesture and must do the seating pass.
     */
    function clearGroupLock() {
        // Guard: in team-scoped mode, clearing the lock would unscope the
        // window and its namespaced writes would land under the wrong prefix.
        // The group strip is hidden so this should not be reached from UI, but
        // guard against programmatic calls.
        if (teamScopeId) { return; }
        activeGroupId = null;
        activeGroupPage = 0;

        // Re-seat from the unassigned live fleet (no delegate children, no group
        // members), honouring pins that are still unassigned.
        const unassignedNames = getUnassignedTerminalNames();
        const maxSlots = getMaxSlotCount();
        const assignments = new Array(maxSlots).fill(null);

        for (let i = 0; i < pinnedPanes.length && i < maxSlots; i++) {
            if (pinnedPanes[i]) {
                const occupant = paneAssignments[i];
                if (occupant && unassignedNames.includes(occupant)) {
                    assignments[i] = occupant;
                } else {
                    pinnedPanes[i] = false;
                }
            }
        }

        const seated = new Set(assignments.filter(Boolean));
        let fillIdx = 0;
        for (const name of unassignedNames) {
            if (seated.has(name)) { continue; }
            while (fillIdx < maxSlots && assignments[fillIdx] !== null) { fillIdx++; }
            if (fillIdx >= maxSlots) { break; }
            assignments[fillIdx] = name;
            fillIdx++;
        }

        paneAssignments = assignments;

        const targetLayout = smallestLayoutFitting(unassignedNames.length);
        currentLayout = targetLayout;
        effectiveLayout = targetLayout;

        syncLayoutPickerUI();
        sanitizePaneAssignments();
        renderPaneGrid();
        applyLayoutFloor();

        saveLayoutSettings();
        renderSidebarList();
    }

    function saveSelectionAsGroup(name) {
        const id = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const members = Array.from(selectedTerminalNames);
        const group = {
            id,
            name: (name || '').trim() || `Group ${terminalGroups.length + 1}`,
            source: 'manual',
            layout: layoutForFleetCount(members.length),
            members,
            order: members
        };
        terminalGroups.push(group);
        selectedTerminalNames.clear();
        saveLayoutSettings();
        renderSidebarList();
    }

    function toggleTerminalSelection(name) {
        if (selectedTerminalNames.has(name)) {
            selectedTerminalNames.delete(name);
        } else {
            selectedTerminalNames.add(name);
        }
        renderSidebarList();
    }

    function switchToGroup(id, opts = {}) {
        // Rule 1: switching groups is a deliberate selection — the most
        // reachable peek-trap route (the UAT report's exact case). The peeked
        // terminal is almost certainly not a member of the new group, so
        // seatActiveGroupPage would rebuild paneAssignments without it and the
        // grid would go fully blank. Cancelling here ends the peek and lets the
        // switch's own render show the new group. dismissPeek early-returns when
        // no peek is active.
        dismissPeek();
        // Guard: a team-scoped window must never silently become unscoped. Its
        // namespaced layout keys would then write under the wrong prefix. The
        // group strip is hidden in team mode so this path should not be reached,
        // but guard anyway — a programmatic call (e.g. switchToTeamGroup) is
        // allowed to switch to the scoped team itself, but not away from it.
        if (teamScopeId && id !== teamScopeId) { return; }
        if (soloTerminalName) {
            document.body.classList.remove('is-solo');
            soloTerminalName = null;
            const soloStatusEl = document.getElementById('solo-status');
            if (soloStatusEl) { soloStatusEl.style.display = 'none'; }
        }
        const group = getAllGroups().find(g => g.id === id);
        if (!group) { return; }
        const sameGroup = activeGroupId === id;
        activeGroupId = id;
        // The page index is a scroll position, not a preference: it resets whenever
        // the lock moves to a different group. seatActiveGroupPage() re-clamps it
        // against the floored slot count, which covers a resize mid-lock.
        if (!sameGroup || !opts.keepPage) { activeGroupPage = 0; }
        // Route the layout through setLayoutMode so applyLayoutFloor still wins over
        // the group's desire; only then is the rendered slot count known. Uses
        // layoutForGroupSwitch (non-monotonic) so a 2-member group restores to 2h
        // even if the previous group was 2x2 — the grow-only layoutForFleetCount
        // would inherit the prior group's grid.
        setLayoutMode(layoutForGroupSwitch(group), { keepLock: true });
        seatActiveGroupPage();
        if (!opts.noSave) {
            saveLayoutSettings();
        }
        renderSidebarList();
    }

    /**
     * Seat the current page of the locked group into the rendered slots. Split out
     * of switchToGroup because the floor can change the rendered slot count after
     * the lock is taken (window resize), and the seating has to be recomputed
     * against the NEW count rather than the group's desired one.
     */
    function seatActiveGroupPage() {
        const group = activeGroupId ? getAllGroups().find(g => g.id === activeGroupId) : null;
        if (!group) { return; }
        const members = getGroupMembers(group);
        const rendered = Math.max(1, getSlotCount(effectiveLayout));
        const pageCount = Math.max(1, Math.ceil(members.length / rendered));
        if (activeGroupPage >= pageCount) { activeGroupPage = pageCount - 1; }
        if (activeGroupPage < 0) { activeGroupPage = 0; }
        const start = activeGroupPage * rendered;
        const assignments = members.slice(start, start + rendered);
        while (assignments.length < getMaxSlotCount()) {
            assignments.push(null);
        }
        paneAssignments = assignments;
        // A lock reseats slots but must not break `pinnedPanes[i] → paneAssignments[i]`.
        // Pins on slots the group left empty are cleared here rather than waiting for
        // the next sanitizePaneAssignments poll, which is what enforces it elsewhere.
        for (let i = 0; i < pinnedPanes.length; i++) {
            if (pinnedPanes[i] && !paneAssignments[i]) { pinnedPanes[i] = false; }
        }
        renderPaneGrid();
    }

    function safeGroupIdForValue(source, value) {
        const encoded = encodeURIComponent(String(value || '')).replace(/[^a-zA-Z0-9_]/g, '_');
        return 'dg_' + source + '_' + encoded;
    }

    /**
     * Separator for the composite (role, location) key. A filesystem path can
     * contain '@', a space, a dash, a colon and a pipe; it cannot contain NUL.
     * Using NUL guarantees two distinct (role, location) pairs can never collide
     * into one map key.
     */
    const LOC_SEP = '\u0000';

    /** Normalise a path for keying: `\` → `/`, trailing slashes stripped. Case is
     *  deliberately preserved — renderSidebarList compares parentRoot exactly, and
     *  a case-folding key here would bucket a terminal differently from the tree. */
    function normalizeLocationPath(p) {
        return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    }

    /**
     * A terminal's physical location: its worktree if it has one, else the parent
     * workspace it was spawned under. Both fields are stamped by both hosts
     * (TaskViewerProvider.ts, bootstrap.ts) and are the same two fields
     * renderSidebarList buckets the tree by.
     *
     * The worktree is only treated as a distinct location when the sidebar treats
     * it as one: renderSidebarList files a terminal as `direct` under its
     * parent when worktreePath IS the parent root or is itself a registered parent
     * folder. Mirroring that rule is what stops the group strip and the sidebar
     * tree from telling two different stories about the same terminal.
     */
    function locationKeyForTerminal(t) {
        const parentRoot = normalizeLocationPath(t && t.parentRoot);
        const wt = normalizeLocationPath(t && t.worktreePath);
        if (!wt || wt === parentRoot) { return parentRoot; }
        const registeredParents = new Set(
            (Array.isArray(parentsList) ? parentsList : [])
                .map(p => normalizeLocationPath(p && p.parentFolder))
                .filter(Boolean)
        );
        return registeredParents.has(wt) ? parentRoot : wt;
    }

    /** Basename of a location key, for the group label. Matches renderSidebarList. */
    function locationLabelForKey(key) {
        if (!key) { return 'unmapped'; }
        const parts = String(key).split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : key;
    }

    function getDerivedGroups() {
        const threshold = groupPrefs.threshold;
        const hidden = new Set(groupPrefs.hidden);
        const live = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId);
        const roleMap = new Map();
        const worktreeMap = new Map();
        for (const t of live) {
            // Role is a job title, not a team and not a place. Two planners in two
            // different checkouts are two agents doing two jobs — keying on role
            // alone seated them into one grid and named the result "Planners".
            if (t.role) {
                const loc = locationKeyForTerminal(t);
                const key = t.role + LOC_SEP + loc;
                const entry = roleMap.get(key) || { role: t.role, loc, count: 0 };
                entry.count++;
                roleMap.set(key, entry);
            }
            if (t.worktreePath) { worktreeMap.set(t.worktreePath, (worktreeMap.get(t.worktreePath) || 0) + 1); }
        }
        const derived = [];
        // Opt-in. Worktree groups below stay automatic: they are location-keyed by
        // construction and describe a place the operator chose to create.
        if (groupPrefs.autoRoleGroups) {
            for (const { role, loc, count } of roleMap.values()) {
                if (count >= threshold) {
                    const label = (role.charAt(0).toUpperCase() + role.slice(1)) + 's';
                    // Always suffixed, never conditionally: a name that flips when a
                    // planner appears in another workspace is a name the operator
                    // cannot learn.
                    derived.push({
                        id: safeGroupIdForValue('role', role + LOC_SEP + loc),
                        name: label + ' · ' + locationLabelForKey(loc),
                        shortName: label,
                        source: 'role',
                        value: role,
                        role,
                        location: loc
                    });
                }
            }
        }
        for (const [wt, count] of worktreeMap) {
            if (count >= threshold) {
                const parts = String(wt).replace(/\\/g, '/').split('/').filter(Boolean);
                const basename = parts.length > 0 ? parts[parts.length - 1] : wt;
                derived.push({
                    id: safeGroupIdForValue('worktree', wt),
                    name: basename,
                    source: 'worktree',
                    value: wt
                });
            }
        }
        return derived.filter(g => !hidden.has(g.id));
    }

    function getAllGroups() {
        // The Unassigned pseudo-group is retired — it was a computed remainder
        // with no identity to delete, and leaving it in getAllGroups while
        // removing it from findGroupForTerminalName produced a dead click for
        // every ungrouped terminal under a lock. Ungrouped terminals now render
        // as ordinary rows under their workspace, not gathered into a bucket.
        return sortGroups([...terminalGroups, ...getDerivedGroups()]);
    }

    /** Whether the given group id names a spawned team. Routes through
     *  isSpawnedTeamGroup, NOT a bare `g.teamGroup` test: a row written with
     *  `teamKind: 'spawned'` but no legacy flag is a team, and testing the flag
     *  alone would let the sidebar guards below wave it through. */
    function isTeamGroup(groupId) {
        return isSpawnedTeamGroup(getAllGroups().find(g => g.id === groupId));
    }

    function sortGroups(groups) {
        const pinned = new Set(groupPrefs.pinned);
        return groups.slice().sort((a, b) => {
            const ap = pinned.has(a.id) ? 0 : 1;
            const bp = pinned.has(b.id) ? 0 : 1;
            if (ap !== bp) { return ap - bp; }
            if (a.source !== 'manual' && b.source === 'manual') { return 1; }
            if (a.source === 'manual' && b.source !== 'manual') { return -1; }
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
    }

    function getGroupMembers(group) {
        if (!group) { return []; }
        // Liveness only. The parentage clause that used to live here answered a
        // DIFFERENT question — "should this terminal be gathered automatically?" —
        // and applying it to `manual` made a group discard the very names it was
        // registered with. A team registers head + children explicitly
        // (teamWiring.ts); members are parented by construction
        // (ptyFleetService.ts:358), so the old set resolved every team to its head
        // alone, with no error anywhere. The role/worktree branches below still
        // exclude children — they are queries, and this is a membership list.
        const live = new Set(fleetList.filter(t => t.status !== 'exited').map(t => t.friendlyName));
        let names = [];
        if (group.source === 'manual') {
            const order = Array.isArray(group.order) ? group.order : (Array.isArray(group.members) ? group.members : []);
            names = order.filter(n => live.has(n));
            for (const n of (group.members || [])) {
                if (live.has(n) && !names.includes(n)) { names.push(n); }
            }
        } else if (group.source === 'role') {
            // Same predicate as getDerivedGroups: role AND location. Filtering on role
            // alone is what unioned every workspace's planners into one group.
            names = fleetList
                .filter(t => t.status !== 'exited'
                    && !t.parentInstanceId
                    && t.role === group.value
                    && locationKeyForTerminal(t) === group.location)
                .map(t => t.friendlyName);
        } else if (group.source === 'worktree') {
            names = fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId && t.worktreePath === group.value).map(t => t.friendlyName);
        }
        // Extras overlay: terminals added to a derived group via the
        // locked-group empty-pane fill. Manual groups append to their own
        // members array, so no overlay is needed for them. The extras union
        // is intersected with the live set explicitly — the role and worktree
        // branches inline the child-excluding predicate rather than reading
        // the live Set, so filtering is not automatic here. A dead name in
        // extras would otherwise be seated into a pane.
        if (group.source !== 'manual' && groupPrefs.extras) {
            const extra = groupPrefs.extras[group.id];
            if (Array.isArray(extra)) {
                for (const n of extra) {
                    if (live.has(n) && !names.includes(n)) { names.push(n); }
                }
            }
        }
        // The 'unassigned' source branch is gone — nothing constructs that
        // group any more, and the branch recursed over every group to compute
        // a complement on every call from the render loop.
        return orderGroupMembers(group, names);
    }

    function orderGroupMembers(group, liveNames) {
        const saved = (groupPrefs.orders && groupPrefs.orders[group.id]) || [];
        const ordered = [];
        const remaining = [...liveNames];
        for (const n of saved) {
            if (remaining.includes(n)) {
                ordered.push(n);
                remaining.splice(remaining.indexOf(n), 1);
            }
        }
        const byName = new Map(fleetList.map(t => [t.friendlyName, t]));
        remaining.sort((a, b) => compareTerminals(byName.get(a), byName.get(b)));
        return ordered.concat(remaining);
    }

    function setGroupOrder(group, order) {
        if (!groupPrefs.orders) { groupPrefs.orders = {}; }
        groupPrefs.orders[group.id] = order;
        saveLayoutSettings();
    }

    /**
     * Read a group's stored layout. Manual groups carry it on the group object
     * (group.layout); derived groups carry it in groupPrefs.layouts[id]. Returns
     * null when no layout has been stored for the group.
     */
    function getStoredGroupLayout(group) {
        if (group.source === 'manual' && group.layout && LAYOUT_MODES.includes(group.layout)) {
            return group.layout;
        }
        const stored = groupPrefs.layouts && groupPrefs.layouts[group.id];
        if (typeof stored === 'string' && LAYOUT_MODES.includes(stored)) {
            return stored;
        }
        return null;
    }

    /**
     * Layout resolver for group switching — free to move in BOTH directions,
     * unlike layoutForFleetCount which is grow-only. A group switch is a
     * restore, and a restore must be able to go down.
     *
     * Read order: stored layout (manual .layout, else groupPrefs.layouts[id])
     * → fall back to smallestLayoutFitting (non-monotonic). Only switchToGroup
     * calls this; the grow-only layoutForFleetCount is untouched so nothing
     * else inherits the non-monotonic behaviour.
     */
    function layoutForGroupSwitch(group) {
        const stored = getStoredGroupLayout(group);
        if (stored && LAYOUT_MODES.includes(stored)) { return stored; }
        return smallestLayoutFitting(getGroupMembers(group).length);
    }

    function findGroupForTerminalName(name) {
        for (const g of terminalGroups) {
            if (getGroupMembers(g).includes(name)) { return g; }
        }
        for (const g of getDerivedGroups()) {
            if (getGroupMembers(g).includes(name)) { return g; }
        }
        // No unassigned fallback — the pseudo-group is retired. Returns null
        // for ungrouped terminals, which makes handleLockedTerminalClick's
        // !group branch live (drop the lock and seat the terminal).
        return null;
    }

    function getUnassignedTerminalNames() {
        const live = fleetList
            .filter(t => t.status !== 'exited' && !t.parentInstanceId)
            .sort(compareTerminals);
        return live
            .filter(t => !findGroupForTerminalName(t.friendlyName))
            .map(t => t.friendlyName);
    }

    /**
     * Add a terminal to the active group's membership. For manual groups,
     * appends to the group's own members array. For derived groups, appends
     * to groupPrefs.extras[id] — the overlay that unions with the computed
     * membership in getGroupMembers. Must be called BEFORE seating so the
     * next seatActiveGroupPage reconcile (triggered by a window resize or
     * group switch) does not evict the addition.
     */
    function addTerminalToActiveGroup(name) {
        const group = getAllGroups().find(g => g.id === activeGroupId);
        if (!group) { return; }
        // Team groups are managed exclusively by the team system (start/stop in
        // the Teams tab). The sidebar must not inject terminals into a team —
        // doing so causes the terminal to receive the team's standing orders on
        // every prompt, making it believe it is a team member.
        if (isSpawnedTeamGroup(group)) { return; }
        if (group.source === 'manual') {
            if (!group.members) { group.members = []; }
            if (!group.members.includes(name)) { group.members.push(name); }
            if (Array.isArray(group.order) && !group.order.includes(name)) { group.order.push(name); }
        } else {
            if (!groupPrefs.extras) { groupPrefs.extras = {}; }
            if (!Array.isArray(groupPrefs.extras[activeGroupId])) { groupPrefs.extras[activeGroupId] = []; }
            if (!groupPrefs.extras[activeGroupId].includes(name)) { groupPrefs.extras[activeGroupId].push(name); }
        }
        saveLayoutSettings();
    }

    function handleLockedTerminalClick(name) {
        // Rule 1: a locked sidebar row click is a deliberate selection. The
        // focus-in-place branch below (same group, already seated) returns
        // without reaching assignToFocusedPane or switchToGroup, so without
        // this cancel the peek survives and the newly-focused terminal stays
        // display:none — the exact UAT repro (peek planner-1, click planner-2
        // in the same locked group). The other two branches cancel downstream
        // (locateTerminal → assignToFocusedPane, switchToGroup) and dismissPeek
        // early-returns on the second call, so this costs nothing extra there.
        // The peekTerminal caller is safe: peekTerminalName still holds the
        // PREVIOUS peek at this point, so this clears the old one, not the new.
        dismissPeek();
        const group = findGroupForTerminalName(name);
        const rendered = Math.max(1, getSlotCount(effectiveLayout));

        // Free-slot fill: if there is a genuinely empty rendered pane, a click
        // on a non-member (whether claimed by another group or by no group at
        // all) means "seat it HERE and make it a member" — not "switch to its
        // group". This is the fix for the reported defect: empty panes under a
        // lock were unfillable because every click was intercepted as a mode
        // change. The terminal is added to the active group's membership BEFORE
        // seating, so the next seatActiveGroupPage reconcile does not evict it.
        // The caller guarantees a free slot exists before passing keepLock,
        // because assignToFocusedPane's displacement fallbacks would otherwise
        // evict a group member to seat a non-member.
        // Mirrors assignToFocusedPane's `isOpen(i) && isFree(i)` exactly, pins
        // included: that function refuses to seat into a pinned slot when
        // rendered > 1, so a precondition that counted one as free would send
        // it down the displacement fallbacks and evict a group member under the
        // lock — the one outcome the keepLock contract forbids.
        const pinsActive = rendered > 1;
        const isFreeSlot = (i) => !paneAssignments[i] && paneModes[i] !== 'kanban' && (!pinsActive || !pinnedPanes[i]);
        let hasFreeSlot = false;
        for (let i = 0; i < rendered; i++) {
            if (isFreeSlot(i)) { hasFreeSlot = true; break; }
        }

        if (hasFreeSlot) {
            const isMemberOfActive = group && group.id === activeGroupId;
            if (!isMemberOfActive) {
                // Team groups are managed exclusively by the team system.
                // Do not inject terminals into a team via sidebar clicks —
                // fall through to the lock-drop path below, which drops the
                // lock and seats the terminal normally.
                if (!isTeamGroup(activeGroupId)) {
                    addTerminalToActiveGroup(name);
                    assignToFocusedPane(name, { keepLock: true });
                    return;
                }
            }
        }

        // No free slot, or the terminal is already a member of the active
        // group — fall through to the existing behaviour.
        if (!group) {
            // No group claims it at all, and no free slot to add it — drop the
            // lock and seat it, so the click is never dead. This branch is now
            // live for every ungrouped terminal clicked under a lock (the
            // Unassigned pseudo-group was retired by the deletion plan, so
            // findGroupForTerminalName returns null instead of a fallback).
            // In team-scoped mode, do not drop the lock — just seat the terminal.
            if (teamScopeId) {
                locateTerminal(name);
                return;
            }
            activeGroupId = null;
            activeGroupPage = 0;
            saveLayoutSettings();
            locateTerminal(name);
            return;
        }
        if (group.id !== activeGroupId) {
            // Belongs to another group, and no free slot in the active group —
            // switch to its group. The tab strip is the deliberate switch
            // affordance; a sidebar click with no free slot falls back to it.
            switchToGroup(group.id);
            return;
        }
        const members = getGroupMembers(group);
        const idxInGroup = members.indexOf(name);
        if (idxInGroup < 0) { return; }
        // Visibility is decided by the pane grid, not by the member index: with paging
        // a member at index 11 can be on screen and a member at index 2 can be off it.
        const paneIndex = paneAssignments.indexOf(name);
        if (paneIndex !== -1 && paneIndex < rendered) {
            activeTerminalName = name;
            focusPaneTerminal(paneIndex);
            renderSidebarList();
            return;
        }
        // Off-screen member: promote it into the LAST rendered slot of the current
        // page, so the pane the user was already reading is the least likely to go.
        promoteGroupMember(group, idxInGroup, activeGroupPage * rendered + rendered - 1);
    }

    function promoteGroupMember(group, fromIndex, toIndex) {
        const members = getGroupMembers(group);
        if (fromIndex < 0 || fromIndex >= members.length) { return; }
        if (toIndex < 0) { toIndex = 0; }
        if (toIndex >= members.length) { toIndex = members.length - 1; }
        const [name] = members.splice(fromIndex, 1);
        members.splice(toIndex, 0, name);
        setGroupOrder(group, members);
        switchToGroup(activeGroupId, { keepPage: true });
    }

    /**
     * Render the team header in the group-tab-strip area (above the pane grid,
     * outside listEl). Shows the team icon, name, member count, and a `+`
     * button that opens the role picker under a `team:<id>` key. Returns true
     * when it mounted the picker, so the GC at the bottom of renderSidebarList
     * does not null a live picker — the same contract renderGroupTabStrip
     * satisfies for `group:*` keys.
     *
     * For a non-team group (derived role/worktree, or a hand-saved selection
     * that is not a spawned team), degrades to a generic "group view" header
     * with no team-specific chrome.
     */
    function renderTeamHeader() {
        if (!teamScopeId || !groupTabStripEl) { return false; }
        // Do NOT clear groupTabStripEl.innerHTML — renderGroupTabStrip has
        // already rendered the tab row (← All + team tabs) into it. The
        // team header appends BELOW the tab row as a context bar.

        const group = getScopedTeamGroup();
        if (!group) { return false; }

        const isTeam = isSpawnedTeamGroup(group);
        const header = document.createElement('div');
        header.className = 'team-header' + (isTeam ? '' : ' is-generic-group');

        // No back button here — the "← All" tab in the tab strip (rendered by
        // renderGroupTabStrip) handles exiting team scope. The team header is
        // now a context bar (icon + name + count), not a navigation bar.

        const iconArea = document.createElement('div');
        iconArea.className = 'team-header-icon';
        if (isTeam) {
            // Crown icon for the team head — mirrors the sidebar crown.
            iconArea.innerHTML = CROWN_SVG;
            iconArea.title = 'Team';
        } else {
            iconArea.textContent = '#';
            iconArea.title = 'Group';
        }
        header.appendChild(iconArea);

        const nameArea = document.createElement('div');
        nameArea.className = 'team-header-name';
        const nameEl = document.createElement('span');
        nameEl.className = 'team-header-title';
        nameEl.textContent = group.shortName || group.name || 'Team';
        nameArea.appendChild(nameEl);

        const members = getGroupMembers(group);
        const active = members.filter(n => {
            const t = fleetList.find(ft => ft.friendlyName === n);
            return t && t.status !== 'exited';
        }).length;
        const exited = members.length - active;
        const countEl = document.createElement('span');
        countEl.className = 'team-header-count';
        countEl.textContent = `${members.length} (${active}a/${exited}x)`;
        nameArea.appendChild(countEl);
        header.appendChild(nameArea);

        groupTabStripEl.appendChild(header);

        // Mount the picker if one is open for this team. Same pattern as
        // renderGroupTabStrip's `group:*` picker — mounted in the strip
        // element (outside listEl) so the innerHTML wipe does not destroy it.
        let pickerRendered = false;
        if (pickerState && pickerState.key === 'team:' + teamScopeId) {
            const picker = mountRolePicker(pickerState.targetSpec);
            groupTabStripEl.appendChild(picker);
            pickerRendered = true;
        }

        return pickerRendered;
    }

    // ──────────────────────────────────────────────────────────────────
    // Team Work Queue
    // ──────────────────────────────────────────────────────────────────

    /** Cached queue items for the scoped team. Refreshed by fetchTeamQueue. */
    let _queueItems = [];
    let _queueMode = 'manual'; // 'manual' | 'auto'
    let _queueFetchInFlight = false;

    /** Queue depth per team groupId, for the rail badge. Refreshed in
     *  buildTeamsForShell so the shell rail can show queue depth without
     *  opening the cockpit. Non-blocking — stale depth beats no depth. */
    const _teamQueueDepths = new Map();
    const _teamInFlight = new Map();
    let _queueDepthFetchInFlight = false;

    /** Fetch the queue for the scoped team from the API. Non-blocking —
     *  the UI renders with whatever the cache holds and updates on the
     *  next poll. Called from renderSidebarList when in team-scoped mode. */
    async function fetchTeamQueue() {
        if (!teamScopeId || _queueFetchInFlight) { return; }
        _queueFetchInFlight = true;
        try {
            const res = await fetch(`/terminals/teams/${encodeURIComponent(teamScopeId)}/queue`, {
                method: 'GET',
                credentials: 'same-origin'
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success && Array.isArray(data.items)) {
                    _queueItems = data.items;
                }
            }
        } catch { /* keep stale cache */ }
        _queueFetchInFlight = false;
    }

    /** Render the queue panel below the team header. Called from
     *  renderSidebarList when in team-scoped mode. Returns the panel
     *  element, or null if not in team mode. */
    function renderTeamQueuePanel() {
        if (!teamScopeId) { return null; }
        const panel = document.createElement('div');
        panel.className = 'team-queue-panel';

        // Header with mode toggle.
        const header = document.createElement('div');
        header.className = 'team-queue-header';
        const title = document.createElement('span');
        title.textContent = `Queue (${_queueItems.length})`;
        header.appendChild(title);

        const modeToggle = document.createElement('div');
        modeToggle.className = 'team-queue-mode-toggle';
        const manualBtn = document.createElement('button');
        manualBtn.className = 'team-queue-mode-btn' + (_queueMode === 'manual' ? ' active' : '');
        manualBtn.textContent = 'Manual';
        manualBtn.addEventListener('click', () => {
            setQueueMode('manual');
        });
        const autoBtn = document.createElement('button');
        autoBtn.className = 'team-queue-mode-btn' + (_queueMode === 'auto' ? ' active' : '');
        autoBtn.textContent = 'Auto';
        autoBtn.title = 'Auto mode: when a coder finishes a task, the system clears the terminal and dispatches the next queued item automatically. Manual mode: you click Send Next Now for each item.';
        autoBtn.addEventListener('click', () => {
            setQueueMode('auto');
        });
        modeToggle.appendChild(manualBtn);
        modeToggle.appendChild(autoBtn);
        header.appendChild(modeToggle);
        panel.appendChild(header);

        // Queue list.
        if (_queueItems.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'team-queue-empty';
            empty.textContent = 'Queue is empty. Drop a plan or prompt to enqueue.';
            panel.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.className = 'team-queue-list';
            _queueItems.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'team-queue-item';
                row.draggable = true;
                row.dataset.itemId = item.id;
                row.dataset.index = String(idx);

                const pos = document.createElement('span');
                pos.className = 'team-queue-item-pos';
                pos.textContent = String(idx + 1);
                row.appendChild(pos);

                const kind = document.createElement('span');
                kind.className = `team-queue-item-kind kind-${item.kind}`;
                kind.textContent = item.kind;
                row.appendChild(kind);

                const itemTitle = document.createElement('span');
                itemTitle.className = 'team-queue-item-title';
                // Title: planId for plan items, first line of body for prompts.
                const displayTitle = item.kind === 'plan'
                    ? (item.planId || 'plan')
                    : (item.body.split('\n')[0] || item.kind);
                itemTitle.textContent = displayTitle;
                itemTitle.title = item.body || '';
                row.appendChild(itemTitle);

                const delBtn = document.createElement('button');
                delBtn.className = 'team-queue-item-delete';
                delBtn.textContent = '\u00d7';
                delBtn.title = 'Remove from queue';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteQueueItem(item.id);
                });
                row.appendChild(delBtn);

                // Drag-to-reorder.
                row.addEventListener('dragstart', (e) => {
                    row.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', item.id);
                });
                row.addEventListener('dragend', () => {
                    row.classList.remove('dragging');
                });
                row.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                });
                row.addEventListener('drop', (e) => {
                    e.preventDefault();
                    const draggedId = e.dataTransfer.getData('text/plain');
                    if (!draggedId || draggedId === item.id) { return; }
                    // Reorder: move draggedId before this item.
                    const ids = _queueItems.map(i => i.id);
                    const fromIdx = ids.indexOf(draggedId);
                    const toIdx = ids.indexOf(item.id);
                    if (fromIdx === -1 || toIdx === -1) { return; }
                    ids.splice(fromIdx, 1);
                    ids.splice(toIdx, 0, draggedId);
                    reorderQueueItems(ids);
                });

                list.appendChild(row);
            });
            panel.appendChild(list);

            // Actions: "Send next now" (manual mode only).
            const actions = document.createElement('div');
            actions.className = 'team-queue-actions';
            const sendBtn = document.createElement('button');
            sendBtn.className = 'team-queue-send-btn';
            sendBtn.textContent = 'Send Next Now';
            sendBtn.disabled = _queueItems.length === 0;
            sendBtn.addEventListener('click', () => {
                sendBtn.disabled = true;
                sendNextQueueItem();
            });
            actions.appendChild(sendBtn);
            panel.appendChild(actions);
        }

        return panel;
    }

    /** Delete a queue item via the API, then re-fetch + re-render. */
    async function deleteQueueItem(itemId) {
        if (!teamScopeId || !itemId) { return; }
        try {
            await fetch(`/terminals/teams/${encodeURIComponent(teamScopeId)}/queue/${encodeURIComponent(itemId)}`, {
                method: 'DELETE',
                credentials: 'same-origin'
            });
        } catch { /* ignore */ }
        await fetchTeamQueue();
        renderSidebarList();
    }

    /** Reorder queue items via the API, then re-fetch + re-render. */
    async function reorderQueueItems(order) {
        if (!teamScopeId) { return; }
        try {
            await fetch(`/terminals/teams/${encodeURIComponent(teamScopeId)}/queue/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order }),
                credentials: 'same-origin'
            });
        } catch { /* ignore */ }
        await fetchTeamQueue();
        renderSidebarList();
    }

    /** Send the next queue item to the team head. Dispatches the prompt via
     *  ptySendPrompt, then deletes the item from the file-based queue on a
     *  successful dispatch. If ptySendPrompt fails, the item stays queued for
     *  retry. Manual mode only — auto mode is completion-driven (the coder
     *  POSTs queue/done on task finish and the system handler dispatches the
     *  next item). */
    async function sendNextQueueItem() {
        if (!teamScopeId || _queueItems.length === 0) { return; }
        const next = _queueItems[0];
        if (!next) { return; }
        try {
            // Dispatch the prompt to the team head.
            const group = getScopedTeamGroup();
            const headName = group ? teamHeadName(group) : null;
            if (!headName) {
                await fetchTeamQueue();
                renderSidebarList();
                return;
            }
            // Build the prompt from the item body.
            const promptText = next.body || (next.kind === 'plan' ? `Work on plan: ${next.planId || ''}` : '');
            let dispatched = false;
            if (promptText) {
                const dispatchRes = await fetch('/terminals/verb/ptySendPrompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: headName, data: promptText, clearBeforePrompt: false }),
                    credentials: 'same-origin'
                });
                const dispatchData = await dispatchRes.json().catch(() => null);
                dispatched = dispatchRes.ok && dispatchData?.success !== false;
            }
            // On successful dispatch, delete the item from the file-based queue.
            // If ptySendPrompt failed, do NOT delete — the item stays queued for
            // retry (the next "Send Next Now" click re-attempts it).
            if (dispatched) {
                const deleteRes = await fetch(`/terminals/teams/${encodeURIComponent(teamScopeId)}/queue/${encodeURIComponent(next.id)}`, {
                    method: 'DELETE',
                    credentials: 'same-origin'
                });
                const deleteData = await deleteRes.json().catch(() => null);
                if (!deleteRes.ok || !deleteData?.success) {
                    showPaneToast(deleteData?.error || 'Prompt sent, but the queue item could not be removed');
                }
            }
        } catch { /* ignore */ }
        await fetchTeamQueue();
        renderSidebarList();
    }

    /** Set the team queue auto/manual mode via the queue/mode endpoint.
     *  The queueMode is stored on the group config in terminals.groups. */
    async function setQueueMode(mode) {
        if (!teamScopeId) { return; }
        try {
            const res = await fetch(`/terminals/teams/${encodeURIComponent(teamScopeId)}/queue/mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode }),
                credentials: 'same-origin'
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                showPaneToast(data?.error || `Could not switch queue to ${mode} mode`);
            } else {
                _queueMode = mode;
                const group = getScopedTeamGroup();
                if (group) {
                    group.queueMode = mode;
                }
            }
        } catch (err) {
            showPaneToast(`Could not switch queue mode: ${err.message || String(err)}`);
        }
        renderSidebarList();
    }

    /** Enqueue an item to the scoped team's queue. Called from drag-drop
     *  handlers (kanban card → team) or programmatic enqueue. */
    async function enqueueToTeamQueue(params) {
        if (!teamScopeId) { return; }
        try {
            await fetch(`/terminals/teams/${encodeURIComponent(teamScopeId)}/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
                credentials: 'same-origin'
            });
        } catch { /* ignore */ }
        await fetchTeamQueue();
        renderSidebarList();
    }

    /** Get the current queue depth (for the rail badge). */
    function getQueueDepth() {
        return _queueItems.length;
    }

    /**
     * Render the group tab strip above the pane grid. Replaces the old sidebar
     * groups tier (renderGroupSidebar). One tab per group plus a leading "All"
     * tab and a trailing "+". Returns true when it mounted the role picker, so
     * the caller's `pickerRendered` bookkeeping covers the strip's picker too.
     *
     * The strip is rendered from renderSidebarList() — NOT on its own timer —
     * because the tab labels carry live member counts and two independent
     * refresh cycles over the same fleetList would disagree visibly.
     *
     * The picker for a `group:*` key is mounted INSIDE the strip element (which
     * lives outside `listEl`), so the `listEl.innerHTML = ''` wipe on every
     * fleet poll does not destroy it. The `pickerRendered = true` guard at the
     * bottom of renderSidebarList prevents the garbage-collect line from
     * nulling `pickerState` for `group:*` keys.
     */
    function renderGroupTabStrip() {
        if (!groupTabStripEl || soloTerminalName) { return false; }
        groupTabStripEl.innerHTML = '';

        const tabRow = document.createElement('div');
        tabRow.className = 'group-tab-row';

        const inTeamScope = !!teamScopeId;
        let allTab;
        let addBtn = null;
        const groupTabEls = [];

        if (controllerScopeActive) {
            // Controller scope needs the same escape hatch team scope has. It hides
            // every general-purpose sidebar button via the is-controller-scoped CSS,
            // so without a back affordance the only way out is END SESSION — i.e. the
            // user must end the Mission Control session to stop looking at it. This is
            // the "a scope that hides but never restores" failure the plan names.
            allTab = document.createElement('button');
            allTab.type = 'button';
            allTab.className = 'group-tab';
            allTab.title = 'Return to the full fleet view';
            const backName = document.createElement('span');
            backName.textContent = '← All';
            allTab.appendChild(backName);
            allTab.addEventListener('click', () => exitControllerScope());
            tabRow.appendChild(allTab);
            groupTabStripEl.appendChild(tabRow);
            // false = no role picker was mounted. The return value is `pickerRendered`,
            // not "did I draw something" — returning true would set the caller's
            // pickerRendered flag and suppress the pickerState garbage-collect.
            return false;
        }

        if (inTeamScope) {
            // "← All" back button — exits team scope, returns to fleet view.
            allTab = document.createElement('button');
            allTab.type = 'button';
            allTab.className = 'group-tab';
            allTab.title = 'Return to the full fleet view';
            const allTabName = document.createElement('span');
            allTabName.textContent = '← All';
            allTab.appendChild(allTabName);
            allTab.addEventListener('click', () => exitTeamScope());
            tabRow.appendChild(allTab);

            // Team group tabs only — non-team groups belong to the fleet view.
            const teamGroups = getAllGroups().filter(g => isSpawnedTeamGroup(g));
            for (const g of teamGroups) {
                const isActive = g.id === teamScopeId;
                const tab = document.createElement('div');
                tab.className = 'group-tab' + (isActive ? ' active' : '');
                tab.title = g.name;
                tab.dataset.groupId = g.id;

                const nameSpan = document.createElement('span');
                nameSpan.textContent = g.name;
                tab.appendChild(nameSpan);

                const members = getGroupMembers(g);
                const countSpan = document.createElement('span');
                countSpan.className = 'group-tab-count';
                countSpan.textContent = String(members.length);
                tab.appendChild(countSpan);

                // No delete button in team-scoped mode — teams are managed
                // through the team view, not the tab strip.
                tab.addEventListener('click', () => {
                    if (teamScopeId === g.id) { return; }
                    enterTeamScope(g.id);
                });

                groupTabEls.push({ el: tab, group: g });
                tabRow.appendChild(tab);
            }
            // No "+" button — team-scoped mode has its own "Add Terminal" sidebar button.
        } else {
        // "Unassigned" tab — active when no group is locked. Clicking it drops the lock.
        // Clicking the already-active tab resets composition to unassigned terminals.
        const unassignedCount = getUnassignedTerminalNames().length;
        allTab = document.createElement('button');
        allTab.type = 'button';
        allTab.className = 'group-tab' + (activeGroupId ? '' : ' active');
        allTab.title = activeGroupId
            ? 'Drop the lock and show unassigned terminals'
            : 'Unassigned terminals';

        const allTabName = document.createElement('span');
        allTabName.textContent = 'Unassigned';
        allTab.appendChild(allTabName);

        const allTabCount = document.createElement('span');
        allTabCount.className = 'group-tab-count';
        allTabCount.textContent = String(unassignedCount);
        allTab.appendChild(allTabCount);

        allTab.addEventListener('click', () => {
            clearGroupLock();
        });
        tabRow.appendChild(allTab);

        // Group tabs — one per group from getAllGroups() in sortGroups order.
        const groups = getAllGroups();
        for (const g of groups) {
            const isActive = g.id === activeGroupId;
            const tab = document.createElement('div');
            tab.className = 'group-tab' + (isActive ? ' active' : '');
            tab.title = g.name;
            tab.dataset.groupId = g.id;

            const nameSpan = document.createElement('span');
            nameSpan.textContent = g.name;
            tab.appendChild(nameSpan);

            const members = getGroupMembers(g);
            const countSpan = document.createElement('span');
            countSpan.className = 'group-tab-count';
            countSpan.textContent = String(members.length);
            tab.appendChild(countSpan);

            // Delete affordance — every tab. One verb, one handler: deleteGroup
            // handles all sources (manual → remove record + prune state;
            // derived → suppress via groupPrefs.hidden). If the deleted group
            // is the locked one, deleteGroup routes through clearGroupLock to
            // re-seat the grid. No confirm gate — per CLAUDE.md, delete
            // executes immediately on click.
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'group-tab-delete';
            delBtn.textContent = '×';
            delBtn.title = 'Delete this group';
            delBtn.setAttribute('aria-label', `Delete ${g.name}`);
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteGroup(g.id);
            });
            tab.appendChild(delBtn);

            // Click: the active tab is inert. "Leave this group" is the "All"
            // tab sitting to the left — it must not inherit the old row's
            // toggle-to-clear behaviour.
            tab.addEventListener('click', () => {
                // A team tab enters team scope even when its group is ALREADY
                // the locked one. startTeam (via switchToTeamGroup) and the
                // load-time lock restore both leave a team group sitting as
                // activeGroupId without entering scope; behind the
                // inert-active-tab guard that state was impossible to escape
                // from the strip — click the team you just started, nothing
                // happens. Only re-entering the SAME scope is a no-op.
                if (isSpawnedTeamGroup(g)) {
                    if (teamScopeId !== g.id) { enterTeamScope(g.id); }
                    return;
                }
                if (activeGroupId === g.id) { return; }
                switchToGroup(g.id);
            });

            groupTabEls.push({ el: tab, group: g });
            tabRow.appendChild(tab);
        }

        // "+" button — opens the role picker scoped to the active group's
        // context. Uses a `group:<id>` key so pickerState keeps it alive
        // across fleet polls (the pickerRendered guard below covers it).
        addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'group-tab-add';
        addBtn.textContent = '+';
        addBtn.title = 'New terminal in active group context';
        const addKey = 'group:' + (activeGroupId || '__all__');
        addBtn.addEventListener('click', () => {
            onNewTerminalClicked(undefined, addKey);
        });
        tabRow.appendChild(addBtn);
        } // end else (fleet-view tab strip)

        // Attach BEFORE measuring. offsetWidth/clientWidth are 0 on a detached
        // node, so measuring here while tabRow was still unparented made
        // availableWidth negative and pushed EVERY group tab into the overflow
        // menu — the strip rendered as "All » +" with no tabs at all, in every
        // fleet shape. The overflow pass below removes children from tabRow,
        // which works identically whether it is attached or not.
        groupTabStripEl.appendChild(tabRow);

        // Overflow: past the strip's width, surplus tabs collapse into a »
        // menu. Realistic counts are small (derived groups only materialise
        // at groupPrefs.threshold members), so this is a guard, not the
        // common path. The » menu also carries the "N hidden groups — show
        // all" entry that used to live in the sidebar, and the role-grouping
        // toggle — so it must be reachable when there are no tabs at all,
        // otherwise the only control that turns role groups back on lives
        // inside a menu that role groups being off has hidden. Both the
        // measurement gate and the build gate are therefore unconditional;
        // overflowReserved (36px) is already subtracted unconditionally below,
        // so the » costs no layout that was not already budgeted.
        const hasHiddenGroups = !inTeamScope && Array.isArray(groupPrefs.hidden) && groupPrefs.hidden.length > 0;
        {
            // Reading offsetWidth forces a synchronous layout, so the
            // measurements are accurate before we remove anything.
            const stripWidth = tabRow.clientWidth;
            const addBtnWidth = addBtn ? addBtn.offsetWidth : 0;
            const overflowReserved = 36;
            const availableWidth = stripWidth - addBtnWidth - overflowReserved;

            let usedWidth = allTab.offsetWidth + 2;
            const overflowing = [];
            for (const item of groupTabEls) {
                const w = item.el.offsetWidth + 2;
                if (usedWidth + w <= availableWidth) {
                    usedWidth += w;
                } else {
                    overflowing.push(item);
                }
            }

            for (const item of overflowing) {
                if (item.el.parentNode === tabRow) {
                    tabRow.removeChild(item.el);
                }
            }

            // In fleet mode the » menu is always built (it carries the
            // role-grouping toggle and hidden-groups restore even when no
            // tabs overflow). In team-scoped mode the menu carries only
            // team tabs — skip it entirely when nothing overflowed.
            if (inTeamScope && overflowing.length === 0) {
                // No overflow items and no fleet-specific menu items — nothing
                // to put in the » menu. The tab strip is complete as-is.
            } else {

            const overflowContainer = document.createElement('div');
            overflowContainer.className = 'group-tab-overflow';

            const overflowBtn = document.createElement('button');
            overflowBtn.type = 'button';
            overflowBtn.className = 'group-tab-overflow-btn';
            overflowBtn.textContent = '»';
            overflowBtn.title = 'More groups';
            overflowContainer.appendChild(overflowBtn);

            const menu = document.createElement('div');
            menu.className = 'group-tab-overflow-menu';
            menu.style.display = 'none';

            const activeId = inTeamScope ? teamScopeId : activeGroupId;
            for (const item of overflowing) {
                const g = item.group;
                const menuItem = document.createElement('div');
                menuItem.className = 'group-tab-overflow-item' + (g.id === activeId ? ' active' : '');
                const nameSpan = document.createElement('span');
                nameSpan.textContent = g.name;
                const countSpan = document.createElement('span');
                countSpan.className = 'group-tab-count';
                countSpan.textContent = String(getGroupMembers(g).length);
                menuItem.appendChild(nameSpan);
                menuItem.appendChild(countSpan);
                menuItem.addEventListener('click', () => {
                    // Same rule as the in-strip tab: a team entry enters scope
                    // unless it is already the scoped team, so a team group
                    // holding the group lock cannot strand the entry.
                    if (isSpawnedTeamGroup(g)) {
                        if (teamScopeId !== g.id) { enterTeamScope(g.id); }
                    } else if (activeId !== g.id) {
                        switchToGroup(g.id);
                    }
                    menu.style.display = 'none';
                });
                menu.appendChild(menuItem);
            }

            if (overflowing.length > 0 && hasHiddenGroups) {
                const divider = document.createElement('div');
                divider.className = 'group-tab-overflow-divider';
                menu.appendChild(divider);
            }

            // Role-grouping toggle and hidden-groups restore — fleet-only.
            // In team-scoped mode the » menu carries only team tabs.
            if (!inTeamScope) {
            // Role-grouping toggle — opt-in consent for derived role groups.
            // Lives in the » menu so it is reachable even when role grouping is
            // off (zero tabs). No confirm gate per CLAUDE.md.
            const roleToggle = document.createElement('div');
            roleToggle.className = 'group-tab-overflow-item';
            roleToggle.textContent = groupPrefs.autoRoleGroups
                ? 'Group by role: on — click to stop'
                : 'Group by role: off — click to group same-role terminals per workspace';
            roleToggle.title = 'When on, terminals sharing a role IN THE SAME workspace or worktree get a group tab. Roles never span locations.';
            roleToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                groupPrefs.autoRoleGroups = !groupPrefs.autoRoleGroups;
                // Turning it off strands a lock on a group that no longer exists: no tab
                // renders active and the empty-pane fill goes inert. Drop it here, where
                // clearGroupLock also re-seats the grid and saves.
                const stillExists = getAllGroups().some(g => g.id === activeGroupId);
                if (activeGroupId && !stillExists) { clearGroupLock(); }
                else { saveLayoutSettings(); renderSidebarList(); }
            });
            menu.appendChild(roleToggle);

            if (hasHiddenGroups) {
                const restoreItem = document.createElement('div');
                restoreItem.className = 'group-tab-overflow-restore';
                restoreItem.textContent = `${groupPrefs.hidden.length} deleted group${groupPrefs.hidden.length === 1 ? '' : 's'} — restore all`;
                restoreItem.title = 'Restore every deleted derived group';
                restoreItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    groupPrefs.hidden = [];
                    saveLayoutSettings();
                    renderSidebarList();
                });
                menu.appendChild(restoreItem);
            }
            } // end if (!inTeamScope) — fleet-only overflow items

            overflowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
            });

            // Close on outside click — one-shot listener.
            document.addEventListener('click', function closeOverflow(ev) {
                if (!overflowContainer.contains(ev.target)) {
                    menu.style.display = 'none';
                    document.removeEventListener('click', closeOverflow);
                }
            });

            overflowContainer.appendChild(menu);
            if (addBtn) {
                tabRow.insertBefore(overflowContainer, addBtn);
            } else {
                tabRow.appendChild(overflowContainer);
            }
            } // end else (overflow container built)
        }

        // Picker for `group:*` key — mounted in the strip, outside listEl,
        // so the innerHTML wipe does not destroy it mid-choice. The key is
        // `group:<id>` (or `group:__all__` for the no-group-locked case).
        // Before mounting, confirm the group the picker was opened against
        // still exists: this plan puts a working delete on every tab, so an
        // operator can open the + on a group and then delete that group. If
        // the group is gone, do not mount — return false so the
        // garbage-collect at the bottom of renderSidebarList nulls the
        // stale pickerState. `__all__` always resolves (it is the no-group
        // sentinel, not a real group id).
        // In team-scoped mode there is no "+" button, so no `group:*` picker
        // is active — skip this block entirely (team pickers use `team:*` keys
        // and are mounted by renderTeamHeader).
        let pickerRendered = false;
        if (!inTeamScope && pickerState && pickerState.key && String(pickerState.key).startsWith('group:')) {
            const pickerGroupId = String(pickerState.key).slice('group:'.length);
            const groupStillExists = pickerGroupId === '__all__'
                || getAllGroups().some(g => g.id === pickerGroupId);
            if (groupStillExists) {
                const picker = mountRolePicker(pickerState.targetSpec);
                groupTabStripEl.appendChild(picker);
                pickerRendered = true;
            }
        }

        return pickerRendered;
    }

    /** Extract a trailing -N from a terminal name for numeric ordering. Renamed
     *  terminals with no numeric suffix sort after the numbered run. */
    function terminalNameSuffix(name) {
        const match = String(name || '').match(/-(\d+)$/);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    }

    /** Total-order comparator for the sidebar, grouped by agent role. */
    function compareTerminals(a, b) {
        // 1. Exited last.
        const aExited = a.status === 'exited' ? 1 : 0;
        const bExited = b.status === 'exited' ? 1 : 0;
        if (aExited !== bExited) { return aExited - bExited; }

        // 2–4. Role tier (mapped by column order before unmapped alphabetical).
        const aMapped = roleOrderMap[a.role] !== undefined ? 0 : 1;
        const bMapped = roleOrderMap[b.role] !== undefined ? 0 : 1;
        if (aMapped !== bMapped) { return aMapped - bMapped; }

        if (aMapped === 0) {
            const aOrder = roleOrderMap[a.role];
            const bOrder = roleOrderMap[b.role];
            if (aOrder !== bOrder) { return aOrder - bOrder; }
        } else {
            const aRole = a.role || '\uFFFF';
            const bRole = b.role || '\uFFFF';
            if (aRole !== bRole) { return aRole.localeCompare(bRole); }
        }

        // 5. Numeric suffix on friendlyName.
        const aSuffix = terminalNameSuffix(a.friendlyName);
        const bSuffix = terminalNameSuffix(b.friendlyName);
        if (aSuffix !== bSuffix) { return aSuffix - bSuffix; }

        // 6. startTime, then final tiebreak on name.
        const aStart = a.startTime || '';
        const bStart = b.startTime || '';
        if (aStart !== bStart) { return aStart.localeCompare(bStart); }
        return String(a.friendlyName || '').localeCompare(String(b.friendlyName || ''));
    }

    /**
     * name -> claiming MANUAL group, built once per render.
     *
     * findGroupForTerminalName calls getGroupMembers for every group, so calling it
     * per row is O(rows x groups x members) on a path that runs on every fleet
     * poll. Manual groups only: a started team registers itself as one
     * (teamWiring.ts:1038), while derived role/worktree groups are queries — and a
     * derived worktree group would duplicate the worktree tier this sits inside.
     * First claimant wins, matching findGroupForTerminalName's precedence.
     *
     * Read straight off the group's own roster arrays rather than through
     * getGroupMembers: that resolver intersects with the LIVE set
     * (fleetList.filter(status !== 'exited')), so an exited seat would lose its
     * claim, fall out of its team's tier and re-render as a loose row underneath
     * it — and renderTeamTier's `Xx` count could never be nonzero. A tier is a
     * place; a seat does not leave it by exiting. Ordering is irrelevant here
     * (bucketRowsByTeam preserves the caller's already-sorted input order), and a
     * roster name with no live or tombstoned row is simply never looked up.
     */
    function buildTeamClaimMap() {
        const map = new Map();
        for (const g of terminalGroups) {
            if (!g || g.source !== 'manual') { continue; }
            const roster = [
                ...(Array.isArray(g.order) ? g.order : []),
                ...(Array.isArray(g.members) ? g.members : [])
            ];
            for (const name of roster) {
                if (name && !map.has(name)) { map.set(name, g); }
            }
        }
        return map;
    }

    /**
     * Split a sorted run of rows into per-team buckets plus the ungrouped
     * remainder. Buckets are ordered by first appearance in the already-sorted
     * input, so team order inherits compareTerminals' role tiering (a lead-headed
     * team sorts above a coder-headed one) with no second comparator.
     */
    function bucketRowsByTeam(items, claimMap) {
        const buckets = new Map();   // groupId -> { group, items: [] }
        const loose = [];
        for (const item of items) {
            const g = claimMap.get(item.friendlyName);
            if (!g) { loose.push(item); continue; }
            let b = buckets.get(g.id);
            if (!b) { b = { group: g, items: [] }; buckets.set(g.id, b); }
            b.items.push(item);
        }
        return { buckets: [...buckets.values()], loose };
    }

    /**
     * One team subheader plus its rows. Deliberately reuses the worktree tier's
     * classes for the header internals so the three tiers read as one system; only
     * the wrapper class differs, and it carries the indent + accent.
     *
     * The `+` targets the ENCLOSING location, not the team: a team is a roster, not
     * a directory, and there is no "spawn into this team" operation (team members
     * are spawned by the team start, teamWiring.ts).
     */
    function renderTeamTier(bucket, locationOwner) {
        // Keyed on LOCATION + team, not team alone. A team whose seats span a
        // workspace and a per-plan worktree renders a tier in each; on a bare
        // 'team:<id>' key those two visually separate tiers would collapse in
        // lockstep. The parent:/worktree: keys beside this one already avoid that
        // by keying on the thing rendered (parent id, worktree path) rather than
        // the thing named.
        const locationKey = locationOwner.fullPath || locationOwner.id || 'root';
        const key = 'team:' + locationKey + ':' + bucket.group.id;
        const isCollapsed = collapsedGroups.has(key);
        const div = document.createElement('div');
        div.className = 'team-group indent-team' + (isCollapsed ? ' collapsed' : '');

        const active = bucket.items.filter(i => i.status !== 'exited').length;
        const exited = bucket.items.length - active;

        const headerEl = document.createElement('div');
        headerEl.className = 'team-group-header';
        headerEl.title = `Team ${bucket.group.name}`;

        const titleArea = document.createElement('div');
        titleArea.className = 'worktree-title-area';

        const icon = document.createElement('span');
        icon.className = 'worktree-collapse-icon';
        icon.textContent = '▼';

        const nameEl = document.createElement('span');
        nameEl.className = 'worktree-name';
        nameEl.textContent = bucket.group.shortName || bucket.group.name;

        const countEl = document.createElement('span');
        countEl.className = 'worktree-count';
        countEl.textContent = `${bucket.items.length} (${active}a/${exited}x)`;

        titleArea.appendChild(icon);
        titleArea.appendChild(nameEl);
        titleArea.appendChild(countEl);

        const newBtn = document.createElement('button');
        newBtn.className = 'btn-group-new';
        newBtn.textContent = '+';
        newBtn.title = `Spawn terminal in ${locationOwner.name || locationOwner.basename || 'workspace'}`;
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Spawn spec AND picker key are the enclosing header's, verbatim. A
            // parentGroup carries `worktreesMap`; a wtGroup does not. The parent
            // arm must reproduce the header's own `fullPath ? {parentRoot} :
            // undefined` ternary and derive its key from the owner's id. An earlier
            // version hardcoded the synthetic workspace-root key as the no-path
            // fallback, which mounted the picker under a key no header renders (a
            // real mapping with an empty parentFolder), so mountRolePicker never ran
            // and the end-of-render garbage-collect swallowed pickerState.
            if (locationOwner.worktreesMap) {
                onNewTerminalClicked(
                    locationOwner.fullPath ? { parentRoot: locationOwner.fullPath } : undefined,
                    'parent:' + locationOwner.id
                );
            } else {
                onNewTerminalClicked({ worktreePath: locationOwner.fullPath }, 'worktree:' + locationOwner.fullPath);
            }
        });

        headerEl.appendChild(titleArea);
        headerEl.appendChild(newBtn);

        headerEl.addEventListener('click', () => {
            if (collapsedGroups.has(key)) {
                collapsedGroups.delete(key);
            } else {
                collapsedGroups.add(key);
            }
            saveLayoutSettings();
            renderSidebarList();
        });

        div.appendChild(headerEl);

        const itemsEl = document.createElement('div');
        itemsEl.className = 'team-items';
        for (const item of bucket.items) {
            itemsEl.appendChild(renderTerminalRow(item, { inTeamTier: true }));
        }
        div.appendChild(itemsEl);

        return div;
    }

    function renderSidebarList() {
        syncLinkUpEnabled();
        const btnTeamOrders = document.getElementById('btn-team-orders');
        if (btnTeamOrders) { btnTeamOrders.hidden = !teamScopeId; }
        const btnTeamAutos = document.getElementById('btn-team-automations');
        if (btnTeamAutos) { btnTeamAutos.hidden = !teamScopeId; }
        const btnTeamClear = document.getElementById('btn-team-clear');
        if (btnTeamClear) { btnTeamClear.hidden = !teamScopeId; }
        const btnTeamClearMembers = document.getElementById('btn-team-clear-members');
        if (btnTeamClearMembers) { btnTeamClearMembers.hidden = !teamScopeId; }
        const btnTeamClose = document.getElementById('btn-team-close');
        if (btnTeamClose) { btnTeamClose.hidden = !teamScopeId; }
        const btnTeamAck = document.getElementById('btn-team-ack');
        if (btnTeamAck) {
            let heldCount = 0;
            if (teamScopeId) {
                const snap = getScopedTeamSnapshot();
                if (snap && Array.isArray(snap.members)) {
                    for (const member of snap.members) {
                        heldCount += (heldUnposted[member] || 0);
                    }
                }
            }
            btnTeamAck.hidden = !teamScopeId || heldCount === 0;
            btnTeamAck.textContent = `RELEASE ${heldCount} HELD CARD${heldCount === 1 ? '' : 'S'}`;
        }
        const btnTeamAdd = document.getElementById('btn-team-add');
        if (btnTeamAdd) { btnTeamAdd.hidden = !teamScopeId; }
        // Controller-scoped ops button: visible only in controller scope.
        const btnControllerStop = document.getElementById('btn-controller-stop');
        if (btnControllerStop) { btnControllerStop.hidden = !controllerScopeActive; }
        // RESTART EXITED MEMBERS: dynamic disabled state — re-evaluated on
        // every renderSidebarList call (5s poll) so a deleted definition
        // disables the button within one poll cycle.
        const btnTeamRestart = document.getElementById('btn-team-restart');
        if (btnTeamRestart) {
            btnTeamRestart.hidden = !teamScopeId;
            if (teamScopeId) {
                const group = getScopedTeamGroup();
                const hasDefinition = group && isSpawnedTeamGroup(group) && group.definitionId;
                btnTeamRestart.disabled = !hasDefinition;
                btnTeamRestart.title = hasDefinition
                    ? 'Re-spawn exited members from the definition'
                    : 'Team definition not found — cannot restart missing members';
            }
        }
        let pickerRendered = false;
        listEl.innerHTML = '';
        // The empty state and the pane grid are in the MAIN area; the workspace groups
        // below are in the sidebar. So an empty fleet toggles those two and then keeps
        // going — it does NOT return.
        //
        // It used to return here, and that is what hid the workspaces until the operator
        // opened a terminal: every parent group carries the per-workspace `+` that spawns
        // INTO that workspace, so a zero-terminal fleet rendered a sidebar with no spawn
        // targets at all. Creating a terminal by any other route repopulated fleetList,
        // the guard stopped firing, and the workspaces appeared — which read as "the list
        // only loads once you open a terminal". The parents list does not depend on the
        // fleet (ptyListTerminals returns it either way), so neither should its render.
        if (fleetList.length === 0) {
            if (!soloTerminalName) {
                emptyStateEl.style.display = 'flex';
                paneGridEl.style.display = 'none';
            }
        } else {
            emptyStateEl.style.display = 'none';
            paneGridEl.style.display = 'grid';
        }

        // Team-scoped empty state: the fleet is loaded but the team has no
        // live members. Show a team-specific message rather than the generic
        // "no terminals" panel state. checkTeamNotFound handles the
        // group-deleted case separately.
        if (teamScopeId && hasFetchedList) {
            const scoped = scopedFleet();
            if (scoped.length === 0 && getScopedTeamGroup()) {
                emptyStateEl.style.display = 'flex';
                emptyStateEl.textContent = 'All team members have exited. Use + to spawn new ones.';
                paneGridEl.style.display = 'none';
            } else {
                // Restore the default empty-state text in case it was changed.
                emptyStateEl.textContent = 'No terminal selected. Use the + beside a workspace in the sidebar to spawn one.';
            }
        }

        if (selectedTerminalNames.size > 0 && !teamScopeId) {
            const selRow = document.createElement('div');
            selRow.className = 'group-tier-header';
            const selTitle = document.createElement('span');
            selTitle.className = 'worktree-name';
            selTitle.textContent = `${selectedTerminalNames.size} selected`;
            const groupBtn = document.createElement('button');
            groupBtn.className = 'group-tier-btn';
            groupBtn.textContent = 'group';
            groupBtn.title = 'Save selection as a manual group';
            groupBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.className = 'item-name-input';
                input.placeholder = 'Group name';
                input.style.width = '100%';
                input.style.marginTop = '8px';
                selRow.replaceWith(input);
                input.focus();
                // One-shot for the same Enter-then-blur double-commit reason as the
                // SAVE AS GROUP input above.
                let done = false;
                const finish = (save) => {
                    if (done) { return; }
                    done = true;
                    const name = input.value.trim();
                    input.replaceWith(selRow);
                    if (save && name) {
                        saveSelectionAsGroup(name);
                    } else {
                        selectedTerminalNames.clear();
                        renderSidebarList();
                    }
                };
                input.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') { finish(true); }
                    if (ev.key === 'Escape') { finish(false); }
                });
                input.addEventListener('blur', () => finish(true));
            });
            const clearBtn = document.createElement('button');
            clearBtn.className = 'group-tier-btn';
            clearBtn.textContent = 'clear';
            clearBtn.title = 'Clear selection';
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedTerminalNames.clear();
                renderSidebarList();
            });
            const actions = document.createElement('div');
            actions.className = 'group-tier-actions';
            actions.appendChild(groupBtn);
            actions.appendChild(clearBtn);
            selRow.appendChild(selTitle);
            selRow.appendChild(actions);
            listEl.appendChild(selRow);
        }

        // Render the group tab strip (above the pane grid, outside listEl).
        // The strip's picker uses a `group:*` key; the guard at the bottom
        // of this function prevents the garbage-collect from nulling it.
        // In team-scoped mode the strip renders "← All" + team tabs for
        // direct team-to-team switching, and renderTeamHeader appends the
        // team context bar below the tab row.
        if (!soloTerminalName) {
            if (renderGroupTabStrip()) { pickerRendered = true; }
        }
        if (teamScopeId) {
            if (renderTeamHeader()) { pickerRendered = true; }
            // Render the work queue panel below the team header. Fetch is
            // non-blocking — the panel renders with the cached items and
            // updates on the next poll. The fetch is kicked off here so
            // it stays in sync with the sidebar refresh cycle.
            fetchTeamQueue();
            const queuePanel = renderTeamQueuePanel();
            if (queuePanel) {
                listEl.appendChild(queuePanel);
            }
        }

        let parents = Array.isArray(parentsList) ? [...parentsList] : [];
        if (parents.length === 0) {
            parents.push({
                id: 'workspace-root',
                name: 'Workspace Root',
                parentFolder: '',
                workspaceFolders: []
            });
        }

        const parentGroups = parents.map(p => ({
            id: p.id,
            name: p.name || 'Workspace Root',
            fullPath: p.parentFolder || '',
            direct: [],
            worktreesMap: new Map()
        }));

        const unmappedGroup = {
            id: 'unmapped',
            name: 'Unmapped',
            fullPath: 'Unmapped',
            direct: [],
            worktreesMap: new Map()
        };

        const allParentFolders = new Set(parentGroups.map(p => p.fullPath).filter(Boolean));

        // In team-scoped mode, only iterate the team's members (scopedFleet).
        // The full fleetList is still in memory for sanitize, standing orders,
        // and dispatch-in-flight cleanup — this is the render boundary.
        const renderFleet = scopedFleet();
        for (const item of renderFleet) {
            let targetGroup = parentGroups.find(p => p.fullPath && p.fullPath === item.parentRoot);
            if (!targetGroup) {
                // Fold an unattributed terminal into the sole group ONLY when that group is
                // the synthetic catch-all (mappings disabled, or the host sent no parents at
                // all) — there, everything genuinely belongs to it. With one REAL configured
                // mapping, folding would file a shell in an unmapped directory under that
                // parent's name, which is the mislabelling this hierarchy exists to remove.
                const soleSynthetic = parentGroups.length === 1
                    && (parentGroups[0].id === 'workspace-root' || !parentGroups[0].fullPath);
                targetGroup = soleSynthetic ? parentGroups[0] : unmappedGroup;
            }

            const wtPath = item.worktreePath;
            const isDirect = !wtPath || wtPath === targetGroup.fullPath || allParentFolders.has(wtPath);

            if (isDirect) {
                targetGroup.direct.push(item);
            } else {
                let wtGroup = targetGroup.worktreesMap.get(wtPath);
                if (!wtGroup) {
                    const parts = wtPath.replace(/\\/g, '/').split('/').filter(Boolean);
                    const basename = parts.length > 0 ? parts[parts.length - 1] : wtPath;
                    wtGroup = { basename, fullPath: wtPath, items: [] };
                    targetGroup.worktreesMap.set(wtPath, wtGroup);
                }
                wtGroup.items.push(item);
            }
        }

        const activeGroupsToRender = [
            ...parentGroups,
            ...(unmappedGroup.direct.length > 0 || unmappedGroup.worktreesMap.size > 0 ? [unmappedGroup] : [])
        ];

        // Sort each bucket by role before rendering. Workspace/worktree hierarchy stays.
        // In team-scoped mode, sort by the group's `order` array — the operator
        // authored that order and a scoped view is where it should be honoured.
        const teamOrder = teamScopeId ? scopedMemberNamesOrdered() : null;
        const teamOrderMap = teamOrder ? new Map(teamOrder.map((n, i) => [n, i])) : null;
        const teamComparator = (a, b) => {
            if (teamOrderMap) {
                const ai = teamOrderMap.has(a.friendlyName) ? teamOrderMap.get(a.friendlyName) : Number.MAX_SAFE_INTEGER;
                const bi = teamOrderMap.has(b.friendlyName) ? teamOrderMap.get(b.friendlyName) : Number.MAX_SAFE_INTEGER;
                if (ai !== bi) { return ai - bi; }
            }
            return compareTerminals(a, b);
        };
        for (const group of activeGroupsToRender) {
            group.direct.sort(teamComparator);
            for (const wtGroup of group.worktreesMap.values()) {
                wtGroup.items.sort(teamComparator);
            }
        }

        const claimMap = buildTeamClaimMap();

        for (const parentGroup of activeGroupsToRender) {
            const parentKey = 'parent:' + parentGroup.id;
            const isParentCollapsed = collapsedGroups.has(parentKey);
            const parentDiv = document.createElement('div');
            parentDiv.className = 'parent-group' + (isParentCollapsed ? ' collapsed' : '');

            let totalItems = parentGroup.direct.length;
            let activeCount = parentGroup.direct.filter(i => i.status !== 'exited').length;

            for (const wtGroup of parentGroup.worktreesMap.values()) {
                totalItems += wtGroup.items.length;
                activeCount += wtGroup.items.filter(i => i.status !== 'exited').length;
            }
            const exitedCount = totalItems - activeCount;

            const headerEl = document.createElement('div');
            headerEl.className = 'parent-group-header';
            if (parentGroup.fullPath) headerEl.title = parentGroup.fullPath;

            const titleArea = document.createElement('div');
            titleArea.className = 'worktree-title-area';

            const icon = document.createElement('span');
            icon.className = 'worktree-collapse-icon';
            icon.textContent = '▼';

            const nameEl = document.createElement('span');
            nameEl.className = 'worktree-name';
            nameEl.textContent = parentGroup.name;

            const countEl = document.createElement('span');
            countEl.className = 'worktree-count';
            countEl.textContent = `${totalItems} (${activeCount}a/${exitedCount}x)`;

            titleArea.appendChild(icon);
            titleArea.appendChild(nameEl);
            titleArea.appendChild(countEl);

            const groupNewBtn = document.createElement('button');
            groupNewBtn.className = 'btn-group-new';
            groupNewBtn.textContent = '+';
            groupNewBtn.title = `Spawn terminal in ${parentGroup.name}`;
            groupNewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onNewTerminalClicked(parentGroup.fullPath ? { parentRoot: parentGroup.fullPath } : undefined, parentKey);
            });

            headerEl.appendChild(titleArea);
            headerEl.appendChild(groupNewBtn);

            headerEl.addEventListener('click', () => {
                if (collapsedGroups.has(parentKey)) {
                    collapsedGroups.delete(parentKey);
                } else {
                    collapsedGroups.add(parentKey);
                }
                saveLayoutSettings();
                renderSidebarList();
            });

            parentDiv.appendChild(headerEl);

            // Between header and items, NOT inside .parent-group-items — that
            // container is display:none when the group is collapsed, and a picker
            // the user opened must not vanish because the group happens to be shut.
            // itemsContainer is appended later, so appending here yields
            // header → picker → items.
            if (pickerState && pickerState.key === parentKey) {
                parentDiv.appendChild(mountRolePicker(pickerState.targetSpec));
                pickerRendered = true;
            }

            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'parent-group-items';

            if (totalItems === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.className = 'empty-parent-notice';
                emptyNotice.textContent = '(no terminals — + to open)';
                itemsContainer.appendChild(emptyNotice);
            } else {
                const directSplit = bucketRowsByTeam(parentGroup.direct, claimMap);
                for (const bucket of directSplit.buckets) {
                    itemsContainer.appendChild(renderTeamTier(bucket, parentGroup));
                }
                for (const item of directSplit.loose) {
                    itemsContainer.appendChild(renderTerminalRow(item));
                }

                for (const [wtPath, wtGroup] of parentGroup.worktreesMap.entries()) {
                    const wtKey = 'worktree:' + wtPath;
                    const isWtCollapsed = collapsedGroups.has(wtKey);
                    const wtDiv = document.createElement('div');
                    wtDiv.className = 'worktree-group indent-worktree' + (isWtCollapsed ? ' collapsed' : '');

                    const wtActive = wtGroup.items.filter(i => i.status !== 'exited').length;
                    const wtExited = wtGroup.items.length - wtActive;

                    const wtHeaderEl = document.createElement('div');
                    wtHeaderEl.className = 'worktree-group-header';
                    wtHeaderEl.title = wtGroup.fullPath;

                    const wtTitleArea = document.createElement('div');
                    wtTitleArea.className = 'worktree-title-area';

                    const wtIcon = document.createElement('span');
                    wtIcon.className = 'worktree-collapse-icon';
                    wtIcon.textContent = '▼';

                    const wtNameEl = document.createElement('span');
                    wtNameEl.className = 'worktree-name';
                    wtNameEl.textContent = wtGroup.basename;

                    const wtCountEl = document.createElement('span');
                    wtCountEl.className = 'worktree-count';
                    wtCountEl.textContent = `${wtGroup.items.length} (${wtActive}a/${wtExited}x)`;

                    wtTitleArea.appendChild(wtIcon);
                    wtTitleArea.appendChild(wtNameEl);
                    wtTitleArea.appendChild(wtCountEl);

                    const wtNewBtn = document.createElement('button');
                    wtNewBtn.className = 'btn-group-new';
                    wtNewBtn.textContent = '+';
                    wtNewBtn.title = `Spawn terminal in ${wtGroup.basename}`;
                    wtNewBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        onNewTerminalClicked({ worktreePath: wtPath }, wtKey);
                    });

                    wtHeaderEl.appendChild(wtTitleArea);
                    wtHeaderEl.appendChild(wtNewBtn);

                    wtHeaderEl.addEventListener('click', () => {
                        if (collapsedGroups.has(wtKey)) {
                            collapsedGroups.delete(wtKey);
                        } else {
                            collapsedGroups.add(wtKey);
                        }
                        saveLayoutSettings();
                        renderSidebarList();
                    });

                    wtDiv.appendChild(wtHeaderEl);

                    // Between worktree header and items — same reasoning as the parent
                    // group picker above. .worktree-items is display:none when the
                    // worktree is collapsed, so the picker must sit outside it.
                    if (pickerState && pickerState.key === wtKey) {
                        wtDiv.appendChild(mountRolePicker(pickerState.targetSpec));
                        pickerRendered = true;
                    }

                    const wtItemsContainer = document.createElement('div');
                    wtItemsContainer.className = 'worktree-items';
                    const wtSplit = bucketRowsByTeam(wtGroup.items, claimMap);
                    for (const bucket of wtSplit.buckets) {
                        wtItemsContainer.appendChild(renderTeamTier(bucket, wtGroup));
                    }
                    for (const item of wtSplit.loose) {
                        wtItemsContainer.appendChild(renderTerminalRow(item));
                    }
                    wtDiv.appendChild(wtItemsContainer);
                    itemsContainer.appendChild(wtDiv);
                }
            }

            parentDiv.appendChild(itemsContainer);
            listEl.appendChild(parentDiv);
        }

        // The group that owned the open picker is gone (mapping removed, worktree
        // pruned). Clearing here keeps the next `+` click from toggling a picker
        // nobody can see. AFTER the loop, not inside it: inside, the first group
        // that is not the owner would clear the state on every single render.
        //
        // The tab strip's `group:*` picker is mounted OUTSIDE listEl (in the strip
        // element above the pane grid), so the workspace-tree loop above never
        // encounters it. But renderGroupTabStrip() at :2755 already propagates
        // its own return value into pickerRendered — it returns true only when it
        // actually mounted the picker, and it refuses to mount when the group no
        // longer exists. That return value is the authoritative signal; no extra
        // guard is needed here, and an unconditional one would make the
        // garbage-collect unreachable for stale group: keys.
        if (pickerState && !pickerRendered) { pickerState = null; }

        // The group tab strip is rendered above the pane grid (outside listEl);
        // the sidebar is now one clean workspace→terminal tree. There is no
        // separate 'Show groups' view toggle.
    }

    /**
     * Point the layout picker’s highlight at the layout the USER picked.
     *
     * Keys on currentLayout, never effectiveLayout: applyLayoutFloor deliberately
     * demotes effectiveLayout when the window is too small and explains it with the
     * fallback banner. Highlighting the floored value would make the picker jump on
     * every resize and contradict the banner.
     *
     * Scoped to .layout-picker for the same reason the click binding is: an
     * unscoped .btn-layout query used to catch #btn-clear-all.
     */
    function syncLayoutPickerUI() {
        document.querySelectorAll('.layout-picker .btn-layout').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-layout') === currentLayout);
        });
    }

    function setLayoutMode(mode, opts = {}) {
        if (!LAYOUT_MODES.includes(mode)) return;
        // A deliberate layout/composer gesture exits a locked group unless the lock
        // itself is the one asking for the layout (switchToGroup passes keepLock).
        // In team-scoped mode, the lock is the team scope — never drop it.
        if (activeGroupId && !opts.keepLock && !teamScopeId) {
            activeGroupId = null;
            activeGroupPage = 0;
            saveLayoutSettings();
        }
        currentLayout = mode;
        // Adopt the pick optimistically so the render below is the ONLY render on the
        // common (fits-fine) path — applyLayoutFloor then re-renders only if the new
        // layout actually trips the floor.
        effectiveLayout = mode;

        syncLayoutPickerUI();
        sanitizePaneAssignments();
        renderPaneGrid();
        applyLayoutFloor();
    }

    /**
     * "Focus terminal" — the browser equivalent of the sidebar's `locate`.
     *
     * The sidebar reveals the terminal in the IDE; here the terminal is already on
     * this page, so revealing it means seating it in the focused pane and handing it
     * the caret. assignToFocusedPane does the seating and always has; the caret was
     * the missing half, which is why "focus terminal" never actually let you type.
     *
     * Deliberately declared ahead of assignToFocusedPane so it stays outside the
     * span shell-terminal-strip.test.js scans for that function's badge-clear paths.
     */
    function locateTerminal(name) {
        assignToFocusedPane(name);
        const index = paneAssignments.indexOf(name);
        if (index !== -1 && index < getSlotCount(effectiveLayout)) {
            focusPaneTerminal(index);
        }
    }

    function assignToFocusedPane(terminalName, opts = {}) {
        // Rule 1: a deliberate composer seat is a selection, and selecting any
        // terminal other than the peeked one ends the peek. This covers
        // locateTerminal (sidebar row click), drag-drop onto a pane, and the
        // inbound focusTerminal message. dismissPeek early-returns when no peek
        // is active, so the no-peek path — almost every call — pays nothing.
        // NOTE: dismissPeek is ABOVE the unlock block and must stay there — do
        // not reorder or gate it on opts.keepLock. The double dismissPeek from
        // handleLockedTerminalClick is harmless (it early-returns).
        dismissPeek();
        // A deliberate composer seat exits a locked group and keeps the panes as
        // they are until this assignment is applied — UNLESS the caller passed
        // keepLock (only handleLockedTerminalClick's free-slot branch does).
        // The caller MUST guarantee a free slot exists before passing keepLock,
        // because the displacement fallbacks below end in "displace the focused
        // pane", which under a lock would evict a group member to seat a non-member.
        if (activeGroupId && !opts.keepLock) {
            activeGroupId = null;
            activeGroupPage = 0;
        }
        const rendered = getSlotCount(effectiveLayout);
        if (focusedPaneIndex < 0 || focusedPaneIndex >= rendered) {
            focusedPaneIndex = 0;
        }

        const existingIndex = paneAssignments.indexOf(terminalName);
        if (existingIndex === focusedPaneIndex) { return; }

        // Already on screen? Follow it. Relocating a seated terminal to satisfy a click
        // empties one pane to fill another for zero gain — and if its seat is pinned,
        // relocating would break the pin outright. This branch sits OUTSIDE the
        // `paneAssignments[target]` conditional below: the old code only followed a
        // seated terminal when every rendered pane was full, which relocated it into a
        // free pane on the common case (one click clearing two panes for zero gain —
        // the defect the comment there already named). Following unconditionally is a
        // deliberate change to unpinned placement, called out in the plan's User Review.
        if (existingIndex !== -1 && existingIndex < rendered) {
            focusedPaneIndex = existingIndex;
            activeTerminalName = terminalName;
            terminalBadges.delete(terminalName);
            terminalReplayGaps.delete(terminalName);
            renderSidebarList();
            renderPaneGrid();
            postFleetStateToShell();
            return;
        }

        // Pins beat focus. This is the whole feature: the focused pane is where the caret
        // happens to be (it moves every time the operator types into a pane), which is far
        // too volatile to decide durable seating.
        //
        // ...except in a one-pane grid, where there is no other seat to protect the pinned
        // one FROM. LAYOUTS['1'] has zero minimums and is the last rung of
        // LAYOUT_FLOOR_ORDER, so a narrow window can drop a pinned 2h layout to a single
        // pane involuntarily — and honouring the pin there turns every sidebar click into
        // a dead click behind a toast. Inert, not enforced.
        const pinsActive = rendered > 1;
        const isOpen = (i) => i < rendered && (!pinsActive || !pinnedPanes[i]);

        let target = -1;
        if (isOpen(focusedPaneIndex)) {
            target = focusedPaneIndex;
        }
        // A kanban-mode slot is unassigned but occupied by a live board column, so it
        // is not a free seat: it must never be preferred over a genuinely empty pane,
        // and the focused pane being one must not short-circuit the scan. With no
        // kanban panes anywhere this is byte-for-byte the previous behaviour.
        const isFree = (i) => !paneAssignments[i] && paneModes[i] !== 'kanban';
        if (target === -1 || !isFree(target)) {
            for (let i = 0; i < rendered; i++) {
                if (isOpen(i) && isFree(i)) { target = i; break; }
            }
        }
        // Nothing free — this is a displacing click. Prefer displacing a terminal pane
        // over a kanban pane: the operator opened that column deliberately, and the
        // terminal keeps running either way. NOT widened to occupied targets in
        // general — a displacing click must still land on the FOCUSED pane, which is
        // what the retained `target` carries here.
        if (target === -1 || paneModes[target] === 'kanban') {
            for (let i = 0; i < rendered; i++) {
                if (isOpen(i) && paneModes[i] !== 'kanban') { target = i; break; }
            }
        }
        if (target === -1) {
            for (let i = 0; i < rendered; i++) {
                if (isOpen(i)) { target = i; break; }
            }
        }
        if (target === -1) {
            // Every rendered pane is pinned. Displacing one would defeat the pin; doing
            // nothing silently reads as a dead click. Say so.
            showPaneToast('All panes are pinned — unpin one to switch.', null);
            return;
        }

        // Navigation undo removed: rapid terminal switching is the primary interaction
        // and an Undo toast on every displacing click reads as nagging. The unassign
        // button still keeps its own undo (see the unassignBtn handler in
        // createPaneElement). hidePaneToast() below retracts any lingering unassign toast.

        if (existingIndex !== -1) {
            // Reachable only for a terminal parked in a NON-rendered slot (the
            // follow-branch above already returned for every rendered one), e.g. a
            // pin set in 3x3 and then shrunk to 2h. Vacating that slot must vacate
            // its pin with it: a pin on an empty slot reserves a seat nothing can
            // fill, it is persisted by the saveLayoutSettings below, and it renders
            // no marker on an empty pane — so widening back to 3x3 would show a pane
            // the sidebar silently refuses to seat into. Same invariant sanitize
            // enforces; enforced here too because sanitize only runs on a list
            // refresh, not on a sidebar click. existingIndex can never equal target
            // (target is always < rendered), so this cannot clear the new seat's pin.
            paneAssignments[existingIndex] = null;
            pinnedPanes[existingIndex] = false;
        }

        // A displacing click takes the pane away from whatever was in it, which is the
        // same event as `hide` for the outgoing terminal: its boot presentation is
        // over. Without this its curtain state stays armed for up to CURTAIN_MAX_MS —
        // the sidebar keeps pulsing for a terminal with no pane, and re-seating it
        // repaints a curtain over a prompt that settled long ago.
        const displacedName = paneAssignments[target];
        if (displacedName && displacedName !== terminalName) { dismissStartupCurtain(displacedName); }

        paneAssignments[target] = terminalName;
        focusedPaneIndex = target;
        activeTerminalName = terminalName;
        if (terminalBadges.has(terminalName)) {
            terminalBadges.delete(terminalName);
        }
        terminalReplayGaps.delete(terminalName);
        postFleetStateToShell();

        // No navigation toast. Retract any toast still on screen from a prior unassign —
        // on EVERY seating, displacing or not. Its Undo restores the whole pre-unassign
        // arrangement (undoLastAssignment replaces paneAssignments wholesale), so a toast
        // left live across a seating reverts this move too, which the operator never
        // asked for. Same invariant as the note on hidePaneToast: a toast must not
        // outlive the mutation it describes.
        hidePaneToast();

        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    function undoLastAssignment() {
        if (!undoSnapshot) { return; }
        hidePaneToast();
        paneAssignments = undoSnapshot.slots;
        if (Array.isArray(undoSnapshot.pins)) { pinnedPanes = undoSnapshot.pins; }
        focusedPaneIndex = Math.min(undoSnapshot.paneIndex, getSlotCount(effectiveLayout) - 1);
        activeTerminalName = paneAssignments[focusedPaneIndex] || null;
        undoSnapshot = null;
        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    /**
     * Give the caret to the terminal in `index`.
     *
     * Nothing in this file used to call term.focus() at all. xterm focuses its own
     * hidden textarea from its internal mousedown handler and nowhere else, so the
     * caret only ever arrived by accident — and any renderPaneGrid() landing after
     * that mousedown took it straight back out again (see the note in
     * renderPaneGrid). Selecting a pane therefore cost two clicks: the first was
     * spent on the rebuild.
     */
    function focusPaneTerminal(index) {
        const name = paneAssignments[index];
        if (!name) { return; }
        const entry = terminalsMap.get(name);
        if (!entry || !entry.term || entry.disposed) { return; }
        try { entry.term.focus(); } catch { /* ignore */ }
    }

    /** Drop the caret ring from every pane. Paired with the onFocus handler in
     *  materializeTerminalView — see the note there for why blur cannot target a
     *  single pane. */
    function clearCaretRing() {
        paneGridEl.querySelectorAll('.terminal-pane.has-caret')
            .forEach(el => el.classList.remove('has-caret'));
    }

    /**
     * Resolve what an operator can actually DO with this terminal right now.
     *
     * Derived, never stored: a socket transition does not re-render the grid, so a
     * cached value would go stale in exactly the situation the chip exists to
     * report. Order matters — a dead terminal whose socket happens to be OPEN is
     * read-only, not live.
     *
     * fleetList is consulted deliberately. It is what makes the header print
     * "(exited)" a few pixels to the chip's left (see updatePaneElement), and
     * entry.exited is only ever set by an error/exit FRAME. A terminal that died
     * without a frame — host restart, socket cut before the exit arrived — would
     * otherwise resolve `live`, and `live` renders NO chip, so the header would
     * read "(exited)" beside the blank space that means healthy. Two sources of
     * truth for "dead" in one header is the exact dishonesty this chip exists to
     * remove.
     *
     * `live` still carries a label even though nothing prints it. The caller
     * decides whether a state is worth drawing; the resolver's job is to name the
     * state, and a shape that changes per branch is harder to read than a string
     * that goes unused.
     */
    function resolveInputState(name) {
        const entry = terminalsMap.get(name);
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        if (fleetItem && fleetItem.status === 'exited') {
            return { key: 'readonly', label: 'read-only' };
        }
        if (!entry) { return { key: 'connecting', label: 'connecting' }; }
        if (entry.exited || (entry.term && entry.term.options.disableStdin)) {
            return { key: 'readonly', label: 'read-only' };
        }
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            // Throttled is NOT a failure state and must not outrank `connecting`:
            // input is queued, never dropped (see the inputThrottled arm of the
            // socket handler and enqueueInput in terminalWsGateway). The chip says
            // "still landing", which is the only thing the operator cannot
            // otherwise see — the CLI shows nothing until the paste arrives.
            if (entry.inputThrottled) {
                const kb = Math.max(1, Math.round((entry.queuedBytes || 0) / 1024));
                return { key: 'queued', label: `paste queued — ${kb} KB` };
            }
            return { key: 'live', label: 'accepts input' };
        }
        return { key: 'connecting', label: 'connecting' };
    }

    /** Repaint only the state class + chip for `name`. Cheaper than
     *  renderPaneGrid() and, more importantly, does not re-append any xterm — a
     *  grid rebuild during a socket transition would yank the caret out
     *  mid-keystroke. */
    function refreshInputState(name) {
        const paneIndex = paneAssignments.indexOf(name);
        if (paneIndex < 0) { return; }
        const paneEl = paneGridEl.querySelector(`.terminal-pane[data-pane-index="${paneIndex}"]`);
        if (!paneEl) { return; }
        const state = resolveInputState(name);
        paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly', 'is-input-queued');
        paneEl.classList.add(`is-input-${state.key}`);
        syncInputStateChip(paneEl, paneEl.querySelector('.pane-title'), state);
    }

    /**
     * Sync `paneEl`'s input-state chip to `state` — creating, updating or removing
     * it. The single writer for both call sites: the grid render in
     * updatePaneElement and the out-of-band refreshInputState.
     *
     * `live` renders NOTHING. The chip's entire job is to say "your keystrokes
     * will not land"; when they will, it has nothing to say, and a badge on every
     * healthy pane is chrome reporting the normal case — nine dots in a 3x3 that
     * never change. The focused-pane half of the signal is unaffected: the ring
     * still recolours via .has-caret.is-input-*.
     *
     * That conditional is why this both creates AND removes. refreshInputState
     * fires on socket transitions, so it is routinely handed a live pane with no
     * chip to repaint (connecting → live) or a connecting pane with no chip to
     * find (live → connecting). Its old early-return on a missing element would
     * now silently skip every disconnect.
     */
    function syncInputStateChip(paneEl, titleEl, state) {
        let chip = paneEl.querySelector('.pane-input-state');
        // The dispatch chip owns this corner while it is up. Two chips in a
        // 3x3 header ellipsise the terminal name away entirely.
        if (state.key === 'live' || paneEl.classList.contains('is-dispatching')) {
            if (chip) { chip.remove(); }
            return;
        }
        if (!chip) {
            const host = titleEl || paneEl.querySelector('.pane-title');
            if (!host) { return; }
            chip = document.createElement('span');
            chip.className = 'pane-input-state';
            host.appendChild(chip);
        }
        // isTerseLayout(), not an inline copy of the layout list: 2x3 and 3x3
        // headers are 10px tall with an ellipsised title, and a word here eats the
        // terminal name. Dot only there, title attribute carries the meaning.
        chip.textContent = isTerseLayout() ? '' : state.label;
        chip.title = state.label;
    }

    /** Single writer for the dispatch chip, same contract as syncInputStateChip:
     *  creates, updates AND removes, because both call sites are routinely handed
     *  a pane with no chip to repaint. */
    function syncDispatchChip(paneEl, titleEl, active) {
        let chip = paneEl.querySelector('.pane-dispatch-state');
        if (!active) {
            if (chip) { chip.remove(); }
            paneEl.classList.remove('is-dispatching');
            return;
        }
        paneEl.classList.add('is-dispatching');
        if (!chip) {
            const host = titleEl || paneEl.querySelector('.pane-title');
            if (!host) { return; }
            chip = document.createElement('span');
            chip.className = 'pane-dispatch-state';
            host.appendChild(chip);
        }
        // Terse layouts get the animated dot alone — isTerseLayout(), not an inline
        // copy of the layout list, for the same reason syncInputStateChip uses it.
        chip.textContent = isTerseLayout() ? '' : 'dispatching…';
        chip.title = 'Clearing the agent and pasting the prompt';
    }

    function beginDispatchIndicator(name) {
        dispatchInFlight.set(name, (dispatchInFlight.get(name) || 0) + 1);
        refreshDispatchState(name);
    }

    function endDispatchIndicator(name) {
        const next = (dispatchInFlight.get(name) || 1) - 1;
        if (next <= 0) { dispatchInFlight.delete(name); } else { dispatchInFlight.set(name, next); }
        refreshDispatchState(name);
    }

    /** Repaint the dispatch chip for `name`, then hand the header back to the
     *  input-state chip. Never renderPaneGrid() — a grid rebuild reparents live
     *  xterm DOM, which updatePaneElement's invariant forbids for a purely visual
     *  change.
     *
     *  The refreshInputState() tail is NOT optional. syncInputStateChip early-returns
     *  while .is-dispatching is set, so when a dispatch ends, removing the dispatch
     *  chip leaves the header with NO chip at all — the connecting / read-only /
     *  paste-queued states stay invisible until the next 5s poll or socket
     *  transition. refreshInputState re-derives and repaints them immediately. */
    function refreshDispatchState(name) {
        const paneIndex = paneAssignments.indexOf(name);
        if (paneIndex < 0) { return; }
        const paneEl = paneGridEl && paneGridEl.querySelector(`.terminal-pane[data-pane-index="${paneIndex}"]`);
        if (!paneEl) { return; }
        syncDispatchChip(paneEl, paneEl.querySelector('.pane-title'), dispatchInFlight.has(name));
        refreshInputState(name);
    }

    /* A dropped keystroke updates the header chip and NOTHING ELSE.
     *
     * There was a `[Not connected — keystroke discarded]` line written into
     * entry.term here. Do not add it back, or any variant of it. Writing a
     * notice into the terminal buffer makes it CONTENT, not chrome: it becomes
     * permanent scrollback, it cannot be dismissed, it corrupts a TUI's screen
     * buffer, and the running CLI already reports its own connection errors —
     * so it was a second notification stacked on top of one the operator
     * already had. Its "once per disconnect episode" guard did not hold either:
     * ws.onopen cleared the flag, so a flapping socket wrote a fresh line every
     * reconnect cycle.
     *
     * The header chip (refreshInputState) is the whole signal. It is chrome, it
     * self-corrects when the socket returns, and it leaves no residue. */
    function notifyInputDropped(entry) {
        refreshInputState(entry.name);
    }

    /**
     * Surface an unrecoverable scrollback gap on the PANE CHROME.
     *
     * Never written into the terminal buffer: a notice injected there lands inside a
     * screen the CLI believes it owns and shifts the row count its next relative redraw
     * depends on — the defect the chrome-writes plan exists to remove.
     */
    function markReplayGap(terminalName) {
        terminalReplayGaps.add(terminalName);
        renderSidebarList();
        renderPaneGrid();
        showPaneToast(`${terminalName}: scrollback gap — screen reset (output was evicted while disconnected)`);
    }

    /**
     * Move pane focus WITHOUT rebuilding the grid.
     *
     * A focus change is a two-class swap. renderPaneGrid() is a full teardown that
     * reparents every live xterm — running it for a highlight change is what ate
     * the first click. The sidebar still re-renders (it carries the .active row and
     * the P-chips), but that touches no terminal DOM, so the caret survives it.
     */
    function setFocusedPane(index) {
        if (index !== focusedPaneIndex) {
            focusedPaneIndex = index;
            const nameInPane = paneAssignments[index];
            if (nameInPane) { activeTerminalName = nameInPane; }
            paneGridEl.querySelectorAll('.terminal-pane').forEach(el => {
                el.classList.toggle('focused', Number(el.dataset.paneIndex) === index);
            });
            renderSidebarList();
        }
        focusPaneTerminal(index);
    }

    /**
     * Reconcile the pane grid IN PLACE.
     *
     * This used to open with `paneGridEl.innerHTML = ''` and rebuild every pane
     * from scratch, which detached and re-appended every live xterm on every
     * render — including renders that changed nothing but a badge. That churn is
     * not cosmetic: xterm's RenderService pauses on non-intersection and PARKS the
     * renderer resize plus the full repaint while paused (see xterm.js
     * _handleIntersectionChange / handleResize), and it only unpauses from an
     * IntersectionObserver batch whose last record says "intersecting". A fit that
     * lands on the wrong side of that delivery leaves the buffer at the new size
     * and the canvas at the old one — and FitAddon.fit() then short-circuits on
     * matching cols/rows forever after, so the pane can never recover. Reusing the
     * pane element means a terminal whose slot survives never moves, never
     * unpauses, and never enters that state.
     *
     * Also removes the teardown that the caret save/restore below exists to paper
     * over, and that setFocusedPane was written specifically to avoid.
     */
    function renderPaneGrid() {
        const slotCount = getSlotCount(effectiveLayout);
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;

        // Pad paneModes to getMaxSlotCount() — never trim. Mirrors paneAssignments'
        // documented no-trim design (see comment below at the assignments loop): a
        // kanban-mode slot's mode + chosen column survive a shrink-grow round trip.
        while (paneModes.length < getMaxSlotCount()) { paneModes.push('terminal'); }
        while (kanbanPaneColumn.length < getMaxSlotCount()) { kanbanPaneColumn.push(undefined); }
        while (kanbanPaneWorkspace.length < getMaxSlotCount()) { kanbanPaneWorkspace.push(undefined); }
        while (kanbanPaneProject.length < getMaxSlotCount()) { kanbanPaneProject.push(''); }

        // Sampled BEFORE any mutation. Both the surplus-pane removal below and the
        // per-pane update can drop the caret (removing or re-parenting the focused
        // element sends focus to <body>), so a flag computed after either one would
        // miss half the cases.
        const hadFocus = paneGridEl.contains(document.activeElement);

        // A floored layout can leave the focus on a pane that is no longer rendered.
        if (focusedPaneIndex >= slotCount) { focusedPaneIndex = 0; }

        // Drop surplus panes first, so index-addressed reuse below is straightforward.
        // A removed pane's terminal container goes with the subtree and is left
        // detached — exactly what innerHTML='' did — and stays referenced by
        // terminalsMap so a later reconcile can re-append it.
        while (paneGridEl.children.length > slotCount) {
            paneGridEl.removeChild(paneGridEl.lastElementChild);
        }
        while (paneGridEl.children.length < slotCount) {
            paneGridEl.appendChild(createPaneElement(paneGridEl.children.length));
        }

        for (let i = 0; i < slotCount; i++) {
            updatePaneElement(paneGridEl.children[i], i);
        }

        // Unchanged from the original, deliberately. `paneAssignments` is padded to
        // getMaxSlotCount() (nine) regardless of the active layout, so a terminal
        // parked in slot 5 while the layout is `1` is still ASSIGNED: no detach timer,
        // keeps its active class, survives a 3x3 -> 1 -> 3x3 round trip instantly.
        // Narrowing this to the rendered slot count would start destroying those.
        for (const [name, entry] of terminalsMap.entries()) {
            if (!paneAssignments.includes(name)) {
                entry.container.classList.remove('active');
                armDetachTimer(name);
            } else {
                cancelDetachTimer(name);
            }
        }

        // Reclaim the caret only when WE had it and WE lost it. The old code restored
        // whenever the grid held focus beforehand, which was right when the teardown
        // destroyed every pane and is wrong now that most reconciles destroy nothing:
        // it would snatch the caret back from wherever the operator just put it.
        if (hadFocus && !paneGridEl.contains(document.activeElement)) {
            focusPaneTerminal(focusedPaneIndex);
        }

        // Then sweep the caret ring if the caret is not actually in the grid.
        //
        // NOT redundant with term.onBlur. Chromium fires no blur when a focused
        // node is detached, and this function detaches focused nodes two ways: the
        // surplus-pane removal above, and updatePaneElement clearing a slot that
        // just went empty (contentEl.textContent = ''). Panes are REUSED rather
        // than rebuilt, so a class stranded that way outlives the render on a live
        // element — and the reclaim above cannot save it, because it early-returns
        // when the focused slot is the one that emptied. The result was an empty
        // pane wearing the teal "type here" outline, which is the precise lie this
        // ring exists to replace.
        //
        // Ordered after the reclaim on purpose: term.focus() dispatches focus
        // synchronously, so a successful reclaim has already put activeElement back
        // inside the grid and this is a no-op. Idempotent and O(panes).
        if (!paneGridEl.contains(document.activeElement)) {
            clearCaretRing();
        }

        // Start the kanban poll if any rendered slot is in kanban mode. The poll
        // is self-correcting: it stops itself when no kanban slots remain.
        if (paneModes.slice(0, slotCount).some(m => m === 'kanban')) {
            startKanbanPoll();
        } else {
            stopKanbanPoll();
        }

        // Any structural grid change (add, layout change, reassign, peek) can leave
        // previously-painted panes with stale glyphs. The next batchFitVisiblePanes
        // run from the structural call sites consumes these flags.
        //
        // Gated on an actual structural DELTA, not on "renderPaneGrid ran". This
        // function is also the badge/gap re-render and the 5 s fleet poll's repaint,
        // and that poll ends in applyLayoutFloor() -> batchFitVisiblePanes(), which
        // starts a ladder for every seated pane. Flagging unconditionally would make
        // every poll consume the flag and fire resyncPaneRenderer + a scrollbar
        // overflowY toggle on every visible pane, forever — nine full repaints every
        // five seconds on a 3x3, which is precisely the "once per transition"
        // property the boolean latch exists to guarantee.
        // JSON, not join() — a renamed terminal may contain the separator, and an
        // aliased key would silently skip a real transition.
        const structureKey = JSON.stringify([
            effectiveLayout,
            paneAssignments.slice(0, slotCount),
            paneModes.slice(0, slotCount),
            peekTerminalName || null
        ]);
        if (structureKey !== lastGridStructureKey) {
            lastGridStructureKey = structureKey;
            for (let i = 0; i < slotCount; i++) {
                const name = paneAssignments[i];
                if (!name) { continue; }
                const entry = terminalsMap.get(name);
                if (!entry || entry.disposed || !entry.term) { continue; }
                entry.needsRendererResync = true;
            }
        }

        applyPeekClasses();
    }

    function applyPeekClasses() {
        if (!paneGridEl) { return; }
        let isPeeking = Boolean(peekTerminalName);
        // Rule 2 — the invariant: if a peek is active but the peeked terminal is
        // not seated in any RENDERED pane, the grid would go fully blank (every
        // pane display:none, none .is-peeked). This happens via involuntary
        // writers — seatActiveGroupPage on a floor change (window resize),
        // sanitizePaneAssignments on a fleet poll — that reseat without knowing
        // about peek. Clear the state and drop the class in this same pass so
        // the grid returns to normal. Do NOT call afterPeekTransition() here:
        // applyPeekClasses is called from inside renderPaneGrid and
        // applyLayoutFloor, and re-entering the render would recurse. The
        // caller's own render finishes this frame; the stale `restore` label on
        // the sidebar row is corrected by the next poll. This also subsumes the
        // exit-only guard in the list-refresh path (peeked terminal exited).
        if (isPeeking) {
            const rendered = getSlotCount(effectiveLayout);
            let seated = false;
            for (let i = 0; i < rendered; i++) {
                if (paneAssignments[i] === peekTerminalName) { seated = true; break; }
            }
            if (!seated) {
                peekTerminalName = null;
                isPeeking = false;
            }
        }
        paneGridEl.classList.toggle('is-peeking', isPeeking);
        for (let i = 0; i < paneGridEl.children.length; i++) {
            const paneEl = paneGridEl.children[i];
            const isPeeked = isPeeking && paneAssignments[i] === peekTerminalName;
            paneEl.classList.toggle('is-peeked', isPeeked);
        }
    }

    /**
     * Re-render the surfaces that read peekTerminalName but are NOT rebuilt by
     * applyPeekClasses: the sidebar row marker/label and the pane header's
     * Restore / Pop out visibility (set in updatePaneElement). Then run the fit
     * ladder — on BOTH transitions, because the panes that were display:none
     * measured zero and only converge once they are visible again.
     */
    function afterPeekTransition() {
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    function dismissPeek() {
        if (!peekTerminalName) { return; }
        peekTerminalName = null;
        applyPeekClasses();
        afterPeekTransition();
    }

    function peekTerminal(name) {
        if (soloTerminalName || !name) { return; }
        // Clear the badge FIRST, before any path that can early-return: the peek
        // IS the acknowledgement, and every return below would otherwise leave the
        // DONE light burning forever (see the clearTerminalBadge note in shell.js).
        if (terminalBadges.has(name)) {
            terminalBadges.delete(name);
            terminalReplayGaps.delete(name);
            renderSidebarList();
            postFleetStateToShell();
        }
        if (paneAssignments.indexOf(name) === -1) {
            // ORDERING IS LOAD-BEARING with Rule 1 in place: handleLockedTerminalClick
            // and locateTerminal both call dismissPeek() now. peekTerminalName is still
            // null (or names the PREVIOUS peek) at this point, so the seat's dismissPeek
            // clears the old peek — not the one we are about to set. The assignment
            // `peekTerminalName = name` MUST stay below this block. Moving it above
            // would let the seat's own dismissPeek() cancel the new peek mid-flight,
            // leaving the terminal seated but not peeked.
            if (activeGroupId) {
                handleLockedTerminalClick(name);
            } else {
                locateTerminal(name);
            }
        }
        const index = paneAssignments.indexOf(name);
        if (index === -1) { return; }
        peekTerminalName = name;
        applyPeekClasses();
        afterPeekTransition();
        // Deliberately NOT focusPaneTerminal(index): a peek is a glance, and taking
        // the caret would both move focusedPaneIndex behind the user's back and put
        // the caret inside the peeked terminal — which is exactly the state in which
        // the Esc exit stands down. The user clicks into the pane if they want it.
    }

    function wireTerminalDropTarget(paneEl, paneIndex) {
        /**
         * Stamp active-agent tracking for plans delivered to a PTY by drag-drop.
         *
         * The paste-attribution path in term.onData cannot see this delivery: both drop
         * branches write to the PTY from outside xterm (server-side ptySendPrompt, or a
         * raw ws.send), and term.onData fires only for locally typed/pasted input. So the
         * drop has to attribute itself. Same verb, same writer (attributePasteDispatch),
         * same deliberately-narrow column set — dispatched_agent / dispatched_terminal /
         * dispatched_at, never routed_to or dispatched_ide.
         *
         * planIds is an ARRAY on purpose: a multi-select drag dispatches N plans in one
         * prompt, and attributePastedPrompt already attributes each id independently.
         * A single-id signature here would light exactly one of N activity pips.
         *
         * workspaceRoot only steers the EXTENSION host (it orders rootsToSearch); the
         * standalone bootstrap overrides it with the server's own root.
         */
        function attributeDropDispatch(terminalName, planIds, workspaceRoot) {
            const ids = (Array.isArray(planIds) ? planIds : [planIds]).filter(Boolean).map(String);
            if (ids.length === 0) { return; }
            const role = fleetList.find(t => t.friendlyName === terminalName)?.role || '';
            fetch('/kanban/verb/attributePastedPrompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    terminalName,
                    role,
                    planIds: ids,
                    planFiles: [],
                    workspaceRoot
                })
            }).then(() => {
                // Chained, not fired beside the POST: the strip is read straight off
                // the fleet list, and the list only carries a title once the
                // attribution row exists. A parallel refetch would race the write and
                // leave the pane blank until the next 5s poll. The drop path pulls no
                // other terminal list, so this is the only refetch in flight here.
                fetchTerminalList();
            }).catch(err => {
                console.warn('[Terminals] drop attribution failed:', err);
            });
        }

        paneEl.addEventListener('dragover', (e) => {
            if (!Array.from(e.dataTransfer.types || []).includes('application/json')) return;
            if (paneModes[paneIndex] === 'kanban' || !paneAssignments[paneIndex]) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            paneEl.classList.add('drag-drop-target');
        });

        paneEl.addEventListener('dragleave', (e) => {
            if (e.relatedTarget && paneEl.contains(e.relatedTarget)) return;
            paneEl.classList.remove('drag-drop-target');
        });

        paneEl.addEventListener('drop', async (e) => {
            e.preventDefault();
            paneEl.classList.remove('drag-drop-target');

            const raw = e.dataTransfer.getData('application/json');
            if (!raw) return;
            let dragData;
            try { dragData = JSON.parse(raw); } catch { return; }
            // kanban.html puts a BARE ARRAY of ids on application/json for its own
            // card drags. That payload carries no column, so promptSelected could never
            // be built from it — reject cleanly rather than POST sessionIds:[undefined].
            if (!dragData || Array.isArray(dragData) || typeof dragData !== 'object') { return; }

            const { planId, sessionId, planIds, column, workspaceRoot, sourcePaneIndex } = dragData;
            // Accept both shapes: the multi payload (planIds) and the legacy single one.
            const ids = (Array.isArray(planIds) && planIds.length > 0)
                ? planIds.filter(Boolean).map(String)
                : [planId || sessionId].filter(Boolean).map(String);
            if (ids.length === 0) { return; }

            const targetName = paneAssignments[paneIndex];
            if (!targetName || paneModes[paneIndex] === 'kanban') {
                showPaneToast('Target pane has no terminal');
                return;
            }
            const entry = terminalsMap.get(targetName);
            if (!entry) {
                showPaneToast('Terminal not found');
                return;
            }
            // For Shift-drop (raw WebSocket paste), the WebSocket must be open.
            // For normal drop (ptySendPrompt verb), the server checks terminal status.
            if (e.shiftKey && (!entry.ws || entry.ws.readyState !== WebSocket.OPEN)) {
                showPaneToast('Terminal not connected');
                return;
            }

            try {
                const res = await fetch('/kanban/verb/promptSelected', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        column,
                        sessionIds: ids,
                        workspaceRoot
                    })
                });
                const data = await res.json();
                if (!data.success) {
                    showPaneToast('Failed to fetch prompt: ' + (data.error || 'unknown'));
                    return;
                }

                const promptText = data.prompt || '';
                if (!promptText) {
                    showPaneToast('Prompt was empty');
                    return;
                }

                if (e.shiftKey) {
                    // Shift-drop: paste the prompt without submitting (bracketed-paste
                    // framing prevents line-by-line execution). The operator can review
                    // and press Enter manually. This path bypasses both hosts, so the
                    // standing-orders block must be applied client-side.
                    const withOrders = applyStandingOrdersClient(promptText, targetName, standingOrders, liveNameSet());
                    entry.ws.send(encodeInputFrame('\x1b[200~' + withOrders + '\x1b[201~'));
                    // Attributed here too, and it must not be dropped as "the operator
                    // has not sent it yet". The paste detector cannot pick this delivery
                    // up: this branch writes over the raw input WebSocket, and
                    // term.onData only fires for input typed or pasted INTO xterm — so
                    // an unattributed shift-drop stays permanently dark (no activity
                    // light, no plan strip, no liveness — recordLiveness only touches
                    // rows with a dispatched_terminal, KanbanDatabase.ts:9995).
                    // ws.send() returns void, so the readyState guard above is the only
                    // success signal available; do not invent an ack protocol for it.
                    // Attribution is therefore early by the seconds the operator spends
                    // reviewing, and it self-corrects the moment output starts
                    // (recordLiveness nulls blocked_at). An abandoned shift-drop reads
                    // as "Waiting on you", which is what it is.
                    attributeDropDispatch(targetName, ids, workspaceRoot);
                } else {
                    // Normal drop: use the server-side ptySendPrompt verb, which handles
                    // /clear before prompt, bracketed-paste framing, chunked writes, and
                    // the confirm Enter key for CLI agents — the same pipeline the kanban
                    // board's drag-drop uses via triggerAction → sendPromptToPty.
                    //
                    // The prompt returned by promptSelected is already composed by
                    // agentPromptBuilder. The delivery layer cannot be told that over HTTP
                    // (addonsComposed is stripped at the boundary as a safeguard), so the seat
                    // directive block dedupes itself against the prompt instead — see
                    // buildSeatDirectiveBlock's existingPrompt argument.
                    //
                    // clearBeforePromptFromConfig: true asks the host to resolve the
                    // switchboard.terminal.clearBeforePrompt config default for this
                    // delivery. The webview cannot read that setting (loadSetting only
                    // reads terminals.* DB keys), and a fresh task dropped on a terminal
                    // genuinely wants a clean context — so the drop path opts in rather
                    // than leaving the field absent (which now defaults to false). An
                    // operator who set the config to false gets false; the destructive
                    // direction is never taken implicitly.
                    const opId = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                    armDispatchCurtain(targetName, opId, { phase: 'clearing' });
                    beginDispatchIndicator(targetName);
                    let promptResult;
                    try {
                        const promptRes = await fetch('/terminals/verb/ptySendPrompt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: targetName,
                                data: promptText,
                                clearBeforePromptFromConfig: true,
                                operationId: opId
                            })
                        });
                        promptResult = await promptRes.json();
                    } finally {
                        // finally, not the success path: a rejected fetch must not
                        // strand the chip, and the failure toast below must never
                        // appear beside a live "dispatching…".
                        endDispatchIndicator(targetName);
                        disarmDispatchCurtain(targetName, opId, promptResult && promptResult.success ? 'signal' : 'error');
                    }
                    if (!promptResult || !promptResult.success) {
                        showPaneToast('Failed to send prompt: ' + ((promptResult && promptResult.error) || 'unknown'));
                        return;
                    }
                    attributeDropDispatch(targetName, ids, workspaceRoot);
                }

                if (sourcePaneIndex !== undefined) {
                    clearPaneSelection(sourcePaneIndex);
                    if (sourcePaneIndex !== paneIndex) { fetchBoardCardsForPane(sourcePaneIndex); }
                }
            } catch (err) {
                showPaneToast('Drag-to-terminal failed: ' + (err.message || String(err)));
            }
        });
    }

    /**
     * Build a pane shell once. Listeners are attached here and here only, and each
     * one re-reads mutable state (paneAssignments, effectiveLayout) at call time —
     * the old code could close over per-render values because the element was
     * thrown away every render; a reused element cannot.
     */
    function createPaneElement(index) {
        const paneEl = document.createElement('div');
        paneEl.className = 'terminal-pane';
        paneEl.dataset.paneIndex = index;

        // mousedown, not click: it lands before xterm's own selection handling and
        // before mouseup, so one press both selects the pane and leaves the caret
        // in it.
        paneEl.addEventListener('mousedown', () => setFocusedPane(index));

        const headerEl = document.createElement('div');
        headerEl.className = 'pane-header';

        const titleEl = document.createElement('div');
        titleEl.className = 'pane-title';

        const actionsEl = document.createElement('div');
        actionsEl.className = 'pane-actions';

        // Pin toggle, prepended so it sits left of clear/hide. Suppressed in a
        // single-slot grid (which covers solo mode, since init() forces
        // effectiveLayout = '1' there): a pin in a one-pane grid can only
        // deadlock the sidebar. The button is created once and reused; its label,
        // state class and visibility are re-derived in updatePaneElement.
        const pinBtn = document.createElement('button');
        pinBtn.className = 'btn-unassign-pane btn-pin-pane';
        pinBtn.title = 'Pin — keep this agent in this pane; other agents go elsewhere';
        pinBtn.setAttribute('aria-pressed', 'false');
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            pinnedPanes[index] = !pinnedPanes[index];
            saveLayoutSettings();
            renderPaneGrid();
            renderSidebarList();
        });

        const paneClearBtn = document.createElement('button');
        paneClearBtn.className = 'btn-unassign-pane';
        paneClearBtn.title = 'Send /clear to this terminal';
        // Re-reads the slot. The original closed over `assignedName` from the render
        // that built the button, which was safe only because the button died with
        // that render — on a reused element it would clear whichever terminal
        // happened to be in this pane when it was first created.
        paneClearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            withClearingFeedback(paneClearBtn, () => clearTerminal(targetName), 'clear');
        });

        const paneModelBtn = document.createElement('button');
        paneModelBtn.className = 'btn-unassign-pane';
        paneModelBtn.title = 'Send /model to this terminal';
        // Re-reads the slot, same rationale as paneClearBtn: the button is reused
        // across renders and must target whatever terminal is in this pane NOW.
        paneModelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            withClearingFeedback(paneModelBtn, () => sendModelCommand(targetName), 'model');
        });

        const unassignBtn = document.createElement('button');
        unassignBtn.className = 'btn-unassign-pane';
        unassignBtn.title = 'Remove from this pane (terminal keeps running)';
        unassignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            undoSnapshot = { slots: paneAssignments.slice(), pins: pinnedPanes.slice(), name: null, displaced: targetName, paneIndex: index };
            showPaneToast(`Pane ${index + 1} cleared (${targetName} still running)`, undoLastAssignment);
            paneAssignments[index] = null;
            pinnedPanes[index] = false; // an empty pinned seat reserves a slot nothing can fill
            dismissStartupCurtain(targetName);
            // Removing a member: while a group is locked, unassigning a pane
            // also removes that terminal from the group's membership. For
            // derived groups, this means removing from groupPrefs.extras (a
            // derived member — one the group computes — cannot be removed this
            // way; unassigning it vacates the pane and the terminal remains a
            // member). For manual groups, removes from the group's members
            // array. Suppressing a derived member is a different feature and
            // is not in scope.
            if (activeGroupId) {
                const group = getAllGroups().find(g => g.id === activeGroupId);
                if (group && !isSpawnedTeamGroup(group)) {
                    if (group.source !== 'manual' && groupPrefs.extras && Array.isArray(groupPrefs.extras[activeGroupId])) {
                        groupPrefs.extras[activeGroupId] = groupPrefs.extras[activeGroupId].filter(n => n !== targetName);
                    } else if (group.source === 'manual' && Array.isArray(group.members)) {
                        group.members = group.members.filter(n => n !== targetName);
                        if (Array.isArray(group.order)) {
                            group.order = group.order.filter(n => n !== targetName);
                        }
                    }
                }
            }
            saveLayoutSettings();
            renderPaneGrid();
            renderSidebarList();
        });

        // Pane-mode toggle back to terminal. Its OWN button, not a repurposed one.
        // renderKanbanPane used to overwrite children[0] — the pin button — setting
        // its className and .onclick; updatePaneElement re-derives label/title/display
        // but never className or onclick, so the pin permanently lost .btn-pin-pane
        // and kept firing the mode handler alongside its own listener. Panes are
        // reused rather than rebuilt, so that damage outlived every later render.
        const modeBtn = document.createElement('button');
        modeBtn.className = 'btn-unassign-pane';
        modeBtn.textContent = 'Terminal';
        modeBtn.title = 'Switch this pane to terminal mode';
        modeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            paneModes[index] = 'terminal';
            saveLayoutSettings();
            renderPaneGrid();
        });

        // Log button — opens the terminal session log as a readable markdown
        // document in a full-screen overlay. Re-reads the pane's current
        // assignment (same pattern as paneClearBtn) so a reused element targets
        // whatever terminal is in this pane NOW, not the one it was built for.
        const paneLogBtn = document.createElement('button');
        paneLogBtn.className = 'btn-unassign-pane btn-log-pane';
        paneLogBtn.title = 'Open this terminal\'s session log';
        paneLogBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            openLogView(targetName);
        });

        const peekDismissBtn = document.createElement('button');
        peekDismissBtn.className = 'btn-unassign-pane btn-peek-dismiss';
        peekDismissBtn.textContent = 'Restore';
        peekDismissBtn.title = 'Dismiss the peek and restore the grid';
        peekDismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismissPeek();
        });

        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'btn-unassign-pane btn-popout-pane';
        popoutBtn.textContent = 'Pop out';
        popoutBtn.title = 'Open this terminal in its own window';
        popoutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetName = paneAssignments[index];
            if (!targetName) { return; }
            if (peekTerminalName) { dismissPeek(); }
            window.parent.postMessage({ type: 'popoutTerminal', name: targetName }, location.origin);
        });

        actionsEl.appendChild(pinBtn);
        actionsEl.appendChild(peekDismissBtn);
        actionsEl.appendChild(popoutBtn);
        actionsEl.appendChild(paneClearBtn);
        actionsEl.appendChild(paneModelBtn);
        actionsEl.appendChild(unassignBtn);
        actionsEl.appendChild(modeBtn);
        actionsEl.appendChild(paneLogBtn);
        headerEl.appendChild(titleEl);
        headerEl.appendChild(actionsEl);
        paneEl.appendChild(headerEl);

        const planEl = document.createElement('div');
        planEl.className = 'pane-plan-title';
        planEl.style.display = 'none';
        paneEl.appendChild(planEl);

        const contentEl = document.createElement('div');
        contentEl.className = 'pane-content';
        // Delegated, because the kanban-mode toggle lives inside the empty-slot
        // placeholder that updatePaneElement rebuilds on every reconcile — attaching
        // there would put listener creation on a per-render path. Reads paneModes at
        // call time, like every other handler on this element.
        contentEl.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || !target.classList) { return; }
            if (target.classList.contains('startup-curtain-dismiss') || target.classList.contains('terminal-curtain-dismiss')) {
                e.stopPropagation();
                // The node's OWN stamp, not paneAssignments[index]: the two can
                // disagree for one reconcile after a displacing click, and dismissing
                // by slot there would clear an unrelated terminal's state while
                // leaving the overlay the operator just clicked on screen. The
                // explicit remove() makes the escape hatch work even when the state
                // entry is already gone — this is the one path that must never no-op.
                const curtainEl = target.closest('.startup-curtain, .terminal-curtain');
                const termName = (curtainEl && curtainEl.dataset.terminal) || paneAssignments[index];
                dismissStartupCurtain(termName);
                if (dispatchCurtains.has(termName)) {
                    const opMap = dispatchCurtains.get(termName);
                    if (opMap) {
                        for (const op of opMap.values()) {
                            op.dismissed = true;
                        }
                    }
                }
                if (curtainEl) { curtainEl.remove(); }
                return;
            }
            // Empty-pane affordance under a lock: clicking the empty-slot
            // placeholder (not the kanban toggle button inside it) opens the
            // role picker scoped to the active group. Reuses the strip's
            // `group:<id>` picker key so renderGroupTabStrip reports it and
            // it survives the 5-second fleet-poll garbage-collect. The picker
            // appears in the strip, not in the pane header — but the empty
            // pane's text invites the click and the picker is functional.
            // No parallel picker mechanism is built.
            // Excludes kanban-mode panes: .kanban-pane-empty carries
            // .pane-empty-slot too, and firing a spawn picker on a working
            // board control would hijack the kanban empty state. The seating
            // logic (isFreeSlot) already excludes kanban panes; this gate
            // matches it.
            if (target.classList.contains('pane-empty-slot')
                    && !target.classList.contains('kanban-pane-empty')
                    && activeGroupId
                    && paneModes[index] !== 'kanban') {
                e.stopPropagation();
                onNewTerminalClicked(undefined, 'group:' + activeGroupId);
                return;
            }
            if (!target.classList.contains('pane-mode-toggle')) { return; }
            e.stopPropagation();
            paneModes[index] = 'kanban';
            clearPaneSelection(index);
            if (!kanbanPaneColumn[index]) { kanbanPaneColumn[index] = 'CREATED'; }
            if (!kanbanPaneWorkspace[index]) { kanbanPaneWorkspace[index] = defaultKanbanWorkspace(); }
            saveLayoutSettings();
            renderPaneGrid();
            fetchBoardCardsForPane(index);
        });
        paneEl.appendChild(contentEl);
        wireTerminalDropTarget(paneEl, index);
        return paneEl;
    }

    /** Dense 6-/9-pane headers: the input-state chip (inside the ellipsizing
     *  title) collapses to a dot there. Button labels are NOT condensed — the
     *  title ellipsizes first by flex design. */
    function isTerseLayout() {
        return effectiveLayout === '2x3' || effectiveLayout === '3x3';
    }

    /**
     * Patch a pane in place. The load-bearing rule: touch `entry.container`'s
     * parent ONLY when the assignment for this slot actually changed. A badge
     * update, an (exited) suffix or a layout-driven label change must move no
     * terminal DOM at all.
     */
    function updatePaneElement(paneEl, index) {
        paneEl.dataset.paneIndex = index;
        paneEl.classList.toggle('focused', index === focusedPaneIndex);
        paneEl.classList.toggle('pinned', Boolean(pinnedPanes[index]));

        // The input-state class is the ONE source of truth the ring and the chip
        // both style off, so they can never disagree. Cleared for empty panes —
        // an empty pane is not a read-only terminal, and a red chip there would
        // be a false alarm.
        paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly', 'is-input-queued');

        const titleEl = paneEl.querySelector('.pane-title');
        const actionsEl = paneEl.querySelector('.pane-actions');
        const contentEl = paneEl.querySelector('.pane-content');
        const assignedName = paneAssignments[index];
        const slotCount = getSlotCount(effectiveLayout);

        // Solo mode pins one terminal and never offers grid choices, so kanban mode
        // is SUPPRESSED there — never written back. paneModes is persisted to a
        // shared setting, so a solo pop-out forcing paneModes[0] = 'terminal' would
        // clobber the cockpit window's kanban choice on its next saveLayoutSettings.
        const isSolo = document.body.classList.contains('is-solo');

        // Kanban-mode pane: render a live kanban column viewer in this slot
        // instead of a terminal viewport. Only on empty slots — a kanban pane
        // must NOT displace an assigned terminal (paneAssignments is untouched).
        if (paneModes[index] === 'kanban' && !assignedName && !isSolo) {
            renderKanbanPane(paneEl, index);
            return;
        }

        // A terminal reached a slot still marked kanban. The seating paths skip
        // kanban slots, so this is the deliberate all-panes-taken displacement (or a
        // persisted mode meeting a restored assignment). Drop the mode so unassigning
        // does not silently teleport the slot back to kanban, and drop the plan list:
        // the assigned branch below removes only .pane-empty-slot, so the list would
        // otherwise sit in the pane alongside the terminal viewport.
        if (paneModes[index] === 'kanban' && assignedName) {
            paneModes[index] = 'terminal';
        }
        // Both kanban bodies: the plan list (inside its .kanban-pane-body wrapper —
        // remove the wrapper, or the hint strip strands in a terminal-mode pane) AND
        // the "No plans in …" empty state. The empty state also carries
        // .pane-empty-slot, which the placeholder branch below treats as "already
        // correct" — leaving it would strand the pane on a board message with no
        // kanban-mode toggle to get back.
        const staleKanban = contentEl.querySelectorAll('.kanban-pane-body, .kanban-pane-list, .kanban-pane-empty');
        staleKanban.forEach(el => el.remove());
        // renderKanbanPane's skip-if-unchanged guard is keyed on this; a stale value
        // surviving a mode round trip would make it skip rendering into empty content.
        delete contentEl.dataset.kanbanSig;

        titleEl.textContent = '';
        if (assignedName) {
            const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
            const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);

            // Brand mark first — the same identifier the sidebar rows
            // (renderTerminalRow), the shell rail (postFleetStateToShell) and the
            // startup curtain (renderStartupCurtain) already show, resolved through
            // the same two helpers so all four surfaces cannot disagree.
            // `|| 'default'` on BOTH calls mirrors renderStartupCurtain: an
            // unrecognised label still gets a mark, and a host that never stamped
            // the dataset attributes gets no <img> at all rather than a broken one.
            const brandKey = brandIconForCliLabel(agentLabel) || 'default';
            const brandUri = brandIconUri(brandKey) || brandIconUri('default');
            if (brandUri) {
                const brandImg = document.createElement('img');
                brandImg.className = 'pane-brand-icon';
                brandImg.src = brandUri;
                // alt='' + aria-hidden: the pane's aria-label below already carries
                // the agent label and handle. A brand name here double-announces.
                brandImg.alt = '';
                brandImg.setAttribute('aria-hidden', 'true');
                brandImg.dataset.brand = brandKey;
                // Dimmed, not dropped — same treatment the sidebar gives an exited
                // row. Stamped here rather than via a `.terminal-pane.is-exited`
                // rule: the pane element never carries that class (it is a
                // .terminal-item class, set in renderTerminalRow).
                if (fleetItem && fleetItem.status === 'exited') {
                    brandImg.classList.add('is-exited');
                }
                // NO data-terminal stamp — see the CSS comment.
                titleEl.appendChild(brandImg);
            }

            if (isTeamHead(assignedName)) {
                const crown = document.createElement('span');
                crown.className = 'pane-crown-icon';
                crown.setAttribute('aria-hidden', 'true');
                crown.title = 'Team lead';
                crown.innerHTML = CROWN_SVG;
                if (fleetItem && fleetItem.status === 'exited') {
                    crown.classList.add('is-exited');
                }
                titleEl.appendChild(crown);
            }

            const idxEl = document.createElement('span');
            const isPinned = Boolean(pinnedPanes[index]);
            idxEl.className = 'pane-index-chip' + (isPinned ? ' is-pinned' : '');
            idxEl.textContent = isPinned ? `📌P${index + 1}` : `P${index + 1}`;
            titleEl.appendChild(idxEl);

            // Terse layouts (2x3/3x3) get the HANDLE alone, not the agent label: every
            // seat in a team runs the same CLI, so the label is identical across the
            // grid while the handle is what tells them apart — and the brand icon
            // already carries the CLI identity. Status suffixes attach to the HANDLE:
            // "planner-2 (exited)" is meaningful, "CLAUDE CLI (exited)" is not.
            let handle = assignedName;
            if (fleetItem && fleetItem.status === 'exited') {
                handle += ' (exited)';
            } else if (!fleetItem && hasFetchedList) {
                handle += ' (no longer listed)';
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'pane-title-name';
            if (!agentLabel) {
                nameSpan.textContent = handle;
            } else if (isTerseLayout()) {
                // Brand icon already carries the CLI identity; the handle (seat name)
                // is the unique identifier that tells siblings apart in a dense grid.
                nameSpan.textContent = handle;
            } else {
                nameSpan.textContent = `${agentLabel} · ${handle}`;
            }
            titleEl.appendChild(nameSpan);
            // Full identity stays reachable even when the terse header shows only the handle.
            titleEl.title = `${agentLabel ? agentLabel + ' — ' : ''}${handle}`;
            paneEl.setAttribute('aria-label', `Pane ${index + 1}: ${titleEl.title}`);

            // No DONE badge here. One completion used to paint four surfaces at once —
            // the shell rail pulse, the sidebar row chip, THIS chip, and a toast — three
            // of them inside the same panel in the same glance. This one was the least
            // useful of the four: it sits on the chrome of a terminal the operator is
            // already watching, duplicates the sidebar row a few inches away, and
            // competes for a header row where .pane-title-name is the only shrinkable
            // child. terminalBadges is unchanged and still drives the sidebar chip and
            // the rail; do not re-add a reader here.
            if (terminalReplayGaps.has(assignedName)) {
                const gapBadge = document.createElement('span');
                gapBadge.className = 'pane-badge is-gap';
                gapBadge.textContent = 'GAP';
                gapBadge.title = 'Output was evicted while this pane was disconnected — the screen was reset rather than spliced';
                titleEl.appendChild(gapBadge);
            }

            // Input-state chip. The class goes on the PANE, not the chip: it is
            // the one source of truth the ring and the chip both style off, so
            // they cannot drift apart. Derived live at render time; socket
            // transitions nudge it out-of-band via refreshInputState.
            const state = resolveInputState(assignedName);
            paneEl.classList.add(`is-input-${state.key}`);
            // Dispatch chip FIRST: syncInputStateChip early-returns while
            // .is-dispatching is set, and panes are reused, so a stale class from a
            // finished dispatch (or from the pane's previous occupant) would
            // suppress the input chip for a whole poll cycle if the order were
            // reversed. DOM order does not matter — the two are mutually exclusive.
            syncDispatchChip(paneEl, titleEl, dispatchInFlight.has(assignedName));
            syncInputStateChip(paneEl, titleEl, state);

            // Guarded like the empty-slot and kanban-mode branches: this runs inside
            // the grid reconcile, so a null here would throw out of renderPaneGrid and
            // strand every pane, not just this one.
            const planEl = paneEl.querySelector('.pane-plan-title');
            const planTitle = ((fleetItem && fleetItem.planTitle) || '').trim();
            if (planEl && planTitle) {
                planEl.textContent = planTitle;
                planEl.title = planTitle;
                planEl.style.display = '';
            } else if (planEl) {
                planEl.textContent = '';
                planEl.removeAttribute('title');
                planEl.style.display = 'none';
            }
        } else {
            titleEl.textContent = `Pane ${index + 1} (Empty)`;
            // Setting textContent wipes the chip ELEMENT, but the class lives on the pane
            // and only syncDispatchChip clears it. Panes are reused, so a pane unassigned
            // mid-dispatch would carry .is-dispatching until something reassigned it —
            // inert today (no CSS keys off it) and self-healing on the next assignment,
            // but it is a class asserting a dispatch that is no longer this pane's.
            paneEl.classList.remove('is-dispatching');
            const planEl = paneEl.querySelector('.pane-plan-title');
            if (planEl) {
                planEl.textContent = '';
                planEl.removeAttribute('title');
                planEl.style.display = 'none';
            }
        }

        // Labels are re-derived every reconcile so a layout change can never leave
        // a stale word on a reused button. Indexed, not destructured: the buttons
        // share a class name, so there is no selector that tells them apart, and
        // children[] is the honest read.
        // children[0] = pin, [1] = peek dismiss, [2] = pop out, [3] = clear,
        // [4] = model, [5] = hide, [6] = mode, [7] = log (order set in createPaneElement).
        const pinBtn = actionsEl.children[0];
        const peekDismissBtn = actionsEl.children[1];
        const popoutBtn = actionsEl.children[2];
        const clearBtn = actionsEl.children[3];
        const modelBtn = actionsEl.children[4];
        const hideBtn = actionsEl.children[5];
        const modeBtn = actionsEl.children[6];
        const logBtn = actionsEl.children[7];
        clearBtn.textContent = 'clear';
        modelBtn.textContent = 'model';
        hideBtn.textContent = 'hide';
        logBtn.textContent = 'log';

        // Restored explicitly, not left to the container's display. renderKanbanPane
        // hides these three INDIVIDUALLY, and panes are reused rather than rebuilt —
        // without this, any pane that ever showed kanban mode loses clear and hide
        // for the life of the page.
        clearBtn.style.display = '';
        modelBtn.style.display = '';
        hideBtn.style.display = '';
        modeBtn.style.display = 'none';
        peekDismissBtn.style.display = '';
        popoutBtn.style.display = '';
        // Log button: visible only on an assigned terminal pane (same gate as
        // the actionsEl container below). renderKanbanPane hides every child but
        // modeBtn by LOOPING over actionsEl.children, so this restore is what
        // brings the button back on a pane that has been in kanban mode.
        logBtn.style.display = assignedName ? '' : 'none';

        // Pin toggle: text labels (not emoji) to match clear/hide treatment; state
        // carried by colour via .btn-pin-pane.is-pinned and by aria-pressed.
        // Suppressed in a single-slot grid — a pin there can only deadlock, and
        // solo mode forces effectiveLayout = '1' so this covers pop-outs too.
        const pinActive = slotCount > 1;
        const isPinned = Boolean(pinnedPanes[index]);
        pinBtn.textContent = isPinned ? 'unpin' : 'pin';
        pinBtn.title = isPinned
            ? 'Unpin — this pane can be reassigned again'
            : 'Pin — keep this agent in this pane; other agents go elsewhere';
        pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        pinBtn.classList.toggle('is-pinned', isPinned);
        pinBtn.style.display = (pinActive && assignedName) ? '' : 'none';

        // The buttons now always EXIST (they are reused); an empty pane hides the
        // block rather than omitting it.
        actionsEl.style.display = assignedName ? '' : 'none';

        // Peek dismiss only on the currently peeked pane; pop-out only on a real,
        // non-solo, terminal-mode pane, and not when the pane is being peeked.
        const isSoloPanel = document.body.classList.contains('is-solo');
        if (assignedName) {
            peekDismissBtn.style.display = (peekTerminalName === assignedName && !isSoloPanel) ? '' : 'none';
            popoutBtn.style.display = (peekTerminalName !== assignedName && !isSoloPanel && paneModes[index] === 'terminal') ? '' : 'none';
        } else {
            peekDismissBtn.style.display = 'none';
            popoutBtn.style.display = 'none';
        }

        if (assignedName) {
            const placeholder = contentEl.querySelector('.pane-empty-slot');
            if (placeholder) { contentEl.removeChild(placeholder); }
            const entry = terminalsMap.get(assignedName);
            if (!entry) {
                createTerminalView(assignedName, contentEl);
            } else {
                // THE invariant of this change: no move when already in place.
                if (entry.container.parentNode !== contentEl) {
                    contentEl.appendChild(entry.container);
                    refreshTerminalScrollbar(entry);   // same-size re-parent
                                                      // leaves the scroll area stale
                    entry.needsRendererResync = true;
                    startFitLadder(entry.name);
                }
                entry.container.classList.add('active');
            }

            // A curtain left behind by a PREVIOUS occupant of this slot. Panes are
            // reused, and this branch only removes .pane-empty-slot — so any path that
            // swaps the assignment without emptying the pane first (a displacing
            // sidebar click, a group apply, an undo restore) would otherwise leave an
            // opaque overlay for a terminal that is no longer here sitting on top of
            // the one that is. Keyed on the stamp, so the current terminal's own
            // curtain survives every reconcile.
            contentEl.querySelectorAll('.startup-curtain').forEach(el => {
                if (el.dataset.terminal !== assignedName) { el.remove(); }
            });

            // Curtain LAST, so it is the final child of .pane-content regardless of which
            // branch above ran. Paint order does not actually depend on that (z-index: 4 beats
            // .terminal-view-host's z-index: auto), but keeping it last means a re-parent
            // cannot visually reorder anything either.
            if (startupCurtains.has(assignedName)) {
                renderStartupCurtain(contentEl, assignedName);
            }
            if (dispatchCurtains.has(assignedName)) {
                renderDispatchCurtain(contentEl, assignedName);
            }
        } else if (!contentEl.querySelector('.pane-empty-slot')) {
            // Clears a container still parented here from a previous assignment. The
            // node survives in terminalsMap; only its parentage is dropped.
            contentEl.textContent = '';
            const emptySlot = document.createElement('div');
            emptySlot.className = 'pane-empty-slot';
            // Under a lock, the empty pane is fillable: clicking a sidebar
            // terminal seats it here and makes it a group member. The text
            // invites that click. Without a lock, the text is the standard
            // free-composition instruction.
            if (activeGroupId) {
                emptySlot.textContent = 'Click a terminal to add it to this group';
            } else {
                emptySlot.textContent = 'Click terminal in sidebar to assign';
            }
            // Kanban-mode toggle: repurpose this dead slot as a live kanban column
            // viewer. Suppressed in solo mode (one pinned terminal, no grid) and in
            // a single-slot grid (no surplus slot to repurpose).
            if (slotCount > 1 && !isSolo) {
                // No listener here — createPaneElement delegates clicks on
                // .pane-mode-toggle from contentEl. This function runs on every
                // reconcile, and attaching listeners in it is what the pane-grid
                // reconcile contract forbids.
                const kanbanToggle = document.createElement('button');
                kanbanToggle.className = 'pane-mode-toggle';
                kanbanToggle.textContent = 'kanban mode';
                kanbanToggle.title = 'Show a kanban column here instead';
                emptySlot.appendChild(kanbanToggle);
            }
            contentEl.appendChild(emptySlot);
        } else {
            // Re-derive the placeholder text on every reconcile for an existing
            // non-kanban empty slot. Panes persist across a group switch, so a
            // slot that was empty before the lock keeps stale text unless it is
            // re-derived here — the same rule the header buttons follow at
            // :4409. Kanban empty slots (.kanban-pane-empty) carry their own
            // text and are left alone.
            const existing = contentEl.querySelector('.pane-empty-slot:not(.kanban-pane-empty)');
            if (existing) {
                const label = activeGroupId
                    ? 'Click a terminal to add it to this group'
                    : 'Click terminal in sidebar to assign';
                // Update the leading TEXT NODE, never `existing.textContent`.
                // Assigning textContent replaces EVERY child — including the
                // `kanban mode` toggle button the creation branch appends — so
                // the first reconcile after a pane emptied would permanently
                // delete the only entry point to kanban pane mode, for the life
                // of the page (panes are reused, not rebuilt).
                const firstText = Array.from(existing.childNodes).find(n => n.nodeType === 3);
                if (firstText) {
                    firstText.nodeValue = label;
                } else {
                    existing.insertBefore(document.createTextNode(label), existing.firstChild);
                }
            }
        }
    }

    /**
     * Resolve the layout the window can actually render. Below the floor xterm shows a
     * handful of unreadable columns, so we step DOWN to the next-simpler layout rather
     * than subdivide further.
     */
    function resolveFlooredLayout() {
        const rect = paneGridEl.getBoundingClientRect();
        // Zero box = panel hidden or not laid out yet. Assume the user's pick; the next
        // real resize re-evaluates.
        if (rect.width <= 0 || rect.height <= 0) { return currentLayout; }

        const start = LAYOUT_FLOOR_ORDER.indexOf(currentLayout);
        if (start === -1) { return '1'; }

        for (let i = start; i < LAYOUT_FLOOR_ORDER.length; i++) {
            const mode = LAYOUT_FLOOR_ORDER[i];
            const spec = LAYOUTS[mode];
            if (rect.width >= spec.minW && rect.height >= spec.minH) { return mode; }
        }
        return '1';
    }

    /** Merge getKanbanStructure's `structure` (built-in + custom, ordered) into a
     *  flat {id,label,role,kind} list for the column picker and the sidebar ordering
     *  key. `customColumns` is the user-editable subset already folded into
     *  `structure`, so it is not re-merged here — re-merging would duplicate custom rows. */
    function buildColumnList(structure, customColumns) {
        const list = [];
        if (Array.isArray(structure)) {
            for (const item of structure) {
                if (item && item.id) {
                    list.push({
                        id: item.id,
                        label: item.label || item.id,
                        role: item.role || null,
                        // kind is what identifies a coder column ('coded'). Sourced from
                        // the live structure (TaskViewerProvider._buildSetupKanbanStructure
                        // passes it through, TaskViewerProvider.ts:3860), so a custom coded
                        // column joins the ALL CODED union automatically instead of being
                        // silently excluded.
                        kind: item.kind || null,
                        order: Number(item.order) || 0
                    });
                }
            }
        }
        list.sort((a, b) => (a.order - b.order) || String(a.label).localeCompare(String(b.label)));
        return list;
    }

    /** Rebuild the sidebar role order map from the current `kanbanColumnsCache`.
     *  The live structure replaces, not merges with, the fallback; a hidden role
     *  loses its weight and falls to the alphabetical tail. */
    function recomputeRoleOrderMap() {
        const next = {};
        for (const col of kanbanColumnsCache) {
            if (col.role) { next[col.role] = col.order; }
        }
        // Empty cache = first paint or a failed fetch; keep the fallback.
        roleOrderMap = Object.keys(next).length > 0 ? next : { ...KANBAN_ROLE_ORDER_FALLBACK };
    }

    /** Build a flat [{root, label}] list of available workspace roots from
     *  parentsList. Each parent's `parentFolder` is a resolved absolute path
     *  that the backend's _resolveWorkspaceRoot accepts as workspaceRoot.
     *  Used to populate the kanban pane's workspace picker so cards come from
     *  the workspace the operator is actually working in, not whatever the
     *  Kanban board tab last selected. */
    function buildWorkspaceList() {
        const list = [];
        const seen = new Set();
        for (const p of parentsList) {
            const root = p && p.parentFolder;
            if (root && !seen.has(root)) {
                seen.add(root);
                list.push({ root, label: p.name || root.split('/').pop() || root });
            }
        }
        return list;
    }

    /** Complexity score → category label. Mirrors the board's scoreToCategory
     *  (kanban.html:6655) so the pane and the board agree on what "6" means. */
    function scoreToCategory(scoreStr) {
        if (scoreStr === 'High') return 'High';
        if (scoreStr === 'Low') return 'Low';
        const score = parseInt(scoreStr, 10);
        if (isNaN(score) || score <= 0) return 'Unknown';
        if (score <= 2) return 'Very Low';
        if (score <= 4) return 'Low';
        if (score <= 6) return 'Medium';
        if (score <= 8) return 'High';
        if (score <= 10) return 'Very High';
        return 'Unknown';
    }

    function categoryToCssClass(category) {
        return category.toLowerCase().replace(' ', '-');
    }

    /**
     * Newest-first ordering for kanban-pane cards.
     *
     * Must match the board's column comparator (kanban.html:6408-6417): parsed
     * `lastActivity` descending, `createdAt` descending as the tiebreaker,
     * unparseable/absent timestamps floored to 0 so they sink rather than
     * jumping to the top.
     *
     * Sorting here is load-bearing, not cosmetic: the pane's cards arrive in
     * `ORDER BY updated_at DESC` order over a TEXT column that holds ISO-8601,
     * SQLite `YYYY-MM-DD HH:MM:SS`, and (in at least one shipped row) a
     * non-timestamp string. That lexicographic order is not chronological, so
     * the raw response order does NOT match the board.
     */
    function cardTimestamp(value) {
        if (!value) { return 0; }
        const t = new Date(value).getTime();
        return isNaN(t) ? 0 : t;
    }

    function compareCardsByRecency(a, b) {
        const tsDiff = cardTimestamp(b.lastActivity) - cardTimestamp(a.lastActivity);
        if (tsDiff !== 0) { return tsDiff; }
        return cardTimestamp(b.createdAt) - cardTimestamp(a.createdAt);
    }

    /** Resolve the default workspace root for a new kanban pane. Prefers the
     *  kanban board's selected workspace (injected by the host), then the
     *  focused pane's terminal's parentRoot, then the first parent, then
     *  undefined (the backend will fall back to its own resolution). */
    function defaultKanbanWorkspace() {
        if (initialWorkspaceRoot) { return initialWorkspaceRoot; }
        const focusedName = paneAssignments[focusedPaneIndex];
        if (focusedName) {
            const term = fleetList.find(t => t.friendlyName === focusedName);
            if (term && term.parentRoot) { return term.parentRoot; }
        }
        const ws = buildWorkspaceList();
        return ws.length > 0 ? ws[0].root : undefined;
    }

    /** Synthetic, DISPLAY-ONLY column id for the coder aggregate. Matches the id the
     *  board uses for its collapsed bucket (kanban.html:4216-4222) so both surfaces
     *  name the same concept. It is NOT a stored column: it exists nowhere in
     *  src/services/*.ts, and the server refuses AUTOCODE as a column ref on purpose
     *  (LocalApiServer.ts:1139-1152 — a many→one label must never resolve by picking
     *  one of its backing columns), so this id must never be sent as getBoardCards'
     *  `column`. getBoardCards compares columns with a literal `===`, so sending it
     *  returns an EMPTY list rather than an error. */
    const AGGREGATE_CODED_ID = 'CODED_AUTO';
    /** Title case, not the board's literal 'AUTOCODE'. Same name, different casing
     *  convention: the board's `.column-name` is `text-transform: uppercase`, so its
     *  labels are stored title-case ('New', 'Planned', 'Lead Coder') and SHOUTED by
     *  CSS. This picker is a plain <select> with no transform, so a caps string here
     *  would be the one shouting option among title-case neighbours. */
    const AGGREGATE_CODED_LABEL = 'Autocode';

    /** The real column ids the aggregate covers, from the live structure. Empty
     *  until the first getKanbanStructure lands — which is why the aggregate option
     *  is only offered once the cache is populated. */
    function codedColumnIds() {
        return kanbanColumnsCache.filter(c => c.kind === 'coded').map(c => c.id);
    }

    /** Human label for a chosen picker value, synthetic id included. */
    function columnLabelForId(id) {
        if (id === AGGREGATE_CODED_ID) { return AGGREGATE_CODED_LABEL; }
        const hit = kanbanColumnsCache.find(c => c.id === id);
        return hit ? hit.label : (id || '—');
    }

    /** Render a kanban column viewer into a pane slot (replaces the terminal
     *  viewport). The pane header carries a combined workspace/project picker + a
     *  column picker + a "Terminal" toggle to switch back to terminal mode; the
     *  body lists plan rows with "Copy Prompt" (advance is implied) and "Link" buttons. */
    function renderKanbanPane(paneEl, index) {
        paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly', 'is-input-queued');
        const planEl = paneEl.querySelector('.pane-plan-title');
        if (planEl) {
            planEl.style.display = 'none';
            planEl.textContent = '';
            planEl.removeAttribute('title');
        }
        const titleEl = paneEl.querySelector('.pane-title');
        const actionsEl = paneEl.querySelector('.pane-actions');
        const contentEl = paneEl.querySelector('.pane-content');

        let chosen = kanbanPaneColumn[index];
        const chosenWs = kanbanPaneWorkspace[index];
        const chosenProj = kanbanPaneProject[index] || '';
        const projects = kanbanPaneProjectsCache[index] || [];

        const coded = codedColumnIds();
        // Offered on exactly the board's terms (kanban.html renderColumns): the coder
        // columns collapse into the aggregate when the board's collapse toggle is on
        // and there is at least one coder column to collapse. NOT `coded.length > 1` —
        // the board collapses a single coder column too, and since the aggregate
        // REPLACES the columns it covers rather than sitting alongside them, a
        // one-column union is not a duplicate option.
        //
        // Gated on a POPULATED cache, not on coded.length alone: codedColumnIds() is
        // ALSO empty before the first getKanbanStructure lands, which is the state of
        // every first paint (kanbanColumnsCache starts [] and updatePaneElement renders
        // panes long before the async structure fetch resolves). Without this guard a
        // persisted CODED_AUTO was rewritten to CREATED and saveLayoutSettings()
        // PERSISTED the clobber on every reload — and the pre-structure label fallback
        // below, whose only purpose is to label CODED_AUTO, could never be reached.
        const structureLanded = kanbanColumnsCache.length > 0;
        const aggregateOffered = structureLanded && kanbanCollapseCoders && coded.length > 0;

        // Keep the pane's selection inside the offered set. Both directions matter,
        // because the board's collapse toggle can flip either way underneath a pane:
        //   - aggregate withdrawn (toggle off, or every coder column hidden in Setup)
        //     → fall to the first coder column, or CREATED when none survive.
        //   - aggregate adopted while a pane sits on an individual coder column → that
        //     column is no longer offered, so follow it into the bucket.
        let snapTo = null;
        if (structureLanded && chosen === AGGREGATE_CODED_ID && !aggregateOffered) {
            snapTo = coded[0] || 'CREATED';
        } else if (aggregateOffered && coded.includes(chosen)) {
            snapTo = AGGREGATE_CODED_ID;
        }
        if (snapTo) {
            kanbanPaneColumn[index] = snapTo;
            chosen = snapTo;
            // Drop the old rows: they belong to a column set this pane no longer
            // shows, so leaving them renders cards under the wrong heading. Same
            // reasoning as the picker's own change handler.
            kanbanPaneCards[index] = [];
            saveLayoutSettings();
            // Deferred: this render can be running INSIDE fetchBoardCardsForPane's
            // response handler (it re-renders the pane before its `finally` clears the
            // guard), where a direct call is swallowed by kanbanFetchInFlight and the
            // pane would sit empty until the next 5s tick.
            setTimeout(() => fetchBoardCardsForPane(index), 0);
        }

        // Before the first getKanbanStructure lands the cache is empty. Fall back to
        // the chosen id so the picker is never a blank <select> the operator cannot
        // read — it is repopulated in place once the structure arrives.
        const liveColumns = structureLanded
            ? kanbanColumnsCache
            // Pre-structure fallback: label the synthetic id properly instead of
            // printing the raw 'CODED_AUTO' at the operator.
            : (chosen ? [{ id: chosen, label: columnLabelForId(chosen) }] : []);

        // Substituted in place, never appended. Mirrors kanban.html renderColumns():
        // drop the coder columns, add the synthetic one carrying the FIRST coder
        // column's order, re-sort. That keeps the bucket in the pipeline position the
        // coder columns occupied (between Planned and Reviewed) instead of stranding
        // it past Completed at the tail of the list.
        const columns = aggregateOffered
            ? liveColumns
                .filter(c => c.kind !== 'coded')
                .concat([{
                    id: AGGREGATE_CODED_ID,
                    label: AGGREGATE_CODED_LABEL,
                    kind: 'coded',
                    order: kanbanColumnsCache.find(c => c.kind === 'coded')?.order || 180,
                    aggregate: true
                }])
                .sort((a, b) => (a.order || 0) - (b.order || 0))
            : liveColumns;

        // pickerSig must move when the union changes, or hiding a coder agent in Setup
        // leaves a stale option set on screen.
        const pickerSig = columns.map(c => `${c.id} ${c.label}`).join('') + '|' + coded.join(',');
        const workspaces = buildWorkspaceList();
        const wsSig = workspaces.map(w => `${w.root} ${w.label}`).join('');
        const projSig = projects.join('|');

        // Header rebuilt only when the option set actually changed. The 5s poll
        // re-renders this pane on every tick, and recreating the <select> each time
        // slammed an open dropdown shut and dropped keyboard focus mid-selection.
        let picker = titleEl.querySelector('.kanban-pane-column-picker');
        let combinedPicker = titleEl.querySelector('.kanban-pane-ws-project-picker');
        const combinedSig = `${wsSig}|${projSig}`;
        if (!picker || picker.dataset.sig !== pickerSig || !combinedPicker || combinedPicker.dataset.sig !== combinedSig) {
            titleEl.textContent = '';
            const idxEl = document.createElement('span');
            idxEl.className = 'pane-index-chip';
            idxEl.textContent = `P${index + 1}`;
            titleEl.appendChild(idxEl);

            // Combined workspace+project picker. The selected workspace's projects
            // are shown as "workspace > project" options. Other workspaces appear
            // as "All projects" entries; selecting one switches workspace and
            // refetches, then the dropdown is rebuilt with that workspace's projects.
            if (workspaces.length > 0 && chosenWs) {
                combinedPicker = document.createElement('select');
                combinedPicker.className = 'kanban-pane-ws-project-picker';
                combinedPicker.title = 'Workspace and project filter';
                combinedPicker.dataset.sig = combinedSig;

                const wsLabel = workspaces.find(w => w.root === chosenWs)?.label || chosenWs;

                const allOpt = document.createElement('option');
                allOpt.value = chosenWs + '|';
                allOpt.textContent = workspaces.length > 1
                    ? `${wsLabel} — All projects`
                    : 'All projects';
                combinedPicker.appendChild(allOpt);

                for (const proj of projects) {
                    const opt = document.createElement('option');
                    opt.value = chosenWs + '|' + proj;
                    opt.textContent = (workspaces.length > 1 ? `${wsLabel} > ` : '') + proj;
                    combinedPicker.appendChild(opt);
                }

                if (workspaces.length > 1) {
                    for (const ws of workspaces) {
                        if (ws.root === chosenWs) continue;
                        const otherOpt = document.createElement('option');
                        otherOpt.value = ws.root + '|';
                        otherOpt.textContent = `${ws.label} — All projects`;
                        combinedPicker.appendChild(otherOpt);
                    }
                }

                const combinedPickerEl = combinedPicker;
                combinedPickerEl.addEventListener('change', () => {
                    const [ws, proj] = combinedPickerEl.value.split('|');
                    const wsChanged = ws !== chosenWs;
                    kanbanPaneWorkspace[index] = ws;
                    kanbanPaneProject[index] = proj || '';
                    kanbanPaneCards[index] = [];
                    clearPaneSelection(index);
                    if (wsChanged) {
                        kanbanPaneProjectsCache[index] = [];
                    }
                    saveLayoutSettings();
                    fetchBoardCardsForPane(index);
                });
                titleEl.appendChild(combinedPickerEl);
            }

            picker = document.createElement('select');
            picker.className = 'kanban-pane-column-picker';
            picker.title = 'Kanban column to display';
            picker.dataset.sig = pickerSig;
            for (const col of columns) {
                const opt = document.createElement('option');
                opt.value = col.id;
                opt.textContent = col.label;
                if (col.aggregate) {
                    opt.title = `Union of ${coded.join(' + ')} — the board's AUTOCODE bucket`;
                }
                picker.appendChild(opt);
            }
            const pickerEl = picker;
            pickerEl.addEventListener('change', () => {
                kanbanPaneColumn[index] = pickerEl.value;
                // Drop the old column's cards so the pane cannot show them under the
                // new column's heading while the fetch is in flight.
                kanbanPaneCards[index] = [];
                clearPaneSelection(index);
                saveLayoutSettings();
                fetchBoardCardsForPane(index);
            });
            titleEl.appendChild(pickerEl);
        }
        if (chosen && picker.value !== chosen) { picker.value = chosen; }
        if (combinedPicker && combinedPicker.value !== `${chosenWs || ''}|${chosenProj}`) {
            combinedPicker.value = `${chosenWs || ''}|${chosenProj}`;
        }

        // Terminal-only actions off, mode toggle on. ONLY style.display is touched —
        // never className or onclick — so updatePaneElement can restore them when this
        // slot goes back to terminal mode.
        actionsEl.style.display = '';
        const modeBtn = actionsEl.children[6];
        for (let i = 0; i < actionsEl.children.length; i++) {
            actionsEl.children[i].style.display = (actionsEl.children[i] === modeBtn) ? '' : 'none';
        }

        // Body: plan list. Signature-gated — the 5s poll calls this on every tick, and
        // an unconditional rebuild reset the list's scroll position and wiped the
        // "Copied!" state off a button mid-timeout.
        // Sorted BEFORE the signature is built: the body signature is derived by mapping over
        // `cards` in order, so signing the unsorted array and rendering the sorted
        // one would mismatch on every poll tick and re-render forever.
        const cards = [...(kanbanPaneCards[index] || [])].sort(compareCardsByRecency);
        const hasFetched = index in kanbanPaneCards;
        const bodySig = `${chosenWs || ''} ${chosenProj || ''} ${chosen || ''} ${hasFetched ? '1' : '0'}`
            + cards.map(c => `${c.planId || c.sessionId || ''} ${c.topic || c.title || ''} ${c.complexity || ''} ${c.working ? 'w' : ''} ${c.project || ''} ${c.isFeature ? 'f' : ''} ${c.subtaskCount || 0} ${c.column || ''}`).join('');
        if (contentEl.dataset.kanbanSig === bodySig) { return; }
        contentEl.dataset.kanbanSig = bodySig;

        contentEl.textContent = '';
        if (!hasFetched) {
            const loading = document.createElement('div');
            loading.className = 'kanban-pane-loading';
            loading.textContent = 'Loading…';
            contentEl.appendChild(loading);
            return;
        }
        if (cards.length === 0) {
            const empty = document.createElement('div');
            // Tagged kanban-pane-empty as well as pane-empty-slot: updatePaneElement's
            // terminal path skips rebuilding the placeholder when a .pane-empty-slot is
            // already present, so an untagged kanban empty state left the pane stuck on
            // "No plans in …" with no way back once the mode flipped.
            empty.className = 'pane-empty-slot kanban-pane-empty';
            empty.textContent = `No plans in ${columnLabelForId(kanbanPaneColumn[index])}`;
            contentEl.appendChild(empty);
            return;
        }
        // Body wrapper: an always-visible hint strip above a scrolling plan list.
        // The strip is NOT a hover affordance — the previous attempt hung a native
        // `title` off an 11px ⤿ glyph in .pane-title, and ⤿ (U+293F) is absent from
        // every face in this panel's stack ('Hanken Grotesk', Menlo, Consolas), so it
        // rendered as tofu with a `?` help cursor and no tooltip anywhere.
        // The wrapper exists because .kanban-pane-list is the scroll container: a
        // sibling strip plus a height:100% list would overflow .pane-content, and
        // .terminal-pane's overflow:hidden would eat the last row.
        const body = document.createElement('div');
        body.className = 'kanban-pane-body';

        const hint = document.createElement('div');
        hint.className = 'kanban-pane-hint';
        hint.textContent = 'Drag a card onto a terminal pane to dispatch it';
        body.appendChild(hint);

        const list = document.createElement('div');
        list.className = 'kanban-pane-list';
        for (const card of cards) {
            const row = document.createElement('div');
            row.className = 'kanban-pane-row';
            if (card.working) { row.classList.add('is-working'); }
            if (card.isFeature) { row.classList.add('is-feature'); }

            const rowId = card.planId || card.sessionId || '';
            row.dataset.planId = rowId;

            // Make the row draggable so it can be dropped into a terminal pane.
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                if (buttonPressRowEl) { e.preventDefault(); return; }
                if (document.body.classList.contains('is-solo')) {
                    e.preventDefault();
                    return;
                }

                // If the dragged row is part of a multi-selection, carry the whole set.
                // Filter against the rendered card list so a card that left the column
                // between selection and drag is not transferred as a stale id — the
                // pane's analogue of kanban.html's getSelectedInRenderedContainer.
                const sel = paneSelection(index);
                const rendered = new Set((kanbanPaneCards[index] || [])
                    .map(c => c.planId || c.sessionId).filter(Boolean));
                let ids = [rowId].filter(Boolean);
                if (rowId && sel.has(rowId) && sel.size > 1) {
                    const live = Array.from(sel).filter(id => rendered.has(id));
                    if (live.length > 1 && live.includes(rowId)) { ids = live; }
                }

                const dragData = {
                    planId: card.planId || '',      // kept for payload back-compat
                    sessionId: card.sessionId || '', // kept for payload back-compat
                    planIds: ids,                    // NEW — the authoritative set
                    column: card.column || '',
                    workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index],
                    sourcePaneIndex: index
                };
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/json', JSON.stringify(dragData));
                e.dataTransfer.setData('text/plain', ids.length > 1
                    ? `${ids.length} plans`
                    : (card.topic || card.title || card.planId || ''));
                ids.forEach(id => {
                    const el = list.querySelector(`.kanban-pane-row[data-plan-id="${CSS.escape(id)}"]`);
                    if (el) { el.classList.add('dragging'); }
                });
            });
            row.addEventListener('dragend', () => {
                list.querySelectorAll('.kanban-pane-row.dragging')
                    .forEach(el => el.classList.remove('dragging'));
            });

            const sel = paneSelection(index);
            // Re-apply after the signature-gated rebuild: the 5s poll wipes contentEl
            // and reconstructs every row, so the class cannot be the source of truth.
            // Mirrors kanban.html:6613.
            if (rowId && sel.has(rowId)) { row.classList.add('selected'); }

            row.addEventListener('click', (e) => {
                // Never swallow the row's own buttons — the same guard the board uses
                // (kanban.html:6561). The buttons also stopPropagation, but that does
                // not cover a click landing on .kanban-pane-row-actions padding.
                if (e.target.closest('button')) { return; }
                if (!rowId) { return; }
                if (sel.has(rowId)) {
                    sel.delete(rowId);
                    row.classList.remove('selected');
                    return;
                }
                // Cross-workspace guard, mirroring kanban.html:6580 — a mixed-root
                // sessionIds array is filtered to one root by KanbanProvider.ts:9431
                // and the rest are silently dropped.
                const incomingRoot = card.workspaceRoot || kanbanPaneWorkspace[index] || '';
                const cards = kanbanPaneCards[index] || [];
                const mixed = Array.from(sel).some(id => {
                    const other = cards.find(c => (c.planId || c.sessionId) === id);
                    return other && (other.workspaceRoot || kanbanPaneWorkspace[index] || '') !== incomingRoot;
                });
                if (mixed) {
                    sel.clear();
                    list.querySelectorAll('.kanban-pane-row.selected')
                        .forEach(el => el.classList.remove('selected'));
                }
                sel.add(rowId);
                row.classList.add('selected');
            });

            const rowText = document.createElement('div');
            rowText.className = 'kanban-pane-row-text';

            const label = document.createElement('span');
            label.className = 'kanban-pane-row-title';
            label.textContent = card.topic || card.title || card.planId || '(untitled)';
            label.title = label.textContent;
            rowText.appendChild(label);

            // Meta line: complexity badge + working indicator + project.
            // Mirrors the board's card-meta density (complexity category + project).
            const meta = document.createElement('div');
            meta.className = 'kanban-pane-row-meta';
            const complexityVal = card.complexity || 'Unknown';
            const complexityCat = scoreToCategory(complexityVal);
            const complexityLabel = document.createElement('span');
            complexityLabel.className = 'kanban-pane-complexity-label';
            complexityLabel.textContent = 'Complexity: ';
            meta.appendChild(complexityLabel);
            const complexityValue = document.createElement('span');
            complexityValue.className = `kanban-pane-complexity ${categoryToCssClass(complexityCat)}`;
            complexityValue.textContent = complexityCat;
            meta.appendChild(complexityValue);
            if (card.isFeature) {
                const featureLabel = document.createElement('span');
                featureLabel.className = 'kanban-pane-feature-label';
                const count = card.subtaskCount || 0;
                featureLabel.textContent = `FEATURE: ${count} SUBTASK${count !== 1 ? 'S' : ''}`;
                meta.insertBefore(featureLabel, meta.firstChild);
            }
            if (card.working) {
                const working = document.createElement('span');
                working.className = 'kanban-pane-working';
                working.textContent = '● working';
                meta.appendChild(working);
            }
            if (card.project && !kanbanPaneProject[index]) {
                const proj = document.createElement('span');
                proj.className = 'kanban-pane-project';
                proj.textContent = card.project;
                proj.title = card.project;
                meta.appendChild(proj);
            }
            // In aggregate mode the list merges three columns, so each row must say which
            // one it is in — otherwise the operator cannot tell lead work from intern work,
            // and the chip is the only thing that distinguishes them.
            if (chosen === AGGREGATE_CODED_ID && card.column) {
                const colChip = document.createElement('span');
                colChip.className = 'kanban-pane-column-chip';
                colChip.textContent = columnLabelForId(card.column);
                colChip.title = card.column;
                meta.appendChild(colChip);
            }
            rowText.appendChild(meta);
            row.appendChild(rowText);

            const btnGroup = document.createElement('div');
            btnGroup.className = 'kanban-pane-row-actions';

            const linkBtn = document.createElement('button');
            linkBtn.className = 'kanban-pane-link-btn';
            linkBtn.textContent = 'link';
            linkBtn.title = 'Open this plan in the planning panel';
            linkBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await fetch('/kanban/verb/selectPlan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sessionId: card.sessionId || '',
                            planId: card.planId || '',
                            workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index]
                        })
                    });
                } catch { /* ignore */ }
            });
            btnGroup.appendChild(linkBtn);

            const viewBtn = document.createElement('button');
            viewBtn.className = 'kanban-pane-view-btn';
            viewBtn.textContent = 'view';
            viewBtn.title = 'Open this plan in the Project panel';
            viewBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                // The label is `view`; the VERB is `reviewPlan` — the same one the board's
                // review button posts (kanban.html:6620-6643). Do NOT "correct" this to
                // `viewPlan`: that kanban-surface verb was deliberately deleted (it opened a
                // markdown preview) and its removal is pinned by
                // src/test/kanban-view-plan-removal-regression.test.js.
                viewBtn.disabled = true;
                let ok = false;
                try {
                    const res = await fetch('/kanban/verb/reviewPlan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sessionId: card.sessionId || '',
                            planId: card.planId || '',
                            planFile: card.planFile || '',
                            workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index],
                            project: card.project || '',
                            column: card.column || '',
                            isFeature: card.isFeature || false
                        })
                    });
                    const data = await res.json();
                    ok = data && data.success === true;
                } catch { /* ok stays false */ }
                if (!ok) {
                    // Do not switch: the Project panel received no selection, so jumping there
                    // would show a stale entry and read as "opened the wrong plan".
                    viewBtn.textContent = 'Failed';
                    setTimeout(() => { viewBtn.disabled = false; viewBtn.textContent = 'view'; }, 2000);
                    return;
                }
                viewBtn.disabled = false;
                // Shell-only move: panels are same-origin iframes and the shell owns the switch.
                // transport.js:349 posts {type:'switchPanel'} to window.parent, so this is a
                // no-op in a bare /terminals tab (and unreachable in a solo popout, where the
                // pane grid — and therefore this button — does not exist).
                if (typeof window.__switchboardSwitchPanel === 'function') {
                    window.__switchboardSwitchPanel('project');
                }
            });
            btnGroup.appendChild(viewBtn);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'kanban-pane-copy-btn';
            copyBtn.textContent = 'Copy Prompt';
            copyBtn.title = 'Copy prompt to clipboard (card advances to next column)';
            copyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                copyBtn.disabled = true;
                copyBtn.textContent = 'Copying…';
                try {
                    const res = await fetch('/kanban/verb/promptSelected', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            column: card.column,
                            sessionIds: [card.planId || card.sessionId],
                            workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index]
                        })
                    });
                    const data = await res.json();
                    if (data.success) {
                        if (typeof data.prompt === 'string') {
                            try {
                                await window.sbCopyToClipboard(data.prompt);
                                copyBtn.textContent = 'Copied!';
                            } catch {
                                copyBtn.textContent = 'Copy failed';
                            }
                        } else {
                            copyBtn.textContent = 'Copy failed';
                        }
                        // Refresh this pane's list (the card advanced out).
                        paneSelection(index).delete(card.planId || card.sessionId || '');
                        fetchBoardCardsForPane(index);
                    } else {
                        copyBtn.textContent = 'Failed';
                    }
                } catch {
                    copyBtn.textContent = 'Error';
                }
                setTimeout(() => { copyBtn.disabled = false; copyBtn.textContent = 'Copy Prompt'; }, 2000);
            });
            btnGroup.appendChild(copyBtn);
            row.appendChild(btnGroup);
            list.appendChild(row);
        }
        body.appendChild(list);
        contentEl.appendChild(body);
    }

    /** Toggle the focused pane to kanban mode (or back to terminal mode if
     *  already kanban). This is the primary, discoverable entry point — the
     *  empty-slot "kanban mode" toggle is a secondary path. If the focused pane
     *  has a terminal assigned, it is unassigned first (the terminal keeps
     *  running, same as the unassign button). */
    function toggleFocusedPaneKanban() {
        const isSolo = document.body.classList.contains('is-solo');
        if (isSolo) { return; }
        const slotCount = getSlotCount(effectiveLayout);
        if (slotCount <= 1) { return; }

        let targetIndex = focusedPaneIndex;
        // If the focused pane is already kanban, toggle it back to terminal.
        if (paneModes[targetIndex] === 'kanban') {
            paneModes[targetIndex] = 'terminal';
            clearPaneSelection(targetIndex);
            saveLayoutSettings();
            renderPaneGrid();
            return;
        }
        // If the focused pane has a terminal, unassign it first (terminal keeps
        // running). This mirrors the unassign button's behavior.
        const assignedName = paneAssignments[targetIndex];
        if (assignedName) {
            paneAssignments[targetIndex] = null;
            pinnedPanes[targetIndex] = false;
        }
        paneModes[targetIndex] = 'kanban';
        clearPaneSelection(targetIndex);
        if (!kanbanPaneColumn[targetIndex]) { kanbanPaneColumn[targetIndex] = 'CREATED'; }
        if (!kanbanPaneWorkspace[targetIndex]) { kanbanPaneWorkspace[targetIndex] = defaultKanbanWorkspace(); }
        if (!kanbanPaneProject[targetIndex]) { kanbanPaneProject[targetIndex] = ''; }
        saveLayoutSettings();
        renderPaneGrid();
        fetchBoardCardsForPane(targetIndex);
    }

    function startKanbanPoll() {
        if (kanbanPollTimer) { return; }
        kanbanPollTimer = setInterval(pollKanbanPanes, 5000);
        pollKanbanPanes(); // immediate first fetch
    }

    function stopKanbanPoll() {
        if (kanbanPollTimer) { clearInterval(kanbanPollTimer); kanbanPollTimer = null; }
    }

    function startFleetPoll() {
        if (fleetPollTimer || isKanbanDock) { return; }
        fleetPollTimer = setInterval(() => {
            // Skip when the tab is hidden — the WebSocket push will catch up on
            // regain, and a background tab hammering ptyListTerminals wastes a
            // server slot per hidden panel. The poll is a fallback for when the
            // WebSocket is dead, not a replacement for it.
            if (document.visibilityState === 'hidden') { return; }
            fetchTerminalList();
        }, 5000);
    }

    function stopFleetPoll() {
        if (fleetPollTimer) {
            clearInterval(fleetPollTimer);
            fleetPollTimer = null;
        }
    }

    /** Fetch the Kanban column structure and rebuild the role order map. Shared by
     *  the kanban pane poll, the terminal list refresh, panel init, and the window
     *  focus hook. A `force` arg bypasses the 30s throttle so reordering in Setup
     *  is picked up the moment the operator returns to the panel. */
    async function fetchKanbanColumnStructure(force = false) {
        if (!force && kanbanStructureTimer && Date.now() - kanbanStructureTimer < 30000) { return; }
        kanbanStructureTimer = Date.now();
        try {
            const structRes = await fetch('/kanban/verb/getKanbanStructure', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            const structData = await structRes.json();
            if (structData && structData.success) {
                kanbanColumnsCache = buildColumnList(structData.structure, structData.customColumns);
                // `!== false` not `!!`: an older host that predates the flag omits it,
                // and the board's default is ON — treating undefined as OFF would strip
                // AUTOCODE from a board that is showing it.
                kanbanCollapseCoders = structData.collapseCoders !== false;
                recomputeRoleOrderMap();
                renderSidebarList();
            }
        } catch { /* ignore — keep stale cache */ }
    }

    async function pollKanbanPanes() {
        const slotCount = getSlotCount(effectiveLayout);
        const kanbanSlots = [];
        for (let i = 0; i < slotCount; i++) {
            if (paneModes[i] === 'kanban' && !paneAssignments[i]) { kanbanSlots.push(i); }
        }
        if (kanbanSlots.length === 0) { stopKanbanPoll(); return; }
        // Column structure changes rarely — refresh on a 30s cadence.
        await fetchKanbanColumnStructure();
        // Fire all pane fetches in parallel. The previous for…of await made the
        // Nth pane wait for all prior fetches, so a slow board stretched the poll
        // cycle linearly with pane count.
        await Promise.all(kanbanSlots.map(idx => fetchBoardCardsForPane(idx)));
    }

    async function fetchBoardCardsForPane(index) {
        const col = kanbanPaneColumn[index];
        if (!col) { return; }
        // One request per pane at a time. setInterval does not await the previous
        // tick, and the mode-toggle handler fetches directly on top of the poll's
        // immediate first pass — so a slow board (large DB, busy host) overlapped
        // requests and let an older response land after a newer one and render
        // stale cards. Dropping the duplicate is correct: the next tick is 5s away.
        if (kanbanFetchInFlight.has(index)) { return; }
        kanbanFetchInFlight.add(index);
        try {
            const wsRoot = kanbanPaneWorkspace[index];
            const proj = kanbanPaneProject[index] || '';
            const isAggregate = col === AGGREGATE_CODED_ID;
            // The aggregate omits `column` entirely rather than sending CODED_AUTO.
            // getBoardCards' filter is a literal `c.column === column` compare
            // (KanbanProvider.ts:10670), so sending the synthetic id returns an EMPTY
            // list — indistinguishable from "nothing is out for coding". Server-side
            // repo-scope, feature roll-up and project filters are per-card predicates
            // independent of the column filter, so an unfiltered fetch inherits them
            // unchanged.
            const body = { workspaceRoot: wsRoot, project: proj };
            if (!isAggregate) { body.column = col; }
            const res = await fetch('/kanban/verb/getBoardCards', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            // Re-check the column: the operator can change the picker while this is
            // in flight, and the response describes the column we ASKED for.
            if (data.success && kanbanPaneColumn[index] === col) {
                const all = Array.isArray(data.cards) ? data.cards : [];
                const codedNow = codedColumnIds();
                kanbanPaneCards[index] = isAggregate
                    ? all.filter(c => codedNow.includes(c.column))
                    : all;
                if (Array.isArray(data.projects)) {
                    kanbanPaneProjectsCache[index] = data.projects;
                }
                // Re-render just this pane if it still exists and is still kanban mode.
                const paneEl = paneGridEl.children[index];
                if (paneEl && paneModes[index] === 'kanban' && !paneAssignments[index]) {
                    renderKanbanPane(paneEl, index);
                }
            }
        } catch { /* ignore — keep stale list */ }
        finally { kanbanFetchInFlight.delete(index); }
    }

    /**
     * Apply the floor. Re-renders when the pane COUNT changes, because the floor is not a
     * CSS-only concern: leaving four pane elements in a two-column grid just reflows them
     * into two implicit rows — i.e. 2x2 again — which is exactly the unreadable grid the
     * floor exists to prevent.
     */
    function applyLayoutFloor(opts) {
        const fit = !opts || opts.fit !== false;
        const resolved = resolveFlooredLayout();
        const changed = resolved !== effectiveLayout;
        effectiveLayout = resolved;

        const activeGroup = activeGroupId ? getAllGroups().find(g => g.id === activeGroupId) : null;
        const members = activeGroup ? getGroupMembers(activeGroup).length : 0;
        const rendered = getSlotCount(effectiveLayout);
        const shortfall = activeGroup && members > rendered;
        const floored = effectiveLayout !== currentLayout;
        fallbackBannerEl.classList.toggle('visible', floored || !!shortfall);
        fallbackBannerEl.textContent = '';
        if (activeGroup && shortfall) {
            // Inside a lock the useful message is the shortfall, not "your layout was
            // reduced" — and paging is the remedy, so it sits in the same place.
            // Paging is keyed to RENDERED slots, not to nine.
            const pageCount = Math.max(1, Math.ceil(members / rendered));
            const start = activeGroupPage * rendered;
            const label = document.createElement('span');
            label.textContent =
                `Showing ${start + 1}–${Math.min(start + rendered, members)} of ${members} — ${activeGroup.name} `;
            fallbackBannerEl.appendChild(label);
            const mkPage = (text, delta, disabled) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'banner-page-btn';
                b.textContent = text;
                b.disabled = disabled;
                b.addEventListener('click', () => {
                    activeGroupPage += delta;
                    seatActiveGroupPage();
                    applyLayoutFloor({ fit: false });
                    batchFitVisiblePanes();
                });
                return b;
            };
            fallbackBannerEl.appendChild(mkPage('‹ prev', -1, activeGroupPage <= 0));
            fallbackBannerEl.appendChild(mkPage('next ›', 1, activeGroupPage >= pageCount - 1));
        } else if (floored) {
            fallbackBannerEl.textContent = 'Window too small for requested layout — using simpler layout floor.';
        }

        if (changed) {
            // The floor moved the rendered slot count: a locked group must re-page
            // against the new count instead of leaving stale seats behind.
            if (activeGroupId) { seatActiveGroupPage(); }
            renderPaneGrid();
            batchFitVisiblePanes();
            return;
        }
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;
        applyPeekClasses();
        if (fit) { batchFitVisiblePanes(); }
    }

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

    /**
     * Force the renderer back in sync WITHOUT touching the buffer and WITHOUT
     * reporting anything to the pty.
     *
     * Ordered least-invasive first:
     *  1. Read the host box. Cheap, but it forces a style/layout flush, which is
     *     what lets the next IntersectionObserver computation see real geometry
     *     and unpause RenderService.
     *  2. refresh() — marks every row dirty, requesting a full repaint. This is
     *     the actual repair for the visibility-regain bug: it reaches WebGL's
     *     _updateModel(0, rows-1), which repaints every row from the current
     *     buffer. For context-loss / renderer-swap paths, add rebuildAtlas:true
     *     to also clear the atlas and force a full model rebuild.
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
    function resyncPaneRenderer(entry, verdict, options) {
        try { void entry.container.getBoundingClientRect(); } catch { /* ignore */ }
        // Atlas rebuild is a sledgehammer route to a full repaint: it makes
        // beginFrame() return true, forcing _clearModel(true) + a full-range
        // _updateModel. refresh() below reaches that same full-range update
        // directly. Wanted on the context-loss path (the renderer really was
        // swapped); NOT wanted on visibility regain, where the atlas is intact
        // and the rebuild only costs re-rasterisation on every alt-tab.
        // Default true so all pre-existing callers are unchanged.
        if (options?.rebuildAtlas !== false) {
            try { entry.term.clearTextureAtlas(); } catch { /* ignore */ }
        }
        try { entry.term.refresh(0, Math.max(0, entry.term.rows - 1)); } catch { /* ignore */ }
        if (verdict !== 'stale-canvas') { return; }
        try {
            entry.term._core._renderService.handleResize(entry.term.cols, entry.term.rows);
        } catch { /* ignore */ }
    }

    /**
     * Re-sync xterm's scroll area after a same-size DOM re-parent or a
     * display:none -> grid flip. fit() short-circuits when cols/rows match,
     * so onDimensionsChange never fires and Viewport.syncScrollArea() is
     * never called; the thumb renders at zero height until the next buffer
     * write. The fit ladder (startFitLadder) verifies cols/rows/canvas but
     * never the scroll area — this closes that gap.
     *
     * Primary: xterm's own Viewport.syncScrollArea (private surface, same
     * precedent as term._core._renderService at resyncPaneRenderer). This path
     * does NOT save and restore scrollTop, and must not start doing so.
     * syncScrollArea defers to Viewport._innerRefresh, which re-derives
     * scrollTop from buffer.ydisp — xterm's authoritative scroll position —
     * and sets _ignoreNextScrollEvent so its own write does not feed back.
     * A restore scheduled here lands one frame LATER and therefore wins:
     * it overwrites the repair with the pre-refresh DOM value, and because
     * that write carries no ignore flag, Viewport._handleScroll turns it into
     * a real scrollLines request. Both callers make that value wrong — a
     * re-parent has already zeroed scrollTop, and a stale (short) scroll area
     * clamps it — so restoring it drags the view to the top of the scrollback
     * in exactly the case this function exists to fix.
     *
     * Fallback: a one-frame overflowY toggle forces the browser to drop and
     * recreate the native scrollbar widget (rAF split so Chromium commits
     * 'hidden' first — a synchronous toggle coalesces into a no-op). 'hidden'
     * makes the element non-scrollable and zeroes scrollTop itself, so THIS
     * path does save and restore it — undoing its own damage, not
     * second-guessing xterm. The restored value agrees with ydisp, so the
     * resulting scroll event resolves to scrollLines(0).
     */
    function refreshTerminalScrollbar(entry) {
        if (!entry || entry.disposed || !entry.term) { return; }
        const container = entry.container;
        if (!container) { return; }
        const viewport = container.querySelector('.xterm-viewport');
        if (!viewport) { return; }
        try {
            const vp = entry.term._core && entry.term._core.viewport;
            if (vp && typeof vp.syncScrollArea === 'function') {
                // `true` = refresh SYNCHRONOUSLY. syncScrollArea(e) forwards e to
                // Viewport._refresh(e), and _refresh(false) only schedules an rAF —
                // so with the default arg the DOM is still stale on the next line and
                // the verification below could not read it.
                vp.syncScrollArea(true);
                // syncScrollArea SELF-SUPPRESSES, so calling it is not the same as
                // repairing anything. It only reaches _refresh when the buffer LENGTH
                // changed, or the viewport height, or scrollTop, or the device cell
                // height. A long-lived pane sitting idle in a static grid matches none
                // of them: once the buffer hits the `scrollback` cap its length is
                // pinned (eviction, not growth), so even continuous output stops
                // moving that first condition. That is the state this function exists
                // for, and it is exactly the state the primary path silently no-ops in.
                // Returning unconditionally here made the fallback below unreachable.
                //
                // Verify against the DOM instead of trusting the call. A thumb is owed
                // only when the buffer actually has scrollback beyond the visible rows
                // (in the ALT buffer length === rows, so no thumb is owed and the
                // early return is correct — nothing to scroll is not a defect).
                const buf = entry.term.buffer && entry.term.buffer.active;
                const owesThumb = !!buf && buf.length > entry.term.rows;
                // +1 absorbs sub-pixel rounding on fractional row heights.
                const domCanScroll = viewport.scrollHeight > viewport.clientHeight + 1;
                if (!owesThumb || domCanScroll) { return; }
                // Owed a thumb and the DOM still says otherwise ⇒ the sync was
                // suppressed. Fall through to the overflowY repair.
            }
        } catch { /* ignore — private shape changed, fall through */ }
        const savedScrollTop = viewport.scrollTop;
        viewport.style.overflowY = 'hidden';
        requestAnimationFrame(() => {
            if (entry.disposed) { return; }
            viewport.style.overflowY = '';
            if (viewport.scrollTop !== savedScrollTop) {
                viewport.scrollTop = savedScrollTop;
            }
        });
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

            // Visibility-regain repair, latched by init()'s visibilitychange listener
            // AND its window-focus listener (focus covers the same-browser window
            // switch, where visibilitychange never fires because the document stays
            // 'visible'). UNCONDITIONAL and NOT gated on inspectPaneFit: unpainted rows
            // leave cols/rows and the painted grid in perfect agreement (inspectPaneFit
            // compares grid geometry, never pixel content), so the verdict is 'ok' and
            // the ladder's early return below would skip the repair entirely.
            // Gated on isRendered instead, because a repair against a zero-box
            // container is wasted and would clear the flag that is meant to carry the
            // intent forward to the reveal.
            // rebuildAtlas:false -- the atlas is intact on this path; refresh(0,rows-1)
            // inside resyncPaneRenderer is the actual repair. 'stale-canvas' is still
            // passed because it is what gates step 4 (handleResize), which covers the
            // DPR / backing-store cases a repaint cannot.
            // Cleared BEFORE the calls: resyncPaneRenderer swallows its own errors, and
            // an entry that could not be repaired must not re-arm on every later ladder.
            if (entry.needsRendererResync && entry.term && isRendered(entry.container)) {
                entry.needsRendererResync = false;
                resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: false });
                refreshTerminalScrollbar(entry);
            }

            const before = inspectPaneFit(entry);
            if (before === 'skip') { return; }
            // Already converged: nothing is mutated below, so re-inspecting would
            // return the same verdict for the price of a second proposeDimensions()
            // — i.e. a second getComputedStyle forced-layout flush per pane, nine of
            // them on a 3x3. The common case must not cost more than the old
            // single-rAF path did.
            if (before === 'ok') { return; }
            // ONLY on a verified buffer mismatch. fitAndReportSize sends a resize frame
            // unconditionally — even when fit() short-circuits and changes nothing — and
            // reconcileTerminalSize takes the MIN across clients, so firing it
            // on an 'unsettled' verdict would push a stale size into the shared pty.
            if (before === 'mismatch') {
                fitAndReportSize(entry);
            }

            const after = inspectPaneFit(entry);
            if (after === 'ok' || after === 'skip') {
                // Belt-and-braces only, and deliberately NOT hoisted above the
                // `before === 'ok'` early return above. Reaching here means a fit
                // actually changed dimensions, which fires onResize ->
                // RenderService.handleResize -> onDimensionsChange -> the viewport's
                // own syncScrollArea; this call is near-redundant on that path. The
                // already-converged pane never reaches here, and covering it would
                // put a syncScrollArea plus an rAF on every batchFitVisiblePanes pass
                // — nine panes per broadcast. The scroll area only goes stale on a
                // transition, and those are covered at their source: the re-parent
                // branch in updatePaneElement and the solo display flip in
                // checkSoloNotFound.
                if (after === 'ok') { refreshTerminalScrollbar(entry); }
                return;
            }
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

    /**
     * Role sent by the "No role" picker button — a plain shell, no agent CLI.
     *
     * The fleet needs SOME role string: it names the terminal (`shell-1`, `shell-2`)
     * and labels the sidebar row. `shell` is deliberately absent from the Agents tab,
     * so `injectStartupCommand` looks it up in the configured startup commands, finds
     * nothing, and returns before writing anything to the pty (ptyFleetService.ts:118)
     * — which also skips the 750ms shell-readiness wait that only exists to let a CLI
     * boot. Sending no role at all would NOT work: the handler defaults to `coder`,
     * which does have a command.
     *
     * Do not add a `shell` entry to the Agents tab startup commands; that would give
     * this button a CLI and defeat it.
     */
    const NO_ROLE = 'shell';

    /**
     * Pull the agent-CLI labels the kanban board already uses.
     *
     * getStartupCommands is an existing allowlisted verb; it now returns the
     * `agentNames` map alongside the raw commands, so this panel renders the same
     * string the column subline does without duplicating the derivation.
     */
    async function fetchAgentNames() {
        try {
            const res = await fetch('/kanban/verb/getStartupCommands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.agentNames && typeof data.agentNames === 'object') {
                    agentNames = data.agentNames;
                }
            }
        } catch { /* labels are decoration — a failure must not blank the sidebar */ }
    }

    /**
     * Debounced refetch + re-render for the startupCommandsChanged push and
     * the panelVisibility → visible backstop. The browser cockpit fans one
     * broadcast out to every panel frame (~6×), so an un-debounced handler
     * would issue six identical getStartupCommands calls per save. A
     * trailing-edge debounce is correct: the last push carries the same
     * information as the first, and the value is already written before any
     * of them are sent. fetchAgentNames swallows failures, so a failed
     * refetch leaves the previous map in place — never blanks the sidebar.
     */
    const debouncedRefreshAgentNames = debounce(async () => {
        await fetchAgentNames();
        renderSidebarList();
        renderPaneGrid();
    }, 200);

    const CROWN_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">'
        + '<path d="M2 5l3 3 3-5 3 5 3-3-1.5 7h-9L2 5z"/>'
        + '</svg>';

    /**
     * Whether `name` is the head (first member) of a registered team-spawned group.
     * The head is the first entry in the group's members array, written by
     * wireSpawnedTeam (teamWiring.ts:1039: `const groupMembers = [headName, ...childNames]`).
     *
     * Team-spawned groups are identified by their `team_` ID prefix (teamWiring.ts,
     * `const groupId = opts.teamId || ('team_' + ...)`); operator-saved groups use
     * `grp_` (saveCurrentAsGroup / saveSelectionAsGroup) and must NOT trigger a crown
     * — both carry source: 'manual', so the ID prefix is the only discriminator.
     *
     * `externalHead` groups are excluded: for those, wireSpawnedTeam deliberately
     * OMITS the head from members ("the head is a non-terminal agent and should not
     * appear in getGroupMembers"), so members[0] is the first CODER. Crowning it
     * would put the lead marker on a worker — the exact confusion this icon exists
     * to remove. An external head has no seat, so no seat is crowned.
     *
     * Survives rename: renameTerminal updates g.members and g.order in-place, so
     * members[0] tracks the renamed head. The group's `name` field is NOT updated on
     * rename, which is why this uses members[0], not g.name.
     *
     * Defensive against empty/unloaded groups.
     */
    function isTeamHead(name) {
        if (!name || !Array.isArray(terminalGroups)) { return false; }
        return terminalGroups.some(g => {
            if (!g || typeof g.id !== 'string') { return false; }
            if (!g.id.startsWith('team_') || g.source !== 'manual' || g.externalHead) { return false; }
            // Prefer the explicit `head` field; fall back to members[0] for
            // legacy rows that predate the head stamp.
            if (typeof g.head === 'string' && g.head) { return g.head === name; }
            return Array.isArray(g.members) && g.members.length > 0 && g.members[0] === name;
        });
    }

    /**
     * The agent CLI label for a role, or '' when there isn’t one.
     *
     * Handles the three no-label cases: the map is empty (fetchAgentNames swallows
     * failures — labels must never blank the sidebar), the role has no startup
     * command (KanbanProvider._getAgentNames returns the literal 'No agent
     * assigned'), and the deliberate CLI-less `shell` role (NO_ROLE).
     */
    function agentLabelForRole(role) {
        if (!role || role === NO_ROLE) { return ''; }
        const label = agentNames[role];
        if (!label || label === 'No agent assigned') { return ''; }
        return label;
    }

    async function fetchPtyVisibleRoles() {
        try {
            const res = await fetch('/terminals/verb/ptyVisibleRoles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success && data.visibleAgents && typeof data.visibleAgents === 'object') {
                    const hasCommand = data.hasCommand && typeof data.hasCommand === 'object' ? data.hasCommand : {};
                    return { visibleAgents: data.visibleAgents, hasCommand };
                }
            }
        } catch { /* fall through */ }
        return { visibleAgents: { ...DEFAULT_VISIBLE_AGENTS }, hasCommand: {} };
    }

    /**
     * Fetch the host-resolved team definitions for the team list and the
     * honest role picker. Returns an array (empty on failure). The definition
     * is resolved host-side — the start verb never accepts one from the wire.
     */
    async function fetchAgentGroups() {
        try {
            const res = await fetch('/terminals/verb/ptyListAgentGroups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success && Array.isArray(data.groups)) {
                    return data.groups;
                }
            }
        } catch { /* fall through */ }
        return [];
    }

    async function fetchVisibleRoles() {
        const data = await fetchPtyVisibleRoles();
        return Object.keys(data.visibleAgents).filter(k => data.visibleAgents[k] !== false);
    }

    async function onNewTerminalClicked(targetSpec, key) {
        const groupKey = key || '__default__';
        // Toggle closed: an open picker on this group, OR one whose roles fetch is
        // still in flight for this group.
        if ((pickerState && pickerState.key === groupKey) || pickerOpening === groupKey) {
            pickerState = null;
            pickerOpening = null;
            renderSidebarList();
            return;
        }
        // Claim the open synchronously, then fetch BEFORE committing pickerState, so
        // the picker never renders empty and then repopulates.
        pickerOpening = groupKey;
        const data = await fetchPtyVisibleRoles();
        // A later click (or a cancel) superseded this one — discard the result.
        if (pickerOpening !== groupKey) { return; }
        pickerOpening = null;
        rolePickerData = data;
        pickerState = { key: groupKey, targetSpec };
        pickerNeedsScroll = true;
        renderSidebarList();
    }

    /**
     * Plain-language summary of what a team spawns, e.g. "3× coder".
     * Mirrors the member-summary style used in the TEAMS tab gallery.
     */
    function teamSpawnSummary(team) {
        const members = Array.isArray(team?.members) ? team.members : [];
        const parts = members.map(m => `${m.count || 1}× ${m.role}${m.scope === 'shared' ? ' (shared)' : ''}`);
        return parts.length > 0 ? parts.join(', ') : 'head only';
    }

    /**
     * Build the inline role picker for one group. Returns a detached element the
     * renderer inserts between a group header and its items container, so it stays
     * visible when the group is collapsed and is unmistakably attached to the
     * workspace it will spawn into. Annotates role options that head a team with
     * the team name and what spawns, so picking a role never silently produces a
     * fleet. The explicit START action lives in the sidebar ops block
     * (#btn-start-team), not here — this picker creates one terminal per click.
     */
    function buildRolePicker(targetSpec) {
        const picker = document.createElement('div');
        picker.className = 'role-picker is-inline';

        const title = document.createElement('div');
        title.className = 'role-picker-title';
        title.textContent = 'New terminal — pick a role';
        picker.appendChild(title);

        // ── Role picker ───────────────────────────────────────────────────
        const optionsEl = document.createElement('div');
        optionsEl.className = 'role-picker-options';

        // Defensive only: onNewTerminalClicked assigns rolePickerData before it
        // assigns pickerState, so the renderer never sees one without the other.
        const data = rolePickerData || { visibleAgents: {}, hasCommand: {} };
        const visible = data.visibleAgents;
        const hasCommand = data.hasCommand;
        const SYSTEM_ROLES = new Set(['mission-control', 'mcp_monitor']);
        const roles = Object.keys(visible)
            .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))
            .sort((a, b) => {
                const aOrder = roleOrderMap[a];
                const bOrder = roleOrderMap[b];
                // Mapped roles sort by column order ascending
                if (aOrder !== undefined && bOrder !== undefined) { return aOrder - bOrder; }
                // Mapped before unmapped
                if (aOrder !== undefined) { return -1; }
                if (bOrder !== undefined) { return 1; }
                // Both unmapped: alphabetical by role
                return (a || '\uFFFF').localeCompare(b || '\uFFFF');
            });

        for (const role of roles) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'role-option';
            const meta = BUILT_IN_AGENT_LABELS.find(r => r.key === role);
            const label = meta ? meta.label : role;
            btn.textContent = label;
            btn.title = hasCommand[role]
                ? `Open ${label} terminal`
                : `${label} — no agent CLI configured (plain shell)`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close NOW, not whenever the next render happens to run. The static
                // picker hid synchronously (`picker.hidden = true`); clearing state
                // alone leaves the menu on screen until something re-renders, and
                // createTerminal's only re-render sits behind `res.ok` — so a
                // command-bearing role holds the menu for the ~750ms
                // SHELL_READINESS_DELAY_MS create round trip, and a failed create
                // holds it until the 5s fleet poll.
                pickerState = null;
                renderSidebarList();
                createTerminal(role, targetSpec, hasCommand[role] === true);
            });
            optionsEl.appendChild(btn);
        }

        // Last, and visually separated: this is the absence of a role, not another
        // one, so it must not read as a peer of the agent buttons above it.
        const noRoleBtn = document.createElement('button');
        noRoleBtn.type = 'button';
        noRoleBtn.className = 'role-option is-no-role';
        noRoleBtn.textContent = 'No role';
        noRoleBtn.title = 'Plain shell in the workspace directory — no agent CLI started';
        noRoleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close synchronously — same reasoning as the role buttons above.
            pickerState = null;
            renderSidebarList();
            createTerminal(NO_ROLE, targetSpec, false);
        });
        optionsEl.appendChild(noRoleBtn);
        picker.appendChild(optionsEl);

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'role-picker-cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', (e) => {
            e.stopPropagation();
            pickerState = null;
            pickerOpening = null;
            renderSidebarList();
        });
        picker.appendChild(cancel);

        return picker;
    }

    /**
     * buildRolePicker + the one-shot scroll-into-view. `.terminals-list` is the
     * sidebar's scroll container (overflow-y:auto), so a picker opened under a
     * header at the bottom of the scrollport lands below the fold and the click
     * reads as a no-op — the original bug wearing a different hat. Scrolling only
     * on the render that OPENED the picker is the point: doing it unconditionally
     * would fight the operator's scroll on every 5s poll re-render.
     *
     * block:'nearest' is a no-op when the picker is already fully visible, and
     * body is height:100vh/overflow:hidden, so .terminals-list is the only ancestor
     * that can scroll — the movement cannot shift the panel layout.
     */
    function mountRolePicker(targetSpec) {
        const el = buildRolePicker(targetSpec);
        if (pickerNeedsScroll) {
            pickerNeedsScroll = false;
            requestAnimationFrame(() => {
                if (el.isConnected) { el.scrollIntoView({ block: 'nearest' }); }
            });
        }
        return el;
    }

    async function createTerminal(role, targetSpec, hasStartupCommand) {
        try {
            const payload = { role };
            if (typeof targetSpec === 'string') {
                payload.cwd = targetSpec;
                payload.worktreePath = targetSpec;
            } else if (targetSpec && typeof targetSpec === 'object') {
                if (targetSpec.parentRoot) {
                    payload.parentRoot = targetSpec.parentRoot;
                }
                if (targetSpec.worktreePath) {
                    payload.cwd = targetSpec.worktreePath;
                    payload.worktreePath = targetSpec.worktreePath;
                }
            }
            const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.terminal) {
                    const delegates = Array.isArray(data.delegates) ? data.delegates : [];
                    // BEFORE fetchTerminalList/assign: those are what build the pane and
                    // its xterm, and updatePaneElement reads startupCurtains to decide
                    // whether to paint the overlay. Arming after them would paint one
                    // reconcile late — a visible flash of the raw prompt.
                    armStartupCurtain(data.terminal.friendlyName, hasStartupCommand);
                    if (delegates.length > 0) {
                        // Team members run the role's configured agent CLI even when the
                        // member definition carries no command of its own
                        // (ptyFleetService.injectStartupCommand falls back to the role's),
                        // so they need curtains too. One fetch for the whole team.
                        const { hasCommand } = await fetchPtyVisibleRoles();
                        for (const d of delegates) {
                            if (d && d.friendlyName) {
                                armStartupCurtain(d.friendlyName, hasCommand[d.role] === true);
                            }
                        }
                    }
                    // Members must be in fleetList before any seating: getGroupMembers()
                    // filters the group's stored names through a liveness set built from
                    // fleetList, so seating before this await resolves the team to its
                    // head alone — the original bug with a bigger grid.
                    await fetchTerminalList();

                    let seatFallbackReason = null;
                    if (delegates.length === 0) {
                        assignToFocusedPane(data.terminal.friendlyName);
                    } else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, data.terminal.friendlyName)) {
                        // Seated by the group lock — sized by the group's stored layout
                        // and paged by seatActiveGroupPage. Deliberately INSTEAD OF
                        // assignToFocusedPane: that helper drops the group lock (see the
                        // keepLock contract in terminal-sidebar-groupings-contract), which
                        // would undo the seating on the next reconcile.
                    } else {
                        seatFallbackReason = data.teamGroupId
                            ? 'its group did not load'
                            : 'no group was registered';
                        seatTeamWithoutGroup(data.terminal.friendlyName, delegates);
                    }

                    reportTeamStart(data, delegates, seatFallbackReason);
                } else if (data && data.error) {
                    console.error('[Terminals] Create rejected:', data.error);
                }
            }
        } catch (err) {
            console.error('[Terminals] Failed to create terminal:', err);
        }
    }

    /**
     * Pull the backend-registered team group into memory, then lock onto it.
     * Returns false when the group did not arrive, so the caller can seat the
     * team by hand instead.
     *
     * The presence check is NOT defensive padding: reloadTerminalGroups() ends
     * in `catch { }` and switchToGroup() early-returns on an unknown id, so an
     * unchecked pair fails silently — an unseated team with nothing on screen
     * to say so, which is the bug this whole change exists to remove.
     *
     * The reload must precede the switch: switchToGroup calls
     * saveLayoutSettings(), which writes the WHOLE in-memory terminalGroups
     * array back to `terminals.groups` and would clobber the group the backend
     * just registered.
     */
    async function switchToTeamGroup(groupId, headName) {
        await reloadTerminalGroups();
        if (!terminalGroups.some(g => g && g.id === groupId)) { return false; }
        switchToGroup(groupId);
        focusSeatedTerminal(headName);
        return true;
    }

    /**
     * Put the caret on the head after a team seat. switchToGroup rebuilds
     * paneAssignments but deliberately leaves focusedPaneIndex and
     * activeTerminalName alone — a tab click is navigation, not selection.
     * After a CREATE that is wrong: the operator's active terminal would stay
     * pointing at whatever was focused before, which the rebuild just pushed
     * off the grid, and every act-on-the-active-terminal path (drag-to-terminal,
     * paste, send prompt) would target something invisible.
     *
     * NOT assignToFocusedPane: that helper drops the group lock.
     */
    function focusSeatedTerminal(name) {
        const idx = paneAssignments.indexOf(name);
        if (idx < 0 || idx >= getSlotCount(effectiveLayout)) { return; }
        focusedPaneIndex = idx;
        activeTerminalName = name;
        renderSidebarList();
        renderPaneGrid();
    }

    /**
     * Seat a team when no group is available — wiring failed, or the group did
     * not load. Seats the team's OWN names, in team order, into free slots.
     *
     * Explicitly not fillEmptyPanes(): that helper fills in fleetList order with
     * no notion of this team, so on a busy fleet the free panes go to unrelated
     * terminals and the members stay invisible — the fallback reproducing the
     * bug it exists to prevent. Pinned slots and kanban panes are skipped for
     * the same reasons fillEmptyPanes skips them.
     *
     * Members that do not fit are left unseated; the caller's toast is the
     * honest channel for that (and for solo mode, where growLayoutForFleet
     * no-ops by design).
     */
    function seatTeamWithoutGroup(headName, delegates) {
        // Drop any group lock FIRST, exactly as assignToFocusedPane does on the
        // no-delegate path. Without this the fallback is a silent revert waiting
        // to happen: the only thing that would clear the lock is growLayoutForFleet's
        // setLayoutMode side effect, and that NO-OPS when the grid is already big
        // enough. So on a fleet with room to spare, activeGroupId stays pointing at
        // the operator's previous group — the tab strip shows THAT group as active
        // while its panes hold the team, applyLayoutFloor's banner counts the wrong
        // membership, and the next seatActiveGroupPage() (a resize tripping the
        // floor, a banner page click, promoteGroupMember) rebuilds paneAssignments
        // from the old group and evicts the team. That is the invisible-team bug
        // this plan exists to kill, restored inside its own fallback.
        activeGroupId = null;
        activeGroupPage = 0;
        const names = [headName, ...delegates.map(d => d && d.friendlyName).filter(Boolean)];
        growLayoutForFleet(names.length);
        const rendered = getSlotCount(effectiveLayout);
        const next = paneAssignments.slice();
        while (next.length < getMaxSlotCount()) { next.push(null); }
        let slot = 0;
        for (const name of names) {
            if (next.includes(name)) { continue; }
            while (slot < rendered && (next[slot] || pinnedPanes[slot] || paneModes[slot] === 'kanban')) { slot++; }
            if (slot >= rendered) { break; }
            next[slot++] = name;
        }
        paneAssignments = next;
        const headIdx = paneAssignments.indexOf(headName);
        if (headIdx >= 0 && headIdx < rendered) {
            focusedPaneIndex = headIdx;
            activeTerminalName = headName;
        }
        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    /**
     * Surface team start failures. The create response carries three
     * independent failure channels and the UI showed none of them, so a team
     * that half-spawned looked exactly like one that fully spawned. The fourth
     * (seatFallbackReason) is local: the team is on screen but not locked to
     * its group, so the next reconcile composes differently than the operator
     * expects.
     */
    function reportTeamStart(data, delegates, seatFallbackReason) {
        if (data.delegateError) {
            showPaneToast(`Team partially started: ${data.delegateError}`);
            return;
        }
        if (data.wiringError) {
            showPaneToast(`Team started but wiring failed: ${data.wiringError}`);
            return;
        }
        if (seatFallbackReason) {
            showPaneToast(`Team seated without its group — ${seatFallbackReason}.`);
        }
    }

    /**
     * Start a team explicitly by id — the first caller of the
     * instantiateAgentGroup path that was finished and never wired. The
     * definition is host-resolved (the verb rejects a wire-supplied group),
     * so only the team id is sent. Surfaces start failures verbatim: the
     * cap and PTY-unavailable errors the core returns are good messages that
     * previously reached nobody.
     *
     * `targetSpec` is the same workspace target the role picker uses, so a
     * team started from a group's `+` spawns into that group's workspace.
     */
    async function startTeam(team, targetSpec, opts) {
        const silent = opts && opts.silent;
        if (!team || !team.id) { return null; }
        try {
            const payload = { teamId: team.id };
            if (typeof targetSpec === 'string') {
                payload.cwd = targetSpec;
            } else if (targetSpec && typeof targetSpec === 'object') {
                if (targetSpec.parentRoot) { payload.parentRoot = targetSpec.parentRoot; }
                if (targetSpec.worktreePath) { payload.cwd = targetSpec.worktreePath; }
            }
            const res = await fetch('/terminals/verb/ptyStartTeam', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            // The LocalApiServer returns 502 (not 200) when success === false,
            // but the error body is still JSON — read it regardless of res.ok
            // so a cap refusal, double-start refusal, or PTY-unavailable message
            // reaches the operator verbatim instead of a generic "request failed".
            let data = null;
            try { data = await res.json(); } catch { /* non-JSON body */ }
            if (data && data.success) {
                // Arm curtains for the head and any delegates that carry a
                // startup command, then refresh the fleet list and seat the
                // whole team — same flow as createTerminal, applied to the team.
                const headName = data.terminal?.friendlyName || (data.created && data.created[0]);
                if (headName) { armStartupCurtain(headName, true); }
                const workers = Array.isArray(data.workers) ? data.workers : [];
                for (const w of workers) {
                    if (w?.friendlyName) { armStartupCurtain(w.friendlyName, true); }
                }
                // Members must be in fleetList before any seating: getGroupMembers()
                // filters the group's stored names through a liveness set built from
                // fleetList, so seating before this await resolves the team to its
                // head alone.
                await fetchTerminalList();

                // Same three branches as the create path. Deliberately NOT
                // assignToFocusedPane on the team branch: that helper drops the
                // group lock, which would undo the seating on the next reconcile.
                // The member-less case stays on assignToFocusedPane — wireSpawnedTeam
                // registers no group for a childless team, and locking a
                // one-terminal "team" into a group would be the opposite regression.
                let seatFallbackReason = null;
                if (!headName) {
                    // Nothing to seat — the warnings below are still delivered.
                } else if (workers.length === 0) {
                    assignToFocusedPane(headName);
                } else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, headName)) {
                    // Seated by the group lock — sized by the group's stored layout
                    // and paged by seatActiveGroupPage.
                } else {
                    seatFallbackReason = data.teamGroupId
                        ? 'its group did not load'
                        : 'no group was registered';
                    seatTeamWithoutGroup(headName, workers);
                }

                // NOT reportTeamStart: that helper reads data.wiringError, which is
                // the field the CREATE path sets, and it early-returns on the first
                // channel it finds. instantiateAgentGroupCore reports a wiring failure
                // as success:true plus `error`, and that failure is EXACTLY the case
                // that also forces the by-name seat — so an early-return chain would
                // tell the operator the wiring failed and never that the team is
                // unlocked from its group. Both notices must reach them, so the seat
                // note rides along instead of competing for the toast.
                const seatNote = seatFallbackReason
                    ? ` Team seated without its group — ${seatFallbackReason}.`
                    : '';
                const commandlessNote = Array.isArray(data.commandlessRoles) && data.commandlessRoles.length
                    ? ` No CLI configured for: ${data.commandlessRoles.join(', ')}. Those seats are bare shells; set a command in the AGENTS tab.`
                    : '';
                if (!silent) {
                    if (data.delegateError) {
                        showPaneToast(`Team started with a delegate warning: ${data.delegateError}${seatNote}${commandlessNote}`);
                    } else if (data.error) {
                        // Terminals created but wiring failed — surface it.
                        showPaneToast(`Team started with a warning: ${data.error}${seatNote}${commandlessNote}`);
                    } else if (seatNote || commandlessNote) {
                        showPaneToast(`${seatNote}${commandlessNote}`.trim());
                    }
                }
                return data;
            } else if (data && data.error) {
                // Verbatim start failure — cap refusal, double-start refusal,
                // PTY unavailable, missing team. These are the messages that
                // used to reach nobody because the path was unwired.
                if (!silent) {
                    showPaneToast(`Could not start team: ${data.error}`);
                }
                console.error('[Terminals] Team start rejected:', data.error);
                return data;
            } else {
                if (!silent) {
                    showPaneToast('Could not start team — the request failed.');
                }
                return data;
            }
        } catch (err) {
            console.error('[Terminals] Failed to start team:', err);
            if (!silent) {
                showPaneToast('Could not start team — a network error occurred.');
            }
            return null;
        }
    }

    /**
     * Role list and order copied from `allBuiltInAgents` in createAgentGrid
     * (src/extension.ts). `project_manager` has a visibility checkbox in the Agents
     * tab but is deliberately absent from that array, so it is absent here too —
     * this list mirrors what OPEN AGENT TERMINALS actually opens, not what the
     * Agents tab can toggle.
     */
    const GRID_BUILTIN_ROLES = [
        'planner', 'lead', 'coder', 'intern', 'reviewer', 'tester',
        'analyst', 'ticket_updater', 'researcher', 'claude_designer', 'phone_a_friend'
    ];

    /**
     * Fallback role -> column order for the sidebar's first paint. Mirrors
     * DEFAULT_KANBAN_COLUMNS in src/services/agentConfig.ts and must be kept in
     * lockstep with it (the new contract test enforces the match).
     */
    const KANBAN_ROLE_ORDER_FALLBACK = {
        researcher: 110,
        planner: 100,
        lead: 180,
        coder: 190,
        intern: 200,
        reviewer: 300,
        tester: 350,
        ticket_updater: 9000
    };
    roleOrderMap = { ...KANBAN_ROLE_ORDER_FALLBACK };

    async function resolveGridAgents() {
        const [savedVisibleData, savedCustom, savedPlannerCount] = await Promise.all([
            fetchPtyVisibleRoles(),
            loadSetting('agents.customAgents', []),
            loadSetting('agents.plannerTerminalCount', 1)
        ]);

        const custom = Array.isArray(savedCustom)
            ? savedCustom.filter(a => a && typeof a.role === 'string')
            : [];

        const visible = { ...savedVisibleData.visibleAgents };
        // Read off the SAME response as `visible`. fetchPtyVisibleRoles always
        // returns the pair (`{}` on its fallback path), so no per-role lookup can
        // throw — but the default must still be an object, because openAllTerminals
        // indexes it directly.
        const hasCommand = savedVisibleData.hasCommand || {};
        // A custom agent defaults to visible, matching getVisibleAgents.
        for (const agent of custom) { visible[agent.role] = true; }

        const plannerCount = Number(savedPlannerCount) > 1 ? Math.floor(Number(savedPlannerCount)) : 1;

        // role -> how many terminals that role should end up with.
        const wanted = new Map();
        for (const role of GRID_BUILTIN_ROLES) {
            if (visible[role] === false) { continue; }
            wanted.set(role, role === 'planner' ? plannerCount : 1);
        }
        for (const agent of custom) {
            if (visible[agent.role] === false) { continue; }
            wanted.set(agent.role, 1);
        }
        if (visible.jules !== false) { wanted.set('jules_monitor', 1); }
        return { wanted, hasCommand };
    }

    /**
     * Create `count` terminals of one role, sequentially, without seating them.
     * Mirrors the inner loop of openAllTerminals so both paths use the same naming,
     * startup-curtain arming, and adoption logic. Returns the number actually created.
     */
    async function createTerminalsForRole(role, count, hasStartupCommand, onCreated) {
        let created = 0;
        for (let i = 0; i < count; i++) {
            try {
                const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.success) {
                        created++;
                        if (data.terminal) {
                            if (!fleetList.some(t => t.friendlyName === data.terminal.friendlyName)) {
                                fleetList.push(data.terminal);
                            }
                            // Arm BEFORE the pane exists or the curtain paints one reconcile late.
                            armStartupCurtain(data.terminal.friendlyName, hasStartupCommand);
                            // Per-terminal hook, AFTER the arm: open-all seats here so
                            // each terminal appears as it is born instead of the whole
                            // batch landing seconds later, and the seat's renderPaneGrid()
                            // is what paints the curtain. Do not flip this order.
                            if (onCreated) { onCreated(data.terminal); }
                        }
                    } else if (data && data.error) {
                        console.warn(`[Terminals] createTerminalsForRole: ${role} rejected:`, data.error);
                    }
                }
            } catch (err) {
                console.warn(`[Terminals] createTerminalsForRole: failed to create ${role}:`, err);
            }
        }
        return created;
    }

    /**
     * "Open all" — the browser counterpart of switchboard.createAgentGrid.
     *
     * Only ever tops up: a role that already has enough live terminals is left
     * alone, so pressing this twice does not double the fleet. Startup commands are
     * NOT sent from here — ptyFleetService.create() injects the role's configured
     * command itself, and duplicating that would launch each agent CLI twice.
     */
    async function openAllTerminals() {
        const { wanted, hasCommand } = await resolveGridAgents();
        if (wanted.size === 0) {
            console.warn('[Terminals] Open all: no visible agent roles configured');
            return;
        }

        // Disarm the seed-on-first-load branch in sanitizePaneAssignments() before the
        // first create. That branch exists for page load, where the fleet is fetched in
        // one shot; here it is actively harmful. The gateway broadcasts terminalsChanged
        // from inside fleetService.create() — 750ms before the create response resolves
        // for any role with a startup command (SHELL_READINESS_DELAY_MS) — so the branch
        // fires on the refetch and seats terminal 1 through a completely different path
        // from terminals 2..N, at a completely different time. That is root cause A
        // (one instant pane, then a gap) and root cause B (a curtain armed into an
        // already-rendered pane) in a single line.
        //
        // AFTER the wanted.size guard, deliberately: a cockpit with every agent hidden
        // must not lose first-paint seeding for the rest of the page's life.
        initialAssignmentDone = true;

        const liveByRole = new Map();
        let liveCount = 0;
        for (const t of fleetList) {
            if (t.status === 'exited') { continue; }
            liveByRole.set(t.role, (liveByRole.get(t.role) || 0) + 1);
            liveCount++;
        }

        // Size the grid to the FINAL fleet before creating anything. Growing per
        // create would reflow the grid on every step (1 -> 2h -> 1x3 -> 2x2 -> 2x3),
        // refitting every live xterm each time. Counts existing terminals too: open-all
        // is a top-up, so `created` alone under-sizes the grid whenever the operator
        // already had panes open.
        let plannedTotal = liveCount;
        for (const [role, count] of wanted.entries()) {
            plannedTotal += Math.max(0, count - (liveByRole.get(role) || 0));
        }
        // Gate on there being something to create. Pressing the button on a fleet that
        // already exceeds the picked layout must NOT override that pick: the operator
        // may have collapsed to `1` on purpose, and the tail below persists only when
        // work happened — so an ungated grow would move the grid now and revert it on
        // reload. Grow only when new terminals are actually coming.
        const grew = plannedTotal > liveCount ? growLayoutForFleet(plannedTotal) : false;

        let created = 0;
        for (const [role, count] of wanted.entries()) {
            const missing = count - (liveByRole.get(role) || 0);
            if (missing > 0) {
                // Sequential per role: ptyFleetService.create() picks the next free
                // `${role}-${n}` name, so concurrent creates for the same role can
                // settle on the same name. The onCreated hook seats each terminal as it
                // is born; persist:false because saveLayoutSettings() is 11 POSTs and
                // the single call in the tail covers the whole batch.
                created += await createTerminalsForRole(
                    role, missing, hasCommand[role] === true,
                    () => { fillEmptyPanes({ persist: false }); }
                );
            }
        }

        // Keep this the FIRST fetchTerminalList call in the function:
        // multi-parent-terminals-contract.test.js:257 slices the open-all body from the
        // function header to this exact line and asserts the create payload inside it.
        await fetchTerminalList();
        if (created > 0 || grew) {
            // persist:false, then one explicit save. The trailing call normally finds
            // nothing unseated (the loop seated everything) and returns at its first
            // guard, so leaving persistence to it would drop the batch entirely; and
            // letting it persist AND calling saveLayoutSettings() would write 22 POSTs.
            const unseated = fillEmptyPanes({ persist: false });
            saveLayoutSettings();
            if (unseated > 0) {
                // Never silent. The old behaviour created six terminals, seated four,
                // and said nothing — which is what "why has this failed so hard" was
                // actually about.
                showPaneToast(`${unseated} terminal${unseated === 1 ? '' : 's'} could not be seated — open from the sidebar or pick a larger layout.`);
            }
        }
    }

    /**
     * Create enough terminals of `role` to fill `mode`'s slot count, then seat them.
     * Counts existing live terminals of that role from fleetList so re-running is a
     * no-op. The layout is switched first so the created terminals have somewhere to
     * sit, then they are created sequentially and the panes are filled once at the end.
     */
    async function fillGrid(role, mode) {
        if (!role || !LAYOUT_MODES.includes(mode)) {
            console.warn('[Terminals] Fill grid: bad role or mode', role, mode);
            return;
        }
        const slots = LAYOUTS[mode].slots;

        // Count live instances of this role from the same list the UI renders.
        let liveCount = 0;
        for (const t of fleetList) {
            if (t.status !== 'exited' && t.role === role) { liveCount++; }
        }
        const need = slots - liveCount;
        if (need <= 0) {
            showPaneToast(`${role} already has ${liveCount} live terminal${liveCount === 1 ? '' : 's'} — no grid to fill.`);
            return;
        }

        const { hasCommand } = await fetchPtyVisibleRoles();
        initialAssignmentDone = true;
        setLayoutMode(mode);
        await createTerminalsForRole(role, need, hasCommand[role] === true);
        await fetchTerminalList();
        const unseated = fillEmptyPanes();
        if (unseated > 0) {
            showPaneToast(`${unseated} terminal${unseated === 1 ? '' : 's'} could not be seated — choose a larger grid.`);
        }
    }

    /**
     * Seat unassigned terminals into whatever rendered panes are still empty.
     *
     * Returns the number of terminals still unseated, so the caller can tell the
     * operator instead of dropping them silently.
     *
     * opts.persist === false skips saveLayoutSettings(). Open-all calls this once per
     * create and persists once at the end; 11 setting POSTs per terminal is not a
     * cost worth paying six times over for a batch that settles in one place.
     */
    function fillEmptyPanes(opts) {
        const persist = !opts || opts.persist !== false;
        const slotCount = getSlotCount(effectiveLayout);
        // In team-scoped mode, only seat team members into empty panes.
        const candidateFleet = scopedFleet();
        const unseated = candidateFleet
            .filter(t => t.status !== 'exited' && !paneAssignments.includes(t.friendlyName))
            .map(t => t.friendlyName);
        if (unseated.length === 0) { return 0; }

        let changed = false;
        for (let i = 0; i < slotCount && unseated.length > 0; i++) {
            // A kanban-mode slot has no assignment but is NOT free: it is showing the
            // operator a live board column. Seating into it silently bulldozed that
            // pane on every Open All. Kanban panes are only ever displaced by an
            // explicit sidebar click with nowhere else to go (see the target scan).
            if (!paneAssignments[i] && paneModes[i] !== 'kanban') {
                paneAssignments[i] = unseated.shift();
                changed = true;
            }
        }
        if (!changed) { return unseated.length; }
        if (!activeTerminalName) { activeTerminalName = paneAssignments[focusedPaneIndex] || null; }
        if (persist) { saveLayoutSettings(); }
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
        return unseated.length;
    }

    async function renameTerminal(name, alias) {
        const next = (alias || '').trim();
        if (!next || next === name) { return; }
        cancelDetachTimer(name);
        cancelDetachTimer(next);
        try {
            const res = await fetch('/terminals/verb/ptyRenameTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, alias: next })
            });
            const data = res.ok ? await res.json() : null;
            if (data && data.success) {
                // Re-key rather than destroy: the gateway keeps the same scrollback
                // ring across a rename, so retaining this entry's lastSeq means the
                // reconnect replays only the tail instead of re-rendering the whole
                // 256 KB ring over a pane that already shows it — and an operator
                // who was scrolled up stays where they were.
                const entry = terminalsMap.get(name);
                if (entry) {
                    cancelDetachTimer(name);
                    terminalsMap.delete(name);
                    entry.name = next;
                    terminalsMap.set(next, entry);
                    // The affordance is stamped with the old name; clear it so it
                    // does not linger on the pane under the new name (the sweep
                    // re-evaluates under `next` on its next tick).
                    clearWorkingSilence(name);
                    // The other name-keyed client collection. An in-flight ladder for
                    // the old name self-terminates (its terminalsMap lookup misses),
                    // but its generation counter is only ever cleaned by
                    // destroyTerminalView under the key it was filed at — which the
                    // re-key just made unreachable. Move it rather than orphan one
                    // entry per rename for the life of the tab.
                    if (fitLadderGen.has(name)) {
                        fitLadderGen.set(next, fitLadderGen.get(name));
                        fitLadderGen.delete(name);
                    }
                    // Not `entry.term` alone: reconnecting an exited terminal makes
                    // setupClient re-send {t:'exit'} (terminalWsGateway.ts:633-635),
                    // printing a SECOND "[Process Exited]" line under the one the
                    // pane already shows. A dead pty has nothing to reconnect to.
                    if (entry.term && !entry.exited) {
                        connectTerminalSocket(entry);
                    }
                } else {
                    destroyTerminalView(name);
                }
                for (let i = 0; i < paneAssignments.length; i++) {
                    if (paneAssignments[i] === name) { paneAssignments[i] = next; }
                }
                for (const g of terminalGroups) {
                    if (g.source !== 'manual') { continue; }
                    for (const key of ['members', 'order']) {
                        const arr = g[key];
                        if (Array.isArray(arr)) {
                            for (let i = 0; i < arr.length; i++) {
                                if (arr[i] === name) { arr[i] = next; }
                            }
                        }
                    }
                }
                if (activeTerminalName === name) { activeTerminalName = next; }
                if (peekTerminalName === name) { peekTerminalName = next; }
                // The undo snapshot must follow the rename too. Left alone it holds the
                // OLD name, which sanitizePaneAssignments cannot see (the live slots now
                // carry the new one), so Undo would restore a name with no session.
                if (undoSnapshot) {
                    undoSnapshot.slots = undoSnapshot.slots.map(n => (n === name ? next : n));
                    if (undoSnapshot.name === name) { undoSnapshot.name = next; }
                    if (undoSnapshot.displaced === name) { undoSnapshot.displaced = next; }
                }
                if (terminalBadges.has(name)) {
                    terminalBadges.set(next, terminalBadges.get(name));
                    terminalBadges.delete(name);
                }
                // The gap set is keyed by friendlyName like terminalBadges; without this
                // a rename strands the GAP badge on the old name with no terminal behind it.
                if (terminalReplayGaps.has(name)) {
                    terminalReplayGaps.delete(name);
                    terminalReplayGaps.add(next);
                }
                // The curtain map is keyed by friendlyName like terminalsMap; without this a
                // rename mid-boot strands the overlay with no timer able to find its node. The
                // dataset stamps are re-pointed in the same block: the sidebar row is rebuilt by
                // the fetchTerminalList() below and picks up the new name, but the curtain node
                // in the pane is not re-created, so its stamp has to be moved by hand.
                const curtain = startupCurtains.get(name);
                if (curtain) {
                    startupCurtains.delete(name);
                    startupCurtains.set(next, curtain);
                    if (paneGridEl) {
                        const sel = `.startup-curtain[data-terminal="${cssAttrEscape(name)}"]`;
                        paneGridEl.querySelectorAll(sel).forEach(el => { el.dataset.terminal = next; });
                    }
                }
                saveLayoutSettings();
            }
            await fetchTerminalList();
        } catch (err) {
            console.error('[Terminals] Failed to rename terminal:', err);
        }
    }

    function beginInlineRename(nameEl, currentName) {
        const input = document.createElement('input');
        input.className = 'item-name-input';
        input.value = currentName;
        let settled = false;
        const commit = (apply) => {
            if (settled) { return; }
            settled = true;
            const next = input.value;
            if (input.parentNode) { input.parentNode.replaceChild(nameEl, input); }
            if (apply) { renameTerminal(currentName, next); }
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { commit(true); }
            else if (e.key === 'Escape') { commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
        input.addEventListener('click', (e) => e.stopPropagation());
        nameEl.parentNode.replaceChild(input, nameEl);
        input.focus();
        input.select();
    }

    async function closeTerminal(name) {
        try {
            await fetch('/terminals/verb/ptyCloseTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            destroyTerminalView(name);
            for (let i = 0; i < paneAssignments.length; i++) {
                if (paneAssignments[i] === name) { paneAssignments[i] = null; }
            }
            if (activeTerminalName === name) { activeTerminalName = null; }
            dismissStartupCurtain(name);
            terminalBadges.delete(name);
            terminalReplayGaps.delete(name);
            saveLayoutSettings();
            await fetchTerminalList();
        } catch (err) {
            console.error('[Terminals] Failed to close terminal:', err);
        }
    }

    async function clearTerminal(name) {
        try {
            await fetch('/terminals/verb/ptyClearTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const badgeChanged = terminalBadges.delete(name);
            const gapChanged = terminalReplayGaps.delete(name);
            if (badgeChanged || gapChanged) { renderSidebarList(); renderPaneGrid(); }
        } catch (err) {
            console.error('[Terminals] Failed to clear terminal:', err);
        }
    }

    async function sendModelCommand(name) {
        try {
            await fetch('/terminals/verb/ptySendModel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
        } catch (err) {
            console.error('[Terminals] Failed to send /model to terminal:', err);
        }
    }

    async function clearAllTerminals() {
        try {
            await fetch('/terminals/verb/ptyClearAllTerminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            // Only re-render if a badge or gap actually went away. renderPaneGrid() empties the
            // grid and reparents every live xterm container — too much teardown to run
            // for no visual change, and the clear itself alters no pane state.
            if (terminalBadges.size > 0 || terminalReplayGaps.size > 0) {
                terminalBadges.clear();
                terminalReplayGaps.clear();
                renderSidebarList();
                renderPaneGrid();
            }
        } catch (err) {
            console.error('[Terminals] Failed to clear all terminals:', err);
        }
    }

    // ─── Team Action Bar: bulk lifecycle verbs ───────────────────────────
    //
    // The fan-out helper and the five team-wide verbs below compose existing
    // per-terminal verbs client-side, per the plan's "compose, do not add
    // backend verbs" approach. No confirm gates anywhere (per CLAUDE.md).

    /**
     * Concurrency cap for team fan-out. Bounds simultaneous requests to avoid
     * overwhelming the local API server while keeping fan-out responsive for
     * typical team sizes (3–9 members). Four lets a 4-member team fire in one
     * wave; a 9-member team settles in three.
     */
    const TEAM_FANOUT_CONCURRENCY = 4;

    /**
     * Fan-out helper: iterate `names` calling `fn(name)` with a concurrency
     * cap of TEAM_FANOUT_CONCURRENCY. Returns an array of per-member results:
     * `{ name, ok, error?, returnValue? }`. A name that is gone by the time
     * its turn comes up simply fails and is reported.
     */
    async function teamFanOut(names, fn) {
        const results = [];
        let index = 0;
        async function worker() {
            while (index < names.length) {
                const myIndex = index++;
                const name = names[myIndex];
                try {
                    const ret = await fn(name);
                    results.push({ name, ok: true, returnValue: ret });
                } catch (err) {
                    results.push({ name, ok: false, error: err.message || String(err) });
                }
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(TEAM_FANOUT_CONCURRENCY, names.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results;
    }

    /**
     * Re-read the scoped team group at the start of each action. Returns a
     * shallow snapshot or null if the team no longer exists. A concurrent
     * upsert (re-spawn) cannot mutate the snapshot mid-action.
     */
    function getScopedTeamSnapshot() {
        const group = getScopedTeamGroup();
        if (!group) { return null; }
        return {
            id: group.id,
            name: group.name,
            shortName: group.shortName,
            head: teamHeadName(group),
            members: Array.isArray(group.members) ? [...group.members] : [],
            order: Array.isArray(group.order) ? [...group.order] : [],
            definitionId: group.definitionId || '',
            source: group.source,
        };
    }

    /**
     * Report fan-out results as a toast. "cleared 3 of 4" style — per-member
     * error reporting for free, the advantage of the client-side loop.
     */
    function reportFanOutResults(results, verb) {
        const ok = results.filter(r => r.ok).length;
        const total = results.length;
        if (ok === total) {
            showPaneToast(`${verb} ${ok} member${ok === 1 ? '' : 's'}`);
        } else {
            const failed = results.filter(r => !r.ok);
            const failedNames = failed.map(r => r.name).join(', ');
            showPaneToast(`${verb} ${ok} of ${total} — ${failedNames} did not respond`);
        }
    }

    /** CLEAR TEAM — /clear to every member. */
    async function clearTeam() {
        const snap = getScopedTeamSnapshot();
        if (!snap) { return; }
        const liveMembers = snap.members.filter(n => {
            const t = fleetList.find(ft => ft.friendlyName === n);
            return t && t.status !== 'exited';
        });
        if (liveMembers.length === 0) { showPaneToast('No live members to clear'); return; }
        const results = await teamFanOut(liveMembers, (name) =>
            fetch('/terminals/verb/ptyClearTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            }).then(res => { if (!res.ok) { throw new Error(`HTTP ${res.status}`); } })
        );
        let changed = false;
        for (const r of results) {
            if (r.ok && (terminalBadges.delete(r.name) || terminalReplayGaps.delete(r.name))) {
                changed = true;
            }
        }
        if (changed) { renderSidebarList(); renderPaneGrid(); postFleetStateToShell(); }
        reportFanOutResults(results, 'Cleared');
    }

    /** CLEAR MEMBERS — /clear to every member except the head. */
    async function clearTeamMembers() {
        const snap = getScopedTeamSnapshot();
        if (!snap) { return; }
        const headName = snap.head;
        const liveMembers = snap.members.filter(n => {
            if (n === headName) { return false; }
            const t = fleetList.find(ft => ft.friendlyName === n);
            return t && t.status !== 'exited';
        });
        if (liveMembers.length === 0) { showPaneToast('No live non-head members to clear'); return; }
        const results = await teamFanOut(liveMembers, (name) =>
            fetch('/terminals/verb/ptyClearTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            }).then(res => { if (!res.ok) { throw new Error(`HTTP ${res.status}`); } })
        );
        let changed = false;
        for (const r of results) {
            if (r.ok && (terminalBadges.delete(r.name) || terminalReplayGaps.delete(r.name))) {
                changed = true;
            }
        }
        if (changed) { renderSidebarList(); renderPaneGrid(); postFleetStateToShell(); }
        reportFanOutResults(results, 'Cleared');
    }

    /** CLOSE TEAM — end every member's process immediately, no confirmation. */
    async function closeTeam() {
        const snap = getScopedTeamSnapshot();
        if (!snap) { return; }
        const liveMembers = snap.members.filter(n => {
            const t = fleetList.find(ft => ft.friendlyName === n);
            return t && t.status !== 'exited';
        });
        if (liveMembers.length === 0) { showPaneToast('No live members to close'); return; }
        const results = await teamFanOut(liveMembers, async (name) => {
            await fetch('/terminals/verb/ptyCloseTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            destroyTerminalView(name);
            for (let i = 0; i < paneAssignments.length; i++) {
                if (paneAssignments[i] === name) { paneAssignments[i] = null; }
            }
            if (activeTerminalName === name) { activeTerminalName = null; }
            dismissStartupCurtain(name);
            terminalBadges.delete(name);
            terminalReplayGaps.delete(name);
        });
        saveLayoutSettings();
        await fetchTerminalList();
        const ok = results.filter(r => r.ok).length;
        const total = results.length;
        const teamDefId = snap.definitionId;
        showPaneToast(
            `Closed ${ok} of ${total} member${total === 1 ? '' : 's'}`,
            () => {
                if (teamDefId) {
                    startTeam({ id: teamDefId }, undefined);
                } else {
                    showPaneToast('Team definition not found — cannot restart');
                }
            }
        );
    }

    /**
     * RESTART MISSING — re-spawn only the dead members from the current
     * definition's roster. Uses the definition's member specs (role, count,
     * label, startupCommand) rather than cloning terminal names. A member
     * removed from the definition and then exited is NOT restarted.
     *
     * If the head itself is exited, calls startTeam (the whole team restarts
     * — the backend's double-start guard only refuses when the head is live).
     * If only non-head members are exited, creates individual terminals with
     * the right role and workspace, then updates the group's members/order.
     */
    async function restartMissingMembers() {
        const snap = getScopedTeamSnapshot();
        if (!snap) { return; }

        const definitions = await fetchAgentGroups();
        const def = definitions.find(d => d.id === snap.definitionId);
        if (!def) {
            showPaneToast('Team definition no longer exists — cannot restart missing members');
            return;
        }

        const headName = snap.head;
        const headTerm = headName ? fleetList.find(t => t.friendlyName === headName) : null;
        const headExited = !headTerm || headTerm.status === 'exited';

        if (headExited) {
            const anyTerm = fleetList.find(t => snap.members.includes(t.friendlyName));
            const targetSpec = anyTerm && anyTerm.parentRoot
                ? { parentRoot: anyTerm.parentRoot }
                : undefined;
            await startTeam({ id: def.id }, targetSpec);
            showPaneToast('Head was exited — restarted entire team');
            return;
        }

        const liveMembers = snap.members
            .filter(n => n !== headName)
            .map(n => fleetList.find(t => t.friendlyName === n))
            .filter(t => t && t.status !== 'exited');
        const liveCounts = new Map();
        for (const terminal of liveMembers) {
            const role = normalizeAgentRoleKey(terminal.role);
            liveCounts.set(role, (liveCounts.get(role) || 0) + 1);
        }
        const restartSpecs = [];
        for (const member of Array.isArray(def.members) ? def.members : []) {
            const role = String(member?.role || '').trim();
            if (!role) { continue; }
            const key = normalizeAgentRoleKey(role);
            const desired = Math.max(Number(member?.count) || 1, 1);
            const present = liveCounts.get(key) || 0;
            const missing = Math.max(desired - present, 0);
            liveCounts.set(key, present + missing);
            for (let i = 0; i < missing; i++) { restartSpecs.push({ role }); }
        }
        if (restartSpecs.length === 0) {
            showPaneToast('All members in the current definition are live');
            return;
        }

        const targetSpec = headTerm && headTerm.parentRoot
            ? { parentRoot: headTerm.parentRoot }
            : undefined;

        const results = await teamFanOut(restartSpecs.map((spec, index) => ({ ...spec, index })), async (spec) => {
            const payload = { role: spec.role };
            if (targetSpec && targetSpec.parentRoot) {
                payload.parentRoot = targetSpec.parentRoot;
            }
            const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!data.success) { throw new Error(data.error || 'Create failed'); }
            return data.terminal?.friendlyName;
        });

        const newNames = results.filter(r => r.ok && r.returnValue).map(r => r.returnValue);

        if (newNames.length > 0) {
            const group = getScopedTeamGroup();
            if (group) {
                const retained = snap.members.filter(name => {
                    if (name === headName) { return true; }
                    const terminal = fleetList.find(t => t.friendlyName === name);
                    return terminal && terminal.status !== 'exited';
                });
                group.members = [...new Set([...retained, ...newNames])];
                const retainedSet = new Set(group.members);
                group.order = [
                    ...(Array.isArray(group.order) ? group.order.filter(name => retainedSet.has(name)) : []),
                    ...newNames.filter(name => !Array.isArray(group.order) || !group.order.includes(name))
                ];
                saveLayoutSettings();
            }
        }

        await fetchTerminalList();
        const ok = newNames.length;
        const total = restartSpecs.length;
        if (ok === total) {
            showPaneToast(`Restarted ${ok} missing member${ok === 1 ? '' : 's'}`);
        } else {
            showPaneToast(`Restarted ${ok} of ${total} — see console for details`);
        }
    }

    /** RELEASE HELD CARDS — release cards held by this team with no completion post. */
    async function releaseTeamHeldCards() {
        const snap = getScopedTeamSnapshot();
        if (!snap || !snap.head) { return; }
        try {
            const res = await fetch('/kanban/team/release', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: snap.head })
            });
            if (!res.ok) {
                showPaneToast(`Release failed: HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            if (!data.success) {
                showPaneToast(`Release failed: ${data.error || 'unknown error'}`);
                return;
            }
            const released = Array.isArray(data.released) ? data.released : [];
            const failed = Array.isArray(data.failed) ? data.failed : [];
            const releasedSeats = Array.isArray(data.releasedSeats) ? data.releasedSeats : [];

            let changed = false;
            for (const seat of releasedSeats) {
                if (terminalBadges.delete(seat)) { changed = true; }
                terminalReplayGaps.delete(seat);
            }

            if (changed) {
                renderSidebarList();
                renderPaneGrid();
                postFleetStateToShell();
            }

            if (failed.length === 0) {
                showPaneToast(`Released ${released.length} held card${released.length === 1 ? '' : 's'}`);
            } else {
                showPaneToast(`Released ${released.length} card${released.length === 1 ? '' : 's'}, ${failed.length} failed`);
            }
        } catch (err) {
            console.error('[Terminals] Failed to release team held cards:', err);
            showPaneToast(`Release failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            await fetchTerminalList();
        }
    }

    /** CLEAR BADGES — acknowledge every member's completion light at once. */
    function clearTeamBadges() {
        const snap = getScopedTeamSnapshot();
        if (!snap) { return; }
        let changed = false;
        for (const name of snap.members) {
            if (terminalBadges.delete(name)) { changed = true; }
            terminalReplayGaps.delete(name);
        }
        if (changed) {
            renderSidebarList();
            renderPaneGrid();
            postFleetStateToShell();
            showPaneToast('Cleared all team badges');
        } else {
            showPaneToast('No badges to clear');
        }
    }

    /**
     * Reorder the team roster. Writes the new `order` back onto the group
     * record via the existing `terminals.groups` save path, then re-seats.
     * `newOrder` must be a permutation of the existing `order` — never adds,
     * never drops. The caller (drag-to-reorder handler) produces the
     * permutation; this function validates and persists it.
     */
    async function reorderTeamRoster(newOrder) {
        const group = getScopedTeamGroup();
        if (!group || !Array.isArray(group.order)) { return; }
        const oldOrder = group.order;
        const oldSet = new Set(oldOrder);
        const newSet = new Set(newOrder);
        if (oldSet.size !== newSet.size || [...oldSet].some(n => !newSet.has(n))) {
            showPaneToast('Roster changed — reordering cancelled');
            await reloadTerminalGroups();
            renderSidebarList();
            return;
        }
        const storedGroups = await loadSetting('terminals.groups', []);
        const storedGroup = Array.isArray(storedGroups) ? storedGroups.find(g => g && g.id === group.id) : null;
        if (!storedGroup || JSON.stringify(storedGroup.order) !== JSON.stringify(oldOrder)) {
            showPaneToast('Roster changed — reordering cancelled');
            await reloadTerminalGroups();
            renderSidebarList();
            return;
        }
        group.order = [...newOrder];
        storedGroup.order = [...newOrder];
        await saveSetting('terminals.groups', storedGroups, storedGroups.map(g => g && g.id).filter(Boolean));
        if (activeGroupId === group.id) {
            switchToGroup(group.id, { keepPage: true });
        }
        renderSidebarList();
    }

    /**
     * Disable-and-relabel for the 600 ms a /clear takes to land, matching the
     * sidebar's `clear` → `clearing` treatment. `restoreLabel` is optional so the
     * toolbar buttons (which have no transient label) keep working unchanged.
     */
    function withClearingFeedback(btn, run, restoreLabel) {
        if (btn.disabled) { return; }
        btn.disabled = true;
        if (restoreLabel) { btn.textContent = restoreLabel.length <= 1 ? '…' : 'clearing'; }
        run();
        setTimeout(() => {
            btn.disabled = false;
            if (restoreLabel) { btn.textContent = restoreLabel; }
        }, 600);
    }

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

    /**
     * Force the terminal's DEC private modes to the gateway's recorded state.
     * Returns true when something was actually written.
     *
     * Written DIRECTLY to the parser, not via the rAF-batched write queue: that path
     * is billed to pendingAckChars via onWriteParsed, and synthetic characters the
     * server never credited would corrupt the backpressure ledger. DECSET/DECRST
     * generate no answerback, so this cannot provoke a reply and needs no
     * suppression window.
     *
     * A mode the server never observed is absent from `modes` and is left at xterm's
     * default — asserting a mode nobody ruled on is how you CREATE this bug.
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

    const pendingBatchEntries = new Set();
    let sharedBatchRafId = null;
    let sharedBatchFallbackTimer = null;

    function destroyTerminalView(name) {
        cancelDetachTimer(name);
        fitLadderGen.delete(name);
        clearWorkingSilence(name);
        const entry = terminalsMap.get(name);
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
        terminalsMap.delete(name);
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
            firstFrameAt: 0
        };
        terminalsMap.set(name, entry);
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
                showPaneToast('Image too large (max 4 MB)');
                return;
            }

            showPaneToast('Pasting image...');
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
                    showPaneToast('Image paste failed: ' + (data.error || 'unknown error'));
                }
                // On success, the file path is already injected into the PTY by
                // the server. The path appears on the terminal input line; user
                // presses Enter to submit.
            } catch (err) {
                showPaneToast('Image paste failed: ' + (err.message || String(err)));
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

        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // The box collapsed — Peek hiding a sibling pane, or the pane losing
                // its assignment. Withdraw before returning, or the gateway keeps
                // clamping the shared pty to a viewport nobody can see.
                if (!isRendered(entry.container)) {
                    releaseSizeVote(entry);
                    armRendererRelease(entry);
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
                // `active` is pane ASSIGNMENT, not visibility — a hidden panel's panes
                // are still "active". inspectPaneFit/fitAndReportSize gate on actually
                // having a box.
                if (entry.container.classList.contains('active')) {
                    startFitLadder(entry.name);
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
            clearCaretRing();
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
        term.textarea.addEventListener('blur', () => clearCaretRing());

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
                    const role = fleetList.find(t => t.friendlyName === entry.name)?.role || '';
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
                                const role = fleetList.find(t => t.friendlyName === entry.name)?.role || '';
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
                notifyInputDropped(entry);
            }
        });

        connectTerminalSocket(entry);

        // A view is built lazily (whenRendered), so a locate/assign that triggered
        // this construction has already run its focus attempt against a null term.
        // Pick the caret up here if this terminal landed in the focused pane.
        if (paneAssignments[focusedPaneIndex] === entry.name) {
            focusPaneTerminal(focusedPaneIndex);
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

        let wsUrl = `${PTY_HOST_ORIGIN}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
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
        refreshInputState(entry.name);

        ws.onopen = () => {
            entry.reconnectDelay = 500;
            // A throttle flag left stranded by a socket that died mid-paste would
            // keep the chip reading "paste queued" forever — the gateway's
            // throttled:false frame for that queue will never arrive. Cleared here
            // and in ws.onclose.
            entry.inputThrottled = false;
            entry.queuedBytes = 0;
            refreshInputState(entry.name);
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
                            if (workingSilenceShown.has(entry.name)) { clearWorkingSilence(entry.name); }
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
                            if (workingSilenceShown.has(entry.name)) { clearWorkingSilence(entry.name); }
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
                        markReplayGap(entry.name);
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
                    refreshInputState(entry.name);
                } else if (frame.t === 'error') {
                    // State first, notification second. A throw inside the toast path
                    // must not be able to leave a dead terminal accepting input — the
                    // onmessage catch swallows it into a console.warn.
                    dismissStartupCurtain(entry.name);
                    clearWorkingSilence(entry.name);
                    entry.exited = true;
                    if (entry.term) { entry.term.options.disableStdin = true; }
                    refreshInputState(entry.name);
                    showTerminalErrorToast(entry.name, frame.message || 'Terminal unavailable');
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
                        dismissStartupCurtain(entry.name);
                        clearWorkingSilence(entry.name);
                        const exitCode = typeof frame.code === 'number' ? frame.code : 0;
                        entry.exited = true;
                        entry.term.write(`\r\n\x1b[31m[Process Exited with code ${exitCode}]\x1b[0m\r\n`);
                        entry.term.options.disableStdin = true;
                        refreshInputState(entry.name);
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
            refreshInputState(entry.name);
            const item = fleetList.find(i => i.friendlyName === entry.name);
            if (item && item.status === 'active') {
                if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
                const delay = entry.reconnectDelay || 500;
                entry.reconnectDelay = Math.min(30000, Math.round(delay * 1.5));
                entry.reconnectTimer = setTimeout(() => {
                    if (terminalsMap.has(entry.name)) {
                        connectTerminalSocket(entry);
                    }
                }, delay);
            }
        };
    }

    function scheduleBatchFlush(entry) {
        if (!entry) return;
        bumpStartupCurtain(entry.name);
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
        if (!entry || entry.disposed || !entry.term) { return; }
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

    window.__sbTerminalStats = function() {
        const stats = {};
        for (const [name, entry] of terminalsMap.entries()) {
            stats[name] = {
                // Renderer identity, not decoration: a pane that silently dropped to
                // canvas has lost a WebGL context, and the browser's context cap is
                // per PROCESS while our MAX_WEBGL_CONTEXTS ceiling is per DOCUMENT —
                // so a popped-out second panel cannot see the main window's usage and
                // both believe they are well under the limit. Reading this in each
                // window is how that gets diagnosed without catching a console warning
                // at the exact moment it fires.
                isWebgl: entry.isWebgl === true,
                rendererDeferred: entry.rendererDeferred === true,
                cols: entry.term ? entry.term.cols : null,
                rows: entry.term ? entry.term.rows : null,
                lastSeq: entry.lastSeq,
                batchQueueLength: entry.batchQueue ? entry.batchQueue.length : 0,
                pendingAckChars: entry.pendingAckChars || 0,
                ackSuppressChars: entry.ackSuppressChars || 0,
                replayGapped: terminalReplayGaps.has(name),
                bytesWritten: entry.bytesWritten || 0,
                writeThrowCount: entry.writeThrowCount || 0,
                largestInputDataLen: entry.largestInputDataLen || 0,
                totalInputChars: entry.totalInputChars || 0
            };
        }
        return stats;
    };

    /**
     * Workspace-wide completion push. Delivered to EVERY subscribed connection by
     * design (SURFACES.common), which includes every `?solo=<name>` pop-out — each one
     * is a full second copy of this document, not a lightweight view. Without the
     * guard below, one completion produced one toast per open window, and each pop-out
     * also ran a badge write, two re-renders and a ptyListTerminals refetch for a
     * terminal it does not display.
     *
     * The COCKPIT owns this notice. It is the document that renders the sidebar DONE
     * chip and relays the rail state, and it is guaranteed to exist whenever a pop-out
     * does (shell.js opens pop-outs from it). A pop-out showing the completed terminal
     * has that terminal's own output in front of the operator, which is a stronger
     * signal than a toast summarising it.
     *
     * Deliberately NOT applied to showTerminalErrorToast: that fires from a specific
     * terminal's own socket, so it only reaches documents attached to that terminal —
     * already correctly scoped.
     */
    function handleAgentCompleted(msg) {
        if (soloTerminalName) { return; }
        const { planTitle, role, terminalName, worktreePath } = msg;

        // The host resolves terminalName from the plan's dispatched_terminal column and
        // already falls back to a role+worktree fleet match. This client-side pass is the
        // last resort (host too old to send either field). It scopes by worktree first —
        // three coders in three checkouts all match on role alone, so a role-only match
        // would badge whichever happened to be listed first.
        let targetTerm = terminalName;
        if (!targetTerm && role) {
            const match = (worktreePath && fleetList.find(t => t.worktreePath === worktreePath && t.role === role))
                || (worktreePath && fleetList.find(t => t.worktreePath === worktreePath))
                || (!worktreePath && fleetList.find(t => t.role === role));
            if (match) targetTerm = match.friendlyName;
        }

        if (targetTerm) {
            terminalBadges.set(targetTerm, { label: 'DONE', stamp: ++badgeStampSeq });
            const isKnown = fleetList.some(t => t.friendlyName === targetTerm);
            if (!isKnown) {
                fetchTerminalList();
            }
            renderSidebarList();
            renderPaneGrid();
            postFleetStateToShell();

            // Unconditional refetch: the completion clear has nulled dispatched_at,
            // so this retires the plan strip in the same beat as the DONE badge.
            fetchTerminalList();
        }

        // The in-panel toast is the ONLY completion notice. There was a native
        // `new Notification(...)` here behind an "OS Notifications" checkbox,
        // firing immediately after this toast with the same role and the same
        // plan title — a duplicate of the notice the operator had already been
        // given. Do not reintroduce it.
        showCompletionToast(planTitle || 'Agent Task', role || 'Agent', targetTerm, msg.planCount);
    }

    /** Completion toasts do not stack: a rolling batch would otherwise fill the
     *  container with identical notices, which is the same spam in different pixels.
     *  Error toasts (.is-error) are a different signal and are never evicted here. */
    function showCompletionToast(title, role, termName, planCount) {
        if (!toastContainerEl) { return; }
        toastContainerEl
            .querySelectorAll('.completion-toast:not(.is-error)')
            .forEach(el => el.remove());

        const toast = document.createElement('div');
        toast.className = 'completion-toast';

        const content = document.createElement('div');
        content.className = 'toast-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = `Completed: ${role}`;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        // planCount is the size of the agent's whole TURN, supplied by the engine.
        // Additive on the wire — an older host omits it, and a single-plan turn is the
        // common case, so both fall through to the plain title.
        const n = Number(planCount);
        const scope = Number.isFinite(n) && n > 1 ? `${title} +${n - 1} more` : title;
        bodyEl.textContent = scope + (termName ? ` (${termName})` : '');

        content.appendChild(titleEl);
        content.appendChild(bodyEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        });

        toast.appendChild(content);
        toast.appendChild(closeBtn);
        toastContainerEl.appendChild(toast);

        // 4s, not 8s. The sidebar chip is the durable record and the rail carries the
        // cross-panel signal, so the toast only has to be SEEN, not read twice.
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4000);
    }

    /** Transient, dismissible terminal failure notice. Deliberately NOT a line in
     *  the buffer: see the prohibition on notifyInputDropped. Mirrors
     *  showCompletionToast's DOM so the two share every .toast-* rule. */
    function showTerminalErrorToast(termName, message) {
        if (!toastContainerEl) { return; }
        const toast = document.createElement('div');
        toast.className = 'completion-toast is-error';

        const content = document.createElement('div');
        content.className = 'toast-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = `Terminal error: ${termName}`;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        // textContent, never innerHTML — frame.message comes off the wire.
        bodyEl.textContent = message;

        content.appendChild(titleEl);
        content.appendChild(bodyEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        });

        toast.appendChild(content);
        toast.appendChild(closeBtn);
        toastContainerEl.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
        }, 8000);
    }

    function applyThemeToAllTerminals(theme) {
        // Body class first: buildTerminalTheme reads the CSS variables it selects,
        // so recolouring before the swap would just re-read the outgoing theme.
        setThemeBodyClass(theme);
        updateCurtainVisuals();
        const nextTheme = buildTerminalTheme();
        for (const entry of terminalsMap.values()) {
            if (entry.term) {
                entry.term.options.theme = nextTheme;
            }
        }
    }

    function debounce(fn, ms) {
        let timer = null;
        return function(...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fn.apply(this, args);
            }, ms);
        };
    }

    // ─── Link-up modal ────────────────────────────────────────────────────
    // A sidebar-only surface that instructs one agent terminal to message
    // another. The operator is NOT messaging the child directly — they are
    // instructing the parent agent to do it, because the parent holds the
    // context worth handing over. See the plan file for the full rationale.

    // Client mirror of the link-preset vocabulary. Keep these in sync with
    // src/services/linkPresets.ts — the contract test
    // (src/test/link-presets-mirror-contract.test.js) enforces that the two
    // copies have identical ids, labels, templates and directions.
    /**
     * Link-up instruction presets. The point of each one is to be a BETTER
     * instruction than what an operator types in a hurry: it states the
     * relationship, what triggers a hand-off, and that the parent keeps working —
     * the three things a terse "you're the researcher" leaves out and the agent
     * therefore gets wrong.
     *
     * Ordered by expected use. The first entry is the default, so the modal opens
     * send-ready.
     *
     * `label` is STATIC — see the Superseded callout in this plan. The child's real
     * name appears in the resolved text, which is where it is load-bearing; the
     * adjacent #link-child select already names it before the operator picks.
     *
     * `direction` is load-bearing: 'member-receives' means the order is installed
     * ON the member ABOUT the head; 'head-receives' means ON the head ABOUT the
     * member. Inferring it is how the orientation gets flipped silently.
     *
     * Single-quoted concatenation, NOT template literals: preset prose must never be
     * evaluated, and `{child}` / `{parent}` are substituted by resolvePreset().
     */
    const LINK_PRESETS = [
        {
            id: 'researcher',
            label: 'Researcher — it researches for me',
            direction: 'head-receives',
            template:
                '{child} is your researcher. When you hit a question that needs external sources, ' +
                'documentation or API details you do not already have, hand it to {child} with enough ' +
                'context to work standalone — it cannot see your conversation. Keep working on what you ' +
                'can while it runs, and fold its answer in when it comes back. Do not block on it.'
        },
        {
            id: 'reviewer',
            label: 'Reviewer — it reviews my work',
            direction: 'head-receives',
            template:
                '{child} is your reviewer. When you finish a self-contained unit of work, hand {child} ' +
                'a summary of what changed and which files — it cannot see your conversation, so make ' +
                'the summary stand on its own — and ask it to review before you move on to the next ' +
                'unit. Address what it raises rather than deferring it.'
        },
        {
            id: 'handoff',
            label: 'Hand off — give it my context',
            direction: 'head-receives',
            template:
                'Hand over the full context of what you are working on to {child}: the goal, what you have ' +
                'done so far, what is left, and any decisions or dead ends that matter. {child} has no ' +
                'visibility into your conversation, so write it to be picked up cold.'
        },
        {
            id: 'second-opinion',
            label: 'Second opinion — ask it before I decide',
            direction: 'head-receives',
            template:
                'Before you commit to an approach on anything non-trivial, put it to {child} as a second ' +
                'opinion: state the approach, the alternatives you rejected and why. Weigh what comes back ' +
                'on the merits — {child} is not the decision-maker, you are.'
        },
        {
            id: 'reports-to-head',
            label: 'Reports to me — it works what I hand it',
            direction: 'member-receives',
            // Byte-identical to AGENT_GROUP_CALLBACK_INSTRUCTION in teamWiring.ts
            // and to the reports-to-head template in linkPresets.ts.
            // {child} is the head terminal name — substituted by resolvePreset
            // in the pair-order path (childName = headName for member-receives)
            // and by wireSpawnedTeam directly when building the team prompt.
            template:
                '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with ' +
                '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in ' +
                '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.'
        },
        { id: 'custom', label: 'Custom…', direction: 'head-receives', template: '' }
    ];

    /** The persisted last-used preset id, resolved once in loadLayoutSettings(). */
    let linkPreset = LINK_PRESETS[0].id;
    let presetDirty = false;

    // Client mirror of the standing-orders resolver. Keep in sync with
    // src/services/standingOrders.ts — the marker string is the contract that
    // prevents double-blocking when a prompt is processed by both client and host.
    const STANDING_ORDERS_MARKER = '=== STANDING ORDERS ===';
    // Matches the block-strip regex in standingOrders.ts — anchored to a COMPLETE
    // block (marker + body + trailing 'These apply...' line) so a prompt that
    // merely quotes the marker mid-text is not silently truncated.
    const STANDING_ORDERS_BLOCK_RE =
        /\n*=== STANDING ORDERS ===\n[\s\S]*?These apply to everything you do in this terminal until told otherwise\.\n$/;
    let linkMode = 'instant';
    let standingOrders = [];
    let standingOrdersAvailable = false;

    function resolvePreset(id, parentName, childName) {
        const preset = LINK_PRESETS.find(p => p.id === id);
        if (!preset || !preset.template) { return ''; }
        return preset.template
            .replace(/\{child\}/g, childName || 'the other terminal')
            .replace(/\{parent\}/g, parentName || 'this terminal');
    }

    /**
     * Build the preset options once. The option text is static, so there is no
     * reason to rebuild this on a parent/child change.
     *
     * EVERY preset is offered, `reports-to-head` included, and the persisted-id
     * validation in loadLayoutSettings() checks the same whole list — the two
     * must stay in step, or a saved id the dropdown never builds makes
     * `presetSel.value = linkPreset` a silent no-op (blank dropdown, empty box,
     * dead SEND). If a preset is ever filtered out here, filter the validation
     * with the same predicate.
     *
     * Known asymmetry, deliberately left: `reports-to-head` carries
     * `direction: 'member-receives'` (installed ON the member ABOUT the head),
     * but this modal always writes {parent, child} as chosen in the two selects.
     * `direction` is honoured by wireSpawnedTeam on the spawn path, not here.
     * Owned by feature_plan_20260812171500_link-up-presets-fire-through-relay-
     * not-standing-orders.md, which flags it and keeps the entry.
     */
    function buildPresetOptions() {
        const sel = document.getElementById('link-preset');
        if (!sel) { return; }
        sel.innerHTML = '';
        for (const p of LINK_PRESETS) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.label;
            sel.appendChild(opt);
        }
    }

    /** Re-resolve the instruction text. `force` = an explicit preset selection, which
     *  always wins over the operator's edits; otherwise a dirty box is left alone. */
    function applyPresetToMessage(force) {
        const presetSel = document.getElementById('link-preset');
        const messageEl = document.getElementById('link-message');
        const parentSel = document.getElementById('link-parent');
        const childSel = document.getElementById('link-child');
        if (!presetSel || !messageEl || !parentSel || !childSel) { return; }
        if (presetDirty && !force) { return; }
        messageEl.value = resolvePreset(presetSel.value, parentSel.value, childSel.value);
        // A programmatic .value assignment does NOT fire `input`, so this neither
        // trips presetDirty nor reaches the listener at :7594 — hence the explicit
        // reset and the explicit syncSendEnabled().
        presetDirty = false;
        syncSendEnabled();
    }

    /**
     * Resolve the parent the modal should open on. The focused pane is the
     * operator's notion of "the selected terminal", but setFocusedPane only writes
     * activeTerminalName when the focused pane actually HOLDS a terminal
     * (terminals.js setFocusedPane) — so a focused-but-empty pane has to fall
     * through to the last terminal that was selected, and only then to the fleet
     * head. Every candidate is re-checked against the live fleet: a default that
     * quietly targets a dead terminal is worse than no default at all.
     */
    function defaultLinkParent() {
        const isLive = (n) => n && fleetList.some(t => t.friendlyName === n && t.status === 'active');
        const focused = paneAssignments[focusedPaneIndex];
        if (isLive(focused)) { return focused; }
        if (isLive(activeTerminalName)) { return activeTerminalName; }
        const first = fleetList.find(t => t.status === 'active');
        return first ? first.friendlyName : null;
    }

    /**
     * Populate a <select> with the live fleet. The selected value is set AFTER
     * the options exist so the browser honours it; setting .value on an empty
     * select is a silent no-op.
     */
    function fillTerminalSelect(sel, live, selectedName) {
        sel.innerHTML = '';
        for (const t of live) {
            const opt = document.createElement('option');
            opt.value = t.friendlyName;
            opt.textContent = `${t.friendlyName} (${t.role})`;
            sel.appendChild(opt);
        }
        if (selectedName && live.some(t => t.friendlyName === selectedName)) {
            sel.value = selectedName;
        }
    }

    /**
     * The child list must never contain the parent — an agent instructed to
     * message itself is a no-op at best and a loop at worst. Re-run on every
     * parent change, preserving the current child selection when it is still
     * valid.
     */
    function syncChildOptions() {
        const parentSel = document.getElementById('link-parent');
        const childSel = document.getElementById('link-child');
        if (!parentSel || !childSel) { return; }
        const parentName = parentSel.value;
        const prevChild = childSel.value;
        const live = fleetList.filter(t => t.status === 'active' && t.friendlyName !== parentName);
        fillTerminalSelect(childSel, live, prevChild);
        applyPresetToMessage(false);
    }

    function setLinkError(msg) {
        const el = document.getElementById('link-error');
        if (!el) { return; }
        if (msg) { el.textContent = msg; el.hidden = false; }
        else { el.hidden = true; el.textContent = ''; }
    }

    function syncSendEnabled() {
        const msg = document.getElementById('link-message');
        const sendBtn = document.getElementById('link-send');
        if (!msg || !sendBtn) { return; }
        sendBtn.disabled = !msg.value.trim();
        sendBtn.textContent = linkMode === 'standing' ? 'SAVE' : 'SEND';
    }

    function liveNameSet() {
        return new Set(fleetList.filter(t => t.status === 'active').map(t => t.friendlyName));
    }

    // ── Team-scoped mode helpers ──────────────────────────────────────────

    // isSpawnedTeamGroup is NOT redeclared here. A second `function
    // isSpawnedTeamGroup` in this same IIFE used to live at this spot, and
    // because function declarations hoist, THAT one silently won for all eight
    // call sites — including the seven above it, which a reader would attribute
    // to the definition near getAgentGroupsCache. The two bodies had different
    // predicates (`teamGroup && team_` vs `team_ && source==='manual'`), so the
    // dead one documented behaviour the program never ran. One definition only,
    // declared once, mirroring teamWiring.ts.

    /** Client-side mirror of `teamHeadName` from `teamWiring.ts`.
     *  Reads the explicit `head` field on the group record, falling back to
     *  `members[0]` only for legacy rows that predate the `head` stamp. Never
     *  infers from `order[0]` — order is the operator's arrangement, not
     *  identity. */
    function teamHeadName(g) {
        if (!g) { return null; }
        if (typeof g.head === 'string' && g.head) { return g.head; }
        if (Array.isArray(g.members) && g.members.length > 0) { return g.members[0]; }
        return null;
    }

    /** Resolve the team-scoped group record from `terminalGroups` by id.
     *  Returns null if the group does not exist or is not a spawned team. */
    function getScopedTeamGroup() {
        if (!teamScopeId) { return null; }
        return terminalGroups.find(g => g && g.id === teamScopeId) || null;
    }

    /** Enter team-scoped mode in-place (no page reload, no pop-out window).
     *  Called by the switchToTeam message handler when the shell rail's team
     *  button is clicked. Sets teamScopeId BEFORE calling switchToGroup so the
     *  guard at switchToGroup (teamScopeId && id !== teamScopeId) passes —
     *  mirrors the init() path at lines 772–782 which sets teamScopeId first.
     *
     *  Async because entering scope has to re-read state under the new scope,
     *  exactly as the init() team branch does. In-place entry is now the ONLY
     *  way into a team view (the pop-out is gone), so anything init did on the
     *  way in has to happen here or it never happens at all. */
    async function enterTeamScope(groupId) {
        const group = getAllGroups().find(g => g.id === groupId);
        if (!group || !isSpawnedTeamGroup(group)) { return; }
        dismissPeek();
        // Save the current scope's layout before switching — prevents unsaved
        // pane/pin/mode changes from being lost on direct team-to-team switch.
        // mapSettingKey reads teamScopeId synchronously (saveSetting computes
        // the storage key before its first await), so this lands under the
        // CURRENT team's namespace even though teamScopeId changes below. Only
        // fires on a direct switch (teamScopeId already set to another team),
        // and only for the namespaced keys — see
        // saveTeamScopedLayoutSettings for why the fleet-wide groups array
        // must not be written here.
        if (teamScopeId && teamScopeId !== groupId) {
            saveTeamScopedLayoutSettings();
        }
        // Clear the old team's work queue so its items don't flash for one
        // frame before the new team's fetchTeamQueue resolves. exitTeamScope
        // does the same cleanup on the way out.
        _queueItems = [];
        _queueMode = 'manual';
        teamScopeId = groupId;
        document.body.classList.add('is-team-scoped');
        document.title = group.shortName || group.name || 'Team';
        // mapSettingKey now prefixes the layout-family keys with
        // `terminals.team.<groupId>.`, so re-read them BEFORE anything writes.
        // switchToGroup below ends in saveLayoutSettings(); without this load
        // that save stamps the FLEET's layout, pins and pane modes over the
        // team's own namespaced copies, destroying them on every entry.
        await loadLayoutSettings();
        // Two rail clicks in quick succession interleave across these awaits.
        // Whoever set teamScopeId last owns the panel; an older call that wakes
        // up afterwards must not seat its team over the newer one. (Cheap here,
        // and switchToGroup's own guard would only half-catch it.)
        if (teamScopeId !== groupId) { return; }
        const scopedGroup = getScopedTeamGroup();
        _queueMode = (scopedGroup && scopedGroup.queueMode === 'auto') ? 'auto' : 'manual';
        if (teamScopeId !== groupId) { return; }
        switchToGroup(groupId);  // seats the team's members into panes; renders the sidebar
        syncLayoutPickerUI();
        renderPaneGrid();
        // Push the fleet state to the shell rail so the team button's light
        // reflects the current scope immediately, not on the next 5s poll.
        postFleetStateToShell();
    }

    /** Exit team-scoped mode and return to the full fleet view. Called by the
     *  back button in renderTeamHeader. Clears teamScopeId, removes the body
     *  class, resets the group lock and layout, and re-renders the full fleet. */
    async function exitTeamScope() {
        teamScopeId = null;
        document.body.classList.remove('is-team-scoped');
        document.title = 'Terminals';
        // The work queue belongs to the team, not the fleet. Left set, the next
        // team entered would paint this team's items and mode for one frame.
        _queueItems = [];
        _queueMode = 'manual';
        // mapSettingKey maps back to the unprefixed keys now the scope is
        // clear, so re-read them: this is what restores the fleet's own pane
        // assignments, pins and modes. Without it the team's layout stays in
        // memory and the next saveLayoutSettings() writes it over the fleet's
        // keys — the mirror image of the clobber guarded against on entry.
        // It also does the reseat the old seatActiveGroupPage() call could
        // never do: that call ran after activeGroupId was nulled, and
        // seatActiveGroupPage early-returns without a locked group, so the grid
        // kept the team's members after the user asked for all terminals.
        // Save the team groups before loadLayoutSettings REPLACES terminalGroups
        // — the load is for layout-family keys (pane assignments, pins, modes),
        // not for the fleet-wide groups roster. If the storage read returns a
        // stale version (e.g. a race with enterTeamScope's fire-and-forget
        // saveLayoutSettings), the team groups would be lost and the next
        // postFleetStateToShell would push an empty teams array, making
        // individual terminals reappear on the shell rail.
        const savedGroups = terminalGroups.map(g => ({ ...g }));
        await loadLayoutSettings();
        // Merge back any groups that loadLayoutSettings dropped (stale storage
        // read or a clobbered key). Only adds groups whose id is no longer
        // present — it does NOT overwrite groups that survived the load.
        const loadedIds = new Set(terminalGroups.map(g => g && g.id).filter(Boolean));
        for (const g of savedGroups) {
            if (g && g.id && !loadedIds.has(g.id)) {
                terminalGroups.push(g);
                loadedIds.add(g.id);
            }
        }
        // Return unlocked: the back button means "all terminals", not "whatever
        // group was locked before". Set after the load, which restores the
        // fleet's persisted activeGroupId.
        activeGroupId = null;
        activeGroupPage = 0;
        setLayoutMode(layoutForFleetCount(fleetList.length));
        syncLayoutPickerUI();
        renderSidebarList();
        renderPaneGrid();
        // Push the fleet state to the shell rail immediately — without this the
        // rail retains its last-pushed state until the next 5s fleet poll, and
        // if that poll sees a terminalGroups missing the team groups (the race
        // above), individual terminals reappear.
        postFleetStateToShell();
    }

    /* ── Controller-scoped mode ────────────────────────────────────────
       Mirrors team-scoped mode: an `is-controller-scoped` body class swaps
       the .sidebar-ops block to show the controller's own controls
       (#btn-controller-stop) instead of the general-purpose buttons. The
       rail icon's lit click navigates here (switchToController postMessage),
       matching every other rail button — team buttons switch to team scope,
       this one switches to controller scope. The end-session control that
       USED to live on the rail icon lives here now, where it can carry a
       label (the rail icon cannot). */
    let controllerScopeActive = false;
    /** Last adopted-controller terminal name seen on the autoban broadcast rail.
     *  Updated by autoban state handler — the role scan alone cannot see an
     *  adopted seat, which is exactly what the docblock below promises to handle. */
    let lastMissionControlSeatName = null;

    /** Enter controller-scoped mode. Finds the controller terminal (by role
     *  'mission-control' or 'project_manager', or by the adopted seat name) and
     *  seats it into a pane. Falls back to a no-scope reveal when no
     *  controller terminal exists — the rail lit state and the seat record
     *  can diverge briefly during adoption. */
    function enterControllerScope() {
        // If already in team scope, exit it first — the two scopes are
        // mutually exclusive, exactly as enterTeamScope clears a prior team.
        if (teamScopeId) { exitTeamScope(); }
        controllerScopeActive = true;
        document.body.classList.add('is-controller-scoped');
        // Show the controller-specific ops button, hide the general-purpose
        // ones (CSS handles the hide — the class is on body). Unhide the
        // stop button explicitly since it starts hidden.
        const stopBtn = document.getElementById('btn-controller-stop');
        if (stopBtn) { stopBtn.hidden = false; }
        // Find and focus the controller terminal in a pane. The adopted seat is
        // checked FIRST: an adopted controller carries neither the controller role
        // nor the canonical name, so a role-only scan silently seats nothing (or the
        // wrong pane) for the adopt door — the same blind spot the service-layer
        // singleton guard exists to close.
        let controller = null;
        if (lastMissionControlSeatName) {
            controller = fleetList.find(t => t.friendlyName === lastMissionControlSeatName) || null;
        }
        if (!controller) {
            controller = fleetList.find(t =>
                t.role === 'mission-control' || t.role === 'project_manager'
            ) || null;
        }
        if (controller) {
            // Seat the controller terminal into pane 0 so the operator sees it.
            paneAssignments[0] = controller.friendlyName;
            initialAssignmentDone = true;
            renderPaneGrid();
        }
        renderSidebarList();
    }

    /** Exit controller-scoped mode and return to the full fleet view. */
    function exitControllerScope() {
        controllerScopeActive = false;
        document.body.classList.remove('is-controller-scoped');
        const stopBtn = document.getElementById('btn-controller-stop');
        if (stopBtn) { stopBtn.hidden = true; }
        renderSidebarList();
        renderPaneGrid();
    }

    /** The render-boundary filter. Returns `fleetList` filtered to the scoped
     *  team's live members when `teamScopeId` is set, and `fleetList` unchanged
     *  otherwise. Called only from render paths — NEVER from fetch, standing-
     *  orders, or sanitize paths that need the whole fleet.
     *
     *  Re-reads the group record each call so a re-spawn that upserts
     *  `members` is picked up on the next poll without a stale cache. Tolerates
     *  a member name that is no longer live (the filter intersects with the
     *  live set). */
    function scopedFleet() {
        if (!teamScopeId) { return fleetList; }
        const group = getScopedTeamGroup();
        if (!group || !Array.isArray(group.members)) { return []; }
        const memberSet = new Set(group.members);
        return fleetList.filter(t => memberSet.has(t.friendlyName));
    }

    /** The set of live member names for the scoped team, in the group's
     *  `order` sequence. Used by the sidebar renderer to honour the operator's
     *  authored order rather than `compareTerminals`. Falls back to `members`
     *  if `order` is absent. */
    function scopedMemberNamesOrdered() {
        const group = getScopedTeamGroup();
        if (!group) { return []; }
        const live = new Set(fleetList.filter(t => t.status !== 'exited').map(t => t.friendlyName));
        const seq = Array.isArray(group.order) ? group.order : (Array.isArray(group.members) ? group.members : []);
        return seq.filter(n => live.has(n));
    }

    /** Client-side mirror of `applyStandingOrders` from `src/services/standingOrders.ts`. */

    /**
     * Pre-rewrite callback text — byte-identical to the shipped
     * AGENT_GROUP_CALLBACK_INSTRUCTION before the team-prompt change.
     * Existing installs have per-member pair rows carrying this exact string.
     * The migration recogniser matches against it (not the post-rewrite
     * constant) because this is what is actually on disk.
     *
     * Mirror of PRE_REWRITE_CALLBACK_INSTRUCTION in teamWiring.ts.
     */
    var PRE_REWRITE_CALLBACK_INSTRUCTION =
        'it is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
        + '{"name":"<that terminal>","data":"<your report>","clearBeforePrompt":false} against the port in '
        + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.';

    /**
     * Post-rewrite callback template — {child} is the head terminal name.
     * Mirror of AGENT_GROUP_CALLBACK_INSTRUCTION in teamWiring.ts.
     */
    var POST_REWRITE_CALLBACK_INSTRUCTION =
        '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
        + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
        + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.';

    /**
     * Git safety directive — mirror of GIT_SAFETY_DIRECTIVE in
     * agentPromptBuilder.ts. One source of truth in the host; this copy
     * exists because the webview cannot import TypeScript modules. The
     * standing-orders-marker-contract test pins byte-identity.
     */
    var GIT_SAFETY_DIRECTIVE_CLIENT =
        'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — commit first, then correct forward. Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — other agents may be working the same tree.';

    /**
     * POST-rewrite Coding team headPrompt — mirror of NEW_CODING_HEAD_PROMPT
     * in teamWiring.ts. Subtask-level, single-action: the lead finishes each
     * subtask, commits, posts completion for that subtask, and asks for the
     * next card via queue/next. {head} is substituted with the live head name.
     */
    var NEW_CODING_HEAD_PROMPT_CLIENT =
        'You lead this team. Your coders work the subtasks of one feature. '
        + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
        + 'Read the plan, dispatch based on it, review against it — never modify its content. '
        + 'Each subtask carries '
        + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
        + 'no such seat, dispatch to a coder and say why in your status report. Your team\'s seats are the '
        + 'ptyListTerminals rows whose parentInstanceId matches your SWITCHBOARD_AGENT_INSTANCE_ID — role alone '
        + 'is not a membership test, and a standalone seat of the same role is not yours to drive. Take the '
        + 'subtask\'s recommendedRole as the routing decision; do not invent complexity tiers. Before sending any '
        + 'seat a revert or stand-down, confirm with git diff that the state you are undoing exists. When a seat fails '
        + 'review on the same subtask twice, do not send that subtask to it a third time — escalate '
        + 'one rung along intern → coder → lead, name the specific defects in the dispatch, and say '
        + 'in your status report which seat you moved it to and why; if the seat that failed twice is '
        + 'a lead, or your team has no seat above it, stop and report to the human instead of '
        + 'dispatching again (or unattended: record the blocked card to .switchboard/mission-control/reports/ '
        + 'and proceed to the next queue item). When a coder reports a subtask finished, note it and '
        + 'dispatch the next subtask to an idle seat that has not already worked on it — do not stack '
        + 'subtasks on the same coder, or it will hit its context limit mid-task. One subtask per '
        + 'cleared seat before rotation. Do not send anything to the reviewer, and do not write review '
        + 'instructions — that is not your job. '
        + 'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
        + 'Never move a card to a new column yourself — that is not your role. '
        + 'When the work is complete, stage the files you changed by explicit path '
        + '— never `git add -A` or `git add .`. Then create a single commit with a '
        + 'descriptive message. '
        + 'POST /kanban/task/complete with {"from":"{head}","planId":"<the subtask\'s planId>","workspaceRoot":'
        + '"<your current working directory>"} against the port in .switchboard/api-server-port.txt. '
        + 'The card stays where it is. Completion is asserted, never inferred from board position. '
        + 'POST /kanban/queue/next with {"from":"{head}"} against the port in .switchboard/api-server-port.txt; '
        + 'if it returns a dispatched card, work it; if it returns dispatched: null, report that the queue is '
        + 'empty and stop.';

    /**
     * Client-side mirror of migrateTeamPairOrders from teamWiring.ts.
     *
     * Recognises pre-rewrite per-member pair rows (instruction matches
     * PRE_REWRITE_CALLBACK_INSTRUCTION), groups them by head (the `child`
     * field in member-receives direction), and folds them into team-scoped
     * orders carrying the default team prompt (callback + git safety).
     * Unrecognised rows are left untouched.
     *
     * Applied INSIDE applyStandingOrdersClient at render time — NOT at the
     * GET /terminals/standing-orders fetch level — so the standingOrders
     * array used by the Link-up editor for delete-by-id is never touched
     * and ids do not churn.
     */
    function migrateTeamPairOrdersClient(orders) {
        if (!Array.isArray(orders) || orders.length === 0) { return orders; }

        var groups = {}; // headName → true (we only need the head name)
        var recognised = {}; // order id → true

        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!o || typeof o !== 'object') { continue; }
            var scope = o.scope || 'pair';
            if (scope !== 'pair') { continue; }
            if (o.instruction !== PRE_REWRITE_CALLBACK_INSTRUCTION) { continue; }
            var headName = o.child;
            if (!headName) { continue; }
            if (!o.parent) { continue; }

            groups[headName] = true;
            recognised[o.id] = true;
        }

        var recognisedCount = Object.keys(recognised).length;
        if (recognisedCount === 0) { return orders; }

        var migrated = [];
        var headNames = Object.keys(groups);
        for (var j = 0; j < headNames.length; j++) {
            var headName = headNames[j];
            var teamId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
            var callbackText = POST_REWRITE_CALLBACK_INSTRUCTION.replace(/\{child\}/g, headName);
            var instruction = callbackText + '\n' + GIT_SAFETY_DIRECTIVE_CLIENT;
            migrated.push({
                id: 'migrated-team-' + teamId,
                parent: headName,
                child: '',
                instruction: instruction,
                createdAt: Date.now(),
                scope: 'team',
                teamId: teamId,
            });
        }

        // Check for existing team-scoped orders with the same teamId to
        // avoid duplication (e.g. from a prior wireSpawnedTeam call).
        var existingTeamIds = {};
        for (var k = 0; k < orders.length; k++) {
            var ord = orders[k];
            if (ord && ord.scope === 'team' && ord.teamId) {
                existingTeamIds[ord.teamId] = true;
            }
        }
        var newTeamOrders = [];
        for (var m = 0; m < migrated.length; m++) {
            if (!existingTeamIds[migrated[m].teamId]) {
                newTeamOrders.push(migrated[m]);
            }
        }

        var kept = [];
        for (var n = 0; n < orders.length; n++) {
            if (!recognised[orders[n].id]) {
                kept.push(orders[n]);
            }
        }
        return kept.concat(newTeamOrders);
    }

    /**
     * Stale V2 fragment — mirror of OLD_HEADPROMPT_V2_FRAGMENT in teamWiring.ts.
     */
    var OLD_HEADPROMPT_V2_FRAGMENT = 'note it and give that coder the next subtask';

    /**
     * Client-side mirror of migrateCodingTeamOrders from teamWiring.ts.
     *
     * Drops the stale reviewer pair row (instruction equals the resolved
     * reviewer preset text for this parent/child pair). Rewrites stale V2
     * team-head rows to NEW_CODING_HEAD_PROMPT_CLIENT. Unrecognised rows
     * are left untouched.
     *
     * Applied INSIDE applyStandingOrdersClient at render time, composed
     * AFTER migrateTeamPairOrdersClient so the pair converter sees the array
     * shape it expects. Pure — does not mutate the input array or the
     * persisted standingOrders. Idempotent.
     */
    function migrateCodingTeamOrdersClient(orders) {
        if (!Array.isArray(orders) || orders.length === 0) { return orders; }

        var drop = {};       // order id → true
        var rewrite = {};    // order id → replacement instruction
        var touched = false;

        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!o || typeof o !== 'object') { continue; }

            // Stale reviewer pair row: instruction equals the resolved
            // reviewer preset text for this (parent, child) pair. Drop it.
            var scope = o.scope || 'pair';
            if (scope === 'pair') {
                var expected = resolvePreset('reviewer', o.parent, o.child);
                if (expected && o.instruction === expected) {
                    drop[o.id] = true;
                    touched = true;
                    continue;
                }
            }

            // Stale V2 team-head row: the feature-level headPrompt whose assignment rule
            // was "give that coder the next subtask".
            if (scope === 'team-head' && typeof o.instruction === 'string') {
                if (o.instruction.indexOf(OLD_HEADPROMPT_V2_FRAGMENT) !== -1) {
                    var newInstruction = NEW_CODING_HEAD_PROMPT_CLIENT.replace(/\{head\}/g, o.parent || '');
                    rewrite[o.id] = newInstruction;
                    touched = true;
                    continue;
                }
            }
        }

        if (!touched) { return orders; }

        var kept = [];
        for (var j = 0; j < orders.length; j++) {
            var ord = orders[j];
            if (!drop[ord.id]) {
                var repl = typeof ord.id === 'string' ? rewrite[ord.id] : undefined;
                kept.push(repl ? Object.assign({}, ord, { instruction: repl }) : ord);
            }
        }
        return kept;
    }

    function applyStandingOrdersClient(prompt, targetName, orders, liveNames) {
        if (!prompt) { return prompt; }
        // Strip a pre-existing block so a prompt that already carries one does
        // not end up with two blocks or lose the target's own orders. Mirrors
        // the host resolver's strip + re-append behaviour.
        var cleanPrompt = prompt.replace(STANDING_ORDERS_BLOCK_RE, '');

        // Migrate pre-rewrite per-member pair rows into team-scoped orders,
        // then migrate stale Coding-team orders, before selection. Pure
        // transforms — do not mutate the input array or the persisted
        // standingOrders. Mirror migrateTeamPairOrders +
        // migrateCodingTeamOrders in teamWiring.ts. Pair-fold first, then
        // Coding-team rewrite, so the pair converter sees the array shape
        // it expects.
        var effectiveOrders = migrateCodingTeamOrdersClient(migrateTeamPairOrdersClient(orders));

        // Scope-aware selection — mirrors selectOrders in standingOrders.ts.
        var mine = effectiveOrders.filter(function (o) {
            var scope = o.scope || 'pair';
            if (scope === 'global') { return true; }
            // `role` scope is host-resolved: matching it needs the terminal-to-role
            // registry (_terminalAgentInfo / the PTY fleet roster), which this panel
            // mirror cannot see. Skip explicitly instead of letting a role order fall
            // through to the pair default below, where a stray `parent` would deliver
            // it to the wrong terminal. Host side: the `role` branch in selectOrders
            // (standingOrders.ts). Graceful degradation, not parity.
            if (scope === 'role') { return false; }
            if (scope === 'team') {
                if (!o.teamId) { return false; }
                var group = terminalGroups.find(function (g) { return g && g.id === o.teamId; });
                if (!group || !Array.isArray(group.members)) { return false; }
                // Exclude the head — the team prompt is for members only.
                // The head name is stored in `o.parent` by wireSpawnedTeam.
                // Mirrors the host resolver's head-exclusion check.
                if (o.parent && targetName === o.parent) { return false; }
                return group.members.indexOf(targetName) !== -1;
            }
            if (scope === 'team-head') {
                if (!o.teamId) { return false; }
                var hGroup = terminalGroups.find(function (g) { return g && g.id === o.teamId; });
                if (!hGroup || !Array.isArray(hGroup.members)) { return false; }
                return !!o.parent && targetName === o.parent && hGroup.members.indexOf(targetName) !== -1;
            }
            // pair (default)
            return o.parent === targetName && o.child !== undefined && liveNames.has(o.child);
        });
        if (mine.length === 0) { return cleanPrompt; }

        // Render safeguard-bearing scopes (global, team) before pair. Mirrors
        // the host's scope-rank sort. Stable sort preserves creation order.
        var scopeRank = { global: 0, role: 1, 'team-head': 2, team: 2, pair: 3 };
        var sorted = mine.slice().sort(function (a, b) {
            return scopeRank[(a.scope || 'pair')] - scopeRank[(b.scope || 'pair')];
        });

        var block = '\n\n' + STANDING_ORDERS_MARKER + '\n';
        for (var i = 0; i < sorted.length; i++) {
            var o = sorted[i];
            var scope = o.scope || 'pair';
            if (scope === 'pair') {
                if (!o.child) { continue; }
                block += '- Regarding terminal "' + o.child + '": ' + o.instruction + '\n';
            } else {
                block += '- ' + o.instruction + '\n';
            }
        }
        block += 'These apply to everything you do in this terminal until told otherwise.\n';
        return cleanPrompt + block;
    }

    async function fetchStandingOrders() {
        try {
            const res = await fetch('/terminals/standing-orders', { method: 'GET' });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success) {
                    standingOrders = Array.isArray(data.orders) ? data.orders : [];
                    standingOrdersAvailable = !!data.available;
                    return;
                }
            }
        } catch (err) {
            console.warn('[Terminals] Failed to fetch standing orders:', err);
        }
        standingOrders = [];
        standingOrdersAvailable = false;
    }

    function syncModeAvailability(sel) {
        if (!sel) { return; }
        const standingOpt = sel.querySelector('option[value="standing"]');
        if (standingOpt) { standingOpt.disabled = !standingOrdersAvailable; }
        if (!standingOrdersAvailable && sel.value === 'standing') {
            sel.value = 'instant';
            // sendLinkMessage branches on the VARIABLE, not the select. Leaving
            // linkMode === 'standing' here sends a "SAVE" to a store the gate just
            // declared unreachable, under a dropdown reading "Instant".
            // Deliberately NOT persisted: the operator's stored preference should
            // survive a context that merely happens to lack the store.
            linkMode = 'instant';
        }
    }

    function renderStandingList() {
        const list = document.getElementById('link-standing-list');
        if (!list) { return; }
        if (standingOrders.length === 0 || !standingOrdersAvailable) {
            list.hidden = true;
            list.innerHTML = '';
            return;
        }
        const live = liveNameSet();
        list.innerHTML = '';
        for (const o of standingOrders) {
            const item = document.createElement('div');
            item.className = 'link-standing-item' + (live.has(o.child) ? '' : ' dead');
            item.dataset.id = o.id;
            const text = document.createElement('span');
            text.textContent = `${o.parent} ← ${o.child}: ${o.instruction}`;
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'delete-btn';
            del.textContent = '×';
            del.title = 'Delete standing order';
            item.appendChild(text);
            item.appendChild(del);
            list.appendChild(item);
        }
        list.hidden = false;
    }

    async function openLinkModal() {
        const live = fleetList.filter(t => t.status === 'active');
        if (live.length < 2) { showPaneToast('Need at least two live terminals to link'); return; }

        const modal = document.getElementById('link-modal');
        const parentSel = document.getElementById('link-parent');
        const childSel = document.getElementById('link-child');
        const modeSel = document.getElementById('link-mode');
        const messageEl = document.getElementById('link-message');
        const presetSel = document.getElementById('link-preset');
        if (!modal || !parentSel || !childSel || !modeSel || !messageEl || !presetSel) { return; }

        // Everything up to `modal.hidden = false` is SYNCHRONOUS: the modal must
        // appear on the frame the operator clicked LINK UP. A modal that waits on
        // a fetch first looks like a dead button, and the second click queues a
        // second open. The persisted preset is already resolved (loadLayoutSettings),
        // so nothing in the send-ready path needs the network.
        fillTerminalSelect(parentSel, live, defaultLinkParent());
        presetDirty = false;
        // BEFORE syncChildOptions(): its tail call to applyPresetToMessage(false)
        // resolves against whatever the select currently holds, which on the first
        // open is the first option rather than the persisted preset.
        presetSel.value = linkPreset; // options already exist — built once in wireLinkModal
        syncChildOptions();
        applyPresetToMessage(true);  // fills the box; SEND is live on open
        modeSel.value = linkMode;
        setLinkError(null);

        modal.hidden = false;
        presetSel.focus();           // the preset is now the primary control; Tab reaches the box

        // Only the standing-orders list and its mode gate need the store, and
        // neither is on the send-ready path — they render into an already-visible
        // modal. Gated off when the store is not reachable (solo popout, headless,
        // or no DB).
        await fetchStandingOrders();
        syncModeAvailability(modeSel);
        renderStandingList();
        syncSendEnabled();           // syncModeAvailability may have forced the mode
                                     // back to instant; the button label follows it
    }

    /**
     * The fleet is repolled by fetchTerminalList, so the two-live-terminals
     * precondition is NOT a boot-time constant. Recompute here;
     * renderSidebarList() is already called on every successful poll.
     */
    function syncLinkUpEnabled() {
        const btn = document.getElementById('btn-link-up');
        if (!btn) { return; }
        const liveCount = fleetList.filter(t => t.status === 'active').length;
        btn.disabled = liveCount < 2;
        btn.title = btn.disabled
            ? 'Needs at least two live terminals'
            : 'Instruct one agent terminal to send a message to another';
    }

    /**
     * Build the relay prompt. Two parts, in this order:
     *   1. the operator's instruction verbatim, delimited — it is the point of
     *      the message and comes first so the agent reads it before the recipe;
     *   2. a single curl against the /terminals/relay endpoint.
     *
     * The prompt is an instruction, not an API tutorial. The old recipe handed
     * the agent a /tmp heredoc, a python3 JSON builder, a clearBeforePrompt
     * lecture and a 401 note — transport mechanics the agent should never see,
     * and a loaded gun (clearBeforePrompt) it had to reproduce faithfully or
     * silently arm a context wipe. /terminals/relay removes all of that: the
     * endpoint takes {to, from, message}, hardcodes clearBeforePrompt:false so
     * the capability to clear the recipient does not exist on the route, stamps
     * provenance itself, and validates both ends against the live fleet. The
     * agent can produce the call correctly in one attempt.
     *
     * The API base is taken from location.origin — this page IS served by the
     * LocalApiServer that owns /terminals/relay (the same server that owns
     * /terminals/verb/), so it is guaranteed correct without a port-file read.
     * PTY_HOST_ORIGIN is a DIFFERENT server (the pty host child) and must not be
     * used here.
     *
     * The auth token is NOT interpolated: it reaches the shell as
     * $SWITCHBOARD_API_TOKEN (see the ptyFleetService change) so the secret
     * never enters the agent's scrollback or conversation history. The header is
     * emitted unconditionally — under the extension host getAuthToken() is empty
     * and _checkAuth short-circuits to loopback trust before reading it, so an
     * empty value is harmless there and correct under standalone.
     *
     * Every line of the shell block starts at column 0: an indented heredoc
     * terminator is not recognised and the shell hangs waiting for input.
     */
    function buildLinkPrompt(parentName, childName, message) {
        const api = location.origin;
        return [
            `You have been asked to relay something to another Switchboard terminal.`,
            ``,
            `TARGET TERMINAL: ${childName}`,
            `YOUR TERMINAL:   ${parentName}`,
            ``,
            `OPERATOR INSTRUCTION:`,
            `---`,
            message,
            `---`,
            ``,
            `To deliver this to ${childName}, run:`,
            ``,
            `curl -s -X POST "${api}/terminals/relay" \\`,
            `  -H "Content-Type: application/json" \\`,
            `  -H "Authorization: Bearer $SWITCHBOARD_API_TOKEN" \\`,
            `  -d '{"to":${JSON.stringify(childName)},"from":${JSON.stringify(parentName)},"message":"<the operator instruction above, verbatim>"}'`,
            ``,
            `For a long or multi-line message, use a heredoc to build the JSON body instead of hand-escaping it into the -d string.`,
            ``,
            `Carry out the operator instruction now.`,
        ].join('\n');
    }

    async function sendLinkMessage() {
        const parentName = document.getElementById('link-parent').value;
        const childName = document.getElementById('link-child').value;
        const message = document.getElementById('link-message').value.trim();
        if (!parentName || !childName || !message) { return; }

        // Clear any error left over from a previous attempt — a stale "<name> is no
        // longer live" sitting above a fresh send reads as the new send's verdict.
        setLinkError(null);

        // Re-validate BOTH ends: the modal may have sat open while the fleet changed.
        const live = (n) => fleetList.some(t => t.friendlyName === n && t.status === 'active');
        if (!live(parentName)) { setLinkError(`${parentName} is no longer live`); return; }
        if (!live(childName)) { setLinkError(`${childName} is no longer live`); return; }

        const sendBtn = document.getElementById('link-send');
        if (sendBtn) { sendBtn.disabled = true; }
        try {
            if (linkMode === 'standing') {
                const res = await fetch('/terminals/standing-orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add', parent: parentName, child: childName, instruction: message })
                });
                const data = await res.json();
                if (!data.success) { setLinkError('Save failed: ' + (data.error || 'unknown')); return; }
                await fetchStandingOrders();
                renderStandingList();
                document.getElementById('link-message').value = '';
                showPaneToast(`Standing order saved for ${parentName}`);
            } else {
                // This hop is panel → PARENT (delivering the relay instruction to
                // the parent agent), NOT panel → child. /terminals/relay is the
                // parent → child hop that the parent agent will make itself (per
                // buildLinkPrompt). The panel is not a fleet terminal, so
                // /terminals/relay's `from`-validation and provenance stamp do
                // not apply here — this is an instruction to the parent, so
                // ptySendPrompt is the correct route. Routing the panel's own
                // send through /terminals/relay would conflate the two hops and
                // reject the call (the panel is not in the fleet).
                //
                // Relative URL + default credentials:'same-origin' — this is the idiom every
                // other verb call in this file uses. It is what carries the HttpOnly
                // sb_session cookie that _checkAuth accepts under standalone.
                const res = await fetch('/terminals/verb/ptySendPrompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: parentName,
                        data: buildLinkPrompt(parentName, childName, message),
                        // EXPLICIT false. The omitted-field default is now false
                        // in BOTH hosts (TaskViewerProvider and bootstrap), so
                        // omitting would be safe — but explicit beats inherited
                        // on a destructive flag: a future refactor that reroutes
                        // this send must not silently arm a /clear on the PARENT
                        // and destroy the very context it is being asked to hand
                        // over.
                        clearBeforePrompt: false,
                        // Link-up instructions must not themselves carry the parent's
                        // standing-orders block, or the agent would see its own orders
                        // quoted back inside the relay message.
                        standingOrders: false
                    })
                });
                const data = await res.json();
                if (!data.success) { setLinkError('Link failed: ' + (data.error || 'unknown')); return; }
                // Close first, THEN toast: the modal out-stacks .toast-container (z 200 vs
                // 100), so a toast raised while it is open would be painted behind it.
                document.getElementById('link-modal').hidden = true;
                showPaneToast(`Instructed ${parentName} to message ${childName}`);
            }
        } catch (err) {
            setLinkError('Link failed: ' + (err.message || String(err)));
        } finally {
            syncSendEnabled();
        }
    }

    // Wire modal controls. Bound once at init; the elements are static in the HTML.
    // Escape is bound at document level in the CAPTURE phase: a listener on
    // #link-modal only fires while focus is inside it, and clicking the backdrop
    // (which deliberately does NOT close the modal) moves focus to <body>, after
    // which an element-scoped Escape is dead. Capture runs before any handler
    // inside xterm's own subtree, so stopPropagation() there reliably prevents the
    // terminal from claiming the key.
    (function wireLinkModal() {
        const closeBtn = document.getElementById('link-modal-close');
        const cancelBtn = document.getElementById('link-cancel');
        const sendBtn = document.getElementById('link-send');
        const parentSel = document.getElementById('link-parent');
        const childSel = document.getElementById('link-child');
        const modeSel = document.getElementById('link-mode');
        const messageEl = document.getElementById('link-message');
        const standingList = document.getElementById('link-standing-list');
        const closeModal = () => {
            const modal = document.getElementById('link-modal');
            if (modal) { modal.hidden = true; }
        };
        if (closeBtn) { closeBtn.addEventListener('click', closeModal); }
        if (cancelBtn) { cancelBtn.addEventListener('click', closeModal); }
        if (sendBtn) { sendBtn.addEventListener('click', sendLinkMessage); }
        if (parentSel) { parentSel.addEventListener('change', syncChildOptions); }
        for (const el of [messageEl, modeSel, childSel]) {
            if (el) { el.addEventListener('keydown', (e) => { e.stopPropagation(); }); }
        }
        if (messageEl) {
            messageEl.addEventListener('input', () => { presetDirty = true; syncSendEnabled(); });
        }
        if (modeSel) {
            modeSel.addEventListener('change', () => {
                if (!standingOrdersAvailable && modeSel.value === 'standing') {
                    setLinkError('Standing orders are not available in this context');
                    modeSel.value = 'instant';
                } else {
                    setLinkError(null);
                    linkMode = modeSel.value;
                    saveSetting('terminals.linkMode', linkMode);
                }
                syncSendEnabled();
            });
        }
        buildPresetOptions();            // static options; the DOM is parsed by now
        const presetSel = document.getElementById('link-preset');
        if (presetSel) {
            presetSel.addEventListener('change', () => {
                linkPreset = presetSel.value;
                applyPresetToMessage(true);
                saveSetting('terminals.linkPreset', linkPreset);
                if (presetSel.value === 'custom') { document.getElementById('link-message').focus(); }
            });
        }
        if (standingList) {
            standingList.addEventListener('click', async (e) => {
                const btn = e.target.closest('.delete-btn');
                if (!btn) { return; }
                const item = btn.closest('.link-standing-item');
                if (!item) { return; }
                const id = item.dataset.id;
                if (!id) { return; }
                try {
                    const res = await fetch('/terminals/standing-orders', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'delete', id })
                    });
                    const data = await res.json();
                    if (!data.success) { setLinkError('Delete failed: ' + (data.error || 'unknown')); return; }
                    await fetchStandingOrders();
                    renderStandingList();
                } catch (err) {
                    setLinkError('Delete failed: ' + (err.message || String(err)));
                }
            });
        }
        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('link-modal');
            if (!modal || modal.hidden) { return; }
            if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
        }, true);
    })();

    let currentTeamOrdersTeamId = null;
    let currentTeamOrderRow = null;
    let currentHeadOrderRow = null;

    function setTeamOrdersError(msg) {
        const errEl = document.getElementById('team-orders-error');
        if (!errEl) return;
        if (!msg) {
            errEl.hidden = true;
            errEl.textContent = '';
        } else {
            errEl.hidden = false;
            errEl.textContent = msg;
        }
    }

    async function openTeamOrdersModal() {
        const modal = document.getElementById('team-orders-modal');
        if (!modal) return;

        const group = getScopedTeamGroup() || (terminalGroups.length > 0 ? terminalGroups[0] : null);
        if (!group) {
            showPaneToast('No team group found');
            return;
        }

        currentTeamOrdersTeamId = group.id;
        const titleEl = document.getElementById('team-orders-modal-title');
        if (titleEl) {
            titleEl.textContent = `Standing orders — ${group.name || group.shortName || 'Team'}`;
        }

        setTeamOrdersError(null);
        modal.hidden = false;

        await refreshTeamOrdersUI();
    }

    async function refreshTeamOrdersUI() {
        await fetchStandingOrders();

        const group = terminalGroups.find(g => g && g.id === currentTeamOrdersTeamId) || getScopedTeamGroup();
        const teamId = currentTeamOrdersTeamId;
        const members = group ? getGroupMembers(group) : [];
        const headName = group ? teamHeadName(group) : '';

        // Find existing orders for this team
        currentTeamOrderRow = standingOrders.find(o => (o.scope === 'team') && o.teamId === teamId) || null;
        currentHeadOrderRow = standingOrders.find(o => (o.scope === 'team-head') && o.teamId === teamId) || null;

        const teamOrderText = document.getElementById('team-order-text');
        const teamOrderDeleteBtn = document.getElementById('team-order-delete');
        if (teamOrderText) {
            teamOrderText.value = currentTeamOrderRow ? currentTeamOrderRow.instruction : '';
            teamOrderText.disabled = !standingOrdersAvailable;
        }
        if (teamOrderDeleteBtn) {
            teamOrderDeleteBtn.style.display = currentTeamOrderRow ? 'inline-block' : 'none';
            teamOrderDeleteBtn.disabled = !standingOrdersAvailable;
        }

        const headOrderText = document.getElementById('team-head-order-text');
        const headOrderDeleteBtn = document.getElementById('team-head-order-delete');
        if (headOrderText) {
            headOrderText.value = currentHeadOrderRow ? currentHeadOrderRow.instruction : '';
            headOrderText.disabled = !standingOrdersAvailable;
        }
        if (headOrderDeleteBtn) {
            headOrderDeleteBtn.style.display = currentHeadOrderRow ? 'inline-block' : 'none';
            headOrderDeleteBtn.disabled = !standingOrdersAvailable;
        }

        const teamOrderSaveBtn = document.getElementById('team-order-save');
        const headOrderSaveBtn = document.getElementById('team-head-order-save');
        const resendBtn = document.getElementById('btn-team-orders-resend');
        if (teamOrderSaveBtn) teamOrderSaveBtn.disabled = !standingOrdersAvailable;
        if (headOrderSaveBtn) headOrderSaveBtn.disabled = !standingOrdersAvailable;
        if (resendBtn) resendBtn.disabled = !standingOrdersAvailable;

        // Render inherited orders
        const inheritedList = document.getElementById('team-inherited-orders-list');
        if (inheritedList) {
            inheritedList.innerHTML = '';
            const inherited = standingOrders.filter(o => {
                const scope = o.scope || 'pair';
                if (scope === 'global') return true;
                if (scope === 'pair') {
                    return members.includes(o.parent) || (o.child && members.includes(o.child));
                }
                return false;
            });
            if (inherited.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'inherited-order-item';
                empty.style.color = 'var(--text-secondary)';
                empty.style.fontStyle = 'italic';
                empty.textContent = 'None';
                inheritedList.appendChild(empty);
            } else {
                for (const o of inherited) {
                    const item = document.createElement('div');
                    item.className = 'inherited-order-item';
                    const badge = document.createElement('span');
                    badge.className = 'inherited-order-badge';
                    badge.textContent = o.scope === 'global' ? 'GLOBAL' : `PAIR (${o.parent}→${o.child})`;
                    const text = document.createElement('span');
                    text.textContent = o.instruction;
                    item.appendChild(badge);
                    item.appendChild(text);
                    inheritedList.appendChild(item);
                }
            }
        }

        // Preview target dropdown
        const previewTargetSel = document.getElementById('team-orders-preview-target');
        if (previewTargetSel) {
            const curVal = previewTargetSel.value;
            previewTargetSel.innerHTML = '';
            const targets = members.slice();
            if (headName && !targets.includes(headName)) {
                targets.unshift(headName);
            }
            if (targets.length === 0) {
                targets.push('member');
            }
            for (const t of targets) {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t === headName ? `${t} (Head)` : `${t} (Member)`;
                previewTargetSel.appendChild(opt);
            }
            if (curVal && targets.includes(curVal)) {
                previewTargetSel.value = curVal;
            }
        }

        updateTeamOrdersPreview();
    }

    function updateTeamOrdersPreview() {
        const previewEl = document.getElementById('team-orders-preview-block');
        const previewTargetSel = document.getElementById('team-orders-preview-target');
        if (!previewEl || !previewTargetSel) return;

        const targetName = previewTargetSel.value;
        const previewOutput = applyStandingOrdersClient('Prompt text...', targetName, standingOrders, liveNameSet());
        const markerIdx = previewOutput.indexOf(STANDING_ORDERS_MARKER);
        if (markerIdx !== -1) {
            previewEl.textContent = previewOutput.substring(markerIdx);
        } else {
            previewEl.textContent = '(No standing orders apply to this terminal)';
        }
    }

    async function deleteStandingOrderById(id, successMsg) {
        if (!id) return;
        try {
            const res = await fetch('/terminals/standing-orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id })
            });
            const data = await res.json();
            if (!data.success) { setTeamOrdersError(data.error || 'Delete failed'); return; }
            if (successMsg) showPaneToast(successMsg);
            await refreshTeamOrdersUI();
        } catch (err) {
            setTeamOrdersError(err.message || String(err));
        }
    }

    async function saveTeamOrder() {
        setTeamOrdersError(null);
        const teamId = currentTeamOrdersTeamId;
        if (!teamId) return;
        const group = terminalGroups.find(g => g && g.id === teamId) || getScopedTeamGroup();
        const headName = group ? teamHeadName(group) : '';
        const text = (document.getElementById('team-order-text')?.value || '').trim();

        if (!text) {
            // Empty instruction routes to delete
            if (currentTeamOrderRow) {
                await deleteStandingOrderById(currentTeamOrderRow.id, 'Team order deleted');
            }
            return;
        }

        try {
            if (currentTeamOrderRow) {
                const res = await fetch('/terminals/standing-orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'update', id: currentTeamOrderRow.id, instruction: text })
                });
                const data = await res.json();
                if (!data.success) { setTeamOrdersError(data.error || 'Update failed'); return; }
                showPaneToast('Team order updated');
            } else {
                const res = await fetch('/terminals/standing-orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add', scope: 'team', teamId, parent: headName || '', instruction: text })
                });
                const data = await res.json();
                if (!data.success) { setTeamOrdersError(data.error || 'Add failed'); return; }
                showPaneToast('Team order created');
            }
            await refreshTeamOrdersUI();
        } catch (err) {
            setTeamOrdersError(err.message || String(err));
        }
    }

    async function saveHeadOrder() {
        setTeamOrdersError(null);
        const teamId = currentTeamOrdersTeamId;
        if (!teamId) return;
        const group = terminalGroups.find(g => g && g.id === teamId) || getScopedTeamGroup();
        const headName = group ? teamHeadName(group) : '';
        const text = (document.getElementById('team-head-order-text')?.value || '').trim();

        if (!text) {
            // Empty instruction routes to delete
            if (currentHeadOrderRow) {
                await deleteStandingOrderById(currentHeadOrderRow.id, 'Head order deleted');
            }
            return;
        }

        try {
            if (currentHeadOrderRow) {
                const res = await fetch('/terminals/standing-orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'update', id: currentHeadOrderRow.id, instruction: text })
                });
                const data = await res.json();
                if (!data.success) { setTeamOrdersError(data.error || 'Update failed'); return; }
                showPaneToast('Head order updated');
            } else {
                const res = await fetch('/terminals/standing-orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add', scope: 'team-head', teamId, parent: headName || '', instruction: text })
                });
                const data = await res.json();
                if (!data.success) { setTeamOrdersError(data.error || 'Add failed'); return; }
                showPaneToast('Head order created');
            }
            await refreshTeamOrdersUI();
        } catch (err) {
            setTeamOrdersError(err.message || String(err));
        }
    }

    async function resendStandingOrdersToMembers() {
        setTeamOrdersError(null);
        const teamId = currentTeamOrdersTeamId;
        if (!teamId) return;
        const group = terminalGroups.find(g => g && g.id === teamId) || getScopedTeamGroup();
        const members = group ? getGroupMembers(group) : [];
        if (members.length === 0) {
            showPaneToast('No members in team');
            return;
        }

        const liveMembers = members.filter(n => fleetList.some(t => t.friendlyName === n && t.status === 'active'));
        if (liveMembers.length === 0) {
            showPaneToast('No active members currently online');
            return;
        }

        let idleCount = 0;
        let busyCount = 0;

        for (const name of liveMembers) {
            const inFlight = dispatchInFlight.get(name) || 0;
            if (inFlight > 0) {
                busyCount++;
                continue;
            }

            idleCount++;
            try {
                await fetch('/terminals/verb/ptySendPrompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name,
                        data: '[OPERATOR NOTICE] Standing orders updated for team.',
                        clearBeforePrompt: false
                    })
                });
            } catch (err) {
                console.warn(`[Terminals] Failed to resend standing orders to ${name}:`, err);
            }
        }

        let msg = `Resent standing orders to ${idleCount} idle member(s)`;
        if (busyCount > 0) {
            msg += ` (${busyCount} busy member(s) skipped)`;
        }
        showPaneToast(msg);
    }

    (function wireTeamOrdersModal() {
        const closeBtn = document.getElementById('team-orders-modal-close');
        const doneBtn = document.getElementById('team-orders-done');
        const saveTeamBtn = document.getElementById('team-order-save');
        const deleteTeamBtn = document.getElementById('team-order-delete');
        const saveHeadBtn = document.getElementById('team-head-order-save');
        const deleteHeadBtn = document.getElementById('team-head-order-delete');
        const resendBtn = document.getElementById('btn-team-orders-resend');
        const btnTeamOrders = document.getElementById('btn-team-orders');
        const previewTargetSel = document.getElementById('team-orders-preview-target');

        const closeModal = () => {
            const modal = document.getElementById('team-orders-modal');
            if (modal) { modal.hidden = true; }
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (doneBtn) doneBtn.addEventListener('click', closeModal);
        if (btnTeamOrders) btnTeamOrders.addEventListener('click', openTeamOrdersModal);
        if (saveTeamBtn) saveTeamBtn.addEventListener('click', saveTeamOrder);
        if (deleteTeamBtn) deleteTeamBtn.addEventListener('click', () => {
            if (currentTeamOrderRow) {
                deleteStandingOrderById(currentTeamOrderRow.id, 'Team order deleted');
            }
        });
        if (saveHeadBtn) saveHeadBtn.addEventListener('click', saveHeadOrder);
        if (deleteHeadBtn) deleteHeadBtn.addEventListener('click', () => {
            if (currentHeadOrderRow) {
                deleteStandingOrderById(currentHeadOrderRow.id, 'Head order deleted');
            }
        });
        if (resendBtn) resendBtn.addEventListener('click', resendStandingOrdersToMembers);
        if (previewTargetSel) previewTargetSel.addEventListener('change', updateTeamOrdersPreview);

        const teamText = document.getElementById('team-order-text');
        const headText = document.getElementById('team-head-order-text');
        for (const el of [teamText, headText]) {
            if (el) {
                el.addEventListener('keydown', (e) => { e.stopPropagation(); });
            }
        }

        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('team-orders-modal');
            if (!modal || modal.hidden) { return; }
            if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
        }, true);
    })();

    // ── Team action bar buttons (relocated from the team header into the
    //    sidebar). Static HTML buttons, wired once at init; shown/hidden by
    //    renderSidebarList based on teamScopeId. The ADD TERMINAL handler
    //    reads team state at click time (getScopedTeamGroup) since it can no
    //    longer capture the group from the render closure. ──────────────
    (function wireTeamActionBar() {
        const btnTeamClear = document.getElementById('btn-team-clear');
        if (btnTeamClear) btnTeamClear.addEventListener('click', () => clearTeam());
        const btnTeamClearMembers = document.getElementById('btn-team-clear-members');
        if (btnTeamClearMembers) btnTeamClearMembers.addEventListener('click', () => clearTeamMembers());
        const btnTeamClose = document.getElementById('btn-team-close');
        if (btnTeamClose) btnTeamClose.addEventListener('click', () => closeTeam());
        const btnTeamRestart = document.getElementById('btn-team-restart');
        if (btnTeamRestart) btnTeamRestart.addEventListener('click', () => restartMissingMembers());
        const btnTeamAck = document.getElementById('btn-team-ack');
        if (btnTeamAck) btnTeamAck.addEventListener('click', () => releaseTeamHeldCards());
        const btnTeamAdd = document.getElementById('btn-team-add');
        if (btnTeamAdd) btnTeamAdd.addEventListener('click', () => {
            const group = getScopedTeamGroup();
            if (!group) { return; }
            const headName = teamHeadName(group);
            const headTerm = headName ? fleetList.find(t => t.friendlyName === headName) : null;
            const targetSpec = headTerm && headTerm.parentRoot
                ? { parentRoot: headTerm.parentRoot }
                : undefined;
            onNewTerminalClicked(targetSpec, 'team:' + teamScopeId);
        });
    })();

    // ── Controller action bar button. The end-session control that moved
    //    off the rail icon. Shaped like #btn-team-close — labelled,
    //    immediate, no confirm gate (CLAUDE.md). POST /mission-control/stop
    //    disarms the session and archives it, deliberately leaving the
    //    terminal alive (a running agent may have uncommitted context).
    //    After stop, exit controller scope — the session is gone, so the
    //    scoped ops block has nothing to act on. ──────────────────────
    (function wireControllerActionBar() {
        const btnControllerStop = document.getElementById('btn-controller-stop');
        if (btnControllerStop) btnControllerStop.addEventListener('click', () => {
            btnControllerStop.disabled = true;
            fetch('/mission-control/stop', { method: 'POST', credentials: 'same-origin' })
                .then(res => res.json())
                .then(result => {
                    if (result.success) {
                        showPaneToast('Mission Control session ended');
                    } else {
                        showPaneToast('Failed to stop Mission Control: ' + (result.error || 'unknown'));
                    }
                })
                .catch(err => {
                    showPaneToast('Failed to stop Mission Control: ' + err.message);
                })
                .finally(() => {
                    btnControllerStop.disabled = false;
                    exitControllerScope();
                });
        });
    })();

    let currentTeamAutosTeamId = null;
    let cachedSchedulerConfig = null;

    function setTeamAutomationsError(msg) {
        const errEl = document.getElementById('team-automations-error');
        if (!errEl) return;
        if (!msg) {
            errEl.hidden = true;
            errEl.textContent = '';
        } else {
            errEl.hidden = false;
            errEl.textContent = msg;
        }
    }

    async function openTeamAutomationsModal() {
        const modal = document.getElementById('team-automations-modal');
        if (!modal) return;

        const group = getScopedTeamGroup() || (terminalGroups.length > 0 ? terminalGroups[0] : null);
        if (!group) {
            showPaneToast('No team group found');
            return;
        }

        currentTeamAutosTeamId = group.id;
        const titleEl = document.getElementById('team-automations-modal-title');
        if (titleEl) {
            titleEl.textContent = `Team automations — ${group.name || group.shortName || 'Team'}`;
        }

        const form = document.getElementById('team-auto-form');
        if (form) form.style.display = 'none';

        setTeamAutomationsError(null);
        modal.hidden = false;

        await refreshTeamAutomationsUI();
    }

    async function refreshTeamAutomationsUI() {
        setTeamAutomationsError(null);
        const listEl = document.getElementById('team-automations-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        try {
            const res = await fetch('/kanban/verb/getSchedulerConfig', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const data = await res.json();
            if (!data.success || !data.config) {
                setTeamAutomationsError(data.error || 'Failed to load scheduler config');
                return;
            }
            cachedSchedulerConfig = data.config;

            const group = terminalGroups.find(g => g && g.id === currentTeamAutosTeamId) || getScopedTeamGroup();
            const teamId = currentTeamAutosTeamId;
            const jobs = (Array.isArray(cachedSchedulerConfig.jobs) ? cachedSchedulerConfig.jobs : [])
                .filter(j => j.source === 'team-automation' && j.teamTarget?.groupId === teamId);

            if (jobs.length === 0) {
                const empty = document.createElement('div');
                empty.style.color = 'var(--text-secondary)';
                empty.style.fontStyle = 'italic';
                empty.style.padding = '12px 0';
                empty.textContent = 'No automations configured for this team. Click + NEW AUTOMATION below to create one.';
                listEl.appendChild(empty);
                return;
            }

            const headName = group ? teamHeadName(group) : '';

            for (const job of jobs) {
                const card = document.createElement('div');
                card.className = 'team-orders-section';
                card.style.display = 'flex';
                card.style.flexDirection = 'column';
                card.style.gap = '6px';
                card.style.background = 'rgba(255, 255, 255, 0.02)';
                card.style.padding = '8px 10px';
                card.style.border = '1px solid var(--border-color)';
                card.style.borderRadius = '4px';

                // Top row: enabled checkbox + label + interval + actions
                const topRow = document.createElement('div');
                topRow.style.display = 'flex';
                topRow.style.alignItems = 'center';
                topRow.style.justifyContent = 'space-between';
                topRow.style.gap = '8px';

                const leftInfo = document.createElement('div');
                leftInfo.style.display = 'flex';
                leftInfo.style.alignItems = 'center';
                leftInfo.style.gap = '8px';

                const enabledCb = document.createElement('input');
                enabledCb.type = 'checkbox';
                enabledCb.checked = !!job.enabled;
                enabledCb.title = 'Enable / disable automation';
                enabledCb.addEventListener('change', async () => {
                    job.enabled = enabledCb.checked;
                    await saveSchedulerConfigDirect();
                });
                leftInfo.appendChild(enabledCb);

                const labelSpan = document.createElement('span');
                labelSpan.style.fontWeight = '600';
                labelSpan.style.color = 'var(--text-primary)';
                labelSpan.textContent = job.label || 'Untitled Automation';
                leftInfo.appendChild(labelSpan);

                const intervalBadge = document.createElement('span');
                intervalBadge.className = 'inherited-order-badge';
                intervalBadge.textContent = `${job.intervalMinutes || 10}m${job.advanceWhenReady ? ' (ready)' : ''}`;
                if (job.advanceWhenReady) {
                    intervalBadge.title = 'Fires on completion; interval is the fallback';
                }
                leftInfo.appendChild(intervalBadge);


                topRow.appendChild(leftInfo);

                const btnGroup = document.createElement('div');
                btnGroup.style.display = 'flex';
                btnGroup.style.gap = '6px';

                const runNowBtn = document.createElement('button');
                runNowBtn.type = 'button';
                runNowBtn.className = 'secondary-btn is-teal';
                runNowBtn.textContent = 'RUN NOW';
                runNowBtn.title = 'Run automation immediately on target';
                runNowBtn.addEventListener('click', async () => {
                    runNowBtn.disabled = true;
                    try {
                        const runRes = await fetch('/kanban/verb/runSchedulerJob', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jobId: job.id })
                        });
                        const runData = await runRes.json();
                        if (runData.success) {
                            showPaneToast(`Ran '${job.label}' → ${runData.target || 'target'}`);
                        } else {
                            showPaneToast(`Run '${job.label}' skipped: ${runData.outcome || runData.error}`);
                        }
                        await refreshTeamAutomationsUI();
                    } catch (err) {
                        setTeamAutomationsError('Run failed: ' + (err.message || String(err)));
                    } finally {
                        runNowBtn.disabled = false;
                    }
                });
                btnGroup.appendChild(runNowBtn);

                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'secondary-btn';
                editBtn.textContent = 'EDIT';
                editBtn.addEventListener('click', () => {
                    openEditAutomationForm(job);
                });
                btnGroup.appendChild(editBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'secondary-btn';
                deleteBtn.textContent = 'DELETE';
                deleteBtn.title = 'Delete automation immediately';
                deleteBtn.addEventListener('click', async () => {
                    await deleteTeamAutomation(job.id);
                });
                btnGroup.appendChild(deleteBtn);

                topRow.appendChild(btnGroup);
                card.appendChild(topRow);

                // Middle row: Target resolution info
                const targetRow = document.createElement('div');
                targetRow.style.fontSize = '11px';
                targetRow.style.color = 'var(--text-secondary)';

                const targetRole = job.teamTarget?.role;
                const teamRoster = group
                    ? (Array.isArray(group.order) && group.order.length ? group.order : (Array.isArray(group.members) ? group.members : []))
                    : [];
                let targetDisplay = '';
                if (targetRole) {
                    const match = fleetList.find(t => teamRoster.includes(t.friendlyName) && t.status === 'active' && normalizeAgentRoleKey(t.role) === normalizeAgentRoleKey(targetRole));
                    if (match) {
                        targetDisplay = `Target: Role '${targetRole}' → ${match.friendlyName} (live)`;
                    } else {
                        targetDisplay = `Target: Role '${targetRole}' (not live / offline)`;
                    }
                } else {
                    const headTerm = headName ? fleetList.find(t => t.friendlyName === headName && t.status === 'active') : null;
                    if (headTerm) {
                        targetDisplay = `Target: Head → ${headName} (live)`;
                    } else {
                        targetDisplay = `Target: Head (${headName || 'unknown'}) (not live / offline)`;
                    }
                }
                targetRow.textContent = targetDisplay;
                card.appendChild(targetRow);

                // Bottom row: Last run & outcome
                const outcomeRow = document.createElement('div');
                outcomeRow.style.fontSize = '10px';
                outcomeRow.style.color = 'var(--text-secondary)';
                if (job.lastRunAt) {
                    const d = new Date(job.lastRunAt);
                    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    outcomeRow.textContent = `Last run: ${timeStr} — Outcome: ${job.lastOutcome || 'unknown'}${job.lastTarget ? ` (${job.lastTarget})` : ''}`;
                } else {
                    outcomeRow.textContent = 'Last run: Never';
                }
                card.appendChild(outcomeRow);

                listEl.appendChild(card);
            }
        } catch (err) {
            setTeamAutomationsError('Failed to refresh automations: ' + (err.message || String(err)));
        }
    }

    function normalizeAgentRoleKey(role) {
        if (!role) return '';
        return String(role).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function openEditAutomationForm(job) {
        const form = document.getElementById('team-auto-form');
        const formTitle = document.getElementById('team-auto-form-title');
        const idInput = document.getElementById('team-auto-id');
        const labelInput = document.getElementById('team-auto-label');
        const intervalInput = document.getElementById('team-auto-interval');
        const roleInput = document.getElementById('team-auto-role');
        const promptInput = document.getElementById('team-auto-prompt');
        const enabledCb = document.getElementById('team-auto-enabled');
        const advanceReadyCb = document.getElementById('team-auto-advance-ready');

        if (!form) return;

        if (job) {
            if (formTitle) formTitle.textContent = 'Edit Automation';
            if (idInput) idInput.value = job.id;
            if (labelInput) labelInput.value = job.label || '';
            if (intervalInput) intervalInput.value = job.intervalMinutes || 10;
            if (roleInput) roleInput.value = job.teamTarget?.role || '';
            const customPrompt = typeof job.sourceConfig?.prompt === 'string' ? job.sourceConfig.prompt : '';
            if (promptInput) promptInput.value = job.promptOverride || customPrompt || '';
            if (enabledCb) enabledCb.checked = !!job.enabled;
            if (advanceReadyCb) advanceReadyCb.checked = !!job.advanceWhenReady;
        } else {
            if (formTitle) formTitle.textContent = 'New Automation';
            if (idInput) idInput.value = '';
            if (labelInput) labelInput.value = '';
            if (intervalInput) intervalInput.value = '10';
            if (roleInput) roleInput.value = '';
            if (promptInput) promptInput.value = '';
            if (enabledCb) enabledCb.checked = true;
            if (advanceReadyCb) advanceReadyCb.checked = false;
        }

        form.style.display = 'block';
    }

    async function saveTeamAutomation() {
        setTeamAutomationsError(null);
        const teamId = currentTeamAutosTeamId;
        if (!teamId) return;

        const idInput = document.getElementById('team-auto-id');
        const labelInput = document.getElementById('team-auto-label');
        const intervalInput = document.getElementById('team-auto-interval');
        const roleInput = document.getElementById('team-auto-role');
        const promptInput = document.getElementById('team-auto-prompt');
        const enabledCb = document.getElementById('team-auto-enabled');
        const advanceReadyCb = document.getElementById('team-auto-advance-ready');

        const label = (labelInput?.value || '').trim() || 'Team Automation';
        const intervalMinutes = Math.max(parseInt(intervalInput?.value || '10', 10) || 10, 1);
        const role = (roleInput?.value || '').trim() || undefined;
        const promptText = (promptInput?.value || '').trim();
        const enabled = enabledCb ? enabledCb.checked : true;
        const advanceWhenReady = advanceReadyCb ? advanceReadyCb.checked : false;
        const existingId = idInput?.value || '';

        if (!cachedSchedulerConfig) {
            cachedSchedulerConfig = { schemaVersion: 1, jobs: [] };
        }
        if (!Array.isArray(cachedSchedulerConfig.jobs)) {
            cachedSchedulerConfig.jobs = [];
        }

        if (existingId) {
            const existingJob = cachedSchedulerConfig.jobs.find(j => j.id === existingId);
            if (existingJob) {
                existingJob.label = label;
                existingJob.intervalMinutes = intervalMinutes;
                existingJob.enabled = enabled;
                existingJob.advanceWhenReady = advanceWhenReady;
                existingJob.promptOverride = promptText || undefined;
                existingJob.sourceConfig = { ...existingJob.sourceConfig, prompt: promptText };
                existingJob.teamTarget = { groupId: teamId, role };
            }
        } else {
            const newJob = {
                id: 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                label,
                enabled,
                advanceWhenReady,
                source: 'team-automation',
                target: 'local-terminal',
                intervalMinutes,
                promptOverride: promptText || undefined,
                sourceConfig: { prompt: promptText },
                teamTarget: { groupId: teamId, role }
            };
            cachedSchedulerConfig.jobs.push(newJob);
        }

        await saveSchedulerConfigDirect();
        const form = document.getElementById('team-auto-form');
        if (form) form.style.display = 'none';
        showPaneToast(existingId ? 'Automation updated' : 'Automation created');
        await refreshTeamAutomationsUI();
    }

    async function deleteTeamAutomation(jobId) {
        if (!jobId || !cachedSchedulerConfig) return;
        cachedSchedulerConfig.jobs = cachedSchedulerConfig.jobs.filter(j => j.id !== jobId);
        await saveSchedulerConfigDirect();
        showPaneToast('Automation deleted');
        await refreshTeamAutomationsUI();
    }

    async function saveSchedulerConfigDirect() {
        if (!cachedSchedulerConfig) return;
        try {
            const res = await fetch('/kanban/verb/setSchedulerConfig', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: cachedSchedulerConfig })
            });
            const data = await res.json();
            if (!data.success) {
                setTeamAutomationsError(data.error || 'Failed to save scheduler config');
            }
        } catch (err) {
            setTeamAutomationsError('Save failed: ' + (err.message || String(err)));
        }
    }

    (function wireTeamAutomationsModal() {
        const closeBtn = document.getElementById('team-automations-modal-close');
        const doneBtn = document.getElementById('team-automations-done');
        const btnNew = document.getElementById('btn-team-auto-new');
        const btnSave = document.getElementById('team-auto-save');
        const btnCancel = document.getElementById('team-auto-cancel');
        const btnSidebarAutos = document.getElementById('btn-team-automations');

        const closeModal = () => {
            const modal = document.getElementById('team-automations-modal');
            if (modal) { modal.hidden = true; }
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (doneBtn) doneBtn.addEventListener('click', closeModal);
        if (btnSidebarAutos) btnSidebarAutos.addEventListener('click', openTeamAutomationsModal);
        if (btnNew) btnNew.addEventListener('click', () => openEditAutomationForm(null));
        if (btnSave) btnSave.addEventListener('click', saveTeamAutomation);
        if (btnCancel) btnCancel.addEventListener('click', () => {
            const form = document.getElementById('team-auto-form');
            if (form) form.style.display = 'none';
        });

        const labelInput = document.getElementById('team-auto-label');
        const roleInput = document.getElementById('team-auto-role');
        const promptInput = document.getElementById('team-auto-prompt');
        for (const el of [labelInput, roleInput, promptInput]) {
            if (el) {
                el.addEventListener('keydown', (e) => { e.stopPropagation(); });
            }
        }

        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('team-automations-modal');
            if (!modal || modal.hidden) { return; }
            if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
        }, true);
    })();

    // ── Terminal session log viewer ──────────────────────────────────────
    //
    // Opens a full-screen overlay showing the terminal's session log as a
    // readable markdown document, with a sidebar for browsing other sessions.
    // Reuses renderMarkdown (sharedUtils.js) and the .content-row / sidebar
    // layout pattern from tickets.html. Fetches the log tail-first via the
    // ranged endpoint to avoid handing renderMarkdown a multi-megabyte string.

    let logViewOverlay = null;
    // Held so closeLogView can unregister it. Registered per open and torn down
    // per close: without this, closing via the Close button leaves a document
    // capture-phase keydown listener behind for every log view ever opened.
    let logViewEscHandler = null;

    function closeLogView() {
        if (logViewEscHandler) {
            document.removeEventListener('keydown', logViewEscHandler, true);
            logViewEscHandler = null;
        }
        if (logViewOverlay) {
            logViewOverlay.remove();
            logViewOverlay = null;
        }
    }

    async function openLogView(terminalName) {
        if (logViewOverlay) { closeLogView(); }

        const overlay = document.createElement('div');
        overlay.className = 'log-view-overlay';
        overlay.id = 'log-view-overlay';

        // Sidebar (session list) + detail (rendered markdown), reusing the
        // .content-row / #tree-pane pattern from tickets.html.
        const contentRow = document.createElement('div');
        contentRow.className = 'content-row log-view-content-row';

        const sidebar = document.createElement('div');
        sidebar.className = 'log-view-sidebar';
        sidebar.id = 'log-view-sidebar';

        const sidebarHeader = document.createElement('div');
        sidebarHeader.className = 'log-view-sidebar-header';
        const sidebarTitle = document.createElement('span');
        sidebarTitle.textContent = `${terminalName} — sessions`;
        sidebarHeader.appendChild(sidebarTitle);

        const sidebarToggle = document.createElement('button');
        sidebarToggle.className = 'log-view-close-btn';
        sidebarToggle.textContent = 'Close';
        sidebarToggle.title = 'Close the log view';
        sidebarToggle.addEventListener('click', closeLogView);
        sidebarHeader.appendChild(sidebarToggle);

        const sessionList = document.createElement('div');
        sessionList.className = 'log-view-session-list';

        sidebar.appendChild(sidebarHeader);
        sidebar.appendChild(sessionList);

        const detail = document.createElement('div');
        detail.className = 'log-view-detail';
        const detailContent = document.createElement('div');
        detailContent.className = 'log-view-detail-content';
        detail.appendChild(detailContent);

        contentRow.appendChild(sidebar);
        contentRow.appendChild(detail);
        overlay.appendChild(contentRow);

        // Close on Escape or overlay backdrop click.
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { closeLogView(); }
        });
        logViewEscHandler = (e) => {
            if (e.key === 'Escape') { closeLogView(); }
        };
        document.addEventListener('keydown', logViewEscHandler, true);

        document.body.appendChild(overlay);
        logViewOverlay = overlay;

        // Load the session list for the sidebar.
        try {
            const res = await fetch(`/terminals/${encodeURIComponent(terminalName)}/logs`, { credentials: 'same-origin' });
            if (res.ok) {
                const data = await res.json();
                if (data.success && Array.isArray(data.sessions)) {
                    renderLogSessionList(sessionList, data.sessions, terminalName, detailContent);
                }
            }
        } catch { /* best-effort — sidebar is optional */ }

        // Load the most recent session's log content.
        await loadLogContent(terminalName, null, detailContent);
    }

    function renderLogSessionList(container, sessions, terminalName, detailEl) {
        container.innerHTML = '';
        if (sessions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'log-view-session-empty';
            empty.textContent = 'No sessions logged yet.';
            container.appendChild(empty);
            return;
        }
        for (const session of sessions) {
            const item = document.createElement('div');
            item.className = 'log-view-session-item';
            const date = new Date(session.mtime);
            const sizeKB = Math.round(session.size / 1024);
            item.textContent = `${date.toLocaleString()} (${sizeKB} KB)`;
            item.title = session.filename;
            item.addEventListener('click', () => {
                // Highlight the selected session.
                for (const child of container.children) {
                    child.classList.remove('selected');
                }
                item.classList.add('selected');
                loadLogContent(terminalName, session.filename, detailEl);
            });
            container.appendChild(item);
            // Auto-select the first (most recent) session.
            if (container.children.length === 1) {
                item.classList.add('selected');
            }
        }
    }

    async function loadLogContent(terminalName, sessionFile, detailEl) {
        detailEl.innerHTML = '<div class="log-view-loading">Loading…</div>';
        try {
            const url = sessionFile
                ? `/terminals/${encodeURIComponent(terminalName)}/log?session=${encodeURIComponent(sessionFile)}`
                : `/terminals/${encodeURIComponent(terminalName)}/log`;
            const res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) {
                if (res.status === 404) {
                    detailEl.innerHTML = '<div class="log-view-empty">No log found for this terminal. Logs are created when the terminal produces output.</div>';
                } else {
                    detailEl.innerHTML = `<div class="log-view-error">Failed to load log (HTTP ${res.status}).</div>`;
                }
                return;
            }
            const text = await res.text();
            if (!text.trim()) {
                detailEl.innerHTML = '<div class="log-view-empty">The log is empty — the terminal has not produced output yet.</div>';
                return;
            }
            // renderMarkdown is from sharedUtils.js, loaded before terminals.js.
            detailEl.innerHTML = (typeof renderMarkdown === 'function')
                ? (renderMarkdown(text) || '')
                : `<pre>${text.replace(/</g, '&lt;')}</pre>`;
        } catch (err) {
            detailEl.innerHTML = `<div class="log-view-error">Failed to load log: ${err instanceof Error ? err.message : String(err)}</div>`;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
