'use strict';

/**
 * Contract: the four direct-to-vscode.Terminal helpers must be fleet-aware,
 * must NOT conjure a VS Code terminal when a PTY fleet is available, must
 * report honest success/failure. Host-derived creation policy: the fleet
 * gate replaces the old apiOriginated flag.
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

    // 1. _tryFleetDeliveryForRole: guards on _ptyHostPort and delivers via _dispatchExecuteMessage.
    test('_tryFleetDeliveryForRole guards on _hasFleet and delivers via _dispatchExecuteMessage', () => {
        const body = extractMethodBody(taskViewerSource, '_tryFleetDeliveryForRole');
        assert.match(body, /if\s*\(!this\._hasFleet\(\)\)\s*\{\s*return\s+false;\s*\}/,
            '_tryFleetDeliveryForRole must short-circuit when !this._hasFleet().');
        // The guard moved one level down, so pin _hasFleet() itself:
        // returns true if either the child host port or the injected fleet verb is present.
        const hasFleet = extractMethodBody(taskViewerSource, '_hasFleet');
        assert.match(hasFleet, /return\s+!!this\._ptyHostPort\s*\|\|\s*!!this\._fleetVerb;/,
            '_hasFleet() must return !!this._ptyHostPort || !!this._fleetVerb.');
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
    //    delegate to createFleetTerminalAndDeliver when a fleet is available (hasPtyHost / _hasFleet).
    test('_sendPromptToTerminal returns Promise<boolean> and delegates to fleet spawn when fleet is available', () => {
        const sigIdx = planningSource.search(/private\s+async\s+_sendPromptToTerminal\s*\(/);
        const sigRegion = planningSource.slice(sigIdx, sigIdx + 400);
        assert.match(sigRegion, /:\s*Promise<boolean>/,
            '_sendPromptToTerminal must return Promise<boolean>.');
        const body = extractMethodBody(planningSource, '_sendPromptToTerminal');
        // hasPtyHost() is kept as the branch selector (retained literal from prior decline policy)
        assert.match(body, /hasPtyHost\(\)/,
            '_sendPromptToTerminal must check hasPtyHost() before creating a VS Code terminal.');
        assert.match(body, /createFleetTerminalAndDeliver\(/,
            '_sendPromptToTerminal must call createFleetTerminalAndDeliver when fleet is available.');
        // Tries fleet first.
        assert.match(body, /tryFleetDeliveryForRole\(/,
            '_sendPromptToTerminal must try the fleet first.');
    });

    test('sendPromptToAgentTerminal returns Promise<boolean> and delegates to fleet spawn when fleet is available', () => {
        const sigIdx = taskViewerSource.search(/public\s+async\s+sendPromptToAgentTerminal\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 400);
        assert.match(sigRegion, /:\s*Promise<boolean>/,
            'sendPromptToAgentTerminal must return Promise<boolean>.');
        const body = extractMethodBody(taskViewerSource, 'sendPromptToAgentTerminal');
        assert.match(body, /if\s*\(\s*this\._hasFleet\(\)\s*\)/,
            'sendPromptToAgentTerminal must check this._hasFleet() before creating a VS Code terminal.');
        assert.match(body, /createFleetTerminalAndDeliver\(/,
            'sendPromptToAgentTerminal must call createFleetTerminalAndDeliver when fleet is available.');
        assert.match(body, /_tryFleetDeliveryForRole\(/,
            'sendPromptToAgentTerminal must try the fleet first.');
        // The editor cold-terminal creation waits must survive (2000ms/3000ms).
        assert.match(body, /setTimeout\(r,\s*2000\)/,
            'sendPromptToAgentTerminal must keep the 2000ms spawn settle for editor callers.');
        assert.match(body, /setTimeout\(r,\s*3000\)/,
            'sendPromptToAgentTerminal must keep the 3000ms startup-command settle for editor callers.');
    });

    test('createFleetTerminalAndDeliver public seam exists and conforms to startup-command contract', () => {
        assert.match(taskViewerSource, /public\s+async\s+createFleetTerminalAndDeliver\(/,
            'a public createFleetTerminalAndDeliver wrapper must exist for PlanningPanelProvider to reach.');
        const body = extractMethodBody(taskViewerSource, 'createFleetTerminalAndDeliver');
        assert.match(body, /_ptyHostVerb\('ptyCreateTerminal'/,
            'createFleetTerminalAndDeliver must issue ptyCreateTerminal.');
        assert.match(body, /_dispatchExecuteMessage\(/,
            'createFleetTerminalAndDeliver must deliver prompt via _dispatchExecuteMessage.');
        assert.match(body, /GlobalIntegrationConfigService\.getAgentStartupCommands\(\)/,
            'createFleetTerminalAndDeliver must check GlobalIntegrationConfigService startup commands.');
        assert.match(body, /getAgentStartupCommand\(/,
            'createFleetTerminalAndDeliver must check getAgentStartupCommand.');
        assert.match(body, /setTimeout\(r,\s*750\)/,
            'createFleetTerminalAndDeliver must wait 750ms shell readiness delay before sending top-up command.');
        assert.match(body, /setTimeout\(r,\s*3000\)/,
            'createFleetTerminalAndDeliver must wait 3000ms settle after startup command.');
    });

    // 3. No DesignPanelProvider send arm returns a bare { success: true } after
    //    awaiting sendPromptToAgentTerminal.
    const sendArms = ['sendStitchTweakPrompt', 'sendHtmlTweakPrompt', 'sendClaudeImportPrompt', 'sendClaudeArtifactPrompt'];
    for (const arm of sendArms) {
        test(`DesignPanelProvider ${arm} propagates the real result (no bare success:true)`, () => {
            const caseMarker = new RegExp(`case\\s+'${arm}'\\s*:\\s*\\{`);
            const idx = designSource.search(caseMarker);
            assert.ok(idx >= 0, `case '${arm}' must exist in DesignPanelProvider.`);
            const region = designSource.slice(idx, idx + 900);
            assert.match(region, /sendPromptToAgentTerminal\(/,
                `${arm} must call sendPromptToAgentTerminal.`);
            // The arm must branch on the delivery result — no unconditional return { success: true }.
            assert.match(region, /if\s*\(\s*!?sent\s*\)/,
                `${arm} must branch on the delivery result (if (sent) / if (!sent)).`);
            assert.match(region, /success:\s*false,\s*error:[\s\S]*?prompt/,
                `${arm} failure body must carry both error and prompt.`);
        });
    }

    // 4. Failure returns carry error + prompt; success returns do not carry prompt.
    test('PlanningPanelProvider builder arms carry prompt only on failure', () => {
        const idx = planningSource.indexOf("case 'invokePrdBuilder':");
        const region = planningSource.slice(idx, idx + 1200);
        assert.match(region, /if\s*\(\s*!?sent\s*\)/, 'invokePrdBuilder must branch on the delivery result.');
        assert.match(region, /return\s*\{\s*success:\s*false,\s*error:[\s\S]*?prompt:\s*promptText\s*\}/,
            'invokePrdBuilder failure must return { success: false, error, prompt: promptText }.');
        assert.match(region, /return\s*\{\s*success:\s*true\s*\}/,
            'invokePrdBuilder success must return { success: true } with NO prompt field.');
    });

    // 5. No apiOriginated parameter remains on the helper signatures.
    test('no helper accepts an apiOriginated parameter (host-derived policy)', () => {
        const bodies = [
            extractMethodBody(planningSource, '_sendPromptToTerminal'),
            extractMethodBody(taskViewerSource, 'sendPromptToAgentTerminal'),
            extractMethodBody(taskViewerSource, '_tryFleetDeliveryForRole'),
            extractMethodBody(taskViewerSource, '_deliverPromptToPmTerminal'),
            extractMethodBody(taskViewerSource, '_handleSendAnalystMessage'),
        ];
        for (const body of bodies) {
            // Strip comments before checking — comments may reference the old flag name.
            const stripped = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            assert.doesNotMatch(stripped, /apiOriginated/,
                'no helper may reference apiOriginated in code (host-derived policy replaces it).');
        }
    });

    // 6. _stampHttpSurface is gone — no verb-rail handler stamps it.
    test('no verb-rail handler in LocalApiServer stamps apiOriginated (_stampHttpSurface removed)', () => {
        assert.doesNotMatch(localApiSource, /_stampHttpSurface/,
            '_stampHttpSurface must be fully removed from LocalApiServer.');
    });

    // 7. _deliverPromptToPmTerminal and _handleSendAnalystMessage are fleet-aware.
    test('_deliverPromptToPmTerminal tries the fleet first and returns PmDeliveryResult', () => {
        const sigIdx = taskViewerSource.search(/private\s+async\s+_deliverPromptToPmTerminal\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 300);
        assert.match(sigRegion, /:\s*Promise<PmDeliveryResult>/, '_deliverPromptToPmTerminal must return Promise<PmDeliveryResult>.');
        const body = extractMethodBody(taskViewerSource, '_deliverPromptToPmTerminal');
        assert.match(body, /_tryFleetDeliveryForRole\(\s*'project_manager'/,
            '_deliverPromptToPmTerminal must try the fleet first for project_manager.');
    });

    test('_handleSendAnalystMessage tries the fleet first and threads root', () => {
        const body = extractMethodBody(taskViewerSource, '_handleSendAnalystMessage');
        assert.match(body, /_tryFleetDeliveryForRole\(\s*'analyst'/,
            '_handleSendAnalystMessage must try the fleet first for analyst.');
        assert.match(body, /_getAgentNameForRole\(\s*'analyst',\s*resolvedRoot\s*\)/,
            '_handleSendAnalystMessage must pass root to _getAgentNameForRole (no apiOriginated).');
        // The existing regression test invariant: no "inbox" word.
        assert.doesNotMatch(body, /inbox/i,
            '_handleSendAnalystMessage must not introduce the word "inbox" (analyst-direct-dispatch-regression test invariant).');
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
