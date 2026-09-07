'use strict';

/**
 * Contract for HTTP response compression and the board's per-column render cap.
 *
 * Plan: the-board-ships-2-8mb-of-uncompressed-json-so-a-remote-device-waits-minutes.
 *
 * Both halves of that plan are invisible to every other gate in this repo, and
 * both fail SILENTLY:
 *
 *  - Compression is a wrapper around `ServerResponse`. Delete it, mis-order its
 *    exclusions, or forget `Vary`, and every suite stays green while a remote
 *    device pays 2.8 MB again. The failure is only visible on a slow link, which
 *    is exactly where nobody is running tests. Worse, the exclusions are the
 *    dangerous part: gzipping a `Content-Range` body or double-wrapping an
 *    already-encoded one produces a response the client cannot read at all, and
 *    on loopback it is fast enough that the corruption looks like a UI bug.
 *
 *  - The render cap is a `slice()` and a limits map. Re-adding
 *    `columnRenderLimits = {}` to renderBoard compiles, lints, passes, and makes
 *    "Load more" collapse a second after the operator clicks it.
 *
 * The compression checks are LIVE: they drive the real `_wrapForCompression`
 * from the compiled source through a real `http.Server` and a real client, so a
 * behavioural change fails here rather than a re-worded assertion passing.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const assert = require('assert');

const { LocalApiServer } = require('../../out/services/LocalApiServer.js');

const SRC = fs.readFileSync(path.join(__dirname, '../services/LocalApiServer.ts'), 'utf8');
const KANBAN_HTML = fs.readFileSync(path.join(__dirname, '../webview/kanban.html'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') { return r.then(() => { passed++; console.log('  ✅ ' + name); },
            (e) => { failed++; console.error('  ❌ ' + name + '\n     ' + (e && e.message)); }); }
        passed++; console.log('  ✅ ' + name);
    } catch (e) {
        failed++; console.error('  ❌ ' + name + '\n     ' + (e && e.message));
    }
    return Promise.resolve();
}

/** Extract a brace-balanced function body from source, by its declaration line. */
function functionBody(src, decl) {
    const at = src.indexOf(decl);
    assert.ok(at !== -1, `declaration not found: ${decl}`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`unbalanced braces for ${decl}`);
}

// ─── Live harness ─────────────────────────────────────────────────────────────
// `this` only needs the two sibling helpers the wrapper calls; the static floor
// is read off the class. Using the prototype keeps this bound to the REAL
// implementation rather than a copy that can drift.
const wrapperThis = Object.create(LocalApiServer.prototype);

/**
 * Serve one response through the real wrapper and return the raw client view.
 * `route(res)` is the handler under test; it receives the WRAPPED response.
 */
function serveOnce(route, requestHeaders) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, rawRes) => {
            let res;
            try {
                res = LocalApiServer.prototype._wrapForCompression.call(wrapperThis, req, rawRes);
            } catch (e) { reject(e); return; }
            try { route(res); } catch (e) { reject(e); }
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const req = http.request({ host: '127.0.0.1', port, path: '/', headers: requestHeaders || {} }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    server.close();
                    resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) });
                });
            });
            req.on('error', (e) => { server.close(); reject(e); });
            req.end();
        });
        server.on('error', reject);
    });
}

const BIG = JSON.stringify({ cards: Array.from({ length: 400 }, (_, i) => ({ id: i, topic: 'a plan with a reasonably long title ' + i })) });
const SMALL = JSON.stringify({ success: true });

function varyHasAcceptEncoding(headers) {
    const v = headers['vary'];
    return !!v && String(v).toLowerCase().split(',').map(s => s.trim()).includes('accept-encoding');
}

async function main() {
    console.log('\nBoard payload compression contract\n');
    assert.ok(BIG.length > LocalApiServer.COMPRESSION_MIN_BYTES, 'fixture must exceed the floor');
    assert.ok(SMALL.length < LocalApiServer.COMPRESSION_MIN_BYTES, 'fixture must sit under the floor');

    await test('a large JSON body is gzipped, carries Vary, and round-trips byte-identical', async () => {
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(BIG);
        }, { 'Accept-Encoding': 'gzip, deflate, br' });
        assert.strictEqual(r.headers['content-encoding'], 'gzip');
        assert.ok(varyHasAcceptEncoding(r.headers), 'Vary: Accept-Encoding is mandatory or an intermediary can serve a compressed body to a client that did not ask');
        assert.strictEqual(r.headers['content-length'], undefined,
            'a streamed compressed body must not advertise the uncompressed length');
        assert.strictEqual(zlib.gunzipSync(r.raw).toString('utf8'), BIG);
        assert.ok(r.raw.length < BIG.length / 2, `gzip must actually shrink the board (${r.raw.length} vs ${BIG.length})`);
    });

    await test('no Accept-Encoding returns valid uncompressed JSON', async () => {
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(BIG);
        }, {});
        assert.strictEqual(r.headers['content-encoding'], undefined);
        assert.strictEqual(r.raw.toString('utf8'), BIG);
        assert.ok(varyHasAcceptEncoding(r.headers), 'the uncompressed answer is still Accept-Encoding-dependent');
    });

    await test('a body under the 1 KB floor is NOT compressed', async () => {
        // The floor is the assertion most likely to rot: almost no route in
        // LocalApiServer sets Content-Length, so a wrapper that decides at
        // writeHead time sees `undefined` and gzips every tiny ack.
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(SMALL);
        }, { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], undefined,
            'an 18-byte ack must not be gzipped — the floor must be applied to the ACTUAL body, not to a Content-Length nobody sets');
        assert.strictEqual(r.raw.toString('utf8'), SMALL);
    });

    await test('an already-encoded body is not double-wrapped', async () => {
        const pre = zlib.gzipSync(Buffer.from(BIG));
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
            res.end(pre);
        }, { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], 'gzip');
        // One layer only: the client's own gunzip yields the JSON, not more gzip.
        assert.strictEqual(zlib.gunzipSync(r.raw).toString('utf8'), BIG);
    });

    await test('a Content-Range response is left alone — byte offsets must stay meaningful', async () => {
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Range': `bytes 0-${BIG.length - 1}/${BIG.length}` });
            res.end(BIG);
        }, { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], undefined);
        assert.strictEqual(r.raw.toString('utf8'), BIG);
    });

    await test('a request carrying Range is never compressed', async () => {
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(BIG);
        }, { 'Accept-Encoding': 'gzip', 'Range': 'bytes=0-99' });
        assert.strictEqual(r.headers['content-encoding'], undefined);
        assert.strictEqual(r.raw.toString('utf8'), BIG);
    });

    await test('an already-compressed format (png) is skipped', async () => {
        const body = Buffer.alloc(4096, 7);
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(body);
        }, { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], undefined);
        assert.strictEqual(r.raw.length, body.length);
    });

    await test('errors and redirects are skipped', async () => {
        for (const status of [404, 500, 302]) {
            const r = await serveOnce((res) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(BIG);
            }, { 'Accept-Encoding': 'gzip' });
            assert.strictEqual(r.headers['content-encoding'], undefined, `status ${status} must not be compressed`);
        }
    });

    await test('deflate is the fallback when gzip is not offered', async () => {
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(BIG);
        }, { 'Accept-Encoding': 'deflate' });
        assert.strictEqual(r.headers['content-encoding'], 'deflate');
        assert.strictEqual(zlib.inflateSync(r.raw).toString('utf8'), BIG);
    });

    await test('gzip;q=0 is honoured as a refusal, not read as an offer', async () => {
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(BIG);
        }, { 'Accept-Encoding': 'gzip;q=0, identity' });
        assert.notStrictEqual(r.headers['content-encoding'], 'gzip');
        assert.strictEqual(r.raw.toString('utf8'), BIG);
    });

    await test('a streamed body (write/write/end) compresses and arrives complete', async () => {
        const halves = [BIG.slice(0, Math.floor(BIG.length / 2)), BIG.slice(Math.floor(BIG.length / 2))];
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write(halves[0]);
            res.write(halves[1]);
            res.end();
        }, { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], 'gzip');
        assert.strictEqual(zlib.gunzipSync(r.raw).toString('utf8'), BIG);
    });

    await test("res.end(body, callback) still fires the caller's callback when compressing", async () => {
        let fired = false;
        const r = await serveOnce((res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(BIG, () => { fired = true; });
        }, { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], 'gzip');
        // `finish` fires on the real response once the gzip stream has drained.
        await new Promise(r2 => setTimeout(r2, 50));
        assert.ok(fired, 'a dropped end() callback silently strands whatever the caller does after the response');
    });

    // ─── Structural: the wiring, which behaviour tests cannot see ─────────────

    await test('compression is wired in the SHARED _handleRequest, not on one listener', () => {
        const body = functionBody(SRC, 'private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {');
        assert.ok(/_wrapForCompression\(req, res\)/.test(body),
            'the wrapper must be applied inside _handleRequest — the handler BOTH http.Server listeners share. '
            + 'Wrapping at a listener instead makes loopback fast and the tailnet path (the only one that needs it) slow, '
            + 'which is the exact shape of the tailnet Host-header defect.');
        const wrapCalls = (SRC.match(/_wrapForCompression\(/g) || []).length;
        assert.strictEqual(wrapCalls, 2,
            'expected exactly the declaration and the single _handleRequest call site; a second call site means a '
            + 'per-listener seam has crept back in');
    });

    await test('the exclusion set is present and named', () => {
        const body = functionBody(SRC, 'private _wrapForCompression(req: http.IncomingMessage, res: http.ServerResponse): http.ServerResponse {');
        for (const needle of ["'content-encoding'", "'content-range'", "'accept-ranges'", "req.headers['range']", 'COMPRESSION_MIN_BYTES']) {
            assert.ok(body.includes(needle), `_wrapForCompression must still guard on ${needle}`);
        }
        assert.ok(/Vary/.test(body), 'Vary: Accept-Encoding must be set by the wrapper');
    });

    await test('the board caps every column uniformly and never keys on a column id', () => {
        assert.ok(/const COLUMN_RENDER_CAP = \d+;/.test(KANBAN_HTML),
            'a single cap constant, not a per-column policy');
        const render = functionBody(KANBAN_HTML, 'function renderBoard(cards, justFinishedIds = new Set()) {');
        assert.ok(/columnRenderLimits\[col\] \?\? COLUMN_RENDER_CAP/.test(render),
            'every column must resolve its limit from the same constant');
        assert.ok(/sortedItems\.slice\(0, limit\)/.test(render),
            'the per-column slice is the cap; without it first paint builds the whole history into the DOM');
    });

    await test('renderBoard does NOT reset the operator\'s paged-in rows', () => {
        const render = functionBody(KANBAN_HTML, 'function renderBoard(cards, justFinishedIds = new Set()) {');
        assert.ok(!/columnRenderLimits = \{\}/.test(render),
            'renderBoard runs on every board push (a card moving, an agent heartbeat, a star confirming). Clearing '
            + 'the limits here collapses a column the operator paged open seconds earlier, and "Load more" reads as broken.');
        // It must still be cleared when the card set stops being the same set.
        assert.ok(/columnRenderLimits = \{\};/.test(KANBAN_HTML),
            'the limits must still be dropped on a workspace change, where the columns hold different cards entirely');
    });

    await test('paging appends and never rebuilds the column body', () => {
        const page = functionBody(KANBAN_HTML, 'function appendColumnPage(col) {');
        assert.ok(!/container\.innerHTML\s*=/.test(page),
            'rebuilding from the stashed bucket discards optimistic DOM state — a card dragged in moments ago lives '
            + 'only in the DOM until the confirming push lands, and innerHTML makes it vanish');
        assert.ok(/insertBefore|appendChild|insertAdjacentHTML/.test(page), 'the next page must be appended');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
