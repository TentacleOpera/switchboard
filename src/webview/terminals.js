(function() {
    'use strict';

    let activeTerminalName = null;
    let currentLayout = '1'; // '1', '2h', '2v', '2x2'
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

    function init() {
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

        window.addEventListener('resize', debounce(() => {
            checkLayoutFloorAndFit();
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
                }
            }
        } catch (err) {
            console.warn('[Terminals] Failed to fetch terminal list:', err);
        }
    }

    function sanitizePaneAssignments() {
        const liveNames = new Set(fleetList.map(t => t.friendlyName));
        const slotCount = getSlotCount(currentLayout);

        paneAssignments = paneAssignments.slice(0, slotCount);
        while (paneAssignments.length < slotCount) {
            paneAssignments.push(null);
        }

        for (let i = 0; i < paneAssignments.length; i++) {
            if (paneAssignments[i] && !liveNames.has(paneAssignments[i])) {
                paneAssignments[i] = null;
            }
        }

        if (activeTerminalName && !liveNames.has(activeTerminalName)) {
            activeTerminalName = null;
        }

        if (!paneAssignments.some(name => name !== null) && fleetList.length > 0) {
            paneAssignments[0] = fleetList[0].friendlyName;
            activeTerminalName = fleetList[0].friendlyName;
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

        document.querySelectorAll('.btn-layout').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-layout') === mode);
        });

        sanitizePaneAssignments();
        renderPaneGrid();
        checkLayoutFloorAndFit();
    }

    function assignToFocusedPane(terminalName) {
        if (focusedPaneIndex < 0 || focusedPaneIndex >= getSlotCount(currentLayout)) {
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
        const slotCount = getSlotCount(currentLayout);
        paneGridEl.className = `pane-grid layout-${currentLayout}`;
        paneGridEl.innerHTML = '';

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

    function checkLayoutFloorAndFit() {
        const rect = paneGridEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        let neededFallback = false;
        let fallbackMode = currentLayout;

        if (currentLayout === '2x2' && (rect.width < 500 || rect.height < 300)) {
            fallbackMode = '2h';
            neededFallback = true;
        }
        if ((fallbackMode === '2h' && rect.width < 400) || (fallbackMode === '2v' && rect.height < 250)) {
            fallbackMode = '1';
            neededFallback = true;
        }

        if (neededFallback) {
            fallbackBannerEl.classList.add('visible');
            paneGridEl.className = `pane-grid layout-${fallbackMode}`;
        } else {
            fallbackBannerEl.classList.remove('visible');
            paneGridEl.className = `pane-grid layout-${currentLayout}`;
        }

        batchFitVisiblePanes();
    }

    function batchFitVisiblePanes() {
        requestAnimationFrame(() => {
            const slotCount = getSlotCount(currentLayout);
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
        entry.exited = true;
        if (entry.ws) {
            try { entry.ws.close(); } catch { /* ignore */ }
            entry.ws = null;
        }
        if (entry.resizeObserver) {
            try { entry.resizeObserver.disconnect(); } catch { /* ignore */ }
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
            fontFamily: 'var(--font-mono)',
            theme: {
                background: '#000000',
                foreground: '#e0e0e0',
                cursor: '#00e5ff',
                selectionBackground: 'rgba(0, 229, 255, 0.3)',
            }
        });

        let fitAddon = null;
        if (window.FitAddon && window.FitAddon.FitAddon) {
            fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);
        }

        term.open(container);
        if (fitAddon) {
            try { fitAddon.fit(); } catch { /* ignore */ }
        }

        const entry = {
            name,
            container,
            term,
            fitAddon,
            ws: null,
            lastSeq: 0,
            batchQueue: [],
            animationFrameId: null,
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
        const ws = new WebSocket(wsUrl);
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
                const frame = JSON.parse(event.data);
                if (frame.t === 'out' && typeof frame.data === 'string') {
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
        if (entry.animationFrameId) return;
        entry.animationFrameId = requestAnimationFrame(() => {
            entry.animationFrameId = null;
            if (entry.batchQueue.length > 0) {
                const combined = entry.batchQueue.join('');
                entry.batchQueue = [];
                entry.term.write(combined);
            }
        });
    }

    function handleAgentCompleted(msg) {
        const { planTitle, role, terminalName } = msg;

        let targetTerm = terminalName;
        if (!targetTerm && role) {
            const match = fleetList.find(t => t.role === role);
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
        for (const entry of terminalsMap.values()) {
            if (entry.term) {
                const bg = theme === 'claudify' ? '#181615' : '#000000';
                const fg = theme === 'claudify' ? '#e0dcd3' : '#e0e0e0';
                entry.term.options.theme = {
                    background: bg,
                    foreground: fg,
                    cursor: '#00e5ff',
                    selectionBackground: 'rgba(0, 229, 255, 0.3)'
                };
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
