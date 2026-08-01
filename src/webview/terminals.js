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
    const collapsedWorktrees = new Set();
    let osNotifyEnabled = false;

    const terminalBadges = new Map(); // terminalName -> string label / count
    // name -> { container, term, fitAddon, rendererAddon, isWebgl, ws, lastSeq, batchQueue,
    //           pendingAckChars, ackSuppressChars, reconnectTimer, reconnectDelay,
    //           resizeObserver, exited, disposed }
    // Batching is page-level (pendingBatchEntries + one shared rAF), so entries hold no
    // timer or frame id of their own.
    const terminalsMap = new Map();
    let fleetList = [];

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
            const parentBody = window.parent && window.parent !== window
                ? window.parent.document.body
                : null;
            if (parentBody) {
                const inherited = ALL_THEME_CLASSES.find(cls => parentBody.classList.contains(cls));
                if (inherited) {
                    document.body.classList.add(inherited);
                    return;
                }
            }
        } catch { /* cross-origin parent — fall through to the default */ }
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

        const layoutBtns = document.querySelectorAll('.btn-layout');
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

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            if (message.type === 'terminalsChanged') {
                fetchTerminalList();
            } else if (message.type === 'switchboardThemeChanged') {
                applyThemeToAllTerminals(message.theme);
            } else if (message.type === 'agentCompleted') {
                handleAgentCompleted(message);
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

        loadLayoutSettings().then(() => {
            fetchTerminalList();
        });
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
        const savedCollapsed = await loadSetting('terminals.collapsedWorktrees', []);
        const savedNotify = await loadSetting('terminals.osNotify', false);

        if (LAYOUT_MODES.includes(savedMode)) {
            currentLayout = savedMode;
        }
        effectiveLayout = currentLayout;
        if (Array.isArray(savedPanes)) {
            paneAssignments = savedPanes;
        }
        if (Array.isArray(savedCollapsed)) {
            savedCollapsed.forEach(c => collapsedWorktrees.add(c));
        }
        osNotifyEnabled = Boolean(savedNotify);
        if (notifyToggleEl) {
            notifyToggleEl.checked = osNotifyEnabled;
        }
    }

    function saveLayoutSettings() {
        saveSetting('terminals.layoutMode', currentLayout);
        saveSetting('terminals.paneAssignments', paneAssignments);
        saveSetting('terminals.collapsedWorktrees', Array.from(collapsedWorktrees));
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
                    fleetList = data.terminals;
                    sanitizePaneAssignments();
                    renderSidebarList();
                    renderPaneGrid();
                    // First paint is also the first chance to measure the grid, so the
                    // floor is evaluated here rather than only on a later resize.
                    applyLayoutFloor();
                }
            }
        } catch (err) {
            console.warn('[Terminals] Failed to fetch terminal list:', err);
        }
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

    function renderSidebarList() {
        listEl.innerHTML = '';
        if (fleetList.length === 0) {
            emptyStateEl.style.display = 'flex';
            paneGridEl.style.display = 'none';
            return;
        }

        emptyStateEl.style.display = 'none';
        paneGridEl.style.display = 'grid';

        const groupsMap = new Map(); // worktreePath -> { basename, fullPath, items: [] }

        for (const item of fleetList) {
            const wtPath = item.worktreePath || 'Workspace Root';
            let group = groupsMap.get(wtPath);
            if (!group) {
                let basename = 'Workspace Root';
                if (item.worktreePath) {
                    const parts = item.worktreePath.replace(/\\/g, '/').split('/').filter(Boolean);
                    basename = parts.length > 0 ? parts[parts.length - 1] : item.worktreePath;
                }
                group = { basename, fullPath: wtPath, items: [] };
                groupsMap.set(wtPath, group);
            }
            group.items.push(item);
        }

        for (const [wtPath, group] of groupsMap.entries()) {
            const groupDiv = document.createElement('div');
            const isCollapsed = collapsedWorktrees.has(wtPath);
            groupDiv.className = 'worktree-group' + (isCollapsed ? ' collapsed' : '');

            const activeCount = group.items.filter(i => i.status !== 'exited').length;
            const exitedCount = group.items.length - activeCount;

            const headerEl = document.createElement('div');
            headerEl.className = 'worktree-group-header';
            headerEl.title = group.fullPath;

            const titleArea = document.createElement('div');
            titleArea.className = 'worktree-title-area';

            const icon = document.createElement('span');
            icon.className = 'worktree-collapse-icon';
            icon.textContent = '▼';

            const nameEl = document.createElement('span');
            nameEl.className = 'worktree-name';
            nameEl.textContent = group.basename;

            const countEl = document.createElement('span');
            countEl.className = 'worktree-count';
            countEl.textContent = `${group.items.length} (${activeCount}a/${exitedCount}x)`;

            titleArea.appendChild(icon);
            titleArea.appendChild(nameEl);
            titleArea.appendChild(countEl);

            const groupNewBtn = document.createElement('button');
            groupNewBtn.className = 'btn-group-new';
            groupNewBtn.textContent = '+';
            groupNewBtn.title = `Spawn terminal in ${group.basename}`;
            groupNewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onNewTerminalClicked(wtPath === 'Workspace Root' ? undefined : wtPath);
            });

            headerEl.appendChild(titleArea);
            headerEl.appendChild(groupNewBtn);

            headerEl.addEventListener('click', () => {
                if (collapsedWorktrees.has(wtPath)) {
                    collapsedWorktrees.delete(wtPath);
                } else {
                    collapsedWorktrees.add(wtPath);
                }
                saveLayoutSettings();
                renderSidebarList();
            });

            groupDiv.appendChild(headerEl);

            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'worktree-items';

            for (const item of group.items) {
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
                roleEl.textContent = item.role;

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

                const renameBtn = document.createElement('button');
                renameBtn.className = 'btn-rename-term';
                renameBtn.textContent = '✎';
                renameBtn.title = 'Rename terminal';
                renameBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    beginInlineRename(termNameEl, item.friendlyName);
                });
                actions.appendChild(renameBtn);

                const clearBtn = document.createElement('button');
                clearBtn.className = 'btn-clear-term';
                clearBtn.textContent = '⌫';
                clearBtn.title = 'Clear terminal (sends /clear)';
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    withClearingFeedback(clearBtn, () => clearTerminal(item.friendlyName));
                });
                actions.appendChild(clearBtn);

                const closeBtn = document.createElement('button');
                closeBtn.className = 'btn-close-term';
                closeBtn.textContent = '×';
                closeBtn.title = 'Close terminal';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeTerminal(item.friendlyName);
                });
                actions.appendChild(closeBtn);

                itemDiv.appendChild(info);
                itemDiv.appendChild(dot);
                itemDiv.appendChild(actions);

                itemDiv.addEventListener('click', () => {
                    assignToFocusedPane(item.friendlyName);
                });

                itemsContainer.appendChild(itemDiv);
            }

            groupDiv.appendChild(itemsContainer);
            listEl.appendChild(groupDiv);
        }
    }

    function setLayoutMode(mode) {
        if (!LAYOUT_MODES.includes(mode)) return;
        currentLayout = mode;
        // Adopt the pick optimistically so the render below is the ONLY render on the
        // common (fits-fine) path — applyLayoutFloor then re-renders only if the new
        // layout actually trips the floor.
        effectiveLayout = mode;

        document.querySelectorAll('.btn-layout').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-layout') === mode);
        });

        sanitizePaneAssignments();
        renderPaneGrid();
        applyLayoutFloor();
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

    function renderPaneGrid() {
        const slotCount = getSlotCount(effectiveLayout);
        paneGridEl.className = `pane-grid layout-${effectiveLayout}`;
        paneGridEl.innerHTML = '';

        // A floored layout can leave the focus on a pane that is no longer rendered.
        if (focusedPaneIndex >= slotCount) { focusedPaneIndex = 0; }

        for (let i = 0; i < slotCount; i++) {
            const paneEl = document.createElement('div');
            paneEl.className = 'terminal-pane' + (i === focusedPaneIndex ? ' focused' : '');
            paneEl.dataset.paneIndex = i;

            paneEl.addEventListener('click', () => {
                if (focusedPaneIndex !== i) {
                    focusedPaneIndex = i;
                    const nameInPane = paneAssignments[i];
                    if (nameInPane) { activeTerminalName = nameInPane; }
                    renderPaneGrid();
                    renderSidebarList();
                }
            });

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
                titleEl.appendChild(document.createTextNode(assignedName));
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
            if (assignedName) {
                const paneClearBtn = document.createElement('button');
                paneClearBtn.className = 'btn-unassign-pane';
                paneClearBtn.textContent = '⌫';
                paneClearBtn.title = 'Clear terminal (sends /clear)';
                paneClearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    withClearingFeedback(paneClearBtn, () => clearTerminal(assignedName));
                });
                actionsEl.appendChild(paneClearBtn);

                const unassignBtn = document.createElement('button');
                unassignBtn.className = 'btn-unassign-pane';
                unassignBtn.textContent = '⊟';
                unassignBtn.title = 'Remove from pane (terminal keeps running)';
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
                    const entry = terminalsMap.get(name);
                    if (entry && entry.fitAddon) {
                        try {
                            entry.fitAddon.fit();
                            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                                entry.ws.send(JSON.stringify({
                                    t: 'resize',
                                    cols: entry.term.cols,
                                    rows: entry.term.rows
                                }));
                            }
                        } catch { /* ignore */ }
                    }
                }
            }
        });
    }

    const DEFAULT_ROLES = ['coder', 'planner', 'reviewer', 'lead', 'analyst', 'intern'];

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

    async function onNewTerminalClicked(targetWorktreePath) {
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
                createTerminal(role, targetWorktreePath);
            });
            optionsEl.appendChild(btn);
        }
        picker.hidden = false;
    }

    async function createTerminal(role, worktreePath) {
        try {
            const payload = { role };
            if (worktreePath) {
                payload.cwd = worktreePath;
                payload.worktreePath = worktreePath;
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
            terminalBadges.clear();
            renderSidebarList();
            renderPaneGrid();
        } catch (err) {
            console.error('[Terminals] Failed to clear all terminals:', err);
        }
    }

    function withClearingFeedback(btn, run) {
        if (btn.disabled) { return; }
        btn.disabled = true;
        run();
        setTimeout(() => { btn.disabled = false; }, 600);
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

        const entry = {
            name,
            container,
            term,
            fitAddon,
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
            exited: false,
            disposed: false
        };

        term.open(container);
        const rendererAddon = attachRenderer(term, entry);
        entry.rendererAddon = rendererAddon;
        if (fitAddon) {
            try { fitAddon.fit(); } catch { /* ignore */ }
        }
        terminalsMap.set(name, entry);

        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (fitAddon && entry.container.classList.contains('active')) {
                    try {
                        fitAddon.fit();
                        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                            entry.ws.send(JSON.stringify({
                                t: 'resize',
                                cols: term.cols,
                                rows: term.rows
                            }));
                        }
                    } catch { /* ignore */ }
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

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${location.host}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
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
            if (entry.fitAddon) {
                try {
                    entry.fitAddon.fit();
                    ws.send(JSON.stringify({
                        t: 'resize',
                        cols: entry.term.cols,
                        rows: entry.term.rows
                    }));
                } catch { /* ignore */ }
            }
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
                    const exitCode = typeof frame.code === 'number' ? frame.code : 0;
                    entry.exited = true;
                    entry.term.write(`\r\n\x1b[31m[Process Exited with code ${exitCode}]\x1b[0m\r\n`);
                    entry.term.options.disableStdin = true;
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
