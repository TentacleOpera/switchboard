'use strict';
/**
 * Contract: SetupPanelProvider must survive `setApiServer` being called BEFORE
 * its BroadcastHub exists, and the browser Setup panel must re-request its
 * mount-time state once the WS connection is provably subscribed.
 *
 * The extension wires the LocalApiServer at activation (TaskViewerProvider
 * setSetupPanelProvider / the LocalApiServer construction block), which is long
 * before the first Setup verb or panel open builds the hub in _initSetupService().
 * A stateless setter dropped the reference on the floor and every push from
 * postSetupPanelState() went to the VS Code webview only — the browser /setup
 * panel rendered with every setting unset. Even with the reference repaired, the
 * inline `ready` post races wsHub's subscribe-after-snapshot ordering, so the
 * panel must re-request on the `sbTransportSubscribed` signal.
 * Source-level because there is no in-process way to stand up a vscode host here.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'SetupPanelProvider.ts'), 'utf8');
const TRANSPORT = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'transport.js'), 'utf8');
const SETUP_HTML = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'setup.html'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

test('setApiServer caches the server rather than only forwarding it', () => {
    const m = SRC.match(/public setApiServer\(server: any\): void \{([\s\S]*?)\n    \}/);
    assert.ok(m, 'setApiServer not found');
    assert.match(m[1], /this\._apiServer\s*=\s*server/,
        'setApiServer must cache — it is called before the hub exists, so a bare ' +
        'this._broadcaster?.setApiServer(server) is a silent no-op');
});

test('the BroadcastHub is constructed with the cached server, never a null literal', () => {
    assert.ok(!/new BroadcastHub\(\{[^}]*apiServer:\s*null[^}]*\}\)/.test(SRC),
        'apiServer: null hard-codes the WS mirror off for the whole session');
    assert.match(SRC, /new BroadcastHub\(\{[^}]*apiServer:\s*this\._apiServer/,
        'the hub must be built with the cached server');
});

test('the seams-already-derived early return re-applies the server', () => {
    const m = SRC.match(/if \(this\._hostSeams\) \{([\s\S]*?)\n            return;/);
    assert.ok(m, '_initSetupService early-return branch not found');
    assert.match(m[1], /setApiServer\(this\._apiServer\)/,
        'a server wired after the first seam derivation would otherwise never reach the hub');
});

test('transport signals subscription from the __resync branch, not onopen', () => {
    const m = TRANSPORT.match(/if \(msg\.type === '__resync'\) \{([\s\S]*?)\n                return;/);
    assert.ok(m, '__resync branch not found in transport.js');
    assert.match(m[1], /sbTransportSubscribed/,
        'receipt of __resync is the first moment the hub is guaranteed to deliver to ' +
        'this connection; onopen precedes the subscribe-after-snapshot add');
});

test('setup.html re-requests its mount-time state on the subscribe signal', () => {
    // The handler body contains `postMessage({...});` lines whose own `});`
    // would truncate a naive non-greedy match, so bound on the addEventListener
    // call's own closing `});` at line-start indentation.
    const m = SETUP_HTML.match(/addEventListener\('sbTransportSubscribed'[\s\S]*?\n        \}\);/);
    assert.ok(m, 'setup.html does not listen for sbTransportSubscribed');
    for (const verb of ['ready', 'getAgentDirCleanupState', 'getPlanningSources']) {
        assert.ok(m[0].includes(`'${verb}'`),
            `the subscribe handler must re-post '${verb}' — its result arrives only as a push`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
