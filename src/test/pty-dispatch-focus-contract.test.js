'use strict';

/**
 * Contract: a PTY dispatch must not raise a spurious VS Code "Terminal not found"
 * warning, and the explicit-focus surfaces must keep theirs.
 *
 * (pty-dispatch-spurious-vscode-focus-warning.md)
 *
 * The reported bug: a browser-originated dispatch that correctly lands in a PTY
 * terminal also fires `switchboard.focusTerminalByName` on the dispatch path. That
 * command is a VS Code-only reveal; a PTY is in neither `registeredTerminals` nor
 * `vscode.window.terminals`, so both lookups miss and the command warns — a toast
 * that reads as a second, failed send next to a dispatch that in fact succeeded.
 *
 * The fix has two layers, in priority order:
 *   1. `{ silent: true }` on the three dispatch-path focus calls — this is what
 *      actually suppresses the toast. A focus miss on the dispatch path is never
 *      the user's only signal (`_dispatchExecuteMessage` reports delivery failure
 *      itself), so the warning is pure duplicate noise there.
 *   2. An advisory `_isLikelyPtyDispatchTarget` predicate at the two
 *      `allowPtyFleet`-bearing sites, so a believed-PTY target skips the pointless
 *      reveal entirely. Advisory only — correctness rests on `silent`, not on the
 *      predicate, because the fleet snapshot can be stale.
 *
 * This is a source-text contract (the failure mode is a silent toast, not a thrown
 * error), so it pins structure rather than runtime behaviour. Run with:
 *   node src/test/pty-dispatch-focus-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROVIDER_PATH = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const EXTENSION_PATH = path.join(REPO_ROOT, 'src', 'extension.ts');
const KANBAN_SERVICE_PATH = path.join(REPO_ROOT, 'src', 'services', 'kanbanService.ts');
const KANBAN_PROVIDER_PATH = path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts');

const providerSource = fs.readFileSync(PROVIDER_PATH, 'utf8');
const extensionSource = fs.readFileSync(EXTENSION_PATH, 'utf8');
const kanbanServiceSource = fs.readFileSync(KANBAN_SERVICE_PATH, 'utf8');
const kanbanProviderSource = fs.readFileSync(KANBAN_PROVIDER_PATH, 'utf8');

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
 * Extract a method body by signature marker, brace-matched. Anchors on a visibility
 * modifier (private/public/protected) so it finds the DEFINITION, not a call site.
 * Skips braces inside the parameter list (e.g. `meta: { ... }`) by walking paren
 * depth to the end of the signature, then taking the next `{` as the body start.
 * Returns the body text including the enclosing braces, or throws if not found.
 */
function extractMethodBody(tsSource, methodName) {
    const marker = new RegExp(`(?:private|public|protected)\\s+(?:async\\s+)?${methodName}\\s*\\(`);
    const match = marker.exec(tsSource);
    if (!match) {
        throw new Error(`Method '${methodName}' not found`);
    }
    // Walk paren depth from the opening `(` to find the end of the parameter list.
    let parenDepth = 0;
    let i = match.index + match[0].length - 1; // position of the opening `(`
    for (; i < tsSource.length; i++) {
        const ch = tsSource[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') {
            parenDepth--;
            if (parenDepth === 0) { i++; break; }
        }
    }
    if (parenDepth !== 0) {
        throw new Error(`Method '${methodName}' parameter list not closed`);
    }
    // After the params, skip the optional return type and find the body `{`.
    const bodyStart = tsSource.indexOf('{', i);
    if (bodyStart < 0) {
        throw new Error(`Method '${methodName}' body not found`);
    }
    let depth = 0;
    for (let j = bodyStart; j < tsSource.length; j++) {
        const ch = tsSource[j];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
            return tsSource.slice(bodyStart, j + 1);
        }
    }
    throw new Error(`Method '${methodName}' closing brace not found`);
}

function run() {
    console.log('\n── PTY dispatch focus contract ──\n');

    // --- the command: opt-out flag + boolean return -------------------------

    test('switchboard.focusTerminalByName accepts an options.silent second parameter', () => {
        assert.match(
            extensionSource,
            /registerSwitchboardCommand\('switchboard\.focusTerminalByName',\s*async\s*\(terminalName:\s*string,\s*options\?:\s*\{\s*silent\?:\s*boolean\s*\}\)/,
            'the extension-host handler must accept an optional { silent?: boolean } second argument.'
        );
    });

    test('switchboard.focusTerminalByName gates its showWarningMessage on !options?.silent', () => {
        const start = extensionSource.indexOf("registerSwitchboardCommand('switchboard.focusTerminalByName'");
        const region = extensionSource.slice(start, start + 4000);
        assert.ok(
            /if\s*\(!options\?\.silent\)\s*\{[\s\S]*?showWarningMessage\([\s\S]*?Terminal\s*'\$\{terminalName\}'\s*not found/.test(region),
            'the miss toast must be wrapped in `if (!options?.silent) { ... }`.'
        );
        assert.match(
            region,
            /return\s+true;/,
            'a successful reveal must return true so callers can react.'
        );
        assert.match(
            region,
            /return\s+false;/,
            'a miss must return false so callers can react.'
        );
        // Unused-var lint guard: the handler references `options`.
        assert.ok(region.includes('options'), 'handler must reference the options parameter.');
    });

    // --- the three dispatch-path focus calls -------------------------------

    test('_handleTriggerAgentActionInternal focus call is guarded + silent', () => {
        const body = extractMethodBody(providerSource, '_handleTriggerAgentActionInternal');
        // The silent call must be wrapped in the !isLikelyPty guard: assert the guard
        // block contains the executeCommand, and that there is exactly one silent
        // focus call in the method.
        const guardIdx = body.indexOf('_isLikelyPtyDispatchTarget(targetAgent)');
        assert.ok(guardIdx >= 0, '_handleTriggerAgentActionInternal must guard its focus call with _isLikelyPtyDispatchTarget(targetAgent).');
        const silentCall = /executeCommand\('switchboard\.focusTerminalByName',\s*targetAgent,\s*\{\s*silent:\s*true\s*\}\)/;
        assert.ok(silentCall.test(body), '_handleTriggerAgentActionInternal must pass { silent: true } to focusTerminalByName.');
        // The silent call must come AFTER the guard (i.e. inside its if-block).
        const silentIdx = body.search(silentCall);
        assert.ok(silentIdx > guardIdx, 'the silent focus call must sit inside the !isLikelyPty guard block, not before it.');
        // Exactly one focus call in this method.
        const focusCalls = (body.match(/focusTerminalByName/g) || []).length;
        assert.strictEqual(focusCalls, 1, '_handleTriggerAgentActionInternal must have exactly one focusTerminalByName call (the guarded silent one).');
    });

    test('dispatchToGroup focus call is guarded + silent (per-group)', () => {
        // dispatchToGroup is a local arrow function inside handleKanbanBatchTrigger;
        // extract the outer method body and assert on the inner call.
        const body = extractMethodBody(providerSource, 'handleKanbanBatchTrigger');
        assert.ok(
            /_isLikelyPtyDispatchTarget\(\s*group\.targetAgent\s*\)/.test(body),
            'dispatchToGroup must guard its focus call with _isLikelyPtyDispatchTarget(group.targetAgent).'
        );
        assert.ok(
            /executeCommand\('switchboard\.focusTerminalByName',\s*group\.targetAgent,\s*\{\s*silent:\s*true\s*\}\)/.test(body),
            'dispatchToGroup must pass { silent: true } to focusTerminalByName.'
        );
    });

    test('dispatchCustomPromptToRole focus call is silent (no PTY predicate)', () => {
        const body = extractMethodBody(providerSource, 'dispatchCustomPromptToRole');
        assert.ok(
            /executeCommand\('switchboard\.focusTerminalByName',\s*targetAgent,\s*\{\s*silent:\s*true\s*\}\)/.test(body),
            'dispatchCustomPromptToRole must pass { silent: true } to focusTerminalByName.'
        );
        assert.match(
            body,
            /_isLikelyPtyDispatchTarget\(\s*targetAgent\s*\)/,
            'dispatchCustomPromptToRole must guard its focus call with _isLikelyPtyDispatchTarget(targetAgent) because its target can now be a PTY.'
        );
        assert.match(
            body,
            /_resolveAgentTerminalForPlan\(\s*role,\s*resolvedWorkspaceRoot,\s*undefined\s*\)/,
            'dispatchCustomPromptToRole must pass 3 args to _resolveAgentTerminalForPlan (no allowPtyFleet).'
        );
        assert.match(
            body,
            /_dispatchExecuteMessage\(\s*resolvedWorkspaceRoot,\s*targetAgent,\s*prompt,\s*\{\},\s*'sidebar'\s*\)/,
            'dispatchCustomPromptToRole must pass 5 args to _dispatchExecuteMessage (no allowPtyFleet).'
        );
    });

    // --- the predicate: advisory, snapshot-based, no round-trip ------------

    test('_isLikelyPtyDispatchTarget is advisory and snapshot-based', () => {
        const body = extractMethodBody(providerSource, '_isLikelyPtyDispatchTarget');
        assert.match(
            body,
            /if\s*\(!this\._ptyHostPort\)\s*\{\s*return\s+false;\s*\}/,
            '_isLikelyPtyDispatchTarget must short-circuit to false when !this._ptyHostPort (no-PTY install keeps today\'s behaviour, never throws).'
        );
        assert.match(
            body,
            /this\._ptyTerminalNames/,
            '_isLikelyPtyDispatchTarget must read the cached _ptyTerminalNames snapshot.'
        );
        assert.match(
            body,
            /this\._normalizeAgentKey\(this\._stripIdeSuffix\(/,
            '_isLikelyPtyDispatchTarget must normalize via _normalizeAgentKey(_stripIdeSuffix(...)).'
        );
        // No round-trip on the dispatch hot path.
        assert.doesNotMatch(
            body,
            /_ptyHostVerb\(/,
            '_isLikelyPtyDispatchTarget must NOT issue a _ptyHostVerb round-trip — it sits on the dispatch hot path.'
        );
        // No in-process fleet (reinforces pty-route-surface-contract.test.js).
        assert.doesNotMatch(
            body,
            /_ptyFleetService/,
            '_isLikelyPtyDispatchTarget must NOT reference an in-process _ptyFleetService — the fleet lives in the pty host child.'
        );
    });

    test('_attemptDirectTerminalPush stays the sole delivery authority', () => {
        const body = extractMethodBody(providerSource, '_attemptDirectTerminalPush');
        assert.match(
            body,
            /_ptyHostVerb\('ptyListTerminals'/,
            '_attemptDirectTerminalPush must keep its own _ptyHostVerb(\'ptyListTerminals\') resolution — the delivery path stays the single authority.'
        );
        assert.doesNotMatch(
            body,
            /_isLikelyPtyDispatchTarget/,
            '_attemptDirectTerminalPush must NOT call _isLikelyPtyDispatchTarget — the advisory predicate must never grow into a router.'
        );
    });

    // --- the explicit-focus surfaces keep their warning --------------------

    // Re-anchored 2026-08-10, then 2026-08-12. `ea1077da` added `{ silent: true }`;
    // the advanceCards plan then added a PTY-skip guard that returns before the
    // call entirely — a PTY fleet terminal is in neither `_registeredTerminals`
    // nor `vscode.window.terminals`, so focusing it by name always misses. The
    // wasted executeCommand was pure noise even with `silent: true`. The guard
    // uses `ctx.isPtyTerminalName`, wired from KanbanProvider._initKanbanService
    // to TaskViewerProvider._isLikelyPtyDispatchTarget.
    test('kanbanService focusTerminal skips PTY targets entirely', () => {
        assert.ok(
            /isPtyTerminalName/.test(kanbanServiceSource),
            'kanbanService.focusTerminal must check ctx.isPtyTerminalName and skip the focus call for PTY targets.'
        );
        assert.ok(
            /return\s*\{\s*success:\s*true\s*\}/.test(kanbanServiceSource),
            'kanbanService.focusTerminal must return early for PTY targets.'
        );
    });

    test('kanbanService focusTerminal is still silent for non-PTY targets', () => {
        assert.match(
            kanbanServiceSource,
            /executeCommand\('switchboard\.focusTerminalByName',\s*terminalName,\s*\{\s*silent:\s*true\s*\}\)/,
            'kanbanService.focusTerminal must pass { silent: true } for non-PTY targets.'
        );
    });

    test('KanbanProvider _initKanbanService wires isPtyTerminalName', () => {
        assert.ok(
            /isPtyTerminalName.*_isLikelyPtyDispatchTarget/.test(kanbanProviderSource),
            'KanbanProvider._initKanbanService must wire isPtyTerminalName to TaskViewerProvider._isLikelyPtyDispatchTarget.'
        );
    });

    test('KanbanProvider focus call passes NO options (warning intended)', () => {
        assert.match(
            kanbanProviderSource,
            /executeCommand\('switchboard\.focusTerminalByName',\s*terminalName\s*\)/,
            'KanbanProvider must call focusTerminalByName without an options argument.'
        );
    });

    test('extension.ts focusAllTerminals passes NO options (warning intended)', () => {
        // The focusAllTerminals handler iterates and calls focusTerminalByName per
        // terminal — those calls must stay bare so a missing terminal still warns.
        const start = extensionSource.indexOf("'switchboard.focusAllTerminals'");
        const region = extensionSource.slice(start, start + 4000);
        assert.ok(
            /executeCommand\('switchboard\.focusTerminalByName',\s*[a-zA-Z_.$]+\s*\)/.test(region),
            'focusAllTerminals must call focusTerminalByName without an options argument.'
        );
        assert.doesNotMatch(
            region,
            /executeCommand\('switchboard\.focusTerminalByName',\s*[a-zA-Z_.$]+,\s*\{\s*silent/,
            'focusAllTerminals must NOT pass { silent: true } — the warning is intended there.'
        );
    });

    // --- the two already-guarded fallback sites stay byte-identical --------

    test('the _focusTerminalByName fallback sites keep their awaited shape', () => {
        // These sites (around the analyst handler and the terminal-grid focus) are
        // already gated behind a successful _focusTerminalByName probe and must not
        // gain a silent flag — they are explicit-focus surfaces that fall back to the
        // command only on a local miss.
        const re = /const\s+focused\s*=\s*await\s+this\._focusTerminalByName\([^)]+\);[\s\S]{0,200}?if\s*\(!focused\)\s*\{[\s\S]{0,200}?await\s+this\._seams\(\)\.commands\.executeCommand\('switchboard\.focusTerminalByName',\s*[a-zA-Z_.]+\s*\);/;
        assert.ok(
            re.test(providerSource),
            'the _focusTerminalByName fallback sites must keep their awaited, no-options shape (byte-identical guard).'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
