(function () {
    const vscode = acquireVsCodeApi();
    const WS_ROOT = decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');
    let _wsRoot = WS_ROOT;
    let _wsRootExplicit = false;

    // What we sent with the most recent memoGeneratePrompt — guards the clear so
    // text the user typed AFTER clicking is never discarded.
    let _submittedContent = null;
    // Which button to flash — 'copy' or 'send'.
    let _submittedAction = null;

    const _wsSelect = document.getElementById('memo-workspace-select');

    function handleThemeChanged(theme) {
        document.body.classList.remove('theme-claudify', 'cyber-theme-enabled');
        if (theme === 'claudify') {
            document.body.classList.add('theme-claudify');
        } else if (theme === 'cyber' || theme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        }
    }

    function _flashAction(action) {
        const isSend = action === 'send';
        const btn = document.getElementById(isSend ? 'memo-send-btn' : 'memo-copy-btn');
        if (!btn || btn.dataset.flashing === '1') return;
        const original = btn.textContent;
        btn.dataset.flashing = '1';
        btn.textContent = isSend ? 'Sent ✓' : 'Copied ✓';
        btn.classList.add('is-copied');
        setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('is-copied');
            btn.dataset.flashing = '0';
        }, 1600);
    }

    function _populateWorkspaceSelect(items, activeWorkspaceRoot) {
        if (!_wsSelect) return;
        _wsSelect.innerHTML = '';
        const list = Array.isArray(items) ? items : [];
        for (const item of list) {
            const opt = document.createElement('option');
            opt.value = item.workspaceRoot || '';
            opt.textContent = item.label || item.workspaceRoot || '';
            _wsSelect.appendChild(opt);
        }
        let selected = _wsRoot;
        const hasCurrent = list.some(i => i.workspaceRoot === _wsRoot);
        if (_wsRootExplicit && hasCurrent) {
            selected = _wsRoot;
        } else if (activeWorkspaceRoot && list.some(i => i.workspaceRoot === activeWorkspaceRoot)) {
            selected = activeWorkspaceRoot;
        } else if (list.length > 0) {
            selected = list[0].workspaceRoot;
        } else {
            selected = '';
        }
        _wsSelect.value = selected;
        if (selected && selected !== _wsRoot) {
            _wsRoot = selected;
            _memoDirty = false;
            _submittedContent = null;
            const ta = document.getElementById('memo-textarea');
            if (ta) { ta.value = ''; }
            vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
        }
    }

    function switchMemoWorkspace(nextRoot) {
        if (!nextRoot || nextRoot === _wsRoot) { return; }
        // Flush against the OLD root before switching. A pending debounced save
        // would otherwise write this workspace's text into the next one.
        if (_memoSaveTimer) {
            clearTimeout(_memoSaveTimer);
            _memoSaveTimer = null;
            const content = document.getElementById('memo-textarea')?.value || '';
            vscode.postMessage({ type: 'memoSave', content, workspaceRoot: _wsRoot });
        }
        _memoDirty = false;              // else memoContent's dirty-guard drops the load
        _submittedContent = null;
        _wsRoot = nextRoot;
        _wsRootExplicit = true;
        const ta = document.getElementById('memo-textarea');
        if (ta) { ta.value = ''; }
        vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        switch (msg.type) {
            case 'switchboardThemeChanged':
            case 'switchboardThemeNameSetting': {
                if (msg.theme) {
                    handleThemeChanged(msg.theme);
                }
                break;
            }
            case 'workspaceChanged': {
                // A board workspace switch must not undo an explicit memo target.
                if (_wsRootExplicit) { break; }
                if (msg.workspaceRoot && msg.workspaceRoot !== _wsRoot) {
                    if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
                    _memoDirty = false;
                    _submittedContent = null;
                    _wsRoot = msg.workspaceRoot;
                    const ta = document.getElementById('memo-textarea');
                    if (ta) { ta.value = ''; }
                    vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
                }
                // Refresh the picker in case the set of roots changed.
                vscode.postMessage({ type: 'memoListWorkspaces' });
                break;
            }
            case 'memoWorkspaceItems': {
                _populateWorkspaceSelect(msg.items, msg.activeWorkspaceRoot);
                break;
            }
            case 'memoUpdated':
            case 'memoContent': {
                const textarea = document.getElementById('memo-textarea');
                if (textarea) {
                    const isFocused = document.activeElement === textarea;
                    if (isFocused || _memoDirty) {
                        break;
                    }
                    textarea.value = typeof msg.content === 'string' ? msg.content : '';
                }
                break;
            }
            case 'memoPromptResult': {
                const statusEl = document.getElementById('memo-status');
                if (statusEl) {
                    statusEl.textContent = msg.message || '';
                    statusEl.style.color = msg.isError ? 'var(--accent-red)' : 'var(--text-secondary)';
                }
                // Resolve the button to flash BEFORE any reset below can null the
                // locally-recorded fallback.
                const flashAction = msg.action || _submittedAction;
                // In the BROWSER one click produces TWO deliveries of this same
                // reply: the WS fan-out (BroadcastHub.mirrorToWs, switched on with
                // _apiServerForBroadcast) and the HTTP response body re-dispatched
                // by transport.js. Every branch here must therefore be safe to run
                // twice, and the post-click-typing guard must survive the first
                // delivery — see the reset rule below.
                let clearedNow = false;
                if (msg.memoCleared) {
                    const textarea = document.getElementById('memo-textarea');
                    //  - value === _submittedContent : the batch we submitted is
                    //    still on screen — clear it.
                    //  - value === ''                : already cleared (the other
                    //    delivery, or the memoContent:'' push, got here first).
                    //    Treat as satisfied, never as a mismatch, or two correct
                    //    signals cancel out.
                    //  - _submittedContent === null   : we never submitted, so this
                    //    reply belongs to another surface (the sidebar pressed Copy).
                    //    Trust the flag, but honour the SAME dirty/focus guard the
                    //    memoContent case uses, or a foreign clear discards local
                    //    typing.
                    const isFocused = document.activeElement === textarea;
                    const mayClearForeign = _submittedContent === null && !_memoDirty && !isFocused;
                    if (textarea && (textarea.value === _submittedContent || textarea.value === '' || mayClearForeign)) {
                        textarea.value = '';
                        if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
                        _memoDirty = false;
                        clearedNow = true;
                    }
                }
                // Reset rule: release the guard once the batch is gone (clearedNow)
                // or once we know no clear is coming at all (memoCleared false —
                // empty memo, or a failed send that preserved the memo). The ONE
                // path that must KEEP it is "memoCleared true but we declined
                // because the user typed after clicking": nulling there lets the
                // second delivery take the `=== null` branch and discard the very
                // text this guard just protected (reproduced — the typed text was
                // lost on delivery 2).
                if (clearedNow || !msg.memoCleared) {
                    _submittedContent = null;
                    _submittedAction = null;
                }
                // Gate on memoCleared, NOT on !isError. The empty-memo reply is
                // { success: true, memoCleared: false } with no `isError`, so an
                // !isError gate flashed "Copied ✓" on a no-op that never reached
                // the clipboard — feedback describing something that did not
                // happen, the same defect _flashCopied() was replaced for.
                if (!msg.isError && msg.memoCleared) { _flashAction(flashAction); }
                break;
            }
            case 'memoError': {
                const statusEl = document.getElementById('memo-status');
                if (statusEl) {
                    statusEl.textContent = msg.message || 'Memo error';
                    statusEl.style.color = 'var(--accent-red)';
                }
                break;
            }
        }
    });

    // Initial load request
    vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
    vscode.postMessage({ type: 'memoListWorkspaces' });

    if (_wsSelect) {
        _wsSelect.addEventListener('change', (e) => {
            switchMemoWorkspace(e.target.value);
        });
    }

    let _memoDirty = false;
    let _memoSaveTimer = null;
    function _debouncedMemoSave() {
        _memoDirty = true;
        if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
        _memoSaveTimer = setTimeout(() => {
            const content = document.getElementById('memo-textarea')?.value || '';
            vscode.postMessage({ type: 'memoSave', content, workspaceRoot: _wsRoot });
            _memoDirty = false;
            const statusEl = document.getElementById('memo-status');
            if (statusEl) {
                statusEl.textContent = 'Saved';
                statusEl.style.color = 'var(--text-secondary)';
                setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
            }
        }, 800);
    }

    const _memoTextarea = document.getElementById('memo-textarea');
    if (_memoTextarea) { _memoTextarea.addEventListener('input', _debouncedMemoSave); }
    const _memoClearBtn = document.getElementById('memo-clear-btn');
    if (_memoClearBtn) {
        _memoClearBtn.addEventListener('click', () => {
            const textarea = document.getElementById('memo-textarea');
            if (textarea) textarea.value = '';
            if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
            _memoDirty = false;
            vscode.postMessage({ type: 'memoClear', workspaceRoot: _wsRoot });
            const statusEl = document.getElementById('memo-status');
            if (statusEl) {
                statusEl.textContent = 'Cleared';
                statusEl.style.color = 'var(--text-secondary)';
            }
        });
    }
    const _memoCopyBtn = document.getElementById('memo-copy-btn');
    if (_memoCopyBtn) {
        _memoCopyBtn.addEventListener('click', () => {
            if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
            _memoDirty = false;
            const content = document.getElementById('memo-textarea')?.value || '';
            _submittedContent = content;
            _submittedAction = 'copy';
            const statusEl = document.getElementById('memo-status');
            if (statusEl) { statusEl.textContent = 'Building prompt…'; statusEl.style.color = 'var(--text-secondary)'; }
            vscode.postMessage({ type: 'memoGeneratePrompt', content, action: 'copy', workspaceRoot: _wsRoot });
        });
    }
    const _memoSendBtn = document.getElementById('memo-send-btn');
    if (_memoSendBtn) {
        _memoSendBtn.addEventListener('click', () => {
            if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
            _memoDirty = false;
            const content = document.getElementById('memo-textarea')?.value || '';
            _submittedContent = content;
            _submittedAction = 'send';
            const statusEl = document.getElementById('memo-status');
            if (statusEl) { statusEl.textContent = 'Building prompt…'; statusEl.style.color = 'var(--text-secondary)'; }
            vscode.postMessage({ type: 'memoGeneratePrompt', content, action: 'send', workspaceRoot: _wsRoot });
        });
    }
})();
