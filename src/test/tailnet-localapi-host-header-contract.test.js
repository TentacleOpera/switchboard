'use strict';
/**
 * Tailnet LocalAPI Host-header contract.
 *
 * `resolveMagicDnsNames()` and `probeLocalApiSocket()` in `src/utils/tailnetDetect.ts`
 * both call the Tailscale LocalAPI over its unix socket. The daemon enforces a
 * `Host` header as its cross-origin defence on a world-readable socket
 * (`srw-rw-rw- root root`): a request that omits it is refused with
 * `403 invalid localapi request`. Before this fix, both probes omitted the
 * header, swallowed the 403, and returned an empty name list —
 * indistinguishable from "this machine has no MagicDNS name". The bind policy
 * was then built with an empty allowlist and the Host guard 403'd the only
 * name a person types.
 *
 * This test mirrors the exact 403-then-200 behaviour measured on the real
 * socket: a mock unix-socket server that 403s on any Host except
 * `local-tailscaled.sock`. A test that accepts any Host header cannot fail on
 * this bug.
 *
 * Invariants:
 *   1. `resolveMagicDnsNames` returns a `MagicDnsResult` tagged union, not a
 *      bare `string[]` — "no name" (source: 'localapi', names: []) is
 *      distinguishable from "probe refused" (source: 'unavailable', reason).
 *   2. Against a server returning a valid `Self.DNSName`, the result is
 *      `source: 'localapi'` with the dot-stripped, lower-cased FQDN.
 *   3. Against a server that always 403s, the result is `source: 'unavailable'`
 *      with a non-empty `reason` — NOT an empty `string[]` or a `source:
 *      'localapi'` with `names: []`.
 *   4. Both probes send the header. A behavioural test only covers the one
 *      probe it calls (`resolveMagicDnsNames`), so the second probe
 *      (`probeLocalApiSocket`) is covered by source-reading the module for two
 *      occurrences of the shared constant.
 *   5. `BindPolicy.magicDnsNames` stays typed `string[]` — the unwrapping from
 *      `MagicDnsResult.names` happens at the call site, not inside the policy
 *      type.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const OUT = path.join(process.cwd(), 'out');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
    resolveMagicDnsNames,
    LOCALAPI_HOST_HEADER,
    _setLocalApiSocketPathsForTest,
} = require(path.join(OUT, 'utils', 'tailnetDetect.js'));

let passed = 0, failed = 0;
const checks = [];
async function check(name, fn) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${e.message}`); }
}
function queueCheck(name, fn) { checks.push(() => check(name, fn)); }

// ------------------------------------------------- source-level invariants
queueCheck('resolveMagicDnsNames returns a MagicDnsResult tagged union, not a bare string[]', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetDetect.ts'), 'utf8');
    assert.ok(/export type MagicDnsResult/.test(src), 'MagicDnsResult type must be exported');
    assert.ok(/source:\s*'localapi'/.test(src), "the 'localapi' variant must exist");
    assert.ok(/source:\s*'unavailable'/.test(src), "the 'unavailable' variant must exist");
    assert.ok(/reason:\s*string/.test(src), "the 'unavailable' variant must carry a reason: string");
    assert.ok(/export async function resolveMagicDnsNames\(\):\s*Promise<MagicDnsResult>/.test(src),
        'resolveMagicDnsNames must be typed Promise<MagicDnsResult>');
});

queueCheck('the Host header constant is exported and shared by all probes (every probe references it)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'tailnetDetect.ts'), 'utf8');
    assert.ok(/export const LOCALAPI_HOST_HEADER/.test(src), 'LOCALAPI_HOST_HEADER must be exported');
    // Count occurrences of the constant in http.get options. Every probe must
    // reference it — a behavioural test only exercises resolveMagicDnsNames, so
    // probeLocalApiSocket is covered here by source-reading.
    const uses = (src.match(/headers:\s*\{\s*Host:\s*LOCALAPI_HOST_HEADER\s*\}/g) || []).length;
    assert.ok(uses >= 2, `all probes must send the header via the shared constant (found ${uses})`);
    assert.ok(/local-tailscaled\.sock/.test(src), 'the constant value must be local-tailscaled.sock');
});

queueCheck('BindPolicy.magicDnsNames stays string[] — unwrapping happens at the call site', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'utils', 'loopbackHostname.ts'), 'utf8');
    assert.ok(/magicDnsNames:\s*string\[\]/.test(src), 'BindPolicy.magicDnsNames must remain string[]');
});

queueCheck('cli.ts unwraps MagicDnsResult.names before building the bind policy', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(/magicDnsResult\.source\s*===\s*'unavailable'/.test(src),
        'cli.ts must branch on the unavailable source');
    assert.ok(/magicDnsNames\s*=\s*magicDnsResult\.names/.test(src),
        'cli.ts must unwrap .names into magicDnsNames (string[])');
    assert.ok(/Could not read this machine's MagicDNS name/.test(src),
        'cli.ts must print a warning when the probe is unavailable');
});

queueCheck('TaskViewerProvider.ts unwraps MagicDnsResult.names and surfaces the unavailable reason', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
    assert.ok(/magicDnsResult\.source\s*===\s*'unavailable'/.test(src),
        'TaskViewerProvider must branch on the unavailable source');
    assert.ok(/magicDnsNames\s*=\s*magicDnsResult\.names/.test(src),
        'TaskViewerProvider must unwrap .names into magicDnsNames (string[])');
    assert.ok(/Could not read this machine's MagicDNS name/.test(src),
        'TaskViewerProvider must log the unavailable reason on the extension side');
});

// ------------------------------------------------- behavioural: mock LocalAPI server
/**
 * Stand up a unix-socket HTTP server that mirrors the real Tailscale LocalAPI's
 * Host-header enforcement: 403 on any Host except the expected one, 200 with a
 * Self.DNSName payload otherwise. A test that accepts any Host cannot fail on
 * this bug.
 */
function startMockLocalApi(socketPath, mode) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const host = req.headers.host;
            if (host !== LOCALAPI_HOST_HEADER) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('invalid localapi request');
                return;
            }
            if (mode === 'always403') {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('invalid localapi request');
                return;
            }
            // mode === 'valid' — return a status payload with a trailing-dot FQDN.
            const body = JSON.stringify({
                Self: {
                    DNSName: 'PatrickRemoteDev.taile9aab9.ts.net.',
                    TailscaleIPs: ['100.110.206.86', 'fd7a:115c:a1e0::1001:cec3'],
                },
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
        });
        server.listen(socketPath, () => resolve(server));
        server.on('error', reject);
    });
}

async function withMockSocket(mode, fn) {
    const socketPath = path.join(os.tmpdir(), `sb-tailnet-localapi-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
    try { fs.unlinkSync(socketPath); } catch { /* not present */ }
    const server = await startMockLocalApi(socketPath, mode);
    _setLocalApiSocketPathsForTest([socketPath]);
    try {
        await fn(socketPath);
    } finally {
        _setLocalApiSocketPathsForTest(null);
        await new Promise((r) => server.close(() => r()));
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    }
}

queueCheck('against a valid LocalAPI response, resolveMagicDnsNames returns source:localapi with dot-stripped lowercased FQDN', async () => {
    await withMockSocket('valid', async () => {
        const result = await resolveMagicDnsNames();
        assert.strictEqual(result.source, 'localapi',
            `expected source 'localapi', got '${result.source}' (reason: ${result.reason || 'n/a'})`);
        // The mock payload's `Self.TailscaleIPs` carries both a v4 and a v6
        // address. `resolveMagicDnsNames` returns the dot-stripped lowercased
        // FQDN and the v6 address bracketed (Option B1: the v6 entry lives in
        // `magicDnsNames` so the allowlist and CSRF guard pick it up without a
        // new BindPolicy field). Both entries are exact-match only.
        assert.deepStrictEqual(result.names,
            ['patrickremotedev.taile9aab9.ts.net', '[fd7a:115c:a1e0::1001:cec3]'],
            'the trailing dot must be stripped, the name lower-cased, and the v6 address bracketed');
    });
});

queueCheck('against a server that always 403s, resolveMagicDnsNames returns source:unavailable with a non-empty reason', async () => {
    await withMockSocket('always403', async () => {
        const result = await resolveMagicDnsNames();
        assert.strictEqual(result.source, 'unavailable',
            `expected source 'unavailable' (the probe was refused), got '${result.source}'`);
        assert.ok(result.reason && result.reason.length > 0,
            'the unavailable reason must be non-empty and actionable');
        assert.ok(/403/.test(result.reason), 'the reason must name the HTTP status');
        assert.deepStrictEqual(result.names, [], 'unavailable must carry an empty names array');
    });
});

queueCheck('against a server that 403s on a missing Host, the header is what makes the valid case succeed', async () => {
    // This is the core regression: the mock 403s on any Host except the expected
    // one. If resolveMagicDnsNames omits the header, this test fails with
    // source 'unavailable'. The valid-case test above already proves the header
    // is sent; this test documents WHY — a server that enforces the header is
    // the whole point.
    await withMockSocket('valid', async () => {
        const result = await resolveMagicDnsNames();
        assert.strictEqual(result.source, 'localapi',
            'the probe must succeed only because it sends Host: local-tailscaled.sock');
    });
});

// ------------------------------------------------- Run
(async () => {
    // Run checks SEQUENTIALLY, not concurrently: the behavioural checks each
    // install a module-level socket-path override (_setLocalApiSocketPathsForTest)
    // and a concurrent run would race on that shared override, pointing one
    // check's probe at another check's mock socket.
    for (const run of checks) { await run(); }
    console.log('\nTailnet LocalAPI Host-header contract tests:');
    console.log(`  ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
})();
