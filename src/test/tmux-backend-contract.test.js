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
        listTmuxSessions,
        buildTmuxGrid,
        validateTmuxSessionName,
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
        // `ideName: 'switchboard-tmux'` was written by BOTH the adoption fleet and
        // the (now-deleted) tmuxTeamSeating.updateTmuxRegistryState. Both merged as
        // "replace my rows, preserve the rest", so without a second discriminator
        // each write deleted the other's rows. `tmuxOwner` is that discriminator.
        //
        // The seating writer is gone (see the plan "tmux Belongs in the Go Host"),
        // but the adoption fleet still carries the discriminator and must not
        // clobber a seat-tagged row left in the registry by a pre-upgrade install.
        // The adoption half runs behaviourally; the seat row is pre-seeded here.
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
    });

    // ─── tmux session list + grid builder (the tmux tab's backend) ───────
    // MEASURED on tmux 3.4: tmux vis-escapes the 0x1f field separator we ask
    // for and writes it back as the four literal characters `\037`. A bare
    // `split('\x1f')` therefore finds ONE field per line, every pane is
    // dropped, and listTmuxPanes/listTmuxSessions return [] against a real
    // server while every mock that feeds raw 0x1f stays green. The fixtures
    // below deliberately use the ESCAPED form — that is what tmux emits.
    const ESC = '\\037';
    const paneLine = (session, win, name, group) =>
        ['%1', session, '1', win, '0', name, 'sleep', '/tmp', '123', group].join(ESC);

    await test('listTmuxPanes parses the escaped \\037 separator tmux actually emits', async () => {
        mockRun(async () => [
            paneLine('lc-coding-team', 'lead', 'lead', 'lc-coding-team'),
        ].join('\n') + '\n');
        try {
            const panes = await listTmuxPanes();
            assert.strictEqual(panes.length, 1, 'the escaped separator must still parse');
            assert.strictEqual(panes[0].sessionName, 'lc-coding-team');
            assert.strictEqual(panes[0].sessionGroup, 'lc-coding-team');
        } finally {
            restoreRun();
        }
    });

    await test('listTmuxSessions groups by session_group, flags the base, and lists only lc- groups', async () => {
        mockRun(async () => [
            paneLine('lc-coding-team', 'lead', 'lead', 'lc-coding-team'),
            paneLine('lc-coding-team', 'coder-1', 'coder-1', 'lc-coding-team'),
            paneLine('lc-coding-team-lead', 'lead', 'lead', 'lc-coding-team'),
            paneLine('lc-coding-team-coder-1', 'coder-1', 'coder-1', 'lc-coding-team'),
            // The operator's own session must never be published by the board.
            paneLine('my-own-work', 'shell', 'shell', ''),
        ].join('\n') + '\n');
        try {
            const teams = await listTmuxSessions();
            assert.strictEqual(teams.length, 1, 'only lc- groups are the board\'s to list');
            assert.strictEqual(teams[0].group, 'lc-coding-team');
            assert.strictEqual(teams[0].baseSession, 'lc-coding-team',
                'the base is the member whose session_name equals its session_group');
            assert.deepStrictEqual(teams[0].windows.sort(), ['coder-1', 'lead'],
                'windows come from the BASE session only, never the per-seat views');
            assert.strictEqual(teams[0].members.length, 3);
        } finally {
            restoreRun();
        }
    });

    await test('listTmuxSessions leaves baseSession empty when no member matches the group', async () => {
        mockRun(async () => [
            paneLine('lc-old-team-lead', 'lead', 'lead', 'lc-old-team'),
        ].join('\n') + '\n');
        try {
            const teams = await listTmuxSessions();
            assert.strictEqual(teams.length, 1);
            assert.strictEqual(teams[0].baseSession, '',
                'a session predating grouping must report no base, never guess a seat');
        } finally {
            restoreRun();
        }
    });

    await test('buildTmuxGrid is idempotent: an existing grid window is killed, never duplicated', async () => {
        const calls = mockRun(async (args) => {
            if (args[0] === 'list-windows') { return 'lead\ncoder-1\ngrid\n'; }
            if (args[0] === 'list-panes') {
                return [
                    paneLine('lc-coding-team', 'lead', 'lead', 'lc-coding-team'),
                    paneLine('lc-coding-team-lead', 'lead', 'lead', 'lc-coding-team'),
                    paneLine('lc-coding-team-coder-1', 'coder-1', 'coder-1', 'lc-coding-team'),
                ].join('\n') + '\n';
            }
            return '';
        });
        try {
            const cmd = await buildTmuxGrid('lc-coding-team');
            assert.strictEqual(cmd, 'tmux attach -t lc-coding-team:grid');
            const verbs = calls.map(c => c.args[0]);
            assert.ok(verbs.includes('kill-window'),
                'an existing grid window must be killed first — tmux permits duplicate window names');
            assert.strictEqual(verbs.filter(v => v === 'new-window').length, 1);
            assert.ok(verbs.includes('select-layout'));
            assert.ok(!verbs.includes('attach'),
                'the board can never attach — the attach string is returned for the human');
            // TMUX= is load-bearing: tmux refuses to attach from inside itself.
            const newWin = calls.find(c => c.args[0] === 'new-window');
            assert.ok(/^TMUX= tmux attach -t /.test(newWin.args[newWin.args.length - 1]),
                'the pane command must clear TMUX before nest-attaching');
        } finally {
            restoreRun();
        }
    });

    await test('buildTmuxGrid refuses a team name outside the deriveTmuxSessionName charset', async () => {
        for (const bad of ['lc-a; kill-server', '-L/tmp/evil', 'coding-team', 'lc-Team', '']) {
            assert.throws(() => validateTmuxSessionName(bad), /invalid tmux session name/,
                `'${bad}' reaches tmux argv and must be rejected`);
        }
        validateTmuxSessionName('lc-coding-team');
    });

    // ─── tmux-seat-reuse: re-seating reuses the window, does not stack ─────
    // (tmux-windows-duplicate-on-re-seat plan, change 1)
    //
    // The seating command is built inside GoPtyFleetProjection.create() and
    // passed to the Go host as `startupCommand` in the ptyCreateTerminal
    // payload. Source-text inspection pins its shape without instantiating
    // the projection (which needs a live supervisor + db).
    const PROJECTION_PATH = path.join(REPO_ROOT, 'src', 'services', 'goPtyFleetProjection.ts');
    const projectionSource = fs.readFileSync(PROJECTION_PATH, 'utf8');
    const BOOTSTRAP_PATH = path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts');
    const bootstrapSource = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const GO_HOST_PATH = path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'main.go');
    const goHostSource = fs.readFileSync(GO_HOST_PATH, 'utf8');

    await test('tmux-seat-reuse: seating command uses if/elif/else, not &&/|| chain', async () => {
        // The old `has-session && new-window || new-session` chain falls
        // through to new-session when new-window fails (shell `A && B || C`
        // runs C when B fails). The fix is an explicit if/elif/else.
        assert.ok(/\bif\s+!\s*tmux has-session/.test(projectionSource),
            'seating must branch on `if ! tmux has-session`');
        assert.ok(/\belif\s+!\s*tmux list-windows/.test(projectionSource),
            'seating must `elif` on the window-name test');
        assert.ok(/grep -Fxq -- "\$\{win\}"/.test(projectionSource),
            'window name test must be `grep -Fxq -- "${win}"` (fixed-string, exact-line, quiet, end-of-options)');
    });

    await test('tmux-seat-reuse: existing window → no new-window in the command', async () => {
        // The three-branch decision: no session → new-session; session but no
        // window → new-window; session AND window → reuse (no new-window, no
        // new-session). The `elif` branch is the new-window branch; the `if`
        // branch is the new-session branch. There is NO third tmux creation
        // command — the `fi` ends the branch, and the reuse case is the
        // implicit else.
        const seatingBlock = projectionSource.match(/effectiveStartupCommand\s*=\s*[\s\S]*?exec tmux -u -CC attach/);
        assert.ok(seatingBlock, 'seating command block must end with `exec tmux -u -CC attach`');
        const block = seatingBlock[0];
        // The block must contain exactly one `new-session` (the if-branch) and
        // exactly one `new-window` (the elif-branch). The reuse case (else) is
        // implicit — neither runs.
        assert.strictEqual((block.match(/tmux new-session/g) || []).length, 1,
            'exactly one `tmux new-session` (the no-session branch)');
        assert.strictEqual((block.match(/tmux new-window/g) || []).length, 1,
            'exactly one `tmux new-window` (the no-window branch)');
    });

    await test('tmux-seat-reuse: name test uses fixed-string whole-line grep with --', async () => {
        // `grep -Fxq -- "${win}"`: -F (fixed-string, so `Coding` does not match
        // `Coding-coder-1` via regex), -x (whole-line, so `Coding` does not
        // match `Coding-coder-1` as a substring), -q (quiet), -- (end-of-
        // options, so a window name beginning with `-` is not read as a flag).
        assert.ok(/grep -Fxq -- "\$\{win\}"/.test(projectionSource),
            'must use `grep -Fxq -- "${win}"` — fixed-string, whole-line, quiet, end-of-options');
        // Must NOT use the old bare `grep -Fqx ${win}` (no --, no quotes).
        assert.ok(!/grep -Fqx \$\{win\}[^"']/.test(projectionSource),
            'must not use the old bare `grep -Fqx ${win}` without `--` and quotes');
    });

    await test('tmux-seat-reuse: flock serializes the test-and-create', async () => {
        // Two concurrent starts of the same team cannot both find no session
        // and both new-session. flock on a per-session lockfile prevents the
        // race; a race-created duplicate does not collapse on re-seat.
        assert.ok(/flock 9/.test(projectionSource),
            'seating must hold a per-session flock during test-and-create');
        assert.ok(/flock -u 9/.test(projectionSource),
            'seating must release the flock before `exec tmux` so the client never holds it');
    });

    // ─── tmux-solo-seat-single-session: solo seat uses one session ────────
    // (tmux-windows-duplicate-on-re-seat plan, change 6)
    await test('tmux-solo-seat-single-session: solo seat sets view = session, skips view creation', async () => {
        // A solo seat (no `tmuxSession` opts) has `view === session` and skips
        // the `new-session -t ${session} -s ${view}` view-creation line. A
        // team member gets a separate view session.
        assert.ok(/isSoloSeat\s*=\s*!opts\?\.tmuxSession/.test(projectionSource),
            'solo seat is derived from `!opts?.tmuxSession`');
        assert.ok(/view\s*=\s*isSoloSeat\s*\?\s*session\s*:/.test(projectionSource),
            'solo seat sets `view = session`; team member sets `view = ${session}-${suffix}`');
        // The view-creation line must be conditional on `!isSoloSeat`.
        assert.ok(/isSoloSeat\s*\?\s*''\s*:/.test(projectionSource),
            'view-creation line must be skipped (`\'\'`) for a solo seat');
    });

    // ─── tmux-team-start-idempotent: starting twice produces four windows ──
    // (tmux-windows-duplicate-on-re-seat plan, change 5)
    await test('tmux-team-start-idempotent: seating is idempotent (no unconditional new-window)', async () => {
        // The old code unconditionally ran `new-window` when `has-session` was
        // true, stacking a duplicate on every re-seat. The fix gates
        // `new-window` behind the `elif` (window-name test fails), so a re-seat
        // of an existing window hits the implicit else and creates nothing.
        // This is what makes `tmux list-windows -t lc-<team> | wc -l` stay at
        // the roster size across two starts.
        const seatingBlock = projectionSource.match(/effectiveStartupCommand\s*=\s*[\s\S]*?exec tmux -u -CC attach/);
        assert.ok(seatingBlock, 'seating command block found');
        const block = seatingBlock[0];
        // `new-window` must be inside the `elif` branch, not at the top level
        // of the command. The `elif` gate is the window-name test.
        const elifIdx = block.indexOf('elif');
        const newWindowIdx = block.indexOf('tmux new-window');
        assert.ok(elifIdx >= 0 && newWindowIdx > elifIdx,
            '`new-window` must be inside the `elif` (window-missing) branch, not unconditional');
        // There must be no `new-window` before the `if` — the old chain had
        // `new-window` right after `has-session &&`.
        const ifIdx = block.indexOf('if !');
        const newWindowBeforeIf = block.slice(0, ifIdx).indexOf('new-window');
        assert.strictEqual(newWindowBeforeIf, -1,
            'no `new-window` before the `if` branch — the old unconditional new-window is gone');
    });

    // ─── operator-close kills window; natural exit preserves it ───────────
    // (tmux-windows-duplicate-on-re-seat plan, change 2)
    await test('operator-close kills the tmux window: Go host fleet.close() issues kill-window', async () => {
        // fleet.close() must kill the seat's window in the base session,
        // ending the agent. The `=` prefix forces exact session match.
        assert.ok(/tmux.*kill-window.*-t.*=\$\{?t\.tmuxSession/.test(goHostSource) ||
                  /exec\.Command\("tmux",\s*"kill-window",\s*"-t",\s*"="\s*\+\s*t\.tmuxSession/.test(goHostSource),
            'fleet.close() must issue `tmux kill-window -t =<session>:<window>`');
        assert.ok(/t\.controlMode\s*&&\s*t\.tmuxSession\s*!=\s*""\s*&&\s*t\.tmuxWindow\s*!=\s*""/.test(goHostSource),
            'kill-window must be gated on controlMode && tmuxSession != "" && tmuxWindow != ""');
    });

    await test('operator-close kills the view session too: Go host fleet.close() issues kill-session for the view', async () => {
        assert.ok(/exec\.Command\("tmux",\s*"kill-session",\s*"-t",\s*"="\s*\+\s*t\.tmuxViewSession/.test(goHostSource),
            'fleet.close() must issue `tmux kill-session -t =<view>` for the per-seat view');
    });

    await test('natural PTY exit does NOT call fleet.close(): readOutput() returns without close()', async () => {
        // Crash survival: a natural PTY exit (agent died) must NOT tear down
        // the tmux window — the window survives so the operator can re-seat.
        // readOutput() marks status='exited', closes clients, logs, returns.
        // It must not call f.close(name).
        const readOutputBlock = goHostSource.match(/func \(f \*fleet\) readOutput\([\s\S]*?\n\}/);
        assert.ok(readOutputBlock, 'readOutput() found');
        const block = readOutputBlock[0];
        assert.ok(!/f\.close\(/.test(block),
            'readOutput() must NOT call f.close() — natural exit preserves the tmux window');
        assert.ok(/status\s*=\s*"exited"/.test(block) || /status:\s*"exited"/.test(block),
            'readOutput() must mark the terminal status exited');
    });

    await test('ptyCreateTerminal payload carries tmuxSession, tmuxWindow, tmuxViewSession', async () => {
        // The Go host reads these from the payload at create time. Without
        // them, fleet.close() has no target and cannot kill the window/view.
        assert.ok(/tmuxViewSession:\s*view/.test(projectionSource),
            'payload must include `tmuxViewSession: view`');
        assert.ok(/tmuxSession:\s*tmuxSessionName/.test(projectionSource),
            'payload must include `tmuxSession: tmuxSessionName`');
        assert.ok(/tmuxWindow:\s*tmuxWindowName/.test(projectionSource),
            'payload must include `tmuxWindow: tmuxWindowName`');
    });

    await test('Go terminal struct stores tmuxSession, tmuxWindow, tmuxViewSession', async () => {
        assert.ok(/tmuxViewSession\s+string/.test(goHostSource),
            'terminal struct must have `tmuxViewSession string`');
        assert.ok(/tmuxSession\s+string/.test(goHostSource),
            'terminal struct must have `tmuxSession string`');
        assert.ok(/tmuxWindow\s+string/.test(goHostSource),
            'terminal struct must have `tmuxWindow string`');
    });

    // ─── startup orphan reaper ────────────────────────────────────────────
    // (tmux-windows-duplicate-on-re-seat plan, change 3)
    await test('startup reaper runs after reconcile and reads runtime.terminals from db', async () => {
        // The reaper must run after tmuxFleetService.reconcile() (so dead
        // panes are marked exited) and must read the persisted registry from
        // db — NOT the in-memory fleet cache, which is empty at boot.
        const reaperIdx = bootstrapSource.indexOf('tmux-reaper');
        assert.ok(reaperIdx >= 0, 'bootstrap must contain a tmux-reaper block');
        const reconcileIdx = bootstrapSource.indexOf('tmuxFleetService.reconcile()');
        assert.ok(reconcileIdx >= 0, 'bootstrap must call tmuxFleetService.reconcile()');
        assert.ok(reaperIdx > reconcileIdx,
            'reaper must run AFTER reconcile so dead panes are marked exited first');
        // Must read from db.getConfigJsonSync('runtime.terminals'), not from
        // the in-memory cache.
        const reaperBlock = bootstrapSource.slice(reaperIdx - 200, reaperIdx + 1500);
        assert.ok(/getConfigJsonSync.*runtime\.terminals/.test(reaperBlock),
            'reaper must read `runtime.terminals` from db (persisted registry), not in-memory cache');
    });

    await test('startup reaper ownership rule: ideName === PTY_IDE_NAME && status !== exited && tmuxSession present', async () => {
        const reaperIdx = bootstrapSource.indexOf('tmux-reaper');
        const reaperBlock = bootstrapSource.slice(reaperIdx - 200, reaperIdx + 2000);
        assert.ok(/PTY_IDE_NAME/.test(reaperBlock),
            'reaper must filter registry rows by `ideName === PTY_IDE_NAME`');
        assert.ok(/status\s*===\s*['"]exited['"]/.test(reaperBlock),
            'reaper must skip rows with `status === "exited"`');
        assert.ok(/entry\.tmuxSession/.test(reaperBlock),
            'reaper must read `entry.tmuxSession` as the ownership signal');
    });

    await test('startup reaper kills lc-* sessions not in owned set, passes tmuxSocket', async () => {
        const reaperIdx = bootstrapSource.indexOf('tmux-reaper');
        const reaperBlock = bootstrapSource.slice(reaperIdx - 200, reaperIdx + 2000);
        assert.ok(/killTmuxSession\(name,\s*tmuxSocket\)/.test(reaperBlock),
            'reaper must call killTmuxSession(name, tmuxSocket) — socket-aware, not bare tmux');
        assert.ok(/n\.startsWith\(['"]lc-['"]\)/.test(reaperBlock),
            'reaper must scope to `lc-*` session names only');
        assert.ok(/orphans\.filter|orphans\s*=.*\.filter/.test(reaperBlock),
            'reaper must filter to orphans (lc-* not in owned set)');
    });

    await test('startup reaper does not use the in-memory fleet cache', async () => {
        // The in-memory cache (ptyFleetService.cache / GoPtyFleetProjection
        // cache) is empty at boot. Using it as the ownership source would reap
        // EVERY surviving session — the opposite of crash survival. The
        // reaper must read the persisted registry.
        const reaperIdx = bootstrapSource.indexOf('tmux-reaper');
        const reaperBlock = bootstrapSource.slice(reaperIdx - 200, reaperIdx + 2000);
        assert.ok(!/ptyFleetService\.cache/.test(reaperBlock) && !/this\.cache/.test(reaperBlock),
            'reaper must NOT read from the in-memory fleet cache — only the persisted registry');
    });

    await test('FleetTerminalInfo + ExtendedTerminalHandle carry tmuxSession for the registry', async () => {
        const ptyFleetPath = path.join(REPO_ROOT, 'src', 'standalone', 'ptyFleetService.ts');
        const ptyFleetSource = fs.readFileSync(ptyFleetPath, 'utf8');
        assert.ok(/tmuxSession\?:\s*string/.test(ptyFleetSource),
            'FleetTerminalInfo must declare `tmuxSession?: string`');
        // The projection's updateRegistryState must persist it.
        assert.ok(/tmuxSession:\s*t\.tmuxSession/.test(projectionSource),
            'updateRegistryState must persist `tmuxSession: t.tmuxSession` into runtime.terminals');
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll tmux backend contract checks passed.\n');
})();
