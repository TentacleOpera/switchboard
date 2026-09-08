'use strict';

/**
 * Contract tests for the tmux bridge transport layer (Part 1).
 *
 * Style mirrors the existing `pty-*-contract.test.js` files. All tests use a
 * mocked `run()` — no test requires a live tmux server, so CI stays green on
 * machines without tmux. One integration test at the end is guarded on
 * `isTmuxAvailable()` and skips cleanly when tmux is absent.
 *
 * The seven contract tests (Phase 3 of the plan):
 *   1. `isTmuxAvailable()` is the single derivation point — swallows every
 *      failure mode → false, never throws.
 *   2. No shell interpolation — no exec(, no execSync(, no shell: true.
 *   3. Pane-id validation — /^%\d+$/ enforced before any -t argument.
 *   4. `dispose()` never kills — no kill-pane on dispose; kill() does issue it.
 *   5. Delivery shape — bracketed-paste path uses -p and -d; buffer names
 *      unique; temp file unlinked even when paste-buffer throws.
 *   6. Newline flattening — no bracketedPaste → no \n in delivered text;
 *      bracketedPaste → newlines preserved via buffer route.
 *   7. Submit shape — exactly two unconditional Enter sends (no regex gate).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('./bootstrap/tsResolveHook').installTsResolveHook();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'tmuxBackend.ts');
const DELIVERY_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'tmuxPromptDelivery.ts');

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

(async function main() {
    console.log('\n── tmux backend contract ──');

    const backend = await import(path.join('file://', BACKEND_FILE));
    const delivery = await import(path.join('file://', DELIVERY_FILE));

    const {
        isTmuxAvailable,
        tmuxCaps,
        validatePaneId,
        listTmuxPanes,
        TmuxTerminalHandle,
        TmuxTerminalBackend,
        _setTmuxRunImpl,
        _resetTmuxCaps,
        _resetTmuxAvailability,
        TMUX_IDE_NAME,
    } = backend;
    const { sendPromptToTmux, clearTmuxPane } = delivery;

    // ─── Helper: create a mock run that records calls ────────────────────
    /**
     * Creates a mock run impl. `handler` receives (args, socket, input) and
     * returns a string or throws. All calls are recorded in `calls`.
     */
    function mockRun(handler) {
        const calls = [];
        const impl = async (args, socket, input) => {
            const record = { args: [...args], socket, input };
            calls.push(record);
            return handler(args, socket, input);
        };
        _setTmuxRunImpl(impl);
        return calls;
    }

    function restoreRun() {
        _setTmuxRunImpl(null);
    }

    // ─── Test 1: isTmuxAvailable swallows every failure mode ─────────────
    await test('isTmuxAvailable returns false (never throws) when binary is missing', async () => {
        _resetTmuxCaps();
        _resetTmuxAvailability();
        _setTmuxRunImpl(async () => { throw new Error('ENOENT: tmux not found'); });
        try {
            const result = await isTmuxAvailable();
            assert.strictEqual(result, false, 'missing binary must resolve false, not throw');
        } finally {
            restoreRun();
        }
    });

    await test('isTmuxAvailable returns false when server is down', async () => {
        _resetTmuxCaps();
        _resetTmuxAvailability();
        // Binary exists (-V succeeds) but no server (list-sessions throws).
        _setTmuxRunImpl(async (args) => {
            if (args[0] === '-V') { return 'tmux 3.4\n'; }
            if (args.includes('list-sessions')) { throw new Error('no server running'); }
            return '';
        });
        try {
            const result = await isTmuxAvailable();
            assert.strictEqual(result, false, 'no server must resolve false');
        } finally {
            restoreRun();
        }
    });

    await test('isTmuxAvailable returns true when binary and server are live', async () => {
        _resetTmuxCaps();
        _resetTmuxAvailability();
        _setTmuxRunImpl(async (args) => {
            if (args[0] === '-V') { return 'tmux 3.4\n'; }
            if (args.includes('list-sessions')) { return 'session1\n'; }
            return '';
        });
        try {
            const result = await isTmuxAvailable();
            assert.strictEqual(result, true, 'binary + server live must resolve true');
        } finally {
            restoreRun();
        }
    });

    // ─── Test 2: no shell interpolation ──────────────────────────────────
    await test('no shell interpolation in tmuxBackend.ts or tmuxPromptDelivery.ts', () => {
        for (const file of [BACKEND_FILE, DELIVERY_FILE]) {
            const src = fs.readFileSync(file, 'utf8');
            // Strip comments before scanning — the source DOCUMENTS the
            // prohibitions in doc comments (e.g. "no `shell: true`"), and a
            // guard that fails on its own documentation teaches the next
            // reader to delete the documentation. Same pattern as the PTY
            // framing test's CLI_AGENT_REGEX check.
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
            assert.ok(
                !/\bexec\s*\(/.test(code),
                `${path.basename(file)} must not use exec( — use execFile with argv`
            );
            assert.ok(
                !/\bexecSync\s*\(/.test(code),
                `${path.basename(file)} must not use execSync(`
            );
            assert.ok(
                !/shell\s*:\s*true/.test(code),
                `${path.basename(file)} must not use shell: true`
            );
        }
    });

    // ─── Test 3: pane-id validation ──────────────────────────────────────
    await test('validatePaneId rejects injection attempts', () => {
        assert.throws(
            () => validatePaneId('%1; kill-server'),
            /invalid tmux pane id/,
            '%1; kill-server must be rejected'
        );
        assert.throws(
            () => validatePaneId('session:0.1'),
            /invalid tmux pane id/,
            'session:0.1 must be rejected — only %N is valid'
        );
        assert.throws(
            () => validatePaneId(''),
            /invalid tmux pane id/,
            'empty string must be rejected'
        );
        assert.doesNotThrow(() => validatePaneId('%5'), '%5 is valid');
        assert.doesNotThrow(() => validatePaneId('%0'), '%0 is valid');
        assert.doesNotThrow(() => validatePaneId('%12345'), '%12345 is valid');
    });

    await test('TmuxTerminalHandle constructor rejects invalid pane ids', () => {
        assert.throws(
            () => new TmuxTerminalHandle('test', '%1; kill-server'),
            /invalid tmux pane id/,
            'handle must reject injection pane id'
        );
        assert.doesNotThrow(() => new TmuxTerminalHandle('test', '%7'));
    });

    // ─── Test 4: dispose() never kills ───────────────────────────────────
    await test('dispose() never issues kill-pane; kill() does', () => {
        const src = fs.readFileSync(BACKEND_FILE, 'utf8');
        // Extract the dispose() method body from TmuxTerminalHandle.
        const disposeMatch = src.match(/dispose\(\)\s*:\s*void\s*\{([^}]*)\}/);
        assert.ok(disposeMatch, 'could not locate dispose() method');
        const disposeBody = disposeMatch[1];
        assert.ok(
            !/kill-pane/.test(disposeBody),
            'dispose() must never issue kill-pane — Switchboard did not create the pane'
        );

        const killMatch = src.match(/kill\(\)\s*:\s*void\s*\{([^}]*)\}/);
        assert.ok(killMatch, 'could not locate kill() method');
        const killBody = killMatch[1];
        assert.ok(
            /kill-pane/.test(killBody),
            'kill() must issue kill-pane — it is the sole destructive path'
        );
    });

    // ─── Test 5: delivery shape (bracketed-paste buffer route) ───────────
    await test('bracketed-paste path uses -p and -d; buffer names unique', async () => {
        _resetTmuxCaps();
        const calls = mockRun(async (args) => {
            if (args[0] === '-V') { return 'tmux 3.4\n'; } // caps: all true
            return ''; // success for all commands
        });
        try {
            const handle = new TmuxTerminalHandle('coder-1', '%5');
            await sendPromptToTmux(handle, 'hello\nworld');

            // Find load-buffer and paste-buffer calls.
            const loadCalls = calls.filter(c => c.args.includes('load-buffer'));
            const pasteCalls = calls.filter(c => c.args.includes('paste-buffer'));
            assert.ok(loadCalls.length >= 1, 'bracketed-paste path must call load-buffer');
            assert.ok(pasteCalls.length >= 1, 'bracketed-paste path must call paste-buffer');

            // paste-buffer must use both -p and -d.
            const paste = pasteCalls[0];
            assert.ok(paste.args.includes('-p'), 'paste-buffer must request bracket codes with -p');
            assert.ok(paste.args.includes('-d'), 'paste-buffer must delete buffer with -d');

            // Buffer name must be in both load-buffer (-b) and paste-buffer (-b).
            const loadBufIdx = loadCalls[0].args.indexOf('-b');
            const pasteBufIdx = paste.args.indexOf('-b');
            assert.ok(loadBufIdx >= 0, 'load-buffer must use -b <name>');
            assert.ok(pasteBufIdx >= 0, 'paste-buffer must use -b <name>');
            const loadBufName = loadCalls[0].args[loadBufIdx + 1];
            const pasteBufName = paste.args[pasteBufIdx + 1];
            assert.strictEqual(loadBufName, pasteBufName, 'load and paste must use same buffer name');
            assert.ok(
                /^switchboard-\d+-\d+$/.test(loadBufName),
                `buffer name must be namespaced: ${loadBufName}`
            );
        } finally {
            restoreRun();
        }
    });

    await test('buffer names are unique across concurrent sends', async () => {
        _resetTmuxCaps();
        const calls = mockRun(async (args) => {
            if (args[0] === '-V') { return 'tmux 3.4\n'; }
            // Add a tiny delay so the two sends truly overlap.
            await new Promise(r => setTimeout(r, 5));
            return '';
        });
        try {
            const h1 = new TmuxTerminalHandle('coder-1', '%5');
            const h2 = new TmuxTerminalHandle('coder-2', '%6');
            await Promise.all([
                sendPromptToTmux(h1, 'prompt A'),
                sendPromptToTmux(h2, 'prompt B'),
            ]);

            const loadCalls = calls.filter(c => c.args.includes('load-buffer'));
            const bufNames = loadCalls.map(c => {
                const idx = c.args.indexOf('-b');
                return c.args[idx + 1];
            });
            const unique = new Set(bufNames);
            assert.strictEqual(
                unique.size, bufNames.length,
                `buffer names must be unique across concurrent sends: got ${JSON.stringify(bufNames)}`
            );
        } finally {
            restoreRun();
        }
    });

    await test('temp file is unlinked even when paste-buffer throws', async () => {
        _resetTmuxCaps();
        const calls = mockRun(async (args) => {
            if (args[0] === '-V') { return 'tmux 2.6\n'; } // stdinBuffer=false, bracketedPaste=true
            if (args.includes('paste-buffer')) {
                throw new Error('can\'t find pane: %5');
            }
            return '';
        });
        try {
            const handle = new TmuxTerminalHandle('coder-1', '%5');

            await assert.rejects(
                () => sendPromptToTmux(handle, 'secret prompt text'),
                /paste-buffer failed/,
                'paste-buffer failure must surface as a rejection'
            );

            // (a) The temp-file route was taken: load-buffer was called with a
            // file path argument (argv after -b <name>), NOT stdin "-". The
            // implementation uses `import * as fs from "fs"` (ESM namespace),
            // so monkey-patching the CJS fs object cannot observe the write —
            // observe via the mock run calls instead.
            const loadCalls = calls.filter(c => c.args.includes('load-buffer'));
            assert.ok(loadCalls.length >= 1, 'load-buffer must have been called');
            const loadCall = loadCalls[0];
            const bIdx = loadCall.args.indexOf('-b');
            const filePathArg = loadCall.args[bIdx + 2]; // after -b <bufName>
            assert.ok(
                filePathArg && filePathArg !== '-',
                `load-buffer must use a file path (not stdin "-"): got ${JSON.stringify(filePathArg)}`
            );
            assert.ok(
                /\.buf$/.test(filePathArg),
                `temp file path must end with .buf: ${filePathArg}`
            );

            // (b) The finally unlinked it: the file no longer exists on disk.
            assert.ok(
                !fs.existsSync(filePathArg),
                `temp file must be unlinked after paste-buffer throws: ${filePathArg}`
            );
        } finally {
            restoreRun();
        }
    });

    // ─── Test 6: newline flattening ──────────────────────────────────────
    await test('no bracketedPaste: newlines flattened to spaces in send-keys', async () => {
        _resetTmuxCaps();
        const calls = mockRun(async (args) => {
            if (args[0] === '-V') { return 'tmux 2.3\n'; } // bracketedPaste=false, hexKeys=false
            return '';
        });
        try {
            const handle = new TmuxTerminalHandle('coder-1', '%5');
            await sendPromptToTmux(handle, 'line one\nline two\nline three');

            const sendKeysCalls = calls.filter(
                c => c.args.includes('send-keys') && c.args.includes('-l')
            );
            assert.ok(sendKeysCalls.length > 0, 'fallback path must use send-keys -l');

            // No send-keys -l chunk may contain a newline.
            for (const c of sendKeysCalls) {
                const payload = c.args[c.args.indexOf('-l') + 1];
                assert.ok(
                    !/[\r\n]/.test(payload),
                    `flattened chunk must contain no newlines: ${JSON.stringify(payload)}`
                );
            }

            // The flattened text must contain spaces where newlines were.
            const allPayloads = sendKeysCalls.map(c => c.args[c.args.indexOf('-l') + 1]).join('');
            assert.ok(
                allPayloads.includes('line one line two line three'),
                `flattened text must join lines with spaces: ${JSON.stringify(allPayloads)}`
            );
        } finally {
            restoreRun();
        }
    });

    await test('bracketedPaste: newlines preserved via buffer route', async () => {
        _resetTmuxCaps();
        const calls = mockRun(async (args) => {
            if (args[0] === '-V') { return 'tmux 3.4\n'; } // all caps true
            return '';
        });
        try {
            const handle = new TmuxTerminalHandle('coder-1', '%5');
            const payload = 'line one\nline two\nline three';
            await sendPromptToTmux(handle, payload);

            // The buffer route must NOT use send-keys -l for the payload.
            const sendKeysPayload = calls.filter(
                c => c.args.includes('send-keys') && c.args.includes('-l') && !c.args.includes('/clear')
            );
            // With stdinBuffer=true (tmux 3.4), the payload goes via load-buffer stdin.
            const loadCalls = calls.filter(c => c.args.includes('load-buffer'));
            assert.ok(loadCalls.length >= 1, 'bracketed-paste path must use load-buffer');

            // The input to load-buffer must preserve newlines.
            const loadCall = loadCalls[0];
            assert.ok(
                loadCall.input && loadCall.input.includes('\n'),
                'buffer route must preserve newlines in the payload'
            );
        } finally {
            restoreRun();
        }
    });

    // ─── Test 7: submit shape — two unconditional Enters ─────────────────
    await test('exactly two unconditional Enter sends after delivery', async () => {
        _resetTmuxCaps();
        const calls = mockRun(async (args) => {
            if (args[0] === '-V') { return 'tmux 3.4\n'; }
            return '';
        });
        try {
            const handle = new TmuxTerminalHandle('coder-1', '%5');
            await sendPromptToTmux(handle, 'prompt text');

            // Count send-keys ... Enter calls (not /clear Enter).
            const enterCalls = calls.filter(
                c => c.args.includes('send-keys') && c.args.includes('Enter') && !c.args.includes('-l')
            );
            // Two: the submit Enter and the confirm Enter.
            assert.strictEqual(
                enterCalls.length, 2,
                `exactly 2 Enter sends (submit + confirm), got ${enterCalls.length}`
            );
        } finally {
            restoreRun();
        }
    });

    await test('no CLI_AGENT_REGEX or name/role gate in tmuxPromptDelivery.ts', () => {
        const src = fs.readFileSync(DELIVERY_FILE, 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/CLI_AGENT_REGEX/.test(code),
            'CLI_AGENT_REGEX must not appear in tmux delivery — confirm Enter is unconditional'
        );
        // No name/role test/match gate.
        assert.ok(
            !/handle\.(name|role)\s*\)?\s*\.(test|match)|\.test\(\s*handle\.(name|role)/.test(code),
            'delivery path must not branch on handle.name or handle.role'
        );
    });

    // ─── TMUX_IDE_NAME ───────────────────────────────────────────────────
    await test('TMUX_IDE_NAME is defined and matches the registry owner pattern', () => {
        assert.strictEqual(TMUX_IDE_NAME, 'switchboard-tmux');
    });

    // ─── Integration test (guarded on isTmuxAvailable) ───────────────────
    await test('integration: list panes on a live tmux server (skips if absent)', async () => {
        _resetTmuxCaps();
        _resetTmuxAvailability();
        restoreRun();
        const available = await isTmuxAvailable();
        if (!available) {
            console.log('     (skipped — tmux not available)');
            return;
        }
        const panes = await listTmuxPanes();
        // On a live server, listTmuxPanes returns an array (possibly empty).
        assert.ok(Array.isArray(panes), 'listTmuxPanes must return an array');
        for (const pane of panes) {
            assert.ok(/^%\d+$/.test(pane.paneId), `pane id must be %N: ${pane.paneId}`);
            assert.ok(typeof pane.friendlyName === 'string', 'friendlyName must be a string');
        }
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll tmux backend contract checks passed.\n');
})();
