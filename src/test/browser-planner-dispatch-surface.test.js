'use strict';

/**
 * Contract: browser-originated "Send to Planner"-family buttons must thread the
 * apiOriginated surface flag end-to-end so a browser PTY planner is reachable,
 * and the failure path must return the prompt in the reply body so the browser
 * clipboard fallback is real (not the extension host's clipboard).
 *
 * (browser-send-to-planner-drops-surface-flag.md)
 *
 * Source-text contract: the failure mode is a silent wrong-fleet dispatch and a
 * no-op clipboard fallback, neither of which throws, so we pin structure.
 * Run with: node src/test/browser-planner-dispatch-surface.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASKVIEWER_PATH = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const PLANNING_PATH = path.join(REPO_ROOT, 'src', 'services', 'PlanningPanelProvider.ts');
const KANBAN_PATH = path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts');
const EXTENSION_PATH = path.join(REPO_ROOT, 'src', 'extension.ts');

const taskViewerSource = fs.readFileSync(TASKVIEWER_PATH, 'utf8');
const planningSource = fs.readFileSync(PLANNING_PATH, 'utf8');
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

/**
 * Extract a method body by signature marker, brace-matched (mirrors the helper
 * in pty-dispatch-focus-contract.test.js).
 */
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
    console.log('\n── Browser planner dispatch surface contract ──\n');

    // 1. dispatchCustomPromptToRole declares an options parameter and derives
    //    allowPtyFleet from options?.apiOriginated.
    test('dispatchCustomPromptToRole declares options?: { apiOriginated?: boolean }', () => {
        assert.match(
            taskViewerSource,
            /public\s+async\s+dispatchCustomPromptToRole\([\s\S]*?options\?\s*:\s*\{\s*apiOriginated\?\s*:\s*boolean\s*\}/,
            'dispatchCustomPromptToRole must declare a trailing options?: { apiOriginated?: boolean } parameter.'
        );
    });

    test('allowPtyFleet is derived as !!options?.apiOriginated (fail-closed)', () => {
        const body = extractMethodBody(taskViewerSource, 'dispatchCustomPromptToRole');
        assert.match(body, /const\s+allowPtyFleet\s*=\s*!!options\?\.apiOriginated/,
            'allowPtyFleet must be derived as !!options?.apiOriginated.');
        // Reject a literal true default — that would let sidebar dispatches land in a PTY.
        assert.doesNotMatch(body, /allowPtyFleet\s*=\s*true/,
            'allowPtyFleet must NOT default to a literal true (fail-closed invariant).');
    });

    test('dispatchCustomPromptToRole forwards allowPtyFleet to resolution and delivery', () => {
        const body = extractMethodBody(taskViewerSource, 'dispatchCustomPromptToRole');
        assert.match(body, /_resolveAgentTerminalForPlan\(\s*role,\s*resolvedWorkspaceRoot,\s*undefined,\s*allowPtyFleet\s*\)/,
            'must pass allowPtyFleet as the fourth argument to _resolveAgentTerminalForPlan.');
        assert.match(body, /_dispatchExecuteMessage\(\s*resolvedWorkspaceRoot,\s*targetAgent,\s*prompt,\s*\{\},\s*'sidebar',\s*allowPtyFleet\s*\)/,
            'must pass allowPtyFleet as the sixth argument to _dispatchExecuteMessage.');
        assert.match(body, /_isLikelyPtyDispatchTarget\(\s*targetAgent,\s*allowPtyFleet\s*\)/,
            'must guard the focus call with _isLikelyPtyDispatchTarget(targetAgent, allowPtyFleet).');
    });

    // 3. All eight call sites pass an apiOriginated value (none calls the 3-arg form).
    test('every dispatchCustomPromptToRole call site passes an apiOriginated value', () => {
        const sources = [taskViewerSource, planningSource, kanbanSource];
        let total = 0;
        for (const src of sources) {
            // Match call sites (not the definition) — a call has no `async` before it.
            const calls = src.match(/dispatchCustomPromptToRole\(/g) || [];
            // Subtract the definition occurrence in taskViewerSource.
            total += calls.length;
        }
        // Subtract 1 for the `public async dispatchCustomPromptToRole(` definition.
        const callSites = total - 1;
        assert.ok(callSites >= 8, `expected at least 8 call sites, found ${callSites}.`);
        // No call site may use the bare 3-arg form: 'planner'|'lead', prompt, root )
        // immediately closed. A 3-arg call ends with the root arg then `)` on the
        // same or next line with no options object. We assert every call site passes
        // an apiOriginated-bearing options object.
        const allSrc = [taskViewerSource, planningSource, kanbanSource].join('\n');
        // Find each call site region and assert it contains apiOriginated.
        const re = /dispatchCustomPromptToRole\([\s\S]{0,200}?\)/g;
        let m;
        let checked = 0;
        while ((m = re.exec(allSrc)) !== null) {
            // Skip the definition (it spans the whole signature + body — too long).
            if (m[0].includes('public async')) { continue; }
            if (m[0].length > 180) { continue; } // definition body, not a call
            assert.ok(/apiOriginated/.test(m[0]),
                `call site must pass apiOriginated: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
            checked++;
        }
        assert.ok(checked >= 8, `checked ${checked} call sites, expected >= 8.`);
    });

    // 4. The memo failure body carries `prompt`, and the success body does not.
    test('memoGeneratePrompt failure body carries prompt; success body does not', () => {
        // The memo return spreads prompt only when !sendSucceeded.
        assert.match(
            taskViewerSource,
            /\.\.\.\(sendSucceeded\s*\?\s*\{\}\s*:\s*\{\s*error:\s*msg,\s*prompt\s*\}\s*\)/,
            'memo return must spread { error, prompt } ONLY on failure (sendSucceeded ? {} : { error, prompt }).'
        );
    });

    // Tickets command boundary: extension.ts must forward apiOriginated explicitly.
    test('extension.ts askAgentTask registration forwards apiOriginated across the command boundary', () => {
        const start = extensionSource.indexOf("'switchboard.askAgentTask'");
        const region = extensionSource.slice(start, start + 1200);
        assert.match(region, /apiOriginated\?\s*:\s*boolean/,
            'askAgentTask command payload type must include apiOriginated?.');
        assert.match(region, /apiOriginated:\s*!!data\.apiOriginated/,
            'askAgentTask must forward apiOriginated: !!data.apiOriginated (the boundary destructures field-by-field).');
    });

    test('askAgentTask method accepts and forwards apiOriginated', () => {
        // Assert against the signature region (params + return type live before the body `{`).
        const sigIdx = taskViewerSource.search(/public\s+async\s+askAgentTask\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 600);
        assert.match(sigRegion, /apiOriginated\?\s*:\s*boolean/,
            'askAgentTask data type must include apiOriginated?.');
        const body = extractMethodBody(taskViewerSource, 'askAgentTask');
        assert.match(body, /dispatchCustomPromptToRole\([\s\S]*?apiOriginated:\s*!!data\.apiOriginated/,
            'askAgentTask must forward apiOriginated to dispatchCustomPromptToRole.');
        // The VS Code-only pre-check (_getAgentNameForRole before dispatch) must be gone.
        assert.doesNotMatch(body, /if\s*\(!agentName\)\s*\{[\s\S]*?showWarningMessage\('No planner agent found/,
            'askAgentTask must NOT keep the stale VS Code-only pre-check that reported "no planner" for a PTY planner.');
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
