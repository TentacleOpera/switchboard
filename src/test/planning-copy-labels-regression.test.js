'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const planningJsPath = path.join(process.cwd(), 'src', 'webview', 'planning.js');
    const planningJsSource = fs.readFileSync(planningJsPath, 'utf8');

    // Extract the _getCopyLabel function by brace counting
    const startIdx = planningJsSource.indexOf('function _getCopyLabel(sourceColumn) {');
    assert.ok(startIdx >= 0, 'Could not find _getCopyLabel function start in planning.js');

    let braceCount = 0;
    let foundOpen = false;
    let endIdx = startIdx;
    for (let i = startIdx; i < planningJsSource.length; i++) {
        if (planningJsSource[i] === '{') {
            braceCount++;
            foundOpen = true;
        } else if (planningJsSource[i] === '}') {
            braceCount--;
        }
        if (foundOpen && braceCount === 0) {
            endIdx = i + 1;
            break;
        }
    }
    const funcStr = planningJsSource.substring(startIdx, endIdx);
    assert.ok(funcStr.includes('return copyLabel;'), 'Extracted _getCopyLabel appears incomplete');

    function evaluateLabel(sourceColumn, kanbanAvailableColumns) {
        const wrappedFunc = `
            let _kanbanAvailableColumns = ${JSON.stringify(kanbanAvailableColumns)};
            ${funcStr}
            return _getCopyLabel(sourceColumn);
        `;
        const fn = new Function('sourceColumn', wrappedFunc);
        return fn(sourceColumn);
    }

    // Mock columns reflecting actual webview payload from PlanningPanelProvider.ts (no role field)
    const stdColumns = [
        { id: 'CREATED', label: 'New', kind: 'created', order: 0 },
        { id: 'PLAN REVIEWED', label: 'Planned', kind: 'review', order: 100 },
        { id: 'LEAD CODED', label: 'Lead Coder', kind: 'coded', order: 180 },
        { id: 'CODER CODED', label: 'Coder', kind: 'coded', order: 190 },
        { id: 'INTERN CODED', label: 'Intern', kind: 'coded', order: 200 },
        { id: 'CODE REVIEWED', label: 'Reviewed', kind: 'reviewed', order: 300 }
    ];

    const customColumns = [
        { id: 'CREATED', label: 'New', kind: 'created', order: 0 },
        { id: 'CUSTOM_USER', label: 'Custom', kind: 'custom-user', order: 50 },
        { id: 'PLAN REVIEWED', label: 'Planned', kind: 'review', order: 100 },
        { id: 'LEAD CODED', label: 'Lead Coder', kind: 'coded', order: 180 },
        { id: 'CODER CODED', label: 'Coder', kind: 'coded', order: 190 },
        { id: 'CODE REVIEWED', label: 'Reviewed', kind: 'reviewed', order: 300 }
    ];

    // TEST: CREATED -> PLAN REVIEWED -> "Copy planning prompt"
    let label = evaluateLabel('CREATED', stdColumns);
    assert.strictEqual(label, 'Copy planning prompt', 'CREATED -> PLAN REVIEWED failed');

    // TEST: PLAN REVIEWED -> LEAD CODED -> "Copy coder prompt"
    label = evaluateLabel('PLAN REVIEWED', stdColumns);
    assert.strictEqual(label, 'Copy coder prompt', 'PLAN REVIEWED -> LEAD CODED failed');

    // TEST: LEAD CODED -> CODER CODED -> "Copy coder prompt"
    label = evaluateLabel('LEAD CODED', stdColumns);
    assert.strictEqual(label, 'Copy coder prompt', 'LEAD CODED -> CODER CODED failed');

    // TEST: CODER CODED -> INTERN CODED -> "Copy coder prompt"
    label = evaluateLabel('CODER CODED', stdColumns);
    assert.strictEqual(label, 'Copy coder prompt', 'CODER CODED -> INTERN CODED failed');

    // TEST: INTERN CODED -> CODE REVIEWED -> "Copy review prompt"
    label = evaluateLabel('INTERN CODED', stdColumns);
    assert.strictEqual(label, 'Copy review prompt', 'INTERN CODED -> CODE REVIEWED failed');

    // TEST: CREATED -> custom column -> "Copy advance prompt"
    label = evaluateLabel('CREATED', customColumns);
    assert.strictEqual(label, 'Copy advance prompt', 'CREATED -> custom column failed');

    // TEST: last column -> "Copy Prompt"
    label = evaluateLabel('CODE REVIEWED', stdColumns);
    assert.strictEqual(label, 'Copy Prompt', 'Last column failed');

    // TEST: unknown column -> "Copy Prompt"
    label = evaluateLabel('UNKNOWN', stdColumns);
    assert.strictEqual(label, 'Copy Prompt', 'Unknown column failed');

    // TEST: role present still works (backward compat if payload ever changes)
    const roleColumns = [
        { id: 'CREATED', label: 'New', kind: 'created', order: 0 },
        { id: 'PLAN REVIEWED', label: 'Planned', kind: 'review', role: 'planner', order: 100 },
        { id: 'LEAD CODED', label: 'Lead Coder', kind: 'coded', role: 'lead', order: 180 },
        { id: 'CODE REVIEWED', label: 'Reviewed', kind: 'reviewed', role: 'reviewer', order: 300 }
    ];
    label = evaluateLabel('PLAN REVIEWED', roleColumns);
    assert.strictEqual(label, 'Copy coder prompt', 'Role present -> lead coder failed');

    console.log('planning copy labels regression test passed');
}

try {
    run();
} catch (error) {
    console.error('planning copy labels regression test failed:', error);
    process.exit(1);
}
