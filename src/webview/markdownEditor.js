(function() {
    // Inject self-contained stylesheet once
    if (!document.getElementById('md-editor-styles')) {
        const style = document.createElement('style');
        style.id = 'md-editor-styles';
        style.textContent = `
            .md-editor-shell {
                display: none;
                flex-direction: column;
                border: 1px solid var(--border-color, #30363d);
                background: var(--bg-color, #0d1117);
                border-radius: 6px;
                overflow: hidden;
                width: 100%;
                height: 100%;
                box-sizing: border-box;
            }
            .edit-mode .md-editor-shell {
                display: flex;
            }
            .md-toolbar {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px;
                padding: 6px;
                background: var(--toolbar-bg, #161b22);
                border-bottom: 1px solid var(--border-color, #30363d);
                user-select: none;
            }
            .md-toolbar-btn {
                background: transparent;
                border: 1px solid transparent;
                color: var(--text-color, #c9d1d9);
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 12px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 24px;
                height: 24px;
                box-sizing: border-box;
            }
            .md-toolbar-btn:hover {
                background: var(--btn-hover-bg, #21262d);
                border-color: var(--border-color, #30363d);
            }
            .md-toolbar-separator {
                width: 1px;
                height: 16px;
                background: var(--border-color, #30363d);
                margin: 0 4px;
            }
            .md-view-toggle {
                margin-left: auto;
                display: flex;
                background: var(--toggle-bg, #0d1117);
                border: 1px solid var(--border-color, #30363d);
                border-radius: 4px;
                overflow: hidden;
                padding: 2px;
            }
            .md-toggle-btn {
                background: transparent;
                border: none;
                color: var(--text-muted, #8b949e);
                font-size: 11px;
                padding: 2px 8px;
                cursor: pointer;
                border-radius: 3px;
            }
            .md-toggle-btn.active {
                background: var(--accent-teal, #00f0ff);
                color: #000;
                font-weight: 600;
            }
            .md-body {
                display: flex;
                flex: 1;
                position: relative;
                overflow: hidden;
                width: 100%;
                height: 100%;
                box-sizing: border-box;
            }
            .md-body > textarea.markdown-editor {
                flex: 1;
                border: none !important;
                resize: none;
                background: transparent;
                color: var(--text-color, #c9d1d9);
                font-family: var(--font-monospace, monospace);
                font-size: 13px;
                padding: 12px;
                box-sizing: border-box;
                outline: none;
                height: 100% !important;
                margin: 0 !important;
                display: block !important; /* override outer display:none */
            }
            .md-live-preview {
                flex: 1;
                border-left: 1px solid var(--border-color, #30363d);
                padding: 12px;
                overflow-y: auto;
                box-sizing: border-box;
                background: var(--preview-bg, #0d1117);
                height: 100%;
            }
            /* Markdown styling integration */
            .md-live-preview.markdown-body {
                color: var(--text-color, #c9d1d9);
                font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif);
                font-size: 14px;
                line-height: 1.6;
            }
            .md-preview-placeholder {
                color: var(--text-muted, #8b949e);
                font-style: italic;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100%;
                font-size: 13px;
            }
            /* Table picker popover */
            .md-table-picker-container {
                position: relative;
                display: inline-block;
            }
            .md-table-popover {
                display: none;
                position: absolute;
                top: 26px;
                left: 0;
                background: var(--toolbar-bg, #161b22);
                border: 1px solid var(--border-color, #30363d);
                border-radius: 6px;
                padding: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                z-index: 1000;
            }
            .md-table-popover.show {
                display: block;
            }
            .md-table-grid {
                display: grid;
                grid-gap: 2px;
            }
            .md-table-cell {
                width: 14px;
                height: 14px;
                border: 1px solid var(--border-color, #30363d);
                background: transparent;
                cursor: pointer;
            }
            .md-table-cell.highlighted {
                background: var(--accent-teal, #00f0ff);
                border-color: var(--accent-teal, #00f0ff);
            }
            .md-table-picker-title {
                font-size: 10px;
                color: var(--text-muted, #8b949e);
                margin-top: 4px;
                text-align: center;
            }
            /* Responsive modes */
            @media (max-width: 640px) {
                .md-body {
                    flex-direction: column;
                }
                .md-live-preview {
                    border-left: none;
                    border-top: 1px solid var(--border-color, #30363d);
                }
            }
            /* View-specific configurations */
            .md-editor-shell.view-edit .md-live-preview {
                display: none !important;
            }
            .md-editor-shell.view-edit textarea.markdown-editor {
                flex: 1 !important;
                display: block !important;
            }
            .md-editor-shell.view-preview textarea.markdown-editor {
                display: none !important;
            }
            .md-editor-shell.view-preview .md-live-preview {
                flex: 1 !important;
                display: block !important;
                border-left: none !important;
            }
            .md-editor-shell.view-split textarea.markdown-editor {
                display: block !important;
            }
            .md-editor-shell.view-split .md-live-preview {
                display: block !important;
            }
        `;
        document.head.appendChild(style);
    }

    // Shared global view preference (persisted in-memory for the session)
    let globalViewMode = 'split'; // 'split' | 'edit' | 'preview'

    window.SwitchboardMarkdownEditor = {
        attach(textarea, options = {}) {
            if (!textarea) return;
            if (textarea.dataset.mdEditorAttached) {
                // Already attached — re-trigger render with current content
                textarea.dispatchEvent(new Event('md-editor-refresh', { bubbles: true }));
                return;
            }
            textarea.dataset.mdEditorAttached = "true";

            const renderPreview = options.renderPreview || (() => Promise.resolve(''));
            let currentRequestId = 0;
            let renderTimeout = null;

            // Capture initial states
            const originalScrollTop = textarea.scrollTop;
            const originalSelStart = textarea.selectionStart;
            const originalSelEnd = textarea.selectionEnd;

            // Create wrapper structures
            const shell = document.createElement('div');
            shell.className = `md-editor-shell view-${globalViewMode}`;

            const toolbar = document.createElement('div');
            toolbar.className = 'md-toolbar';

            const body = document.createElement('div');
            body.className = 'md-body';

            const preview = document.createElement('div');
            preview.className = 'md-live-preview markdown-body';

            // Insert shell into DOM around textarea
            textarea.parentNode.insertBefore(shell, textarea);
            shell.appendChild(toolbar);
            shell.appendChild(body);
            body.appendChild(textarea);
            body.appendChild(preview);

            // Restore scroll and selections
            textarea.scrollTop = originalScrollTop;
            textarea.setSelectionRange(originalSelStart, originalSelEnd);

            // Populate toolbar buttons
            const createBtn = (label, title, action) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'md-toolbar-btn';
                btn.title = title;
                btn.innerHTML = label;
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    action();
                    textarea.focus();
                });
                return btn;
            };

            const insertText = (before, after = '') => {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                const selected = text.substring(start, end);

                // Simple wrap/unwrap toggle logic
                if (before && after && selected.startsWith(before) && selected.endsWith(after)) {
                    // Unwrap
                    const unwrapped = selected.substring(before.length, selected.length - after.length);
                    textarea.value = text.substring(0, start) + unwrapped + text.substring(end);
                    textarea.setSelectionRange(start, start + unwrapped.length);
                } else {
                    // Wrap
                    const replacement = before + selected + after;
                    textarea.value = text.substring(0, start) + replacement + text.substring(end);
                    textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
                }

                // Dispatch synthetic input event so page controllers detect change
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            };

            const toggleLinePrefix = (prefix) => {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                
                // Find start and end of selected lines
                let lineStart = text.lastIndexOf('\n', start - 1) + 1;
                let lineEnd = text.indexOf('\n', end);
                if (lineEnd === -1) lineEnd = text.length;

                const selectedBlock = text.substring(lineStart, lineEnd);
                const lines = selectedBlock.split('\n');

                const allHavePrefix = lines.every(line => line.startsWith(prefix));
                const newLines = lines.map(line => {
                    if (allHavePrefix) {
                        return line.substring(prefix.length);
                    } else {
                        // If it has some other list prefix, we might want to replace it, but simple toggle is fine
                        return prefix + line;
                    }
                });

                const replacement = newLines.join('\n');
                textarea.value = text.substring(0, lineStart) + replacement + text.substring(lineEnd);
                textarea.setSelectionRange(lineStart, lineStart + replacement.length);
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            };

            // Insert a link — no modal dialog (prompt() is a silent no-op in VS Code webviews)
            // If selection looks like a URL, put it in the paren with empty link text.
            // Otherwise, selection becomes link text with a placeholder URL.
            const insertLink = () => {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                const selected = text.substring(start, end);
                if (selected.startsWith('http://') || selected.startsWith('https://')) {
                    textarea.value = text.substring(0, start) + `[](${selected})` + text.substring(end);
                    textarea.setSelectionRange(start + 1, start + 1);
                } else {
                    textarea.value = text.substring(0, start) + `[${selected}](https://)` + text.substring(end);
                    const urlStart = start + selected.length + 3;
                    textarea.setSelectionRange(urlStart, urlStart + 8);
                }
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            };

            // Bold & Italic shortcuts
            textarea.addEventListener('keydown', (e) => {
                const isMeta = e.ctrlKey || e.metaKey;
                if (isMeta && e.key === 'b') {
                    e.preventDefault();
                    insertText('**', '**');
                } else if (isMeta && e.key === 'i') {
                    e.preventDefault();
                    insertText('*', '*');
                } else if (isMeta && e.key === 'k') {
                    e.preventDefault();
                    insertLink();
                }
            });

            // Add standard actions
            toolbar.appendChild(createBtn('<b>B</b>', 'Bold (Ctrl+B)', () => insertText('**', '**')));
            toolbar.appendChild(createBtn('<i>I</i>', 'Italic (Ctrl+I)', () => insertText('*', '*')));
            
            toolbar.appendChild(createBtn('H1', 'Heading 1', () => toggleLinePrefix('# ')));
            toolbar.appendChild(createBtn('H2', 'Heading 2', () => toggleLinePrefix('## ')));
            toolbar.appendChild(createBtn('H3', 'Heading 3', () => toggleLinePrefix('### ')));

            const sep1 = document.createElement('div');
            sep1.className = 'md-toolbar-separator';
            toolbar.appendChild(sep1);

            toolbar.appendChild(createBtn('•', 'Bullet List', () => toggleLinePrefix('- ')));
            toolbar.appendChild(createBtn('1.', 'Numbered List', () => toggleLinePrefix('1. ')));
            toolbar.appendChild(createBtn('[ ]', 'Checkbox List', () => toggleLinePrefix('- [ ] ')));
            toolbar.appendChild(createBtn('“', 'Blockquote', () => toggleLinePrefix('> ')));

            const sep2 = document.createElement('div');
            sep2.className = 'md-toolbar-separator';
            toolbar.appendChild(sep2);

            toolbar.appendChild(createBtn('<code>', 'Inline Code', () => insertText('`', '`')));
            toolbar.appendChild(createBtn('<code-block>', 'Code Block', () => insertText('```\n', '\n```')));
            toolbar.appendChild(createBtn('🔗', 'Link (Ctrl+K)', () => insertLink()));

            // Table picker popover button
            const pickerContainer = document.createElement('div');
            pickerContainer.className = 'md-table-picker-container';
            const tableBtn = createBtn('📅', 'Insert Table', () => {
                popover.classList.toggle('show');
            });
            pickerContainer.appendChild(tableBtn);

            const popover = document.createElement('div');
            popover.className = 'md-table-popover';
            
            const grid = document.createElement('div');
            grid.className = 'md-table-grid';
            grid.style.gridTemplateColumns = 'repeat(5, 14px)';
            
            const title = document.createElement('div');
            title.className = 'md-table-picker-title';
            title.innerText = '0 x 0';

            const cells = [];
            for (let r = 0; r < 5; r++) {
                for (let c = 0; c < 5; c++) {
                    const cell = document.createElement('div');
                    cell.className = 'md-table-cell';
                    cell.dataset.row = r + 1;
                    cell.dataset.col = c + 1;
                    
                    cell.addEventListener('mouseover', () => {
                        const targetRow = r + 1;
                        const targetCol = c + 1;
                        title.innerText = `${targetRow} x ${targetCol}`;
                        cells.forEach(item => {
                            const itemRow = parseInt(item.dataset.row);
                            const itemCol = parseInt(item.dataset.col);
                            if (itemRow <= targetRow && itemCol <= targetCol) {
                                item.classList.add('highlighted');
                            } else {
                                item.classList.remove('highlighted');
                            }
                        });
                    });

                    cell.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const targetRow = r + 1;
                        const targetCol = c + 1;
                        
                        // Build GFM table skeleton
                        let markdown = '\n';
                        // Header row
                        markdown += '| ' + Array.from({ length: targetCol }, (_, i) => `Header ${i + 1}`).join(' | ') + ' |\n';
                        // Separator row
                        markdown += '| ' + Array.from({ length: targetCol }, () => '---').join(' | ') + ' |\n';
                        // Data rows
                        for (let ri = 0; ri < targetRow; ri++) {
                            markdown += '| ' + Array.from({ length: targetCol }, () => ' ').join(' | ') + ' |\n';
                        }
                        
                        insertText(markdown);
                        popover.classList.remove('show');
                        textarea.focus();
                    });

                    grid.appendChild(cell);
                    cells.push(cell);
                }
            }

            // Close popover when clicking outside
            document.addEventListener('click', (e) => {
                if (!pickerContainer.contains(e.target)) {
                    popover.classList.remove('show');
                }
            });

            popover.appendChild(grid);
            popover.appendChild(title);
            pickerContainer.appendChild(popover);
            toolbar.appendChild(pickerContainer);

            // View toggle
            const viewToggle = document.createElement('div');
            viewToggle.className = 'md-view-toggle';
            
            const btnSplit = document.createElement('button');
            btnSplit.type = 'button';
            btnSplit.className = `md-toggle-btn ${globalViewMode === 'split' ? 'active' : ''}`;
            btnSplit.innerText = 'Split';

            const btnEdit = document.createElement('button');
            btnEdit.type = 'button';
            btnEdit.className = `md-toggle-btn ${globalViewMode === 'edit' ? 'active' : ''}`;
            btnEdit.innerText = 'Edit';

            const btnPreview = document.createElement('button');
            btnPreview.type = 'button';
            btnPreview.className = `md-toggle-btn ${globalViewMode === 'preview' ? 'active' : ''}`;
            btnPreview.innerText = 'Preview';

            const updateViewClasses = (mode) => {
                globalViewMode = mode;
                shell.className = `md-editor-shell view-${mode}`;
                btnSplit.className = `md-toggle-btn ${mode === 'split' ? 'active' : ''}`;
                btnEdit.className = `md-toggle-btn ${mode === 'edit' ? 'active' : ''}`;
                btnPreview.className = `md-toggle-btn ${mode === 'preview' ? 'active' : ''}`;
                if (mode !== 'edit') {
                    triggerRender();
                }
            };

            btnSplit.addEventListener('click', () => updateViewClasses('split'));
            btnEdit.addEventListener('click', () => updateViewClasses('edit'));
            btnPreview.addEventListener('click', () => updateViewClasses('preview'));

            viewToggle.appendChild(btnSplit);
            viewToggle.appendChild(btnEdit);
            viewToggle.appendChild(btnPreview);
            toolbar.appendChild(viewToggle);

            // Rendering live preview
            const triggerRender = () => {
                const content = textarea.value;
                if (content.length > 30000) {
                    preview.innerHTML = '<div class="md-preview-placeholder">Live preview paused (large doc)</div>';
                    // Force edit mode if currently showing a preview
                    if (globalViewMode !== 'edit') {
                        updateViewClasses('edit');
                    }
                    return;
                }

                if (!content.trim()) {
                    preview.innerHTML = '<div class="md-preview-placeholder">Nothing to preview</div>';
                    return;
                }

                const reqId = ++currentRequestId;
                renderPreview(content).then(html => {
                    if (reqId === currentRequestId) {
                        preview.innerHTML = html || '<div class="md-preview-placeholder">Nothing to preview</div>';
                    }
                }).catch(err => {
                    if (reqId === currentRequestId) {
                        preview.innerHTML = `<div class="md-preview-placeholder">Render error: ${err}</div>`;
                    }
                });
            };

            textarea.addEventListener('input', () => {
                if (renderTimeout) clearTimeout(renderTimeout);
                renderTimeout = setTimeout(triggerRender, 200);
            });

            // Re-render when re-attach is called (e.g. re-entering edit mode with new content)
            textarea.addEventListener('md-editor-refresh', () => {
                if (renderTimeout) clearTimeout(renderTimeout);
                triggerRender();
            });

            // Initial render
            if (globalViewMode !== 'edit') {
                triggerRender();
            }
        }
    };
})();
