'use strict';
/**
 * Board CSRF guard contract.
 *
 * The browser board is served unauthenticated by both hosts when no durable
 * token is configured (the extension host ALWAYS; the standalone host since
 * bootstrap.ts stopped minting a random secret). Authentication was the
 * board's only defence against a hostile page, and one of the two hosts had
 * none — so every state-changing route was reachable from any page the
 * operator visited while a board was open. The CSRF guard
 * (`_isAllowedCrossSiteRequest` in `LocalApiServer._handleRequest`) closes that
 * hole using request metadata (`Sec-Fetch-Site` / `Origin`) and a positive
 * client marker (`X-Switchboard-Client`), never a credential.
 *
 * These tests have two halves, matching `loopback-hostname-contract` and
 * `tailscale-bind-contract`:
 *
 *   1. SOURCE-LEVEL assertions pin the structural invariants that would
 *      otherwise silently regress — the guard is unconditional, reads the
 *      shared `isAllowedOriginFor` predicate, runs before any route handler,
 *      `/health` is exempt, the WS path is covered by the existing check, and
 *      the empty-cookie emission is fixed.
 *   2. BEHAVIOURAL assertions start a real `LocalApiServer` and exercise the
 *      guard end to end: cross-site POST → 403, same-site POST → 403,
 *      same-origin → allowed, no headers + no marker → 403, no headers + marker
 *      → allowed, `/health` with none of the three → 200.
 *
 * Plan: .switchboard/plans/browser-board-csrf-cross-site-rejection.md
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
let passed = 0, failed = 0;

function check(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

async function checkAsync(name, fn) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('Board CSRF guard contract');

// ──────────────────────────────────────────────────────────── source invariants

const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');

check('Sec-Fetch-Site appears in LocalApiServer source (its absence was the bug)', () => {
    assert.ok(SERVER_SRC.includes('sec-fetch-site'),
        'Sec-Fetch-Site must be inspected by the CSRF guard — it did not appear before this change');
    assert.ok(/cross-site/.test(SERVER_SRC), 'the guard must reject Sec-Fetch-Site: cross-site');
    assert.ok(/same-site/.test(SERVER_SRC), 'the guard must reject Sec-Fetch-Site: same-site');
});

check('a named cross-site guard predicate exists and is called from _handleRequest', () => {
    assert.ok(/_isAllowedCrossSiteRequest/.test(SERVER_SRC),
        '_isAllowedCrossSiteRequest must exist');
    assert.ok(/!this\._isAllowedCrossSiteRequest\(req\)/.test(SERVER_SRC),
        '_handleRequest must call _isAllowedCrossSiteRequest and reject (403) when it returns false');
});

check('the guard runs BEFORE any route handler — after the Host guard, before CORS mirroring', () => {
    const hostGuard = SERVER_SRC.indexOf("Access denied: invalid Host header");
    assert.ok(hostGuard > 0, 'the Host guard must exist');
    const csrfGuard = SERVER_SRC.indexOf('_isAllowedCrossSiteRequest(req)');
    assert.ok(csrfGuard > hostGuard, 'the CSRF guard must come AFTER the Host guard');
    const corsMirror = SERVER_SRC.indexOf("'Access-Control-Allow-Origin'");
    // Find the CORS mirror inside _handleRequest (after the Host guard), not the
    // one inside wsUpgradeAuth or elsewhere.
    const corsInHandler = SERVER_SRC.indexOf("'Access-Control-Allow-Origin'", hostGuard);
    assert.ok(csrfGuard > 0 && corsInHandler > csrfGuard,
        'the CSRF guard must come BEFORE the CORS mirroring in _handleRequest');
});

check('the guard reads isAllowedOriginFor(this._bindPolicy, origin) — the same predicate the Host guard and WS auth use', () => {
    assert.ok(/_isLocalhostOrigin/.test(SERVER_SRC), '_isLocalhostOrigin must exist');
    assert.ok(/isAllowedOriginFor\(this\._bindPolicy/.test(SERVER_SRC),
        '_isLocalhostOrigin must delegate to isAllowedOriginFor(this._bindPolicy, ...) — no second copy of the allowlist');
});

check('the guard is UNCONDITIONAL — not gated on serveStatic (the extension host is the one that needs it)', () => {
    const csrfCall = SERVER_SRC.indexOf('if (!this._isAllowedCrossSiteRequest(req))');
    assert.ok(csrfCall > 0, 'the CSRF guard call must exist');
    // The Host guard is gated on serveStatic: `if (this._options.serveStatic && ...)`.
    // The CSRF guard must NOT be. Confirm the serveStatic gate does not appear
    // between the Host guard's reject and the CSRF guard's call.
    const hostGuard = SERVER_SRC.indexOf("Access denied: invalid Host header");
    const slice = SERVER_SRC.slice(hostGuard, csrfCall);
    assert.ok(!/this\._options\.serveStatic\s*&&/.test(slice),
        'the CSRF guard must not be gated on serveStatic — the extension host serves the board and has no token');
});

check('/health is exempt from the guard — port discovery works before a client knows anything about the server', () => {
    const fnStart = SERVER_SRC.indexOf('_isAllowedCrossSiteRequest(req: http.IncomingMessage)');
    assert.ok(fnStart > 0, 'the guard predicate body must exist');
    const fnBody = SERVER_SRC.slice(fnStart, fnStart + 800);
    assert.ok(/\/health/.test(fnBody), 'the guard must exempt /health');
});

check('the X-Switchboard-Client marker is checked when neither Origin nor Sec-Fetch-Site is present', () => {
    const fnStart = SERVER_SRC.indexOf('_isAllowedCrossSiteRequest(req: http.IncomingMessage)');
    const fnBody = SERVER_SRC.slice(fnStart, fnStart + 1600);
    assert.ok(/x-switchboard-client/.test(fnBody),
        'the guard must check X-Switchboard-Client when no browser signal is present (2026-09-10 correction)');
    // A request with none of the three is REJECTED, not allowed.
    assert.ok(/return typeof marker === 'string' && marker\.length > 0/.test(fnBody),
        'a missing marker must reject — header absence no longer allows');
});

check('the empty-cookie emission is fixed — Set-Cookie is skipped when the expected token is empty', () => {
    // The three token-exchange sites build redirect headers conditionally.
    // The unconditional `Set-Cookie: sb_session=${expected}` string must be
    // gone from the unconditional path; it must now live inside an
    // `if (expected)` block.
    const sites = SERVER_SRC.split('consumeOneTimeToken(token)');
    // sites[0] is before the first call; sites[1..] each follow a consume call.
    for (let i = 1; i < sites.length; i++) {
        const block = sites[i].slice(0, 600);
        assert.ok(/if \(expected\)/.test(block),
            `token-exchange site ${i} must gate Set-Cookie on a non-empty expected token`);
    }
});

check('wsUpgradeAuth imports and calls isAllowedOriginFor with the bind policy — the WS path is covered by the existing check', () => {
    const wsSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'wsUpgradeAuth.ts'), 'utf8');
    assert.ok(/isAllowedOriginFor/.test(wsSrc),
        'wsUpgradeAuth must import isAllowedOriginFor');
    assert.ok(/isLocalhostOrigin\(origin,\s*policy\)/.test(wsSrc),
        'wsUpgradeAuth must call isLocalhostOrigin with the bind policy — no second predicate');
});

check('the CORS Allow-Headers includes X-Switchboard-Client so a preflight can advertise it', () => {
    assert.ok(/Access-Control-Allow-Headers'[^;]*X-Switchboard-Client/.test(SERVER_SRC),
        "Access-Control-Allow-Headers must include X-Switchboard-Client so a browser preflight can request it");
});

check('the CLI apiRequest sends the X-Switchboard-Client marker (the non-breaking gate for in-tree clients)', () => {
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(/X-Switchboard-Client/.test(cliSrc),
        'cli.ts apiRequest must send the X-Switchboard-Client marker or every kanban_operations script 403s');
});

check('the Go client transport sends the X-Switchboard-Client marker', () => {
    const goSrc = fs.readFileSync(path.join(REPO_ROOT, 'internal', 'client', 'transport.go'), 'utf8');
    assert.ok(/X-Switchboard-Client/.test(goSrc),
        'the Go client transport must send the X-Switchboard-Client marker');
});

// ──────────────────────────────────────────────────────────── behavioural

function request(port, method, pathname, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: pathname, method,
            headers: headers || {},
        }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function behavioural() {
    let LocalApiServer;
    try {
        LocalApiServer = require(path.join(process.cwd(), 'out', 'services', 'LocalApiServer.js')).LocalApiServer;
    } catch (e) {
        console.warn('  [skipped] behavioural CSRF guard tests require a compiled out/ — run `npm run compile-tests`.');
        return;
    }

    const server = new LocalApiServer({
        port: 0,
        workspaceRoot: REPO_ROOT,
        getAuthToken: async () => '',
        serveStatic: undefined,
    });
    await server.start();
    const port = server.getPort();
    try {
        // /health is exempt — works with none of the three signals.
        await checkAsync('/health with no Origin, no Sec-Fetch-Site, no marker → 200', async () => {
            const res = await request(port, 'GET', '/health');
            assert.strictEqual(res.status, 200, `/health must be exempt from the guard (got ${res.status})`);
        });

        // /health is exempt even when a cross-site Origin is present.
        await checkAsync('/health with a cross-site Origin → 200', async () => {
            const res = await request(port, 'GET', '/health', { Origin: 'https://evil.example' });
            assert.strictEqual(res.status, 200, `/health must be exempt even with a cross-site Origin (got ${res.status})`);
        });

        // Sec-Fetch-Site: cross-site POST → 403.
        await checkAsync('Sec-Fetch-Site: cross-site POST → 403', async () => {
            const res = await request(port, 'POST', '/kanban/move', {
                'Sec-Fetch-Site': 'cross-site',
                'Content-Type': 'application/json',
            });
            assert.strictEqual(res.status, 403, `cross-site POST must be rejected (got ${res.status})`);
        });

        // Sec-Fetch-Site: same-site POST → 403 (same-site is NOT same-origin).
        await checkAsync('Sec-Fetch-Site: same-site POST → 403', async () => {
            const res = await request(port, 'POST', '/kanban/move', {
                'Sec-Fetch-Site': 'same-site',
                'Content-Type': 'application/json',
            });
            assert.strictEqual(res.status, 403, `same-site POST must be rejected — localhost:8080 is not same-origin with localhost:7777 (got ${res.status})`);
        });

        // Sec-Fetch-Site: cross-site PLUS a valid marker → 403 (browser signal wins).
        await checkAsync('Sec-Fetch-Site: cross-site + valid marker → 403 (a browser signal always wins; the marker is not an override)', async () => {
            const res = await request(port, 'POST', '/kanban/move', {
                'Sec-Fetch-Site': 'cross-site',
                'X-Switchboard-Client': 'forged',
                'Content-Type': 'application/json',
            });
            assert.strictEqual(res.status, 403, `cross-site with a marker must still be rejected (got ${res.status})`);
        });

        // Sec-Fetch-Site: none GET → allowed (user navigation / openExternal).
        await checkAsync('Sec-Fetch-Site: none GET → allowed (not 403)', async () => {
            const res = await request(port, 'GET', '/kanban/plans', { 'Sec-Fetch-Site': 'none' });
            assert.ok(res.status !== 403, `Sec-Fetch-Site: none must not be rejected as cross-site (got ${res.status})`);
        });

        // Sec-Fetch-Site: same-origin POST → allowed (the board's own fetch).
        await checkAsync('Sec-Fetch-Site: same-origin POST → allowed (not 403)', async () => {
            const res = await request(port, 'POST', '/kanban/plans', { 'Sec-Fetch-Site': 'same-origin' });
            assert.ok(res.status !== 403, `same-origin must not be rejected as cross-site (got ${res.status})`);
        });

        // Non-loopback Origin → 403.
        await checkAsync('non-loopback Origin → 403', async () => {
            const res = await request(port, 'POST', '/kanban/move', { Origin: 'https://evil.example' });
            assert.strictEqual(res.status, 403, `a foreign Origin must be rejected (got ${res.status})`);
        });

        // Loopback Origin → allowed (not 403).
        await checkAsync('loopback Origin → allowed (not 403)', async () => {
            const res = await request(port, 'GET', '/kanban/plans', { Origin: 'http://127.0.0.1:' + port });
            assert.ok(res.status !== 403, `a loopback Origin must not be rejected (got ${res.status})`);
        });

        // No Origin, no Sec-Fetch-Site, no marker → 403 (header absence no longer allows).
        await checkAsync('no Origin, no Sec-Fetch-Site, no marker → 403', async () => {
            const res = await request(port, 'POST', '/kanban/move', { 'Content-Type': 'application/json' });
            assert.strictEqual(res.status, 403, `header absence must NOT allow — curl is not a supported client (got ${res.status})`);
        });

        // No Origin, no Sec-Fetch-Site, valid marker → allowed (the local-script case).
        await checkAsync('no Origin, no Sec-Fetch-Site, valid marker → allowed (the in-tree client case)', async () => {
            const res = await request(port, 'GET', '/kanban/plans', { 'X-Switchboard-Client': 'test' });
            assert.ok(res.status !== 403, `a valid marker must allow a non-browser request (got ${res.status})`);
        });
    } finally {
        await server.stop();
    }
}

behavioural().then(() => {
    if (failed > 0) {
        console.error(`\n${failed} assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll board CSRF guard contract assertions passed.');
}, err => {
    console.error('\nboard CSRF guard contract harness error:', err);
    process.exit(1);
});
