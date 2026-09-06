'use strict';
/**
 * CLI seat targeting + standalone planner round-robin contract.
 *
 * The plan `cli-dispatch-has-no-seat-targeting-flag.md` had SIX listed automated
 * tests and shipped none, so every gate stayed green while the round-robin was
 * unreachable in the host it was written for. These are its Goal Invariants as
 * source contracts.
 *
 * The load-bearing one is #4. `getRoleTerminalSet` runs its rows through
 * `_getAliveAutobanTerminalRegistry`, which only trusts a PTY row's own `status`
 * when the caller passes `{ allowPtyFleet: true }`. Standalone's vscodeShim
 * exports `window.terminals = []` and no `env.appName`, and PtyFleetService's
 * persisted row carries no `lastSeen` — so without the opt-in every planner is
 * filtered out, the set comes back EMPTY, and the rotation silently never fires.
 * That is not a style preference; it is the difference between the feature
 * working and not existing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const BOOTSTRAP = fs.readFileSync(path.join(repoRoot, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
const CLI = fs.readFileSync(path.join(repoRoot, 'src', 'standalone', 'cli.ts'), 'utf8');
const API = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'LocalApiServer.ts'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

console.log('CLI seat dispatch + planner rotation contract');

/** The body of handlePtyVerb's `case 'triggerAction':` arm. */
function triggerActionBody() {
    const marks = [];
    let i = 0;
    while ((i = BOOTSTRAP.indexOf("case 'triggerAction': {", i)) !== -1) { marks.push(i); i += 10; }
    assert.strictEqual(marks.length, 1, "expected exactly one `case 'triggerAction': {` block in bootstrap.ts");
    const start = marks[0];
    const end = BOOTSTRAP.indexOf("case '", start + 30);
    return BOOTSTRAP.slice(start, end === -1 ? BOOTSTRAP.length : end);
}

test('handlePtyVerb reads payload.targetTerminalOverride, not only payload.terminalName', () => {
    const body = triggerActionBody();
    assert.match(body, /payload\.targetTerminalOverride/,
        'performKanbanDispatch sends targetTerminalOverride; reading only terminalName discards every board and CLI override');
    assert.match(body, /payload\.terminalName/,
        'switchboard.triggerAgentFromKanban still sends terminalName — both names must be accepted');
});

test('an explicit terminal override that names no live seat fails loudly', () => {
    const body = triggerActionBody();
    const idx = body.indexOf('const overrideName');
    assert(idx > -1, 'expected an overrideName binding in the triggerAction arm');
    const window = body.slice(idx, idx + 1400);
    assert.match(window, /No live terminal named/,
        'a --seat miss must name the seat and refuse, never fall through to role matching and report success');
});

test('the planner rotation cursor is read and advanced inside the triggerAction arm', () => {
    const body = triggerActionBody();
    assert.match(body, /getRoleTerminalSet\(/, 'the rotation needs the role terminal set');
    assert.match(body, /getPlannerRotationCursor\(/, 'the rotation must READ the persistent cursor');
    assert.match(body, /advancePlannerRotationCursor\(/, 'the rotation must ADVANCE the persistent cursor');
});

test('getRoleTerminalSet is called with { allowPtyFleet: true } — PTY is the only fleet standalone has', () => {
    const body = triggerActionBody();
    const m = body.match(/getRoleTerminalSet\((.|\n)*?\)\s*;/);
    assert(m, 'expected a getRoleTerminalSet call in the triggerAction arm');
    assert.match(m[0], /allowPtyFleet:\s*true/,
        'without allowPtyFleet the alive-registry filter drops every PTY row (no lastSeen, empty vscode.window.terminals, blank appName) and the rotation never fires');
});

test('the cursor advances only AFTER delivery succeeded, so a failed dispatch does not skip a slot', () => {
    const body = triggerActionBody();
    const deliver = body.indexOf('ptySendPrompt');
    const exitGuard = body.indexOf("readiness?.reason === 'exit'");
    const advance = body.indexOf('advancePlannerRotationCursor');
    assert(deliver > -1 && exitGuard > -1 && advance > -1, 'expected delivery, the exit guard and the advance in this arm');
    assert(advance > exitGuard && exitGuard > deliver,
        'advancePlannerRotationCursor must come after the delivery AND after the exit-failure early return');
});

test('cmdDispatch parses --seat and threads it into doDispatch', () => {
    const start = CLI.indexOf('async function cmdDispatch(');
    assert(start > -1, 'expected cmdDispatch in cli.ts');
    const body = CLI.slice(start, CLI.indexOf('\nasync function', start + 10));
    assert.match(body, /a === '--seat'/, 'cmdDispatch must parse --seat in its arg loop');
    assert.match(body, /doDispatch\([^)]*seat\s*\)/, 'the parsed seat must reach doDispatch');
});

test('doDispatch puts seat in the /kanban/dispatch body', () => {
    const start = CLI.indexOf('async function doDispatch(');
    assert(start > -1, 'expected doDispatch in cli.ts');
    const body = CLI.slice(start, start + 900);
    assert.match(body, /seat\?:\s*string/, 'doDispatch must accept a seat parameter');
    assert.match(body, /seat\s*\?\s*\{\s*seat\s*\}/, 'seat must be sent in the POST body only when supplied');
});

test('_handleKanbanDispatch reads body.seat and forwards it as targetTerminalOverride', () => {
    const start = API.indexOf('private async _handleKanbanDispatch(');
    assert(start > -1, 'expected _handleKanbanDispatch in LocalApiServer.ts');
    const body = API.slice(start, API.indexOf('\n    /**', start));
    assert.match(body, /body\?\.seat/, '_handleKanbanDispatch must read seat off the request body');
    const hits = body.match(/targetTerminalOverride:\s*seat/g) || [];
    assert.strictEqual(hits.length, 2,
        'both the acked and unacked dispatch arms must forward the seat, or --seat works on one path only');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
