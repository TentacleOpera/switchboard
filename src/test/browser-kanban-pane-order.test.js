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

/* ── Autocode aggregate (CODED_AUTO) ───────────────────────────────────────
   Every failure mode here is SILENT: a wrong branch renders an empty pane that
   reads as "nothing is out for coding", and a wrong guard quietly rewrites the
   operator's persisted selection. Source assertions are the cheapest place to
   pin them — the pane has no headless harness. */

test('the aggregate id is never sent to getBoardCards as a column filter', () => {
    const fnMatch = terminalsSrc.match(/async function fetchBoardCardsForPane[\s\S]*?\n    \}/);
    assert.ok(fnMatch, 'could not extract fetchBoardCardsForPane body');
    const body = fnMatch[0];
    assert.match(body, /isAggregate\s*=\s*col\s*===\s*AGGREGATE_CODED_ID/,
        'the fetch must detect the aggregate before building the request body');
    assert.match(body, /if\s*\(\s*!isAggregate\s*\)\s*\{\s*body\.column\s*=\s*col;\s*\}/,
        'column must be OMITTED for the aggregate — getBoardCards compares columns with a literal ===, so sending CODED_AUTO returns an empty list rather than an error');
    assert.strictEqual((body.match(/body\.column\s*=/g) || []).length, 1,
        'body.column must be assigned exactly once, inside the !isAggregate guard — a second unguarded assignment reinstates the silent-empty failure');
});

test('the aggregate collapse-reset is gated on a POPULATED structure cache', () => {
    // codedColumnIds() is empty both when the union genuinely collapsed AND before
    // the first getKanbanStructure lands. Keying the reset on length alone clobbers
    // a persisted CODED_AUTO to CREATED on every reload, and persists it.
    assert.match(terminalsSrc,
        /const\s+structureLanded\s*=\s*kanbanColumnsCache\.length\s*>\s*0/,
        'structureLanded must be derived from kanbanColumnsCache.length > 0');
    assert.match(terminalsSrc,
        /if\s*\(\s*structureLanded\s*&&\s*chosen\s*===\s*AGGREGATE_CODED_ID\s*&&\s*!aggregateOffered\s*\)/,
        'the CODED_AUTO reset must require structureLanded — otherwise the pre-structure first paint destroys the persisted selection');
});

test('the aggregate option is offered on the board\'s terms, not its own', () => {
    // Must track kanban.html renderColumns(): collapse toggle ON + at least one
    // coder column. A `coded.length > 1` floor here would leave the pane offering
    // individual coder columns while the board shows only the bucket.
    assert.match(terminalsSrc,
        /const\s+aggregateOffered\s*=\s*structureLanded\s*&&\s*kanbanCollapseCoders\s*&&\s*coded\.length\s*>\s*0/,
        'the aggregate must be gated on the board collapse toggle and a non-empty coder set');
});

test('the pane reads the board collapse toggle off the structure response', () => {
    assert.match(terminalsSrc, /let\s+kanbanCollapseCoders\s*=\s*true/,
        'kanbanCollapseCoders must default true, matching kanban.html\'s own default');
    assert.match(terminalsSrc,
        /kanbanCollapseCoders\s*=\s*structData\.collapseCoders\s*!==\s*false/,
        'must use `!== false` — a host predating the flag omits it, and the board default is ON');
});

test('the aggregate SUBSTITUTES for the coder columns and keeps their order slot', () => {
    // The original appended it, which stranded the bucket past Completed at the tail
    // of the picker while the board renders it mid-pipeline.
    assert.doesNotMatch(terminalsSrc, /liveColumns\.concat\(\[\s*\{\s*\n?\s*id:\s*AGGREGATE_CODED_ID/,
        'the aggregate must not be appended to the full column list');
    assert.match(terminalsSrc, /liveColumns\s*\n?\s*\.filter\(c\s*=>\s*c\.kind\s*!==\s*'coded'\)/,
        'the coder columns must be filtered out when the aggregate is offered');
    assert.match(terminalsSrc,
        /order:\s*kanbanColumnsCache\.find\(c\s*=>\s*c\.kind\s*===\s*'coded'\)\?\.order\s*\|\|\s*180/,
        'the aggregate must inherit the FIRST coder column\'s order, matching kanban.html renderColumns()');
    assert.match(terminalsSrc, /\.sort\(\(a,\s*b\)\s*=>\s*\(a\.order\s*\|\|\s*0\)\s*-\s*\(b\.order\s*\|\|\s*0\)\)/,
        'the substituted list must be re-sorted by order');
});

test('the aggregate label is title case, not SHOUTED', () => {
    const labelMatch = terminalsSrc.match(/const\s+AGGREGATE_CODED_LABEL\s*=\s*'([^']+)'/);
    assert.ok(labelMatch, 'AGGREGATE_CODED_LABEL must be declared');
    const label = labelMatch[1];
    // The picker is a plain <select> with no text-transform, so its options render
    // raw. Every real column label ships title case ('New', 'Planned', 'Lead Coder')
    // and is uppercased by the BOARD's .column-name CSS, which the pane does not have.
    assert.notStrictEqual(label, label.toUpperCase(),
        `AGGREGATE_CODED_LABEL is '${label}' — an all-caps label shouts next to the title-case column labels in the same <select>`);
});

test('the board persists collapseCoders host-side so other surfaces can read it', () => {
    assert.match(kanbanSrc, /postKanbanMessage\(\{\s*type:\s*'toggleCollapseCoders',\s*enabled:\s*collapseCodersEnabled\s*\}\)/,
        'the collapse toggle must write through to the host — vscode.getState() is per-webview and the terminals pane cannot read it');
    assert.match(kanbanSrc, /case\s*'collapseCodersState'/,
        'the board must adopt the host-pushed collapse state');
});

test('bodySig reacts to a card changing column', () => {
    const sigLine = terminalsSrc.split('\n').find(l => l.includes('c.subtaskCount || 0'));
    assert.ok(sigLine, 'could not locate the bodySig card mapping');
    assert.ok(sigLine.includes('c.column'),
        'bodySig must include c.column — in aggregate mode a card moving Lead → Coder changes nothing else, so the row chip would freeze on its first value forever');
});

test('kanban.html still carries its own comparator (parity check)', () => {
    assert.match(kanbanSrc, /sortedItems\s*=\s*\[\.\.\.items\]\.sort/,
        'kanban.html must still have its column sort — the two comparators must stay in sync');
    assert.match(kanbanSrc, /lastActivity/,
        'kanban.html comparator must still use lastActivity');
});

test('kanban pane selection state is declared per-pane', () => {
    assert.match(terminalsSrc, /let\s+kanbanPaneSelection\s*=\s*\{\}/, 'kanbanPaneSelection object must be declared');
    assert.match(terminalsSrc, /function\s+paneSelection\s*\(\s*index\s*\)\s*\{/, 'paneSelection(index) accessor must exist');
});

test('drop handler accepts multi-id payload and posts sessionIds: ids', () => {
    assert.ok(terminalsSrc.includes('planIds, column, workspaceRoot, sourcePaneIndex'), 'drop handler must destructure planIds');
    assert.ok(terminalsSrc.includes('sessionIds: ids,'), 'promptSelected request must use sessionIds: ids');
    assert.ok(!terminalsSrc.includes('sessionIds: [planId || sessionId]'), 'legacy single-id sessionIds must not remain');
});

test('drop handler rejects bare-array drag payloads before destructure', () => {
    const arrayIdx = terminalsSrc.indexOf('Array.isArray(dragData)');
    const destrIdx = terminalsSrc.indexOf('planIds, column, workspaceRoot, sourcePaneIndex');
    assert.ok(arrayIdx > -1 && destrIdx > -1 && arrayIdx < destrIdx, 'Array.isArray rejection must appear before the dragData destructure');
});

test('bodySig does not include selection state', () => {
    const sigLine = terminalsSrc.split('\n').find(l => l.includes('c.subtaskCount || 0'));
    assert.ok(sigLine, 'could not locate the bodySig line');
    assert.ok(!sigLine.includes('kanbanPaneSelection'), 'bodySig must not reference kanbanPaneSelection');
});

test('row click handler guards buttons and does not select plans', () => {
    const clickStart = terminalsSrc.indexOf("row.addEventListener('click', (e) => {");
    assert.ok(clickStart > -1, 'row click listener must exist');
    const clickEnd = terminalsSrc.indexOf('const rowText = document.createElement', clickStart);
    assert.ok(clickEnd > clickStart, 'row click listener must end before rowText');
    const clickBlock = terminalsSrc.slice(clickStart, clickEnd);
    assert.ok(clickBlock.includes("if (e.target.closest('button')) { return; }"), 'click handler must ignore button clicks');
    assert.ok(!clickBlock.includes('selectPlan'), 'click handler must not post selectPlan');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
