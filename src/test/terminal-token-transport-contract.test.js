'use strict';

/**
 * Contract: terminal-channel authentication.
 * (extension-host-pty-fleet-and-packaging.md, step 2b.)
 *
 * TWO TOKEN SOURCES EXIST BY DESIGN — this file exists to stop them being "simplified"
 * into one:
 *
 *   HTTP token      `LocalApiServerOptions.getAuthToken`. In the extension host this is
 *                   `secrets.get('switchboard.apiToken') || ''` — an opt-in secret that
 *                   is EMPTY for essentially every install, so `_checkAuth` short-
 *                   circuits into loopback trust. The whole skill ecosystem
 *                   (Switchboard CLI / skills) rides that path with no token
 *                   handling whatsoever. Returning a non-empty value from getAuthToken
 *                   401s every skill, every script and /health.
 *
 *   Terminal token  The gateway's OWN closure. Per-session, in-memory, never persisted.
 *                   `/ws/terminal` is an RCE-grade input channel, so the gateway keeps
 *                   `rejectWhenTokenEmpty: true` and must NEVER fall back to loopback
 *                   trust.
 *
 * THE REGRESSION THIS FILE PINS. The token has to reach the browser somehow. Injecting
 * it as an inline `<script>` does not work: the terminals panel serves
 * `script-src 'nonce-<n>' 'self'`, so a nonce-less inline script is blocked outright,
 * `window.__SB_TERMINAL_TOKEN__` stays undefined, no `&token=` is appended, and every
 * upgrade 401s — terminals that RENDER but never STREAM, which is exactly the silent
 * dead panel step 2b exists to prevent. The transport must be CSP-legal.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

function get(port, pathname, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: headers || {} }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, raw: data }));
        });
        req.on('error', reject);
        req.end();
    });
}

(async function main() {
    console.log('\n── Terminal token transport contract ──');

    const { LocalApiServer } = require(path.join(REPO_ROOT, 'out', 'services', 'LocalApiServer.js'));
    const { authorizeWsUpgrade } = require(path.join(REPO_ROOT, 'out', 'services', 'wsUpgradeAuth.js'));

    // --- the gateway's own guard -------------------------------------------
    await test('an empty gateway token rejects the upgrade even from loopback', async () => {
        const req = { url: '/ws/terminal?name=x', headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' } };
        const auth = await authorizeWsUpgrade(req, async () => '', { rejectWhenTokenEmpty: true });
        assert.strictEqual(auth.authorized, false, 'rejectWhenTokenEmpty must refuse an empty token — /ws/terminal is an RCE-grade channel, loopback is not a credential.');
        assert.strictEqual(auth.statusCode, 401, 'an empty-token rejection must be a 401');
    });

    await test('the query-param form of the terminal token authorizes the upgrade', async () => {
        // terminals.js appends `&token=<value>`; authorizeWsUpgrade already accepts it,
        // so the corrected transport needs no gateway change.
        const token = 'a'.repeat(64);
        const req = { url: `/ws/terminal?name=x&token=${token}`, headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' } };
        const auth = await authorizeWsUpgrade(req, async () => token, { rejectWhenTokenEmpty: true });
        assert.strictEqual(auth.authorized, true, 'a matching ?token= query param must authorize the upgrade');
    });

    await test('a wrong terminal token is rejected', async () => {
        const req = { url: '/ws/terminal?name=x&token=wrong', headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' } };
        const auth = await authorizeWsUpgrade(req, async () => 'b'.repeat(64), { rejectWhenTokenEmpty: true });
        assert.strictEqual(auth.authorized, false, 'a mismatched token must not authorize the upgrade');
    });

    await test('the HTTP-token cookie does NOT satisfy a gateway expecting the terminal token', () => {
        const req = { url: '/ws/terminal?name=x', headers: { host: '127.0.0.1:1234', cookie: 'sb_session=http-token-value' }, socket: { remoteAddress: '127.0.0.1' } };
        return authorizeWsUpgrade(req, async () => 'terminal-token-value', { rejectWhenTokenEmpty: true })
            .then(auth => assert.strictEqual(auth.authorized, false, 'the HTTP token must not authorize the terminal channel'));
    });

    await test('vscode-webview origin with valid token authorizes upgrade', async () => {
        const req = { url: '/ws/terminal?name=x&token=valid-token', headers: { host: '127.0.0.1:1234', origin: 'vscode-webview://12345' }, socket: { remoteAddress: '127.0.0.1' } };
        const auth = await authorizeWsUpgrade(req, async () => 'valid-token', { rejectWhenTokenEmpty: true });
        assert.strictEqual(auth.authorized, true, 'vscode-webview origin with valid token must authorize upgrade');
    });

    await test('vscode-webview origin with invalid token fails upgrade', async () => {
        const req = { url: '/ws/terminal?name=x&token=wrong-token', headers: { host: '127.0.0.1:1234', origin: 'vscode-webview://12345' }, socket: { remoteAddress: '127.0.0.1' } };
        const auth = await authorizeWsUpgrade(req, async () => 'valid-token', { rejectWhenTokenEmpty: true });
        assert.strictEqual(auth.authorized, false, 'vscode-webview origin with invalid token must fail upgrade');
    });

    await test('untrusted web origin with valid token is rejected by origin check', async () => {
        const req = { url: '/ws/terminal?name=x&token=valid-token', headers: { host: '127.0.0.1:1234', origin: 'https://evil.example.com' }, socket: { remoteAddress: '127.0.0.1' } };
        const auth = await authorizeWsUpgrade(req, async () => 'valid-token', { rejectWhenTokenEmpty: true });
        assert.strictEqual(auth.authorized, false, 'untrusted web origin must be rejected');
        assert.strictEqual(auth.statusCode, 403, 'untrusted origin must get 403');
    });

    await test('the gateway keeps rejectWhenTokenEmpty: true', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'terminalWsGateway.ts'), 'utf8');
        assert.ok(
            /rejectWhenTokenEmpty:\s*true/.test(src),
            'terminalWsGateway must keep rejectWhenTokenEmpty: true. Relaxing it to loopback trust would let any local process attach to and type into an agent shell.'
        );
    });

    // --- the HTTP trust model is untouched ----------------------------------
    await test('an unauthenticated GET /health still succeeds when the HTTP token is unset', async () => {
        // The specific breakage step 2b exists to avoid: if the terminal token were
        // returned from getAuthToken, the whole HTTP surface would flip to
        // token-required and 401 the entire skill ecosystem.
        const server = new LocalApiServer({ port: 0, workspaceRoot: REPO_ROOT, getAuthToken: async () => '' });
        await server.start();
        try {
            const res = await get(server.getPort(), '/health');
            assert.strictEqual(res.status, 200, `loopback trust must survive: expected 200 from /health, got ${res.status}`);
        } finally {
            await server.stop();
        }
    });

    await test('the extension host does NOT return the terminal token from getAuthToken', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const start = src.indexOf('getAuthToken:');
        assert.ok(start > -1, 'TaskViewerProvider must supply getAuthToken');
        const block = src.slice(start, start + 400);
        assert.ok(
            /switchboard\.apiToken/.test(block),
            'getAuthToken must keep reading the switchboard.apiToken secret.'
        );
        assert.ok(
            !/_terminalSessionToken/.test(block),
            'the terminal token must NEVER be returned from getAuthToken — that flips the entire HTTP surface to token-required and 401s every skill.'
        );
    });

    // --- the transport is CSP-legal -----------------------------------------
    await test('the terminals panel CSP forbids nonce-less inline script (the trap is real)', () => {
        const shared = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
        const fnStart = shared.indexOf('export function getTerminalsHtml');
        assert.ok(fnStart > -1, 'getTerminalsHtml must exist');
        const body = shared.slice(fnStart, fnStart + 2000);
        const csp = /const csp = `([^`]*)`/.exec(body);
        assert.ok(csp, 'getTerminalsHtml must declare a CSP');
        assert.ok(/script-src[^;]*nonce-/.test(csp[1]), 'the terminals CSP must be nonce-based');
        assert.ok(
            !/script-src[^;]*'unsafe-inline'/.test(csp[1]),
            "the terminals CSP must not allow 'unsafe-inline' — that is what makes a nonce-less injected <script> unusable as a token transport."
        );
    });

    await test('the host injects the terminal token through a CSP-legal channel', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const idx = src.indexOf('_terminalSessionToken');
        assert.ok(idx > -1, 'TaskViewerProvider must mint a terminal session token');

        // Find the injection site (the getPanelHtml post-processing for id === 'terminals').
        const site = src.indexOf("id === 'terminals'");
        assert.ok(site > -1, 'the terminals panel HTML must be post-processed to carry the token');
        // Strip comments before scanning — the injection site legitimately DISCUSSES the
        // rejected inline-script approach, and matching prose would be a false positive.
        // Window sized for the whole post-processing arm, not just the first
        // attribute. The arm accumulates attributes (token, pty-host origin,
        // working-silence threshold) each with its own rationale comment, and a
        // window tight enough to have fitted the ORIGINAL arm reports a missing
        // data-attribute the moment a second one is added above it — a false
        // regression that says "the token is gone" when the token is right there.
        // Comments are stripped AFTER the slice, so prose counts against it.
        const block = src.slice(site, site + 2600)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        const injectsBareScript = /<script>(?![\s\S]{0,40}nonce)/.test(block);
        assert.ok(
            !injectsBareScript,
            'the token is injected as a nonce-less inline <script>, which the terminals CSP blocks. '
            + 'The token would never reach terminals.js and every /ws/terminal upgrade would 401 — terminals that render but never stream. '
            + 'Use a body data-attribute (no CSP interaction) or a nonced script.'
        );
        assert.ok(
            /data-terminal-token/.test(block),
            'expected the token to be carried on a body data-attribute (data-terminal-token), which CSP does not police.'
        );
    });

    await test('terminals.js reads the token from the CSP-legal channel and appends it to the WS URL', () => {
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        assert.ok(
            /dataset\.terminalToken/.test(js),
            'terminals.js must read the token from document.body.dataset.terminalToken.'
        );
        assert.ok(
            /\/ws\/terminal\?name=/.test(js) && /&token=\$\{encodeURIComponent\(/.test(js),
            'terminals.js must append the token as a ?token= param on the /ws/terminal upgrade URL.'
        );
        // Standalone injects nothing and relies on the sb_session cookie, which
        // authorizeWsUpgrade also accepts. Absent token ⇒ no param ⇒ unchanged behaviour.
        assert.ok(
            /if \(terminalToken\)/.test(js),
            'the token param must be conditional so standalone (cookie auth) is unaffected.'
        );
    });

    // --- the token must land on the REAL body tag --------------------------
    // The two source-grep checks above both passed while the shipped panel was dead:
    // terminals.html grew a CSS comment mentioning the body tag in prose, and the
    // first-match `.replace('<body', ...)` stamped the token into that comment. The
    // real body tag rendered bare, terminals.js read no token, every /ws/terminal
    // upgrade 401'd, and the browser fleet showed terminals that accepted no input.
    // Grepping source cannot see that — these checks render and inspect the output.
    const { getPanelHtmlById, injectBodyAttributes } = require(path.join(REPO_ROOT, 'out', 'services', 'headlessPanelHtml.js'));

    /** The body tag as a browser would parse it: the first one after </head>. */
    function realBodyTag(html) {
        const headEnd = html.search(/<\/head\s*>/i);
        assert.ok(headEnd > -1, 'panel HTML must have a </head>');
        const match = /<body\b[^>]*>/i.exec(html.slice(headEnd));
        assert.ok(match, 'panel HTML must have a <body> tag after </head>');
        return match[0];
    }

    await test('injectBodyAttributes ignores a <body> written in prose before </head>', () => {
        const html = '<html><head><style>/* the class lands on <body> somehow */</style></head>\n<body>\n</body></html>';
        const out = injectBodyAttributes(html, 'data-terminal-token="deadbeef"');
        assert.ok(
            /data-terminal-token="deadbeef"/.test(realBodyTag(out)),
            'attributes must land on the real body tag, not the first textual "<body" occurrence.'
        );
        assert.ok(
            !/data-terminal-token/.test(out.slice(0, out.search(/<\/head\s*>/i))),
            'nothing may be injected into <head> — a comment or inline CSS mentioning the tag is not the tag.'
        );
    });

    await test('injectBodyAttributes preserves attributes already on the tag', () => {
        const out = injectBodyAttributes('<html><head></head><body class="cyber-theme-enabled"></body></html>', 'data-panel="terminals"');
        const tag = realBodyTag(out);
        assert.ok(/data-panel="terminals"/.test(tag) && /class="cyber-theme-enabled"/.test(tag),
            'injection must add attributes without dropping existing ones');
    });

    await test('every rendered panel carries its host attributes on the real body tag', () => {
        for (const id of ['board', 'project', 'memo', 'planning', 'design', 'setup', 'terminals']) {
            const result = getPanelHtmlById(id, REPO_ROOT, REPO_ROOT, {}, 'cyber-theme-enabled');
            assert.ok(result && result.html, `${id} panel must render`);
            const tag = realBodyTag(result.html);
            assert.ok(/data-panel="/.test(tag), `${id}: data-panel must be on the real body tag, not stamped into <head>`);
            assert.ok(/data-host-capabilities="/.test(tag), `${id}: data-host-capabilities must be on the real body tag`);
            assert.ok(/class="cyber-theme-enabled"/.test(tag), `${id}: the theme class must be on the real body tag`);
        }
    });

    await test('the rendered terminals panel carries data-terminal-token on the real body tag', () => {
        // End-to-end over the exact composition the host uses: getPanelHtmlById first
        // (workspace root / panel id / capabilities / theme), then the token appended to
        // the already-rendered HTML.
        const result = getPanelHtmlById('terminals', REPO_ROOT, REPO_ROOT, {}, 'cyber-theme-enabled');
        const html = injectBodyAttributes(result.html, `data-terminal-token="${'a'.repeat(64)}"`);
        const tag = realBodyTag(html);
        assert.ok(
            /data-terminal-token="a{64}"/.test(tag),
            'the terminals panel must render the token on its real body tag — terminals.js reads '
            + 'document.body.dataset.terminalToken, and without it every /ws/terminal upgrade 401s: '
            + 'terminals that render but accept no input.'
        );
        assert.ok(
            !/data-terminal-token/.test(html.slice(0, html.search(/<\/head\s*>/i))),
            'the token must not be injected into <head> (a CSS comment mentioning the body tag is not the tag).'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} contract check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll terminal token transport checks passed.\n');
})();
