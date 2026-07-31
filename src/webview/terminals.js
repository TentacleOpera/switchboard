(function() {
    'use strict';

    let activeTerminalName = null;
    const terminalsMap = new Map(); // name -> { handle, container, ws, term, fitAddon, lastSeq, batchQueue, animationFrameId }
    let fleetList = [];

    const listEl = document.getElementById('terminals-list');
    const mainEl = document.getElementById('terminals-main');
    const emptyStateEl = document.getElementById('empty-state');
    const btnNew = document.getElementById('btn-new-terminal');

    function init() {
        if (btnNew) {
            btnNew.addEventListener('click', onNewTerminalClicked);
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
            const res = await fetch('/kanban/verb/ptyListTerminals', {
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

            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn-close-term';
            closeBtn.textContent = '×';
            closeBtn.title = 'Close terminal';
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

    async function onNewTerminalClicked() {
        const role = prompt('Enter agent role for new terminal (e.g. coder, planner, reviewer):', 'coder');
        if (!role) return;

        try {
            const res = await fetch('/kanban/verb/ptyCreateTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: role.trim() })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.terminal) {
                    await fetchTerminalList();
                    switchActiveTerminal(data.terminal.friendlyName);
                }
            }
        } catch (err) {
            console.error('[Terminals] Failed to create terminal:', err);
        }
    }

    async function closeTerminal(name) {
        try {
            await fetch('/kanban/verb/ptyCloseTerminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            await fetchTerminalList();
        } catch (err) {
            console.error('[Terminals] Failed to close terminal:', err);
        }
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
            animationFrameId: null
        };
        terminalsMap.set(name, entry);

        // Debounced resize observer
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

        // Input handler
        term.onData((data) => {
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                const base64Data = btoa(data);
                entry.ws.send(JSON.stringify({
                    t: 'input',
                    data: base64Data
                }));
            }
        });

        connectTerminalSocket(entry);
    }

    function connectTerminalSocket(entry) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
        const ws = new WebSocket(wsUrl);
        entry.ws = ws;

        ws.onopen = () => {
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
                    const rawData = atob(frame.data);
                    entry.batchQueue.push(rawData);
                    scheduleBatchFlush(entry);
                } else if (frame.t === 'exit') {
                    entry.term.write('\r\n\x1b[31m[Process Exited]\x1b[0m\r\n');
                    entry.term.options.disableStdin = true;
                }
            } catch (err) {
                console.warn('[Terminals] Bad message:', err);
            }
        };

        ws.onclose = () => {
            // Retry connection if terminal still active
            const item = fleetList.find(i => i.friendlyName === entry.name);
            if (item && item.status === 'active') {
                setTimeout(() => {
                    if (terminalsMap.has(entry.name)) {
                        connectTerminalSocket(entry);
                    }
                }, 1000);
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
