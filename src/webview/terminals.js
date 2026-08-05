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
    const collapsedGroups = new Set();
    let osNotifyEnabled = false;

    let soloTerminalName = null;
    let hasFetchedList = false;
    try {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.has('solo')) {
            soloTerminalName = urlParams.get('solo');
        }
    } catch { /* ignore */ }

    const PTY_HOST_ORIGIN = (document.body && document.body.dataset && document.body.dataset.ptyHostOrigin)
        || window.__SB_PTY_HOST_ORIGIN__
        || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

    // role -> agent CLI label ('CLAUDE CLI'), exactly as the kanban column sublines
    // show it. Supplied pre-derived by getStartupCommands; never computed here, so the
    // two surfaces cannot disagree about what a role is running.
    let agentNames = {};

    const terminalBadges = new Map(); // terminalName -> string label / count
    // name -> { container, term, fitAddon, rendererAddon, isWebgl, ws, lastSeq, batchQueue,
    //           pendingAckChars, ackSuppressChars, reconnectTimer, reconnectDelay,
    //           resizeObserver, exited, disposed }
    // Batching is page-level (pendingBatchEntries + one shared rAF), so entries hold no
    // timer or frame id of their own.
    const terminalsMap = new Map();
    let fleetList = [];
    let parentsList = [];

    const listEl = document.getElementById('terminals-list');
    const mainEl = document.getElementById('terminals-main');
    const emptyStateEl = document.getElementById('empty-state');
    const btnNew = document.getElementById('btn-new-terminal');
    const paneGridEl = document.getElementById('pane-grid');
    const toastContainerEl = document.getElementById('toast-container');
    const fallbackBannerEl = document.getElementById('layout-fallback-banner');
    const notifyToggleEl = document.getElementById('notify-toggle');

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
        try {
            entry.fitAddon.fit();
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({
                    t: 'resize',
                    cols: entry.term.cols,
                    rows: entry.term.rows,
                    rendered: true
                }));
            }
        } catch { /* ignore */ }
    }

    const DETACH_GRACE_MS = 15000;
    const detachTimers = new Map();
    const MAX_WEBGL_CONTEXTS = 12;
    let liveWebglContexts = 0;

    function armDetachTimer(name) {
        if (detachTimers.has(name)) return;
        const timerId = setTimeout(() => {
            detachTimers.delete(name);
            if (!paneAssignments.includes(name)) {
                destroyTerminalView(name);
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
        const holder = { current: null };
        if (window.WebglAddon && window.WebglAddon.WebglAddon && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
            try {
                const webgl = new window.WebglAddon.WebglAddon();
                // A lost context (GPU reset, driver crash, too many live contexts)
                // leaves the addon painting nothing at all. Drop to canvas rather
                // than leaving the operator with a blank terminal.
                webgl.onContextLoss(() => {
                    console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
                    if (entry) entry.isWebgl = false;
                    liveWebglContexts = Math.max(0, liveWebglContexts - 1);
                    try { webgl.dispose(); } catch { /* ignore */ }
                    holder.current = attachCanvasRenderer(term);
                });
                term.loadAddon(webgl);
                holder.current = webgl;
                if (entry) entry.isWebgl = true;
                liveWebglContexts++;
                return holder;
            } catch (err) {
                console.warn('[Terminals] WebGL renderer unavailable, falling back:', err);
            }
        }
        holder.current = attachCanvasRenderer(term);
        return holder;
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
        }

        // Before any terminal is constructed — buildTerminalTheme() reads the CSS
        // variables this class selects.
        resolveInitialTheme();

        if (btnNew) {
            btnNew.addEventListener('click', () => onNewTerminalClicked());
        }
        const pickerCancel = document.getElementById('role-picker-cancel');
        if (pickerCancel) {
            pickerCancel.addEventListener('click', () => {
                const picker = document.getElementById('role-picker');
                if (picker) { picker.hidden = true; }
            });
        }

        if (listEl) {
            listEl.addEventListener('dblclick', (e) => {
                const nameEl = e.target && e.target.closest ? e.target.closest('.item-name') : null;
                if (nameEl && nameEl.textContent) {
                    beginInlineRename(nameEl, nameEl.textContent);
                }
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
                    setLayoutMode(requested);
                    saveLayoutSettings();
                }
            });
        });

        if (notifyToggleEl) {
            notifyToggleEl.addEventListener('change', () => {
                osNotifyEnabled = notifyToggleEl.checked;
                if (osNotifyEnabled && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
                    Notification.requestPermission().catch(() => {});
                }
                saveSetting('terminals.osNotify', osNotifyEnabled);
            });
        }

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

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            if (message.type === 'terminalsChanged') {
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

        if (soloTerminalName) {
            // Paint the transient state BEFORE the first fetch. checkSoloNotFound is
            // otherwise only reached from a fetch that SUCCEEDED, so a slow or failed
            // first fetch would leave the window blank instead of "Connecting…".
            checkSoloNotFound();
            fetchTerminalList();
        } else {
            // Labels before the first paint, so rows do not visibly gain their CLI
            // name a beat after appearing.
            Promise.all([loadLayoutSettings(), fetchAgentNames()]).then(() => {
                fetchTerminalList();
            });
        }
    }

    function postFleetStateToShell() {
        if (window.parent === window) { return; }
        const terminals = fleetList.map(t => {
            let light = 'active';
            if (t.status === 'exited') {
                light = 'exited';
            } else if (terminalBadges.has(t.friendlyName)) {
                light = 'done';
            }
            return {
                name: t.friendlyName,
                role: t.role,
                worktreePath: t.worktreePath,
                light
            };
        });
        window.parent.postMessage({
            type: 'terminalFleetState',
            terminals
        }, location.origin);
    }

    const LAYOUTS = {
        '1':   { slots: 1, minW: 0,   minH: 0   },
        '2h':  { slots: 2, minW: 400, minH: 0   },
        '2v':  { slots: 2, minW: 0,   minH: 250 },
        '2x2': { slots: 4, minW: 500, minH: 300 },
        '2x3': { slots: 6, minW: 750, minH: 300 },
        '3x3': { slots: 9, minW: 750, minH: 450 },
    };

    const LAYOUT_FLOOR_ORDER = ['3x3', '2x3', '2x2', '2h', '2v', '1'];
    const LAYOUT_MODES = Object.keys(LAYOUTS);

    function getSlotCount(layout) {
        return (LAYOUTS[layout] || LAYOUTS['1']).slots;
    }

    function getMaxSlotCount() {
        return Math.max(...LAYOUT_MODES.map(m => LAYOUTS[m].slots));
    }

    async function loadSetting(key, defaultVal) {
        try {
            const res = await fetch('/kanban/verb/getSetting', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
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

    async function saveSetting(key, value) {
        if (soloTerminalName) { return; }
        try {
            await fetch('/kanban/verb/saveSetting', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value })
            });
        } catch { /* ignore */ }
    }

    async function loadLayoutSettings() {
        const savedMode = await loadSetting('terminals.layoutMode', '1');
        const savedPanes = await loadSetting('terminals.paneAssignments', []);
        const savedCollapsed = await loadSetting('terminals.collapsedGroups', []);
        const savedNotify = await loadSetting('terminals.osNotify', false);
        const savedPins = await loadSetting('terminals.pinnedPanes', []);

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
        if (Array.isArray(savedCollapsed)) {
            savedCollapsed.forEach(c => collapsedGroups.add(c));
        }
        osNotifyEnabled = Boolean(savedNotify);
        if (notifyToggleEl) {
            notifyToggleEl.checked = osNotifyEnabled;
        }
    }

    function saveLayoutSettings() {
        saveSetting('terminals.layoutMode', currentLayout);
        saveSetting('terminals.paneAssignments', paneAssignments);
        saveSetting('terminals.pinnedPanes', pinnedPanes);
        saveSetting('terminals.collapsedGroups', Array.from(collapsedGroups));
    }

    async function fetchTerminalList() {
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
                    // Self-heal for a custom agent added mid-session: only re-reads when
                    // a role turns up that the cached label map has never seen, so the
                    // common terminalsChanged refresh costs nothing extra.
                    if (fleetList.some(t => t.role && !(t.role in agentNames))) {
                        await fetchAgentNames();
                    }
                    sanitizePaneAssignments();
                    renderSidebarList();
                    renderPaneGrid();
                    // First paint is also the first chance to measure the grid, so the
                    // floor is evaluated here rather than only on a later resize.
                    applyLayoutFloor();
                    postFleetStateToShell();
                    checkSoloNotFound();
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
        checkSoloNotFound();
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

        // Seed pane 0 on FIRST load only. Re-seeding on every list refresh would undo a
        // deliberate pane clear the moment any terminalsChanged broadcast arrived.
        if (!initialAssignmentDone && fleetList.length > 0) {
            initialAssignmentDone = true;
            if (!paneAssignments.some(name => name !== null)) {
                paneAssignments[0] = fleetList[0].friendlyName;
                activeTerminalName = fleetList[0].friendlyName;
            }
        }
    }

    function renderTerminalRow(item) {
        const itemDiv = document.createElement('div');
        const paneIndex = paneAssignments.indexOf(item.friendlyName);
        const isFocused = activeTerminalName === item.friendlyName;
        itemDiv.className = 'terminal-item'
            + (isFocused ? ' active' : '')
            + (paneIndex !== -1 ? ' assigned' : '');

        const info = document.createElement('div');
        info.className = 'item-info';

        const termNameEl = document.createElement('div');
        termNameEl.className = 'item-name';
        termNameEl.textContent = item.friendlyName;

        const roleEl = document.createElement('div');
        roleEl.className = 'item-role';
        const cliLabel = agentNames[item.role];
        roleEl.textContent = (cliLabel && cliLabel !== 'No agent assigned')
            ? `${item.role} · ${cliLabel}`
            : item.role;

        info.appendChild(termNameEl);
        info.appendChild(roleEl);

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
            badge.textContent = terminalBadges.get(item.friendlyName);
            info.appendChild(badge);
        }

        const dot = document.createElement('div');
        dot.className = 'status-dot' + (item.status === 'exited' ? ' exited' : '');

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const locateBtn = document.createElement('button');
        locateBtn.className = 'locate-btn';
        locateBtn.textContent = 'locate';
        locateBtn.title = 'Show this terminal in the focused pane and put the cursor in it';
        locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            locateTerminal(item.friendlyName);
        });
        actions.appendChild(locateBtn);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'locate-btn';
        clearBtn.textContent = 'clear';
        clearBtn.title = 'Send /clear to this terminal';
        clearBtn.disabled = item.status === 'exited';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            withClearingFeedback(clearBtn, () => clearTerminal(item.friendlyName), 'clear');
        });
        actions.appendChild(clearBtn);

        const renameBtn = document.createElement('button');
        renameBtn.className = 'locate-btn';
        renameBtn.textContent = 'rename';
        renameBtn.title = 'Rename terminal';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            beginInlineRename(termNameEl, item.friendlyName);
        });
        actions.appendChild(renameBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'locate-btn is-danger';
        closeBtn.textContent = 'close';
        closeBtn.title = 'Close terminal (ends the process)';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTerminal(item.friendlyName);
        });
        actions.appendChild(closeBtn);

        const topRow = document.createElement('div');
        topRow.className = 'terminal-item-top';
        topRow.appendChild(info);
        topRow.appendChild(dot);

        itemDiv.appendChild(topRow);
        itemDiv.appendChild(actions);

        itemDiv.addEventListener('click', () => {
            locateTerminal(item.friendlyName);
        });

        return itemDiv;
    }

    function renderSidebarList() {
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

        for (const item of fleetList) {
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
                onNewTerminalClicked(parentGroup.fullPath ? { parentRoot: parentGroup.fullPath } : undefined);
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

            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'parent-group-items';

            if (totalItems === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.className = 'empty-parent-notice';
                emptyNotice.textContent = '(no terminals — + to open)';
                itemsContainer.appendChild(emptyNotice);
            } else {
                for (const item of parentGroup.direct) {
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
                        onNewTerminalClicked({ worktreePath: wtPath });
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

                    const wtItemsContainer = document.createElement('div');
                    wtItemsContainer.className = 'worktree-items';
                    for (const item of wtGroup.items) {
                        wtItemsContainer.appendChild(renderTerminalRow(item));
                    }
                    wtDiv.appendChild(wtItemsContainer);
                    itemsContainer.appendChild(wtDiv);
                }
            }

            parentDiv.appendChild(itemsContainer);
            listEl.appendChild(parentDiv);
        }
    }

    function setLayoutMode(mode) {
        if (!LAYOUT_MODES.includes(mode)) return;
        currentLayout = mode;
        // Adopt the pick optimistically so the render below is the ONLY render on the
        // common (fits-fine) path — applyLayoutFloor then re-renders only if the new
        // layout actually trips the floor.
        effectiveLayout = mode;

        document.querySelectorAll('.layout-picker .btn-layout').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-layout') === mode);
        });

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

    function assignToFocusedPane(terminalName) {
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
        if (target === -1 || paneAssignments[target]) {
            for (let i = 0; i < rendered; i++) {
                if (isOpen(i) && !paneAssignments[i]) { target = i; break; }
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

        paneAssignments[target] = terminalName;
        focusedPaneIndex = target;
        activeTerminalName = terminalName;
        if (terminalBadges.has(terminalName)) {
            terminalBadges.delete(terminalName);
        }
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
        paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly');
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
        if (state.key === 'live') {
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

    /** Tell the operator their keystroke went nowhere.
     *
     *  ONE notice per disconnect episode, not one per interval: a 30-second
     *  backoff window with a rolling timer still stacks ten identical lines into
     *  a TUI's screen buffer, and the tenth says nothing the first did not. The
     *  flag resets in ws.onopen, so the next outage reports again. The header chip
     *  is the PERSISTENT signal — this line only catches the operator who is
     *  looking at the terminal rather than the header. */
    function notifyInputDropped(entry) {
        refreshInputState(entry.name);
        if (entry.inputDropNoticed) { return; }
        entry.inputDropNoticed = true;
        try {
            entry.term.write('\r\n\x1b[33m[Not connected — keystroke discarded]\x1b[0m\r\n');
        } catch { /* ignore */ }
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
            const label = isTerseLayout() ? 'c' : 'clear';
            withClearingFeedback(paneClearBtn, () => clearTerminal(targetName), label);
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
            saveLayoutSettings();
            renderPaneGrid();
            renderSidebarList();
        });

        actionsEl.appendChild(pinBtn);
        actionsEl.appendChild(paneClearBtn);
        actionsEl.appendChild(unassignBtn);
        headerEl.appendChild(titleEl);
        headerEl.appendChild(actionsEl);
        paneEl.appendChild(headerEl);

        const contentEl = document.createElement('div');
        contentEl.className = 'pane-content';
        paneEl.appendChild(contentEl);
        return paneEl;
    }

    /** The 6- and 9-pane headers cannot fit the two-word button labels. */
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
        paneEl.classList.remove('is-input-live', 'is-input-connecting', 'is-input-readonly');

        const titleEl = paneEl.querySelector('.pane-title');
        const actionsEl = paneEl.querySelector('.pane-actions');
        const contentEl = paneEl.querySelector('.pane-content');
        const assignedName = paneAssignments[index];
        const terse = isTerseLayout();
        const slotCount = getSlotCount(effectiveLayout);

        titleEl.textContent = '';
        if (assignedName) {
            const idxEl = document.createElement('span');
            const isPinned = Boolean(pinnedPanes[index]);
            idxEl.className = 'pane-index-chip' + (isPinned ? ' is-pinned' : '');
            idxEl.textContent = isPinned ? `📌P${index + 1}` : `P${index + 1}`;
            titleEl.appendChild(idxEl);

            let displayTitle = assignedName;
            const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
            if (fleetItem && fleetItem.status === 'exited') {
                displayTitle += ' (exited)';
            } else if (!fleetItem && hasFetchedList) {
                displayTitle += ' (no longer listed)';
            }
            titleEl.appendChild(document.createTextNode(displayTitle));

            if (terminalBadges.has(assignedName)) {
                const badgeSpan = document.createElement('span');
                badgeSpan.className = 'pane-badge';
                badgeSpan.textContent = terminalBadges.get(assignedName);
                titleEl.appendChild(badgeSpan);
            }

            // Input-state chip. The class goes on the PANE, not the chip: it is
            // the one source of truth the ring and the chip both style off, so
            // they cannot drift apart. Derived live at render time; socket
            // transitions nudge it out-of-band via refreshInputState.
            const state = resolveInputState(assignedName);
            paneEl.classList.add(`is-input-${state.key}`);
            syncInputStateChip(paneEl, titleEl, state);
        } else {
            titleEl.textContent = `Pane ${index + 1} (Empty)`;
        }

        // Labels are re-derived every reconcile: a 2x3 pane demoted to 2h must lose
        // its `c`/`h` initials, which a create-time-only label would keep forever.
        // Indexed, not destructured: the buttons share a class name, so there is
        // no selector that tells them apart, and children[] is the honest read.
        // children[0] = pin, [1] = clear, [2] = hide (order set in createPaneElement).
        const pinBtn = actionsEl.children[0];
        const clearBtn = actionsEl.children[1];
        const hideBtn = actionsEl.children[2];
        clearBtn.textContent = terse ? 'c' : 'clear';
        hideBtn.textContent = terse ? 'h' : 'hide';

        // Pin toggle: text labels (not emoji) to match clear/hide treatment; state
        // carried by colour via .btn-pin-pane.is-pinned and by aria-pressed.
        // Suppressed in a single-slot grid — a pin there can only deadlock, and
        // solo mode forces effectiveLayout = '1' so this covers pop-outs too.
        const pinActive = slotCount > 1;
        const isPinned = Boolean(pinnedPanes[index]);
        pinBtn.textContent = terse ? (isPinned ? 'u' : 'p') : (isPinned ? 'unpin' : 'pin');
        pinBtn.title = isPinned
            ? 'Unpin — this pane can be reassigned again'
            : 'Pin — keep this agent in this pane; other agents go elsewhere';
        pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        pinBtn.classList.toggle('is-pinned', isPinned);
        pinBtn.style.display = (pinActive && assignedName) ? '' : 'none';

        // The buttons now always EXIST (they are reused); an empty pane hides the
        // block rather than omitting it.
        actionsEl.style.display = assignedName ? '' : 'none';

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
                }
                entry.container.classList.add('active');
            }
        } else if (!contentEl.querySelector('.pane-empty-slot')) {
            // Clears a container still parented here from a previous assignment. The
            // node survives in terminalsMap; only its parentage is dropped.
            contentEl.textContent = '';
            const emptySlot = document.createElement('div');
            emptySlot.className = 'pane-empty-slot';
            emptySlot.textContent = 'Click terminal in sidebar to assign';
            contentEl.appendChild(emptySlot);
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

        fallbackBannerEl.classList.toggle('visible', effectiveLayout !== currentLayout);

        if (changed) {
            renderPaneGrid();
            batchFitVisiblePanes();
            return;
        }
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;
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

    const DEFAULT_ROLES = ['coder', 'planner', 'reviewer', 'lead', 'analyst', 'intern'];

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

    async function fetchVisibleRoles() {
        try {
            const res = await fetch('/kanban/verb/getSetting', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'agents.visibleAgents' })
            });
            if (res.ok) {
                const data = await res.json();
                const v = data && data.value;
                if (Array.isArray(v) && v.length > 0) { return v.filter(r => typeof r === 'string'); }
                if (v && typeof v === 'object') {
                    const on = Object.keys(v).filter(k => v[k] !== false);
                    if (on.length > 0) { return on; }
                }
            }
        } catch { /* fall through */ }
        return DEFAULT_ROLES;
    }

    async function onNewTerminalClicked(targetSpec) {
        const picker = document.getElementById('role-picker');
        const optionsEl = document.getElementById('role-picker-options');
        if (!picker || !optionsEl) { return; }

        if (!picker.hidden) { picker.hidden = true; return; }

        const roles = await fetchVisibleRoles();
        optionsEl.innerHTML = '';
        for (const role of roles) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'role-option';
            btn.textContent = role;
            btn.addEventListener('click', () => {
                picker.hidden = true;
                createTerminal(role, targetSpec);
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
        noRoleBtn.addEventListener('click', () => {
            picker.hidden = true;
            createTerminal(NO_ROLE, targetSpec);
        });
        optionsEl.appendChild(noRoleBtn);

        picker.hidden = false;
    }

    async function createTerminal(role, targetSpec) {
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
                    await fetchTerminalList();
                    assignToFocusedPane(data.terminal.friendlyName);
                } else if (data && data.error) {
                    console.error('[Terminals] Create rejected:', data.error);
                }
            }
        } catch (err) {
            console.error('[Terminals] Failed to create terminal:', err);
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
        'analyst', 'ticket_updater', 'researcher', 'claude_artifacts', 'phone_a_friend'
    ];

    /**
     * Mirror of TaskViewerProvider._defaultVisibleAgents(). createAgentGrid tests
     * `visibleAgents[role] !== false` against a map that has ALREADY been merged
     * over these defaults, so reading the saved value raw is not equivalent: an
     * absent key would read as visible and open the opt-in roles (tester,
     * researcher, phone_a_friend and friends) that the extension leaves shut.
     * Keep in step with that method.
     */
    const DEFAULT_VISIBLE_AGENTS = {
        lead: true, coder: true, intern: true, reviewer: true,
        tester: false, planner: true, analyst: true, jules: false,
        ticket_updater: false, researcher: false,
        claude_artifacts: false, phone_a_friend: false, project_manager: true
    };

    async function resolveGridAgents() {
        const [savedVisible, savedCustom, savedPlannerCount] = await Promise.all([
            loadSetting('agents.visibleAgents', undefined),
            loadSetting('agents.customAgents', []),
            loadSetting('agents.plannerTerminalCount', 1)
        ]);

        const custom = Array.isArray(savedCustom)
            ? savedCustom.filter(a => a && typeof a.role === 'string')
            : [];

        const visible = { ...DEFAULT_VISIBLE_AGENTS };
        // A custom agent defaults to visible, matching getVisibleAgents.
        for (const agent of custom) { visible[agent.role] = true; }
        if (Array.isArray(savedVisible)) {
            // Older array form: the listed roles are the visible ones.
            for (const role of Object.keys(visible)) { visible[role] = savedVisible.includes(role); }
            for (const role of savedVisible) { visible[role] = true; }
        } else if (savedVisible && typeof savedVisible === 'object') {
            Object.assign(visible, savedVisible);
        }

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
        return wanted;
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
        const wanted = await resolveGridAgents();
        if (wanted.size === 0) {
            console.warn('[Terminals] Open all: no visible agent roles configured');
            return;
        }

        const liveByRole = new Map();
        for (const t of fleetList) {
            if (t.status === 'exited') { continue; }
            liveByRole.set(t.role, (liveByRole.get(t.role) || 0) + 1);
        }

        let created = 0;
        for (const [role, count] of wanted.entries()) {
            const missing = count - (liveByRole.get(role) || 0);
            // Sequential, not Promise.all: ptyFleetService.create() picks the next
            // free `${role}-${n}` name off its own map, so concurrent creates for
            // the same role can settle on the same name.
            for (let i = 0; i < missing; i++) {
                try {
                    const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.success) { created++; }
                        else if (data && data.error) { console.warn(`[Terminals] Open all: ${role} rejected:`, data.error); }
                    }
                } catch (err) {
                    console.warn(`[Terminals] Open all: failed to create ${role}:`, err);
                }
            }
        }

        await fetchTerminalList();
        if (created > 0) { fillEmptyPanes(); }
    }

    /**
     * Seat unassigned terminals into whatever rendered panes are still empty.
     *
     * Open-all can spawn more terminals than there are panes; the remainder stay in
     * the sidebar and the operator seats them by clicking. Deliberately does not
     * displace anything already on screen.
     */
    function fillEmptyPanes() {
        const slotCount = getSlotCount(effectiveLayout);
        const unseated = fleetList
            .filter(t => t.status !== 'exited' && !paneAssignments.includes(t.friendlyName))
            .map(t => t.friendlyName);
        if (unseated.length === 0) { return; }

        let changed = false;
        for (let i = 0; i < slotCount && unseated.length > 0; i++) {
            if (!paneAssignments[i]) {
                paneAssignments[i] = unseated.shift();
                changed = true;
            }
        }
        if (!changed) { return; }
        if (!activeTerminalName) { activeTerminalName = paneAssignments[focusedPaneIndex] || null; }
        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
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
                if (activeTerminalName === name) { activeTerminalName = next; }
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
            terminalBadges.delete(name);
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
            if (terminalBadges.delete(name)) { renderSidebarList(); renderPaneGrid(); }
        } catch (err) {
            console.error('[Terminals] Failed to clear terminal:', err);
        }
    }

    async function clearAllTerminals() {
        try {
            await fetch('/terminals/verb/ptyClearAllTerminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            // Only re-render if a badge actually went away. renderPaneGrid() empties the
            // grid and reparents every live xterm container — too much teardown to run
            // for no visual change, and the clear itself alters no pane state.
            if (terminalBadges.size > 0) {
                terminalBadges.clear();
                renderSidebarList();
                renderPaneGrid();
            }
        } catch (err) {
            console.error('[Terminals] Failed to clear all terminals:', err);
        }
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

    const pendingBatchEntries = new Set();
    let sharedBatchRafId = null;
    let sharedBatchFallbackTimer = null;

    function destroyTerminalView(name) {
        cancelDetachTimer(name);
        fitLadderGen.delete(name);
        const entry = terminalsMap.get(name);
        if (!entry) { return; }
        entry.disposed = true;
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        pendingBatchEntries.delete(entry);
        entry.exited = true;
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
        // that browsers cap per page (~16 contexts), so leaking one per closed
        // terminal eventually forces every terminal back to the DOM renderer.
        if (entry.rendererAddon && entry.rendererAddon.current) {
            try {
                entry.rendererAddon.current.dispose();
                if (entry.isWebgl) {
                    liveWebglContexts = Math.max(0, liveWebglContexts - 1);
                }
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
            isWebgl: false,
            ws: null,
            lastSeq: 0,
            batchQueue: [],
            pendingAckChars: 0,
            ackSuppressChars: 0,
            bytesWritten: 0,
            writeThrowCount: 0,
            largestInputDataLen: 0,
            totalInputChars: 0,
            inputDropNoticed: false,
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
            pendingModes: null
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
        // Belongs to the socket that just went away. A set left armed by a socket that
        // died mid-replay describes a stream this connection will not receive.
        entry.pendingModes = null;

        let wsUrl = `${PTY_HOST_ORIGIN}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
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
            // A fresh socket earns a fresh drop notice. Paired with
            // notifyInputDropped — see the note there.
            entry.inputDropNoticed = false;
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
                    // Informational only — stdin stays enabled. Input is queued, never
                    // dropped, so the operator can keep typing behind a large paste.
                    if (frame.throttled === false) {
                        entry.term.write(`\r\n\x1b[2m[Input queue drained]\x1b[0m\r\n`);
                    } else {
                        entry.term.write(`\r\n\x1b[2m[Pasting — input queued: ${frame.queued || 0} bytes…]\x1b[0m\r\n`);
                    }
                } else if (frame.t === 'error') {
                    entry.exited = true;
                    entry.term.write(`\r\n\x1b[31m[${frame.message || 'Terminal unavailable'}]\x1b[0m\r\n`);
                    entry.term.options.disableStdin = true;
                    refreshInputState(entry.name);
                } else if (frame.t === 'exit') {
                    if (frame.reason === 'Lagging client evicted') {
                        entry.term.write(`\r\n\x1b[33m[Disconnected — reconnecting…]\x1b[0m\r\n`);
                    } else {
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
            if (entry.exited) { return; }
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
                lastSeq: entry.lastSeq,
                batchQueueLength: entry.batchQueue ? entry.batchQueue.length : 0,
                pendingAckChars: entry.pendingAckChars || 0,
                ackSuppressChars: entry.ackSuppressChars || 0,
                bytesWritten: entry.bytesWritten || 0,
                writeThrowCount: entry.writeThrowCount || 0,
                largestInputDataLen: entry.largestInputDataLen || 0,
                totalInputChars: entry.totalInputChars || 0
            };
        }
        return stats;
    };

    function handleAgentCompleted(msg) {
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
            terminalBadges.set(targetTerm, 'DONE');
            renderSidebarList();
            renderPaneGrid();
            postFleetStateToShell();

            const isKnown = fleetList.some(t => t.friendlyName === targetTerm);
            if (!isKnown) {
                fetchTerminalList();
            }
        }

        showCompletionToast(planTitle || 'Agent Task', role || 'Agent', targetTerm);

        if (osNotifyEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
                new Notification(`Agent Completed: ${role || 'Agent'}`, {
                    body: planTitle || 'Task completed'
                });
            } catch { /* ignore */ }
        }
    }

    function showCompletionToast(title, role, termName) {
        const toast = document.createElement('div');
        toast.className = 'completion-toast';

        const content = document.createElement('div');
        content.className = 'toast-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = `Completed: ${role}`;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        bodyEl.textContent = title + (termName ? ` (${termName})` : '');

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

        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 8000);
    }

    function applyThemeToAllTerminals(theme) {
        // Body class first: buildTerminalTheme reads the CSS variables it selects,
        // so recolouring before the swap would just re-read the outgoing theme.
        setThemeBodyClass(theme);
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
