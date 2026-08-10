#!/usr/bin/env node
'use strict';

/**
 * Standalone Push-Parity Guard — Browser Switchboard.
 *
 * The standalone (npx) host and the VS Code extension host share the same board
 * UI (`kanban.html`). Every parity audit that declared standalone "done" checked
 * verb reachability — which cannot fail, because bootstrap.ts's `default:` arm
 * delegates every unmatched verb to the provider. The dead half is the READ-BACK
 * path: the payload the standalone host pushes to the browser. This guard turns
 * that gap into a ratcheted number rather than another manual assessment.
 *
 * Three assertions:
 *
 * 1. MESSAGE-TYPE COVERAGE (ratcheted): the set of message types the shared
 *    board handles (Set A, extracted from kanban.html's message listener) minus
 *    the types standalone can actually deliver (Set B: literal broadcasts in
 *    bootstrap.ts ∪ provider postMessage types, conditional on a broadcaster
 *    being installed). The difference is the gap; it must not exceed the baseline.
 *
 * 2. BROADCASTER INSTALLATION (pass/fail): bootstrap.ts must construct a
 *    BroadcastHub, assign it to each headless provider, and call setApiServer so
 *    the hub's WS fan-out has a target. This already landed (2026-07-22); the
 *    assertion locks it in place so a future refactor cannot silently drop it.
 *
 * 3. NO HARDCODED VIEW STATE (ratcheted): the board payload fields that must
 *    reflect live state must not be hand-built from literals in bootstrap.ts's
 *    state builders. The floor of this ratchet is a delegation assertion: the
 *    state builders must obtain their message list from
 *    kanbanProvider.getFullStateMessages(...) rather than constructing entries
 *    inline. Until delegation lands, a per-field literal count is ratcheted.
 *
 * This is a RATCHET, not a zero-check. Baselines capture today's true gap so CI
 * is green from the first commit; they may only ever be LOWERED, never raised.
 * Following the check-push-routing.js convention.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Baselines (LOWER only; NEVER raise) ───────────────────────────────────
// The message-type gap: |Set A \ Set B| minus allowlisted extension-only types.
// Today this is dominated by the fabricated payload (types the board handles
// but standalone broadcasts as literals with dead values). Once delegation lands
// the gap drops to the extension-only residue.
// 2026-08-10 (review pass): lowered 13 → 0. The original 13 was not a real gap —
// Set B under-counted through three emission shapes the AST walk did not know:
// `this.postMessage(msgVariable)` (TaskViewerProvider builds the message into a
// local first), cross-provider pushes (`this._kanbanProvider.postMessage(...)`,
// `broadcastToWebviews`), and four sibling providers that share the same headless
// hub but were never scanned. That is the same over-report the hand-written greps
// produced, reproduced in code — the exact failure this guard exists to end. With
// the scan corrected, the true residual is 6 types, every one of them explained in
// the allowlist (5 delivered by verb RETURN BODY rather than by push; 1 —
// liveSyncUpdate — genuinely extension-only). Unexplained gap is now 0.
const BASELINE_MESSAGE_TYPE_GAP = 0; // measured on current tree; LOWER only

// Hardcoded view-state field count: the number of named payload fields whose AST
// value in bootstrap.ts's state builders is a literal rather than a call/property
// access. Once delegation lands this drops to 0 (the delegation assertion takes
// over as the floor).
const BASELINE_HARDCODED_FIELDS = 0; // dropped to 0 after delegation to getFullStateMessages; LOWER only

// ─── Allowlist ─────────────────────────────────────────────────────────────
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'standalone-parity-allowlist.json');
const ALLOWLIST = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

// ─── Helpers ───────────────────────────────────────────────────────────────

function readSource(rel) {
    const full = path.join(REPO_ROOT, rel);
    return fs.readFileSync(full, 'utf8');
}

function parseTs(src, fileName) {
    return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function parseJs(src, fileName) {
    return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/**
 * Walk every node in a source file. Calls visitor with (node, parent).
 */
function walk(sourceFile, visitor) {
    function visit(node, parent) {
        visitor(node, parent);
        ts.forEachChild(node, child => visit(child, node));
    }
    visit(sourceFile, undefined);
}

/**
 * Extract the first <script> body from an HTML file (no attributes on the tag).
 * Returns the raw JS text. Throws if no script block is found.
 */
function extractInlineScript(html) {
    const openIdx = html.indexOf('<script>');
    if (openIdx === -1) {
        throw new Error('No <script> block found in HTML file.');
    }
    const bodyStart = openIdx + '<script>'.length;
    const closeIdx = html.indexOf('</script>', bodyStart);
    if (closeIdx === -1) {
        throw new Error('No closing </script> found.');
    }
    return html.slice(bodyStart, closeIdx);
}

/**
 * Collect string-literal case clause values from a SwitchStatement.
 */
function collectSwitchCases(switchStmt) {
    const cases = new Set();
    for (const clause of switchStmt.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && clause.expression && ts.isStringLiteral(clause.expression)) {
            cases.add(clause.expression.text);
        }
    }
    return cases;
}

/**
 * Collect msg.type === '...' string comparisons from an if/else-if chain.
 * Handles: if (msg.type === 'x') ... else if (msg.type === 'y') ...
 */
function collectIfChainTypeComparisons(ifStmt) {
    const types = new Set();
    let current = ifStmt;
    while (current && current.kind === ts.SyntaxKind.IfStatement) {
        const test = current.expression;
        // msg.type === 'string'
        if (test && ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
            for (const [left, right] of [[test.left, test.right], [test.right, test.left]]) {
                if (right && ts.isStringLiteral(right) && left && ts.isPropertyAccessExpression(left)
                    && left.name.text === 'type'
                    && left.expression && ts.isIdentifier(left.expression) && left.expression.text === 'msg') {
                    types.add(right.text);
                }
            }
        }
        // else might be a Block wrapping another IfStatement, or a direct IfStatement
        const elseStmt = current.elseStatement;
        if (elseStmt && elseStmt.kind === ts.SyntaxKind.IfStatement) {
            current = elseStmt;
        } else if (elseStmt && ts.isBlock(elseStmt) && elseStmt.statements.length === 1
                   && elseStmt.statements[0].kind === ts.SyntaxKind.IfStatement) {
            current = elseStmt.statements[0];
        } else {
            current = undefined;
        }
    }
    return types;
}

// ─── Set A: message types the shared board handles ─────────────────────────

function extractBoardHandlerTypes(html) {
    const scriptBody = extractInlineScript(html);
    const sourceFile = parseJs(scriptBody, 'kanban.html.script.js');

    const switchTypes = new Set();
    const ifChainTypes = new Set();

    walk(sourceFile, (node) => {
        // window.addEventListener('message', (event) => { switch (msg.type) { ... } })
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'addEventListener' &&
            node.arguments.length >= 2 &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === 'message') {

            const callback = node.arguments[1];
            // Walk inside the callback body for switch statements and if-chains
            function visitCallback(n) {
                if (ts.isSwitchStatement(n)) {
                    // Check it switches on msg.type or event.data.type etc.
                    const switchExpr = n.expression;
                    if (ts.isPropertyAccessExpression(switchExpr) && switchExpr.name.text === 'type') {
                        for (const t of collectSwitchCases(n)) {
                            switchTypes.add(t);
                        }
                    }
                }
                if (ts.isIfStatement(n)) {
                    const collected = collectIfChainTypeComparisons(n);
                    for (const t of collected) {
                        ifChainTypes.add(t);
                    }
                }
                ts.forEachChild(n, visitCallback);
            }
            ts.forEachChild(callback, visitCallback);
        }
    });

    const all = new Set([...switchTypes, ...ifChainTypes]);
    return { types: all, switchCount: switchTypes.size, ifChainCount: ifChainTypes.size };
}

// ─── Set B: types standalone can deliver ───────────────────────────────────

/**
 * Collect the `type` string from an object literal, handling `as const`.
 * Returns null if no type property is found or it's not a string literal.
 */
function extractTypeFromObjectLiteral(objLit) {
    for (const prop of objLit.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'type') {
            let init = prop.initializer;
            // Handle `as const`: the initializer is an AsExpression
            if (ts.isAsExpression(init)) {
                init = init.expression;
            }
            if (ts.isStringLiteral(init)) {
                return init.text;
            }
            return null; // type is present but not a string literal (dynamic)
        }
    }
    return null;
}

// Push-method names that fan a message out to a UI target. `postMessage` routes
// through the provider's BroadcastHub (and therefore the WS hub in standalone);
// the two Planning wrappers are that provider's equivalents.
// `broadcastToWebviews` is TaskViewer's cross-panel fan-out: it forwards to
// `_kanbanProvider.postMessage` / `_designPanelProvider.postMessage` / etc., so
// its argument reaches the WS hub in standalone exactly like a direct push. Its
// callees take an opaque `message` parameter, so the literal is only visible at
// the fan-out call site — omitting this name loses those types from Set B.
const PUSH_METHOD_NAMES = new Set([
    'postMessage',
    'postMessageToWebview',
    'postMessageToProjectWebview',
    'broadcastToWebviews',
]);

/**
 * Index every `const x = { type: '...' }` object-literal binding in the file by
 * variable name. Providers routinely build a message into a local and then push
 * the local (`const message = {...}; this.postMessage(message);`) — an
 * argument-shape-only walk misses every one of those, which UNDER-counts Set B
 * and therefore OVER-reports the parity gap. That is precisely the failure mode
 * the hand-written greps had; reproducing it in the AST would defeat the guard.
 *
 * Name collisions across scopes are accepted deliberately: this set is used only
 * to answer "is this type deliverable at all", so a superset within one provider
 * file cannot mask a real gap in another.
 */
function indexMessageVariables(sourceFile) {
    const byName = new Map(); // varName → type string
    walk(sourceFile, (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            let init = node.initializer;
            if (ts.isAsExpression(init)) init = init.expression;
            // `cond ? { type: 'a', ... } : { type: 'b', ... }` — both arms count.
            const candidates = ts.isConditionalExpression(init)
                ? [init.whenTrue, init.whenFalse]
                : [init];
            for (const c of candidates) {
                const obj = ts.isParenthesizedExpression(c) ? c.expression : c;
                if (ts.isObjectLiteralExpression(obj)) {
                    const t = extractTypeFromObjectLiteral(obj);
                    if (t) {
                        const existing = byName.get(node.name.text);
                        byName.set(node.name.text, existing ? new Set([...existing, t]) : new Set([t]));
                    }
                }
            }
        }
    });
    return byName;
}

/**
 * Collect provider-emitted message types from push calls.
 * Handles:
 *   - this.postMessage({ type: 'x', ... })
 *   - this.postMessage({ type: 'x' as const, ... })
 *   - this.postMessage((scope) => ({ type: 'x', ... }))
 *   - this.postMessage(messageVariable)                  ← resolved via indexMessageVariables
 *   - this._kanbanProvider?.postMessage({ type: 'x' })    ← cross-provider push
 *   - this.postMessageToWebview({ type: 'x' })            ← Planning's wrappers
 *
 * Receivers whose text mentions a webview are EXCLUDED: `panel.webview.postMessage`
 * is a direct editor-only write (the shape `check-push-routing.js` exists to ban),
 * not something standalone can deliver.
 */
function collectProviderPostMessageTypes(sourceFile) {
    const types = new Set();
    const messageVars = indexMessageVariables(sourceFile);

    walk(sourceFile, (node) => {
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            PUSH_METHOD_NAMES.has(node.expression.name.text) &&
            !/webview/i.test(node.expression.expression.getText())) {

            const arg = node.arguments[0];
            if (!arg) return;

            // Variable form: this.postMessage(message)
            if (ts.isIdentifier(arg)) {
                const resolved = messageVars.get(arg.text);
                if (resolved) for (const t of resolved) types.add(t);
                return;
            }

            // Direct object literal: this.postMessage({ type: 'x', ... })
            if (ts.isObjectLiteralExpression(arg)) {
                const t = extractTypeFromObjectLiteral(arg);
                if (t) types.add(t);
                return;
            }

            // Factory form: this.postMessage((scope) => ({ type: 'x', ... }))
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
                const body = arg.body;
                // Arrow with expression body: (scope) => ({ ... })
                if (ts.isObjectLiteralExpression(body)) {
                    const t = extractTypeFromObjectLiteral(body);
                    if (t) types.add(t);
                    return;
                }
                // Arrow with parenthesized expression body: (scope) => (({ ... }))
                if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
                    const t = extractTypeFromObjectLiteral(body.expression);
                    if (t) types.add(t);
                    return;
                }
                // Arrow with block body: (scope) => { return { ... }; }
                if (ts.isBlock(body)) {
                    for (const stmt of body.statements) {
                        if (ts.isReturnStatement(stmt) && stmt.expression) {
                            let retExpr = stmt.expression;
                            if (ts.isParenthesizedExpression(retExpr)) {
                                retExpr = retExpr.expression;
                            }
                            if (ts.isObjectLiteralExpression(retExpr)) {
                                const t = extractTypeFromObjectLiteral(retExpr);
                                if (t) types.add(t);
                            }
                        }
                    }
                }
            }
        }
    });

    return types;
}

/**
 * Collect types from the return array of getFullStateMessages in a provider file.
 * Once bootstrap.ts delegates to getFullStateMessages, the types it returns are
 * the types standalone delivers via pushFullState's broadcast loop. The return
 * array contains object literals with `type` string properties — collect them
 * the same way we collect bootstrap literal broadcasts (object literals with
 * `type` and `surface`).
 */
function collectGetFullStateMessagesTypes(sourceFile) {
    const types = new Set();

    walk(sourceFile, (node) => {
        // Find the getFullStateMessages method declaration
        if (ts.isMethodDeclaration(node) && node.name.text === 'getFullStateMessages') {
            // Walk the method body for object literals with type + surface
            function visitMethod(n) {
                if (ts.isObjectLiteralExpression(n)) {
                    let typeVal = null;
                    let hasSurface = false;
                    for (const prop of n.properties) {
                        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                            if (prop.name.text === 'type' && ts.isStringLiteral(prop.initializer)) {
                                typeVal = prop.initializer.text;
                            }
                            if (prop.name.text === 'surface') {
                                hasSurface = true;
                            }
                        }
                    }
                    if (typeVal && hasSurface) {
                        types.add(typeVal);
                    }
                }
                ts.forEachChild(n, visitMethod);
            }
            ts.forEachChild(node, visitMethod);
        }
    });

    return types;
}

/**
 * Collect literal broadcast types from bootstrap.ts:
 *   - Direct `server.broadcastWs('type', ...)` calls.
 *   - Object literals with both `type` (string) and `surface` properties —
 *     these are the state-array entries fed to `server.broadcastWs(msg.type, ...)`
 *     via a for-of loop. Scanning for the shape directly avoids tracing variable
 *     references through `for (const msg of state)` bindings.
 */
function collectBootstrapLiteralBroadcasts(sourceFile) {
    const literalTypes = new Set();

    walk(sourceFile, (node) => {
        // Direct string literal: server.broadcastWs('showStatusMessage', ...)
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'broadcastWs' &&
            node.arguments.length >= 1 &&
            ts.isStringLiteral(node.arguments[0])) {
            literalTypes.add(node.arguments[0].text);
        }

        // State-array entries: object literals with both `type` and `surface`
        if (ts.isObjectLiteralExpression(node)) {
            let typeVal = null;
            let hasSurface = false;
            for (const prop of node.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                    if (prop.name.text === 'type' && ts.isStringLiteral(prop.initializer)) {
                        typeVal = prop.initializer.text;
                    }
                    if (prop.name.text === 'surface') {
                        hasSurface = true;
                    }
                }
            }
            if (typeVal && hasSurface) {
                literalTypes.add(typeVal);
            }
        }
    });

    return literalTypes;
}

// ─── Assertion: broadcaster installation ───────────────────────────────────

// Six providers share the one headless hub. Five take it by direct
// `_broadcaster` assignment; TaskViewer takes it as an argument to
// `initHeadlessVerbServing`. A presence-only regex (`.test()`) is satisfied by a
// SINGLE surviving assignment — a refactor could drop four providers off the hub
// and the guard would still report green. Count the assignments instead, and
// require the TaskViewer hand-off separately.
const EXPECTED_BROADCASTER_ASSIGNMENTS = 5; // Design, Setup, Tickets, Kanban, Planning
function checkBroadcasterInstalled(bootstrapSrc) {
    const assignments = bootstrapSrc.match(/\._broadcaster\s*=\s*headlessBroadcaster/g) || [];
    return {
        constructsHub: /new\s+BroadcastHub\s*\(/.test(bootstrapSrc),
        assignsToProviders: assignments.length >= EXPECTED_BROADCASTER_ASSIGNMENTS,
        assignmentCount: assignments.length,
        // TaskViewer is wired through initHeadlessVerbServing rather than a
        // direct field assignment — assert it explicitly or the sixth provider
        // can silently fall off the hub.
        wiresTaskViewer: /initHeadlessVerbServing\s*\([^)]*headlessBroadcaster/.test(bootstrapSrc),
        // Headless mode must be declared at the single composition root, or the
        // hub's pending-webview queue grows unbounded for the process lifetime.
        headlessDeclared: /new\s+BroadcastHub\s*\(\s*\{[^}]*headless\s*:\s*true/.test(bootstrapSrc),
        callsSetApiServer: /\.setApiServer\s*\(\s*server\s*\)/.test(bootstrapSrc),
    };
}

// ─── Assertion: no hardcoded view state in board payload ───────────────────

// Named payload fields that must reflect live state. Each is checked in
// bootstrap.ts's state builder arrays. If the AST value is a literal (false,
// {}, null, a bare identifier for raw defaults) rather than a call or property
// access, it counts toward the hardcoded-field ratchet.
const HARDCODED_FIELD_NAMES = [
    'columns',
    'routingConfig',
    'enabled',           // cliTriggersState.enabled
    'theme',             // switchboardThemeNameSetting.theme
    'activeFilter',
    'controlPlaneMode',
    'controlPlaneRoot',
    'effectiveControlPlaneRoot',
    'explicitControlPlaneRoot',
    'pendingCandidate',
    'repoScopeFilter',
    'projectContextEnabled',
];

/**
 * Check whether bootstrap.ts's state builders (pushFullState / getFullState)
 * delegate to getFullStateMessages. Returns true if delegation is detected.
 */
function checkStateBuilderDelegation(sourceFile) {
    let delegates = false;
    walk(sourceFile, (node) => {
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'getFullStateMessages') {
            delegates = true;
        }
    });
    return delegates;
}

/**
 * Count hardcoded view-state fields in bootstrap.ts's state builder arrays.
 * Looks for object literal properties in the state arrays whose values are
 * literals (string, boolean, null, bare identifier, empty object).
 */
function countHardcodedFields(sourceFile) {
    const hardcoded = new Map(); // key: "type.field" → { type, field }
    const stateArrayTypes = new Set([
        'updateColumns',
        'updateWorkspaceSelection',
        'cliTriggersState',
        'switchboardThemeNameSetting',
        'updateBoard',
    ]);

    walk(sourceFile, (node) => {
        // Find object literals that have a `type` property matching a state-array type
        if (ts.isObjectLiteralExpression(node)) {
            let typeVal = null;
            for (const prop of node.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'type') {
                    if (ts.isStringLiteral(prop.initializer)) {
                        typeVal = prop.initializer.text;
                    }
                }
            }
            if (typeVal && stateArrayTypes.has(typeVal)) {
                // Check each property for literal values
                for (const prop of node.properties) {
                    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
                    const fieldName = prop.name.text;
                    if (!HARDCODED_FIELD_NAMES.includes(fieldName)) continue;
                    if (ALLOWLIST[fieldName]) continue; // allowlisted override

                    const init = prop.initializer;
                    const isLiteral =
                        ts.isStringLiteral(init) ||
                        ts.isNumericLiteral(init) ||
                        (init.kind === ts.SyntaxKind.FalseKeyword) ||
                        (init.kind === ts.SyntaxKind.TrueKeyword) ||
                        (init.kind === ts.SyntaxKind.NullKeyword) ||
                        (ts.isIdentifier(init) && init.text !== 'undefined') || // bare identifier = raw defaults
                        (ts.isObjectLiteralExpression(init) && init.properties.length === 0); // {}
                    if (isLiteral) {
                        const key = `${typeVal}.${fieldName}`;
                        if (!hardcoded.has(key)) {
                            hardcoded.set(key, { type: typeVal, field: fieldName });
                        }
                    }
                }
            }
        }
    });

    return [...hardcoded.values()];
}

// ─── Main ──────────────────────────────────────────────────────────────────

let failed = false;
const findings = [];

console.log('=== Standalone Push-Parity Guard ===\n');

// ── Set A: board handler types ──
const kanbanHtml = readSource('src/webview/kanban.html');
let setA;
try {
    setA = extractBoardHandlerTypes(kanbanHtml);
} catch (e) {
    console.error(`❌ Failed to extract board handler types from kanban.html: ${e.message}`);
    console.error('   This is the worst outcome — a vacuous guard that passes on broken extraction.');
    process.exit(1);
}

const SET_A_FLOOR = 40; // the board handler switch has ~60 cases; below 40 means extraction broke
if (setA.types.size < SET_A_FLOOR) {
    console.error(`❌ Set A (board handler types) extracted only ${setA.types.size} types (floor ${SET_A_FLOOR}).`);
    console.error('   Extraction likely broke — a vacuous guard is worse than no guard.');
    process.exit(1);
}
console.log(`Set A — board handler types: ${setA.types.size} (${setA.switchCount} from switch, ${setA.ifChainCount} from if-chain)`);

// ── Broadcaster installation assertion ──
const bootstrapSrc = readSource('src/standalone/bootstrap.ts');
const broadcasterChecks = checkBroadcasterInstalled(bootstrapSrc);
const broadcasterPass = broadcasterChecks.constructsHub && broadcasterChecks.assignsToProviders
    && broadcasterChecks.wiresTaskViewer && broadcasterChecks.headlessDeclared && broadcasterChecks.callsSetApiServer;
console.log(`\nBroadcaster installation:`);
console.log(`  constructs BroadcastHub: ${broadcasterChecks.constructsHub ? '✅' : '❌'}`);
console.log(`  assigns to providers:    ${broadcasterChecks.assignsToProviders ? '✅' : '❌'} (${broadcasterChecks.assignmentCount}/${EXPECTED_BROADCASTER_ASSIGNMENTS} direct assignments)`);
console.log(`  wires TaskViewer:        ${broadcasterChecks.wiresTaskViewer ? '✅' : '❌'} (initHeadlessVerbServing)`);
console.log(`  headless mode declared:  ${broadcasterChecks.headlessDeclared ? '✅' : '❌'} (bounds the pending-webview queue)`);
console.log(`  calls setApiServer:      ${broadcasterChecks.callsSetApiServer ? '✅' : '❌'}`);
if (!broadcasterPass) {
    console.error('  ❌ Broadcaster installation regressed — provider pushes cannot reach the browser.');
    findings.push('Broadcaster installation regressed.');
    failed = true;
}

// ── Set B: standalone-deliverable types ──
const bootstrapSf = parseTs(bootstrapSrc, 'bootstrap.ts');
const bootstrapLiterals = collectBootstrapLiteralBroadcasts(bootstrapSf);
console.log(`\nSet B — bootstrap.ts literal broadcasts: ${bootstrapLiterals.size}`);

const kanbanProviderSrc = readSource('src/services/KanbanProvider.ts');
const kanbanProviderSf = parseTs(kanbanProviderSrc, 'KanbanProvider.ts');
const kanbanProviderTypes = collectProviderPostMessageTypes(kanbanProviderSf);
const kanbanFullStateTypes = collectGetFullStateMessagesTypes(kanbanProviderSf);
console.log(`Set B — KanbanProvider postMessage types: ${kanbanProviderTypes.size}`);
console.log(`Set B — KanbanProvider getFullStateMessages types: ${kanbanFullStateTypes.size}`);

const taskViewerSrc = readSource('src/services/TaskViewerProvider.ts');
const taskViewerSf = parseTs(taskViewerSrc, 'TaskViewerProvider.ts');
const taskViewerTypes = collectProviderPostMessageTypes(taskViewerSf);
console.log(`Set B — TaskViewerProvider postMessage types: ${taskViewerTypes.size}`);

// The remaining providers that share the ONE headless BroadcastHub in standalone
// (bootstrap.ts constructs Design, Setup, Tickets, TaskViewer, Kanban, Planning).
// Untagged provider pushes reach every subscribed surface (wsHub.ts:303-316), so a
// type the board handles is deliverable if ANY of the six emits it — scanning only
// two of six under-counts Set B and over-reports the gap.
const SIBLING_PROVIDER_SOURCES = [
    'src/services/SetupPanelProvider.ts',
    'src/services/PlanningPanelProvider.ts',
    'src/services/TicketsPanelProvider.ts',
    'src/services/DesignPanelProvider.ts',
];
const siblingTypes = new Set();
for (const rel of SIBLING_PROVIDER_SOURCES) {
    const sf = parseTs(readSource(rel), path.basename(rel));
    for (const t of collectProviderPostMessageTypes(sf)) siblingTypes.add(t);
}
console.log(`Set B — sibling headless providers (${SIBLING_PROVIDER_SOURCES.length} files): ${siblingTypes.size}`);

// Set B = literal broadcasts ∪ provider-emitted ∪ getFullStateMessages return types
// (only if broadcaster is installed — without it, none of these reach the browser)
const setB = new Set([...bootstrapLiterals]);
if (broadcasterPass) {
    for (const t of kanbanProviderTypes) setB.add(t);
    for (const t of kanbanFullStateTypes) setB.add(t);
    for (const t of taskViewerTypes) setB.add(t);
    for (const t of siblingTypes) setB.add(t);
} else {
    console.log('  ⚠️  Broadcaster not installed — provider-emitted types treated as undeliverable.');
}
console.log(`Set B — total standalone-deliverable: ${setB.size}`);

// ── Message-type gap (ratcheted) ──
const gap = [...setA.types].filter(t => !setB.has(t)).sort();
// Remove allowlisted types from the gap
const unexplainedGap = gap.filter(t => !ALLOWLIST[t]);
const allowlistedGap = gap.filter(t => ALLOWLIST[t]);

console.log(`\nMessage-type gap (Set A \\ Set B): ${gap.length} total, ${allowlistedGap.length} allowlisted, ${unexplainedGap.length} unexplained`);
if (unexplainedGap.length > 0) {
    console.log('  Unexplained types (board handles, standalone cannot deliver):');
    for (const t of unexplainedGap) {
        console.log(`    • ${t}`);
    }
}
if (allowlistedGap.length > 0) {
    console.log('  Allowlisted types (legitimately extension-only):');
    for (const t of allowlistedGap) {
        console.log(`    • ${t}: ${ALLOWLIST[t]}`);
    }
}

if (unexplainedGap.length > BASELINE_MESSAGE_TYPE_GAP) {
    console.error(`❌ Message-type gap ${unexplainedGap.length} exceeds baseline ${BASELINE_MESSAGE_TYPE_GAP}.`);
    findings.push(`Message-type gap ${unexplainedGap.length} > baseline ${BASELINE_MESSAGE_TYPE_GAP}.`);
    failed = true;
} else if (unexplainedGap.length < BASELINE_MESSAGE_TYPE_GAP) {
    console.log(`✅ Message-type gap ${unexplainedGap.length} (baseline ${BASELINE_MESSAGE_TYPE_GAP}) — improved; lower the baseline.`);
} else {
    console.log(`✅ Message-type gap ${unexplainedGap.length} (baseline ${BASELINE_MESSAGE_TYPE_GAP})`);
}

// ── Allowlist validation ──
let allowlistValid = true;
for (const [key, reason] of Object.entries(ALLOWLIST)) {
    if (!reason || !reason.trim()) {
        console.error(`❌ Allowlist entry '${key}' has an empty reason.`);
        allowlistValid = false;
        failed = true;
    }
}
if (allowlistValid) {
    console.log(`✅ Allowlist valid (${Object.keys(ALLOWLIST).length} entries, all with reasons).`);
}

// ── Hardcoded view-state assertion ──
const delegationDetected = checkStateBuilderDelegation(bootstrapSf);
console.log(`\nState-builder delegation: ${delegationDetected ? '✅ detected (getFullStateMessages called)' : '❌ not detected'}`);

const hardcodedFields = countHardcodedFields(bootstrapSf);
console.log(`Hardcoded view-state fields: ${hardcodedFields.length} (baseline ${BASELINE_HARDCODED_FIELDS})`);
if (hardcodedFields.length > 0) {
    for (const h of hardcodedFields) {
        console.log(`    • ${h.type}.${h.field}`);
    }
}

if (delegationDetected) {
    // Delegation is the floor: once it lands, hardcoded fields should be 0.
    // The delegation assertion replaces the per-field ratchet.
    if (hardcodedFields.length > 0) {
        console.error(`❌ State builders delegate but ${hardcodedFields.length} hardcoded fields remain.`);
        findings.push(`${hardcodedFields.length} hardcoded fields remain after delegation.`);
        failed = true;
    } else {
        console.log('✅ Delegation floor: state builders delegate, no hardcoded fields.');
    }
} else {
    // Pre-delegation: ratchet on the per-field count.
    if (hardcodedFields.length > BASELINE_HARDCODED_FIELDS) {
        console.error(`❌ Hardcoded fields ${hardcodedFields.length} exceeds baseline ${BASELINE_HARDCODED_FIELDS}.`);
        findings.push(`Hardcoded fields ${hardcodedFields.length} > baseline ${BASELINE_HARDCODED_FIELDS}.`);
        failed = true;
    } else if (hardcodedFields.length < BASELINE_HARDCODED_FIELDS) {
        console.log(`✅ Hardcoded fields ${hardcodedFields.length} (baseline ${BASELINE_HARDCODED_FIELDS}) — improved; lower the baseline.`);
    } else {
        console.log(`✅ Hardcoded fields ${hardcodedFields.length} (baseline ${BASELINE_HARDCODED_FIELDS})`);
    }
}

// ── Summary ──
console.log('\n' + '='.repeat(60));
if (failed) {
    console.error('❌ Standalone push-parity check FAILED.');
    for (const f of findings) {
        console.error(`   • ${f}`);
    }
    process.exit(1);
}
console.log('✅ Standalone push-parity check passed.');
process.exit(0);
