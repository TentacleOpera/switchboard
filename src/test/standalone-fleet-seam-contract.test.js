'use strict';

/**
 * Contract: Standalone Fleet Seam & Host-Agnostic Fleet Predicate
 *
 * Pins the nine census guard sites in TaskViewerProvider to `_hasFleet()`,
 * verifies `hasPtyHost()` delegates to `_hasFleet()`, asserts `bootstrap.ts`
 * injects the fleet verb seam into TaskViewerProvider, and verifies the
 * extension-only agent-group arm still refuses without a reachable fleet.
 *
 * (feature_plan_20260812150000_fleet-seam-standalone-terminal-parity.md)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASKVIEWER_PATH = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const BOOTSTRAP_PATH = path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts');

const taskViewerSource = fs.readFileSync(TASKVIEWER_PATH, 'utf8');
const bootstrapSource = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

function extractMethodBody(tsSource, methodName) {
    const marker = new RegExp(`(?:private|public|protected|static)\\s+(?:async\\s+)?${methodName}\\s*\\(`);
    const match = marker.exec(tsSource);
    if (!match) { throw new Error(`Method '${methodName}' not found`); }
    let parenDepth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < tsSource.length; i++) {
        if (tsSource[i] === '(') parenDepth++;
        if (tsSource[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) { i++; break; }
        }
    }
    // Skip a return-type annotation: the body's `{` is the first one at
    // angle-bracket depth 0. Without this, a signature like
    // `Promise<{ a: string } | undefined>` hands back the RETURN TYPE's object
    // literal instead of the method body, and every assertion against that
    // method silently tests the wrong text.
    let angle = 0;
    for (; i < tsSource.length; i++) {
        const ch = tsSource[i];
        if (ch === '<') { angle++; continue; }
        if (ch === '>') { if (angle > 0) angle--; continue; }
        if (ch === '{' && angle === 0) { break; }
    }
    let depth = 0;
    const bodyStart = i;
    for (let j = bodyStart; j < tsSource.length; j++) {
        const ch = tsSource[j];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) { return tsSource.slice(bodyStart, j + 1); }
    }
    throw new Error(`Method '${methodName}' closing brace not found`);
}

function run() {
    console.log('\n── Standalone fleet seam contract ──\n');

    // 1. Predicate implementation: exactly two ORed fields
    test('_hasFleet is exactly !!this._ptyHostPort || !!this._fleetVerb', () => {
        const body = extractMethodBody(taskViewerSource, '_hasFleet');
        assert.match(body, /return\s+!!this\._ptyHostPort\s*\|\|\s*!!this\._fleetVerb;/,
            '_hasFleet must return exactly !!this._ptyHostPort || !!this._fleetVerb');
    });

    test('hasPtyHost delegates to _hasFleet', () => {
        const body = extractMethodBody(taskViewerSource, 'hasPtyHost');
        assert.match(body, /return\s+this\._hasFleet\(\);/,
            'hasPtyHost must delegate to this._hasFleet()');
    });

    test('_ptyHostVerb routes to _fleetVerb fallback after standing orders', () => {
        const body = extractMethodBody(taskViewerSource, '_ptyHostVerb');
        assert.match(body, /this\._fleetVerb\(verb,\s*payload,\s*signal\)/,
            '_ptyHostVerb must invoke _fleetVerb fallback');
        assert.match(body, /applyStandingOrders\(/,
            '_ptyHostVerb must contain applyStandingOrders before routing');
    });

    // 2. Nine census sites check _hasFleet
    test('broadcastAgentCompleted uses _hasFleet for terminal resolution', () => {
        const body = extractMethodBody(taskViewerSource, 'broadcastAgentCompleted');
        assert.match(body, /this\._hasFleet\(\)/,
            'broadcastAgentCompleted must check this._hasFleet()');
    });

    // The miss branch used to be `if (this._hasFleet()) { return false; }` — a
    // decline. The sibling creation-policy subtask replaced the decline with a
    // fleet spawn in the same delivery, so the predicate is pinned here but the
    // decline literal deliberately is NOT.
    test('sendPromptToAgentTerminal spawns in the fleet on the miss path', () => {
        const body = extractMethodBody(taskViewerSource, 'sendPromptToAgentTerminal');
        assert.match(body, /if\s*\(\s*this\._hasFleet\(\)\s*\)\s*\{/,
            'sendPromptToAgentTerminal must branch on this._hasFleet()');
        assert.match(body, /createFleetTerminalAndDeliver\(/,
            'the _hasFleet() branch must spawn in the fleet, not return false');
        assert.doesNotMatch(body, /if\s*\(\s*this\._ptyHostPort\s*\)/,
            'sendPromptToAgentTerminal must not read the child-process port as a fleet predicate');
    });

    test('_isTerminalLive checks _hasFleet', () => {
        const body = extractMethodBody(taskViewerSource, '_isTerminalLive');
        assert.match(body, /if\s*\(\s*this\._hasFleet\(\)\s*\)/,
            '_isTerminalLive must check this._hasFleet()');
    });

    test('_resolveExactAgentTerminalForPlan checks _hasFleet for role resolution', () => {
        const body = extractMethodBody(taskViewerSource, '_resolveExactAgentTerminalForPlan');
        assert.match(body, /this\._hasFleet\(\)/,
            '_resolveExactAgentTerminalForPlan must check this._hasFleet()');
    });

    test('_resolveDelegateIdentityForTarget checks _hasFleet', () => {
        const body = extractMethodBody(taskViewerSource, '_resolveDelegateIdentityForTarget');
        assert.match(body, /!this\._hasFleet\(\)/,
            '_resolveDelegateIdentityForTarget must short-circuit on !this._hasFleet()');
    });

    test('_isLikelyPtyDispatchTarget guards on _hasFleet', () => {
        const body = extractMethodBody(taskViewerSource, '_isLikelyPtyDispatchTarget');
        assert.match(body, /if\s*\(!this\._hasFleet\(\)\)\s*\{\s*return\s+false;\s*\}/,
            '_isLikelyPtyDispatchTarget must return false on !this._hasFleet()');
    });

    test('_tryFleetDeliveryForRole guards on _hasFleet', () => {
        const body = extractMethodBody(taskViewerSource, '_tryFleetDeliveryForRole');
        assert.match(body, /if\s*\(!this\._hasFleet\(\)\)\s*\{\s*return\s+false;\s*\}/,
            '_tryFleetDeliveryForRole must return false on !this._hasFleet()');
    });

    test('_attemptDirectTerminalPush guards on _hasFleet', () => {
        const body = extractMethodBody(taskViewerSource, '_attemptDirectTerminalPush');
        assert.match(body, /if\s*\(\s*this\._hasFleet\(\)\s*\)/,
            '_attemptDirectTerminalPush must check this._hasFleet()');
    });

    // 3. Standalone bootstrap registers fleet verb seam
    test('bootstrap.ts wires setFleetVerb only for an available fleet', () => {
        assert.match(bootstrapSource, /if\s*\(ptyReady\)\s*\{\s*taskViewerProvider\.setFleetVerb\(/,
            'bootstrap.ts must call taskViewerProvider.setFleetVerb only when ptyReady');
        assert.match(bootstrapSource, /handlePtyVerb\(verb,\s*payload,\s*workspaceRoot\)/,
            'bootstrap.ts setFleetVerb must route to handlePtyVerb with 3 arguments');
    });

    // 4. Kept extension-only sites retain _ptyHostPort
    // The plan's census predicted this arm still read `_ptyHostPort`; it has read
    // `_hasFleet()` since before this change. Either predicate is correct here —
    // standalone never reaches this arm (bootstrap registers
    // setAgentGroupInstantiator and drives ptyFleetService directly) — so pin
    // what the code actually does rather than the census's prediction.
    test('instantiateAgentGroup refuses when no fleet is reachable', () => {
        const body = extractMethodBody(taskViewerSource, 'instantiateAgentGroup');
        assert.match(body, /if\s*\(!this\._hasFleet\(\)\)\s*\{/,
            'instantiateAgentGroup must refuse when no fleet is reachable');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
