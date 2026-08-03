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

        if (LAYOUT_MODES.includes(savedMode)) {
            currentLayout = savedMode;
        }
        effectiveLayout = currentLayout;
        if (Array.isArray(savedPanes)) {
            paneAssignments = savedPanes;
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
    let undoSnapshot = null; // { slots: [...paneAssignments], name, displaced, paneIndex }
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
            const paneChip = document.createElement('span');
            paneChip.className = 'pane-index-chip';
            paneChip.textContent = `P${paneIndex + 1}`;
            paneChip.title = `Showing in pane ${paneIndex + 1}`;
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
        if (fleetList.length === 0) {
            if (!soloTerminalName) {
                emptyStateEl.style.display = 'flex';
                paneGridEl.style.display = 'none';
            }
            return;
        }

        emptyStateEl.style.display = 'none';
        paneGridEl.style.display = 'grid';

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
                targetGroup = parentGroups.length === 1 ? parentGroups[0] : unmappedGroup;
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

        let target = focusedPaneIndex;
        if (paneAssignments[target]) {
            let free = -1;
            for (let i = 0; i < rendered; i++) {
                if (!paneAssignments[i]) { free = i; break; }
            }
            if (free !== -1) {
                target = free;
            } else if (existingIndex !== -1 && existingIndex < rendered) {
                // Every rendered pane is full AND this terminal already occupies one of
                // them. Moving it would evict a bystander and leave the terminal's old
                // pane empty — one click clearing two panes for zero gain, which is the
                // defect this function exists to remove. Follow the terminal instead.
                focusedPaneIndex = existingIndex;
                activeTerminalName = terminalName;
                terminalBadges.delete(terminalName);
                renderSidebarList();
                renderPaneGrid();
                postFleetStateToShell();
                return;
            }
        }

        const displaced = paneAssignments[target] || null;
        undoSnapshot = { slots: paneAssignments.slice(), name: terminalName, displaced, paneIndex: target };

        if (existingIndex !== -1) {
            paneAssignments[existingIndex] = null;
        }

        paneAssignments[target] = terminalName;
        focusedPaneIndex = target;
        activeTerminalName = terminalName;
        if (terminalBadges.has(terminalName)) {
            terminalBadges.delete(terminalName);
        }
        postFleetStateToShell();

        if (displaced) {
            showPaneToast(`Pane ${target + 1}: ${displaced} → ${terminalName}`, undoLastAssignment);
        } else {
            // Nothing was destroyed, but undoSnapshot was just replaced — retract any
            // toast still on screen from the previous mutation.
            hidePaneToast();
        }

        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    function undoLastAssignment() {
        if (!undoSnapshot) { return; }
        hidePaneToast();
        paneAssignments = undoSnapshot.slots;
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

    function renderPaneGrid() {
        const slotCount = getSlotCount(effectiveLayout);
        // A rebuild reparents every live xterm, and a re-parented node does not keep
        // focus — removing the focused element from the document drops focus to
        // <body>. renderPaneGrid runs on every terminalsChanged broadcast, every
        // agentCompleted badge and every per-terminal clear, so without this the
        // caret was yanked out mid-keystroke whenever anything happened elsewhere in
        // the fleet. Remember whether the caret was ours and hand it back at the end.
        const hadFocus = paneGridEl.contains(document.activeElement);
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;
        paneGridEl.innerHTML = '';

        // A floored layout can leave the focus on a pane that is no longer rendered.
        if (focusedPaneIndex >= slotCount) { focusedPaneIndex = 0; }

        for (let i = 0; i < slotCount; i++) {
            const paneEl = document.createElement('div');
            paneEl.className = 'terminal-pane' + (i === focusedPaneIndex ? ' focused' : '');
            paneEl.dataset.paneIndex = i;

            // mousedown, not click: it lands before xterm's own selection handling
            // and before mouseup, so one press both selects the pane and leaves the
            // caret in it. On `click` the focus arrived after xterm had already
            // decided where the caret went.
            paneEl.addEventListener('mousedown', () => setFocusedPane(i));

            const headerEl = document.createElement('div');
            headerEl.className = 'pane-header';

            const titleEl = document.createElement('div');
            titleEl.className = 'pane-title';

            const assignedName = paneAssignments[i];
            if (assignedName) {
                const idxEl = document.createElement('span');
                idxEl.className = 'pane-index-chip';
                idxEl.textContent = `P${i + 1}`;
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
            } else {
                titleEl.textContent = `Pane ${i + 1} (Empty)`;
            }

            const actionsEl = document.createElement('div');
            actionsEl.className = 'pane-actions';
            if (assignedName) {
                // Same two words the extension sidebar uses. The 6- and 9-pane
                // headers cannot fit them, so those fall back to initials.
                const terse = effectiveLayout === '2x3' || effectiveLayout === '3x3';

                const paneClearBtn = document.createElement('button');
                paneClearBtn.className = 'btn-unassign-pane';
                paneClearBtn.textContent = terse ? 'c' : 'clear';
                paneClearBtn.title = 'Send /clear to this terminal';
                paneClearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    withClearingFeedback(paneClearBtn, () => clearTerminal(assignedName), terse ? 'c' : 'clear');
                });
                actionsEl.appendChild(paneClearBtn);

                const unassignBtn = document.createElement('button');
                unassignBtn.className = 'btn-unassign-pane';
                unassignBtn.textContent = terse ? 'h' : 'hide';
                unassignBtn.title = 'Remove from this pane (terminal keeps running)';
                unassignBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const targetName = paneAssignments[i];
                    undoSnapshot = { slots: paneAssignments.slice(), name: null, displaced: targetName, paneIndex: i };
                    showPaneToast(`Pane ${i + 1} cleared (${targetName} still running)`, undoLastAssignment);
                    paneAssignments[i] = null;
                    saveLayoutSettings();
                    renderPaneGrid();
                    renderSidebarList();
                });
                actionsEl.appendChild(unassignBtn);
            }

            headerEl.appendChild(titleEl);
            headerEl.appendChild(actionsEl);
            paneEl.appendChild(headerEl);

            const contentEl = document.createElement('div');
            contentEl.className = 'pane-content';

            if (assignedName) {
                let entry = terminalsMap.get(assignedName);
                if (!entry) {
                    createTerminalView(assignedName, contentEl);
                } else {
                    if (entry.container.parentNode !== contentEl) {
                        contentEl.appendChild(entry.container);
                    }
                    entry.container.classList.add('active');
                }
            } else {
                const emptySlot = document.createElement('div');
                emptySlot.className = 'pane-empty-slot';
                emptySlot.textContent = 'Click terminal in sidebar to assign';
                contentEl.appendChild(emptySlot);
            }

            paneEl.appendChild(contentEl);
            paneGridEl.appendChild(paneEl);
        }

        for (const [name, entry] of terminalsMap.entries()) {
            if (!paneAssignments.includes(name)) {
                entry.container.classList.remove('active');
                armDetachTimer(name);
            } else {
                cancelDetachTimer(name);
            }
        }

        if (hadFocus) { focusPaneTerminal(focusedPaneIndex); }
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

    function batchFitVisiblePanes() {
        requestAnimationFrame(() => {
            const slotCount = getSlotCount(effectiveLayout);
            for (let i = 0; i < slotCount; i++) {
                const name = paneAssignments[i];
                if (name) {
                    fitAndReportSize(terminalsMap.get(name));
                }
            }
        });
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
                destroyTerminalView(name);
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
    const pendingBatchEntries = new Set();
    let sharedBatchRafId = null;
    let sharedBatchFallbackTimer = null;

    function destroyTerminalView(name) {
        cancelDetachTimer(name);
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
            reconnectTimer: null,
            reconnectDelay: 500,
            resizeObserver: null,
            pendingObserver: null,
            exited: false,
            disposed: false
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
            fontSize: 13,
            fontFamily: resolveMonoFont(),
            theme: buildTerminalTheme(),
            // Explicit, not xterm's implicit default, because it is now load-bearing:
            // a view disposed on unassign re-attaches by replaying the gateway's
            // MAX_SCROLLBACK_BYTES ring (256 KB ≈ 3000 lines at 80 cols). Keeping the
            // client below that means disposal can never lose scrollback the operator
            // could still have scrolled to. Change the two together.
            scrollback: 1000,
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
        if (fitAddon) {
            try { fitAddon.fit(); } catch { /* ignore */ }
        }

        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // `active` is pane ASSIGNMENT, not visibility — a hidden panel's panes
                // are still "active". fitAndReportSize is what gates on actually
                // having a box.
                if (entry.container.classList.contains('active')) {
                    fitAndReportSize(entry);
                }
            }, 100);
        });
        resizeObserver.observe(container);
        entry.resizeObserver = resizeObserver;

        term.onData((data) => {
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                if (!entry.largestInputDataLen) entry.largestInputDataLen = 0;
                if (data.length > entry.largestInputDataLen) entry.largestInputDataLen = data.length;
                entry.totalInputChars = (entry.totalInputChars || 0) + data.length;
                entry.ws.send(encodeInputFrame(data));
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

    function connectTerminalSocket(entry) {
        if (entry.ws) {
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }
        // Both counters belong to the socket that just went away: the server issues a
        // fresh zeroed credit ledger with the new ClientState, so carrying either one
        // forward would ack characters the new counter never issued.
        entry.pendingAckChars = 0;
        entry.ackSuppressChars = 0;

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

        ws.onopen = () => {
            entry.reconnectDelay = 500;
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
                    entry.batchQueue.push(outputDecoder.decode(new Uint8Array(event.data, 4)));
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
                } else if (frame.t === 'exit') {
                    if (frame.reason === 'Lagging client evicted') {
                        entry.term.write(`\r\n\x1b[33m[Disconnected — reconnecting…]\x1b[0m\r\n`);
                    } else {
                        const exitCode = typeof frame.code === 'number' ? frame.code : 0;
                        entry.exited = true;
                        entry.term.write(`\r\n\x1b[31m[Process Exited with code ${exitCode}]\x1b[0m\r\n`);
                        entry.term.options.disableStdin = true;
                    }
                }
            } catch (err) {
                console.warn('[Terminals] Bad message:', err);
            }
        };

        ws.onclose = () => {
            if (entry.exited) { return; }
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
