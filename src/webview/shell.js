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
    // The dock is one iframe pointing at /dock. The dock document owns its
    // tab strip, panes, seat lifecycle and fleet table; the shell owns only
    // open/closed, width, splitter and the minimum-width gate.
    const dockEl = document.getElementById('agent-dock');
    const splitterEl = document.getElementById('dock-splitter');
    const dockFrame = document.getElementById('dock-frame');

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

    function readDockState() {
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            // The shell owns `open` and `width`; the dock document owns
            // `activeTab` and `seat`. Both read/write the same key — each
            // writer only patches its own fields, so the merge is safe.
            return {
                open: s.open === true,
                width: clampDockWidth(Number(s.width) || DOCK_DEFAULT),
            };
        } catch { return { open: false, width: DOCK_DEFAULT }; }
    }
    function writeDockState(patch) {
        // Merge with the RAW stored state (not the shell's trimmed readDockState)
        // so the dock document's activeTab/seat fields are preserved across
        // shell writes.
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            const next = { ...s, ...patch };
            localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(next));
            return next;
        } catch { return patch; }
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
        // The dock frame is NOT in `frames` (it is a /dock iframe, not a
        // manifest panel), so applyThemeToAll's loop above misses it — a
        // live theme toggle would leave the dock in the old palette until
        // reload. Fan out explicitly to the dock iframe.
        try {
            dockFrame?.contentWindow?.postMessage(
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
       The dock is one iframe pointing at /dock. The dock document owns its
       tab strip (Agent / CLI / Fleet), its seat lifecycle, its terminal
       viewports and its fleet table. The shell owns only open/closed, width,
       the splitter and the minimum-width gate. */

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
            // Apply the persisted width BEFORE the frame gets a box, so the
            // pty is sized once. Without this the dock always reopens at the
            // CSS default and the saved width is write-only.
            const w = clampDockWidth(readDockState().width);
            dockEl.style.width = w + 'px';
            // Mount the single /dock iframe. The dock document handles the
            // rest — tab strip, seats, fleet, theme.
            if (dockFrame.getAttribute('src') !== '/dock') { dockFrame.src = '/dock'; }
            dockFrame.hidden = false;
            dockFrame.classList.add('is-visible');
        } else {
            // Hide the frame; the dock document keeps its state across
            // open/close cycles (same origin, same iframe — no reload).
            dockFrame.hidden = true;
            dockFrame.classList.remove('is-visible');
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
    });

    // Dock controls (close button, tab buttons, start/restart, CLI input,
    // fleet hops) all live in the dock document now — see dock.js. The shell
    // only listens for dockCloseRequested from the dock iframe.


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

            // ONE mark for every team. At 22px, four different pictures read as
            // noise rather than identity, so the rail uses the jet for all of
            // them and distinguishes teams by a single-letter initial in the
            // corner. The jet is a CSS-masked glyph painted with var(--accent),
            // so it follows the theme for free — cyan (#00f0ff) by default,
            // terracotta (#D97757) under theme-claudify.
            //
            // The jet is the DEFAULT, not the only option: the picker offers the
            // jet plus the CLI brand icons and nothing else, so an explicit pick
            // is always one of those two things. A brand icon renders as an <img>
            // and keeps its own brand colours; the jet is masked and takes the
            // accent. The head's CLI brand mark is still NOT auto-used as a team
            // mark — a team only shows a brand when someone chose it.
            // The jet is drawn as an <img>, NOT a CSS-masked glyph. A mask keeps only
            // the alpha channel, which flattens the afc-jet's three shading layers into
            // one silhouette — that is why the rail read as a blob rather than a plane.
            // team-<headRole>.svg is the same aircraft from the fleet-command art, with
            // its body/highlight/shadow intact and a colour per role.
            const ROLE_JETS = ['lead', 'coder', 'planner', 'reviewer', 'intern'];
            const icon = document.createElement('img');
            icon.className = 'strip-term-icon strip-team-icon pixel-art';
            const role = String(team.headRole || '').toLowerCase();
            icon.src = team.iconUri
                || '/static/icons/team-' + (ROLE_JETS.indexOf(role) >= 0 ? role : 'lead') + '.svg';
            icon.alt = '';
            btn.appendChild(icon);

            // Decorative: the button's aria-label already carries the full team
            // name, so a screen reader must not hear the letter twice.
            const initial = document.createElement('span');
            initial.className = 'strip-team-initial';
            initial.textContent = String(team.name || '?').trim().charAt(0).toUpperCase();
            initial.setAttribute('aria-hidden', 'true');
            btn.appendChild(initial);

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
        // Sub-fragment deep link (e.g. `setup:host`) — select the panel then
        // forward the sub-fragment so the panel activates its own sub-section.
        const colonIdx = hash.indexOf(':');
        const panelHash = colonIdx >= 0 ? hash.slice(0, colonIdx) : hash;
        const subFragment = colonIdx >= 0 ? hash.slice(colonIdx + 1) : '';
        if (panelHash && modalPanels.has(panelHash)) {
            const base = defaultPanelId(manifest);
            if (base) { selectPanel(base); }
            openModal(panelHash);
        } else {
            const initial = (panelHash && frames.has(panelHash)) ? panelHash : defaultPanelId(manifest);
            if (initial) { selectPanel(initial); }
        }
        if (subFragment && frames.has(panelHash)) {
            // Defer slightly so the target iframe has loaded before the message lands.
            setTimeout(() => {
                const frame = frames.get(panelHash);
                try {
                    frame.contentWindow?.postMessage(
                        { type: 'openSetupSection', section: subFragment },
                        location.origin
                    );
                } catch { /* frame not ready yet */ }
            }, 200);
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
            // Defect 3 fix (defense-in-depth): the dock guard on the SENDER
            // (transport.js) is the primary fix. This origin check is secondary
            // — the other three arms below already carry it, and switchPanel
            // was the only one without. The sender now posts with
            // location.origin rather than '*', but a frame the page hosts
            // could still reach this arm; the origin check bounds the surface
            // to same-origin senders.
            if (event.origin !== location.origin) { return; }
            if (frames.has(data.panel)) {
                selectPanel(data.panel);
            }
        } else if (data.type === 'switchboardThemeChanged') {
            applyThemeToAll(data.theme);
        } else if (data.type === 'dockCloseRequested') {
            // The dock document's close button asks the shell to close the
            // dock — the shell owns open/closed.
            if (event.origin !== location.origin) { return; }
            setDockOpen(false);
        } else if (data.type === 'terminalFleetState' && Array.isArray(data.terminals)) {
            if (event.origin !== location.origin) { return; }
            renderTerminalSection(data.terminals, Array.isArray(data.teams) ? data.teams : []);
            // The dock document handles its own seat sync on fleet pushes —
            // it has its own transport WS and hears the same broadcast.
        } else if (data.type === 'dockTerminalExited' && typeof data.name === 'string') {
            // The dock document's viewport posts this when a terminal exits.
            // Relay it back to the dock iframe so dock.js can show the restart
            // button and empty state immediately. The viewport posts to
            // window.parent (the shell) because its isDockFrame flag is true;
            // dock.js listens on its own window for this relay.
            if (event.origin !== location.origin) { return; }
            try {
                dockFrame?.contentWindow?.postMessage(
                    { type: 'dockTerminalExited', name: data.name }, location.origin);
            } catch { /* ignore */ }
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
    // A hash may carry a sub-fragment after a colon (e.g. `setup:host`) to
    // deep-link a tab inside a panel. The panel part selects the panel; the
    // sub-fragment is forwarded to the panel iframe as a postMessage so the
    // panel can activate its own sub-section (plan: settings-window-and-the-write-path-review-deleted).
    window.addEventListener('hashchange', () => {
        const hash = window.location.hash.replace(/^#/, '');
        if (!hash) return;
        const colonIdx = hash.indexOf(':');
        const panelId = colonIdx >= 0 ? hash.slice(0, colonIdx) : hash;
        const subFragment = colonIdx >= 0 ? hash.slice(colonIdx + 1) : '';
        if (frames.has(panelId) && panelId !== activePanel) {
            selectPanel(panelId);
        }
        if (subFragment && frames.has(panelId)) {
            const frame = frames.get(panelId);
            try {
                frame.contentWindow?.postMessage(
                    { type: 'openSetupSection', section: subFragment },
                    location.origin
                );
            } catch { /* frame not ready yet */ }
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadManifest);
    } else {
        loadManifest();
    }
})();

