'use strict';

/**
 * Contract: a terminal pane's GPU renderer is acquired only against a real box and is
 * handed back — for real, not just on paper — when it stops having one.
 *
 * Source-text contract, in the style of terminal-pane-fit-verification-contract.test.js:
 * the panel is a browser-only IIFE with no export surface, and "the process actually
 * freed a WebGL slot" is not observable from Node.
 *
 * The failure mode this file exists for is SILENT SUCCESS. `WebglAddon.dispose()` does
 * not release the GL context — it leaves the live WebGL2 context to the garbage
 * collector, and the browser's per-process ceiling is charged against the live context,
 * not against our intent to drop it. A release path that only disposes therefore
 * satisfies every in-panel signal (`liveWebglContexts`, `isWebgl`, `rendererDeferred`,
 * `__sbTerminalStats()`) while the process budget is completely unchanged. Assertions 3
 * and 4 below are the only guards against that, which is why they are separate tests
 * rather than clauses hanging off the accounting one.
 *
 * DECLARATION ORDER IS PART OF THE CONTRACT — see the last test. The new functions must
 * be declared ABOVE `readRenderedGrid`, because terminal-pane-fit-verification-contract
 * slices spans between `readRenderedGrid -> inspectPaneFit -> resyncPaneRenderer ->
 * startFitLadder -> batchFitVisiblePanes -> const NO_ROLE`. Declaring any of them
 * between those markers silently widens another suite's spans.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');
const VP = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminalViewport.js'), 'utf8');
const ADDON = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'vendor', 'xterm', 'addon-webgl.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

function block(startMarker, endMarker, source) {
    const src = source || VP;
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found AFTER "${startMarker}": ${endMarker}`);
    assert.ok(end > start, `span is inverted — check declaration order: ${startMarker}`);
    return src.substring(start, end);
}

// attachRenderer through the release/reconcile helpers that follow it.
const RENDERER_BLOCK = () => block('function attachRenderer(term, entry)', 'function forceReleaseWebglContext');

test('exactly one increment, exactly one decrement path', () => {
    const increments = VP.match(/liveWebglContexts\+\+/g) || [];
    assert.strictEqual(increments.length, 1, 'exactly one increment site');
    assert.ok(RENDERER_BLOCK().includes('liveWebglContexts++'),
        'the single increment must live inside attachRenderer');

    // Any decrement outside the one-shot closure is the hand-paired accounting this
    // design replaced: four sites keyed on entry.isWebgl is how a counter drifts low
    // (over-allocating) or high (pinning every pane to canvas for the life of the page).
    const decrements = VP.match(/liveWebglContexts(--|\s*-=|\s*=\s*Math\.max\(0, liveWebglContexts - 1\))/g) || [];
    assert.strictEqual(decrements.length, 1,
        'exactly one decrement, and it must be the holder.release closure');
    const release = RENDERER_BLOCK();
    const closureAt = release.indexOf('holder.release = () => {');
    const decrementAt = release.indexOf('liveWebglContexts = Math.max(0, liveWebglContexts - 1)');
    assert.ok(closureAt !== -1 && decrementAt > closureAt,
        'the decrement must sit inside holder.release, not merely near it');
});

test('release() is one-shot', () => {
    assert.ok(
        /holder\.release = \(\) => \{\s*\n\s*if \(released\) \{ return; \}\s*\n\s*released = true;/.test(RENDERER_BLOCK()),
        'the closure must guard on `released` and set it BEFORE the decrement — a swap followed by a late context loss would otherwise decrement twice'
    );
});

test('the context is actually handed back, not merely disposed', () => {
    const release = RENDERER_BLOCK();
    assert.ok(/released = true;[\s\S]{0,600}?forceReleaseWebglContext\(webgl\)/.test(release),
        'holder.release must call forceReleaseWebglContext — dispose() alone leaves the live context to GC and frees no process budget');

    const force = block('function forceReleaseWebglContext(addon)', 'function reconcileRendererForVisibility(');
    assert.ok(force.includes("addon._renderer && addon._renderer._gl"),
        'the helper must reach the context through addon._renderer._gl');
    assert.ok(force.includes("getExtension('WEBGL_lose_context')"),
        'WEBGL_lose_context is the only way to hand a context back explicitly');
    assert.ok(force.includes('ext.loseContext()'),
        'getting the extension without calling loseContext() frees nothing');
});

test('the vendored private path forceReleaseWebglContext depends on still exists', () => {
    // An xterm bump that renames these must break the BUILD, not the feature: the
    // failure mode of a renamed hop is a silent no-op inside a try/catch.
    assert.ok(ADDON.includes('this._renderer'), 'vendored addon no longer exposes this._renderer');
    assert.ok(ADDON.includes('this._gl'), 'vendored addon no longer exposes this._gl');
    assert.ok(/getContext\("webgl2"|getContext\('webgl2'/.test(ADDON),
        'vendored addon no longer acquires a webgl2 context');
    // If a future xterm starts releasing properly we want to find out and DELETE our
    // helper, not double-release.
    assert.ok(!ADDON.includes('loseContext'),
        'the vendored addon now references loseContext itself — re-verify forceReleaseWebglContext before shipping, it may now double-release');
});

test('onContextLoss is guarded against our own deliberate loss', () => {
    const release = RENDERER_BLOCK();
    const handlerAt = release.indexOf('webgl.onContextLoss(');
    assert.ok(handlerAt !== -1, 'the loss handler must exist');
    const handler = release.slice(handlerAt);
    const guardAt = handler.indexOf('if (released) { return; }');
    assert.ok(guardAt !== -1,
        'loseContext() fires webglcontextlost straight back into this handler while swapRenderer is mid-teardown — without the guard it double-attaches');
    assert.ok(guardAt < handler.indexOf('holder.release()'),
        'the guard must be the first statement, ahead of the release it protects');
});

test('ordering: release -> dispose -> attach, in both release sites', () => {
    const swap = block('function swapRenderer(entry, wantWebgl)', 'function cancelRendererRelease(');
    const sRelease = swap.indexOf('outgoing.release()');
    const sTry = swap.indexOf('try {', sRelease);
    const sDispose = swap.indexOf('.dispose()', sRelease);
    const sAttach = swap.indexOf('entry.rendererAddon =', sRelease);
    assert.ok(sRelease !== -1 && sDispose !== -1 && sAttach !== -1, 'swapRenderer must release, dispose and attach');
    assert.ok(sRelease < sDispose,
        'release BEFORE dispose — dispose() drops addon._renderer, and with it the only path to the context');
    assert.ok(sRelease < sTry,
        'release OUTSIDE the try wrapping dispose() — a throwing dispose() must still give the budget back');
    assert.ok(sDispose < sAttach,
        'dispose BEFORE attach — two loaded renderers on one Terminal is not a supported xterm state');

    const destroy = block('function destroyTerminalView(name)', 'function createTerminalView(');
    const dRelease = destroy.indexOf('entry.rendererAddon.release()');
    const dTry = destroy.indexOf('try {', dRelease);
    const dDispose = destroy.indexOf('.dispose()', dRelease);
    assert.ok(dRelease !== -1, 'destroyTerminalView must route the drop through the holder');
    assert.ok(dRelease < dDispose && dRelease < dTry,
        'same ordering in destroyTerminalView: release, outside and before the dispose try');
});

test('every release site goes through the holder', () => {
    const release = RENDERER_BLOCK();
    assert.ok(release.slice(release.indexOf('webgl.onContextLoss(')).includes('holder.release()'),
        'onContextLoss must release through the holder');
    assert.ok(block('function swapRenderer(entry, wantWebgl)', 'function cancelRendererRelease(').includes('outgoing.release()'),
        'swapRenderer must release through the holder');
    assert.ok(block('function destroyTerminalView(name)', 'function createTerminalView(').includes('entry.rendererAddon.release()'),
        'destroyTerminalView must release through the holder');
});

test('every renderer swap ends in a repaint, guarded on actually having a box', () => {
    const swap = block('function swapRenderer(entry, wantWebgl)', 'function cancelRendererRelease(');
    // deps.resyncPaneRenderer: the viewport module takes the panel's repaint as a
    // constructor dependency rather than closing over a panel global.
    assert.ok(/if \(isRendered\(entry\.container\)\) \{ deps\.resyncPaneRenderer\(entry, 'stale-canvas'\); \}/.test(swap),
        'an on-screen swap strands every already-drawn row unless it repaints; a boxless one must NOT repaint, or handleResize measures a zero cell');
    // Permanently guards the already-landed onContextLoss repair too.
    const release = RENDERER_BLOCK();
    assert.ok(release.slice(release.indexOf('webgl.onContextLoss(')).includes("deps.resyncPaneRenderer(entry, 'stale-canvas')"),
        'the context-loss handler must still repaint — the canvas renderer starts empty and paints only rows later marked dirty');
});

test('WebGL acquisition is gated on a box, not only on the per-document cap', () => {
    const release = RENDERER_BLOCK();
    assert.ok(release.includes('const hasBox = entry ? isRendered(entry.container) : true;'),
        'acquisition must re-read the box: swapRenderer re-enters attachRenderer on the upgrade path');
    assert.ok(release.includes('webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS'),
        'MAX_WEBGL_CONTEXTS counts THIS document only — a pop-out is a second document in the same process with its own counter at zero, so the box check is not redundant with it');
});

test('no exit from attachRenderer leaves a terminal with no renderer', () => {
    const release = RENDERER_BLOCK();
    const canvasFallbacks = release.match(/holder\.current = attachCanvasRenderer\(term\)/g) || [];
    assert.ok(canvasFallbacks.length >= 3,
        'the constructor-throw, budget/boxless and context-loss paths must each fall back to canvas');
});

test('the debt expression is the availability check, not !hasBox', () => {
    const release = RENDERER_BLOCK();
    // A budget-exhausted pane is owed a retry; !hasBox would record `false` for it and
    // strand it on canvas for the life of the page.
    assert.ok(release.includes('if (entry) { entry.rendererDeferred = webglAvailable(); }'),
        'the canvas exit must record the debt as webglAvailable(), never !hasBox');
    assert.ok(!release.includes('rendererDeferred = !hasBox'),
        '!hasBox misreports an exhausted budget as "nothing owed"');
    // A constructor that threw will throw again next tick — retrying per tick is the
    // churn this machinery exists to avoid.
    const throwArm = release.slice(release.indexOf('WebGL renderer unavailable'));
    assert.ok(throwArm.includes('entry.rendererDeferred = false;'),
        'the constructor-throw path must retire the pane rather than re-arming a debt');
});

test('the release is debounced, cancellable, and torn down', () => {
    const arm = block('function armRendererRelease(entry)', 'function buildTerminalTheme(');
    assert.ok(arm.includes('if (entry.releaseTimer || entry.disposed) { return; }'),
        'armRendererRelease must be idempotent — the ResizeObserver fires on every geometry change, not only on visibility transitions');
    assert.ok(arm.includes('RENDERER_RELEASE_DELAY_MS'),
        'the release must be delayed, or panel flipping thrashes the GPU and the shell loses its instant-switch property');

    const cancel = block('function cancelRendererRelease(entry)', 'function armRendererRelease(');
    assert.ok(cancel.includes('clearTimeout(entry.releaseTimer)') && cancel.includes('entry.releaseTimer = null'),
        'cancel must clear AND null the handle');
    assert.ok(block('function destroyTerminalView(name)', 'function createTerminalView(').includes('cancelRendererRelease(entry)'),
        'teardown must clear the release timer, or it fires against a disposed entry');
});

test('reconcile precedes the fit ladder in the ResizeObserver', () => {
    const observer = block('const resizeObserver = new ResizeObserver(', 'resizeObserver.observe(container)');
    const reconcileAt = observer.indexOf('reconcileRendererForVisibility(entry)');
    const ladderAt = observer.indexOf('startFitLadder(entry.name)');
    assert.ok(reconcileAt !== -1 && ladderAt !== -1, 'both must be wired into the observer');
    assert.ok(reconcileAt < ladderAt,
        'the ladder inspects the PAINTED grid via readRenderedGrid — running it across a pending swap measures a surface that is about to be replaced');
    assert.ok(observer.includes('armRendererRelease(entry)'),
        'the unrendered branch must arm the release');
    assert.ok(observer.includes('cancelRendererRelease(entry)'),
        'the rendered branch must cancel a pending release before anything else');
});

test('the shell panel-switch carrier also drives the renderer, not only the size vote', () => {
    // The release machinery's headline case is "a panel switched away from keeps every
    // context it took". A ResizeObserver inside an iframe may never see the parent's
    // display:none (HTML "update the rendering" does not run for an unrendered document),
    // so the panelVisibility message is the only carrier guaranteed to arrive. Leaving
    // the renderer on the observer alone loses SILENTLY — nobody reads
    // __sbTerminalStats() in the panel that is currently hidden.
    const arm = block("message.type === 'panelVisibility'", "window.addEventListener('resize'", SRC);
    const hideAt = arm.indexOf('viewport.armRendererRelease(entry)');
    const showAt = arm.indexOf('viewport.reconcileRendererForVisibility(entry)');
    assert.ok(hideAt !== -1, 'the hide direction must arm the renderer release');
    assert.ok(showAt !== -1, 'the show direction must reconcile the renderer back up');
    const cancelAt = arm.indexOf('viewport.cancelRendererRelease(entry)');
    assert.ok(cancelAt !== -1 && cancelAt < arm.indexOf('requestAnimationFrame'),
        'the show direction must cancel the pending release SYNCHRONOUSLY — setTimeout keeps running in a hidden iframe and would beat a rAF-deferred cancel');
});

test('declaration order keeps the pane-fit contract spans forward-only', () => {
    const anchor = SRC.indexOf('function readRenderedGrid(');
    assert.ok(anchor !== -1, 'readRenderedGrid must exist in terminals.js — it anchors the pane-fit suite');
    // The renderer functions moved to terminalViewport.js. They must exist there,
    // and must NOT exist in terminals.js (or they would land inside the pane-fit
    // suite's slices and silently widen them).
    for (const name of [
        'function webglAvailable(',
        'function attachRenderer(',
        'function forceReleaseWebglContext(',
        'function reconcileRendererForVisibility(',
        'function swapRenderer(',
        'function cancelRendererRelease(',
        'function armRendererRelease(',
    ]) {
        const atVp = VP.indexOf(name);
        assert.ok(atVp !== -1, `missing declaration in terminalViewport.js: ${name}`);
        const atSrc = SRC.indexOf(name);
        assert.ok(atSrc === -1,
            `${name} must NOT be declared in terminals.js — it was extracted to terminalViewport.js and a leftover copy would land inside terminal-pane-fit-verification-contract's slices`);
    }
});

test('the per-document cap is documented as NOT the process ceiling', () => {
    // The wrong word here is what made the pop-out interaction invisible on inspection.
    const capNote = VP.slice(VP.indexOf('MAX_WEBGL_CONTEXTS = 12') - 500, VP.indexOf('MAX_WEBGL_CONTEXTS = 12'));
    assert.ok(/per-document|per document/.test(capNote),
        'MAX_WEBGL_CONTEXTS must be documented as a per-document ceiling');
    const destroy = block('function destroyTerminalView(name)', 'function createTerminalView(');
    assert.ok(/per RENDERER PROCESS|per renderer process/.test(destroy),
        'destroyTerminalView must say per renderer process, not "per page" — the pop-out shares it');
    assert.ok(SRC.includes('rendererDeferred: entry.rendererDeferred === true'),
        '__sbTerminalStats must expose rendererDeferred so "on canvas, owed an upgrade" is distinguishable from "on canvas, retired"');
});


// ─── A re-box must not release the renderer (layout-switch churn) ───────────
//
// Measured 2026-09-08: one seated terminal, six layout switches, NINE WebGL
// acquires and nine releases. The seat never left the fleet — only the box it
// was drawn in changed. The release path was suspendTerminalStream, which the
// reconcile's trailing loop calls whenever isTerminalRendered(name) is false,
// and a container transiently measures 0x0 mid-reflow. That site released
// IMMEDIATELY, bypassing RENDERER_RELEASE_DELAY_MS entirely.

test('a seated terminal is never released without the delay timer', () => {
    const suspend = block('function suspendTerminalStream(entry)', 'function resumeTerminalStream(entry)');
    assert.ok(/deps\.isTerminalSeated/.test(suspend),
        'suspendTerminalStream must consult isTerminalSeated — "assigned to a rendered, non-status slot" is what separates a re-box from a leave');
    assert.ok(/if \(seated\) \{\s*armRendererRelease\(entry\);/.test(suspend),
        'a SEATED terminal must ARM the 5 s release, never release inline: an immediate release on a transient 0x0 is the 9/9 acquire/release churn');
    // The immediate release must still exist for a terminal that genuinely left.
    assert.ok(/\} else \{[\s\S]*?cancelRendererRelease\(entry\);[\s\S]*?rendererAddon\.release\(\)/.test(suspend),
        'an UNSEATED terminal (unassigned, or a status pane) must still release immediately — that path is not the churn and must not regress');
    // And the seated branch must NOT cancel: panelVisibility arms the genuine
    // hidden-panel reclaim, and a cancel here would silently keep every context
    // for the life of a hidden panel.
    const seatedBranch = block('if (seated) {', '} else {', suspend);
    assert.ok(!/cancelRendererRelease/.test(seatedBranch),
        'the seated branch must not cancel a release the panelVisibility hide path armed — that timer IS the hidden-panel reclaim');
});

test('the ResizeObserver still arms on a lost box, for every terminal', () => {
    const observer = block('const resizeObserver = new ResizeObserver', 'resizeObserver.observe(container)');
    const lostBox = block('if (!isRendered(entry.container)) {', 'cancelRendererRelease(entry);', observer);
    assert.ok(/armRendererRelease\(entry\);/.test(lostBox),
        'the observer must arm unconditionally: the 5 s timer is the transient-vs-real discriminator, and gating it on seating means a Peek-collapsed or long-hidden pane never gives its context back');
    assert.ok(!/isTerminalSeated/.test(lostBox),
        'the seating guard belongs at the IMMEDIATE-release site (suspendTerminalStream), not on the already-delayed arm');
});

test('the ceiling reclaims a hidden context instead of skipping the acquire', () => {
    assert.ok(VP.includes('function evictLeastRecentlyVisibleHiddenWebgl(requestingEntry)'),
        'the budget-exhausted path must have an eviction policy, not an order-determined skip');
    const evict = block('function evictLeastRecentlyVisibleHiddenWebgl(requestingEntry)', 'function cancelRendererRelease');
    assert.ok(/if \(isRendered\(e\.container\)\) \{ continue; \}/.test(evict),
        'eviction must NEVER take a currently-rendered pane: degrading the pane the operator is watching is a regression skip-on-ceiling did not have');
    assert.ok(/deps\.terminalsMap\.values\(\)/.test(evict),
        'eviction must be page-global — liveWebglContexts is script-scoped and shared by the dock\'s two viewports');
    assert.ok(/swapRenderer\(candidate, \/\* wantWebgl \*\/ false\)/.test(evict),
        'the drop must route through swapRenderer -> the one-shot holder.release, so the decrement and forceReleaseWebglContext guarantee are unchanged');
    // The re-entry must not add a second increment site (pinned at one above).
    const attach = RENDERER_BLOCK();
    assert.ok(/function acquireWebgl\(\)/.test(attach),
        'the acquire body must be factored into one closure so the eviction re-entry cannot duplicate the liveWebglContexts++');
    assert.ok(/evictLeastRecentlyVisibleHiddenWebgl\(entry\)\s*\n?\s*&& liveWebglContexts < MAX_WEBGL_CONTEXTS/.test(attach),
        'the eviction re-entry must re-check the budget before acquiring');
});

test('the per-switch fit ladder is coalesced, not doubled', () => {
    const observer = block('const resizeObserver = new ResizeObserver', 'resizeObserver.observe(container)');
    // batchFitVisiblePanes runs after every renderPaneGrid and bumps fitLadderGen
    // for each assigned pane. A gen that MOVED since this observer last looked means
    // that ladder is already serving this reflow — the observer must skip, not add
    // a second one. Inverting this reads as a coalescing guard while coalescing
    // nothing (and suppressing the one case it should serve).
    assert.ok(/if \(fitGen !== entry\.lastObservedFitGen\) \{\s*\n\s*entry\.lastObservedFitGen = fitGen;\s*\n\s*return;/.test(observer),
        'a MOVED fitLadderGen must SKIP the observer ladder — the switch already started one');
    assert.ok(/deps\.startFitLadder\(entry\.name\);\s*\n\s*entry\.lastObservedFitGen = readFitGen\(\);/.test(observer),
        'after running its own ladder the observer must re-stamp the gen, or the next fire mistakes its own bump for someone else\'s');
});

test('the churn probe is opt-in and changes nothing when off', () => {
    assert.ok(VP.includes('window.__sbWebglChurnProbe'),
        'the instrumentation must land as a repeatable check, not be re-patched by hand each time');
    assert.ok(/let churnProbe = null;/.test(VP),
        'the probe must be OFF by default');
    for (const fn of ['recordChurnAcquire', 'recordChurnRelease', 'recordChurnResize']) {
        const at = VP.indexOf(`function ${fn}(entry) {`);
        assert.ok(at !== -1, `missing ${fn}`);
        assert.ok(/^\s*if \(!churnProbe\) \{ return; \}/m.test(VP.slice(at, at + 200)),
            `${fn} must return immediately when the probe is disabled — a probe that costs anything when off is not dev-only`);
    }
    // Per-entry by construction: this is the filter the global ResizeObserver patch
    // that produced the original 33-callback figure did not have.
    assert.ok(/recordChurnResize\(entry\);/.test(block('const resizeObserver = new ResizeObserver', 'resizeObserver.observe(container)')),
        'the resize count must come from the PER-ENTRY observer, never a global ResizeObserver patch');
});

console.log(failed === 0 ? '\nAll terminal renderer lifecycle contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
