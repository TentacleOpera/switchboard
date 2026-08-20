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

    const modalPanels = new Set();   // manifest ids with presentation === 'modal'
    let openModalId = null;
    let modalReturnFocus = null;
    let modalHost = null, modalDialog = null;

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

    /* ── Orchestrator rail icon ─────────────────────────────────────────
       A UFO button at the top of #strip-terminals that lights (animated cyan
       lights) when an orchestrator session is active and dims when inactive.
       Lit click → POST /orchestration/stop (end the session). Dimmed click →
       POST /orchestration/start: the server decides — if a lead/coder agent is
       configured it creates a pty terminal and delivers the persona prompt
       (mode 'terminal'); otherwise it returns the /switchboard launcher text
       (mode 'clipboard') for the shell to copy. State arrives via
       `orchestratorState` postMessages relayed from terminals.js (which gets
       autobanStateSync / updateAutobanConfig over the WS broadcast rail). */
    let orchestratorActive = false;
    let orchestratorSeat = null;
    // In-flight guard for the dimmed-click /orchestration/start fetch. The
    // server's seat guard cannot help here: the agent adopts the seat seconds
    // or minutes after the terminal is created, so two rapid clicks both see
    // an empty seat and spawn a second 'Orchestrator' terminal (renamed to
    // 'orchestrator-2' by ptyFleetService.create's collision loop). A second
    // click while a start fetch is pending is a silent no-op — cleared in both
    // the success and failure paths. No confirmation dialog (CLAUDE.md).
    let orchestrationStartInFlight = false;

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

    function createOrchestratorIcon() {
        const btn = document.createElement('button');
        btn.id = 'strip-orchestrator';
        btn.type = 'button';
        btn.className = 'orchestrator-dimmed';
        btn.setAttribute('aria-label', 'Orchestrator session');
        btn.dataset.tooltip = 'Operator: inactive — click to start';

        // Inline SVG (not an <img src>) so shell.html's CSS can select into the
        // icon's sub-elements — the dimmed freeze and reduced-motion rules are
        // inert when the SVG is a separate document. The SVG's internal <style>
        // block is dropped; all animation rules live in shell.html. ids are
        // prefixed (sb-orch-*) to avoid document-wide collisions now that they
        // are global. aria-hidden="true" + no role/aria-labelledby so the icon
        // does not double-announce beside the button's aria-label. Class names
        // on sub-elements (.ufo, .beam, .light-a, .light-b, .star-a, .star-b)
        // are kept — shell.html's selectors depend on them.
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" aria-hidden="true" shape-rendering="crispEdges" class="strip-orch-icon">'
            + '<defs>'
            + '<filter id="sb-orch-cyan-glow" x="-100%" y="-100%" width="300%" height="300%">'
            + '<feGaussianBlur stdDeviation="3" result="blur"/>'
            + '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>'
            + '</filter>'
            + '<linearGradient id="sb-orch-beam" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#00e5ff" stop-opacity=".22"/>'
            + '<stop offset="1" stop-color="#00e5ff" stop-opacity="0"/>'
            + '</linearGradient>'
            + '</defs>'
            + '<g fill="#00e5ff" filter="url(#sb-orch-cyan-glow)">'
            + '<rect class="star-a" x="40" y="36" width="4" height="4"/>'
            + '<rect class="star-b" x="268" y="54" width="4" height="4"/>'
            + '<rect class="star-b" x="74" y="126" width="3" height="3"/>'
            + '<rect class="star-a" x="248" y="132" width="3" height="3"/>'
            + '</g>'
            + '<g class="beam">'
            + '<path d="M128 104h64l32 68H96z" fill="url(#sb-orch-beam)"/>'
            + '<rect x="112" y="168" width="96" height="4" fill="#00e5ff" opacity=".16"/>'
            + '</g>'
            + '<g class="ufo">'
            + '<g filter="url(#sb-orch-cyan-glow)" opacity=".35" fill="#00e5ff">'
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
            + '<g fill="#00e5ff" filter="url(#sb-orch-cyan-glow)">'
            + '<rect class="light-a" x="96" y="82" width="12" height="8"/>'
            + '<rect class="light-b" x="120" y="86" width="12" height="8"/>'
            + '<rect class="light-a" x="144" y="88" width="12" height="8"/>'
            + '<rect class="light-b" x="168" y="88" width="12" height="8"/>'
            + '<rect class="light-a" x="192" y="86" width="12" height="8"/>'
            + '<rect class="light-b" x="216" y="82" width="12" height="8"/>'
            + '</g>'
            + '<rect x="156" y="98" width="8" height="8" fill="#00e5ff" filter="url(#sb-orch-cyan-glow)"/>'
            + '</g>'
            + '</svg>';

        btn.addEventListener('click', () => {
            if (orchestratorActive) {
                // End immediately — no confirmation. The user is in control.
                btn.dataset.tooltip = 'Orchestrator: stopping…';
                fetch('/orchestration/stop', { method: 'POST', credentials: 'same-origin' })
                    .then(res => res.json())
                    .then(result => {
                        if (result.success) {
                            showStripToast('Orchestrator session ended');
                        } else {
                            showStripToast('Failed to stop orchestrator: ' + (result.error || 'unknown'));
                        }
                    })
                    .catch(err => {
                        showStripToast('Failed to stop orchestrator: ' + err.message);
                    });
            } else {
                // Dimmed click: start the operator. The server decides the path
                // — terminal (agent configured) or clipboard fallback (no agent).
                // In-flight guard: a second click while a start fetch is pending
                // is a silent no-op (double-click protection — see the module
                // flag's comment for why the server seat guard cannot help).
                if (orchestrationStartInFlight) { return; }
                orchestrationStartInFlight = true;
                btn.dataset.tooltip = 'Operator: starting…';
                fetch('/orchestration/start', { method: 'POST', credentials: 'same-origin' })
                    .then(res => res.json())
                    .then(result => {
                        if (result.success && result.mode === 'terminal') {
                            showStripToast('Operator started — check the Orchestrator terminal');
                        } else if (result.success && result.mode === 'clipboard') {
                            // No agent configured — copy the prompt to clipboard.
                            const text = result.prompt || 'Run /switchboard workflow to start orchestration';
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
                            showStripToast('Failed to start operator: ' + (result.error || 'unknown'));
                        }
                        // Restore the inactive tooltip after the attempt resolves
                        // so a later hover is not stuck on 'starting…'.
                        btn.dataset.tooltip = 'Operator: inactive — click to start';
                    })
                    .catch(err => {
                        showStripToast('Failed to start operator: ' + err.message);
                        btn.dataset.tooltip = 'Operator: inactive — click to start';
                    })
                    .finally(() => {
                        orchestrationStartInFlight = false;
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
        // The fleet container owns the bottom anchor in CSS; the orchestrator
        // icon rides above it. Reconcile so the anchor stays on the container.
        applyBottomAnchor();
        return btn;
    }

    /* Ensure the orchestrator rail icon exists independently of any
       `orchestratorState` postMessage. renderOrchestratorIcon is the ONLY
       other creator and it only runs when a state message arrives — on a cold
       shell load with no autoban state change, NO icon would exist at all and
       the start control would be unreachable. This is called (a) once during
       shell init after the rail/manifest is built, and (b) at the END of
       renderTerminalSection in BOTH branches — including the early-return
       `!frames.has('terminals')` branch, which removes the container (and the
       icon with it). Idempotent: a no-op when the icon already exists. */
    function ensureOrchestratorIcon() {
        if (document.getElementById('strip-orchestrator')) { return; }
        createOrchestratorIcon();
    }

    function renderOrchestratorIcon(state) {
        orchestratorActive = !!state.active;
        orchestratorSeat = state.seat || null;
        // Only update classes/tooltip on an icon that already exists —
        // ensureOrchestratorIcon() owns creation (init + renderTerminalSection).
        // Creating here would re-introduce the cold-load gap this function
        // cannot close: it only runs when a state message arrives.
        const icon = document.getElementById('strip-orchestrator');
        if (!icon) { return; }
        if (!orchestratorActive) {
            icon.classList.remove('orchestrator-active');
            icon.classList.add('orchestrator-dimmed');
            icon.dataset.tooltip = 'Operator: inactive — click to start';
            return;
        }
        icon.classList.remove('orchestrator-dimmed');
        icon.classList.add('orchestrator-active');
        const since = orchestratorSeat && orchestratorSeat.adoptedAt
            ? new Date(orchestratorSeat.adoptedAt).toLocaleTimeString()
            : '';
        const where = orchestratorSeat && orchestratorSeat.terminalName
            ? ' on ' + orchestratorSeat.terminalName : '';
        icon.dataset.tooltip = since
            ? 'Orchestrator: active' + where + ' since ' + since + ' — click to end session'
            : 'Orchestrator: active — click to end session';
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
            // The container.remove() above took the orchestrator icon with it.
            // Re-create it so the rail control survives a terminals-panel-less
            // rebuild — the start control must stay reachable without a state
            // message (CRITICAL 1 regression guard).
            ensureOrchestratorIcon();
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

        // Rebuild only the fleet terminal buttons. #strip-orchestrator (managed
        // by renderOrchestratorIcon) is a first child of this container and
        // MUST survive the rebuild — a plain innerHTML='' would wipe it every
        // 5s poll and leave the rail dark until the next autoban state push.
        // The orchestrator button carries no .strip-term-btn / .strip-team-btn
        // class, so removing those children is equivalent to the old wipe minus
        // the orchestrator.
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
        // The selective button removal above preserves #strip-orchestrator, but a
        // future edit to this rebuild could still drop it. Ensure it exists at the
        // end of every fleet rebuild so the rail control never vanishes without a
        // state message (CRITICAL 1 regression guard).
        ensureOrchestratorIcon();
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

        // Bottom cluster: settings icons are appended here, then the theme
        // toggle. renderTerminalSection (called next) inserts the fleet
        // container BEFORE the settings icons, yielding the DOM order:
        // top group → terminals → settings → theme toggle. applyBottomAnchor
        // hands margin-top:auto to the settings icon, pinning settings +
        // theme toggle together at the foot of the rail with the fleet list
        // above them — keeping the two controls adjacent even as the fleet
        // list grows toward its 40vh cap.
        for (const icon of bottomPanels) { strip.appendChild(icon); }

        const themeBtn = buildThemeToggle();
        strip.appendChild(themeBtn);

        renderTerminalSection([]);

        // The orchestrator rail icon must exist on a cold load with no
        // orchestratorState message — without this the start control is
        // unreachable until a seat changes. renderTerminalSection's own
        // ensureOrchestratorIcon() call covers its branches, but the very first
        // build goes through renderManifest before any fleet push, so ensure
        // here too (idempotent).
        ensureOrchestratorIcon();

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
            renderTerminalSection(data.terminals, Array.isArray(data.teams) ? data.teams : []);
        } else if (data.type === 'orchestratorState') {
            // Relayed from terminals.js (autobanStateSync / updateAutobanConfig
            // over the WS broadcast rail). Origin-guarded: the relay targets
            // location.origin, so a foreign framer cannot light the icon.
            if (event.origin !== location.origin) { return; }
            renderOrchestratorIcon(data);
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

