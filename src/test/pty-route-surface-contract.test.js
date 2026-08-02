'use strict';

/**
 * Contract: the PTY verb surface lives on `/terminals/verb/`, and ONLY there.
 * (extension-host-pty-fleet-and-packaging.md, steps 2a and 3.)
 *
 * The guarantee this pins is structural rather than disciplinary. The VS Code sidebar
 * board posts to `/kanban/verb/`. If the four `pty*` verbs exist only on
 * `/terminals/verb/`, the sidebar CANNOT spawn a terminal it has no way to display —
 * enforced by routing, not by a convention a future edit can quietly break.
 *
 * It also pins the second half of that guarantee: `pty*` must stay out of the
 * GENERATED surface entirely (no catalog entries, no KANBAN_VERBS members), so
 * catalog:check / parity:check / verb-returns:check remain untouched by this feature.
 * A `pty` member appearing in the allowlist means an arm leaked into a Provider switch.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PTY_VERBS = [
    'ptyCreateTerminal', 'ptyCloseTerminal', 'ptyListTerminals', 'ptyRenameTerminal',
    'ptyClearTerminal', 'ptyClearAllTerminals',
];

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

function post(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
            res => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* non-JSON body */ }
                    resolve({ status: res.statusCode, body: json, raw: data });
                });
            }
        );
        req.on('error', reject);
        req.end(payload);
    });
}

(async function main() {
    console.log('\n── PTY route surface contract ──');

    const { LocalApiServer } = require(path.join(REPO_ROOT, 'out', 'services', 'LocalApiServer.js'));

    // --- generated-surface isolation ---------------------------------------
    await test('KANBAN_VERBS contains no pty member (nothing leaked into a Provider switch)', () => {
        const allowlist = require(path.join(REPO_ROOT, 'out', 'generated', 'verbAllowlist.js'));
        const kanbanVerbs = allowlist.KANBAN_VERBS;
        assert.ok(kanbanVerbs, 'verbAllowlist must export KANBAN_VERBS');
        const leaked = [...kanbanVerbs].filter(v => /^pty/i.test(v));
        assert.deepStrictEqual(
            leaked, [],
            `pty verb(s) leaked into the generated kanban allowlist: ${leaked.join(', ')}. `
            + 'They must be served by the dedicated /terminals/verb/ route, not a Provider switch — '
            + 'verb-returns:check reconciles case-label counts against allowlist size and will trip.'
        );
    });

    await test('the protocol catalog lists no pty verb', () => {
        const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'protocol-catalog.json'), 'utf8'));
        const text = JSON.stringify(catalog.verbs || catalog);
        const hits = PTY_VERBS.filter(v => new RegExp(`"${v}"`).test(text));
        assert.deepStrictEqual(hits, [], `pty verb(s) present in the generated catalog: ${hits.join(', ')}`);
    });

    // --- live routing -------------------------------------------------------
    await test('pty verbs are reachable on /terminals/verb/ and reach the terminalVerb hook', async () => {
        const seen = [];
        const server = new LocalApiServer({
            port: 0,
            workspaceRoot: REPO_ROOT,
            // Empty token keeps _checkAuth's historical loopback trust — the proven
            // in-repo pattern, not a hand-rolled bypass.
            getAuthToken: async () => '',
            terminalVerb: async (verb) => { seen.push(verb); return { success: true, verb }; },
        });
        await server.start();
        try {
            const port = server.getPort();
            for (const verb of PTY_VERBS) {
                const res = await post(port, `/terminals/verb/${verb}`, {});
                assert.strictEqual(res.status, 200, `${verb} should reach terminalVerb (got ${res.status})`);
                assert.strictEqual(res.body && res.body.verb, verb, `${verb} response must carry the dispatched verb in-body`);
            }
            assert.deepStrictEqual(seen, PTY_VERBS, 'terminalVerb must receive all four verbs');
        } finally {
            await server.stop();
        }
    });

    await test('/terminals/verb/ returns 503 when the host does not wire terminalVerb', async () => {
        // Matches how every other panel verb route behaves in a host that has not
        // constructed that panel — capability-gating honesty, not a silent 404.
        const server = new LocalApiServer({ port: 0, workspaceRoot: REPO_ROOT, getAuthToken: async () => '' });
        await server.start();
        try {
            const res = await post(server.getPort(), '/terminals/verb/ptyListTerminals', {});
            assert.strictEqual(res.status, 503, `expected 503 with no terminalVerb wired, got ${res.status}`);
        } finally {
            await server.stop();
        }
    });

    await test('pty verbs on /kanban/verb/ do NOT reach the terminal fleet', async () => {
        // The load-bearing half: even with BOTH hooks wired, a pty verb posted to the
        // kanban route must never be served by the terminal fleet. The sidebar posts
        // there, and it cannot display a PTY.
        const terminalSeen = [];
        const kanbanSeen = [];
        const server = new LocalApiServer({
            port: 0,
            workspaceRoot: REPO_ROOT,
            getAuthToken: async () => '',
            terminalVerb: async (verb) => { terminalSeen.push(verb); return { success: true }; },
            kanbanVerb: async (verb) => { kanbanSeen.push(verb); return { success: false, error: `Verb '${verb}' not implemented` }; },
        });
        await server.start();
        try {
            for (const verb of PTY_VERBS) {
                await post(server.getPort(), `/kanban/verb/${verb}`, {});
            }
            assert.deepStrictEqual(
                terminalSeen, [],
                `terminalVerb was reached via /kanban/verb/: ${terminalSeen.join(', ')} — the routing guarantee is broken.`
            );
            assert.deepStrictEqual(kanbanSeen, PTY_VERBS, 'the kanban route should still receive and reject them');
        } finally {
            await server.stop();
        }
    });

    await test('/ws/terminal is destroyed when no gateway is injected', async () => {
        const server = new LocalApiServer({ port: 0, workspaceRoot: REPO_ROOT, getAuthToken: async () => '' });
        await server.start();
        try {
            const port = server.getPort();
            const outcome = await new Promise((resolve) => {
                const req = http.request({
                    host: '127.0.0.1', port, path: '/ws/terminal?name=x', method: 'GET',
                    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
                });
                req.on('upgrade', () => resolve('upgraded'));
                req.on('response', res => resolve(`response:${res.statusCode}`));
                req.on('error', () => resolve('destroyed'));
                req.end();
            });
            assert.notStrictEqual(outcome, 'upgraded', 'an upgrade must not succeed with no terminalWsGateway wired');
        } finally {
            await server.stop();
        }
    });

    // --- both hosts wire it the same way ------------------------------------
    await test('the standalone host serves pty verbs on terminalVerb, not kanbanVerb', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        const kanbanVerbBlock = src.slice(src.indexOf('const kanbanVerb'), src.indexOf('const handlePtyVerb'));
        for (const verb of PTY_VERBS) {
            assert.ok(
                !new RegExp(`case '${verb}'`).test(kanbanVerbBlock),
                `bootstrap.ts still serves '${verb}' from kanbanVerb — it belongs on /terminals/verb/ only.`
            );
        }
        assert.ok(/terminalVerb:/.test(src), 'bootstrap.ts must wire terminalVerb into LocalApiServerOptions');
        assert.ok(
            /terminalVerb:[\s\S]{0,400}?ptyReady/.test(src),
            'the terminalVerb entry point must keep the ptyReady guard — an unguarded call surfaces as an unhandled spawn exception.'
        );
    });

    await test('the extension host wires terminalVerb and gates capabilities on the constructed fleet', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(/terminalVerb:/.test(src), 'TaskViewerProvider must wire terminalVerb');
        assert.ok(!/terminalWsGateway:\s*this\._terminalWsGateway/.test(src), 'TaskViewerProvider must not inject in-process terminalWsGateway into LocalApiServer');
        // Capability-gating honesty (PRD contract #6): the probe passing is not enough.
        // With no kanban db the fleet is never constructed, and advertising the panel
        // on the probe alone ships a Terminals icon whose every verb fails.
        assert.ok(
            /terminalFleet:\s*ptyHostReady\(\)/.test(src),
            'terminalFleet must derive from the CONSTRUCTED fleet (ptyHostReady()), not the bare probe.'
        );
        assert.ok(
            /terminals:\s*ptyHostReady\(\)/.test(src),
            'the /panels manifest must gate the terminals entry on the constructed fleet, not the bare probe.'
        );
    });

    await test('the extension host forwards pty verbs to the child process, never to an in-process fleet', () => {
        // The whole point of the out-of-process host: terminal work leaves the
        // extension's event loop (35.21 ms p50 in-process vs 0.24 ms out). A
        // "convenience" re-introduction of an in-process PtyFleetService or a
        // TerminalWsGateway here puts every frame straight back on the contended loop.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            /_ptyHostVerb\s*\(\s*verb\s*,\s*payload\s*\)/.test(src),
            'the extension-host terminalVerb arm must forward through _ptyHostVerb (HTTP to the child), not serve verbs locally.'
        );
        assert.ok(
            /\/api\/pty\/\$\{encodeURIComponent\(verb\)\}/.test(src),
            '_ptyHostVerb must POST to the child on /api/pty/<verb>.'
        );
        assert.ok(
            !/new\s+PtyFleetService\s*\(/.test(src),
            'TaskViewerProvider must not construct a PtyFleetService — the fleet lives in the pty host child.'
        );
        assert.ok(
            !/new\s+TerminalWsGateway\s*\(/.test(src),
            'TaskViewerProvider must not construct a TerminalWsGateway — the gateway lives in the pty host child.'
        );
        // Dispatch delivery must keep its bracketed-paste/chunking/lock machinery. A
        // raw ptyWrite submits a multi-line prompt line by line and the agent runs
        // fragments; the lock can only serialise concurrent dispatches on the child.
        assert.ok(
            /_ptyHostVerb\('ptySendPrompt'/.test(src),
            'dispatch delivery to a PTY must use the ptySendPrompt verb, not a raw ptyWrite.'
        );
        const child = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyHost.ts'), 'utf8');
        assert.ok(
            /case 'ptySendPrompt'/.test(child) && /sendPromptToPty\(/.test(child),
            'the pty host must serve ptySendPrompt via sendPromptToPty.'
        );
        // process.execPath in the extension host is the ELECTRON binary. Without this
        // the spawn opens a second IDE window instead of running the script.
        assert.ok(
            /ELECTRON_RUN_AS_NODE:\s*'1'/.test(src),
            'the pty host spawn must set ELECTRON_RUN_AS_NODE=1 — process.execPath is Electron under the extension host.'
        );
    });

    await test('terminals.js dials the pty host origin, not the page origin', () => {
        // Plan 3's regression: the panel and the gateway are no longer the same server
        // under the extension host. Rebuilding the socket URL from location.host
        // silently re-couples the panel to the extension port, which serves nothing.
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        assert.ok(
            /PTY_HOST_ORIGIN\}\/ws\/terminal/.test(js),
            'terminals.js must build the /ws/terminal URL from PTY_HOST_ORIGIN.'
        );
        assert.ok(
            !/\$\{location\.host\}\/ws\/terminal/.test(js),
            'terminals.js must not construct the terminal socket URL from location.host directly — that is the re-coupling regression.'
        );
        assert.ok(
            /dataset\.ptyHostOrigin/.test(js),
            'PTY_HOST_ORIGIN must read the serve-time data-pty-host-origin body attribute.'
        );
        // The standalone host injects nothing and must stay byte-identical, so the
        // location fallback has to survive.
        assert.ok(
            /__SB_PTY_HOST_ORIGIN__[\s\S]{0,160}location\.host/.test(js),
            'the location.host fallback must remain so the standalone host is unchanged.'
        );
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            /data-pty-host-origin="ws:\/\/127\.0\.0\.1:\$\{this\._ptyHostPort\}"/.test(src),
            'the extension host must inject data-pty-host-origin alongside data-terminal-token at serve time.'
        );
    });

    await test('the webview posts pty verbs to /terminals/verb/ and keeps getSetting on /kanban/verb/', () => {
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        for (const verb of PTY_VERBS) {
            assert.ok(new RegExp(`/terminals/verb/${verb}`).test(js), `terminals.js must post ${verb} to /terminals/verb/`);
            assert.ok(!new RegExp(`/kanban/verb/${verb}`).test(js), `terminals.js still posts ${verb} to /kanban/verb/`);
        }
        // getSetting is a KANBAN verb (the agents.visibleAgents role-picker read). A
        // blanket "everything to /terminals/verb/" edit breaks the role picker.
        assert.ok(
            /\/kanban\/verb\/getSetting/.test(js),
            'getSetting is a kanban verb and must stay on /kanban/verb/ — moving it breaks the role picker.'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} contract check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll PTY route surface checks passed.\n');
})();
