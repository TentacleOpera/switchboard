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
        });
    });

    // =========================================================================
    // SUB-TAB 1: PROVIDERS (REMOTE CONTROL CONFIG)
    // =========================================================================
    let remoteControlActive = false;
    let _remoteHealthTimer = null;
    let _remoteCapabilities = { pull: true, push: true };

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

    function applyRemoteProviderUi() {
        const providerEl = document.getElementById('remote-provider');
        const provider = providerEl ? providerEl.value : 'linear';
        const setupNotion = document.getElementById('remote-notion-setup');
        if (setupNotion) setupNotion.style.display = provider === 'notion' ? 'block' : 'none';
        const setupClickup = document.getElementById('remote-clickup-setup');
        if (setupClickup) setupClickup.style.display = provider === 'clickup' ? 'block' : 'none';

        const title = document.getElementById('remote-subsection-title');
        if (title) {
            title.textContent = provider === 'notion' ? 'Remote Control (Notion)'
                : provider === 'clickup' ? 'Remote Control (ClickUp)'
                : 'Remote Control (Linear)';
        }
        const skillBlock = document.getElementById('remote-linear-agent-skill');
        if (skillBlock) skillBlock.style.display = provider === 'linear' ? 'block' : 'none';
    }

    function renderRemoteConfig(config, payload) {
        payload = payload || {};
        const wsSel = document.getElementById('remote-workspace');
        if (wsSel && Array.isArray(payload.workspaces)) {
            wsSel.innerHTML = '';
            payload.workspaces.forEach(w => {
                const opt = document.createElement('option');
                opt.value = w.path;
                opt.textContent = w.name;
                if (w.path === payload.selectedWorkspace) opt.selected = true;
                wsSel.appendChild(opt);
            });
        }

        const providerEl = document.getElementById('remote-provider');
        if (providerEl && config.provider) providerEl.value = config.provider;

        const freqEl = document.getElementById('remote-frequency');
        if (freqEl && config.frequencySeconds) freqEl.value = config.frequencySeconds;

        const modeIngest = document.getElementById('remote-mode-ingest');
        const modeFull = document.getElementById('remote-mode-full');
        if (config.mode === 'full') {
            if (modeFull) modeFull.checked = true;
        } else {
            if (modeIngest) modeIngest.checked = true;
        }

        const commentsEl = document.getElementById('remote-comments');
        if (commentsEl) commentsEl.checked = config.autoComment !== false;

        const contentEl = document.getElementById('remote-content');
        if (contentEl) contentEl.checked = config.includeContent !== false;

        const pushEl = document.getElementById('remote-push');
        if (pushEl) pushEl.checked = config.autoPush !== false;

        remoteControlActive = !!payload.active;
        applyRemoteControlButtonState();
        applyRemoteProviderUi();
    }

    function readRemoteConfigFromUi() {
        const providerEl = document.getElementById('remote-provider');
        const freqEl = document.getElementById('remote-frequency');
        const modeFull = document.getElementById('remote-mode-full');
        const commentsEl = document.getElementById('remote-comments');
        const contentEl = document.getElementById('remote-content');
        const pushEl = document.getElementById('remote-push');

        return {
            provider: providerEl ? providerEl.value : 'linear',
            frequencySeconds: parseInt(freqEl?.value || '30', 10),
            mode: modeFull?.checked ? 'full' : 'ingest',
            autoComment: commentsEl ? commentsEl.checked : true,
            includeContent: contentEl ? contentEl.checked : true,
            autoPush: pushEl ? pushEl.checked : true,
        };
    }

    function saveRemoteConfig() {
        const wsSel = document.getElementById('remote-workspace');
        const cfg = readRemoteConfigFromUi();
        vscode.postMessage({
            type: 'setRemoteConfig',
            config: cfg,
            workspaceRoot: wsSel ? wsSel.value : undefined
        });
    }

    // Attach listeners for Providers tab
    document.getElementById('remote-provider')?.addEventListener('change', () => {
        applyRemoteProviderUi();
        saveRemoteConfig();
    });

    document.getElementById('btn-remote-control-toggle')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        const action = remoteControlActive ? 'stopRemoteControl' : 'startRemoteControl';
        vscode.postMessage({ type: action, workspaceRoot: wsSel ? wsSel.value : undefined });
        remoteControlActive = !remoteControlActive;
        applyRemoteControlButtonState();
    });

    document.getElementById('remote-linear-copy-skill')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({ type: 'copyLinearAgentSkill', workspaceRoot: wsSel ? wsSel.value : undefined });
    });

    document.getElementById('btn-run-notion-remote-setup')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({ type: 'runNotionRemoteSetup', workspaceRoot: wsSel ? wsSel.value : undefined });
    });

    document.getElementById('btn-run-clickup-remote-setup')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({ type: 'runClickUpRemoteSetup', workspaceRoot: wsSel ? wsSel.value : undefined });
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
    // SUB-TAB 3: JOBS (SPARK CONTEXT REGENERATION)
    // =========================================================================
    document.getElementById('btn-regenerate-spark-context')?.addEventListener('click', () => {
        const statusEl = document.getElementById('spark-context-result');
        if (statusEl) statusEl.textContent = 'Generating switchboard-spark.md…';
        vscode.postMessage({ type: 'regenerateSparkContext' });
    });

    // =========================================================================
    // SUB-TAB 4: WEB AGENTS (DOCUMENT INGESTION & PLAN PASTE-BACK)
    // =========================================================================
    document.getElementById('create-plans-zip-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'createPlansPickFolder' });
    });

    document.getElementById('create-plans-copy-prompt-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'createPlansCopyPrompt' });
    });

    document.getElementById('create-plans-paste-btn')?.addEventListener('click', () => {
        const textarea = document.getElementById('create-plans-paste-textarea');
        const statusEl = document.getElementById('create-plans-paste-status');
        const content = textarea ? textarea.value.trim() : '';
        if (!content) {
            if (statusEl) statusEl.textContent = 'Please paste markdown content first.';
            return;
        }
        if (statusEl) statusEl.textContent = 'Creating plan card…';
        vscode.postMessage({ type: 'createPlansPasteBack', content });
    });

    // Handle incoming messages
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        switch (msg.type) {
            case 'remoteConfig':
                renderRemoteConfig(msg.config || {}, msg);
                break;
            case 'sparkContextResult': {
                const statusEl = document.getElementById('spark-context-result');
                if (statusEl) {
                    statusEl.textContent = msg.success
                        ? `Generated ${msg.path || '.switchboard/switchboard-spark.md'} ✓`
                        : 'Failed to generate Spark context.';
                }
                break;
            }
            case 'createPlansPasteBackResult': {
                const statusEl = document.getElementById('create-plans-paste-status');
                if (statusEl) {
                    statusEl.textContent = msg.success
                        ? 'Plan card created on board ✓'
                        : `Error: ${msg.message || 'Failed to create plan card'}`;
                }
                break;
            }
            case 'remoteHealthResult': {
                const el = document.getElementById('remote-health-content');
                if (el) el.textContent = msg.health || 'Connection healthy ✓';
                break;
            }
        }
    });

    // Initial load
    vscode.postMessage({ type: 'getRemoteConfig' });
})();
