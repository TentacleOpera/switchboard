'use strict';

/**
 * Contract tests for shell modal panel presentation (Memo as modal).
 *
 * These are source-text assertions: the failure modes (partial interception,
 * dropping the frame, destroying it on close, native title tooltips) are all
 * silent in the browser, so the build is the cheapest place to pin them.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const shellJs = fs.readFileSync(path.join(__dirname, '../webview/shell.js'), 'utf8');
const shellHtml = fs.readFileSync(path.join(__dirname, '../webview/shell.html'), 'utf8');
const manifestSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

test('the memo manifest entry carries presentation: modal', () => {
    assert.ok(
        /\{\s*id:\s*'memo',[^\n]*presentation:\s*'modal'/.test(manifestSrc),
        "the memo manifest entry must carry presentation: 'modal'"
    );
});

test('selectPanel intercepts modal ids before assigning activePanel', () => {
    const fn = block(shellJs, 'function selectPanel(id) {', 'function buildMaskedGlyph');
    const modalHasAt = fn.indexOf('modalPanels.has(id)');
    const activeAt = fn.indexOf('activePanel = id');
    assert.ok(modalHasAt !== -1, 'selectPanel must check modalPanels.has(id)');
    assert.ok(activeAt !== -1, 'selectPanel must still assign activePanel');
    assert.ok(modalHasAt < activeAt, 'modal interception must precede activePanel assignment');
});

test('selectPanel toggle loops both skip modal ids', () => {
    const fn = block(shellJs, 'function selectPanel(id) {', 'function buildMaskedGlyph');
    const skips = (fn.match(/if\s*\(\s*modalPanels\.has\(pid\)\s*\)\s*\{\s*continue;\s*\}/g) || []).length;
    assert.strictEqual(skips, 2, 'both toggle loops must `continue` when modalPanels.has(pid)');
});

test('closeModal never destroys the modal frame', () => {
    const fn = block(shellJs, 'function closeModal() {', 'function toggleModal');
    // classList.remove() is the class toggling this function is BUILT on (the icon's
    // is-active, the host's is-open), so a bare /\.remove\(/ matches the correct
    // implementation and the guard is red on arrival. Mask it out first; what is
    // actually forbidden is removing the FRAME from the DOM.
    const structural = fn.replace(/classList\.remove\(/g, 'classList.__clear(');
    assert.ok(!/\.src\s*=/.test(structural), 'closeModal must not reassign frame src');
    assert.ok(!/\.remove\(/.test(structural), 'closeModal must not remove the frame');
    assert.ok(!/frames\.delete\(/.test(structural), 'closeModal must not unregister the frame');
});

test('shell.js still sets no native title tooltips', () => {
    assert.ok(!/\.title\s*=/.test(shellJs), 'shell.js must not set native title tooltips');
});

test('shell.html body markup keeps #content and #tooltip-overlay as siblings', () => {
    const body = block(shellHtml, '<body>', '<script');
    // #agent-dock is a third body-level flex child sitting between #content and
    // the overlay, so the two are no longer adjacent. The invariant that matters
    // is that the overlay stays at BODY level — nested inside #content or the
    // dock it would be clipped and painted invisible.
    assert.ok(
        /(?:<div id="content"><\/div>|<\/aside>)\s*<div id="tooltip-overlay"><\/div>/.test(body),
        'the overlay must remain a body-level sibling of #content'
    );
});

const total = passed + failed;
console.log(`\n${total} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
