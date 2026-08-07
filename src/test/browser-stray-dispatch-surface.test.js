'use strict';

/**
 * Contract: the four stray _dispatchExecuteMessage call sites (orchestrator
 * kickoff/wake, pair-programming coder, airlock send-to-coder) must be
 * surface-aware, and the orchestrator's starting surface must be remembered on
 * run state so the timer-fired wake can read it.
 *
 * (browser-stray-dispatch-sites-hardcode-vscode-fleet.md)
 *
 * Source-text contract: the failure mode is a silent dead-on-arrival orchestrator
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

    // 1. Every _dispatchExecuteMessage call site passes six arguments (property
    //    over all sites + a >= 7 floor — never an equality, because the sibling
    //    plan adds an eighth site inside _tryFleetDeliveryForRole).
    test('every _dispatchExecuteMessage call site passes an explicit sixth argument', () => {
        // Match call sites: `_dispatchExecuteMessage(` not preceded by `async` (definition).
        const re = /this\._dispatchExecuteMessage\(/g;
        let m;
        let sites = 0;
        while ((m = re.exec(taskViewerSource)) !== null) {
            sites++;
            // Grab a generous window after the opening paren to capture all args.
            const window = taskViewerSource.slice(m.index, m.index + 600);
            // The call must contain the sixth-arg surface token. We assert the call
            // region contains either `allowPtyFleet`, `this._orchestratorApiOriginated`,
            // or a literal `true` (the fleet helper passes `true`). The key property:
            // no site ends at the 4th/5th arg with a bare `)` relying on the default.
            assert.ok(
                /allowPtyFleet|_orchestratorApiOriginated|\btrue\b/.test(window),
                `call site #${sites} must pass an explicit sixth argument (found region lacks a surface token).`
            );
        }
        assert.ok(sites >= 7, `expected >= 7 _dispatchExecuteMessage call sites, found ${sites}.`);
    });

    // 2. _orchestratorApiOriginated lifecycle.
    test('_orchestratorApiOriginated is initialised false, set at both start entry points, reset on stop, read at both dispatch sites', () => {
        assert.match(taskViewerSource, /private\s+_orchestratorApiOriginated\s*=\s*false/,
            '_orchestratorApiOriginated must be declared and initialised false (fail-closed default).');
        // Set at startOrchestratorFromKanban.
        const startBody = extractMethodBody(taskViewerSource, 'startOrchestratorFromKanban');
        assert.match(startBody, /this\._orchestratorApiOriginated\s*=\s*!!options\?\.apiOriginated/,
            'startOrchestratorFromKanban must set _orchestratorApiOriginated = !!options?.apiOriginated.');
        // Set at the LocalApiServer orchestrationStart callback (HTTP-only → literal true).
        assert.match(taskViewerSource, /orchestrationStart:\s*async\s*\(wsRoot\)\s*=>\s*\{[\s\S]*?startOrchestratorFromKanban\(\s*wsRoot,\s*undefined,\s*\{\s*apiOriginated:\s*true\s*\}\s*\)/,
            'the orchestrationStart callback must pass { apiOriginated: true } (HTTP-only path, no body to stamp).');
        // Reset on stop.
        const stopBody = extractMethodBody(taskViewerSource, 'stopOrchestratorFromKanban');
        assert.match(stopBody, /this\._orchestratorApiOriginated\s*=\s*false/,
            'stopOrchestratorFromKanban must reset _orchestratorApiOriginated = false.');
        // Read at both dispatch sites (kickoff + wake).
        assert.ok(
            (taskViewerSource.match(/_orchestratorApiOriginated/g) || []).length >= 5,
            '_orchestratorApiOriginated must be referenced at both dispatch sites (kickoff + wake) in addition to set/reset/init.'
        );
        // KanbanProvider startOrchestrator verb arm forwards the flag.
        assert.match(kanbanSource, /startOrchestratorFromKanban\(\s*workspaceRoot,\s*undefined,\s*\{\s*apiOriginated:\s*!!msg\?\.apiOriginated\s*\}\s*\)/,
            'KanbanProvider startOrchestrator verb arm must forward { apiOriginated: !!msg?.apiOriginated }.');
    });

    test('orchestrator kickoff reports a failed delivery instead of a silent dead-on-arrival run', () => {
        const startBody = extractMethodBody(taskViewerSource, 'startOrchestratorFromKanban');
        assert.match(startBody, /const\s+kickoffSent\s*=\s*await\s+this\._dispatchExecuteMessage\([\s\S]*?_orchestratorApiOriginated/,
            'kickoff dispatch must capture its result and pass _orchestratorApiOriginated.');
        assert.match(startBody, /if\s*\(!kickoffSent\)\s*\{[\s\S]*?orchestratorStartResult[\s\S]*?success:\s*false/,
            'kickoff must post orchestratorStartResult { success: false } when delivery failed.');
    });

    // 3. dispatchToCoderTerminal signature + return.
    test('dispatchToCoderTerminal declares options, returns Promise<boolean>, passes 4th arg to resolution', () => {
        const sigIdx = taskViewerSource.search(/public\s+async\s+dispatchToCoderTerminal\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 400);
        assert.match(sigRegion, /options\?\s*:\s*\{\s*apiOriginated\?\s*:\s*boolean\s*\}/,
            'dispatchToCoderTerminal must declare options?: { apiOriginated?: boolean }.');
        assert.match(sigRegion, /:\s*Promise<boolean>/,
            'dispatchToCoderTerminal must return Promise<boolean>.');
        const body = extractMethodBody(taskViewerSource, 'dispatchToCoderTerminal');
        assert.match(body, /_resolveAgentTerminalForPlan\(\s*'coder',\s*workspaceRoot,\s*worktreePath,\s*allowPtyFleet\s*\)/,
            'dispatchToCoderTerminal must pass allowPtyFleet as the fourth argument to _resolveAgentTerminalForPlan.');
        assert.match(body, /return\s+false/,
            'dispatchToCoderTerminal must return false on resolution miss (honest failure).');
        // extension.ts forwards the third argument.
        const start = extensionSource.indexOf("'switchboard.dispatchToCoderTerminal'");
        const region = extensionSource.slice(start, start + 800);
        assert.match(region, /options\?\s*:\s*\{\s*apiOriginated\?\s*:\s*boolean\s*\}/,
            'extension.ts dispatchToCoderTerminal command must accept and forward the options argument.');
    });

    // 4. Airlock arm.
    test('airlock arm passes workspaceRoot to _getAgentNameForRole and gates airlock_coderSent on delivery', () => {
        const body = extractMethodBody(taskViewerSource, '_handleAirlockSendToCoder');
        assert.match(body, /_getAgentNameForRole\(\s*'coder',\s*workspaceRoot,\s*allowPtyFleet\s*\)/,
            '_handleAirlockSendToCoder must pass workspaceRoot and allowPtyFleet to _getAgentNameForRole.');
        assert.match(body, /const\s+sent\s*=\s*await\s+this\._dispatchExecuteMessage\([\s\S]*?allowPtyFleet/,
            'airlock dispatch must capture the result and pass allowPtyFleet.');
        assert.match(body, /if\s*\(!sent\)\s*\{[\s\S]*?airlock_coderError/,
            'airlock must post airlock_coderError (not airlock_coderSent) when delivery failed.');
        // The arm call site forwards the flag.
        assert.match(taskViewerSource, /airlock_sendToCoder'[\s\S]{0,120}?_handleAirlockSendToCoder\(\s*data\.text,\s*\{\s*apiOriginated:\s*!!data\.apiOriginated\s*\}\s*\)/,
            "the airlock_sendToCoder arm must forward { apiOriginated: !!data.apiOriginated }.");
    });

    // 5. _dispatchWithPairProgrammingIfNeeded + all call sites.
    test('_dispatchWithPairProgrammingIfNeeded forwards the flag and every call site passes apiOriginated', () => {
        const sigIdx = kanbanSource.search(/private\s+async\s+_dispatchWithPairProgrammingIfNeeded\s*\(/);
        const sigRegion = kanbanSource.slice(sigIdx, sigIdx + 400);
        assert.match(sigRegion, /options\?\s*:\s*\{\s*apiOriginated\?\s*:\s*boolean\s*\}/,
            '_dispatchWithPairProgrammingIfNeeded must declare options?: { apiOriginated?: boolean }.');
        const body = extractMethodBody(kanbanSource, '_dispatchWithPairProgrammingIfNeeded');
        assert.match(body, /executeCommand\(\s*'switchboard\.dispatchToCoderTerminal',\s*coderPrompt,\s*worktreePath,\s*\{\s*apiOriginated:\s*!!options\?\.apiOriginated\s*\}\s*\)/,
            '_dispatchWithPairProgrammingIfNeeded must forward the flag as the third command argument.');
        // Every call site must pass an apiOriginated value — none uses the 2-arg form.
        const callRe = /_dispatchWithPairProgrammingIfNeeded\(/g;
        let m;
        let sites = 0;
        while ((m = callRe.exec(kanbanSource)) !== null) {
            // Skip the definition (it has `private async` before it).
            const prefix = kanbanSource.slice(Math.max(0, m.index - 40), m.index);
            if (/private\s+async\s+_dispatchWithPairProgrammingIfNeeded/.test(prefix + kanbanSource.slice(m.index, m.index + 40))) { continue; }
            sites++;
            const window = kanbanSource.slice(m.index, m.index + 300);
            assert.ok(/apiOriginated/.test(window),
                `call site #${sites} must pass { apiOriginated: ... } (2-arg form is the bug).`);
        }
        assert.ok(sites >= 9, `expected >= 9 _dispatchWithPairProgrammingIfNeeded call sites, found ${sites}.`);
    });

    // 6. Fail-closed: no options?.apiOriginated read defaults to a literal true,
    //    except the orchestrationStart callback (HTTP-only, allowlisted by name).
    test('fail-closed: only the orchestrationStart callback may pass a literal true', () => {
        // The orchestrationStart callback passing { apiOriginated: true } is the one
        // sanctioned exception. Assert it exists and is commented as HTTP-only.
        assert.match(taskViewerSource, /orchestrationStart:\s*async\s*\(wsRoot\)\s*=>\s*\{[\s\S]*?apiOriginated:\s*true\s*\}/,
            'the orchestrationStart callback is the sanctioned literal-true exception (HTTP-only path).');
        // No OTHER call site in TaskViewerProvider passes a bare { apiOriginated: true }.
        const re = /apiOriginated:\s*true/g;
        let m;
        while ((m = re.exec(taskViewerSource)) !== null) {
            const ctx = taskViewerSource.slice(Math.max(0, m.index - 400), m.index + 50);
            assert.ok(/orchestrationStart/.test(ctx),
                'a bare { apiOriginated: true } appears outside the orchestrationStart callback — only that HTTP-only path may use a literal true.');
        }
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
