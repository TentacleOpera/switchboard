(function () {
    const vscode = acquireVsCodeApi();
    const WS_ROOT = decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');
    let _wsRoot = WS_ROOT;

    // What we sent with the most recent memoGeneratePrompt — guards the clear so
    // text the user typed AFTER clicking is never discarded.
    let _submittedContent = null;
    // Which button to flash — 'copy' or 'send'.
    let _submittedAction = null;

    // Split on BOTH separators: this extension ships on Windows, where an
    // absolute root ("C:\Users\x\repo") contains no '/' and a '/'-only split
    // would render the whole path instead of the folder name.
    function _basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }

    const wsLabel = document.getElementById('memo-workspace');
    if (wsLabel) { wsLabel.textContent = _basename(_wsRoot); }

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
                if (msg.workspaceRoot && msg.workspaceRoot !== _wsRoot) {
                    if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
                    _memoDirty = false;
                    _submittedContent = null;
                    _wsRoot = msg.workspaceRoot;
                    if (wsLabel) { wsLabel.textContent = _basename(_wsRoot); }
                    const ta = document.getElementById('memo-textarea');
                    if (ta) { ta.value = ''; }
                    vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
                }
                break;
            }
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
                if (msg.memoCleared) {
                    const textarea = document.getElementById('memo-textarea');
                    if (textarea && (_submittedContent === null || textarea.value === _submittedContent || textarea.value === '')) {
                        textarea.value = '';
                        if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
                        _memoDirty = false;
                    }
                }
                // Gate on memoCleared, NOT on !isError. The empty-memo reply is
                // { success: true, memoCleared: false } with no `isError`, so an
                // !isError gate flashed "Copied ✓" on a no-op that never reached
                // the clipboard — feedback describing something that did not
                // happen, the same defect _flashCopied() was replaced for.
                if (!msg.isError && msg.memoCleared) { _flashAction(msg.action || _submittedAction); }
                _submittedContent = null;
                _submittedAction = null;
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
