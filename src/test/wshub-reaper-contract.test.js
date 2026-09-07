'use strict';

/**
 * Contract tests for the wsHub reaper's removal behaviour.
 *
 * The reaper terminates a dead connection but, before the fix, never removed
 * it from `_connections`. For an already-dead socket (peer vanished without a
 * TCP FIN) `terminate()` is a no-op that emits no `close` event, so
 * `handleDisconnect` never ran and the entry was re-reaped every tick for the
 * process lifetime — unbounded log growth, a leaking set, and a `send()` into
 * a dead socket on every broadcast.
 *
 * These tests prove the fix by making `terminate()` a true no-op that emits
 * nothing (the production bug condition) and asserting that removal is the
 * reaper's own action — not deferred to a `close` event. The existing B2 test
 * in `design-view-state-seats-contract.test.js` uses `autoPong: false` but
 * passes today because the socket is still OPEN when terminated, so `close`
 * fires and `handleDisconnect` removes it. That does not reproduce the bug.
 *
 * Run: node --require ./src/test/bootstrap/sandboxStateHome.js
 *      src/test/wshub-reaper-contract.test.js
 */

const assert = require('assert');
const http = require('http');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');

// Install trap before out/services modules load.
installVscodeTrap();

const { WsHub } = require('../../out/services/wsHub');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startHub(pingIntervalMs) {
    const server = http.createServer();
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    const hub = new WsHub({ server, getAuthToken: async () => '', pingIntervalMs });
    hub.attach();
    return { server, hub, port };
}

/**
 * Patch `WebSocket.prototype.terminate` for the duration of `body` so the
 * reaper's `terminate()` call becomes a true no-op that emits nothing — the
 * exact condition of an already-dead socket in production. Restored in `finally`.
 */
async function withNoopTerminate(body) {
    const origTerminate = WebSocket.prototype.terminate;
    WebSocket.prototype.terminate = function noopTerminate() { /* emit nothing */ };
    try {
        await body();
    } finally {
        WebSocket.prototype.terminate = origTerminate;
    }
}

async function main() {
    console.log('\n— wsHub reaper contract —');

    await test('R1. reaped connection is removed synchronously when terminate() emits nothing', async () => {
        const { server, hub, port } = await startHub(60);
        const gone = [];
        hub.onDisconnect((id) => gone.push(id));
        await withNoopTerminate(async () => {
            const client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_corpse`, { autoPong: false });
            await new Promise(res => client.on('open', res));
            assert.strictEqual(hub.connectionCount, 1, 'client must join the broadcast set on connect');
            // tick1: marks isAlive=false + pings. tick2: reaps. terminate() is a
            // no-op so no 'close' fires — removal MUST come from the reaper's own
            // _removeConnection call, not from handleDisconnect.
            await sleep(200);
            assert.strictEqual(hub.connectionCount, 0,
                'reaper must remove the entry itself when terminate() emits no close');
            assert.deepStrictEqual(gone, ['cli_corpse'],
                'disconnect listener must fire on the reap path with the correct originatorId');
            try { client.close(); } catch { /* client-side cleanup */ }
        });
        hub.close();
        await new Promise(res => server.close(res));
    });

    await test('R2. a dead connection is reaped exactly once across multiple ticks', async () => {
        const { server, hub, port } = await startHub(60);
        const gone = [];
        hub.onDisconnect((id) => gone.push(id));
        let reapLogCount = 0;
        const origWarn = console.warn;
        console.warn = (...args) => {
            const s = args.join(' ');
            if (s.includes('reaping connection with no pong')) reapLogCount++;
            origWarn(...args);
        };
        try {
            await withNoopTerminate(async () => {
                const client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_once`, { autoPong: false });
                await new Promise(res => client.on('open', res));
                await sleep(400); // > 6 ticks at 60ms — would re-reap 6x without the fix
                assert.strictEqual(reapLogCount, 1,
                    `expected exactly one reap log line, got ${reapLogCount} (re-reaping is the bug)`);
                assert.deepStrictEqual(gone, ['cli_once']);
                assert.strictEqual(hub.connectionCount, 0);
                try { client.close(); } catch { /* */ }
            });
        } finally {
            // Restore in `finally`: a failing assertion above must not leave the
            // process-wide console.warn patched for R3/R4 (and their reap counts
            // silently accumulating into this closure's counter).
            console.warn = origWarn;
            hub.close();
            await new Promise(res => server.close(res));
        }
    });

    await test('R3. a late close after a reap is a no-op — no second listener call, no throw', async () => {
        const { server, hub, port } = await startHub(60);
        const gone = [];
        hub.onDisconnect((id) => gone.push(id));
        let client;
        await withNoopTerminate(async () => {
            client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_late`, { autoPong: false });
            await new Promise(res => client.on('open', res));
            await sleep(200); // reaped by now
            assert.strictEqual(hub.connectionCount, 0);
            assert.deepStrictEqual(gone, ['cli_late']);
        });
        // terminate() is restored. Force a real close on the still-open client
        // socket — the server sees a 'close', handleDisconnect runs, hits the
        // has() guard in _removeConnection, and must do nothing.
        try { client.close(); } catch { /* */ }
        await sleep(100);
        assert.deepStrictEqual(gone, ['cli_late'],
            'late close must not fire the disconnect listener a second time');
        assert.strictEqual(hub.connectionCount, 0);
        hub.close();
        await new Promise(res => server.close(res));
    });

    await test('R4. terminate() throwing still removes the entry and fires the listener', async () => {
        const { server, hub, port } = await startHub(60);
        const gone = [];
        hub.onDisconnect((id) => gone.push(id));
        const origTerminate = WebSocket.prototype.terminate;
        WebSocket.prototype.terminate = function throwingTerminate() {
            throw new Error('synthetic terminate failure');
        };
        try {
            const client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_throw`, { autoPong: false });
            await new Promise(res => client.on('open', res));
            await sleep(200);
            assert.strictEqual(hub.connectionCount, 0,
                'removal must happen even if terminate() throws (delete is outside the try)');
            assert.deepStrictEqual(gone, ['cli_throw'],
                'listener must fire even when terminate() throws');
            try { client.close(); } catch { /* */ }
        } finally {
            WebSocket.prototype.terminate = origTerminate;
        }
        hub.close();
        await new Promise(res => server.close(res));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
