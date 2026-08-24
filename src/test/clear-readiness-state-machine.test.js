'use strict';

const assert = require('assert');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const READINESS_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'clearReadiness.ts');
const IDENTITY_FILE = path.join(REPO_ROOT, 'src', 'services', 'cliIdentity.ts');
const DELIVERY_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'ptyPromptDelivery.ts');

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

function createMockHandle(overrides = {}) {
    const dataListeners = new Set();
    const exitListeners = new Set();
    const writes = [];
    return {
        name: 'test-seat',
        role: 'coder',
        status: 'active',
        cliFamily: 'unknown',
        writes,
        write(data) {
            writes.push(data);
        },
        onData(cb) {
            dataListeners.add(cb);
            return {
                dispose: () => dataListeners.delete(cb)
            };
        },
        onExit(cb) {
            exitListeners.add(cb);
            return {
                dispose: () => exitListeners.delete(cb)
            };
        },
        emitData(chunk) {
            for (const cb of [...dataListeners]) cb(chunk);
        },
        emitExit(code = 0) {
            for (const cb of [...exitListeners]) cb(code);
        },
        dataListenerCount() {
            return dataListeners.size;
        },
        exitListenerCount() {
            return exitListeners.size;
        },
        ...overrides,
    };
}

(async function main() {
    console.log('\n── Clear readiness state machine tests ──');

    const { deriveCliIdentity, deriveCliFamily, deriveAgentDisplayName } = await import(path.join('file://', IDENTITY_FILE));
    const { createClearReadinessTracker, resolvePtyTimingPolicy } = await import(path.join('file://', READINESS_FILE));
    const { sendPromptToPty } = await import(path.join('file://', DELIVERY_FILE));

    // 1. CLI Identity derivation
    await test('deriveCliIdentity correctly identifies families and display names', () => {
        assert.strictEqual(deriveCliFamily('devin'), 'devin');
        assert.strictEqual(deriveCliFamily('/usr/local/bin/devin.exe --flag'), 'devin');
        assert.strictEqual(deriveCliFamily('claude --dangerously-skip-permissions'), 'claude');
        assert.strictEqual(deriveCliFamily('agy'), 'antigravity');
        assert.strictEqual(deriveCliFamily('antigravity'), 'antigravity');
        assert.strictEqual(deriveCliFamily('bash'), 'unknown');
        assert.strictEqual(deriveCliFamily(''), 'unknown');
        assert.strictEqual(deriveCliFamily(null), 'unknown');

        assert.strictEqual(deriveAgentDisplayName('agy'), 'Antigravity CLI');
        assert.strictEqual(deriveAgentDisplayName('antigravity'), 'Antigravity CLI');
        assert.strictEqual(deriveAgentDisplayName('devin'), 'DEVIN CLI');
        assert.strictEqual(deriveAgentDisplayName('No agent assigned'), 'No agent assigned');
        assert.strictEqual(deriveAgentDisplayName(''), '');
    });

    // 2. Timing Policy Resolution
    await test('resolvePtyTimingPolicy adheres to the 5 resolution rules', () => {
        // 1. Explicit Auto
        assert.deepStrictEqual(resolvePtyTimingPolicy({ mode: 'auto' }), { mode: 'auto', delayMs: 600 });
        assert.deepStrictEqual(resolvePtyTimingPolicy({ mode: 'auto', explicitPtyDelay: 400 }), { mode: 'auto', delayMs: 400 });

        // 2. Explicit Manual
        assert.deepStrictEqual(resolvePtyTimingPolicy({ mode: 'manual' }), { mode: 'manual', delayMs: 600 });
        assert.deepStrictEqual(resolvePtyTimingPolicy({ mode: 'manual', explicitPtyDelay: 350 }), { mode: 'manual', delayMs: 350 });
        assert.deepStrictEqual(resolvePtyTimingPolicy({ mode: 'manual', explicitPtyDelay: 0 }), { mode: 'manual', delayMs: 0 });
        assert.deepStrictEqual(resolvePtyTimingPolicy({ mode: 'manual', explicitLegacyDelay: 2000 }), { mode: 'manual', delayMs: 2000 });

        // 3. No mode + explicit PTY delay -> compatibility Manual
        assert.deepStrictEqual(resolvePtyTimingPolicy({ explicitPtyDelay: 300 }), { mode: 'manual', delayMs: 300 });

        // 4. No mode/PTY value + explicit legacy delay -> compatibility Manual
        assert.deepStrictEqual(resolvePtyTimingPolicy({ explicitLegacyDelay: 2000 }), { mode: 'manual', delayMs: 2000 });

        // 5. No explicit values -> Auto with 600ms fallback
        assert.deepStrictEqual(resolvePtyTimingPolicy({}), { mode: 'auto', delayMs: 600 });
    });

    // 3. Devin Auto profile state machine
    await test('Devin Auto profile: chunk-fragmented escape sequences resolve signal after quiet', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { devinQuietMs: 20, devinTimeoutMs: 2000 },
        });

        // Split disable sequence across chunks: \x1b[?2004l
        handle.emitData('\x1b[?20');
        handle.emitData('04l');

        // Split enable and render sequence across chunks: \x1b[?2004h\x1b[?25h\x1b[?2026l
        handle.emitData('\x1b[?20');
        handle.emitData('04h');
        handle.emitData('\x1b[?25');
        handle.emitData('h\x1b[?2026');
        handle.emitData('l');

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal');
        assert.strictEqual(handle.dataListenerCount(), 0, 'listeners must be cleaned up on resolve');
    });

    await test('Devin Auto profile: intermediate enable followed by disable does not resolve prematurely', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { devinQuietMs: 40, devinTimeoutMs: 2000 },
        });

        // 1. Initial disable
        handle.emitData('\x1b[?2004l');
        // 2. Intermediate enable & render
        handle.emitData('\x1b[?2004h\x1b[?25h\x1b[?2026l');

        // 3. Devin disables again 10ms later before quiet window finishes!
        await new Promise(r => setTimeout(r, 10));
        handle.emitData('\x1b[?2004l');

        // Wait 50ms (longer than quietMs): it must NOT have resolved because latest state is disabled
        let resolved = false;
        tracker.promise.then(() => { resolved = true; });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(resolved, false, 'should not resolve when disabledAt >= enabledAt');

        // 4. Final enable + cursor + render completion
        handle.emitData('\x1b[?2004h\x1b[?25h\x1b[?2026l');

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal');
        assert.strictEqual(handle.dataListenerCount(), 0);
    });

    await test('Devin Auto profile: quiet timer resets on new output', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { devinQuietMs: 30, devinTimeoutMs: 2000 },
        });

        handle.emitData('\x1b[?2004l\x1b[?2004h\x1b[?25h\x1b[?2026l');

        // Interrupt with ongoing output every 15ms
        for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 15));
            handle.emitData(' rendering progress... ');
        }

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal');
    });

    // 4. Claude and Antigravity profiles
    await test('Claude / Antigravity Auto profile: live output followed by quiet resolves signal', async () => {
        const handle = createMockHandle({ cliFamily: 'claude' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { claudeQuietMs: 20, claudeTimeoutMs: 1000 },
        });

        handle.emitData('\x1b[2J\x1b[H');
        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal');
        assert.strictEqual(handle.dataListenerCount(), 0);
    });

    // 5. Unknown profile
    await test('Unknown profile in Auto: uses fallback delay and reports reason fallback', async () => {
        const handle = createMockHandle({ cliFamily: 'unknown' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            fallbackDelayMs: 25,
        });

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'fallback');
    });

    // 6. Manual mode
    await test('Manual mode: uses exact delay and reports reason manual', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'manual',
            fallbackDelayMs: 20,
        });

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'manual');
    });

    // 7. Exit handling & Prompt blocking
    await test('Terminal exit before / during clear resolves exit and blocks prompt paste', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { devinTimeoutMs: 5000 },
        });

        handle.emitExit(1);
        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'exit');
    });

    await test('sendPromptToPty does not paste if terminal exits during clear', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const promptPromise = sendPromptToPty(handle, 'my-prompt', {
            clearBeforePrompt: true,
            clearReadinessMode: 'auto',
        });

        // Terminal exits while waiting for clear readiness
        await new Promise(r => setTimeout(r, 10));
        handle.status = 'exited';
        handle.emitExit(1);

        await promptPromise;

        // Verify that bracketed paste markers and prompt were never written
        const wrotePasteOpen = handle.writes.includes('\x1b[200~');
        assert.strictEqual(wrotePasteOpen, false, 'prompt must not be pasted when terminal exited');
    });

    // 8. Disposal cleanup
    await test('Dispose cleans up all listeners and timers idempotently', () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { devinTimeoutMs: 5000 },
        });

        assert.strictEqual(handle.dataListenerCount(), 1);
        assert.strictEqual(handle.exitListenerCount(), 1);

        tracker.dispose();
        tracker.dispose();

        assert.strictEqual(handle.dataListenerCount(), 0);
        assert.strictEqual(handle.exitListenerCount(), 0);
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll clear readiness state machine tests passed.\n');
})();
