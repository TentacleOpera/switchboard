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
    const terminalsMap = new Map(); // name -> { handle, container, ws, term, fitAddon, lastSeq, batchQueue, animationFrameId, reconnectTimer, reconnectDelay, resizeObserver, exited }
    let fleetList = [];

    const listEl = document.getElementById('terminals-list');
    const mainEl = document.getElementById('terminals-main');
    const emptyStateEl = document.getElementById('empty-state');
    const btnNew = document.getElementById('btn-new-terminal');
    const paneGridEl = document.getElementById('pane-grid');
    const toastContainerEl = document.getElementById('toast-container');
    const fallbackBannerEl = document.getElementById('layout-fallback-banner');
    const notifyToggleEl = document.getElementById('notify-toggle');

    function utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        return btoa(bin);
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
     * `fontFamily: 'var(--font-mono)'` survives the DOM renderer (an inline style
     * resolves the var against :root) but is meaningless to a canvas/WebGL
     * renderer, which passes the string straight to `ctx.font` where `var()` is
     * invalid — yielding a silent fallback and wrong glyph metrics. Resolve it here
     * so the GPU renderers measure the same font the DOM one drew.
     */
    function resolveMonoFont() {
        try {
            const resolved = getComputedStyle(document.documentElement)
                .getPropertyValue('--font-mono')
                .trim();
            if (resolved) { return resolved; }
        } catch { /* fall through */ }
        return 'Menlo, Monaco, "Courier New", monospace';
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
    function attachRenderer(term) {
        const holder = { current: null };
        if (window.WebglAddon && window.WebglAddon.WebglAddon) {
            try {
                const webgl = new window.WebglAddon.WebglAddon();
                // A lost context (GPU reset, driver crash, too many live contexts)
                // leaves the addon painting nothing at all. Drop to canvas rather
                // than leaving the operator with a blank terminal.
                webgl.onContextLoss(() => {
                    console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
                    try { webgl.dispose(); } catch { /* ignore */ }
                    holder.current = attachCanvasRenderer(term);
                });
                term.loadAddon(webgl);
                holder.current = webgl;
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

    function getSlotCount(layout) {
        switch (layout) {
            case '2h': return 2;
            case '2v': return 2;
            case '2x2': return 4;
            case '1':
            default: return 1;
        }
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

        if (['1', '2h', '2v', '2x2'].includes(savedMode)) {
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

    function sanitizePaneAssignments() {
        const liveNames = new Set(fleetList.map(t => t.friendlyName));
        // Sized by the USER's layout, not the floored one — a temporarily floored window
        // must not truncate (and then persist away) the assignments of the panes it is
        // merely declining to render.
        const slotCount = getSlotCount(currentLayout);

        paneAssignments = paneAssignments.slice(0, slotCount);
        while (paneAssignments.length < slotCount) {
            paneAssignments.push(null);
        }

        // Stale-slot drop: a persisted layout may name terminals that died while the page
        // was closed. Drop those slots individually — never discard the whole layout.
        for (let i = 0; i < paneAssignments.length; i++) {
            if (paneAssignments[i] && !liveNames.has(paneAssignments[i])) {
                paneAssignments[i] = null;
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
                const isAssigned = paneAssignments.includes(item.friendlyName);
                const isFocused = activeTerminalName === item.friendlyName;
                itemDiv.className = 'terminal-item' + (isFocused ? ' active' : '');

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
        if (!['1', '2h', '2v', '2x2'].includes(mode)) return;
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
        if (focusedPaneIndex < 0 || focusedPaneIndex >= getSlotCount(effectiveLayout)) {
            focusedPaneIndex = 0;
        }

        const existingIndex = paneAssignments.indexOf(terminalName);
        if (existingIndex !== -1 && existingIndex !== focusedPaneIndex) {
            paneAssignments[existingIndex] = null;
        }

        paneAssignments[focusedPaneIndex] = terminalName;
        activeTerminalName = terminalName;
        if (terminalBadges.has(terminalName)) {
            terminalBadges.delete(terminalName);
        }

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
                titleEl.textContent = assignedName;
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
                const unassignBtn = document.createElement('button');
                unassignBtn.className = 'btn-close-term';
                unassignBtn.textContent = '×';
                unassignBtn.title = 'Clear pane assignment';
                unassignBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
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

        let mode = currentLayout;
        if (mode === '2x2' && (rect.width < 500 || rect.height < 300)) {
            mode = rect.width >= 400 ? '2h' : '2v';
        }
        if (mode === '2h' && rect.width < 400) { mode = '1'; }
        if (mode === '2v' && rect.height < 250) { mode = '1'; }
        return mode;
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

    function destroyTerminalView(name) {
        const entry = terminalsMap.get(name);
        if (!entry) { return; }
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        if (entry.animationFrameId) { cancelAnimationFrame(entry.animationFrameId); entry.animationFrameId = null; }
        if (entry.batchFallbackTimer) { clearTimeout(entry.batchFallbackTimer); entry.batchFallbackTimer = null; }
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
            try { entry.rendererAddon.current.dispose(); } catch { /* ignore */ }
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
        });

        let fitAddon = null;
        if (window.FitAddon && window.FitAddon.FitAddon) {
            fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);
        }

        term.open(container);
        const rendererAddon = attachRenderer(term);
        if (fitAddon) {
            try { fitAddon.fit(); } catch { /* ignore */ }
        }

        const entry = {
            name,
            container,
            term,
            fitAddon,
            rendererAddon,
            ws: null,
            lastSeq: 0,
            batchQueue: [],
            animationFrameId: null,
            batchFallbackTimer: null,
            reconnectTimer: null,
            reconnectDelay: 500,
            resizeObserver: null,
            exited: false
        };
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
                const base64Data = utf8ToBase64(data);
                entry.ws.send(JSON.stringify({
                    t: 'input',
                    data: base64Data
                }));
            }
        });

        connectTerminalSocket(entry);
    }

    function connectTerminalSocket(entry) {
        if (entry.ws) {
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }

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
        if (!entry.animationFrameId) {
            entry.animationFrameId = requestAnimationFrame(() => {
                entry.animationFrameId = null;
                flushBatch(entry);
            });
        }
        // rAF is parked while the tab sits in the background, so a chatty terminal
        // would bank its entire output in batchQueue and land it as one enormous
        // write the moment the operator switches back. The timer keeps it draining.
        if (!entry.batchFallbackTimer) {
            entry.batchFallbackTimer = setTimeout(() => {
                entry.batchFallbackTimer = null;
                flushBatch(entry);
            }, BATCH_FALLBACK_MS);
        }
    }

    function flushBatch(entry) {
        if (entry.batchFallbackTimer) {
            clearTimeout(entry.batchFallbackTimer);
            entry.batchFallbackTimer = null;
        }
        if (entry.batchQueue.length === 0) { return; }
        const combined = entry.batchQueue.join('');
        entry.batchQueue = [];
        entry.term.write(combined);
    }

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
