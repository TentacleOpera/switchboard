'use strict';
/**
 * Contract: the browser Memo panel's copy/send round trip clears the panel and
 * says so.
 *
 * The regression this locks down: the memo file was emptied host-side while the
 * browser panel kept the text and said nothing, because the response body
 * carried no `type` for transport.js to route and memo.js had no clear logic.
 * The clipboard itself was never broken — the extension host writes it through
 * the clipboard seam — so this test asserts on the seam recorder, NOT on a
 * `prompt` field in the body (which is deliberately not returned: a second,
 * browser-side write would be redundant here and is rejected by WebKit after a
 * fetch() boundary).
 *
 * Run with: npm run compile-tests && npm run test:contract:memo-browser-clear
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JSDOM } = require('jsdom');

const {
    installPermissiveVscodeStub,
    createHeadlessTestSeams,
} = require('./helpers/verbEngineTestSeams');

// A RECORDING stub, not the strict booby trap: TaskViewerProvider's instance
// fields call vscode.window.createOutputChannel(), so the trap fires inside
// `new` before any arm runs. That unmigrated ctor is a known, separately-planned
// problem (see the NOT WIRED YET note in .github/workflows/integration-tests.yml).
// The acceptance signal is preserved per-arm below: `vscodeAccesses` is reset
// after construction and asserted empty across the verb call.
const vscodeStub = installPermissiveVscodeStub();

const { TaskViewerProvider } = require('../../out/services/TaskViewerProvider');
const { BroadcastHub } = require('../../out/services/broadcastHub');

// The ctor fires _startLocalApiServer(), which binds a real TCP port. This suite
// exercises the memo ARM and the broadcaster wiring, not server startup — so the
// one heavyweight constructor side effect is neutralised. Test isolation only:
// nothing under test lives inside it.
TaskViewerProvider.prototype._startLocalApiServer = async function () { /* no port binding in tests */ };

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

/**
 * A TaskViewerProvider wired for headless execution, matching
 * verb-engine-headless-seams.test.js:101-127. `plannerDispatches` records
 * dispatchCustomPromptToRole calls so the send path can be forced to fail
 * without a real terminal.
 */
function buildHeadlessTaskViewer(tmpRoot, seamOpts = {}) {
    // _getWorkspaceRoots() reads vscode.workspace.workspaceFolders DIRECTLY (not
    // via a seam), and every root validation flows through it — so the arm only
    // accepts an explicit `workspaceRoot` if it is listed here.
    vscodeStub.setWorkspaceFolders([tmpRoot]);
    const { seams, recorders } = createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts });
    const pushes = [];
    const fakeWebview = {
        postMessage: (msg) => { pushes.push(msg); return Promise.resolve(true); },
    };
    const provider = new TaskViewerProvider(
        { fsPath: path.join(tmpRoot, 'ext') },
        {
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
            // _initEventHandlers pushes disposables here — omit it and the ctor throws.
            subscriptions: [],
            extensionUri: { fsPath: path.join(__dirname, '..', '..') },
            secrets: null,
        },
        false
    );
    // The sanctioned registration path — the same one the standalone (`npx`) host
    // uses (TaskViewerProvider.initHeadlessVerbServing). It registers
    // `_messageListener` without mounting a webview.
    provider.initHeadlessVerbServing(seams, new BroadcastHub({ webview: fakeWebview, apiServer: null }));
    // Construction is done; from here on any vscode access belongs to the ARM.
    vscodeStub.reset();
    return { provider, seams, recorders, pushes };
}

/**
 * Boot `src/webview/memo.js` for REAL against the real `memo.html` body markup.
 *
 * Source-regex assertions on memo.js cannot see behaviour, and that blindness
 * shipped a data-loss bug: the post-click-typing guard was defeated by the
 * BROWSER's double delivery (one click → the WS fan-out copy of
 * `memoPromptResult` AND the HTTP response body re-dispatched by transport.js),
 * while every regex the suite asserted still matched. These subtests execute the
 * handler instead of reading it.
 */
function bootMemoPanel(initialRoot = '/tmp/ws-a') {
    const REPO_ROOT = path.join(__dirname, '..', '..');
    const memoJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'memo.js'), 'utf8');
    const memoHtml = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'memo.html'), 'utf8');
    // Real markup, minus the <script> tags the shim/loader inject at serve time.
    const bodyInner = memoHtml.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(
        `<!DOCTYPE html><html><body data-initial-workspace-root="${encodeURIComponent(initialRoot)}">${bodyInner}</body></html>`,
        { runScripts: 'outside-only' }
    );
    const { window } = dom;
    const posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
    window.eval(memoJs);
    const el = (id) => window.document.getElementById(id);
    return {
        window, posted,
        el,
        get value() { return el('memo-textarea').value; },
        status: () => el('memo-status'),
        // Typing goes through the real `input` listener, so _memoDirty tracks it.
        type: (v) => {
            const ta = el('memo-textarea');
            ta.value = v;
            ta.dispatchEvent(new window.Event('input', { bubbles: true }));
        },
        click: (id) => el(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
        deliver: (m) => window.dispatchEvent(new window.MessageEvent('message', { data: m })),
    };
}

const REPLY_COPY_CLEARED = {
    type: 'memoPromptResult', success: true, memoCleared: true, isError: false, action: 'copy',
    message: 'Prompt for 2 issue(s) copied to clipboard. Memo cleared.',
};
const REPLY_SEND_FAILED = {
    type: 'memoPromptResult', success: false, memoCleared: false, isError: true, action: 'send',
    message: 'Failed to send to planner. Prompt copied to clipboard. Memo preserved for retry.',
};
const REPLY_EMPTY = {
    type: 'memoPromptResult', success: true, memoCleared: false, message: 'No entries to process.',
};

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-memo-clear-'));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard'), { recursive: true });
    const memoPath = path.join(tmpRoot, '.switchboard', 'memo.md');

    console.log('\n=== Browser Memo panel: clear-on-copy/send + copy confirmation ===\n');

    await test('copy: body is ROUTABLE (has `type`), reports the clear, and empties the file', async () => {
        const { provider, recorders } = buildHeadlessTaskViewer(tmpRoot);
        fs.writeFileSync(memoPath, 'Bug: one\n\nBug: two', 'utf8');

        const result = await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one\n\nBug: two',
            action: 'copy',
            workspaceRoot: tmpRoot,
        });

        // THE assertion that maps to the report: without `type`, transport.js's
        // re-dispatch never reaches memo.js's switch and the panel never learns.
        assert.strictEqual(result.type, 'memoPromptResult', 'response body carries no `type` — transport.js cannot route it');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.memoCleared, true);
        assert.strictEqual(result.action, 'copy');
        assert.match(result.message, /copied to clipboard/i);
        assert.strictEqual(fs.readFileSync(memoPath, 'utf8'), '', 'memo file was not emptied');

        // The clipboard is written HOST-SIDE, through the seam.
        const lastCopy = recorders.clipboardWrites[recorders.clipboardWrites.length - 1];
        assert.ok(typeof lastCopy === 'string' && /### Issue 1/.test(lastCopy),
            'host-side clipboard seam was not written with the planner prompt');

        // ...and the prompt is NOT echoed back to the browser.
        assert.strictEqual(result.prompt, undefined,
            'response body echoes the prompt — triggers a redundant, WebKit-hostile browser clipboard write');

        // A2b acceptance signal (PRD contract #3), as a RATCHET rather than a
        // clean assertion. The memo arm itself is seam-routed, but two helpers it
        // calls are not yet: `_getWorkspaceRoots()` reads
        // `vscode.workspace.workspaceFolders` directly instead of the seam that
        // already exists for it (`seams.workspace.getWorkspaceRoots()`), and the
        // kanban-db path read goes through `vscode.workspace.getConfiguration`.
        // Both predate this feature, are provider-wide (every root validation
        // flows through them), and need their own migration plan — this list
        // records them so a NEW vscode reach fails here instead of shipping.
        const KNOWN_UNMIGRATED_VSCODE_READS = new Set([
            'workspace',
            'workspace.workspaceFolders',
            'workspace.getConfiguration',
        ]);
        const unexpected = [...new Set(vscodeStub.accesses)]
            .filter(a => !KNOWN_UNMIGRATED_VSCODE_READS.has(a));
        assert.deepStrictEqual(unexpected, [],
            `memoGeneratePrompt reached NEW vscode surface (not host-agnostic): ${unexpected.join(', ')}`);
    });

    await test('copy: the webview push is additive and carries the same clear flag', async () => {
        const { provider, pushes } = buildHeadlessTaskViewer(tmpRoot);
        fs.writeFileSync(memoPath, 'Bug: one', 'utf8');
        await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one', action: 'copy', workspaceRoot: tmpRoot,
        });
        const push = pushes.find(p => p.type === 'memoPromptResult');
        assert.ok(push, 'no memoPromptResult push');
        assert.strictEqual(push.memoCleared, true);
        assert.strictEqual(push.action, 'copy');
        assert.ok(pushes.some(p => p.type === 'memoContent' && p.content === ''),
            'no memoContent:"" push (the sidebar/two-surface clear path)');
    });

    await test('send failure PRESERVES the memo, sets isError, and returns `error` (PRD contract #4)', async () => {
        const { provider, recorders } = buildHeadlessTaskViewer(tmpRoot);
        fs.writeFileSync(memoPath, 'Bug: one', 'utf8');
        // No planner terminal is registered in the headless harness, so the
        // dispatch fails the way it does in the extension host with no planner.
        provider.dispatchCustomPromptToRole = async () => false;

        const failed_ = await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one', action: 'send', workspaceRoot: tmpRoot,
        });

        assert.strictEqual(failed_.memoCleared, false, 'a failed send discarded the memo');
        assert.strictEqual(failed_.isError, true);
        assert.strictEqual(failed_.success, false);
        assert.strictEqual(failed_.type, 'memoPromptResult');
        assert.strictEqual(failed_.action, 'send');
        assert.ok(typeof failed_.error === 'string' && failed_.error.length > 0,
            'failure body has no `error` — PRD contract #4, and transport.js would toast "Action failed: memoGeneratePrompt"');
        assert.strictEqual(failed_.error, failed_.message,
            'the toast and the panel status line must say the same thing');
        assert.notStrictEqual(fs.readFileSync(memoPath, 'utf8'), '', 'memo file was emptied on a failed send');
        // The failure message promises the prompt is on the clipboard — keep that true.
        assert.ok(recorders.clipboardWrites.some(w => /### Issue 1/.test(String(w))),
            'failure fallback did not copy the prompt for manual paste');
    });

    await test('send success clears and names the send action (so the SEND button flashes, not copy)', async () => {
        const { provider } = buildHeadlessTaskViewer(tmpRoot);
        fs.writeFileSync(memoPath, 'Bug: one\n\nBug: two', 'utf8');
        provider.dispatchCustomPromptToRole = async () => true;

        const ok = await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one\n\nBug: two', action: 'send', workspaceRoot: tmpRoot,
        });
        assert.strictEqual(ok.success, true);
        assert.strictEqual(ok.memoCleared, true);
        assert.strictEqual(ok.action, 'send');
        assert.match(ok.message, /to planner/i);
        assert.strictEqual(fs.readFileSync(memoPath, 'utf8'), '');
    });

    await test('empty memo is ROUTABLE, is not a failure, and is not a clear', async () => {
        const { provider } = buildHeadlessTaskViewer(tmpRoot);
        const empty = await provider.handleServiceVerb('memoGeneratePrompt', {
            content: '   ', action: 'copy', workspaceRoot: tmpRoot,
        });
        // Untyped → transport.js returns before dispatchMessage and the panel
        // never showed the message at all.
        assert.strictEqual(empty.type, 'memoPromptResult');
        assert.strictEqual(empty.memoCleared, false);
        // success:true, so no redundant toast over the panel's own status line.
        assert.strictEqual(empty.success, true);
    });

    await test('the unresolvable-workspace failure is ROUTABLE and carries `error` (PRD contract #4)', async () => {
        const { provider } = buildHeadlessTaskViewer(tmpRoot);
        // _resolveWorkspaceRoot() returns null only when there are NO roots at all,
        // which is what makes this branch reachable.
        vscodeStub.setWorkspaceFolders([]);
        const res = await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one', action: 'copy',
        });
        vscodeStub.setWorkspaceFolders([tmpRoot]);
        assert.strictEqual(res.success, false);
        assert.ok(typeof res.type === 'string' && res.type.length > 0,
            'untyped failure body — transport.js stops before dispatchMessage, so the panel never shows it');
        assert.ok(typeof res.error === 'string' && res.error.length > 0,
            'failure body has no `error` — transport.js would toast "Action failed: memoGeneratePrompt"');
        assert.strictEqual(res.error, res.message, 'the toast and the panel status must say the same thing');
    });

    await test('setApiServer BEFORE the hub exists still wires WS fan-out (sibling-provider parity)', async () => {
        // The regression: _initTaskViewerService() runs LAZILY on the first HTTP
        // verb, which is AFTER the API server started, so an optional-chained
        // setApiServer alone was a no-op and the hub was built with
        // apiServer:null — silently dropping EVERY TaskViewer push to browser/WS
        // clients. This is subtask 3's workspaceChanged prerequisite.
        vscodeStub.setWorkspaceFolders([tmpRoot]);
        const { seams } = createHeadlessTestSeams({ roots: [tmpRoot] });
        const provider = new TaskViewerProvider(
            { fsPath: path.join(tmpRoot, 'ext') },
            {
                globalState: { get: () => undefined, update: async () => {} },
                workspaceState: { get: () => undefined, update: async () => {} },
                subscriptions: [],
                extensionUri: { fsPath: path.join(__dirname, '..', '..') },
                secrets: null,
            },
            false
        );
        // Register the listener, then drop the hub: `_broadcaster === undefined`
        // with the API server already started IS the bug's shape (the hub is only
        // built later, lazily, on the first HTTP verb).
        provider.initHeadlessVerbServing(seams, new BroadcastHub({ webview: null, apiServer: null }));
        provider._broadcaster = undefined;
        vscodeStub.reset();
        assert.strictEqual(provider._broadcaster, undefined, 'harness precondition: no hub yet');

        const broadcasts = [];
        // Real signature is broadcastWs(verb, msg, surface) — broadcastHub.ts:90-91.
        const fakeApiServer = {
            broadcastWs: (verb, msg, surface) => { broadcasts.push({ verb, msg, surface }); },
        };
        provider.setApiServer(fakeApiServer);

        fs.writeFileSync(memoPath, 'persisted memo', 'utf8');
        // First HTTP verb → builds the hub → must adopt the stored server.
        await provider.handleServiceVerb('memoLoad', { workspaceRoot: tmpRoot });

        assert.ok(broadcasts.some(b => b.verb === 'memoContent'),
            'TaskViewer push did not reach the WS hub — broadcaster built with apiServer:null');
    });

    await test('memo.js clears on the flag, guards post-click typing, and gates the flash on memoCleared', async () => {
        const REPO_ROOT = path.join(__dirname, '..', '..');
        const memoJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'memo.js'), 'utf8');
        assert.match(memoJs, /msg\.memoCleared/, 'memo.js does not read memoCleared');
        assert.match(memoJs, /_submittedContent/, 'memo.js has no post-click-typing guard');
        // An already-empty textarea must count as satisfied: the memoContent:''
        // WS push and the typed body race, and a strict equality-only guard turns
        // two correct signals into a no-op.
        assert.match(memoJs, /textarea\.value === ''/,
            'the clear guard rejects an already-empty textarea — the two delivery paths cancel out');
        // The flash must not fire on the empty-memo no-op (nothing was copied).
        assert.match(memoJs, /!msg\.isError && msg\.memoCleared/,
            'the affirmation flash is not gated on memoCleared — it fires "Copied ✓" on the empty-memo no-op');

        // transport.js is NOT part of this change (no browser-side clipboard path).
        const transportJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'transport.js'), 'utf8');
        assert.ok(!/clipboardWriteFailed/.test(transportJs),
            'transport.js gained a clipboard-failure path this plan deliberately dropped');
    });

    // ── memo.js EXECUTED (not grepped) under the browser's double delivery ──

    await test('DOUBLE DELIVERY: post-click typing survives BOTH copies of the reply', async () => {
        // The bug this locks down: one click yields two deliveries of the same
        // memoPromptResult (WS fan-out + HTTP body). The first correctly declined
        // to clear because the user had kept typing — and then released the guard,
        // so the SECOND delivery took the `_submittedContent === null` branch and
        // discarded the text the first delivery had just protected. Subtask 2's
        // own manual step 14 is exactly this case.
        const p = bootMemoPanel();
        p.type('Bug: one\n\nBug: two');
        p.click('memo-copy-btn');
        p.type('Bug: one\n\nBug: two\n\nBug: THREE typed after the click');

        p.deliver(REPLY_COPY_CLEARED);
        assert.ok(p.value.includes('typed after the click'),
            'delivery 1 discarded text typed after the click');
        p.deliver(REPLY_COPY_CLEARED);
        assert.ok(p.value.includes('typed after the click'),
            'delivery 2 discarded text typed after the click — the guard was released too early');
    });

    await test('DOUBLE DELIVERY: text typed BETWEEN the two deliveries is not discarded', async () => {
        const p = bootMemoPanel();
        p.type('Bug: one');
        p.click('memo-copy-btn');
        p.deliver(REPLY_COPY_CLEARED);
        assert.strictEqual(p.value, '', 'delivery 1 did not clear the submitted batch');
        p.type('Bug: brand new, typed after the clear');
        p.deliver(REPLY_COPY_CLEARED);
        assert.ok(p.value.includes('brand new'),
            'delivery 2 discarded text typed after the clear');
    });

    await test('the ordinary copy round trip still clears and flashes the COPY button only', async () => {
        const p = bootMemoPanel();
        p.type('Bug: one\n\nBug: two');
        p.click('memo-copy-btn');
        assert.match(p.status().textContent, /Building prompt/, 'no in-flight status on click');
        p.deliver(REPLY_COPY_CLEARED);
        p.deliver(REPLY_COPY_CLEARED);
        assert.strictEqual(p.value, '', 'the textarea was not cleared');
        assert.match(p.status().textContent, /copied to clipboard/i);
        assert.ok(p.el('memo-copy-btn').textContent.includes('Copied'), 'Copy button did not flash');
        assert.ok(!p.el('memo-send-btn').textContent.includes('Sent'),
            'Send to Planner flashed for a copy the user never asked it to do');
    });

    await test('a successful send flashes SEND, never COPY (a send does not copy)', async () => {
        const p = bootMemoPanel();
        const sent = { ...REPLY_COPY_CLEARED, action: 'send', message: 'Sent 1 issue(s) to planner. Memo cleared.' };
        p.type('Bug: one');
        p.click('memo-send-btn');
        p.deliver(sent);
        p.deliver(sent);
        assert.strictEqual(p.value, '');
        assert.ok(p.el('memo-send-btn').textContent.includes('Sent'), 'Send button did not flash');
        assert.ok(!p.el('memo-copy-btn').textContent.includes('Copied'),
            'Copy Prompt flashed on a send — feedback on a control the user did not touch');
    });

    await test('a failed send preserves the memo, shows the error colour, and does not flash', async () => {
        const p = bootMemoPanel();
        p.type('Bug: one');
        p.click('memo-send-btn');
        p.deliver(REPLY_SEND_FAILED);
        p.deliver(REPLY_SEND_FAILED);
        assert.strictEqual(p.value, 'Bug: one', 'a failed send discarded the memo');
        assert.match(p.status().style.color, /accent-red/);
        assert.ok(!p.el('memo-send-btn').textContent.includes('Sent'), 'flashed success on a failed send');
    });

    await test('the empty-memo no-op does not flash "Copied ✓" (nothing was copied)', async () => {
        const p = bootMemoPanel();
        p.click('memo-copy-btn');
        p.deliver(REPLY_EMPTY);
        p.deliver(REPLY_EMPTY);
        assert.match(p.status().textContent, /No entries to process/);
        assert.ok(!p.el('memo-copy-btn').textContent.includes('Copied'),
            'the button announced "Copied ✓" while the status said nothing was processed');
    });

    await test('a FOREIGN clear applies when clean, but never discards unsaved local typing', async () => {
        // `_submittedContent === null` means this panel never submitted, so the
        // reply belongs to another surface (the sidebar pressed Copy). Trust it
        // only under the same dirty/focus guard the memoContent case uses.
        const clean = bootMemoPanel();
        clean.el('memo-textarea').value = 'text this panel never submitted';
        clean.deliver(REPLY_COPY_CLEARED);
        assert.strictEqual(clean.value, '', 'a foreign clear did not reach a clean panel');

        const dirty = bootMemoPanel();
        dirty.type('locally typed, not yet saved');
        dirty.deliver(REPLY_COPY_CLEARED);
        assert.strictEqual(dirty.value, 'locally typed, not yet saved',
            'a foreign clear discarded unsaved local typing');
    });

    await test('workspaceChanged relabels, clears, and re-issues memoLoad for the new root', async () => {
        const p = bootMemoPanel('/tmp/ws-a');
        assert.strictEqual(p.el('memo-workspace').textContent, 'ws-a', 'initial workspace label missing');
        p.type('ws-a memo text');
        p.deliver({ type: 'workspaceChanged', workspaceRoot: '/tmp/ws-b' });
        assert.strictEqual(p.value, '', 'the previous workspace\'s text survived the switch');
        assert.strictEqual(p.el('memo-workspace').textContent, 'ws-b', 'header did not follow the switch');
        const loads = p.posted.filter(m => m.type === 'memoLoad');
        assert.ok(loads.length >= 2 && loads[loads.length - 1].workspaceRoot === '/tmp/ws-b',
            'no memoLoad re-issued for the new root');
        // The pending debounced save for the OLD root must be gone, or it fires
        // against the NEW root and writes the previous workspace's text there.
        assert.ok(!p.posted.some(m => m.type === 'memoSave'),
            'a pending memoSave survived the workspace switch');
    });

    await test('standalone arm carries the same parity flags', async () => {
        const REPO_ROOT = path.join(__dirname, '..', '..');
        const bootstrap = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        // The standalone router uses `if (verb === '...')`, not a switch.
        const start = bootstrap.indexOf("if (verb === 'memoGeneratePrompt')");
        assert.ok(start !== -1, 'standalone memoGeneratePrompt arm not found');
        const rest = bootstrap.slice(start);
        const next = rest.indexOf("if (verb === '", 10);
        const armBody = next === -1 ? rest.slice(0, 4000) : rest.slice(0, next);
        assert.match(armBody, /memoCleared:\s*true/, 'standalone success return has no memoCleared');
        assert.match(armBody, /memoCleared:\s*false/, 'standalone empty-memo return has no memoCleared');
        assert.match(armBody, /action:\s*'copy'/, 'standalone return has no action');
        // This host has NO VS Code clipboard, so it MUST keep returning prompt.
        assert.match(armBody, /\bprompt,/, 'standalone dropped `prompt` — it is the only clipboard writer there');
    });

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed === 0) console.log('memo-browser-clear-and-copy-contract: OK');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
