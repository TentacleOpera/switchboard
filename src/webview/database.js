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
            backupsContainer.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-secondary); font-size: 11px;">No backups found</div>';
        } else {
            backupsContainer.innerHTML = backups.map(b => {
                const badge = b.failed
                    ? '<span class="badge danger" style="margin-left: 6px; font-size: 9px; padding: 1px 4px;">FAILED</span>'
                    : (b.verified
                        ? '<span class="badge info" style="margin-left: 6px; font-size: 9px; padding: 1px 4px; color: var(--accent-green);">VERIFIED</span>'
                        : '<span class="badge neutral" style="margin-left: 6px; font-size: 9px; padding: 1px 4px;">LEGACY</span>');
                const plansPart = b.planCount ? ` • ${b.planCount} plan${b.planCount === 1 ? '' : 's'}` : '';
                const restoreBtn = !b.failed
                    ? `<button class="btn btn-restore-backup" data-backup-id="${escapeHtml(b.filename)}" style="padding: 2px 6px; font-size: 10px; margin-left: 8px;">RESTORE</button>`
                    : '';
                return `
                    <div class="backup-item" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid var(--border-color);">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: 500; color: var(--text-primary); display: flex; align-items: center;">
                                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(b.filename)}</span>
                                ${badge}
                            </div>
                            <div class="backup-meta">Reason: ${escapeHtml(b.reason)} • ${formatBytes(b.sizeBytes)}${plansPart}</div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <div class="backup-meta">${formatDate(b.timestamp)}</div>
                            ${restoreBtn}
                        </div>
                    </div>
                `;
            }).join('');
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

    // ─── Backup & Restore Actions ──────────────────────────────────────────────
    const btnBackupNow = document.getElementById('btn-backup-now');
    if (btnBackupNow) {
        btnBackupNow.addEventListener('click', async () => {
            btnBackupNow.disabled = true;
            btnBackupNow.textContent = 'BACKING UP…';
            try {
                if (typeof vscode !== 'undefined' && vscode.postMessage) {
                    vscode.postMessage({ type: 'createBackup', reason: 'manual-ui' });
                } else {
                    await fetch('/database/backup', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason: 'manual-ui' }),
                    });
                }
            } finally {
                setTimeout(async () => {
                    btnBackupNow.disabled = false;
                    btnBackupNow.textContent = 'BACKUP NOW';
                    await loadStatus();
                }, 1000);
            }
        });
    }

    // Immediate-acting restore on backup item click (per project rule, no confirmation dialog)
    document.getElementById('backups-container').addEventListener('click', async (e) => {
        const target = e.target;
        if (!target || !target.classList.contains('btn-restore-backup')) return;
        const backupId = target.getAttribute('data-backup-id');
        if (!backupId) return;

        target.disabled = true;
        target.textContent = 'RESTORING…';
        try {
            if (typeof vscode !== 'undefined' && vscode.postMessage) {
                vscode.postMessage({ type: 'restoreBackup', backupId });
            } else {
                await fetch('/database/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ backupId }),
                });
            }
        } finally {
            setTimeout(loadStatus, 1000);
        }
    });

    // ─── Project Export & Import Actions ────────────────────────────────────────
    const exportPanel = document.getElementById('export-flow-panel');
    const importPanel = document.getElementById('import-flow-panel');
    const exportStatusDiv = document.getElementById('project-export-import-status');

    document.getElementById('btn-export-project').addEventListener('click', () => {
        exportPanel.classList.toggle('hidden');
        importPanel.classList.add('hidden');
    });

    document.getElementById('btn-cancel-export').addEventListener('click', () => {
        exportPanel.classList.add('hidden');
    });

    document.getElementById('btn-confirm-export').addEventListener('click', async () => {
        const destPath = document.getElementById('export-dest-input').value.trim();
        if (!destPath) return;

        exportStatusDiv.style.display = 'block';
        exportStatusDiv.textContent = 'Exporting workspace…';
        try {
            const res = await fetch('/database/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ destPath, workspaceId: window.__switchboardWorkspaceId || 'default' }),
            });
            const data = await res.json();
            if (data.success) {
                exportStatusDiv.textContent = `Export complete: ${destPath}`;
                exportPanel.classList.add('hidden');
            } else {
                exportStatusDiv.textContent = `Export error: ${data.error || 'Failed'}`;
            }
        } catch (err) {
            exportStatusDiv.textContent = `Export failed: ${err.message || err}`;
        }
    });

    document.getElementById('btn-import-project').addEventListener('click', () => {
        importPanel.classList.toggle('hidden');
        exportPanel.classList.add('hidden');
    });

    document.getElementById('btn-cancel-import').addEventListener('click', () => {
        importPanel.classList.add('hidden');
    });

    document.getElementById('btn-confirm-import').addEventListener('click', async () => {
        const srcPath = document.getElementById('import-src-input').value.trim();
        if (!srcPath) return;

        exportStatusDiv.style.display = 'block';
        exportStatusDiv.textContent = 'Importing workspace…';
        try {
            const res = await fetch('/database/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ srcPath }),
            });
            const data = await res.json();
            if (data.success) {
                exportStatusDiv.textContent = `Import complete: imported ${data.result?.importedWorkspaceId || 'workspace'}`;
                importPanel.classList.add('hidden');
                setTimeout(loadStatus, 1000);
            } else {
                exportStatusDiv.textContent = `Import error: ${data.error || 'Failed'}`;
            }
        } catch (err) {
            exportStatusDiv.textContent = `Import failed: ${err.message || err}`;
        }
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

    // ─── Storage Stats & Retention ───────────────────────────────────────────
    async function loadStorageStats() {
        try {
            let stats = null;
            try {
                const res = await fetch('/database/storage-stats');
                const data = await res.json();
                if (data.success) stats = data.stats;
            } catch {
                if (typeof vscode !== 'undefined' && vscode.postMessage) {
                    vscode.postMessage({ type: 'getDatabaseStorageStats' });
                }
            }

            if (stats) {
                renderStorageStats(stats);
            }
        } catch (err) {
            console.warn('[Database] Failed to load storage stats:', err);
        }
    }

    function renderStorageStats(stats) {
        if (!stats) return;
        const totalSizeEl = document.getElementById('storage-total-size');
        const growthDeltaEl = document.getElementById('storage-growth-delta');
        const lastAuditedEl = document.getElementById('storage-last-audited');
        const badgeEl = document.getElementById('retention-status-badge');

        if (totalSizeEl) totalSizeEl.textContent = formatBytes(stats.totalBytes);
        if (growthDeltaEl) {
            const delta = stats.growthBytes || 0;
            const prefix = delta > 0 ? '+' : '';
            growthDeltaEl.textContent = `${prefix}${formatBytes(delta)}`;
            growthDeltaEl.style.color = delta > 0 ? 'var(--accent-orange, #ed8936)' : 'var(--text-primary)';
        }
        if (lastAuditedEl) lastAuditedEl.textContent = formatDate(stats.checkedAt);

        const policy = stats.retentionPolicy || {};
        if (badgeEl) {
            if (policy.enabled) {
                badgeEl.textContent = 'Retention: Active';
                badgeEl.className = 'badge info';
            } else {
                badgeEl.textContent = 'Retention: Disabled';
                badgeEl.className = 'badge neutral';
            }
        }
        const enabledCheckbox = document.getElementById('retention-enabled-input');
        if (enabledCheckbox) enabledCheckbox.checked = policy.enabled === true;
        const daysInput = document.getElementById('retention-days-input');
        if (daysInput && policy.eventRetentionDays) daysInput.value = policy.eventRetentionDays;
        const monthsInput = document.getElementById('retention-months-input');
        if (monthsInput && policy.dormantWorkspaceMonths) monthsInput.value = policy.dormantWorkspaceMonths;

        const tablesTbody = document.getElementById('storage-tables-tbody');
        if (tablesTbody && Array.isArray(stats.tables)) {
            tablesTbody.innerHTML = stats.tables.map(t => {
                const deltaPrefix = t.rowDelta > 0 ? '+' : '';
                const deltaColor = t.rowDelta > 0 ? 'var(--accent-orange, #ed8936)' : 'var(--text-secondary)';
                return `
                    <tr style="border-bottom: 1px solid var(--border-color);">
                        <td style="padding: 4px 8px; font-weight: 500;">${escapeHtml(t.tableName)}</td>
                        <td style="padding: 4px 8px; text-align: right;">${t.rowCount.toLocaleString()}</td>
                        <td style="padding: 4px 8px; text-align: right;">${formatBytes(t.estimatedBytes)}</td>
                        <td style="padding: 4px 8px; text-align: right; color: ${deltaColor};">${deltaPrefix}${t.rowDelta}</td>
                    </tr>
                `;
            }).join('');
        }

        const wsTbody = document.getElementById('storage-workspaces-tbody');
        if (wsTbody && Array.isArray(stats.workspaces)) {
            wsTbody.innerHTML = stats.workspaces.map(w => {
                const statusBadge = w.isDormant
                    ? `<span class="badge danger" style="padding: 1px 4px; font-size: 9px;">DORMANT</span> <button class="btn btn-reactivate-ws" data-ws="${escapeHtml(w.workspaceId)}" style="padding: 1px 4px; font-size: 9px; margin-left: 4px;">REACTIVATE</button>`
                    : '<span class="badge reachable" style="padding: 1px 4px; font-size: 9px;">ACTIVE</span>';
                const idDisplay = w.workspaceId.length > 20 ? `${w.workspaceId.slice(0, 18)}…` : w.workspaceId;
                return `
                    <tr style="border-bottom: 1px solid var(--border-color);">
                        <td style="padding: 4px 8px; font-weight: 500;" title="${escapeHtml(w.workspaceId)}">${escapeHtml(idDisplay)}</td>
                        <td style="padding: 4px 8px; text-align: right;">${w.plansCount.toLocaleString()}</td>
                        <td style="padding: 4px 8px; text-align: right;">${w.eventsCount.toLocaleString()}</td>
                        <td style="padding: 4px 8px; text-align: right;">${w.activityCount.toLocaleString()}</td>
                        <td style="padding: 4px 8px; text-align: right;">${statusBadge}</td>
                    </tr>
                `;
            }).join('');
        }
    }

    const btnRefreshStorageStats = document.getElementById('btn-refresh-storage-stats');
    if (btnRefreshStorageStats) {
        btnRefreshStorageStats.addEventListener('click', () => loadStorageStats());
    }

    const retentionStatusEl = document.getElementById('retention-action-status');
    const btnSaveRetention = document.getElementById('btn-save-retention-config');
    if (btnSaveRetention) {
        btnSaveRetention.addEventListener('click', async () => {
            const enabled = document.getElementById('retention-enabled-input').checked;
            const eventRetentionDays = parseInt(document.getElementById('retention-days-input').value, 10) || 180;
            const dormantWorkspaceMonths = parseInt(document.getElementById('retention-months-input').value, 10) || 12;

            retentionStatusEl.style.display = 'block';
            retentionStatusEl.textContent = 'Saving policy…';
            try {
                const res = await fetch('/database/retention/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled, eventRetentionDays, dormantWorkspaceMonths }),
                });
                const data = await res.json();
                if (data.success) {
                    retentionStatusEl.textContent = 'Policy saved successfully.';
                    setTimeout(loadStorageStats, 500);
                } else {
                    retentionStatusEl.textContent = `Error: ${data.error || 'Failed to save policy'}`;
                }
            } catch (err) {
                retentionStatusEl.textContent = `Error: ${err.message || err}`;
            }
        });
    }

    const btnRunRotation = document.getElementById('btn-run-rotation-now');
    if (btnRunRotation) {
        btnRunRotation.addEventListener('click', async () => {
            btnRunRotation.disabled = true;
            btnRunRotation.textContent = 'ROTATING…';
            retentionStatusEl.style.display = 'block';
            retentionStatusEl.textContent = 'Running retention rotation…';
            try {
                const res = await fetch('/database/retention/rotate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: true }),
                });
                const data = await res.json();
                if (data.success && data.report?.ran) {
                    retentionStatusEl.textContent = `Rotation complete: rotated ${data.report.rotated.planEvents} events, ${data.report.rotated.activityLog} logs.`;
                    setTimeout(() => {
                        loadStatus();
                        loadStorageStats();
                    }, 1000);
                } else {
                    retentionStatusEl.textContent = `Rotation skipped/failed: ${data.report?.reason || data.error || 'Check log'}`;
                }
            } catch (err) {
                retentionStatusEl.textContent = `Error: ${err.message || err}`;
            } finally {
                btnRunRotation.disabled = false;
                btnRunRotation.textContent = 'RUN ROTATION NOW';
            }
        });
    }

    // Reactivate workspace delegation
    const workspacesTable = document.getElementById('storage-workspaces-tbody');
    if (workspacesTable) {
        workspacesTable.addEventListener('click', async (e) => {
            const target = e.target;
            if (!target || !target.classList.contains('btn-reactivate-ws')) return;
            const wsId = target.getAttribute('data-ws');
            if (!wsId) return;

            target.disabled = true;
            target.textContent = 'REACTIVATING…';
            try {
                const res = await fetch('/database/retention/reactivate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId: wsId }),
                });
                const data = await res.json();
                if (data.success) {
                    setTimeout(loadStorageStats, 1000);
                } else {
                    alert(`Reactivation failed: ${data.error || 'Unknown error'}`);
                    target.disabled = false;
                    target.textContent = 'REACTIVATE';
                }
            } catch (err) {
                alert(`Reactivation failed: ${err.message || err}`);
                target.disabled = false;
                target.textContent = 'REACTIVATE';
            }
        });
    }

    // ─── Message Handling from Backend ────────────────────────────────────────
    window.addEventListener('message', event => {
        const message = event.data;
        if (!message) return;
        switch (message.type) {
            case 'dbPathUpdated':
            case 'dbConnectionTested':
            case 'notionConfigUpdated':
                loadStatus();
                loadStorageStats();
                break;
            case 'databaseStorageStats':
                if (message.stats) renderStorageStats(message.stats);
                break;
            default:
                break;
        }
    });

    // Boot
    loadStatus();
    loadStorageStats();
})();
