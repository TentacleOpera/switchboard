'use strict';

/**
 * Contract: "Relay Standing Orders to a Seat the Moment It Starts".
 *
 * Standing orders used to ride only on a prompt — a seat booted and sat at its
 * CLI having been told nothing. The fix adds a startup orientation relay: after
 * a seat is created and its orders are wired, a fire-and-forget path waits for
 * the seat to quiesce, then sends a one-line carrier through the SAME delivery
 * chokepoint that already decorates prompts with the standing-orders block. The
 * block is gated inside the chokepoint on whether applyStandingOrders actually
 * changed the text, so a seat with no orders receives nothing at all.
 *
 * Two kinds of assertion, and the distinction is load-bearing (same split as
 * seat-safeguards-fleet-prompt-path.test.js):
 *
 *  - BEHAVIOURAL (section 1) — `waitForSeatQuiescence` is a pure, vscode-free
 *    poller, so it is loaded from `out/` and its RETURN VALUE is asserted with
 *    injected `now`/`sleep` (no real time).
 *  - SOURCE-LEVEL (sections 2-5) — the house pattern for pinning TypeScript
 *    call-site, ordering, and wiring facts that cannot be reached without a
 *    live host.
 *
 * Requires `npm run compile-tests` to have produced out/services/startupOrientation.js.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/startup-orientation-relay-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
    waitForSeatQuiescence,
    ORIENTATION_QUIET_MS,
    ORIENTATION_NO_OUTPUT_MS,
    ORIENTATION_MAX_WAIT_MS,
    ORIENTATION_POLL_MS,
    ORIENTATION_PREAMBLE,
} = require('../../out/services/startupOrientation');

const STARTUP_ORIENTATION_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'startupOrientation.ts'), 'utf8'
);
const TASK_VIEWER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8'
);
const BOOTSTRAP_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8'
);
const TERMINALS_JS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                  .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; });
        } else {
            console.log(`  ✅ ${name}`); passed++;
        }
    } catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

// ── 1. BEHAVIOURAL: waitForSeatQuiescence with injected time ─────────────
//
// `lastDataAt` is initialised to Date.now() at creation and updated on every
// data frame, so it is ALWAYS > 0 for a live seat. The no-output `else` branch
// (ORIENTATION_NO_OUTPUT_MS) is therefore dead code and is NOT exercised here —
// the plan's Superseded callout is explicit that a test must not assert it
// fires. The quiet check (ORIENTATION_QUIET_MS) subsumes the no-output case.

test('BEHAVIOUR: settles once output has been quiet for ORIENTATION_QUIET_MS', async () => {
    // A plain shell: lastDataAt stamped at creation (1000) and never updated
    // again (no more frames). The quiet check fires 1200 ms after that stamp.
    let clock = 1000;
    const sleeps = [];
    const ok = await waitForSeatQuiescence(
        async () => ({ lastDataAt: 1000, status: 'active' }),
        {
            now: () => clock,
            sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
        }
    );
    assert.strictEqual(ok, true, 'a live, quiet seat is worth sending to');
    // The poll interval is the constant, not a magic number.
    for (const s of sleeps) { assert.strictEqual(s, ORIENTATION_POLL_MS, 'sleep must use ORIENTATION_POLL_MS'); }
    // Settled no later than the quiet threshold after the last frame.
    assert.ok(clock - 1000 >= ORIENTATION_QUIET_MS, `must wait at least ORIENTATION_QUIET_MS (${ORIENTATION_QUIET_MS}); waited ${clock - 1000}`);
    assert.ok(clock - 1000 < ORIENTATION_MAX_WAIT_MS, 'must not need the hard cap for a quiet seat');
});

test('BEHAVIOUR: fires the hard cap when output never stops (ORIENTATION_MAX_WAIT_MS)', async () => {
    // A chatty CLI: every probe reports a fresh frame at the current clock, so
    // now - lastDataAt is always ~0 and the quiet check never fires. The hard
    // cap is the only way out. Clock starts positive so lastDataAt is always > 0
    // (as it is for a real seat) — the dead no-output else branch is never
    // touched, per the plan's Superseded callout.
    let clock = 1000;
    let probes = 0;
    const ok = await waitForSeatQuiescence(
        async () => { probes++; return { lastDataAt: clock, status: 'active' }; },
        {
            now: () => clock,
            sleep: (ms) => { clock += ms; return Promise.resolve(); },
        }
    );
    assert.strictEqual(ok, true, 'a still-chatty seat is still alive and worth sending to (hard cap)');
    assert.ok(clock >= ORIENTATION_MAX_WAIT_MS, `must wait until the hard cap (${ORIENTATION_MAX_WAIT_MS}); waited ${clock}`);
    assert.ok(probes > 1, 'must have polled more than once');
});

test('BEHAVIOUR: returns false when the seat is gone from the fleet', async () => {
    const ok = await waitForSeatQuiescence(
        async () => null,
        { now: () => 0, sleep: () => Promise.resolve() }
    );
    assert.strictEqual(ok, false, 'a missing seat is not worth sending to');
});

test('BEHAVIOUR: returns false when the seat exited mid-wait', async () => {
    let clock = 1000;
    let calls = 0;
    const ok = await waitForSeatQuiescence(
        async () => { calls++; return calls < 3 ? { lastDataAt: 1000, status: 'active' } : { lastDataAt: 1000, status: 'closed' }; },
        { now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); } }
    );
    assert.strictEqual(ok, false, 'an exited seat is not worth sending to');
});

test('BEHAVIOUR: ORIENTATION_PREAMBLE is a single non-empty line that does not command work', () => {
    assert.ok(typeof ORIENTATION_PREAMBLE === 'string' && ORIENTATION_PREAMBLE.length > 0,
        'preamble must be a non-empty string');
    assert.ok(!/\n/.test(ORIENTATION_PREAMBLE),
        'preamble must be exactly one line (a multi-line carrier is no longer "that something")');
    assert.ok(/wait/i.test(ORIENTATION_PREAMBLE),
        'preamble must tell the seat to wait — a lead must not read its orientation as a start signal');
});

// ── 2. SOURCE: the orientationOnly gate is positioned AFTER applyStandingOrders ─
//
// The gate reads the result of applyStandingOrders (soBlockAdded); it must not
// predict it. A gate that runs before the call cannot know whether a block was
// appended, and a second order resolution in the caller is a second source of
// truth about who is in a team (the existing comments at TaskViewerProvider
// :712-716 warn against exactly that).

test('SOURCE: _ptyHostVerb declares soBlockAdded beside the applyStandingOrders call', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    const soIdx = verbBody.indexOf('applyStandingOrders(');
    const gateIdx = verbBody.indexOf("payload.orientationOnly === true && !soBlockAdded");
    assert.ok(soIdx > -1, 'applyStandingOrders call must be present in _ptyHostVerb');
    assert.ok(gateIdx > -1, 'orientationOnly gate must be present in _ptyHostVerb');
    assert.ok(soIdx < gateIdx,
        'the orientationOnly gate must come AFTER the applyStandingOrders call (it reads soBlockAdded, set by that call)');
    const decorationCatchIdx = verbBody.indexOf("console.warn('[TaskViewerProvider] Standing-orders / seat-block append failed:", soIdx);
    assert.ok(decorationCatchIdx > soIdx && decorationCatchIdx < gateIdx,
        'the orientationOnly gate must also run after a decoration failure so a bare carrier is never sent');
});

test('SOURCE: _ptyHostVerb orientationOnly gate returns a skipped result, not a throw', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    const gateIdx = verbBody.indexOf("payload.orientationOnly === true && !soBlockAdded");
    const window = verbBody.slice(gateIdx, gateIdx + 160);
    assert.ok(/skipped:\s*['"]no-standing-orders['"]/.test(window),
        'a skipped relay must return { success: true, skipped: "no-standing-orders" }, not throw or send');
});

test('SOURCE: deliverPrompt declares soBlockAdded beside the applyStandingOrders call', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('const relayStartupOrientation =', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    const soIdx = fnBody.indexOf('applyStandingOrders(');
    const gateIdx = fnBody.indexOf('orientationOnly && !soBlockAdded');
    assert.ok(soIdx > -1, 'applyStandingOrders call must be present in deliverPrompt');
    assert.ok(gateIdx > -1, 'orientationOnly gate must be present in deliverPrompt');
    assert.ok(soIdx < gateIdx,
        'the deliverPrompt orientationOnly gate must come AFTER the applyStandingOrders call');
});

test('SOURCE: deliverPrompt orientationOnly gate precedes await sendPromptToPty', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('const relayStartupOrientation =', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    const gateIdx = fnBody.indexOf('orientationOnly && !soBlockAdded');
    const sendIdx = fnBody.indexOf('await sendPromptToPty(');
    assert.ok(gateIdx > -1 && sendIdx > -1, 'both the gate and sendPromptToPty must be present in deliverPrompt');
    assert.ok(gateIdx < sendIdx,
        'a skipped relay must return BEFORE sendPromptToPty — a carrier line with no block must never reach the PTY');
});

// ── 3. SOURCE: orientationOnly is stripped at the HTTP boundary ──────────
//
// A caller that could set orientationOnly could make any dispatch silently not
// send. It is a host-only field, stripped beside addonsComposed and seatBlock.

test('SOURCE: orientationOnly is stripped at the HTTP boundary beside addonsComposed and seatBlock', () => {
    // The strip block lives in the HTTP entry arm of _ptyHostVerb.
    const stripIdx = TASK_VIEWER_SRC.indexOf("payload.orientationOnly !== undefined");
    assert.ok(stripIdx > -1, 'orientationOnly must be deleted at the HTTP boundary');
    const window = TASK_VIEWER_SRC.slice(stripIdx - 320, stripIdx + 80);
    assert.ok(/addonsComposed\s*!==\s*undefined/.test(window),
        'orientationOnly must be stripped beside addonsComposed (same host-only reason)');
    assert.ok(/seatBlock\s*!==\s*undefined/.test(window),
        'orientationOnly must be stripped beside seatBlock (same host-only reason)');
});

// ── 4. SOURCE: both hosts relay on ptyCreateTerminal (head + delegates) and ptyCreateBatch ─

test('SOURCE: extension host relays on ptyCreateTerminal for the head and its delegates', () => {
    const callIdx = TASK_VIEWER_SRC.indexOf("verb === 'ptyCreateTerminal' && result && result.success !== false && result.terminal?.friendlyName");
    assert.ok(callIdx > -1, 'extension host must relay after a successful ptyCreateTerminal');
    const window = TASK_VIEWER_SRC.slice(callIdx, callIdx + 320);
    assert.ok(/_relayStartupOrientation/.test(window), 'the call must invoke _relayStartupOrientation');
    assert.ok(/result\.terminal\.friendlyName/.test(window), 'the head terminal must be relayed');
    assert.ok(/result\.delegates/.test(window),
        'delegates (spawned team children) must be relayed too — a team start orients every seat');
});

test('SOURCE: extension host relays on ptyCreateBatch', () => {
    const callIdx = TASK_VIEWER_SRC.indexOf("verb === 'ptyCreateBatch' && result && Array.isArray(result.created)");
    assert.ok(callIdx > -1, 'extension host must relay after a successful ptyCreateBatch');
    const window = TASK_VIEWER_SRC.slice(callIdx, callIdx + 200);
    assert.ok(/_relayStartupOrientation/.test(window), 'the call must invoke _relayStartupOrientation');
    assert.ok(/result\.created\.map/.test(window), 'every created seat in the batch must be relayed');
});

test('SOURCE: standalone host relays on ptyCreateTerminal for the head and its delegates', () => {
    const callIdx = BOOTSTRAP_SRC.indexOf('relayStartupOrientation([terminal.friendlyName, ...spawned.children.map(c => c.friendlyName)]');
    assert.ok(callIdx > -1, 'standalone host must relay after ptyCreateTerminal, covering the head and spawned children');
});

test('SOURCE: standalone host relays on ptyCreateBatch', () => {
    // The batch arm relays over result.created.
    const callIdx = BOOTSTRAP_SRC.indexOf('relayStartupOrientation(result.created.map((c: any) => c.friendlyName))');
    assert.ok(callIdx > -1, 'standalone host must relay after ptyCreateBatch over result.created');
});

test('SOURCE: standalone setAgentGroupInstantiator relays only after team wiring resolves', () => {
    const callbackStart = BOOTSTRAP_SRC.indexOf('setAgentGroupInstantiator(async (group: any, groupRoot: string) => {');
    assert.ok(callbackStart > -1, 'setAgentGroupInstantiator callback must be present in bootstrap');
    const instantiateIdx = BOOTSTRAP_SRC.indexOf('const result = await instantiateAgentGroupCore({', callbackStart);
    const relayIdx = BOOTSTRAP_SRC.indexOf('relayStartupOrientation(result.created);', instantiateIdx);
    const returnIdx = BOOTSTRAP_SRC.indexOf('return result;', relayIdx);
    assert.ok(instantiateIdx > callbackStart, 'the callback must await instantiateAgentGroupCore');
    assert.ok(relayIdx > instantiateIdx,
        'the startup relay must run after instantiateAgentGroupCore resolves and wireSpawnedTeam has installed orders');
    assert.ok(returnIdx > relayIdx, 'the wired result must return after the relay is scheduled');
});

test('SOURCE: external-headed teams relay after wiring in both hosts', () => {
    const extensionStart = TASK_VIEWER_SRC.indexOf('const result = await instantiateExternalHeadedTeam({');
    const extensionRelay = TASK_VIEWER_SRC.indexOf('this._relayStartupOrientation(result.workers.map', extensionStart);
    assert.ok(extensionStart > -1 && extensionRelay > extensionStart,
        'extension external-team workers must relay only after instantiateExternalHeadedTeam resolves');

    const standaloneStart = BOOTSTRAP_SRC.indexOf('const result = await instantiateExternalHeadedTeam({');
    const standaloneRelay = BOOTSTRAP_SRC.indexOf('relayStartupOrientation(result.workers.map', standaloneStart);
    assert.ok(standaloneStart > -1 && standaloneRelay > standaloneStart,
        'standalone external-team workers must relay only after instantiateExternalHeadedTeam resolves');
});

test('SOURCE: extension external-team workers suppress the pre-wiring create relay', () => {
    const externalStart = TASK_VIEWER_SRC.indexOf('const result = await instantiateExternalHeadedTeam({');
    const externalRelay = TASK_VIEWER_SRC.indexOf('this._relayStartupOrientation(result.workers.map', externalStart);
    const body = TASK_VIEWER_SRC.slice(externalStart, externalRelay);
    assert.ok(/suppressStartupOrientation:\s*true/.test(body),
        'external-team ptyCreateTerminal calls must not race a relay ahead of wireSpawnedTeam');
    assert.ok(TASK_VIEWER_SRC.includes('payload?.suppressStartupOrientation !== true'),
        'the ptyCreateTerminal relay gate must honour the internal suppression flag');
    assert.ok(TASK_VIEWER_SRC.includes('payload.suppressStartupOrientation !== undefined'),
        'the HTTP boundary must strip the internal suppression flag');
});

// ── 5. SOURCE: every relay call site is fire-and-forget (void-ed or .catch-ed) ─
//
// The relay is a convenience; the terminal is the product. A relay that fails
// must never fail a create. Every relay path is void-ed and self-catching,
// exactly like the existing updateMirrorRegistry / rename-rewrite calls.

test('SOURCE: _relayStartupOrientation voids and .catch-es every per-name relay', () => {
    const fnStart = TASK_VIEWER_SRC.indexOf('private _relayStartupOrientation(names: string[]): void {');
    const fnEnd = TASK_VIEWER_SRC.indexOf('\n    private ', fnStart + 10);
    const fnBody = TASK_VIEWER_SRC.slice(fnStart, fnEnd);
    assert.ok(/void\s*\(async/.test(fnBody), 'each relay must be void-ed (fire-and-forget)');
    assert.ok(/\.catch\(/.test(fnBody), 'each relay must self-catch (a failure must not reject an unawaited promise)');
    assert.ok(/clearBeforePrompt:\s*false/.test(fnBody),
        'a /clear at startup is pointless and mid-CLI-boot harmful — clearBeforePrompt must be false');
    assert.ok(/seatBlock:\s*false/.test(fnBody),
        'orientation must not cache a seat block that the no-orders gate may skip before delivery');
    assert.ok(/orientationOnly:\s*true/.test(fnBody),
        'the relay must mark itself orientationOnly so the chokepoint gate can drop a no-orders send');
});

test('SOURCE: standalone relayStartupOrientation voids and .catch-es every per-name relay', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const relayStartupOrientation = (names: string[]): void => {');
    const fnEnd = BOOTSTRAP_SRC.indexOf('\n    const secrets', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(/void\s*\(async/.test(fnBody), 'each relay must be void-ed (fire-and-forget)');
    assert.ok(/\.catch\(/.test(fnBody), 'each relay must self-catch');
    assert.ok(/clearBeforePrompt:\s*false/.test(fnBody), 'clearBeforePrompt must be false on the relay path');
    // The standalone relay disables the seat block and passes orientationOnly=true.
    assert.ok(/,\s*true,\s*false,\s*undefined,\s*false,\s*true\)/.test(fnBody),
        'the standalone relay must apply orders only, without consuming seat-block cache state');
});

// ── 6. SOURCE: quiescence numbers are pinned to the webview curtain (drift pin) ─
//
// The plan lifts the timings from the webview's startup curtain rather than
// inventing them. If either set drifts, the relay and the curtain answer the
// same question ("has the CLI finished booting?") with different numbers. This
// reads the constants straight out of terminals.js so a change there without a
// matching change here (or vice versa) fails the gate.

test('SOURCE: ORIENTATION_QUIET_MS equals the webview CURTAIN_QUIET_MS (drift pin)', () => {
    const m = TERMINALS_JS_SRC.match(/CURTAIN_QUIET_MS\s*=\s*(\d+)/);
    assert.ok(m, 'CURTAIN_QUIET_MS must be defined in terminals.js');
    assert.strictEqual(ORIENTATION_QUIET_MS, Number(m[1]),
        `ORIENTATION_QUIET_MS (${ORIENTATION_QUIET_MS}) must equal CURTAIN_QUIET_MS (${m[1]}) — do not fork a second set of timings`);
});

test('SOURCE: ORIENTATION_NO_OUTPUT_MS equals the webview CURTAIN_NO_OUTPUT_MS (drift pin)', () => {
    const m = TERMINALS_JS_SRC.match(/CURTAIN_NO_OUTPUT_MS\s*=\s*(\d+)/);
    assert.ok(m, 'CURTAIN_NO_OUTPUT_MS must be defined in terminals.js');
    assert.strictEqual(ORIENTATION_NO_OUTPUT_MS, Number(m[1]),
        `ORIENTATION_NO_OUTPUT_MS (${ORIENTATION_NO_OUTPUT_MS}) must equal CURTAIN_NO_OUTPUT_MS (${m[1]}) — kept for parity even though the branch is dead`);
});

test('SOURCE: ORIENTATION_MAX_WAIT_MS equals the webview CURTAIN_MAX_MS (drift pin)', () => {
    const m = TERMINALS_JS_SRC.match(/CURTAIN_MAX_MS\s*=\s*(\d+)/);
    assert.ok(m, 'CURTAIN_MAX_MS must be defined in terminals.js');
    assert.strictEqual(ORIENTATION_MAX_WAIT_MS, Number(m[1]),
        `ORIENTATION_MAX_WAIT_MS (${ORIENTATION_MAX_WAIT_MS}) must equal CURTAIN_MAX_MS (${m[1]}) — the hard cap must not diverge`);
});

test('SOURCE: the no-output else branch is annotated dead in startupOrientation.ts', () => {
    // lastDataAt is initialised to Date.now() at creation, so the else branch
    // is unreachable. The plan requires it be kept for defensive clarity but
    // annotated as dead so a future reader does not wire a test onto it.
    assert.ok(/Dead branch/.test(STARTUP_ORIENTATION_SRC),
        'the no-output else branch must be annotated as dead (lastDataAt is always > 0 for a live seat)');
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}, 1000);
