'use strict';
/**
 * Loopback hostname policy contract.
 *
 * `--hostname switchboard.localhost` widened the set of `Host` headers the board
 * server accepts. That guard is the DNS-rebinding defence for a server whose only
 * other protection is a loopback socket bind, so every assertion below pins a way
 * a plausible-looking widening quietly becomes a hole — or breaks the feature:
 *
 *   1. Substring matching. `localhost.evil.example` and `notlocalhost` contain the
 *      magic word but are attacker-registrable names that can be pointed at
 *      127.0.0.1. Only the reserved `.localhost` TLD is unspoofable.
 *   2. Prefix matching. The previous guard used `startsWith('127.0.0.1:')`, which
 *      accepts `127.0.0.1:evil` and rejects `[::1]:8080`. Parse, don't prefix.
 *   3. CLI/server drift. If the CLI prints a hostname the server's guard rejects,
 *      the launch burns the one-time token on a request that 403s and the user is
 *      locked out. Both sides must consult ONE predicate.
 *   4. CSP omission. The board reaches its own WebSocket at `location.host`. A
 *      `connect-src` that enumerates `ws://localhost:*` but not `ws://*.localhost:*`
 *      serves a board that renders and then never receives a state push.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const OUT = path.join(process.cwd(), 'out');
const {
    hostnameFromHostHeader,
    isLoopbackHostname,
    isLoopbackHostHeader,
    isLoopbackOrigin,
    DEFAULT_DISPLAY_HOSTNAME,
    resolveDisplayHostname,
} = require(path.join(OUT, 'utils', 'loopbackHostname.js'));

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
}

console.log('Loopback hostname contract');

// ---------------------------------------------------------------- host parsing
check('strips the port from an ordinary Host header', () => {
    assert.strictEqual(hostnameFromHostHeader('switchboard.localhost:4321'), 'switchboard.localhost');
    assert.strictEqual(hostnameFromHostHeader('127.0.0.1:65535'), '127.0.0.1');
    assert.strictEqual(hostnameFromHostHeader('localhost'), 'localhost');
});

check('lowercases, so case cannot smuggle a name past the guard', () => {
    assert.strictEqual(hostnameFromHostHeader('SwitchBoard.LOCALHOST:4321'), 'switchboard.localhost');
});

check('handles the bracketed IPv6 literal the old prefix test missed', () => {
    assert.strictEqual(hostnameFromHostHeader('[::1]'), '[::1]');
    assert.strictEqual(hostnameFromHostHeader('[::1]:8080'), '[::1]');
    assert.ok(isLoopbackHostHeader('[::1]:8080'), '[::1] with a port must be accepted');
});

check('returns null for malformed headers rather than guessing', () => {
    assert.strictEqual(hostnameFromHostHeader('127.0.0.1:evil'), null);
    assert.strictEqual(hostnameFromHostHeader('::1:8080'), null);
    assert.strictEqual(hostnameFromHostHeader('[::1'), null);
    assert.strictEqual(hostnameFromHostHeader('[::1]junk'), null);
    assert.strictEqual(hostnameFromHostHeader(''), null);
    assert.strictEqual(hostnameFromHostHeader(undefined), null);
});

check('a missing Host header is rejected, never defaulted', () => {
    assert.strictEqual(isLoopbackHostHeader(undefined), false);
    assert.strictEqual(isLoopbackHostHeader(''), false);
});

// ------------------------------------------------------------- accepted names
check('accepts the historical loopback names', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
        assert.ok(isLoopbackHostname(h), `${h} must be accepted`);
    }
});

check('accepts names under the reserved .localhost TLD', () => {
    for (const h of ['switchboard.localhost', 'a.localhost', 'board.sb.localhost', 'my-board.localhost']) {
        assert.ok(isLoopbackHostname(h), `${h} must be accepted`);
    }
});

// ------------------------------------------------------------- rejected names
check('rejects attacker-registrable names that merely contain "localhost"', () => {
    for (const h of [
        'localhost.evil.example',          // real domain, resolvable to 127.0.0.1
        'switchboard.localhost.evil.example',
        'notlocalhost',
        'localhostx',
        'xlocalhost',
    ]) {
        assert.strictEqual(isLoopbackHostname(h), false, `${h} must be rejected`);
    }
});

check('rejects a bare or malformed .localhost label', () => {
    for (const h of ['.localhost', 'localhost.', '-bad.localhost', 'bad-.localhost', '..localhost']) {
        assert.strictEqual(isLoopbackHostname(h), false, `${h} must be rejected`);
    }
});

check('does not widen to the rest of 127.0.0.0/8 or the LAN', () => {
    for (const h of ['127.0.0.2', '127.1.1.1', '0.0.0.0', '192.168.1.10', 'example.com']) {
        assert.strictEqual(isLoopbackHostname(h), false, `${h} must be rejected`);
    }
});

// -------------------------------------------------------------------- origins
check('mirrors CORS only for loopback origins', () => {
    assert.ok(isLoopbackOrigin('http://switchboard.localhost:4321'));
    assert.ok(isLoopbackOrigin('http://127.0.0.1:4321'));
    assert.strictEqual(isLoopbackOrigin('https://evil.example'), false);
    assert.strictEqual(isLoopbackOrigin('http://localhost.evil.example'), false);
    assert.strictEqual(isLoopbackOrigin('not a url'), false);
});

// ------------------------------------------------- no CLI / server guard drift
check('the server Host guard delegates to this module (no second predicate)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(
        /_isAllowedHost\([^)]*\)\s*:\s*boolean\s*\{\s*return isAllowedHostFor\(/.test(src),
        '_isAllowedHost must delegate to isAllowedHostFor (the bind-policy-aware predicate)'
    );
    assert.ok(
        /_isLocalhostOrigin\([^)]*\)\s*:\s*boolean\s*\{\s*return isAllowedOriginFor\(/.test(src),
        '_isLocalhostOrigin must delegate to isAllowedOriginFor'
    );
});

check('the WebSocket upgrade guard delegates too (it was the second predicate)', () => {
    // wsUpgradeAuth is what BOTH the board's state hub (wsHub) and the terminal
    // gateway call. It carried its own hand-rolled copies of these two checks, and
    // the copies never learned about `.localhost` — so a board served at
    // switchboard.localhost passed the HTTP guard above and then had every upgrade
    // 403'd: `Forbidden Host` in standalone, `Forbidden Origin` under the extension
    // host. Terminals rendered and never streamed. The check above only ever looked
    // at LocalApiServer.ts, which is exactly why this drift survived.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'wsUpgradeAuth.ts'), 'utf8');
    assert.ok(src.includes("from '../utils/loopbackHostname'"), 'wsUpgradeAuth must import the shared policy');
    assert.ok(
        /export function isAllowedHost\([^)]*\)\s*:\s*boolean\s*\{\s*return isAllowedHostFor\(/.test(src),
        'isAllowedHost must delegate to isAllowedHostFor, not re-implement a prefix test'
    );
    assert.ok(
        /return isAllowedOriginFor\(/.test(src),
        'isLocalhostOrigin must delegate to isAllowedOriginFor'
    );
    // The vscode-webview: origin allowance now lives in the shared module
    // (isAllowedOriginFor), not in wsUpgradeAuth — but it must survive the
    // delegation. Check the shared module directly.
    const loopbackSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'utils', 'loopbackHostname.ts'), 'utf8');
    assert.ok(
        loopbackSrc.includes("u.protocol === 'vscode-webview:'"),
        'the vscode-webview: origin allowance must survive in isAllowedOriginFor — the editor webview uses this gateway'
    );
});

check('the CLI validates --hostname with the same predicate', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(src.includes("from '../utils/loopbackHostname'"), 'cli.ts must import the shared policy');
    assert.ok(/isLoopbackHostname\(candidate\)/.test(src), 'cli.ts must validate --hostname against it');
});

check('the standalone URL is built from the validated hostname', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
    assert.ok(/const url = `http:\/\/\$\{displayHost\}:\$\{port\}`/.test(src), 'bootstrap must build url from displayHost');
    assert.ok(/listen\(this\._port/.test(fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8')));
});

check('the server still binds loopback — hostname is presentation, not reach', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(src.includes("this._server.listen(this._port || 0, '127.0.0.1'"), 'loopback bind address must stay 127.0.0.1');
    assert.ok(
        /remoteAddress !== '127\.0\.0\.1' && remoteAddress !== '::1'/.test(src),
        'the non-loopback peer rejection must remain (now with a tailnet-listener bypass)'
    );
    // The server must NEVER bind 0.0.0.0 — tailnet mode adds a second listener
    // on the specific tailnet address, not a wildcard.
    assert.ok(
        !src.includes("listen(this._port") || !/listen\([^)]*0\.0\.0\.0/.test(src),
        'the server must never bind 0.0.0.0'
    );
});

// ------------------------------------------------------------------------ CSP
check('every CSP that allows ws://localhost also allows ws://*.localhost', () => {
    const targets = [
        path.join(process.cwd(), 'src', 'services', 'headlessPanelHtml.ts'),
        path.join(process.cwd(), 'src', 'webview', 'shell.html'),
    ];
    for (const file of targets) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (!line.includes('ws://localhost:*')) { return; }
            assert.ok(
                line.includes('ws://*.localhost:*') && line.includes('wss://*.localhost:*'),
                `${path.basename(file)}:${i + 1} allows ws://localhost:* but not ws://*.localhost:* — ` +
                'the board would render and then never receive a state push'
            );
        });
    }
});

check('the DEFAULT display hostname is switchboard.localhost, not 127.0.0.1', () => {
    assert.strictEqual(DEFAULT_DISPLAY_HOSTNAME, 'switchboard.localhost');
    assert.ok(isLoopbackHostname(DEFAULT_DISPLAY_HOSTNAME));
});

check('no launch surface hardcodes the 127.0.0.1 display URL', () => {
    // Regression guard for the exact gap: the flag existed, the guard existed,
    // the CSP existed — and every builder still emitted 127.0.0.1.
    for (const f of ['src/standalone/cli.ts', 'src/standalone/bootstrap.ts', 'src/extension.ts']) {
        const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
        assert.ok(!/\?\?\s*'127\.0\.0\.1'/.test(src), `${f} must not default the display host to 127.0.0.1`);
    }
    const extSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(!/http:\/\/127\.0\.0\.1:\$\{port\}\/\?token=/.test(extSrc),
        'openInBrowser must build its URL from resolveDisplayHostname');
});

// ------------------------------------------------ resolveDisplayHostname behaviour
// The probe is the ENTIRE mitigation for defaulting to a name the OS resolver may
// not implement (Windows, stock macOS/Safari), so "the default is
// switchboard.localhost" is only half the contract — the other half is that a
// failed probe never reaches the user. Both branches below are machine-independent:
// a closed port refuses on every platform, whether or not `*.localhost` resolves.
async function behavioural() {
    const http = require('http');
    const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', port: srv.address().port }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const livePort = srv.address().port;

    await checkAsync('an explicit, reachable hostname is returned verbatim and warns nothing', async () => {
        const warnings = [];
        const host = await resolveDisplayHostname('127.0.0.1', livePort, m => warnings.push(m));
        assert.strictEqual(host, '127.0.0.1');
        assert.deepStrictEqual(warnings, [], 'a reachable explicit name must not warn');
    });

    await new Promise(r => srv.close(r));

    await checkAsync('an unreachable default falls back to 127.0.0.1 and logs one line', async () => {
        const warnings = [];
        const host = await resolveDisplayHostname(undefined, livePort, m => warnings.push(m));
        assert.strictEqual(host, '127.0.0.1',
            'never hand the user a URL that failed its own probe — that reads as "Switchboard is broken"');
        assert.strictEqual(warnings.length, 1, 'the fallback must be announced exactly once');
    });

    await checkAsync('an explicit name survives a failed probe — the user may manage a hosts entry', async () => {
        const warnings = [];
        const host = await resolveDisplayHostname('other.localhost', livePort, m => warnings.push(m));
        assert.strictEqual(host, 'other.localhost', 'an explicit choice outranks the probe: warn, never override');
        assert.strictEqual(warnings.length, 1);
    });

    await checkAsync('an unreachable probe resolves rather than hanging the launch', async () => {
        // isHostnameReachable is awaited by openInBrowser and by the standalone
        // bootstrap, so a pending promise is a command that never opens a browser
        // and never reports an error.
        const started = Date.now();
        await resolveDisplayHostname(undefined, livePort, () => { });
        assert.ok(Date.now() - started < 5000, 'the probe must be bounded by its own timeout');
    });
}

async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
}

behavioural().then(() => {
    if (failures > 0) {
        console.error(`\n${failures} assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll loopback hostname contract assertions passed.');
}, err => {
    console.error('\nloopback hostname contract harness error:', err);
    process.exit(1);
});
