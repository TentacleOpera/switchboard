// terminalKeyBar.js — Mobile terminal key bar.
//
// Phone keyboards have no arrow keys, no Esc, no Tab, no Ctrl. A terminal
// without those keys cannot answer a menu. This module synthesizes the
// terminal control sequences a phone keyboard cannot type and delivers them
// through the same `encodeInputFrame` the desktop terminals panel uses, so
// the gateway sees them as real keystrokes — not pasted text.
//
// Loaded as a classic <script> (CSP: script-src 'nonce-...' 'self'). Exposes
// window.SwitchboardTerminalKeyBar.create(deps) → a key bar controller.
//
// deps:
//   container       HTMLElement the key bar is rendered into.
//   send            (string) => void  — delivers a UTF-8 input frame payload
//                   (the bytes the gateway's input frame carries, NOT a paste).
//                   The caller is responsible for framing: it MUST route
//                   through encodeInputFrame and ws.send, never term.paste.
//   getCursorMode   () => 'application' | 'normal'  — DECCKM, read at PRESS
//                   time. The mode flips during a session (vim, less, fzf),
//                   so a value captured at attach goes stale; the bar reads
//                   it on every press.
//   isCoarsePointer () => boolean  — true on touch surfaces. The bar is
//                   hidden on fine-pointer (desktop) viewports.
//
// Design notes:
//   - pointerdown + preventDefault on every key. A click handler would let
//     the soft keyboard dismiss before the synthetic keystroke landed, which
//     is the exact "I pressed arrow and the keyboard vanished" complaint.
//   - Sticky Ctrl. Phone keyboards have no chord, so Ctrl is a latch: press
//     Ctrl, the next key is Ctrl+that. The latch clears on the next press
//     (Enter/Esc/Tab/arrows/letter) or on a second Ctrl tap (cancel).
//   - DECCKM-aware arrows. Normal cursor mode sends ESC [ X; application
//     cursor mode sends ESC O X. Read at press time — never cached.
(function() {
    'use strict';

    window.SwitchboardTerminalKeyBar = { create: createTerminalKeyBar };

    function createTerminalKeyBar(deps) {
        if (!deps || !deps.container || typeof deps.send !== 'function') {
            throw new Error('SwitchboardTerminalKeyBar.create: container and send are required');
        }
        const container = deps.container;
        const send = deps.send;
        const getCursorMode = typeof deps.getCursorMode === 'function'
            ? deps.getCursorMode
            : () => 'normal';
        const isCoarsePointer = typeof deps.isCoarsePointer === 'function'
            ? deps.isCoarsePointer
            : () => (typeof window !== 'undefined'
                && window.matchMedia
                && window.matchMedia('(pointer: coarse)').matches);

        let ctrlArmed = false;
        let disposed = false;
        const buttons = [];

        // Coarse-pointer visibility gate. The bar is built unconditionally so
        // a viewport that flips pointer type at runtime (rare, but a tablet
        // with a paired mouse does it) can re-evaluate; the CSS class is the
        // single source of truth the operator sees.
        function syncVisibility() {
            if (disposed) return;
            const coarse = isCoarsePointer();
            container.classList.toggle('sb-keybar-hidden', !coarse);
            container.classList.toggle('sb-keybar-visible', !!coarse);
        }

        function deliver(bytes) {
            if (disposed) return;
            // Every synthesized key goes through `send`, which the caller
            // routes through encodeInputFrame + ws.send. NEVER paste: a paste
            // would land as bracketed-paste text, not a keystroke, and a TUI
            // reading a single arrow would see the whole bracketed block.
            try { send(bytes); } catch { /* disposed mid-press */ }
        }

        // DECCKM-aware arrow. Normal mode: ESC [ X. Application mode: ESC O X.
        // The mode is read at PRESS time — a value captured at attach goes
        // stale the moment the operator enters vim or less.
        function arrowSeq(letter) {
            const mode = getCursorMode() === 'application' ? 'application' : 'normal';
            const intro = mode === 'application' ? '\x1bO' : '\x1b[';
            return intro + letter;
        }

        // Ctrl+letter: the control code is the letter's index in the alphabet
        // masked to 0x1f. Ctrl-C → 0x03, Ctrl-D → 0x04, Ctrl-Z → 0x1a. Only the
        // letters we expose on the bar (c, d, z) are wired here; the bar does
        // not synthesize arbitrary Ctrl chords.
        function ctrlLetter(letter) {
            const lower = letter.toLowerCase();
            const code = lower.charCodeAt(0) - 96; // 'a' = 1 → 0x01
            if (code < 1 || code > 26) { return ''; }
            return String.fromCharCode(code & 0x1f);
        }

        function setCtrlArmed(armed) {
            ctrlArmed = armed;
            for (const b of buttons) {
                if (b.dataset.key === 'ctrl') {
                    b.classList.toggle('sb-keybar-armed', !!armed);
                }
            }
        }

        function handlePress(key) {
            if (disposed) return;
            switch (key) {
                case 'up':       deliver(arrowSeq('A')); break;
                case 'down':     deliver(arrowSeq('B')); break;
                case 'right':    deliver(arrowSeq('C')); break;
                case 'left':     deliver(arrowSeq('D')); break;
                case 'enter':    deliver('\r'); break;
                case 'esc':      deliver('\x1b'); break;
                case 'tab':      deliver('\t'); break;
                case 'ctrl': {
                    // Sticky toggle: first tap arms, second tap cancels.
                    setCtrlArmed(!ctrlArmed);
                    return; // do not clear the latch below
                }
                case 'ctrl-c':   deliver('\x03'); setCtrlArmed(false); break;
                case 'ctrl-d':   deliver(ctrlLetter('d')); setCtrlArmed(false); break;
                case 'ctrl-z':   deliver(ctrlLetter('z')); setCtrlArmed(false); break;
                default: return;
            }
            // A bar key consumes the latch. The latch's real target is the NEXT
            // character typed on the SOFT KEYBOARD — see applyCtrlLatch — because
            // that is the half of the keyboard the bar does not own and the half
            // that has no chord. A bar key pressed while armed delivered its own
            // plain sequence above (the Ctrl variants of the arrows and Enter are
            // not worth a second row of buttons on a phone), so all that is left
            // is to drop the latch rather than leave it armed for a keystroke the
            // operator no longer expects it to modify.
            if (key !== 'ctrl' && ctrlArmed) {
                setCtrlArmed(false);
            }
        }

        /**
         * Consume the sticky-Ctrl latch against a character on its way to the pty.
         *
         * The embedder installs this on the terminal's outgoing data path (the
         * viewport's `transformInput` seam), so a letter typed on the soft
         * keyboard while Ctrl is armed leaves as its control code — which is the
         * whole point of a latch on a keyboard with no chord. Returns `data`
         * unchanged when the latch is not armed, so it is identity on every
         * keystroke but the one immediately after a Ctrl tap.
         *
         * Only a single character is rewritten: a paste or a multi-byte escape
         * sequence arriving while armed is passed through untouched (and clears
         * the latch), because Ctrl+<a whole paste> is not a thing an operator can
         * have meant.
         */
        function applyCtrlLatch(data) {
            if (disposed || !ctrlArmed || typeof data !== 'string' || data.length === 0) { return data; }
            setCtrlArmed(false);
            if (data.length !== 1) { return data; }
            // Ctrl maps @A-Z[\]^_ (0x40-0x5F) to 0x00-0x1F; lowercase letters
            // fold to their uppercase first. Space is the conventional Ctrl-@
            // (NUL). Anything else has no control code and is sent as typed.
            const upper = data.toUpperCase();
            const code = upper.charCodeAt(0);
            if (code >= 0x40 && code <= 0x5f) { return String.fromCharCode(code & 0x1f); }
            if (data === ' ') { return '\x00'; }
            return data;
        }

        function makeButton(label, key, opts) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sb-keybar-btn';
            btn.dataset.key = key;
            btn.textContent = label;
            // tabIndex -1: the terminal owns the keyboard. A tabbable bar
            // button would put a stop between the operator and the pty for a
            // control they reach by pointer anyway.
            btn.tabIndex = -1;
            if (opts && opts.wide) { btn.classList.add('sb-keybar-btn-wide'); }
            // pointerdown, NOT click: a click handler fires after the soft
            // keyboard's blur, which dismisses the keyboard. preventDefault
            // on pointerdown suppresses the focus shift that would trigger
            // that blur, so the keyboard stays up.
            btn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handlePress(key);
            });
            // Touch devices synthesize a click after pointerdown; suppress it
            // so it does not re-focus the terminal and fight the keyboard.
            btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
            container.appendChild(btn);
            buttons.push(btn);
            return btn;
        }

        function build() {
            container.innerHTML = '';
            container.className = 'sb-keybar';
            makeButton('←', 'left');
            makeButton('↓', 'down');
            makeButton('↑', 'up');
            makeButton('→', 'right');
            makeButton('Tab', 'tab');
            makeButton('Esc', 'esc');
            makeButton('Enter', 'enter', { wide: true });
            makeButton('Ctrl', 'ctrl');
            makeButton('Ctrl-C', 'ctrl-c');
            makeButton('Ctrl-D', 'ctrl-d');
            makeButton('Ctrl-Z', 'ctrl-z');
            syncVisibility();
        }

        // Re-evaluate pointer-coarse on resize/orientation change. A tablet
        // with a paired mouse flips fine↔coarse at runtime; the bar must
        // follow without a reload.
        let pointerQuery = null;
        try {
            pointerQuery = (typeof window !== 'undefined' && window.matchMedia)
                ? window.matchMedia('(pointer: coarse)') : null;
        } catch { /* matchMedia unavailable */ }
        let pointerHandler = null;
        if (pointerQuery && typeof pointerQuery.addEventListener === 'function') {
            pointerHandler = () => syncVisibility();
            pointerQuery.addEventListener('change', pointerHandler);
        }

        build();

        return {
            // Re-evaluate coarse-pointer visibility (call after a viewport
            // resize or pointer-type change).
            refresh: syncVisibility,
            // Install on the terminal's outgoing data path so a soft-keyboard
            // character typed while Ctrl is armed leaves as its control code.
            applyCtrlLatch,
            // Tear down listeners and empty the container. Idempotent.
            dispose() {
                if (disposed) return;
                disposed = true;
                if (pointerQuery && pointerHandler && typeof pointerQuery.removeEventListener === 'function') {
                    try { pointerQuery.removeEventListener('change', pointerHandler); } catch { /* ignore */ }
                }
                pointerQuery = null;
                pointerHandler = null;
                buttons.length = 0;
                container.innerHTML = '';
                container.className = '';
            }
        };
    }
})();
