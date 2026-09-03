// database.js — Controller for the Database storage panel
(function () {
    'use strict';

    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : {
        postMessage: (msg) => {
            if (window.sbTransport) {
                window.sbTransport.postMessage(msg);
            }
        }
    };

    let _lastStatus = null;

    // ─── Tab Switching ────────────────────────────────────────────────────────
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
        });
    });

    // ─── Formatting Helpers ───────────────────────────────────────────────────
    function formatBytes(bytes) {
        if (typeof bytes !== 'number' || isNaN(bytes) || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatDate(ts) {
        if (!ts) return '—';
        try {
            const d = new Date(ts);
            return d.toLocaleString();
        } catch {
            return String(ts);
        }
    }

    // ─── Render Status ────────────────────────────────────────────────────────
    function renderStatus(status) {
        _lastStatus = status;
        if (!status) return;

        const store = status.store || {};
        const local = status.local || {};
        const projections = status.projections || {};

        // 1. Authoritative Store Section
        const storeReachableBadge = document.getElementById('store-reachable-badge');
        const storeErrorBanner = document.getElementById('store-error-banner');
        if (store.reachable) {
            storeReachableBadge.textContent = 'REACHABLE';
            storeReachableBadge.className = 'badge reachable';
            storeErrorBanner.classList.add('hidden');
        } else {
            storeReachableBadge.textContent = 'UNREACHABLE';
            storeReachableBadge.className = 'badge unreachable';
            storeErrorBanner.textContent = store.error ? `Store Unreachable: ${store.error}` : 'Store target is currently unreachable.';
            storeErrorBanner.classList.remove('hidden');
        }

        document.getElementById('store-kind').textContent = store.kind ? store.kind.toUpperCase() : 'UNKNOWN';
        document.getElementById('store-target').textContent = store.target || '—';
        document.getElementById('store-fingerprint').textContent = store.fingerprint || '—';
        document.getElementById('store-sync-lag').textContent = store.syncLagMs != null ? `${store.syncLagMs} ms (in sync)` : 'Unknown';
        document.getElementById('store-arbitration').textContent = store.arbitration || '—';

        // 2. This Machine (Local Tier) Section
        const localIntegrityBadge = document.getElementById('local-integrity-badge');
        const localIntegrityVal = document.getElementById('local-integrity-value');
        const integrity = local.integrity || 'unknown';
        localIntegrityVal.textContent = integrity;
        if (integrity === 'ok') {
            localIntegrityBadge.textContent = 'INTEGRITY OK';
            localIntegrityBadge.className = 'badge reachable';
        } else if (integrity === 'unknown') {
            localIntegrityBadge.textContent = 'NOT CHECKED';
            localIntegrityBadge.className = 'badge neutral';
        } else {
            localIntegrityBadge.textContent = 'INTEGRITY ISSUE';
            localIntegrityBadge.className = 'badge unreachable';
        }

        document.getElementById('local-file-path').textContent = local.filePath || '—';
        document.getElementById('local-file-size').textContent = local.exists ? formatBytes(local.sizeBytes) : 'File missing';
        document.getElementById('local-mtime').textContent = local.mtime ? formatDate(local.mtime) : '—';
        document.getElementById('local-state-backup-status').textContent = local.stateBackupExists
            ? `Present (${formatDate(local.stateBackupMtime)})`
            : 'None';

        // Backups list
        const backupsContainer = document.getElementById('backups-container');
        const backups = Array.isArray(local.backups) ? local.backups : [];
        const backupCountBadge = document.getElementById('backup-count-badge');
        backupCountBadge.textContent = `${backups.length} snapshot${backups.length === 1 ? '' : 's'}`;

        if (backups.length === 0) {
            backupsContainer.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-secondary); font-size: 11px;">No backups found in .switchboard/dbbackup/</div>';
        } else {
            backupsContainer.innerHTML = backups.map(b => `
                <div class="backup-item">
                    <div>
                        <div style="font-weight: 500; color: var(--text-primary);">${escapeHtml(b.filename)}</div>
                        <div class="backup-meta">Reason: ${escapeHtml(b.reason)} • ${formatBytes(b.sizeBytes)}</div>
                    </div>
                    <div class="backup-meta">${formatDate(b.timestamp)}</div>
                </div>
            `).join('');
        }

        // 3. Projections Section
        const notion = projections.notion || {};
        const linear = projections.linear || {};
        const clickup = projections.clickup || {};

        const notionBadge = document.getElementById('notion-status-badge');
        if (notion.configured) {
            notionBadge.textContent = 'CONFIGURED';
            notionBadge.className = 'badge info';
        } else {
            notionBadge.textContent = 'NOT CONFIGURED';
            notionBadge.className = 'badge neutral';
        }
        document.getElementById('notion-configured-val').textContent = notion.configured ? 'Configured & Active' : 'Not configured';
        document.getElementById('notion-last-push-val').textContent = notion.lastPush ? formatDate(notion.lastPush) : 'Never';
        document.getElementById('notion-last-pull-val').textContent = notion.lastPull ? formatDate(notion.lastPull) : 'Never';

        const linearBadge = document.getElementById('linear-status-badge');
        linearBadge.textContent = linear.configured ? 'CONFIGURED' : 'NOT CONFIGURED';
        linearBadge.className = linear.configured ? 'badge info' : 'badge neutral';
        document.getElementById('linear-configured-val').textContent = linear.configured ? 'Configured' : 'Not configured';
        document.getElementById('linear-last-push-val').textContent = linear.lastPush ? formatDate(linear.lastPush) : 'Never';
        document.getElementById('linear-last-pull-val').textContent = linear.lastPull ? formatDate(linear.lastPull) : 'Never';

        const clickupBadge = document.getElementById('clickup-status-badge');
        clickupBadge.textContent = clickup.configured ? 'CONFIGURED' : 'NOT CONFIGURED';
        clickupBadge.className = clickup.configured ? 'badge info' : 'badge neutral';
        document.getElementById('clickup-configured-val').textContent = clickup.configured ? 'Configured' : 'Not configured';
        document.getElementById('clickup-last-push-val').textContent = clickup.lastPush ? formatDate(clickup.lastPush) : 'Never';
        document.getElementById('clickup-last-pull-val').textContent = clickup.lastPull ? formatDate(clickup.lastPull) : 'Never';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ─── Fetch Status ─────────────────────────────────────────────────────────
    async function loadStatus() {
        try {
            const res = await fetch('/database/status', { credentials: 'same-origin' });
            if (!res.ok) {
                renderStatus({
                    store: { reachable: false, error: `HTTP status ${res.status}` },
                    local: { exists: false, integrity: 'unavailable' },
                    projections: {}
                });
                return;
            }
            const data = await res.json();
            renderStatus(data);
        } catch (err) {
            renderStatus({
                store: { reachable: false, error: err && err.message ? err.message : 'Network error' },
                local: { exists: false, integrity: 'unavailable' },
                projections: {}
            });
        }
    }

    // ─── Switch Target Multi-Step Flow ───────────────────────────────────────
    const switchFlowPanel = document.getElementById('switch-flow-panel');
    const btnToggleSwitch = document.getElementById('btn-toggle-switch-flow');
    const selectKind = document.getElementById('switch-target-kind-select');
    const summaryLabel = document.getElementById('switch-target-summary-label');
    const paramCustom = document.getElementById('param-group-local-custom');
    const paramLibsql = document.getElementById('param-group-libsql');
    const paramGit = document.getElementById('param-group-git');

    btnToggleSwitch.addEventListener('click', () => {
        switchFlowPanel.classList.toggle('hidden');
    });

    document.getElementById('btn-cancel-switch').addEventListener('click', () => {
        switchFlowPanel.classList.add('hidden');
    });

    function updateSwitchParamsVisibility() {
        const val = selectKind.value;
        paramCustom.classList.add('hidden');
        paramLibsql.classList.add('hidden');
        paramGit.classList.add('hidden');

        if (val === 'local-default') {
            summaryLabel.textContent = 'Local Default (.switchboard/kanban.db)';
        } else if (val === 'local-custom') {
            paramCustom.classList.remove('hidden');
            const p = document.getElementById('switch-custom-path-input').value.trim();
            summaryLabel.textContent = p ? `Custom Path: ${p}` : 'Custom Local SQLite File';
        } else if (val === 'libsql') {
            paramLibsql.classList.remove('hidden');
            const u = document.getElementById('switch-libsql-url-input').value.trim();
            summaryLabel.textContent = u ? `libSQL: ${u}` : 'libSQL / Turso Cloud (Staged Target)';
        } else if (val === 'git') {
            paramGit.classList.remove('hidden');
            const b = document.getElementById('switch-git-branch-input').value.trim();
            summaryLabel.textContent = b ? `Git Branch: ${b}` : 'Git-carried Branch (Staged Target)';
        }
    }

    selectKind.addEventListener('change', updateSwitchParamsVisibility);
    document.getElementById('switch-custom-path-input').addEventListener('input', updateSwitchParamsVisibility);
    document.getElementById('switch-libsql-url-input').addEventListener('input', updateSwitchParamsVisibility);
    document.getElementById('switch-git-branch-input').addEventListener('input', updateSwitchParamsVisibility);

    document.getElementById('btn-execute-switch').addEventListener('click', () => {
        const val = selectKind.value;
        if (val === 'local-default') {
            vscode.postMessage({ type: 'setLocalDb' });
        } else if (val === 'local-custom') {
            const customPath = document.getElementById('switch-custom-path-input').value.trim();
            if (customPath) {
                vscode.postMessage({ type: 'setCustomDbPath', path: customPath });
            }
        } else {
            // Future store target activation
            console.log('[database] Staged target switch selected:', val);
        }
        switchFlowPanel.classList.add('hidden');
        setTimeout(loadStatus, 500);
    });

    // ─── Direct Actions ───────────────────────────────────────────────────────
    document.getElementById('btn-refresh').addEventListener('click', loadStatus);

    document.getElementById('btn-test-connection').addEventListener('click', () => {
        vscode.postMessage({ type: 'testDbConnection' });
    });

    document.getElementById('btn-edit-db-path').addEventListener('click', () => {
        vscode.postMessage({ type: 'editDbPath' });
    });

    document.getElementById('btn-use-local-db').addEventListener('click', () => {
        vscode.postMessage({ type: 'setLocalDb' });
        setTimeout(loadStatus, 500);
    });

    document.getElementById('btn-check-integrity').addEventListener('click', async () => {
        await loadStatus();
    });

    // Rebuild Reinitialization Flow (Explicit multi-step flow)
    const rebuildConfirmBox = document.getElementById('rebuild-confirm-box');
    document.getElementById('btn-start-rebuild-flow').addEventListener('click', () => {
        rebuildConfirmBox.classList.remove('hidden');
    });
    document.getElementById('btn-cancel-rebuild').addEventListener('click', () => {
        rebuildConfirmBox.classList.add('hidden');
    });
    document.getElementById('btn-confirm-rebuild').addEventListener('click', () => {
        vscode.postMessage({ type: 'resetDatabase' });
        rebuildConfirmBox.classList.add('hidden');
        setTimeout(loadStatus, 1000);
    });

    // Notion Projection Actions
    document.getElementById('btn-notion-backup').addEventListener('click', () => {
        const url = document.getElementById('notion-db-url-input').value.trim();
        if (url) {
            vscode.postMessage({ type: 'configureNotionBackup', databaseUrl: url });
        }
        vscode.postMessage({ type: 'backupToNotion' });
    });

    document.getElementById('btn-notion-auto-setup').addEventListener('click', () => {
        vscode.postMessage({ type: 'autoCreateNotionDatabase' });
    });

    // Notion Break-Glass Restore Flow (Explicit multi-step flow)
    const notionRestoreConfirmBox = document.getElementById('notion-restore-confirm-box');
    document.getElementById('btn-notion-restore-breakglass').addEventListener('click', () => {
        notionRestoreConfirmBox.classList.remove('hidden');
    });
    document.getElementById('btn-cancel-notion-restore').addEventListener('click', () => {
        notionRestoreConfirmBox.classList.add('hidden');
    });
    document.getElementById('btn-confirm-notion-restore').addEventListener('click', () => {
        vscode.postMessage({ type: 'restoreFromNotion' });
        notionRestoreConfirmBox.classList.add('hidden');
        setTimeout(loadStatus, 1000);
    });

    // ─── Message Handling from Backend ────────────────────────────────────────
    window.addEventListener('message', event => {
        const message = event.data;
        if (!message) return;
        switch (message.type) {
            case 'dbPathUpdated':
            case 'dbConnectionTested':
            case 'notionConfigUpdated':
                loadStatus();
                break;
            default:
                break;
        }
    });

    // Boot
    loadStatus();
})();
