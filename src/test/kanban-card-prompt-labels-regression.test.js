'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const kanbanHtmlSource = fs.readFileSync(kanbanHtmlPath, 'utf8');

    // Extract the label logic block
    const match = kanbanHtmlSource.match(/let copyLabel = 'Copy Prompt';[\s\S]*?(?=primaryActionBtn =)/);
    assert.ok(match, 'Could not find copyLabel logic in kanban.html');

    const logicStr = match[0];

    // Build an evaluator
    function evaluateLabel(cardColumn, getNextColumnImpl, columnDefs, columnsArr, collapseCodersEnabled = true) {
        let card = { column: cardColumn };
        let columnDefinitions = columnDefs;
        let getNextColumn = getNextColumnImpl;
        let columns = columnsArr;
        
        // Execute the extracted logic
        const wrappedLogic = logicStr + '\nreturn copyLabel;';
        const func = new Function('card', 'columnDefinitions', 'getNextColumn', 'columns', 'collapseCodersEnabled', wrappedLogic);
        return func(card, columnDefinitions, getNextColumn, columns, collapseCodersEnabled);
    }

    // Mocks
    const stdDefs = [
        { id: 'CREATED', kind: 'standard' },
        { id: 'PLAN REVIEWED', kind: 'standard', role: 'planner' },
        { id: 'LEAD CODED', role: 'lead' },        // Realistic: no kind: 'coded'
        { id: 'CODER CODED', role: 'coder' },      // Realistic: no kind: 'coded'
        { id: 'CODE REVIEWED', kind: 'standard', role: 'reviewer' }
    ];
    const stdColumns = stdDefs.map(d => d.id);

    const customDefs = [
        { id: 'CREATED', kind: 'standard' },
        { id: 'CUSTOM_USER', kind: 'custom-user' },
        { id: 'PLAN REVIEWED', kind: 'standard', role: 'planner' },
        { id: 'LEAD CODED', role: 'lead' },
        { id: 'CODER CODED', role: 'coder' },
        { id: 'CODE REVIEWED', kind: 'standard', role: 'reviewer' }
    ];
    const customColumns = customDefs.map(d => d.id);

    // Mock getNextColumn using columns array, not defs
    function sourceToNext(src, cols) {
        const idx = cols.indexOf(src);
        if (idx >= 0 && idx < cols.length - 1) {
            return cols[idx + 1];
        }
        return null;
    }

    // TEST: CREATED -> custom column -> "Copy advance prompt"
    let label = evaluateLabel('CREATED', (src) => sourceToNext(src, customColumns), customDefs, customColumns);
    assert.strictEqual(label, 'Copy advance prompt', 'CREATED -> custom column failed');

    // TEST: CREATED -> PLAN REVIEWED -> "Copy planning prompt"
    label = evaluateLabel('CREATED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns);
    assert.strictEqual(label, 'Copy planning prompt', 'CREATED -> PLAN REVIEWED failed');

    // TEST: PLAN REVIEWED -> LEAD CODED -> "Copy coder prompt"
    label = evaluateLabel('PLAN REVIEWED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns);
    assert.strictEqual(label, 'Copy coder prompt', 'PLAN REVIEWED -> LEAD CODED failed');

    // TEST: LEAD CODED -> CODER CODED -> "Copy coder prompt" (when collapseCodersEnabled=false)
    label = evaluateLabel('LEAD CODED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns, false);
    assert.strictEqual(label, 'Copy coder prompt', 'LEAD CODED -> CODER CODED failed (collapsed=false)');
    
    // TEST: CODER CODED -> CODE REVIEWED -> "Copy review prompt" (when collapseCodersEnabled=false)
    label = evaluateLabel('CODER CODED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns, false);
    assert.strictEqual(label, 'Copy review prompt', 'CODER CODED -> CODE REVIEWED failed (collapsed=false)');

    // TEST: CODED_AUTO -> next real column resolved correctly
    label = evaluateLabel('CODED_AUTO', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns);
    assert.strictEqual(label, 'Copy review prompt', 'CODED_AUTO synthetic card failed');

    // TEST: LEAD CODED -> "Copy review prompt" when collapseCodersEnabled=true (visually in AUTOCODE)
    label = evaluateLabel('LEAD CODED', (src) => sourceToNext(src, stdColumns), stdDefs, stdColumns, true);
    assert.strictEqual(label, 'Copy review prompt', 'LEAD CODED card in AUTOCODE bucket failed');

    console.log('kanban card prompt labels regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban card prompt labels regression test failed:', error);
    process.exit(1);
}
