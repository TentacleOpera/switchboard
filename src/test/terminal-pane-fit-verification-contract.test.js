'use strict';

/**
 * Contract: the Terminals pane fit VERIFIES itself and retries.
 *
 * Source-text contract, not behavioural: the panel is a browser-only IIFE with no
 * export surface, and "the canvas is painting the old grid" is not observable from
 * Node. What CAN be pinned is the handful of decisions that are invisible on
 * inspection and each of which was wrong in a first pass.
 *
 * DECLARATION ORDER IS PART OF THE CONTRACT. The spans below are forward-only and
 * non-overlapping only if terminals.js declares, in this order:
 *   readRenderedGrid -> inspectPaneFit -> resyncPaneRenderer -> startFitLadder
 *   -> batchFitVisiblePanes -> const DEFAULT_ROLES
 * An inverted slice yields '' — which silently satisfies every negative assertion.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

function block(startMarker, endMarker) {
    const start = SRC.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = SRC.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found AFTER "${startMarker}": ${endMarker}`);
    assert.ok(end > start, `span is inverted — check declaration order: ${startMarker}`);
    return SRC.substring(start, end);
}

test('declaration order keeps every contract span forward-only', () => {
    const order = [
        'function readRenderedGrid(',
        'function inspectPaneFit(',
        'function resyncPaneRenderer(',
        'function startFitLadder(',
        'function batchFitVisiblePanes(',
        'const DEFAULT_ROLES'
    ].map(m => [m, SRC.indexOf(m)]);
    for (const [marker, at] of order) {
        assert.ok(at !== -1, `missing declaration: ${marker}`);
    }
    for (let i = 1; i < order.length; i++) {
        assert.ok(
            order[i][1] > order[i - 1][1],
            `${order[i][0]} must be declared after ${order[i - 1][0]}`
        );
    }
});

test('the fit is verified, not fired once and forgotten', () => {
    const batch = block('function batchFitVisiblePanes(', 'const DEFAULT_ROLES');
    assert.ok(batch.includes('startFitLadder'), 'batchFitVisiblePanes must drive the ladder');
    // The old body was a bare requestAnimationFrame around fitAndReportSize.
    assert.ok(!batch.includes('requestAnimationFrame'), 'the single-rAF body must be gone');
    assert.ok(!batch.includes('fitAndReportSize'), 'batchFitVisiblePanes must not fit directly');
});

test('a stale RENDERER is detected, not just a stale buffer', () => {
    assert.ok(SRC.includes('function readRenderedGrid('), 'the painted grid must be readable');
    assert.ok(SRC.includes("'stale-canvas'"), 'the stale-canvas verdict must exist');
    const inspect = block('function inspectPaneFit(', 'function resyncPaneRenderer(');
    assert.ok(inspect.includes('readRenderedGrid'), 'the verdict must consult the painted grid');
    assert.ok(inspect.includes('proposeDimensions'), 'the verdict must also check the buffer half');
});

test('an unreadable renderer is a retry, never a pass', () => {
    const inspect = block('function inspectPaneFit(', 'function resyncPaneRenderer(');
    // A null/'swapping' read means we could not tell. Returning 'ok' there would
    // reintroduce the original bug with extra steps.
    assert.ok(
        /painted === null[\s\S]{0,80}'unsettled'/.test(inspect),
        'an unreadable painted grid must resolve to unsettled'
    );
    const read = block('function readRenderedGrid(', 'function inspectPaneFit(');
    assert.ok(read.includes('hasRenderer'), 'a renderer swap must be distinguished from a bad read');
});

test('only a VERIFIED mismatch is reported to the shared pty', () => {
    const resync = block('function resyncPaneRenderer(', 'function startFitLadder(');
    // reconcileTerminalSize takes the MIN across clients, so an intermediate size
    // would flap the shared pty. The resync sends nothing at all.
    assert.ok(!resync.includes('fitAndReportSize'), 'resyncPaneRenderer must not report a size');
    assert.ok(!resync.includes("t: 'resize'"), 'resyncPaneRenderer must not send a resize frame');

    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    assert.ok(ladder.includes('fitAndReportSize'), 'the ladder is the only reporter');
    // fitAndReportSize sends unconditionally, even when fit() short-circuits, so an
    // 'unsettled' verdict must NOT reach it.
    assert.ok(
        /before === 'mismatch'\s*\)\s*\{\s*\n\s*fitAndReportSize/.test(ladder),
        'fitAndReportSize must be gated on a verified buffer mismatch alone'
    );
});

test('the renderer repair is gated on stale-canvas alone, and never resizes the buffer', () => {
    const resync = block('function resyncPaneRenderer(', 'function startFitLadder(');
    assert.ok(
        resync.includes("verdict !== 'stale-canvas'"),
        'a repair that runs on every layout change is a repair nobody can reason about'
    );
    assert.ok(
        resync.includes('_renderService.handleResize('),
        'the repair must drive the renderer directly — fit() cannot reach it once cols/rows match'
    );
    // A rows round-trip (resize(cols, rows - 1) then back) would also drive the
    // renderer, but it WRITES the buffer and can shift ybase when the viewport is
    // pinned to the bottom. handleResize only reads it.
    assert.ok(!resync.includes('term.resize('), 'the repair must not touch the buffer');
});

test('retries run off timers as well as rAF, so a hidden tab converges', () => {
    assert.ok(SRC.includes('FIT_SETTLE_DELAYS_MS'), 'the schedule must be named and reviewable');
    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    assert.ok(ladder.includes('setTimeout'), 'a backgrounded tab fires no rAF');
    assert.ok(ladder.includes('requestAnimationFrame'), 'attempt 0 must still land on a frame');
});

test('a newer request supersedes an in-flight ladder', () => {
    assert.ok(SRC.includes('fitLadderGen'), 'ladders must be generation-tracked');
    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    assert.ok(ladder.includes('fitLadderGen.get(name) !== gen'), 'each attempt must check its generation');
    assert.ok(SRC.includes('fitLadderGen.delete(name)'), 'destroyTerminalView must drop the generation');
});

test('the ladder gates on the RENDERED slots, not the padded assignment array', () => {
    const ladder = block('function startFitLadder(', 'function batchFitVisiblePanes(');
    // paneAssignments is padded to getMaxSlotCount() (nine) regardless of layout, so a
    // bare .includes() would also match a terminal parked off-screen.
    assert.ok(
        ladder.includes('paneAssignments.slice(0, getSlotCount(effectiveLayout))'),
        'a bare includes() would fit terminals that are not on screen'
    );
});

console.log(failed === 0 ? '\nAll pane-fit verification contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
