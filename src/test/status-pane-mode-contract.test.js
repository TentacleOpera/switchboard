'use strict';

/**
 * Status-pane mode contract.
 *
 * `paneModes` gained a third value, `'status'`, and the entire risk of that
 * change is that ~23 existing sites binary-test the mode. A third value
 * inheriting the wrong branch COMPILES CLEAN and misbehaves silently — there is
 * no runtime harness for the pane grid, so source assertions are the only place
 * these invariants can be pinned at all.
 *
 * Every test here is one of the plan's Goal Invariants. A failure means a status
 * pane is behaving as a terminal pane (or vice versa) at a site nothing else
 * checks.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const TERMINALS_JS = path.join(repoRoot, 'src', 'webview', 'terminals.js');
const TERMINALS_HTML = path.join(repoRoot, 'src', 'webview', 'terminals.html');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

const src = fs.readFileSync(TERMINALS_JS, 'utf8');
const html = fs.readFileSync(TERMINALS_HTML, 'utf8');

/** Extract a top-level `function name(...) { ... }` body by brace matching. */
function fnBody(name) {
    const marker = `function ${name}(`;
    const start = src.indexOf(marker);
    assert.ok(start > -1, `function ${name} not found in terminals.js`);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') { depth++; }
        else if (src[j] === '}') { depth--; if (depth === 0) { return src.slice(start, j + 1); } }
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

/* ── The persisted value survives a reload ──────────────────────────────── */

test("the restore path preserves 'status' instead of coercing it to 'terminal'", () => {
    // The pre-change line was `m === 'kanban' ? 'kanban' : 'terminal'`, which
    // silently turned every persisted status pane back into a terminal on the
    // first reload — the feature working in-session and failing across one.
    assert.match(
        src,
        /savedModes\.map\(m =>[^\n]*'status'[^\n]*'status'/,
        "the savedModes restore map must carry 'status' through"
    );
});

/* ── Seating: an unassigned status pane is free, and filling it turns output on ─ */

test('the sidebar seating path flips the pane to terminal alongside the assignment', () => {
    const idxAssign = src.indexOf("paneAssignments[target] = terminalName;");
    assert.ok(idxAssign > -1, 'the sidebar seating assignment was not found');
    const after = src.slice(idxAssign, idxAssign + 900);
    assert.match(after, /paneModes\[target\] = 'terminal';/,
        "seating must set paneModes[target] = 'terminal' at the seating path, not at render time");
});

test('the Open All seating path flips the pane to terminal alongside the assignment', () => {
    const m = src.match(/if \(!paneAssignments\[i\] && paneModes\[i\] !== 'kanban'\) \{\s*\n\s*paneAssignments\[i\] = unseated\.shift\(\);\s*\n\s*paneModes\[i\] = 'terminal';/);
    assert.ok(m, "the Open All fill must set paneModes[i] = 'terminal' when it seats a terminal");
});

test('the team seating path flips the slot to terminal alongside the assignment', () => {
    const m = src.match(/paneModes\[slot\] = 'terminal';\s*\n\s*next\[slot\+\+\] = name;/);
    assert.ok(m, "team seating must set paneModes[slot] = 'terminal' before filling the slot");
});

/* ── The kanban-with-assignment flip must NOT be extended to status ─────── */

test("an assigned status pane is not flipped to terminal by the kanban render-time flip", () => {
    const idx = src.indexOf("if (paneModes[index] === 'kanban' && assignedName) {");
    assert.ok(idx > -1, 'the kanban-with-assignment flip was not found');
    const arm = src.slice(idx, idx + 200);
    assert.ok(!arm.includes("'status'"),
        "the kanban flip must test kanban ALONE — an assigned status pane is the feature's entire point");
});

/* ── Overlays that would cover the card ─────────────────────────────────── */

test('working silence clears for a status pane, not only for a kanban pane', () => {
    const body = fnBody('updateWorkingSilence');
    assert.match(body, /paneModes\[paneIndex\] === 'kanban' \|\| paneModes\[paneIndex\] === 'status'/,
        'the working-silence guard must clear for status panes — the overlay would cover the status card');
});

test('the status branch strips curtains, which are opaque full-pane overlays', () => {
    const idx = src.indexOf('if (isStatusPane) {');
    assert.ok(idx > -1, 'the status render branch was not found');
    const arm = src.slice(idx, idx + 1800);
    assert.match(arm, /querySelectorAll\('\.startup-curtain, \.terminal-curtain'\)/,
        'a status pane must remove curtains — they paint opaque over the whole pane');
});

/* ── Pop-out stays reachable: the "I need to type" escape hatch ─────────── */

test('the pop-out button is gated on not-kanban, so a status pane keeps it', () => {
    assert.match(
        src,
        /popoutBtn\.style\.display = \(peekTerminalName !== assignedName && !isSoloPanel && paneModes\[index\] !== 'kanban'\)/,
        "pop-out must be gated `!== 'kanban'`; `=== 'terminal'` hides it for a status pane"
    );
});

/* ── The socket, not the view, is what a status pane gives up ───────────── */

test('entering status suspends the stream and does not dispose the terminal', () => {
    const idx = src.indexOf('if (isStatusPane) {');
    const arm = src.slice(idx, idx + 1800);
    assert.match(arm, /suspendTerminalStream\(entry\)/, 'a status pane must suspend its stream');
    assert.ok(!/createTerminalView\(/.test(arm),
        'a status pane must never CREATE a terminal view — that opens the socket it exists to close');
    const suspend = fnBody('suspendTerminalStream');
    assert.ok(!/term\.dispose\(\)/.test(suspend),
        'suspendTerminalStream must not dispose entry.term — the scrollback is what makes the toggle instant');
    assert.match(suspend, /entry\.ws\.close\(\)/, 'suspendTerminalStream must close the socket');
    assert.match(suspend, /entry\.batchQueue = \[\];/,
        'suspendTerminalStream must DROP the queued batch — flushBatch only skips it, so it would be replayed twice');
});

test('leaving status resumes the stream from lastSeq', () => {
    const resume = fnBody('resumeTerminalStream');
    assert.match(resume, /connectTerminalSocket\(entry\)/, 'resume must reconnect');
    assert.match(src, /wsUrl \+= `&lastSeq=/, 'the reconnect must carry lastSeq so the gateway replays only the tail');
});

test('resume is invoked only after the container is marked active', () => {
    const activeIdx = src.indexOf("entry.container.classList.add('active');");
    const resumeIdx = src.indexOf('if (entry.suspended) { resumeTerminalStream(entry); }');
    assert.ok(activeIdx > -1 && resumeIdx > -1, 'both the active class and the resume call must exist');
    assert.ok(activeIdx < resumeIdx,
        'resume must run AFTER .active — attachRenderer reads isRendered(), and a display:none host acquires no renderer');
});

/* ── Presentation: a toggle, never a third peer in a picker ─────────────── */

test('the output control is a per-pane toggle between terminal and status', () => {
    assert.match(src, /paneModes\[index\] = paneModes\[index\] === 'status' \? 'terminal' : 'status';/,
        'the output button must toggle the pane between terminal and status');
});

test('no mode picker offering three peer values exists', () => {
    // A <select>/<option> carrying 'status' beside 'kanban' would be the picker
    // matrix the plan's non-goals forbid.
    assert.ok(!/<option[^>]*value=["']status["']/.test(src) && !/<option[^>]*value=["']status["']/.test(html),
        "status must never appear as an <option> — it is a toggle on a terminal pane, not a peer mode");
});

test('nothing enforces a maximum of one terminal-mode pane', () => {
    // The solo gesture flips OTHERS to status; it is an operator action and lives
    // on a click handler. An ENFORCEMENT would look like the render path deciding
    // the modes for itself, so that is what is pinned.
    for (const fn of ['renderPaneGrid', 'updatePaneElement']) {
        assert.ok(!/paneModes\[[^\]]+\] = 'status'/.test(fnBody(fn)),
            `${fn} must never assign status — per-pane choice is the operator's, not the grid's`);
    }
    // And no count-based cap anywhere.
    assert.ok(!/filter\([^)]*'terminal'[^)]*\)\.length\s*[><=]/.test(src),
        'nothing may compare a count of terminal-mode panes against a limit');
});

/* ── Declared over inferred, and honest failure ─────────────────────────── */

test('the pane reads its state through one resolver, not inline per render site', () => {
    assert.match(src, /function resolveSeatState\(name\)/, 'resolveSeatState must exist');
    const render = fnBody('renderStatusPane');
    assert.match(render, /resolveSeatState\(name\)/, 'renderStatusPane must go through the resolver');
    // The card must not reach around the resolver into the raw sources.
    assert.ok(!/fleetList\./.test(render), 'renderStatusPane must not read fleetList directly');
    assert.ok(!/terminalsMap\./.test(render), 'renderStatusPane must not read terminalsMap directly');
    assert.ok(!/terminalBadges\./.test(render), 'renderStatusPane must not read terminalBadges directly');
});

test('a declared report renders above the host-derived block', () => {
    const render = fnBody('renderStatusPane');
    const declaredIdx = render.indexOf("'status-pane-declared'");
    const inferredIdx = render.indexOf("'status-pane-inferred'");
    assert.ok(declaredIdx > -1 && inferredIdx > -1, 'both blocks must be rendered');
    assert.ok(declaredIdx < inferredIdx,
        'the declared block must be built before the host-derived block — the ordering is the contract');
});

test('the host-derived block is labelled as host-derived', () => {
    const render = fnBody('renderStatusPane');
    assert.match(render, /textContent = 'host-derived'/,
        'inferred signals must carry a label saying so — a guess must never read as a declaration');
});

test('only the declared vocabulary is accepted from the inbox', () => {
    assert.match(src, /SEAT_REPORT_KINDS = \['finished', 'blocked', 'question', 'status'\]/,
        'the report vocabulary must match the inbox directive in agentPromptBuilder.ts');
    const parse = fnBody('parseSeatReport');
    assert.match(parse, /SEAT_REPORT_KINDS\.includes\(kind\)/,
        'an unrecognised kind must be dropped, never shown under a guessed label');
});

test('inbox reachability is tracked per team, not as one global flag', () => {
    const refresh = fnBody('refreshSeatReports');
    assert.match(refresh, /nextOk\.set\(id, false\)/,
        'each team must record its own inbox outcome — one global flag either cries wolf or hides a dead inbox');
    assert.match(refresh, /nextOk\.set\(id, true\)/, 'a successful team inbox must be recorded as such');
    const resolve = fnBody('resolveSeatState');
    assert.match(resolve, /reportsSource/, 'the resolver must report which inbox answered, not just whether one did');
    const render = fnBody('renderStatusPane');
    assert.ok(/'nothing declared'/.test(render)
        && /did not answer/.test(render)
        && /no readable report inbox/.test(render),
        'the three cases — declared-nothing, inbox-unreachable, no-inbox — must render as three different sentences');
});

test('an unresolvable state renders as unreachable, visually distinct from idle', () => {
    const resolve = fnBody('resolveSeatState');
    assert.match(resolve, /reachable: false/, 'the resolver must be able to answer unreachable');
    assert.match(resolve, /fleetFetchFailed/,
        'a failed fleet poll must produce unreachable — a stale row rendered as fact is the hazard this guards');
    const render = fnBody('renderStatusPane');
    assert.match(render, /is-unreachable/, 'the unreachable state must carry its own class');
    assert.match(render, /textContent = 'unreachable'/, 'the unreachable state must say the word');
    assert.match(html, /\.status-pane-card\.is-unreachable \{/,
        'the unreachable card must be styled distinctly from a populated one');
});

test('the fleet-failure flag is set on both failure paths and cleared on success', () => {
    const fetchFn = fnBody('fetchTerminalList');
    assert.match(fetchFn, /if \(!res\.ok\) \{ fleetFetchFailed = true; \}/, 'a non-OK response must set the flag');
    assert.match(fetchFn, /fleetFetchFailed = true;\s*\n\s*console\.warn/, 'a thrown fetch must set the flag');
    assert.match(fetchFn, /fleetFetchFailed = false;\s*\n\s*hasFetchedList = true;/, 'a good poll must clear the flag');
});

/* ── The stats surface must be able to answer the verification ──────────── */

test('__sbTerminalStats reports suspension and socket state', () => {
    assert.match(src, /suspended: entry\.suspended === true,/,
        '__sbTerminalStats must report suspension — the plan verifies closed sockets through it');
    assert.match(src, /wsState: entry\.ws \? entry\.ws\.readyState : null,/,
        '__sbTerminalStats must report the socket state');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
