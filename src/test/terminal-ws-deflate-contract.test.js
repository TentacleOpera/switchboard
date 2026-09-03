'use strict';

/**
 * Contract for permessage-deflate on the terminal WebSocket.
 *
 * Two failure modes, neither of which any other gate can see.
 *
 * The first is silent loss of the benefit: `perMessageDeflate` is one
 * constructor literal, and deleting it, or "hardening" it with the reflexive
 * `serverNoContextTakeover: true`, compiles, lints, passes every suite, and
 * quietly throws away most of the compression ratio on the largest traffic
 * class Switchboard produces. Nothing on the wire tells an operator.
 *
 * The second is silent loss of a client: `serverNoContextTakeover: false` makes
 * ws REFUSE an offer carrying `server_no_context_takeover`, and a refused
 * extension offer aborts the upgrade with HTTP 400 rather than downgrading. The
 * live checks below pin that consequence explicitly so it stays a known,
 * deliberate cost rather than a mystery connection failure.
 *
 * The live checks build a real WebSocketServer from the options literal PARSED
 * OUT OF THE GATEWAY SOURCE, so there is one source of truth: a drift in the
 * source fails the structural assertions, and a change in `ws` behaviour under
 * an unchanged source fails the behavioural ones.
 */

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { WebSocketServer } = require('ws');

const gatewayPath = path.join(__dirname, '../standalone/terminalWsGateway.ts');
const gatewayCode = fs.readFileSync(gatewayPath, 'utf8');
const hubCode = fs.readFileSync(path.join(__dirname, '../services/wsHub.ts'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

/** The `perMessageDeflate: { ... }` object literal, lifted verbatim from the gateway source. */
function extractDeflateLiteral() {
    const key = 'perMessageDeflate: {';
    const at = gatewayCode.indexOf(key);
    assert.ok(at !== -1, 'terminalWsGateway.ts must configure perMessageDeflate on its WebSocketServer');
    let i = at + key.length - 1;
    let depth = 0;
    for (; i < gatewayCode.length; i++) {
        if (gatewayCode[i] === '{') { depth++; }
        else if (gatewayCode[i] === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.ok(depth === 0, 'unbalanced braces in the perMessageDeflate literal');
    const body = gatewayCode.substring(at + key.length - 1, i + 1);
    // eslint-disable-next-line no-new-func
    return { text: body, value: new Function(`return ${body};`)() };
}

const deflate = extractDeflateLiteral();

// ------------------------------------------------------------------ structure

test('the terminal WebSocketServer enables permessage-deflate', () => {
    assert.ok(/new WebSocketServer\(\{[\s\S]{0,200}?perMessageDeflate:/.test(gatewayCode),
        'perMessageDeflate must be passed to the WebSocketServer constructor, not wired through a setter — '
        + 'a two-call-site seam is how the two hosts drift');
});

test('context takeover is retained (serverNoContextTakeover: false)', () => {
    assert.strictEqual(deflate.value.serverNoContextTakeover, false,
        'true, or omitting it, resets the deflate dictionary per message and discards most of the ratio on '
        + 'repainted terminal output — the entire reason this is enabled');
});

test('no threshold is configured — it is dead config under context takeover', () => {
    assert.ok(!('threshold' in deflate.value),
        'ws only honours `threshold` when server_no_context_takeover is negotiated; setting it here would tell a '
        + 'future reader small frames bypass zlib when they do not');
});

test('zlib level and the shared concurrency limit are stated, not left implicit', () => {
    assert.strictEqual(deflate.value.zlibDeflateOptions.level, 6);
    assert.strictEqual(deflate.value.zlibDeflateOptions.memLevel, 8);
    assert.strictEqual(deflate.value.concurrencyLimit, 10,
        'concurrencyLimit is a module-level global in ws shared by every connection in the process; the value is '
        + 'pinned here so a change is a deliberate one');
});

test('the comment names the HTTP 400 consequence of serverNoContextTakeover: false', () => {
    const block = gatewayCode.substring(Math.max(0, gatewayCode.indexOf('perMessageDeflate: {') - 2200),
        gatewayCode.indexOf('perMessageDeflate: {'));
    assert.ok(/400/.test(block),
        'the option refuses a client offer outright rather than downgrading; a reader who does not know that will '
        + 'debug the resulting handshake failure as a network fault');
});

test('the control-plane hub stays uncompressed', () => {
    const constructions = hubCode.match(/new WebSocketServer\(\{[^}]*\}/g) || [];
    assert.strictEqual(constructions.length, 2, 'wsHub.ts is expected to construct exactly two WebSocketServers');
    for (const c of constructions) {
        assert.ok(!c.includes('perMessageDeflate'),
            'wsHub carries small JSON pushes where deflate is mostly overhead — it is explicitly out of scope');
    }
});

test('the flow-control budget is untouched by the compression change', () => {
    assert.ok(/export const HIGH_WATER_MARK_BYTES = 1024 \* 1024;/.test(gatewayCode));
    assert.ok(/export const LOW_WATER_MARK_BYTES = 256 \* 1024;/.test(gatewayCode));
    assert.ok(/export const MAX_FLUSH_BYTES = 128 \* 1024;/.test(gatewayCode),
        'the 128 KB cap keeps one frame from becoming a multi-megabyte deflate job');
    assert.ok(/export const OUTPUT_FLUSH_MS = 6;/.test(gatewayCode));
});

test('checkBackpressure records that bufferedAmount is now a mixed count', () => {
    const at = gatewayCode.indexOf('private checkBackpressure(');
    assert.ok(at !== -1);
    const body = gatewayCode.substring(at, at + 2500);
    assert.ok(/unackedChars/.test(body) && /compress/i.test(body),
        'with deflate on, bufferedAmount mixes compressed socket bytes with uncompressed queued bytes; unackedChars '
        + 'is the signal that still measures terminal output, and the code must say so');
});

test('no new constructor parameter or setter was added for compression', () => {
    const ctor = gatewayCode.substring(gatewayCode.indexOf('    constructor('),
        gatewayCode.indexOf('    constructor(') + 400);
    assert.ok(!/deflate|compress/i.test(ctor), 'compression must not become a constructor parameter');
    assert.ok(!/set[A-Za-z]*(Deflate|Compression)/.test(gatewayCode),
        'a settable seam is wired in one composition root and forgotten in the other — the constructor is the point');
});

// ----------------------------------------------------------------- behavioural

/** Raw HTTP upgrade so the offer header is exactly what a given client would send. */
function handshake(port, extensionsHeader) {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(
                `GET /ws/terminal HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n`
                + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
                + (extensionsHeader ? `Sec-WebSocket-Extensions: ${extensionsHeader}\r\n` : '')
                + '\r\n'
            );
        });
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => { sock.destroy(); finish(); }, 2000);
        let done = false;
        function finish() {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) { reject(new Error('no complete response headers')); return; }
            const head = buf.slice(0, idx).toString();
            const status = Number((head.split('\r\n')[0].match(/HTTP\/1\.1 (\d+)/) || [])[1]);
            const negotiated = ((head.match(/Sec-WebSocket-Extensions: (.*)/i) || [])[1] || '').trim();
            const frames = [];
            let body = buf.slice(idx + 4);
            let o = 0;
            while (o + 2 <= body.length) {
                const b0 = body[o];
                const b1 = body[o + 1];
                let len = b1 & 0x7f;
                let hdr = 2;
                if (len === 126) { len = body.readUInt16BE(o + 2); hdr = 4; }
                else if (len === 127) { len = Number(body.readBigUInt64BE(o + 2)); hdr = 10; }
                if (o + hdr + len > body.length) { break; }
                frames.push({ compressed: (b0 & 0x40) !== 0, wireBytes: len });
                o += hdr + len;
            }
            sock.destroy();
            resolve({ status, negotiated, frames });
        }
        sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
        sock.on('close', finish);
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

const SMALL = Buffer.from('ok');                       // a keystroke echo
const LARGE = Buffer.from('x'.repeat(4096));           // a coalesced repaint

async function main() {
    // Built from the literal the gateway itself passes, so this exercises the shipped config.
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: deflate.value });
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send(SMALL, { binary: true });
            ws.send(LARGE, { binary: true });
            ws.send(LARGE, { binary: true });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    await asyncTest('permessage-deflate is negotiated for a Chrome-shaped offer', async () => {
        const res = await handshake(port, 'permessage-deflate; client_max_window_bits');
        assert.strictEqual(res.status, 101);
        assert.ok(/permessage-deflate/.test(res.negotiated),
            `expected permessage-deflate in the 101 response, got "${res.negotiated}"`);
    });

    await asyncTest('permessage-deflate is negotiated for a bare Firefox/Safari-shaped offer', async () => {
        const res = await handshake(port, 'permessage-deflate');
        assert.strictEqual(res.status, 101);
        assert.ok(/permessage-deflate/.test(res.negotiated));
    });

    await asyncTest('a coalesced repaint is compressed, and the retained window improves the repeat', async () => {
        const res = await handshake(port, 'permessage-deflate; client_max_window_bits');
        const [, first, second] = res.frames;
        assert.ok(first && second, `expected three frames, got ${res.frames.length}`);
        assert.ok(first.compressed && second.compressed, 'large frames must carry RSV1');
        assert.ok(first.wireBytes < LARGE.length / 20,
            `4096 bytes should leave in well under 205; got ${first.wireBytes}`);
        assert.ok(second.wireBytes <= first.wireBytes,
            'a repeat of the same payload must not cost more than the first — that is context takeover working; '
            + `got ${first.wireBytes} then ${second.wireBytes}`);
    });

    await asyncTest('a keystroke-sized frame is ALSO compressed — the threshold does not apply', async () => {
        const res = await handshake(port, 'permessage-deflate; client_max_window_bits');
        const small = res.frames[0];
        assert.ok(small, 'expected the small frame first');
        assert.ok(small.compressed,
            'ws gates `threshold` on server_no_context_takeover, so every frame is compressed here. If this ever '
            + 'fails, ws changed and the gateway comment claiming "all messages are compressed" is now wrong.');
        assert.ok(small.wireBytes <= SMALL.length + 4,
            `small-frame enlargement must stay in the noise; ${SMALL.length} bytes went out as ${small.wireBytes}`);
    });

    await asyncTest('an offer carrying server_no_context_takeover is refused with 400, not downgraded', async () => {
        const res = await handshake(port, 'permessage-deflate; server_no_context_takeover; client_max_window_bits');
        assert.strictEqual(res.status, 400,
            'this is the documented cost of serverNoContextTakeover: false — pinned so it stays a known trade '
            + 'rather than an unexplained connection failure');
    });

    await asyncTest('a client offering no extensions still connects, uncompressed', async () => {
        const res = await handshake(port, '');
        assert.strictEqual(res.status, 101);
        assert.strictEqual(res.negotiated, '');
        assert.ok(res.frames.length >= 1 && !res.frames[0].compressed,
            'without a negotiated extension the frames must go out verbatim');
    });

    server.close();
    console.log(`\nResults: ${passed} passed, ${failed} failed.`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
