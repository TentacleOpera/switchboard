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

    function buildIcon(panel) {
        const btn = document.createElement('button');
        btn.className = 'strip-icon';
        btn.type = 'button';
        btn.role = 'tab';
        btn.dataset.panel = panel.id;
        btn.setAttribute('aria-label', panel.label || panel.id);
        if (panel.enabled === false) { btn.disabled = true; }
        const glyph = document.createElement('span');
        glyph.textContent = panel.icon || panel.id.charAt(0).toUpperCase();
        btn.appendChild(glyph);
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

    function buildFrame(panel) {
        const frame = document.createElement('iframe');
        frame.className = 'panel-frame';
        frame.dataset.panel = panel.id;
        frame.src = panel.route;
        frame.setAttribute('aria-label', panel.label || panel.id);
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        return frame;
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
            if (panel.enabled === false) {
                // Render a disabled icon so the strip is honest about what's
                // configured-but-unavailable; never a dead button.
                const icon = buildIcon(panel);
                icons.set(panel.id, icon);
                strip.appendChild(icon);
                continue;
            }
            const icon = buildIcon(panel);
            const frame = buildFrame(panel);
            icons.set(panel.id, icon);
            frames.set(panel.id, frame);
            strip.appendChild(icon);
            content.appendChild(frame);
        }
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

    // Cross-panel bridge: iframes post {type:'switchPanel', panel} to switch.
    window.addEventListener('message', (event) => {
        if (event.source === window) { return; }
        const data = event.data;
        if (!data || typeof data !== 'object') { return; }
        if (data.type === 'switchPanel' && typeof data.panel === 'string') {
            if (frames.has(data.panel)) {
                selectPanel(data.panel);
            }
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
