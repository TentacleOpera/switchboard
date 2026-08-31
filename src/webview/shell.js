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

    // ── Right-hand agent dock element refs ───────────────────────────
    // The dock is a third flex child beside #content, hosting one live agent
    // terminal via /terminals?solo=&dock=1. All visibility is class-driven
    // (.is-open / .is-visible), never [hidden] alone — see shell.html's
    // dock CSS comment for the cascade reason.
    const dockEl = document.getElementById('agent-dock');
    const splitterEl = document.getElementById('dock-splitter');
    const dockFrame = document.getElementById('dock-frame');
    const dockKanbanFrame = document.getElementById('dock-kanban-frame');
    const dockTabAgentBtn = document.getElementById('dock-tab-agent');
    const dockTabKanbanBtn = document.getElementById('dock-tab-kanban');
    const dockTitleEl = document.getElementById('dock-title');
    const dockCloseBtn = document.getElementById('dock-close');
    const emptyEl = document.getElementById('dock-empty');
    const startBtn = document.getElementById('dock-start');
    const dockEmptyHint = document.getElementById('dock-empty-hint');

    const frames = new Map(); // id -> HTMLIFrameElement
    const icons = new Map();  // id -> HTMLButtonElement
    let activePanel = null;

    const modalPanels = new Set();   // manifest ids with presentation === 'modal'
    let openModalId = null;
    let modalReturnFocus = null;
    let modalHost = null, modalDialog = null;

    // ── Agent dock state + persistence (browser-local UI chrome) ──────
    // The dock hosts the controller singleton occupant. `seat` holds the
    // friendlyName the server returned and is treated as an opaque string.
    const DOCK_STATE_KEY = 'sb.agentDock';
    // 648 = 80 cols × 7.80px worst-case advance + 24px chrome. Default IS the
    // floor: this is a board-first cockpit, and 804px (100 cols) would leave a
    // 1280px laptop only 424px of board. See edge case 13.
    const DOCK_MIN = 648, DOCK_DEFAULT = 648, DOCK_MAX = 1100;
    const DOCK_MIN_CONTENT = 280;
    // Smallest viewport that fits rail + splitter + dock floor + board floor.
    // Below it the dock is disabled rather than shrunk — edge case 7.
    const DOCK_VIABLE_MIN = 48 + 4 + DOCK_MIN + DOCK_MIN_CONTENT; // 980

    let dockOpen = false;
    const dockRole = 'mission-control';
    let lastFleet = [];
    let lastAutobanArmed = false;

    function readDockState() {
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            return {
                open: s.open === true,
                width: clampDockWidth(Number(s.width) || DOCK_DEFAULT),
                seat: typeof s.seat === 'string' ? s.seat : null,
                activeTab: s.activeTab === 'kanban' ? 'kanban' : 'agent',
            };
        } catch { return { open: false, width: DOCK_DEFAULT, seat: null, activeTab: 'agent' }; }
    }
    function writeDockState(patch) {
        const next = { ...readDockState(), ...patch };
        try { localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
    }
    function clampDockWidth(px) {
        const max = Math.min(DOCK_MAX, window.innerWidth - 48 - 4 - DOCK_MIN_CONTENT);
        return Math.max(DOCK_MIN, Math.min(px, Math.max(DOCK_MIN, max)));
    }

    function ensureModalHost() {
        if (modalHost) { return modalHost; }
        modalHost = document.createElement('div');
        modalHost.id = 'modal-host';
        modalHost.setAttribute('role', 'dialog');
        modalHost.setAttribute('aria-modal', 'true');

        const backdrop = document.createElement('div');
        backdrop.id = 'modal-backdrop';
        backdrop.addEventListener('click', closeModal);
        modalHost.appendChild(backdrop);

        modalDialog = document.createElement('div');
        modalDialog.id = 'modal-dialog';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'modal-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        // data-tooltip, never .title — shell.js is asserted free of native title
        // tooltips (shell-terminal-strip.test.js:395); a native one would
        // double-fire beside the styled overlay.
        closeBtn.dataset.tooltip = 'Close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', closeModal);
        modalDialog.appendChild(closeBtn);

        modalHost.appendChild(modalDialog);
        content.appendChild(modalHost);
        return modalHost;
    }

    /** Show a modal panel over the current one. The frame is only UNHIDDEN: its
     *  document, its live WebSocket, its pending autosave debounce and any text
     *  the operator has typed all survive, exactly as they do when panels are
     *  switched. Nothing here may destroy or reload the frame. */
    function openModal(id) {
        const frame = frames.get(id);
        if (!frame) { return; }
        ensureModalHost();
        modalHost.classList.add('is-open');
        modalHost.setAttribute('aria-label', frame.getAttribute('aria-label') || id);
        openModalId = id;
        const icon = icons.get(id);
        if (icon) { icon.classList.add('is-active'); icon.setAttribute('aria-expanded', 'true'); }
        modalReturnFocus = icon || null;
        focusModalContent(frame);
    }

    function closeModal() {
        if (!openModalId) { return; }
        const icon = icons.get(openModalId);
        if (icon) { icon.classList.remove('is-active'); icon.setAttribute('aria-expanded', 'false'); }
        if (modalHost) { modalHost.classList.remove('is-open'); }
        openModalId = null;
        // No flush, no save, no postMessage on the way out: memo.js owns its own
        // debounced save and the frame is still alive to run it. Adding a second
        // writer here is exactly the two-writer hazard this design removes.
        if (modalReturnFocus) { try { modalReturnFocus.focus(); } catch { /* ignore */ } }
        modalReturnFocus = null;
    }

    function toggleModal(id) {
        if (openModalId === id) { closeModal(); } else { openModal(id); }
    }

    /** The frame is same-origin (frame-src 'self', /memo on this host), so the
     *  shell can listen inside it. Without this, Escape while typing in the memo
     *  textarea reaches nothing and the dialog feels stuck. */
    function wireModalFrameKeys(frame) {
        try {
            const doc = frame.contentDocument;
            if (!doc || doc.dataset && doc.dataset.sbModalKeys === '1') { return; }
            if (doc.documentElement && doc.documentElement.dataset.sbModalKeys === '1') { return; }
            doc.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { closeModal(); }
            });
            if (doc.documentElement) { doc.documentElement.dataset.sbModalKeys = '1'; }
        } catch { /* cross-origin or not yet loaded — retried on open */ }
    }

    function focusModalContent(frame) {
        wireModalFrameKeys(frame);
        try {
            const doc = frame.contentDocument;
            const ta = doc && doc.querySelector('textarea');
            if (ta) { ta.focus(); return; }
        } catch { /* ignore */ }
        try { frame.focus(); } catch { /* ignore */ }
    }

    function defaultPanelId(manifest) {
        return 'board';
    }

    function selectPanel(id) {
        if (!frames.has(id)) { return; }
        // A modal panel is never "the active panel" — it overlays one. Every
        // caller (rail click, hash deep-link, hashchange, the switchPanel bridge)
        // funnels through here, so intercepting at this single point is what
        // keeps them all correct.
        if (modalPanels.has(id)) { openModal(id); return; }
        closeModal();                       // navigating away dismisses the overlay
        activePanel = id;
        for (const [pid, frame] of frames) {
            if (modalPanels.has(pid)) { continue; }   // modal frames are shown by the host, not by is-active
            frame.classList.toggle('is-active', pid === id);
            // A document inside a display:none iframe is not rendered and gets no
            // rendering opportunities, so it cannot observe its own hiding — the
            // Terminals panel needs this to release its hold on the shared pty size
            // (see releaseSizeVote in terminals.js). Panels with no arm for this type
            // fall through their message chain and ignore it.
            try {
                frame.contentWindow?.postMessage(
                    { type: 'panelVisibility', visible: pid === id },
                    location.origin
                );
            } catch { /* frame not ready yet — its first fit reports a size anyway */ }
        }
        for (const [pid, icon] of icons) {
            if (modalPanels.has(pid)) { continue; }   // the modal icon lights only while its overlay is open
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
        // degenerate-window cosmetic case, accepted). Cluster buttons on the
        // right edge position to the left.
        let left;
        if (el.closest('#top-right-cluster')) {
            left = rect.left - tipRect.width - GAP;
        } else {
            left = rect.right + GAP;
            if (left + tipRect.width > viewportW - 4) {
                left = rect.left - tipRect.width - GAP;
            }
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

    /* ── Mission Control rail icon ─────────────────────────────────────────
       A UFO button at the top of #strip-terminals that lights (animated cyan
       lights) when a Mission Control session is active and dims when inactive.
       Lit click → REVEAL (navigate to the terminals panel and focus the
    /* Minimal transient message near the rail. Reuses the body-level
       tooltip-overlay positioning pattern but auto-dismisses. textContent
       only — never innerHTML. Declared as a function declaration so the
       click handler's forward reference is safe (hoisted). */
    function showStripToast(text) {
        let toast = document.getElementById('strip-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'strip-toast';
            toast.style.cssText = 'position:fixed; right:60px; bottom:12px; z-index:9999;'
                + 'padding:6px 10px; border-radius:4px; background:var(--bg-elev,#222);'
                + 'color:var(--text,#e0e0e0); font-size:11px; pointer-events:none;'
                + 'box-shadow:0 2px 8px rgba(0,0,0,0.4); transition:opacity 0.3s;';
            document.body.appendChild(toast);
        }
        toast.textContent = text;
        toast.style.opacity = '1';
        clearTimeout(toast._dismissTimer);
        toast._dismissTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
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
        btn.className = 'strip-icon strip-group-' + (panel.group || 'primary');
        btn.type = 'button';
        if (panel.presentation === 'modal') {
            btn.role = 'button';
            btn.setAttribute('aria-haspopup', 'dialog');
            btn.setAttribute('aria-expanded', 'false');
        } else {
            btn.role = 'tab';
        }
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
            if (panel.presentation === 'modal') {
                toggleModal(panel.id);
            } else {
                selectPanel(panel.id);
            }
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
        // The dock frames are NOT in `frames` (they are /terminals?solo=&dock=1
        // and /terminals?kanban=1&dock=1 iframes, not manifest panels), so
        // applyThemeToAll's loop above misses them — a live theme toggle would
        // leave the dock in the old palette until reload. Fan out explicitly.
        try {
            dockFrame?.contentWindow?.postMessage(
                { type: 'switchboardThemeChanged', theme: themeName }, '*');
        } catch { /* ignore */ }
        try {
            dockKanbanFrame?.contentWindow?.postMessage(
                { type: 'switchboardThemeChanged', theme: themeName }, '*');
        } catch { /* ignore */ }
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

    /* ══ Agent dock module ══════════════════════════════════════════════
       The dock hosts one live agent terminal beside #content, mirroring the
       right-sidebar agent-chat placement users know from agentic IDEs. It
       reuses /terminals?solo=&dock=1 as its iframe src — no new terminal
       renderer. Seats are adopt-if-present-else-create, keyed by a stable
       dock seat name; the friendlyName the server actually returned is
       persisted and treated as opaque (edge case 4). */

    const CONTROLLER_ROLES = new Set(['mission-control', 'project_manager']);
    function isControllerTerminal(t) {
        if (!t) { return false; }
        if (t.role && CONTROLLER_ROLES.has(t.role)) { return true; }
        if (t.name === 'Mission Control') { return true; }
        return false;
    }

    function dockSeatName() { return `dock-${dockRole}`; }

    function setDockActiveTab(tab) {
        const activeTab = tab === 'kanban' ? 'kanban' : 'agent';
        writeDockState({ activeTab });
        if (dockTabAgentBtn) {
            dockTabAgentBtn.classList.toggle('is-active', activeTab === 'agent');
            dockTabAgentBtn.setAttribute('aria-selected', String(activeTab === 'agent'));
        }
        if (dockTabKanbanBtn) {
            dockTabKanbanBtn.classList.toggle('is-active', activeTab === 'kanban');
            dockTabKanbanBtn.setAttribute('aria-selected', String(activeTab === 'kanban'));
        }
        if (activeTab === 'kanban') {
            dockFrame.classList.remove('is-visible');
            dockFrame.hidden = true;
            emptyEl.classList.remove('is-visible');
            emptyEl.hidden = true;
            mountDockKanbanFrame();
        } else {
            if (dockKanbanFrame) {
                dockKanbanFrame.classList.remove('is-visible');
                dockKanbanFrame.hidden = true;
            }
            syncDockSeat();
        }
    }

    function mountDockKanbanFrame() {
        if (!dockKanbanFrame) { return; }
        const url = '/terminals?kanban=1&dock=1';
        if (dockKanbanFrame.getAttribute('src') !== url) {
            dockKanbanFrame.src = url;
        }
        dockKanbanFrame.hidden = false;
        dockKanbanFrame.classList.add('is-visible');
        dockTitleEl.textContent = 'Kanban';
    }

    function setDockOpen(open) {
        dockOpen = !!open;
        dockEl.classList.toggle('is-open', dockOpen);
        splitterEl.classList.toggle('is-open', dockOpen);
        dockEl.hidden = !dockOpen;
        splitterEl.hidden = !dockOpen;
        const toggle = document.querySelector('.dock-toggle-btn');
        if (toggle) {
            toggle.classList.toggle('is-active', dockOpen);
            toggle.setAttribute('aria-expanded', String(dockOpen));
        }
        writeDockState({ open: dockOpen });
        if (dockOpen) {
            // Apply the persisted width BEFORE the frame gets a box, so the pty
            // is sized once. Without this the dock always reopens at the CSS
            // default and the saved width is write-only.
            const w = clampDockWidth(readDockState().width);
            dockEl.style.width = w + 'px';
            document.documentElement.style.setProperty('--dock-width', w + 'px');
            const state = readDockState();
            setDockActiveTab(state.activeTab);
        } else {
            document.documentElement.style.setProperty('--dock-width', '0px');
        }
    }

    // Seat resolution — adopt, never implicitly create. The fleet snapshot
    // (cached in lastFleet) is the only liveness oracle. `saved.seat` is the
    // friendlyName the SERVER returned, treated as opaque — PtyFleetService
    // drops the requested name entirely on collision and falls back to the
    // `<role>-N` series, so nothing may key on the `dock-` prefix.
    function syncDockSeat() {
        const saved = readDockState();
        if (saved.activeTab !== 'agent') { return; }
        if (saved.seat) {
            const liveSaved = lastFleet.find(t => t.name === saved.seat && t.light !== 'exited');
            if (liveSaved) {
                if (isControllerTerminal(liveSaved)) {
                    mountDockFrame(liveSaved.name);
                    return;
                } else {
                    // Non-controller persisted seat from picker era — discard it.
                    writeDockState({ seat: null });
                }
            }
        }
        const liveController = lastFleet.find(t => isControllerTerminal(t) && t.light !== 'exited');
        if (liveController) {
            mountDockFrame(liveController.name);
        } else {
            showDockEmptyState();
        }
    }

    function updateDockTitle(name) {
        if (readDockState().activeTab === 'kanban') {
            dockTitleEl.textContent = 'Kanban';
            return;
        }
        if (!name) { dockTitleEl.textContent = ''; return; }
        const status = lastAutobanArmed ? 'Armed' : 'Awaiting confirmation';
        dockTitleEl.textContent = `${name} — ${status}`;
    }

    function mountDockFrame(name) {
        const url = `/terminals?solo=${encodeURIComponent(name)}&dock=1`;
        if (dockFrame.getAttribute('src') !== url) { dockFrame.src = url; }
        dockFrame.hidden = false;
        dockFrame.classList.add('is-visible');
        emptyEl.hidden = true;
        emptyEl.classList.remove('is-visible');
        updateDockTitle(name);
        writeDockState({ seat: name });
    }

    function showDockEmptyState() {
        dockFrame.hidden = true;
        dockFrame.classList.remove('is-visible');
        emptyEl.hidden = false;
        emptyEl.classList.add('is-visible');
        startBtn.style.display = '';
        startBtn.textContent = 'Start Mission Control';
        dockEmptyHint.innerHTML = '';
        dockTitleEl.textContent = '';
    }

    function renderDockClipboardPrompt(promptText) {
        dockFrame.hidden = true;
        dockFrame.classList.remove('is-visible');
        emptyEl.hidden = false;
        emptyEl.classList.add('is-visible');
        startBtn.style.display = 'none';
        dockTitleEl.textContent = 'Mission Control (Clipboard)';
        dockEmptyHint.innerHTML = '';

        const msg = document.createElement('p');
        msg.textContent = 'No agent CLI configured. Copy the prompt below to run Mission Control:';
        msg.style.marginBottom = '8px';

        const box = document.createElement('div');
        box.style.cssText = 'background: var(--bg-elev); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-family: monospace; font-size: 11px; word-break: break-all; margin-bottom: 8px; text-align: left; max-height: 120px; overflow-y: auto; user-select: all;';
        box.textContent = promptText;

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'dock-start-btn';
        copyBtn.textContent = 'Copy Prompt';
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(promptText);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy Prompt'; }, 2000);
            } catch {
                copyBtn.textContent = 'Failed to copy';
            }
        });

        dockEmptyHint.appendChild(msg);
        dockEmptyHint.appendChild(box);
        dockEmptyHint.appendChild(copyBtn);
    }

    // Create on explicit click only — never implicitly on shell load (edge
    // case 4). Routes through /mission-control/start.
    async function startDockTerminal() {
        startBtn.disabled = true;
        try {
            const res = await fetch('/mission-control/start', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            if (res.status === 503) {
                dockEmptyHint.textContent = 'Mission Control is not available in this host.';
                return;
            }
            const data = await res.json();
            if (data && data.success !== false) {
                if (data.mode === 'clipboard') {
                    renderDockClipboardPrompt(data.prompt || data.message || 'Run /switchboard workflow to start Mission Control');
                } else {
                    const name = data.friendlyName || data.name || (data.terminal && data.terminal.friendlyName) || 'Mission Control';
                    mountDockFrame(name);
                }
            } else {
                dockEmptyHint.textContent = (data && data.error) || 'Could not start Mission Control.';
            }
        } catch (err) {
            dockEmptyHint.textContent = 'Could not reach the server.';
        } finally {
            startBtn.disabled = false;
        }
    }

    // Narrow-window gate (edge case 7). Below DOCK_VIABLE_MIN the dock is not
    // offered at all — the rail toggle renders disabled with a tooltip, and an
    // open dock auto-closes. The board keeps the full content area and is
    // never squeezed to 200px. The dock does NOT reopen by itself (closing was
    // a forced action, not a user preference — leave open:false written).
    function updateDockViableGating() {
        const toggle = document.querySelector('.dock-toggle-btn');
        if (!toggle) { return; }
        const viable = window.innerWidth >= DOCK_VIABLE_MIN;
        toggle.disabled = !viable;
        toggle.dataset.tooltip = viable
            ? 'Agent Dock'
            : 'Window too narrow for the agent dock (needs 980px)';
        if (!viable && dockOpen) {
            setDockOpen(false);
        }
    }

    // Splitter drag with pointer capture. Dragging a splitter over an iframe
    // loses mousemove to the frame's document, so body.dock-dragging makes
    // both .panel-frame and #dock-frame pointer-inert for the duration
    // (edge case 6). setPointerCapture keeps the events on the splitter.
    if (splitterEl) {
        splitterEl.addEventListener('pointerdown', (e) => {
            splitterEl.setPointerCapture(e.pointerId);
            splitterEl.classList.add('is-dragging');
            document.body.classList.add('dock-dragging');
            const startX = e.clientX, startW = dockEl.getBoundingClientRect().width;
            const onMove = (ev) => {
                const w = clampDockWidth(startW + (startX - ev.clientX));
                dockEl.style.width = w + 'px';
                document.documentElement.style.setProperty('--dock-width', w + 'px');
            };
            const onUp = (ev) => {
                splitterEl.releasePointerCapture(ev.pointerId);
                splitterEl.classList.remove('is-dragging');
                document.body.classList.remove('dock-dragging');
                splitterEl.removeEventListener('pointermove', onMove);
                splitterEl.removeEventListener('pointerup', onUp);
                writeDockState({ width: dockEl.getBoundingClientRect().width });
            };
            splitterEl.addEventListener('pointermove', onMove);
            splitterEl.addEventListener('pointerup', onUp);
        });
    }

    // Re-clamp on resize so a narrowed window does not strand the board at
    // 0px with no way back. #content is safe from min-content pressure: every
    // .panel-frame is position:absolute, so absolutely-positioned children
    // contribute nothing to #content's min-content size and it can shrink
    // freely (edge case 7).
    window.addEventListener('resize', () => {
        updateDockViableGating();
        if (!dockOpen) { return; }
        const w = clampDockWidth(dockEl.getBoundingClientRect().width);
        dockEl.style.width = w + 'px';
        document.documentElement.style.setProperty('--dock-width', w + 'px');
    });

    // Dock close button.
    if (dockCloseBtn) {
        dockCloseBtn.addEventListener('click', () => setDockOpen(false));
    }

    // Start button — the ONLY create path (edge case 4).
    if (startBtn) {
        startBtn.addEventListener('click', startDockTerminal);
    }

    // Dock tab buttons.
    if (dockTabAgentBtn) {
        dockTabAgentBtn.addEventListener('click', () => setDockActiveTab('agent'));
    }
    if (dockTabKanbanBtn) {
        dockTabKanbanBtn.addEventListener('click', () => setDockActiveTab('kanban'));
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
        const coldIcons = strip.querySelectorAll('.strip-group-cold');
        for (const el of coldIcons) {
            el.style.marginTop = '';
            el.classList.remove('is-cold-first');
        }
        if (coldIcons.length > 0) {
            if (container) { container.style.marginTop = '0'; }
            coldIcons[0].style.marginTop = 'auto';
            // The divider above the cold group. CSS cannot select "first cold
            // icon" — :first-of-type is per element TYPE, and every rail icon is
            // a <button> — so the class is applied here, beside the anchor.
            coldIcons[0].classList.add('is-cold-first');
        } else if (container) {
            container.style.marginTop = '';
        }
    }

    function renderTerminalSection(terminals, teams) {
        // A fleet-state push rebuilds every terminal button (innerHTML = ''
        // below). If the hovered button is removed mid-hover, no mouseout ever
        // fires and the overlay strands beside empty space — hide it first.
        hideStripTooltip();
        let container = document.getElementById('strip-terminals');

        if (!frames.has('terminals')) {
            if (container) {
                container.remove();
            }
            applyBottomAnchor();
            return;
        }

        if (!container) {
            container = document.createElement('div');
            container.id = 'strip-terminals';
            container.role = 'group';
            container.setAttribute('aria-label', 'Fleet terminals');
            const firstCold = strip.querySelector('.strip-group-cold');
            if (firstCold) {
                strip.insertBefore(container, firstCold);
            } else {
                strip.appendChild(container);
            }
        }
        applyBottomAnchor();

        // Rebuild only the fleet team buttons.
        for (const child of Array.from(container.querySelectorAll(':scope > .strip-term-btn, :scope > .strip-team-btn'))) {
            child.remove();
        }

        // ── Teams mode (the only mode) ───────────────────────────────
        // Exactly three fixed slots (in stable definition order from the panel).
        const teamsArr = Array.isArray(teams) ? teams : [];

        for (const team of teamsArr) {
            const btn = document.createElement('button');
            // The dispatched indicator is an informational UI signal only.
            // Nothing in the client may use it to gate dispatches; the server's 409
            // remains the sole authority.
            const isDispatched = Boolean(team.running && team.dispatched);
            btn.className = 'strip-icon strip-team-btn'
                + (team.running ? '' : ' is-dormant')
                + (isDispatched ? ' is-dispatched' : '');
            btn.type = 'button';

            btn.setAttribute('aria-label', team.name);
            btn.dataset.tooltip = team.name;

            // Two-deep icon fallback: team icon → head's role letter. The
            // rail is the primary navigation surface and must never render
            // an empty button. The head's CLI brand mark is NOT a valid
            // fallback for a team button — it communicates the wrong identity.
            if (team.iconUri) {
                const icon = document.createElement('img');
                icon.className = 'strip-term-icon strip-team-icon pixel-art';
                icon.src = team.iconUri;
                icon.alt = '';
                btn.appendChild(icon);
            } else {
                const headTerm = (Array.isArray(terminals) ? terminals : []).find(t => t.name === team.head);
                const roleChar = (team.headRole || (headTerm && headTerm.role) || 'T').charAt(0).toUpperCase();
                const glyph = document.createElement('span');
                glyph.className = 'strip-team-icon';
                glyph.textContent = roleChar;
                btn.appendChild(glyph);
            }

            btn.addEventListener('click', async () => {
                if (team.running && !team.groupId && team.head) {
                    // A member-less team registers no terminals.groups row
                    // (wireSpawnedTeam returns early with no children), so there is
                    // no team scope to switch into — the head IS the team. Focus it.
                    selectPanel('terminals');
                    const termFrame = frames.get('terminals');
                    if (termFrame && termFrame.contentWindow) {
                        try {
                            termFrame.contentWindow.postMessage({
                                type: 'focusTerminal',
                                name: team.head
                            }, location.origin);
                        } catch { /* ignore */ }
                    }
                } else if (team.running && team.groupId) {
                    // Switch the main terminals panel to team-scoped mode in-place.
                    // No pop-out window — the team view replaces the fleet view
                    // inside the existing panel, with a back button to return.
                    selectPanel('terminals');
                    const termFrame = frames.get('terminals');
                    if (termFrame && termFrame.contentWindow) {
                        try {
                            termFrame.contentWindow.postMessage({
                                type: 'switchToTeam',
                                groupId: team.groupId
                            }, location.origin);
                        } catch { /* ignore */ }
                    }
                } else {
                    // Absent slot: start that team. Reuses the Agent Control
                    // panel's ptyStartTeam path. Disable the button while pending.
                    btn.disabled = true;
                    try {
                        const res = await fetch('/terminals/verb/ptyStartTeam', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ teamId: team.definitionId })
                        });
                        let data = null;
                        try { data = await res.json(); } catch { /* ignore */ }
                        if (!data || data.success === false) {
                            const msg = (data && data.error) || 'Failed to start team';
                            showStripToast(msg);
                        }
                    } catch (err) {
                        showStripToast('Failed to start team: ' + (err?.message || err));
                    } finally {
                        btn.disabled = false;
                    }
                }
            });

            container.appendChild(btn);
        }
    }

    function requestFleetState() {
        const termFrame = frames.get('terminals');
        if (termFrame && termFrame.contentWindow) {
            try {
                termFrame.contentWindow.postMessage({ type: 'requestFleetState' }, location.origin);
            } catch { /* ignore */ }
        }
    }

    function renderTopRightCluster(manifest) {
        const cluster = document.getElementById('top-right-cluster');
        if (!cluster) { return; }
        cluster.innerHTML = '';

        // 1. Agent Dock toggle button
        const dockBtn = document.createElement('button');
        dockBtn.className = 'strip-icon dock-toggle-btn';
        dockBtn.type = 'button';
        dockBtn.setAttribute('aria-label', 'Agent Dock');
        dockBtn.dataset.tooltip = 'Agent Dock';
        dockBtn.setAttribute('aria-expanded', 'false');
        dockBtn.appendChild(buildMaskedGlyph('/static/icons/nav-dock.svg'));
        dockBtn.addEventListener('click', () => setDockOpen(!dockOpen));
        if (!frames.has('terminals')) {
            dockBtn.disabled = true;
        }
        cluster.appendChild(dockBtn);

        // 2. Setup, 3. Memo, 4. Connections
        const clusterIds = ['setup', 'memo', 'connections'];
        for (const id of clusterIds) {
            const panel = manifest.find(p => p.id === id);
            // Same rule as the rail: a panel this host did not enable is OMITTED,
            // not synthesised. renderManifest builds no frame for it, so a
            // fabricated cluster button would selectPanel() into nothing — the
            // dead control the rail's own omission exists to prevent.
            if (!panel || panel.enabled === false) { continue; }
            const btn = buildIcon(panel);
            btn.className = 'strip-icon';
            icons.set(id, btn);
            cluster.appendChild(btn);
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

        const primaryIcons = [];
        const coldIcons = [];
        for (const panel of manifest) {
            // A panel the host did not enable is OMITTED, not greyed out. `enabled`
            // reflects a capability this host does not have at all (e.g. Terminals
            // exists only in standalone, and only when node-pty loaded), so a
            // disabled icon is a dead control the user can never turn on — it just
            // reads as "broken". Panels that are merely empty stay enabled.
            if (panel.enabled === false) { continue; }
            const frame = buildFrame(panel);
            frames.set(panel.id, frame);
            if (panel.presentation === 'modal') {
                modalPanels.add(panel.id);
                frame.className = 'modal-frame';
                frame.addEventListener('load', () => wireModalFrameKeys(frame));
                ensureModalHost();
                modalDialog.appendChild(frame);
            } else {
                content.appendChild(frame);
            }

            if (panel.railHidden) { continue; }

            const icon = buildIcon(panel);
            icons.set(panel.id, icon);
            if (panel.group === 'cold') {
                coldIcons.push(icon);
            } else {
                primaryIcons.push(icon);
            }
        }

        for (const icon of primaryIcons) { strip.appendChild(icon); }

        let container = document.getElementById('strip-terminals');
        if (!container) {
            container = document.createElement('div');
            container.id = 'strip-terminals';
            container.role = 'group';
            container.setAttribute('aria-label', 'Fleet terminals');
        }
        strip.appendChild(container);

        for (const icon of coldIcons) { strip.appendChild(icon); }

        renderTerminalSection([]);
        renderTopRightCluster(manifest);

        // Dock boot: restore the dock if it was left open across a reload.
        // Only when the host has a Terminals panel — the same gate the toggle
        // itself makes. Also apply the narrow-window viability gate on first paint.
        if (frames.has('terminals')) {
            updateDockViableGating();
            if (readDockState().open && window.innerWidth >= DOCK_VIABLE_MIN) {
                setDockOpen(true);
            }
        }

        // Ask the terminals iframe for its fleet state once it's loaded. The iframe's
        // own postFleetStateToShell runs on init and on a 5s poll, but a transient
        // fetch failure in the iframe can leave the rail dark. This request ensures
        // the shell gets fleet state even if the iframe's initial push was lost or
        // sent before the shell's message listener was ready.
        const termFrame = frames.get('terminals');
        if (termFrame) {
            termFrame.addEventListener('load', () => {
                setTimeout(requestFleetState, 500);
            });
        }

        const hash = window.location.hash.replace(/^#/, '');
        if (hash && modalPanels.has(hash)) {
            const base = defaultPanelId(manifest);
            if (base) { selectPanel(base); }
            openModal(hash);
        } else {
            const initial = (hash && frames.has(hash)) ? hash : defaultPanelId(manifest);
            if (initial) { selectPanel(initial); }
        }
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
        } else if (data.type === 'missionControlArmed' && typeof data.armed === 'boolean') {
            // Relayed by the Terminals panel: the shell has no WebSocket, so the
            // autoban broadcast rail (autobanStateSync / updateAutobanConfig) is
            // not audible here. Without the relay this stayed false forever and the
            // dock title read "Awaiting confirmation" for an armed session.
            if (event.origin !== location.origin) { return; }
            lastAutobanArmed = data.armed;
            const saved = readDockState();
            if (saved.seat && saved.activeTab === 'agent' && dockFrame.classList.contains('is-visible')) {
                updateDockTitle(saved.seat);
            }
        } else if (data.type === 'terminalFleetState' && Array.isArray(data.terminals)) {
            if (event.origin !== location.origin) { return; }
            // Cache the fleet snapshot as the dock's liveness oracle. The dock
            // treats the friendlyName as opaque (edge case 4) and uses this
            // cache to decide adopt-vs-empty-state on every push.
            lastFleet = data.terminals;
            renderTerminalSection(data.terminals, Array.isArray(data.teams) ? data.teams : []);
            // If the dock is open and active on the agent tab, re-sync the seat — a fleet push may report
            // the seat we just created, or report that a previously-live seat
            // has exited.
            if (dockOpen && readDockState().activeTab === 'agent') { syncDockSeat(); }
        } else if (data.type === 'popoutTerminal' && typeof data.name === 'string') {
            if (event.origin !== location.origin) { return; }
            const slug = data.name.replace(/[^A-Za-z0-9_-]/g, '_');
            const popoutName = `sb-term-${slug}`;
            const popoutUrl = `/terminals?solo=${encodeURIComponent(data.name)}`;
            const features = 'width=900,height=700';
            let popout = null;
            try {
                popout = window.open(popoutUrl, popoutName, features);
            } catch { /* ignore */ }
            if (popout && !popout.closed) {
                popoutWindows.add(popout);
            } else {
                const termFrame = frames.get('terminals');
                if (termFrame && termFrame.contentWindow) {
                    try {
                        termFrame.contentWindow.postMessage({ type: 'popoutBlocked', name: data.name }, location.origin);
                    } catch { /* ignore */ }
                }
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openModalId) { closeModal(); }
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

