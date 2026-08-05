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

test('the scrollbar repair verifies the sync instead of trusting it', () => {
    const m = JS.match(/function refreshTerminalScrollbar\([\s\S]*?\n    \}/);
    assert.ok(m, 'refreshTerminalScrollbar not found');
    const body = m[0];

    // syncScrollArea(e) forwards e to Viewport._refresh(e); _refresh(false) only
    // schedules an rAF, so the default arg leaves the DOM stale and unverifiable
    // on the next line.
    assert.match(body, /syncScrollArea\(\s*true\s*\)/,
        'syncScrollArea must be called with true (synchronous refresh) or the DOM ' +
        'check below reads a pre-refresh layout');

    // The bug this guards: syncScrollArea self-suppresses unless the buffer length,
    // viewport height, scrollTop or device cell height changed. A long-lived pane at
    // the scrollback cap in a static grid matches none of them — buffer length is
    // pinned by eviction — so the call is a no-op in exactly the state the repair
    // exists for. Returning on the call alone made the overflowY fallback unreachable.
    assert.ok(!/syncScrollArea\([^)]*\);\s*\n\s*return;/.test(body),
        'must not return immediately after syncScrollArea — that makes the overflowY ' +
        'fallback dead code in the one state that needs it');

    assert.match(body, /scrollHeight[\s\S]{0,120}clientHeight/,
        'the repair must confirm against the DOM that the viewport can actually scroll');
    assert.match(body, /buffer[\s\S]{0,60}length\s*>\s*[\s\S]{0,30}rows/,
        'a thumb is only owed when the buffer exceeds the visible rows — in the alt ' +
        'buffer length === rows and returning early is correct, not a defect');

    // The fallback must still be after the primary path, not replaced by it.
    assert.match(body, /overflowY\s*=\s*'hidden'/,
        'the overflowY fallback was removed rather than made reachable');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
