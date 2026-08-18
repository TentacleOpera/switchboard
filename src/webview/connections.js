// connections.js — Webview controller for the Connections panel
(function () {
    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : {
        postMessage: (msg) => {
            if (window.sbTransport) {
                window.sbTransport.postMessage(msg);
            }
        }
    };

    // Sub-tab switching
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
            if (targetTab === 'web-agents') {
                vscode.postMessage({ type: 'createPlansInit' });
            }
        });
    });

    // =========================================================================
    // SUB-TAB 1: PROVIDERS (REMOTE CONTROL CONFIG)
    //
    // Ported wholesale from setup.html's Remote tab — the implementation that has
    // been live on shipped installs — rather than re-derived. The earlier
    // hand-written version of this section invented four RemoteConfig field names
    // (frequencySeconds / autoPush / autoComment / includeContent) and two workspace
    // payload fields (w.path / w.name), so it rendered defaults over real settings
    // and wrote them back. Field names below are the canonical ones:
    //   RemoteConfig  — provider, boards, silentSync, pingFrequencySeconds, mode,
    //                   push, comments, content   (RemoteControlService.ts:42-59)
    //   payload       — config, boardKeys, projects, workspaces[{workspaceRoot,
    //                   label, active}], capabilities, active
    //                   (KanbanProvider._buildRemoteConfigPayload)
    // Change either side and this breaks silently: the boundary is an untyped
    // postMessage, so nothing in tsc, lint or the ratchets can see a mismatch.
    // =========================================================================
    let remoteControlActive = false;
    let _remoteHealthTimer = null;
    let _remoteCapabilities = { pull: true, push: true };
    // Last config the host sent. `setRemoteConfig` REPLACES the stored object
    // (RemoteControlService.setConfig re-derives every field, so a missing `boards`
    // becomes []), so saves merge over this. The full form is present now and
    // collects every field, but the merge stays as defence: a future partial render
    // must not be able to wipe what it cannot show.
    let _lastRemoteConfig = null;

    function applyRemoteControlButtonState() {
        const btn = document.getElementById('btn-remote-control-toggle');
        if (btn) btn.textContent = remoteControlActive ? 'Stop Remote Control' : 'Start Remote Control';
        const stateEl = document.getElementById('remote-control-state');
        if (stateEl) stateEl.textContent = remoteControlActive ? 'Pinging…' : '';
        const healthSection = document.getElementById('remote-health-section');
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
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({ type: 'getRemoteHealth', workspaceRoot: wsSel ? wsSel.value : undefined });
    }

    const PERSISTENT_FAILURE_THRESHOLD = 3;
    function renderRemoteSyncHealth(health) {
        if (!health) return;
        const pollEl = document.getElementById('remote-health-poll');
        const pushEl = document.getElementById('remote-health-push');
        const thrEl = document.getElementById('remote-health-throttle');
        const failEl = document.getElementById('remote-health-failure');

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

    function applyRemoteProviderUi() {
        const providerEl = document.getElementById('remote-provider');
        const provider = providerEl ? providerEl.value : 'linear';
        const notionSetup = document.getElementById('remote-notion-setup');
        if (notionSetup) notionSetup.style.display = provider === 'notion' ? 'block' : 'none';
        // No ClickUp provisioning block: there is no runClickUpRemoteSetup verb in
        // SETUP_VERBS, and setup.html never offered one. The earlier version of this
        // panel rendered a "Provision ClickUp Fields & Statuses" button that posted a
        // verb the server rejects — a dead click, which PRD contract #6 forbids.

        const title = document.getElementById('remote-subsection-title');
        if (title) {
            title.textContent = provider === 'notion' ? 'Remote Control (Notion)'
                : provider === 'clickup' ? 'Remote Control (ClickUp)'
                    : 'Remote Control (Linear)';
        }
        const skillBlock = document.getElementById('remote-linear-agent-skill');
        if (skillBlock) skillBlock.style.display = provider === 'linear' ? 'block' : 'none';

        // Capability gating: a provider that cannot push must not offer a push
        // toggle that silently does nothing (PRD contract #6).
        const caps = _remoteCapabilities || { pull: true, push: true };
        const pushLabel = document.getElementById('remote-push-label');
        const pushInput = document.getElementById('remote-push');
        const modeFull = document.getElementById('remote-mode-full');
        const modeFullLabel = modeFull ? modeFull.closest('label') : null;
        const modeQueue = document.getElementById('remote-mode-queue');
        const modeQueueLabel = modeQueue ? modeQueue.closest('label') : null;
        if (pushInput && pushLabel) {
            pushInput.disabled = !caps.push;
            pushLabel.style.opacity = caps.push ? '1' : '0.5';
            pushLabel.style.pointerEvents = caps.push ? 'auto' : 'none';
        }
        if (modeFull && modeFullLabel) {
            modeFull.disabled = !caps.pull;
            modeFullLabel.style.opacity = caps.pull ? '1' : '0.5';
            modeFullLabel.style.pointerEvents = caps.pull ? 'auto' : 'none';
        }
        // Queue mode also requires pull — staging needs to read the remote board.
        if (modeQueue && modeQueueLabel) {
            modeQueue.disabled = !caps.pull;
            modeQueueLabel.style.opacity = caps.pull ? '1' : '0.5';
            modeQueueLabel.style.pointerEvents = caps.pull ? 'auto' : 'none';
        }
    }

    function renderRemoteConfig(config, payload) {
        payload = payload || {};
        if (payload.capabilities) {
            _remoteCapabilities = payload.capabilities;
        }
        const wsSel = document.getElementById('remote-workspace');
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

        const list = document.getElementById('remote-boards-list');
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
            const providerEl = document.getElementById('remote-provider');
            if (providerEl) providerEl.value = (config.provider === 'notion' || config.provider === 'clickup') ? config.provider : 'linear';
            const silent = document.getElementById('remote-silent-sync');
            if (silent) silent.checked = config.silentSync === true;
            const freq = document.getElementById('remote-ping-frequency');
            if (freq) freq.value = config.pingFrequencySeconds || 60;
            const modeIngest = document.getElementById('remote-mode-ingest');
            const modeQueue = document.getElementById('remote-mode-queue');
            const modeFull = document.getElementById('remote-mode-full');
            if (modeIngest && modeFull) {
                modeIngest.checked = config.mode === 'ingest' || (config.mode !== 'queue' && config.mode !== 'full');
                if (modeQueue) modeQueue.checked = config.mode === 'queue';
                modeFull.checked = config.mode === 'full';
            }
            const comments = document.getElementById('remote-comments');
            if (comments) comments.checked = config.comments !== false;
            const content = document.getElementById('remote-content');
            if (content) content.checked = config.content !== false;
            const push = document.getElementById('remote-push');
            if (push) push.checked = config.push === true;
            const queueSeq = document.getElementById('remote-queue-sequencing');
            if (queueSeq) queueSeq.checked = config.queueSequencing === true;
        }

        remoteControlActive = payload.active === true;
        applyRemoteControlButtonState();
        applyRemoteProviderUi();
    }

    function remoteCollectConfig() {
        const boards = Array.from(
            document.querySelectorAll('#remote-boards-list input[data-role="remote-board"]:checked')
        ).map(cb => cb.value);
        const providerEl = document.getElementById('remote-provider');
        const providerVal = providerEl ? providerEl.value : 'linear';
        const modeFull = document.getElementById('remote-mode-full');
        const modeQueue = document.getElementById('remote-mode-queue');
        // Three-way mode: queue is checked → 'queue'; full is checked → 'full';
        // otherwise 'ingest' (the default and the safe fallback).
        const mode = modeQueue && modeQueue.checked ? 'queue'
            : modeFull && modeFull.checked ? 'full'
            : 'ingest';
        // Merge over the host-supplied config so any field this form does not render
        // survives the replace performed by setRemoteConfig.
        return Object.assign({}, _lastRemoteConfig || {}, {
            provider: (providerVal === 'notion' || providerVal === 'clickup') ? providerVal : 'linear',
            boards,
            silentSync: document.getElementById('remote-silent-sync')?.checked === true,
            pingFrequencySeconds: Math.min(120, Math.max(30,
                parseInt(document.getElementById('remote-ping-frequency')?.value, 10) || 60)),
            mode,
            push: document.getElementById('remote-push')?.checked === true,
            comments: document.getElementById('remote-comments')?.checked !== false,
            content: document.getElementById('remote-content')?.checked !== false,
            queueSequencing: document.getElementById('remote-queue-sequencing')?.checked === true,
        });
    }

    function remoteAutosave() {
        // Never save before the host has told us what is stored: a save built on an
        // empty base is the replace-with-defaults that wipes boards.
        if (!_lastRemoteConfig) { return; }
        const wsSel = document.getElementById('remote-workspace');
        const workspaceRoot = wsSel ? wsSel.value : undefined;
        const config = remoteCollectConfig();
        const statusEl = document.getElementById('remote-config-status');
        if (statusEl) statusEl.textContent = 'Saved.';
        vscode.postMessage({ type: 'setRemoteConfig', config, workspaceRoot });
    }

    function collectNotionRemoteSetupOptions() {
        return {
            realTimeSyncEnabled: document.getElementById('notion-option-realtime-sync')?.checked === true,
            deleteSyncEnabled: document.getElementById('notion-option-delete-sync')?.checked === true,
            inboundDeleteEnabled: document.getElementById('notion-option-inbound-delete')?.checked === true,
        };
    }

    // One delegated change listener over the whole tab, matching setup.html: the
    // boards list is rebuilt on every render, so per-checkbox listeners would be
    // lost each time.
    document.getElementById('providers-fields')?.addEventListener('change', (e) => {
        if (e.target.id === 'remote-workspace') {
            vscode.postMessage({ type: 'getRemoteConfig', workspaceRoot: e.target.value });
            return;
        }
        if (e.target.id === 'board-state-export-select') {
            const row = document.getElementById('board-state-export-remote-url-row');
            if (row) row.style.display = e.target.value === 'read-only-snapshot' ? 'block' : 'none';
            vscode.postMessage({ type: 'setBoardStateExport', value: e.target.value });
            return;
        }
        if (e.target.id === 'board-state-export-remote-url') {
            vscode.postMessage({ type: 'setBoardStateExportRemoteUrl', value: e.target.value || '' });
            return;
        }
        // Notion setup options are read on demand by collectNotionRemoteSetupOptions;
        // they are not part of RemoteConfig and must not trigger a config save.
        if (e.target.id && e.target.id.startsWith('notion-option-')) { return; }
        if (e.target.id === 'remote-provider') {
            applyRemoteProviderUi();
        }
        remoteAutosave();
    });

    let _remoteFreqTimer;
    document.getElementById('remote-ping-frequency')?.addEventListener('input', () => {
        clearTimeout(_remoteFreqTimer);
        _remoteFreqTimer = setTimeout(remoteAutosave, 400);
    });

    document.getElementById('btn-remote-control-toggle')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        // Do NOT flip remoteControlActive locally — the host echoes the real state
        // back via remoteControlState, and an optimistic flip desynchronises the
        // button from the service when start fails.
        vscode.postMessage({
            type: remoteControlActive ? 'stopRemoteControl' : 'startRemoteControl',
            workspaceRoot: (wsSel && wsSel.value) || undefined
        });
    });

    document.getElementById('btn-copy-linear-agent-skill')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({ type: 'copyLinearAgentSkill', workspaceRoot: (wsSel && wsSel.value) || undefined });
    });

    document.getElementById('btn-notion-remote-setup')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        const statusEl = document.getElementById('remote-notion-setup-status');
        if (statusEl) statusEl.textContent = 'Running setup sync…';
        vscode.postMessage({
            type: 'runNotionRemoteSetup',
            workspaceRoot: wsSel ? wsSel.value : undefined,
            options: collectNotionRemoteSetupOptions()
        });
    });

    // =========================================================================
    // SUB-TAB 2: HAND-OFFS (EXTERNAL AGENT LAUNCHERS)
    // =========================================================================
    document.getElementById('btn-copy-handoff-prompt')?.addEventListener('click', () => {
        const launcherSel = document.getElementById('handoff-launcher-select');
        const targetPathInput = document.getElementById('handoff-target-path');
        const statusEl = document.getElementById('handoff-prompt-result');

        const launcherId = launcherSel ? launcherSel.value : 'plan-write';
        const targetPath = targetPathInput ? targetPathInput.value.trim() : '';

        if (statusEl) statusEl.textContent = 'Generating & copying prompt…';
        vscode.postMessage({ type: 'getLauncherPrompt', launcherId, targetPath });
        setTimeout(() => {
            if (statusEl) statusEl.textContent = 'Copied launcher prompt to clipboard ✓';
            setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
        }, 500);
    });

    // =========================================================================
    // SUB-TAB 3: JOBS (STANDING JOBS, INBOX LIFECYCLE, RUN LOG & MOVES)
    // =========================================================================
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async function execConnectionVerb(verb, data = {}) {
        const wsSel = document.getElementById('remote-workspace');
        const workspaceRoot = (wsSel && wsSel.value) || undefined;
        const payload = Object.assign({}, data, { workspaceRoot });
        try {
            const res = await fetch(`/connections/verb/${encodeURIComponent(verb)}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                return { success: false, error: errJson.error || `Verb ${verb} failed` };
            }
            return await res.json();
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    async function loadJobsTabContent() {
        // 1. Standing jobs
        const standingEl = document.getElementById('standing-jobs-list');
        if (standingEl) {
            const res = await execConnectionVerb('jobsList');
            if (res.success && res.jobs) {
                if (res.jobs.length === 0) {
                    standingEl.innerHTML = `
                        <div style="padding: 4px 0; color: var(--text-secondary);">
                            <strong style="color: var(--text-primary);">First-Run Setup Guide</strong>
                            <ol style="margin: 6px 0 0 16px; padding: 0; line-height: 1.6;">
                                <li>Upload the <code>switchboard-spark</code> context artifact to your external AI surface (Gemini Spark, Claude Cowork, etc.).</li>
                                <li>Configure your external agent's cron/scheduler to check <code>.switchboard/instructions/inbox/</code> periodically.</li>
                                <li>Leave Switchboard running during scheduled windows so instruction imports, board updates, and declared moves apply live.</li>
                            </ol>
                        </div>
                    `;
                } else {
                    standingEl.innerHTML = res.jobs.map(j => {
                        const lastRunHtml = j.lastRun
                            ? `<span style="color: var(--text-primary);">${escapeHtml(j.lastRun.timestamp)}</span> — ${escapeHtml(j.lastRun.summary)}`
                            : `<span style="color: var(--text-secondary); font-style: italic;">Never run</span>`;
                        return `
                            <div style="background: #1e1e1e; border: 1px solid var(--border-color); border-radius: 4px; padding: 8px 10px; margin-bottom: 8px;">
                                <div style="font-weight: 600; color: var(--accent-teal); font-family: var(--font-code);">${escapeHtml(j.name)}</div>
                                <div style="color: var(--text-secondary); margin-top: 2px;">
                                    Advisory schedule: <strong style="color: var(--text-primary);">${escapeHtml(j.schedule)}</strong> (schedule lives in your agent's cron)
                                </div>
                                <div style="color: var(--text-secondary); margin-top: 2px;">
                                    Reads: <code>${escapeHtml(j.reads)}</code> | Writes: <code>${escapeHtml(j.writes)}</code>
                                </div>
                                <div style="margin-top: 4px; border-top: 1px dashed #333; padding-top: 4px;">
                                    <strong>Last run:</strong> ${lastRunHtml}
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            } else {
                standingEl.innerHTML = `<div style="color: #e74c3c;">Failed to load standing jobs: ${escapeHtml(res.error || 'unknown error')}</div>`;
            }
        }

        // 2. Inbox lifecycle
        const inboxEl = document.getElementById('jobs-inbox-list');
        if (inboxEl) {
            const res = await execConnectionVerb('jobsInboxList');
            if (res.success && res.items) {
                if (res.items.length === 0) {
                    inboxEl.innerHTML = `<div style="color: var(--text-secondary);">Inbox is empty (no pending, claimed, or stuck instructions).</div>`;
                } else {
                    inboxEl.innerHTML = res.items.map(item => {
                        let badgeHtml = '';
                        let actionHtml = '';
                        if (item.status === 'pending') {
                            badgeHtml = `<span style="background: #333; color: #ccc; padding: 2px 6px; border-radius: 3px; font-weight: bold;">pending</span>`;
                        } else if (item.status === 'claimed') {
                            badgeHtml = `<span style="background: #0e639c; color: #fff; padding: 2px 6px; border-radius: 3px; font-weight: bold;">claimed</span> by ${escapeHtml(item.agent || 'agent')}`;
                        } else if (item.status === 'done') {
                            badgeHtml = `<span style="background: #27ae60; color: #fff; padding: 2px 6px; border-radius: 3px; font-weight: bold;">done</span> ${item.result ? `(${escapeHtml(item.result)})` : ''}`;
                        } else if (item.status === 'stuck') {
                            badgeHtml = `<span style="background: #c0392b; color: #fff; padding: 2px 6px; border-radius: 3px; font-weight: bold;">STUCK</span> (claimed: ${escapeHtml(item.claimed_ts || 'unknown')})`;
                            actionHtml = `<button class="btn-clear-stuck-claim btn-secondary" data-file="${escapeHtml(item.file)}" style="padding: 2px 8px; font-size: 10px; border: none; border-radius: 2px; cursor: pointer; margin-left: 8px; background: #c0392b; color: #fff;">Clear claim</button>`;
                        }
                        return `
                            <div style="display: flex; align-items: center; justify-content: space-between; background: #1e1e1e; border: 1px solid var(--border-color); border-radius: 4px; padding: 6px 10px; margin-bottom: 6px;">
                                <div>
                                    <code style="color: var(--accent-teal);">${escapeHtml(item.file)}</code> — ${badgeHtml}
                                </div>
                                <div>${actionHtml}</div>
                            </div>
                        `;
                    }).join('');
                }
            } else {
                inboxEl.innerHTML = `<div style="color: #e74c3c;">Failed to load inbox items: ${escapeHtml(res.error || 'unknown error')}</div>`;
            }
        }

        // 3. Declared moves
        const movesEl = document.getElementById('declared-moves-list');
        if (movesEl) {
            const res = await execConnectionVerb('jobsMovesList');
            if (res.success && res.moves) {
                if (res.moves.length === 0) {
                    movesEl.innerHTML = `<div style="color: var(--text-secondary);">No declared moves recorded yet.</div>`;
                } else {
                    movesEl.innerHTML = res.moves.map(m => {
                        const isApplied = m.status === 'applied';
                        const statusBadge = isApplied
                            ? `<span style="color: #27ae60; font-weight: bold;">applied</span>`
                            : `<span style="color: #e67e22; font-weight: bold;">skipped</span>`;
                        const reasonHtml = (!isApplied && m.reason)
                            ? `<div style="color: var(--text-secondary); font-size: 10px; margin-top: 2px;">Reason: ${escapeHtml(m.reason)}</div>`
                            : '';
                        return `
                            <div style="background: #1e1e1e; border: 1px solid var(--border-color); border-radius: 4px; padding: 6px 10px; margin-bottom: 6px;">
                                <div>
                                    <code>${escapeHtml(m.plan_id)}</code> &rarr; <code>${escapeHtml(m.to_column)}</code> — ${statusBadge} <span style="color: var(--text-secondary); font-size: 10px;">(${escapeHtml(m.timestamp)})</span>
                                </div>
                                ${reasonHtml}
                            </div>
                        `;
                    }).join('');
                }
            } else {
                movesEl.innerHTML = `<div style="color: #e74c3c;">Failed to load declared moves: ${escapeHtml(res.error || 'unknown error')}</div>`;
            }
        }
    }

    document.getElementById('btn-copy-cron-prompt')?.addEventListener('click', () => {
        const text = "Follow your Switchboard context and process your instruction folder";
        const resultEl = document.getElementById('jobs-action-result');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                if (resultEl) resultEl.textContent = 'Cron prompt copied to clipboard ✓';
                setTimeout(() => { if (resultEl) resultEl.textContent = ''; }, 3000);
            }).catch(() => {
                vscode.postMessage({ type: 'copyTextToClipboard', text });
                if (resultEl) resultEl.textContent = 'Cron prompt copied to clipboard ✓';
                setTimeout(() => { if (resultEl) resultEl.textContent = ''; }, 3000);
            });
        } else {
            vscode.postMessage({ type: 'copyTextToClipboard', text });
            if (resultEl) resultEl.textContent = 'Cron prompt copied to clipboard ✓';
            setTimeout(() => { if (resultEl) resultEl.textContent = ''; }, 3000);
        }
    });

    document.getElementById('btn-refresh-jobs')?.addEventListener('click', async () => {
        const resultEl = document.getElementById('jobs-action-result');
        if (resultEl) resultEl.textContent = 'Refreshing activity...';
        await execConnectionVerb('jobsRefresh');
        await loadJobsTabContent();
        if (resultEl) {
            resultEl.textContent = 'Activity refreshed ✓';
            setTimeout(() => { resultEl.textContent = ''; }, 3000);
        }
    });

    document.getElementById('btn-drop-instruction')?.addEventListener('click', async () => {
        const inputEl = document.getElementById('instruction-body');
        const resultEl = document.getElementById('drop-instruction-result');
        const body = inputEl ? inputEl.value.trim() : '';
        if (!body) {
            if (resultEl) resultEl.textContent = 'Please enter an instruction body.';
            return;
        }
        if (resultEl) resultEl.textContent = 'Dropping instruction...';
        const res = await execConnectionVerb('jobsDropInstruction', { body });
        if (res.success) {
            if (inputEl) inputEl.value = '';
            if (resultEl) resultEl.textContent = 'Instruction dropped ✓';
            setTimeout(() => { if (resultEl) resultEl.textContent = ''; }, 3000);
            await loadJobsTabContent();
        } else {
            if (resultEl) resultEl.textContent = `Error: ${res.error || 'Failed to drop instruction'}`;
        }
    });

    document.getElementById('jobs-inbox-list')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.btn-clear-stuck-claim');
        if (btn) {
            const file = btn.getAttribute('data-file');
            if (file) {
                btn.textContent = 'Clearing...';
                btn.disabled = true;
                const res = await execConnectionVerb('jobsClearStuckClaim', { file });
                if (res.success) {
                    await loadJobsTabContent();
                } else {
                    btn.textContent = 'Clear failed';
                    alert(`Failed to clear claim: ${res.error || 'unknown error'}`);
                }
            }
        }
    });

    document.getElementById('btn-regenerate-spark-context')?.addEventListener('click', () => {
        const statusEl = document.getElementById('spark-context-result');
        if (statusEl) statusEl.textContent = 'Generating switchboard-spark.md…';
        vscode.postMessage({ type: 'regenerateSparkContext' });
    });

    // =========================================================================
    // SUB-TAB 5: DOCS HEALTH (PLANNING-DOC GUIDANCE & MAINTENANCE PROMPT)
    // =========================================================================
    document.getElementById('dh-btn-copy')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'docsHealthCopyPrompt' });
    });

    // =========================================================================
    // SUB-TAB 4: WEB AGENTS (DOCUMENT INGESTION & PLAN PASTE-BACK)
    // =========================================================================
    // ── Create Plans tab — point an agent at your docs, get a plan back ──
    // One real mechanism: the source picker (zip / public link / platform).
    // Prompts and the zip are assembled backend-side.
    (function initCreatePlansTab() {
        const rows = {
            zip: document.getElementById('cp-zip-row'),
            link: document.getElementById('cp-link-row'),
            platform: document.getElementById('cp-platform-row')
        };
        const urlInput = document.getElementById('cp-url');
        const refInput = document.getElementById('cp-ref');
        const platformSel = document.getElementById('cp-platform');
        const pasteArea = document.getElementById('cp-paste');
        const btnZip = document.getElementById('cp-btn-zip');
        const btnFolder = document.getElementById('cp-btn-folder');
        const folderPathEl = document.getElementById('cp-folder-path');
        const includeExtras = document.getElementById('cp-include-extras');
        const btnCopyLink = document.getElementById('cp-btn-copy-link');
        const btnCopyPlatform = document.getElementById('cp-btn-copy-platform');
        const btnCreate = document.getElementById('cp-btn-create');
        const btnImprove = document.getElementById('cp-btn-improve');
        const statusEl = document.getElementById('cp-status');
        const zipHint = document.getElementById('cp-zip-hint');
        if (!rows.zip || !btnZip) { return; } // pane absent — nothing to wire

        // The chosen folder is the zip's source; the button stays disabled until one is picked.
        let chosenFolder = '';

        document.querySelectorAll('input[name="cp-source"]').forEach(radio => {
            radio.addEventListener('change', () => {
                Object.keys(rows).forEach(k => { if (rows[k]) rows[k].style.display = (k === radio.value) ? '' : 'none'; });
            });
        });

        const gateLink = () => { btnCopyLink.disabled = !(urlInput && urlInput.value.trim()); };
        const gatePlatform = () => { btnCopyPlatform.disabled = !(refInput && refInput.value.trim()); };
        const gateCreate = () => { btnCreate.disabled = !(pasteArea && pasteArea.value.trim()); };
        if (urlInput) urlInput.addEventListener('input', gateLink);
        if (refInput) refInput.addEventListener('input', gatePlatform);
        if (pasteArea) pasteArea.addEventListener('input', gateCreate);

        if (btnFolder) btnFolder.addEventListener('click', () => {
            vscode.postMessage({ type: 'createPlansPickFolder' });
        });
        btnZip.addEventListener('click', () => {
            if (!chosenFolder) { return; }
            vscode.postMessage({
                type: 'createPlansDownloadZip',
                folder: chosenFolder,
                includeExtras: !!(includeExtras && includeExtras.checked)
            });
        });
        btnCopyLink.addEventListener('click', () => {
            vscode.postMessage({ type: 'createPlansCopyPrompt', source: 'link', url: urlInput.value.trim() });
        });
        btnCopyPlatform.addEventListener('click', () => {
            vscode.postMessage({ type: 'createPlansCopyPrompt', source: 'platform', platform: platformSel.value, reference: refInput.value.trim() });
        });
        btnCreate.addEventListener('click', () => {
            const markdown = pasteArea.value.trim();
            if (!markdown) { return; }
            btnCreate.disabled = true;
            if (statusEl) statusEl.textContent = 'Creating…';
            vscode.postMessage({ type: 'createPlansPasteBack', markdown });
        });
        btnImprove.addEventListener('click', () => {
            vscode.postMessage({ type: 'createPlansImproveSource' });
        });

        window.__createPlansHandleMessage = (message) => {
            if (message.type === 'createPlansState') {
                // The zip is gated on a folder being chosen, not on managed docs existing.
                // If no managed docs exist, the "include extras" checkbox has nothing to add.
                if (includeExtras && !message.hasDocs) {
                    includeExtras.checked = false;
                    includeExtras.disabled = true;
                    includeExtras.parentElement.title = 'No managed docs (constitution / PRDs / README) found in this workspace.';
                }
                if (urlInput && !urlInput.value && message.publicUrl) { urlInput.value = message.publicUrl; gateLink(); }
                if (platformSel && message.platform) { platformSel.value = message.platform; }
                if (refInput && !refInput.value && message.platformRef) { refInput.value = message.platformRef; gatePlatform(); }
                return;
            }
            if (message.type === 'createPlansFolderPicked') {
                chosenFolder = message.folder || '';
                if (folderPathEl) folderPathEl.textContent = chosenFolder || 'No folder chosen.';
                btnZip.disabled = !chosenFolder;
                if (zipHint) {
                    zipHint.textContent = chosenFolder
                        ? "Bundles the folder's docs with a HOW-TO-PLAN.md the agent follows."
                        : 'Choose a folder to bundle its docs.';
                }
                return;
            }
            if (message.type === 'createPlansPasteBackResult') {
                if (message.ok) {
                    if (pasteArea) pasteArea.value = '';
                    if (statusEl) statusEl.textContent = message.projectName
                        ? ('Plan card created (pinned to ' + message.projectName + ').')
                        : 'Plan card created (unassigned — assign on the board).';
                } else if (statusEl) {
                    statusEl.textContent = message.error || 'Import failed.';
                }
                gateCreate();
            }
        };
    })();

    // Handle incoming messages
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        switch (msg.type) {
            case 'remoteConfig':
                if (typeof msg.active === 'boolean') {
                    remoteControlActive = msg.active;
                    applyRemoteControlButtonState();
                }
                renderRemoteConfig(msg.config, msg);
                break;
            // The host is the authority on start/stop — the toggle posts and waits
            // for this echo rather than flipping locally, so a failed start cannot
            // leave the button claiming the service is running.
            case 'remoteControlState':
                remoteControlActive = !!msg.active;
                applyRemoteControlButtonState();
                break;
            // The real health push is `remoteSyncHealth` with a structured `health`
            // object. The earlier `remoteHealthResult` case matched no message the
            // host ever sends and wrote to an element that no longer exists.
            case 'remoteSyncHealth':
                renderRemoteSyncHealth(msg.health);
                break;
            case 'boardStateExportSetting': {
                const select = document.getElementById('board-state-export-select');
                if (select && typeof msg.value === 'string') { select.value = msg.value; }
                const row = document.getElementById('board-state-export-remote-url-row');
                if (row) { row.style.display = msg.value === 'read-only-snapshot' ? 'block' : 'none'; }
                const urlInput = document.getElementById('board-state-export-remote-url');
                if (urlInput && typeof msg.remoteUrl === 'string') { urlInput.value = msg.remoteUrl; }
                break;
            }
            // Hydrates the three Notion sync-option checkboxes. They are part of the
            // Remote form's markup but their stored state travels on the integration
            // state push, not in RemoteConfig — so without this they would render
            // unchecked over the user's real settings, and the next "Run Notion setup
            // sync" would write those blanks back.
            case 'integrationSetupStates': {
                const ns = msg.notionState;
                if (ns) {
                    const set = (id, on) => {
                        const el = document.getElementById(id);
                        if (el) { el.checked = on === true; }
                    };
                    set('notion-option-realtime-sync', ns.realTimeSyncEnabled);
                    set('notion-option-delete-sync', ns.deleteSyncEnabled);
                    set('notion-option-inbound-delete', ns.inboundDeleteEnabled);
                }
                break;
            }
            case 'notionRemoteSetupResult': {
                const statusEl = document.getElementById('remote-notion-setup-status');
                if (statusEl) {
                    statusEl.textContent = msg.success
                        ? `Setup complete — ${msg.backedUp || 0} card(s) backed up. Connect Notion to claude.ai and drive it from there.`
                        : `Setup failed: ${msg.error || 'unknown error'}`;
                }
                break;
            }
            case 'linearAgentSkillText': {
                const btn = document.getElementById('btn-copy-linear-agent-skill');
                const status = document.getElementById('copy-linear-agent-skill-status');
                if (msg.text) {
                    navigator.clipboard.writeText(msg.text).then(() => {
                        if (btn) { btn.textContent = 'Copied!'; }
                        if (status) { status.textContent = ''; }
                        setTimeout(() => { if (btn) { btn.textContent = 'Copy Linear Agent Skill'; } }, 2000);
                    }).catch(err => {
                        console.error('Failed to copy Linear agent skill:', err);
                        if (status) { status.textContent = 'Copy failed — see console.'; }
                    });
                } else if (status) {
                    status.textContent = msg.error || 'Could not build the Linear agent skill.';
                }
                break;
            }
            case 'sparkContextResult': {
                const statusEl = document.getElementById('spark-context-result');
                if (statusEl) {
                    statusEl.textContent = msg.success
                        ? `Generated ${msg.path || '.switchboard/switchboard-spark.md'} ✓`
                        : 'Failed to generate Spark context.';
                }
                break;
            }
            case 'createPlansState':
            case 'createPlansFolderPicked':
            case 'createPlansPasteBackResult': {
                if (window.__createPlansHandleMessage) { window.__createPlansHandleMessage(msg); }
                break;
            }
            case 'docsHealthPromptResult': {
                const statusEl = document.getElementById('dh-status');
                if (statusEl) {
                    statusEl.textContent = msg.success
                        ? 'Copied to clipboard!'
                        : (msg.error || 'Copy failed.');
                }
                break;
            }
        }
    });

    // Initial load. `getIntegrationSetupStates` is what carries notionState, which
    // hydrates the Notion sync-option checkboxes. `boardStateExportSetting` has no
    // request verb — it arrives on the Setup panel state push.
    vscode.postMessage({ type: 'getRemoteConfig' });
    vscode.postMessage({ type: 'getIntegrationSetupStates' });
})();
