'use strict';

/**
 * Contract: Start Grid ("OPEN AGENT TERMINALS") creates `plannerTerminalCount`
 * NEW planner terminals, in BOTH grid-building paths.
 *
 * The defect: `plannerTerminalCount` was read as "top up to N total", so an
 * already-live Planner ate a slot and a request for 4 planners produced 3. The
 * two paths are the VS Code extension (`createAgentGrid` in extension.ts) and
 * the browser/standalone panel (`openAllTerminals` in webview/terminals.js).
 *
 * Mostly a source-text contract (the panel is a browser-only IIFE with no export
 * surface), with one genuinely behavioural test: the planner-name regex is lifted
 * out of the extension source and exercised against real terminal names, because
 * the gap case (Planner 1 and Planner 3 live, Planner 2 closed) is exactly where
 * a count-based offset silently regresses.
 *
 * Run with: node src/test/terminal-grid-planner-count-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');
const EXT = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

// ---------------------------------------------------------------- extension path

const extPlannerBlock = block(
    EXT,
    'const plannerCount = await taskViewerProvider.getPlannerTerminalCount(',
    'for (const agent of customAgents) {'
);

test('extension: the agents list no longer numbers planners from 1 unconditionally', () => {
    assert.ok(
        !/for \(let n = 1; n <= plannerCount; n\+\+\)/.test(extPlannerBlock),
        'numbering from 1 makes an existing Planner 1 be reused instead of created — the undercount'
    );
});

test('extension: planners are numbered from maxPlannerNum + 1 for plannerCount entries', () => {
    assert.ok(
        /let maxPlannerNum = 0;/.test(extPlannerBlock),
        'the highest live planner number must be scanned before the agents list is built'
    );
    assert.ok(
        /const startN = maxPlannerNum \+ 1;/.test(extPlannerBlock),
        'the loop must start at maxPlannerNum + 1 — COUNT-based offsets collide across gaps'
    );
    assert.ok(
        /for \(let n = startN; n < startN \+ plannerCount; n\+\+\)/.test(extPlannerBlock),
        'the loop must run plannerCount times from startN, creating that many NEW planners'
    );
});

test('extension: the scan runs over live terminals and skips exited ones', () => {
    assert.ok(
        /for \(const t of vscode\.window\.terminals\)/.test(extPlannerBlock),
        'the scan must read vscode.window.terminals'
    );
    assert.ok(
        /if \(t\.exitStatus !== undefined\) \{ continue; \}/.test(extPlannerBlock),
        'exited terminals must not contribute a planner number'
    );
});

test('extension: the planner-name regex matches every live planner name shape', () => {
    // Lift the ACTUAL regex out of the source and run it — this is the piece the
    // gap case turns on, so it is exercised rather than merely spelled.
    const m = extPlannerBlock.match(/\/(\^Planner[^/]*)\//);
    assert.ok(m, 'the planner-name regex must be present in the scan');
    const re = new RegExp(m[1]);
    const cases = [
        ['Planner', 1],
        ['Planner 2', 2],
        ['Planner 10', 10],
        ['Planner (2)', 1],      // VS Code dedup suffix on the bare name
        ['Planner 2 (1)', 2]     // dedup suffix on a numbered name
    ];
    for (const [name, expected] of cases) {
        const match = name.trim().match(re);
        assert.ok(match, `"${name}" must match the planner-name regex`);
        const num = match[1] ? parseInt(match[1], 10) : 1;
        assert.strictEqual(num, expected, `"${name}" must resolve to planner number ${expected}`);
    }
    for (const name of ['Planner X', 'Lead Coder', 'Planner2', 'Planners', 'Planner 2x']) {
        assert.ok(!name.trim().match(re), `"${name}" must NOT match the planner-name regex`);
    }
});

test('extension: max-based offset survives the gap case', () => {
    // Planner 1 and Planner 3 live (Planner 2 closed): count = 2, max = 3.
    // A count-based offset (startN = 3) would collide with the live Planner 3.
    const live = ['Planner', 'Planner 3'];
    const re = new RegExp(extPlannerBlock.match(/\/(\^Planner[^/]*)\//)[1]);
    let maxPlannerNum = 0;
    for (const name of live) {
        const match = name.match(re);
        const num = match[1] ? parseInt(match[1], 10) : 1;
        if (num > maxPlannerNum) { maxPlannerNum = num; }
    }
    assert.strictEqual(maxPlannerNum, 3, 'the scan must find the MAX (3), not the count (2)');
    const startN = maxPlannerNum + 1;
    const created = [];
    for (let n = startN; n < startN + 4; n++) {
        created.push(n === 1 ? 'Planner' : `Planner ${n}`);
    }
    assert.deepStrictEqual(
        created, ['Planner 4', 'Planner 5', 'Planner 6', 'Planner 7'],
        'a request for 4 planners must produce 4 NEW, non-colliding names'
    );
    for (const name of created) {
        assert.ok(!live.includes(name), `new name "${name}" must not collide with a live terminal`);
    }
});

// ---------------------------------------------------------------- browser path

const openAll = block(SRC, 'async function openAllTerminals() {', 'await fetchTerminalList();');

test('browser: planners are batch-created, not topped up', () => {
    assert.ok(
        /const missing = \(role === 'planner' && count > 1\)\s*\n\s*\? count\s*\n\s*: count - \(liveByRole\.get\(role\) \|\| 0\);/.test(openAll),
        'the planner role must request `count` new terminals regardless of how many are live'
    );
});

test('browser: plannedTotal uses the same planner rule, or the grid under-sizes', () => {
    assert.ok(
        /plannedTotal \+= \(role === 'planner' && count > 1\)\s*\n\s*\? count\s*\n\s*: Math\.max\(0, count - \(liveByRole\.get\(role\) \|\| 0\)\);/.test(openAll),
        'plannedTotal must count the batch-created planners too — otherwise the grid is sized for fewer panes than terminals created'
    );
});

test('browser: non-planner roles keep the top-up behaviour', () => {
    // wanted is 1 for every other role; `count - live` is what makes a second
    // Start Grid press reuse an existing Coder instead of doubling the fleet.
    assert.ok(
        /count - \(liveByRole\.get\(role\) \|\| 0\)/.test(openAll),
        'non-planner roles must stay top-up'
    );
    assert.ok(
        !/role === 'coder'/.test(openAll),
        'no special case may be added for non-planner roles'
    );
});

test('browser: plannerCount comes from the agents setting and is >= 1', () => {
    const resolve = block(SRC, 'async function resolveGridAgents() {', 'async function createTerminalsForRole(');
    assert.ok(
        /loadSetting\('agents\.plannerTerminalCount', 1\)/.test(resolve),
        'the count must come from the same setting the extension reads'
    );
    assert.ok(
        /wanted\.set\(role, role === 'planner' \? plannerCount : 1\)/.test(resolve),
        'planner must be the only role with a count other than 1'
    );
});

console.log(failed === 0 ? '\nAll planner-count contracts passed.' : `\n${failed} contract(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
