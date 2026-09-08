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

const PROJECTION_PATH = path.join(REPO_ROOT, 'src', 'services', 'goPtyFleetProjection.ts');

const taskViewerSource = fs.readFileSync(TASKVIEWER_PATH, 'utf8');
const bootstrapSource = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
const projectionSource = fs.readFileSync(PROJECTION_PATH, 'utf8');

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

    // 5. The terminalsChanged push seam — BOTH hosts.
    //
    // The fleet moved into the Go PTY host child and its notifications did not
    // come with it: the only broadcaster was the retired terminalWsGateway.ts,
    // which nothing constructs, so no production path pushed terminalsChanged in
    // either host. The 5s terminals.js fleet poll stood in for it, which is why a
    // completely dead push presented as sluggishness rather than a break. That
    // poll is now deleted, so these seams are load-bearing.
    //
    // STATIC WIRING ONLY. These assert the emitter, the subscription, the
    // broadcast and the surface tag exist and are joined up. They cannot prove a
    // push ARRIVES at a subscribed client — that needs a live hub subscription.

    test('bootstrap.ts subscribes to the fleet projection and broadcasts terminalsChanged', () => {
        assert.match(bootstrapSource, /ptyFleetService\.onDidChange\(/,
            'bootstrap.ts must subscribe to GoPtyFleetProjection.onDidChange');
        assert.equal((bootstrapSource.match(/ptyFleetService\.onDidChange\(/g) || []).length, 1,
            'exactly one onDidChange subscription — a second would double-push every fleet change');
        const sub = bootstrapSource.slice(bootstrapSource.indexOf('ptyFleetService.onDidChange('));
        const body = sub.slice(0, sub.indexOf('\n    });') + 8);
        assert.match(body, /broadcastWs\('terminalsChanged',\s*\{\}?,?\s*[^)]*SURFACES\.terminals\)/,
            'the subscription must broadcast terminalsChanged tagged SURFACES.terminals, not to every surface');
        assert.match(body, /setTimeout\(/,
            'the broadcast must be debounced — a team start fires several creates in ~200ms');
        assert.match(body, /clearTimeout\(/,
            'the debounce must be trailing-edge (clear-and-reset), so the LAST change still pushes');
    });

    test('the fleet projection emits a change on natural CLI exit, not only on kill()', () => {
        // kill() emits {type:'closed'} itself; a CLI that exits on its own only
        // reaches the {"t":"exit"} arm of attachLiveStream. Without an emit there,
        // the seat reads active until something else refetches — and with the poll
        // gone, nothing does.
        const exitArm = projectionSource.slice(projectionSource.indexOf("message.t === 'exit'"));
        const arm = exitArm.slice(0, 2000);
        assert.match(arm, /this\.emitter\.emit\('change',\s*\{\s*type:\s*'closed'/,
            "the {\"t\":\"exit\"} handler must emit a 'closed' fleet change");
        assert.ok(!/if\s*\(\s*this\.cache\.has\(name\)\s*\)[^\n]*\n?[^\n]*emitter\.emit/.test(arm),
            'the exit emit must NOT be guarded on cache membership — kill() deletes from cache before the socket closes');
    });

    test('the extension host pushes terminalsChanged at _ptyHostVerb, not only at the verb wrapper', () => {
        // handlePtyVerb is the HTTP/webview wrapper, and half the extension host's
        // fleet mutations never reach it: ptyStartTeam returns from
        // startTeamForWorkspace before it, and the autoban create, the team
        // head/delegate creates and the dispatch-time create all call _ptyHostVerb
        // directly. _ptyHostVerb is the ONE chokepoint (its own docblock: "the
        // ONLY way the extension reaches the fleet"), so the push belongs there.
        const body = extractMethodBody(taskViewerSource, '_ptyHostVerb');
        assert.match(body, /TERMINAL_MUTATION_VERBS\.has\(verb\)/,
            '_ptyHostVerb must gate the push on the roster-mutating verb set');
        assert.match(body, /_scheduleTerminalsChangedPush\(\)/,
            '_ptyHostVerb must schedule the terminalsChanged push');
        assert.match(body, /result\.success !== false/,
            'the push must be gated on a non-failing result — a rejected verb changed nothing');
        for (const verb of ['ptyCreateTerminal', 'ptyCreateBatch', 'ptyCloseTerminal', 'ptyRenameTerminal']) {
            assert.ok(new RegExp(`'${verb}'`).test(taskViewerSource.slice(
                taskViewerSource.indexOf('const TERMINAL_MUTATION_VERBS'),
                taskViewerSource.indexOf('const TERMINALS_CHANGED_PUSH_DEBOUNCE_MS'))),
                `${verb} must be in TERMINAL_MUTATION_VERBS`);
        }
        const push = extractMethodBody(taskViewerSource, '_scheduleTerminalsChangedPush');
        assert.match(push, /clearTimeout\(this\._terminalsChangedPushTimer\)/,
            'the push must be trailing-edge debounced (clear-and-reset)');
        assert.match(push, /push\(\{\s*type:\s*'terminalsChanged'\s*\},\s*SURFACES\.terminals\)/,
            'the push must be tagged SURFACES.terminals, not broadcast to every surface');
    });

    test('the 5s fleet poll is gone from terminals.js', () => {
        // The poll is what let a dead push read as slowness. Pinned as an absence
        // in both this suite and shell-agent-dock.test.js: reintroducing it
        // restores the camouflage for the next notification someone forgets to wire.
        const terminalsJs = fs.readFileSync(
            path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        assert.ok(!/startFleetPoll|stopFleetPoll|fleetPollTimer/.test(terminalsJs),
            'terminals.js must have no fleet poll — the terminalsChanged push replaced it');
        assert.match(terminalsJs, /message\.type === 'terminalsChanged'/,
            'terminals.js must still consume the terminalsChanged push');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
