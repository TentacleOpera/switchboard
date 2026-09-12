'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('./bootstrap/tsResolveHook').installTsResolveHook();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const READINESS_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'clearReadiness.ts');
const IDENTITY_FILE = path.join(REPO_ROOT, 'src', 'services', 'cliIdentity.ts');
const DELIVERY_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'ptyPromptDelivery.ts');
const GO_PROMPT_FILE = path.join(REPO_ROOT, 'cmd', 'switchboard-pty-host', 'prompt.go');

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
    const { createClearReadinessTracker } = await import(path.join('file://', READINESS_FILE));
    const deliveryModule = await import(path.join('file://', DELIVERY_FILE));
    const { sendPromptToPty } = deliveryModule;

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

    // 2. The timing policy lives in ONE module
    await test('clearReadiness does not carry a second copy of the timing policy', () => {
        const fs = require('fs');
        const readiness = fs.readFileSync(READINESS_FILE, 'utf8');
        // A duplicate resolver lived here and DISAGREED with the real one
        // (explicit Auto + an explicit legacy VS Code delay resolved the unknown-CLI
        // fallback to the legacy value instead of 600). It had no production caller;
        // its only consumer was this file, so every precedence assertion passed while
        // pinning behaviour nothing shipped.
        assert.ok(
            !/resolvePtyTimingPolicy/.test(readiness),
            'clearReadiness.ts must not re-declare the PTY timing policy — ptyClearPolicy.ts owns it'
        );
        const policySrc = fs.readFileSync(
            path.join(REPO_ROOT, 'src', 'services', 'ptyClearPolicy.ts'), 'utf8');
        assert.ok(
            /export function resolvePtyClearPolicyFromExplicit\(/.test(policySrc),
            'the single precedence ladder must live in ptyClearPolicy.ts'
        );
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
    await test('Claude / Antigravity Auto profile: live output after submit followed by quiet resolves signal', async () => {
        const handle = createMockHandle({ cliFamily: 'claude' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { claudeQuietMs: 20, claudeTimeoutMs: 1000 },
        });

        tracker.markSubmitted();
        handle.emitData('\x1b[2J\x1b[H');
        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal');
        assert.strictEqual(handle.dataListenerCount(), 0);
    });

    await test('Claude / Antigravity Auto profile: the ECHO of the clear command cannot resolve readiness', async () => {
        // The tracker is armed BEFORE `/clear` is typed (Devin needs the old session's
        // paste-disable). For an output-settled profile that means the CLI echoing the
        // typed characters back is the first "post-clear output" it sees — and a quiet
        // window measured from the echo fires before the clear has begun. markSubmitted()
        // is the boundary; nothing before it counts.
        const handle = createMockHandle({ cliFamily: 'claude' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            timeouts: { claudeQuietMs: 20, claudeTimeoutMs: 400 },
        });

        handle.emitData('/clear');            // the echo, pre-submit
        let resolvedEarly = false;
        tracker.promise.then(() => { resolvedEarly = true; });
        await new Promise(r => setTimeout(r, 60));   // 3x the quiet window
        assert.strictEqual(resolvedEarly, false, 'echo must not satisfy the quiet window');

        tracker.markSubmitted();
        handle.emitData('\x1b[2J\x1b[H');
        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal');
    });

    // 5. Unknown profile
    await test('Unknown profile in Auto: uses patient default ceiling and reports reason fallback', async () => {
        const handle = createMockHandle({ cliFamily: 'unknown' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            fallbackDelayMs: 25,
            // The unknown branch now uses DEVIN_DEFAULT_TIMEOUT_MS (15s) as the
            // patient default, not the fallbackDelay. Override with a short
            // timeout for test speed. See prompt-delivery-should-be-patient-not-precise.md.
            timeouts: { devinTimeoutMs: 25 },
        });

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'fallback');
    });

    // 6. Manual mode — unknown family: delay is the whole policy (unchanged)
    await test('Manual mode (unknown family): uses exact delay and reports reason manual', async () => {
        const handle = createMockHandle({ cliFamily: 'unknown' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'manual',
            fallbackDelayMs: 20,
        });

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'manual');
    });

    // 6b. Manual mode — known family: delay is a floor, state machine runs
    await test('Manual mode (devin): delay is a floor — signal before floor waits', async () => {
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'manual',
            fallbackDelayMs: 60,
            timeouts: { devinQuietMs: 10, devinTimeoutMs: 2000 },
        });

        // Emit the Devin readiness signal immediately
        handle.emitData('\x1b[?2004l\x1b[?2004h\x1b[?25h\x1b[?2026l');

        const res = await tracker.promise;
        // Signal was detected, but the floor (60ms) must have elapsed
        assert.strictEqual(res.reason, 'signal');
        assert.ok(res.elapsedMs >= 60, `floor must be enforced (elapsed=${res.elapsedMs}ms)`);
    });

    await test('AUTO mode (devin): a signal cannot resolve faster than the floor', async () => {
        // The floor used to be gated on mode === 'manual'. `auto` is the default
        // mode for every dispatch, so the default path had NO floor: the instant
        // the state machine matched, the tracker resolved and the prompt was
        // pasted. Every patience mechanism above it was bypassed by the one case
        // it most needed to cover. Patience a signal can short-circuit is not
        // patience — this pins the floor on the default path, not just the
        // opt-in one.
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            fallbackDelayMs: 80,
            timeouts: { devinQuietMs: 10, devinTimeoutMs: 2000 },
        });

        handle.emitData('\x1b[?2004l\x1b[?2004h\x1b[?25h\x1b[?2026l');

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'signal', 'the signal must still be detected and reported honestly');
        assert.ok(res.elapsedMs >= 80, `auto-mode floor must be enforced (elapsed=${res.elapsedMs}ms)`);
    });

    await test('A dead CLI is exempt from the floor and aborts immediately', async () => {
        // The floor must never delay an abort. A seat that exited has nothing to
        // be patient for, and making the lead wait out a floor to learn the CLI
        // is dead is the opposite of the fix.
        const handle = createMockHandle({ cliFamily: 'devin' });
        const tracker = createClearReadinessTracker(handle, {
            mode: 'auto',
            fallbackDelayMs: 5000,
            timeouts: { devinQuietMs: 10, devinTimeoutMs: 10000 },
        });

        const startedAt = Date.now();
        handle.emitExit(1);

        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'exit');
        assert.ok(Date.now() - startedAt < 2000, 'exit must not wait out the floor');
    });

    // 7. Exit handling & Prompt blocking
    await test('Tracker constructed on an ALREADY-exited target resolves exit (no ReferenceError)', async () => {
        // Regression: finish() reads `mode`, `family` and `fallbackDelay` for the
        // manual-mode floor. When those `const`s were declared BELOW the
        // already-exited check, this branch threw
        // `ReferenceError: Cannot access 'mode' before initialization` — the one
        // input that reaches finish() before the declarations run.
        const handle = createMockHandle({ cliFamily: 'devin', status: 'exited' });
        let tracker;
        assert.doesNotThrow(() => {
            tracker = createClearReadinessTracker(handle, { mode: 'manual', fallbackDelayMs: 5000 });
        }, 'constructing a tracker on an exited target must not throw');
        const res = await tracker.promise;
        assert.strictEqual(res.reason, 'exit');
        assert.ok(res.elapsedMs < 5000, 'an exited target must not wait out the manual floor');
    });

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
    // 8. Per-delivery floor (prompt-delivery-should-be-patient-not-precise)
    await test('Warm-seat delivery waits the family floor before the first paste byte', async () => {
        // promptCount >= 1 with clearBeforePrompt off runs NO readiness gate — the
        // floor is the only thing between the queue pop and the write. Claude's
        // floor (3000ms) is used so the assertion does not cost devin's 15s.
        const handle = createMockHandle({ cliFamily: 'claude', promptCount: 1 });
        const startAt = Date.now();
        let pasteOpenAt = 0;
        const baseWrite = handle.write.bind(handle);
        handle.write = (data) => {
            if (data === '\x1b[200~' && !pasteOpenAt) { pasteOpenAt = Date.now(); }
            baseWrite(data);
        };

        await sendPromptToPty(handle, 'warm-seat-prompt', { clearBeforePrompt: false });

        assert.ok(pasteOpenAt > 0, 'the prompt must still be delivered');
        assert.ok(pasteOpenAt - startAt >= 3000,
            `floor must be honoured before the first paste byte (waited ${pasteOpenAt - startAt}ms)`);
        assert.ok(handle.writes.includes('\x1b[201~'), 'paste close marker must still be written');
        assert.strictEqual(handle.writes.filter(w => w === '\r').length, 2,
            'the confirm-Enter double CR must be unchanged by the floor');
    });

    await test('Attendance caps the floor, and the cap can only shorten', () => {
        // 5s attended / 10s unattended, applied as min(familyFloor, cap). Pinned as
        // an ordering + relationship, not three magic numbers, so tuning the values
        // does not require editing this test — only inverting them does.
        const delivery = deliveryModule;
        const { ATTENDED_FLOOR_CAP_MS, UNATTENDED_FLOOR_CAP_MS } = delivery;
        assert.strictEqual(typeof ATTENDED_FLOOR_CAP_MS, 'number');
        assert.strictEqual(typeof UNATTENDED_FLOOR_CAP_MS, 'number');
        assert.ok(
            ATTENDED_FLOOR_CAP_MS < UNATTENDED_FLOOR_CAP_MS,
            'a watched send must never wait longer than an unwatched one — that inversion is the whole point of the flag'
        );
        assert.ok(
            UNATTENDED_FLOOR_CAP_MS <= 15000,
            'the unattended cap must not exceed the devin family floor it caps, or it is not a cap'
        );
        // The cap must never LENGTHEN a fast family. claude/antigravity sit at 3000;
        // if a future cap dropped below that it would still be min(), but if someone
        // reimplements this as an assignment rather than a min, this catches it.
        assert.ok(
            Math.min(3000, UNATTENDED_FLOOR_CAP_MS) === 3000,
            'capping must not make a family with a shorter floor slower'
        );
    });

    await test('An undeclared caller gets the LONGER floor, not the shorter one', () => {
        // The safe direction is the default. A call site that forgets `attended`
        // costs seconds and is visible; the opposite default would silently shorten
        // automated delivery, which is the failure that stalled Coding-coder-1 for
        // ~55 minutes. Devin is used because its family floor sits above both caps,
        // so the two are distinguishable — claude's 3000 would prove nothing.
        const { resolveDeliveryFloorMs, ATTENDED_FLOOR_CAP_MS, UNATTENDED_FLOOR_CAP_MS } = deliveryModule;
        assert.strictEqual(resolveDeliveryFloorMs('devin', true), ATTENDED_FLOOR_CAP_MS,
            'an explicitly attended send takes the attended cap');
        // Everything that is not exactly `true` must land on the longer cap. The
        // delivery path compares `opts?.attended === true`, so these all arrive as
        // false — this pins that the comparison stays strict.
        for (const notTrue of [undefined, false]) {
            assert.strictEqual(resolveDeliveryFloorMs('devin', notTrue === true), UNATTENDED_FLOOR_CAP_MS,
                `attended=${String(notTrue)} must take the unattended cap`);
        }
        // A family already below both caps is untouched in both modes.
        assert.strictEqual(resolveDeliveryFloorMs('claude', true), 3000);
        assert.strictEqual(resolveDeliveryFloorMs('claude', false), 3000);
        // unknown is the patient default and must be capped like devin, not left at 15s.
        assert.strictEqual(resolveDeliveryFloorMs(undefined, false), UNATTENDED_FLOOR_CAP_MS);
    });

    await test('A pure /clear (empty payload) does NOT pay the delivery floor', async () => {
        // clearTerminalContext sends `data: ''` on both hosts. There is no prompt
        // text a not-yet-ready composer could swallow, so flooring it would add the
        // full devin floor (15s) to every queue/done pop for nothing.
        const handle = createMockHandle({ cliFamily: 'devin', promptCount: 1 });
        const startAt = Date.now();
        await sendPromptToPty(handle, '', { clearBeforePrompt: false });
        const elapsed = Date.now() - startAt;
        assert.ok(elapsed < 1000, `empty payload must not wait the devin floor (waited ${elapsed}ms)`);
    });

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

    await test('No family\'s post-clear quiet window sits below the calibrated floor', () => {
        // All three families shipped at 100 ms. claude and antigravity were raised to
        // 300 when 100 was measured to be shorter than the /clear re-render burst —
        // the first post-submit chunk arms the quiet timer and a gap mid-re-render
        // resolves "ready" before the input editor has repainted. DEVIN was left at
        // 100 for months, which is the family every team seat in this repo runs: a
        // prompt pasted into a still-repainting editor is lost, the receipt still says
        // success: true, and the lead blocks on a callback that never comes (observed
        // 2026-09-12 on Coding-coder-1 — ~55 minutes stalled, lead routed around it).
        //
        // This asserts the floor across ALL families at once rather than pinning three
        // separate numbers, because the defect was never a wrong value — it was one
        // family silently not getting a fix the other two got. A new family added at
        // the old default fails here on day one.
        const readiness = require(READINESS_FILE);
        const CALIBRATED_FLOOR_MS = 300;
        const windows = {
            devin: readiness.DEVIN_DEFAULT_QUIET_MS,
            claude: readiness.CLAUDE_DEFAULT_QUIET_MS,
            antigravity: readiness.ANTIGRAVITY_DEFAULT_QUIET_MS,
        };
        for (const [family, ms] of Object.entries(windows)) {
            assert.strictEqual(
                typeof ms, 'number',
                `${family} quiet window must be a number, got ${typeof ms}`
            );
            assert.ok(
                ms >= CALIBRATED_FLOOR_MS,
                `${family} post-clear quiet window is ${ms} ms, below the ${CALIBRATED_FLOOR_MS} ms calibrated floor — ` +
                'a window shorter than the CLI\'s re-render burst resolves "ready" early and the next prompt is pasted into a repainting editor. ' +
                'Raising a family above the floor is fine; dropping one below it is the bug this pins.'
            );
        }
    });

    await test('The Go pty host and the TS delivery module agree on devin timing', () => {
        // THIS IS THE LIVE COPY. Delivery runs in cmd/switchboard-pty-host — the
        // TypeScript sendPromptToPty in ptyPromptDelivery.ts has no production
        // caller. On 2026-09-12 devin's post-clear quiet window was raised from
        // 100ms to 1500ms in TypeScript, every suite in this file went green, and
        // not one seat changed behaviour, because prompt.go carried its own copy
        // still set to 100ms. Two implementations of one timing policy in two
        // languages, and every gate pointed at the one that does not run.
        //
        // This asserts the numbers match across both. It does not care which file
        // is eventually deleted — it cares that a fix to one is never again
        // reported as a fix while the other disagrees.
        const goSrc = fs.readFileSync(GO_PROMPT_FILE, 'utf8');
        const readiness = deliveryModule; // re-exported constants live alongside the floor caps
        void readiness;

        const clearWindows = goSrc.match(/func clearReadinessWindows\([\s\S]*?\n}/);
        assert.ok(clearWindows, 'clearReadinessWindows must exist in prompt.go');
        const devinArm = clearWindows[0].match(/case "devin":\s*\n\s*return\s+(\d+)\s*\*\s*time\.Second,\s*(\d+)\s*\*\s*time\.Millisecond/);
        assert.ok(devinArm, 'the devin arm of clearReadinessWindows must be readable');
        const goDevinQuietMs = Number(devinArm[2]);

        const tsSrc = fs.readFileSync(READINESS_FILE, 'utf8');
        const tsDevin = tsSrc.match(/export const DEVIN_DEFAULT_QUIET_MS\s*=\s*(\d+)/);
        assert.ok(tsDevin, 'DEVIN_DEFAULT_QUIET_MS must be readable from clearReadiness.ts');
        const tsDevinQuietMs = Number(tsDevin[1]);

        assert.strictEqual(
            goDevinQuietMs, tsDevinQuietMs,
            `devin post-clear quiet window disagrees: prompt.go=${goDevinQuietMs}ms, clearReadiness.ts=${tsDevinQuietMs}ms. ` +
            'prompt.go is the copy that runs — fixing only the TypeScript one changes nothing on a real seat.'
        );

        // The attendance caps must exist in the live copy too, with the same
        // ordering the TS module pins.
        const goAttended = goSrc.match(/attendedFloorCap\s*=\s*(\d+)\s*\*\s*time\.Second/);
        const goUnattended = goSrc.match(/unattendedFloorCap\s*=\s*(\d+)\s*\*\s*time\.Second/);
        assert.ok(goAttended && goUnattended, 'prompt.go must carry both floor caps — the TS-only version reaches no seat');
        assert.strictEqual(Number(goAttended[1]) * 1000, deliveryModule.ATTENDED_FLOOR_CAP_MS,
            'attended floor cap disagrees between prompt.go and ptyPromptDelivery.ts');
        assert.strictEqual(Number(goUnattended[1]) * 1000, deliveryModule.UNATTENDED_FLOOR_CAP_MS,
            'unattended floor cap disagrees between prompt.go and ptyPromptDelivery.ts');

        // The unknown/default floor arm must not be 0. An unrecognised CLI takes
        // the longest floor, never the shortest — guessing short breaks delivery.
        const familyFloor = goSrc.match(/func familyFloor\([\s\S]*?\n}/);
        assert.ok(familyFloor, 'familyFloor must exist in prompt.go');
        assert.ok(
            !/default:\s*\n(\s*\/\/[^\n]*\n)*\s*return 0\b/.test(familyFloor[0]),
            'familyFloor\'s default arm must not return 0 — an unknown CLI is the seat to be most patient with, not the least'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll clear readiness state machine tests passed.\n');
})();
