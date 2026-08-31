// linear.js — Webview controller for the Linear integration panel
(function () {
    'use strict';

    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : {
        postMessage: (msg) => {
            if (window.sbTransport) {
                window.sbTransport.postMessage(msg);
            }
        }
    };

    // ── Tab switching ────────────────────────────────────────────────────────
    document.querySelectorAll('.shared-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            document.querySelectorAll('.shared-tab-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            document.querySelectorAll('.shared-tab-content').forEach(c => {
                c.classList.remove('active');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            const content = document.querySelector(`[data-tab-content="${targetTab}"]`);
            if (content) content.classList.add('active');
            if (targetTab === 'wire-agent') {
                requestLinearAgentSkill();
            }
        });
    });

    // ── State variables ──────────────────────────────────────────────────────
    let remoteControlActive = false;
    let _remoteHealthTimer = null;
    let _remoteCapabilities = { pull: true, push: true };
    let _lastRemoteConfig = null;
    let _lastLinearConfig = null;
    let _lastSkillText = '';

    // ── Remote control state & health ────────────────────────────────────────
    function applyRemoteControlButtonState() {
        const btn = document.getElementById('btn-linear-remote-control-toggle');
        if (btn) btn.textContent = remoteControlActive ? 'Stop Remote Control' : 'Start Remote Control';
        const stateEl = document.getElementById('linear-remote-control-state');
        if (stateEl) stateEl.textContent = remoteControlActive ? 'Pinging…' : 'Inactive';
        const healthSection = document.getElementById('linear-health-section');
        if (healthSection) healthSection.style.display = remoteControlActive ? 'block' : 'none';
        if (remoteControlActive && !_remoteHealthTimer) {
            _remoteHealthTimer = setInterval(requestRemoteHealth, 15000);
            requestRemoteHealth();
        } else if (!remoteControlActive && _remoteHealthTimer) {
            clearInterval(_remoteHealthTimer);
            _remoteHealthTimer = null;
        }
    }

    function requestRemoteHealth() {
        const wsSel = document.getElementById('linear-workspace');
        vscode.postMessage({ type: 'getRemoteHealth', workspaceRoot: wsSel ? wsSel.value : undefined });
    }

    const PERSISTENT_FAILURE_THRESHOLD = 3;
    function renderRemoteSyncHealth(health) {
        if (!health) return;
        const pollEl = document.getElementById('linear-health-poll');
        const pushEl = document.getElementById('linear-health-push');
        const thrEl = document.getElementById('linear-health-throttle');
        const failEl = document.getElementById('linear-health-failure');

        if (pollEl) {
            const ts = health.lastPollAt ? new Date(health.lastPollAt).toLocaleTimeString() : 'never';
            const icon = health.lastPollOk ? '✓' : '✗';
            const err = health.lastPollError ? ` — ${health.lastPollError.slice(0, 120)}` : '';
            pollEl.textContent = `Last poll: ${icon} ${ts}${err}`;
            pollEl.style.color = health.lastPollOk ? 'var(--text-secondary)' : '#e74c3c';
        }
        if (pushEl) {
            const ts = health.lastPushAt ? new Date(health.lastPushAt).toLocaleTimeString() : 'never';
            const icon = health.lastPushOk ? '✓' : '✗';
            const err = health.lastPushError ? ` — ${health.lastPushError.slice(0, 120)}` : '';
            pushEl.textContent = `Last push: ${icon} ${ts}${err}`;
            pushEl.style.color = health.lastPushOk ? 'var(--text-secondary)' : '#e74c3c';
        }
        if (thrEl) {
            if (health.throttled) {
                const until = health.throttleUntil ? new Date(health.throttleUntil).toLocaleTimeString() : '';
                thrEl.textContent = `⏳ Rate-limited — backing off until ${until}`;
                thrEl.style.display = 'block';
                thrEl.style.color = '#f39c12';
            } else {
                thrEl.style.display = 'none';
            }
        }
        if (failEl) {
            if (health.consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD) {
                failEl.textContent = `⚠ ${health.consecutiveFailures} consecutive failures — check token/connection`;
                failEl.style.display = 'block';
                failEl.style.color = '#e74c3c';
            } else {
                failEl.style.display = 'none';
            }
        }
    }

    // ── Render Remote Config & Board List ────────────────────────────────────
    function renderRemoteConfig(config, payload) {
        payload = payload || {};
        if (payload.capabilities) {
            _remoteCapabilities = payload.capabilities;
        }
        const wsSel = document.getElementById('linear-workspace');
        if (wsSel && Array.isArray(payload.workspaces)) {
            wsSel.innerHTML = '';
            payload.workspaces.forEach(w => {
                const opt = document.createElement('option');
                opt.value = w.workspaceRoot;
                opt.textContent = w.label;
                if (w.active) opt.selected = true;
                wsSel.appendChild(opt);
            });
        }

        const list = document.getElementById('linear-boards-list');
        const boardKeys = Array.isArray(payload.boardKeys)
            ? payload.boardKeys
            : ['', ...((payload.projects) || [])];
        if (list) {
            const chosen = new Set((config && config.boards) || []);
            list.innerHTML = '';
            boardKeys.forEach(key => {
                const row = document.createElement('label');
                row.className = 'remote-checkbox-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = key;
                cb.checked = chosen.has(key);
                cb.dataset.role = 'remote-board';
                const span = document.createElement('span');
                span.textContent = key === '' ? 'No Project (base workspace board)' : key;
                row.appendChild(cb);
                row.appendChild(span);
                list.appendChild(row);
            });
        }

        if (config) {
            _lastRemoteConfig = Object.assign({}, config);
            const silent = document.getElementById('linear-silent-sync');
            if (silent) silent.checked = config.silentSync === true;
            const freq = document.getElementById('linear-ping-frequency');
            if (freq) freq.value = config.pingFrequencySeconds || 60;
            const modeIngest = document.getElementById('linear-mode-ingest');
            const modeQueue = document.getElementById('linear-mode-queue');
            const modeFull = document.getElementById('linear-mode-full');
            if (modeIngest && modeFull) {
                modeIngest.checked = config.mode === 'ingest' || (config.mode !== 'queue' && config.mode !== 'full');
                if (modeQueue) modeQueue.checked = config.mode === 'queue';
                modeFull.checked = config.mode === 'full';
            }
            const comments = document.getElementById('linear-comments');
            if (comments) comments.checked = config.comments !== false;
            const content = document.getElementById('linear-content');
            if (content) content.checked = config.content !== false;
            const push = document.getElementById('linear-push');
            if (push) push.checked = config.push === true;
            const queueSeq = document.getElementById('linear-queue-sequencing');
            if (queueSeq) queueSeq.checked = config.queueSequencing === true;
        }

        remoteControlActive = payload.active === true;
        applyRemoteControlButtonState();
        requestLinearAgentSkill();
    }

    function remoteCollectConfig() {
        const boards = Array.from(
            document.querySelectorAll('#linear-boards-list input[data-role="remote-board"]:checked')
        ).map(cb => cb.value);
        const modeFull = document.getElementById('linear-mode-full');
        const modeQueue = document.getElementById('linear-mode-queue');
        const mode = modeQueue && modeQueue.checked ? 'queue'
            : modeFull && modeFull.checked ? 'full'
            : 'ingest';

        return Object.assign({}, _lastRemoteConfig || {}, {
            provider: 'linear',
            boards,
            silentSync: document.getElementById('linear-silent-sync')?.checked === true,
            pingFrequencySeconds: Math.min(120, Math.max(30,
                parseInt(document.getElementById('linear-ping-frequency')?.value, 10) || 60)),
            mode,
            push: document.getElementById('linear-push')?.checked === true,
            comments: document.getElementById('linear-comments')?.checked !== false,
            content: document.getElementById('linear-content')?.checked !== false,
            queueSequencing: document.getElementById('linear-queue-sequencing')?.checked === true,
        });
    }

    function remoteAutosave() {
        if (!_lastRemoteConfig) { return; }
        const wsSel = document.getElementById('linear-workspace');
        const workspaceRoot = wsSel ? wsSel.value : undefined;
        const config = remoteCollectConfig();
        const statusEl = document.getElementById('linear-config-status');
        if (statusEl) statusEl.textContent = 'Saved.';
        vscode.postMessage({ type: 'setRemoteConfig', config, workspaceRoot });
    }

    // ── Integration Auth & Status ────────────────────────────────────────────
    function renderIntegrationState(msg) {
        const badge = document.getElementById('linear-auth-badge');
        const desc = document.getElementById('linear-auth-description');
        const tokenInputRow = document.getElementById('linear-token-input-row');

        const hasToken = msg.linearHasToken === true;
        const setupComplete = msg.linearSetupComplete === true;
        _lastLinearConfig = msg.linearState;

        if (hasToken && setupComplete) {
            if (badge) {
                badge.textContent = 'Connected';
                badge.className = 'status-badge is-active';
            }
            if (desc) {
                desc.textContent = 'Linear integration is configured and authenticated. Project issue sync and comment routing are active.';
            }
            if (tokenInputRow) { tokenInputRow.style.display = 'none'; }
        } else if (hasToken) {
            if (badge) {
                badge.textContent = 'Token saved';
                badge.className = 'status-badge';
            }
            if (desc) {
                desc.textContent = 'API token is saved, but status mapping setup is incomplete. Select projects and map column statuses in the Tickets panel.';
            }
            if (tokenInputRow) { tokenInputRow.style.display = 'none'; }
        } else {
            if (badge) {
                badge.textContent = 'Not connected';
                badge.className = 'status-badge';
            }
            if (desc) {
                desc.textContent = 'No Linear API token found. Enter an API token or configure in Tickets to connect.';
            }
            if (tokenInputRow) { tokenInputRow.style.display = 'block'; }
        }

        renderMappingTable(msg.linearState);
        requestLinearAgentSkill();
    }

    function renderMappingTable(linearState) {
        const tbody = document.getElementById('linear-mapping-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const colMap = linearState && linearState.columnToStateId;
        if (!colMap || Object.keys(colMap).length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 2;
            td.style.color = 'var(--text-secondary)';
            td.textContent = 'No column status mappings configured. Set up mappings in Tickets → Linear.';
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }

        for (const [col, stateName] of Object.entries(colMap)) {
            const tr = document.createElement('tr');
            const tdCol = document.createElement('td');
            tdCol.textContent = col; // textContent for safety
            const tdState = document.createElement('td');
            tdState.textContent = String(stateName || '(unmapped)'); // textContent for safety
            tr.appendChild(tdCol);
            tr.appendChild(tdState);
            tbody.appendChild(tr);
        }
    }

    // ── Tailored Agent Skill Instructions ────────────────────────────────────
    function requestLinearAgentSkill() {
        const wsSel = document.getElementById('linear-workspace');
        vscode.postMessage({
            type: 'copyLinearAgentSkill',
            workspaceRoot: (wsSel && wsSel.value) || undefined
        });
    }

    function renderLinearAgentSkill(msg) {
        const pre = document.getElementById('linear-agent-skill-preview');
        const status = document.getElementById('copy-linear-agent-skill-status');
        if (msg.text) {
            _lastSkillText = msg.text;
            if (pre) {
                pre.textContent = msg.text; // textContent for safety
            }
        } else if (msg.error) {
            if (pre) {
                pre.textContent = msg.error;
            }
            if (status) {
                status.textContent = msg.error;
            }
        }
    }

    // ── Event Listeners ──────────────────────────────────────────────────────
    document.getElementById('tab-connect')?.addEventListener('change', (e) => {
        if (e.target.id === 'linear-workspace') {
            const root = e.target.value;
            vscode.postMessage({ type: 'getRemoteConfig', workspaceRoot: root });
            vscode.postMessage({ type: 'getIntegrationSetupStates', workspaceRoot: root });
            return;
        }
        remoteAutosave();
    });

    let _linearFreqTimer;
    document.getElementById('linear-ping-frequency')?.addEventListener('input', () => {
        clearTimeout(_linearFreqTimer);
        _linearFreqTimer = setTimeout(remoteAutosave, 400);
    });

    document.getElementById('btn-linear-remote-control-toggle')?.addEventListener('click', () => {
        const wsSel = document.getElementById('linear-workspace');
        vscode.postMessage({
            type: remoteControlActive ? 'stopRemoteControl' : 'startRemoteControl',
            workspaceRoot: (wsSel && wsSel.value) || undefined
        });
    });

    document.getElementById('btn-copy-linear-agent-skill')?.addEventListener('click', () => {
        const btn = document.getElementById('btn-copy-linear-agent-skill');
        const status = document.getElementById('copy-linear-agent-skill-status');
        if (_lastSkillText) {
            const copyFn = window.sbCopyToClipboard || ((txt) => navigator.clipboard.writeText(txt));
            copyFn(_lastSkillText).then(() => {
                if (btn) { btn.textContent = 'Copied!'; }
                if (status) { status.textContent = 'Skill copied to clipboard.'; }
                setTimeout(() => {
                    if (btn) { btn.textContent = 'Copy Linear Agent Skill'; }
                    if (status) { status.textContent = ''; }
                }, 2500);
            }).catch(err => {
                console.error('Failed to copy Linear agent skill:', err);
                if (status) { status.textContent = 'Copy failed — check browser clipboard permissions.'; }
            });
        } else {
            requestLinearAgentSkill();
        }
    });

    document.getElementById('btn-switch-to-tickets')?.addEventListener('click', () => {
        try {
            window.parent.postMessage({ type: 'switchPanel', panel: 'tickets' }, location.origin);
        } catch { /* ignore */ }
        try {
            vscode.postMessage({ type: 'openTicketsPanel' });
        } catch { /* ignore */ }
    });

    document.getElementById('btn-linear-apply-token')?.addEventListener('click', () => {
        const tokenInput = document.getElementById('linear-api-token');
        const token = tokenInput ? tokenInput.value.trim() : '';
        const status = document.getElementById('linear-auth-status');
        if (!token) {
            if (status) status.textContent = 'Please enter a token.';
            return;
        }
        if (status) status.textContent = 'Saving token…';
        const wsSel = document.getElementById('linear-workspace');
        vscode.postMessage({
            type: 'applyLinearConfig',
            token,
            workspaceRoot: (wsSel && wsSel.value) || undefined
        });
    });

    // ── Inbound Message Dispatch ─────────────────────────────────────────────
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
            case 'remoteConfig':
                renderRemoteConfig(msg.config, msg.payload);
                break;
            case 'remoteControlState':
                remoteControlActive = msg.active === true;
                applyRemoteControlButtonState();
                break;
            case 'remoteSyncHealth':
                renderRemoteSyncHealth(msg.health);
                break;
            case 'integrationSetupStates':
                renderIntegrationState(msg);
                break;
            case 'linearAgentSkillText':
                renderLinearAgentSkill(msg);
                break;
            case 'linearConfigResult':
                if (msg.success) {
                    const status = document.getElementById('linear-auth-status');
                    if (status) status.textContent = 'Token saved successfully.';
                    vscode.postMessage({ type: 'getIntegrationSetupStates' });
                } else {
                    const status = document.getElementById('linear-auth-status');
                    if (status) status.textContent = `Save failed: ${msg.error || 'unknown error'}`;
                }
                break;
        }
    });

    // ── Initial Bootstrap ────────────────────────────────────────────────────
    vscode.postMessage({ type: 'getRemoteConfig' });
    vscode.postMessage({ type: 'getIntegrationSetupStates' });
    requestLinearAgentSkill();
})();
