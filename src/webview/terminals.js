(function() {
    'use strict';

    let activeTerminalName = null;
    const terminalsMap = new Map(); // name -> { handle, container, ws, term, fitAddon, lastSeq, batchQueue, animationFrameId, reconnectTimer, reconnectDelay }
    let fleetList = [];

    const listEl = document.getElementById('terminals-list');
    const mainEl = document.getElementById('terminals-main');
    const emptyStateEl = document.getElementById('empty-state');
    const btnNew = document.getElementById('btn-new-terminal');

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
            btnNew.addEventListener('click', onNewTerminalClicked);
        }
        const pickerCancel = document.getElementById('role-picker-cancel');
        if (pickerCancel) {
            pickerCancel.addEventListener('click', () => {
                const picker = document.getElementById('role-picker');
                if (picker) { picker.hidden = true; }
            });
        }
        // Double-click a name to rename, as well as the ✎ affordance.
        if (listEl) {
            listEl.addEventListener('dblclick', (e) => {
                const nameEl = e.target && e.target.closest ? e.target.closest('.item-name') : null;
                if (nameEl && nameEl.textContent) {
                    beginInlineRename(nameEl, nameEl.textContent);
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
            }
        });

        fetchTerminalList();
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
                    renderSidebarList();
                }
            }
        } catch (err) {
            console.warn('[Terminals] Failed to fetch terminal list:', err);
        }
    }

    function renderSidebarList() {
        listEl.innerHTML = '';
        if (fleetList.length === 0) {
            emptyStateEl.style.display = 'flex';
            if (activeTerminalName) {
                switchActiveTerminal(null);
            }
            return;
        }

        for (const item of fleetList) {
            const div = document.createElement('div');
            div.className = 'terminal-item' + (item.friendlyName === activeTerminalName ? ' active' : '');
            
            const info = document.createElement('div');
            info.className = 'item-info';
            
            const nameEl = document.createElement('div');
            nameEl.className = 'item-name';
            nameEl.textContent = item.friendlyName;
            
            const roleEl = document.createElement('div');
            roleEl.className = 'item-role';
            roleEl.textContent = item.role;

            info.appendChild(nameEl);
            info.appendChild(roleEl);

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
                beginInlineRename(nameEl, item.friendlyName);
            });
            actions.appendChild(renameBtn);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn-close-term';
            closeBtn.textContent = '×';
            closeBtn.title = 'Close terminal';
            // Immediate — no confirm gate, per project rule.
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTerminal(item.friendlyName);
            });
            actions.appendChild(closeBtn);

            div.appendChild(info);
            div.appendChild(dot);
            div.appendChild(actions);

            div.addEventListener('click', () => {
                switchActiveTerminal(item.friendlyName);
            });

            listEl.appendChild(div);
        }

        if (!activeTerminalName && fleetList.length > 0) {
            switchActiveTerminal(fleetList[0].friendlyName);
        }
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
                // getSetting returns the raw value under `value`; accept an array of
                // role strings or an object map of role -> visible.
                const v = data && data.value;
                if (Array.isArray(v) && v.length > 0) { return v.filter(r => typeof r === 'string'); }
                if (v && typeof v === 'object') {
                    const on = Object.keys(v).filter(k => v[k] !== false);
                    if (on.length > 0) { return on; }
                }
            }
        } catch { /* fall through to defaults */ }
        return DEFAULT_ROLES;
    }

    async function onNewTerminalClicked() {
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
                createTerminal(role);
            });
            optionsEl.appendChild(btn);
        }
        picker.hidden = false;
    }

    async function createTerminal(role) {
        try {
            const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.terminal) {
                    await fetchTerminalList();
                    switchActiveTerminal(data.terminal.friendlyName);
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
                // The socket URL is keyed by name, so the old view must go; the
                // renamed terminal re-attaches lazily on next selection.
                destroyTerminalView(name);
                if (activeTerminalName === name) { activeTerminalName = next; }
            }
            await fetchTerminalList();
        } catch (err) {
            console.error('[Terminals] Failed to rename terminal:', err);
        }
    }

    /** Swap the name label for an input, commit on Enter/blur, cancel on Escape. */
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
            if (activeTerminalName === name) { activeTerminalName = null; }
            await fetchTerminalList();
        } catch (err) {
            console.error('[Terminals] Failed to close terminal:', err);
        }
    }

    /**
     * Full teardown for one terminal view. Closing the socket alone left the xterm
     * instance, its ResizeObserver and its container alive with the map entry still
     * present — so `terminalsMap.has(name)` stayed true forever, which both leaked a
     * renderer per closed terminal and let the reconnect guard resurrect a socket
     * for a terminal that no longer exists.
     */
    function destroyTerminalView(name) {
        const entry = terminalsMap.get(name);
        if (!entry) { return; }
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        if (entry.animationFrameId) { cancelAnimationFrame(entry.animationFrameId); entry.animationFrameId = null; }
        entry.exited = true; // stops ws.onclose from scheduling another attempt
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

    function switchActiveTerminal(name) {
        activeTerminalName = name;
        renderSidebarList();

        for (const [tName, entry] of terminalsMap.entries()) {
            if (tName === name) {
                entry.container.classList.add('active');
                if (entry.fitAddon) {
                    try { entry.fitAddon.fit(); } catch { /* ignore */ }
                }
            } else {
                entry.container.classList.remove('active');
            }
        }

        if (name) {
            emptyStateEl.style.display = 'none';
            if (!terminalsMap.has(name)) {
                createTerminalView(name);
            }
        } else {
            emptyStateEl.style.display = 'flex';
        }
    }

    function createTerminalView(name) {
        const container = document.createElement('div');
        container.className = 'terminal-view-host active';
        mainEl.appendChild(container);

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
        if (window.__SB_TERMINAL_TOKEN__) {
            wsUrl += `&token=${encodeURIComponent(window.__SB_TERMINAL_TOKEN__)}`;
        }
        const ws = new WebSocket(wsUrl);
        entry.ws = ws;

        ws.onopen = () => {
            entry.reconnectDelay = 500; // reset on success
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
                        return; // Dedup
                    }
                    if (frame.seq) {
                        entry.lastSeq = frame.seq;
                    }
                    const rawData = base64ToUtf8(frame.data);
                    entry.batchQueue.push(rawData);
                    scheduleBatchFlush(entry);
                } else if (frame.t === 'error') {
                    // e.g. 4404 no-such-terminal from the gateway's attach path.
                    entry.exited = true;
                    entry.term.write(`\r\n\x1b[31m[${frame.message || 'Terminal unavailable'}]\x1b[0m\r\n`);
                    entry.term.options.disableStdin = true;
                } else if (frame.t === 'exit') {
                    const exitCode = typeof frame.code === 'number' ? frame.code : 0;
                    // Latch it: ws.onclose fires immediately after and must not
                    // schedule a reconnect. Relying on fleetList's status raced the
                    // list refresh, so a dead terminal re-attached at least once.
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
