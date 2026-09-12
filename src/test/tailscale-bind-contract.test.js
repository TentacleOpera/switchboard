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

// ------------------------------------------------- tailnet origin resolver (secure-origin plan)
check('resolveTailnetOrigin exists and is imported by both composition roots', () => {
    const resolverPath = path.join(REPO_ROOT, 'src', 'utils', 'tailnetOrigin.ts');
    assert.ok(fs.existsSync(resolverPath), 'src/utils/tailnetOrigin.ts must exist (the shared resolver module)');
    const resolver = fs.readFileSync(resolverPath, 'utf8');
    assert.ok(/export async function resolveTailnetOrigin/.test(resolver), 'resolveTailnetOrigin must be exported');
    assert.ok(/export interface TailnetOriginResult/.test(resolver), 'TailnetOriginResult must be exported');
    assert.ok(/secure:\s*boolean/.test(resolver), 'the result must carry a `secure` flag');

    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(/from '\.\.\/utils\/tailnetOrigin'/.test(cliSrc), 'cli.ts must import the shared resolver');
    assert.ok(/resolveTailnetOrigin|resolveTailnetUrl/.test(cliSrc), 'cli.ts must consume the resolver');

    const extSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');
    assert.ok(/from '\.\/utils\/tailnetOrigin'/.test(extSrc), 'extension.ts must import the shared resolver');
    assert.ok(/resolveTailnetOrigin/.test(extSrc), 'extension.ts must consume the resolver');
});

check('the raw-IP tailnet URL interpolation is absent from the primary emission path in both roots', () => {
    // The hardcoded `http://${tailnetAddress}` (or `bindPolicy.tailnetAddress`)
    // string must be gone from the primary URL construction in both roots —
    // replaced by a call to the shared resolver. The IP survives only as the
    // resolver's terminal fallback and as an explicit `ipFallback` line.
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    // The resolver helper builds the IP fallback; the emission sites must go
    // through resolveTailnetUrl/resolveTailnetOrigin, not interpolate directly.
    assert.ok(!/const tailnetUrl = `http:\/\/\$\{tailnetAddress\}:\$\{instance\.port\}\/`/.test(cliSrc),
        'the foreground tailnet URL must not be hardcoded as http://${tailnetAddress}:${instance.port}/');

    const extSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');
    assert.ok(!/const tailnetUrl = `http:\/\/\$\{bindPolicy\.tailnetAddress\}:\$\{port\}\/`/.test(extSrc),
        'the extension tailnet URL must not be hardcoded as http://${bindPolicy.tailnetAddress}:${port}/');
});

check('an HTTPS-capable probe (https.get, not http.get) exists for the cert-liveness check', () => {
    const resolver = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetOrigin.ts'), 'utf8');
    assert.ok(/import \* as https from 'https'/.test(resolver), 'the resolver must import the https module');
    assert.ok(/export async function isHttpsOriginReachable/.test(resolver), 'isHttpsOriginReachable must be exported');
    assert.ok(/https\.get/.test(resolver), 'the TLS probe must use https.get, not http.get — a TLS handshake is the cert-liveness check (Edge Case 2)');
    // The HTTP probe is reused from loopbackHostname (http.get); the resolver
    // itself must not perform an http.get for the HTTPS candidate.
    assert.ok(!/\bhttp\.get\(/.test(resolver), 'the resolver must not call http.get directly — the HTTP candidate reuses isHostnameReachable');
});

check('the probe target is /health, never /?token= — the one-time token must not be burned', () => {
    const resolver = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetOrigin.ts'), 'utf8');
    assert.ok(resolver.includes('/health'), 'the probe path must include /health');
    assert.ok(!/\?token=/.test(resolver), 'no probe path may include ?token= — consumeOneTimeToken succeeds exactly once');
});

check('the serve-config parser reads /localapi/v0/serve-config (primary) with the CLI as fallback, never a bare spawn', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetDetect.ts'), 'utf8');
    assert.ok(src.includes('/localapi/v0/serve-config'), 'the primary transport must hit /localapi/v0/serve-config');
    assert.ok(/serve',\s*'status',\s*'--json'/.test(src), 'the CLI fallback must run `tailscale serve status --json` via the absolute-path probe');
    assert.ok(/detectServeConfigMapping/.test(src), 'detectServeConfigMapping must be exported');
    assert.ok(/readCertDomains/.test(src), 'readCertDomains must be exported');
    // The Host header constant is shared so the serve-config probe cannot drift
    // on the value Subtask 0 fixed.
    assert.ok(src.includes('LOCALAPI_HOST_HEADER'), 'the serve-config probe must reuse the shared Host header constant');
});

check('the HTTPS candidate is skipped when CertDomains is empty or null (pre-flight check)', () => {
    const resolver = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetOrigin.ts'), 'utf8');
    assert.ok(/certDomains && certDomains\.length > 0/.test(resolver),
        'the HTTPS candidate must be gated on certDomains being non-null AND non-empty — cert generation disabled short-circuits the TLS probe');
});

check('the serve-config parser degrades to null on any parse failure or schema mismatch', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetDetect.ts'), 'utf8');
    // The parser must never throw — every shape mismatch returns null.
    const parserIdx = src.indexOf('function parseWebKey');
    assert.ok(parserIdx > 0, 'parseWebKey must exist');
    const parser = src.slice(parserIdx, parserIdx + 1000);
    assert.ok(/return null/.test(parser), 'parseWebKey must return null on shape mismatch, not throw');
    const proxyIdx = src.indexOf('function proxyMatchesBoardPort');
    assert.ok(proxyIdx > 0, 'proxyMatchesBoardPort must exist');
    const proxy = src.slice(proxyIdx, proxyIdx + 1000);
    assert.ok(/return false/.test(proxy) && !/throw/.test(proxy), 'proxyMatchesBoardPort must return false on mismatch, not throw');
    // The top-level detectServeConfigMapping must catch and return null.
    const detectIdx = src.indexOf('export async function detectServeConfigMapping');
    assert.ok(detectIdx > 0, 'detectServeConfigMapping must exist');
    const detect = src.slice(detectIdx, detectIdx + 1600);
    assert.ok(/return null/.test(detect), 'detectServeConfigMapping must return null when no mapping is found');
    assert.ok(/\} catch \{/.test(detect), 'detectServeConfigMapping must catch any parse failure and return null');
});

check('the advisory line fires only when the chosen origin is insecure', () => {
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    // The advisory names the concrete cost (Home Screen install), not generic
    // TLS advice, and does NOT claim to fix copy-button reliability.
    assert.ok(/Home Screen/.test(cliSrc), 'the advisory must name the Home Screen install cost');
    assert.ok(!/clipboard.*reliab/i.test(cliSrc) || !/fix.*clipboard/i.test(cliSrc),
        'the advisory must not claim to fix copy-button reliability');
    // The advisory is gated on `!secure` — it must not fire when the scheme is https.
    assert.ok(/!tailnetResolved\.secure/.test(cliSrc), 'the advisory must be gated on the chosen origin being insecure');
    assert.ok(/tailnetResolved\.secure && tailnetResolved\.isFunnel/.test(cliSrc),
        'the funnel note must fire only when the chosen origin is secure AND a funnel endpoint');

    const extSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');
    assert.ok(/!tailnetResolved\.secure/.test(extSrc), 'the extension advisory must be gated on insecure');
});

check('an explicit --hostname bypasses the resolver (Edge Case 7)', () => {
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(/hostnameExplicit/.test(cliSrc), 'cli.ts must compute a hostnameExplicit flag');
    assert.ok(/if \(hostnameExplicit\)/.test(cliSrc), 'the resolver helper must short-circuit on an explicit --hostname');
    // The advisory must also be suppressed when --hostname is explicit.
    assert.ok(/!hostnameExplicit/.test(cliSrc), 'the advisory must be suppressed when --hostname is explicit');
});

// ------------------------------------------------- Run
console.log('\nTailscale bind-policy contract tests:');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
