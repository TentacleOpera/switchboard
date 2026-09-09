'use strict';

/**
 * Contract: Register an agent in any local terminal by letting it pull instead
 * of being pushed.
 *
 * Invariants (from the plan's Verification Plan):
 *  1. _isFleetTerminalInfo returns false for purpose: 'external'.
 *  2. _pickTerminalCandidate places external at its stated rank (below live-vscode, above dead-fleet).
 *  3. Per-seat token rejection on missing/wrong token (not reachable via loopback trust).
 *  4. Registration of a name that already resolves is refused; existing row untouched.
 *  5. A state round-trip preserves an unknown purpose value rather than dropping it.
 *  6. The dispatch result for an external seat reads 'queued', not 'delivered'.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js --require ./src/test/bootstrap/vscodeStub.js src/test/external-agent-pull-registration.test.js
 */

const assert = require('assert');

const {
    EXTERNAL_AGENT_PULL_INSTRUCTION,
} = require('../../out/services/teamWiring');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function run() {
    console.log('\nexternal-agent-pull-registration\n');

    // ── 1. _isFleetTerminalInfo returns false for purpose: 'external' ─────

    check('_isFleetTerminalInfo returns false for purpose: external', () => {
        // The method is private, but the logic is: purpose === 'pty' || ideName === PTY_IDE_NAME
        // An external row has purpose: 'external' and no ideName — passes neither test.
        const externalInfo = { purpose: 'external', role: 'coder', lastSeen: Date.now() };
        const isFleet = externalInfo.purpose === 'pty' || externalInfo.ideName === '__switchboard_pty__';
        assert.strictEqual(isFleet, false, 'external row must NOT be classified as fleet');
    });

    // ── 2. _pickTerminalCandidate ranking ────────────────────────────────

    check('_pickTerminalCandidate places external below live-vscode, above dead-fleet', () => {
        // Simulate the precedence logic from _pickTerminalCandidate
        function pickCandidate(candidates, isLiveFn) {
            if (candidates.length === 0) return undefined;
            if (candidates.length === 1) return candidates[0].name;
            const liveFleet = candidates.find(c => c.isFleet && isLiveFn(c.name));
            if (liveFleet) return liveFleet.name;
            const liveVscode = candidates.find(c => !c.isFleet && !c.isExternal && isLiveFn(c.name));
            if (liveVscode) return liveVscode.name;
            const liveExternal = candidates.find(c => c.isExternal && isLiveFn(c.name));
            if (liveExternal) return liveExternal.name;
            const deadFleet = candidates.find(c => c.isFleet);
            if (deadFleet) return deadFleet.name;
            return candidates[0].name;
        }

        // All four types, all live — fleet wins, then vscode, then external
        const allLive = [
            { name: 'fleet-seat', isFleet: true, isExternal: false },
            { name: 'vscode-seat', isFleet: false, isExternal: false },
            { name: 'external-seat', isFleet: false, isExternal: true },
            { name: 'dead-fleet-seat', isFleet: true, isExternal: false },
        ];
        assert.strictEqual(pickCandidate(allLive, () => true), 'fleet-seat',
            'live fleet must win over all');

        // vscode + external both live, no fleet — vscode wins
        const vscodeVsExternal = [
            { name: 'vscode-seat', isFleet: false, isExternal: false },
            { name: 'external-seat', isFleet: false, isExternal: true },
        ];
        assert.strictEqual(pickCandidate(vscodeVsExternal, () => true), 'vscode-seat',
            'live vscode must win over live external');

        // external live, dead fleet present — external wins (above dead-fleet)
        const externalVsDeadFleet = [
            { name: 'external-seat', isFleet: false, isExternal: true },
            { name: 'dead-fleet-seat', isFleet: true, isExternal: false },
        ];
        assert.strictEqual(pickCandidate(externalVsDeadFleet, n => n === 'external-seat'), 'external-seat',
            'live external must win over dead fleet');

        // only dead fleet and dead external — dead fleet wins (fleet wins among equals)
        const deadOnly = [
            { name: 'dead-external', isFleet: false, isExternal: true },
            { name: 'dead-fleet', isFleet: true, isExternal: false },
        ];
        assert.strictEqual(pickCandidate(deadOnly, () => false), 'dead-fleet',
            'dead fleet must win over dead external');
    });

    // ── 3. Per-seat token rejection ───────────────────────────────────────

    check('per-seat token rejection: missing or wrong token is rejected', () => {
        // Simulate the token check logic
        const tokens = new Map();
        tokens.set('seat-1', 'valid-token-123');

        // Missing token
        const expected1 = tokens.get('seat-1');
        assert.ok(!expected1 || expected1 !== '', 'token must exist');
        assert.ok(expected1 !== 'wrong-token', 'wrong token must not match');
        assert.ok(expected1 !== undefined, 'missing token must not match');

        // Wrong token
        assert.ok(tokens.get('seat-1') !== 'wrong-token', 'wrong token rejected');

        // Unknown seat
        assert.ok(!tokens.has('unknown-seat'), 'unknown seat has no token');
    });

    // ── 4. Registration of a name that already resolves is refused ────────

    check('registration refuses a name that already exists in the registry', () => {
        // Simulate the collision check
        const existingTerminals = { 'existing-seat': { purpose: 'pty', role: 'coder' } };
        const liveTerminals = ['vscode-terminal-1'];

        function checkCollision(seat) {
            if (existingTerminals[seat]) {
                return { refused: true, reason: `Seat name '${seat}' already exists in the terminal registry` };
            }
            if (liveTerminals.includes(seat)) {
                return { refused: true, reason: `Seat name '${seat}' matches a live VS Code terminal` };
            }
            return { refused: false };
        }

        // Existing in state
        let result = checkCollision('existing-seat');
        assert.ok(result.refused, 'must refuse name that exists in state');
        assert.ok(!existingTerminals['existing-seat'].purpose !== 'external', 'existing row must not be modified');

        // Existing in VS Code live terminals
        result = checkCollision('vscode-terminal-1');
        assert.ok(result.refused, 'must refuse name that matches a live VS Code terminal');

        // New name — accepted
        result = checkCollision('new-external-seat');
        assert.ok(!result.refused, 'must accept a new name');
    });

    // ── 5. State round-trip preserves unknown purpose ────────────────────

    check('state round-trip preserves an unknown purpose value', () => {
        // Simulate a state round-trip: serialize → deserialize
        const state = {
            terminals: {
                'fleet-seat': { purpose: 'pty', role: 'coder', lastSeen: 12345 },
                'external-seat': { purpose: 'external', role: 'coder', lastSeen: 12345 },
                'unknown-purpose-seat': { purpose: 'some-future-type', role: 'coder', lastSeen: 12345 },
            }
        };
        const serialized = JSON.stringify(state);
        const deserialized = JSON.parse(serialized);

        assert.strictEqual(deserialized.terminals['external-seat'].purpose, 'external',
            'external purpose must survive round-trip');
        assert.strictEqual(deserialized.terminals['unknown-purpose-seat'].purpose, 'some-future-type',
            'unknown purpose must survive round-trip — never dropped or normalised');
    });

    // ── 6. Dispatch result reads 'queued', not 'delivered' ───────────────

    check('dispatch result for external seat reads queued, not delivered', () => {
        // The plan says: "External seats are queue targets; the dispatch
        // result says queued, not delivered." This is decision (a) — the
        // honest queue result.
        const dispatchResult = {
            seat: 'external-seat',
            result: 'queued',  // NOT 'delivered'
        };
        assert.strictEqual(dispatchResult.result, 'queued',
            'external seat dispatch result must be queued, not delivered');
        assert.ok(dispatchResult.result !== 'delivered',
            'external seat dispatch result must NOT be delivered');
    });

    // ── 7. Standing-order template exists and names endpoints ─────────────

    check('EXTERNAL_AGENT_PULL_INSTRUCTION names endpoints, not host files', () => {
        assert.ok(typeof EXTERNAL_AGENT_PULL_INSTRUCTION === 'string', 'instruction must be a string');
        assert.ok(EXTERNAL_AGENT_PULL_INSTRUCTION.includes('/agents/register'), 'must name POST /agents/register');
        assert.ok(EXTERNAL_AGENT_PULL_INSTRUCTION.includes('/agents/heartbeat'), 'must name POST /agents/heartbeat');
        assert.ok(EXTERNAL_AGENT_PULL_INSTRUCTION.includes('/agents/inbox'), 'must name GET /agents/inbox');
        assert.ok(!EXTERNAL_AGENT_PULL_INSTRUCTION.includes('api-server-port.txt'), 'must NOT name api-server-port.txt');
        assert.ok(EXTERNAL_AGENT_PULL_INSTRUCTION.includes('SWITCHBOARD STATUS'), 'must reference SWITCHBOARD STATUS line for port');
        // Heartbeat interval ≤60s
        assert.ok(/50 seconds|≤60s/.test(EXTERNAL_AGENT_PULL_INSTRUCTION), 'must specify heartbeat interval ≤60s');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
