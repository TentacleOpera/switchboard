/**
 * Tailscale bind-policy contract tests.
 *
 * These are SOURCE-LEVEL contract tests (same shape as loopback-hostname-contract):
 * they read the .ts source and assert structural invariants that would otherwise
 * silently regress. They do NOT start a server or require Tailscale to be running.
 *
 * The invariants:
 *   1. The loopback listener is ALWAYS retained in tailnet mode (two listeners,
 *      not a bind moved). Moving the bind would break every local agent client.
 *   2. The server NEVER binds 0.0.0.0.
 *   3. The tailnet-listener identification is by socket.localAddress, not by an
 *      allowlist of remote peer addresses.
 *   4. The token skip (decision 4) is scoped to the tailnet listener — the
 *      loopback listener still enforces the token.
 *   5. The CLI's 'start' subcommand is retired; 'local' and 'tailnet' are the
 *      serve modes; 'tailnet' exits non-zero when Tailscale is absent.
 *   6. The bind policy is the single source of truth — _isAllowedHost,
 *      isAllowedHost (wsUpgradeAuth), and the CLI's resolveHostname all delegate
 *      to isAllowedHostFor, not to a second predicate.
 *   7. The clipboard fallback helper exists and is injected into the transport
 *      shim, so a board served over a non-secure tailnet URL can still copy.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
let passed = 0, failed = 0;

function check(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ------------------------------------------------- two listeners, not a moved bind
check('tailnet mode opens a SECOND listener; the loopback listener is retained', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(src.includes("this._tailnetServer"), 'LocalApiServer must have a _tailnetServer field');
    assert.ok(src.includes("'127.0.0.1'"), 'the loopback listener bind to 127.0.0.1 must remain');
    assert.ok(/this\._tailnetServer\.listen\(this\._port,\s*this\._tailnetAddress/.test(src),
        'the tailnet listener must bind the specific tailnet address, not a wildcard');
});

check('both listeners bind the SAME port — the tailnet listen is sequenced after the loopback one', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    // `this._port` is only assigned inside the loopback listen callback. A
    // `this._tailnetServer.listen(this._port, ...)` issued in the enclosing
    // synchronous block therefore reads the CONSTRUCTOR value — 0 whenever the
    // port is ephemeral (the extension host passes no port at all; the CLI
    // falls back to 0 when the preferred port is taken). The two listeners then
    // bind two DIFFERENT random ports and nothing errors: start() resolves, the
    // port file and every printed URL carry the loopback port, and the tailnet
    // listener is unreachable. The bind must be sequenced, so pin the ordering.
    const loopbackListen = src.indexOf("this._server.listen(this._port || 0, '127.0.0.1'");
    assert.ok(loopbackListen > 0, 'the loopback listen call must be present');
    const tailnetListen = src.search(/this\._tailnetServer\.listen\(this\._port,/);
    assert.ok(tailnetListen > 0, 'the tailnet listen call must be present');

    // The tailnet listen must be reached THROUGH the loopback listen callback,
    // never as a sibling statement in the same synchronous block. Structurally:
    // it lives in a helper the callback invokes.
    assert.ok(/const startTailnetListener\s*=/.test(src),
        'the tailnet listen must be factored into a helper invoked after the port resolves');
    const helperCall = src.indexOf('startTailnetListener();');
    assert.ok(helperCall > loopbackListen,
        'startTailnetListener() must be called from inside the loopback listen callback, after this._port is assigned');
    // And the assignment must precede the call in source order.
    const portAssign = src.indexOf('this._port = address.port;');
    assert.ok(portAssign > 0 && portAssign < helperCall,
        'this._port must be assigned before the tailnet listener is opened');
});

check('a failed tailnet bind tears down the loopback listener instead of orphaning it', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    const errIdx = src.indexOf('[LocalApiServer] Tailnet listener error:');
    assert.ok(errIdx > 0, 'the tailnet error handler must exist');
    const handler = src.slice(errIdx, errIdx + 1400);
    assert.ok(/this\._server\?\.close\(\)/.test(handler),
        'the loopback listener must be closed before start() rejects — otherwise it holds the port and the retry dies on EADDRINUSE');
});

check('the server never binds 0.0.0.0', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(!/listen\([^)]*0\.0\.0\.0/.test(src),
        'no listen() call may bind 0.0.0.0 — tailnet mode uses a specific address');
});

// ------------------------------------------------- tailnet identification by localAddress
check('tailnet-listener identification is by socket.localAddress, not remote peer allowlist', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(/_isTailnetSocket/.test(src), '_isTailnetSocket must exist');
    assert.ok(/localAddress/.test(src), 'the tailnet identification must read socket.localAddress');
    // The peer check must bypass for tailnet, not just reject non-loopback.
    assert.ok(/onTailnet/.test(src), 'the peer check must compute an onTailnet flag');
});

// ------------------------------------------------- token skip scoped to tailnet listener
check('the token skip (decision 4) is scoped to the tailnet listener', () => {
    const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(/_isTailnetSocket\(req\).*return true/.test(serverSrc.replace(/\s+/g, ' ')),
        '_checkAuth must return true for tailnet-listener requests BEFORE reading the token');
    const wsSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'wsUpgradeAuth.ts'), 'utf8');
    assert.ok(/isTailnetUpgrade/.test(wsSrc), 'authorizeWsUpgrade must accept an isTailnetUpgrade predicate');
    assert.ok(/isTailnetUpgrade\(req\)/.test(wsSrc), 'the predicate must be called, not just accepted');
});

// ------------------------------------------------- CLI subcommand whitelist
check('the CLI retires "start" and introduces "local" and "tailnet"', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(src.includes("'start' has been replaced"), 'start must produce a redirect message');
    assert.ok(src.includes("'switchboard local'"), 'the redirect must name switchboard local');
    assert.ok(src.includes("'switchboard tailnet'"), 'the redirect must name switchboard tailnet');
    assert.ok(/KNOWN_SUBCOMMANDS/.test(src), 'a known-subcommand whitelist must exist');
    assert.ok(src.includes("Unknown subcommand"), 'unknown subcommands must be rejected, not silently served');
});

check('tailnet mode exits non-zero when Tailscale is absent', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(/detectTailnetAddress/.test(src), 'cli.ts must call detectTailnetAddress');
    assert.ok(/Tailscale is not running/.test(src), 'a null address must produce a clear error');
    assert.ok(/process\.exit\(1\)/.test(src), 'the error must exit non-zero');
});

// ------------------------------------------------- bind policy is the single source of truth
check('isAllowedHostFor is the single Host predicate (no second copy)', () => {
    const loopbackSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'loopbackHostname.ts'), 'utf8');
    assert.ok(/export function isAllowedHostFor/.test(loopbackSrc), 'isAllowedHostFor must be exported');
    assert.ok(/export type BindPolicy/.test(loopbackSrc), 'BindPolicy must be exported');
    assert.ok(/export function isTailnetPolicy/.test(loopbackSrc), 'isTailnetPolicy type guard must be exported');

    const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(serverSrc.includes('isAllowedHostFor'), 'LocalApiServer must use isAllowedHostFor');

    const wsSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'wsUpgradeAuth.ts'), 'utf8');
    assert.ok(wsSrc.includes('isAllowedHostFor'), 'wsUpgradeAuth must use isAllowedHostFor');
});

// ------------------------------------------------- clipboard fallback
check('the clipboard fallback helper exists and is injected into the transport shim', () => {
    const helperPath = path.join(REPO_ROOT, 'src', 'webview', 'clipboardFallback.js');
    assert.ok(fs.existsSync(helperPath), 'src/webview/clipboardFallback.js must exist');
    const helper = fs.readFileSync(helperPath, 'utf8');
    assert.ok(helper.includes('sbCopyToClipboard'), 'the helper must install window.sbCopyToClipboard');
    assert.ok(helper.includes('execCommand'), 'the helper must fall back to execCommand for insecure contexts');

    const htmlSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
    assert.ok(htmlSrc.includes('clipboardFallback.js'), 'the transport shim must inject clipboardFallback.js');
});

// ------------------------------------------------- CSP widening for tailnet
check('the CSP is widened at serve time for tailnet requests', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(/_widenCspForRequest/.test(src), '_widenCspForRequest must exist');
    assert.ok(/isTailnetPolicy/.test(src), 'CSP widening must be gated on the tailnet policy');
    assert.ok(/ws:\/\/\$\{host\}/.test(src), 'the widened CSP must add ws://<host> from the request Host header');
});

// ------------------------------------------------- extension host parity
check('the extension host has the switchboard.remote.tailnet setting', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const props = pkg.contributes?.configuration?.properties || {};
    assert.ok(props['switchboard.remote.tailnet'], 'package.json must declare switchboard.remote.tailnet');
    assert.strictEqual(props['switchboard.remote.tailnet'].type, 'boolean');
    assert.strictEqual(props['switchboard.remote.tailnet'].default, false);
});

check('the extension host threads bindPolicy into the LocalApiServer options', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
    assert.ok(src.includes('_resolveBindPolicy'), 'TaskViewerProvider must have a _resolveBindPolicy method');
    assert.ok(src.includes('bindPolicy'), 'the LocalApiServer options must include bindPolicy');
    assert.ok(src.includes('detectTailnetAddress'), 'the extension must call detectTailnetAddress when the setting is on');
});

// ------------------------------------------------- stop() closes both listeners
check('stop() closes both the loopback and tailnet listeners', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(/closeAll\(this\._tailnetServer\)/.test(src), 'stop() must close the tailnet server');
    assert.ok(/closeAll\(this\._server\)/.test(src), 'stop() must close the loopback server');
});

// ------------------------------------------------- Run
console.log('\nTailscale bind-policy contract tests:');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
