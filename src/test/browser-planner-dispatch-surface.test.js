'use strict';

/**
 * Contract: browser-originated "Send to Planner"-family buttons must use
 * host-derived fleet resolution (no apiOriginated flag). The failure path
 * must return the prompt in the reply body so the browser clipboard fallback
 * is real (not the extension host's clipboard).
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

    // 1. dispatchCustomPromptToRole has no apiOriginated parameter.
    test('dispatchCustomPromptToRole has no apiOriginated parameter', () => {
        const sigIdx = taskViewerSource.search(/public\s+async\s+dispatchCustomPromptToRole\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 400);
        assert.doesNotMatch(sigRegion, /apiOriginated/,
            'dispatchCustomPromptToRole must NOT declare an apiOriginated parameter.');
        assert.match(sigRegion, /workspaceRoot:\s*string\s*\)/,
            'dispatchCustomPromptToRole must end at the workspaceRoot parameter (no options).');
    });

    test('dispatchCustomPromptToRole uses host-derived resolution (no allowPtyFleet)', () => {
        const body = extractMethodBody(taskViewerSource, 'dispatchCustomPromptToRole');
        assert.doesNotMatch(body, /allowPtyFleet/,
            'dispatchCustomPromptToRole must NOT reference allowPtyFleet.');
    });

    test('dispatchCustomPromptToRole forwards to resolution and delivery without allowPtyFleet', () => {
        const body = extractMethodBody(taskViewerSource, 'dispatchCustomPromptToRole');
        assert.match(body, /_resolveAgentTerminalForPlan\(\s*role,\s*resolvedWorkspaceRoot,\s*undefined\s*\)/,
            'must pass 3 args to _resolveAgentTerminalForPlan (no allowPtyFleet).');
        assert.match(body, /_dispatchExecuteMessage\(\s*resolvedWorkspaceRoot,\s*targetAgent,\s*prompt,\s*\{\},\s*'sidebar'\s*\)/,
            'must pass 5 args to _dispatchExecuteMessage (no allowPtyFleet).');
        assert.match(body, /_isLikelyPtyDispatchTarget\(\s*targetAgent\s*\)/,
            'must guard the focus call with _isLikelyPtyDispatchTarget(targetAgent) (1 arg).');
    });

    // 3. All call sites use the 3-arg form (no apiOriginated).
    test('every dispatchCustomPromptToRole call site uses the 3-arg form (no apiOriginated)', () => {
        const allSrc = [taskViewerSource, planningSource, kanbanSource].join('\n');
        const re = /dispatchCustomPromptToRole\([\s\S]{0,200}?\)/g;
        let m;
        let checked = 0;
        while ((m = re.exec(allSrc)) !== null) {
            if (m[0].includes('public async')) { continue; }
            if (m[0].length > 180) { continue; }
            assert.doesNotMatch(m[0], /apiOriginated/,
                `call site must NOT pass apiOriginated: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
            checked++;
        }
        assert.ok(checked >= 8, `checked ${checked} call sites, expected >= 8.`);
    });

    // 4. The memo failure body carries `prompt`, and the success body does not.
    test('memoGeneratePrompt failure body carries prompt; success body does not', () => {
        assert.match(
            taskViewerSource,
            /\.\.\.\(sendSucceeded\s*\?\s*\{\}\s*:\s*\{\s*error:\s*msg,\s*prompt\s*\}\s*\)/,
            'memo return must spread { error, prompt } ONLY on failure (sendSucceeded ? {} : { error, prompt }).'
        );
    });

    // Tickets command boundary: extension.ts must NOT forward apiOriginated.
    test('extension.ts askAgentTask registration does NOT forward apiOriginated', () => {
        const start = extensionSource.indexOf("'switchboard.askAgentTask'");
        const region = extensionSource.slice(start, start + 1200);
        assert.doesNotMatch(region, /apiOriginated/,
            'askAgentTask command must NOT reference apiOriginated (host-derived policy).');
    });

    test('askAgentTask method does NOT accept or forward apiOriginated', () => {
        const sigIdx = taskViewerSource.search(/public\s+async\s+askAgentTask\s*\(/);
        const sigRegion = taskViewerSource.slice(sigIdx, sigIdx + 600);
        assert.doesNotMatch(sigRegion, /apiOriginated/,
            'askAgentTask data type must NOT include apiOriginated.');
        const body = extractMethodBody(taskViewerSource, 'askAgentTask');
        assert.match(body, /dispatchCustomPromptToRole\(\s*'planner',\s*prompt,\s*resolvedRoot\s*\)/,
            'askAgentTask must call dispatchCustomPromptToRole with 3 args (no options).');
        assert.doesNotMatch(body, /apiOriginated/,
            'askAgentTask must NOT reference apiOriginated.');
    });

    // ---- planner fan-out: the round-robin must SEE the terminals-pane fleet ----
    // (planner-fanout-pty-fleet-awareness.md)

    test('the PTY liveness widening is opt-in and OFF by default', () => {
        assert.match(taskViewerSource,
            /public async getRoleTerminalSet\(\s*role: string,\s*workspaceRoot: string,\s*opts\?: \{ allowPtyFleet\?: boolean \}/,
            'getRoleTerminalSet must take an opts bag.');
        assert.match(taskViewerSource,
            /private async _getAliveAutobanTerminalRegistry\(\s*workspaceRoot: string,\s*opts\?: \{ allowPtyFleet\?: boolean \}/,
            '_getAliveAutobanTerminalRegistry must take the same opts bag.');
        // Default OFF: with the flag absent, the PTY branch is skipped entirely and the
        // VS Code liveness test is not merely equivalent but literally unchanged, which
        // is the byte-compatibility contract for the ~4,000 shipped installs.
        assert.match(taskViewerSource,
            /const isPtyRow = opts\?\.allowPtyFleet && this\._isFleetTerminalInfo\(info\);/,
            'the PTY branch must be gated on opts.allowPtyFleet.');
    });

    test('a PTY row is alive iff its own status is not exited', () => {
        const idx = taskViewerSource.indexOf('const isPtyRow = opts?.allowPtyFleet');
        const branch = taskViewerSource.slice(idx, idx + 500);
        assert.match(branch, /if \(info\.status === 'exited'\) \{ continue; \}/,
            'an exited PTY row must be excluded from the pool in both modes.');
        // Host-agnostic by construction: the test reads a persisted registry field, not a
        // vscode.* surface and not the extension-only _ptyHostPort. A fix expressed
        // against _ptyHostPort passes every extension-host test and leaves
        // `npx switchboard` — where PTY is the ONLY fleet — exactly as broken.
        assert.doesNotMatch(branch, /vscode\./, 'the widened branch must not read a vscode.* surface.');
        assert.doesNotMatch(branch, /_ptyHostPort/, 'the widened branch must not key on the extension-only PTY port.');
    });

    test('backups are still filtered out of the widened pool', () => {
        const idx = taskViewerSource.indexOf('public async getRoleTerminalSet(');
        const body = taskViewerSource.slice(idx, idx + 1200);
        assert.match(body, /!this\._isAutobanBackupTerminalInfo\(info\)/,
            'the backup filter must still apply — a PTY row must not be mistaken for a backup, nor a backup admitted.');
    });

    test('the planner distribution reports failed buckets instead of claiming success', () => {
        const idx = kanbanSource.indexOf('private async _distributePlannerDispatch(');
        const body = kanbanSource.slice(idx, kanbanSource.indexOf('/** Get the next column ID', idx));
        assert.match(body, /getRoleTerminalSet\('planner', workspaceRoot, \{ allowPtyFleet: true \}\)/,
            'the pool resolution must admit the PTY fleet, or a grid of planners collapses onto one terminal.');
        // Making the pool non-empty makes a previously-latent defect live: every bucket
        // could reject and the board still claimed success, with the cards already moved.
        assert.match(body, /const failedBuckets: string\[\] = \[\]/, 'failed buckets must be collected.');
        assert.match(body, /failedBuckets\.length > 0[\s\S]*isError: true/,
            'a failed bucket must produce an isError push, not only a console.error.');
        // The moves are persisted BEFORE dispatch on purpose (optimistic UI); reporting
        // is the fix, not rolling them back.
        assert.doesNotMatch(body, /rollback|revertMove/, 'column moves must not be rolled back on bucket failure.');
        // One resolution per dispatch: _getAliveAutobanTerminalRegistry is a Promise.all
        // over PID resolution with a 1s per-terminal timeout.
        assert.strictEqual((body.match(/getRoleTerminalSet\(/g) || []).length, 1,
            'the terminal set must be resolved exactly once per dispatch.');
    });

    test('the rotation cursor advances once per batch, by plans.length', () => {
        const idx = kanbanSource.indexOf('private async _distributePlannerDispatch(');
        const body = kanbanSource.slice(idx, kanbanSource.indexOf('/** Get the next column ID', idx));
        assert.strictEqual((body.match(/advancePlannerRotationCursor\(/g) || []).length, 1,
            'exactly one cursor advance per batch, not one per plan.');
        assert.match(body, /advancePlannerRotationCursor\(locationKey, plans\.length\)/,
            'the advance is by plans.length — a skipped index in a round robin costs nothing.');
        assert.match(body, /terminals\[\(cursor \+ i\) % terminals\.length\]/,
            'buckets must be assigned from the persisted cursor, so a pool that grew resolves without reset.');
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
