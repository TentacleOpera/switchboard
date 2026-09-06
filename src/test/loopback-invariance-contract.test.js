'use strict';
/**
 * Loopback-invariance contract.
 *
 * This is the regression test for the paired-app plan's OWN first draft, which
 * proposed binding `LocalApiServer` off `127.0.0.1` behind mandatory auth. That
 * would have dismantled a four-layer, threat-modelled guard to enable something
 * a tunnel already does better. The plan's non-goal is now explicit — "binding
 * off loopback ... the plan should be read as forbidding it" — and this test is
 * what stops a future well-meaning `--bind` flag from re-opening it.
 *
 * The invariant is NOT "the server only ever listens on 127.0.0.1". `switchboard
 * tailnet` adds a SECOND listener on the Tailscale interface, and that is a
 * deliberate, typed, operator-invoked widening (covered by
 * tailscale-bind-contract). The invariant this file pins is narrower and load-
 * bearing:
 *
 *   1. The loopback listener is unconditional — there is no policy, flag, env
 *      var or setting under which it is absent.
 *   2. There is exactly ONE loopback predicate, and nothing configures it away.
 *   3. No `--bind` / `--host` flag exists that changes the bind address. A
 *      `--hostname` value that is not loopback is REFUSED, not honoured.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'out');

const {
    isLoopbackHostname,
    isLoopbackHostHeader,
    LOOPBACK_ONLY_POLICY,
    isTailnetPolicy,
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

check('the default policy is loopback-only', () => {
    assert.strictEqual(LOOPBACK_ONLY_POLICY.loopbackOnly, true,
        'LOOPBACK_ONLY_POLICY must be loopback-only.');
    assert.strictEqual(isTailnetPolicy(LOOPBACK_ONLY_POLICY), false,
        'The default policy must not read as a tailnet policy.');
});

check('the guard accepts every loopback form and rejects lookalikes', () => {
    for (const name of ['127.0.0.1', 'localhost', '::1', 'switchboard.localhost']) {
        assert.ok(isLoopbackHostname(name), `${name} must be accepted`);
    }
    // Attacker-registrable names that merely CONTAIN the magic word. Only the
    // reserved .localhost TLD is unspoofable.
    for (const name of ['localhost.evil.example', 'notlocalhost', 'evil.com', '127.0.0.1.evil.example']) {
        assert.ok(!isLoopbackHostname(name), `${name} must be rejected`);
    }
});

check('the Host-header guard parses rather than prefix-matches', () => {
    assert.ok(isLoopbackHostHeader('127.0.0.1:7777'), '127.0.0.1:7777 must be accepted');
    assert.ok(isLoopbackHostHeader('[::1]:7777'), '[::1]:7777 must be accepted');
    assert.ok(!isLoopbackHostHeader('127.0.0.1.evil.example:7777'),
        'A prefix match would accept this — the guard must parse the hostname.');
});

check('no configuration path can disable the loopback guard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/utils/loopbackHostname.ts'), 'utf8');
    assert.ok(!/process\.env\.(SWITCHBOARD_)?BIND/i.test(src),
        'No env var may override the loopback guard.');
    assert.ok(!/getConfiguration\(|workspaceConfig/.test(src),
        'No VS Code setting may override the loopback guard.');
});

check('no --bind or --host flag exists that changes the bind address', () => {
    for (const rel of ['src/standalone/cli.ts', 'src/standalone/bootstrap.ts']) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.ok(!/['"]--bind['"]/.test(src) && !/\battrs?\.bind\b/.test(src),
            `${rel} must not introduce a --bind flag — see the plan non-goal.`);
        assert.ok(!/['"]--host['"]/.test(src),
            `${rel} must not introduce a --host flag; --hostname is the DISPLAY name and is ` +
            'validated against the loopback guard, not a bind address.');
    }
});

check('the CLI validates --hostname through the single loopback predicate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/standalone/cli.ts'), 'utf8');
    assert.ok(src.includes('isLoopbackHostname'),
        'cli.ts must consult isLoopbackHostname — a second copy of the predicate is how ' +
        'the CLI and the server drift and lock the operator out.');
});

check('the loopback listener is unconditional in the standalone host', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/standalone/bootstrap.ts'), 'utf8');
    assert.ok(src.includes('LOOPBACK_ONLY_POLICY'),
        'bootstrap.ts must default to LOOPBACK_ONLY_POLICY.');
});

check('LocalApiServer runs Host/Origin through the policy-aware guard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/LocalApiServer.ts'), 'utf8');
    assert.ok(/isAllowedHostFor|isLoopbackHostHeader/.test(src),
        'LocalApiServer must guard the Host header — DNS-rebinding protection.');
    assert.ok(/isAllowedOriginFor|isLoopbackOrigin/.test(src),
        'LocalApiServer must guard the Origin header.');
});

if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll loopback invariance contract assertions passed.');
