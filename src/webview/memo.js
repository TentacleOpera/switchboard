(function () {
    const vscode = acquireVsCodeApi();
    const WS_ROOT = decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');

    function handleThemeChanged(theme) {
        document.body.classList.remove('theme-claudify', 'cyber-theme-enabled');
        if (theme === 'claudify') {
            document.body.classList.add('theme-claudify');
        } else if (theme === 'cyber' || theme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        }
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
                if (statusEl) statusEl.textContent = msg.message || '';
                break;
            }
            case 'memoError': {
                const statusEl = document.getElementById('memo-status');
                if (statusEl) { statusEl.textContent = msg.message || 'Memo error'; }
                break;
            }
        }
    });

    // Initial load request
    vscode.postMessage({ type: 'memoLoad', workspaceRoot: WS_ROOT });

    let _memoDirty = false;
    let _memoSaveTimer = null;
    function _debouncedMemoSave() {
        _memoDirty = true;
        if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
        _memoSaveTimer = setTimeout(() => {
            const content = document.getElementById('memo-textarea')?.value || '';
            vscode.postMessage({ type: 'memoSave', content, workspaceRoot: WS_ROOT });
            _memoDirty = false;
            const statusEl = document.getElementById('memo-status');
            if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500); }
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
            vscode.postMessage({ type: 'memoClear', workspaceRoot: WS_ROOT });
            const statusEl = document.getElementById('memo-status');
            if (statusEl) statusEl.textContent = 'Cleared';
        });
    }
    const _memoCopyBtn = document.getElementById('memo-copy-btn');
    if (_memoCopyBtn) {
        _memoCopyBtn.addEventListener('click', () => {
            if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
            _memoDirty = false;
            const content = document.getElementById('memo-textarea')?.value || '';
            vscode.postMessage({ type: 'memoGeneratePrompt', content, action: 'copy', workspaceRoot: WS_ROOT });
        });
    }
    const _memoSendBtn = document.getElementById('memo-send-btn');
    if (_memoSendBtn) {
        _memoSendBtn.addEventListener('click', () => {
            if (_memoSaveTimer) clearTimeout(_memoSaveTimer);
            _memoDirty = false;
            const content = document.getElementById('memo-textarea')?.value || '';
            vscode.postMessage({ type: 'memoGeneratePrompt', content, action: 'send', workspaceRoot: WS_ROOT });
        });
    }
})();
