'use strict';

/**
 * Contract: terminal sessions are persisted as readable markdown documents.
 *
 * The plan's Goal Invariants, one test each:
 *   - every session has a log covering more than the ring holds
 *   - a log never breaks its own markdown rendering
 *   - no log is reachable without auth, and none is ever committed
 *   - the live attach path is unchanged
 *   - BOTH hosts produce logs with dispatch headings, because the heading hook
 *     lives in the shared `sendPromptToPty` and both composition roots register
 *     against it
 *
 * The fence tests are the load-bearing ones. `renderMarkdown` delimits code
 * blocks on EXACTLY three backticks and its match is not line-anchored, so the
 * "use a fence longer than the payload" strategy does not work against this
 * renderer — an agent-printed ``` closes the block and the rest of the session
 * renders as prose. These tests render the writer's real output through the real
 * `renderMarkdown` rather than asserting on the bytes, because "the log renders
 * fine until it doesn't" is invisible to any assertion that stops at the file.
 *
 * Requires `npm run compile-tests` to have produced out/.
 *
 * Run with:
 *   npm run test:contract:terminal-session-log
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const REPO_ROOT = path.join(__dirname, '..', '..');
const {
    TerminalLogWriter,
    normalizeLogSlice,
    stripAnsi,
    collapseCarriageReturns,
    sanitizeFencePayload,
    LOG_FENCE_OPEN,
    LOG_FENCE_CLOSE,
} = require('../../out/standalone/terminalLogWriter');
const { LocalApiServer } = require('../../out/services/LocalApiServer');
const { sendPromptToPty } = require('../../out/standalone/ptyPromptDelivery');

const GATEWAY_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'terminalWsGateway.ts'), 'utf8');
const DELIVERY_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyPromptDelivery.ts'), 'utf8');
const BOOTSTRAP_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
const PTYHOST_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'ptyHost.ts'), 'utf8');
const TASKVIEWER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const GITIGNORE = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

// ── renderMarkdown, loaded the way its own contract test loads it ─────────────
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
dom.window.eval(fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'sharedUtils.js'), 'utf8'));
const renderMarkdown = dom.window.renderMarkdown;

/** The rendered HTML with every <pre> block removed — what leaked OUT of the code blocks. */
function outsideCodeBlocks(html) {
    return html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
}

/** Let the writer's per-terminal promise chain drain. */
const settle = () => new Promise(r => setTimeout(r, 50));

/** Three backticks, spelled out so it never ends a template literal in this file. */
const FENCE_MARK = '`'.repeat(3);

function tmpLogsDir(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sb-termlog-${tag}-`));
    return path.join(dir, '.switchboard', 'logs');
}

function readSessions(logsDir, prefix) {
    return fs.readdirSync(logsDir)
        .filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.md'))
        .sort();
}

// ── LocalApiServer harness: no vscode, no listening socket ────────────────────
// Same Object.create shape as design-asset-route-traversal.test.js — the private
// handler is driven directly so the auth gate is exercised, not assumed.
function buildServer(workspaceRoot, token) {
    const server = Object.create(LocalApiServer.prototype);
    server._options = { workspaceRoot, allRoots: [workspaceRoot], getAuthToken: async () => token };
    return server;
}
function fakeRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(chunk) { this.body = chunk === undefined ? '' : chunk; },
    };
}
async function getLog(server, name, query, token) {
    const res = fakeRes();
    const headers = { host: '127.0.0.1:9999' };
    if (token) { headers.authorization = `Bearer ${token}`; }
    const req = { url: `/terminals/${encodeURIComponent(name)}/log${query ? `?${query}` : ''}`, method: 'GET', headers };
    await server._handleTerminalLog(req, res, name);
    return res;
}

(async function main() {
    console.log('\n=== Terminal session logs as readable markdown ===\n');

    // ── Invariant: history outlives the ring ─────────────────────────────────
    await test('the log keeps output the 256 KB replay ring has already evicted', async () => {
        const logsDir = tmpLogsDir('ring');
        const w = new TerminalLogWriter(logsDir);
        // MAX_SCROLLBACK_BYTES is 256 KB; emit well past it so the earliest
        // lines are gone from the ring by the time the last one lands.
        const LINES = 6000; // ~300 KB of 50-char lines
        for (let i = 0; i < LINES; i++) {
            w.onFlush('coder-1', `line ${i} ${'.'.repeat(40)}\n`);
        }
        w.dispose();
        await settle();

        const file = path.join(logsDir, readSessions(logsDir, 'coder-1')[0]);
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(raw.length > 256 * 1024, `log should exceed the ring cap, got ${raw.length} bytes`);
        assert.ok(raw.includes('line 0 '), 'the FIRST line — long since evicted from the ring — must still be in the log');
        assert.ok(raw.includes(`line ${LINES - 1} `), 'the last line must be in the log');
    });

    // ── Invariant: a log never breaks its own markdown rendering ─────────────
    await test('agent-printed code fences do not break the document', async () => {
        const logsDir = tmpLogsDir('fence');
        const w = new TerminalLogWriter(logsDir);
        w.onPrompt('coder-1', 'implement the thing');
        w.onFlush('coder-1', 'plain line\r\n');
        w.onFlush('coder-1', 'here is code:\r\n' + FENCE_MARK + 'js\r\nconst secret = 1;\r\n' + FENCE_MARK + '\r\nand after\r\n');
        w.onFlush('coder-1', 'still logging\r\n');
        w.dispose();
        await settle();

        const raw = fs.readFileSync(path.join(logsDir, readSessions(logsDir, 'coder-1')[0]), 'utf8');
        const html = renderMarkdown(raw);
        const leaked = outsideCodeBlocks(html);

        // Every line of terminal output must still be INSIDE a code block. The
        // shipped failure was `const secret = 1;` rendering as prose because the
        // agent's own ``` closed the log's block.
        for (const needle of ['plain line', 'const secret = 1;', 'and after', 'still logging']) {
            assert.ok(html.includes(needle), `output line missing entirely: ${needle}`);
            assert.ok(!leaked.includes(needle),
                `"${needle}" escaped its code block and rendered as prose — an agent fence closed the log's own block`);
        }
        // The dispatch heading is the one thing that must be OUTSIDE the block.
        assert.ok(/<h2>[^<]*implement the thing<\/h2>/.test(html),
            'the dispatch heading must render as a heading, not as a line inside the code block');
    });

    await test('a prompt whose first line is a code fence cannot delimit from the heading', async () => {
        const logsDir = tmpLogsDir('fenceprompt');
        const w = new TerminalLogWriter(logsDir);
        w.onPrompt('coder-1', FENCE_MARK + 'sh\nrun this\n' + FENCE_MARK);
        w.onFlush('coder-1', 'output after the heading\n');
        w.dispose();
        await settle();

        const raw = fs.readFileSync(path.join(logsDir, readSessions(logsDir, 'coder-1')[0]), 'utf8');
        for (const line of raw.split('\n')) {
            if (line.startsWith('## ')) {
                assert.ok(!line.includes(FENCE_MARK),
                    'a heading carrying a bare fence delimits a block from mid-heading: ' + JSON.stringify(line));
            }
        }
        const leaked = outsideCodeBlocks(renderMarkdown(raw));
        assert.ok(!leaked.includes('output after the heading'), 'output must stay inside its code block');
    });

    await test('sanitizeFencePayload leaves 1- and 2-backtick runs alone and breaks 3+', () => {
        assert.strictEqual(sanitizeFencePayload('a `b` c'), 'a `b` c');
        assert.strictEqual(sanitizeFencePayload('a ``b`` c'), 'a ``b`` c');
        assert.ok(!sanitizeFencePayload(FENCE_MARK + 'js').includes(FENCE_MARK), '3 backticks must not survive');
        assert.ok(!sanitizeFencePayload('`'.repeat(9)).includes(FENCE_MARK), 'a long run must not survive');
    });

    // ── Invariant: redraws collapse ──────────────────────────────────────────
    await test('carriage-return redraws collapse to the final line state', async () => {
        const logsDir = tmpLogsDir('cr');
        const w = new TerminalLogWriter(logsDir);
        const FRAMES = 500;
        let raw = 0;
        for (let i = 0; i < FRAMES; i++) {
            const chunk = `\rWorking ${i}/${FRAMES} ${'|/-\\'[i % 4]}`;
            raw += chunk.length;
            w.onFlush('coder-1', chunk);
        }
        w.onFlush('coder-1', '\rdone\n');
        w.dispose();
        await settle();

        const out = fs.readFileSync(path.join(logsDir, readSessions(logsDir, 'coder-1')[0]), 'utf8');
        const spinnerLines = out.split('\n').filter(l => l.startsWith('Working '));
        assert.strictEqual(spinnerLines.length, 0,
            `no intermediate spinner frame should survive, found ${spinnerLines.length}`);
        assert.ok(out.includes('done'), 'the final line state must survive');
        assert.ok(out.length < raw / 4,
            `collapsed log (${out.length}B) should be a small fraction of the raw stream (${raw}B)`);
    });

    await test('collapseCarriageReturns overlays from column 0 and carries a partial line', () => {
        assert.strictEqual(collapseCarriageReturns('\rA\rB\rC\n', '').collapsed, 'C\n');
        assert.strictEqual(collapseCarriageReturns('abc\r\n', '').collapsed, 'abc\n', 'CRLF is a newline, not a redraw');
        const first = collapseCarriageReturns('par', '');
        assert.strictEqual(first.collapsed, '', 'an incomplete line is held back, not written');
        assert.strictEqual(collapseCarriageReturns('tial\n', first.carry).collapsed, 'partial\n');
    });

    await test('ANSI is stripped, including OSC and DEC private modes', () => {
        assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
        assert.strictEqual(stripAnsi('\x1b]0;title\x07body'), 'body');
        assert.strictEqual(stripAnsi('\x1b[?1049hfoo\x1b[?1049l'), 'foo');
    });

    // ── Invariant: no split characters ──────────────────────────────────────
    await test('a multi-byte character straddling a flush boundary survives intact', async () => {
        const logsDir = tmpLogsDir('utf8');
        const w = new TerminalLogWriter(logsDir);
        // The astral char lands in the CR-collapse carry (no newline yet) and is
        // written on the next flush — the boundary the frame-level guarantee
        // covers one layer up.
        w.onFlush('coder-1', 'before 😀');
        w.onFlush('coder-1', ' after — é ✓\n');
        w.dispose();
        await settle();

        const raw = fs.readFileSync(path.join(logsDir, readSessions(logsDir, 'coder-1')[0]), 'utf8');
        assert.ok(raw.includes('before 😀 after — é ✓'), `carry boundary corrupted the line: ${JSON.stringify(raw)}`);
        assert.ok(!raw.includes('�'), 'no replacement characters — the log must be valid UTF-8');
    });

    await test('a stream that never sends a newline is flushed at the carry cap', async () => {
        const logsDir = tmpLogsDir('carrycap');
        const w = new TerminalLogWriter(logsDir);
        // 64 KiB cap: a TUI repainting with cursor positioning has its escapes
        // stripped, so the whole repaint is ONE line and the carry would grow for
        // the life of the terminal.
        for (let i = 0; i < 100; i++) { w.onFlush('coder-1', 'x'.repeat(1024)); }
        await settle();
        const raw = fs.readFileSync(path.join(logsDir, readSessions(logsDir, 'coder-1')[0]), 'utf8');
        assert.ok(raw.length > 64 * 1024,
            `the carry must be flushed at the cap rather than held forever, got ${raw.length} bytes`);
        w.dispose();
    });

    // ── Invariant: history outlives the clear ───────────────────────────────
    await test('a session boundary rolls the file and preserves the cleared session', async () => {
        const logsDir = tmpLogsDir('roll');
        const w = new TerminalLogWriter(logsDir);
        w.onFlush('coder-1', 'work from the FIRST session\n');
        await settle();
        w.onSessionBoundary('coder-1');
        w.onFlush('coder-1', 'work from the SECOND session\n');
        w.dispose();
        await settle();

        const sessions = readSessions(logsDir, 'coder-1');
        assert.strictEqual(sessions.length, 2, `expected two session files, got ${sessions.join(', ')}`);
        const bodies = sessions.map(f => fs.readFileSync(path.join(logsDir, f), 'utf8'));
        const first = bodies.find(b => b.includes('FIRST'));
        const second = bodies.find(b => b.includes('SECOND'));
        assert.ok(first, 'the cleared session must still be on disk');
        assert.ok(second, 'the new session must be its own document');
        assert.ok(!first.includes('SECOND'),
            'output produced after the roll must not land in the pre-roll file — the queued write has to carry its own target path');
        assert.ok(second.startsWith('# Terminal log:'),
            'the rolled-to session is a new document and needs its own header');
        for (const body of bodies) {
            const leaked = outsideCodeBlocks(renderMarkdown(body));
            assert.ok(!leaked.includes('session'), 'each rolled file must be independently renderable');
        }
    });

    // ── Invariant: served ranged, and never without auth ────────────────────
    await test('an unauthenticated log request is refused', async () => {
        const logsDir = tmpLogsDir('auth');
        const wsRoot = path.join(logsDir, '..', '..');
        const w = new TerminalLogWriter(logsDir);
        w.onFlush('coder-1', 'secret token abc123\n');
        w.dispose();
        await settle();

        const server = buildServer(wsRoot, 'the-real-token');
        const anon = await getLog(server, 'coder-1', '', null);
        assert.strictEqual(anon.statusCode, 401, 'no token must mean 401, not a log body');
        assert.ok(!String(anon.body).includes('abc123'), 'the refusal must not leak the log');

        const wrong = await getLog(server, 'coder-1', '', 'not-the-real-token');
        assert.strictEqual(wrong.statusCode, 401, 'a wrong token must mean 401');

        const ok = await getLog(server, 'coder-1', '', 'the-real-token');
        assert.strictEqual(ok.statusCode, 200, 'a valid Bearer token must be served');
        assert.ok(String(ok.body).includes('abc123'), 'the authenticated read must return the log');
    });

    await test('a missing log is a 404, not a 500', async () => {
        const logsDir = tmpLogsDir('missing');
        const server = buildServer(path.join(logsDir, '..', '..'), '');
        const res = await getLog(server, 'never-existed', '', null);
        assert.strictEqual(res.statusCode, 404);
    });

    await test('a large log is served ranged — neither the default nor an offset reads the whole file', async () => {
        const logsDir = tmpLogsDir('ranged');
        const wsRoot = path.join(logsDir, '..', '..');
        const w = new TerminalLogWriter(logsDir);
        for (let i = 0; i < 20000; i++) { w.onFlush('coder-1', `line ${i} ${'.'.repeat(40)}\n`); }
        w.dispose();
        await settle();

        const file = path.join(logsDir, readSessions(logsDir, 'coder-1')[0]);
        const total = fs.statSync(file).size;
        assert.ok(total > 512 * 1024, `need a big log to test the range, got ${total}`);

        const server = buildServer(wsRoot, '');
        const dflt = await getLog(server, 'coder-1', '', null);
        assert.strictEqual(dflt.statusCode, 200);
        assert.ok(dflt.body.length < total / 2,
            `the default tail must not return the whole file (${dflt.body.length} of ${total})`);
        assert.strictEqual(dflt.headers['X-Log-Total-Bytes'], String(total), 'the total size must be reported');
        assert.ok(/^bytes \d+-\d+\/\d+$/.test(dflt.headers['Content-Range']), 'the served range must be reported');

        // `offset` is a WINDOW start, not "from here to EOF" — otherwise
        // offset=0 hands renderMarkdown the entire multi-megabyte document.
        const windowed = await getLog(server, 'coder-1', 'offset=1&tail=2048', null);
        assert.ok(windowed.body.length < 4096,
            `offset+tail must bound the read, got ${windowed.body.length} bytes`);

        // A tail beyond the cap is clamped, not honoured.
        const greedy = await getLog(server, 'coder-1', `tail=${total * 10}`, null);
        assert.ok(greedy.body.length <= total + 64, 'a greedy tail must not read past the file');
    });

    await test('a ranged tail is fence-balanced so its markdown still renders', async () => {
        const logsDir = tmpLogsDir('tailfence');
        const wsRoot = path.join(logsDir, '..', '..');
        const w = new TerminalLogWriter(logsDir);
        w.onPrompt('coder-1', 'first dispatch');
        for (let i = 0; i < 4000; i++) { w.onFlush('coder-1', `body line ${i} ${'.'.repeat(40)}\n`); }
        // Deliberately NOT disposed: the live session's block is still open, which
        // is the state every real read hits.
        await settle();

        const server = buildServer(wsRoot, '');
        const res = await getLog(server, 'coder-1', 'tail=4096', null);
        assert.strictEqual(res.statusCode, 200);
        const leaked = outsideCodeBlocks(renderMarkdown(res.body));
        assert.ok(/body line \d+/.test(res.body), 'the tail must carry output');
        assert.ok(!/body line \d+/.test(leaked),
            'a tail that starts inside a code block and ends inside the live one must be balanced before it is served');
        w.dispose();
    });

    await test('normalizeLogSlice balances both ends of an arbitrary slice', () => {
        const whole = `# h\n\n${LOG_FENCE_OPEN}\na\nb\n${LOG_FENCE_CLOSE}\n`;
        assert.strictEqual(normalizeLogSlice(whole, false), whole, 'a balanced whole file is left alone');

        // Starts mid-block (first fence seen is a close) → an open is prepended.
        const midStart = normalizeLogSlice('half a line\nb\n' + LOG_FENCE_CLOSE + '\n', true);
        assert.ok(midStart.startsWith(LOG_FENCE_OPEN), 'a slice starting inside a block must be opened');
        assert.ok(!midStart.includes('half a line'), 'the partial first line must be dropped');

        // Ends mid-block (live session) → a close is appended.
        const liveTail = normalizeLogSlice(`x\n${LOG_FENCE_OPEN}\na\n`, false);
        assert.ok(liveTail.trimEnd().endsWith(LOG_FENCE_CLOSE), 'an unclosed trailing block must be closed');

        // No fence at all in a mid-file slice → assume inside a block and wrap it.
        const noFence = normalizeLogSlice('drop\nkeep one\nkeep two\n', true);
        assert.ok(noFence.startsWith(LOG_FENCE_OPEN) && noFence.trimEnd().endsWith(LOG_FENCE_CLOSE),
            'a fence-less mid-file slice must be wrapped, not served as prose');
    });

    await test('the session list endpoint enumerates every rolled session, newest first', async () => {
        const logsDir = tmpLogsDir('list');
        const wsRoot = path.join(logsDir, '..', '..');
        const w = new TerminalLogWriter(logsDir);
        w.onFlush('coder-1', 'one\n');
        await settle();
        w.onSessionBoundary('coder-1');
        w.onFlush('coder-1', 'two\n');
        w.dispose();
        await settle();

        const server = buildServer(wsRoot, 'tok');
        const res = fakeRes();
        await server._handleTerminalLogList(
            { url: '/terminals/coder-1/logs', method: 'GET', headers: { host: '127.0.0.1:1', authorization: 'Bearer tok' } },
            res, 'coder-1');
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.sessions.length, 2, 'both sessions must be listed');
        assert.ok(body.sessions[0].filename > body.sessions[1].filename, 'newest first');

        const anon = fakeRes();
        await server._handleTerminalLogList(
            { url: '/terminals/coder-1/logs', method: 'GET', headers: { host: '127.0.0.1:1' } }, anon, 'coder-1');
        assert.strictEqual(anon.statusCode, 401, 'the listing is a log surface too and must be auth-gated');
    });

    await test('a session query cannot read outside this terminal\'s own sessions', async () => {
        const logsDir = tmpLogsDir('traverse');
        const wsRoot = path.join(logsDir, '..', '..');
        const w = new TerminalLogWriter(logsDir);
        w.onFlush('mine', 'my output\n');
        w.onFlush('theirs', 'their output\n');
        w.dispose();
        await settle();
        fs.writeFileSync(path.join(logsDir, '..', 'secret.md'), 'NOT A LOG');

        const server = buildServer(wsRoot, '');
        const theirs = readSessions(logsDir, 'theirs')[0];
        const cross = await getLog(server, 'mine', `session=${encodeURIComponent(theirs)}`, null);
        assert.strictEqual(cross.statusCode, 404, 'another terminal\'s session file is not this terminal\'s log');
        const up = await getLog(server, 'mine', 'session=..%2Fsecret.md', null);
        assert.strictEqual(up.statusCode, 404, 'traversal out of the logs dir must not resolve');
        assert.ok(!String(up.body).includes('NOT A LOG'));
    });

    // ── Invariant: never committed ──────────────────────────────────────────
    await test('.switchboard/logs/ is gitignored and carries no un-ignore negation', () => {
        assert.ok(/^\.switchboard\/\*$/m.test(GITIGNORE), '.switchboard/* must still be the ignore glob');
        const negation = GITIGNORE.split('\n').find(l => /^\s*!\s*\.switchboard\/logs/.test(l));
        assert.strictEqual(negation, undefined,
            `a ! negation for logs/ would commit terminal output (and its secrets): ${negation}`);
        // The ignore RESULT alone would pass the day someone adds a negation, so
        // both are asserted. This half proves the result today.
        let ignored = true;
        try {
            execFileSync('git', ['check-ignore', '-q', '.switchboard/logs/coder-1-abc.md'], { cwd: REPO_ROOT });
        } catch { ignored = false; }
        assert.ok(ignored, 'git must report .switchboard/logs/*.md as ignored');
    });

    // ── Invariant: the live attach path is unchanged ────────────────────────
    await test('the ring cap and the replay path are untouched', () => {
        assert.match(GATEWAY_SRC, /MAX_SCROLLBACK_BYTES\s*=\s*256\s*\*\s*1024/,
            'this plan exists to remove the pressure to grow the ring, not to grow it');
        assert.match(GATEWAY_SRC, /OUTPUT_FLUSH_MS\s*=\s*6/, 'the flush window is unchanged');
        const flush = GATEWAY_SRC.match(/private flushOutput\([\s\S]*?\n    \}/);
        assert.ok(flush, 'flushOutput not found');
        const body = flush[0];
        const ringAt = body.indexOf('buffer.chunks.push');
        const fanoutAt = body.indexOf('this.safeSendBinary');
        const observerAt = body.indexOf('flushObservers');
        assert.ok(ringAt > 0 && fanoutAt > ringAt && observerAt > fanoutAt,
            'the tee must run AFTER the ring append and the client fan-out — the live path is never delayed by the log');
        assert.match(body, /try \{ observer\(terminalName, combined\)[\s\S]{0,60}catch/,
            'a throwing observer must not take the gateway down with it');
    });

    await test('the log write never runs on the flush caller\'s stack', async () => {
        const logsDir = tmpLogsDir('nonblock');
        const w = new TerminalLogWriter(logsDir);
        const realAppend = fs.appendFileSync;
        let inFlush = false;
        let synchronousWrites = 0;
        fs.appendFileSync = function (...args) {
            if (inFlush) { synchronousWrites++; }
            return realAppend.apply(fs, args);
        };
        try {
            inFlush = true;
            w.onFlush('coder-1', 'some output\n');
            w.onPrompt('coder-1', 'a prompt');
            w.onSessionBoundary('coder-1');
            inFlush = false;
            await settle();
        } finally {
            fs.appendFileSync = realAppend;
        }
        assert.strictEqual(synchronousWrites, 0,
            'a blocking write here stalls the shared flush interval — every terminal, not just this one');
        assert.ok(readSessions(logsDir, 'coder-1').length >= 1, 'the deferred writes must still land');
        w.dispose();
    });

    // ── Invariant: BOTH hosts get dispatch headings ─────────────────────────
    await test('sendPromptToPty — the SHARED delivery path — fires the heading hook', async () => {
        const logsDir = tmpLogsDir('shared');
        const w = new TerminalLogWriter(logsDir);
        const writes = [];
        const handle = { name: 'coder-1', role: 'coder', write: (c) => writes.push(c) };
        await sendPromptToPty(handle, 'Implement the ranged log endpoint', {
            clearBeforePrompt: false,
            onPromptDelivered: (name, text) => w.onPrompt(name, text),
        });
        w.dispose();
        await settle();

        const raw = fs.readFileSync(path.join(logsDir, readSessions(logsDir, 'coder-1')[0]), 'utf8');
        assert.match(raw, /^## \d{4}-\d{2}-\d{2}T[^\n]*Implement the ranged log endpoint/m,
            'the shared delivery function must emit the dispatch heading — this is the test that covers BOTH composition roots');
        assert.ok(writes.length > 0, 'delivery itself must still happen');
    });

    await test('the heading hook is INVOKED only in the shared ptyPromptDelivery path', () => {
        assert.match(DELIVERY_SRC, /opts\??\.\s*onPromptDelivered\(/,
            'sendPromptToPty must be the one place that fires the notification');
        for (const [label, src] of [['bootstrap.ts', BOOTSTRAP_SRC], ['ptyHost.ts', PTYHOST_SRC]]) {
            assert.ok(!/onPromptDelivered\s*\(/.test(src),
                `${label} must REGISTER the hook, never invoke it — an invocation in a host is the divergence the plan forbids`);
        }
    });

    await test('both composition roots wire the log writer', () => {
        for (const [label, src] of [['bootstrap.ts', BOOTSTRAP_SRC], ['ptyHost.ts', PTYHOST_SRC]]) {
            assert.match(src, /new TerminalLogWriter\(/, `${label} must construct the writer`);
            assert.match(src, /\.onFlush\(\(terminal, data\)/, `${label} must subscribe to the gateway's flush observer`);
            assert.match(src, /onPromptDelivered:/, `${label} must register the heading hook on sendPromptToPty`);
            assert.match(src, /'renamed'[\s\S]{0,200}onRename\(/, `${label} must re-key the writer on a fleet rename`);
            assert.match(src, /'closed'[\s\S]{0,200}onClose\(/, `${label} must close the writer's file on terminal close`);
        }
        // Session boundary: standalone owns the callback in-process; the extension
        // host's writer lives in the pty child, so the roll crosses the verb
        // boundary. Both routes must exist or one host silently never rolls.
        assert.match(BOOTSTRAP_SRC, /onTerminalContextCleared:[\s\S]{0,200}onSessionBoundary\(/,
            'standalone must roll the session when queue/done clears the seat');
        assert.match(PTYHOST_SRC, /case 'ptyRollLogSession'/, 'the pty child must answer the session-roll verb');
        assert.match(TASKVIEWER_SRC, /onTerminalContextCleared:[\s\S]{0,300}ptyRollLogSession/,
            'the extension host must forward the session roll to the pty child');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
