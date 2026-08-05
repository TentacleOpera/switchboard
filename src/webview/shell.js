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

    /* ── Strip tooltip overlay ──────────────────────────────────────────
       Single body-level position:fixed overlay (a right-placed port of
       kanban.html's tooltip system) — no ancestor overflow can clip it, which
       is the whole point: #strip and #strip-terminals both clip, and that clip
       is load-bearing (the rail scrolls). Text goes through textContent, never
       innerHTML. */
    const tooltipOverlay = document.getElementById('tooltip-overlay');
    let tooltipTarget = null;

    function showStripTooltip(el) {
        if (!tooltipOverlay) { return; }
        const text = el.getAttribute('data-tooltip');
        if (!text) { return; }
        tooltipTarget = el;
        tooltipOverlay.textContent = text;

        // Measure off-screen first — the text is variable width.
        tooltipOverlay.style.left = '-9999px';
        tooltipOverlay.style.top = '-9999px';
        tooltipOverlay.classList.add('visible');

        const rect = el.getBoundingClientRect();
        const tipRect = tooltipOverlay.getBoundingClientRect();
        const viewportW = document.documentElement.clientWidth;
        const viewportH = document.documentElement.clientHeight;
        const GAP = 6;

        // Horizontal: right of the icon; flip left when that would overflow the
        // viewport (in a 48px rail the flip lands over the icon itself — a
        // degenerate-window cosmetic case, accepted).
        let left = rect.right + GAP;
        if (left + tipRect.width > viewportW - 4) {
            left = rect.left - tipRect.width - GAP;
        }
        if (left < 4) { left = 4; }

        // Vertical: centred on the icon, clamped on-screen so buttons near the
        // top or bottom of a scrolled strip keep their tooltip fully visible.
        let top = rect.top + rect.height / 2 - tipRect.height / 2;
        if (top < 4) { top = 4; }
        if (top + tipRect.height > viewportH - 4) {
            top = viewportH - tipRect.height - 4;
        }

        tooltipOverlay.style.left = left + 'px';
        tooltipOverlay.style.top = top + 'px';
    }

    function hideStripTooltip() {
        if (!tooltipOverlay) { return; }
        tooltipOverlay.classList.remove('visible');
        tooltipOverlay.style.left = '-9999px';
        tooltipOverlay.style.top = '-9999px';
        tooltipTarget = null;
    }

    // Delegation via mouseover/mouseout (these bubble; mouseenter/mouseleave do
    // not). The relatedTarget containment check stops flicker when moving
    // between a button and its own glyph child.
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) { return; }
        if (el === tooltipTarget) { return; }
        hideStripTooltip();
        showStripTooltip(el);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) { return; }
        const related = e.relatedTarget;
        if (related && el.contains(related)) { return; }
        hideStripTooltip();
    });
    // A position:fixed tooltip does not follow a scrolling target — hide on any
    // scroll inside the rail (capture phase: scroll does not bubble) and on
    // click. The third strand case — renderTerminalSection wiping the hovered
    // button mid-hover so no mouseout ever fires — is handled inside
    // renderTerminalSection itself.
    document.addEventListener('scroll', (e) => {
        if (!tooltipTarget) { return; }
        const scroller = e.target;
        if (scroller === strip || (scroller instanceof Element && scroller.id === 'strip-terminals')) {
            hideStripTooltip();
        }
    }, true);
    document.addEventListener('click', hideStripTooltip);

    function buildIcon(panel) {
        const btn = document.createElement('button');
        btn.className = 'strip-icon' + (panel.placement === 'bottom' ? ' strip-placement-bottom' : '');
        btn.type = 'button';
        btn.role = 'tab';
        btn.dataset.panel = panel.id;
        btn.setAttribute('aria-label', panel.label || panel.id);
        // Tooltip for every manifest entry — a panel with no label gets its id
        // rather than silently none.
        btn.dataset.tooltip = panel.label || panel.id;
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
        btn.dataset.tooltip = 'Toggle Theme';
        btn.style.marginTop = 'auto';
        btn.appendChild(buildMaskedGlyph('/static/icons/nav-theme.svg'));

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

    /**
     * Hand the rail's bottom anchor to the FIRST member of the bottom cluster.
     *
     * The rail is a column flex box, so its free space collapses into whichever
     * child carries `margin-top: auto` — and everything BEFORE that child stays
     * packed with the top group. That is why appending the Setup icon ahead of
     * the anchor is not enough to move it: the icon lands directly under the
     * workspace panels with the gap below it, which is the opposite of "at the
     * bottom, next to the theme toggle".
     *
     * The cluster's composition changes at runtime (Setup can be disabled,
     * #strip-terminals appears and disappears with the Terminals panel), so the
     * anchor has to be reconciled rather than declared once. Exactly one member
     * may hold it: two auto margins SPLIT the free space and park the cluster
     * mid-rail. #strip-terminals owns the anchor in CSS, so it is neutralised
     * inline whenever something precedes it.
     */
    function applyBottomAnchor() {
        const container = document.getElementById('strip-terminals');
        const themeBtn = strip.querySelector('.theme-toggle-btn');
        const members = [
            ...strip.querySelectorAll('.strip-placement-bottom'),
            container,
            themeBtn
        ].filter(Boolean);
        if (members.length === 0) { return; }
        for (const el of members) {
            // '' restores the stylesheet value: 6px for a placement icon, auto for
            // #strip-terminals, nothing for the toggle (which owns its anchor inline).
            el.style.marginTop = '';
        }
        const first = members[0];
        if (container && container !== first) { container.style.marginTop = '0'; }
        if (first !== container) { first.style.marginTop = 'auto'; }
    }

    function renderTerminalSection(terminals) {
        // A fleet-state push rebuilds every terminal button (innerHTML = ''
        // below). If the hovered button is removed mid-hover, no mouseout ever
        // fires and the overlay strands beside empty space — hide it first.
        hideStripTooltip();
        let container = document.getElementById('strip-terminals');
        const themeBtn = document.querySelector('.theme-toggle-btn');

        if (!frames.has('terminals')) {
            if (container) {
                container.remove();
            }
            if (themeBtn) {
                themeBtn.style.marginTop = 'auto';
            }
            // The line above is the no-bottom-icons default; applyBottomAnchor then
            // moves the anchor onto the Setup icon when one is present, so the
            // cluster reads `Setup | Toggle Theme` at the foot of the rail.
            applyBottomAnchor();
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
        applyBottomAnchor();

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
            // Tooltip mirrors the accessible name (light state included) plus the
            // full worktree path on a second line — what the removed native
            // btn.title used to show, minus the double-tooltip asymmetry.
            btn.dataset.tooltip = t.worktreePath ? `${labelText}\n${t.worktreePath}` : labelText;

            const glyph = document.createElement('span');
            glyph.textContent = roleChar;
            btn.appendChild(glyph);

            const dot = document.createElement('span');
            dot.className = `strip-term-dot dot-${t.light}`;
            btn.appendChild(dot);

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

        const bottomPanels = [];
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
            content.appendChild(frame);
            // Frames are position-independent (display-toggled, keyed by id); only the
            // ICON's rail position depends on placement.
            if (panel.placement === 'bottom') { bottomPanels.push(icon); } else { strip.appendChild(icon); }
        }

        // Bottom cluster, in reading order: settings icons, then the fleet list, then
        // the theme toggle. The fleet container carries `margin-top: auto`, so anything
        // appended BEFORE it and AFTER the top group lands at the top of the bottom
        // cluster — which is what keeps Setup adjacent to the theme toggle even as the
        // fleet list grows toward its 40vh cap.
        for (const icon of bottomPanels) { strip.appendChild(icon); }

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

