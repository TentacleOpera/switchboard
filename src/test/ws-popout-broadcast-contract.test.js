'use strict';

/**
 * Contract: a WS connection joins the broadcast set even when its connect-time snapshot
 * is slow or never settles — and a late snapshot never clobbers a delivered delta.
 *
 * This is the "New Window freeze" discriminator. `wsHub.handleUpgrade` completes the
 * socket upgrade, then awaits `getFullState(meta.project)` BEFORE `_connections.add(meta)`.
 * The subscribe-after-snapshot ordering is deliberate — a delta sent during the await
 * window takes seq 1, and the resync's hardcoded seq 0 would then clobber it, so the
 * client would apply the OLDER state last. But the await used to be UNBOUNDED, and that
 * has an exact failure signature: the socket is open on the wire (the client's `onopen`
 * has already fired, because `_wss.handleUpgrade`'s callback receives an already-upgraded
 * socket), the server never adds it to `_connections`, so every broadcast skips it
 * FOREVER — with no close event, and therefore no reconnect. HTTP fine, "connected" in
 * the console, zero pushes, permanent.
 *
 * Test 3 is the whole point of the file: it is the in-process reproduction of that
 * hypothesis, and it FAILS against an unbounded await. Run it before instrumenting a
 * browser — it settles the server half deterministically.
 *
 * Harness note: this drives `WsHub` against a bare `http.Server` rather than booting a
 * full `LocalApiServer`. Every assertion here is about hub behaviour (surface filter,
 * join-on-stalled-snapshot, seq ordering); `LocalApiServer.broadcastWs` is a one-line
 * forwarder to `wsHub.broadcast` with nothing to discriminate. Same harness shape as
 * cross-client-scope-contract.test.js:231, which already drives a real hub and real `ws`
 * clients this way. `getAuthToken: async () => ''` is the proven in-repo loopback-trust
 * pattern, not a hand-rolled bypass.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');

const { WsHub } = require('../../out/services/wsHub');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a bare http server with a hub attached. Returns a teardown-safe handle. */
async function bootHub(getFullState) {
    const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const hub = new WsHub({
        server,
        getAuthToken: async () => '',
        getFullState,
        // Reaper left at its 30s default deliberately: no case below runs that long, and
        // `pingIntervalMs: 0` would NOT disable it — the option is read with `??`, so 0 is
        // honoured and produces a zero-delay setInterval.
    });
    hub.attach();
    return {
        port, hub,
        close: () => { try { hub.close(); } catch { /* ignore */ } server.close(); },
    };
}

/**
 * Connect a real ws client. Resolves on `open` — deliberately NOT on `__resync`, because
 * the cases under test are precisely the ones where no resync ever arrives.
 */
function connect(port, query = '?surfaces=terminals,common') {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
        const received = [];
        ws.on('message', (raw) => {
            try { received.push(JSON.parse(raw.toString())); } catch { /* non-JSON frame */ }
        });
        ws.on('error', reject);
        ws.on('open', () => resolve({ ws, received }));
    });
}

/** Poll for a frame matching `pred`, up to `timeoutMs`. */
async function waitForFrame(received, pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = received.find(pred);
        if (hit) { return hit; }
        await sleep(25);
    }
    return undefined;
}

(async () => {
    console.log('\n── WsHub: popout broadcast reachability ──');

    await test('both clients declaring surfaces=terminals receive a terminals-tagged broadcast', async () => {
        const h = await bootHub(async () => [{ type: 'seed', surface: 'kanban' }]);
        try {
            const a = await connect(h.port, '?surfaces=terminals,common&originatorId=shell-iframe');
            const b = await connect(h.port, '?surfaces=terminals,common&originatorId=popout');
            // Wait for both baselines so the broadcast cannot race the join.
            assert.ok(await waitForFrame(a.received, (m) => m.type === '__resync'), 'client A never got its baseline');
            assert.ok(await waitForFrame(b.received, (m) => m.type === '__resync'), 'client B never got its baseline');

            h.hub.broadcast('terminalsChanged', {}, 'terminals');

            const fa = await waitForFrame(a.received, (m) => m.type === 'terminalsChanged');
            const fb = await waitForFrame(b.received, (m) => m.type === 'terminalsChanged');
            assert.ok(fa, 'the shell iframe connection did not receive terminalsChanged');
            assert.ok(fb, 'the POPOUT connection did not receive terminalsChanged — the surface filter or the broadcast set is dropping it');
            assert.strictEqual(fa.surface, 'terminals', 'the frame must carry its surface tag');
            assert.strictEqual(fb.surface, 'terminals', 'the frame must carry its surface tag');
            a.ws.close(); b.ws.close();
        } finally { h.close(); }
    });

    await test('a connection joins the broadcast set even when its snapshot is SLOW', async () => {
        // Regression guard for the bounded resync: 1.5s is under the 5s timeout, so the
        // healthy subscribe-after-snapshot path still runs — but a broadcast issued after
        // the snapshot lands must reach the client.
        const h = await bootHub(async () => { await sleep(1500); return [{ type: 'seed', surface: 'kanban' }]; });
        try {
            const c = await connect(h.port);
            assert.ok(await waitForFrame(c.received, (m) => m.type === '__resync', 4000),
                'the slow snapshot must still be delivered when it lands inside the timeout');
            h.hub.broadcast('terminalsChanged', {}, 'terminals');
            assert.ok(await waitForFrame(c.received, (m) => m.type === 'terminalsChanged'),
                'a broadcast after a slow snapshot must reach the client');
            c.ws.close();
        } finally { h.close(); }
    });

    await test('a connection whose snapshot NEVER settles still joins the broadcast set', async () => {
        // THE reproduction. Against an unbounded await this fails: the socket is open, the
        // client saw `onopen`, and `_connections` never gains the meta — so the broadcast
        // is skipped forever with no close event and therefore no reconnect.
        const h = await bootHub(() => new Promise(() => { /* never resolves */ }));
        try {
            const c = await connect(h.port);
            // Past RESYNC_TIMEOUT_MS (5s) the hub must have given up and joined anyway.
            await sleep(6000);
            h.hub.broadcast('terminalsChanged', {}, 'terminals');
            assert.ok(await waitForFrame(c.received, (m) => m.type === 'terminalsChanged'),
                'a stalled snapshot must NOT orphan the connection — this is the New Window freeze signature');
            assert.ok(!c.received.some((m) => m.type === '__resync'),
                'no baseline can have been sent — the snapshot never settled');

            const roster = h.hub.getConnectionInfo();
            assert.strictEqual(roster.length, 1, 'the connection must appear in the diagnostic roster');
            assert.strictEqual(roster[0].resyncFailed, true,
                'resyncFailed must make the missing baseline visible rather than silent');
            c.ws.close();
        } finally { h.close(); }
    });

    await test('a late snapshot never clobbers a delivered delta', async () => {
        // The ordering hazard the subscribe-after-snapshot comment warns about, now
        // reachable via the timeout path: a seq-0 __resync arriving BEHIND a seq-1 delta
        // would have the client apply the older state last.
        let resolveSnapshot;
        const h = await bootHub(() => new Promise((r) => { resolveSnapshot = r; }));
        try {
            const c = await connect(h.port);
            await sleep(6000);                       // let the resync time out and join
            h.hub.broadcast('terminalsChanged', {}, 'terminals');
            const delta = await waitForFrame(c.received, (m) => m.type === 'terminalsChanged');
            assert.ok(delta, 'the delta must be delivered');
            assert.ok(delta.seq >= 1, 'the delta must carry a seq above the baseline');

            resolveSnapshot([{ type: 'seed', surface: 'kanban' }]);   // the late snapshot lands
            await sleep(400);

            const lateResync = c.received.find((m) => m.type === '__resync');
            assert.ok(!lateResync,
                'a seq-0 __resync must be SUPPRESSED once anything has been sent on the connection — the meta.seq === 0 guard is the single most important line in this change');
            c.ws.close();
        } finally { h.close(); }
    });

    await test('the surface filter still excludes a connection that did not declare terminals', async () => {
        // The narrowing guard: joining unconditionally must not turn into broadcasting
        // unconditionally.
        const h = await bootHub(async () => [{ type: 'seed', surface: 'kanban' }]);
        try {
            const kanbanOnly = await connect(h.port, '?surfaces=kanban,common&originatorId=board');
            const terminals = await connect(h.port, '?surfaces=terminals,common&originatorId=popout');
            assert.ok(await waitForFrame(kanbanOnly.received, (m) => m.type === '__resync'), 'board client never got its baseline');
            assert.ok(await waitForFrame(terminals.received, (m) => m.type === '__resync'), 'terminals client never got its baseline');

            h.hub.broadcast('terminalsChanged', {}, 'terminals');
            assert.ok(await waitForFrame(terminals.received, (m) => m.type === 'terminalsChanged'),
                'the terminals-declaring client must receive it');
            await sleep(300);
            assert.ok(!kanbanOnly.received.some((m) => m.type === 'terminalsChanged'),
                'a connection that did not declare `terminals` must not receive the push');
            kanbanOnly.ws.close(); terminals.ws.close();
        } finally { h.close(); }
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
})();
