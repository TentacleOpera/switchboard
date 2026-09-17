'use strict';

/**
 * Contract: the Terminals panel's first-load payload stays inside a byte budget,
 * the canvas fallback renderer is fetched lazily (not eagerly), and the shared
 * static handler emits a validator (ETag) so a repeat load can 304.
 *
 * Plan: the-terminals-panel-costs-a-megabyte-and-a-half-before-it-can-take-a-click.
 *
 * THE BUDGET MEASURES UNCOMPRESSED FILE SIZES (parse/compile cost), NOT COMPRESSED
 * TRANSFER. Compression is already active via _wrapForCompression on every response;
 * the budget bounds the work the browser's main thread does AFTER decompression,
 * which is the real bottleneck behind "takes forever to be ready for a click". A
 * future maintainer must NOT "fix" the number by switching to compressed sizes —
 * that would hide the parse cost this gate exists to bound.
 *
 * Three silent-failure shapes this file guards:
 *  - Re-accretion: the panel grew to 1.5 MB by individually-defensible additions
 *    with no size budget. Without a gate it re-accretes and nobody notices until
 *    an operator complains again.
 *  - Eager canvas: addon-canvas.js (95 KB) is the WebGL-unavailable fallback. On
 *    any machine WITH WebGL it was fetched, parsed and discarded every load. A
 *    re-added eager <script> tag is invisible to every other gate.
 *  - Missing validator: `Cache-Control: no-cache` without an ETag is a full
 *    re-download on every load. The header reads correct; the regression is the
 *    missing validator, which a `curl -I` (405) hides.
 *
 * Run with:
 *   npm run compile-tests && node src/test/terminals-panel-payload-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { LocalApiServer } = require('../../out/services/LocalApiServer');

const WEBVIEW_DIR = path.join(__dirname, '..', 'webview');
const TERMINALS_HTML = fs.readFileSync(path.join(WEBVIEW_DIR, 'terminals.html'), 'utf8');
const DOCK_HTML = fs.readFileSync(path.join(WEBVIEW_DIR, 'dock.html'), 'utf8');
const TERMINALS_VP = fs.readFileSync(path.join(WEBVIEW_DIR, 'terminalViewport.js'), 'utf8');
const LOCAL_API_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'LocalApiServer.ts'), 'utf8');

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

// ─── Byte budget ────────────────────────────────────────────────────────────
// The budget bounds the uncompressed size of the panel's first load: the served
// HTML plus every eagerly-referenced asset (deferred scripts + linked CSS + the
// transport shim injected server-side). addon-canvas.js is excluded because it is
// now lazy — fetched only when WebGL is absent.
//
// BUDGET IS UNCOMPRESSED SOURCE BYTES, measured against src/webview. That is
// deliberately NOT what a packaged install downloads: `webpack --mode production`
// minifies the CopyPlugin output, so dist/webview/terminals.js is ~170 KB where the
// source is ~664 KB. The budget's job is to bound what humans ADD to the source, which
// is where re-accretion happens; the shipped figure is a build-time property and is
// asserted separately by the eager-set assertions below.
//
// The pre-plan first load measured 1517 KB of source (2026-09-12, against a
// DEVELOPMENT build, which is served unminified). 1045 KB is the post-plan figure with
// the xterm bundle and the canvas addon both off the critical path; the budget sits
// just above it, tight enough that re-adding either eagerly breaches it.
const PANEL_BUDGET_BYTES = 1100 * 1024;

// Placeholders substituted server-side by getTerminalsHtml (headlessPanelHtml.ts).
// Mapped here so the budget reads SRC, not a possibly-stale dist/.
const PLACEHOLDER_TO_URI = {
    '{{XTERM_JS_URI}}': '/static/webview/vendor/xterm/xterm.js',
    '{{XTERM_CSS_URI}}': '/static/webview/vendor/xterm/xterm.css',
    '{{XTERM_ADDON_FIT_URI}}': '/static/webview/vendor/xterm/addon-fit.js',
    '{{XTERM_ADDON_WEBGL_URI}}': '/static/webview/vendor/xterm/addon-webgl.js',
    '{{TERMINAL_VIEWPORT_JS_URI}}': '/static/webview/terminalViewport.js',
    '{{TERMINALS_JS_URI}}': '/static/webview/terminals.js',
    '{{SHARED_UTILS_URI}}': '/static/webview/sharedUtils.js',
    '{{DOCK_JS_URI}}': '/static/webview/dock.js',
    '{{STATUS_CARDS_URI}}': '/static/webview/statusCards.js',
    '{{STATUS_CARDS_CSS_URI}}': '/static/webview/statusCards.css',
};

// The transport shim files injected by injectTransportShim
// (headlessPanelHtml.ts:74) — plain <script> tags, NOT in the HTML source, so
// added explicitly. They are eagerly fetched and parsed, so they count.
// Injected by terminalViewport.js at runtime (data-* body attributes carry the URLs),
// never <script> tags in the document. The xterm bundle is 383 KB — 27% of the old
// first load — and is needed only by materializeTerminalView, which runs after the
// fleet fetch; the canvas addon only when WebGL is absent.
const LAZY_VENDOR_URIS = [
    '/static/webview/vendor/xterm/xterm.js',
    '/static/webview/vendor/xterm/addon-fit.js',
    '/static/webview/vendor/xterm/addon-webgl.js',
    '/static/webview/vendor/xterm/addon-canvas.js',
];

const TRANSPORT_SHIM_URIS = [
    '/static/webview/sharedDefaults.js',
    '/static/webview/clipboardFallback.js',
    '/static/webview/transport.js',
];

function resolveStaticPath(uri) {
    if (!uri.startsWith('/static/webview/')) { return null; }
    return path.join(WEBVIEW_DIR, uri.slice('/static/webview/'.length));
}

function eagerAssetUris(html) {
    const assets = [];
    const linkRe = /<link[^>]+href="([^"]+)"/g;
    const scriptRe = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) { assets.push(m[1]); }
    while ((m = scriptRe.exec(html)) !== null) { assets.push(m[1]); }
    return assets
        .map(u => PLACEHOLDER_TO_URI[u] || u)
        // Everything terminalViewport.js injects at runtime is off the first-load
        // path and does not count against the budget. If any of these reappears as a
        // <script> tag the assertions below fail, so this filter cannot hide a
        // regression — it only keeps the arithmetic honest.
        .filter(u => !LAZY_VENDOR_URIS.includes(u));
}

function panelFirstLoadBytes(html) {
    let total = Buffer.byteLength(html, 'utf8');
    for (const uri of eagerAssetUris(html)) {
        const p = resolveStaticPath(uri);
        if (p && fs.existsSync(p)) { total += fs.statSync(p).size; }
    }
    for (const uri of TRANSPORT_SHIM_URIS) {
        const p = resolveStaticPath(uri);
        if (p && fs.existsSync(p)) { total += fs.statSync(p).size; }
    }
    return total;
}

// ─── Live harness for the static handler ────────────────────────────────────
// Drives the real _handleServeStatic via Object.create (same harness pattern as
// design-asset-route-traversal.test.js). The compression wrapper is applied in
// _handleRequest, not here, so a 304 (status < 300) is never compressed anyway.

function buildServer(options) {
    const server = Object.create(LocalApiServer.prototype);
    server._options = options;
    return server;
}

function fakeRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        wroteHead: false,
        ended: false,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; this.wroteHead = true; },
        end(chunk) { this.body = chunk; this.ended = true; },
    };
}

function fakeReq(url, headers) {
    return { url, method: 'GET', headers: Object.assign({ host: '127.0.0.1:9999' }, headers || {}) };
}

async function main() {
    console.log('\n=== Terminals panel payload contract ===\n');

    // ── 1. Byte budget ──────────────────────────────────────────────────────
    await test('terminals panel first load is inside the byte budget (uncompressed)', () => {
        const bytes = panelFirstLoadBytes(TERMINALS_HTML);
        const kb = (bytes / 1024).toFixed(0);
        assert.ok(bytes <= PANEL_BUDGET_BYTES,
            `terminals panel first load is ${kb} KB > ${PANEL_BUDGET_BYTES / 1024} KB budget. `
            + 'The budget bounds UNCOMPRESSED parse/compile cost (see file header). '
            + 'If this is a deliberate, reviewed addition, raise the budget WITH a note; '
            + 'otherwise the panel is re-accreting.');
        console.log(`     first load: ${kb} KB (budget ${PANEL_BUDGET_BYTES / 1024} KB)`);
    });

    await test('the budget is materially below the 1517 KB measured on 2026-09-12', () => {
        const bytes = panelFirstLoadBytes(TERMINALS_HTML);
        const measured = 1517 * 1024;
        // The xterm bundle (383 KB) and the canvas addon (95 KB) both left the critical
        // path, so the gap is ~470 KB, not the ~95 KB the lazy-canvas step alone bought.
        assert.ok(bytes < measured - 400 * 1024,
            `first load (${(bytes / 1024).toFixed(0)} KB) is not materially below the 1517 KB `
            + 'baseline — the xterm bundle and the canvas addon should both be off the '
            + 'first-load path.');
    });

    // ── 2. addon-canvas.js is NOT eagerly referenced ────────────────────────
    await test('addon-canvas.js is not referenced by an eager <script> tag in terminals.html', () => {
        assert.ok(!/<script[^>]+addon-canvas\.js/.test(TERMINALS_HTML),
            'addon-canvas.js must not be an eager <script> — it is the WebGL-unavailable '
            + 'fallback and is fetched lazily by terminalViewport.js when WebGL is absent.');
    });

    await test('addon-canvas.js is not referenced by an eager <script> tag in dock.html', () => {
        assert.ok(!/<script[^>]+addon-canvas\.js/.test(DOCK_HTML),
            'dock.html embeds terminal viewports too and must not eagerly load the canvas addon.');
    });

    await test('the xterm bundle is not referenced by an eager <script> tag in either document', () => {
        // 383 KB — 27% of the pre-plan first load — and none of it is needed before the
        // sidebar takes a click. Deferred scripts execute in DOCUMENT ORDER, so these
        // tags sitting ahead of terminals.js meant the browser compiled all of xterm
        // before it compiled the code that wires a single button.
        for (const [label, html] of [['terminals.html', TERMINALS_HTML], ['dock.html', DOCK_HTML]]) {
            for (const f of ['xterm.js', 'addon-fit.js', 'addon-webgl.js']) {
                assert.ok(!new RegExp('<script[^>]+' + f.replace('.', '\\.')).test(html),
                    `${label} must not load ${f} with a <script> tag — terminalViewport.js `
                    + 'injects it, which keeps the compile off the path to interactive.');
            }
        }
    });

    await test('the xterm bundle URIs are exposed as body data attributes (both roots)', () => {
        // Without these the injector has no URL, xtermReady resolves immediately with
        // nothing loaded, and every pane logs "xterm.js did not load" — a panel that
        // renders its chrome and no terminals.
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'headlessPanelHtml.ts'), 'utf8');
        for (const fn of ['getTerminalsHtml', 'getDockHtml']) {
            const block = src.match(new RegExp(fn + '[\\s\\S]{0,6000}?data-xterm-uri="([^"]+)"'));
            assert.ok(block, `${fn} must inject data-xterm-uri onto <body>`);
            assert.strictEqual(block[1], '/static/webview/vendor/xterm/xterm.js');
        }
        for (const attr of ['data-xterm-fit-uri', 'data-xterm-webgl-uri']) {
            assert.ok(src.includes(attr), `headlessPanelHtml must inject ${attr}`);
        }
    });

    await test('materializeTerminalView is gated on xtermReady, and createTerminalView is not', () => {
        // The shape that matters: createTerminalView must stay synchronous (dock.js and
        // renderPaneGrid call it for effect and ignore the return), while the xterm
        // dependency is awaited one layer in, at the only site that touches
        // window.Terminal. A guard placed in createTerminalView instead would return
        // before terminalsMap.set and silently drop the pane.
        assert.ok(/whenRendered\(entry, \(\) => \{ void xtermReady\.then\(\(\) => materializeTerminalView\(entry\)\); \}\);/.test(TERMINALS_VP),
            'materialization must be gated on BOTH whenRendered and xtermReady.');
        const fn = TERMINALS_VP.match(/function createTerminalView\([\s\S]*?whenRendered\(entry,/);
        assert.ok(fn, 'createTerminalView not found');
        assert.ok(!/typeof window\.Terminal/.test(fn[0]),
            'createTerminalView must not check window.Terminal — it runs before the '
            + 'bundle is guaranteed to have landed, and an early return there drops the '
            + 'entry before terminalsMap.set.');
    });

    await test('the canvas addon URI is exposed as a body data attribute (terminals)', () => {
        // The runtime lazy-load reads document.body.dataset.canvasAddonUri. Without it
        // the kickoff is a no-op and a WebGL-less machine silently gets the DOM renderer
        // forever. The attribute is injected by getTerminalsHtml (headlessPanelHtml.ts).
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'headlessPanelHtml.ts'), 'utf8');
        const terminalsBody = src.match(/getTerminalsHtml[\s\S]{0,5000}?data-canvas-addon-uri="([^"]+)"/);
        assert.ok(terminalsBody,
            'getTerminalsHtml must inject data-canvas-addon-uri onto <body> so the runtime '
            + 'lazy-load has the resolved URL.');
        assert.strictEqual(terminalsBody[1], '/static/webview/vendor/xterm/addon-canvas.js',
            'the canvas addon URI must resolve to the vendored addon path.');
    });

    await test('the canvas addon URI is exposed as a body data attribute (dock)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'headlessPanelHtml.ts'), 'utf8');
        const dockBody = src.match(/getDockHtml[\s\S]{0,5000}?data-canvas-addon-uri="([^"]+)"/);
        assert.ok(dockBody,
            'getDockHtml must inject data-canvas-addon-uri onto <body> — the dock embeds '
            + 'terminal viewports and shares the same lazy-load path.');
    });

    await test('terminalViewport.js kicks off the canvas fetch when WebGL is absent', () => {
        assert.ok(/function ensureCanvasAddonKickedOff\(\)/.test(TERMINALS_VP),
            'terminalViewport.js must define ensureCanvasAddonKickedOff — the lazy-load kickoff.');
        assert.ok(/xtermReady\.then\(\(\) => \{\s*if \(!webglAvailable\(\)\) \{ ensureCanvasAddonKickedOff\(\); \}/.test(TERMINALS_VP),
            'the init kickoff must be gated on !webglAvailable() AT THE CALL SITE (that '
            + 'gate saves the 95 KB on a WebGL machine) and must run only AFTER xtermReady '
            + '— addon-webgl.js is injected now, so asking before it lands answers false on '
            + 'every machine and fetches the canvas addon universally.');
        assert.ok(/bodyUri\('canvasAddonUri'\)/.test(TERMINALS_VP),
            'the kickoff must read the URI from the canvasAddonUri body data attribute.');
        assert.ok(/document\.body\.dataset\[key\]/.test(TERMINALS_VP),
            'bodyUri must read from document.body.dataset — that is how every server-'
            + 'substituted asset URL reaches the runtime.');
    });

    await test('ensureCanvasAddonKickedOff does NOT gate itself on webglAvailable()', () => {
        // The bug this pins: a `if (webglAvailable()) { return; }` INSIDE the helper
        // makes the second kickoff path (attachCanvasRenderer, the WebGL-context-
        // creation-failed case) dead — webglAvailable() is TRUE there, so the guard
        // returns before fetching and that machine gets the DOM renderer forever.
        // The gate belongs at the module-init call site, never in the helper.
        const fn = TERMINALS_VP.match(/function ensureCanvasAddonKickedOff\(\)[\s\S]{0,900}?\n    }/);
        assert.ok(fn, 'ensureCanvasAddonKickedOff not found');
        assert.ok(!/webglAvailable\(\)/.test(fn[0]),
            'ensureCanvasAddonKickedOff must not call webglAvailable() — an internal WebGL '
            + 'guard silently kills the attachCanvasRenderer kickoff, which fires precisely '
            + 'when WebGL IS available but its context creation threw.');
    });

    await test('attachCanvasRenderer stays synchronous and kicks off the fetch if the addon is missing', () => {
        // The hazard the plan names: attachCanvasRenderer returns the addon
        // synchronously and its result is assigned to holder.current. A naive
        // lazy load returns undefined to a caller that assumes an object. The
        // accepted shape keeps it synchronous: if the addon has not landed it
        // returns null (DOM renderer fallback) AND kicks off the fetch so the
        // NEXT attach gets canvas.
        const fn = TERMINALS_VP.match(/function attachCanvasRenderer[\s\S]{0,1500}?\n    }/);
        assert.ok(fn, 'attachCanvasRenderer not found');
        const body = fn[0];
        assert.ok(/ensureCanvasAddonKickedOff\(\)/.test(body),
            'attachCanvasRenderer must kick off the canvas fetch when the addon is missing, '
            + 'so a WebGL context failure at runtime still loads canvas for the next attach.');
        assert.ok(/return null/.test(body),
            'attachCanvasRenderer must return null (DOM renderer fallback) when the addon is '
            + 'not yet loaded — never undefined.');
    });

    // ── 3. ETag + 304 on the shared static handler ──────────────────────────
    const serveStatic = {
        getBoardHtml: async () => ({ html: '<html></html>', csp: '' }),
        staticRoutes: { webview: [WEBVIEW_DIR] },
    };
    const server = buildServer({ serveStatic });

    await test('the static handler emits an ETag on a 200 response', async () => {
        const res = fakeRes();
        await server._handleServeStatic(fakeReq('/static/webview/terminals.css'), res);
        assert.strictEqual(res.statusCode, 200, 'terminals.css must be served from /static/webview/');
        assert.ok(res.headers && res.headers['ETag'],
            'the static handler must emit an ETag so no-cache revalidation can 304.');
        assert.ok(res.headers['Last-Modified'],
            'Last-Modified is the secondary validator and must accompany the ETag.');
        assert.strictEqual(res.headers['Cache-Control'], 'no-cache',
            'webview code/assets must stay no-cache (revalidate before use).');
    });

    await test('a matching If-None-Match receives 304 with an empty body', async () => {
        // First request to capture the ETag.
        const first = fakeRes();
        await server._handleServeStatic(fakeReq('/static/webview/terminals.css'), first);
        const etag = first.headers['ETag'];
        assert.ok(etag, 'need an ETag to test revalidation');

        const second = fakeRes();
        await server._handleServeStatic(
            fakeReq('/static/webview/terminals.css', { 'if-none-match': etag }),
            second);
        assert.strictEqual(second.statusCode, 304,
            'a matching If-None-Match must short-circuit to 304 — no-cache without a validator '
            + 'is a full re-download on every load.');
        assert.ok(second.body === undefined || second.body === null || second.body === '' || second.body.length === 0,
            'a 304 must carry an empty body.');
        assert.strictEqual(second.headers['ETag'], etag,
            'the 304 must echo the ETag so the cache entry stays valid.');
    });

    await test('a non-matching If-None-Match receives 200 with the body', async () => {
        const res = fakeRes();
        await server._handleServeStatic(
            fakeReq('/static/webview/terminals.css', { 'if-none-match': '"stale-0-0"' }),
            res);
        assert.strictEqual(res.statusCode, 200,
            'a non-matching If-None-Match must serve the full 200 response.');
        assert.ok(res.body && res.body.length > 0, 'the 200 must carry the body.');
    });

    await test('the ETag is derived from size + mtime (the stat already at the serve site)', () => {
        // Pin the derivation so a future "cleanup" does not switch to a hash that
        // costs a full file read on every request, or to a value that ignores size
        // (two same-mtime files of different sizes would collide).
        const body = LOCAL_API_SRC.match(/private async _handleServeStatic[\s\S]{0,4000}?res\.end\(fsSync\.readFileSync/);
        assert.ok(body, '_handleServeStatic not found');
        const handler = body[0];
        assert.ok(/stat\.size/.test(handler) && /stat\.mtimeMs/.test(handler),
            'the ETag must be derived from stat.size and stat.mtimeMs — both are already in '
            + 'hand from the isFile() stat, so no extra syscall is needed.');
        assert.ok(/if-none-match/.test(handler),
            'the handler must check req.headers[\'if-none-match\'] before writing the body.');
        assert.ok(/304/.test(handler),
            'the handler must short-circuit to 304 on a matching validator.');
    });

    // ── 4. The seven panel scripts still carry defer ─────────────────────────
    await test('the panel scripts in terminals.html still carry defer (no regression of b8f3d275)', () => {
        const scriptRe = /<script\s+([^>]*?)\s+src="([^"]+)"[^>]*>/g;
        let m;
        const withoutDefer = [];
        while ((m = scriptRe.exec(TERMINALS_HTML)) !== null) {
            const attrs = m[1];
            const src = PLACEHOLDER_TO_URI[m[2]] || m[2];
            // The transport shim is injected by injectTransportShim as plain <script> tags
            // (not deferred) and is not present in the HTML source. Only the panel scripts
            // declared in terminals.html itself are checked here.
            if (src.startsWith('/static/webview/') && !/\bdefer\b/.test(attrs)) {
                withoutDefer.push(src);
            }
        }
        assert.strictEqual(withoutDefer.length, 0,
            'panel scripts lost their defer attribute: ' + withoutDefer.join(', ')
            + '. defer makes the seven scripts download in parallel (b8f3d275); losing it '
            + 'reverts to serial fetch+compile.');
    });

    // ── 5. CSS extraction: the stylesheet is a cacheable linked file ────────
    await test('terminals.css is linked from terminals.html and served from /static/webview/', () => {
        assert.ok(/<link[^>]+href="\/static\/webview\/terminals\.css"/.test(TERMINALS_HTML),
            'the bulk of the panel CSS must live in a linked /static/webview/terminals.css '
            + 'so it is cacheable separately from the no-store HTML document.');
        assert.ok(fs.existsSync(path.join(WEBVIEW_DIR, 'terminals.css')),
            'src/webview/terminals.css must exist.');
    });

    await test('the @font-face blocks stay inline (template placeholders are server-substituted)', () => {
        // A static .css file is not template-substituted, so the {{HANKEN_FONT_URI}}
        // / {{GEIST_PIXEL_FONT_URI}} blocks must stay inline in the HTML. Moving them
        // to the .css file would ship literal placeholders to the browser.
        assert.ok(/\{\{HANKEN_FONT_URI\}\}/.test(TERMINALS_HTML),
            'the @font-face blocks with server-side placeholders must stay inline in terminals.html.');
        assert.ok(!/\{\{HANKEN_FONT_URI\}\}/.test(fs.readFileSync(path.join(WEBVIEW_DIR, 'terminals.css'), 'utf8')),
            'terminals.css must not contain template placeholders — it is served as a static file.');
    });

    await test('terminals.css is served with no-cache + ETag (the item 2/3 coupling)', async () => {
        // The coupling the plan names: extracted CSS without an ETag regresses repeat
        // loads (no-cache + no validator = full re-download PLUS a round trip the
        // inline CSS never cost). With the ETag, a repeat load 304s.
        const first = fakeRes();
        await server._handleServeStatic(fakeReq('/static/webview/terminals.css'), first);
        assert.strictEqual(first.headers['Cache-Control'], 'no-cache');
        assert.ok(first.headers['ETag'], 'extracted CSS needs the ETag to 304 on repeat loads.');
        const second = fakeRes();
        await server._handleServeStatic(
            fakeReq('/static/webview/terminals.css', { 'if-none-match': first.headers['ETag'] }),
            second);
        assert.strictEqual(second.statusCode, 304,
            'a repeat load of terminals.css must 304 — the coupling between CSS extraction '
            + 'and the ETag is honoured.');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
