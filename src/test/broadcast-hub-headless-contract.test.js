'use strict';

/**
 * BroadcastHub headless-mode contract.
 *
 * `BroadcastHub` is shared by the VS Code extension host (~4,000 installs) and
 * the standalone/npx host. Its `_pendingWebviewMessages` queue exists for ONE
 * reason: the editor's cold-start ordering — messages produced before
 * `resolveWebviewView`/panel creation are queued and flushed by `setWebview`.
 *
 * In standalone there is no webview and never will be, so every push was
 * appended to that queue and never drained: one hub shared by six providers,
 * driven by the 40 ms coalesced push loop, in a long-running foreground process.
 * The `headless` flag suppresses the append.
 *
 * The risk this file exists to pin is NOT the standalone leak — it is the
 * editor regression a careless fix would cause. A "drop when no webview is
 * bound" change looks identical in standalone and silently breaks every cold
 * panel open in the extension. So both behaviours are asserted here, not
 * reasoned about.
 *
 * Covers `restore-backlog-view-to-standalone-host.md` §Verification/Automated
 * items 1-3.
 *
 * Run with:
 *   npm run compile-tests && node src/test/broadcast-hub-headless-contract.test.js
 */

const assert = require('assert');

const { BroadcastHub } = require('../../out/services/broadcastHub');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

/** Minimal wsHub-bearing LocalApiServer stand-in: records every broadcastWs call. */
function makeApiServer() {
    const calls = [];
    return {
        calls,
        broadcastWs(verb, payload, surface) { calls.push({ verb, payload, surface }); },
    };
}

/** Minimal webview stand-in: records every postMessage call. */
function makeWebview() {
    const posted = [];
    return {
        posted,
        postMessage(msg) { posted.push(msg); return Promise.resolve(true); },
    };
}

console.log('\nBroadcastHub headless-mode contract\n');

// ── 1. A headless hub retains nothing ──────────────────────────────────────
test('headless hub: N pushes leave pendingCount at 0 and all N reach the WS target', () => {
    const apiServer = makeApiServer();
    const hub = new BroadcastHub({ webview: null, apiServer, headless: true });

    const N = 50;
    for (let i = 0; i < N; i++) {
        hub.push({ type: 'updateBoard', cards: [{ id: i }] }, 'kanban');
    }

    assert.strictEqual(hub.pendingCount, 0,
        'headless hub queued messages — the unbounded-retention defect is back');
    assert.strictEqual(apiServer.calls.length, N,
        'headless hub dropped WS pushes; the WS fan-out is the ONLY delivery path headlessly');
    assert.strictEqual(apiServer.calls[0].verb, 'updateBoard');
    assert.strictEqual(apiServer.calls[0].surface, 'kanban',
        'surface tag must survive the headless path — wsHub filters per-connection on it');
});

test('headless hub: pushWebviewOnly drops (no webview, and by definition no WS fan-out)', () => {
    const apiServer = makeApiServer();
    const hub = new BroadcastHub({ webview: null, apiServer, headless: true });

    hub.pushWebviewOnly({ type: 'switchToTab', tab: 'automation' });

    assert.strictEqual(hub.pendingCount, 0,
        'pushWebviewOnly queued in headless mode — same unbounded growth by another route');
    assert.strictEqual(apiServer.calls.length, 0,
        'pushWebviewOnly must NOT mirror to WS — it is webview-internal by definition');
});

// ── 2. The editor cold-start contract is untouched ─────────────────────────
// This is the assertion that protects the ~4,000 installed extension hosts.
test('editor hub (headless unset): queues before the webview binds, flushes on setWebview', () => {
    const apiServer = makeApiServer();
    const hub = new BroadcastHub({ webview: null, apiServer });

    hub.push({ type: 'updateColumns', columns: [] }, 'kanban');
    hub.push({ type: 'updateBoard', cards: [] }, 'kanban');

    assert.strictEqual(hub.pendingCount, 2,
        'editor cold-start queue lost — pre-webview messages would never reach a mounting panel');

    const webview = makeWebview();
    hub.setWebview(webview);

    assert.strictEqual(hub.pendingCount, 0, 'setWebview did not drain the queue');
    assert.deepStrictEqual(webview.posted.map(m => m.type), ['updateColumns', 'updateBoard'],
        'flush must preserve push order — the board requires updateColumns before updateBoard');
});

test('editor hub: headless flag absent means undefined, not false-y accident', () => {
    // Guards the specific implementation shape: `else if (!this._target.headless)`.
    // If the flag is ever read with inverted or defaulted logic, the editor path
    // silently becomes the headless path.
    const hub = new BroadcastHub({ webview: null, apiServer: null });
    hub.push({ type: 'anything' });
    assert.strictEqual(hub.pendingCount, 1,
        'a hub constructed WITHOUT the headless flag must still queue');
});

// ── 3. Factory (scoped-payload) rendering on both paths ────────────────────
test('factory payload is rendered, not dropped or serialised — headless path', () => {
    const apiServer = makeApiServer();
    const hub = new BroadcastHub({ webview: null, apiServer, headless: true });
    hub.setWebviewScope('ProjectA');

    hub.push((scope) => ({ type: 'cliTriggersState', enabled: scope === 'ProjectA' }), 'kanban');

    assert.strictEqual(apiServer.calls.length, 1);
    // The factory itself must reach wsHub so it can be re-rendered per declared
    // scope; passing a pre-rendered object would collapse every connection onto
    // the webview's scope.
    assert.strictEqual(typeof apiServer.calls[0].payload, 'function',
        'headless push must forward the FACTORY to wsHub, not a pre-rendered object');
    assert.strictEqual(apiServer.calls[0].verb, 'cliTriggersState',
        'verb hint must be derived by rendering the factory, even though the render is discarded headlessly');
});

test('factory payload is rendered against the webview scope — editor path', () => {
    const apiServer = makeApiServer();
    const webview = makeWebview();
    const hub = new BroadcastHub({ webview, apiServer });
    hub.setWebviewScope('ProjectA');

    hub.push((scope) => ({ type: 'updateBoard', scopeSeen: scope }), 'kanban');

    assert.strictEqual(webview.posted.length, 1, 'factory push did not reach the bound webview');
    assert.strictEqual(typeof webview.posted[0], 'object',
        'the webview must receive a RENDERED object, never the function itself');
    assert.strictEqual(webview.posted[0].scopeSeen, 'ProjectA',
        'factory must be rendered against the webview’s declared scope');
});

test('factory payload queued pre-webview is rendered, not stored as a function', () => {
    const hub = new BroadcastHub({ webview: null, apiServer: null });
    hub.setWebviewScope('ProjectB');

    hub.push((scope) => ({ type: 'updateBoard', scopeSeen: scope }), 'kanban');

    const webview = makeWebview();
    hub.setWebview(webview);

    assert.strictEqual(webview.posted.length, 1);
    assert.strictEqual(typeof webview.posted[0], 'object',
        'a queued factory must be rendered at push time, not flushed as a raw function');
    assert.strictEqual(webview.posted[0].scopeSeen, 'ProjectB');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
