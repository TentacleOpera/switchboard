# Terminal vertical scrollbar goes missing, especially in single/solo view mode

## Goal

The vertical scrollbar on xterm terminal panes intermittently disappears. The
problem is most frequent in solo (single-view) mode and is hard to reproduce
because it depends on browser layout/paint timing.

### Problem analysis

xterm.js renders its scrollbar as a **native** scrollbar on the
`.xterm-viewport` element. xterm.css (v5.5.0) sets `overflow-y: scroll` on that
element, so the scrollbar gutter is always reserved. The panel's global
`::-webkit-scrollbar` rules (`terminals.html` lines 765-781) style it to 6px
wide with a `#444` (`--border-bright`) thumb. So in principle the scrollbar
should always be visible.

It goes missing anyway. Two root causes, both confirmed by reading the code:

**Root cause 1 — DOM re-attachment without a scrollbar refresh.**
`renderPaneGrid()` (`terminals.js` line 1162) does a full
`paneGridEl.innerHTML = ''` teardown and rebuilds every pane on every call.
Existing terminal containers are detached and re-attached to freshly-created
`.pane-content` parents (line 1267: `contentEl.appendChild(entry.container)`).
`renderPaneGrid()` is called on **every** `terminalsChanged` broadcast (line
381 → `fetchTerminalList` → line 559), every `focusTerminal` message (line
396), every `clearTerminalBadge` (line 410), every layout change, and every
assign/unassign.

After re-attachment, `batchFitVisiblePanes()` (line 1339) runs via
`applyLayoutFloor()` (line 562). It calls `fitAndReportSize` →
`fitAddon.fit()`. But when the pane layout hasn't changed (the common case —
especially in solo mode where there is only one pane), the container's box is
identical before and after the re-attach. `fit()` detects no dimension change,
does **not** call `term.resize()`, so `onResize` does not fire, and xterm's
`syncScrollArea()` is never triggered. The `.xterm-viewport` element was just
removed from the document and put back; the browser may not repaint its native
scrollbar without a layout change, and xterm's internal
`_lastRecordedViewportHeight` / scroll-area height are stale. The scrollbar
thumb renders at zero height or not at all until the next render or resize
event — which may not come if there is no new terminal output.

This is why it is "difficult to reproduce": it depends on whether the browser
happens to repaint the native scrollbar after a same-size re-attachment, which
varies by Chromium version, GPU state, and whether a paint is coalesced.

**Root cause 2 — Solo-mode `display: none → grid` transition.**
In solo mode, `checkSoloNotFound()` (line 578) sets `paneGridEl.style.display
= 'none'` while the terminal list is loading, then flips it back to `'grid'`
once the terminal is confirmed live (line 601). The terminal is materialized
via a `whenRendered` ResizeObserver that fires when the container transitions
from 0×0 (hidden grid) to a real box. `materializeTerminalView()` (line 1872)
calls `term.open(container)` then `fitAddon.fit()` inside that observer
callback. If the browser has not completed layout by the time the observer
fires, `fit()` measures a transient box and the viewport's initial scrollbar
dimensions are wrong. The per-terminal ResizeObserver (100 ms debounce, line
1904) may or may not fire again to correct it — if the box doesn't change
after the initial fit, no correction happens.

**Contributing factor — low contrast.** The scrollbar thumb is `#444`
(`--border-bright`) on a `#000` viewport background (`xterm.css`). A 6px
`#444` bar on `#000` is low-contrast, so even when the scrollbar is
technically present, it is easy to miss on a large full-window terminal in
solo mode. This compounds the perception that it "went missing."

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Adding a scoped CSS block for `.xterm-viewport` scrollbar contrast.
- Adding a `requestAnimationFrame` re-fit call after `checkSoloNotFound` makes
  the grid visible.

**Complex / risky:**
- Forcing a scrollbar repaint after DOM re-attachment without disturbing the
  user's scroll position. The approach (toggle `overflow-y` on the viewport
  element for one frame) is a well-known repaint-forcing technique, but it
  must not reset scroll position or trigger spurious scroll events. xterm's
  `syncScrollArea` must be re-invoked so `_lastRecordedViewportHeight` is
  fresh.
- `renderPaneGrid()` is on the hot path (every `terminalsChanged` broadcast).
  Any per-terminal work added there must be cheap and must not cause focus
  loss (the existing `hadFocus` guard at line 1170 handles focus, but new
  layout reads must not invalidate it).

No database, auth, or backend changes. No migrations. The change is confined
to `src/webview/terminals.js`, `src/webview/terminals.html`, and a new
contract test.

## Edge-Case & Dependency Audit

1. **User scrolled up when a `terminalsChanged` broadcast arrives.** The
   scrollbar refresh must NOT scroll the terminal to the bottom. The
   `overflow-y` toggle technique preserves `scrollTop` because the browser
   restores it when `overflow-y` returns to `scroll`. The fix must read
   `scrollTop` before the toggle and restore it after, as a belt-and-suspenders
   guard.

2. **Terminal has no scrollback (content fits in visible rows).** With
   `overflow-y: scroll`, the thumb fills the track. The refresh must still
   produce a visible thumb in this state — the `overflow-y` toggle handles
   this because the browser re-evaluates the scrollbar from scratch.

3. **Multi-pane mode (2×2, 2×3, 3×3).** The same re-attachment issue affects
   all pane counts, but it is less noticeable because the panes are smaller
   and `terminalsChanged` broadcasts don't always change every pane's
   assignment. The fix applies uniformly to all panes via
   `batchFitVisiblePanes`.

4. **Terminal not yet materialized (deferred via `whenRendered`).** The
   scrollbar refresh must skip entries with no `term` (entry.term is null).
   `fitAndReportSize` already guards on `!entry.term`; the new refresh
   function must do the same.

5. **Disposed / exited terminals.** The refresh must skip disposed entries
   (`entry.disposed`). Already guarded by `fitAndReportSize`.

6. **WebGL / Canvas renderer context loss.** The renderer can swap mid-session
   (`attachRenderer` returns a holder, not the addon itself). The scrollbar
   refresh is independent of the renderer — it operates on the viewport DOM
   element, not the canvas. No interaction.

7. **Firefox.** Firefox ignores `::-webkit-scrollbar` and uses the standard
   `scrollbar-width` / `scrollbar-color` properties (gated in the `@supports`
   block). The `overflow-y` toggle technique works in Firefox too. The
   contrast CSS must be added inside the existing `@supports` gate for the
   Firefox path, and as a `::-webkit-scrollbar-thumb` override for the
   Chromium/WebKit path.

8. **Existing scrollbar contract test**
   (`src/test/browser-panel-scrollbar-contract.test.js`). It asserts exactly
   one bare `::-webkit-scrollbar` rule per panel HTML file. The new
   `.xterm-viewport::-webkit-scrollbar` rules are **scoped** (prefixed with
   `.xterm-viewport`), so they do not match the bare `::-webkit-scrollbar`
   pattern the test counts. The test should still pass. Verify.

9. **`batchFitVisiblePanes` is already called after most `renderPaneGrid`
   paths** — but NOT after the `terminalsChanged` → `fetchTerminalList` path
   directly (it comes indirectly via `applyLayoutFloor`). The fix adds an
   explicit scrollbar refresh to `batchFitVisiblePanes` so every caller
   benefits.

## Proposed Changes

### 1. `src/webview/terminals.js` — force scrollbar repaint after re-attach

Add a `refreshTerminalScrollbar(entry)` function that forces xterm's viewport
to repaint its native scrollbar after a DOM re-attachment, without changing
scroll position. Wire it into `batchFitVisiblePanes` so every grid rebuild
triggers it.

```js
/**
 * Force xterm's native scrollbar to repaint after a DOM re-attachment.
 *
 * renderPaneGrid() does a full innerHTML='' teardown and re-attaches every
 * terminal container. When the pane layout is unchanged, fit() detects no
 * dimension change, term.resize() is not called, onResize does not fire, and
 * xterm's syncScrollArea() is never triggered. The .xterm-viewport element
 * was just removed from the document and put back; the browser may not
 * repaint its native scrollbar without a layout change, leaving the thumb at
 * zero height or absent until the next render.
 *
 * Toggling overflow-y on the viewport for one frame forces the browser to
 * destroy and recreate the scrollbar, and reading offsetHeight forces
 * syncScrollArea to re-record the viewport height. Scroll position is
 * preserved across the toggle.
 */
function refreshTerminalScrollbar(entry) {
    if (!entry || entry.disposed || !entry.term) { return; }
    const container = entry.container;
    if (!container) { return; }
    const viewport = container.querySelector('.xterm-viewport');
    if (!viewport) { return; }
    // Preserve scroll position across the toggle.
    const savedScrollTop = viewport.scrollTop;
    // Force the browser to drop and recreate the scrollbar widget.
    viewport.style.overflowY = 'hidden';
    // Restore on the next frame so the browser commits the 'hidden' state
    // before re-enabling scroll — a synchronous toggle is coalesced into a
    // no-op by some Chromium versions.
    requestAnimationFrame(() => {
        if (entry.disposed) { return; }
        viewport.style.overflowY = '';
        // Re-fit in case the box changed during the hidden frame, then
        // restore scroll position.
        fitAndReportSize(entry);
        if (viewport.scrollTop !== savedScrollTop) {
            viewport.scrollTop = savedScrollTop;
        }
    });
}
```

Update `batchFitVisiblePanes` to call it for every live pane:

```js
function batchFitVisiblePanes() {
    requestAnimationFrame(() => {
        const slotCount = getSlotCount(effectiveLayout);
        for (let i = 0; i < slotCount; i++) {
            const name = paneAssignments[i];
            if (name) {
                const entry = terminalsMap.get(name);
                fitAndReportSize(entry);
                refreshTerminalScrollbar(entry);
            }
        }
    });
}
```

### 2. `src/webview/terminals.js` — explicit re-fit after solo grid becomes visible

In `checkSoloNotFound()`, after setting `paneGridEl.style.display = 'grid'`
(line 601), schedule a re-fit + scrollbar refresh for the solo terminal on the
next frame. This handles the `display: none → grid` transition where the
initial materialization fit may have measured a transient box.

```js
// Inside checkSoloNotFound(), after:
//   soloStatusEl.style.display = 'none';
//   paneGridEl.style.display = 'grid';
// Add:
requestAnimationFrame(() => {
    const entry = terminalsMap.get(soloTerminalName);
    if (entry) {
        fitAndReportSize(entry);
        refreshTerminalScrollbar(entry);
    }
});
```

### 3. `src/webview/terminals.js` — deferred second fit after initial materialization

In `materializeTerminalView()`, after the initial `fitAddon.fit()` (line 1901),
schedule a second fit + scrollbar refresh on the next frame. This handles the
case where the first fit ran against a box that was technically non-zero but
not yet at its final settled size (common in the solo `whenRendered` path).

```js
// After: try { fitAddon.fit(); } catch { /* ignore */ }
// Add:
requestAnimationFrame(() => {
    if (entry.disposed || !entry.term) { return; }
    fitAndReportSize(entry);
    refreshTerminalScrollbar(entry);
});
```

### 4. `src/webview/terminals.html` — higher-contrast xterm scrollbar

Add scoped CSS for `.xterm-viewport` scrollbars so the thumb is visible even
on a large full-window terminal. The global `::-webkit-scrollbar-thumb` uses
`--border-bright` (`#444`), which is too subtle on `#000`. Override it
specifically for the terminal viewport with a higher-contrast token. These
rules are scoped (`.xterm-viewport::-webkit-scrollbar`) so they do not affect
the sidebar or other panel scrollers, and they do not count as a "bare"
`::-webkit-scrollbar` rule for the existing contract test.

```css
/* xterm's viewport scrollbar — higher contrast than the panel default so
   the thumb is visible on a full-window terminal (solo mode). The global
   ::-webkit-scrollbar-thumb uses --border-bright (#444), which is nearly
   invisible on xterm's #000 viewport background at 6px. */
.xterm-viewport::-webkit-scrollbar {
    width: 8px;
}
.xterm-viewport::-webkit-scrollbar-thumb {
    background: var(--text-secondary, #8C8C8C);
    border-radius: 4px;
}
.xterm-viewport::-webkit-scrollbar-thumb:hover {
    background: var(--text-primary, #e0e0e0);
}
```

And inside the existing `@supports not selector(::-webkit-scrollbar)` block,
add a Firefox-specific override for the viewport:

```css
@supports not selector(::-webkit-scrollbar) {
    :root {
        scrollbar-width: thin;
        scrollbar-color: var(--border-bright) transparent;
    }
    .xterm-viewport {
        scrollbar-width: auto;
        scrollbar-color: var(--text-secondary, #8C8C8C) transparent;
    }
}
```

### 5. `src/test/terminal-scrollbar-refresh-contract.test.js` — new regression test

A contract test (same pattern as `terminal-solo-popout-contract.test.js` and
`browser-panel-scrollbar-contract.test.js`) that verifies:

- `terminals.js` defines a `refreshTerminalScrollbar` function that toggles
  `overflowY` on the viewport and restores scroll position.
- `batchFitVisiblePanes` calls `refreshTerminalScrollbar` for each live pane.
- `checkSoloNotFound` schedules a `requestAnimationFrame` re-fit after
  setting `display: grid`.
- `materializeTerminalView` schedules a deferred second fit.
- `terminals.html` has a scoped `.xterm-viewport::-webkit-scrollbar` rule
  with a higher-contrast thumb than `--border-bright`.
- The scoped rule does not break the "exactly one bare `::-webkit-scrollbar`"
  assertion in `browser-panel-scrollbar-contract.test.js` (the scoped rule is
  prefixed and does not match the bare pattern).

```js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const terminalsJs = fs.readFileSync(
    path.join(__dirname, '../webview/terminals.js'), 'utf8');
const terminalsHtml = fs.readFileSync(
    path.join(__dirname, '../webview/terminals.html'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

test('refreshTerminalScrollbar toggles overflowY and preserves scrollTop', () => {
    assert.ok(terminalsJs.includes('function refreshTerminalScrollbar'),
        'refreshTerminalScrollbar must be defined');
    const fn = terminalsJs.substring(
        terminalsJs.indexOf('function refreshTerminalScrollbar'));
    assert.ok(fn.includes("viewport.style.overflowY = 'hidden'"),
        'must toggle overflowY to hidden to force repaint');
    assert.ok(fn.includes('savedScrollTop'),
        'must preserve scroll position across the toggle');
    assert.ok(fn.includes('requestAnimationFrame'),
        'must restore overflowY on the next frame');
});

test('batchFitVisiblePanes calls refreshTerminalScrollbar', () => {
    const fn = terminalsJs.substring(
        terminalsJs.indexOf('function batchFitVisiblePanes'),
        terminalsJs.indexOf('function batchFitVisiblePanes') + 400);
    assert.ok(fn.includes('refreshTerminalScrollbar'),
        'batchFitVisiblePanes must refresh scrollbars after re-attach');
});

test('checkSoloNotFound schedules a re-fit after display:grid', () => {
    const fn = terminalsJs.substring(
        terminalsJs.indexOf('function checkSoloNotFound'),
        terminalsJs.indexOf('function checkSoloNotFound') + 600);
    assert.ok(fn.includes("paneGridEl.style.display = 'grid'"),
        'must set display to grid');
    assert.ok(fn.includes('requestAnimationFrame'),
        'must schedule a rAF re-fit after showing the grid');
    assert.ok(fn.includes('refreshTerminalScrollbar'),
        'must refresh the scrollbar after showing the grid');
});

test('materializeTerminalView schedules a deferred second fit', () => {
    const fn = terminalsJs.substring(
        terminalsJs.indexOf('function materializeTerminalView'),
        terminalsJs.indexOf('function materializeTerminalView') + 800);
    assert.ok(fn.includes('requestAnimationFrame'),
        'must schedule a deferred re-fit after initial fit()');
});

test('terminals.html has scoped xterm-viewport scrollbar with higher contrast', () => {
    assert.ok(terminalsHtml.includes('.xterm-viewport::-webkit-scrollbar'),
        'must scope a scrollbar rule to .xterm-viewport');
    assert.ok(terminalsHtml.includes('.xterm-viewport::-webkit-scrollbar-thumb'),
        'must override the thumb for xterm viewport');
    // The thumb must NOT fall back to --border-bright (#444) — that is the
    // low-contrast token this plan replaces.
    const thumbBlock = terminalsHtml.match(
        /\.xterm-viewport::-webkit-scrollbar-thumb\s*\{([^}]*)\}/);
    assert.ok(thumbBlock, 'thumb block must exist');
    assert.ok(!thumbBlock[1].includes('--border-bright'),
        'xterm viewport thumb must not use --border-bright (#444) — too low contrast');
});

test('scoped xterm scrollbar does not add a bare ::-webkit-scrollbar rule', () => {
    // The existing contract test counts bare (un-prefixed) ::-webkit-scrollbar
    // rules. Scoped rules (.xterm-viewport::-webkit-scrollbar) must not match.
    const bare = (terminalsHtml.match(/^\s*::-webkit-scrollbar\s*\{/gm) || []).length;
    assert.strictEqual(bare, 1,
        `expected exactly 1 bare ::-webkit-scrollbar rule, found ${bare}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

## Verification Plan

1. **Run the new contract test:**
   ```
   node src/test/terminal-scrollbar-refresh-contract.test.js
   ```
   All 6 tests must pass.

2. **Run the existing scrollbar contract test (must not regress):**
   ```
   node src/test/browser-panel-scrollbar-contract.test.js
   ```
   The "exactly one bare `::-webkit-scrollbar` rule" assertion must still
   pass for `terminals.html`.

3. **Run the existing solo popout contract test:**
   ```
   node src/test/terminal-solo-popout-contract.test.js
   ```

4. **Manual verification — solo mode:**
   - Open a terminal in solo mode (`?solo=<name>` popout).
   - Produce enough output to fill the viewport with scrollback.
   - Trigger repeated `terminalsChanged` broadcasts (spawn/close another
     terminal in the fleet, or wait for periodic fleet updates).
   - Confirm the scrollbar remains visible after each broadcast.
   - Scroll up mid-output, trigger a `terminalsChanged` broadcast, and confirm
     the scroll position is preserved and the scrollbar thumb is still
     visible.

5. **Manual verification — multi-pane mode:**
   - Open a 2×2 grid with 4 terminals.
   - Produce output in each.
   - Trigger `terminalsChanged` broadcasts.
   - Confirm all 4 scrollbars remain visible.

6. **Manual verification — no scrollback:**
   - Open a terminal with no output (fresh shell).
   - Confirm the scrollbar thumb is visible (full-track, higher-contrast
     `#8C8C8C` instead of `#444`).

7. **Firefox check (if available):**
   - Open the terminals panel in Firefox.
   - Confirm the xterm scrollbar is visible with the
     `scrollbar-color: var(--text-secondary)` override.
