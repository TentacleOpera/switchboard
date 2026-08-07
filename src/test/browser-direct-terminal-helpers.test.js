'use strict';

/**
 * Contract: the four direct-to-vscode.Terminal helpers must be fleet-aware, must
 * NOT conjure a VS Code terminal for a browser caller, must report honest
 * success/failure, and the design + setup verb rails must stamp apiOriginated.
 *
 * (browser-direct-terminal-helpers-not-fleet-aware.md)
 *
 * Source-text contract: the failure mode is a prompt landing in an invisible VS
 * Code terminal (or a created one) with a success body, so we pin structure.
 * Run with: node src/test/browser-direct-terminal-helpers.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASKVIEWER_PATH = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const PLANNING_PATH = path.join(REPO_ROOT, 'src', 'services', 'PlanningPanelProvider.ts');
const DESIGN_PATH = path.join(REPO_ROOT, 'src', 'services', 'DesignPanelProvider.ts');
const LOCALAPI_PATH = path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts');

const taskViewerSource = fs.readFileSync(TASKVIEWER_PATH, 'utf8');
const planningSource = fs.readFileSync(PLANNING_PATH, 'utf8');
const designSource = fs.readFileSync(DESIGN_PATH, 'utf8');
const localApiSource = fs.readFileSync(LOCALAPI_PATH, 'utf8');

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
    console.log('\n── Browser direct terminal helpers contract ──\n');

    // 1. _tryFleetDeliveryForRole: guards + delivers via _dispatchExecuteMessage.
    test('_tryFleetDeliveryForRole guards on apiOriginated && _ptyHostPort and delivers via _dispatchExecuteMessage', () => {
        const body = extractMethodBody(taskViewerSource, '_tryFleetDeliveryForRole');
        assert.match(body, /if\s*\(!apiOriginated\s*\|\|\s*!this\._ptyHostPort\)\s*\{\s*return\s+false;\s*\}/,
            '_tryFleetDeliveryForRole must short-circuit when !apiOriginated || !this._ptyHostPort.');
        assert.match(body, /_ptyHostVerb\('ptyListTerminals'/,
            '_tryFleetDeliveryForRole must authoritatively ask the fleet via ptyListTerminals.');
        assert.match(body, /_dispatchExecuteMessage\(/,
            '_tryFleetDeliveryForRole must deliver through _dispatchExecuteMessage (not a raw ptyWrite).');
        assert.doesNotMatch(body, /ptyWrite\(/,
            '_tryFleetDeliveryForRole must NOT hand-roll a ptyWrite (multi-line prompts would fragment).');
        // Public wrapper exists for cross-provider use.
        assert.match(taskViewerSource, /public\s+async\s+tryFleetDeliveryForRole\(/,
            'a public tryFleetDeliveryForRole wrapper must exist for PlanningPanelProvider to reach.');
    });

    // 2. _sendPromptToTerminal and sendPromptToAgentTerminal return boolean and
    //    guard terminal creation for browser callers.
    test('_sendPromptToTerminal returns Promise<boolean> and refuses to create a terminal for browser callers', () => {
        const sigIdx = planningSource.search(/private\s+async\s+_sendPromptToTerminal\s*\(/);
        const sigRegion = planningSource.slice(sigIdx, sigIdx + 400);
        assert.match(sigRegion, /:\s*Promise<boolean>/,
            '_sendPromptToTerminal must return Promise<boolean>.');
        const body = extractMethodBody(planningSource, '_sendPromptToTerminal');
        assert.match(body, /if\s*\(\s*apiOriginated\s*\)\s*\{\s*return\s+false;\s*\}/,
            '_sendPromptToTerminal must `if (apiOriginated) { return false; }` before creating a VS Code terminal.');
        // Tries fleet first for api-originated callers.
        assert.match(body, /tryFleetDeliveryForRole\(/,
            '_sendPromptToTerminal must try the fleet first for api-originated callers.');
    });

    test('sendPromptToAgentTerminal returns Promise<boolean> and refuses to create a terminal for browser callers', () => {
        const sigIdx = taskViewerSource.search(/public\s+async\s+sendPromptToAgentTerminal\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 400);
        assert.match(sigRegion, /:\s*Promise<boolean>/,
            'sendPromptToAgentTerminal must return Promise<boolean>.');
        const body = extractMethodBody(taskViewerSource, 'sendPromptToAgentTerminal');
        assert.match(body, /if\s*\(\s*apiOriginated\s*\)\s*\{\s*return\s+false;\s*\}/,
            'sendPromptToAgentTerminal must `if (apiOriginated) { return false; }` before creating a VS Code terminal.');
        assert.match(body, /_tryFleetDeliveryForRole\(/,
            'sendPromptToAgentTerminal must try the fleet first for api-originated callers.');
        // The editor cold-terminal creation waits must survive (2000ms/3000ms).
        assert.match(body, /setTimeout\(r,\s*2000\)/,
            'sendPromptToAgentTerminal must keep the 2000ms spawn settle for editor callers.');
        assert.match(body, /setTimeout\(r,\s*3000\)/,
            'sendPromptToAgentTerminal must keep the 3000ms startup-command settle for editor callers.');
    });

    // 3. No DesignPanelProvider send arm returns a bare { success: true } after
    //    awaiting sendPromptToAgentTerminal.
    const sendArms = ['sendStitchTweakPrompt', 'sendHtmlTweakPrompt', 'sendClaudeImportPrompt', 'sendClaudeArtifactPrompt'];
    for (const arm of sendArms) {
        test(`DesignPanelProvider ${arm} propagates the real result (no bare success:true)`, () => {
            // The arms are switch cases inside _handleMessage, not methods — extract by case marker.
            const caseMarker = new RegExp(`case\\s+'${arm}'\\s*:\\s*\\{`);
            const idx = designSource.search(caseMarker);
            assert.ok(idx >= 0, `case '${arm}' must exist in DesignPanelProvider.`);
            // Grab the case body up to the next `case ` or `}` at the switch level.
            const region = designSource.slice(idx, idx + 900);
            assert.match(region, /sendPromptToAgentTerminal\([\s\S]*?apiOriginated:\s*!!message\.apiOriginated/,
                `${arm} must pass { apiOriginated: !!message.apiOriginated } to sendPromptToAgentTerminal.`);
            // The arm must branch on the delivery result — no unconditional return { success: true }.
            assert.match(region, /if\s*\(\s*!?sent\s*\)/,
                `${arm} must branch on the delivery result (if (sent) / if (!sent)).`);
            assert.match(region, /success:\s*false,\s*error:[\s\S]*?prompt/,
                `${arm} failure body must carry both error and prompt.`);
        });
    }

    // 4. Failure returns carry error + prompt; success returns do not carry prompt.
    test('PlanningPanelProvider builder arms carry prompt only on failure', () => {
        // Each builder arm returns { success: false, error, prompt } on miss and
        // { success: true } on hit. Assert the pattern exists for invokePrdBuilder.
        const idx = planningSource.indexOf("case 'invokePrdBuilder':");
        const region = planningSource.slice(idx, idx + 1200);
        assert.match(region, /if\s*\(\s*!?sent\s*\)/, 'invokePrdBuilder must branch on the delivery result.');
        assert.match(region, /return\s*\{\s*success:\s*false,\s*error:[\s\S]*?prompt:\s*promptText\s*\}/,
            'invokePrdBuilder failure must return { success: false, error, prompt: promptText }.');
        assert.match(region, /return\s*\{\s*success:\s*true\s*\}/,
            'invokePrdBuilder success must return { success: true } with NO prompt field.');
    });

    // 5. Fail-closed: no options?.apiOriginated defaults to true.
    test('fail-closed: no helper defaults apiOriginated to a literal true', () => {
        const bodies = [
            extractMethodBody(planningSource, '_sendPromptToTerminal'),
            extractMethodBody(taskViewerSource, 'sendPromptToAgentTerminal'),
            extractMethodBody(taskViewerSource, '_tryFleetDeliveryForRole'),
            extractMethodBody(taskViewerSource, '_deliverPromptToPmTerminal'),
            extractMethodBody(taskViewerSource, '_handleSendAnalystMessage'),
        ];
        for (const body of bodies) {
            assert.doesNotMatch(body, /apiOriginated\s*=\s*true/,
                'no helper may default apiOriginated to a literal true (fail-closed invariant).');
        }
    });

    // 6. _handleDesignVerb and _handleSetupVerb both stamp; every verb-rail
    //    handler either stamps or is in the documented exclusion list.
    test('every verb-rail handler in LocalApiServer stamps apiOriginated (or is excluded by name)', () => {
        // Find every `private async _handle*Verb(` handler.
        const re = /private\s+async\s+_handle(\w+?)Verb\s*\(/g;
        let m;
        const excluded = ['Terminal']; // _handleTerminalVerb: pty control plane, no prompt dispatch
        while ((m = re.exec(localApiSource)) !== null) {
            const name = m[1];
            const body = extractMethodBody(localApiSource, `_handle${name}Verb`);
            if (excluded.includes(name)) {
                assert.doesNotMatch(body, /_stampHttpSurface/,
                    `_handle${name}Verb is in the exclusion list (pty control plane) and must NOT stamp.`);
                continue;
            }
            assert.match(body, /_stampHttpSurface\(/,
                `_handle${name}Verb must call _stampHttpSurface (the design/setup rails were the blocking gap).`);
        }
    });

    // 7. _deliverPromptToPmTerminal and _handleSendAnalystMessage are fleet-aware.
    test('_deliverPromptToPmTerminal tries the fleet first and returns boolean', () => {
        const sigIdx = taskViewerSource.search(/private\s+async\s+_deliverPromptToPmTerminal\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 300);
        assert.match(sigRegion, /:\s*Promise<boolean>/, '_deliverPromptToPmTerminal must return Promise<boolean>.');
        const body = extractMethodBody(taskViewerSource, '_deliverPromptToPmTerminal');
        assert.match(body, /_tryFleetDeliveryForRole\(\s*'project_manager'/,
            '_deliverPromptToPmTerminal must try the fleet first for project_manager.');
    });

    test('_handleSendAnalystMessage tries the fleet first and threads root + flag', () => {
        const body = extractMethodBody(taskViewerSource, '_handleSendAnalystMessage');
        assert.match(body, /_tryFleetDeliveryForRole\(\s*'analyst'/,
            '_handleSendAnalystMessage must try the fleet first for analyst.');
        assert.match(body, /_getAgentNameForRole\(\s*'analyst',\s*resolvedRoot,\s*apiOriginated\s*\)/,
            '_handleSendAnalystMessage must pass root + apiOriginated to _getAgentNameForRole.');
        // The existing regression test invariant: no "inbox" word.
        assert.doesNotMatch(body, /inbox/i,
            '_handleSendAnalystMessage must not introduce the word "inbox" (analyst-direct-dispatch-regression test invariant).');
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
