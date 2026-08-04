# Terminal panes need a grabbable scrollbar and a jump-to-latest control

## Goal

Give every terminal pane in the browser Terminals panel a scrollbar the operator can actually see and drag, plus a "jump to latest" affordance that returns the view to the bottom in one click when they are scrolled up inside a long agent conversation.

### Observed problem

Scrolled up in the middle of a long conversation in a terminal pane, there is no visible way back to the bottom. The operator reads it as "there is no scrollbar for each terminal" and is left wheel-scrolling blindly, with no indication of how far from the bottom they are or when the terminal is still producing output.

### Root cause

Two separate gaps, both real. Both re-verified against the current source during this review; line numbers below are corrected to the live files.

**1. The scrollbar exists but is effectively invisible and un-grabbable.** `xterm.css` gives every terminal a permanent scroll track — `.xterm .xterm-viewport { overflow-y: scroll; }` (`src/webview/vendor/xterm/xterm.css:93-104`). But `terminals.html` styles all of its scrollers with one unscoped block written for the sidebar and dropdown lists (`src/webview/terminals.html:765-781`): `width: 6px`, `background: transparent` track, thumb `var(--vscode-scrollbarSlider-background, var(--border-bright))`. In a plain browser the `--vscode-*` variable does not exist, so the thumb resolves to `--border-bright: #444444` (`:28`) — a 6-pixel `#444` sliver against the terminal surface `--term-surface: #171717` (`:39`). `.terminal-view-host` also carries `padding: 8px` (`:359-367`), so that sliver sits 8 px in from the pane edge rather than flush against it, well outside where a pointer instinctively goes. At 2×2 and denser layouts it is essentially undiscoverable.

**2. There is no jump-to-bottom control at all.** `terminals.js` never calls `term.scrollToBottom()`, never subscribes to `term.onScroll`, and the pane header (`renderPaneGrid`, `src/webview/terminals.js:1162-1292`) offers only `clear` and `hide`. xterm auto-follows new output only while the viewport is already at the bottom, so once the operator scrolls up they stay parked there — with no signal that output is still arriving and no one-click way back. The reported difficulty is precisely this missing control; the invisible scrollbar is what removes the fallback.

### Root cause 2a — the part the first draft of this plan got wrong

`term.onScroll` alone cannot drive the control's visibility, because **it does not fire when the operator scrolls the viewport.** Traced through the vendored bundle (`src/webview/vendor/xterm/xterm.js`):

- `Viewport._handleScroll` (the DOM `scroll` handler on `.xterm-viewport`) emits `onRequestScrollLines({ amount, suppressScrollEvent: true })`.
- `Terminal` wires that to `this.scrollLines(e.amount, e.suppressScrollEvent, /* source */ 1)`, and `Terminal.scrollLines` special-cases source `1` as `super.scrollLines(e, t, i)` **plus** an explicit `this.refresh(0, this.rows - 1)` — the repaint that would otherwise have come from the scroll event.
- `BufferService.scrollLines` ends with `r !== s.ydisp && (t || this._onScroll.fire(s.ydisp))`. With `t === true` the fire is skipped.

So a wheel or thumb-drag repaints the terminal without ever reaching `term.onScroll`. Meanwhile `BufferService.scroll()` — the new-output path — ends with an **unconditional** `this._onScroll.fire(i.ydisp)`, and that path changes no `scrollTop`, so it never produces a DOM `scroll` event either. The two sources are strictly complementary: each covers exactly what the other misses.

## Metadata

- **Complexity:** 5
- **Tags:** ux, ui, frontend

> **Superseded:** **Complexity:** 4
> **Reason:** The control now needs two complementary event sources rather than one (see Root cause 2a), an explicit listener-teardown path for the non-disposable DOM listener, and a corrected containment assertion in the new test. Still majority-routine CSS plus one localized JS addition, but the event wiring is a real correctness surface rather than a single subscription.
> **Replaced with:** **Complexity:** 5

## User Review Required

- **Two event sources, not one.** The `term.onScroll`-only design in the first draft would have shipped a pill that never appears when the operator scrolls up in an *idle* terminal — which is a large share of the reported scenario (scroll back through a conversation the agent has finished). Confirm you are happy with the corrected dual wiring (viewport `scroll` + `term.onScroll`) before implementation.
- **The 8 px inset is not removed.** This plan widens the bar to 12 px but leaves `.terminal-view-host`'s `padding: 8px`, so the scrollbar still sits 8 px in from the pane edge rather than flush. Removing the right-hand padding would put it where a pointer flung at the pane edge actually lands, at the cost of the terminal text sitting flush against the pane border. Called out as a deliberate non-change — say if you want the padding dropped on the right.
- **Thumb contrast is a taste call.** `color-mix(in srgb, var(--text-secondary) 55%, transparent)` over `--term-surface` lands around `#5c5c5c`. Visible, but conservative. Bump the percentage in the manual pass if it still reads as faint on your display.
- **Pill wording and placement.** `↓ latest (N)` pinned bottom-right of the pane. Rejected alternatives: a full-width "N new lines" bar (steals a terminal row), and header-mounted (competes with `clear`/`hide`, which already degrade to initials at 2×3 and 3×3).

## Complexity Audit

### Routine

- The CSS change is additive and scoped to `.xterm-viewport`; nothing else on the panel is restyled.
- The pill is a single `<button>` hung off the existing `materializeTerminalView` / `destroyTerminalView` lifecycle. No socket, protocol or state changes.
- Sizing is already handled: `@xterm/addon-fit` subtracts the live scrollbar width before proposing dimensions — confirmed in the vendored bundle, `proposeDimensions()` computes `const r = 0 === this._terminal.options.scrollback ? 0 : e.viewport.scrollBarWidth` and deducts it. `materializeTerminalView` fits after `term.open()` (`terminals.js:1899-1902`) and the `ResizeObserver` re-fits on any box change, so no extra plumbing is needed.

### Complex / Risky

- **The dual event wiring is the correctness surface.** Neither source alone is sufficient (Root cause 2a). Wiring only `term.onScroll` produces a control that is silently wrong in the idle-terminal case; wiring only the DOM `scroll` event produces one that never updates its line count as output arrives. A future "simplification" that drops either is a regression the new test must catch by name.
- **The DOM `scroll` listener is not an xterm disposable.** `term.dispose()` does not remove it. It must be removed explicitly in `destroyTerminalView`, or an unassign/re-assign cycle accumulates listeners on detached viewport elements.
- **Hard constraint that must not be violated:** `src/test/browser-panel-scrollbar-contract.test.js` enforces three things per browser-served panel — exactly **one** *bare* (unscoped, line-initial) `::-webkit-scrollbar {` rule, a thumb whose fallback token is defined in the same file, and **no** `scrollbar-width` / `scrollbar-color` outside the `@supports not selector(::-webkit-scrollbar)` gate. In Chromium 121+ and Safari 17.4+, a scroller that resolves *either* standard property to any non-`auto` value has **all** of its `::-webkit-scrollbar-*` rules ignored — per scroller, and one property is enough to trigger it. The new rules are therefore written as `.xterm-viewport::-webkit-scrollbar` (scoped — does not match the bare-rule regex `^\s*::-webkit-scrollbar\s*\{`), and the Firefox override goes **inside** the existing `@supports` block.

  **The two properties do not have the same blast radius, and `scrollbar-color` is the dangerous one.** `scrollbar-width` is *not* inherited, so an ungated `:root { scrollbar-width: thin }` would kill webkit styling on the document scroller only. `scrollbar-color` *is* inherited, so an ungated `:root { scrollbar-color: … }` cascades a non-`auto` value onto **every scroller in the document**, including every `.xterm-viewport` — deleting the whole panel's scrollbar styling in one line, with no error and nothing else to notice. That asymmetry is why the gate is load-bearing rather than tidy, and it is the specific scenario the containment assertion in the new test must actually be able to fail on (the original unbounded regex could not — see the superseded note in §4).

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Handling |
| :--- | :--- |
| Output arriving while the operator drags the thumb | The two sources fire independently and `update()` is idempotent — it recomputes `baseY - viewportY` from scratch each time and returns early when the value is unchanged. No ordering dependency between them. |
| Terminal disposed between an event firing and `update()` running | `update()` early-returns on `entry.disposed || !entry.term`, and wraps the buffer read in try/catch. |
| Click landing after the term was disposed mid-press | The click handler's `scrollToBottom`/`focus` pair is wrapped in try/catch. |
| `renderPaneGrid()` rebuild mid-scroll | The pill is a child of `entry.container`, which `renderPaneGrid` re-parents whole (`terminals.js:1261-1269`); the pill and both listeners ride along untouched. |

### Security

- No new network surface, no new message types, no user-supplied content rendered. The pill's text is a locally computed integer. Nothing to audit.

### Side Effects

| Case | Handling |
| :--- | :--- |
| Existing scrollbar contract test | New rules are scoped selectors, so the "exactly one bare rule" assertion still sees exactly one. Firefox override lives inside the `@supports` gate, so the leak assertion still passes. |
| Firefox (ignores `::-webkit-scrollbar` entirely) | Add `.xterm-viewport { scrollbar-width: auto; scrollbar-color: var(--text-secondary) transparent; }` **inside** the existing `@supports` block. The `scrollbar-color` line is the one that does the work — see the superseded note under Proposed Changes §1. |
| Theme switch (afterburner ↔ claudify) | Style the thumb off existing panel custom properties, not literals, so `setThemeBodyClass` recolours it for free. The pill reuses `--accent-teal` / `--term-surface`, same as the pane chrome. |
| WebGL / canvas / DOM renderer | Scrolling is a viewport-DOM concern in all three; `attachRenderer`'s fallback chain (`terminals.js:174-199`) is untouched. |
| Terminal shorter than the viewport | `baseY === 0`, so the pill never shows. Its `display` is driven by state, not by hover. |
| 6-pane / 9-pane layouts | Pill is compact and absolutely positioned in the pane's bottom-right; it does not compete with the header, which already degrades to initials at those densities (`terminals.js:1219`). |
| `clear` button (`ptyClearTerminal`) | The clear sequence's `\x1b[3J` runs through `InputHandler.eraseInDisplay`, which resets `ybase`/`ydisp` and fires its own `_onScroll.fire(0)` — Terminal forwards that to `term.onScroll`. The pill therefore clears itself; no extra hook needed. |
| Widening the bar shrinks the terminal | FitAddon deducts `viewport.scrollBarWidth` (verified above) and the `ResizeObserver` re-fits. The pty is told the new size by `fitAndReportSize`. |
| Pane not yet materialised (`entry.term === null`) | The pill is created in `materializeTerminalView`, alongside the terminal it controls. `createTerminalView` only declares the fields as `null`. |
| Keyboard focus | The pill is `tabIndex = -1` so Tab never parks on it between the operator and the pty. It is pointer-reachable and carries an `aria-label`. |
| Clicking the pill must not steal the caret | `click` (not `mousedown`) so the pane's own `mousedown` selection runs first; then `term.scrollToBottom()` + `term.focus()`, with `stopPropagation()` so the click is not also read as a click into the terminal body. |
| Operator selecting text while scrolled up | Unchanged — the pill is a separate element with `pointer-events` only on itself. |
| Solo pop-out (`body.is-solo`) | Goes through the same `materializeTerminalView` path; no special casing. |

### Dependencies & Conflicts

- **xterm API surface, already vendored:** `term.onScroll`, `term.scrollToBottom()`, `term.buffer.active.{viewportY,baseY}`, `term.focus()`, `term.element`. No new libraries.
- **Shared file with the rename re-key plan.** `feature_plan_20260803150400_terminal-rename-blanks-scrollback.md` also edits `src/webview/terminals.js`, but in `renameTerminal` (`:1626`) and `connectTerminalSocket` (`:1938`) — disjoint from this plan's `materializeTerminalView` (`:1872`), `destroyTerminalView` (`:1762`) and `createTerminalView` (`:1804`). Land in either order; expect only a trivial merge in the entry literal at `:1821-1843` if both touch it.
- **Positive interaction with that plan.** Its client-side re-key preserves the whole `entry` object across a rename, so this plan's `scrollDisposable`, `jumpBtn`, `jumpViewport` and `jumpScrollHandler` survive it for free — and the operator's scroll position (and therefore the pill) survives too, instead of being reset by a destroy/replay.

## Dependencies

- None — no prior session artefacts are required. Both changes are self-contained in `src/webview/`.

## Adversarial Synthesis

**Risk summary.** The load-bearing risk was a silent behavioural gap, not a crash: xterm suppresses `onScroll` for operator-driven viewport scrolling (`suppressScrollEvent: true`), so an `onScroll`-only pill would never appear in an idle terminal — passing every source-level test while failing the actual reported use case. Mitigated by wiring both the viewport's native `scroll` event and `term.onScroll`, with a test that names each source. Secondary risks: the DOM listener is not an xterm disposable and must be removed by hand in `destroyTerminalView` or it leaks per unassign/re-assign cycle; and any un-scoping of the new CSS (or hoisting the Firefox override out of the `@supports` gate) silently deletes scrollbar styling across the whole panel — guarded by the existing `browser-panel-scrollbar-contract.test.js` plus a brace-matched containment check in the new test.

## Proposed Changes

### 1. `src/webview/terminals.html` — scoped terminal scrollbar

**Context.** The bare `::-webkit-scrollbar` block at `:765-781` is sized for the sidebar and dropdown lists. It is the only scrollbar styling in the file, and it must stay exactly one bare block (`browser-panel-scrollbar-contract.test.js`).

**Logic.** Add a *scoped* override for `.xterm-viewport` only. Scoped selectors beat the bare rule on specificity regardless of source order, and do not match the bare-rule regex the contract test counts.

**Implementation.** Insert immediately after the existing block (`:781`), keeping that block intact:

```css
        /* Terminal viewports only. The block above is sized for sidebar and
           dropdown lists; at 6px with a transparent track and a #444 thumb it is
           effectively invisible against --term-surface, and .terminal-view-host's
           8px padding sets it in from the pane edge where no pointer looks for it.
           SCOPED on purpose: browser-panel-scrollbar-contract.test.js requires
           exactly one BARE ::-webkit-scrollbar rule per panel file, and a second
           unscoped block would fail it. */
        .xterm-viewport::-webkit-scrollbar {
            width: 12px;
        }
        .xterm-viewport::-webkit-scrollbar-track {
            background: color-mix(in srgb, var(--text-primary) 6%, transparent);
        }
        .xterm-viewport::-webkit-scrollbar-thumb {
            background: color-mix(in srgb, var(--text-secondary) 55%, transparent);
            border-radius: 6px;
            border: 2px solid transparent;
            background-clip: content-box;
        }
        .xterm-viewport::-webkit-scrollbar-thumb:hover {
            background: var(--accent-teal);
            background-clip: content-box;
        }
```

Extend the existing Firefox gate (`:787-792`) — the properties stay inside it for the reason the comment there already gives:

```css
        @supports not selector(::-webkit-scrollbar) {
            :root {
                scrollbar-width: thin;
                scrollbar-color: var(--border-bright) transparent;
            }
            /* Gecko only — this whole block is gated off in Blink and WebKit.
               `scrollbar-color` IS inherited, so the #444 thumb above genuinely
               reaches the terminal viewport, and overriding it here is what does
               the work. `scrollbar-width` is NOT inherited — inner scrollers were
               already `auto` — so that line is belt-and-braces: it pins the intent
               so a later `scrollbar-width: thin` moved onto a wrapper cannot
               quietly thin the terminal bar.

               Do not "simplify" by lifting either property out of the gate. The
               inherited one is the trap: an ungated `scrollbar-color` cascades a
               non-auto value onto EVERY scroller in Chromium 121+ / Safari 17.4+,
               and each of them silently drops all of its ::-webkit-scrollbar
               rules. One line, whole panel, no error. */
            .xterm-viewport {
                scrollbar-width: auto;
                scrollbar-color: var(--text-secondary) transparent;
            }
        }
```

> **Superseded:** "Add `.xterm-viewport { scrollbar-width: auto; }` **inside** the existing `@supports` block so terminals get the wide native bar while the rest of the panel keeps `thin`."
> **Reason:** The stated rationale does not hold. `scrollbar-width` is a non-inherited property, so `:root { scrollbar-width: thin }` only ever applied to the document scroller — the sidebar and dropdown lists were already rendering at `auto` width in Firefox. The line is therefore not what makes the terminal bar wide. `scrollbar-color` *is* inherited, which is why the `#444` thumb genuinely does reach `.xterm-viewport` and genuinely does need overriding.
> **Replaced with:** Keep both declarations, but treat `scrollbar-color` as the functional one and `scrollbar-width: auto` as an explicit intent pin, per the corrected comment above. (Flagged under Uncertain Assumptions — worth a one-line confirmation.)

**Edge cases.** `color-mix()` is already used elsewhere in this file (`:155`, `:168`), so no new baseline is assumed. The 2 px transparent border with `background-clip: content-box` makes the *painted* thumb 8 px inside a 12 px track — deliberate, so the thumb reads as a pill rather than a slab.

### 2. `src/webview/terminals.html` — jump-to-latest pill styling

**Context.** `.terminal-view-host` (`:359-367`) is `position: absolute`, so it is already a containing block for an absolutely positioned child. `.pane-content` is at `:679`.

**Logic.** Anchor the pill to the view host, not the pane, so it is re-parented with the terminal on every `renderPaneGrid()` rebuild. Drive visibility from a state class, never from `:hover` — an operator who does not know the control exists will never hover for it.

**Implementation.** Add near the `.pane-content` / `.terminal-view-host` rules:

```css
        /* Anchored to the view host, not the pane, so it is re-parented with the
           terminal on every renderPaneGrid() rebuild. Hidden by state rather than
           hover — an operator who does not know it exists never hovers for it.
           right: 22px clears the 12px scrollbar with room to spare. */
        .jump-to-latest {
            position: absolute;
            right: 22px;
            bottom: 12px;
            display: none;
            align-items: center;
            gap: 4px;
            padding: 3px 9px;
            font-size: 11px;
            font-family: inherit;
            line-height: 1.4;
            color: var(--term-surface);
            background: var(--accent-teal);
            border: none;
            border-radius: 10px;
            cursor: pointer;
            z-index: 3;
            box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
        }
        .jump-to-latest.visible { display: inline-flex; }
        .jump-to-latest:hover { filter: brightness(1.12); }
```

**Edge cases.** Offsets on an abspos child resolve against the *padding box* of `.terminal-view-host`, i.e. inside its 8 px padding — so `right: 22px` sits 22 px in from the padding edge, clear of the 12 px bar. `.terminal-view-host` sets no `overflow`, so nothing clips the pill.

### 3. `src/webview/terminals.js` — build and drive the control

**Context.** `materializeTerminalView` (`:1872-1935`) is where the terminal is actually constructed; `entry.rendererAddon = attachRenderer(term, entry);` is at `:1899`. `destroyTerminalView` is at `:1762-1801`, with `term.dispose()` at `:1796`. The `createTerminalView` entry literal is at `:1821-1843`.

**Logic.** One button per materialised view, visibility derived from `baseY - viewportY`, updated from **both** event sources for the reason established in Root cause 2a. Cache the last value so a firehose does not write `textContent` on every frame.

**Implementation.** In `materializeTerminalView`, immediately after `:1899`:

```js
        attachJumpToLatest(entry, term, container);
```

New function, placed beside `materializeTerminalView`:

```js
    /**
     * A pinned "jump to latest" pill for a pane that is scrolled off the bottom.
     *
     * xterm only auto-follows new output while the viewport is already at the
     * bottom, so an operator who scrolled up inside a long agent conversation
     * stays parked there with no signal that output is still arriving. The
     * scrollbar is the only other way back, and even widened it is a 12px bar
     * inset 8px from the pane edge — a poor primary control at 2x2 and denser.
     *
     * TWO event sources, and BOTH are required:
     *  - The viewport's native `scroll` event covers the OPERATOR scrolling
     *    (wheel, thumb drag, keyboard). term.onScroll does NOT fire for these:
     *    Viewport._handleScroll emits onRequestScrollLines with
     *    suppressScrollEvent:true, and Terminal.scrollLines handles source
     *    VIEWPORT by calling refresh(0, rows-1) itself, so
     *    BufferService.scrollLines skips _onScroll.fire entirely.
     *  - term.onScroll covers NEW OUTPUT advancing baseY while the operator stays
     *    parked. BufferService.scroll() fires it unconditionally, and that path
     *    mutates no scrollTop, so it never produces a DOM scroll event.
     * Drop either one and the pill is silently wrong in a case the operator hits
     * on first use: onScroll-only never appears in an idle terminal, DOM-only
     * never updates its count as output arrives.
     */
    function attachJumpToLatest(entry, term, container) {
        const btn = document.createElement('button');
        btn.className = 'jump-to-latest';
        btn.type = 'button';
        // The terminal owns the keyboard. A tabbable button inside the pane would
        // put a stop between the operator and the pty for a control they reach by
        // pointer anyway.
        btn.tabIndex = -1;
        btn.title = 'Scroll to the latest output';
        btn.setAttribute('aria-label', 'Scroll to the latest output');
        btn.textContent = '↓ latest';
        container.appendChild(btn);
        entry.jumpBtn = btn;

        // Cached so a firehose does not rewrite textContent on every flush. Starts
        // at -1 so the first call always paints.
        let lastBehind = -1;
        const update = () => {
            if (entry.disposed || !entry.term) { return; }
            let behind = 0;
            try {
                const buf = term.buffer.active;
                behind = Math.max(0, buf.baseY - buf.viewportY);
            } catch { return; }
            if (behind === lastBehind) { return; }
            lastBehind = behind;
            btn.classList.toggle('visible', behind > 0);
            btn.textContent = behind > 0 ? `↓ latest (${behind})` : '↓ latest';
        };

        // click, NOT mousedown: the pane's own mousedown handler must run first so
        // the press also selects the pane (see renderPaneGrid). stopPropagation
        // keeps the click from being read a second time as a click into the
        // terminal body.
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                term.scrollToBottom();
                term.focus();
            } catch { /* term disposed mid-click */ }
            update();
        });

        // term.element exists: this runs after term.open(container).
        const viewport = term.element && term.element.querySelector('.xterm-viewport');
        if (viewport) {
            viewport.addEventListener('scroll', update, { passive: true });
            // Retained for teardown — a DOM listener is not an xterm disposable and
            // term.dispose() will not remove it.
            entry.jumpViewport = viewport;
            entry.jumpScrollHandler = update;
        }
        entry.scrollDisposable = term.onScroll(update);
        update();
    }
```

> **Superseded:** `entry.scrollDisposable = term.onScroll(update);` as the sole visibility driver, with the comment "onScroll fires both when the operator scrolls and when new output advances baseY, so the pill's line count stays live with no polling."
> **Reason:** Factually wrong against the vendored xterm build. `Viewport._handleScroll` fires `onRequestScrollLines({ amount, suppressScrollEvent: true })` and `BufferService.scrollLines` gates its `_onScroll.fire` on that flag, so operator-driven scrolling never reaches `term.onScroll`. The pill would not appear when scrolling up in an idle terminal — the exact reported scenario — and would not disappear when the operator scrolled back down by hand. Every source-level test would still have passed.
> **Replaced with:** The dual wiring above — the viewport's native `scroll` event for operator scrolling, `term.onScroll` for output advancing `baseY` — with a matching assertion in the new test so a later "simplification" back to one source fails loudly.

In `destroyTerminalView`, immediately before the `if (entry.term)` dispose block at `:1795`:

```js
        // Not an xterm disposable — term.dispose() will not remove it, and the
        // viewport element outlives this call only through these two fields.
        if (entry.jumpViewport && entry.jumpScrollHandler) {
            try { entry.jumpViewport.removeEventListener('scroll', entry.jumpScrollHandler); } catch { /* ignore */ }
        }
        entry.jumpViewport = null;
        entry.jumpScrollHandler = null;
        if (entry.scrollDisposable) {
            try { entry.scrollDisposable.dispose(); } catch { /* ignore */ }
            entry.scrollDisposable = null;
        }
        entry.jumpBtn = null;
```

Add the four fields to the entry literal in `createTerminalView` (`:1839-1842`) so the shape stays declared in one place:

```js
            resizeObserver: null,
            pendingObserver: null,
            scrollDisposable: null,
            jumpBtn: null,
            jumpViewport: null,
            jumpScrollHandler: null,
            exited: false,
            disposed: false
```

**Edge cases.** `update()` runs once at attach time so a view materialised into an already-scrolled buffer paints correctly. `entry.disposed` is set at the top of `destroyTerminalView` (`:1766`), before the teardown above, so any listener that fires mid-teardown short-circuits.

### 4. `src/test/terminal-scroll-affordance-contract.test.js` — new test

```js
'use strict';
/**
 * Contract: terminal panes carry a visible scrollbar and a jump-to-latest control.
 *
 * Two things this guards.
 *
 * SCOPING. browser-panel-scrollbar-contract.test.js requires exactly ONE bare
 * ::-webkit-scrollbar rule per panel file and forbids scrollbar-width/color
 * outside the @supports gate; a well-meaning future edit that unscopes these
 * terminal rules, or hoists the Firefox override, silently deletes scrollbar
 * styling across the whole panel with no error.
 *
 * DUAL EVENT SOURCES. term.onScroll does NOT fire for operator-driven viewport
 * scrolling — xterm's Viewport passes suppressScrollEvent:true and repaints via
 * refresh() instead. The DOM scroll event does not fire for new output advancing
 * baseY, because that path changes no scrollTop. Collapsing the two back into one
 * "simpler" subscription reintroduces a silent behavioural bug, so both are
 * asserted by name.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.html'), 'utf8');
const JS = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/** Body of the first @supports not selector(::-webkit-scrollbar) block, brace-matched. */
function webkitGateBody(css) {
    const m = /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)\s*\{/.exec(css);
    if (!m) { return null; }
    const start = m.index + m[0].length;
    let i = start, depth = 1;
    while (i < css.length && depth > 0) {
        if (css[i] === '{') { depth++; }
        else if (css[i] === '}') { depth--; }
        i++;
    }
    return css.slice(start, i - 1);
}

test('the terminal viewport scrollbar is styled and wider than the list default', () => {
    const m = HTML.match(/\.xterm-viewport::-webkit-scrollbar\s*\{([^}]*)\}/);
    assert.ok(m, 'no .xterm-viewport::-webkit-scrollbar rule');
    const width = /width:\s*(\d+)px/.exec(m[1]);
    assert.ok(width && Number(width[1]) >= 10,
        `expected >= 10px so it is grabbable on a dark pane, got: ${m[1].trim()}`);
});

test('the terminal rules stay scoped — the bare rule count is still 1', () => {
    const count = (HTML.match(/^\s*::-webkit-scrollbar\s*\{/gm) || []).length;
    assert.strictEqual(count, 1,
        'browser-panel-scrollbar-contract.test.js requires exactly one bare rule per panel');
});

test('the Firefox terminal override stays inside the @supports gate', () => {
    const body = webkitGateBody(HTML);
    assert.ok(body, 'no @supports not selector(::-webkit-scrollbar) block');
    const RULE = /\.xterm-viewport\s*\{[^}]*scrollbar-(?:width|color)/;
    assert.match(body, RULE, 'the .xterm-viewport override must be inside the gate');
    // Brace-matched, not a non-greedy [\s\S]*? scan: an unbounded scan would happily
    // match a rule that had LEAKED past the gate's closing brace, i.e. it would pass
    // in exactly the situation this test exists to catch.
    assert.ok(!RULE.test(HTML.replace(body, '')),
        'ungated scrollbar-width/color makes Chromium 121+ / Safari 17.4+ drop every ::-webkit-scrollbar rule');
});

test('a jump-to-latest control is built for each materialised view', () => {
    assert.match(JS, /function attachJumpToLatest\(/, 'attachJumpToLatest missing');
    assert.match(JS, /term\.scrollToBottom\(\)/, 'the control must actually scroll to bottom');
});

test('visibility is driven by BOTH event sources', () => {
    const m = JS.match(/function attachJumpToLatest\([\s\S]*?\n    \}/);
    assert.ok(m, 'attachJumpToLatest not found');
    assert.match(m[0], /term\.onScroll\(/,
        'without term.onScroll the line count never advances as new output arrives');
    assert.match(m[0], /addEventListener\('scroll'/,
        'without the viewport DOM scroll listener the pill never appears when the ' +
        'operator scrolls up in an idle terminal — xterm suppresses onScroll for ' +
        'operator-driven viewport scrolling (suppressScrollEvent: true)');
});

test('both listeners are torn down with the view', () => {
    const m = JS.match(/function destroyTerminalView\([\s\S]*?\n    \}/);
    assert.ok(m, 'destroyTerminalView not found');
    assert.match(m[0], /scrollDisposable[\s\S]{0,80}dispose\(\)/,
        'an undisposed onScroll listener outlives its terminal');
    assert.match(m[0], /removeEventListener\('scroll'/,
        'the DOM scroll listener is not an xterm disposable — term.dispose() will not ' +
        'remove it, so it leaks once per unassign/re-assign cycle');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

> **Superseded:** the original gate assertion, `assert.match(HTML, /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)\s*\{[\s\S]*?\.xterm-viewport\s*\{[^}]*scrollbar-width/)`.
> **Reason:** `[\s\S]*?` is unbounded and will scan straight past the gate's closing brace. If a future edit hoisted `.xterm-viewport { scrollbar-width: … }` out of the `@supports` block, that regex would still find it and the test would pass — in precisely the scenario it exists to catch.
> **Replaced with:** `webkitGateBody()` above — brace-matched extraction, assert the rule is present inside the gate body and absent from the remainder of the file.

## Verification Plan

### Automated Tests

Not run during this planning pass (the session directed no compilation and no test execution). Run them at implementation time:

1. **New test:** `node src/test/terminal-scroll-affordance-contract.test.js` — 6 passing.
2. **The guard it must not break:** `node src/test/browser-panel-scrollbar-contract.test.js` — still fully green, including the `terminals.html` cases.
3. **Other terminal suites:** `node src/test/terminal-solo-popout-contract.test.js`, `node src/test/shell-terminal-strip.test.js`.

### Manual

4. **Scrollbar:**
   - Open the browser Terminals panel, produce a long buffer (`for i in $(seq 1 800); do echo "line $i"; done`).
   - **Expected:** a clearly visible thumb on the right edge of the pane, wide enough to grab on the first attempt, that highlights to the accent colour on hover and drags the view smoothly.
   - Repeat in the 1, 2×1, 2×2 and 3×3 layouts — visible and draggable in each.
   - If the thumb still reads as faint on your display, raise the `55%` in the `color-mix` and re-check.
5. **Jump to latest — the idle case (the regression the dual wiring exists for):**
   - Produce the long buffer, let the command **finish**, then scroll up ~200 lines with the wheel.
   - **Expected:** the pill appears immediately, showing the number of lines behind, with no further output arriving. This is the case an `onScroll`-only implementation would fail.
   - Scroll back to the bottom by hand — the pill disappears on its own, again with no output.
6. **Jump to latest — the live case:**
   - Scroll up while output is still streaming. The count increases without the view scrolling.
   - Click the pill: the view jumps to the bottom, the pill disappears, and the caret is in that terminal (typing goes straight to the pty).
   - With a terminal whose output is shorter than the pane, the pill never appears.
7. **Clear:** with the pill visible, press the pane's `clear` button — the pill must clear itself (no stale count over an empty terminal).
8. **Theme:** toggle afterburner ↔ claudify with a pane scrolled up; thumb and pill both recolour with the panel, no leftover teal on claudify.
9. **Layout churn:** with the pill visible, switch layouts and resize the window — `renderPaneGrid` re-parents the view and the pill must ride along and remain correct.
10. **No leak:** unassign the pane, wait past the 15 s detach grace, re-assign; no duplicate pill, and devtools → Memory shows no growth in retained detached `.xterm-viewport` nodes after several cycles.
11. **Firefox:** repeat steps 4–6 in Firefox — the native terminal scrollbar must be visibly brighter than the `#444` the panel default inherits onto it. Not a defect if it reverts to system rendering under OS High Contrast: `@media (forced-colors: active)` overrides custom `scrollbar-color` by design.
12. **Both hosts:** confirm under the extension-hosted server and under `npx switchboard` standalone.

## Resolved Assumptions

No open uncertainties remain. The four CSS-behaviour questions this plan rested on were confirmed by web research (2026-08-03, against CSS Scrollbars Styling Module Level 1, MDN, Chromium 121 / Safari 17.4 release notes and Firefox Bugzilla #1460109). Shipped behaviour matches spec in all four cases — no divergence found.

1. **`scrollbar-width` is `Inherited: no`; `scrollbar-color` is `Inherited: yes`.** Confirmed. So `:root { scrollbar-width: thin }` never reached the panel's inner scrollers — sidebar and dropdown lists were already rendering at platform-default `auto` width in Firefox — while `:root { scrollbar-color: … }` *did* inherit down and is the reason the `#444` thumb reaches `.xterm-viewport`. The corrected rationale in §1 stands; the CSS shipped is unchanged.
2. **A nested scroller's own `scrollbar-color` overrides the inherited value in Firefox.** Confirmed by normal cascade. Two caveats recorded for the manual pass: `scrollbar-color: auto` hands rendering back to the platform, where `color-scheme: dark` then applies (this panel sets `color-scheme: dark` at `:root`), and `@media (forced-colors: active)` overrides custom scrollbar colours back to system high-contrast rendering — so the terminal bar will not honour these tokens under OS High Contrast. Acceptable; that is the correct behaviour for that mode.
3. **`@supports not selector(::-webkit-scrollbar)` is a reliable Gecko-only gate.** Confirmed false in Chromium 121+ and Safari 17.4+, true in Firefox 128+. Gecko never implemented the pseudo-element and has no plans to; Blink and WebKit retained it alongside the standard properties. No change planned in any engine that would invalidate the gate.
4. **Any non-`auto` standard scrollbar property suppresses all `::-webkit-scrollbar-*` rules, per scroller, and one property is enough.** Confirmed. Combined with (1), this is why an ungated `scrollbar-color` is far more dangerous than an ungated `scrollbar-width`: the inherited one cascades the suppression onto every scroller in the document at once. Captured in the Complex / Risky bullet and in the gate comment in §1.

Everything else in this plan was verified directly against the source in this workspace: the xterm `suppressScrollEvent` path, `BufferService.scroll`'s unconditional fire, `InputHandler.eraseInDisplay`'s `_onScroll.fire(0)`, FitAddon's `viewport.scrollBarWidth` deduction, the contract test's regexes, and every cited line number.

---

**Recommendation: Send to Coder** (complexity 5).

## Completion Report

Implemented a 12px grabbable scrollbar for terminal viewports and a pinned "jump to latest" (`↓ latest (N)`) button for scrolled-up terminal panes. Files modified: `src/webview/terminals.html` (scoped CSS and jump button styles), `src/webview/terminals.js` (`attachJumpToLatest` dual event source wiring and lifecycle teardown), and added contract test `src/test/terminal-scroll-affordance-contract.test.js`. No issues encountered during implementation.

## Review Findings

One MAJOR, fixed in this pass: `terminal-scroll-affordance-contract.test.js` was defined but never invoked — no `package.json` script and no CI step — so the plan's primary gate could not fail a build; added `test:contract:terminal-scroll-affordance` to `package.json` and a named step to `.github/workflows/integration-tests.yml`. All 16 assertions from the plan's Verification Plan pass (new test 6/6, `browser-panel-scrollbar-contract` 40/40, plus 10 further terminal contract suites green); `tsc --noEmit` reports only 5 pre-existing unrelated `TS2835` import-extension errors in `src/services/*`. Regression analysis found no defects: `materializeTerminalView` has one call site and guards on `entry.term` (no double pill), pane selection is on `mousedown` (`terminals.js:1388`) so the pill's `click` + `stopPropagation` cannot break it, `renderPaneGrid` re-parents the whole container (`:1570`) so the pill and both listeners ride along, `removeEventListener` still matches despite the `passive` option, and the dual-source claim was re-verified in the vendored bundle (`get onScroll(){return this._core.onScroll}`, `suppressScrollEvent:!0`, `viewportY→ydisp`, `baseY→ybase`). Remaining risks are all NIT and deferred: `entry.jumpBtn` is a write-only field; the pill's `z-index: 3` sits below xterm's own `z-index` 5/10 layers (harmless only because both are transparent and `pointer-events: none`); `right: 22px` leaves 2px clearance over the 12px bar; and the plan's "clear self-heals via `\x1b[3J`" claim is not this repo's to make — `clearPty` writes `/clear\r` and the reset depends on the agent CLI's response (behaviour is correct either way, but manual step 7 is the real check). Manual steps 4–12, including the Firefox and idle-terminal cases, remain unexecuted and still need an operator pass.
