'use strict';

/**
 * `GET /design/asset` — security contract test.
 *
 * The route is the headless replacement for `webview.asWebviewUri`, so it serves
 * files out of arbitrary, possibly out-of-workspace folders the user configured.
 * That makes it the load-bearing surface of the Design-view cockpit fix: a loose
 * check here is an arbitrary-file-read on the loopback port. These tests pin the
 * guarantees the plan requires — allow-list containment, `..` rejection, symlink
 * escape rejection, caller-supplied-root rejection, and MIME narrowing.
 *
 * Drives the compiled LocalApiServer under a booby-trapped vscode module, built
 * via Object.create so the vscode-coupled constructor is bypassed (same harness
 * pattern as verb-engine-kanban-headless.test.js).
 *
 * Run with:
 *   npm run compile-tests && node src/test/design-asset-route-traversal.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { LocalApiServer } = require('../../out/services/LocalApiServer');

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

/** Minimal ServerResponse double capturing status / headers / body. */
function fakeRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(chunk) { this.body = chunk; },
    };
}

function fakeReq(query) {
    return { url: `/design/asset?${query}`, method: 'GET', headers: { host: '127.0.0.1:9999' } };
}

function buildServer(options) {
    const server = Object.create(LocalApiServer.prototype);
    server._options = options;
    return server;
}

async function main() {
    console.log('\n=== GET /design/asset — traversal & allow-list contract ===\n');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-design-asset-'));
    const wsRoot = path.join(tmpRoot, 'workspace');
    const imagesDir = path.join(wsRoot, 'images');
    const secretsDir = path.join(tmpRoot, 'secrets');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });

    const pngPath = path.join(imagesDir, 'shot.png');
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sourcePath = path.join(imagesDir, 'notes.ts');
    fs.writeFileSync(sourcePath, 'export const secret = 1;');
    const outsidePath = path.join(secretsDir, 'creds.png');
    fs.writeFileSync(outsidePath, 'TOP SECRET');

    const options = {
        workspaceRoot: wsRoot,
        allRoots: [wsRoot],
        getDesignAssetRoots: (root) => (root === wsRoot ? [imagesDir] : []),
    };

    const call = async (query, opts) => {
        const res = fakeRes();
        await buildServer(opts || options)._handleDesignAsset(fakeReq(query), res);
        return res;
    };

    const q = (root, p) => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`;

    await test('serves an image inside a configured folder', async () => {
        const res = await call(q(wsRoot, pngPath));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['Content-Type'], 'image/png');
        assert.strictEqual(res.headers['X-Content-Type-Options'], 'nosniff');
        assert.ok(Buffer.isBuffer(res.body) && res.body.length === 4);
    });

    await test('rejects an absolute path outside every configured folder', async () => {
        const res = await call(q(wsRoot, outsidePath));
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!String(res.body).includes('TOP SECRET'));
    });

    await test('rejects /etc/passwd', async () => {
        const res = await call(q(wsRoot, '/etc/passwd'));
        assert.strictEqual(res.statusCode, 403);
    });

    await test('rejects a `..` escape out of a configured folder', async () => {
        const escape = path.join(imagesDir, '..', '..', 'secrets', 'creds.png');
        const res = await call(q(wsRoot, escape));
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!String(res.body).includes('TOP SECRET'));
    });

    await test('rejects a symlink inside a configured folder that points outside', async () => {
        const linkPath = path.join(imagesDir, 'link.png');
        try { fs.symlinkSync(outsidePath, linkPath); } catch { return; } // platform without symlink perms
        const res = await call(q(wsRoot, linkPath));
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!String(res.body).includes('TOP SECRET'));
    });

    await test('rejects a non-image file even inside a configured folder', async () => {
        const res = await call(q(wsRoot, sourcePath));
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!String(res.body).includes('secret'));
    });

    await test('never consults a caller-supplied root', async () => {
        // getDesignAssetRoots would happily hand back the attacker's folder if the
        // route passed `secretsDir` through; it must only ask about its OWN roots.
        const leaky = {
            workspaceRoot: wsRoot,
            allRoots: [wsRoot],
            getDesignAssetRoots: (root) => (root === wsRoot ? [imagesDir] : [secretsDir]),
        };
        const res = await call(q(secretsDir, outsidePath), leaky);
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!String(res.body).includes('TOP SECRET'));
    });

    await test('serves an asset from a secondary workspace root (multi-root union)', async () => {
        const otherRoot = path.join(tmpRoot, 'workspace2');
        const otherImages = path.join(otherRoot, 'pics');
        fs.mkdirSync(otherImages, { recursive: true });
        const otherPng = path.join(otherImages, 'b.png');
        fs.writeFileSync(otherPng, Buffer.from([0x89, 0x50]));
        const multi = {
            workspaceRoot: wsRoot,
            allRoots: [wsRoot, otherRoot],
            getDesignAssetRoots: (root) => (root === wsRoot ? [imagesDir] : [otherImages]),
        };
        // The preview only knows the primary root, yet the secondary-root asset resolves.
        const res = await call(q(wsRoot, otherPng), multi);
        assert.strictEqual(res.statusCode, 200);
    });

    await test('answers 503 when no allow-list provider is wired (never a looser rule)', async () => {
        const res = await call(q(wsRoot, pngPath), { workspaceRoot: wsRoot, allRoots: [wsRoot] });
        assert.strictEqual(res.statusCode, 503);
    });

    // ── Tickets asset roots (getTicketsAssetRoots) ──
    // getTicketsAssetRoots was public on TicketsPanelProvider and consulted by its OWN
    // URL builder, but neither host passed it to this route — so a configured
    // ticketSaveLocation had URLs happily emitted and then 403'd at fetch time. The
    // existing coverage (verb-engine-tickets-headless.test.js) asserted the URL SHAPE and
    // never fetched it, which is why it stayed green throughout. These fetch.
    const ticketSaveDir = path.join(tmpRoot, 'ticket-store', 'clickup');
    fs.mkdirSync(path.join(ticketSaveDir, 'space', 'list', 'attachments'), { recursive: true });
    const ticketPng = path.join(ticketSaveDir, 'space', 'list', 'attachments', 'flow.png');
    fs.writeFileSync(ticketPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    // A sibling just OUTSIDE the configured root — the negative control. The widening
    // must add exactly `<ticketSaveLocation>/<provider>`, never its parent.
    const ticketSaveParent = path.dirname(ticketSaveDir);
    const outsideTicketPng = path.join(ticketSaveParent, 'not-mine.png');
    fs.writeFileSync(outsideTicketPng, 'TOP SECRET');

    const ticketsOnly = {
        workspaceRoot: wsRoot,
        allRoots: [wsRoot],
        getTicketsAssetRoots: (root) => (root === wsRoot ? [ticketSaveDir] : []),
    };

    await test('serves a ticket asset under a configured ticketSaveLocation', async () => {
        const res = await call(q(wsRoot, ticketPng), ticketsOnly);
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode} — getTicketsAssetRoots is not wired into the route`);
        assert.strictEqual(res.headers['Content-Type'], 'image/png');
        assert.ok(Buffer.isBuffer(res.body) && res.body.length === 5);
    });

    await test('a sibling just outside the configured ticketSaveLocation still 403s', async () => {
        const res = await call(q(wsRoot, outsideTicketPng), ticketsOnly);
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!String(res.body).includes('TOP SECRET'));
    });

    await test('the tickets provider alone satisfies the 503 wiring guard', async () => {
        // The guard is "no provider at all", not "no design provider" — a host that wires
        // only Tickets must still serve, never answer 503.
        const res = await call(q(wsRoot, ticketPng), ticketsOnly);
        assert.notStrictEqual(res.statusCode, 503);
    });

    await test('all three root providers union rather than shadowing each other', async () => {
        const allThree = {
            workspaceRoot: wsRoot,
            allRoots: [wsRoot],
            getDesignAssetRoots: (root) => (root === wsRoot ? [imagesDir] : []),
            getPlanningAssetRoots: () => [],
            getTicketsAssetRoots: (root) => (root === wsRoot ? [ticketSaveDir] : []),
        };
        assert.strictEqual((await call(q(wsRoot, pngPath), allThree)).statusCode, 200);
        assert.strictEqual((await call(q(wsRoot, ticketPng), allThree)).statusCode, 200);
        assert.strictEqual((await call(q(wsRoot, outsidePath), allThree)).statusCode, 403);
    });

    await test('a version query param is inert — the route resolves only root and path', async () => {
        // The cache-busting `&v=<mtime>` token the Tickets provider appends must not be
        // read as part of the filename (the classic "server stats image.png?v=123" 404).
        const res = await call(`${q(wsRoot, ticketPng)}&v=1754899200000`, ticketsOnly);
        assert.strictEqual(res.statusCode, 200);
    });

    await test('requires the path parameter', async () => {
        const res = await call(`root=${encodeURIComponent(wsRoot)}`);
        assert.strictEqual(res.statusCode, 400);
    });

    await test('denies a missing file rather than serving or confirming it', async () => {
        // An unresolvable path fails the realpath step, so it is denied before the
        // existence check — fail-closed, and it does not leak file existence.
        const res = await call(q(wsRoot, path.join(imagesDir, 'nope.png')));
        assert.ok(res.statusCode === 403 || res.statusCode === 404, `got ${res.statusCode}`);
    });

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
