// dockComposer.js — the dock's Composer tab. A standing prompt surface, not a
// modal: the draft and its target stay put across tab switches, dock
// close/reopen and reload, and a send clears the draft only on success (plan:
// the-composer-is-a-modal-you-have-to-summon-make-it-a-dock-tab).
//
// The pane's static markup lives in dock.html under #dock-composer-*; this
// module wires it, following the shared-webview-module pattern (IIFE, static
// ids, window.Switchboard* export).
//
// Fleet source: the ptyListTerminals verb, fetched here — NEVER read from
// window.parent. The dock is its own document; reaching into the parent for
// fleet state is exactly the coupling this tab exists to break.
//
// No confirmation dialog gates anything here (CLAUDE.md), and NO Escape
// handler is bound anywhere in this module — Escape in the dock must never
// close or dismiss anything (plan edge-case 4).
(function () {
    'use strict';

    const targetSelectEl = document.getElementById('dock-composer-target');
    const inputEl = document.getElementById('dock-composer-input');
    const statusEl = document.getElementById('dock-composer-status');
    const sendBtn = document.getElementById('dock-composer-send');

    let sendInFlight = false;
    // A stored target the first refreshTargets applies once the live list
    // exists — the select has no options before then.
    let pendingRestoredTarget = null;

    // ── Draft persistence ────────────────────────────────────────────────
    // The draft (text + target) survives tab switches, dock close/reopen and
    // reload — that persistence is what makes a standing surface worth
    // having. Per-surface convenience state ONLY: localStorage, never the
    // kanban database, never synced anywhere.
    const DRAFT_KEY = 'sb.composerDraft';

    function readStoredDraft() {
        try {
            const raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) { return null; }
            const d = JSON.parse(raw);
            return {
                target: typeof d.target === 'string' && d.target ? d.target : null,
                text: typeof d.text === 'string' ? d.text : '',
            };
        } catch (err) {
            // A corrupt draft is dropped loudly-ish — convenience state, so a
            // console note is the right volume; a silent {} would read a
            // corrupt store as an unwritten one.
            console.warn('[dock] composer draft unreadable, dropping it:', err);
            try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
            return null;
        }
    }

    /** Persist the current text + target. Called on input/change and after
     *  the successful-send clear (which stores { text: '' }). */
    function persistDraft() {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify({
                target: targetSelectEl ? targetSelectEl.value : '',
                text: inputEl ? inputEl.value : '',
            }));
        } catch { /* storage full/blocked — the draft just does not persist */ }
    }

    /** Restore the stored draft into the controls. The text lands
     *  immediately; the target is deferred to the first refreshTargets —
     *  before it, the select has no options to select. */
    function restoreDraft() {
        const d = readStoredDraft();
        if (!d) { return; }
        pendingRestoredTarget = d.target;
        writeDraft(d.text);
    }

    /** Set the status line text + is-error class. */
    function setComposerStatus(text, isError) {
        if (!statusEl) { return; }
        statusEl.textContent = text || '';
        statusEl.classList.toggle('is-error', isError === true);
    }

    /**
     * SEND is enabled only with a live target selected AND a non-empty draft,
     * and never while a send is in flight. Named — not inlined into the
     * listeners — so the draft-persistence hook can re-run it after a restore.
     */
    function updateSendButton() {
        if (!sendBtn) { return; }
        const hasTarget = !!(targetSelectEl && targetSelectEl.value && !targetSelectEl.disabled);
        const hasText = !!(inputEl && inputEl.value.length > 0);
        sendBtn.disabled = sendInFlight || !(hasTarget && hasText);
    }

    /** The current draft text. Named seam for the persistence hook. */
    function readDraft() {
        return inputEl ? inputEl.value : '';
    }

    /**
     * Replace the draft text and re-evaluate SEND. Named seam — persistence
     * restores through here, and a successful send clears through here.
     */
    function writeDraft(text) {
        if (inputEl) { inputEl.value = text; }
        updateSendButton();
    }

    /**
     * Rebuild the target select from the host's own terminal list (the only
     * fleet source for this surface). Preserves the operator's current
     * selection across a refresh while it is still live — a standing pane has
     * no "open" moment, so the refresh must never fight the selection the way
     * a modal rebuild could. Mirrors the preservation pass in terminals.js
     * openComposerModal.
     */
    async function refreshTargets() {
        if (!targetSelectEl) { return; }
        let terminals = null;
        try {
            const res = await fetch('/terminals/verb/ptyListTerminals', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.terminals)) { terminals = data.terminals; }
            }
        } catch { /* terminals stays null — handled below */ }
        if (!terminals) {
            // The fetch failed: report it rather than blank the control, so a
            // dead host is never indistinguishable from an empty fleet.
            setComposerStatus('Could not reach the terminal list.', true);
            return;
        }
        const live = terminals.filter(t => t && t.status === 'active');
        // A restored target wins the FIRST refresh (the select was empty at
        // restore time); afterwards the operator's current selection is what
        // a refresh must not fight.
        const current = pendingRestoredTarget || targetSelectEl.value;
        pendingRestoredTarget = null;
        targetSelectEl.innerHTML = '';
        if (live.length === 0) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'No active terminals';
            placeholder.disabled = true;
            placeholder.selected = true;
            targetSelectEl.appendChild(placeholder);
            targetSelectEl.disabled = true;
            setComposerStatus('No active terminals available.', false);
        } else {
            targetSelectEl.disabled = false;
            for (const t of live) {
                const opt = document.createElement('option');
                opt.value = t.friendlyName;
                opt.textContent = t.friendlyName;
                targetSelectEl.appendChild(opt);
            }
            // Preserve the prior selection if it is still live.
            if (current && live.some(t => t.friendlyName === current)) {
                targetSelectEl.value = current;
            }
            setComposerStatus('', false);
        }
        updateSendButton();
    }

    /**
     * Deliver the draft to the selected terminal via the same route the old
     * modal used — POST /terminals/verb/sendToTerminal.
     *
     * standingOrders:false is LOAD-BEARING: the standalone sendToTerminal
     * handler applies standing orders by default and a user-typed prompt is
     * not a system dispatch; appending them silently corrupts the operator
     * intent.
     */
    async function deliverComposerPrompt() {
        if (!targetSelectEl || !inputEl || sendInFlight) { return; }
        const name = targetSelectEl.value;
        const input = readDraft();
        if (!name) { setComposerStatus('No terminal selected.', true); return; }
        if (!input) { setComposerStatus('Nothing to send.', true); return; }

        sendInFlight = true;
        updateSendButton();
        setComposerStatus('Sending…', false);
        try {
            const res = await fetch('/terminals/verb/sendToTerminal', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, input, paced: true, standingOrders: false })
            });
            const data = await res.json().catch(() => null);
            if (data && data.success) {
                setComposerStatus('Sent to ' + name, false);
                // A successful send is the ONLY thing that clears the draft —
                // the text, not the target: follow-up prompts usually go back
                // to the same seat, so the selection stays stored.
                writeDraft('');
                persistDraft();
            } else {
                // Keep the draft — a failed send must not cost the prompt.
                setComposerStatus('Send failed: ' + ((data && data.error) || 'unknown'), true);
            }
        } catch (err) {
            setComposerStatus('Send failed: ' + (err && err.message ? err.message : String(err)), true);
        } finally {
            sendInFlight = false;
            updateSendButton();
        }
    }

    /**
     * Called by dock.js each time the Composer tab is selected: refresh the
     * target list, then focus the textarea. The ~50ms delay mirrors the old
     * modal's focus, which had to out-wait the hidden-toggle reflow.
     */
    function activate() {
        void refreshTargets();
        setTimeout(() => { try { if (inputEl) { inputEl.focus(); } } catch { /* ignore */ } }, 50);
    }

    // Bind listeners once at module load — the markup is static.
    if (sendBtn) { sendBtn.addEventListener('click', () => void deliverComposerPrompt()); }
    if (targetSelectEl) {
        targetSelectEl.addEventListener('change', () => { updateSendButton(); persistDraft(); });
    }
    if (inputEl) {
        inputEl.addEventListener('input', () => { updateSendButton(); persistDraft(); });
        // Every keydown stops at the textarea so host-page handlers never
        // claim keys while composing (same reason as the old link modal).
        // Ctrl+Enter / Cmd+Enter sends. No Escape branch — there is nothing
        // to dismiss in a standing pane.
        inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void deliverComposerPrompt();
            }
        });
    }
    restoreDraft();
    updateSendButton();

    window.SwitchboardDockComposer = { activate, refreshTargets };
})();
