'use strict';

/**
 * Contract: the four stray _dispatchExecuteMessage call sites (Mission Control
 * kickoff/wake, pair-programming coder, airlock send-to-coder) must be
 * host-derived (no apiOriginated flag). Mission Control no longer remembers
 * a starting surface — fleet consultation is unconditional via _ptyHostPort.
 *
 * (browser-stray-dispatch-sites-hardcode-vscode-fleet.md)
 *
 * Source-text contract: the failure mode is a silent dead-on-arrival Mission Control
 * or an invisible VS Code toast, so we pin structure. Run with:
 *   node src/test/browser-stray-dispatch-surface.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASKVIEWER_PATH = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const KANBAN_PATH = path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts');
const EXTENSION_PATH = path.join(REPO_ROOT, 'src', 'extension.ts');

const taskViewerSource = fs.readFileSync(TASKVIEWER_PATH, 'utf8');
const kanbanSource = fs.readFileSync(KANBAN_PATH, 'utf8');
const extensionSource = fs.readFileSync(EXTENSION_PATH, 'utf8');

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
    const marker = new RegExp(`(?:private|public|protected)\\s+(?:async\\s+)?${methodName}\\s*\\(`);
    const match = marker.exec(tsSource);
    if (!match) { throw new Error(`Method '${methodName}' not found`); }
    let parenDepth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < tsSource.length; i++) {
        const ch = tsSource[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    }
    if (parenDepth !== 0) { throw new Error(`Method '${methodName}' parameter list not closed`); }
    const bodyStart = tsSource.indexOf('{', i);
    if (bodyStart < 0) { throw new Error(`Method '${methodName}' body not found`); }
    let depth = 0;
    for (let j = bodyStart; j < tsSource.length; j++) {
        const ch = tsSource[j];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) { return tsSource.slice(bodyStart, j + 1); }
    }
    throw new Error(`Method '${methodName}' closing brace not found`);
}

function run() {
    console.log('\n── Browser stray dispatch surface contract ──\n');

    // 1. _dispatchExecuteMessage no longer takes an allowPtyFleet sixth argument.
    //    The sixth slot is NOT free-for-all: it is pinned to the seat-safeguard
    //    composition marker (`promptComposed: boolean = false`) and nothing else.
    //    Anything else landing there — a resurrected allowPtyFleet, a new routing
    //    flag — fails here, which is the property the original "no sixth arg"
    //    assertion was protecting. The default MUST stay `false`: a call site
    //    added later then gets the seat directive block by omission rather than
    //    silently losing it.
    test('_dispatchExecuteMessage signature has no allowPtyFleet parameter', () => {
        const sigIdx = taskViewerSource.search(/private\s+async\s+_dispatchExecuteMessage\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 400);
        assert.doesNotMatch(sigRegion, /allowPtyFleet/,
            '_dispatchExecuteMessage must NOT declare an allowPtyFleet parameter.');
        assert.match(sigRegion, /sender:\s*string\s*=\s*'sidebar',\s*promptComposed:\s*boolean\s*=\s*false\s*\)/,
            '_dispatchExecuteMessage must end at sender + promptComposed: boolean = false — no other sixth arg, ' +
            'and the marker must default to false so a new call site gains the seat block rather than losing it.');
    });

    // 2. _missionControlApiOriginated is gone.
    test('_missionControlApiOriginated field is fully removed', () => {
        assert.doesNotMatch(taskViewerSource, /_missionControlApiOriginated/,
            '_missionControlApiOriginated must be fully removed from TaskViewerProvider.');
    });

    test('Mission Control kickoff reports a failed delivery instead of a silent dead-on-arrival run', () => {
        const startBody = extractMethodBody(taskViewerSource, 'startMissionControlFromKanban');
        assert.match(startBody, /const\s+kickoffSent\s*=\s*await\s+this\._dispatchExecuteMessage\(/,
            'kickoff dispatch must capture its result.');
        assert.doesNotMatch(startBody, /_missionControlApiOriginated/,
            'kickoff dispatch must NOT reference _missionControlApiOriginated.');
        assert.match(startBody, /if\s*\(!kickoffSent\)\s*\{[\s\S]*?missionControlStartResult[\s\S]*?success:\s*false/,
            'kickoff must post missionControlStartResult { success: false } when delivery failed.');
    });

    // 3. dispatchToCoderTerminal signature + return.
    test('dispatchToCoderTerminal has no apiOriginated, returns Promise<boolean>', () => {
        const sigIdx = taskViewerSource.search(/public\s+async\s+dispatchToCoderTerminal\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 400);
        assert.doesNotMatch(sigRegion, /apiOriginated/,
            'dispatchToCoderTerminal must NOT declare an apiOriginated parameter.');
        assert.match(sigRegion, /:\s*Promise<boolean>/,
            'dispatchToCoderTerminal must return Promise<boolean>.');
        const body = extractMethodBody(taskViewerSource, 'dispatchToCoderTerminal');
        assert.match(body, /_resolveAgentTerminalForPlan\(\s*'coder',\s*workspaceRoot,\s*worktreePath\s*\)/,
            'dispatchToCoderTerminal must pass 3 args to _resolveAgentTerminalForPlan (no allowPtyFleet).');
        assert.match(body, /return\s+false/,
            'dispatchToCoderTerminal must return false on resolution miss (honest failure).');
        // extension.ts no longer forwards options.
        const start = extensionSource.indexOf("'switchboard.dispatchToCoderTerminal'");
        const region = extensionSource.slice(start, start + 800);
        assert.doesNotMatch(region, /apiOriginated/,
            'extension.ts dispatchToCoderTerminal command must NOT accept or forward apiOriginated.');
    });

    // 4. Airlock arm.
    test('airlock arm passes workspaceRoot to _getAgentNameForRole and gates airlock_coderSent on delivery', () => {
        const body = extractMethodBody(taskViewerSource, '_handleAirlockSendToCoder');
        assert.match(body, /_getAgentNameForRole\(\s*'coder',\s*workspaceRoot\s*\)/,
            '_handleAirlockSendToCoder must pass workspaceRoot to _getAgentNameForRole (no allowPtyFleet).');
        assert.match(body, /const\s+sent\s*=\s*await\s+this\._dispatchExecuteMessage\(/,
            'airlock dispatch must capture the result.');
        assert.doesNotMatch(body, /allowPtyFleet/,
            'airlock dispatch must NOT pass allowPtyFleet.');
        assert.match(body, /if\s*\(!sent\)\s*\{[\s\S]*?airlock_coderError/,
            'airlock must post airlock_coderError (not airlock_coderSent) when delivery failed.');
        // The arm call site no longer forwards the flag.
        assert.match(taskViewerSource, /airlock_sendToCoder'[\s\S]{0,120}?_handleAirlockSendToCoder\(\s*data\.text\s*\)/,
            "the airlock_sendToCoder arm must call _handleAirlockSendToCoder(data.text) with no options.");
    });

    // 5. _dispatchWithPairProgrammingIfNeeded + all call sites.
    test('_dispatchWithPairProgrammingIfNeeded has no apiOriginated and every call site uses 2-arg form', () => {
        const sigIdx = kanbanSource.search(/private\s+async\s+_dispatchWithPairProgrammingIfNeeded\s*\(/);
        const sigRegion = kanbanSource.slice(sigIdx, sigIdx + 400);
        assert.doesNotMatch(sigRegion, /apiOriginated/,
            '_dispatchWithPairProgrammingIfNeeded must NOT declare an apiOriginated parameter.');
        const body = extractMethodBody(kanbanSource, '_dispatchWithPairProgrammingIfNeeded');
        assert.match(body, /executeCommand\(\s*'switchboard\.dispatchToCoderTerminal',\s*coderPrompt,\s*worktreePath\s*\)/,
            '_dispatchWithPairProgrammingIfNeeded must call dispatchToCoderTerminal with 2 args (no options).');
        // Every call site must use the 2-arg form — none passes apiOriginated.
        const callRe = /_dispatchWithPairProgrammingIfNeeded\(/g;
        let m;
        let sites = 0;
        while ((m = callRe.exec(kanbanSource)) !== null) {
            const prefix = kanbanSource.slice(Math.max(0, m.index - 40), m.index);
            if (/private\s+async\s+_dispatchWithPairProgrammingIfNeeded/.test(prefix + kanbanSource.slice(m.index, m.index + 40))) { continue; }
            sites++;
            const window = kanbanSource.slice(m.index, m.index + 300);
            assert.doesNotMatch(window, /apiOriginated/,
                `call site #${sites} must NOT pass apiOriginated (host-derived policy).`);
        }
        assert.ok(sites >= 9, `expected >= 9 _dispatchWithPairProgrammingIfNeeded call sites, found ${sites}.`);
    });

    // 6. No apiOriginated remains in TaskViewerProvider (except the one comment).
    test('no apiOriginated parameter or variable remains in TaskViewerProvider', () => {
        // The only allowed match is the comment at the creation policy.
        const matches = taskViewerSource.match(/apiOriginated/g) || [];
        assert.ok(matches.length <= 1, `expected at most 1 apiOriginated reference (a comment), found ${matches.length}.`);
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
