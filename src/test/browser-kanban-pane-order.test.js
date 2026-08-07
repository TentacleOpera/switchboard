'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const TERMINALS_JS = path.join(repoRoot, 'src', 'webview', 'terminals.js');
const KANBAN_HTML = path.join(repoRoot, 'src', 'webview', 'kanban.html');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

const terminalsSrc = fs.readFileSync(TERMINALS_JS, 'utf8');
const kanbanSrc = fs.readFileSync(KANBAN_HTML, 'utf8');

test('terminals.js defines compareCardsByRecency', () => {
    assert.match(terminalsSrc, /function\s+compareCardsByRecency\s*\(/,
        'compareCardsByRecency must exist as a named function in terminals.js');
});

test('terminals.js defines cardTimestamp that floors NaN to 0', () => {
    assert.match(terminalsSrc, /function\s+cardTimestamp\s*\(/,
        'cardTimestamp helper must exist');
    assert.match(terminalsSrc, /isNaN\s*\(\s*t\s*\)\s*\?\s*0/,
        'cardTimestamp must floor NaN to 0, matching kanban.html:6367');
});

test('terminals.js sorts pane cards before building bodySig', () => {
    // The sort must be on the line that produces `cards`, before bodySig.
    assert.match(terminalsSrc, /\.sort\(compareCardsByRecency\)/,
        'cards must be sorted with compareCardsByRecency');
    // Verify the sort appears before bodySig in the source.
    const sortIdx = terminalsSrc.indexOf('.sort(compareCardsByRecency)');
    const sigIdx = terminalsSrc.indexOf('bodySig');
    assert.ok(sortIdx > -1 && sigIdx > -1 && sortIdx < sigIdx,
        'sort must appear before bodySig in source order — sorting after signature causes infinite re-render');
});

test('compareCardsByRecency uses lastActivity primary, createdAt tiebreaker', () => {
    const fnMatch = terminalsSrc.match(/function\s+compareCardsByRecency[\s\S]*?\n\s*\}/);
    assert.ok(fnMatch, 'could not extract compareCardsByRecency body');
    const body = fnMatch[0];
    assert.ok(body.includes('lastActivity'), 'comparator must use lastActivity as primary key');
    assert.ok(body.includes('createdAt'), 'comparator must use createdAt as tiebreaker');
});

test('kanban.html still carries its own comparator (parity check)', () => {
    assert.match(kanbanSrc, /sortedItems\s*=\s*\[\.\.\.items\]\.sort/,
        'kanban.html must still have its column sort — the two comparators must stay in sync');
    assert.match(kanbanSrc, /lastActivity/,
        'kanban.html comparator must still use lastActivity');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
