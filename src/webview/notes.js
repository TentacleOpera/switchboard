(function () {
    const vscode = acquireVsCodeApi();
    const WS_ROOT = decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');
    let _wsRoot = WS_ROOT;

    // Split on BOTH separators — an absolute Windows root contains no '/'. (memo.js)
    function _basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }

    const wsLabel = document.getElementById('notes-workspace');
    if (wsLabel) { wsLabel.textContent = _basename(_wsRoot); }

    function handleThemeChanged(theme) {
        document.body.classList.remove('theme-claudify', 'cyber-theme-enabled');
        if (theme === 'claudify') {
            document.body.classList.add('theme-claudify');
        } else if (theme === 'cyber' || theme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        }
    }

    function _el(id) { return document.getElementById(id); }

    function _setStatus(text, isError) {
        const el = _el('notes-status');
        if (el) {
            el.textContent = text || '';
            el.style.color = isError ? 'var(--accent-red)' : 'var(--text-secondary)';
        }
    }

    function _requestList() {
        vscode.postMessage({ type: 'notesList', workspaceRoot: _wsRoot });
    }

    // ISO (UTC) → the local value a <input type="datetime-local"> expects.
    function _isoToLocalInput(iso) {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return '';
        const d = new Date(t);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function _syncWhenVisibility() {
        const kind = _el('note-kind')?.value;
        const field = _el('note-when-field');
        if (field) { field.classList.toggle('hidden', kind !== 'meeting'); }
    }

    function _clearForm() {
        if (_el('note-id')) _el('note-id').value = '';
        if (_el('note-title')) _el('note-title').value = '';
        if (_el('note-kind')) _el('note-kind').value = 'plan';
        if (_el('note-when')) _el('note-when').value = '';
        if (_el('note-tags')) _el('note-tags').value = '';
        if (_el('note-body')) _el('note-body').value = '';
        _syncWhenVisibility();
        _setStatus('');
    }

    function _renderList(notes) {
        const list = _el('notes-list');
        if (!list) return;
        list.innerHTML = '';
        if (!Array.isArray(notes) || notes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'notes-empty';
            empty.textContent = 'No notes yet. Create one below.';
            list.appendChild(empty);
            return;
        }
        for (const note of notes) {
            const row = document.createElement('div');
            row.className = 'note-row';
            row.dataset.id = note.id;

            const main = document.createElement('div');
            main.className = 'note-row-main';
            const title = document.createElement('div');
            title.className = 'note-row-title';
            title.textContent = note.title || '(untitled)';
            const meta = document.createElement('div');
            meta.className = 'note-row-meta';
            const when = note.when ? ` · ${_isoToLocalInput(note.when).replace('T', ' ')}` : '';
            meta.textContent = `${note.kind || 'note'} · ${_relTime(note.updated)}${when}`;
            main.appendChild(title);
            main.appendChild(meta);

            const del = document.createElement('button');
            del.className = 'note-row-delete';
            del.title = 'Delete note';
            del.textContent = '✕';
            // Delete immediately — no confirmation (hard project rule; confirm() is
            // a silent no-op in a VS Code webview anyway).
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'notesDelete', id: note.id, workspaceRoot: _wsRoot });
            });

            main.addEventListener('click', () => {
                vscode.postMessage({ type: 'notesRead', id: note.id, workspaceRoot: _wsRoot });
            });

            row.appendChild(main);
            row.appendChild(del);
            list.appendChild(row);
        }
    }

    function _relTime(iso) {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return '';
        const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    }

    // Extract the body out of the stored markdown (everything after the `## Body`
    // marker) so the edit form shows the body, not the metadata block.
    function _bodyFromContent(content) {
        const s = typeof content === 'string' ? content : '';
        const m = s.match(/^##\s+Body\s*$/im);
        if (m && m.index !== undefined) {
            return s.slice(m.index + m[0].length).replace(/^\n+/, '').trimEnd();
        }
        return '';
    }

    function _loadNoteIntoForm(note) {
        if (!note) return;
        if (_el('note-id')) _el('note-id').value = note.id || '';
        if (_el('note-title')) _el('note-title').value = note.title || '';
        if (_el('note-kind')) _el('note-kind').value = note.kind || 'plan';
        if (_el('note-tags')) _el('note-tags').value = Array.isArray(note.tags) ? note.tags.join(', ') : '';
        if (_el('note-when')) _el('note-when').value = note.when ? _isoToLocalInput(note.when) : '';
        if (_el('note-body')) _el('note-body').value = _bodyFromContent(note.content);
        _syncWhenVisibility();
        _setStatus(`Editing "${note.title || '(untitled)'}"`);
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        switch (msg.type) {
            case 'switchboardThemeChanged':
            case 'switchboardThemeNameSetting': {
                if (msg.theme) { handleThemeChanged(msg.theme); }
                break;
            }
            case 'workspaceChanged': {
                if (msg.workspaceRoot && msg.workspaceRoot !== _wsRoot) {
                    _wsRoot = msg.workspaceRoot;
                    if (wsLabel) { wsLabel.textContent = _basename(_wsRoot); }
                    _clearForm();
                    _requestList();
                }
                break;
            }
            case 'notesListResult': {
                _renderList(msg.notes || []);
                break;
            }
            case 'noteContent': {
                _loadNoteIntoForm(msg.note);
                break;
            }
            case 'noteSaved': {
                _setStatus(`Saved "${(msg.note && msg.note.title) || 'note'}"`);
                _clearForm();
                _requestList();
                break;
            }
            case 'noteDeleted': {
                _setStatus('Note deleted');
                // If the deleted note was in the form, reset it.
                if (_el('note-id') && _el('note-id').value === String(msg.id)) { _clearForm(); }
                _requestList();
                break;
            }
            case 'notesError': {
                _setStatus(msg.message || 'Notes error', true);
                break;
            }
        }
    });

    // --- Form wiring ---
    _el('note-kind')?.addEventListener('change', _syncWhenVisibility);
    _el('note-new-btn')?.addEventListener('click', _clearForm);
    _el('note-save-btn')?.addEventListener('click', () => {
        const title = _el('note-title')?.value.trim() || '';
        if (!title) { _setStatus('A title is required', true); return; }
        const kind = _el('note-kind')?.value || 'plan';
        const body = _el('note-body')?.value || '';
        const tags = _el('note-tags')?.value || '';
        const whenRaw = _el('note-when')?.value || '';
        const id = _el('note-id')?.value || '';
        const payload = { type: 'notesCreate', workspaceRoot: _wsRoot, kind, title, body, tags };
        if (id) { payload.id = id; }
        if (kind === 'meeting' && whenRaw) { payload.when = whenRaw; }
        _setStatus('Saving…');
        vscode.postMessage(payload);
    });

    // Initial load
    _syncWhenVisibility();
    _requestList();
})();
