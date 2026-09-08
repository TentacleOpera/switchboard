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
        run,
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

    // ─── Regression: execFile has no `input` option ──────────────────────
    // Every other test in this file mocks `run()`, so the real invocation layer
    // was never exercised: `options.input` was set and silently ignored, and
    // because execFile still opens a stdin pipe and never ends it, `tmux
    // load-buffer -` blocked on a read that never saw EOF. On tmux >= 3.2 that
    // is the path EVERY prompt delivery takes, and the per-pane lock was held
    // forever. Nothing about it is visible to tsc, lint, or a mocked run().
    await test('defaultRunImpl writes stdin explicitly (execFile has no `input` option)', () => {
        const src = fs.readFileSync(BACKEND_FILE, 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/options\.input\s*=/.test(code),
            'execFile ignores an `input` option — it belongs to execFileSync/spawnSync'
        );
        assert.ok(
            /\.stdin/.test(code) && /stdin\.end\(/.test(code),
            'a command taking stdin must write to child.stdin and END it, or tmux blocks on EOF forever'
        );
    });

    await test('integration: load-buffer over stdin round-trips (skips if tmux absent)', async () => {
        _resetTmuxCaps();
        _resetTmuxAvailability();
        restoreRun();
        if (!(await isTmuxAvailable())) {
            console.log('     (skipped — tmux not available)');
            return;
        }
        const caps = await tmuxCaps();
        if (!caps.stdinBuffer) {
            console.log('     (skipped — tmux < 3.2, no stdin buffer route)');
            return;
        }
        const bufName = `switchboard-test-${process.pid}`;
        const payload = 'line one\nline two\n';
        // This is the call that hung: run() with an `input` argument. A 10s
        // guard turns a regression into a failure instead of a stalled suite.
        const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('load-buffer over stdin HUNG — stdin was never closed')), 10000).unref());
        await Promise.race([run(['load-buffer', '-b', bufName, '-'], undefined, payload), guard]);
        const back = await run(['show-buffer', '-b', bufName]);
        assert.strictEqual(back, payload, 'the buffer must contain exactly what was written to stdin');
        await run(['delete-buffer', '-b', bufName]);
    });

    // ─── Regression: reconcile is not a purge ────────────────────────────
    // `reconcile()` walked only the in-memory map. At boot that map is empty, so
    // the pass kept nothing, dropped nothing, and then WROTE a registry with no
    // tmux rows at all — deleting every persisted adoption on every restart.
    // Adoption is persisted precisely so a pane survives a restart.
    const fleetMod = await import(path.join('file://', path.join(REPO_ROOT, 'src', 'standalone', 'tmuxFleetService.ts')));
    const { TmuxFleetService, TMUX_OWNER_SEAT } = fleetMod;

    function makeFakeDb(initial) {
        const store = { 'runtime.terminals': initial };
        return {
            getConfigJsonSync: (k, d) => (k in store ? store[k] : d),
            getConfigJson: async (k, d) => (k in store ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; return true; },
            _read: () => store['runtime.terminals'],
        };
    }

    await test('reconcile() re-adopts persisted rows instead of purging them', async () => {
        mockRun(args => {
            if (args[0] === 'list-panes') {
                // %1 is still alive; %2 died while Switchboard was down.
                return ['%1', 'work', '1', 'win', '0', 'coder-1', 'claude', '/tmp/wt', '4242'].join('\x1f') + '\n';
            }
            return '';
        });
        try {
            const db = makeFakeDb({
                'coder-1': { friendlyName: 'coder-1', role: 'coder', status: 'active', paneId: '%1', ideName: TMUX_IDE_NAME, purpose: 'tmux', sessionName: 'work' },
                'coder-2': { friendlyName: 'coder-2', role: 'coder', status: 'active', paneId: '%2', ideName: TMUX_IDE_NAME, purpose: 'tmux', sessionName: 'work' },
                'pty-seat': { friendlyName: 'pty-seat', ideName: 'switchboard-pty', purpose: 'pty' },
            });
            const fleet = new TmuxFleetService('/tmp/ws', db, new TmuxTerminalBackend());
            const res = await fleet.reconcile();
            assert.strictEqual(res.kept, 1, 'the live persisted pane must be kept, not silently dropped');
            assert.strictEqual(res.dropped, 1, 'the dead persisted pane must be dropped');
            assert.deepStrictEqual(
                fleet.listActive().map(p => p.paneId),
                ['%1'],
                'a restart must re-adopt a surviving pane without the operator re-adopting it'
            );
            const written = db._read();
            assert.ok(written['coder-1'], 'the live adoption must survive the boot reconcile');
            assert.ok(!written['coder-2'], 'the dead adoption must be dropped');
            assert.ok(written['pty-seat'], 'non-tmux rows must never be touched');
        } finally {
            restoreRun();
        }
    });

    await test('adopted rows persist sessionName — the field the liveness poll reads', async () => {
        mockRun(args => {
            if (args[0] === 'list-panes') {
                return ['%7', 'mysession', '1', 'win', '0', 'coder-9', 'claude', '/tmp/wt', '99'].join('\x1f') + '\n';
            }
            return '';
        });
        try {
            const db = makeFakeDb({});
            const fleet = new TmuxFleetService('/tmp/ws', db, new TmuxTerminalBackend());
            await fleet.adopt('%7', 'coder');
            await new Promise(r => setImmediate(r));
            const row = db._read()['coder-9'];
            assert.ok(row, 'the adopted pane must be registered');
            // startTmuxReconcilePoll marks a row dead when its sessionName is not
            // in the live session set. `undefined` is never in that Set, so an
            // omitted field marked every live adopted pane exited on tick one.
            assert.strictEqual(row.sessionName, 'mysession', 'sessionName must be persisted, not just held in memory');
        } finally {
            restoreRun();
        }
    });

    await test('the two tmux registry writers do not clobber each other', async () => {
        // `ideName: 'switchboard-tmux'` is written by BOTH the adoption fleet and
        // tmuxTeamSeating.updateTmuxRegistryState. Both merge as "replace my rows,
        // preserve the rest", so without a second discriminator each write deleted
        // the other's rows. `tmuxOwner` is that discriminator.
        //
        // The adoption half runs behaviourally. The seating half is asserted at the
        // source: tmuxTeamSeating cannot be imported here (a transitive dependency
        // uses a TS parameter property, unsupported by the strip-only loader).
        mockRun(args => {
            if (args[0] === 'list-panes') {
                return ['%1', 'work', '1', 'win', '0', 'coder-1', 'claude', '/tmp/wt', '11'].join('\x1f') + '\n';
            }
            return '';
        });
        try {
            const db = makeFakeDb({
                // A row as the team-seating writer leaves it.
                'lead-1': {
                    friendlyName: 'lead-1', role: 'lead', status: 'active', paneId: '%50',
                    sessionName: 'sb-team', ideName: TMUX_IDE_NAME, purpose: 'tmux',
                    tmuxOwner: TMUX_OWNER_SEAT,
                },
                'pty-seat': { friendlyName: 'pty-seat', ideName: 'switchboard-pty', purpose: 'pty' },
            });
            const fleet = new TmuxFleetService('/tmp/ws', db, new TmuxTerminalBackend());
            await fleet.adopt('%1', 'coder');
            await new Promise(r => setImmediate(r));
            const written = db._read();
            assert.ok(written['lead-1'], 'an adoption write must not delete team-seated rows');
            assert.ok(written['coder-1'], 'the adopted pane must be registered');
            assert.ok(written['pty-seat'], 'non-tmux rows must never be touched');
        } finally {
            restoreRun();
        }

        const seatingSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'tmuxTeamSeating.ts'), 'utf8');
        const seatingCode = seatingSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(
            /tmuxOwner:\s*TMUX_OWNER_SEAT/.test(seatingCode),
            'the seating writer must tag its rows tmuxOwner: seat'
        );
        assert.ok(
            /e\.tmuxOwner\s*===\s*TMUX_OWNER_SEAT/.test(seatingCode),
            'the seating writer must claim ONLY seat rows, or it deletes every adopted pane'
        );
    });

    await test('delegate panes split on a pane id, never on <session>:0', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'tmuxTeamSeating.ts'), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        // `base-index` is a user setting and is commonly 1, so `<session>:0`
        // resolves to nothing and every delegate split fails — which the
        // partial-failure arm escalates into killing the whole session.
        assert.ok(
            !/split-window[\s\S]{0,200}\$\{sessionName\}:0/.test(code),
            'split-window must target the head pane id, not a base-index-dependent window index'
        );
        assert.ok(
            /'split-window',\s*'-t',\s*headPaneId/.test(code),
            'split-window must target headPaneId'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll tmux backend contract checks passed.\n');
})();
