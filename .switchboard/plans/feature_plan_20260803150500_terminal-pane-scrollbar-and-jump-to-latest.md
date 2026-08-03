# Terminal panes need a grabbable scrollbar and a jump-to-latest control

## Goal

Give every terminal pane in the browser Terminals panel a scrollbar the operator can actually see and drag, plus a "jump to latest" affordance that returns the view to the bottom in one click when they are scrolled up inside a long agent conversation.

### Observed problem

Scrolled up in the middle of a long conversation in a terminal pane, there is no visible way back to the bottom. The operator reads it as "there is no scrollbar for each terminal" and is left wheel-scrolling blindly, with no indication of how far from the bottom they are or when the terminal is still producing output.

### Root cause

Two separate gaps, both real:

**1. The scrollbar exists but is effectively invisible and un-grabbable.** `xterm.css` gives every terminal a permanent scroll track — `.xterm .xterm-viewport { overflow-y: scroll; }` (`src/webview/vendor/xterm/xterm.css:93-104`). But `terminals.html` styles all of its scrollers with one unscoped block written for the sidebar and dropdown lists (`src/webview/terminals.html:723-740`): `width: 6px`, `background: transparent` track, thumb `var(--vscode-scrollbarSlider-background, var(--border-bright))`. In a plain browser the `--vscode-*` variable does not exist, so the thumb resolves to `--border-bright: #444444` (`:28`) — a 6-pixel `#444` sliver against the terminal surface `--term-surface: #171717`. `.terminal-view-host` also carries `padding: 8px` (`:359-367`), so that sliver sits 8 px in from the pane edge rather than flush against it, well outside where a pointer instinctively goes. At 2×2 and denser layouts it is essentially undiscoverable.

**2. There is no jump-to-bottom control at all.** `terminals.js` never calls `term.scrollToBottom()`, never subscribes to `term.onScroll`, and the pane header (`renderPaneGrid`, `src/webview/terminals.js:1078-1146`) offers only `clear` and `hide`. xterm auto-follows new output only while the viewport is already at the bottom, so once the operator scrolls up they stay parked there — with no signal that output is still arriving and no one-click way back. The reported difficulty is precisely this missing control; the invisible scrollbar is what removes the fallback.

## Metadata

- **Complexity:** 4
- **Tags:** ux, ui, frontend

## Complexity Audit (Routine vs Complex/Risky)

**Routine, with one hard constraint to respect.**

- The CSS change is additive and scoped to `.xterm-viewport`; nothing else on the panel is restyled.
- The JS change adds a per-entry DOM node and two listeners, hung off the existing `materializeTerminalView` / `destroyTerminalView` lifecycle. No socket, protocol or state changes.

**Constraint that must not be violated:** `src/test/browser-panel-scrollbar-contract.test.js` enforces three things per browser-served panel — exactly **one** *bare* (unscoped, line-initial) `::-webkit-scrollbar {` rule, a thumb whose fallback token is defined in the same file, and **no** `scrollbar-width` / `scrollbar-color` outside the `@supports not selector(::-webkit-scrollbar)` gate. Hoisting either standard property to top level makes Chromium 121+ and Safari 17.4+ ignore *every* `::-webkit-scrollbar` rule on that scroller, silently deleting the panel's styling. The new rules are therefore written as `.xterm-viewport::-webkit-scrollbar` (scoped — does not match the bare-rule regex `^\s*::-webkit-scrollbar\s*\{`), and the Firefox width override goes **inside** the existing `@supports` block.

**Sizing note:** widening the terminal scrollbar reduces the pane's usable width by a few pixels, which `FitAddon` already accounts for on the next `fit()`. `materializeTerminalView` fits after `term.open()` and the `ResizeObserver` re-fits on any box change, so no extra plumbing is needed.

## Edge-Case & Dependency Audit

| Case | Handling |
| :--- | :--- |
| Existing scrollbar contract test | New rules are scoped selectors, so the "exactly one bare rule" assertion still sees exactly one. Firefox override lives inside the `@supports` gate, so the leak assertion still passes. |
| Firefox (ignores `::-webkit-scrollbar` entirely) | Add `.xterm-viewport { scrollbar-width: auto; }` **inside** the existing `@supports` block so terminals get the wide native bar while the rest of the panel keeps `thin`. |
| Theme switch (afterburner ↔ claudify) | Style the thumb off existing panel custom properties, not literals, so `setThemeBodyClass` recolours it for free. The jump button reuses `--accent-teal` / `--term-surface`, same as the pane chrome. |
| WebGL / canvas / DOM renderer | Scrolling is a viewport-DOM concern in all three; `attachRenderer`'s fallback chain (`terminals.js:173-199`) is untouched. |
| Terminal shorter than the viewport | `baseY === 0`, so the button never shows. Its `display` is driven by state, not by hover. |
| 6-pane / 9-pane layouts | Button is icon-only and absolutely positioned in the pane's bottom-right; it does not compete with the header, which already degrades to initials at those densities (`terminals.js:1115`). |
| `renderPaneGrid()` rebuilds | The button belongs to `entry.container`, not the pane element, so it survives re-parenting exactly as the xterm instance does. |
| Pane not yet materialised (`entry.term === null`) | The button is created in `materializeTerminalView`, alongside the terminal it controls. |
| View disposal | `destroyTerminalView` already removes `entry.container` from the DOM (`terminals.js:1680-1682`); the `onScroll` disposable is stored on the entry and disposed with the term. |
| New output while scrolled up | `onScroll` fires as `baseY` advances, so the button appears/updates without polling. |
| Clicking the button must not steal the caret | Call `term.scrollToBottom()` then `term.focus()`, and `stopPropagation()` so the pane's `mousedown` handler still selects the pane. |
| Operator selecting text while scrolled up | Unchanged — the button is a separate element with `pointer-events` only on itself. |

**Dependencies:** xterm.js API surface already vendored — `term.onScroll`, `term.scrollToBottom()`, `term.buffer.active.{viewportY,baseY}`, `term.focus()`. No new libraries.

## Proposed Changes

### 1. `src/webview/terminals.html` — scoped terminal scrollbar

Add immediately after the existing unscoped scrollbar block (`:723-740`), keeping that block intact:

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

Extend the existing Firefox gate (`:745-750`) — the properties stay inside it for the reason the comment there already gives:

```css
        @supports not selector(::-webkit-scrollbar) {
            :root {
                scrollbar-width: thin;
                scrollbar-color: var(--border-bright) transparent;
            }
            /* Terminals want the full-width native bar, not the thin one the
               sidebar lists use. */
            .xterm-viewport {
                scrollbar-width: auto;
                scrollbar-color: var(--text-secondary) transparent;
            }
        }
```

### 2. `src/webview/terminals.html` — jump-to-latest button styling

Add near the `.pane-content` / `.terminal-view-host` rules (`:359-368`, `:679`):

```css
        /* Anchored to the view host, not the pane, so it is re-parented with the
           terminal on every renderPaneGrid() rebuild. Hidden by state rather than
           hover — an operator who does not know it exists never hovers for it. */
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

### 3. `src/webview/terminals.js` — build and drive the control

In `materializeTerminalView`, after `entry.rendererAddon = attachRenderer(term, entry);` (`:1899`):

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
     * scrollbar is the only other way back and it is a 12px sliver inset 8px from
     * the pane edge — a poor primary control at 2x2 and denser layouts.
     */
    function attachJumpToLatest(entry, term, container) {
        const btn = document.createElement('button');
        btn.className = 'jump-to-latest';
        btn.type = 'button';
        btn.title = 'Scroll to the latest output';
        btn.textContent = '↓ latest';
        // mousedown so the pane's own mousedown selection still runs first; the
        // click must not also be read as a click into the terminal body.
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                term.scrollToBottom();
                term.focus();
            } catch { /* term disposed mid-click */ }
            update();
        });
        container.appendChild(btn);
        entry.jumpBtn = btn;

        const update = () => {
            if (entry.disposed || !entry.term) { return; }
            let behind = 0;
            try {
                const buf = term.buffer.active;
                behind = Math.max(0, buf.baseY - buf.viewportY);
            } catch { return; }
            btn.classList.toggle('visible', behind > 0);
            btn.textContent = behind > 0 ? `↓ latest (${behind})` : '↓ latest';
        };

        // onScroll fires both when the operator scrolls and when new output
        // advances baseY, so the pill's line count stays live with no polling.
        entry.scrollDisposable = term.onScroll(update);
        update();
    }
```

In `destroyTerminalView`, before `term.dispose()` (`:1677`):

```js
        if (entry.scrollDisposable) {
            try { entry.scrollDisposable.dispose(); } catch { /* ignore */ }
            entry.scrollDisposable = null;
        }
        entry.jumpBtn = null;
```

Add the two fields to the entry literal in `createTerminalView` (`:1703-1725`) so the shape stays declared in one place:

```js
            resizeObserver: null,
            pendingObserver: null,
            scrollDisposable: null,
            jumpBtn: null,
            exited: false,
            disposed: false
```

### 4. `src/test/terminal-scroll-affordance-contract.test.js` — new test

```js
'use strict';
/**
 * Contract: terminal panes carry a visible scrollbar and a jump-to-latest control.
 *
 * The important assertion is the scoping one. browser-panel-scrollbar-contract.js
 * requires exactly ONE bare ::-webkit-scrollbar rule per panel file and forbids
 * scrollbar-width/color outside the @supports gate; a well-meaning future edit
 * that unscopes these terminal rules, or hoists the Firefox override, silently
 * deletes scrollbar styling across the whole panel with no error.
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

test('scrollbar-width overrides stay inside the @supports gate', () => {
    const gated = /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)\s*\{[\s\S]*?\.xterm-viewport\s*\{[^}]*scrollbar-width/;
    assert.match(HTML, gated,
        'ungated scrollbar-width makes Chromium 121+ / Safari 17.4+ drop every ::-webkit-scrollbar rule');
});

test('a jump-to-latest control is built for each materialised view', () => {
    assert.match(JS, /function attachJumpToLatest\(/, 'attachJumpToLatest missing');
    assert.match(JS, /term\.scrollToBottom\(\)/, 'the control must actually scroll to bottom');
    assert.match(JS, /term\.onScroll\(/, 'visibility must be driven by onScroll, not polling');
});

test('the scroll listener is disposed with the view', () => {
    const m = JS.match(/function destroyTerminalView\([\s\S]*?\n    \}/);
    assert.ok(m, 'destroyTerminalView not found');
    assert.match(m[0], /scrollDisposable[\s\S]{0,80}dispose\(\)/,
        'an undisposed onScroll listener outlives its terminal');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

## Verification Plan

1. **New test:** `node src/test/terminal-scroll-affordance-contract.test.js` — 5 passing.
2. **The guard it must not break:** `node src/test/browser-panel-scrollbar-contract.test.js` — still fully green, including the `terminals.html` cases.
3. **Other terminal suites:** `node src/test/terminal-solo-popout-contract.test.js`, `node src/test/shell-terminal-strip.test.js`.
4. **Manual — scrollbar:**
   - Open the browser Terminals panel, produce a long buffer (`for i in $(seq 1 800); do echo "line $i"; done`).
   - **Expected:** a clearly visible thumb on the right edge of the pane, wide enough to grab on the first attempt, that highlights to the accent colour on hover and drags the view smoothly.
   - Repeat in the 1, 2×1, 2×2 and 3×3 layouts — visible and draggable in each.
5. **Manual — jump to latest:**
   - Scroll up ~200 lines. The pill appears in the pane's bottom-right showing the number of lines behind.
   - Let the terminal keep producing output — the count increases without scrolling the view.
   - Click the pill: the view jumps to the bottom, the pill disappears, and the caret is in that terminal (typing goes straight to the pty).
   - Scroll back to the bottom by hand: the pill disappears on its own.
   - With a terminal whose output is shorter than the pane, the pill never appears.
6. **Theme:** toggle afterburner ↔ claudify with a pane scrolled up; thumb and pill both recolour with the panel, no leftover teal on claudify.
7. **Layout churn:** with the pill visible, switch layouts and resize the window — `renderPaneGrid` re-parents the view and the pill must ride along and remain correct.
8. **No leak:** unassign the pane, wait past the 15 s detach grace, re-assign; no duplicate pill, and devtools shows no growth in retained listeners after several cycles.
9. **Firefox:** repeat steps 4–5 in Firefox — the native terminal scrollbar must be the wide variant while sidebar lists stay thin.
10. **Both hosts:** confirm under the extension-hosted server and under `npx switchboard` standalone.
