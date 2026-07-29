'use strict';

/**
 * Contract tests for Per-Client Design Panel View State.
 *
 * Part A — DesignPanelProvider seats: per-client view state keyed by
 * originatorId, seat-local cross-nulling, poll lifecycle decoupled from the
 * extension panel, keyed auto-refresh debounces, eviction grace + cancel on
 * proof-of-life, and poll-driven preview refresh (the closed-panel /
 * standalone marquee).
 *
 * Part B — wsHub liveness: originatorId on the connection, onDisconnect on
 * close, the 30s ping/terminate keepalive (run at a test cadence via
 * pingIntervalMs), healthy clients surviving ticks, and interval teardown.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { installVscodeTrap, createHeadlessTestSeams } = require('./helpers/verbEngineTestSeams');

// Install trap before out/services modules load
installVscodeTrap();

const { DesignPanelProvider } = require('../../out/services/DesignPanelProvider');
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

function buildTestHarness(tmpRoot) {
    const { seams } = createHeadlessTestSeams({ roots: [tmpRoot] });
    const dummyUri = { fsPath: path.join(tmpRoot, 'ext') };
    const dummyContext = {
        extensionUri: dummyUri,
        extensionPath: tmpRoot,
        asAbsolutePath: (p) => path.join(tmpRoot, p),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }
    };

    const provider = new DesignPanelProvider(dummyContext);
    provider._hostSeams = seams;

    const pushCalls = [];
    const pushWebviewOnlyCalls = [];
    provider._broadcaster = {
        push: (msg) => pushCalls.push(msg),
        pushWebviewOnly: (msg) => pushWebviewOnlyCalls.push(msg),
        setWebview: () => {},
        setApiServer: () => {}
    };
    provider._getWorkspaceRoot = () => tmpRoot;
    provider._getWorkspaceRoots = () => [tmpRoot];

    return { provider, pushCalls, pushWebviewOnlyCalls };
}

async function main() {
    console.log('Per-Client Design Panel View State — Contract Tests\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-seats-test-'));
    const htmlDir = path.join(tmpDir, '.switchboard', 'html');
    fs.mkdirSync(htmlDir, { recursive: true });
    const sampleHtml = path.join(htmlDir, 'sample.html');
    fs.writeFileSync(sampleHtml, '<html><body>v1</body></html>');

    const mockFolderSvc = {
        getDesignFolderPaths: () => [],
        getHtmlFolderPaths: () => [htmlDir],
        getClaudeFolderPaths: () => [],
        getBriefsFolderPaths: () => [],
        getImagesFolderPaths: () => []
    };

    console.log('— Part A: provider seats —');

    await test('A1. cross-nulling regression: B\'s tab change does not null A\'s preview', async () => {
        const { provider } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        await provider.handleServiceVerb('fetchPreview', {
            sourceId: 'html-folder', sourceFolder: htmlDir, docId: 'sample.html',
            requestId: 1, originatorId: 'client_A'
        });
        assert.ok(provider._seats.get('client_A').htmlPreview, 'A registered a preview');

        const res = await provider.handleServiceVerb('activeTabChanged', { tab: 'images', originatorId: 'client_B' });
        assert.deepStrictEqual(res, { success: true, activeTab: 'images' });
        assert.ok(provider._seats.get('client_A').htmlPreview, 'A\'s preview must survive B\'s tab change');
        assert.strictEqual(provider._seats.get('client_B').htmlPreview, null);
        provider.dispose();
    });

    await test('A2. stitchHtmlListDocs project switch nulls only the CALLER\'s stitch preview', async () => {
        const { provider } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;
        provider._sendStitchHtmlDocsReady = async () => ({});
        provider._setupStitchHtmlFolderWatchers = async () => {};

        const stitchReg = { sourceFolder: htmlDir, docId: 'x.html', sourceId: 'stitch-html-folder', projectId: 'p1', workspaceRoot: tmpDir };
        provider._seatFor({ originatorId: 'client_A', __viaHttp: true }).stitchHtmlPreview = { ...stitchReg };
        provider._seatFor({ originatorId: 'client_B', __viaHttp: true }).stitchHtmlPreview = { ...stitchReg };

        await provider._handleMessage({ type: 'stitchHtmlListDocs', workspaceRoot: tmpDir, projectId: 'p2', originatorId: 'client_B' });
        assert.ok(provider._seats.get('client_A').stitchHtmlPreview, 'A\'s stitch preview must survive B entering another project');
        assert.strictEqual(provider._seats.get('client_B').stitchHtmlPreview, null, 'B\'s own stitch preview is cleared');
        provider.dispose();
    });

    await test('A3. browser-only seat starts the poll with NO panel; leaving the polled tab stops it', async () => {
        const { provider } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;
        assert.strictEqual(provider._panel, undefined, 'no extension panel in this harness');

        await provider.handleServiceVerb('activeTabChanged', { tab: 'html-preview', originatorId: 'client_A' });
        assert.ok(provider._externalFilePollTimer, 'poll timer must run for a browser seat without any panel');

        await provider.handleServiceVerb('activeTabChanged', { tab: 'stitch', originatorId: 'client_A' });
        assert.strictEqual(provider._externalFilePollTimer, undefined, 'poll timer must stop when the last seat leaves polled tabs');
        provider.dispose();
    });

    await test('A4. no originatorId → default seat, exact legacy return shape', async () => {
        const { provider } = buildTestHarness(tmpDir);
        const result = await provider.handleServiceVerb('activeTabChanged', { tab: 'briefs' });
        assert.deepStrictEqual(result, { success: true, activeTab: 'briefs' });
        assert.ok(provider._seats.has('__default__'));
        provider.dispose();
    });

    await test('A5. keyed debounce: two seats previewing the SAME doc both get an auto-refresh', async () => {
        const { provider } = buildTestHarness(tmpDir);
        const built = [];
        provider._buildAndSendPreview = async (opts) => { built.push(opts.originatorId); return { success: true, payload: {} }; };

        const reg = { sourceFolder: htmlDir, docId: 'sample.html', sourceId: 'html-folder' };
        const seatA = provider._seatFor({ originatorId: 'client_A', __viaHttp: true });
        const seatB = provider._seatFor({ originatorId: 'client_B', __viaHttp: true });
        seatA.htmlPreview = { ...reg };
        seatB.htmlPreview = { ...reg };

        provider._autoRefreshHtmlPreview(sampleHtml);
        assert.strictEqual(provider._autoRefreshDebounces.size, 2, 'one debounce per (seat,target)');
        await sleep(450);
        assert.deepStrictEqual(built.sort(), ['client_A', 'client_B'], 'both seats refreshed — a shared debounce collapses this to one');
        provider.dispose();
    });

    await test('A6. eviction: disconnect schedules grace, proof-of-life cancels, silent death evicts + stops poll', async () => {
        const { provider } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;
        provider._evictionGraceMs = 40;

        let disconnectCb = null;
        provider.setApiServer({
            wsHub: { onDisconnect: (cb) => { disconnectCb = cb; return () => {}; }, connectionCount: 0 },
            getPort: () => 0
        });
        assert.ok(disconnectCb, 'provider registers onDisconnect');

        await provider.handleServiceVerb('activeTabChanged', { tab: 'html-preview', originatorId: 'client_A' });
        assert.ok(provider._externalFilePollTimer, 'poll running');

        // Drop 1: reconnect (any message from the same id) inside grace cancels eviction.
        disconnectCb('client_A');
        assert.strictEqual(provider._evictionTimers.size, 1, 'eviction scheduled');
        await provider.handleServiceVerb('activeTabChanged', { tab: 'html-preview', originatorId: 'client_A' });
        assert.strictEqual(provider._evictionTimers.size, 0, 'proof of life cancels the pending eviction');
        await sleep(90);
        assert.ok(provider._seats.has('client_A'), 'seat survives a transient drop');
        assert.ok(provider._externalFilePollTimer, 'poll still running');

        // Drop 2: no reconnect — seat evicted after grace and the poll stops.
        disconnectCb('client_A');
        await sleep(90);
        assert.ok(!provider._seats.has('client_A'), 'seat evicted after grace');
        assert.strictEqual(provider._externalFilePollTimer, undefined, 'poll stopped after last seat evicted');

        // Foreign ids (other panels share the hub) schedule nothing.
        disconnectCb('kanban_client_Z');
        assert.strictEqual(provider._evictionTimers.size, 0, 'no eviction timer for ids without a Design seat');
        provider.dispose();
    });

    await test('A7. poll tick refreshes a seat\'s previewed DOCUMENT on mtime advance (no panel, no watchers)', async () => {
        const { provider } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;
        provider._sendHtmlDocsReady = async () => {};
        const refreshed = [];
        provider._autoRefreshHtmlPreview = (p) => refreshed.push(p);

        const seat = provider._seatFor({ originatorId: 'client_A', __viaHttp: true });
        seat.activeTab = 'html-preview';
        seat.htmlPreview = { sourceFolder: htmlDir, docId: 'sample.html', sourceId: 'html-folder' };

        await provider._pollTick();
        assert.strictEqual(refreshed.length, 0, 'first sighting only seeds the mtime baseline');

        const future = new Date(Date.now() + 5000);
        fs.utimesSync(sampleHtml, future, future);
        await provider._pollTick();
        assert.strictEqual(refreshed.length, 1, 'mtime advance routes through the auto-refresh path');
        assert.strictEqual(path.resolve(refreshed[0]), path.resolve(sampleHtml));
        provider.dispose();
    });

    console.log('\n— Part B: wsHub liveness —');

    async function startHub(pingIntervalMs) {
        const server = http.createServer();
        await new Promise(res => server.listen(0, '127.0.0.1', res));
        const port = server.address().port;
        const hub = new WsHub({ server, getAuthToken: async () => '', pingIntervalMs });
        hub.attach();
        return { server, hub, port };
    }

    await test('B1. graceful close fires onDisconnect with the connection\'s originatorId', async () => {
        const { server, hub, port } = await startHub(60);
        const gone = [];
        hub.onDisconnect((id) => gone.push(id));
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_graceful`);
        await new Promise(res => client.on('open', res));
        assert.strictEqual(hub.connectionCount, 1);
        client.close();
        await sleep(100);
        assert.deepStrictEqual(gone, ['cli_graceful']);
        assert.strictEqual(hub.connectionCount, 0);
        hub.close();
        await new Promise(res => server.close(res));
    });

    await test('B2. keepalive terminates a client that stops answering pong; onDisconnect fires', async () => {
        const { server, hub, port } = await startHub(60);
        const gone = [];
        hub.onDisconnect((id) => gone.push(id));
        // autoPong:false = a half-open/dead client: never answers the server's pings.
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_dead`, { autoPong: false });
        await new Promise(res => client.on('open', res));
        const closed = new Promise(res => client.on('close', res));
        await Promise.race([closed, sleep(1000)]);
        await sleep(50);
        assert.deepStrictEqual(gone, ['cli_dead'], 'dead client must be terminate()d by the keepalive');
        assert.strictEqual(hub.connectionCount, 0);
        hub.close();
        await new Promise(res => server.close(res));
    });

    await test('B3. healthy client survives ≥3 keepalive ticks and still receives broadcasts', async () => {
        const { server, hub, port } = await startHub(60);
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws?originatorId=cli_healthy`); // autoPong defaults on
        await new Promise(res => client.on('open', res));
        const received = [];
        client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
        await sleep(250); // > 3 ticks at 60ms
        assert.strictEqual(hub.connectionCount, 1, 'healthy client must never be terminated');
        hub.broadcast('pingCheck', { ok: true });
        await sleep(100);
        assert.ok(received.some(m => m.type === 'pingCheck'), 'broadcast still delivered after ticks');
        client.close();
        hub.close();
        await new Promise(res => server.close(res));
    });

    await test('B4. close() clears the keepalive interval (no live handle)', async () => {
        const { server, hub } = await startHub(60);
        assert.ok(hub._pingInterval, 'interval running after attach');
        hub.close();
        assert.strictEqual(hub._pingInterval, null, 'close() must clear the keepalive interval');
        await new Promise(res => server.close(res));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
