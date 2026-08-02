/*
 * Switchboard headless app-shell — shell.js
 *
 * Renders the left icon strip from the /panels manifest and hosts each panel
 * as a same-origin iframe. All iframes are mounted up-front and toggled via
 * display; each panel keeps its state and its live WebSocket across switches
 * (instant switch, no reconnect).
 *
 * Deep-link: /#board, /#project, /#design, /#setup select a panel on load.
 * Cross-panel bridge: listens for postMessage {type:'switchPanel', panel}
 * from iframes and switches the active panel.
 */
(function () {
    'use strict';

    const strip = document.getElementById('strip');
    const content = document.getElementById('content');
    if (!strip || !content) { return; }

    const frames = new Map(); // id -> HTMLIFrameElement
    const icons = new Map();  // id -> HTMLButtonElement
    let activePanel = null;

    function defaultPanelId(manifest) {
        // First enabled panel in manifest order; Board is conventionally first.
        for (const p of manifest) {
            if (p.enabled !== false) { return p.id; }
        }
        return null;
    }

    function selectPanel(id) {
        if (!frames.has(id)) { return; }
        activePanel = id;
        for (const [pid, frame] of frames) {
            frame.classList.toggle('is-active', pid === id);
        }
        for (const [pid, icon] of icons) {
            icon.classList.toggle('is-active', pid === id);
        }
        if (window.location.hash !== '#' + id) {
            try { history.replaceState(null, '', '#' + id); } catch { /* ignore */ }
        }
    }

    function buildMaskedGlyph(iconUrl) {
        const glyph = document.createElement('span');
        glyph.className = 'strip-glyph';
        glyph.style.webkitMaskImage = 'url("' + iconUrl + '")';
        glyph.style.maskImage = 'url("' + iconUrl + '")';
        return glyph;
    }

    function buildIcon(panel) {
        const btn = document.createElement('button');
        btn.className = 'strip-icon';
        btn.type = 'button';
        btn.role = 'tab';
        btn.dataset.panel = panel.id;
        btn.setAttribute('aria-label', panel.label || panel.id);
        if (panel.enabled === false) { btn.disabled = true; }
        if (panel.icon && panel.icon.endsWith('.svg')) {
            // Single-color SVG: render via CSS mask + currentColor so the glyph
            // follows the strip's idle/hover/active colors (an <img> would stay
            // the file's baked-in fill).
            btn.appendChild(buildMaskedGlyph(panel.icon));
        } else if (panel.icon && (panel.icon.startsWith('/') || panel.icon.includes('.'))) {
            const img = document.createElement('img');
            img.src = panel.icon;
            img.alt = panel.label || panel.id;
            img.style.width = '20px';
            img.style.height = '20px';
            img.style.objectFit = 'contain';
            btn.appendChild(img);
        } else {
            const glyph = document.createElement('span');
            glyph.textContent = panel.icon || panel.id.charAt(0).toUpperCase();
            btn.appendChild(glyph);
        }
        if (panel.label) {
            const label = document.createElement('span');
            label.className = 'strip-label';
            label.textContent = panel.label;
            btn.appendChild(label);
        }
        btn.addEventListener('click', () => {
            if (panel.enabled === false) { return; }
            selectPanel(panel.id);
        });
        return btn;
    }

    function buildThemeToggle() {
        const btn = document.createElement('button');
        btn.className = 'strip-icon theme-toggle-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Toggle Theme');
        btn.style.marginTop = 'auto';
        btn.appendChild(buildMaskedGlyph('/static/icons/nav-theme.svg'));
        const label = document.createElement('span');
        label.className = 'strip-label';
        label.textContent = 'Toggle Theme';
        btn.appendChild(label);

        btn.addEventListener('click', async () => {
            const isClaudify = document.body.classList.contains('theme-claudify');
            const newTheme = isClaudify ? 'afterburner' : 'claudify';
            try {
                await fetch('/setup/verb/setThemeSetting', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ theme: newTheme })
                });
            } catch (err) {
                console.warn('[shell] Failed to persist theme change:', err);
            }
            applyThemeToAll(newTheme);
        });
        return btn;
    }

    const popoutWindows = new Set();

    function applyThemeToAll(themeName) {
        const isClaudify = themeName === 'claudify';
        if (isClaudify) {
            document.body.className = 'theme-claudify kanban-icons-colour';
        } else {
            document.body.className = 'cyber-theme-enabled';
        }
        for (const [_, frame] of frames) {
            try {
                frame.contentWindow?.postMessage({ type: 'switchboardThemeChanged', theme: themeName }, '*');
            } catch { /* ignore */ }
        }
        for (const win of Array.from(popoutWindows)) {
            if (win.closed) {
                popoutWindows.delete(win);
            } else {
                try {
                    win.postMessage({ type: 'switchboardThemeChanged', theme: themeName }, location.origin);
                } catch { /* ignore */ }
            }
        }
    }

    function buildFrame(panel) {
        const frame = document.createElement('iframe');
        frame.className = 'panel-frame';
        frame.dataset.panel = panel.id;
        frame.src = panel.route;
        frame.setAttribute('aria-label', panel.label || panel.id);
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        return frame;
    }

    function renderTerminalSection(terminals) {
        let container = document.getElementById('strip-terminals');
        const themeBtn = document.querySelector('.theme-toggle-btn');

        if (!frames.has('terminals')) {
            if (container) {
                container.remove();
            }
            if (themeBtn) {
                themeBtn.style.marginTop = 'auto';
            }
            return;
        }

        if (!container) {
            container = document.createElement('div');
            container.id = 'strip-terminals';
            container.role = 'group';
            container.setAttribute('aria-label', 'Fleet terminals');

            if (themeBtn) {
                strip.insertBefore(container, themeBtn);
                themeBtn.style.marginTop = '';
            } else {
                strip.appendChild(container);
            }
        }

        container.innerHTML = '';
        if (!Array.isArray(terminals) || terminals.length === 0) {
            return;
        }

        for (const t of terminals) {
            const btn = document.createElement('button');
            btn.className = 'strip-icon strip-term-btn';
            btn.type = 'button';

            const roleChar = (t.role || 'T').charAt(0).toUpperCase();
            let wtBase = 'Workspace Root';
            if (t.worktreePath) {
                const parts = t.worktreePath.replace(/\\/g, '/').split('/').filter(Boolean);
                wtBase = parts.length > 0 ? parts[parts.length - 1] : t.worktreePath;
            }

            const labelText = `${t.name} · ${t.role || 'Terminal'} · ${wtBase} [${t.light}]`;
            btn.setAttribute('aria-label', labelText);
            btn.title = t.worktreePath || t.name;

            const glyph = document.createElement('span');
            glyph.textContent = roleChar;
            btn.appendChild(glyph);

            const dot = document.createElement('span');
            dot.className = `strip-term-dot dot-${t.light}`;
            btn.appendChild(dot);

            const label = document.createElement('span');
            label.className = 'strip-label';
            label.textContent = `${t.name} · ${t.role || 'Terminal'} · ${wtBase}`;
            btn.appendChild(label);

            btn.addEventListener('click', () => {
                const slug = t.name.replace(/[^A-Za-z0-9_-]/g, '_');
                const popoutName = `sb-term-${slug}`;
                const popoutUrl = `/terminals?solo=${encodeURIComponent(t.name)}`;
                const features = 'width=900,height=700';

                let popout = null;
                try {
                    popout = window.open(popoutUrl, popoutName, features);
                } catch { /* ignore */ }

                const fallbackToInCockpit = () => {
                    selectPanel('terminals');
                    const termFrame = frames.get('terminals');
                    if (termFrame && termFrame.contentWindow) {
                        try {
                            termFrame.contentWindow.postMessage({
                                type: 'focusTerminal',
                                name: t.name
                            }, location.origin);
                        } catch { /* ignore */ }
                    }
                };

                if (!popout || popout.closed) {
                    fallbackToInCockpit();
                    return;
                }

                popoutWindows.add(popout);
                // Clicking a lit entry IS the acknowledgement — the user has now been
                // shown the terminal. The in-cockpit fallback clears the badge as a
                // side effect of `focusTerminal`; the pop-out path reaches no such
                // code, so without this the DONE light burns forever. Acknowledge-only:
                // popping out must not rearrange the cockpit's panes.
                const termFrame = frames.get('terminals');
                if (termFrame && termFrame.contentWindow) {
                    try {
                        termFrame.contentWindow.postMessage({
                            type: 'clearTerminalBadge',
                            name: t.name
                        }, location.origin);
                    } catch { /* ignore */ }
                }
                try { popout.focus(); } catch { /* ignore */ }

                setTimeout(() => {
                    try {
                        if (!popout.closed && !popout.document.hasFocus()) {
                            fallbackToInCockpit();
                        }
                    } catch {
                        // Throw treated as focused (do nothing)
                    }
                }, 100);
            });

            container.appendChild(btn);
        }
    }

    function renderManifest(manifest) {
        if (!Array.isArray(manifest) || manifest.length === 0) {
            const err = document.createElement('div');
            err.id = 'strip-error';
            err.textContent = 'No panels registered.';
            strip.appendChild(err);
            return;
        }
        for (const panel of manifest) {
            // A panel the host did not enable is OMITTED, not greyed out. `enabled`
            // reflects a capability this host does not have at all (e.g. Terminals
            // exists only in standalone, and only when node-pty loaded), so a
            // disabled icon is a dead control the user can never turn on — it just
            // reads as "broken". Panels that are merely empty stay enabled.
            if (panel.enabled === false) { continue; }
            const icon = buildIcon(panel);
            const frame = buildFrame(panel);
            icons.set(panel.id, icon);
            frames.set(panel.id, frame);
            strip.appendChild(icon);
            content.appendChild(frame);
        }

        const themeBtn = buildThemeToggle();
        strip.appendChild(themeBtn);

        renderTerminalSection([]);

        const hash = window.location.hash.replace(/^#/, '');
        const initial = (hash && frames.has(hash)) ? hash : defaultPanelId(manifest);
        if (initial) { selectPanel(initial); }
    }

    function loadManifest() {
        fetch('/panels', { credentials: 'same-origin' })
            .then(res => res.json())
            .then(data => {
                const manifest = Array.isArray(data) ? data : (data && Array.isArray(data.panels) ? data.panels : []);
                renderManifest(manifest);
            })
            .catch(err => {
                console.error('[shell] Failed to load /panels manifest:', err);
                const div = document.createElement('div');
                div.id = 'strip-error';
                div.textContent = 'Failed to load panels.';
                strip.appendChild(div);
            });
    }

    // Cross-panel bridge & theme sync
    window.addEventListener('message', (event) => {
        if (event.source === window) { return; }
        const data = event.data;
        if (!data || typeof data !== 'object') { return; }
        if (data.type === 'switchPanel' && typeof data.panel === 'string') {
            if (frames.has(data.panel)) {
                selectPanel(data.panel);
            }
        } else if (data.type === 'switchboardThemeChanged') {
            applyThemeToAll(data.theme);
        } else if (data.type === 'terminalFleetState' && Array.isArray(data.terminals)) {
            if (event.origin !== location.origin) { return; }
            renderTerminalSection(data.terminals);
        }
    });

    // Hash deep-link changes (bookmarkable panels).
    window.addEventListener('hashchange', () => {
        const hash = window.location.hash.replace(/^#/, '');
        if (hash && frames.has(hash) && hash !== activePanel) {
            selectPanel(hash);
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadManifest);
    } else {
        loadManifest();
    }
})();

