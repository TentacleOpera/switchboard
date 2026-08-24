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
    const dockTitleEl = document.getElementById('dock-title');
    const dockRoleBtn = document.getElementById('dock-role-btn');
    const dockRoleMenu = document.getElementById('dock-role-menu');
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
    // The role is NOT stored here — it is a workspace-level setting (change 4),
    // so it follows the workspace across browsers. `seat` holds the friendlyName
    // the server returned and is treated as an opaque string (edge case 4).
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
    let dockRole = 'project_manager';   // replaced by the boot fetch in loadDockRole
    let lastFleet = [];
    // Cached ptyVisibleRoles response {visibleAgents, hasCommand} — fetched once
    // when the dock first opens, used to label the role picker and the empty state.
    let dockRolesCache = null;

    function readDockState() {
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            return {
                open: s.open === true,
                width: clampDockWidth(Number(s.width) || DOCK_DEFAULT),
                seat: typeof s.seat === 'string' ? s.seat : null,
            };
        } catch { return { open: false, width: DOCK_DEFAULT, seat: null }; }
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
        // First enabled, non-modal panel in manifest order; Board is conventionally first.
        for (const p of manifest) {
            if (p.enabled === false) { continue; }
            if (p.presentation === 'modal') { continue; }
            return p.id;
        }
        return null;
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

    /* ── Mission Control rail icon ─────────────────────────────────────────
       A UFO button at the top of #strip-terminals that lights (animated cyan
       lights) when a Mission Control session is active and dims when inactive.
       Lit click → REVEAL (navigate to the terminals panel and focus the
       controller terminal), matching every other button in the rail — team
       buttons switch the panel to team scope, ungrouped terminal buttons
       focus/peek. The rail is a row of navigational icons, and this one is no
       longer the exception: the destructive end-session control lives in the
       controller's own scoped ops block inside the terminals panel (see
       btn-controller-stop), where it can carry a label — the rail icon cannot.
       Dimmed click → POST /mission-control/start: the server decides — if a
       lead/coder agent is configured it creates a pty terminal and delivers
       the persona prompt (mode 'terminal'); otherwise it returns the
       /switchboard launcher text (mode 'clipboard') for the shell to copy.
       State arrives via `missionControlState` postMessages relayed from
       terminals.js (which gets autobanStateSync / updateAutobanConfig over the
       WS broadcast rail). */
    let missionControlActive = false;
    let missionControlSeat = null;
    // UI affordance for the dimmed-click /mission-control/start fetch. This is
    // NO LONGER THE GUARD against duplicate controllers — that guard now lives
    // in ptyFleetService.create(), which consults the singleton identity
    // before the collision loop and returns the existing live handle rather
    // than minting mission-control-2. The service guard is the one chokepoint
    // every path goes through (rail, panel, dock, standalone host), so a
    // client flag cannot be the protection and was never sufficient: two shell
    // tabs, a shell tab plus the extension panel, or a reload mid-flight all
    // defeated it. This flag now only disables the button while a start fetch
    // is pending, so a double-click does not fire two fetches — a UX nicety,
    // not a correctness gate. No confirmation dialog (CLAUDE.md).
    let missionControlStartInFlight = false;

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

    function createMissionControlIcon() {
        const btn = document.createElement('button');
        btn.id = 'strip-mission-control';
        btn.type = 'button';
        btn.className = 'mission-control-dimmed';
        btn.setAttribute('aria-label', 'Mission Control session');
        btn.dataset.tooltip = 'Mission Control: inactive — click to start';

        // Inline SVG (not an <img src>) so shell.html's CSS can select into the
        // icon's sub-elements — the dimmed freeze and reduced-motion rules are
        // inert when the SVG is a separate document. The SVG's internal <style>
        // block is dropped; all animation rules live in shell.html. ids are
        // prefixed (sb-mc-*) to avoid document-wide collisions now that they
        // are global. aria-hidden="true" + no role/aria-labelledby so the icon
        // does not double-announce beside the button's aria-label. Class names
        // on sub-elements (.ufo, .beam, .light-a, .light-b, .star-a, .star-b)
        // are kept — shell.html's selectors depend on them.
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" aria-hidden="true" shape-rendering="crispEdges" class="strip-mc-icon">'
            + '<defs>'
            + '<filter id="sb-mc-cyan-glow" x="-100%" y="-100%" width="300%" height="300%">'
            + '<feGaussianBlur stdDeviation="3" result="blur"/>'
            + '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>'
            + '</filter>'
            + '<linearGradient id="sb-mc-beam" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#00e5ff" stop-opacity=".22"/>'
            + '<stop offset="1" stop-color="#00e5ff" stop-opacity="0"/>'
            + '</linearGradient>'
            + '</defs>'
            + '<g fill="#00e5ff" filter="url(#sb-mc-cyan-glow)">'
            + '<rect class="star-a" x="40" y="36" width="4" height="4"/>'
            + '<rect class="star-b" x="268" y="54" width="4" height="4"/>'
            + '<rect class="star-b" x="74" y="126" width="3" height="3"/>'
            + '<rect class="star-a" x="248" y="132" width="3" height="3"/>'
            + '</g>'
            + '<g class="beam">'
            + '<path d="M128 104h64l32 68H96z" fill="url(#sb-mc-beam)"/>'
            + '<rect x="112" y="168" width="96" height="4" fill="#00e5ff" opacity=".16"/>'
            + '</g>'
            + '<g class="ufo">'
            + '<g filter="url(#sb-mc-cyan-glow)" opacity=".35" fill="#00e5ff">'
            + '<rect x="112" y="50" width="96" height="4"/>'
            + '<rect x="88" y="70" width="144" height="20"/>'
            + '<rect x="104" y="90" width="112" height="12"/>'
            + '</g>'
            + '<path d="M136 42h48v4h12v8h8v16h-88V54h8v-8h12z" fill="#1d2323"/>'
            + '<rect x="136" y="46" width="48" height="4" fill="#5e6666"/>'
            + '<rect x="124" y="54" width="72" height="16" fill="#363a3a"/>'
            + '<rect x="132" y="50" width="56" height="4" fill="#a0a6a6"/>'
            + '<rect x="136" y="54" width="48" height="12" fill="#0b0f0f"/>'
            + '<rect x="144" y="54" width="32" height="4" fill="#00363a"/>'
            + '<rect x="152" y="58" width="24" height="4" fill="#00e5ff" opacity=".55"/>'
            + '<rect x="104" y="66" width="112" height="4" fill="#5e6666"/>'
            + '<rect x="88" y="70" width="144" height="8" fill="#363a3a"/>'
            + '<rect x="72" y="78" width="176" height="12" fill="#1d2323"/>'
            + '<rect x="88" y="90" width="144" height="8" fill="#0b0f0f"/>'
            + '<rect x="104" y="98" width="112" height="4" fill="#363a3a"/>'
            + '<rect x="120" y="102" width="80" height="4" fill="#1d2323"/>'
            + '<rect x="72" y="82" width="16" height="4" fill="#5e6666"/>'
            + '<rect x="232" y="82" width="16" height="4" fill="#5e6666"/>'
            + '<g fill="#00e5ff" filter="url(#sb-mc-cyan-glow)">'
            + '<rect class="light-a" x="96" y="82" width="12" height="8"/>'
            + '<rect class="light-b" x="120" y="86" width="12" height="8"/>'
            + '<rect class="light-a" x="144" y="88" width="12" height="8"/>'
            + '<rect class="light-b" x="168" y="88" width="12" height="8"/>'
            + '<rect class="light-a" x="192" y="86" width="12" height="8"/>'
            + '<rect class="light-b" x="216" y="82" width="12" height="8"/>'
            + '</g>'
            + '<rect x="156" y="98" width="8" height="8" fill="#00e5ff" filter="url(#sb-mc-cyan-glow)"/>'
            + '</g>'
            + '</svg>';

        btn.addEventListener('click', () => {
            if (missionControlActive) {
                // Lit click → REVEAL, matching every other button in the rail.
                // Team buttons switch the panel to team scope; ungrouped
                // terminal buttons focus/peek. This one navigates to the
                // terminals panel and asks it to focus the controller terminal
                // (or enter controller scope). Purely navigational — no
                // /mission-control/stop is posted from any rail path. The
                // destructive end-session control lives in the controller's
                // own scoped ops block inside the terminals panel
                // (btn-controller-stop), where it can carry a label.
                selectPanel('terminals');
                const termFrame = frames.get('terminals');
                if (termFrame && termFrame.contentWindow) {
                    try {
                        termFrame.contentWindow.postMessage({
                            type: 'switchToController'
                        }, location.origin);
                    } catch { /* ignore */ }
                }
            } else {
                // Dimmed click: start Mission Control. The server decides the path
                // — terminal (agent configured) or clipboard fallback (no agent).
                // UI affordance only: disable the button while a start fetch is
                // pending so a double-click does not fire two fetches. This is
                // NOT the duplicate-controller guard — that lives in
                // ptyFleetService.create() now (see the flag's comment above).
                if (missionControlStartInFlight) { return; }
                missionControlStartInFlight = true;
                btn.disabled = true;
                btn.dataset.tooltip = 'Mission Control: starting…';
                fetch('/mission-control/start', { method: 'POST', credentials: 'same-origin' })
                    .then(res => res.json())
                    .then(result => {
                        if (result.success && result.mode === 'terminal') {
                            showStripToast('Mission Control started — check Mission Control terminal');
                        } else if (result.success && result.mode === 'clipboard') {
                            // No agent configured — copy the prompt to clipboard.
                            const text = result.prompt || 'Run /switchboard workflow to start Mission Control';
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(text).then(() => {
                                    showStripToast('Copied: ' + text);
                                }).catch(() => {
                                    showStripToast(text);
                                });
                            } else {
                                showStripToast(text);
                            }
                        } else {
                            showStripToast('Failed to start Mission Control: ' + (result.error || 'unknown'));
                        }
                        // Restore the inactive tooltip after the attempt resolves
                        // so a later hover is not stuck on 'starting…'.
                        btn.dataset.tooltip = 'Mission Control: inactive — click to start';
                    })
                    .catch(err => {
                        showStripToast('Failed to start Mission Control: ' + err.message);
                        btn.dataset.tooltip = 'Mission Control: inactive — click to start';
                    })
                    .finally(() => {
                        missionControlStartInFlight = false;
                        btn.disabled = false;
                    });
            }
        });

        // Insert as the first child of #strip-terminals. If the fleet container
        // does not exist yet, create it and position it before the bottom
        // cluster (settings/theme toggle) — mirroring renderTerminalSection's
        // container-creation logic so a later fleet push reuses the same
        // container instead of creating a second one.
        let container = document.getElementById('strip-terminals');
        if (!container) {
            container = document.createElement('div');
            container.id = 'strip-terminals';
            container.role = 'group';
            container.setAttribute('aria-label', 'Fleet terminals');
            const firstBottom = strip.querySelector('.strip-placement-bottom');
            const themeBtn = strip.querySelector('.theme-toggle-btn');
            if (firstBottom) {
                strip.insertBefore(container, firstBottom);
            } else if (themeBtn) {
                strip.insertBefore(container, themeBtn);
            } else {
                strip.appendChild(container);
            }
        }
        container.insertBefore(btn, container.firstChild);
        // The fleet container owns the bottom anchor in CSS; Mission Control
        // icon rides above it. Reconcile so the anchor stays on the container.
        applyBottomAnchor();
        return btn;
    }

    /* Ensure the Mission Control rail icon exists independently of any
       `missionControlState` postMessage. renderMissionControlIcon is the ONLY
       other creator and it only runs when a state message arrives — on a cold
       shell load with no autoban state change, NO icon would exist at all and
       the start control would be unreachable. This is called (a) once during
       shell init after the rail/manifest is built, and (b) at the END of
       renderTerminalSection in BOTH branches — including the early-return
       `!frames.has('terminals')` branch, which removes the container (and the
       icon with it). Idempotent: a no-op when the icon already exists. */
    function ensureMissionControlIcon() {
        if (document.getElementById('strip-mission-control')) { return; }
        createMissionControlIcon();
    }

    function renderMissionControlIcon(state) {
        missionControlActive = !!state.active;
        missionControlSeat = state.seat || null;
        // Only update classes/tooltip on an icon that already exists —
        // ensureMissionControlIcon() owns creation (init + renderTerminalSection).
        // Creating here would re-introduce the cold-load gap this function
        // cannot close: it only runs when a state message arrives.
        const icon = document.getElementById('strip-mission-control');
        if (!icon) { return; }
        if (!missionControlActive) {
            icon.classList.remove('mission-control-active');
            icon.classList.add('mission-control-dimmed');
            icon.dataset.tooltip = 'Mission Control: inactive — click to start';
            return;
        }
        icon.classList.remove('mission-control-dimmed');
        icon.classList.add('mission-control-active');
        const since = missionControlSeat && missionControlSeat.adoptedAt
            ? new Date(missionControlSeat.adoptedAt).toLocaleTimeString()
            : '';
        const where = missionControlSeat && missionControlSeat.terminalName
            ? ' on ' + missionControlSeat.terminalName : '';
        icon.dataset.tooltip = since
            ? 'Mission Control: active' + where + ' since ' + since + ' — click to reveal'
            : 'Mission Control: active — click to reveal';
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

    /* ── Agent dock: rail toggle ──────────────────────────────────────
       Carries `strip-placement-bottom`, so applyBottomAnchor() already
       treats it as a cluster member — strip.querySelectorAll('.strip-
       placement-bottom') picks it up with NO change to that function.
       Inserted in renderManifest BEFORE the Setup icon so the cluster
       reads Dock | Setup | Toggle Theme. The glyph is nav-dock.svg, NOT
       nav-terminals.svg — the Terminals panel already uses that glyph in
       the top group, and two identical icons with different actions is an
       unresolvable affordance (edge case 17). */
    function buildDockToggle() {
        const btn = document.createElement('button');
        btn.className = 'strip-icon strip-placement-bottom dock-toggle-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Agent Dock');
        btn.dataset.tooltip = 'Agent Dock';
        btn.setAttribute('aria-expanded', 'false');
        btn.appendChild(buildMaskedGlyph('/static/icons/nav-dock.svg'));
        btn.addEventListener('click', () => setDockOpen(!dockOpen));
        return btn;
    }

    const popoutWindows = new Set();

    // name -> { stamp, startedAt }. renderTerminalSection rebuilds EVERY button from
    // scratch on every fleet push (5s poll + terminalsChanged + the completion push
    // itself), so a bare CSS animation on `.strip-term-done` would restart every few
    // seconds and blink forever. A plain "already pulsed" boolean is not enough
    // either: the rebuild destroys the animating element mid-pulse and its
    // replacement, marked pulsed, wears no ring — the pulse is silently truncated,
    // often to nothing (handleAgentCompleted relays, then fetchTerminalList relays
    // again ~200ms later).
    //
    // So record WHEN the pulse started and keep re-applying the class with a negative
    // animation-delay equal to the elapsed time: a negative delay starts a CSS
    // animation already that far into its timeline, so each rebuilt element picks up
    // exactly where its predecessor was killed. Once elapsed >= DONE_PULSE_MS the
    // class stops being applied and the ring is gone for good.
    //
    // performance.now(), not document.timeline.currentTime: they share the same
    // monotonic clock and both keep advancing while the tab is hidden, so the two are
    // interchangeable for this arithmetic — and document.timeline can be null on a
    // freshly attached document, which performance.now() never is.
    const pulsedDoneStamps = new Map();
    const DONE_PULSE_MS = 2200; // MUST equal the animation duration in shell.html

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
        // The dock frame is NOT in `frames` (it is a /terminals?solo=&dock=1
        // iframe, not a manifest panel), so applyThemeToAll's loop above misses
        // it — a live theme toggle would leave the dock in the old palette
        // until reload. Fan out explicitly (edge case 10).
        try {
            dockFrame.contentWindow?.postMessage(
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

    // Roles that operate via skills/addons, not as dockable agent CLIs —
    // same exclusion onNewTerminalClicked applies (terminals.js:3605-3607).
    const DOCK_SYSTEM_ROLES = new Set(['mission-control', 'mcp_monitor']);

    function labelForRole(role) {
        const meta = (typeof BUILT_IN_AGENT_LABELS !== 'undefined')
            ? BUILT_IN_AGENT_LABELS.find(r => r.key === role)
            : null;
        return meta ? meta.label : role;
    }

    function dockSeatName(role) { return `dock-${role}`; }

    function setDockOpen(open) {
        dockOpen = !!open;
        dockEl.classList.toggle('is-open', dockOpen);
        splitterEl.classList.toggle('is-open', dockOpen);
        dockEl.hidden = !dockOpen;
        splitterEl.hidden = !dockOpen;
        const toggle = strip.querySelector('.dock-toggle-btn');
        if (toggle) {
            toggle.classList.toggle('is-active', dockOpen);
            toggle.setAttribute('aria-expanded', String(dockOpen));
        }
        writeDockState({ open: dockOpen });
        if (dockOpen) {
            // Apply the persisted width BEFORE the frame gets a box, so the pty
            // is sized once. Without this the dock always reopens at the CSS
            // default and the saved width is write-only.
            dockEl.style.width = clampDockWidth(readDockState().width) + 'px';
            syncDockSeat();
            // Fetch the role list once on first open — needed to label the
            // picker and the empty-state hint. Cached for the session.
            if (!dockRolesCache) { fetchDockRoles(); }
        }
    }

    // Seat resolution — adopt, never implicitly create. The fleet snapshot
    // (cached in lastFleet) is the only liveness oracle. `saved.seat` is the
    // friendlyName the SERVER returned, treated as opaque — PtyFleetService
    // drops the requested name entirely on collision and falls back to the
    // `<role>-N` series, so nothing may key on the `dock-` prefix.
    function syncDockSeat() {
        const saved = readDockState();
        const wanted = saved.seat || dockSeatName(dockRole);
        const live = lastFleet.find(t => t.name === wanted && t.light !== 'exited');
        if (live) {
            mountDockFrame(wanted);
        } else {
            showDockEmptyState();
        }
    }

    function mountDockFrame(name) {
        const url = `/terminals?solo=${encodeURIComponent(name)}&dock=1`;
        if (dockFrame.getAttribute('src') !== url) { dockFrame.src = url; }
        dockFrame.hidden = false;
        dockFrame.classList.add('is-visible');
        emptyEl.hidden = true;
        emptyEl.classList.remove('is-visible');
        dockTitleEl.textContent = name;
        writeDockState({ seat: name });
    }

    function showDockEmptyState() {
        dockFrame.hidden = true;
        dockFrame.classList.remove('is-visible');
        emptyEl.hidden = false;
        emptyEl.classList.add('is-visible');
        // Label the start button from BUILT_IN_AGENT_LABELS (now reachable via
        // sharedDefaults.js — edge case 15). When the role has no CLI configured,
        // show the same honest hint onNewTerminalClicked gives.
        const label = labelForRole(dockRole);
        startBtn.textContent = `Start ${label}`;
        const hasCmd = dockRolesCache && dockRolesCache.hasCommand
            ? dockRolesCache.hasCommand[dockRole] === true
            : true;   // optimistic until the first fetch resolves
        dockEmptyHint.textContent = hasCmd
            ? ''
            : 'No agent CLI configured — this opens a plain shell.';
        dockTitleEl.textContent = '';
    }

    // Create on explicit click only — never implicitly on shell load (edge
    // case 4). data.terminal.friendlyName — NOT the requested name — is what
    // gets mounted and persisted. On a collision the server returns something
    // from the `<role>-N` series instead, and the dock must follow it.
    async function startDockTerminal() {
        startBtn.disabled = true;
        try {
            const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: dockRole, name: dockSeatName(dockRole) })
            });
            const data = await res.json();
            if (data && data.success && data.terminal) {
                mountDockFrame(data.terminal.friendlyName);
            } else {
                dockEmptyHint.textContent = (data && data.error) || 'Could not start the terminal.';
            }
        } catch (err) {
            dockEmptyHint.textContent = 'Could not reach the terminal service.';
        } finally {
            startBtn.disabled = false;
        }
    }

    // Fetch the role list once when the dock first opens. ptyVisibleRoles
    // returns {visibleAgents, hasCommand} and is the one pty verb served even
    // when the fleet is unavailable. Cached for the session.
    async function fetchDockRoles() {
        try {
            const res = await fetch('/terminals/verb/ptyVisibleRoles', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const data = await res.json();
            if (data && Array.isArray(data.visibleAgents)) {
                dockRolesCache = { visibleAgents: data.visibleAgents, hasCommand: data.hasCommand || {} };
                buildDockRoleMenu();
                // Re-paint the empty state now that the hasCommand hint is known.
                if (dockOpen && emptyEl.classList.contains('is-visible')) { showDockEmptyState(); }
            }
        } catch { /* keep the optimistic default */ }
    }

    // Build the role picker menu from the cached ptyVisibleRoles response.
    // Same SYSTEM_ROLES exclusion onNewTerminalClicked applies, labels from
    // BUILT_IN_AGENT_LABELS. Selecting a role persists it (change 4), updates
    // dockRole, and re-runs syncDockSeat() — which lands on the empty state
    // for the new role's seat: changing the agent means starting that agent.
    // The previously running seat is NOT killed; it stays in the fleet strip.
    function buildDockRoleMenu() {
        if (!dockRolesCache) { return; }
        dockRoleMenu.innerHTML = '';
        const roles = dockRolesCache.visibleAgents.filter(r => !DOCK_SYSTEM_ROLES.has(r));
        for (const role of roles) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'dock-role-item' + (role === dockRole ? ' is-selected' : '');
            item.textContent = labelForRole(role);
            item.addEventListener('click', () => {
                dockRole = role;
                writeDockState({ seat: null });   // new role → new seat
                // Persist the role choice server-side (workspace-level setting).
                fetch('/setup/verb/setAgentDockRole', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role })
                }).catch(() => { /* non-fatal — the local dockRole is already set */ });
                dockRoleMenu.classList.remove('is-visible');
                dockRoleBtn.textContent = labelForRole(dockRole);
                buildDockRoleMenu();   // refresh selected highlight
                syncDockSeat();
            });
            dockRoleMenu.appendChild(item);
        }
    }

    // Boot: fetch the persisted role before first paint of the dock. The role
    // is a workspace-level setting (change 4), so it follows the workspace
    // across browsers. This read is the shell's second-ever server call and
    // follows the same read-the-HTTP-body pattern as the theme write.
    async function loadDockRole() {
        try {
            const res = await fetch('/setup/verb/getAgentDockRole', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const data = await res.json();
            if (data && data.success && typeof data.role === 'string' && data.role) {
                dockRole = data.role;
            }
        } catch { /* keep the built-in default */ }
        dockRoleBtn.textContent = labelForRole(dockRole);
        // After the role resolves, restore the dock if it was left open — but
        // only if the window is wide enough. On a narrow window the viability
        // gate (updateDockViableGating, already called synchronously in
        // renderManifest) has disabled the toggle; opening the dock here would
        // bypass that gate and squeeze the board (edge case 7).
        if (readDockState().open && window.innerWidth >= DOCK_VIABLE_MIN) {
            setDockOpen(true);
        }
    }

    // Narrow-window gate (edge case 7). Below DOCK_VIABLE_MIN the dock is not
    // offered at all — the rail toggle renders disabled with a tooltip, and an
    // open dock auto-closes. The board keeps the full content area and is
    // never squeezed to 200px. The dock does NOT reopen by itself (closing was
    // a forced action, not a user preference — leave open:false written).
    function updateDockViableGating() {
        const toggle = strip.querySelector('.dock-toggle-btn');
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
                dockEl.style.width = clampDockWidth(startW + (startX - ev.clientX)) + 'px';
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
        dockEl.style.width = clampDockWidth(dockEl.getBoundingClientRect().width) + 'px';
    });

    // Dock close button.
    if (dockCloseBtn) {
        dockCloseBtn.addEventListener('click', () => setDockOpen(false));
    }

    // Start button — the ONLY create path (edge case 4).
    if (startBtn) {
        startBtn.addEventListener('click', startDockTerminal);
    }

    // Role picker: toggle the menu, dismiss on outside click / Escape.
    if (dockRoleBtn) {
        dockRoleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!dockRolesCache) { fetchDockRoles(); }
            dockRoleMenu.classList.toggle('is-visible');
            if (dockRoleMenu.classList.contains('is-visible')) {
                const rect = dockRoleBtn.getBoundingClientRect();
                dockRoleMenu.style.left = rect.left + 'px';
                dockRoleMenu.style.top = (rect.bottom + 4) + 'px';
            }
        });
    }
    document.addEventListener('click', (e) => {
        if (dockRoleMenu && dockRoleMenu.classList.contains('is-visible')) {
            if (!dockRoleMenu.contains(e.target) && e.target !== dockRoleBtn) {
                dockRoleMenu.classList.remove('is-visible');
            }
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dockRoleMenu && dockRoleMenu.classList.contains('is-visible')) {
            dockRoleMenu.classList.remove('is-visible');
        }
    });

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

    function renderTerminalSection(terminals, teams) {
        // A fleet-state push rebuilds every terminal button (innerHTML = ''
        // below). If the hovered button is removed mid-hover, no mouseout ever
        // fires and the overlay strands beside empty space — hide it first.
        hideStripTooltip();
        let container = document.getElementById('strip-terminals');
        const themeBtn = document.querySelector('.theme-toggle-btn');

        if (!frames.has('terminals')) {
            pulsedDoneStamps.clear();
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
            // The container.remove() above took Mission Control icon with it.
            // Re-create it so the rail control survives a terminals-panel-less
            // rebuild — the start control must stay reachable without a state
            // message (CRITICAL 1 regression guard).
            ensureMissionControlIcon();
            return;
        }

        if (!container) {
            container = document.createElement('div');
            container.id = 'strip-terminals';
            container.role = 'group';
            container.setAttribute('aria-label', 'Fleet terminals');

            if (themeBtn) {
                // Insert BEFORE the first bottom-placement icon (settings) when
                // one exists, so the DOM order is: top group → terminals →
                // settings → theme toggle. applyBottomAnchor then hands
                // margin-top:auto to the settings icon, pinning settings +
                // theme toggle together at the foot of the rail with the
                // fleet list above them. Inserting before themeBtn instead
                // would sandwich the fleet list between settings and the
                // toggle, separating the two controls the user asked to keep
                // adjacent.
                const firstBottom = strip.querySelector('.strip-placement-bottom');
                if (firstBottom) {
                    strip.insertBefore(container, firstBottom);
                } else {
                    strip.insertBefore(container, themeBtn);
                }
                themeBtn.style.marginTop = '';
            } else {
                strip.appendChild(container);
            }
        }
        applyBottomAnchor();

        // Rebuild only the fleet terminal buttons. #strip-mission-control (managed
        // by renderMissionControlIcon) is a first child of this container and
        // MUST survive the rebuild — a plain innerHTML='' would wipe it every
        // 5s poll and leave the rail dark until the next autoban state push.
        // Mission Control button carries no .strip-term-btn / .strip-team-btn
        // class, so removing those children is equivalent to the old wipe minus
        // Mission Control.
        for (const child of Array.from(container.querySelectorAll(':scope > .strip-term-btn, :scope > .strip-team-btn'))) {
            child.remove();
        }
        if (!Array.isArray(terminals) || terminals.length === 0) {
            pulsedDoneStamps.clear();
            return;
        }

        const seenKeys = new Set();

        // ── Teams mode (the only mode) ───────────────────────────────
        // One button per team (in stable order from the panel), then one
        // button per ungrouped terminal. A terminal claimed by a team
        // does NOT also render as ungrouped — first-by-stable-order wins.
        const teamsArr = Array.isArray(teams) ? teams : [];
        const claimedNames = new Set();
        for (const team of teamsArr) {
            for (const name of (team.memberNames || [])) {
                claimedNames.add(name);
            }
        }

        for (const team of teamsArr) {
            const key = 'team:' + team.groupId;
            seenKeys.add(key);

            // Pulse ledger keyed on groupId — same machinery, same guards.
            let pulseElapsed = -1;
            if (team.light === 'done') {
                const prev = pulsedDoneStamps.get(key);
                if (!prev || prev.stamp !== team.doneStamp) {
                    pulsedDoneStamps.set(key, { stamp: team.doneStamp, startedAt: performance.now() });
                    pulseElapsed = 0;
                } else {
                    const elapsed = performance.now() - prev.startedAt;
                    if (elapsed < DONE_PULSE_MS) { pulseElapsed = elapsed; }
                }
            } else {
                pulsedDoneStamps.delete(key);
            }

            const btn = document.createElement('button');
            btn.className = 'strip-icon strip-team-btn strip-term-' + team.light
                + (pulseElapsed >= 0 ? ' is-pulsing' : '');
            btn.type = 'button';
            if (pulseElapsed > 0) {
                btn.style.animationDelay = '-' + Math.floor(pulseElapsed) + 'ms';
            }

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
                const headTerm = terminals.find(t => t.name === team.head);
                const roleChar = (team.headRole || (headTerm && headTerm.role) || 'T').charAt(0).toUpperCase();
                const glyph = document.createElement('span');
                glyph.textContent = roleChar;
                btn.appendChild(glyph);
            }

            // Queue-depth badge — shows pending work count on the rail
            // icon so depth is visible without opening the cockpit.
            // Only shown when there are queued items.
            const qDepth = team.queueDepth || 0;
            if (qDepth > 0) {
                const qBadge = document.createElement('span');
                qBadge.className = 'strip-team-queue-depth';
                qBadge.textContent = String(qDepth);
                btn.appendChild(qBadge);
            }

            btn.addEventListener('click', () => {
                const termFrame = frames.get('terminals');
                // Clicking a team with an unacknowledged completion IS the
                // acknowledgement — relay clearTeamBadges carrying
                // memberNames so the panel clears every member's badge.
                // Otherwise the aggregate light burns forever.
                if (team.light === 'done' && termFrame && termFrame.contentWindow) {
                    try {
                        termFrame.contentWindow.postMessage({
                            type: 'clearTeamBadges',
                            memberNames: team.memberNames || []
                        }, location.origin);
                    } catch { /* ignore */ }
                }
                // Switch the main terminals panel to team-scoped mode in-place.
                // No pop-out window — the team view replaces the fleet view
                // inside the existing panel, with a back button to return.
                selectPanel('terminals');
                if (termFrame && termFrame.contentWindow) {
                    try {
                        termFrame.contentWindow.postMessage({
                            type: 'switchToTeam',
                            groupId: team.groupId
                        }, location.origin);
                    } catch { /* ignore */ }
                }
            });

            container.appendChild(btn);
        }

        // Ungrouped terminals — one per-terminal button for any terminal
        // not claimed by a team.
        for (const t of terminals) {
            if (claimedNames.has(t.name)) { continue; }
            seenKeys.add('term:' + t.name);
            container.appendChild(buildTerminalButton(t, seenKeys));
        }

        // Prune pulse ledger entries that no longer have a button.
        for (const key of Array.from(pulsedDoneStamps.keys())) {
            if (!seenKeys.has(key)) { pulsedDoneStamps.delete(key); }
        }
        // The selective button removal above preserves #strip-mission-control, but a
        // future edit to this rebuild could still drop it. Ensure it exists at the
        // end of every fleet rebuild so the rail control never vanishes without a
        // state message (CRITICAL 1 regression guard).
        ensureMissionControlIcon();
    }

    /**
     * Build a single per-terminal button. Extracted from renderTerminalSection
     * so both teams mode (ungrouped terminals) and terminals mode (all
     * terminals) share the exact same rendering + click behaviour. The pulse
     * ledger is keyed on 'term:<name>' so it never collides with 'team:<id>'.
     */
    function buildTerminalButton(t, seenKeys) {
        let pulseElapsed = -1;
        const key = 'term:' + t.name;
        if (t.light === 'done') {
            const prev = pulsedDoneStamps.get(key);
            if (!prev || prev.stamp !== t.doneStamp) {
                pulsedDoneStamps.set(key, { stamp: t.doneStamp, startedAt: performance.now() });
                pulseElapsed = 0;
            } else {
                // STRICTLY less than. A delay whose magnitude reaches the duration
                // puts the animation straight into its post-active phase, and with
                // fill-mode `both` the element paints the 100% keyframe for one
                // frame — a green flash on an expired completion. This comparison
                // is the guard against that, not a rounding nicety.
                const elapsed = performance.now() - prev.startedAt;
                if (elapsed < DONE_PULSE_MS) { pulseElapsed = elapsed; }
            }
        } else {
            // Not done any more (acknowledged, or exited): forget it, so a LATER
            // completion of the same terminal pulses again from the top.
            pulsedDoneStamps.delete(key);
        }

        const btn = document.createElement('button');
        // The done ring is a one-shot ANIMATION, not a state class: it plays for
        // DONE_PULSE_MS from the push that carried a new completion stamp, and is
        // simply absent on every push after that window closes. A terminal that
        // completed a minute ago wears no ring — the sidebar DONE chip and the
        // pane badge in the Terminals panel remain the durable record of an
        // unacknowledged completion.
        btn.className = 'strip-icon strip-term-btn strip-term-' + t.light
            + (pulseElapsed >= 0 ? ' is-pulsing' : '');
        btn.type = 'button';
        if (pulseElapsed > 0) {
            // Resume, do not restart — the previous element was destroyed mid-pulse.
            // FLOOR, never round: the guard above admits pulseElapsed strictly below
            // DONE_PULSE_MS, but rounding 2199.6 up to 2200 hands the animation a
            // delay whose magnitude EQUALS the duration — straight into the
            // post-active phase, where fill-mode `both` paints the 100% keyframe for
            // one frame. That is the green flash on an expired completion the strict
            // comparison exists to prevent; rounding would reintroduce it.
            btn.style.animationDelay = '-' + Math.floor(pulseElapsed) + 'ms';
        }

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

        // Coloured brand icon replaces the old role-letter glyph + status dot. The
        // URI is resolved panel-side (terminals.js postFleetStateToShell) from the
        // same brandIconForCliLabel/brandIconUri helpers the Terminals sidebar uses,
        // so the two surfaces show the same icon for the same terminal. An <img> (not
        // the strip's CSS-mask/currentColor path) is deliberate: these are multi-hue
        // brand marks whose baked-in fill IS the identity. Fall back to the role
        // letter only if the relay sent no URI (defensive — the relay always sends at
        // least the default icon unless the dataset attrs are missing entirely).
        if (t.iconUri) {
            const icon = document.createElement('img');
            icon.className = 'strip-term-icon';
            icon.src = t.iconUri;
            // alt='' is correct: the button's aria-label already carries name, role,
            // worktree and light state. A brand name here would double-announce.
            icon.alt = '';
            btn.appendChild(icon);
        } else {
            const glyph = document.createElement('span');
            glyph.textContent = roleChar;
            btn.appendChild(glyph);
        }

        btn.addEventListener('click', () => {
            const slug = t.name.replace(/[^A-Za-z0-9_-]/g, '_');
            const popoutName = `sb-term-${slug}`;

            // If a solo pop-out for this terminal is already open, focus it — the
            // open window is the stronger signal of intent than a peek.
            let existing = null;
            for (const win of Array.from(popoutWindows)) {
                if (win.closed) {
                    popoutWindows.delete(win);
                } else if (win.name === popoutName) {
                    existing = win;
                }
            }

            const termFrame = frames.get('terminals');
            if (existing) {
                // Clicking a lit entry IS the acknowledgement. This branch never
                // reaches the panel's peek arm, so without an explicit clear the
                // DONE light burns forever — the exact regression the old
                // clearTerminalBadge relay existed to prevent.
                if (termFrame && termFrame.contentWindow) {
                    try {
                        termFrame.contentWindow.postMessage({
                            type: 'clearTerminalBadge',
                            name: t.name
                        }, location.origin);
                    } catch { /* ignore */ }
                }
                try { existing.focus(); } catch { /* ignore */ }
                return;
            }

            // Otherwise peek it in the cockpit. Switch the panel FIRST — the strip
            // is visible while other panels are active, so a peek alone would
            // change a panel the user cannot see. The peek arm clears the badge.
            selectPanel('terminals');
            if (termFrame && termFrame.contentWindow) {
                try {
                    termFrame.contentWindow.postMessage({
                        type: 'peekTerminal',
                        name: t.name
                    }, location.origin);
                } catch { /* ignore */ }
            }
        });

        return btn;
    }

    function requestFleetState() {
        const termFrame = frames.get('terminals');
        if (termFrame && termFrame.contentWindow) {
            try {
                termFrame.contentWindow.postMessage({ type: 'requestFleetState' }, location.origin);
            } catch { /* ignore */ }
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
            if (panel.presentation === 'modal') {
                modalPanels.add(panel.id);
                frame.className = 'modal-frame';
                frame.addEventListener('load', () => wireModalFrameKeys(frame));
                ensureModalHost();
                modalDialog.appendChild(frame);
            } else {
                content.appendChild(frame);
            }
            // Frames are position-independent (display-toggled, keyed by id); only the
            // ICON's rail position depends on placement.
            if (panel.placement === 'bottom') { bottomPanels.push(icon); } else { strip.appendChild(icon); }
        }

        // Bottom cluster, in rail order: dock toggle → settings panels → theme
        // toggle. Only added when the host actually has a Terminals panel —
        // `enabled:false` panels are omitted from `frames` entirely (see the
        // comment at the top of the loop), so this is the same test the fleet
        // strip makes, and it fails closed on a node-pty-less install (edge
        // case 3). The dock toggle carries strip-placement-bottom, so
        // applyBottomAnchor() picks it up as a cluster member with no change
        // to that function.
        if (frames.has('terminals')) { strip.appendChild(buildDockToggle()); }
        for (const icon of bottomPanels) { strip.appendChild(icon); }

        const themeBtn = buildThemeToggle();
        strip.appendChild(themeBtn);

        renderTerminalSection([]);

        // Dock boot: fetch the persisted role, then restore the dock if it
        // was left open across a reload. Only when the host has a Terminals
        // panel — the same gate the toggle itself makes. Also apply the
        // narrow-window viability gate on first paint.
        if (frames.has('terminals')) {
            updateDockViableGating();
            loadDockRole();
        }

        // The Mission Control rail icon must exist on a cold load with no
        // missionControlState message — without this the start control is
        // unreachable until a seat changes. renderTerminalSection's own
        // ensureMissionControlIcon() call covers its branches, but the very first
        // build goes through renderManifest before any fleet push, so ensure
        // here too (idempotent).
        ensureMissionControlIcon();

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
        } else if (data.type === 'terminalFleetState' && Array.isArray(data.terminals)) {
            if (event.origin !== location.origin) { return; }
            // Cache the fleet snapshot as the dock's liveness oracle. The dock
            // treats the friendlyName as opaque (edge case 4) and uses this
            // cache to decide adopt-vs-empty-state on every push.
            lastFleet = data.terminals;
            renderTerminalSection(data.terminals, Array.isArray(data.teams) ? data.teams : []);
            // If the dock is open, re-sync the seat — a fleet push may report
            // the seat we just created, or report that a previously-live seat
            // has exited.
            if (dockOpen) { syncDockSeat(); }
        } else if (data.type === 'missionControlState') {
            // Relayed from terminals.js (autobanStateSync / updateAutobanConfig
            // over the WS broadcast rail). Origin-guarded: the relay targets
            // location.origin, so a foreign framer cannot light the icon.
            if (event.origin !== location.origin) { return; }
            renderMissionControlIcon(data);
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

    // A completion that lands while the cockpit tab is hidden burns its whole 2.2s
    // window unwatched — the fleet poll is suspended (terminals.js skips it on
    // visibilityState === 'hidden'), background tabs throttle animation frames, and
    // even if neither were true the pulse is over before the operator looks. Dropping
    // the ledger on return re-arms every STILL-OUTSTANDING completion so the next push
    // re-announces it exactly once. Identical semantics to a shell reload, which this
    // design already treats as correct. A terminal whose badge was acknowledged is not
    // `done` any more, so it is not re-announced.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { pulsedDoneStamps.clear(); }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadManifest);
    } else {
        loadManifest();
    }
})();

