'use strict';

/**
 * Contract: one board-resolution chain, both clients — the tagged ApiTarget.
 *
 * Plan: `the-cli-reaches-a-remote-board-over-the-tailnet`.
 *
 * The resolver is the head of the chain: every remote command resolves an
 * ApiTarget once, and every value carries where it came from. The failure
 * shapes this pins are all quiet-wrong-answer shapes: a remote root guessed
 * from selectedWorkspaceRoot, a corrupt remotes.json read as unconfigured, a
 * named remote demoted to local discovery, a connect-port/expected-port probe
 * that fails a healthy tailscale-serve remote, a token precedence that
 * differs by which binary the operator installed.
 *
 * Behavioural assertions run against `out/` (run `npm run compile-tests`
 * first) with injected health/discovery — the precedence contract is
 * exercised without sockets. The parity assertions are source-level against
 * `src/` and `internal/client/resolve.go`: flag names, env names, tier order,
 * and refusal semantics must read identically in both clients.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const api = require(path.join(REPO, 'out', 'standalone', 'apiTarget.js'));
const { resolveApiTarget, MissingRootError, StaleRemoteRootError, loadRemotesConfig } = api;

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err && err.message}`); }
}
async function acheck(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err && err.message}`); }
}

function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'api-target-')); }

function writeRemotes(obj) {
    const p = path.join(tmpdir(), 'remotes.json');
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
}

/** Health injection helpers — the resolver's remote path never needs a socket. */
const healthy = roots => async () => ({ service: 'switchboard', status: 'ok', port: 7777, roots });
const dead = code => async () => { const e = new Error(code === 'ENOTFOUND' ? 'getaddrinfo ENOTFOUND x' : 'connect ECONNREFUSED'); e.code = code; throw e; };
const noLocal = async () => null;

const REMOTE = { url: 'http://labcom.example.net:7777' };

async function run() {
    console.log('\ncli-api-target-contract\n');

    // ── 1. Endpoint precedence ──────────────────────────────────────────

    await acheck('--remote <url> resolves with a flag source and skips discovery', async () => {
        let discovered = false;
        const t = await resolveApiTarget({
            remote: 'http://labcom.example.net:7777',
            env: {}, clientCwd: '/tmp/x',
            remotesPath: path.join(tmpdir(), 'absent.json'),
            fetchHealth: healthy(['/srv/board']),
            discoverLocal: async () => { discovered = true; return { port: 7777, via: 'probe' }; },
        });
        assert.strictEqual(t.baseUrl, 'http://labcom.example.net:7777');
        assert.strictEqual(t.source, 'flag:--remote http://labcom.example.net:7777');
        assert.strictEqual(t.isRemote, true);
        assert.strictEqual(discovered, false, 'explicit endpoint must never touch local discovery');
    });

    await acheck('--remote <name> resolves through remotes.json, carrying the stored root', async () => {
        const t = await resolveApiTarget({
            remote: 'labcom',
            env: {}, clientCwd: '/tmp/x',
            remotesPath: writeRemotes({ remotes: { labcom: { ...REMOTE, workspaceRoot: '/srv/board' } } }),
            fetchHealth: healthy(['/srv/board']),
            discoverLocal: noLocal,
        });
        assert.strictEqual(t.baseUrl, 'http://labcom.example.net:7777');
        assert.strictEqual(t.remoteName, 'labcom');
        assert.strictEqual(t.workspaceRoot, '/srv/board');
        assert.strictEqual(t.rootSource, 'config:remotes.labcom.workspaceRoot');
    });

    await acheck('a named remote that is not configured is an error, never a demotion', async () => {
        let discovered = false;
        await assert.rejects(
            resolveApiTarget({
                remote: 'ghost', env: {}, clientCwd: '/tmp/x',
                remotesPath: path.join(tmpdir(), 'absent.json'),
                fetchHealth: healthy(['/r']),
                discoverLocal: async () => { discovered = true; return { port: 7777, via: 'probe' }; },
            }),
            /ghost/
        );
        assert.strictEqual(discovered, false, 'a failed remote name must not demote to local discovery');
    });

    await acheck('--remote + --server disagreeing is a loud conflict', async () => {
        await assert.rejects(
            resolveApiTarget({
                remote: 'http://a.example.net:7777', server: 'http://b.example.net:7777',
                env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
                fetchHealth: healthy(['/r']), discoverLocal: noLocal,
            }),
            /conflicting endpoints/
        );
    });

    await acheck('--remote + --server agreeing is agreement, not conflict', async () => {
        const t = await resolveApiTarget({
            remote: 'http://labcom.example.net:7777', server: 'http://labcom.example.net:7777/',
            env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/srv/board']), discoverLocal: noLocal,
        });
        assert.strictEqual(t.baseUrl, 'http://labcom.example.net:7777');
    });

    await acheck('SWITCHBOARD_REMOTE outranks --server', async () => {
        const t = await resolveApiTarget({
            server: 'http://b.example.net:7777',
            env: { SWITCHBOARD_REMOTE: 'http://a.example.net:7777' },
            clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/srv/board']), discoverLocal: noLocal,
        });
        assert.strictEqual(t.baseUrl, 'http://a.example.net:7777');
        assert.strictEqual(t.source, 'env:SWITCHBOARD_REMOTE');
    });

    await acheck('SWITCHBOARD_SERVER_URL resolves that URL and never consults discovery', async () => {
        let discovered = false;
        const t = await resolveApiTarget({
            env: { SWITCHBOARD_SERVER_URL: 'http://labcom.example.net:7777' },
            clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/srv/board']),
            discoverLocal: async () => { discovered = true; return { port: 7777, via: 'probe' }; },
        });
        assert.strictEqual(t.baseUrl, 'http://labcom.example.net:7777');
        assert.strictEqual(t.source, 'env:SWITCHBOARD_SERVER_URL');
        assert.strictEqual(t.isRemote, true);
        assert.strictEqual(discovered, false, 'a seat carrying SWITCHBOARD_SERVER_URL must never dial 127.0.0.1');
    });

    await acheck('SWITCHBOARD_REMOTE vs SWITCHBOARD_SERVER_URL disagreeing is a loud conflict', async () => {
        await assert.rejects(
            resolveApiTarget({
                env: { SWITCHBOARD_REMOTE: 'http://a.example.net:7777', SWITCHBOARD_SERVER_URL: 'http://b.example.net:7777' },
                clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
                fetchHealth: healthy(['/r']), discoverLocal: noLocal,
            }),
            /conflicting endpoints/
        );
    });

    await acheck('remotes.json defaultRemote routes bare commands, tagged config', async () => {
        const t = await resolveApiTarget({
            env: {}, clientCwd: '/tmp/x',
            remotesPath: writeRemotes({ defaultRemote: 'labcom', remotes: { labcom: REMOTE } }),
            fetchHealth: healthy(['/srv/board']), discoverLocal: noLocal,
        });
        assert.strictEqual(t.source, 'config:remotes.labcom');
        assert.strictEqual(t.baseUrl, 'http://labcom.example.net:7777');
        assert.strictEqual(t.isRemote, true);
    });

    await acheck('a corrupt remotes.json surfaces as corrupt, not as unconfigured', async () => {
        await assert.rejects(
            resolveApiTarget({
                env: {}, clientCwd: '/tmp/x', remotesPath: writeRemotes('{not json'),
                fetchHealth: healthy(['/r']), discoverLocal: noLocal,
            }),
            /corrupt/
        );
    });

    await acheck('https with no port dials 443 (the tailscale serve spelling)', async () => {
        let seen = '';
        const t = await resolveApiTarget({
            server: 'https://labcom.tail-xyz.ts.net',
            env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: async base => { seen = base; return { service: 'switchboard', status: 'ok', port: 7777, roots: ['/r'] }; },
            discoverLocal: noLocal,
        });
        assert.strictEqual(t.baseUrl, 'https://labcom.tail-xyz.ts.net:443');
        assert.strictEqual(seen, 'https://labcom.tail-xyz.ts.net:443');
    });

    // ── 2. Root precedence ──────────────────────────────────────────────

    await acheck('a remote root is never guessed — multi-root remote without a root refuses and lists', async () => {
        const err = await resolveApiTarget({
            server: 'http://labcom.example.net:7777',
            env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/srv/board-a', '/srv/board-b']), discoverLocal: noLocal,
        }).then(() => null, e => e);
        assert.ok(err instanceof MissingRootError, `want MissingRootError, got ${err && err.constructor && err.constructor.name}`);
        assert.deepStrictEqual(err.roots, ['/srv/board-a', '/srv/board-b']);
    });

    await acheck('a single advertised root auto-picks, tagged health-roots', async () => {
        const t = await resolveApiTarget({
            server: 'http://labcom.example.net:7777',
            env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/srv/only-board']), discoverLocal: noLocal,
        });
        assert.strictEqual(t.workspaceRoot, '/srv/only-board');
        assert.strictEqual(t.rootSource, 'health-roots');
    });

    await acheck('a stale stored root refuses and re-lists, never silently switches', async () => {
        const err = await resolveApiTarget({
            remote: 'labcom',
            env: {}, clientCwd: '/tmp/x',
            remotesPath: writeRemotes({ remotes: { labcom: { ...REMOTE, workspaceRoot: '/old/root' } } }),
            fetchHealth: healthy(['/new/root-a', '/new/root-b']), discoverLocal: noLocal,
        }).then(() => null, e => e);
        assert.ok(err instanceof StaleRemoteRootError, `want StaleRemoteRootError, got ${err && err.constructor && err.constructor.name}`);
        assert.strictEqual(err.storedRoot, '/old/root');
        assert.deepStrictEqual(err.roots, ['/new/root-a', '/new/root-b']);
    });

    await acheck('SWITCHBOARD_WORKSPACE_ROOT beats the client cwd and the stored root', async () => {
        const t = await resolveApiTarget({
            remote: 'labcom',
            env: { SWITCHBOARD_WORKSPACE_ROOT: '/env/root' }, clientCwd: '/tmp/x',
            remotesPath: writeRemotes({ remotes: { labcom: { ...REMOTE, workspaceRoot: '/srv/board' } } }),
            fetchHealth: healthy(['/srv/board']), discoverLocal: noLocal,
        });
        assert.strictEqual(t.workspaceRoot, '/env/root');
        assert.strictEqual(t.rootSource, 'env:SWITCHBOARD_WORKSPACE_ROOT');
    });

    await acheck('--workspace-root beats every other tier', async () => {
        const t = await resolveApiTarget({
            remote: 'labcom', workspaceRoot: '/explicit/root',
            env: { SWITCHBOARD_WORKSPACE_ROOT: '/env/root' }, clientCwd: '/tmp/x',
            remotesPath: writeRemotes({ remotes: { labcom: { ...REMOTE, workspaceRoot: '/srv/board' } } }),
            fetchHealth: healthy(['/srv/board']), discoverLocal: noLocal,
        });
        assert.strictEqual(t.workspaceRoot, '/explicit/root');
        assert.strictEqual(t.rootSource, 'flag:--workspace-root');
    });

    await acheck('an unreachable remote resolves to an error naming it — ENOTFOUND is the rename case', async () => {
        await assert.rejects(
            resolveApiTarget({
                remote: 'labcom',
                env: {}, clientCwd: '/tmp/x',
                remotesPath: writeRemotes({ remotes: { labcom: REMOTE } }),
                fetchHealth: dead('ENOTFOUND'), discoverLocal: noLocal,
            }),
            /labcom.*does not resolve.*renamed/s
        );
    });

    await acheck('ECONNREFUSED names a reachable host with a stopped board', async () => {
        await assert.rejects(
            resolveApiTarget({
                server: 'http://labcom.example.net:7777',
                env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
                fetchHealth: dead('ECONNREFUSED'), discoverLocal: noLocal,
            }),
            /refused the connection.*not listening/s
        );
    });

    // ── 3. Local path untouched ─────────────────────────────────────────

    await acheck('no remote named: local discovery returns today\'s local target', async () => {
        const t = await resolveApiTarget({
            env: {}, clientCwd: '/srv/local-board',
            remotesPath: path.join(tmpdir(), 'absent.json'),
            fetchHealth: healthy([]),
            discoverLocal: async () => ({ port: 7777, via: 'probe' }),
        });
        assert.strictEqual(t.isRemote, false);
        assert.strictEqual(t.baseUrl, 'http://127.0.0.1:7777');
        assert.strictEqual(t.source, 'local:probe');
        assert.strictEqual(t.workspaceRoot, path.resolve('/srv/local-board'));
        assert.strictEqual(t.rootSource, 'local:cwd');
    });

    await acheck('the port-file path is tagged local:port-file', async () => {
        const t = await resolveApiTarget({
            env: {}, clientCwd: '/srv/local-board',
            remotesPath: path.join(tmpdir(), 'absent.json'),
            fetchHealth: healthy([]),
            discoverLocal: async () => ({ port: 7779, via: 'port-file' }),
        });
        assert.strictEqual(t.source, 'local:port-file');
        assert.strictEqual(t.baseUrl, 'http://127.0.0.1:7779');
    });

    // ── 4. Token precedence ─────────────────────────────────────────────

    await acheck('SWITCHBOARD_API_TOKEN wins over every other tier', async () => {
        const t = await resolveApiTarget({
            server: 'http://labcom.example.net:7777',
            env: { SWITCHBOARD_API_TOKEN: 'envtok' }, clientCwd: '/tmp/x',
            remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/r']), discoverLocal: noLocal,
        });
        assert.deepStrictEqual(t.auth, { token: 'envtok', source: 'env:SWITCHBOARD_API_TOKEN' });
    });

    await acheck('--token-file beats the workspace token file', async () => {
        const tf = path.join(tmpdir(), 'tok.txt');
        fs.writeFileSync(tf, 'filetok\n');
        const t = await resolveApiTarget({
            server: 'http://labcom.example.net:7777', tokenFile: tf,
            env: {}, clientCwd: '/tmp/x',
            remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/r']), discoverLocal: noLocal,
        });
        assert.deepStrictEqual(t.auth, { token: 'filetok', source: 'flag:--token-file' });
    });

    await acheck('an unreadable --token-file is an error, never a demotion to no-credential', async () => {
        // An explicitly requested credential source that fails must not fall
        // through to `tailnet-listener-trusted` — the tag would assert no
        // credential is the CORRECT posture when one was asked for and could
        // not be read. Same no-inter-tier-fallback rule as the endpoint chain.
        await assert.rejects(
            resolveApiTarget({
                server: 'http://labcom.example.net:7777', tokenFile: '/nonexistent/token.txt',
                env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
                fetchHealth: healthy(['/r']), discoverLocal: noLocal,
            }),
            /--token-file/
        );
        const empty = path.join(tmpdir(), 'empty.txt');
        fs.writeFileSync(empty, '   \n');
        await assert.rejects(
            resolveApiTarget({
                server: 'http://labcom.example.net:7777', tokenFile: empty,
                env: {}, clientCwd: '/tmp/x', remotesPath: path.join(tmpdir(), 'a.json'),
                fetchHealth: healthy(['/r']), discoverLocal: noLocal,
            }),
            /empty/
        );
    });

    await acheck('no credential on a remote is tailnet-listener-trusted, not an error', async () => {
        const t = await resolveApiTarget({
            server: 'http://labcom.example.net:7777',
            env: {}, clientCwd: tmpdir(),
            remotesPath: path.join(tmpdir(), 'a.json'),
            fetchHealth: healthy(['/r']), discoverLocal: noLocal,
        });
        assert.deepStrictEqual(t.auth, { token: null, source: 'tailnet-listener-trusted' });
    });

    // ── 5. Parity + structure pins (source-level) ───────────────────────

    check('the module exports the tagged ApiTarget seam', () => {
        assert.strictEqual(typeof resolveApiTarget, 'function');
        assert.strictEqual(typeof MissingRootError, 'function');
        assert.strictEqual(typeof StaleRemoteRootError, 'function');
        assert.strictEqual(typeof loadRemotesConfig, 'function');
    });

    check('both clients name the same env vars and flags', () => {
        const node = read('src/standalone/apiTarget.ts');
        const go = read('internal/client/resolve.go');
        for (const name of ['SWITCHBOARD_REMOTE', 'SWITCHBOARD_SERVER_URL', 'SWITCHBOARD_WORKSPACE_ROOT', 'SWITCHBOARD_API_TOKEN', 'SWITCHBOARD_STATE_HOME']) {
            assert.ok(node.includes(name), `Node resolver missing ${name}`);
            assert.ok(go.includes(name), `Go resolver missing ${name}`);
        }
        for (const flag of ['--remote', '--server', '--workspace-root', '--token-file']) {
            assert.ok(node.includes(flag), `Node resolver missing ${flag}`);
            assert.ok(go.includes(flag), `Go resolver missing ${flag}`);
        }
        // Same refusal vocabularies.
        for (const marker of ['conflicting endpoints', 'not configured', 'corrupt', 'health-roots']) {
            assert.ok(node.includes(marker), `Node resolver missing "${marker}"`);
            assert.ok(go.includes(marker), `Go resolver missing "${marker}"`);
        }
    });

    check('the Go client parses --remote and names an unreachable remote', () => {
        const main = read('cmd/switchboard/main.go');
        assert.ok(main.includes('"--remote"'), 'main.go connectionFlags missing --remote');
        assert.ok(main.includes('opts.Remote'), 'extractConnectionFlags does not populate Options.Remote');
        assert.ok(main.includes('DescribeUnreachable'), 'runOwnedVerb does not name the unreachable remote');
        assert.ok(main.includes('StaleRootError'), 'runOwnedVerb does not surface the stale-root re-list');
    });

    check('selectedWorkspaceRoot is never read as a root fallback', () => {
        const node = read('src/standalone/apiTarget.ts');
        const go = read('internal/client/resolve.go');
        // The field may appear in the HealthJson interface type only — never
        // in a resolution expression.
        assert.ok(!/workspaceRoot\s*=\s*health!?\.selectedWorkspaceRoot|roots\[0\].*selectedWorkspaceRoot/.test(node),
            'Node resolver reads selectedWorkspaceRoot as a root');
        assert.ok(!/SelectedWorkspaceRoot/.test(go), 'Go resolver reads SelectedWorkspaceRoot');
    });

    check('local discovery is invoked exactly once — inside the absent-remote branch', () => {
        const node = read('src/standalone/apiTarget.ts');
        const calls = node.match(/await discoverLocal\(cwd\)/g) || [];
        assert.strictEqual(calls.length, 1, `discoverLocal(cwd) must be called exactly once, found ${calls.length}`);
    });

    check('a token value is never accepted in argv — no --token flag exists', () => {
        const node = read('src/standalone/apiTarget.ts');
        const go = read('internal/client/resolve.go');
        const main = read('cmd/switchboard/main.go');
        for (const [name, src] of [['apiTarget.ts', node], ['resolve.go', go], ['main.go', main]]) {
            assert.ok(!/"--token"/.test(src) && !/args\[i\+1\].*Token\b/.test(src.replace(/--token-file/g, '')),
                `${name} accepts a token value in argv`);
        }
    });

    await acheck('probeHealth connect≠expected succeeds on the expected port and fails on a third value', async () => {
        // cli.ts runs main() at load and cannot be required — transpile the
        // real probeHealth/getHealthJson out of the source and run them
        // against a live loopback server, http/https injected.
        const tsc = require('typescript');
        const src = read('src/standalone/cli.ts');
        function extractFn(name) {
            // Top-level declarations close at column 0 — brace counting from
            // the signature is wrong because getHealthJson's return type is a
            // `Promise<{...}>` whose braces precede the body.
            const start = src.indexOf(`async function ${name}(`);
            assert.ok(start > -1, `${name} not found in cli.ts`);
            const end = src.indexOf('\n}\n', start);
            assert.ok(end > start, `${name} body not closed`);
            return src.slice(start, end + 2);
        }
        const compiled = tsc.transpileModule(
            `${extractFn('getHealthJson')}\n${extractFn('probeHealth')}\nmodule.exports = { probeHealth };`,
            { compilerOptions: { module: 'commonjs', target: 'es2020' } }
        ).outputText;
        const mod = { exports: {} };
        new Function('module', 'http', 'https', compiled)(mod, http, https);
        const { probeHealth } = mod.exports;
        const srv = http.createServer((_req, res) => {
            res.end(JSON.stringify({ service: 'switchboard', status: 'ok', port: 7777, roots: [] }));
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        try {
            const connectPort = srv.address().port;
            // tailscale-serve shape: connect on connectPort, board reports 7777.
            assert.strictEqual(await probeHealth(connectPort, '127.0.0.1', 2000, 7777), true,
                'connect port ≠ expected port must pass when the body reports the expected port');
            assert.strictEqual(await probeHealth(connectPort, '127.0.0.1', 2000, 9999), false,
                'a body reporting a third value must fail — the comparison is load-bearing');
        } finally {
            srv.close();
        }
    });

    check('probeHealth splits connect port from expected port; getHealthJson takes a scheme', () => {
        const cli = read('src/standalone/cli.ts');
        const sig = cli.match(/async function probeHealth\(([^)]*)\)/);
        assert.ok(sig && sig[1].includes('expectedPort'), 'probeHealth lacks an expectedPort param');
        assert.ok(/json\.port === expectedPort/.test(cli), 'probeHealth still compares the connect port');
        const gsig = cli.match(/async function getHealthJson\(([^)]*)\)/);
        assert.ok(gsig && gsig[1].includes('scheme'), 'getHealthJson lacks a scheme param');
        assert.ok(/scheme === 'https' \? https : http/.test(cli), 'getHealthJson does not pick the transport by scheme');
    });

    check('discoverAuthToken runs env → token-file → workspace file', () => {
        const cli = read('src/standalone/cli.ts');
        const body = cli.slice(cli.indexOf('function discoverAuthToken'), cli.indexOf('interface ApiResponse'));
        // Key on the READ sites, not the identifiers — `tokenFileArg` first
        // occurs in the signature, which precedes the env read by position.
        const envIdx = body.indexOf('process.env.SWITCHBOARD_API_TOKEN');
        const fileIdx = body.indexOf('readFileSync(tokenFileArg');
        const wsIdx = body.indexOf("'.switchboard', 'api-server-token.txt'");
        assert.ok(envIdx > -1 && fileIdx > -1 && wsIdx > -1, 'discoverAuthToken is missing a precedence tier');
        assert.ok(envIdx < fileIdx && fileIdx < wsIdx, 'token precedence order is wrong');
    });

    check('remotes.json absent file is an absent tier (null), never an error', () => {
        const p = path.join(tmpdir(), 'absent.json');
        assert.strictEqual(loadRemotesConfig(p), null);
    });

    console.log(failures === 0 ? '\nALL PASSED\n' : `\n${failures} FAILED\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
